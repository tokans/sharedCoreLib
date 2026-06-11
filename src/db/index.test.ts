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
  it("migrationFor: additive → ALTER ADD COLUMN; conflict → throws", () => {
    const next = account({ fields: [...account().fields, { name: "currency", dataType: "string" }] });
    const stmts = migrationFor(account(), next);
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toMatch(/ALTER TABLE "myfinance_Account" ADD COLUMN "currency" TEXT/);
    const conflicting = account({ fields: [{ name: "id", dataType: "number", keyField: true }] });
    expect(() => migrationFor(account(), conflicting)).toThrow();
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
