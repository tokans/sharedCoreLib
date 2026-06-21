import { describe, it, expect } from "vitest";
import { createMergeEngine, createSyncEngineFactory, syncableTables, applyBundle, buildBundle, type SyncDb, type SyncBundle, type SyncTransport } from "./index.js";
import type { SchemaDescriptor, SchemaRegistry } from "../schema/index.js";
import { privateCompartment } from "../multiuser/index.js";

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

describe("compartment-aware sync (K0.4.4)", () => {
  const ins = (db: SyncDb, id: string, compartment: string | null) =>
    db.execute(
      `INSERT OR REPLACE INTO "myfinance_Account" ("id", "v", "updated_at", "device_id", "compartment") VALUES (?, ?, ?, ?, ?)`,
      [id, "v-" + id, "2026-06-10", "devA", compartment],
    );

  async function seeded() {
    const db = memDb();
    await ins(db, "untagged", null);
    await ins(db, "shared", "shared");
    await ins(db, "al", privateCompartment("alice"));
    await ins(db, "bo", privateCompartment("bob"));
    return db;
  }

  it("outgoing for a recipient: shared + untagged + their own private rows only", async () => {
    const db = await seeded();
    const engine = createMergeEngine({ db, registry, appId: "myfinance", localDeviceId: "devA" });
    const forAlice = await engine.outgoing("alice");
    expect(forAlice["myfinance#Account"]!.map((r) => r.id).sort()).toEqual(["al", "shared", "untagged"]);
    const forBob = await engine.outgoing("bob");
    expect(forBob["myfinance#Account"]!.map((r) => r.id).sort()).toEqual(["bo", "shared", "untagged"]);
    // a non-member recipient gets only shared/untagged rows
    const forCarol = await engine.outgoing("carol");
    expect(forCarol["myfinance#Account"]!.map((r) => r.id).sort()).toEqual(["shared", "untagged"]);
  });

  it("REGRESSION: no recipient ⇒ every row is emitted, exactly as before", async () => {
    const db = await seeded();
    const engine = createMergeEngine({ db, registry, appId: "myfinance", localDeviceId: "devA" });
    const all = await engine.outgoing();
    expect(all["myfinance#Account"]).toHaveLength(4);
    // and buildBundle without compartment options is identical
    const scope = syncableTables(registry, "myfinance");
    expect(await buildBundle(db, scope)).toEqual(all);
  });

  it("ingest with localUserId skips another member's private rows (receive-side guard)", async () => {
    const db = memDb();
    const engine = createMergeEngine({ db, registry, appId: "myfinance", localDeviceId: "devA", localUserId: "alice" });
    const remote: SyncBundle = {
      "myfinance#Account": [
        { id: "s1", v: "shared", updated_at: "2026-06-10", device_id: "devB", compartment: "shared" },
        { id: "u1", v: "untagged", updated_at: "2026-06-10", device_id: "devB" },
        { id: "a1", v: "alice-private", updated_at: "2026-06-10", device_id: "devB", compartment: "private:alice" },
        { id: "b1", v: "bob-private", updated_at: "2026-06-10", device_id: "devB", compartment: "private:bob" },
      ],
    };
    const res = await engine.ingest(remote);
    expect(db.dump("myfinance_Account").map((r) => r.id).sort()).toEqual(["a1", "s1", "u1"]);
    expect(res.applied).toBe(3);
    expect(res.skipped).toBe(1); // bob's private row never written
  });

  it("REGRESSION: ingest without localUserId applies every row, exactly as before", async () => {
    const db = memDb();
    const engine = createMergeEngine({ db, registry, appId: "myfinance", localDeviceId: "devA" });
    const remote: SyncBundle = {
      "myfinance#Account": [
        { id: "b1", v: "bob-private", updated_at: "2026-06-10", device_id: "devB", compartment: "private:bob" },
        { id: "u1", v: "untagged", updated_at: "2026-06-10", device_id: "devB" },
      ],
    };
    const res = await engine.ingest(remote);
    expect(res.applied).toBe(2);
    expect(db.dump("myfinance_Account")).toHaveLength(2);
  });
});

describe("createSyncEngineFactory (app coreMerge dedup)", () => {
  const factory = () =>
    createSyncEngineFactory({
      appId: "myfinance",
      openDb: async () => memDb(),
      loadRegistry: async () => registry, // injected to avoid a registry-table dependency
    });

  it("syncableTables is scoped to owned + common", () => {
    expect(factory().syncableTables(registry).map((s) => s.dbAlias)).toEqual(
      expect.arrayContaining(["myfinance_Account", "common_Person"]),
    );
  });

  it("createMergeEngine returns null when openDb yields null (browser/preview)", async () => {
    const f = createSyncEngineFactory({ appId: "myfinance", openDb: async () => null, loadRegistry: async () => registry });
    expect(await f.createMergeEngine("devA")).toBeNull();
    expect(await f.runScopedSync("devA", { exchange: async () => new Uint8Array() }, () => new Uint8Array(), () => ({}), {})).toBeNull();
  });

  it("syncOnce exchanges the encoded bundle and ingests the peer's", async () => {
    const f = factory();
    const engine = (await f.createMergeEngine("devA"))!;
    let sent: SyncBundle | null = null;
    const peer: SyncBundle = {
      "myfinance#Account": [{ id: "p1", v: "peer", updated_at: "2026-06-10", device_id: "devB" }],
    };
    const transport: SyncTransport = {
      exchange: async (bytes) => {
        sent = JSON.parse(new TextDecoder().decode(bytes)) as SyncBundle;
        return new TextEncoder().encode(JSON.stringify(peer));
      },
    };
    const res = await f.syncOnce(
      engine,
      transport,
      (b) => new TextEncoder().encode(JSON.stringify(b)),
      (b) => JSON.parse(new TextDecoder().decode(b)) as SyncBundle,
    );
    expect(sent).not.toBeNull();
    expect(res.applied).toBe(1);
  });

  it("runScopedSync builds the member-scoped engine and runs a round", async () => {
    const f = factory();
    const transport: SyncTransport = {
      exchange: async () => new TextEncoder().encode(JSON.stringify({})),
    };
    const res = await f.runScopedSync(
      "devA",
      transport,
      (b) => new TextEncoder().encode(JSON.stringify(b)),
      (b) => JSON.parse(new TextDecoder().decode(b)) as SyncBundle,
      { localUserId: "alice", recipientUserId: "bob" },
    );
    expect(res).toEqual({ applied: 0, skipped: 0 });
  });
});
