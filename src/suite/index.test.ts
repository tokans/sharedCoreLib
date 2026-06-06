import { describe, it, expect, beforeAll } from "vitest";
import { signAsync, getPublicKeyAsync, etc } from "@noble/ed25519";
import { sha256Hex } from "../masters/index.js";
import {
  createSuiteUpdater, buildUpdatePlan, isNewerVersion, isFresh, passesAntiRollback,
  verifyTargetBytes, applyModeFor, type TrustAnchor, type SuiteTarget, type SuiteUpdaterConfig,
  createAppCatalog, pickDownloadLink, updateAvailableFor, meetsAccess,
  type PublishedApp, type AppLocalState, type AppCatalogConfig, type Entitlements,
} from "./index.js";

const ENC = new TextEncoder();
let priv: Uint8Array;
let pubHex: string;

beforeAll(async () => {
  priv = crypto.getRandomValues(new Uint8Array(32)); // an ed25519 secret key is 32 random bytes
  pubHex = etc.bytesToHex(await getPublicKeyAsync(priv));
});

function b64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
const sign = async (bytes: Uint8Array) => b64(await signAsync(bytes, priv));

function anchor(): TrustAnchor {
  return {
    root: { keyId: "root", algo: "ed25519", publicKeyHex: "00", offline: true, immutable: true },
    delegations: {
      data: { keyId: "d", algo: "ed25519", publicKeyHex: pubHex, signedByRoot: true },
      code: { keyId: "c", algo: "ed25519", publicKeyHex: pubHex, signedByRoot: true, threshold: 2 },
      snapshot: { keyId: "s", algo: "ed25519", publicKeyHex: pubHex, signedByRoot: true },
      timestamp: { keyId: "t", algo: "ed25519", publicKeyHex: pubHex, signedByRoot: true, maxExpiryDays: 7 },
    },
    feed: { baseUrl: "https://updates.example.com", anchorSource: "baked" },
  };
}

async function scenario(over: Partial<{ expiresAt: string; lastSnap: number; installed: Record<string, string> }> = {}) {
  const runtimePayload = ENC.encode("RUNTIME-BYTES-v2");
  const nativePayload = ENC.encode("NATIVE-BYTES-v2");
  const targets: SuiteTarget[] = [
    { id: "runtime", kind: "runtime", file: "runtime.bin", bytes: runtimePayload.length, sha256: await sha256Hex(runtimePayload), version: "2.0.0" },
    { id: "native:myapp", kind: "native", file: "native.bin", bytes: nativePayload.length, sha256: await sha256Hex(nativePayload), version: "2.0.0" },
  ];
  const snapshot = { snapshotVersion: 5, targets };
  const timestamp = { expiresAt: over.expiresAt ?? "2999-01-01T00:00:00Z", snapshotVersion: 5 };
  const snapBytes = ENC.encode(JSON.stringify(snapshot));
  const tsBytes = ENC.encode(JSON.stringify(timestamp));
  const feed: Record<string, Uint8Array> = {
    "suite.timestamp.json": tsBytes,
    "suite.timestamp.json.sig": ENC.encode(await sign(tsBytes)),
    "suite.snapshot.json": snapBytes,
    "suite.snapshot.json.sig": ENC.encode(await sign(snapBytes)),
    "runtime.bin": runtimePayload,
    "native.bin": nativePayload,
  };
  const appliedContent: string[] = [];
  const stagedNative: string[] = [];
  const cfg: SuiteUpdaterConfig = {
    anchor: anchor(),
    transportKeyB64: "MA==",
    fetchFile: async (f) => { const b = feed[f]; if (!b) throw new Error("404 " + f); return b; },
    now: () => "2026-06-05T00:00:00Z",
    getLastSnapshotVersion: async () => over.lastSnap ?? 4,
    setLastSnapshotVersion: async () => undefined,
    getInstalledVersions: async () => over.installed ?? { runtime: "1.0.0" },
    confirmUpdate: async () => true,
    applyContentUpdate: async (t) => { appliedContent.push(t.id); },
    stageNativeUpdate: async (t) => { stagedNative.push(t.id); },
  };
  return { cfg, feed, appliedContent, stagedNative };
}

describe("suite pure helpers", () => {
  it("isNewerVersion is strict", () => {
    expect(isNewerVersion("2.0.0", "1.0.0")).toBe(true);
    expect(isNewerVersion("1.0.0", "1.0.0")).toBe(false);
    expect(isNewerVersion("1.0.0", "2.0.0")).toBe(false);
  });
  it("isFresh / anti-rollback", () => {
    expect(isFresh({ expiresAt: "2999-01-01T00:00:00Z", snapshotVersion: 1 }, "2026-06-05T00:00:00Z")).toBe(true);
    expect(isFresh({ expiresAt: "2000-01-01T00:00:00Z", snapshotVersion: 1 }, "2026-06-05T00:00:00Z")).toBe(false);
    expect(passesAntiRollback({ snapshotVersion: 5, targets: [] }, 4)).toBe(true);
    expect(passesAntiRollback({ snapshotVersion: 5, targets: [] }, 5)).toBe(false);
  });
  it("buildUpdatePlan splits content vs native and skips installed", () => {
    const targets: SuiteTarget[] = [
      { id: "runtime", kind: "runtime", file: "r", bytes: 1, sha256: "x", version: "2.0.0" },
      { id: "native:a", kind: "native", file: "n", bytes: 1, sha256: "x", version: "2.0.0" },
      { id: "masters:common", kind: "masters", file: "m", bytes: 1, sha256: "x", version: "9" },
    ];
    const plan = buildUpdatePlan(targets, { runtime: "2.0.0" }); // runtime up-to-date → skipped
    expect(plan.content.map((t) => t.id)).toEqual(["masters:common"]);
    expect(plan.native.map((t) => t.id)).toEqual(["native:a"]);
    expect(plan.isEmpty).toBe(false);
    expect(applyModeFor("native")).toBe("next-launch");
    expect(applyModeFor("runtime")).toBe("hot-reload");
  });
  it("verifyTargetBytes catches size/hash mismatch", async () => {
    const bytes = ENC.encode("abc");
    const t: SuiteTarget = { id: "x", kind: "runtime", file: "f", bytes: 3, sha256: await sha256Hex(bytes), version: "1" };
    expect(await verifyTargetBytes(t, bytes)).toBe(true);
    expect(await verifyTargetBytes(t, ENC.encode("abd"))).toBe(false);
  });
});

describe("createSuiteUpdater", () => {
  it("happy path: verifies, confirms, hot-reloads content + stages native", async () => {
    const { cfg, appliedContent, stagedNative } = await scenario();
    const res = await createSuiteUpdater(cfg).check();
    expect(res.applied).toBe(true);
    expect(appliedContent).toContain("runtime");
    expect(stagedNative).toContain("native:myapp");
  });

  it("VERIFY-AT-LOAD: a tampered staged target aborts the apply", async () => {
    const { cfg, feed, appliedContent } = await scenario();
    feed["runtime.bin"] = ENC.encode("TAMPERED-BYTES"); // hash no longer matches the signed snapshot
    const res = await createSuiteUpdater(cfg).check();
    expect(res.applied).toBe(false);
    expect(res.reason).toMatch(/verify-at-load/);
    expect(appliedContent).not.toContain("runtime");
  });

  it("rejects a delegation that does not chain to root", async () => {
    const { cfg } = await scenario();
    cfg.anchor.delegations.timestamp.signedByRoot = false;
    const res = await createSuiteUpdater(cfg).check();
    expect(res.applied).toBe(false);
    expect(res.reason).toMatch(/bad-timestamp-signature/);
  });

  it("anti-rollback: refuses a snapshot at/below the applied floor", async () => {
    const { cfg } = await scenario({ lastSnap: 5 });
    const res = await createSuiteUpdater(cfg).check();
    expect(res.applied).toBe(false);
    expect(res.reason).toMatch(/rollback-rejected/);
  });

  it("freshness: refuses expired metadata", async () => {
    const { cfg } = await scenario({ expiresAt: "2000-01-01T00:00:00Z" });
    const res = await createSuiteUpdater(cfg).check();
    expect(res.applied).toBe(false);
    expect(res.reason).toMatch(/stale-metadata/);
  });
});

describe("app marketplace / launcher", () => {
  const apps: PublishedApp[] = [
    { appId: "myfinance", name: "myFinance", marketingUrl: "https://tokans.github.io/myFinance/",
      downloadLinks: { windows: "https://x/win.msi", macos: "https://x/mac.dmg" },
      latestVersion: "1.2.0", latestCoreVersion: "1.0.0" },
    { appId: "myhealth", name: "myHealth", marketingUrl: "https://tokans.github.io/myHealth/",
      downloadLinks: { windows: "https://y/win.msi" }, latestVersion: "0.5.0", latestCoreVersion: "1.0.0" },
  ];
  const local: Record<string, AppLocalState> = {
    myfinance: { installed: true, installedVersion: "1.1.0", phoneSyncEnabled: false }, // update available
    myhealth: { installed: false, phoneSyncEnabled: false },
  };
  const opened: string[] = [];
  const launched: string[] = [];
  const mkCfg = (currentAppId: string, platform?: string): AppCatalogConfig => ({
    currentAppId,
    listPublishedApps: async () => apps,
    getLocalState: async (id) => local[id] ?? { installed: false, phoneSyncEnabled: false },
    setLocalState: async (id, s) => { local[id] = s; },
    openExternal: async (url) => { opened.push(url); },
    launchApp: async (app) => { launched.push(app.appId); },
    platform: () => platform,
  });

  it("pickDownloadLink prefers the platform, falls back to first", () => {
    expect(pickDownloadLink(apps[0]!, "macos")).toBe("https://x/mac.dmg");
    expect(pickDownloadLink(apps[1]!, "macos")).toBe("https://y/win.msi"); // no macos → fallback
  });

  it("updateAvailableFor is true only for an installed older version", () => {
    expect(updateAvailableFor(apps[0]!, local.myfinance!)).toBe(true);
    expect(updateAvailableFor(apps[1]!, local.myhealth!)).toBe(false);
  });

  it("list joins registry with local state + flags current/update", async () => {
    const rows = await createAppCatalog(mkCfg("myfinance", "windows")).list();
    const fin = rows.find((r) => r.appId === "myfinance")!;
    expect(fin.isCurrentApp).toBe(true);
    expect(fin.updateAvailable).toBe(true);
    expect(fin.downloadUrl).toBe("https://x/win.msi");
  });

  it("listInstalled / listAvailable partition correctly (available excludes current)", async () => {
    const cat = createAppCatalog(mkCfg("myfinance"));
    expect((await cat.listInstalled()).map((r) => r.appId)).toEqual(["myfinance"]);
    expect((await cat.listAvailable()).map((r) => r.appId)).toEqual(["myhealth"]);
  });

  it("primaryAction: installed→open, not-installed→download, current→current", async () => {
    const rows = await createAppCatalog(mkCfg("myhealth")).list();
    expect(rows.find((r) => r.appId === "myfinance")!.primaryAction).toBe("open");      // installed
    expect(rows.find((r) => r.appId === "myhealth")!.primaryAction).toBe("current");    // current app
    // myhealth is current+uninstalled; check a non-current uninstalled via a different current
    const rows2 = await createAppCatalog(mkCfg("myfinance")).list();
    expect(rows2.find((r) => r.appId === "myhealth")!.primaryAction).toBe("download");  // not installed
  });

  it("install (download) opens the platform download link; open launches an installed app", async () => {
    opened.length = 0; launched.length = 0;
    const cat = createAppCatalog(mkCfg("myfinance", "windows"));
    await cat.install("myhealth");
    expect(opened).toEqual(["https://y/win.msi"]);
    await cat.open("myfinance");
    expect(launched).toEqual(["myfinance"]);
  });

  it("open throws for a not-installed app", async () => {
    await expect(createAppCatalog(mkCfg("myfinance")).open("myhealth")).rejects.toThrow(/not installed/);
  });

  it("activate dispatches: installed→launch, not-installed→download, current→no-op", async () => {
    opened.length = 0; launched.length = 0;
    // From myHealth: activating the installed myFinance launches it; activating self is a no-op.
    const fromHealth = createAppCatalog(mkCfg("myhealth", "windows"));
    await fromHealth.activate("myfinance"); // installed, not current → launch
    await fromHealth.activate("myhealth");  // current → no-op
    expect(launched).toEqual(["myfinance"]);
    expect(opened).toEqual([]);
    // From myFinance: activating the uninstalled myHealth downloads it.
    await createAppCatalog(mkCfg("myfinance", "windows")).activate("myhealth"); // not installed → download
    expect(opened).toEqual(["https://y/win.msi"]);
  });

  it("markUninstalled and setPhoneSync mutate local state", async () => {
    const cat = createAppCatalog(mkCfg("myhealth"));
    await cat.setPhoneSync("myhealth", true);
    expect(local.myhealth!.phoneSyncEnabled).toBe(true);
    await cat.markUninstalled("myfinance");
    expect(local.myfinance!.installed).toBe(false);
  });
});

describe("marketplace access-gated apps (myWorkAssistant)", () => {
  const mwa: PublishedApp = {
    appId: "myworkassistant", name: "myWorkAssistant", marketingUrl: "https://tokans.org/mwa",
    enrollUrl: "https://tokans.org/partner/enroll",
    downloadLinks: { windows: "https://z/mwa.msi" }, latestVersion: "1.0.0", latestCoreVersion: "1.0.0",
    access: "partner", hasBackend: true,
  };
  const opened: string[] = [];
  const mkCfg = (ent: Entitlements): AppCatalogConfig => ({
    currentAppId: "myfinance",
    listPublishedApps: async () => [mwa],
    getLocalState: async () => ({ installed: false, phoneSyncEnabled: false }),
    setLocalState: async () => undefined,
    openExternal: async (url) => { opened.push(url); },
    launchApp: async () => undefined,
    platform: () => "windows",
    entitlements: async () => ent,
  });

  it("meetsAccess gates partner apps on the partner entitlement", () => {
    expect(meetsAccess(mwa, { isPatron: true, isPartner: false })).toBe(false);
    expect(meetsAccess(mwa, { isPatron: false, isPartner: true })).toBe(true);
  });

  it("non-Partner sees primaryAction 'enroll'; activate routes to the enroll URL", async () => {
    opened.length = 0;
    const cat = createAppCatalog(mkCfg({ isPatron: false, isPartner: false }));
    const row = (await cat.list())[0]!;
    expect(row.primaryAction).toBe("enroll");
    await cat.activate("myworkassistant");
    expect(opened).toEqual(["https://tokans.org/partner/enroll"]);
  });

  it("Partner sees 'download'; activate downloads it", async () => {
    opened.length = 0;
    const cat = createAppCatalog(mkCfg({ isPatron: false, isPartner: true }));
    expect((await cat.list())[0]!.primaryAction).toBe("download");
    await cat.activate("myworkassistant");
    expect(opened).toEqual(["https://z/mwa.msi"]);
  });
});
