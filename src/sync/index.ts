/**
 * Device-to-device sync KERNEL — app-agnostic.
 *
 * Two pieces are genuinely reusable across apps and live here:
 *   - {@link SyncDb}: the minimal async DB interface a merge engine runs against
 *     (works over both the Tauri SQL plugin and node:sqlite in tests).
 *   - {@link isNewer}: the last-writer-wins conflict rule — strictly-newer
 *     `updated_at`, ties broken by the higher `device_id` — applied identically
 *     by both peers so they converge on the same winner.
 *
 * The ENVELOPE crypto is shared separately via `sharedcorelib/crypto`
 * (`encryptJson`/`decryptJson`, the pairing code as passphrase).
 *
 * What stays in each app (because it is inherently schema-bound — see CONTRACT.md):
 *   - the table SPEC + change-set/`Bundle` shape (which tables sync, identity
 *     kind, FKs, tombstone keys),
 *   - the merge ENGINE that walks that spec (FK remap, natural-key match,
 *     tombstone apply, blob/credential re-seal hooks),
 *   - the Rust transport (the dumb encrypted-byte LAN pipe).
 * Each app builds those on this kernel + `sharedcorelib/crypto`.
 */

/** Minimal async DB surface a merge engine needs. */
export interface SyncDb {
  select<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(
    sql: string,
    params?: unknown[],
  ): Promise<{ lastInsertId?: number; rowsAffected?: number }>;
}

/**
 * Last-writer-wins comparison: is the remote value strictly newer than the local
 * one, with a lexicographic `device_id` tie-break? Null/undefined sort as "". Both
 * peers run this on each other's change-set, so they converge on the same winner.
 */
export function isNewer(
  remoteUpdatedAt: unknown,
  localUpdatedAt: unknown,
  remoteDeviceId: string,
  localDeviceId: string,
): boolean {
  const a = remoteUpdatedAt == null ? "" : String(remoteUpdatedAt);
  const b = localUpdatedAt == null ? "" : String(localUpdatedAt);
  if (a > b) return true;
  if (a < b) return false;
  return remoteDeviceId > localDeviceId;
}
