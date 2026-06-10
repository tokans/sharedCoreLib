import { describe, it, expect } from "vitest";
import { createMergeEngine, syncableTables, applyBundle, type SyncDb, type SyncBundle } from "./index.js";
import type { SchemaDescriptor, SchemaRegistry } from "../schema/index.js";

const table = (namespace: string, name: string, owner: string): SchemaDescriptor => ({
  namespace, name, owner, schemaType: "Table", confidentiality: "Internal",
  dbAlias: `${namespace}_${name}`,
  fields: [
    { name: "id", dataType: "id", keyField: true },
    { name: "v", dataType: "string" },
    { name: "updated_at", dataType: "date" },
    { name: "device_id", dataType: "string" },
  ],
});

const registry: SchemaRegistry = {
  "myfinance#Account": table("myfinance", "Account", "myfinance"),
  "myhealth#Vital": table("myhealth", "Vital", "myhealth"),
  "common#Person": table("common", "Person", "common"),
};

/** Minimal in-memory SqlDb (INSERT OR REPLACE + SELECT * [WHERE id = ?]). */
function memDb(): SyncDb & { dump(t: string): Record<string, unknown>[] } {
  const tables = new Map<string, Map<string, Record<string, unknown>>>();
  const tbl = (n: string) => { if (!tables.has(n)) tables.set(n, new Map()); return tables.get(n)!; };
  const nameOf = (sql: string) => sql.match(/(?:INTO|FROM)\s+"([^"]+)"/i)?.[1] ?? "";
  return {
    execute: async (sql, params = []) => {
      if (/^INSERT OR REPLACE/i.test(sql.trim())) {
        const cols = [...sql.matchAll(/"([^"]+)"/g)].slice(1).map((m) => m[1]!);
        const row: Record<string, unknown> = {};
        cols.forEach((c, i) => (row[c] = (params as unknown[])[i]));
        tbl(nameOf(sql)).set(String(row.id), row);
      }
      return {};
    },
    select: async (sql, params = []) => {
      const rows = [...tbl(nameOf(sql)).values()];
      const w = sql.match(/WHERE\s+"(\w+)"\s*=\s*\?/i);
      return (w ? rows.filter((r) => String(r[w[1]!]) === String((params as unknown[])[0])) : rows) as never;
    },
    dump: (t) => [...tbl(t).values()],
  };
}

describe("per-app sync scoping", () => {
  it("syncableTables returns only owned + common tables, never another app's", () => {
    const fin = syncableTables(registry, "myfinance").map((s) => s.dbAlias);
    expect(fin).toEqual(expect.arrayContaining(["myfinance_Account", "common_Person"]));
    expect(fin).not.toContain("myhealth_Vital"); // health's private table is out of scope
  });

  it("includeCommon=false drops common tables", () => {
    expect(syncableTables(registry, "myfinance", { includeCommon: false }).map((s) => s.dbAlias)).toEqual(["myfinance_Account"]);
  });

  it("ingest ignores out-of-scope tables a peer offers (receive-side scoping)", async () => {
    const db = memDb();
    const engine = createMergeEngine({ db, registry, appId: "myfinance", localDeviceId: "devA" });
    const remote: SyncBundle = {
      "myfinance#Account": [{ id: "a1", v: "mine", updated_at: "2026-06-10", device_id: "devB" }],
      "myhealth#Vital": [{ id: "h1", v: "not yours", updated_at: "2026-06-10", device_id: "devB" }],
    };
    const res = await engine.ingest(remote);
    expect(db.dump("myfinance_Account")).toHaveLength(1);
    expect(db.dump("myhealth_Vital")).toHaveLength(0); // never written — out of scope
    expect(res.applied).toBe(1);
    expect(res.skipped).toBe(1);
  });

  it("LWW: a strictly-newer remote row wins; an older one is skipped", async () => {
    const db = memDb();
    const scope = syncableTables(registry, "myfinance");
    await db.execute(`INSERT OR REPLACE INTO "myfinance_Account" ("id", "v", "updated_at", "device_id") VALUES (?, ?, ?, ?)`, ["a1", "local", "2026-06-10", "devA"]);
    // older remote → skipped
    await applyBundle(db, scope, { "myfinance#Account": [{ id: "a1", v: "old", updated_at: "2026-06-01", device_id: "devB" }] }, "devA");
    expect(db.dump("myfinance_Account")[0]!.v).toBe("local");
    // newer remote → wins
    await applyBundle(db, scope, { "myfinance#Account": [{ id: "a1", v: "new", updated_at: "2026-06-20", device_id: "devB" }] }, "devA");
    expect(db.dump("myfinance_Account")[0]!.v).toBe("new");
  });
});
