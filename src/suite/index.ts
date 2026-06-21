/**
 * Suite update manager — app-agnostic, dependency-injected.
 *
 * A single client-side, background, non-blocking service shared by every installed
 * app that keeps reference data AND versions current from the publisher's signed
 * feed. The security controls from THREAT_MODEL.md are encoded into the TYPES and
 * the verify flow so an app cannot wire it insecurely:
 *
 *   - **Delegation chain** — {@link TrustAnchor} is a baked, immutable, offline ROOT
 *     plus separate root-delegated keys for `data` / `code` / `snapshot` / `timestamp`.
 *     Code is verified with the CODE key, never the data key. A delegation that does
 *     not declare `signedByRoot` is rejected.
 *   - **Verify-at-load** — {@link verifyTargetBytes} re-checks bytes against the
 *     root-delegated signed snapshot at the moment of use, so the (untrusted) on-disk
 *     staging area cannot be tampered between download and apply.
 *   - **Anti-rollback + freshness** — a monotonic `snapshotVersion` floor and an
 *     expiring `timestamp` reject downgrade, freeze and replay.
 *   - **Native-owned confirmation** — {@link SuiteUpdaterConfig.confirmUpdate} is the
 *     trusted-UI gate; it lives in the app's native shell, never the webview being
 *     replaced.
 *
 * Network, filesystem, lease and clock are all injected adapters — no module state,
 * no direct Tauri import here — so the engine is pure and testable.
 */
import { verifyManifestSignature, sha256Hex, decryptTransport, meetsMinVersion } from "../masters/index.js";
import { isTauri } from "../env/index.js";

// ── Trust anchor (baked) ─────────────────────────────────────────────────────

export type DelegationRole = "data" | "code" | "snapshot" | "timestamp";

export interface DelegatedKey {
  keyId: string;
  algo: "ed25519";
  publicKeyHex: string;
  /** Must be true — the key is delegated by the immutable root (chain of trust). */
  signedByRoot: boolean;
  /** k-of-n threshold (code role should be ≥ 2). */
  threshold?: number;
  /** Max freshness window for the timestamp role. */
  maxExpiryDays?: number;
}

export interface TrustAnchor {
  root: {
    keyId: string;
    algo: "ed25519";
    publicKeyHex: string;
    /** The root key is held offline (HSM). */
    offline: boolean;
    /** The root anchor never changes after install. */
    immutable: boolean;
  };
  delegations: Record<DelegationRole, DelegatedKey>;
  feed: { baseUrl: string; anchorSource: "baked" };
}

// ── Published-apps registry ──────────────────────────────────────────────────

export interface PublishedApp {
  appId: string;
  name: string;
  tagline?: string;
  description?: string;
  icon?: string;
  marketingUrl: string;
  /** Per-platform installer URLs, e.g. { windows, macos, linux }. */
  downloadLinks: Record<string, string>;
  latestVersion: string;
  /** Newest shared-runtime version this app expects. */
  latestCoreVersion: string;
  /**
   * Access requirement. `"open"` (default) — anyone can download. `"patron"` /
   * `"partner"` — gated behind the corresponding entitlement; until the user has it,
   * the marketplace offers **Enroll** (route to the donation / partner-enrollment flow)
   * instead of Download. E.g. `myWorkAssistant` is `access: "partner"`.
   */
  access?: "open" | "patron" | "partner";
  /**
   * True for an app with its OWN backend + auth (NOT a receive-only local-first app) —
   * e.g. `myWorkAssistant` (full tauri-react-stack + core). Such apps prompt to
   * enroll / sign in and do not carry the suite's receive-only promise.
   */
  hasBackend?: boolean;
  /** Where "Enroll" routes (the portal). Defaults to `marketingUrl`. */
  enrollUrl?: string;
}

/** Client-LOCAL state — held per-app-private, never uploaded (receive-only). */
export interface AppLocalState {
  installed: boolean;
  installedVersion?: string;
  phoneSyncEnabled: boolean;
}

// ── Signed metadata (TUF-modeled) ────────────────────────────────────────────

export type SuiteTargetKind = "runtime" | "masters" | "registry" | "app-content" | "native";

export interface SuiteTarget {
  /** Stable id, e.g. "runtime", "masters:common", "app:myfinance", "native:myfinance". */
  id: string;
  kind: SuiteTargetKind;
  /** File path under the feed baseUrl. */
  file: string;
  bytes: number;
  sha256: string;
  /** Semver (runtime/apps) or revision string (masters/registry). */
  version: string;
  /** Whether the payload is AES-GCM transport-encrypted (masters/registry usually are). */
  transportEncrypted?: boolean;
}

export interface SuiteSnapshot {
  /** Monotonic — the anti-rollback floor. */
  snapshotVersion: number;
  minAppVersion?: string;
  targets: SuiteTarget[];
}

export interface SuiteTimestamp {
  /** ISO instant after which this metadata is stale (anti-freeze/replay). */
  expiresAt: string;
  /** Must equal the snapshot's version (consistency binding). */
  snapshotVersion: number;
}

/** How a confirmed target is applied. */
export type ApplyMode = "hot-reload" | "next-launch";

export function applyModeFor(kind: SuiteTargetKind): ApplyMode {
  return kind === "native" ? "next-launch" : "hot-reload";
}

export interface UpdatePlan {
  /** Webview/content targets — hot-reloaded live after verify-at-load. */
  content: SuiteTarget[];
  /** Native targets — staged, applied on next launch. */
  native: SuiteTarget[];
  isEmpty: boolean;
}

// ── Pure helpers (testable, no IO) ───────────────────────────────────────────

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Strictly newer than the installed version (≥ AND not equal). */
export function isNewerVersion(candidate: string, installed: string): boolean {
  return meetsMinVersion(candidate, installed) && candidate !== installed;
}

/** Verify a role's metadata signature against its ROOT-DELEGATED key. Never throws. */
export async function verifyDelegated(
  bytes: Uint8Array,
  sigB64: string,
  anchor: TrustAnchor,
  role: DelegationRole,
): Promise<boolean> {
  const key = anchor.delegations[role];
  // A delegation that doesn't chain to the immutable root is not trusted.
  if (!key || key.signedByRoot !== true) return false;
  try {
    return await verifyManifestSignature(bytes, b64ToBytes(sigB64), key.publicKeyHex);
  } catch {
    return false;
  }
}

/** Metadata is fresh while `now` is at/before `expiresAt`. */
export function isFresh(ts: SuiteTimestamp, nowIso: string): boolean {
  const now = Date.parse(nowIso);
  const exp = Date.parse(ts.expiresAt);
  return Number.isFinite(now) && Number.isFinite(exp) && now <= exp;
}

/** Anti-rollback: a snapshot is acceptable only strictly above the highest applied. */
export function passesAntiRollback(snapshot: SuiteSnapshot, lastApplied: number): boolean {
  return snapshot.snapshotVersion > lastApplied;
}

/**
 * VERIFY-AT-LOAD — re-check bytes against the (signed) snapshot target right before
 * use. The staged on-disk bytes are untrusted until this passes.
 */
export async function verifyTargetBytes(target: SuiteTarget, bytes: Uint8Array): Promise<boolean> {
  if (bytes.length !== target.bytes) return false;
  return (await sha256Hex(bytes)) === target.sha256;
}

/** Build the plan: include a target when it is absent or strictly newer than installed. */
export function buildUpdatePlan(targets: SuiteTarget[], installed: Record<string, string>): UpdatePlan {
  const content: SuiteTarget[] = [];
  const native: SuiteTarget[] = [];
  for (const t of targets) {
    const have = installed[t.id];
    if (have != null && !isNewerVersion(t.version, have)) continue;
    (applyModeFor(t.kind) === "next-launch" ? native : content).push(t);
  }
  return { content, native, isEmpty: content.length + native.length === 0 };
}

// ── Updater factory ──────────────────────────────────────────────────────────

export interface SuiteUpdaterConfig {
  /** The baked, immutable trust anchor (feed baseUrl + root + delegated keys). */
  anchor: TrustAnchor;
  /** AES-GCM transport key for encrypted targets (masters/registry). */
  transportKeyB64: string;
  /** Filenames of the signed metadata under baseUrl. Defaults shown. */
  files?: { timestamp?: string; snapshot?: string };

  /** Fetch a file (and `${file}.sig`) under the feed baseUrl. */
  fetchFile: (file: string) => Promise<Uint8Array>;
  /** Current ISO instant — injected so freshness is deterministic/testable. */
  now: () => string;

  /** Highest snapshotVersion already applied (anti-rollback floor). */
  getLastSnapshotVersion: () => Promise<number>;
  /** Persist the new floor after a successful apply. */
  setLastSnapshotVersion: (v: number) => Promise<void>;

  /** Versions currently installed, keyed by target id (absent ⇒ not installed). */
  getInstalledVersions: () => Promise<Record<string, string>>;

  /**
   * NATIVE-OWNED CONFIRMATION — the trusted-UI gate. Implement this in the app's
   * native shell (NOT the webview being replaced). Return true to apply the plan.
   */
  confirmUpdate: (plan: UpdatePlan) => Promise<boolean>;

  /** Apply a verified content target by hot-reloading it (masters/registry/runtime/app-content). */
  applyContentUpdate: (target: SuiteTarget, bytes: Uint8Array) => Promise<void>;
  /** Stage a verified native target to apply on next launch. */
  stageNativeUpdate: (target: SuiteTarget, bytes: Uint8Array) => Promise<void>;

  /** Cross-process daily lease so only ONE app checks per machine/day. Default: always granted. */
  acquireLease?: () => Promise<boolean>;
  releaseLease?: () => Promise<void>;
  /** Record that a check ran (e.g. persist a timestamp). */
  markChecked?: () => void;
  /** Surface a freshness warning when metadata is stale/expired. */
  onStaleMetadata?: () => void;
}

export interface SuiteCheckResult {
  applied: boolean;
  plan?: UpdatePlan;
  reason?: string;
}

export interface SuiteUpdater {
  /** Run one update check end-to-end. Best-effort; never throws. */
  check(opts?: { force?: boolean }): Promise<SuiteCheckResult>;
}

/**
 * Build a suite updater bound to one app's config. State (the in-flight guard) is
 * closed over locally, so the returned method is safe to destructure. Fail-silent:
 * offline / bad signature / stale / downgrade all leave existing data untouched.
 */
export function createSuiteUpdater(cfg: SuiteUpdaterConfig): SuiteUpdater {
  const tsFile = cfg.files?.timestamp ?? "suite.timestamp.json";
  const snapFile = cfg.files?.snapshot ?? "suite.snapshot.json";
  let inFlight = false;

  const DEC = new TextDecoder();
  const parse = <T>(bytes: Uint8Array): T => JSON.parse(DEC.decode(bytes)) as T;
  const sigOf = async (file: string): Promise<string> => DEC.decode(await cfg.fetchFile(`${file}.sig`)).trim();

  async function check(opts: { force?: boolean } = {}): Promise<SuiteCheckResult> {
    if (inFlight) return { applied: false, reason: "in-flight" };
    inFlight = true;
    let leased = false;
    try {
      leased = opts.force ? true : (cfg.acquireLease ? await cfg.acquireLease() : true);
      if (!leased) return { applied: false, reason: "no-lease" };

      // 1. Fetch + verify timestamp (freshness), against the root-delegated timestamp key.
      const tsBytes = await cfg.fetchFile(tsFile);
      if (!(await verifyDelegated(tsBytes, await sigOf(tsFile), cfg.anchor, "timestamp"))) {
        return { applied: false, reason: "bad-timestamp-signature" };
      }
      const timestamp = parse<SuiteTimestamp>(tsBytes);
      if (!isFresh(timestamp, cfg.now())) {
        cfg.onStaleMetadata?.();
        return { applied: false, reason: "stale-metadata" };
      }

      // 2. Fetch + verify snapshot (anti-rollback + consistency), against the snapshot key.
      const snapBytes = await cfg.fetchFile(snapFile);
      if (!(await verifyDelegated(snapBytes, await sigOf(snapFile), cfg.anchor, "snapshot"))) {
        return { applied: false, reason: "bad-snapshot-signature" };
      }
      const snapshot = parse<SuiteSnapshot>(snapBytes);
      if (snapshot.snapshotVersion !== timestamp.snapshotVersion) {
        return { applied: false, reason: "snapshot/timestamp mismatch" };
      }
      if (!passesAntiRollback(snapshot, await cfg.getLastSnapshotVersion())) {
        return { applied: false, reason: "rollback-rejected" };
      }

      // 3. Build the plan; confirm via the native-owned gate.
      const plan = buildUpdatePlan(snapshot.targets, await cfg.getInstalledVersions());
      if (plan.isEmpty) { cfg.markChecked?.(); return { applied: false, plan, reason: "up-to-date" }; }
      if (!(await cfg.confirmUpdate(plan))) { cfg.markChecked?.(); return { applied: false, plan, reason: "declined" }; }

      // 4. Download → VERIFY-AT-LOAD → apply (hot-reload now / stage for next launch).
      for (const target of [...plan.content, ...plan.native]) {
        let bytes = await cfg.fetchFile(target.file);
        // Hash-verify the ENCRYPTED bytes (that's what the signed snapshot hashes), then decrypt.
        if (!(await verifyTargetBytes(target, bytes))) {
          return { applied: false, plan, reason: `verify-at-load failed for ${target.id}` };
        }
        if (target.transportEncrypted) bytes = await decryptTransport(bytes, cfg.transportKeyB64);
        if (applyModeFor(target.kind) === "next-launch") await cfg.stageNativeUpdate(target, bytes);
        else await cfg.applyContentUpdate(target, bytes);
      }

      await cfg.setLastSnapshotVersion(snapshot.snapshotVersion);
      cfg.markChecked?.();
      return { applied: true, plan };
    } catch (e) {
      return { applied: false, reason: `error: ${(e as Error).message}` };
    } finally {
      if (leased && cfg.releaseLease) await cfg.releaseLease().catch(() => undefined);
      inFlight = false;
    }
  }

  return { check };
}

// ── App marketplace / launcher (the mobile "More" surface) ───────────────────
//
// Every installed suite app exposes a marketplace surface (a store-like icon, in the
// "More" section on mobile) listing ALL the publisher's apps — both INSTALLED and NOT
// YET installed — sourced from the `common:app` registry. From it the user can discover
// and install other apps, open their marketing pages, uninstall, and toggle phone-sync.
// The lib provides the DATA + ACTIONS (DI); the app renders the UI. Actual OS install/
// uninstall is OS-mediated (open the platform download/store link); the registry tracks
// the client-LOCAL install/sync state (per-app-private, never uploaded — receive-only).

/**
 * What clicking the row does — drives the icon + behavior the UI renders:
 *   - `open`     installed (not current) → show an "installed" badge, click LAUNCHES it
 *   - `download` not installed (entitled) → click DOWNLOADS it (platform installer link)
 *   - `enroll`   access-gated (patron/partner) and not yet entitled → route to the
 *                donation / partner-enrollment flow (e.g. myWorkAssistant for non-Partners)
 *   - `current`  the app the user is already in → no action
 */
export type AppPrimaryAction = "open" | "download" | "enroll" | "current";

/** The user's suite entitlements, read from the grant state (see `sharedcorelib/grant`). */
export interface Entitlements {
  isPatron: boolean;
  isPartner: boolean;
}

const NO_ENTITLEMENTS: Entitlements = { isPatron: false, isPartner: false };

/** Whether the user meets an app's access requirement. */
export function meetsAccess(app: PublishedApp, ent: Entitlements): boolean {
  switch (app.access ?? "open") {
    case "partner": return ent.isPartner;
    case "patron": return ent.isPatron || ent.isPartner;
    default: return true;
  }
}

/** A published app joined with this client's local state — one marketplace row. */
export interface AppCatalogEntry extends PublishedApp {
  local: AppLocalState;
  /** The app the user is currently running (don't offer to install/uninstall it). */
  isCurrentApp: boolean;
  /** Installed AND a newer version is published. */
  updateAvailable: boolean;
  /** Installer URL for the active platform (falls back to the first link), if any. */
  downloadUrl?: string;
  /** Click behavior for this row: open (installed) · download (not) · current. */
  primaryAction: AppPrimaryAction;
}

/**
 * Click behavior for a row: current app → none; installed → open; access-gated and
 * not yet entitled → enroll; otherwise → download.
 */
export function primaryActionFor(
  app: PublishedApp, local: AppLocalState, currentAppId: string, ent: Entitlements = NO_ENTITLEMENTS,
): AppPrimaryAction {
  if (app.appId === currentAppId) return "current";
  if (local.installed) return "open";
  return meetsAccess(app, ent) ? "download" : "enroll";
}

/** Choose the installer URL for a platform; falls back to the first available link. */
export function pickDownloadLink(app: PublishedApp, platform?: string): string | undefined {
  if (platform && app.downloadLinks[platform]) return app.downloadLinks[platform];
  return Object.values(app.downloadLinks)[0];
}

/** An installed app has an update when the published version is strictly newer. */
export function updateAvailableFor(app: PublishedApp, local: AppLocalState): boolean {
  return !!local.installed && !!local.installedVersion && isNewerVersion(app.latestVersion, local.installedVersion);
}

/** Join a published app with local state into a marketplace row. */
export function toCatalogEntry(
  app: PublishedApp, local: AppLocalState, currentAppId: string,
  platform?: string, ent: Entitlements = NO_ENTITLEMENTS,
): AppCatalogEntry {
  return {
    ...app,
    local,
    isCurrentApp: app.appId === currentAppId,
    updateAvailable: updateAvailableFor(app, local),
    downloadUrl: pickDownloadLink(app, platform),
    primaryAction: primaryActionFor(app, local, currentAppId, ent),
  };
}

export interface AppCatalogConfig {
  /** This app's id — flags the current app so the UI doesn't offer to (un)install it. */
  currentAppId: string;
  /** Read the published-apps registry (`common:app`) from the shared store / feed. */
  listPublishedApps: () => Promise<PublishedApp[]>;
  /** Read this client's per-app-private local state (installed/version/sync). */
  getLocalState: (appId: string) => Promise<AppLocalState>;
  /** Persist this client's per-app-private local state. */
  setLocalState: (appId: string, state: AppLocalState) => Promise<void>;
  /** Open a URL in the OS browser / store (native-owned; download + marketing go through here). */
  openExternal: (url: string) => Promise<void>;
  /** Launch an INSTALLED sibling app (native: deep-link / URL scheme / OS launch). */
  launchApp: (app: PublishedApp) => Promise<void>;
  /** Active platform for download-link selection ("windows" | "macos" | "linux" | "ios" | "android"). */
  platform?: () => string | undefined;
  /** The user's suite entitlements (from grant state) — gates Patron/Partner-only apps. Default: none. */
  entitlements?: () => Promise<Entitlements>;
  /**
   * Opt-in allow-list of https hostnames for feed-supplied URLs (download/marketing/enroll
   * links). A compromised registry feed is a phishing/malware channel (THREAT_MODEL §7); when
   * set, every URL is origin-checked before it reaches `openExternal` (a host matches itself or
   * any subdomain). When unset, URLs pass through as before (the app owns the policy). Apps
   * SHOULD set this, e.g. `["tokans.org", "github.io", "github.com"]`.
   */
  allowedUrlHosts?: string[];
}

/** True only for an https URL whose host equals, or is a subdomain of, an allow-listed host. */
function isAllowedUrl(url: string, hosts: string[]): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    const host = u.hostname.toLowerCase();
    return hosts.some((h) => host === h || host.endsWith(`.${h}`));
  } catch {
    return false;
  }
}

export interface AppCatalog {
  /** All published apps with this client's install/sync state — the full marketplace list. */
  list(): Promise<AppCatalogEntry[]>;
  /** Only installed apps (e.g. a launcher / app switcher). */
  listInstalled(): Promise<AppCatalogEntry[]>;
  /** Only not-yet-installed apps, excluding the current app (the "discover" tab). */
  listAvailable(): Promise<AppCatalogEntry[]>;
  /** Row click: LAUNCH it if installed, else DOWNLOAD it (no-op for the current app). */
  activate(appId: string): Promise<void>;
  /** Launch an installed app (throws if not installed). */
  open(appId: string): Promise<void>;
  /** Begin install: open the platform download link / store page (OS performs the install). */
  install(appId: string): Promise<void>;
  /** Route to the donation / partner-enrollment flow for an access-gated app. */
  enroll(appId: string): Promise<void>;
  /** Open an app's marketing page. */
  openMarketing(appId: string): Promise<void>;
  /** Record an uninstall in client-local state (the OS performs the actual removal). */
  markUninstalled(appId: string): Promise<void>;
  /** Toggle phone-sync for an app on this client. */
  setPhoneSync(appId: string, enabled: boolean): Promise<void>;
}

/**
 * Build the marketplace/launcher catalog bound to one app's adapters. No module state.
 * Reads the shared published-apps registry and joins it with per-app-private local state.
 */
export function createAppCatalog(cfg: AppCatalogConfig): AppCatalog {
  const platform = () => cfg.platform?.();
  const getEntitlements = async (): Promise<Entitlements> =>
    cfg.entitlements ? await cfg.entitlements() : NO_ENTITLEMENTS;

  // Origin-check every feed-supplied URL before handing it to the OS browser (opt-in).
  const openExternal = async (url: string): Promise<void> => {
    if (cfg.allowedUrlHosts && !isAllowedUrl(url, cfg.allowedUrlHosts)) {
      throw new Error(`blocked URL with non-allow-listed origin: ${url}`);
    }
    await cfg.openExternal(url);
  };

  async function entries(): Promise<AppCatalogEntry[]> {
    const [apps, ent] = await Promise.all([cfg.listPublishedApps(), getEntitlements()]);
    const rows: AppCatalogEntry[] = [];
    for (const app of apps) {
      rows.push(toCatalogEntry(app, await cfg.getLocalState(app.appId), cfg.currentAppId, platform(), ent));
    }
    return rows;
  }

  const findApp = async (appId: string): Promise<PublishedApp> => {
    const app = (await cfg.listPublishedApps()).find((a) => a.appId === appId);
    if (!app) throw new Error(`unknown app: ${appId}`);
    return app;
  };

  const open = async (appId: string): Promise<void> => {
    const local = await cfg.getLocalState(appId);
    if (!local.installed) throw new Error(`app not installed: ${appId}`);
    await cfg.launchApp(await findApp(appId));
  };
  const install = async (appId: string): Promise<void> => {
    const url = pickDownloadLink(await findApp(appId), platform());
    if (!url) throw new Error(`no download link for ${appId}`);
    await openExternal(url);
  };
  const enroll = async (appId: string): Promise<void> => {
    const app = await findApp(appId);
    await openExternal(app.enrollUrl ?? app.marketingUrl);
  };

  return {
    list: entries,
    listInstalled: async () => (await entries()).filter((e) => e.local.installed),
    listAvailable: async () => (await entries()).filter((e) => !e.local.installed && !e.isCurrentApp),
    activate: async (appId) => {
      // current → nothing; installed → open; access-gated & not entitled → enroll; else download.
      if (appId === cfg.currentAppId) return;
      const [app, local] = await Promise.all([findApp(appId), cfg.getLocalState(appId)]);
      if (local.installed) return open(appId);
      if (!meetsAccess(app, await getEntitlements())) return enroll(appId);
      return install(appId);
    },
    open,
    install,
    enroll,
    openMarketing: async (appId) => openExternal((await findApp(appId)).marketingUrl),
    markUninstalled: async (appId) => {
      const local = await cfg.getLocalState(appId);
      await cfg.setLocalState(appId, { ...local, installed: false, installedVersion: undefined });
    },
    setPhoneSync: async (appId, enabled) => {
      const local = await cfg.getLocalState(appId);
      await cfg.setLocalState(appId, { ...local, phoneSyncEnabled: enabled });
    },
  };
}

// ── Marketplace wiring helpers (dedup: byte-identical glue across every app) ──
//
// Every suite app shipped the same four files to wire `createAppCatalog`: a UA→platform
// string, a Tauri app-version read, a localStorage-backed local-state adapter, and the
// registry source + catalog factory. They differed only by an app id (and an inconsistent
// localStorage key prefix). Promoted here as pure/DI helpers parameterized by what varies.

/**
 * Active platform for download-link selection, derived from the webview user-agent (no
 * plugin needed). Android reports "Linux" in its UA, so it is checked first. Returns
 * undefined when unknown — callers fall back to the first available link.
 */
export function detectPlatform(): string | undefined {
  if (typeof navigator === "undefined") return undefined;
  const ua = navigator.userAgent || "";
  if (/Android/i.test(ua)) return "android";
  if (/iPhone|iPad|iPod/i.test(ua)) return "ios";
  if (/Windows/i.test(ua)) return "windows";
  if (/Mac OS X|Macintosh/i.test(ua)) return "macos";
  if (/Linux|X11/i.test(ua)) return "linux";
  return undefined;
}

/** This app's installed version, read from the Tauri shell (undefined in browser dev). */
export async function currentAppVersion(): Promise<string | undefined> {
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    return await getVersion();
  } catch {
    return undefined;
  }
}

/** Minimal storage surface (`localStorage` in the webview; a fake in tests). */
export type SuiteStorageLike = Pick<Storage, "getItem" | "setItem">;

/**
 * Per-app marketplace local-state adapter (installed / version / phone-sync), backed by
 * client storage (receive-only, never uploaded). Keys are namespaced `${appId}:suite:local:*`
 * (the inconsistent `suite:registry` vs `mydocs:suite:registry` prefixes are normalized to
 * always carry the app id). The CURRENT app is reported installed at its running version by
 * default; siblings default to not-installed until the OS reports otherwise.
 *
 * Provides BOTH halves an `AppCatalog` needs: `getLocalState`/`setLocalState`, plus a
 * registry cache (`listPublishedApps`/`cachePublishedApps`) that unions the cached OTA
 * registry over the app's baked seed so the current app never vanishes.
 */
export interface LocalStateAdapter {
  getLocalState(appId: string): Promise<AppLocalState>;
  setLocalState(appId: string, state: AppLocalState): Promise<void>;
  /** OTA-cached registry (if any) unioned over `seed`; the seed always survives. */
  listPublishedApps(seed: PublishedApp[]): Promise<PublishedApp[]>;
  /** Persist a freshly-verified registry from a suite `registry` target. */
  cachePublishedApps(apps: PublishedApp[]): void;
}

export interface LocalStateAdapterOptions {
  /** The version reporter for the current app. Defaults to {@link currentAppVersion}. */
  appVersion?: () => Promise<string | undefined>;
  /** Storage override (tests). Defaults to `localStorage` when present, else a no-op. */
  storage?: () => SuiteStorageLike | null;
}

/**
 * Build the localStorage-backed local-state + registry-cache adapter for one app. `appId`
 * is the CURRENT app id (reported installed) and the key namespace.
 */
export function createLocalStateAdapter(appId: string, opts: LocalStateAdapterOptions = {}): LocalStateAdapter {
  const appVersion = opts.appVersion ?? currentAppVersion;
  const storage = opts.storage ?? (() => (typeof localStorage !== "undefined" ? localStorage : null));
  const localKey = (id: string) => `${appId}:suite:local:${id}`;
  const registryKey = `${appId}:suite:registry`;

  return {
    getLocalState: async (id) => {
      try {
        const raw = storage()?.getItem(localKey(id));
        if (raw) return JSON.parse(raw) as AppLocalState;
      } catch {
        /* fall through to defaults */
      }
      if (id === appId) {
        return { installed: true, installedVersion: await appVersion(), phoneSyncEnabled: false };
      }
      return { installed: false, phoneSyncEnabled: false };
    },
    setLocalState: async (id, state) => {
      try {
        storage()?.setItem(localKey(id), JSON.stringify(state));
      } catch {
        /* ignore — storage full / unavailable */
      }
    },
    listPublishedApps: async (seed) => {
      let cached: PublishedApp[] | null = null;
      try {
        const raw = storage()?.getItem(registryKey);
        if (raw) cached = JSON.parse(raw) as PublishedApp[];
      } catch {
        cached = null;
      }
      if (!cached || cached.length === 0) return seed;
      // OTA registry wins; keep any seed apps it omits so the current app never vanishes.
      const byId = new Map(cached.map((a) => [a.appId, a] as const));
      for (const s of seed) if (!byId.has(s.appId)) byId.set(s.appId, s);
      return [...byId.values()];
    },
    cachePublishedApps: (apps) => {
      try {
        storage()?.setItem(registryKey, JSON.stringify(apps));
      } catch {
        /* ignore — storage full / unavailable */
      }
    },
  };
}

export interface SuiteCatalogOptions {
  /** The current app id (flags the current row; key namespace for the local-state adapter). */
  appId: string;
  /** This app's baked published-apps seed (kept app-side — it varies per app). */
  seed: PublishedApp[];
  /** Open a URL in the OS browser/store (native opener); the catalog gates it. */
  openExternal: (url: string) => Promise<void>;
  /**
   * Read the published-apps registry. Defaults to the built-in {@link createLocalStateAdapter}
   * cache unioned over `seed`. Pass to use a custom source (e.g. an existing app adapter).
   */
  listPublishedApps?: () => Promise<PublishedApp[]>;
  /** Local-state adapter override; defaults to one built from `appId`. */
  localState?: Pick<LocalStateAdapter, "getLocalState" | "setLocalState">;
  /**
   * Launch an installed sibling. Defaults to the suite-standard best-effort URL-scheme
   * launch (`${appId}://open`) falling back to the marketing page.
   */
  launchApp?: (app: PublishedApp) => Promise<void>;
  /** Active-platform detector; defaults to {@link detectPlatform}. */
  platform?: () => string | undefined;
  /** Suite entitlements (Patron/Partner) gating access-restricted apps. Default: none. */
  entitlements?: () => Promise<Entitlements>;
  /** https origin allow-list for feed-supplied URLs (forwarded to {@link createAppCatalog}). */
  allowedUrlHosts?: string[];
  /** Storage override for the default local-state adapter (tests). */
  storage?: () => SuiteStorageLike | null;
}

/**
 * One-call marketplace catalog wiring for a suite app — folds the four byte-identical glue
 * files (platform + version + localState + registry + catalog) into a single DI factory.
 * The app supplies only what genuinely varies: `appId`, its baked `seed`, and `openExternal`
 * (everything else has a suite-standard default, overridable). Returns the same {@link AppCatalog}
 * as {@link createAppCatalog}.
 */
export function createSuiteCatalog(opts: SuiteCatalogOptions): AppCatalog {
  const defaultAdapter = createLocalStateAdapter(opts.appId, { storage: opts.storage });
  const local = opts.localState ?? defaultAdapter;
  const listPublishedApps = opts.listPublishedApps ?? (() => defaultAdapter.listPublishedApps(opts.seed));
  const launchApp =
    opts.launchApp ??
    (async (app: PublishedApp) => {
      // Try the app's own deep-link scheme first. This URL is APP-constructed (not user
      // input), so it must NOT go through `openExternal` — that helper fails closed on
      // anything outside https/tel/mailto (to drop untrusted javascript:/data: links) and
      // would silently swallow `appId://open`, launching nothing and skipping the fallback.
      // Open it via the raw opener; on any failure (scheme not registered / not installed),
      // fall back to the marketing page through the guarded opener.
      if (isTauri()) {
        try {
          const { openUrl } = await import("@tauri-apps/plugin-opener");
          await openUrl(`${app.appId}://open`);
          return;
        } catch {
          /* no handler registered for the scheme — fall through to marketing */
        }
      }
      await opts.openExternal(app.marketingUrl);
    });
  return createAppCatalog({
    currentAppId: opts.appId,
    listPublishedApps,
    getLocalState: local.getLocalState,
    setLocalState: local.setLocalState,
    openExternal: opts.openExternal,
    launchApp,
    platform: opts.platform ?? detectPlatform,
    entitlements: opts.entitlements,
    allowedUrlHosts: opts.allowedUrlHosts,
  });
}

// ── Issue reporter (dedup: identical "Report an issue" wiring across apps) ────
//
// Several apps (myFinance, myHealth, myHome) shipped the same `reportIssue.ts`: a fixed
// list of issue types, app+OS context collection, and a prefilled GitHub new-issue URL.
// Promoted here as a DI factory parameterized only by the receiving `repo` (and an optional
// default tier label). Pure helpers + dynamic Tauri imports — import-safe in the browser/SSR.

export type IssueType = "bug" | "feature" | "question";

/** The fixed issue-type vocabulary (value + human label + GitHub label). Identical in every app. */
export const ISSUE_TYPES: { value: IssueType; label: string; label_gh: string }[] = [
  { value: "bug", label: "Bug — something is broken", label_gh: "bug" },
  { value: "feature", label: "Feature request — an idea or improvement", label_gh: "enhancement" },
  { value: "question", label: "Question — need help or clarification", label_gh: "question" },
];

export interface IssueDraft {
  type: IssueType;
  title: string;
  description: string;
  steps?: string;
  includeContext: boolean;
  /** The reporter's engagement tier label (e.g. "Newcomer", "Patron"). */
  tierLabel: string;
}

/** Indefinite article that reads naturally before a tier label ("an Expert", "a Patron"). */
export function article(word: string): string {
  return /^[aeiou]/i.test(word) ? "an" : "a";
}

export interface IssueReporter {
  /** The receiving repo (e.g. "tokans/myFinance"). */
  readonly repo: string;
  readonly ISSUE_TYPES: typeof ISSUE_TYPES;
  /** Indefinite article for a tier label. */
  article(word: string): string;
  /** Best-effort app + OS context appended to the issue body. Never throws. */
  collectContext(): Promise<string>;
  /** Build the prefilled GitHub "new issue" URL (GitHub prompts the user to sign in to submit). */
  buildIssueUrl(draft: IssueDraft, context: string): string;
}

/**
 * Build an issue reporter bound to one repo. `defaultTierLabel` (default "Newcomer") is used
 * when a draft's `tierLabel` is blank. No module state; the Tauri APIs are dynamically
 * imported in `collectContext` so this is import-safe everywhere.
 */
export function createIssueReporter(opts: { repo: string; defaultTierLabel?: string }): IssueReporter {
  const defaultTier = opts.defaultTierLabel ?? "Newcomer";

  const collectContext = async (): Promise<string> => {
    const lines: string[] = [];
    try {
      if (isTauri()) {
        const { getVersion, getTauriVersion } = await import("@tauri-apps/api/app");
        const os = await import("@tauri-apps/plugin-os");
        const [appVer, tauriVer] = await Promise.all([getVersion(), getTauriVersion()]);
        lines.push(`- App version: ${appVer}`);
        lines.push(`- Platform: ${os.platform()} ${os.version()} (${os.arch()})`);
        lines.push(`- Tauri: ${tauriVer}`);
      } else {
        lines.push(`- Environment: web (npm run dev)`);
        lines.push(`- User agent: ${typeof navigator !== "undefined" ? navigator.userAgent : "unknown"}`);
      }
    } catch {
      // Context is a nicety, not a requirement — drop it silently on failure.
    }
    return lines.join("\n");
  };

  const buildIssueUrl = (draft: IssueDraft, context: string): string => {
    const tier = draft.tierLabel.trim() || defaultTier;
    const lead = `I am ${article(tier)} ${tier} user and ${draft.description.trim()}`;
    const bodyParts = [lead];
    if (draft.steps?.trim()) bodyParts.push(`### Steps to reproduce\n${draft.steps.trim()}`);
    if (draft.includeContext && context) bodyParts.push(`### Environment\n${context}`);

    const gh = ISSUE_TYPES.find((t) => t.value === draft.type);
    const params = new URLSearchParams({
      title: draft.title.trim(),
      body: bodyParts.filter(Boolean).join("\n\n"),
    });
    if (gh?.label_gh) params.set("labels", gh.label_gh);
    return `https://github.com/${opts.repo}/issues/new?${params.toString()}`;
  };

  return { repo: opts.repo, ISSUE_TYPES, article, collectContext, buildIssueUrl };
}
