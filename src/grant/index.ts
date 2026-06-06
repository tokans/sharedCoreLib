/**
 * Receive-only entitlement grants — the Patron / Partner completion handoff.
 *
 * After a donation (Patron) or a professional enrollment at the publisher portal
 * (Partner), the user's device must learn the new status WITHOUT the app uploading
 * anything about the user. A grant is a signed-then-encrypted envelope the app only
 * ever RECEIVES, by either of two receive-only channels:
 *
 *   1. **Dropped file** — the portal hands the user a small `.grant` file they save
 *      into a known location; the app reads exactly that one path (myFinance's
 *      original `.tokans` email-attachment flow generalised).
 *   2. **Anonymous backend token** — the user pastes a short claim TOKEN (a donation /
 *      enrollment reference, NOT personal data) and the app GETs the signed grant by
 *      that token. This is the relaxation of the old "no backend" rule to
 *      **receive-only** — the app never uploads user data, it only fetches by token.
 *      See THREAT_MODEL.md §6 / the "receive-only, never upload" principle.
 *
 * Verification mirrors masters/patron: authenticate the ciphertext (Ed25519) BEFORE
 * decrypting (AES-256-GCM transport), then validate the payload shape. The grant
 * signing keys are SEPARATE from the masters/code keys (grants may be minted online).
 */
import { verifyManifestSignature, decryptTransport } from "../masters/index.js";

export type GrantKind = "patron" | "partner";

/** The signed envelope written to a grant file / served by the backend (all base64). */
export interface GrantEnvelope {
  v: 1;
  /** base64 of `iv(12) || ciphertext || tag(16)` (AES-256-GCM transport). */
  enc: string;
  /** base64 Ed25519 detached signature over the decoded `enc` bytes. */
  sig: string;
}

export interface GrantKeys {
  /** Baked Ed25519 public key for grant files (hex). Separate from masters keys. */
  pubkeyHex: string;
  /** Baked AES-256 transport key for grant files (base64). */
  transportKeyB64: string;
}

function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const textDecode = (b: Uint8Array): string => new TextDecoder().decode(b);

/**
 * Verify (signature over ciphertext) then decrypt a grant envelope → the raw payload.
 * Throws on any failure (bad JSON, bad signature, decrypt failure) so callers can fail
 * silently and leave entitlement state untouched. NOT shape-validated — the caller
 * parses the payload (e.g. with a zod schema) for its grant kind.
 */
export async function verifyGrant(fileBytes: Uint8Array, keys: GrantKeys): Promise<unknown> {
  const env = JSON.parse(textDecode(fileBytes)) as GrantEnvelope;
  if (env?.v !== 1 || typeof env.enc !== "string" || typeof env.sig !== "string") {
    throw new Error("malformed grant envelope");
  }
  const enc = b64ToBytes(env.enc);
  const sig = b64ToBytes(env.sig);
  if (!(await verifyManifestSignature(enc, sig, keys.pubkeyHex))) {
    throw new Error("grant signature invalid");
  }
  const plain = await decryptTransport(enc, keys.transportKeyB64);
  return JSON.parse(textDecode(plain));
}

export interface GrantReceiverConfig<TPayload> extends GrantKeys {
  /** Validate/narrow the decrypted payload (e.g. a zod schema's `.parse`). Throws on mismatch. */
  parsePayload: (raw: unknown) => TPayload;
  /** Read the dropped grant file bytes (e.g. from Downloads); null if absent. Receive-only. */
  readDroppedFile?: () => Promise<Uint8Array | null>;
  /**
   * Fetch the signed grant by an ANONYMOUS claim token (donation/enrollment reference,
   * not personal data); null if not ready. **GET only — never uploads user data.**
   */
  fetchByToken?: (token: string) => Promise<Uint8Array | null>;
}

export interface GrantReceiver<TPayload> {
  /** Try the dropped-file channel (no token needed). null when absent/invalid. */
  fromFile(): Promise<TPayload | null>;
  /** Claim by anonymous token via the receive-only backend. null when not-ready/invalid. */
  fromToken(token: string): Promise<TPayload | null>;
}

/**
 * Build a receive-only grant receiver. Both channels verify-then-parse and never throw
 * to the caller (a bad/absent grant ⇒ null), so the app keeps existing state on failure.
 */
export function createGrantReceiver<TPayload>(cfg: GrantReceiverConfig<TPayload>): GrantReceiver<TPayload> {
  const verify = async (bytes: Uint8Array): Promise<TPayload> => cfg.parsePayload(await verifyGrant(bytes, cfg));
  return {
    fromFile: async () => {
      if (!cfg.readDroppedFile) return null;
      try { const b = await cfg.readDroppedFile(); return b ? await verify(b) : null; } catch { return null; }
    },
    fromToken: async (token) => {
      if (!cfg.fetchByToken || !token.trim()) return null;
      try { const b = await cfg.fetchByToken(token.trim()); return b ? await verify(b) : null; } catch { return null; }
    },
  };
}
