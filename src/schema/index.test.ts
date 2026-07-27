import { describe, it, expect } from "vitest";
import {
  validateDescriptor, compareSchema, checkAgainstRegistry, mergeIntoRegistry,
  qualifiedName, columnSimilarity, type SchemaDescriptor, type SchemaRegistry,
} from "./index.js";

const base = (over: Partial<SchemaDescriptor> = {}): SchemaDescriptor => ({
  namespace: "myfinance", name: "Account", schemaType: "Table",
  confidentiality: "Internal", owner: "myfinance",
  fields: [
    { name: "id", dataType: "id", keyField: true },
    { name: "name", dataType: "string", required: true },
  ],
  ...over,
});

describe("validateDescriptor", () => {
  it("accepts a well-formed table", () => {
    expect(validateDescriptor(base()).ok).toBe(true);
  });
  it("rejects a Table with no key field", () => {
    const r = validateDescriptor(base({ fields: [{ name: "name", dataType: "string" }] }));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => /keyField/.test(i.message))).toBe(true);
  });
  it("enforces DPDP: personal data must not be Public and needs a purpose", () => {
    const r = validateDescriptor(base({
      confidentiality: "Public",
      fields: [
        { name: "id", dataType: "id", keyField: true },
        { name: "pan", dataType: "string", personalData: true }, // Public + no purpose
      ],
    }));
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => /must not be Public/.test(i.message))).toBe(true);
    expect(r.issues.some((i) => /needs a `purpose`/.test(i.message))).toBe(true);
  });
});

describe("compareSchema", () => {
  it("identical → identical", () => {
    expect(compareSchema(base(), base()).status).toBe("identical");
  });
  it("added field → mergeable, union in merged", () => {
    const proposed = base({ fields: [...base().fields, { name: "currency", dataType: "string" }] });
    const r = compareSchema(base(), proposed);
    expect(r.status).toBe("mergeable");
    expect(r.additions.fields).toEqual(["currency"]);
    expect(r.merged!.fields.map((f) => f.name)).toContain("currency");
  });
  it("field type change → conflict (no merged)", () => {
    const proposed = base({ fields: [
      { name: "id", dataType: "id", keyField: true },
      { name: "name", dataType: "number", required: true }, // was string
    ] });
    const r = compareSchema(base(), proposed);
    expect(r.status).toBe("conflict");
    expect(r.conflicts[0]!.kind).toBe("field-type-mismatch");
    expect(r.merged).toBeUndefined();
  });
  it("confidentiality downgrade → conflict", () => {
    const r = compareSchema(base({ confidentiality: "Confidential" }), base({ confidentiality: "Internal" }));
    expect(r.conflicts.some((c) => c.kind === "confidentiality-downgrade")).toBe(true);
  });
  it("enum widening (added values) → additive, not a conflict", () => {
    const withEnum = (vals: string[]) => base({ fields: [
      { name: "id", dataType: "id", keyField: true },
      { name: "kind", dataType: "enum", constraints: { enumValues: vals } },
    ] });
    const r = compareSchema(withEnum(["a", "b"]), withEnum(["a", "b", "c"]));
    expect(r.conflicts.some((c) => c.kind === "field-constraint-mismatch")).toBe(false);
    expect(r.status).not.toBe("conflict");
  });
  it("enum narrowing (removed value) → still a conflict", () => {
    const withEnum = (vals: string[]) => base({ fields: [
      { name: "id", dataType: "id", keyField: true },
      { name: "kind", dataType: "enum", constraints: { enumValues: vals } },
    ] });
    const r = compareSchema(withEnum(["a", "b"]), withEnum(["a"]));
    expect(r.conflicts.some((c) => c.kind === "field-constraint-mismatch")).toBe(true);
  });
});

describe("checkAgainstRegistry + mergeIntoRegistry", () => {
  const registry: SchemaRegistry = { [qualifiedName(base())]: base() };

  it("new schema is reported new and merges in", () => {
    const fresh = base({ namespace: "myhealth", name: "Vital", owner: "myhealth",
      fields: [{ name: "id", dataType: "id", keyField: true }] });
    const res = checkAgainstRegistry([fresh], registry);
    expect(res.entries[0]!.status).toBe("new");
    expect(res.hasConflicts).toBe(false);
    const merged = mergeIntoRegistry(registry, [fresh]);
    expect(Object.keys(merged)).toContain("myhealth#Vital");
  });

  it("conflicting republish is flagged and mergeIntoRegistry throws", () => {
    const conflicting = base({ fields: [
      { name: "id", dataType: "id", keyField: true },
      { name: "name", dataType: "number" }, // type change
    ] });
    const res = checkAgainstRegistry([conflicting], registry);
    expect(res.hasConflicts).toBe(true);
    expect(() => mergeIntoRegistry(registry, [conflicting])).toThrow(/schema conflict/);
  });

  it("flags a cross-owner duplicate candidate (same data modeled twice)", () => {
    const dup = base({ namespace: "myhealth", owner: "myhealth" }); // same Name "Account" + shape, other owner
    const res = checkAgainstRegistry([dup], registry);
    expect(res.duplicateCandidates.some((d) => d.kind === "duplicate-candidate")).toBe(true);
  });

  it("rejects a different app re-registering an owned table (cross-app dup table name)", () => {
    // Same qualified name (myfinance#Account) but a different owner claiming it — even with
    // an identical shape this must be a hard conflict, not a silent 'identical' merge.
    const claim = base({ owner: "myhealth" });
    const res = checkAgainstRegistry([claim], registry);
    expect(res.hasConflicts).toBe(true);
    expect(res.entries[0]!.conflicts.some((c) => c.kind === "owner-mismatch")).toBe(true);
    expect(() => mergeIntoRegistry(registry, [claim])).toThrow(/schema conflict/);
  });

  it("same owner re-registering its own table additively still merges (no false owner-mismatch)", () => {
    const evolved = base({ fields: [...base().fields, { name: "currency", dataType: "string" }] });
    const res = checkAgainstRegistry([evolved], registry);
    expect(res.hasConflicts).toBe(false);
    expect(res.entries[0]!.status).toBe("mergeable");
  });
});

describe("duplicate hard-block (duplicates: 'block')", () => {
  // Registered: a contact-like table owned by app A.
  const contact = (over: Partial<SchemaDescriptor> = {}): SchemaDescriptor => ({
    namespace: "appa", name: "Contact", schemaType: "Table",
    confidentiality: "Confidential", owner: "appa",
    fields: [
      { name: "id", dataType: "id", keyField: true },
      { name: "fullName", dataType: "string" },
      { name: "email", dataType: "string" },
      { name: "phone", dataType: "string" },
      { name: "updated_at", dataType: "date" },
    ],
    ...over,
  });
  const registry: SchemaRegistry = { [qualifiedName(contact())]: contact() };
  // Proposed by app B: different table/namespace name, near-identical significant columns.
  const lookalike = (over: Partial<SchemaDescriptor> = {}): SchemaDescriptor => contact({
    namespace: "appb", name: "Buddy", owner: "appb",
    fields: [
      { name: "id", dataType: "id", keyField: true },
      { name: "fullName", dataType: "string" },
      { name: "email", dataType: "string" },
      { name: "phone", dataType: "string" },
      { name: "created_at", dataType: "date" }, // audit col — ignored by the heuristic
    ],
    ...over,
  });

  it("similarity heuristic: high column overlap (audit/sync cols ignored) → candidate", () => {
    expect(columnSimilarity(lookalike(), contact())).toBe(1); // {fullname,email,phone} vs same
    const res = checkAgainstRegistry([lookalike()], registry);
    expect(res.duplicateCandidates).toHaveLength(1); // detected even with different names
    expect(res.hasConflicts).toBe(false); // default mode is warn — advisory only
  });

  it("block mode FAILS an un-adopted, un-overridden duplicate candidate", () => {
    const res = checkAgainstRegistry([lookalike()], registry, { duplicates: "block" });
    expect(res.hasConflicts).toBe(true);
    expect(res.entries[0]!.status).toBe("conflict");
    expect(res.entries[0]!.conflicts.some((c) => c.kind === "duplicate-candidate")).toBe(true);
  });

  it("adopts: declaring use of the existing table passes block mode", () => {
    const adopting = lookalike({ adopts: "appa#Contact" });
    const res = checkAgainstRegistry([adopting], registry, { duplicates: "block" });
    expect(res.hasConflicts).toBe(false);
    expect(res.duplicateCandidates).toHaveLength(0);
    // adopting a DIFFERENT table does not exempt this candidate
    const wrong = lookalike({ adopts: "appa#Other" });
    expect(checkAgainstRegistry([wrong], registry, { duplicates: "block" }).hasConflicts).toBe(true);
  });

  it("duplicateOverride: a reviewed reason passes block mode but stays reported", () => {
    const overridden = lookalike({ duplicateOverride: "Reviewed 2026-06: different lifecycle + retention." });
    const res = checkAgainstRegistry([overridden], registry, { duplicates: "block" });
    expect(res.hasConflicts).toBe(false);
    expect(res.duplicateCandidates).toHaveLength(1);
    expect(res.duplicateCandidates[0]!.detail).toMatch(/reviewed override/);
  });

  it("no false positive when only audit/sync columns overlap", () => {
    const sparse = base({
      namespace: "appb", owner: "appb", name: "Tag",
      fields: [
        { name: "id", dataType: "id", keyField: true },
        { name: "created_at", dataType: "date" },
        { name: "updated_at", dataType: "date" },
        { name: "label", dataType: "string" },
      ],
    });
    const res = checkAgainstRegistry([sparse], registry, { duplicates: "block" });
    expect(res.duplicateCandidates).toHaveLength(0);
    expect(res.hasConflicts).toBe(false);
  });

  it("validateDescriptor accepts the new fields and rejects malformed/self adopts", () => {
    expect(validateDescriptor(lookalike({ adopts: "appa#Contact", duplicateOverride: "reviewed" })).ok).toBe(true);
    expect(validateDescriptor(lookalike({ adopts: "not-qualified" })).ok).toBe(false);
    expect(validateDescriptor(contact({ adopts: "appa#Contact" })).ok).toBe(false); // self-adoption
  });
});
