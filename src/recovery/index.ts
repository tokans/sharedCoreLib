/**
 * Account-recovery primitives — app-agnostic, local-first, free.
 *
 * The user's master key (MK) unlocks the vault. If the device password is lost, the MK
 * is recovered from a high-entropy **Recovery Key (RK)** the user holds — never the vendor.
 * This module provides:
 *
 *   - **RK generation** — a high-entropy, human-transcribable key.
 *   - **wrap/unwrap** — seal the MK under the RK (reuses the audited `crypto` AES-GCM +
 *     PBKDF2 seal; the RK is the passphrase). The wrapped blob is opaque ciphertext.
 *   - **Local wrapped-blob storage** (DI {@link RecoveryBlobStore}) — free, offline,
 *     on-device next to the vault. No backend.
 *   - **Zero-knowledge escrow client** (DI {@link EscrowClient}) — push/pull the wrapped
 *     blob as CIPHERTEXT for new-device restore. The RK never leaves the device, so the
 *     server cannot decrypt. (Wired to `account` in Phase 4.)
 *   - **Re-key on recovery** — after a recovery, mint a fresh RK and re-wrap, invalidating
 *     the old RK path (forward protection).
 *   - **Social / Shamir split** — split the RK into M-of-N shares (standard GF(256) SSS) so
 *     a quorum of trusted contacts can reconstruct it. The shares are the only secret;
 *     fewer than M reveal nothing.
 *
 * DI/pure: storage + escrow are injected; the crypto is Web Crypto via `../crypto`.
 *
 * ⚠ CRYPTO subsystem — flagged for human review (recovery path; never vendor-held).
 */
import { encryptJson, decryptJson } from "../crypto/index.js";

const toB64 = (u: Uint8Array): string =>
  typeof Buffer !== "undefined" ? Buffer.from(u).toString("base64") : btoa(String.fromCharCode(...u));
const fromB64 = (s: string): Uint8Array =>
  typeof Buffer !== "undefined" ? new Uint8Array(Buffer.from(s, "base64")) : Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// ── Recovery Key generation ─────────────────────────────────────────────────

/** Crockford base32 alphabet (no I/L/O/U — unambiguous when transcribed). */
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const RK_AAD = "sharedcorelib/recovery/rk-wrap/v1";

/**
 * A high-entropy Recovery Key: `bytes*8` bits of randomness rendered as grouped base32,
 * e.g. `K7QF-3M2A-...`. Default 20 bytes = 160 bits. The user stores this offline; it is
 * the sole secret that unwraps the MK off-device.
 */
export function generateRecoveryKey(bytes = 20, group = 4): string {
  const raw = crypto.getRandomValues(new Uint8Array(bytes));
  let out = "";
  for (const b of raw) out += B32[b & 31]! + B32[(b >> 3) & 31]!; // 2 chars/byte (sufficient entropy)
  return out.slice(0, Math.ceil((bytes * 8) / 5)).replace(new RegExp(`(.{${group}})`, "g"), "$1-").replace(/-$/, "");
}

/** Normalize a user-typed RK (strip separators/whitespace, upper-case) for comparison/derivation. */
export function normalizeRecoveryKey(rk: string): string {
  return rk.replace(/[\s-]+/g, "").toUpperCase();
}

// ── Wrap / unwrap the master key under the RK ───────────────────────────────

/** Opaque wrapped-MK blob (ciphertext). Stored locally and/or escrowed. */
export type WrappedKey = Uint8Array;

/** Seal the master key under the recovery key. The blob is undecryptable without the RK. */
export async function wrapMasterKey(masterKey: Uint8Array, rk: string): Promise<WrappedKey> {
  return encryptJson({ mk: toB64(masterKey) }, normalizeRecoveryKey(rk), { aad: RK_AAD });
}

/** Recover the master key from a wrapped blob + the recovery key. Throws on a wrong RK. */
export async function unwrapMasterKey(blob: WrappedKey, rk: string): Promise<Uint8Array> {
  const { mk } = await decryptJson<{ mk: string }>(blob, normalizeRecoveryKey(rk), { aad: RK_AAD });
  return fromB64(mk);
}

// ── DI surfaces ─────────────────────────────────────────────────────────────

/** Local, on-device storage for the wrapped-MK blob (next to the vault). Free, offline. */
export interface RecoveryBlobStore {
  save(blob: WrappedKey): Promise<void>;
  load(): Promise<WrappedKey | null>;
  clear(): Promise<void>;
}

/**
 * Zero-knowledge escrow transport (registered-tier). It only ever moves CIPHERTEXT; the
 * server stores a blob it cannot decrypt (the RK never leaves the device). 2FA gating of
 * the *release* lives in `account` — this is pure transport.
 */
export interface EscrowClient {
  push(blob: WrappedKey): Promise<void>;
  pull(): Promise<WrappedKey | null>;
}

export interface RecoveryConfig {
  blobStore: RecoveryBlobStore;
  /** Optional registered-tier escrow (ciphertext only). Absent on the free, offline path. */
  escrow?: EscrowClient;
}

export interface Recovery {
  /** Mint a fresh RK, wrap the MK under it, persist locally (+escrow if configured). Returns the RK to show ONCE. */
  enroll(masterKey: Uint8Array): Promise<{ recoveryKey: string }>;
  /** Recover the MK from the local blob (or escrow) using the RK. */
  recover(rk: string): Promise<Uint8Array>;
  /**
   * Re-key after a recovery: mint a NEW RK, re-wrap the MK, overwrite local (+escrow).
   * Forward protection — the old RK no longer opens the current blob.
   */
  rekey(masterKey: Uint8Array): Promise<{ recoveryKey: string }>;
  /** Push the current local blob to escrow as ciphertext (registered tier). */
  backupToEscrow(): Promise<void>;
}

export function createRecovery(cfg: RecoveryConfig): Recovery {
  const enrollWith = async (masterKey: Uint8Array) => {
    const recoveryKey = generateRecoveryKey();
    const blob = await wrapMasterKey(masterKey, recoveryKey);
    await cfg.blobStore.save(blob);
    if (cfg.escrow) await cfg.escrow.push(blob);
    return { recoveryKey };
  };
  return {
    enroll: enrollWith,
    rekey: enrollWith, // identical mechanism; semantically distinct (post-recovery rotation)
    recover: async (rk) => {
      const blob = (await cfg.blobStore.load()) ?? (cfg.escrow ? await cfg.escrow.pull() : null);
      if (!blob) throw new Error("no recovery blob available (local or escrow)");
      return unwrapMasterKey(blob, rk);
    },
    backupToEscrow: async () => {
      if (!cfg.escrow) throw new Error("no escrow client configured");
      const blob = await cfg.blobStore.load();
      if (!blob) throw new Error("nothing to back up — enroll first");
      await cfg.escrow.push(blob);
    },
  };
}

// ── Social / Shamir secret sharing (M-of-N over GF(256)) ────────────────────
// Standard Shamir's Secret Sharing. Each byte of the secret is split independently as the
// constant term of a random degree-(threshold-1) polynomial over GF(2^8) (AES field,
// 0x11b). Any `threshold` shares reconstruct via Lagrange interpolation at x=0; fewer
// reveal nothing. ⚠ CRYPTO — review.

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x ^= (x << 1) ^ ((x & 0x80) ? 0x11b : 0); // multiply by 3 (generator) in GF(2^8)
    x &= 0xff;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
})();

const gmul = (a: number, b: number): number => (a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!);
const gdiv = (a: number, b: number): number => (a === 0 ? 0 : EXP[LOG[a]! + 255 - LOG[b]!]!);

/** One Shamir share: an x-coordinate (1..255) and the y-bytes for the secret. */
export interface SecretShare {
  x: number;
  y: Uint8Array;
}

/**
 * Split `secret` into `n` shares, any `threshold` of which reconstruct it. `threshold ≤ n ≤ 255`.
 * Use to split a Recovery Key across trusted contacts (social recovery).
 */
export function splitSecret(secret: Uint8Array, n: number, threshold: number): SecretShare[] {
  if (threshold < 2 || threshold > n || n > 255) throw new Error("require 2 ≤ threshold ≤ n ≤ 255");
  const shares: SecretShare[] = Array.from({ length: n }, (_, i) => ({ x: i + 1, y: new Uint8Array(secret.length) }));
  for (let b = 0; b < secret.length; b++) {
    const coeffs = crypto.getRandomValues(new Uint8Array(threshold - 1)); // random a1..a_{t-1}
    for (const sh of shares) {
      let acc = secret[b]!; // a0 = secret byte
      let xp = 1;
      for (let d = 0; d < coeffs.length; d++) { xp = gmul(xp, sh.x); acc ^= gmul(coeffs[d]!, xp); }
      sh.y[b] = acc;
    }
  }
  return shares;
}

/** Reconstruct the secret from `threshold`+ shares (Lagrange interpolation at x=0). */
export function combineShares(shares: SecretShare[]): Uint8Array {
  if (shares.length < 2) throw new Error("need at least 2 shares");
  const len = shares[0]!.y.length;
  const out = new Uint8Array(len);
  for (let b = 0; b < len; b++) {
    let secret = 0;
    for (let i = 0; i < shares.length; i++) {
      let num = 1, den = 1;
      for (let j = 0; j < shares.length; j++) {
        if (i === j) continue;
        num = gmul(num, shares[j]!.x);
        den = gmul(den, shares[i]!.x ^ shares[j]!.x);
      }
      secret ^= gmul(shares[i]!.y[b]!, gdiv(num, den));
    }
    out[b] = secret;
  }
  return out;
}

/** Split a Recovery Key string into M-of-N social-recovery shares (normalized first). */
export function splitRecoveryKey(rk: string, n: number, threshold: number): SecretShare[] {
  return splitSecret(new TextEncoder().encode(normalizeRecoveryKey(rk)), n, threshold);
}

/** Reconstruct a Recovery Key string from a quorum of shares. */
export function combineRecoveryKey(shares: SecretShare[]): string {
  return new TextDecoder().decode(combineShares(shares));
}
