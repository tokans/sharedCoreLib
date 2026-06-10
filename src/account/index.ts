/**
 * tokans.org account client — the ONLY core code that talks to a backend. Registered/paid
 * tiers only; never on a free-tier code path. It ships ONLY ciphertext + minimal metadata
 * (account id, email, dates, opaque tokens) — never plaintext user data and never a
 * decrypting secret (RK, recipient passphrase, master key).
 *
 * Surfaces (wire shapes frozen in contracts/account-wire.md — tokans-backend implements them):
 *   - **identity/auth** — a free account = Registered tier ({@link AccountClient.register}/`login`).
 *   - **recovery escrow** — push/pull the wrapped-MK blob as ciphertext; implements the
 *     recovery {@link EscrowClient}. The server cannot decrypt (RK never leaves the device).
 *   - **dead-man's-switch heartbeat** — `email + lastUsedDate`; escalation is server-side,
 *     the user is notified first and cancels with an "I'm here" {@link AccountClient.heartbeatCancel}.
 *   - **break-glass escrow** — publish a recipient slice (ciphertext); RELEASE is gated by a
 *     2FA token (gates release of ciphertext, never decryption); implements {@link BreakGlassEscrow}.
 *   - **promise-card redemption** — redeem a signed card against a paid product.
 *   - **offline verify** — verify a server-signed receipt with ed25519, no network.
 *
 * DI/pure: the HTTP layer is an injected {@link HttpTransport} (Tauri http plugin in the app,
 * a fake in tests) — no direct Tauri/fetch import; everything is asserted on the wire shapes.
 *
 * ⚠ EGRESS surface — flagged for human review (network; registered/paid only; ciphertext-only).
 */
import { verifyManifestSignature } from "../masters/index.js";
import type { EscrowClient, WrappedKey } from "../recovery/index.js";
import type { BreakGlassEscrow } from "../breakglass/index.js";

const toB64 = (u: Uint8Array): string =>
  typeof Buffer !== "undefined" ? Buffer.from(u).toString("base64") : btoa(String.fromCharCode(...u));
const fromB64 = (s: string): Uint8Array =>
  typeof Buffer !== "undefined" ? new Uint8Array(Buffer.from(s, "base64")) : Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

// ── Transport (DI) ──────────────────────────────────────────────────────────

/** Minimal HTTP surface. The app supplies a TLS-only transport (no insecure channel — invariant 7). */
export interface HttpTransport {
  post<T = unknown>(path: string, body: unknown): Promise<T>;
  get<T = unknown>(path: string): Promise<T>;
}

// ── Frozen wire shapes (contracts/account-wire.md) ──────────────────────────

export interface Session { accountId: string; token: string; tier: "registered" | "patron" | "paid" }

export interface RegisterRequest { email: string }
export interface RegisterResponse { accountId: string; token: string; tier: Session["tier"] }
export interface LoginRequest { email: string; token: string }

export interface HeartbeatRequest { accountId: string; token: string; email: string; lastUsedDate: string }
export interface HeartbeatResponse { ok: boolean; nextDueDate: string; escalating: boolean }
export interface HeartbeatCancelRequest { accountId: string; token: string }

export interface EscrowPushRequest { accountId: string; token: string; blobB64: string }
export interface EscrowPullResponse { blobB64: string | null }

export interface BreakGlassPublishRequest { accountId: string; token: string; recipientId: string; blobB64: string }
/** 2FA `releaseToken` gates RELEASE of ciphertext — it never decrypts (decryption needs the passphrase). */
export interface BreakGlassReleaseRequest { recipientId: string; releaseToken: string }
export interface BreakGlassReleaseResponse { blobB64: string | null }

export interface PromiseCardRedeemRequest { accountId: string; token: string; cardB64: string; product: "myworkassistant" | "mylifeassistant" }
export interface PromiseCardRedeemResponse { ok: boolean; creditMinor: number; currency: string; reason?: string }

/** Keys that must NEVER appear in an outgoing payload (decrypting secrets / plaintext). */
export const FORBIDDEN_EGRESS_KEYS = ["recoveryKey", "rk", "passphrase", "masterKey", "mk", "plaintext", "password"];

/**
 * Defensive egress guard: throw if a payload (recursively) contains a forbidden key or a
 * value that looks like a master key. Called before every POST — a backstop so a future
 * edit can't silently start shipping a secret.
 */
export function assertNoPlaintextSecrets(payload: unknown, path = "$"): void {
  if (payload == null || typeof payload !== "object") return;
  for (const [k, v] of Object.entries(payload as Record<string, unknown>)) {
    if (FORBIDDEN_EGRESS_KEYS.includes(k)) throw new Error(`egress guard: forbidden key "${k}" at ${path}`);
    assertNoPlaintextSecrets(v, `${path}.${k}`);
  }
}

// ── Client ──────────────────────────────────────────────────────────────────

export interface AccountConfig {
  http: HttpTransport;
  /** tokans.org public key (hex) for offline ed25519 receipt verification. */
  serverPubkeyHex?: string;
}

export interface AccountClient {
  register(email: string): Promise<Session>;
  login(email: string, token: string): Promise<Session>;
  /** Send a heartbeat (email + last-used date). Returns escalation state; user is notified first. */
  heartbeat(s: Session, email: string, lastUsedDate: string): Promise<HeartbeatResponse>;
  /** "I'm here" — cancel an in-flight dead-man's-switch escalation. */
  heartbeatCancel(s: Session): Promise<{ ok: boolean }>;
  /** A recovery escrow bound to this session (implements the recovery EscrowClient). */
  recoveryEscrow(s: Session): EscrowClient;
  /** A break-glass escrow bound to this session (implements BreakGlassEscrow; release is 2FA-gated). */
  breakGlassEscrow(s: Session, releaseTokenFor: (recipientId: string) => string): BreakGlassEscrow;
  redeemPromiseCard(s: Session, card: Uint8Array, product: PromiseCardRedeemRequest["product"]): Promise<PromiseCardRedeemResponse>;
  /** Offline ed25519 verification of a server-signed receipt (no network). */
  verifyReceipt(receiptBytes: Uint8Array, sigBytes: Uint8Array): Promise<boolean>;
}

export function createAccountClient(cfg: AccountConfig): AccountClient {
  const post = <T>(path: string, body: unknown): Promise<T> => {
    assertNoPlaintextSecrets(body);
    return cfg.http.post<T>(path, body);
  };

  return {
    register: async (email) => {
      const r = await post<RegisterResponse>("/account/register", { email } satisfies RegisterRequest);
      return { accountId: r.accountId, token: r.token, tier: r.tier };
    },
    login: async (email, token) => {
      const r = await post<RegisterResponse>("/account/login", { email, token } satisfies LoginRequest);
      return { accountId: r.accountId, token: r.token, tier: r.tier };
    },
    heartbeat: (s, email, lastUsedDate) =>
      post<HeartbeatResponse>("/account/heartbeat", { accountId: s.accountId, token: s.token, email, lastUsedDate } satisfies HeartbeatRequest),
    heartbeatCancel: (s) =>
      post<{ ok: boolean }>("/account/heartbeat/cancel", { accountId: s.accountId, token: s.token } satisfies HeartbeatCancelRequest),

    recoveryEscrow: (s): EscrowClient => ({
      push: async (blob: WrappedKey) => {
        await post<{ ok: boolean }>("/recovery/escrow/push", { accountId: s.accountId, token: s.token, blobB64: toB64(blob) } satisfies EscrowPushRequest);
      },
      pull: async () => {
        const r = await post<EscrowPullResponse>("/recovery/escrow/pull", { accountId: s.accountId, token: s.token });
        return r.blobB64 ? fromB64(r.blobB64) : null;
      },
    }),

    breakGlassEscrow: (s, releaseTokenFor): BreakGlassEscrow => ({
      publish: async (recipientId, blob) => {
        await post<{ ok: boolean }>("/breakglass/publish", { accountId: s.accountId, token: s.token, recipientId, blobB64: toB64(blob) } satisfies BreakGlassPublishRequest);
      },
      release: async (recipientId) => {
        const r = await post<BreakGlassReleaseResponse>("/breakglass/release", { recipientId, releaseToken: releaseTokenFor(recipientId) } satisfies BreakGlassReleaseRequest);
        return r.blobB64 ? fromB64(r.blobB64) : null;
      },
    }),

    redeemPromiseCard: (s, card, product) =>
      post<PromiseCardRedeemResponse>("/grant/redeem", { accountId: s.accountId, token: s.token, cardB64: toB64(card), product } satisfies PromiseCardRedeemRequest),

    verifyReceipt: async (receiptBytes, sigBytes) => {
      if (!cfg.serverPubkeyHex) return false;
      return verifyManifestSignature(receiptBytes, sigBytes, cfg.serverPubkeyHex);
    },
  };
}
