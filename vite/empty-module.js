// Empty stub for Node's `vm`, aliased by the `backupVite()` helper (./backup-polyfills.mjs).
//
// `vm` is pulled in transitively by crypto-browserify's asn1.js — but ONLY on the
// asymmetric/RSA codegen path. The one consumer in the suite, officecrypto-tool's
// ECMA-376 agile encryption (the optional Excel backup password), is purely symmetric
// (AES-CBC + SHA-512) and never reaches it. So a real `vm` is unreachable: this empty
// module resolves it cleanly (no "externalized for browser" warning) without dragging in
// vm-browserify, which relies on direct `eval` (bundle bloat + a Tauri-CSP hazard).
export default {};
