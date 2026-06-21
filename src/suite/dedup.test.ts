import { describe, it, expect } from "vitest";
import {
  createLocalStateAdapter,
  createSuiteCatalog,
  createIssueReporter,
  ISSUE_TYPES,
  article,
  type PublishedApp,
} from "./index.js";

/** In-memory storage stand-in for the local-state adapter. */
function fakeStorage() {
  const map = new Map<string, string>();
  return {
    store: { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) },
    map,
  };
}

const SEED: PublishedApp[] = [
  {
    appId: "myfinance",
    name: "myFinance",
    marketingUrl: "https://tokans.org/myfinance",
    downloadLinks: { windows: "https://tokans.org/dl/win" },
    latestVersion: "1.0.0",
    latestCoreVersion: "0.5.0",
  },
];

describe("createLocalStateAdapter", () => {
  it("namespaces keys by appId and reports the current app installed", async () => {
    const { store, map } = fakeStorage();
    const a = createLocalStateAdapter("mydocs", { appVersion: async () => "2.3.4", storage: () => store });

    const self = await a.getLocalState("mydocs");
    expect(self).toEqual({ installed: true, installedVersion: "2.3.4", phoneSyncEnabled: false });

    const sibling = await a.getLocalState("myfinance");
    expect(sibling).toEqual({ installed: false, phoneSyncEnabled: false });

    await a.setLocalState("myfinance", { installed: true, installedVersion: "1.0.0", phoneSyncEnabled: true });
    expect([...map.keys()]).toContain("mydocs:suite:local:myfinance");
    expect((await a.getLocalState("myfinance")).installed).toBe(true);
  });

  it("unions the cached registry over the seed (seed never vanishes)", async () => {
    const { store } = fakeStorage();
    const a = createLocalStateAdapter("mydocs", { storage: () => store });
    expect(await a.listPublishedApps(SEED)).toEqual(SEED); // no cache → seed
    a.cachePublishedApps([{ ...SEED[0]!, appId: "myhealth", name: "myHealth" }]);
    const merged = await a.listPublishedApps(SEED);
    expect(merged.map((m) => m.appId).sort()).toEqual(["myfinance", "myhealth"]);
  });
});

describe("createSuiteCatalog", () => {
  it("wires the catalog with defaults; download opens the platform link", async () => {
    const { store } = fakeStorage();
    const opened: string[] = [];
    const catalog = createSuiteCatalog({
      appId: "mydocs",
      seed: SEED,
      openExternal: async (u) => void opened.push(u),
      platform: () => "windows",
      storage: () => store,
    });
    const rows = await catalog.list();
    expect(rows.find((r) => r.appId === "myfinance")?.primaryAction).toBe("download");
    await catalog.install("myfinance");
    expect(opened).toEqual(["https://tokans.org/dl/win"]);
  });
});

describe("createIssueReporter", () => {
  it("exposes the fixed vocabulary and the article helper", () => {
    const r = createIssueReporter({ repo: "tokans/myFinance" });
    expect(r.ISSUE_TYPES).toBe(ISSUE_TYPES);
    expect(r.article("Expert")).toBe("an");
    expect(article("Patron")).toBe("a");
  });

  it("builds a prefilled GitHub issue URL with tier lead, steps, labels", () => {
    const r = createIssueReporter({ repo: "tokans/myFinance" });
    const url = r.buildIssueUrl(
      { type: "bug", title: "Crash", description: "it crashed", steps: "do x", includeContext: false, tierLabel: "Patron" },
      "",
    );
    expect(url.startsWith("https://github.com/tokans/myFinance/issues/new?")).toBe(true);
    const q = new URL(url).searchParams;
    expect(q.get("title")).toBe("Crash");
    expect(q.get("labels")).toBe("bug");
    expect(q.get("body")).toContain("I am a Patron user and it crashed");
    expect(q.get("body")).toContain("Steps to reproduce");
  });

  it("falls back to the default tier label when blank", () => {
    const r = createIssueReporter({ repo: "tokans/x", defaultTierLabel: "Newcomer" });
    const url = r.buildIssueUrl(
      { type: "question", title: "Q", description: "help", includeContext: false, tierLabel: "  " },
      "",
    );
    expect(new URL(url).searchParams.get("body")).toContain("I am a Newcomer user");
  });
});
