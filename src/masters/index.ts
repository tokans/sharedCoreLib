/**
 * Masters / over-the-air reference-data engine — app-agnostic.
 *
 * Provides the reusable MECHANISM only:
 *   - signed-bundle verification + decryption (Ed25519 sig → revision/compat
 *     gates → per-file SHA-256 → AES-256-GCM transport decrypt),
 *   - the 4-layer option merge + dropdown/autocomplete mode pick,
 *   - an adapter-driven OTA updater factory (throttle → fetch → verify → apply).
 *
 * The APP supplies (via config/adapters): its release repo/tag base URL, its
 * signing public key + transport key, its OWN master registry + zod schemas,
 * which bundle types exist (e.g. "partner"), how to read the applied revision,
 * and how to apply each verified entry to its OWN SQLite. Nothing here knows a
 * single finance- or health-specific master id.
 *
 * Receive-only: the updater pulls public signed data and uploads nothing.
 */
import { z } from "zod";
import { verifyAsync, etc } from "@noble/ed25519";
import { isTauri } from "../env/index.js";
import { COMMON_SCOPE } from "./common.js";

// Common masters + the scope/namespacing convention that keeps a shared store
// conflict-free. Re-exported so `sharedcorelib/masters` is the one import surface.
export {
  COMMON_SCOPE,
  qualifyMasterKey,
  parseMasterKey,
  isCommonMaster,
  getCommonBaked,
  // City seed is lazy (heavy JSON kept out of the eager bundle). `getCommonBaked`
  // returns [] for cities until `loadCommonCities()` has resolved once; consumers
  // prewarm via these, or fetch directly via the async `getBakedCities`.
  loadCommonCities,
  getBakedCities,
  COMMON_MASTER_IDS,
  type CommonMasterId,
} from "./common.js";

// ── Option merge (4-layer) ──────────────────────────────────────────────────

/** One option in a finite set. `source` drives sort priority + de-dupe wins. */
export interface MasterOption {
  value: string;
  label: string;
  icon?: string;
  source?: "baked" | "live" | "custom" | "remote";
}

/** Below this many real options a finite-set input is a dropdown; at/above, autocomplete. */
export const DROPDOWN_MAX = 10;
export type InputMode = "dropdown" | "autocomplete";
export function pickMode(optionCount: number): InputMode {
  return optionCount < DROPDOWN_MAX ? "dropdown" : "autocomplete";
}

const keyOf = (o: MasterOption) => o.value.trim().toLowerCase();

/**
 * Merge ordered option groups into one de-duplicated list. Groups are layered in
 * the order given; the first occurrence of a value wins (de-dupe + label/icon).
 * Null groups (e.g. an offline live fetch) are skipped. Apps call it in priority
 * order: remote (OTA) ⊕ baked ⊕ live ⊕ custom.
 */
export function mergeMasterOptions(
  ...groups: Array<MasterOption[] | null | undefined>
): MasterOption[] {
  const seen = new Set<string>();
  const out: MasterOption[] = [];
  for (const group of groups) {
    for (const o of group ?? []) {
      const k = keyOf(o);
      if (!k || seen.has(k)) continue;
      seen.add(k);
      out.push(o);
    }
  }
  return out;
}

// ── Verification engine ─────────────────────────────────────────────────────

const IV_LEN = 12;
const TAG_LEN = 16;

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const textDecode = (b: Uint8Array): string => new TextDecoder().decode(b);

/**
 * TS narrows `Uint8Array` to `Uint8Array<ArrayBufferLike>`, which WebCrypto's
 * `BufferSource` rejects. Our buffers are never SharedArrayBuffer-backed.
 */
const asSource = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

/** Compare a dotted app version against a required minimum. Pads missing parts with 0. */
export function meetsMinVersion(appVersion: string, minVersion: string): boolean {
  const a = appVersion.split(".").map(Number);
  const m = minVersion.split(".").map(Number);
  for (let i = 0; i < Math.max(a.length, m.length); i++) {
    const x = a[i] ?? 0;
    const y = m[i] ?? 0;
    // Fail closed on a malformed segment (Number("x") === NaN) — NaN comparisons
    // are all false, which would otherwise silently treat the gate as "meets".
    if (Number.isNaN(x) || Number.isNaN(y)) return false;
    if (x > y) return true;
    if (x < y) return false;
  }
  return true;
}

/** Verify a detached Ed25519 signature over the raw manifest bytes. Never throws. */
export async function verifyManifestSignature(
  manifestBytes: Uint8Array,
  sigBytes: Uint8Array,
  pubkeyHex: string,
): Promise<boolean> {
  try {
    // zip215:false → strict RFC8032 semantics, matching the Node signer.
    return await verifyAsync(sigBytes, manifestBytes, etc.hexToBytes(pubkeyHex), { zip215: false });
  } catch {
    return false;
  }
}

// sha256Hex lives in the dependency-free `./hash.js` leaf so the offline feed-builder
// can hash without importing this engine; re-exported here to keep the public surface.
import { sha256Hex } from "./hash.js";
export { sha256Hex };

/** AES-256-GCM decrypt a `iv(12) || ciphertext || tag(16)` blob with the transport key. */
export async function decryptTransport(enc: Uint8Array, keyB64: string): Promise<Uint8Array> {
  if (enc.length < IV_LEN + TAG_LEN) throw new Error("ciphertext too short");
  const key = await crypto.subtle.importKey("raw", asSource(b64ToBytes(keyB64)), { name: "AES-GCM" }, false, [
    "decrypt",
  ]);
  const iv = enc.subarray(0, IV_LEN);
  const body = enc.subarray(IV_LEN); // ciphertext || tag together for Web Crypto
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: asSource(iv) }, key, asSource(body));
  return new Uint8Array(plain);
}

export interface VerifiedEntry {
  /** Manifest entry id — an app master id, or a bundle type like "partner". */
  id: string;
  /** Per-master revision this payload was published at. */
  version: number;
  /** Decrypted, JSON-parsed payload — NOT yet shape-validated (caller does that per id). */
  payload: unknown;
}

/** The minimal manifest shape the engine relies on; apps may parse to a stricter type. */
export interface BaseManifest {
  revision: number;
  minAppVersion: string;
  entries: Array<{ id: string; file: string; bytes: number; sha256: string; version: number }>;
}

/** Anything with a `.parse()` that yields a {@link BaseManifest}-compatible value (a zod schema qualifies). */
export interface ManifestSchemaLike<T extends BaseManifest> {
  parse(data: unknown): T;
}

/**
 * A generic, app-agnostic manifest schema. Entry `id` is a free string here;
 * apps that want to restrict the id set pass their own stricter schema instead.
 */
export const genericManifestSchema = z.object({
  revision: z.number().int().nonnegative(),
  generatedAt: z.string().min(1),
  schemaVersion: z.number().int().positive(),
  minAppVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
  entries: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        file: z.string().min(1).max(128),
        bytes: z.number().int().nonnegative(),
        sha256: z.string().regex(/^[0-9a-f]{64}$/),
        version: z.number().int().nonnegative(),
      }),
    )
    .min(1),
});

/** What a manifest entry pins its file to — passed to {@link VerifyOptions.fetchFile} so a cache can self-validate. */
export interface ExpectedFile {
  sha256: string;
  bytes: number;
}

export interface VerifyOptions<T extends BaseManifest = BaseManifest> {
  /**
   * Fetch a ciphertext file by its manifest filename. `expected` (when provided) lets a
   * caching layer validate a cache hit against the signed manifest before trusting it.
   */
  fetchFile: (file: string, expected?: ExpectedFile) => Promise<Uint8Array>;
  pubkeyHex: string;
  transportKeyB64: string;
  /** Override the manifest validation schema (default: {@link genericManifestSchema}). */
  manifestSchema?: ManifestSchemaLike<T>;
  /** Reject manifests whose revision is ≤ this (anti-downgrade). */
  lastRevision?: number;
  /** This binary's version, gated against `minAppVersion`. */
  appVersion?: string;
}

/**
 * Full verify-then-decrypt pass over a signed manifest. Throws on any failure
 * (bad signature, stale revision, incompatible app version, size/hash mismatch,
 * decrypt failure) so the caller can fail silently and keep the existing data.
 * Order is signature → revision/compat → per-file hash → decrypt: nothing is
 * decrypted before it is authenticated.
 */
export async function verifyAndDecryptManifest<T extends BaseManifest = BaseManifest>(
  manifestBytes: Uint8Array,
  sigBytes: Uint8Array,
  opts: VerifyOptions<T>,
): Promise<{ manifest: T; entries: VerifiedEntry[] }> {
  if (!(await verifyManifestSignature(manifestBytes, sigBytes, opts.pubkeyHex))) {
    throw new Error("master manifest signature invalid");
  }

  const schema = (opts.manifestSchema ?? (genericManifestSchema as unknown as ManifestSchemaLike<T>));
  const manifest = schema.parse(JSON.parse(textDecode(manifestBytes)));

  if (opts.lastRevision != null && manifest.revision <= opts.lastRevision) {
    throw new Error(`stale manifest revision ${manifest.revision} <= ${opts.lastRevision}`);
  }
  if (opts.appVersion && !meetsMinVersion(opts.appVersion, manifest.minAppVersion)) {
    throw new Error(`app ${opts.appVersion} below required ${manifest.minAppVersion}`);
  }

  const entries: VerifiedEntry[] = [];
  for (const e of manifest.entries) {
    const enc = await opts.fetchFile(e.file, { sha256: e.sha256, bytes: e.bytes });
    if (enc.length !== e.bytes) throw new Error(`size mismatch for ${e.file}`);
    if ((await sha256Hex(enc)) !== e.sha256) throw new Error(`sha256 mismatch for ${e.file}`);
    const plain = await decryptTransport(enc, opts.transportKeyB64);
    entries.push({ id: e.id, version: e.version, payload: JSON.parse(textDecode(plain)) });
  }
  return { manifest, entries };
}

// ── Shared on-disk bundle cache (the L2 reuse win) ──────────────────────────
//
// CONTRACT §5.4: the FIRST suite app to pull downloads the signed bundle into the
// shared masters dir; the SECOND reuses those bytes — no second download. Entry
// ciphertexts are content-addressed (the signed manifest pins each by SHA-256), so a
// cache hit is validated against the manifest before it is trusted; a stale/poisoned
// cache entry simply misses and is re-fetched. The manifest + signature themselves are
// NEVER cached (always fetched fresh) so revision/freshness gating stays current.

/** Minimal filesystem the bundle cache needs. Injected (DI) so the cache is testable without Tauri. */
export interface CacheFs {
  exists(path: string): Promise<boolean>;
  readFile(path: string): Promise<Uint8Array>;
  writeFile(path: string, data: Uint8Array): Promise<void>;
  /** Create a directory (recursive); best-effort, must not throw if it already exists. */
  mkdir(path: string): Promise<void>;
}

/** Join cache path parts with `/` (Tauri's fs plugin accepts forward slashes on every OS). */
function joinCachePath(...parts: string[]): string {
  return parts.map((p) => p.replace(/[\\/]+$/, "")).join("/");
}

export interface CachedFetchOptions {
  /** Fetch the file from the network (the throw-on-error transport). */
  fetchNetwork: (file: string) => Promise<Uint8Array>;
  fs: CacheFs;
  /** Shared cache root (the L2 masters dir injected by the bootstrap). */
  dir: string;
  /** Per-app/per-scope subdir so apps sharing `dir` never collide on filenames. */
  namespace: string;
}

/**
 * A `fetchFile` that reads through a shared on-disk cache. On a hit it validates the
 * cached bytes against the manifest's `expected` {size, sha256}; only a matching hit
 * skips the network. A miss (or a failed validation) fetches from the network and
 * writes the bytes back to the cache for the next app. All cache IO is best-effort:
 * any fs error falls back to the network so an update never fails because of the cache.
 */
export function createCachedFetch(
  o: CachedFetchOptions,
): (file: string, expected?: ExpectedFile) => Promise<Uint8Array> {
  const nsDir = joinCachePath(o.dir, o.namespace);
  return async (file: string, expected?: ExpectedFile): Promise<Uint8Array> => {
    const path = joinCachePath(nsDir, file);
    try {
      if (await o.fs.exists(path)) {
        const cached = await o.fs.readFile(path);
        // Trust a hit only when it matches the signed manifest (or no expectation given).
        if (!expected || (cached.length === expected.bytes && (await sha256Hex(cached)) === expected.sha256)) {
          return cached;
        }
      }
    } catch {
      // Unreadable cache → fall through to the network.
    }
    const fresh = await o.fetchNetwork(file);
    try {
      await o.fs.mkdir(nsDir);
      await o.fs.writeFile(path, fresh);
    } catch {
      // Cache write is an optimization, never a hard failure.
    }
    return fresh;
  };
}

/** Default cache fs backed by the Tauri fs plugin (lazy-imported; desktop/mobile only). */
async function tauriCacheFs(): Promise<CacheFs> {
  const fs = await import("@tauri-apps/plugin-fs");
  return {
    exists: (p) => fs.exists(p),
    readFile: (p) => fs.readFile(p),
    writeFile: (p, d) => fs.writeFile(p, d),
    mkdir: async (p) => {
      try {
        await fs.mkdir(p, { recursive: true });
      } catch {
        // already exists / race — fine.
      }
    },
  };
}

// ── OTA updater factory ─────────────────────────────────────────────────────

export interface OtaUpdaterConfig<T extends BaseManifest = BaseManifest> {
  /** Base URL of the rolling release that always holds the newest bundle. */
  baseUrl: string;
  /** Manifest filename under baseUrl. Default "masters.manifest.json". */
  manifestFile?: string;
  pubkeyHex: string;
  transportKeyB64: string;
  /** App's stricter manifest schema (optional; defaults to the generic one). */
  manifestSchema?: ManifestSchemaLike<T>;
  /** Anti-downgrade floor — the highest revision already applied. */
  getLastRevision: () => Promise<number>;
  /** Apply one verified entry to the app's own store. Throws to abort the batch. */
  applyEntry: (entry: VerifiedEntry) => Promise<void>;
  /** This binary's version for the minAppVersion gate (undefined → skip the gate). */
  getAppVersion?: () => Promise<string | undefined>;
  /** Whether updates are enabled (default: always). */
  enabled?: () => boolean;
  /** Whether a check is due now (default: always). `force` bypasses this anyway. */
  isDue?: () => boolean;
  /** Record that a check ran (e.g. persist a timestamp). */
  markChecked?: () => void;
  /** Called once after a successful apply with the new manifest revision. */
  onApplied?: (revision: number) => void;
  /**
   * Optional shared on-disk cache directory for downloaded bundles. Injecting the
   * SAME path across suite apps is what lets the FIRST app's download be REUSED by
   * the SECOND (the L2 shared-masters-cache win — see CONTRACT.md §5.4). The bootstrap
   * wires this from the `shared_core_masters_dir` Tauri command; an absent value means
   * "no cache" (always fetch from the network).
   */
  cacheDir?: string;
  /**
   * Filesystem used for {@link cacheDir}. Defaults to the Tauri fs plugin (lazy-imported)
   * when `cacheDir` is set and running under Tauri. Inject a fake in tests.
   */
  cacheFs?: CacheFs;
  /**
   * Namespace under {@link cacheDir} this app's downloaded bundles are written to,
   * so multiple suite apps sharing the cache never collide on filenames. Use the
   * app id for app-specific bundles, or `COMMON_SCOPE` for the shared common
   * masters bundle (downloaded once, reused by all). Defaults to `COMMON_SCOPE`.
   * See CONTRACT.md §5.4 — this is the "no name/search conflicts" guarantee for
   * the shared store.
   */
  cacheNamespace?: string;
}

export interface OtaUpdater {
  /** Run one update check. Returns true if any data was applied. */
  runUpdate(opts?: { force?: boolean }): Promise<boolean>;
}

/**
 * Build an OTA updater bound to one app's config. The in-flight guard is closed
 * over locally (no module state), so each app gets its own. Best-effort and
 * fail-silent: offline, no bundle, bad signature, or a downgrade attempt all
 * just leave existing data untouched and reschedule for the next interval.
 */
export function createOtaUpdater<T extends BaseManifest = BaseManifest>(
  cfg: OtaUpdaterConfig<T>,
): OtaUpdater {
  let inFlight = false;
  const manifestFile = cfg.manifestFile ?? "masters.manifest.json";
  const base = cfg.baseUrl.replace(/\/+$/, "");

  async function fetchBytes(url: string): Promise<Uint8Array> {
    const { fetch } = await import("@tauri-apps/plugin-http");
    const res = await fetch(url);
    if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
    return new Uint8Array(await res.arrayBuffer());
  }

  /** The `.sig` asset is base64 text; decode it to the raw 64-byte signature. */
  function decodeSig(sigFileBytes: Uint8Array): Uint8Array {
    const bin = atob(new TextDecoder().decode(sigFileBytes).trim());
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  /**
   * The entry-file fetcher handed to the verifier: read-through the shared on-disk
   * cache when `cacheDir` is wired (the L2 reuse win), else fetch straight from the
   * network. Resolved per-run so a missing fs plugin can't break a cacheless app.
   */
  async function entryFetcher(): Promise<(file: string, expected?: ExpectedFile) => Promise<Uint8Array>> {
    const fetchNetwork = (file: string) => fetchBytes(`${base}/${file}`);
    if (!cfg.cacheDir) return fetchNetwork;
    let fs = cfg.cacheFs;
    if (!fs) {
      try {
        fs = await tauriCacheFs();
      } catch {
        return fetchNetwork; // no fs plugin → run without a cache.
      }
    }
    return createCachedFetch({
      fetchNetwork,
      fs,
      dir: cfg.cacheDir,
      namespace: cfg.cacheNamespace ?? COMMON_SCOPE,
    });
  }

  async function runUpdate(opts: { force?: boolean } = {}): Promise<boolean> {
    if (!isTauri() || cfg.enabled?.() === false || inFlight) return false;
    if (!opts.force && cfg.isDue && !cfg.isDue()) return false;
    inFlight = true;
    try {
      const [manifestBytes, sigFile] = await Promise.all([
        fetchBytes(`${base}/${manifestFile}`),
        fetchBytes(`${base}/${manifestFile}.sig`),
      ]);

      const { manifest, entries } = await verifyAndDecryptManifest<T>(manifestBytes, decodeSig(sigFile), {
        fetchFile: await entryFetcher(),
        pubkeyHex: cfg.pubkeyHex,
        transportKeyB64: cfg.transportKeyB64,
        manifestSchema: cfg.manifestSchema,
        lastRevision: await cfg.getLastRevision(),
        appVersion: cfg.getAppVersion ? await cfg.getAppVersion() : undefined,
      });

      let applied = 0;
      for (const e of entries) {
        await cfg.applyEntry(e);
        applied++;
      }

      cfg.markChecked?.();
      if (applied > 0) cfg.onApplied?.(manifest.revision);
      return applied > 0;
    } catch (e) {
      // Offline / no bundle / bad signature / downgrade — keep existing data.
      console.debug("ota update check skipped:", e);
      cfg.markChecked?.();
      return false;
    } finally {
      inFlight = false;
    }
  }

  return { runUpdate };
}
