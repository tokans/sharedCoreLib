/**
 * Multi-user crypto primitives — app-agnostic (Phase 7, stageable after the single-user
 * path ships). The substrate for a shared family vault:
 *
 *   - **Shared key, multi-wrapped per user** — one shared key (SK) protects family-shared
 *     rows; it is wrapped once per member under that member's high-entropy user key. Add a
 *     member = add a wrap; remove a member = ROTATE the SK and re-wrap for the rest (so a
 *     removed member can't read anything written afterward).
 *   - **Per-user private compartments (crypto-hard)** — each user has their OWN private
 *     compartment key (PK), a fresh 256-bit key wrapped ONLY under that user's user key
 *     (never multi-wrapped). Rows tagged `private:<userId>` are sealed under that user's PK,
 *     so another member cannot read them even if they obtain the ciphertext — they simply
 *     do not hold the key (`keyForCompartment` returns null for them). `shared` rows are
 *     sealed under the family shared key SK and readable by every member. This is the
 *     CRYPTO boundary; the sync send-side filter below is defense-in-depth, not the guard.
 *   - **Compartment-aware sync/db helpers** — shared rows replicate to all family devices;
 *     a private row only to its owner's devices. This is send-side SCOPING that avoids
 *     shipping ciphertext a peer can't use; confidentiality still rests on the per-user PK.
 *   - **Co-user shared-data recovery** — a member who holds SK re-wraps it for a locked-out
 *     co-user under a fresh user key (no vendor involvement).
 *
 * Reuses the audited `recovery` wrap/unwrap and the `crypto` SCX1 seal (versioned, visible
 * format header) from `sharedcorelib/crypto`. No new crypto is invented: a compartment key
 * is wrapped exactly like a master key, and a compartment payload is sealed exactly like a
 * recovery package (under the high-entropy key, AAD-bound to the compartment).
 *
 * ⚠ CRYPTO subsystem — flagged for human review; multi-user rollout is a human STAGING
 * decision (see REVIEW-REQUIRED / BUILD-STATUS).
 */
import { wrapMasterKey, unwrapMasterKey, generateRecoveryKey } from "../recovery/index.js";
import { encryptJson, decryptJson } from "../crypto/index.js";

// Member-class feature policy (K0.4.2) — the UI-SOFT gating layer (crypto-hard boundaries
// stay in the compartment primitives below).
export {
  createMemberClassPolicy, createChildSoftPolicy,
  CHILD_SOFT_DEFAULT_RULES, SENSITIVE_FEATURE_CATEGORIES,
  type MemberClassPolicy, type MemberClassRule, type SensitiveFeatureCategory,
} from "./policy.js";

export type UserId = string;

/** A family member: their id + a high-entropy per-user key (their device secret / derived UK). */
export interface Member { userId: UserId; userKey: string }

/** userId → wrapped shared-key blob (ciphertext). */
export type WrapSet = Record<UserId, Uint8Array>;

/** A fresh 256-bit shared key. */
export function generateSharedKey(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

/** Wrap the shared key once per member (each under their own user key). */
export async function multiWrap(sharedKey: Uint8Array, members: Member[]): Promise<WrapSet> {
  const out: WrapSet = {};
  for (const m of members) out[m.userId] = await wrapMasterKey(sharedKey, m.userKey);
  return out;
}

/** Recover the shared key from a member's wrap using their user key. Throws on a wrong key. */
export async function unwrapShared(wraps: WrapSet, userId: UserId, userKey: string): Promise<Uint8Array> {
  const blob = wraps[userId];
  if (!blob) throw new Error(`no wrap for user ${userId}`);
  return unwrapMasterKey(blob, userKey);
}

/** Add a member: wrap the EXISTING shared key for them (no rotation; they get current + future data). */
export async function addMember(wraps: WrapSet, sharedKey: Uint8Array, member: Member): Promise<WrapSet> {
  return { ...wraps, [member.userId]: await wrapMasterKey(sharedKey, member.userKey) };
}

/**
 * Remove a member: ROTATE the shared key and re-wrap it for the remaining members only.
 * The removed member's old wrap can never yield the new key — forward secrecy for the family.
 * Returns the new shared key (re-encrypt shared rows under it) + the new wrap set.
 */
export async function removeMember(remaining: Member[]): Promise<{ sharedKey: Uint8Array; wraps: WrapSet }> {
  const sharedKey = generateSharedKey();
  return { sharedKey, wraps: await multiWrap(sharedKey, remaining) };
}

/**
 * Co-user recovery: a member holding the shared key re-wraps it for a locked-out co-user
 * under a fresh user key (handed over out-of-band). No vendor, no SK rotation.
 */
export async function coUserRewrap(sharedKey: Uint8Array, lockedOutUserId: UserId): Promise<{ userKey: string; wrap: Uint8Array }> {
  const userKey = generateRecoveryKey();
  return { userKey, wrap: await wrapMasterKey(sharedKey, userKey) };
}

// ── Private compartments ────────────────────────────────────────────────────

/** A row's compartment: family-`shared`, or `private:<userId>` (only that user can read). */
export type Compartment = "shared" | `private:${string}`;

export function privateCompartment(userId: UserId): Compartment {
  return `private:${userId}`;
}

/** Read a row's compartment tag (defaults to `shared` when untagged). */
export function compartmentOf(row: { compartment?: string | null }): Compartment {
  const c = row.compartment;
  return c && c.startsWith("private:") ? (c as Compartment) : "shared";
}

/** Can `userId` decrypt/read a row in this compartment? Shared → everyone; private → owner only. */
export function canAccessCompartment(compartment: Compartment, userId: UserId): boolean {
  return compartment === "shared" || compartment === `private:${userId}`;
}

// ── Per-user compartment keys (the crypto-hard isolation layer) ───────────────

const COMPARTMENT_AAD = "sharedcorelib.multiuser.compartment.v1";

/** A user's private-compartment key, wrapped under THEIR user key only (opaque to others). */
export interface WrappedCompartmentKey { userId: UserId; wrapped: Uint8Array }

/** Uint8Array key → the base64 string the SCX1 seal consumes as its high-entropy passphrase. */
function keyToPass(key: Uint8Array): string {
  let s = "";
  for (const b of key) s += String.fromCharCode(b);
  return btoa(s);
}

/**
 * Mint a fresh private-compartment key for a member and wrap it under their user key ONLY
 * (single wrap — NOT multi-wrapped), so no other member can ever unwrap it. Returns the raw
 * key (to seal the owner's private rows now) and the wrapped blob (safe to store/sync — it
 * is ciphertext only the owner's user key opens).
 */
export async function createPrivateCompartmentKey(
  member: Member,
): Promise<{ key: Uint8Array; wrapped: WrappedCompartmentKey }> {
  const key = generateSharedKey(); // 256-bit CSPRNG, personal scope
  return { key, wrapped: { userId: member.userId, wrapped: await wrapMasterKey(key, member.userKey) } };
}

/** Unwrap a member's OWN private-compartment key. Anyone else's user key fails the GCM tag. */
export async function unwrapPrivateCompartmentKey(blob: WrappedCompartmentKey, userKey: string): Promise<Uint8Array> {
  return unwrapMasterKey(blob.wrapped, userKey);
}

/** The key material a member currently holds, used to resolve a per-compartment seal key. */
export interface CompartmentKeyring {
  userId: UserId;
  /** The family shared key (for `shared` rows), unwrapped from this member's wrap. */
  sharedKey: Uint8Array;
  /** This member's OWN private-compartment key (for `private:<userId>` rows); absent if none. */
  privateKey?: Uint8Array;
}

/**
 * Resolve the raw key to seal/open a row in `compartment` given the keys this member holds.
 * `shared` → the shared key; this member's own private compartment → their private key;
 * ANOTHER member's private compartment → **null** (crypto-hard: they hold no such key).
 */
export function keyForCompartment(compartment: Compartment, ring: CompartmentKeyring): Uint8Array | null {
  if (compartment === "shared") return ring.sharedKey;
  if (compartment === `private:${ring.userId}`) return ring.privateKey ?? null;
  return null;
}

/**
 * Seal a JSON-serialisable payload under its compartment key (AAD-bound to the compartment,
 * so a sealed payload can't be replayed into another compartment). Throws if this member
 * does not hold the key for `compartment` (e.g. sealing into someone else's private space).
 */
export async function sealForCompartment(value: unknown, compartment: Compartment, ring: CompartmentKeyring): Promise<Uint8Array> {
  const key = keyForCompartment(compartment, ring);
  if (!key) throw new Error(`multiuser: ${ring.userId} holds no key for compartment "${compartment}"`);
  return encryptJson(value, keyToPass(key), { aad: `${COMPARTMENT_AAD}:${compartment}` });
}

/**
 * Open a compartment-sealed payload. Returns **null** when this member cannot access the
 * compartment (no key held) — the crypto-hard boundary: a foreign private row is unreadable
 * even with its ciphertext in hand. Throws only on corruption of an accessible payload.
 */
export async function openForCompartment<T = unknown>(blob: Uint8Array, compartment: Compartment, ring: CompartmentKeyring): Promise<T | null> {
  const key = keyForCompartment(compartment, ring);
  if (!key) return null;
  return decryptJson<T>(blob, keyToPass(key), { aad: `${COMPARTMENT_AAD}:${compartment}` });
}

/** Which members' devices should receive a row in this compartment (send-side scoping). */
export function syncTargets(compartment: Compartment, allUserIds: UserId[]): UserId[] {
  if (compartment === "shared") return [...allUserIds];
  const owner = compartment.slice("private:".length);
  return allUserIds.includes(owner) ? [owner] : [];
}

/**
 * Filter a list of rows to those a given recipient user may receive: shared rows + that
 * user's own private rows. A private row owned by someone else is never sent to them.
 */
export function rowsForRecipient<T extends { compartment?: string | null }>(rows: T[], recipientUserId: UserId): T[] {
  return rows.filter((r) => canAccessCompartment(compartmentOf(r), recipientUserId));
}
