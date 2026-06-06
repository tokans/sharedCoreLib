/**
 * Passphrase-based encryption for offline export packages — fully generic.
 *
 * Distinct from a vault DEK (see /vault): these packages are meant to be opened
 * by a trusted contact on THEIR device, so they're sealed with a passphrase the
 * user shares out-of-band, not a master password or per-device key.
 *
 * ── Format (v1, current) ─────────────────────────────────────────────────────
 *   magic("SCX1") ‖ kdfId(1) ‖ iterations(4 BE) ‖ salt(16) ‖ iv(12) ‖ ciphertext
 *   key = PBKDF2(passphrase, salt, iterations). The whole leading header (magic →
 *   iv) plus any caller AAD is bound as AES-GCM Additional Authenticated Data, so
 *   the KDF parameters cannot be tampered/downgraded without failing the tag.
 *
 * ── Format (legacy, read-only) ───────────────────────────────────────────────
 *   salt(16) ‖ iv(12) ‖ ciphertext, PBKDF2 @ 150k, no AAD. Still decryptable so
 *   packages produced before the format was versioned keep opening. New packages
 *   are always written in v1. See THREAT_MODEL.md §5.
 *
 * Uses only the Web Crypto API (available in the webview and in Node), so there is
 * no Tauri or Node dependency.
 */
const ENC = new TextEncoder();
const DEC = new TextDecoder();

/** Current (v1) work factor — OWASP-aligned floor; enforced by publisher-ci `kdf-floor`. */
export const PBKDF2_ITERATIONS = 600_000;
/** The original work factor; used only to open legacy (unversioned) packages. */
const LEGACY_PBKDF2_ITERATIONS = 150_000; // publisher-ci-ignore: kdf-floor (read-only legacy decrypt)

const MAGIC = ENC.encode("SCX1"); // 4 bytes
const KDF_PBKDF2_SHA256 = 1;
const SALT_LEN = 16;
const IV_LEN = 12;
const HEADER_LEN = MAGIC.length + 1 + 4 + SALT_LEN + IV_LEN; // magic+kdfId+iters+salt+iv

const asSource = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function startsWithMagic(bytes: Uint8Array): boolean {
  if (bytes.length < HEADER_LEN) return false;
  for (let i = 0; i < MAGIC.length; i++) if (bytes[i] !== MAGIC[i]) return false;
  return bytes[MAGIC.length] === KDF_PBKDF2_SHA256; // known KDF id → treat as v1
}

async function deriveKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey(
    "raw", asSource(ENC.encode(passphrase)), "PBKDF2", false, ["deriveKey"],
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: asSource(salt), iterations, hash: "SHA-256" },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

export interface SealOptions {
  /** Extra context bound as AAD (e.g. an app id / purpose). Must match on decrypt. */
  aad?: string;
}

/** Encrypt a JSON-serialisable value to a self-describing, versioned sealed byte array. */
export async function encryptJson(value: unknown, passphrase: string, opts: SealOptions = {}): Promise<Uint8Array> {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_LEN));
  const iv = crypto.getRandomValues(new Uint8Array(IV_LEN));
  const iters = new Uint8Array(4);
  new DataView(iters.buffer).setUint32(0, PBKDF2_ITERATIONS, false);
  const header = concat(MAGIC, new Uint8Array([KDF_PBKDF2_SHA256]), iters, salt, iv);

  const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS);
  const additional = opts.aad ? concat(header, ENC.encode(opts.aad)) : header;
  const ct = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: asSource(iv), additionalData: asSource(additional) },
      key,
      asSource(ENC.encode(JSON.stringify(value))),
    ),
  );
  return concat(header, ct);
}

/** Decrypt bytes produced by {@link encryptJson} (v1 or legacy). Throws on wrong passphrase/corruption. */
export async function decryptJson<T = unknown>(bytes: Uint8Array, passphrase: string, opts: SealOptions = {}): Promise<T> {
  if (startsWithMagic(bytes)) {
    const iterations = new DataView(bytes.buffer, bytes.byteOffset + MAGIC.length + 1, 4).getUint32(0, false);
    const saltStart = MAGIC.length + 1 + 4;
    const salt = bytes.slice(saltStart, saltStart + SALT_LEN);
    const iv = bytes.slice(saltStart + SALT_LEN, HEADER_LEN);
    const ct = bytes.slice(HEADER_LEN);
    const header = bytes.slice(0, HEADER_LEN);
    const additional = opts.aad ? concat(header, ENC.encode(opts.aad)) : header;
    const key = await deriveKey(passphrase, salt, iterations);
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: asSource(iv), additionalData: asSource(additional) }, key, asSource(ct),
    );
    return JSON.parse(DEC.decode(new Uint8Array(pt))) as T;
  }

  // Legacy: salt(16) ‖ iv(12) ‖ ct, PBKDF2 @ 150k, no AAD.
  if (bytes.length <= SALT_LEN + IV_LEN) throw new Error("Package is too short to be valid.");
  const salt = bytes.slice(0, SALT_LEN);
  const iv = bytes.slice(SALT_LEN, SALT_LEN + IV_LEN);
  const ct = bytes.slice(SALT_LEN + IV_LEN);
  const key = await deriveKey(passphrase, salt, LEGACY_PBKDF2_ITERATIONS);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: asSource(iv) }, key, asSource(ct));
  return JSON.parse(DEC.decode(new Uint8Array(pt))) as T;
}
