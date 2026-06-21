/**
 * Per-app dev-server port allocation so EVERY suite app (and any NEW app built on
 * sharedCoreLib) binds a UNIQUE, stable Vite/Tauri dev port — letting several apps run at
 * the same time instead of fighting over 1420.
 *
 * The constraint: Tauri reads `devUrl` (a fixed port) from its config BEFORE it starts the
 * `beforeDevCommand`, and Vite binds with `strictPort: true`, so the two MUST agree on an
 * exact port. Apps historically hardcoded `1420` on both sides — which means only one app
 * could ever run, and a stray process on 1420 broke dev entirely. Just letting Vite pick a
 * random free port doesn't work either: Tauri would still be pointed at the old `devUrl`.
 *
 * The fix is two cooperating pieces:
 *   1. A DETERMINISTIC preferred port derived from the app's Tauri `identifier`
 *      (`com.myfinance.app` → always the same port). Different apps spread across the range,
 *      and each app's URL is stable run-to-run (nice for bookmarks / OS window state).
 *   2. `sync-dev-port.mjs` — run as an npm `predev` / `pretauri:dev` hook — resolves the
 *      first ACTUALLY-FREE port at/after the preferred one and writes it to a gitignored
 *      `src-tauri/.dev.conf.json`. Tauri merges that overlay via `tauri dev --config`, and
 *      this module reads the same overlay so Vite binds the identical port. Net result:
 *      zero clashes between apps, graceful fallback when a port is taken by anything else,
 *      and the committed config never churns.
 *
 * Consume from an app's vite.config.ts:
 *
 *   import { devServer } from "sharedcorelib/vite";
 *   const host = process.env.TAURI_DEV_HOST;
 *   export default defineConfig({
 *     server: devServer({ host }),
 *     // ...
 *   });
 */
import fs from "node:fs";
import path from "node:path";

/** Dev ports live in [BASE_PORT, BASE_PORT + PORT_SPAN). HMR mirrors each at +1000. */
const BASE_PORT = 1420;
// 256 keeps every current suite identifier collision-free (range [1420, 1675]; HMR →
// [2420, 2675], no overlap). A future collision is harmless anyway — sync-dev-port.mjs
// linear-probes to the next free port at dev time.
const PORT_SPAN = 256;

/** FNV-1a 32-bit — a small, stable, dependency-free string hash. */
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Deterministic preferred dev port for a Tauri identifier (e.g. "com.myfinance.app").
 * Pure function of the identifier, so it is identical in vite.config and sync-dev-port.mjs.
 * @param {string} identifier
 * @returns {number}
 */
export function preferredDevPort(identifier) {
  return BASE_PORT + (fnv1a(String(identifier || "app")) % PORT_SPAN);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Extract the port from a "http://localhost:1487" / "http://localhost:1487/" devUrl. */
function portFromDevUrl(url) {
  const m = typeof url === "string" && url.match(/:(\d{2,5})(?:\/|$)/);
  return m ? Number(m[1]) : null;
}

/**
 * Resolve the dev port for the app rooted at `cwd`, in priority order:
 *   1. the free port chosen by sync-dev-port.mjs (src-tauri/.dev.conf.json devUrl);
 *   2. else the deterministic preferred port from src-tauri/tauri.conf.json's identifier;
 *   3. else the committed devUrl's port, finally BASE_PORT.
 * @param {string} [cwd]
 * @returns {number}
 */
export function resolveDevPort(cwd = process.cwd()) {
  const tauriDir = path.join(cwd, "src-tauri");

  const overlayPort = portFromDevUrl(readJson(path.join(tauriDir, ".dev.conf.json"))?.build?.devUrl);
  if (overlayPort) return overlayPort;

  const conf = readJson(path.join(tauriDir, "tauri.conf.json"));
  if (conf?.identifier) return preferredDevPort(conf.identifier);

  return portFromDevUrl(conf?.build?.devUrl) || BASE_PORT;
}

/**
 * Build the Vite `server` config block for a suite app. Drop the result straight into
 * defineConfig({ server: devServer({ host }) }); for an app that needs extra `server`
 * fields, spread it: server: { ...devServer({ host }), fs: { allow: [...] } }.
 * @param {{ host?: string|false, cwd?: string }} [opts]
 * @returns {import("vite").ServerOptions}
 */
export function devServer({ host, cwd } = {}) {
  const port = resolveDevPort(cwd);
  return {
    port,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: port + 1000 } : undefined,
    watch: { ignored: ["**/src-tauri/**"] },
  };
}
