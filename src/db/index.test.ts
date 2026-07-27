import { describe, it, expect } from "vitest";
import type { SchemaDescriptor } from "../schema/index.js";
import {
  createTableSql, addColumnSql, migrationFor, sqliteType, tableName,
  registerSchemas, loadRegistry, REGISTRY_TABLE,
  visibleColumns, schemaVisibleAt, canAppWrite, createSharedDb,
  type SqlDb,
} from "./index.js";

const account = (over: Partial<SchemaDescriptor> = {}): SchemaDescriptor => ({
  namespace: "myfinance", name: "Account", schemaType: "Table",
  confidentiality: "Internal", owner: "myfinance",
  fields: [
    { name: "id", dataType: "id", keyField: true },
    { name: "name", dataType: "string", required: true, index: "Unique" },
    { name: "balance", dataType: "number" },
  ],
  ...over,
});

/** In-memory fake SqlDb: records calls; returns seeded rows for registry/data selects. */
function fakeDb({ registryRows = [] as { qualified: string; descriptor: string }[], dataRows = [] as unknown[] } = {}) {
  const calls = { execute: [] as { sql: string; params?: unknown[] }[], select: [] as { sql: string; params?: unknown[] }[] };
  const db: SqlDb = {
    select: async (sql, params) => {
      calls.select.push({ sql, params });
      return (sql.includes(REGISTRY_TABLE) ? registryRows : dataRows) as never;
    },
    execute: async (sql, params) => { calls.execute.push({ sql, params }); return {}; },
  };
  return { db, calls };
}

describe("DDL generation", () => {
  it("createTableSql: columns, PK, unique index, types", () => {
    const [create, idx] = createTableSql(account());
    expect(create).toMatch(/CREATE TABLE IF NOT EXISTS "myfinance_Account"/);
    expect(create).toMatch(/"name" TEXT NOT NULL/);
    expect(create).toMatch(/"balance" REAL/);
    expect(create).toMatch(/PRIMARY KEY \("id"\)/);
    expect(idx).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS "ix_myfinance_Account_name"/);
  });
  it("sqliteType maps affinities", () => {
    expect(sqliteType("number")).toBe("REAL");
    expect(sqliteType("boolean")).toBe("INTEGER");
    expect(sqliteType("string")).toBe("TEXT");
  });
  it("a sole numeric keyField is emitted as INTEGER so SQLite aliases it to ROWID", () => {
    // App-side auto-incrementing integer ids (the convention every myHealth table uses,
    // e.g. `idField()` in appTables.ts) declare `{ dataType: "number", keyField: true }`.
    // SQLite only auto-populates a PRIMARY KEY column on INSERT when its declared type is
    // the literal "INTEGER" (REAL — the normal sqliteType("number") mapping — does NOT
    // alias ROWID, so the column would silently stay NULL forever on every insert).
    const intIdSchema = account({
      fields: [
        { name: "id", dataType: "number", keyField: true },
        { name: "name", dataType: "string" },
        { name: "balance", dataType: "number" },
      ],
    });
    const [create] = createTableSql(intIdSchema);
    expect(create).toMatch(/"id" INTEGER/);
    expect(create).not.toMatch(/"id" REAL/);
    // A genuinely fractional numeric field that is NOT the key keeps REAL affinity.
    expect(create).toMatch(/"balance" REAL/);
  });
  it("migrationFor: additive → ALTER ADD COLUMN; conflict → throws", () => {
    const next = account({ fields: [...account().fields, { name: "currency", dataType: "string" }] });
    const stmts = migrationFor(account(), next);
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toMatch(/ALTER TABLE "myfinance_Account" ADD COLUMN "currency" TEXT/);
    const conflicting = account({ fields: [{ name: "id", dataType: "number", keyField: true }] });
    expect(() => migrationFor(account(), conflicting)).toThrow();
  });
  it("migrationFor: a field missing from the registry but already a live column is skipped, not re-ALTERed", () => {
    // Regression: the registry's stored descriptor can drift from the table's actual
    // columns (a raw aux-SQL step added it out-of-band, or a field was renamed away and
    // back to the same name across two registry-writing boots). Diffing against the
    // registry alone would re-issue ADD COLUMN for "currency" here even though it already
    // physically exists, throwing "duplicate column name" at execute time.
    const next = account({ fields: [...account().fields, { name: "currency", dataType: "string" }] });
    const stmts = migrationFor(account(), next, new Set(["currency"]));
    expect(stmts).toHaveLength(0);
  });
});

describe("registerSchemas", () => {
  it("new schema → CREATE TABLE + persists descriptor", async () => {
    const { db, calls } = fakeDb();
    const res = await registerSchemas(db, [account()]);
    expect(res.registry["myfinance#Account"]).toBeTruthy();
    expect(calls.execute.some((c) => /CREATE TABLE IF NOT EXISTS "myfinance_Account"/.test(c.sql))).toBe(true);
    expect(calls.execute.some((c) => c.sql.includes(REGISTRY_TABLE) && /INSERT/.test(c.sql))).toBe(true);
  });

  it("a field new to the registry but already a live column doesn't throw 'duplicate column name'", async () => {
    // End-to-end version of the migrationFor regression above: registerSchemas queries
    // PRAGMA table_info for an already-registered table and must not re-emit ADD COLUMN
    // for something PRAGMA says already exists, even though the registry's stored
    // descriptor doesn't mention it yet.
    const existing = account(); // registry doesn't know about "currency"
    const next = account({ fields: [...account().fields, { name: "currency", dataType: "string" }] });
    const { db, calls } = fakeDb({
      registryRows: [{ qualified: "myfinance#Account", descriptor: JSON.stringify(existing) }],
      dataRows: [{ name: "id" }, { name: "name" }, { name: "balance" }, { name: "currency" }], // PRAGMA table_info result
    });
    await expect(registerSchemas(db, [next])).resolves.toBeTruthy();
    expect(calls.execute.some((c) => /ADD COLUMN "currency"/.test(c.sql))).toBe(false);
  });

  it("re-registering an unchanged schema re-asserts its field-level indexes (not just new columns)", async () => {
    // Regression: migrationFor only diffs columns, so a unique index that existed in the
    // descriptor from the start was never re-asserted on a later, no-column-change
    // registerSchemas call — meaning an index dropped out-of-band (e.g. by an app's own
    // table-recreating repair migration) had no path back. CREATE INDEX IF NOT EXISTS is
    // a no-op when nothing changed, so doing this unconditionally is free.
    const existing = account({
      fields: [...account().fields, { name: "iban", dataType: "string", index: "Unique" }],
    });
    const { db, calls } = fakeDb({ registryRows: [{ qualified: "myfinance#Account", descriptor: JSON.stringify(existing) }] });
    await registerSchemas(db, [existing]); // identical descriptor — no column migration needed
    expect(calls.execute.some((c) => /CREATE UNIQUE INDEX IF NOT EXISTS "ix_myfinance_Account_iban"/.test(c.sql))).toBe(true);
  });

  it("conflicting re-register → throws (runtime backstop)", async () => {
    const existing = account();
    const { db } = fakeDb({ registryRows: [{ qualified: "myfinance#Account", descriptor: JSON.stringify(existing) }] });
    const conflicting = account({ fields: [{ name: "id", dataType: "number", keyField: true }, { name: "name", dataType: "string" }] });
    await expect(registerSchemas(db, [conflicting])).rejects.toThrow(/conflicts/);
  });

  it("a descriptor with `adopts` creates no table and is reported adopted", async () => {
    const existing = account();
    const { db, calls } = fakeDb({ registryRows: [{ qualified: "myfinance#Account", descriptor: JSON.stringify(existing) }] });
    const adopting: SchemaDescriptor = {
      ...account(), namespace: "myhealth", name: "Money", owner: "myhealth", adopts: "myfinance#Account",
    };
    const res = await registerSchemas(db, [adopting]);
    expect(res.adopted).toEqual(["myhealth#Money"]);
    expect(res.registry["myhealth#Money"]).toBeUndefined(); // not registered — it USES myfinance#Account
    expect(calls.execute.some((c) => /CREATE TABLE/.test(c.sql) && /myhealth_Money/.test(c.sql))).toBe(false);

    const dangling = { ...adopting, adopts: "nope#Missing" };
    await expect(registerSchemas(db, [dangling])).rejects.toThrow(/adopts unknown table/);
  });

  it("duplicates: 'block' makes an un-adopted duplicate candidate a registration error", async () => {
    const existing = account();
    const { db } = fakeDb({ registryRows: [{ qualified: "myfinance#Account", descriptor: JSON.stringify(existing) }] });
    const dup = account({ namespace: "myhealth", owner: "myhealth" }); // same Name + shape, other owner
    await expect(registerSchemas(db, [dup], { duplicates: "block" })).rejects.toThrow(/duplicate-candidate/);
    await expect(registerSchemas(db, [dup])).resolves.toBeTruthy(); // default stays warn (advisory)
  });

  it("loadRegistry parses persisted descriptors", async () => {
    const { db } = fakeDb({ registryRows: [{ qualified: "myfinance#Account", descriptor: JSON.stringify(account()) }] });
    const reg = await loadRegistry(db);
    expect(reg["myfinance#Account"]!.name).toBe("Account");
  });
});

describe("access governance", () => {
  const s = account({
    confidentiality: "Internal",
    fields: [
      { name: "id", dataType: "id", keyField: true },
      { name: "name", dataType: "string" },
      { name: "pan", dataType: "string", confidentiality: "Restricted", personalData: true, purpose: "KYC" },
    ],
  });

  it("visibleColumns withholds fields above the caller's level", () => {
    expect(visibleColumns(s, "Internal")).toEqual(["id", "name"]); // pan (Restricted) hidden
    expect(visibleColumns(s, "Restricted")).toEqual(["id", "name", "pan"]);
  });
  it("schemaVisibleAt + canAppWrite", () => {
    expect(schemaVisibleAt("Public", account({ confidentiality: "Confidential" }))).toBe(false);
    expect(schemaVisibleAt("Secret", account({ confidentiality: "Confidential" }))).toBe(true);
    expect(canAppWrite(account(), "myfinance")).toBe(true);
    expect(canAppWrite(account(), "myhealth")).toBe(false);
  });
});

describe("createSharedDb (governed handle)", () => {
  const registry = { "myfinance#Account": account({
    fields: [
      { name: "id", dataType: "id", keyField: true },
      { name: "name", dataType: "string" },
      { name: "pan", dataType: "string", confidentiality: "Secret" },
    ],
  }) };

  it("read returns only visible columns; forbidden table throws", async () => {
    const { db, calls } = fakeDb({ dataRows: [{ id: "1", name: "Acct" }] });
    const handle = createSharedDb({ db, appId: "myhealth", grantedLevel: "Internal", registry });
    const rows = await handle.read("myfinance#Account");
    expect(rows).toEqual([{ id: "1", name: "Acct" }]);
    const sql = calls.select.at(-1)!.sql;
    expect(sql).toMatch(/SELECT "id", "name" FROM "myfinance_Account"/);
    expect(sql).not.toMatch(/pan/); // Secret column withheld from an Internal caller

    const secret = { "x#S": account({ namespace: "x", name: "S", confidentiality: "Secret" }) };
    const low = createSharedDb({ db, appId: "myhealth", grantedLevel: "Internal", registry: secret });
    await expect(low.read("x#S")).rejects.toThrow(/forbidden/);
  });

  it("write allowed only for the owner", async () => {
    const { db, calls } = fakeDb();
    const owner = createSharedDb({ db, appId: "myfinance", grantedLevel: "Internal", registry });
    await owner.write("myfinance#Account", { id: "1", name: "Acct" });
    expect(calls.execute.some((c) => /INSERT OR REPLACE INTO "myfinance_Account"/.test(c.sql))).toBe(true);

    const notOwner = createSharedDb({ db, appId: "myhealth", grantedLevel: "Internal", registry });
    await expect(notOwner.write("myfinance#Account", { id: "2" })).rejects.toThrow(/may not write/);
  });
});

// The fakeDb above never executes SQL, so it can't catch genuine SQLite-semantics bugs
// (a string-matching DDL test missed exactly this: a sole numeric PK declared REAL is
// syntactically fine but never auto-populates on INSERT). Run the same DDL against a REAL
// SQLite engine where available (Node 22.5+'s builtin `node:sqlite`); skip gracefully on
// older Node (e.g. CI pinned to Node 20) rather than failing the suite.
let DatabaseSyncCtor: (new (location: string) => InstanceType<typeof import("node:sqlite").DatabaseSync>) | null = null;
try {
  ({ DatabaseSync: DatabaseSyncCtor } = await import("node:sqlite"));
} catch {
  /* node:sqlite unavailable on this Node — the suite below is skipped */
}

describe.skipIf(!DatabaseSyncCtor)("createTableSql against a real SQLite engine", () => {
  it("an app-side auto-increment integer id round-trips through INSERT", async () => {
    const Ctor = DatabaseSyncCtor!;
    const db = new Ctor(":memory:");
    const sql: SqlDb = {
      select: async (s, params = []) => db.prepare(s).all(...(params as never[])) as never,
      execute: async (s, params = []) => {
        const info = db.prepare(s).run(...(params as never[]));
        return { rowsAffected: Number(info.changes), lastInsertId: Number(info.lastInsertRowid) };
      },
    };
    const schema = account({
      fields: [
        { name: "id", dataType: "number", keyField: true },
        { name: "name", dataType: "string", required: true },
      ],
    });
    for (const stmt of createTableSql(schema)) await sql.execute(stmt);

    const res = await sql.execute(`INSERT INTO "myfinance_Account" (name) VALUES (?)`, ["Alice"]);
    expect(res.lastInsertId).toBe(1);
    const rows = await sql.select<{ id: number; name: string }>(`SELECT * FROM "myfinance_Account"`);
    // Before the fix this was `id: null` — the column never aliased ROWID, so the
    // returned lastInsertId pointed at a row that "WHERE id = ?" could never find.
    expect(rows).toEqual([{ id: 1, name: "Alice" }]);

    const res2 = await sql.execute(`UPDATE "myfinance_Account" SET name = ? WHERE id = ?`, ["Alice B", res.lastInsertId]);
    expect(res2.rowsAffected).toBe(1);
  });

  it("registerSchemas heals a field-level index dropped out-of-band, end to end", async () => {
    const Ctor = DatabaseSyncCtor!;
    const db = new Ctor(":memory:");
    const sql: SqlDb = {
      select: async (s, params = []) => db.prepare(s).all(...(params as never[])) as never,
      execute: async (s, params = []) => {
        const info = db.prepare(s).run(...(params as never[]));
        return { rowsAffected: Number(info.changes), lastInsertId: Number(info.lastInsertRowid) };
      },
    };
    const schema = account({ fields: [...account().fields, { name: "iban", dataType: "string", index: "Unique" }] });
    await registerSchemas(sql, [schema]);

    db.exec(`DROP INDEX "ix_myfinance_Account_iban"`); // simulate an out-of-band drop
    db.prepare(`INSERT INTO "myfinance_Account" (id, name, iban) VALUES (1, 'a', 'X')`).run();

    const res = await registerSchemas(sql, [schema]); // same descriptor, no column change — should still heal the index
    expect(res.indexWarnings).toEqual([]);
    const idx = db.prepare(`SELECT name FROM sqlite_master WHERE name='ix_myfinance_Account_iban'`).all();
    expect(idx).toHaveLength(1);
    // The index is back — a NEW conflicting insert is rejected again.
    expect(() => db.prepare(`INSERT INTO "myfinance_Account" (id, name, iban) VALUES (2, 'b', 'X')`).run()).toThrow(
      /UNIQUE constraint failed/,
    );
  });

  it("a pre-existing duplicate blocking the index heal is reported, not thrown — other tables still register", async () => {
    const Ctor = DatabaseSyncCtor!;
    const db = new Ctor(":memory:");
    const sql: SqlDb = {
      select: async (s, params = []) => db.prepare(s).all(...(params as never[])) as never,
      execute: async (s, params = []) => {
        const info = db.prepare(s).run(...(params as never[]));
        return { rowsAffected: Number(info.changes), lastInsertId: Number(info.lastInsertRowid) };
      },
    };
    const schema = account({ fields: [...account().fields, { name: "iban", dataType: "string", index: "Unique" }] });
    const other = account({ namespace: "myhealth", name: "Vital", owner: "myhealth" });
    await registerSchemas(sql, [schema, other]);

    db.exec(`DROP INDEX "ix_myfinance_Account_iban"`);
    db.prepare(`INSERT INTO "myfinance_Account" (id, name, iban) VALUES (1, 'a', 'X')`).run();
    db.prepare(`INSERT INTO "myfinance_Account" (id, name, iban) VALUES (2, 'b', 'X')`).run(); // duplicate — index can't come back yet

    const res = await registerSchemas(sql, [schema, other]); // must not throw
    expect(res.indexWarnings).toHaveLength(1);
    expect(res.indexWarnings[0]!.error).toMatch(/UNIQUE constraint failed/);
    const idx = db.prepare(`SELECT name FROM sqlite_master WHERE name='ix_myfinance_Account_iban'`).all();
    expect(idx).toHaveLength(0); // still missing — caller must dedupe first
    // `other`'s own (unaffected) registration still completed normally.
    expect(res.registry["myhealth#Vital"]).toBeTruthy();
  });
});
