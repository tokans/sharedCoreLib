import { describe, it, expect } from "vitest";
import {
  validateDescriptor, compareSchema, checkAgainstRegistry, mergeIntoRegistry,
  qualifiedName, type SchemaDescriptor, type SchemaRegistry,
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
