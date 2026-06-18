/**
 * Build-time Vite wiring for the OPTIONAL Excel backup password (`sharedcorelib/backup`).
 *
 * Why this lives in core: `backup/index.ts` lazy-loads `officecrypto-tool` for ECMA-376
 * agile workbook encryption. That library — and its xml2js/sax deps — is written for Node:
 * it does `require('crypto')` and uses `Buffer`/`stream`/`events`/`timers`, none of which
 * exist in the Tauri webview a suite app ships in. Without polyfills Vite externalizes
 * those built-ins to empty stubs and a password-protected export/import THROWS at runtime.
 *
 * Every app that mounts the shared `BackupPanel` (which exposes the password field) needs
 * the identical fix, so it is centralized here instead of copy-pasted into each app's
 * `vite.config.ts`. Spread the result into the app config:
 *
 *   import { backupVite } from "sharedcorelib/vite";
 *   const backup = backupVite();
 *   export default defineConfig({
 *     plugins: [react(), ...backup.plugins],
 *     resolve: { alias: { "@": ..., ...backup.alias } },
 *     build: { chunkSizeWarningLimit: backup.chunkSizeWarningLimit, ... },
 *   });
 *
 * (For an app whose `resolve.alias` is the ARRAY form, map it:
 *   ...Object.entries(backup.alias).map(([find, replacement]) => ({ find, replacement })) )
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// Resolve the plugin's install location from HERE (sharedCoreLib) so the shim aliases and
// the vm stub are ABSOLUTE paths that resolve no matter which app consumes core via
// `file:../sharedCoreLib` — the plugin injects bare `vite-plugin-node-polyfills/shims/*`
// imports into app modules (incl. the symlinked `sharedcorelib/backup`), and from that
// location the bare specifier would not otherwise resolve.
const pluginEntry = fileURLToPath(import.meta.resolve("vite-plugin-node-polyfills"));
const pluginRoot = path.resolve(path.dirname(pluginEntry), ".."); // .../dist/index.js → package root
const here = path.dirname(fileURLToPath(import.meta.url));

const shim = (name) => path.join(pluginRoot, "shims", name, "dist", "index.js");

// Every package the backup-password path drags into the bundle: officecrypto-tool + its
// xml/crypto deps, plus node-stdlib-browser and the crypto-browserify closure the Node
// polyfills pull in. Used by `isBackupModule()` so apps can keep this whole subtree OFF a
// manualChunks catch-all and let rolldown default-split it onto the lazy backup chunk.
const BACKUP_PKGS = new Set([
  "vite-plugin-node-polyfills",
  // officecrypto-tool + its direct xml/crypto deps
  "officecrypto-tool", "xml2js", "sax", "cfb", "crypto-js", "xmlbuilder", "object-hash",
  // node-stdlib-browser + the polyfilled built-ins
  "node-stdlib-browser", "buffer", "events", "stream-browserify", "readable-stream",
  "timers-browserify", "isomorphic-timers-promises", "util", "process",
  "process-nextick-args", "inherits", "safe-buffer", "string_decoder", "util-deprecate",
  "core-util-is", "vm-browserify",
  // the crypto-browserify closure
  "crypto-browserify", "browserify-aes", "browserify-cipher", "browserify-des",
  "browserify-rsa", "browserify-sign", "evp_bytestokey", "create-hash", "create-hmac",
  "cipher-base", "hash-base", "hash.js", "md5.js", "sha.js", "ripemd160", "pbkdf2",
  "randombytes", "randomfill", "diffie-hellman", "public-encrypt", "parse-asn1",
  "asn1.js", "bn.js", "miller-rabin", "elliptic", "hmac-drbg", "des.js", "brorand",
  "minimalistic-assert", "minimalistic-crypto-utils",
]);
const PKG_RE = /[\\/]node_modules[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/;

/**
 * Is `id` part of the backup-password module subtree (officecrypto + Node polyfills)?
 * Apps whose `manualChunks` has a catch-all (`return "vendor"`) should early-return
 * `undefined` for these so the whole subtree stays on rolldown's lazy default split
 * instead of being yanked into the eager `vendor` chunk. See ./backup-polyfills.mjs.
 * @param {string} id
 * @returns {boolean}
 */
export function isBackupModule(id) {
  const m = PKG_RE.exec(id);
  return m ? BACKUP_PKGS.has(m[1].replace(/\\/g, "/")) : false;
}

/**
 * @returns {{ plugins: import("vite").PluginOption[], alias: Record<string, string>, chunkSizeWarningLimit: number, isBackupModule: (id: string) => boolean }}
 */
export function backupVite() {
  return {
    isBackupModule,
    plugins: [
      // Scope the polyfills to exactly what the backup-password path pulls in; they ride
      // only in the lazy backup chunk (Settings → Backup), never first paint.
      nodePolyfills({
        include: ["buffer", "crypto", "stream", "events", "timers", "util", "process"],
        globals: { Buffer: true, global: true, process: true },
      }),
    ],
    alias: {
      "vite-plugin-node-polyfills/shims/buffer": shim("buffer"),
      "vite-plugin-node-polyfills/shims/global": shim("global"),
      "vite-plugin-node-polyfills/shims/process": shim("process"),
      // `vm` rides in via crypto-browserify's asn1.js, but only on the asymmetric/RSA path
      // the symmetric officecrypto code never touches. Resolve it to an empty stub (vs.
      // letting Vite externalize it, which warns, or polyfilling it with eval-based
      // vm-browserify). See ./empty-module.js.
      vm: path.join(here, "empty-module.js"),
    },
    // The lazy officecrypto chunk is ~950 KB (it carries the crypto-browserify Node-crypto
    // polyfill) and xlsx is ~500 KB — both code-split off first paint. Raise the warning
    // floor so those expected, isolated chunks don't trip it.
    chunkSizeWarningLimit: 1100,
  };
}
