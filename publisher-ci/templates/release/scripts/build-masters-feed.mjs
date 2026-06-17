#!/usr/bin/env node
// build-masters-feed.mjs — OFFLINE producer for the masters OTA bundle the suite
// updater fetches from the feed `baseUrl`. Run this on a trusted, offline machine:
// it loads the secret signing + transport keys, encrypts each master payload, builds
// the signed manifest, and writes the bundle into the feed dir for publish-feed.mjs.
//
//   MASTERS_SIGNING_KEY_FILE=~/.keys/masters-data.key \
//   MASTERS_TRANSPORT_KEY_FILE=~/.keys/masters-transport.key \
//   node scripts/build-masters-feed.mjs masters.feed.json ./dist-suite
//
// Then: node scripts/publish-feed.mjs ./dist-suite   (uploads to the publisher release)
//
// SECURITY (THREAT_MODEL §2): the private DATA signing key NEVER enters CI or the app.
// The byte assembly + AES-GCM live in `sharedcorelib/masters/feed-builder` (key-free);
// ONLY the final ed25519 signature over the manifest bytes happens here, offline.
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { signAsync, getPublicKeyAsync, etc } from "@noble/ed25519";
import { buildMastersManifest } from "sharedcorelib/masters/feed-builder";

const die = (m) => { console.error(`ERROR: ${m}`); process.exit(1); };

const specPath = process.argv[2] ?? "masters.feed.json";
const outDir = process.argv[3] ?? "dist-suite";
const manifestName = "masters.manifest.json";

if (!existsSync(specPath)) die(`feed spec "${specPath}" not found (see masters.feed.json)`);

// ── Secret keys: read from OFFLINE files referenced by env (never inline, never CI) ──
const signingKeyFile = process.env.MASTERS_SIGNING_KEY_FILE;
const transportKeyFile = process.env.MASTERS_TRANSPORT_KEY_FILE;
if (!signingKeyFile) die("set MASTERS_SIGNING_KEY_FILE to the offline ed25519 DATA private key file");
if (!transportKeyFile) die("set MASTERS_TRANSPORT_KEY_FILE to the AES-256 transport key file (base64)");

/** Parse a 32-byte key from a file holding hex (64 chars) or base64. */
function readKey32(path, what) {
  const raw = readFileSync(path, "utf8").trim();
  let bytes;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) bytes = etc.hexToBytes(raw.toLowerCase());
  else { const bin = Buffer.from(raw, "base64"); bytes = new Uint8Array(bin); }
  if (bytes.length !== 32) die(`${what} must be 32 bytes (got ${bytes.length}) — check ${path}`);
  return bytes;
}

const signPriv = readKey32(signingKeyFile, "signing key");
const transportKeyB64 = Buffer.from(readKey32(transportKeyFile, "transport key")).toString("base64");

// ── Feed spec → entries (inline `payload` or `payloadFile` path) ─────────────
const spec = JSON.parse(readFileSync(specPath, "utf8"));
if (!Array.isArray(spec.entries) || spec.entries.length === 0) die("feed spec needs a non-empty `entries` array");
if (typeof spec.revision !== "number") die("feed spec needs a numeric `revision`");
if (typeof spec.minAppVersion !== "string") die("feed spec needs a `minAppVersion` (x.y.z)");

const entries = spec.entries.map((e) => {
  if (!e.id || typeof e.version !== "number") die(`each entry needs an \`id\` and numeric \`version\` (offending: ${JSON.stringify(e)})`);
  const payload = e.payloadFile ? JSON.parse(readFileSync(e.payloadFile, "utf8")) : e.payload;
  if (payload === undefined) die(`entry ${e.id}: provide \`payload\` or \`payloadFile\``);
  return { id: e.id, version: e.version, payload, file: e.file };
});

// ── Anti-rollback guardrail: refuse a revision at/below the one already published ──
const prevManifestPath = join(outDir, manifestName);
if (existsSync(prevManifestPath)) {
  const prev = JSON.parse(readFileSync(prevManifestPath, "utf8"));
  if (typeof prev.revision === "number" && spec.revision <= prev.revision) {
    die(`revision ${spec.revision} must be greater than the published ${prev.revision} (anti-downgrade)`);
  }
}

// ── Build (key-free assembly) → sign the EXACT manifest bytes offline ────────
const built = await buildMastersManifest(entries, {
  revision: spec.revision,
  minAppVersion: spec.minAppVersion,
  transportKeyB64,
  generatedAt: new Date().toISOString(),
  schemaVersion: spec.schemaVersion,
});

// Confirm the signing key matches the app's baked DATA public key (catch wrong-key signing).
const pubHex = etc.bytesToHex(await getPublicKeyAsync(signPriv));
try {
  const trust = JSON.parse(readFileSync("publisher.trust.json", "utf8"));
  const baked = trust?.delegations?.data?.publicKeyHex;
  if (baked && /^[0-9a-f]{64}$/i.test(baked) && baked.toLowerCase() !== pubHex) {
    die(`signing key public ${pubHex} != baked data key ${baked} — wrong key; aborting`);
  }
} catch (e) { if (e?.message?.includes("aborting")) throw e; /* no trust file → skip the cross-check */ }

const sig = await signAsync(built.manifestBytes, signPriv);
const sigB64 = Buffer.from(sig).toString("base64");

// ── Write the bundle (manifest + detached sig + each entry ciphertext) ───────
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, manifestName), Buffer.from(built.manifestBytes));
writeFileSync(join(outDir, `${manifestName}.sig`), sigB64);
for (const [file, bytes] of Object.entries(built.files)) writeFileSync(join(outDir, file), Buffer.from(bytes));

console.log(`Built masters feed rev ${built.manifest.revision} → ${outDir}`);
console.log(`  ${manifestName} (+ .sig)  signed by data key ${pubHex.slice(0, 16)}…`);
for (const e of built.manifest.entries) console.log(`  ${e.file}  [${e.id} v${e.version}, ${e.bytes} B]`);
console.log(`\nNext: node scripts/publish-feed.mjs ${outDir}`);
