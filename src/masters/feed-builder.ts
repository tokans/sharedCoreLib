/**
 * Masters feed BUILDER — the producer side of the OTA pipeline.
 *
 * The runtime engine in `./index.ts` VERIFIES a signed masters bundle. This module
 * builds one: it takes app/common master payloads and produces the exact bytes a
 * publisher hosts at the feed `baseUrl`:
 *
 *   - one AES-256-GCM-encrypted `.bin` per entry (`iv(12) ‖ ciphertext ‖ tag(16)` —
 *     the precise layout {@link decryptTransport} expects),
 *   - a `masters.manifest.json` whose per-entry `bytes`/`sha256` pin those files,
 *   - the EXACT manifest bytes to sign (so the served bytes and the signed bytes match).
 *
 * DELIBERATELY KEY-FREE. There is NO private key and NO signing here, so the runtime
 * package never carries signing-with-a-secret. Ed25519 signing happens OFFLINE in the
 * CLI/build step (`scripts/build-masters-feed.mjs`) over {@link BuiltFeed.manifestBytes}
 * — the private key never enters this code, the runtime, or CI (THREAT_MODEL §2).
 *
 * Build-time only — apps never call this at runtime; with `sideEffects:false` it is
 * tree-shaken out of every app bundle. The output is byte-for-byte verifiable by
 * {@link verifyAndDecryptManifest}, which is exactly what the feed-builder test asserts.
 */
import { sha256Hex, type BaseManifest } from "./index.js";

/** A single master payload to publish. `payload` is JSON-serialized then encrypted. */
export interface MasterFeedEntryInput {
  /** Manifest entry id — an app master id (e.g. `myfinance:institution`) or a bundle type. */
  id: string;
  /** Per-master revision this payload is published at (anti-downgrade, per id). */
  version: number;
  /** JSON-serializable payload (the decrypted shape the app's `applyEntry` consumes). */
  payload: unknown;
  /** Override the on-feed filename. Default: `${id}.bin` with unsafe chars replaced. */
  file?: string;
}

export interface BuildManifestOptions {
  /** Whole-bundle revision — MUST be strictly greater than the last published one. */
  revision: number;
  /** Minimum app version allowed to apply this bundle (gates `minAppVersion`). */
  minAppVersion: string;
  /** AES-256-GCM transport key, base64 of 32 raw bytes — the app's baked transport key. */
  transportKeyB64: string;
  /** ISO instant stamped into the manifest. Injected so the build is deterministic. */
  generatedAt: string;
  /** Manifest schema version. Default 1. */
  schemaVersion?: number;
}

/** The manifest shape the generic verifier validates (superset of {@link BaseManifest}). */
export interface BuiltManifest extends BaseManifest {
  generatedAt: string;
  schemaVersion: number;
  entries: Array<{ id: string; file: string; bytes: number; sha256: string; version: number }>;
}

export interface BuiltFeed {
  /** The parsed manifest (for inspection/logging). */
  manifest: BuiltManifest;
  /**
   * The EXACT manifest bytes to host AND to sign. Sign these verbatim offline; write
   * these verbatim to `masters.manifest.json`. Re-serializing risks a byte mismatch
   * that would fail signature verification.
   */
  manifestBytes: Uint8Array;
  /** Filename → bytes for every entry ciphertext (write each under the feed baseUrl). */
  files: Record<string, Uint8Array>;
}

const IV_LEN = 12;
const enc = new TextEncoder();

/** TS narrows `Uint8Array` to `Uint8Array<ArrayBufferLike>`, which WebCrypto rejects. */
const asSource = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Default feed filename for an entry — namespaced id with separators made path-safe. */
function defaultFileFor(id: string): string {
  return `${id.replace(/[^a-zA-Z0-9._-]+/g, "_")}.bin`;
}

/**
 * AES-256-GCM encrypt to the `iv(12) ‖ ciphertext ‖ tag(16)` layout the runtime
 * {@link decryptTransport} consumes (WebCrypto appends the tag to the ciphertext).
 */
async function encryptTransport(plain: Uint8Array, keyB64: string): Promise<Uint8Array> {
  const rawKey = b64ToBytes(keyB64);
  if (rawKey.length !== 32) throw new Error(`transport key must be 32 bytes, got ${rawKey.length}`);
  const key = await crypto.subtle.importKey("raw", asSource(rawKey), { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: asSource(iv) }, key, asSource(plain)));
  const out = new Uint8Array(IV_LEN + ct.length);
  out.set(iv, 0);
  out.set(ct, IV_LEN);
  return out;
}

/**
 * Build a complete, unsigned masters bundle. Encrypts each entry, pins it by size +
 * SHA-256 in the manifest, and returns the exact manifest bytes to sign offline.
 *
 * Throws on a bad transport key or a duplicate entry id/filename (a duplicate would
 * make one payload silently shadow another in the shared store).
 */
export async function buildMastersManifest(
  entries: MasterFeedEntryInput[],
  opts: BuildManifestOptions,
): Promise<BuiltFeed> {
  if (entries.length === 0) throw new Error("masters feed needs at least one entry");
  if (!Number.isInteger(opts.revision) || opts.revision < 0) throw new Error("revision must be a non-negative integer");
  if (!/^\d+\.\d+\.\d+$/.test(opts.minAppVersion)) throw new Error(`minAppVersion must be x.y.z, got "${opts.minAppVersion}"`);

  const files: Record<string, Uint8Array> = {};
  const seenIds = new Set<string>();
  const manifestEntries: BuiltManifest["entries"] = [];

  for (const e of entries) {
    if (seenIds.has(e.id)) throw new Error(`duplicate entry id: ${e.id}`);
    seenIds.add(e.id);
    const file = e.file ?? defaultFileFor(e.id);
    if (files[file]) throw new Error(`duplicate entry file: ${file} (set a distinct \`file\`)`);
    if (!Number.isInteger(e.version) || e.version < 0) throw new Error(`entry ${e.id}: version must be a non-negative integer`);

    const plain = enc.encode(JSON.stringify(e.payload));
    const ciphertext = await encryptTransport(plain, opts.transportKeyB64);
    files[file] = ciphertext;
    manifestEntries.push({
      id: e.id,
      file,
      bytes: ciphertext.length,
      sha256: await sha256Hex(ciphertext),
      version: e.version,
    });
  }

  const manifest: BuiltManifest = {
    revision: opts.revision,
    generatedAt: opts.generatedAt,
    schemaVersion: opts.schemaVersion ?? 1,
    minAppVersion: opts.minAppVersion,
    entries: manifestEntries,
  };

  // Serialize ONCE; these are the bytes to both host and sign.
  const manifestBytes = enc.encode(JSON.stringify(manifest, null, 2));
  return { manifest, manifestBytes, files };
}
