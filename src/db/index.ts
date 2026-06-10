/**
 * Shared suite database — runtime layer over the semantic schema registry.
 *
 * The suite runs ONE client-side SQLite DB shared by every installed app (per-app +
 * common tables). This module turns {@link SchemaDescriptor}s into that DB and governs
 * access to it:
 *
 *   - **DDL generation** — `createTableSql` / `addColumnSql` / `migrationFor` map a
 *     descriptor to CREATE TABLE + indexes, and an additive schema change to ALTER ADD
 *     COLUMN (append-only; an incompatible change throws via the schema engine).
 *   - **On-disk registry** — `ensureRegistry` / `loadRegistry` / `registerSchemas` persist
 *     the registered schemas in `__schema_registry__` and apply the table migrations on
 *     publish/install. A conflicting schema BLOCKS registration (the publish gate already
 *     catches it at build time; this is the runtime backstop).
 *   - **Confidentiality-governed access** — `createSharedDb({ appId, grantedLevel })`
 *     exposes `read`/`write`/`list` that only expose tables + fields at/below the caller's
 *     granted confidentiality, and only let an app WRITE tables it owns.
 *
 * DI/pure: everything runs against an injected {@link SqlDb} (the Tauri SQL plugin in the
 * app, an in-memory fake in tests) — no module state, no direct Tauri import.
 */
import {
  CONFIDENTIALITY_ORDER, qualifiedName, checkAgainstRegistry, mergeIntoRegistry,
  type SchemaDescriptor, type FieldDescriptor, type SchemaRegistry, type Confidentiality,
} from "../schema/index.js";

/** Minimal async SQL surface (compatible with `sharedcorelib/sync`'s `SyncDb`). */
export interface SqlDb {
  select<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<{ rowsAffected?: number; lastInsertId?: number }>;
}

const rank = (c: Confidentiality): number => CONFIDENTIALITY_ORDER.indexOf(c);

// ── Identifier + type mapping (pure) ─────────────────────────────────────────

const ident = (s: string): string => `"${s.replace(/[^A-Za-z0-9_]/g, "_")}"`;

/** Physical table name for a schema (its dbAlias, else `namespace_Name`), sanitized. */
export function tableName(s: SchemaDescriptor): string {
  return (s as { dbAlias?: string }).dbAlias ?? `${s.namespace}_${s.name}`.replace(/[^A-Za-z0-9_]/g, "_");
}

/** Map a semantic dataType to a SQLite column type affinity. */
export function sqliteType(dataType: string): string {
  switch (dataType) {
    case "number": return "REAL";
    case "boolean": return "INTEGER";
    default: return "TEXT"; // string/id/date/enum/reference/embedded/any/Enum-names
  }
}

const colName = (f: FieldDescriptor): string => ident(f.dbAlias ?? f.name);

/** CREATE TABLE (+ indexes) statements for a schema. */
export function createTableSql(s: SchemaDescriptor): string[] {
  const t = tableName(s);
  const cols = s.fields.map((f) => {
    const notNull = f.required && !f.keyField ? " NOT NULL" : "";
    return `  ${colName(f)} ${sqliteType(f.dataType)}${notNull}`;
  });
  const keys = s.fields.filter((f) => f.keyField).map(colName);
  if (keys.length) cols.push(`  PRIMARY KEY (${keys.join(", ")})`);
  const stmts = [`CREATE TABLE IF NOT EXISTS ${ident(t)} (\n${cols.join(",\n")}\n)`];

  for (const f of s.fields) {
    if (!f.index || f.keyField) continue;
    const unique = f.index === "Unique" ? "UNIQUE " : "";
    if (f.index === "Text") continue; // full-text needs FTS — left to the app
    stmts.push(`CREATE ${unique}INDEX IF NOT EXISTS ${ident(`ix_${t}_${f.name}`)} ON ${ident(t)} (${colName(f)})`);
  }
  return stmts;
}

/** ALTER TABLE ADD COLUMN for an additively-added field (append-only; no NOT NULL). */
export function addColumnSql(s: SchemaDescriptor, f: FieldDescriptor): string {
  return `ALTER TABLE ${ident(tableName(s))} ADD COLUMN ${colName(f)} ${sqliteType(f.dataType)}`;
}

/**
 * The migration statements to evolve `existing` into `proposed` (additive only). Throws
 * (via the schema engine) if the change is incompatible. Returns [] when identical.
 */
export function migrationFor(existing: SchemaDescriptor, proposed: SchemaDescriptor): string[] {
  // mergeIntoRegistry throws on conflict; reuse it to validate, then diff fields.
  mergeIntoRegistry({ [qualifiedName(existing)]: existing }, [proposed]);
  const have = new Set(existing.fields.map((f) => f.name));
  return proposed.fields.filter((f) => !have.has(f.name)).map((f) => addColumnSql(proposed, f));
}

// ── On-disk registry ─────────────────────────────────────────────────────────

export const REGISTRY_TABLE = "__schema_registry__";

export async function ensureRegistry(db: SqlDb): Promise<void> {
  await db.execute(
    `CREATE TABLE IF NOT EXISTS ${ident(REGISTRY_TABLE)} (` +
      `qualified TEXT PRIMARY KEY, descriptor TEXT NOT NULL)`,
  );
}

/** Load the registered schemas from the DB into a {@link SchemaRegistry}. */
export async function loadRegistry(db: SqlDb): Promise<SchemaRegistry> {
  await ensureRegistry(db);
  const rows = await db.select<{ qualified: string; descriptor: string }>(
    `SELECT qualified, descriptor FROM ${ident(REGISTRY_TABLE)}`,
  );
  const out: SchemaRegistry = {};
  for (const r of rows) {
    try { out[r.qualified] = JSON.parse(r.descriptor) as SchemaDescriptor; } catch { /* skip corrupt row */ }
  }
  return out;
}

export interface RegisterResult {
  registry: SchemaRegistry;
  /** SQL statements applied (creates + alters), in order. */
  applied: string[];
  duplicateCandidates: { schema: string; detail: string }[];
}

/**
 * Register a batch of schemas (an app being published/installed) into the shared DB:
 * conflict-check against the current registry (THROWS on conflict), apply append-only
 * CREATE/ALTER migrations, and persist the merged descriptors. Returns the new registry,
 * the SQL applied, and any duplicate candidates to review.
 */
export async function registerSchemas(db: SqlDb, descriptors: SchemaDescriptor[]): Promise<RegisterResult> {
  const registry = await loadRegistry(db);
  const check = checkAgainstRegistry(descriptors, registry);
  if (check.hasConflicts) {
    const detail = check.entries
      .filter((e) => e.status === "conflict")
      .map((e) => `${e.schema}: ${e.conflicts.map((c) => c.kind).join(", ")}`)
      .join("; ");
    throw new Error(`schema registration blocked — conflicts: ${detail}`);
  }

  const applied: string[] = [];
  const merged = mergeIntoRegistry(registry, descriptors);
  for (const d of descriptors) {
    const q = qualifiedName(d);
    const existing = registry[q];
    const stmts = existing ? migrationFor(existing, d) : createTableSql(merged[q]!);
    for (const sql of stmts) { await db.execute(sql); applied.push(sql); }
    await db.execute(
      `INSERT INTO ${ident(REGISTRY_TABLE)} (qualified, descriptor) VALUES (?, ?) ` +
        `ON CONFLICT(qualified) DO UPDATE SET descriptor = excluded.descriptor`,
      [q, JSON.stringify(merged[q])],
    );
  }
  return {
    registry: merged,
    applied,
    duplicateCandidates: check.duplicateCandidates.map((d) => ({ schema: d.schema, detail: d.detail })),
  };
}

// ── Access governance (pure) ─────────────────────────────────────────────────

const fieldLevel = (s: SchemaDescriptor, f: FieldDescriptor): Confidentiality => f.confidentiality ?? s.confidentiality;

export function schemaVisibleAt(level: Confidentiality, s: SchemaDescriptor): boolean {
  return rank(s.confidentiality) <= rank(level);
}
export function fieldVisibleAt(level: Confidentiality, s: SchemaDescriptor, f: FieldDescriptor): boolean {
  return rank(fieldLevel(s, f)) <= rank(level);
}
/** The field names a caller at `level` may read (others are withheld as too-confidential). */
export function visibleColumns(s: SchemaDescriptor, level: Confidentiality): string[] {
  return s.fields.filter((f) => fieldVisibleAt(level, s, f)).map((f) => f.dbAlias ?? f.name);
}
/** Only the owning app may write a table (common tables are written by their owner). */
export function canAppWrite(s: SchemaDescriptor, appId: string): boolean {
  return s.owner === appId;
}

// ── Governed shared-DB handle ────────────────────────────────────────────────

export interface SharedDbConfig {
  db: SqlDb;
  /** The calling app's id (gates writes to owned tables). */
  appId: string;
  /** The caller's granted confidentiality (gates which tables/fields it can read). */
  grantedLevel: Confidentiality;
  /** The loaded registry (from {@link loadRegistry}). */
  registry: SchemaRegistry;
}

export interface SharedDb {
  /** Schemas the caller may read, at its granted level. */
  list(): SchemaDescriptor[];
  /** Read visible columns of a table the caller may read. Throws if unknown/forbidden. */
  read<T = Record<string, unknown>>(qualified: string, opts?: { where?: string; params?: unknown[]; limit?: number }): Promise<T[]>;
  /** Write a row to a table the caller OWNS. Throws if unknown/not-owner. */
  write(qualified: string, row: Record<string, unknown>): Promise<void>;
}

/**
 * A governed handle on the shared DB for one app: reads are filtered to the caller's
 * confidentiality, writes are restricted to tables the app owns.
 */
export function createSharedDb(cfg: SharedDbConfig): SharedDb {
  const get = (qualified: string): SchemaDescriptor => {
    const s = cfg.registry[qualified];
    if (!s) throw new Error(`unknown schema: ${qualified}`);
    return s;
  };

  return {
    list: () => Object.values(cfg.registry).filter((s) => schemaVisibleAt(cfg.grantedLevel, s)),

    read: async (qualified, opts = {}) => {
      const s = get(qualified);
      if (!schemaVisibleAt(cfg.grantedLevel, s)) {
        throw new Error(`forbidden: ${qualified} requires ${s.confidentiality}, caller has ${cfg.grantedLevel}`);
      }
      const cols = visibleColumns(s, cfg.grantedLevel);
      if (!cols.length) throw new Error(`forbidden: no readable columns of ${qualified} at ${cfg.grantedLevel}`);
      const colList = cols.map((c) => `"${c.replace(/[^A-Za-z0-9_]/g, "_")}"`).join(", ");
      const where = opts.where ? ` WHERE ${opts.where}` : "";
      const limit = opts.limit ? ` LIMIT ${Number(opts.limit)}` : "";
      return cfg.db.select(`SELECT ${colList} FROM ${ident(tableName(s))}${where}${limit}`, opts.params);
    },

    write: async (qualified, row) => {
      const s = get(qualified);
      if (!canAppWrite(s, cfg.appId)) {
        throw new Error(`forbidden: ${cfg.appId} may not write ${qualified} (owner ${s.owner})`);
      }
      const keys = Object.keys(row);
      if (!keys.length) return;
      const cols = keys.map((k) => `"${k.replace(/[^A-Za-z0-9_]/g, "_")}"`).join(", ");
      const placeholders = keys.map(() => "?").join(", ");
      await cfg.db.execute(
        `INSERT OR REPLACE INTO ${ident(tableName(s))} (${cols}) VALUES (${placeholders})`,
        keys.map((k) => row[k]),
      );
    },
  };
}
