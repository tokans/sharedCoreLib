/**
 * Multi-user crypto primitives — app-agnostic (Phase 7, stageable after the single-user
 * path ships). The substrate for a shared family vault:
 *
 *   - **Shared key, multi-wrapped per user** — one shared key (SK) protects family-shared
 *     rows; it is wrapped once per member under that member's high-entropy user key. Add a
 *     member = add a wrap; remove a member = ROTATE the SK and re-wrap for the rest (so a
 *     removed member can't read anything written afterward).
 *   - **Per-user private compartments** — each user has a private compartment key; rows
 *     tagged `private:<userId>` are readable only by that user. `shared` rows are readable
 *     by every member.
 *   - **Compartment-aware sync/db helpers** — shared rows replicate to all family devices;
 *     a private row only to its owner's devices (enforced on the send side).
 *   - **Co-user shared-data recovery** — a member who holds SK re-wraps it for a locked-out
 *     co-user under a fresh user key (no vendor involvement).
 *
 * Reuses the audited `recovery` wrap/unwrap, which seals under the versioned SCX1 format
 * from `sharedcorelib/crypto` (a visible format/version header). No new crypto is invented.
 *
 * ⚠ CRYPTO subsystem — flagged for human review; multi-user rollout is a human STAGING
 * decision (see REVIEW-REQUIRED / BUILD-STATUS).
 */
import { wrapMasterKey, unwrapMasterKey, generateRecoveryKey } from "../recovery/index.js";

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
