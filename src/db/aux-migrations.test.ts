import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { SchemaDescriptor } from "../schema/index.js";
import {
  registerSchemas, registerAuxMigrations, referencedTables,
  AUX_MIGRATIONS_TABLE, type SqlDb,
} from "./index.js";

/** Real SQLite SqlDb adapter (node:sqlite, in-memory) — true end-to-end. */
function realDb(): { db: SqlDb; raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  const db: SqlDb = {
    select: async (sql, params = []) =>
      raw.prepare(sql).all(...(params as never[])) as never,
    execute: async (sql, params = []) => {
      // Statements like CREATE TRIGGER can't always be prepared+run with params bound.
      if (!params || (params as unknown[]).length === 0) { raw.exec(sql); return {}; }
      const r = raw.prepare(sql).run(...(params as never[]));
      return { rowsAffected: Number(r.changes), lastInsertId: Number(r.lastInsertRowid) };
    },
  };
  return { db, raw };
}

const account = (over: Partial<SchemaDescriptor> = {}): SchemaDescriptor => ({
  namespace: "myfinance", name: "Account", schemaType: "Table",
  confidentiality: "Internal", owner: "myfinance",
  fields: [
    { name: "id", dataType: "id", keyField: true },
    { name: "name", dataType: "string", required: true },
    { name: "audit", dataType: "string" },
  ],
  ...over,
});

const vital = (): SchemaDescriptor => ({
  namespace: "myhealth", name: "Vital", schemaType: "Table",
  confidentiality: "Internal", owner: "myhealth",
  fields: [{ name: "id", dataType: "id", keyField: true }, { name: "value", dataType: "number" }],
});

const commonPerson = (): SchemaDescriptor => ({
  namespace: "common", name: "Person", schemaType: "Table",
  confidentiality: "Confidential", owner: "common", shared: true,
  fields: [{ name: "id", dataType: "id", keyField: true }, { name: "fullName", dataType: "string" }],
});

const TRIGGER_STEP = {
  version: 1,
  sql: [
    `CREATE TRIGGER IF NOT EXISTS trg_account_audit AFTER INSERT ON "myfinance_Account" ` +
      `BEGIN UPDATE "myfinance_Account" SET "audit" = 'inserted:' || NEW."name" WHERE "id" = NEW."id"; END`,
  ],
};

describe("referencedTables (SQL table extraction)", () => {
  it("extracts trigger target + body targets, index targets, DML targets", () => {
    const trig =
      `CREATE TRIGGER t AFTER UPDATE OF name ON acc BEGIN ` +
      `INSERT INTO log_t (x) SELECT name FROM acc JOIN other o ON o.id = acc.id; ` +
      `DELETE FROM stale; UPDATE counts SET n = n + 1; END`;
    expect(referencedTables(trig).sort()).toEqual(["acc", "counts", "log_t", "other", "stale"]);
    expect(referencedTables(`CREATE UNIQUE INDEX IF NOT EXISTS ix ON "tbl" (col)`)).toEqual(["tbl"]);
    expect(referencedTables(`ALTER TABLE a ADD COLUMN x; CREATE TABLE b (i); DROP TABLE IF EXISTS c`).sort())
      .toEqual(["a", "b", "c"]);
  });
  it("ignores comments, string literals, and CTE names; unquotes identifiers", () => {
    expect(referencedTables(`SELECT 1 FROM "real_t" -- FROM commented_t\n WHERE x = 'FROM literal_t'`))
      .toEqual(["real_t"]);
    expect(referencedTables(`WITH cte AS (SELECT * FROM base) SELECT * FROM cte`)).toEqual(["base"]);
    expect(referencedTables("INSERT INTO `tick_t` VALUES (1)")).toEqual(["tick_t"]);
  });
});

describe("registerAuxMigrations", () => {
  it("applies a trigger end-to-end: trigger actually fires on real SQLite", async () => {
    const { db, raw } = realDb();
    await registerSchemas(db, [account()]);
    const res = await registerAuxMigrations(db, "myfinance", [TRIGGER_STEP]);
    expect(res).toEqual({ applied: [1], skipped: [] });

    raw.exec(`INSERT INTO "myfinance_Account" ("id", "name") VALUES ('a1', 'Salary')`);
    const rows = raw.prepare(`SELECT "audit" FROM "myfinance_Account" WHERE "id" = 'a1'`).all() as { audit: string }[];
    expect(rows[0]!.audit).toBe("inserted:Salary"); // the trigger fired

    const hist = raw.prepare(`SELECT app_id, version FROM "${AUX_MIGRATIONS_TABLE}"`).all();
    expect(hist).toEqual([{ app_id: "myfinance", version: 1 }]);
  });

  it("is idempotent: re-running the same steps is a no-op", async () => {
    const { db, raw } = realDb();
    await registerSchemas(db, [account()]);
    await registerAuxMigrations(db, "myfinance", [TRIGGER_STEP]);
    const again = await registerAuxMigrations(db, "myfinance", [TRIGGER_STEP]);
    expect(again).toEqual({ applied: [], skipped: [1] });
    const hist = raw.prepare(`SELECT COUNT(*) AS n FROM "${AUX_MIGRATIONS_TABLE}"`).all() as { n: number }[];
    expect(hist[0]!.n).toBe(1);
  });

  it("applies ascending; rejects out-of-order and duplicate versions in a batch", async () => {
    const { db } = realDb();
    await registerSchemas(db, [account()]);
    const v = (version: number) => ({
      version,
      sql: [`CREATE INDEX IF NOT EXISTS ix_v${version} ON "myfinance_Account" ("name")`],
    });
    await expect(registerAuxMigrations(db, "myfinance", [v(2), v(1)])).rejects.toThrow(/strictly ascending/);
    await expect(registerAuxMigrations(db, "myfinance", [v(1), v(1)])).rejects.toThrow(/strictly ascending/);
    await expect(registerAuxMigrations(db, "myfinance", [v(0)])).rejects.toThrow(/positive integer/);
    const ok = await registerAuxMigrations(db, "myfinance", [v(1), v(2)]);
    expect(ok.applied).toEqual([1, 2]);
  });

  it("rejects a NEW version below the applied high-water mark (append-only)", async () => {
    const { db } = realDb();
    await registerSchemas(db, [account()]);
    const v = (version: number) => ({
      version,
      sql: [`CREATE INDEX IF NOT EXISTS ix_v${version} ON "myfinance_Account" ("name")`],
    });
    await registerAuxMigrations(db, "myfinance", [v(5)]);
    await expect(registerAuxMigrations(db, "myfinance", [v(3)])).rejects.toThrow(/high-water/);
    // but re-running the already-applied version is a skip, not an error
    await expect(registerAuxMigrations(db, "myfinance", [v(5)])).resolves.toEqual({ applied: [], skipped: [5] });
  });

  it("rejects SQL touching another app's table — in headers AND trigger bodies", async () => {
    const { db, raw } = realDb();
    await registerSchemas(db, [account(), vital()]);

    // trigger ON a foreign table
    await expect(registerAuxMigrations(db, "myfinance", [{
      version: 1,
      sql: [`CREATE TRIGGER t1 AFTER INSERT ON "myhealth_Vital" BEGIN SELECT 1; END`],
    }])).rejects.toThrow(/owned by "myhealth", not "myfinance"/);

    // own trigger target, but the body writes a foreign table
    await expect(registerAuxMigrations(db, "myfinance", [{
      version: 1,
      sql: [
        `CREATE TRIGGER t2 AFTER INSERT ON "myfinance_Account" ` +
          `BEGIN INSERT INTO "myhealth_Vital" ("id", "value") VALUES (NEW."id", 0); END`,
      ],
    }])).rejects.toThrow(/owned by "myhealth", not "myfinance"/);

    // index on a foreign table
    await expect(registerAuxMigrations(db, "myfinance", [{
      version: 1,
      sql: [`CREATE INDEX ix_foreign ON "myhealth_Vital" ("value")`],
    }])).rejects.toThrow(/owned by "myhealth"/);

    // nothing executed, nothing recorded
    const hist = raw.prepare(`SELECT COUNT(*) AS n FROM "${AUX_MIGRATIONS_TABLE}"`).all() as { n: number }[];
    expect(hist[0]!.n).toBe(0);
  });

  it("common-owned tables need a core-owned step (appId 'common'); apps are blocked", async () => {
    const { db } = realDb();
    await registerSchemas(db, [commonPerson()]);
    const step = {
      version: 1,
      sql: [`CREATE INDEX IF NOT EXISTS ix_person_name ON "common_Person" ("fullName")`],
    };
    await expect(registerAuxMigrations(db, "myfinance", [step])).rejects.toThrow(/owned by "common", not "myfinance"/);
    await expect(registerAuxMigrations(db, "common", [step])).resolves.toEqual({ applied: [1], skipped: [] });
  });

  it("rejects unregistered and core-internal tables outright", async () => {
    const { db } = realDb();
    await registerSchemas(db, [account()]);
    await expect(registerAuxMigrations(db, "myfinance", [{
      version: 1, sql: [`CREATE TABLE rogue (id TEXT)`],
    }])).rejects.toThrow(/not a registered table/);
    await expect(registerAuxMigrations(db, "myfinance", [{
      version: 1, sql: [`DELETE FROM "__schema_registry__"`],
    }])).rejects.toThrow(/core-internal/);
    await expect(registerAuxMigrations(db, "myfinance", [{
      version: 1, sql: [`UPDATE sqlite_master SET sql = 'x'`],
    }])).rejects.toThrow(/core-internal/);
  });

  it("guards every statement of every pending step before executing any (atomic gate)", async () => {
    const { db, raw } = realDb();
    await registerSchemas(db, [account(), vital()]);
    await expect(registerAuxMigrations(db, "myfinance", [
      { version: 1, sql: [`CREATE INDEX ix_ok ON "myfinance_Account" ("name")`] },
      { version: 2, sql: [`CREATE INDEX ix_bad ON "myhealth_Vital" ("value")`] },
    ])).rejects.toThrow(/owned by "myhealth"/);
    // step 1 must NOT have been applied even though it was valid
    const ix = raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'ix_ok'`).all();
    expect(ix).toEqual([]);
  });
});
