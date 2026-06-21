/**
 * Excel backup & restore — whole-store export/import for any suite app.
 *
 * Every app exposes this from its Settings page: export ALL stored data (the app's
 * own SQLite DB plus the tables it owns/reads in the shared suite DB) into ONE
 * `.xlsx` workbook — one sheet per table — so the user holds a human-readable,
 * portable backup they can re-import on another machine.
 *
 * Secrets never leave in the clear: any field whose descriptor confidentiality is at
 * or above the configured floor (default `Secret`), and any column whose name matches
 * the secret-name pattern (password/passphrase/token/key/…) in tables that have no
 * descriptor, is exported as `sha256:<hex>` — a one-way fingerprint. On import those
 * sentinel values are SKIPPED so a hash can never overwrite a real secret; secrets are
 * re-entered (or restored via the vault/recovery path), by design.
 *
 * DI/pure like every core subsystem: runs against injected {@link SqlDb} handles. The
 * SheetJS codec defaults to the lib's own bundled `xlsx` dependency (lazy-imported on
 * first use) and can be overridden via `config.xlsx` (tests inject a fake). No module
 * state, no Tauri imports — the file save/pick stays in the app (or use the SSR-safe
 * `BackupPanel` in ../ui).
 *
 * OPTIONAL password protection (Excel-native): pass `{ password }` to
 * {@link ExcelBackup.exportWorkbook} and the workbook bytes are wrapped in ECMA-376
 * agile encryption (an OLE/CFB container with `EncryptionInfo` + `EncryptedPackage`
 * streams) — Excel itself prompts for the password on open, and the file is no longer
 * readable as a plain zip. Import auto-detects the container (see
 * {@link isEncryptedWorkbook}) and requires the same password. The encryptor defaults
 * to the MIT `officecrypto-tool` dependency, lazy-imported ONLY on the password path
 * (apps that never set a password load nothing extra) and overridable via
 * `config.ooxmlCrypto`. There is NO recovery for a forgotten backup password — by
 * design this stays optional and plaintext remains the default.
 */
import {
  CONFIDENTIALITY_ORDER,
  qualifiedName,
  type Confidentiality,
  type SchemaDescriptor,
  type SchemaRegistry,
} from "../schema/index.js";
import { createTableSql, tableName, REGISTRY_TABLE, loadRegistry, type SqlDb } from "../db/index.js";

// ── SheetJS surface (injected; subset of the `xlsx` module we use) ───────────

/** The slice of the SheetJS (`xlsx`) module the backup engine needs — pass the module itself. */
export interface XlsxModule {
  utils: {
    book_new(): unknown;
    book_append_sheet(wb: unknown, ws: unknown, name: string): void;
    json_to_sheet(rows: object[], opts?: { header?: string[] }): unknown;
    sheet_to_json<T>(ws: unknown, opts?: { defval?: unknown }): T[];
  };
  write(wb: unknown, opts: { type: "array"; bookType: "xlsx" }): ArrayBuffer;
  read(data: ArrayBuffer | Uint8Array, opts?: { type?: "array" }): { SheetNames: string[]; Sheets: Record<string, unknown> };
}

// ── OOXML encryption surface (injected; subset of `officecrypto-tool` we use) ─

/**
 * The OOXML (ECMA-376 agile) encryptor the password path needs. Defaults to the lib's
 * own `officecrypto-tool` dependency (MIT), lazy-imported only when a password is
 * actually used; override via {@link ExcelBackupConfig.ooxmlCrypto} (tests, browsers
 * without a `Buffer` polyfill, …). Both methods take and return whole-file bytes.
 */
export interface OoxmlCryptoModule {
  /** Wrap plaintext `.xlsx` bytes in an encrypted OLE/CFB container. */
  encrypt(input: Uint8Array, opts: { password: string }): Uint8Array | Promise<Uint8Array>;
  /** Unwrap an encrypted container back to plaintext `.xlsx` bytes. Rejects on a wrong password. */
  decrypt(input: Uint8Array, opts: { password: string }): Uint8Array | Promise<Uint8Array>;
}

// ── Config & result types ────────────────────────────────────────────────────

/** One database feeding the backup (the app's own DB, the shared suite DB, …). */
export interface BackupSource {
  /** Stable id recorded in the workbook meta (e.g. `"app"`, `"suite"`). */
  id: string;
  db: SqlDb;
  /** Explicit table list; omit to auto-discover user tables from `sqlite_master`. */
  tables?: string[];
  /** Descriptors governing (some of) this source's tables — drive field-level hashing. */
  descriptors?: SchemaDescriptor[];
  /**
   * Marks a SHARED store (the suite DB): its sheets restore from any suite app's
   * workbook, not only one produced by this `appId` (the per-app sources still
   * refuse a foreign workbook unless `force`).
   */
  shared?: boolean;
}

export interface ExcelBackupConfig {
  /** The exporting app — recorded in meta; import refuses a foreign app's file unless forced. */
  appId: string;
  sources: BackupSource[];
  /** SheetJS module override; defaults to the lib's own `xlsx` dependency (lazy import). */
  xlsx?: XlsxModule;
  /** OOXML encryptor override; defaults to the lib's own `officecrypto-tool` dependency (lazy import on the password path only). */
  ooxmlCrypto?: OoxmlCryptoModule;
  /** Hash fields whose confidentiality is at/above this level. Default `"Secret"`. */
  hashAtOrAbove?: Confidentiality;
  /** Name pattern hashed in tables with NO descriptor (defense in depth). */
  secretNamePattern?: RegExp;
  /** Tables never exported, in addition to internals. */
  excludeTables?: string[];
  /** Clock injection for tests. */
  now?: () => Date;
}

export interface TablePlan {
  sourceId: string;
  table: string;
  sheet: string;
  columns: string[];
  hashedColumns: string[];
  /** Qualified schema name when a descriptor governs this table. */
  qualified?: string;
  /**
   * Set when a descriptor-bearing source listed this table but no descriptor governs it,
   * so ALL columns were hashed (fail-closed) to avoid leaking an unregistered Secret field.
   * A non-empty set of these in an export signals a registration gap to investigate.
   */
  failClosed?: boolean;
}

export interface ExportReport {
  fileNameHint: string;
  tables: Array<TablePlan & { rows: number }>;
  /** True when the workbook bytes are password-protected (ECMA-376 agile encryption). */
  encrypted: boolean;
}

export interface ImportReport {
  tables: Array<{
    sourceId: string;
    table: string;
    sheet: string;
    rows: number;
    created: boolean;
    /** Columns skipped because they carry hashed-secret sentinels. */
    skippedHashedColumns: string[];
    /** Columns in the sheet that don't exist on the target table (skipped). */
    unknownColumns: string[];
  }>;
  /** Sheets that matched no known source (left untouched). */
  unmatchedSheets: string[];
  /** Sheets skipped because the workbook came from another app (non-shared sources only). */
  foreignAppSheets: string[];
}

export interface ExcelBackup {
  /** What an export WILL contain (tables, columns, which columns get hashed). */
  plan(): Promise<TablePlan[]>;
  /**
   * Build the workbook. Returns the raw `.xlsx` bytes + a per-table report. With
   * `password` the bytes are Excel-native encrypted (ECMA-376 agile) — Excel asks for
   * the password on open, and import requires it too. NO recovery if forgotten.
   */
  exportWorkbook(opts?: { password?: string }): Promise<{ bytes: Uint8Array; report: ExportReport }>;
  /**
   * Restore a workbook produced by {@link exportWorkbook}. `merge` (default) upserts
   * row-by-row; `replace` clears each matched table first. Hashed-secret sentinel
   * values are never written. Throws on a foreign `appId` unless `force`. A
   * password-protected workbook is auto-detected and requires `password` (clear
   * errors when it is missing or wrong).
   */
  importWorkbook(
    bytes: ArrayBuffer | Uint8Array,
    opts?: { mode?: "merge" | "replace"; force?: boolean; password?: string },
  ): Promise<ImportReport>;
}

// ── Internals ────────────────────────────────────────────────────────────────

export const BACKUP_FORMAT = "sharedcorelib-excel-backup";
export const BACKUP_FORMAT_VERSION = 1;
/** Exported secret fingerprints look like `sha256:<64 hex>`. */
export const HASHED_VALUE_RE = /^sha256:[0-9a-f]{64}$/;
const DEFAULT_SECRET_NAME_RE = /password|passphrase|secret|token|api[-_]?key|private[-_]?key|credential/i;
const META_SHEET = "_meta";
const TABLES_SHEET = "_tables";
const SCHEMAS_SHEET = "_schemas";
const INTERNAL_TABLES = new Set([REGISTRY_TABLE]);

const confRank = (c: Confidentiality): number => CONFIDENTIALITY_ORDER.indexOf(c);

// ── Password protection (ECMA-376 agile encryption) ──────────────────────────

// `isEncryptedWorkbook` lives in the dependency-free `./detect.js` leaf so UIs can
// import it without pulling this engine; re-exported here to keep the public surface.
import { isEncryptedWorkbook } from "./detect.js";
export { isEncryptedWorkbook };

/**
 * `officecrypto-tool` needs Node-style Buffers; fail with an actionable message where
 * none exists (inject `ooxmlCrypto` instead). Always a COPY — the lib works on the
 * buffer in place, and the caller's bytes must survive e.g. a wrong-password retry.
 */
function toBuffer(u8: Uint8Array): Buffer {
  if (typeof Buffer === "undefined") {
    throw new Error(
      "password-protected backups need a Buffer implementation in this runtime — add a bundler Buffer polyfill or inject config.ooxmlCrypto",
    );
  }
  return Buffer.from(u8); // Buffer.from(Uint8Array) copies
}

/** Adapt the lazy-imported `officecrypto-tool` CJS module (default vs named interop) to {@link OoxmlCryptoModule}. */
function adaptOfficeCrypto(mod: unknown): OoxmlCryptoModule {
  const m = mod as { default?: unknown; encrypt?: unknown };
  const lib = (typeof m.encrypt === "function" ? m : m.default) as {
    encrypt(input: Buffer, opts: { password: string }): Buffer;
    decrypt(input: Buffer, opts: { password: string }): Promise<Buffer>;
  };
  return {
    encrypt: (input, opts) => new Uint8Array(lib.encrypt(toBuffer(input), opts)),
    decrypt: async (input, opts) => new Uint8Array(await lib.decrypt(toBuffer(input), opts)),
  };
}

const SENTINEL_ENCODER = new TextEncoder();

async function sha256Sentinel(value: unknown): Promise<string> {
  const bytes = SENTINEL_ENCODER.encode(String(value));
  const digest = await crypto.subtle.digest("SHA-256", bytes.buffer as ArrayBuffer);
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  return `sha256:${hex}`;
}

/** Excel sheet names: ≤31 chars, no []:*?/\ — sanitize then dedupe with a numeric suffix. */
export function sheetNameFor(table: string, taken: Set<string>): string {
  let base = table.replace(/[[\]:*?/\\]/g, "_");
  if (base.length > 31) base = base.slice(0, 31);
  let name = base;
  let i = 2;
  while (taken.has(name)) {
    const suffix = `~${i++}`;
    name = base.slice(0, 31 - suffix.length) + suffix;
  }
  taken.add(name);
  return name;
}

async function discoverTables(db: SqlDb): Promise<string[]> {
  const rows = await db.select<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite[_]%' ESCAPE '[' ORDER BY name`,
  );
  return rows.map((r) => r.name);
}

async function tableColumns(db: SqlDb, table: string): Promise<string[]> {
  const rows = await db.select<{ name: string }>(`PRAGMA table_info("${table.replace(/[^A-Za-z0-9_]/g, "_")}")`);
  return rows.map((r) => r.name);
}

/**
 * Which columns of `table` must be hashed, given its (optional) descriptor.
 *
 * FAIL-CLOSED (security): when the source declares descriptors (a registered/suite
 * source) but this particular table has NONE, we cannot know which columns are Secret,
 * so EVERY column is hashed rather than emitted as plaintext. Without this, a suite
 * table that slipped registration — auto-discovered into a `suiteSourceFull` dump —
 * would leak its Secret columns (e.g. one named `value`/`data`, outside the name rule)
 * as plaintext, and via the cross-app full-suite export that leak rides out in ANOTHER
 * app's workbook. A descriptor-LESS source (no registry at all) keeps the legacy
 * name-pattern-only behavior.
 */
function hashedColumnsFor(
  columns: string[],
  descriptor: SchemaDescriptor | undefined,
  floor: Confidentiality,
  namePattern: RegExp,
  sourceHasDescriptors: boolean,
): string[] {
  if (!descriptor) {
    if (sourceHasDescriptors) return [...columns]; // fail closed: registered source, unknown table → hash all
    return columns.filter((c) => namePattern.test(c)); // descriptor-less source → name rule only
  }
  const byCol = new Map<string, Confidentiality>();
  for (const f of descriptor.fields) byCol.set(f.dbAlias ?? f.name, f.confidentiality ?? descriptor.confidentiality);
  return columns.filter((c) => {
    const level = byCol.get(c);
    if (level !== undefined) return confRank(level) >= confRank(floor);
    return namePattern.test(c); // column unknown to the descriptor — fall back to the name rule
  });
}

/**
 * Convenience: the {@link BackupSource} for an app's slice of the shared suite DB —
 * the tables it owns plus the shared `common` tables, with their registry descriptors.
 */
export function suiteSourceForApp(db: SqlDb, registry: SchemaRegistry, appId: string): BackupSource {
  const descriptors = Object.values(registry).filter((s) => s.owner === appId || s.owner === "common");
  return { id: "suite", db, tables: descriptors.map(tableName), descriptors, shared: true };
}

/**
 * Convenience: the {@link BackupSource} for the ENTIRE shared suite DB — every table
 * every installed app has registered (auto-discovered from `sqlite_master`), with the
 * FULL registry's descriptors driving field-level hashing. This is the suite-wide
 * "everything the system has" dump: any app's Settings export carries all apps' shared
 * data, and the resulting workbook restores into any suite app on another machine.
 * (Per-app legacy DBs of OTHER apps live in their own sandboxes and are not reachable —
 * they enter the suite dump as their backfills into `suite.db` land.)
 */
export function suiteSourceFull(db: SqlDb, registry: SchemaRegistry): BackupSource {
  return { id: "suite", db, descriptors: Object.values(registry), shared: true };
}

// ── Suite-wide backup convenience (dedup: identical glue across every app) ────
//
// Every suite app's Settings "Backup & restore" wires the SAME two helpers over
// `createExcelBackup` + `suiteSourceFull`: a native byte-save, and a one-call build of
// the engine over the whole shared suite DB. They are byte-identical across the apps, so
// they live here as DI helpers (no app id / DB path baked in — both are injected).

/**
 * Native save of finished workbook bytes — the `BackupPanel`/Settings save handler every
 * Tauri app exposes. Pops the OS save dialog (`.xlsx` filter, default name = `fileName`),
 * then writes the bytes. Throws `"Export cancelled"` if the user picks no path. The Tauri
 * plugins are dynamically imported so this module stays import-safe in the browser/SSR.
 */
export async function saveBackupBytes(bytes: Uint8Array, fileName: string): Promise<void> {
  const { save } = await import("@tauri-apps/plugin-dialog");
  const { writeFile } = await import("@tauri-apps/plugin-fs");
  const path = await save({
    defaultPath: fileName,
    filters: [{ name: "Excel workbook", extensions: ["xlsx"] }],
  });
  if (!path) throw new Error("Export cancelled — no file chosen.");
  await writeFile(path, bytes);
}

export interface SuiteBackupOptions {
  /** The exporting app id (recorded in meta; gates per-app restore). */
  appId: string;
  /** Open the shared suite DB (the Tauri SQL plugin handle); called once per build. */
  openDb: () => Promise<SqlDb>;
  /**
   * Load the schema registry for the opened DB. Defaults to `loadRegistry` from `../db`.
   * Injectable for tests / to avoid pulling the default DB path.
   */
  loadRegistry?: (db: SqlDb) => Promise<SchemaRegistry>;
  /** SheetJS override forwarded to {@link createExcelBackup} (tests inject a fake). */
  xlsx?: XlsxModule;
  /** OOXML encryptor override forwarded to {@link createExcelBackup} (password path only). */
  ooxmlCrypto?: OoxmlCryptoModule;
}

/**
 * Build the whole-suite backup engine over the shared suite DB in one call — the standard
 * "export everything the system has" path. Opens the DB, loads the registry, and returns a
 * {@link createExcelBackup} bound to a single {@link suiteSourceFull} source. Identical glue
 * across every app, parameterized only by `appId` + the injected `openDb` (and an optional
 * `loadRegistry` to dodge any default-DB-path coupling).
 */
export async function buildSuiteBackup(opts: SuiteBackupOptions): Promise<ExcelBackup> {
  const db = await opts.openDb();
  const load = opts.loadRegistry ?? loadRegistry;
  const sources: BackupSource[] = [suiteSourceFull(db, await load(db))];
  return createExcelBackup({ appId: opts.appId, sources, xlsx: opts.xlsx, ooxmlCrypto: opts.ooxmlCrypto });
}

// ── Factory ──────────────────────────────────────────────────────────────────

export function createExcelBackup(cfg: ExcelBackupConfig): ExcelBackup {
  const floor = cfg.hashAtOrAbove ?? "Secret";
  const nameRe = cfg.secretNamePattern ?? DEFAULT_SECRET_NAME_RE;
  const excluded = new Set([...INTERNAL_TABLES, ...(cfg.excludeTables ?? [])]);
  const now = cfg.now ?? (() => new Date());
  let xlsxMod: XlsxModule | undefined = cfg.xlsx;
  const resolveXlsx = async (): Promise<XlsxModule> =>
    (xlsxMod ??= (await import("xlsx")) as unknown as XlsxModule);
  let ooxmlCrypto: OoxmlCryptoModule | undefined = cfg.ooxmlCrypto;
  const resolveOoxmlCrypto = async (): Promise<OoxmlCryptoModule> =>
    (ooxmlCrypto ??= adaptOfficeCrypto(await import("officecrypto-tool")));

  const descriptorFor = (src: BackupSource, table: string): SchemaDescriptor | undefined =>
    src.descriptors?.find((d) => tableName(d) === table);

  async function buildPlan(): Promise<TablePlan[]> {
    const plans: TablePlan[] = [];
    const taken = new Set<string>([META_SHEET, TABLES_SHEET, SCHEMAS_SHEET]);
    for (const src of cfg.sources) {
      const tables = (src.tables ?? (await discoverTables(src.db))).filter((t) => !excluded.has(t));
      const sourceHasDescriptors = (src.descriptors?.length ?? 0) > 0;
      for (const table of tables) {
        const columns = await tableColumns(src.db, table);
        if (!columns.length) continue; // absent table (e.g. suite table not created yet)
        const d = descriptorFor(src, table);
        plans.push({
          sourceId: src.id,
          table,
          sheet: sheetNameFor(table, taken),
          columns,
          hashedColumns: hashedColumnsFor(columns, d, floor, nameRe, sourceHasDescriptors),
          qualified: d ? qualifiedName(d) : undefined,
          // A registered source listing a table with no descriptor → fully hashed (fail-closed).
          failClosed: sourceHasDescriptors && !d ? true : undefined,
        });
      }
    }
    return plans;
  }

  return {
    plan: buildPlan,

    exportWorkbook: async (exportOpts = {}) => {
      const X = await resolveXlsx();
      const plans = await buildPlan();
      const wb = X.utils.book_new();
      const tableRows: object[] = [];
      const schemaRows: object[] = [];
      const reportTables: ExportReport["tables"] = [];

      for (const p of plans) {
        const src = cfg.sources.find((s) => s.id === p.sourceId)!;
        const rows = await src.db.select<Record<string, unknown>>(`SELECT * FROM "${p.table.replace(/[^A-Za-z0-9_]/g, "_")}"`);
        const out: Record<string, unknown>[] = [];
        let exportedRows = 0;
        for (const row of rows) {
          const copy: Record<string, unknown> = {};
          for (const col of p.columns) {
            const v = row[col];
            copy[col] =
              p.hashedColumns.includes(col) && v !== null && v !== undefined && v !== ""
                ? await sha256Sentinel(v)
                : v ?? null;
          }
          out.push(copy);
          // Yield periodically so a large table doesn't freeze the webview (tables with
          // no hashed columns never hit the await above, so this loop can run fully sync).
          if (++exportedRows % 250 === 0) await new Promise((r) => setTimeout(r, 0));
        }
        X.utils.book_append_sheet(wb, X.utils.json_to_sheet(out, { header: p.columns }), p.sheet);
        tableRows.push({
          sheet: p.sheet, sourceId: p.sourceId, table: p.table,
          columns: p.columns.join("|"), hashedColumns: p.hashedColumns.join("|"),
        });
        const d = descriptorFor(src, p.table);
        if (d) schemaRows.push({ table: p.table, qualified: qualifiedName(d), descriptor: JSON.stringify(d) });
        reportTables.push({ ...p, rows: out.length });
      }

      const exportedAt = now().toISOString();
      X.utils.book_append_sheet(
        wb,
        X.utils.json_to_sheet([{
          format: BACKUP_FORMAT, formatVersion: BACKUP_FORMAT_VERSION,
          appId: cfg.appId, exportedAt,
          note: "Secret fields are one-way sha256 fingerprints; they are skipped on import.",
        }]),
        META_SHEET,
      );
      X.utils.book_append_sheet(wb, X.utils.json_to_sheet(tableRows), TABLES_SHEET);
      if (schemaRows.length) X.utils.book_append_sheet(wb, X.utils.json_to_sheet(schemaRows), SCHEMAS_SHEET);

      let bytes: Uint8Array = new Uint8Array(X.write(wb, { type: "array", bookType: "xlsx" }));
      const password = exportOpts.password;
      if (password) {
        // Excel-native protection: wrap the plaintext zip in an ECMA-376 agile
        // encryption container. Excel prompts for this password on open.
        bytes = await (await resolveOoxmlCrypto()).encrypt(bytes, { password });
      }
      const stamp = exportedAt.slice(0, 10);
      return {
        bytes,
        report: { fileNameHint: `${cfg.appId}-backup-${stamp}.xlsx`, tables: reportTables, encrypted: Boolean(password) },
      };
    },

    importWorkbook: async (bytes, opts = {}) => {
      const X = await resolveXlsx();
      const mode = opts.mode ?? "merge";
      let u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      if (isEncryptedWorkbook(u8)) {
        if (!opts.password) {
          throw new Error("this backup is password-protected — enter its password to import");
        }
        try {
          u8 = await (await resolveOoxmlCrypto()).decrypt(u8, { password: opts.password });
        } catch {
          throw new Error("wrong password for this backup (or the file is corrupted)");
        }
      }
      const wb = X.read(u8, { type: "array" });

      const metaWs = wb.Sheets[META_SHEET];
      if (!metaWs) throw new Error("not a sharedcorelib Excel backup (missing _meta sheet)");
      const meta = X.utils.sheet_to_json<{ format?: string; formatVersion?: number; appId?: string }>(metaWs)[0] ?? {};
      if (meta.format !== BACKUP_FORMAT) throw new Error(`unknown backup format: ${meta.format ?? "(none)"}`);
      if ((meta.formatVersion ?? 0) > BACKUP_FORMAT_VERSION) {
        throw new Error(`backup format v${meta.formatVersion} is newer than this app understands (v${BACKUP_FORMAT_VERSION})`);
      }
      // A foreign app's workbook may still restore SHARED stores (the suite DB is one
      // store for every app); only the per-app (non-shared) sources refuse it.
      const foreign = meta.appId !== cfg.appId && !opts.force;
      if (foreign && !cfg.sources.some((s) => s.shared)) {
        throw new Error(`backup belongs to "${meta.appId}", not "${cfg.appId}" — pass force to import anyway`);
      }

      const tablesWs = wb.Sheets[TABLES_SHEET];
      if (!tablesWs) throw new Error("corrupt backup: missing _tables sheet");
      const mappings = X.utils.sheet_to_json<{ sheet: string; sourceId: string; table: string; hashedColumns?: string }>(tablesWs);
      const schemasWs = wb.Sheets[SCHEMAS_SHEET];
      const embedded = new Map<string, SchemaDescriptor>();
      if (schemasWs) {
        for (const r of X.utils.sheet_to_json<{ table: string; descriptor: string }>(schemasWs)) {
          try { embedded.set(r.table, JSON.parse(r.descriptor) as SchemaDescriptor); } catch { /* skip corrupt */ }
        }
      }

      const report: ImportReport = { tables: [], unmatchedSheets: [], foreignAppSheets: [] };
      for (const m of mappings) {
        const src = cfg.sources.find((s) => s.id === m.sourceId);
        const ws = wb.Sheets[m.sheet];
        if (!src || !ws || excluded.has(m.table)) {
          report.unmatchedSheets.push(m.sheet);
          continue;
        }
        if (foreign && !src.shared) {
          report.foreignAppSheets.push(m.sheet);
          continue;
        }
        const safeTable = m.table.replace(/[^A-Za-z0-9_]/g, "_");
        let columns = await tableColumns(src.db, m.table);
        let created = false;
        if (!columns.length) {
          const d = embedded.get(m.table);
          if (!d) { report.unmatchedSheets.push(m.sheet); continue; }
          for (const sql of createTableSql(d)) await src.db.execute(sql);
          columns = await tableColumns(src.db, m.table);
          created = true;
        }

        const rows = X.utils.sheet_to_json<Record<string, unknown>>(ws, { defval: null });
        const declaredHashed = new Set((m.hashedColumns ?? "").split("|").filter(Boolean));
        const colSet = new Set(columns);
        const skippedHashed = new Set<string>();
        const unknown = new Set<string>();

        if (mode === "replace" && rows.length) await src.db.execute(`DELETE FROM "${safeTable}"`);

        let written = 0;
        for (const row of rows) {
          const cols: string[] = [];
          const vals: unknown[] = [];
          for (const [col, value] of Object.entries(row)) {
            if (!colSet.has(col)) { unknown.add(col); continue; }
            if (declaredHashed.has(col) || (typeof value === "string" && HASHED_VALUE_RE.test(value))) {
              skippedHashed.add(col);
              continue; // never write a fingerprint over a real secret
            }
            cols.push(`"${col.replace(/[^A-Za-z0-9_]/g, "_")}"`);
            vals.push(value);
          }
          if (!cols.length) continue;
          await src.db.execute(
            `INSERT OR REPLACE INTO "${safeTable}" (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
            vals,
          );
          written++;
          // Yield periodically so a large restore keeps the webview responsive.
          if (written % 250 === 0) await new Promise((r) => setTimeout(r, 0));
        }

        report.tables.push({
          sourceId: m.sourceId, table: m.table, sheet: m.sheet, rows: written, created,
          skippedHashedColumns: [...skippedHashed], unknownColumns: [...unknown],
        });
      }
      return report;
    },
  };
}
