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

/**
 * The schema's sole numeric `keyField`, if it has exactly one. SQLite only aliases a
 * PRIMARY KEY column to the internal ROWID (and so auto-populates it on INSERT) when its
 * declared type is the literal `INTEGER` and it is the table's only key column — `REAL`
 * (the normal `sqliteType` mapping for `"number"`) does NOT get this treatment, so an
 * app-side auto-incrementing integer id must be special-cased to `INTEGER` here. Numeric
 * fields that are not the sole key (e.g. `balance`, `value`, `height_cm`) are unaffected
 * and keep their normal `REAL` affinity.
 */
function soleNumericKeyField(s: SchemaDescriptor): FieldDescriptor | null {
  const keys = s.fields.filter((f) => f.keyField);
  return keys.length === 1 && keys[0]!.dataType === "number" ? keys[0]! : null;
}

/** `CREATE [UNIQUE] INDEX IF NOT EXISTS` for every field-level `index:` on a schema. */
function fieldIndexSql(s: SchemaDescriptor): string[] {
  const t = tableName(s);
  const stmts: string[] = [];
  for (const f of s.fields) {
    if (!f.index || f.keyField) continue;
    if (f.index === "Text") continue; // full-text needs FTS — left to the app
    const unique = f.index === "Unique" ? "UNIQUE " : "";
    stmts.push(`CREATE ${unique}INDEX IF NOT EXISTS ${ident(`ix_${t}_${f.name}`)} ON ${ident(t)} (${colName(f)})`);
  }
  return stmts;
}

/** CREATE TABLE (+ indexes) statements for a schema. */
export function createTableSql(s: SchemaDescriptor): string[] {
  const t = tableName(s);
  const intKey = soleNumericKeyField(s);
  const cols = s.fields.map((f) => {
    const notNull = f.required && !f.keyField ? " NOT NULL" : "";
    const type = f === intKey ? "INTEGER" : sqliteType(f.dataType);
    return `  ${colName(f)} ${type}${notNull}`;
  });
  const keys = s.fields.filter((f) => f.keyField).map(colName);
  if (keys.length) cols.push(`  PRIMARY KEY (${keys.join(", ")})`);
  return [`CREATE TABLE IF NOT EXISTS ${ident(t)} (\n${cols.join(",\n")}\n)`, ...fieldIndexSql(s)];
}

/** ALTER TABLE ADD COLUMN for an additively-added field (append-only; no NOT NULL). */
export function addColumnSql(s: SchemaDescriptor, f: FieldDescriptor): string {
  return `ALTER TABLE ${ident(tableName(s))} ADD COLUMN ${colName(f)} ${sqliteType(f.dataType)}`;
}

/**
 * The migration statements to evolve `existing` into `proposed` (additive only). Throws
 * (via the schema engine) if the change is incompatible. Returns [] when identical.
 *
 * `liveColumns`, when given, is the TABLE's actual physical column set (e.g. from
 * `PRAGMA table_info`) — a field absent from `existing` (the registry's stored copy) but
 * already physically present is skipped rather than re-ALTERed. This matters because the
 * registry record and the live table can drift out of sync (a raw aux-SQL step added the
 * column out-of-band, or a field was renamed away from and back to the same name across
 * two registry-writing boots): diffing against the registry alone would then re-issue
 * `ADD COLUMN` for something that already exists and throw "duplicate column name",
 * aborting registration for every other table in the same batch.
 */
export function migrationFor(
  existing: SchemaDescriptor,
  proposed: SchemaDescriptor,
  liveColumns?: ReadonlySet<string>,
): string[] {
  // mergeIntoRegistry throws on conflict; reuse it to validate, then diff fields.
  mergeIntoRegistry({ [qualifiedName(existing)]: existing }, [proposed]);
  const have = new Set(existing.fields.map((f) => f.name));
  return proposed.fields
    .filter((f) => !have.has(f.name))
    .filter((f) => !liveColumns?.has(f.dbAlias ?? f.name))
    .map((f) => addColumnSql(proposed, f));
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
  /**
   * Field-level index statements that failed when re-asserted against an already-
   * registered schema (e.g. data inserted while the index was missing now violates a
   * UNIQUE index being recreated) — non-fatal, since a stale index is a lesser problem
   * than aborting registration for every other table. The caller should dedupe/clean the
   * offending data and let this run again.
   */
  indexWarnings: { sql: string; error: string }[];
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
  const indexWarnings: { sql: string; error: string }[] = [];
  const merged = mergeIntoRegistry(registry, creating);
  for (const d of creating) {
    const q = qualifiedName(d);
    const existing = registry[q];
    // For an already-registered schema, migrationFor only returns ALTER ADD COLUMN for
    // genuinely new fields — a genuine migration failure here should still halt
    // registration, so it's NOT wrapped below. Cross-check against the table's ACTUAL
    // columns (not just the registry's stored copy) so a field the registry doesn't know
    // about yet, but that already physically exists, doesn't get re-ALTERed in (see
    // migrationFor's doc comment).
    let stmts: string[];
    if (existing) {
      const liveColumns = new Set(
        (await db.select<{ name: string }>(`PRAGMA table_info(${ident(tableName(d))})`)).map((c) => c.name),
      );
      stmts = migrationFor(existing, d, liveColumns);
    } else {
      stmts = createTableSql(merged[q]!);
    }
    for (const sql of stmts) { await db.execute(sql); applied.push(sql); }
    if (existing) {
      // It has no opinion on a field-level index that already exists in the descriptor —
      // re-assert those too: CREATE INDEX IF NOT EXISTS is a free no-op when the index is
      // already there, and cheap insurance against it having been dropped out-of-band
      // (e.g. by an app's own table-recreating repair migration). Fail-SOFT per statement:
      // data that drifted to violate a should-be-unique index while it was missing must
      // not abort registration for every other table — surface it instead.
      for (const sql of fieldIndexSql(merged[q]!)) {
        try { await db.execute(sql); applied.push(sql); }
        catch (e) { indexWarnings.push({ sql, error: e instanceof Error ? e.message : String(e) }); }
      }
    }
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
    indexWarnings,
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
  // NOTE: plain FROM/JOIN tables are extracted by scanFromJoinTables (below), NOT here —
  // a `\bFROM <tbl>` regex captures only the FIRST table, so the old-style comma join
  // `FROM a, b` would leave `b` (a possibly foreign table) invisible to the guard.
  new RegExp(`\\bALTER\\s+TABLE\\s+${SQL_TBL}`, "gi"),
  new RegExp(`\\bDROP\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?${SQL_TBL}`, "gi"),
  new RegExp(`\\bCREATE\\s+(?:TEMP(?:ORARY)?\\s+)?TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${SQL_TBL}`, "gi"),
  new RegExp(`\\bCREATE\\s+(?:TEMP(?:ORARY)?\\s+)?VIEW\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${SQL_TBL}`, "gi"),
  new RegExp(`\\bREFERENCES\\s+${SQL_TBL}`, "gi"),
];

// The leading table identifier of one FROM/JOIN-list item: `[schema.]table [[AS] alias]`.
// A subquery item (`(SELECT …) x`) starts with `(` and yields nothing here — its own
// FROM/JOIN tables are found by the global scan over the whole cleaned statement.
const FROM_ITEM_LEAD = new RegExp(`^\\s*${SQL_TBL}`, "i");
// Keywords that END a FROM/JOIN clause's comma-list (so commas in SELECT/INSERT-column/
// function-argument lists are never mistaken for additional join tables).
const FROM_LIST_STOP =
  /^\s+(?:WHERE|GROUP|HAVING|ORDER|LIMIT|OFFSET|WINDOW|UNION|EXCEPT|INTERSECT|RETURNING|ON|USING|SET|VALUES|JOIN|INNER|LEFT|RIGHT|FULL|OUTER|CROSS|NATURAL|FROM)\b/i;

/**
 * Scan every FROM/JOIN clause and return ALL referenced tables, INCLUDING the
 * old-style comma join `FROM a, b, c`. Bounded to the clause (stops at the next SQL
 * clause keyword) and paren-aware (a `(SELECT …)` subquery is skipped here; its own
 * tables are caught by the outer scan), so commas outside a FROM-list never count.
 */
function scanFromJoinTables(clean: string): string[] {
  const found: string[] = [];
  const kw = /\b(?:FROM|JOIN)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = kw.exec(clean)) !== null) {
    let i = m.index + m[0].length;
    let depth = 0;
    let buf = "";
    const items: string[] = [];
    const flush = (): void => {
      if (buf.trim()) items.push(buf);
      buf = "";
    };
    while (i < clean.length) {
      const ch = clean[i]!;
      if (ch === "(") { depth++; buf += ch; i++; continue; }
      if (ch === ")") { if (depth === 0) break; depth--; buf += ch; i++; continue; }
      if (depth === 0 && ch === ",") { flush(); i++; continue; }
      if (depth === 0 && ch === ";") break;
      if (depth === 0 && FROM_LIST_STOP.test(clean.slice(i))) break;
      buf += ch; i++;
    }
    flush();
    for (const item of items) {
      const lead = FROM_ITEM_LEAD.exec(item);
      if (lead) found.push(unquoteSqlIdent(lead[1]!));
    }
  }
  return found;
}

/**
 * Extract the table identifiers a raw SQL statement references (trigger ON-targets,
 * INSERT/UPDATE/DELETE/SELECT/JOIN targets incl. trigger bodies and comma joins, index
 * ON-targets, ALTER/CREATE/DROP TABLE, REFERENCES). CTE names declared in the same
 * statement are excluded. Comments and string literals are ignored. Conservative by
 * design: it is the input to a deny-on-unknown ownership guard.
 */
export function referencedTables(sql: string): string[] {
  const clean = stripSqlNoise(sql);
  // CTE names declared in this statement (WITH a AS (...), b AS (...)) are not tables.
  const cteNames = new Set<string>();
  for (const m of clean.matchAll(new RegExp(`\\b(?:WITH(?:\\s+RECURSIVE)?|,)\\s*(${SQL_ID})\\s+AS\\s*\\(`, "gi"))) {
    cteNames.add(unquoteSqlIdent(m[1]!).toLowerCase());
  }
  const out = new Map<string, string>(); // lowercased → first-seen spelling
  const record = (name: string): void => {
    const key = name.toLowerCase();
    if (!cteNames.has(key) && !out.has(key)) out.set(key, name);
  };
  for (const re of TABLE_POSITION_PATTERNS) {
    for (const m of clean.matchAll(re)) record(unquoteSqlIdent(m[1]!));
  }
  for (const name of scanFromJoinTables(clean)) record(name);
  return [...out.values()];
}

// Statements that reach outside the registered-table model entirely (attach a foreign
// DB file, flip schema-mutating pragmas, …). Table extraction can't reason about them,
// so they are denied outright rather than waved through with an empty referenced-set.
const FORBIDDEN_LEADING_KEYWORD = /^\s*(?:ATTACH|DETACH|PRAGMA|VACUUM)\b/i;

function assertStatementOwned(stmt: string, appId: string, ownerByTable: Map<string, string>): void {
  const clean = stripSqlNoise(stmt);
  if (FORBIDDEN_LEADING_KEYWORD.test(clean)) {
    const kw = FORBIDDEN_LEADING_KEYWORD.exec(clean)![0].trim().toUpperCase();
    throw new Error(`aux migration blocked — "${kw}" is not allowed in app SQL (it bypasses the table-ownership guard)`);
  }
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
    // OR IGNORE: two concurrent callers (e.g. React StrictMode double-invoking a dev boot
    // effect) can both compute the same `pending` set before either's ledger row lands —
    // each statement above is itself idempotent (IF NOT EXISTS/OR IGNORE by convention),
    // so let the loser's redundant ledger insert no-op instead of throwing a unique-
    // constraint error that would abort its whole caller mid-sequence.
    await db.execute(
      `INSERT OR IGNORE INTO ${ident(AUX_MIGRATIONS_TABLE)} (app_id, version, applied_at) VALUES (?, ?, ?)`,
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
      // `where` is a trusted, app-supplied predicate (values go through opts.params).
      // Reject statement-stacking / comment markers so a careless consumer that ever
      // derives it from untrusted input can't smuggle a second statement past this sink.
      if (opts.where && /;|--|\/\*/.test(opts.where)) {
        throw new Error(`invalid where clause: ${opts.where}`);
      }
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
