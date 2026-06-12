import { describe, it, expect } from "vitest";
import { migrationFor, type SqlDb } from "../db/index.js";
import {
  createEntitiesStore, personKeyFor, ENTITY_SCHEMAS,
  PERSON_SCHEMA, PERSON_RELATIONSHIP_SCHEMA, EVENT_SCHEMA, DOCUMENT_SCHEMA, ASSET_SCHEMA,
  MEMBER_CLASSES, isMemberClass, memberClassOf,
} from "./index.js";
import { validateDescriptor, checkAgainstRegistry, compareSchema, type SchemaRegistry } from "../schema/index.js";

/**
 * Tiny in-memory SqlDb that interprets the narrow SQL the entities store emits:
 * CREATE TABLE (noop), INSERT OR REPLACE, SELECT * [WHERE col = ?] [ORDER BY col], DELETE.
 * Rows are keyed by the table's first inserted column (the PK), matching INSERT OR REPLACE.
 */
function memDb(): SqlDb {
  const tables = new Map<string, Map<string, Record<string, unknown>>>();
  const tbl = (name: string) => {
    if (!tables.has(name)) tables.set(name, new Map());
    return tables.get(name)!;
  };
  const tableOf = (sql: string) => sql.match(/(?:INTO|FROM)\s+"([^"]+)"/i)?.[1] ?? "";
  return {
    execute: async (sql, params = []) => {
      if (/^CREATE TABLE/i.test(sql.trim())) return {};
      if (/^INSERT OR REPLACE/i.test(sql.trim())) {
        const cols = [...sql.matchAll(/"([^"]+)"/g)].slice(1).map((m) => m[1]!); // skip table name
        const row: Record<string, unknown> = {};
        cols.forEach((c, i) => (row[c] = params[i]));
        tbl(tableOf(sql)).set(String(row[cols[0]!]), row);
        return { rowsAffected: 1 };
      }
      if (/^DELETE/i.test(sql.trim())) {
        const t = tbl(tableOf(sql));
        const key = String((params as unknown[])[0]);
        for (const [k, v] of t) {
          const col = sql.match(/WHERE\s+(\w+)\s*=/i)?.[1];
          if (col && String(v[col]) === key) t.delete(k);
        }
        return { rowsAffected: 1 };
      }
      return {};
    },
    select: async (sql, params = []) => {
      const rows = [...tbl(tableOf(sql)).values()];
      const where = sql.match(/WHERE\s+(\w+)\s*=\s*\?/i);
      let out = rows;
      if (where) out = rows.filter((r) => String(r[where[1]!]) === String((params as unknown[])[0]));
      const order = sql.match(/ORDER BY\s+(\w+)/i);
      if (order) out = [...out].sort((a, b) => String(a[order[1]!]).localeCompare(String(b[order[1]!])));
      return out as never;
    },
  };
}

describe("entity schemas", () => {
  it("all five validate and are owner=common shared tables", () => {
    for (const s of ENTITY_SCHEMAS) {
      const r = validateDescriptor(s);
      expect(r.ok, `${s.name}: ${JSON.stringify(r.issues)}`).toBe(true);
      expect(s.owner).toBe("common");
      expect(s.shared).toBe(true);
    }
  });

  it("registry sees them as new (no conflicts) and they don't dup-collide with each other", () => {
    const res = checkAgainstRegistry(ENTITY_SCHEMAS, {} as SchemaRegistry);
    expect(res.hasConflicts).toBe(false);
    expect(res.entries.every((e) => e.status === "new")).toBe(true);
  });

  it("person is identity-only (no domain/value fields)", () => {
    const names = PERSON_SCHEMA.fields.map((f) => f.name);
    expect(names).toContain("person_key");
    expect(names).toContain("display_name");
    expect(names).not.toContain("value");
    expect(names).not.toContain("balance");
  });

  it("person_relationship is the dormant objective-edge table", () => {
    const names = PERSON_RELATIONSHIP_SCHEMA.fields.map((f) => f.name);
    expect(names).toEqual(expect.arrayContaining(["from_person", "to_person", "type"]));
  });
});

describe("createEntitiesStore", () => {
  it("CRUD round-trip on person, stamping source_app", async () => {
    const store = createEntitiesStore(memDb(), { appId: "myfinance" });
    await store.ensure();
    await store.upsertPerson({ person_key: "self", display_name: "Anshuman" });
    const self = await store.getPerson("self");
    expect(self!.display_name).toBe("Anshuman");
    expect(self!.source_app).toBe("myfinance");
    expect(await store.listPeople()).toHaveLength(1);
    await store.removePerson("self");
    expect(await store.getPerson("self")).toBeNull();
  });

  it("pickOrCreatePerson is explicit-reference: returns existing, never merges", async () => {
    const store = createEntitiesStore(memDb(), { appId: "myhealth" });
    await store.ensure();
    const a = await store.pickOrCreatePerson("self", { display_name: "Anshuman" });
    expect(a.display_name).toBe("Anshuman");
    // second call with a different seed must NOT overwrite/merge — returns the existing row
    const b = await store.pickOrCreatePerson("self", { display_name: "SOMEONE ELSE" });
    expect(b.display_name).toBe("Anshuman");
    expect(await store.listPeople()).toHaveLength(1);
  });

  it("suggestDuplicates flags same-name / same-dob but never auto-merges", async () => {
    const store = createEntitiesStore(memDb(), { appId: "myfinance" });
    await store.ensure();
    await store.upsertPerson({ person_key: "self", display_name: "Jane Doe", dob: "1990-01-01" });
    await store.upsertPerson({ person_key: "jane-doe", display_name: "Jane  Doe", dob: "1990-01-01" });
    const sugg = await store.suggestDuplicates({ display_name: "Jane Doe", dob: "1990-01-01", person_key: "self" });
    expect(sugg).toHaveLength(1);
    expect(sugg[0]!.candidate.person_key).toBe("jane-doe");
    expect(sugg[0]!.reasons).toEqual(expect.arrayContaining(["same-name", "same-dob"]));
    // both rows still exist — suggestion only
    expect(await store.listPeople()).toHaveLength(2);
  });

  it("asset aggregation sums an owner's values", async () => {
    const store = createEntitiesStore(memDb(), { appId: "myfinance" });
    await store.ensure();
    await store.upsertAsset({ id: "a1", type: "account", label: "Savings", value: 1000, owner: "self" });
    await store.upsertAsset({ id: "a2", type: "property", label: "Flat", value: 5000000, owner: "self" });
    await store.upsertAsset({ id: "a3", type: "vehicle", label: "Car", value: 800000, owner: "spouse" });
    const { assets, total } = await store.assetsForOwner("self");
    expect(assets).toHaveLength(2);
    expect(total).toBe(5001000);
  });

  it("events link to a person and read back in date order", async () => {
    const store = createEntitiesStore(memDb(), { appId: "mymemories" });
    await store.ensure();
    await store.upsertEvent({ id: "e2", date: "2026-06-10", title: "Anniversary", person_key: "self" });
    await store.upsertEvent({ id: "e1", date: "2020-01-01", title: "Wedding", person_key: "self" });
    const evs = await store.listEvents({ personKey: "self" });
    expect(evs.map((e) => e.id)).toEqual(["e1", "e2"]);
  });
});

describe("member-class vocabulary (K0.4)", () => {
  it("member_class is an ADDITIVE, nullable column — a pre-K0.4 registry merges cleanly", () => {
    // The person schema as registered before K0.4 (no member_class).
    const preK04 = { ...PERSON_SCHEMA, fields: PERSON_SCHEMA.fields.filter((f) => f.name !== "member_class") };
    const cmp = compareSchema(preK04, PERSON_SCHEMA);
    expect(cmp.status).toBe("mergeable"); // additive, never a conflict
    expect(cmp.additions.fields).toEqual(["member_class"]);
    // The migration is a single nullable ALTER ADD — existing rows are untouched.
    const stmts = migrationFor(preK04, PERSON_SCHEMA);
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toMatch(/^ALTER TABLE "common_person" ADD COLUMN "member_class" TEXT$/);
    expect(stmts[0]).not.toMatch(/NOT NULL/);
  });

  it("the descriptor field is optional (not required/key) and enumerates the vocabulary", () => {
    const f = PERSON_SCHEMA.fields.find((x) => x.name === "member_class")!;
    expect(f.required).toBeFalsy();
    expect(f.keyField).toBeFalsy();
    expect(f.constraints?.enumValues).toEqual([...MEMBER_CLASSES]);
    expect(validateDescriptor(PERSON_SCHEMA).ok).toBe(true);
  });

  it("isMemberClass accepts exactly the vocabulary", () => {
    for (const c of MEMBER_CLASSES) expect(isMemberClass(c)).toBe(true);
    expect(isMemberClass("admin")).toBe(false);
    expect(isMemberClass(null)).toBe(false);
    expect(isMemberClass(undefined)).toBe(false);
  });

  it("memberClassOf defaults absent/null/unknown to owner — the single primary user", () => {
    expect(memberClassOf(undefined)).toBe("owner");
    expect(memberClassOf(null)).toBe("owner");
    expect(memberClassOf({})).toBe("owner");
    expect(memberClassOf({ member_class: null })).toBe("owner");
    expect(memberClassOf({ member_class: "garbage" })).toBe("owner");
    expect(memberClassOf({ member_class: "child_user" })).toBe("child_user");
  });

  it("member_class round-trips through the entities store; old writers leave it null", async () => {
    const store = createEntitiesStore(memDb(), { appId: "myhealth" });
    await store.ensure();
    await store.upsertPerson({ person_key: "self", display_name: "Anshuman" }); // pre-K0.4-style write
    await store.upsertPerson({ person_key: "kid", display_name: "Kid", member_class: "child_user" });
    expect(memberClassOf(await store.getPerson("self"))).toBe("owner");
    expect((await store.getPerson("kid"))!.member_class).toBe("child_user");
  });
});

describe("personKeyFor", () => {
  it("'self' for the primary user, slug otherwise", () => {
    expect(personKeyFor({ isSelf: true, name: "anyone" })).toBe("self");
    expect(personKeyFor({ isSelf: false, name: "Jane Doe" })).toBe("jane-doe");
  });
});
