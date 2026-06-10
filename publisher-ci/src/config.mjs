// Loads the consuming app's security config (sharedcorelib.security.json) and
// fills in safe defaults. The config points at the trust manifest + signing config
// and tunes the thresholds the checks enforce.
import { join } from "node:path";
import { readJson, fileExists } from "./util.mjs";

export const CONFIG_FILE = "sharedcorelib.security.json";

export const DEFAULTS = {
  coreVersion: null, // the shared-runtime version this app targets, e.g. "1.4.0"
  deprecationWindow: 3, // honored backward-compat window, in core versions
  trustManifest: "publisher.trust.json",
  releaseSigning: "release.signing.json",
  deprecations: "deprecations.json",
  source: { include: ["src", "src-tauri/src"], ignore: [] },
  kdf: { minPbkdf2Iterations: 600000, requireFormatHeader: true },
  criticalDeps: [
    "sharedcorelib",
    "@noble/ed25519",
    "@noble/hashes",
    "@tauri-apps/plugin-stronghold",
    "@tauri-apps/plugin-http",
  ],
  feed: { requireHttps: true },
  // Shared-DB schema registry: the app's semantic schema manifest + an optional
  // snapshot of the already-registered shared schemas to conflict-check against.
  schema: {
    manifest: "schema.manifest.json",
    registry: "shared-schemas.json",
  },
  // Cross-account release pipeline (publish builds + gh-pages to a publisher account).
  release: {
    publishOwner: "tokans",
    workflow: ".github/workflows/release.yml",
    requirePublishToken: true,
    // Feed/code signing must stay OFFLINE — no signing private keys in CI (THREAT_MODEL §2).
    forbidInCiSigningKeys: true,
  },
  // Check ids to skip (e.g. a library skips app-deployment checks it doesn't own).
  skipChecks: [],
  // Checks whose findings at/above this level fail the build (exit 1).
  failOn: "high", // one of: critical, high, medium, low
};

/** Deep-ish merge: objects merge, everything else is replaced by the override. */
function merge(base, over) {
  if (!over || typeof over !== "object" || Array.isArray(over)) return over ?? base;
  const out = { ...base };
  for (const k of Object.keys(over)) {
    out[k] = (base && typeof base[k] === "object" && !Array.isArray(base[k]))
      ? merge(base[k], over[k])
      : over[k];
  }
  return out;
}

export function loadConfig(appDir) {
  const path = join(appDir, CONFIG_FILE);
  if (!fileExists(path)) {
    return { config: { ...DEFAULTS }, configPath: null };
  }
  const raw = readJson(path);
  if (raw?.__parseError) {
    throw new Error(`${CONFIG_FILE} is not valid JSON`);
  }
  return { config: merge(DEFAULTS, raw), configPath: path };
}
