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

// ── Per-app-scoped merge engine (promoted from the apps — Phase 6) ───────────
// A generic LWW merge engine that walks the schema registry instead of an app-specific
// table spec. It is SCOPED per app via the register's table ownership: an app syncs ONLY
// its own tables (owner === appId) plus, optionally, the co-owned `common` shared tables.
// Device-to-device only — NO backend (the encrypted-byte LAN pipe is the injected
// {@link SyncTransport}). This lets apps delete their local `src/sync/merge.ts`.
import { tableName } from "../db/index.js";
import { qualifiedName, type SchemaDescriptor, type SchemaRegistry } from "../schema/index.js";

/** A per-table change-set: the rows a peer is offering for that table. */
export type SyncBundle = Record<string, Record<string, unknown>[]>;

/** The dumb encrypted-byte LAN pipe (Rust sidecar in the app; a fake in tests). */
export interface SyncTransport {
  /** Send our bundle as bytes; receive the peer's bundle bytes in return. */
  exchange(ourBundleBytes: Uint8Array): Promise<Uint8Array>;
}

export interface ScopeOptions {
  /** Also sync the co-owned `common` shared tables (person/event/ICE/…). Default true. */
  includeCommon?: boolean;
}

/**
 * The tables an app may sync: the ones it OWNS, plus (by default) the `common` shared
 * tables. Pure — derived from the registry's ownership, so sync can never reach another
 * app's private tables.
 */
export function syncableTables(registry: SchemaRegistry, appId: string, opts: ScopeOptions = {}): SchemaDescriptor[] {
  const includeCommon = opts.includeCommon ?? true;
  return Object.values(registry).filter(
    (s) => s.schemaType === "Table" || s.schemaType === "Event",
  ).filter((s) => s.owner === appId || (includeCommon && s.owner === "common"));
}

const pk = (s: SchemaDescriptor): string => (s.fields.find((f) => f.keyField)?.dbAlias ?? s.fields.find((f) => f.keyField)?.name ?? "id");

/** Read every row of each scoped table into a bundle keyed by qualified name. */
export async function buildBundle(db: SyncDb, tables: SchemaDescriptor[]): Promise<SyncBundle> {
  const bundle: SyncBundle = {};
  for (const s of tables) {
    bundle[qualifiedName(s)] = await db.select(`SELECT * FROM "${tableName(s).replace(/[^A-Za-z0-9_]/g, "_")}"`);
  }
  return bundle;
}

export interface ApplyResult { applied: number; skipped: number }

/**
 * Apply a remote bundle into the local DB with last-writer-wins per row, but ONLY for
 * tables in `scope` — a remote bundle offering a table this app doesn't own/share is
 * ignored (per-app scoping enforced on the receive side too). Returns counts.
 */
export async function applyBundle(
  db: SyncDb, scope: SchemaDescriptor[], remote: SyncBundle, localDeviceId: string,
): Promise<ApplyResult> {
  const byName = new Map(scope.map((s) => [qualifiedName(s), s]));
  let applied = 0, skipped = 0;
  for (const [q, rows] of Object.entries(remote)) {
    const s = byName.get(q);
    if (!s) { skipped += rows.length; continue; } // out-of-scope table → never written
    const table = `"${tableName(s).replace(/[^A-Za-z0-9_]/g, "_")}"`;
    const key = pk(s);
    for (const row of rows) {
      const localRows = await db.select<Record<string, unknown>>(`SELECT * FROM ${table} WHERE "${key}" = ?`, [row[key]]);
      const local = localRows[0];
      if (local && !isNewer(row.updated_at, local.updated_at, String(row.device_id ?? ""), localDeviceId)) { skipped++; continue; }
      const cols = Object.keys(row);
      await db.execute(
        `INSERT OR REPLACE INTO ${table} (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
        cols.map((c) => row[c]),
      );
      applied++;
    }
  }
  return { applied, skipped };
}

export interface MergeEngineConfig {
  db: SyncDb;
  registry: SchemaRegistry;
  appId: string;
  localDeviceId: string;
  scope?: ScopeOptions;
}

export interface MergeEngine {
  /** The tables this engine will sync (owned + common). */
  scope(): SchemaDescriptor[];
  /** Build this device's outgoing bundle. */
  outgoing(): Promise<SyncBundle>;
  /** Merge a peer's bundle (out-of-scope tables ignored). */
  ingest(remote: SyncBundle): Promise<ApplyResult>;
}

/** A per-app-scoped LWW merge engine over the shared suite DB. Replaces app-local merge.ts. */
export function createMergeEngine(cfg: MergeEngineConfig): MergeEngine {
  const scope = syncableTables(cfg.registry, cfg.appId, cfg.scope);
  return {
    scope: () => scope,
    outgoing: () => buildBundle(cfg.db, scope),
    ingest: (remote) => applyBundle(cfg.db, scope, remote, cfg.localDeviceId),
  };
}
