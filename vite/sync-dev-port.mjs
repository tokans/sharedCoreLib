/**
 * sync-dev-port.mjs — pick the first FREE dev port at/after this app's deterministic
 * preferred port and write it to a gitignored Tauri config overlay (src-tauri/.dev.conf.json)
 * that both Tauri and Vite consume, so several suite apps can run dev at the same time
 * without clashing on 1420. See ./dev-server.mjs for the full design.
 *
 * Wire it into an app's package.json (it MUST run before Tauri reads its config, hence the
 * `pre*` hooks; the path resolves through the `file:../sharedCoreLib` symlink):
 *
 *   "predev":       "node node_modules/sharedcorelib/vite/sync-dev-port.mjs",
 *   "pretauri:dev": "node node_modules/sharedcorelib/vite/sync-dev-port.mjs",
 *   "tauri:dev":    "tauri dev --config src-tauri/.dev.conf.json"
 *
 * And gitignore the overlay:  src-tauri/.dev.conf.json
 *
 * Runs in the app's cwd (npm sets it), reading ./src-tauri/tauri.conf.json.
 */
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { preferredDevPort } from "./dev-server.mjs";

const cwd = process.cwd();
const tauriDir = path.join(cwd, "src-tauri");
const confPath = path.join(tauriDir, "tauri.conf.json");
const outPath = path.join(tauriDir, ".dev.conf.json");

/** Probe one interface: "busy" only on EADDRINUSE, "skip" if the stack is unavailable. */
function probe(port, host) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once("error", (e) => resolve(e.code === "EADDRINUSE" ? "busy" : "skip"));
    srv.once("listening", () => srv.close(() => resolve("free")));
    srv.listen(port, host);
  });
}

/**
 * Is `port` bindable right now? Vite binds "localhost", which on Windows resolves to ::1
 * (and often 127.0.0.1 too), so we must check BOTH stacks — an orphaned Vite holding only
 * ::1:<port> is the common case, and an IPv4-only probe would miss it and hand Vite a
 * port it then fails to bind. A stack that simply isn't present ("skip") doesn't veto.
 */
async function isFree(port) {
  for (const host of ["127.0.0.1", "::1"]) {
    if ((await probe(port, host)) === "busy") return false;
  }
  return true;
}

/** First free port at/after `start` (scans a bounded window, then gives up gracefully). */
async function firstFree(start) {
  for (let p = start; p < start + 200; p++) {
    if (await isFree(p)) return p;
  }
  return start; // let Vite's strictPort surface the clash rather than guess wildly
}

function readIdentifier() {
  try {
    const conf = JSON.parse(fs.readFileSync(confPath, "utf8"));
    if (conf.identifier) return conf.identifier;
  } catch {
    /* fall through to the directory-name fallback */
  }
  return path.basename(cwd);
}

const identifier = readIdentifier();
const preferred = preferredDevPort(identifier);
const port = await firstFree(preferred);
const devUrl = `http://localhost:${port}`;

// Only the dev `devUrl` belongs in the overlay; Tauri merges it over tauri.conf.json.
const next = JSON.stringify({ build: { devUrl } }, null, 2) + "\n";
const prev = fs.existsSync(outPath) ? fs.readFileSync(outPath, "utf8") : "";
if (prev !== next) {
  fs.mkdirSync(tauriDir, { recursive: true });
  fs.writeFileSync(outPath, next);
}

const note = port === preferred ? "" : ` (preferred ${preferred} busy)`;
console.log(`[dev-port] ${identifier} → ${devUrl}${note}`);
