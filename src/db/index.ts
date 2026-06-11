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
 *   - **Aux SQL migrations** — `registerAuxMigrations(db, appId, steps)` applies app-scoped,
 *     versioned raw-SQL steps (triggers/CHECKs — what descriptors can't express) append-only
 *     after `registerSchemas`, with an ownership guard: a step may only touch tables the
 *     registry says `appId` owns.
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
  type RegistryCheckOptions,
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
  /** Qualified names of descriptors that ADOPT an existing table (no table created). */
  adopted: string[];
}

/**
 * Register a batch of schemas (an app being published/installed) into the shared DB:
 * conflict-check against the current registry (THROWS on conflict; pass
 * `{ duplicates: "block" }` to also hard-block un-adopted/un-overridden duplicate
 * candidates), apply append-only CREATE/ALTER migrations, and persist the merged
 * descriptors. A descriptor with `adopts` registers NO table — it declares use of the
 * existing one (which must exist). Returns the new registry, the SQL applied, the
 * adopted names, and any duplicate candidates to review.
 */
export async function registerSchemas(
  db: SqlDb,
  descriptors: SchemaDescriptor[],
  opts: RegistryCheckOptions = {},
): Promise<RegisterResult> {
  const registry = await loadRegistry(db);
  const check = checkAgainstRegistry(descriptors, registry, opts);
  if (check.hasConflicts) {
    const detail = check.entries
      .filter((e) => e.status === "conflict")
      .map((e) => `${e.schema}: ${e.conflicts.map((c) => c.kind).join(", ")}`)
      .join("; ");
    throw new Error(`schema registration blocked — conflicts: ${detail}`);
  }

  const adopting = descriptors.filter((d) => d.adopts);
  for (const d of adopting) {
    if (!registry[d.adopts!] && !descriptors.some((x) => !x.adopts && qualifiedName(x) === d.adopts)) {
      throw new Error(`schema registration blocked — ${qualifiedName(d)} adopts unknown table ${d.adopts}`);
    }
  }
  const creating = descriptors.filter((d) => !d.adopts);

  const applied: string[] = [];
  const merged = mergeIntoRegistry(registry, creating);
  for (const d of creating) {
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
    adopted: adopting.map((d) => qualifiedName(d)),
  };
}

// ── Aux SQL migrations (app-scoped, versioned raw SQL) ──────────────────────

export const AUX_MIGRATIONS_TABLE = "__aux_migrations__";

/** One aux migration step: a version + the raw SQL statements it applies. */
export interface AuxMigrationStep {
  /** Positive integer; steps apply in ascending order, append-only per app. */
  version: number;
  /** Raw SQL statements (triggers, CHECK-bearing indexes, …) executed in order. */
  sql: string[];
}

export interface AuxMigrationResult {
  /** Versions applied by this run, ascending. */
  applied: number[];
  /** Versions skipped because they were already recorded (idempotent re-run). */
  skipped: number[];
}

// SQL identifier: "quoted", `quoted`, [quoted], or a bare word.
const SQL_ID = `(?:"[^"]+"|\`[^\`]+\`|\\[[^\\]]+\\]|[A-Za-z_][A-Za-z0-9_$]*)`;
// A table reference: optional schema prefix (main./temp.), capture the table identifier.
const SQL_TBL = `(?:${SQL_ID}\\.)?(${SQL_ID})`;

/** Strip comments + single-quoted string literals so they can't hide table names. */
function stripSqlNoise(sql: string): string {
  return sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "''");
}

function unquoteSqlIdent(raw: string): string {
  const t = raw.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("`") && t.endsWith("`"))) return t.slice(1, -1);
  if (t.startsWith("[") && t.endsWith("]")) return t.slice(1, -1);
  return t;
}

// Patterns that put a TABLE name in a known position. DROP TRIGGER/INDEX names and
// CTE aliases are deliberately NOT extracted (they are not tables).
const TABLE_POSITION_PATTERNS: RegExp[] = [
  // trigger header: BEFORE|AFTER|INSTEAD OF INSERT|DELETE|UPDATE [OF cols] ON <t>
  new RegExp(`\\b(?:INSERT|DELETE|UPDATE(?:\\s+OF\\s+[A-Za-z0-9_$",\`\\[\\]\\s]+?)?)\\s+ON\\s+${SQL_TBL}`, "gi"),
  // CREATE [UNIQUE] INDEX [IF NOT EXISTS] <name> ON <t>
  new RegExp(`\\bINDEX\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${SQL_ID}\\s+ON\\s+${SQL_TBL}`, "gi"),
  new RegExp(`\\bINSERT\\s+(?:OR\\s+(?:REPLACE|IGNORE|ABORT|FAIL|ROLLBACK)\\s+)?INTO\\s+${SQL_TBL}`, "gi"),
  new RegExp(`\\bREPLACE\\s+INTO\\s+${SQL_TBL}`, "gi"),
  new RegExp(`\\bUPDATE\\s+(?:OR\\s+(?:REPLACE|IGNORE|ABORT|FAIL|ROLLBACK)\\s+)?${SQL_TBL}\\s+SET\\b`, "gi"),
  new RegExp(`\\bDELETE\\s+FROM\\s+${SQL_TBL}`, "gi"),
  new RegExp(`\\bFROM\\s+${SQL_TBL}`, "gi"),
  new RegExp(`\\bJOIN\\s+${SQL_TBL}`, "gi"),
  new RegExp(`\\bALTER\\s+TABLE\\s+${SQL_TBL}`, "gi"),
  new RegExp(`\\bDROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${SQL_TBL}`, "gi"),
  new RegExp(`\\bCREATE\\s+(?:TEMP(?:ORARY)?\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${SQL_TBL}`, "gi"),
  new RegExp(`\\bCREATE\\s+(?:TEMP(?:ORARY)?\\s+)?VIEW\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${SQL_TBL}`, "gi"),
  new RegExp(`\\bREFERENCES\\s+${SQL_TBL}`, "gi"),
];

/**
 * Extract the table identifiers a raw SQL statement references (trigger ON-targets,
 * INSERT/UPDATE/DELETE/SELECT/JOIN targets incl. trigger bodies, index ON-targets,
 * ALTER/CREATE/DROP TABLE, REFERENCES). CTE names declared in the same statement are
 * excluded. Comments and string literals are ignored. Conservative by design: it is
 * the input to a deny-on-unknown ownership guard.
 */
export function referencedTables(sql: string): string[] {
  const clean = stripSqlNoise(sql);
  // CTE names declared in this statement (WITH a AS (...), b AS (...)) are not tables.
  const cteNames = new Set<string>();
  for (const m of clean.matchAll(new RegExp(`\\b(?:WITH(?:\\s+RECURSIVE)?|,)\\s*(${SQL_ID})\\s+AS\\s*\\(`, "gi"))) {
    cteNames.add(unquoteSqlIdent(m[1]!).toLowerCase());
  }
  const out = new Map<string, string>(); // lowercased → first-seen spelling
  for (const re of TABLE_POSITION_PATTERNS) {
    for (const m of clean.matchAll(re)) {
      const name = unquoteSqlIdent(m[1]!);
      const key = name.toLowerCase();
      if (!cteNames.has(key) && !out.has(key)) out.set(key, name);
    }
  }
  return [...out.values()];
}

function assertStatementOwned(stmt: string, appId: string, ownerByTable: Map<string, string>): void {
  for (const t of referencedTables(stmt)) {
    const key = t.toLowerCase();
    if (key.startsWith("sqlite_") || key.startsWith("__")) {
      throw new Error(`aux migration blocked — "${t}" is a core-internal table; app SQL may not touch it`);
    }
    const owner = ownerByTable.get(key);
    if (owner === undefined) {
      throw new Error(
        `aux migration blocked — "${t}" is not a registered table; tables are created via ` +
          `SchemaDescriptors (registerSchemas), not aux SQL`,
      );
    }
    if (owner !== appId) {
      throw new Error(`aux migration blocked — "${t}" is owned by "${owner}", not "${appId}"`);
    }
  }
}

async function ensureAuxMigrationsTable(db: SqlDb): Promise<void> {
  await db.execute(
    `CREATE TABLE IF NOT EXISTS ${ident(AUX_MIGRATIONS_TABLE)} (` +
      `app_id TEXT NOT NULL, version INTEGER NOT NULL, applied_at TEXT NOT NULL, ` +
      `PRIMARY KEY (app_id, version))`,
  );
}

/**
 * Apply an app's auxiliary raw-SQL migrations to the shared suite DB — the core
 * mechanism for what descriptors can't express (triggers, CHECK-bearing indexes, …),
 * replacing per-app Tauri-plugin SQL migrations. Run it AFTER {@link registerSchemas}
 * (the tables the SQL touches must already be registered).
 *
 * Semantics:
 *   - Steps are versioned and **append-only per app**: the `steps` array must be strictly
 *     ascending; already-recorded `(appId, version)` pairs are skipped (idempotent re-run);
 *     a NEW step below the app's high-water mark is rejected.
 *   - **Ownership guard** (security): every statement may reference ONLY tables whose
 *     registry owner is `appId`. Common tables (`owner: "common"`) need a core-owned step
 *     (`appId === "common"`). Unregistered or core-internal tables are rejected outright.
 *     All pending statements are guarded BEFORE any SQL is executed.
 */
export async function registerAuxMigrations(
  db: SqlDb,
  appId: string,
  steps: AuxMigrationStep[],
): Promise<AuxMigrationResult> {
  if (!appId) throw new Error("registerAuxMigrations: appId is required");
  for (let i = 0; i < steps.length; i++) {
    const v = steps[i]!.version;
    if (!Number.isInteger(v) || v < 1) {
      throw new Error(`aux migration rejected — version must be a positive integer (got ${v})`);
    }
    if (i > 0 && v <= steps[i - 1]!.version) {
      throw new Error(
        `aux migration rejected — steps must be strictly ascending (version ${v} after ${steps[i - 1]!.version})`,
      );
    }
  }

  await ensureAuxMigrationsTable(db);
  const rows = await db.select<{ version: number }>(
    `SELECT version FROM ${ident(AUX_MIGRATIONS_TABLE)} WHERE app_id = ? ORDER BY version`,
    [appId],
  );
  const done = new Set(rows.map((r) => Number(r.version)));
  const highWater = rows.length ? Math.max(...rows.map((r) => Number(r.version))) : 0;

  const pending = steps.filter((s) => !done.has(s.version));
  const skipped = steps.filter((s) => done.has(s.version)).map((s) => s.version);
  for (const s of pending) {
    if (s.version < highWater) {
      throw new Error(
        `aux migration rejected — version ${s.version} is below the already-applied ` +
          `high-water mark ${highWater} for "${appId}" (append-only)`,
      );
    }
  }

  // Guard EVERY pending statement against the registry before executing ANY of them.
  const registry = await loadRegistry(db);
  const ownerByTable = new Map<string, string>();
  for (const s of Object.values(registry)) ownerByTable.set(tableName(s).toLowerCase(), s.owner);
  for (const step of pending) for (const stmt of step.sql) assertStatementOwned(stmt, appId, ownerByTable);

  const applied: number[] = [];
  for (const step of pending) {
    for (const stmt of step.sql) await db.execute(stmt);
    await db.execute(
      `INSERT INTO ${ident(AUX_MIGRATIONS_TABLE)} (app_id, version, applied_at) VALUES (?, ?, ?)`,
      [appId, step.version, new Date().toISOString()],
    );
    applied.push(step.version);
  }
  return { applied, skipped };
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
