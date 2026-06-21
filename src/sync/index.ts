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
import { tableName, loadRegistry as coreLoadRegistry } from "../db/index.js";
import { qualifiedName, type SchemaDescriptor, type SchemaRegistry } from "../schema/index.js";
import { canAccessCompartment, compartmentOf, rowsForRecipient } from "../multiuser/index.js";

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

// ── Compartment-aware scoping (K0.4.4 — multi-user activation) ───────────────
// Rows may carry a `compartment` tag (`sharedcorelib/multiuser`): "shared" or
// "private:<userId>". The merge engine honors the tag on BOTH legs:
//   - send side: a private row is only emitted to its owner (`rowsForRecipient`);
//   - receive side: an incoming row in a compartment the local user can't access is skipped.
// UNTAGGED rows are "shared" and behave exactly as before; omitting the user ids disables
// the filtering entirely (single-user sync is byte-for-byte today's behavior).

/** ADDITIVE (K0.4.4): per-leg compartment scoping options. */
export interface CompartmentOptions {
  /** The member the OUTGOING bundle is for — their shared + own-private rows only. */
  recipientUserId?: string;
  /** The local member — incoming rows in compartments they can't access are skipped. */
  localUserId?: string;
}

/**
 * Read every row of each scoped table into a bundle keyed by qualified name. With
 * `compartments.recipientUserId` set, rows are filtered to those the recipient may
 * receive (shared + their own private compartment) — send-side enforcement.
 */
export async function buildBundle(
  db: SyncDb, tables: SchemaDescriptor[], compartments?: CompartmentOptions,
): Promise<SyncBundle> {
  const recipient = compartments?.recipientUserId;
  const bundle: SyncBundle = {};
  let n = 0;
  for (const s of tables) {
    const rows = await db.select<Record<string, unknown> & { compartment?: string | null }>(
      `SELECT * FROM "${tableName(s).replace(/[^A-Za-z0-9_]/g, "_")}"`,
    );
    bundle[qualifiedName(s)] = recipient === undefined ? rows : rowsForRecipient(rows, recipient);
    // Yield between tables so dumping many large tables doesn't block the webview.
    if (++n % 8 === 0) await new Promise((r) => setTimeout(r, 0));
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
  compartments?: CompartmentOptions,
): Promise<ApplyResult> {
  const byName = new Map(scope.map((s) => [qualifiedName(s), s]));
  const localUser = compartments?.localUserId;
  let applied = 0, skipped = 0;
  for (const [q, rows] of Object.entries(remote)) {
    const s = byName.get(q);
    if (!s) { skipped += rows.length; continue; } // out-of-scope table → never written
    const table = `"${tableName(s).replace(/[^A-Za-z0-9_]/g, "_")}"`;
    const key = pk(s);
    const keyId = `"${key.replace(/[^A-Za-z0-9_]/g, "_")}"`;
    // Allow-list: only columns DECLARED by this table's descriptor may be written. Column
    // names arrive in an untrusted peer's decrypted bundle (THREAT_MODEL: a paired peer is
    // untrusted), so an unknown/crafted key must never reach the SQL identifier — values are
    // parameterized, but identifiers can't be. Unknown columns are dropped, not written.
    const allowedCols = new Set(s.fields.map((f) => f.dbAlias ?? f.name));

    // Batch-load the local side ONCE per table (LWW only needs updated_at), keyed by pk —
    // instead of one SELECT per incoming row (an N+1 that serialized N IPC round-trips and
    // froze sync on real data). Chunked to stay under SQLite's bound-variable limit.
    const localUpdatedAt = new Map<unknown, unknown>();
    const ids = rows.map((r) => r[key]).filter((v) => v != null);
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500);
      const localRows = await db.select<Record<string, unknown>>(
        `SELECT ${keyId}, "updated_at" FROM ${table} WHERE ${keyId} IN (${chunk.map(() => "?").join(", ")})`,
        chunk,
      );
      for (const lr of localRows) localUpdatedAt.set(lr[key], lr.updated_at);
    }

    let n = 0;
    for (const row of rows) {
      // Receive-side compartment guard (K0.4.4): never write another member's private row.
      if (localUser !== undefined && !canAccessCompartment(compartmentOf(row as { compartment?: string | null }), localUser)) {
        skipped++;
        continue;
      }
      const hasLocal = localUpdatedAt.has(row[key]);
      if (hasLocal && !isNewer(row.updated_at, localUpdatedAt.get(row[key]), String(row.device_id ?? ""), localDeviceId)) { skipped++; continue; }
      const cols = Object.keys(row).filter((c) => allowedCols.has(c));
      if (!cols.length) { skipped++; continue; } // nothing recognized to write
      await db.execute(
        `INSERT OR REPLACE INTO ${table} (${cols.map((c) => `"${c.replace(/[^A-Za-z0-9_]/g, "_")}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
        cols.map((c) => row[c]),
      );
      applied++;
      // Yield periodically so a large merge doesn't starve the webview's paint/input.
      if (++n % 250 === 0) await new Promise((r) => setTimeout(r, 0));
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
  /**
   * ADDITIVE (K0.4.4): the LOCAL member's user id. When set, ingest skips incoming rows in
   * compartments this member can't access (another member's `private:<userId>` rows).
   * Omit in a single-user app — behavior is exactly as before.
   */
  localUserId?: string;
}

export interface MergeEngine {
  /** The tables this engine will sync (owned + common). */
  scope(): SchemaDescriptor[];
  /**
   * Build this device's outgoing bundle. ADDITIVE (K0.4.4): pass the recipient member's
   * user id to emit only the rows that member may receive (shared + their own private
   * compartment). Omit it (single-user) and every row is emitted, exactly as before.
   */
  outgoing(recipientUserId?: string): Promise<SyncBundle>;
  /** Merge a peer's bundle (out-of-scope tables ignored; foreign private compartments skipped). */
  ingest(remote: SyncBundle): Promise<ApplyResult>;
}

/** A per-app-scoped LWW merge engine over the shared suite DB. Replaces app-local merge.ts. */
export function createMergeEngine(cfg: MergeEngineConfig): MergeEngine {
  const scope = syncableTables(cfg.registry, cfg.appId, cfg.scope);
  return {
    scope: () => scope,
    outgoing: (recipientUserId) => buildBundle(cfg.db, scope, { recipientUserId }),
    ingest: (remote) => applyBundle(cfg.db, scope, remote, cfg.localDeviceId, { localUserId: cfg.localUserId }),
  };
}

// ── App sync-engine factory (dedup: every app's `coreMerge.ts` was the same glue) ──
//
// Every syncing app (myDocs/myHobbies/myHome/myThoughts/myMemories) shipped a near-identical
// `src/sync/coreMerge.ts`: a `<app>SyncScope`, a `create<App>MergeEngine` that opens the
// shared DB + loads the registry + calls `createMergeEngine`, a `syncOnce` round, and (for
// the multi-user apps) a `runScopedSync` that builds the engine per active member and runs a
// round. The bodies differ ONLY by appId + how the DB is opened, so this factory takes those
// two and returns the whole bundle. Pure/DI — the app still injects `openDb` + the transport.

/** The result of one sync round (rows applied / skipped). */
export interface SyncRoundResult { applied: number; skipped: number }

/** Per-leg active-member ids that scope a multi-user round. Both undefined ⇒ single-user (inert). */
export interface SyncCompartmentIds {
  /** The ACTIVE member on this device — ingest skips compartments they can't access. */
  localUserId?: string;
  /** The PEER member being synced to — the outgoing bundle is filtered to rows they may receive. */
  recipientUserId?: string;
}

export interface SyncEngineFactoryConfig {
  appId: string;
  /**
   * Open the shared suite DB (the Tauri SQL plugin handle). May return `null` outside Tauri
   * (browser/preview) — the engine builders then resolve to `null`. Called per engine build.
   */
  openDb: () => Promise<SyncDb | null>;
  /** Load the schema registry for the opened DB. Defaults to `loadRegistry` from `../db`. */
  loadRegistry?: (db: SyncDb) => Promise<SchemaRegistry>;
  /** Table-scope options forwarded to {@link createMergeEngine}. */
  scope?: ScopeOptions;
}

export interface SyncEngineFactory {
  /** The tables this app may sync (owned + common), for a loaded registry. */
  syncableTables(registry: SchemaRegistry): SchemaDescriptor[];
  /**
   * Build the per-app merge engine over the shared suite DB. `null` when `openDb` returns null
   * (browser/preview). `localUserId` (multi-user) is an optional ingest-side compartment scope.
   */
  createMergeEngine(localDeviceId: string, localUserId?: string): Promise<MergeEngine | null>;
  /**
   * One sync round over an authenticated, paired LAN transport: send our scoped bundle, ingest
   * the peer's. `encode`/`decode` carry the envelope crypto at the call site. `recipientUserId`
   * (multi-user) filters the outgoing bundle; omit it (single-user) → every row is emitted.
   */
  syncOnce(
    engine: MergeEngine,
    transport: SyncTransport,
    encode: (b: SyncBundle) => Uint8Array,
    decode: (b: Uint8Array) => SyncBundle,
    recipientUserId?: string,
  ): Promise<SyncRoundResult>;
  /**
   * Multi-user (K4) round: build the engine scoped to the ACTIVE member (`compartments.localUserId`)
   * and run one round scoped to the PEER (`compartments.recipientUserId`), so `private:<userId>`
   * rows reach ONLY their owner. `null` in browser/preview. With an empty `compartments` this is
   * byte-identical to a plain `createMergeEngine` + `syncOnce` (inert for the single-user tier).
   */
  runScopedSync(
    localDeviceId: string,
    transport: SyncTransport,
    encode: (b: SyncBundle) => Uint8Array,
    decode: (b: Uint8Array) => SyncBundle,
    compartments: SyncCompartmentIds,
  ): Promise<SyncRoundResult | null>;
}

/**
 * Build an app's sync glue (scope + engine builder + `syncOnce` + `runScopedSync`) from just
 * its `appId` and an `openDb`. Folds the byte-identical `coreMerge.ts` every syncing app
 * shipped into one DI factory; the app keeps only its own `openDb`/transport at the call site.
 */
export function createSyncEngineFactory(cfg: SyncEngineFactoryConfig): SyncEngineFactory {
  const load = cfg.loadRegistry ?? coreLoadRegistry;

  const buildEngine = async (localDeviceId: string, localUserId?: string): Promise<MergeEngine | null> => {
    const db = await cfg.openDb();
    if (!db) return null;
    const registry = await load(db);
    return createMergeEngine({ db, registry, appId: cfg.appId, localDeviceId, localUserId, scope: cfg.scope });
  };

  const syncOnce = async (
    engine: MergeEngine,
    transport: SyncTransport,
    encode: (b: SyncBundle) => Uint8Array,
    decode: (b: Uint8Array) => SyncBundle,
    recipientUserId?: string,
  ): Promise<SyncRoundResult> => {
    const outgoing = await engine.outgoing(recipientUserId);
    const peerBytes = await transport.exchange(encode(outgoing));
    return engine.ingest(decode(peerBytes));
  };

  return {
    syncableTables: (registry) => syncableTables(registry, cfg.appId, cfg.scope),
    createMergeEngine: buildEngine,
    syncOnce,
    runScopedSync: async (localDeviceId, transport, encode, decode, compartments) => {
      const engine = await buildEngine(localDeviceId, compartments.localUserId);
      if (!engine) return null;
      return syncOnce(engine, transport, encode, decode, compartments.recipientUserId);
    },
  };
}
