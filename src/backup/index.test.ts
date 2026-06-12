import { describe, it, expect } from "vitest";
import * as CFB from "cfb";
import {
  createExcelBackup, sheetNameFor, suiteSourceForApp, suiteSourceFull,
  isEncryptedWorkbook, HASHED_VALUE_RE, BACKUP_FORMAT,
  type XlsxModule, type BackupSource,
} from "./index.js";
import type { SchemaDescriptor } from "../schema/index.js";
import { REGISTRY_TABLE, type SqlDb } from "../db/index.js";

// ── Injected fake SheetJS module (workbook = JSON; core never imports `xlsx`) ─

interface FakeSheet { __rows: Record<string, unknown>[] }
interface FakeWb { SheetNames: string[]; Sheets: Record<string, FakeSheet> }

function fakeXlsx(): XlsxModule {
  return {
    utils: {
      book_new: () => ({ SheetNames: [], Sheets: {} }) as FakeWb,
      book_append_sheet: (wb, ws, name) => {
        const w = wb as FakeWb;
        w.SheetNames.push(name);
        w.Sheets[name] = ws as FakeSheet;
      },
      json_to_sheet: (rows) => ({ __rows: rows as Record<string, unknown>[] }),
      sheet_to_json: <T,>(ws: unknown) => ((ws as FakeSheet).__rows ?? []) as T[],
    },
    // The fake "workbook file" is JSON behind a real zip magic ("PK\x03\x04") — the
    // OOXML encryptor verifies decrypted plaintext LOOKS like a zip (its wrong-password
    // detector), so the fake must look like one too.
    write: (wb) => {
      const json = new TextEncoder().encode(JSON.stringify(wb));
      const out = new Uint8Array(4 + json.length);
      out.set([0x50, 0x4b, 0x03, 0x04]);
      out.set(json, 4);
      return out.buffer as ArrayBuffer;
    },
    read: (data) => {
      let bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
      if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) bytes = bytes.slice(4);
      return JSON.parse(new TextDecoder().decode(bytes)) as FakeWb;
    },
  };
}
const xlsx = fakeXlsx();
const readWb = (bytes: Uint8Array): FakeWb => xlsx.read(bytes) as FakeWb;
const sheetRows = (wb: FakeWb, name: string): Record<string, unknown>[] => wb.Sheets[name]?.__rows ?? [];

// ── In-memory fake SqlDb understanding exactly the SQL the engine issues ─────

interface MemTable { columns: string[]; rows: Record<string, unknown>[] }

function memDb(initial: Record<string, MemTable> = {}): { db: SqlDb; tables: Map<string, MemTable> } {
  const tables = new Map<string, MemTable>(Object.entries(initial));
  const db: SqlDb = {
    async select<T>(sql: string): Promise<T[]> {
      if (/FROM sqlite_master/i.test(sql)) {
        return [...tables.keys()].sort().map((name) => ({ name })) as T[];
      }
      const pragma = /^PRAGMA table_info\("(.+)"\)$/.exec(sql);
      if (pragma) return (tables.get(pragma[1]!)?.columns ?? []).map((name) => ({ name })) as T[];
      const all = /^SELECT \* FROM "(.+)"$/.exec(sql);
      if (all) return (tables.get(all[1]!)?.rows ?? []) as T[];
      throw new Error(`memDb: unhandled select: ${sql}`);
    },
    async execute(sql: string, params: unknown[] = []) {
      const create = /^CREATE TABLE IF NOT EXISTS "(.+?)" \(([\s\S]+)\)$/.exec(sql);
      if (create) {
        const cols = [...create[2]!.matchAll(/^\s*"([A-Za-z0-9_]+)"\s/gm)].map((m) => m[1]!);
        if (!tables.has(create[1]!)) tables.set(create[1]!, { columns: cols, rows: [] });
        return {};
      }
      if (/^CREATE (UNIQUE )?INDEX/.test(sql)) return {};
      const del = /^DELETE FROM "(.+)"$/.exec(sql);
      if (del) { const t = tables.get(del[1]!); if (t) t.rows = []; return {}; }
      const ins = /^INSERT OR REPLACE INTO "(.+?)" \((.+?)\) VALUES/.exec(sql);
      if (ins) {
        const t = tables.get(ins[1]!);
        if (!t) throw new Error(`memDb: no table ${ins[1]}`);
        const cols = ins[2]!.split(", ").map((c) => c.replace(/"/g, ""));
        const row: Record<string, unknown> = {};
        cols.forEach((c, i) => { row[c] = params[i]; });
        t.rows.push(row);
        return { rowsAffected: 1 };
      }
      throw new Error(`memDb: unhandled execute: ${sql}`);
    },
  };
  return { db, tables };
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

const credsDescriptor: SchemaDescriptor = {
  namespace: "myapp", name: "Credential", schemaType: "Table",
  confidentiality: "Confidential", owner: "myapp", dbAlias: "creds",
  fields: [
    { name: "id", dataType: "id", keyField: true, required: true },
    { name: "site", dataType: "string" },
    { name: "login_password", dataType: "string", confidentiality: "Secret" },
  ],
};

function appSource(): { src: BackupSource; tables: Map<string, MemTable> } {
  const { db, tables } = memDb({
    accounts: { columns: ["id", "name", "balance"], rows: [
      { id: "a1", name: "Savings", balance: 1200 },
      { id: "a2", name: "Current", balance: 300 },
    ] },
    settings: { columns: ["key", "value", "api_token"], rows: [
      { key: "theme", value: "dark", api_token: "tok-123" },
    ] },
    [REGISTRY_TABLE]: { columns: ["qualified", "descriptor"], rows: [{ qualified: "x", descriptor: "{}" }] },
  });
  return { src: { id: "app", db }, tables };
}

function suiteSource(): { src: BackupSource; tables: Map<string, MemTable> } {
  const { db, tables } = memDb({
    creds: { columns: ["id", "site", "login_password"], rows: [
      { id: "c1", site: "example.com", login_password: "hunter2" },
    ] },
  });
  return { src: { id: "suite", db, tables: ["creds"], descriptors: [credsDescriptor] }, tables };
}

const make = (sources: BackupSource[]) =>
  createExcelBackup({ appId: "myapp", sources, xlsx, now: () => new Date("2026-06-11T00:00:00Z") });

// ── Tests ────────────────────────────────────────────────────────────────────

describe("sheetNameFor", () => {
  it("truncates to 31 chars and dedupes collisions", () => {
    const taken = new Set<string>();
    const long = "a_very_long_table_name_that_exceeds_excel_limit";
    const first = sheetNameFor(long, taken);
    const second = sheetNameFor(long, taken);
    expect(first).toHaveLength(31);
    expect(second).toHaveLength(31);
    expect(second).not.toBe(first);
    expect(second.endsWith("~2")).toBe(true);
  });

  it("strips characters Excel forbids", () => {
    expect(sheetNameFor("a[b]:c*d?e/f\\g", new Set())).toBe("a_b__c_d_e_f_g");
  });
});

describe("plan", () => {
  it("discovers tables, excludes internals, and marks hashed columns by descriptor + name rule", async () => {
    const app = appSource();
    const suite = suiteSource();
    const plans = await make([app.src, suite.src]).plan();

    expect(plans.map((p) => p.table).sort()).toEqual(["accounts", "creds", "settings"]); // registry excluded
    expect(plans.find((p) => p.table === "settings")?.hashedColumns).toEqual(["api_token"]); // name rule
    expect(plans.find((p) => p.table === "creds")?.hashedColumns).toEqual(["login_password"]); // Secret field
    expect(plans.find((p) => p.table === "creds")?.qualified).toBe("myapp#Credential");
  });
});

describe("exportWorkbook", () => {
  it("writes one sheet per table + meta, hashing secrets", async () => {
    const { bytes, report } = await make([appSource().src, suiteSource().src]).exportWorkbook();

    expect(report.fileNameHint).toBe("myapp-backup-2026-06-11.xlsx");
    const wb = readWb(bytes);
    expect(wb.SheetNames).toEqual(expect.arrayContaining(["accounts", "settings", "creds", "_meta", "_tables", "_schemas"]));

    const meta = sheetRows(wb, "_meta")[0]!;
    expect(meta.format).toBe(BACKUP_FORMAT);
    expect(meta.appId).toBe("myapp");

    const creds = sheetRows(wb, "creds")[0]!;
    expect(creds.site).toBe("example.com");
    expect(String(creds.login_password)).toMatch(HASHED_VALUE_RE); // never plaintext
    expect(String(creds.login_password)).not.toContain("hunter2");
    expect(String(sheetRows(wb, "settings")[0]!.api_token)).toMatch(HASHED_VALUE_RE);
    // non-secret data is in the clear (it's a usable backup)
    expect(sheetRows(wb, "accounts")[0]).toMatchObject({ id: "a1", name: "Savings", balance: 1200 });
  });

  it("hashes deterministically (same secret → same fingerprint)", async () => {
    const a = await make([suiteSource().src]).exportWorkbook();
    const b = await make([suiteSource().src]).exportWorkbook();
    expect(sheetRows(readWb(a.bytes), "creds")[0]!.login_password)
      .toBe(sheetRows(readWb(b.bytes), "creds")[0]!.login_password);
  });
});

describe("importWorkbook", () => {
  it("round-trips data onto a fresh machine, skipping hashed secrets and creating descriptor-backed tables", async () => {
    const { bytes } = await make([appSource().src, suiteSource().src]).exportWorkbook();

    // Fresh machine: app tables exist (migrations ran) but are empty; suite table absent.
    const freshApp = memDb({
      accounts: { columns: ["id", "name", "balance"], rows: [] },
      settings: { columns: ["key", "value", "api_token"], rows: [] },
    });
    const freshSuite = memDb();
    const report = await make([
      { id: "app", db: freshApp.db },
      { id: "suite", db: freshSuite.db, descriptors: [credsDescriptor] },
    ]).importWorkbook(bytes);

    expect(freshApp.tables.get("accounts")?.rows).toHaveLength(2);
    expect(freshApp.tables.get("accounts")?.rows[0]).toMatchObject({ id: "a1", name: "Savings", balance: 1200 });
    // hashed columns skipped → a fingerprint is never written as a secret
    expect(freshApp.tables.get("settings")?.rows[0]).not.toHaveProperty("api_token");
    const credsReport = report.tables.find((t) => t.table === "creds")!;
    expect(credsReport.created).toBe(true); // rebuilt from the embedded descriptor
    expect(credsReport.skippedHashedColumns).toEqual(["login_password"]);
    expect(freshSuite.tables.get("creds")?.rows[0]).toMatchObject({ id: "c1", site: "example.com" });
    expect(freshSuite.tables.get("creds")?.rows[0]).not.toHaveProperty("login_password");
  });

  it("replace mode clears matched tables first", async () => {
    const { bytes } = await make([appSource().src]).exportWorkbook();
    const target = memDb({
      accounts: { columns: ["id", "name", "balance"], rows: [{ id: "old", name: "Stale", balance: 1 }] },
      settings: { columns: ["key", "value", "api_token"], rows: [] },
    });
    await make([{ id: "app", db: target.db }]).importWorkbook(bytes, { mode: "replace" });
    const ids = target.tables.get("accounts")!.rows.map((r) => r.id);
    expect(ids).toEqual(["a1", "a2"]); // stale row gone
  });

  it("refuses a foreign app's backup unless forced (no shared source)", async () => {
    const { bytes } = await make([appSource().src]).exportWorkbook();
    const otherDb = memDb({ accounts: { columns: ["id", "name", "balance"], rows: [] } });
    const other = createExcelBackup({ appId: "otherapp", sources: [{ id: "app", db: otherDb.db }], xlsx });
    await expect(other.importWorkbook(bytes)).rejects.toThrow(/belongs to "myapp"/);
    await expect(other.importWorkbook(bytes, { force: true })).resolves.toBeTruthy();
  });

  it("a foreign app's workbook still restores the SHARED suite store (per-app sheets skipped)", async () => {
    // myapp exports its own DB + the suite store…
    const { bytes } = await make([appSource().src, suiteSource().src]).exportWorkbook();
    // …and otherapp (different appId) imports: suite sheets land, app sheets are skipped.
    const otherApp = memDb({ accounts: { columns: ["id", "name", "balance"], rows: [] } });
    const otherSuite = memDb();
    const report = await createExcelBackup({
      appId: "otherapp",
      sources: [
        { id: "app", db: otherApp.db },
        { id: "suite", db: otherSuite.db, descriptors: [credsDescriptor], shared: true },
      ],
      xlsx,
    }).importWorkbook(bytes);

    expect(otherSuite.tables.get("creds")?.rows).toHaveLength(1); // shared store restored
    expect(otherApp.tables.get("accounts")?.rows).toHaveLength(0); // foreign per-app data NOT written
    expect(report.foreignAppSheets.sort()).toEqual(["accounts", "settings"]);
    expect(report.tables.map((t) => t.table)).toEqual(["creds"]);
  });

  it("rejects files that are not sharedcorelib backups", async () => {
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, xlsx.utils.json_to_sheet([{ a: 1 }]), "Sheet1");
    const bytes = new Uint8Array(xlsx.write(wb, { type: "array", bookType: "xlsx" }));
    await expect(make([appSource().src]).importWorkbook(bytes)).rejects.toThrow(/missing _meta/);
  });
});

describe("default SheetJS codec (the lib's own xlsx dependency)", () => {
  it("round-trips a real .xlsx when no xlsx module is injected", async () => {
    const src = appSource().src;
    const engine = createExcelBackup({ appId: "myapp", sources: [src], now: () => new Date("2026-06-11T00:00:00Z") });
    const { bytes, report } = await engine.exportWorkbook();
    expect(report.fileNameHint).toBe("myapp-backup-2026-06-11.xlsx");
    expect(bytes.length).toBeGreaterThan(500); // a real zip container, not our JSON fake
    expect(bytes[0]).toBe(0x50); // "PK"
    expect(bytes[1]).toBe(0x4b);

    const fresh = memDb({
      accounts: { columns: ["id", "name", "balance"], rows: [] },
      settings: { columns: ["key", "value", "api_token"], rows: [] },
    });
    const imported = await createExcelBackup({ appId: "myapp", sources: [{ id: "app", db: fresh.db }] })
      .importWorkbook(bytes);
    expect(fresh.tables.get("accounts")?.rows).toHaveLength(2);
    expect(fresh.tables.get("accounts")?.rows[0]).toMatchObject({ id: "a1", name: "Savings", balance: 1200 });
    expect(fresh.tables.get("settings")?.rows[0]).not.toHaveProperty("api_token"); // hash skipped
    expect(imported.tables.find((t) => t.table === "settings")?.skippedHashedColumns).toEqual(["api_token"]);
  });

  it("password-protects a REAL .xlsx end to end (SheetJS write → agile encrypt → decrypt → SheetJS read)", async () => {
    const engine = createExcelBackup({ appId: "myapp", sources: [appSource().src] });
    const { bytes, report } = await engine.exportWorkbook({ password: "real-pw" });

    expect(report.encrypted).toBe(true);
    expect(isEncryptedWorkbook(bytes)).toBe(true);
    expect(bytes[0]).not.toBe(0x50); // no longer a plain zip
    // real SheetJS refuses it without the password (Excel would prompt instead)
    const X = (await import("xlsx")) as unknown as XlsxModule;
    expect(() => X.read(bytes)).toThrow(/password/i);

    const fresh = memDb({
      accounts: { columns: ["id", "name", "balance"], rows: [] },
      settings: { columns: ["key", "value", "api_token"], rows: [] },
    });
    const target = createExcelBackup({ appId: "myapp", sources: [{ id: "app", db: fresh.db }] });
    await expect(target.importWorkbook(bytes)).rejects.toThrow(/password-protected/);
    await target.importWorkbook(bytes, { password: "real-pw" });
    expect(fresh.tables.get("accounts")?.rows).toHaveLength(2);
    expect(fresh.tables.get("accounts")?.rows[0]).toMatchObject({ id: "a1", name: "Savings", balance: 1200 });
  });
});

describe("password protection (Excel-native OOXML agile encryption)", () => {
  const OLE_SIG = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1];

  it("isEncryptedWorkbook tells the OLE/CFB container apart from plain bytes", async () => {
    const { bytes: plain } = await make([appSource().src]).exportWorkbook();
    expect(isEncryptedWorkbook(plain)).toBe(false);
    expect(isEncryptedWorkbook(new Uint8Array(OLE_SIG))).toBe(true);
    expect(isEncryptedWorkbook(new Uint8Array([0xd0, 0xcf]))).toBe(false); // too short
  });

  it("no password → plaintext output, exactly as before (report says so)", async () => {
    const { bytes, report } = await make([appSource().src]).exportWorkbook({});
    expect(report.encrypted).toBe(false);
    expect(isEncryptedWorkbook(bytes)).toBe(false);
    expect(readWb(bytes).SheetNames).toContain("_meta"); // still directly readable
  });

  it("password → a real ECMA-376 agile encryption container, not a readable zip/workbook", async () => {
    const { bytes, report } = await make([appSource().src]).exportWorkbook({ password: "s3cret!" });

    expect(report.encrypted).toBe(true);
    // (a) unreadable as a plain workbook…
    expect(() => readWb(bytes)).toThrow(); // the codec cannot parse it any more
    expect(bytes[0]).not.toBe(0x50); // not zip "PK" — Excel sees an encrypted file
    // …because (b) it is an OLE/CFB compound file with the agile-encryption streams:
    expect(Array.from(bytes.slice(0, 8))).toEqual(OLE_SIG);
    expect(isEncryptedWorkbook(bytes)).toBe(true);
    const container = CFB.read(Buffer.from(bytes), { type: "buffer" });
    const paths = container.FullPaths.map((p) => p.replace(/^Root Entry\//, ""));
    expect(paths).toContain("EncryptionInfo");
    expect(paths).toContain("EncryptedPackage");
    const info = CFB.find(container, "EncryptionInfo")!;
    // EncryptionInfo header: version major=4, minor=4 ⇒ agile encryption (ECMA-376 Part 4).
    expect(Array.from(info.content.slice(0, 4))).toEqual([0x04, 0x00, 0x04, 0x00]);
    const xml = Buffer.from(info.content.slice(8) as Uint8Array).toString("utf8");
    expect(xml).toContain("http://schemas.microsoft.com/office/2006/encryption");
  });

  it("round-trips with the password: import decrypts and restores identical data", async () => {
    const { bytes } = await make([appSource().src, suiteSource().src]).exportWorkbook({ password: "pw-roundtrip" });

    const freshApp = memDb({
      accounts: { columns: ["id", "name", "balance"], rows: [] },
      settings: { columns: ["key", "value", "api_token"], rows: [] },
    });
    const freshSuite = memDb();
    const report = await make([
      { id: "app", db: freshApp.db },
      { id: "suite", db: freshSuite.db, descriptors: [credsDescriptor] },
    ]).importWorkbook(bytes, { password: "pw-roundtrip" });

    expect(freshApp.tables.get("accounts")?.rows).toEqual([
      { id: "a1", name: "Savings", balance: 1200 },
      { id: "a2", name: "Current", balance: 300 },
    ]);
    expect(freshSuite.tables.get("creds")?.rows[0]).toMatchObject({ id: "c1", site: "example.com" });
    // the secret-hashing contract is unchanged under encryption
    expect(report.tables.find((t) => t.table === "creds")?.skippedHashedColumns).toEqual(["login_password"]);
  });

  it("fails cleanly when the password is missing or wrong", async () => {
    const { bytes } = await make([appSource().src]).exportWorkbook({ password: "right" });
    const target = make([{ id: "app", db: memDb({ accounts: { columns: ["id", "name", "balance"], rows: [] } }).db }]);
    await expect(target.importWorkbook(bytes)).rejects.toThrow(/password-protected — enter its password/);
    await expect(target.importWorkbook(bytes, { password: "wrong" })).rejects.toThrow(/wrong password/);
    await expect(target.importWorkbook(bytes, { password: "right" })).resolves.toBeTruthy();
  });

  it("honors an injected ooxmlCrypto module (DI override)", async () => {
    const calls: string[] = [];
    const engine = createExcelBackup({
      appId: "myapp", sources: [appSource().src], xlsx,
      ooxmlCrypto: {
        encrypt: (input, opts) => { calls.push(`enc:${opts.password}`); return new Uint8Array([...OLE_SIG, ...input]); },
        decrypt: (input, opts) => { calls.push(`dec:${opts.password}`); return input.slice(OLE_SIG.length); },
      },
    });
    const { bytes } = await engine.exportWorkbook({ password: "pw" });
    expect(isEncryptedWorkbook(bytes)).toBe(true);
    await engine.importWorkbook(bytes, { password: "pw" });
    expect(calls).toEqual(["enc:pw", "dec:pw"]);
  });
});

describe("suiteSourceForApp", () => {
  it("selects the app's own + common tables with their descriptors", () => {
    const common: SchemaDescriptor = { ...credsDescriptor, namespace: "common", name: "IceCard", dbAlias: "common_ice", owner: "common" };
    const foreign: SchemaDescriptor = { ...credsDescriptor, namespace: "other", name: "Thing", dbAlias: "other_thing", owner: "otherapp" };
    const src = suiteSourceForApp(memDb().db, {
      "myapp#Credential": credsDescriptor, "common#IceCard": common, "other#Thing": foreign,
    }, "myapp");
    expect(src.tables?.sort()).toEqual(["common_ice", "creds"]);
    expect(src.descriptors).toHaveLength(2);
    expect(src.shared).toBe(true);
  });
});

describe("suiteSourceFull (the suite-wide everything dump)", () => {
  it("exports EVERY suite table — other apps' included — with the full registry driving hashing", async () => {
    const otherSecret: SchemaDescriptor = {
      ...credsDescriptor, namespace: "otherapp", name: "Token", dbAlias: "other_tokens", owner: "otherapp",
      fields: [
        { name: "id", dataType: "id", keyField: true, required: true },
        { name: "service", dataType: "string" },
        { name: "value", dataType: "string", confidentiality: "Secret" },
      ],
    };
    const suite = memDb({
      creds: { columns: ["id", "site", "login_password"], rows: [{ id: "c1", site: "example.com", login_password: "hunter2" }] },
      other_tokens: { columns: ["id", "service", "value"], rows: [{ id: "t1", service: "mail", value: "tok-xyz" }] },
      [REGISTRY_TABLE]: { columns: ["qualified", "descriptor"], rows: [] },
    });
    const src = suiteSourceFull(suite.db, {
      "myapp#Credential": credsDescriptor,
      "otherapp#Token": otherSecret,
    });
    expect(src.shared).toBe(true);
    expect(src.tables).toBeUndefined(); // auto-discover: ALL tables, not an owner slice

    const { bytes, report } = await make([src]).exportWorkbook();
    expect(report.tables.map((t) => t.table).sort()).toEqual(["creds", "other_tokens"]); // registry excluded
    const wb = readWb(bytes);
    // another app's Secret field is STILL hashed because the full registry came along
    expect(String(sheetRows(wb, "other_tokens")[0]!.value)).toMatch(HASHED_VALUE_RE);
    expect(sheetRows(wb, "other_tokens")[0]!.service).toBe("mail");
  });
});
