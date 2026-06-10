/**
 * Semantic data-schema registry — app-agnostic.
 *
 * The suite runs ONE shared client-side database with per-app tables PLUS shared
 * ("common") tables that hold a single copy of data many apps use — so the same data
 * is never replicated. To make that safe, every table is described by a SEMANTIC
 * {@link SchemaDescriptor}: the schema's purpose + confidentiality, and for each
 * field/relationship its dataType, constraints, purpose, confidentiality, and DPDP
 * personal-data marker. The descriptor model is distilled from the hyperclaw
 * `schemata` meta-schema (Schema/Field/Relationship + confidentiality, editability,
 * personalData/purpose, relationshipType, indexType, constraints).
 *
 * On publish, an app's schemas are CHECKED against the already-registered ones:
 * identical → no-op, purely-additive → auto-mergeable, anything else → a reported
 * CONFLICT the publisher must resolve before the shared store is updated. This module
 * is the pure engine (validate + compare + merge + duplicate detection); the SQLite
 * access layer and the on-disk registry live in the shared-suite runtime.
 */
import { z } from "zod";

// ── Vocabulary (from the hyperclaw schemata) ─────────────────────────────────

export type Confidentiality = "Public" | "Internal" | "Confidential" | "Restricted" | "Secret";
export const CONFIDENTIALITY_ORDER: Confidentiality[] = ["Public", "Internal", "Confidential", "Restricted", "Secret"];
const confRank = (c: Confidentiality): number => CONFIDENTIALITY_ORDER.indexOf(c);

export type Editability = "Mutable" | "MutableIfNull" | "Immutable" | "Generated";
export type RelationshipType = "One-One" | "One-Many" | "Many-One" | "Many-Many";
export type SchemaKind = "Table" | "Embedded" | "Enum" | "Reference" | "Event";
export type IndexType = "NonUnique" | "Unique" | "Text";

/** Field value constraints (a subset of the schemata Field validations). */
export interface FieldConstraints {
  pattern?: string;
  min?: number;
  max?: number;
  length?: number;
  multipleOf?: number;
  enumValues?: string[];
  /** Unit of measure (e.g. "INR", "kg", "ms") — semantic, helps dedup/merge. */
  unit?: string;
}

export interface FieldDescriptor {
  name: string;
  /** "string" | "number" | "boolean" | "date" | "enum" | "reference" | "embedded" | "id" | "any" | an Enum name. */
  dataType: string;
  description?: string;
  /** Why this data is collected/kept — required for personal data (DPDP). */
  purpose?: string;
  confidentiality?: Confidentiality;
  /** DPDP: true for personal data. Such fields must NOT be Public and need a purpose. */
  personalData?: boolean;
  editability?: Editability;
  required?: boolean;
  keyField?: boolean;
  index?: IndexType;
  dbAlias?: string;
  constraints?: FieldConstraints;
}

export interface RelationshipDescriptor {
  name: string;
  relationshipType: RelationshipType;
  /** Qualified name of the related schema, "namespace#Name". */
  relatedSchema: string;
  description?: string;
  purpose?: string;
  required?: boolean;
  embedded?: boolean;
  reverseName?: string;
  confidentiality?: Confidentiality;
}

export interface SchemaDescriptor {
  namespace: string;
  name: string;
  plural?: string;
  description?: string;
  /** The purpose of this table's data (governance + dedup reasoning). */
  purpose?: string;
  schemaType: SchemaKind;
  confidentiality: Confidentiality;
  /** Physical table name override (else `namespace_Name`); used by the suite-DB layer. */
  dbAlias?: string;
  /** The app id that owns/defines this schema; "common" for core-owned shared tables. */
  owner: string;
  /**
   * True when this is a SHARED ("common") table — a single copy in the suite DB that
   * every entitled app reads, instead of each app keeping its own duplicate.
   */
  shared?: boolean;
  fields: FieldDescriptor[];
  relationships?: RelationshipDescriptor[];
  tags?: string[];
}

/** Fully-qualified key, "namespace#Name" (mirrors the schemata `core#Duration` convention). */
export function qualifiedName(s: Pick<SchemaDescriptor, "namespace" | "name">): string {
  return `${s.namespace}#${s.name}`;
}

// ── Validation (zod + DPDP rule) ─────────────────────────────────────────────

const confEnum = z.enum(["Public", "Internal", "Confidential", "Restricted", "Secret"]);

const fieldSchema = z.object({
  name: z.string().min(1).max(64),
  dataType: z.string().min(1).max(64),
  description: z.string().max(2000).optional(),
  purpose: z.string().max(2000).optional(),
  confidentiality: confEnum.optional(),
  personalData: z.boolean().optional(),
  editability: z.enum(["Mutable", "MutableIfNull", "Immutable", "Generated"]).optional(),
  required: z.boolean().optional(),
  keyField: z.boolean().optional(),
  index: z.enum(["NonUnique", "Unique", "Text"]).optional(),
  dbAlias: z.string().max(64).optional(),
  constraints: z.object({
    pattern: z.string().optional(), min: z.number().optional(), max: z.number().optional(),
    length: z.number().optional(), multipleOf: z.number().optional(),
    enumValues: z.array(z.string()).optional(), unit: z.string().max(32).optional(),
  }).strict().optional(),
}).strict();

const relationshipSchema = z.object({
  name: z.string().min(1).max(64),
  relationshipType: z.enum(["One-One", "One-Many", "Many-One", "Many-Many"]),
  relatedSchema: z.string().min(1),
  description: z.string().max(2000).optional(),
  purpose: z.string().max(2000).optional(),
  required: z.boolean().optional(),
  embedded: z.boolean().optional(),
  reverseName: z.string().max(64).optional(),
  confidentiality: confEnum.optional(),
}).strict();

export const schemaDescriptorSchema = z.object({
  namespace: z.string().min(1).max(64),
  name: z.string().min(1).max(64),
  plural: z.string().max(64).optional(),
  description: z.string().max(2000).optional(),
  purpose: z.string().max(2000).optional(),
  schemaType: z.enum(["Table", "Embedded", "Enum", "Reference", "Event"]),
  confidentiality: confEnum,
  dbAlias: z.string().max(64).optional(),
  owner: z.string().min(1).max(64),
  shared: z.boolean().optional(),
  fields: z.array(fieldSchema).min(1),
  relationships: z.array(relationshipSchema).optional(),
  tags: z.array(z.string()).optional(),
}).strict();

export interface ValidationIssue {
  schema: string;
  field?: string;
  message: string;
}

/**
 * Validate one descriptor: shape (zod) + semantic rules — DPDP (personal data must
 * not be Public and needs a purpose), at least one key field, unique field names.
 */
export function validateDescriptor(input: unknown): { ok: boolean; issues: ValidationIssue[]; value?: SchemaDescriptor } {
  const parsed = schemaDescriptorSchema.safeParse(input);
  if (!parsed.success) {
    const where = (input as { namespace?: string; name?: string }) ?? {};
    return {
      ok: false,
      issues: parsed.error.issues.map((i) => ({
        schema: `${where.namespace ?? "?"}#${where.name ?? "?"}`,
        field: i.path.join("."),
        message: i.message,
      })),
    };
  }
  const s = parsed.data as SchemaDescriptor;
  const q = qualifiedName(s);
  const issues: ValidationIssue[] = [];

  const seen = new Set<string>();
  for (const f of s.fields) {
    if (seen.has(f.name)) issues.push({ schema: q, field: f.name, message: "duplicate field name" });
    seen.add(f.name);
    if (f.personalData) {
      if ((f.confidentiality ?? s.confidentiality) === "Public") {
        issues.push({ schema: q, field: f.name, message: "personal data must not be Public (DPDP)" });
      }
      if (!f.purpose) issues.push({ schema: q, field: f.name, message: "personal data needs a `purpose` (DPDP)" });
    }
  }
  if (s.schemaType === "Table" && !s.fields.some((f) => f.keyField)) {
    issues.push({ schema: q, message: "a Table needs at least one keyField" });
  }
  return { ok: issues.length === 0, issues, value: s };
}

// ── Conflict / merge engine ──────────────────────────────────────────────────

export type ConflictKind =
  | "schema-kind-mismatch"
  | "field-type-mismatch"
  | "field-constraint-mismatch"
  | "key-mismatch"
  | "confidentiality-downgrade"
  | "personal-data-mismatch"
  | "relationship-mismatch"
  | "owner-mismatch"
  | "duplicate-candidate";

export interface SchemaConflict {
  kind: ConflictKind;
  schema: string;
  field?: string;
  detail: string;
}

export type CompareStatus = "identical" | "mergeable" | "conflict";

export interface CompareResult {
  schema: string;
  status: CompareStatus;
  conflicts: SchemaConflict[];
  /** Additive (non-conflicting) names the proposed schema introduces. */
  additions: { fields: string[]; relationships: string[] };
  /** The union, present only when status !== "conflict". */
  merged?: SchemaDescriptor;
}

const sameConstraints = (a?: FieldConstraints, b?: FieldConstraints): boolean =>
  JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});

/**
 * Compare a proposed schema against the existing registered one (same qualified name).
 * Existing wins on shared fields; the proposed may only ADD. Any incompatible change is
 * a conflict. Returns the union as `merged` when there are no conflicts.
 */
export function compareSchema(existing: SchemaDescriptor, proposed: SchemaDescriptor): CompareResult {
  const q = qualifiedName(existing);
  const conflicts: SchemaConflict[] = [];
  const addedFields: string[] = [];
  const addedRels: string[] = [];

  if (existing.schemaType !== proposed.schemaType) {
    conflicts.push({ kind: "schema-kind-mismatch", schema: q, detail: `${existing.schemaType} vs ${proposed.schemaType}` });
  }
  // A registered table belongs to exactly one owner. A different app re-registering the
  // same qualified name is cross-app table duplication (even if the shape matches) — block
  // it so two apps can never silently claim/redefine the same physical table.
  if (existing.owner !== proposed.owner) {
    conflicts.push({ kind: "owner-mismatch", schema: q, detail: `owned by ${existing.owner}, ${proposed.owner} may not redefine it` });
  }
  if (confRank(proposed.confidentiality) < confRank(existing.confidentiality)) {
    conflicts.push({ kind: "confidentiality-downgrade", schema: q, detail: `${existing.confidentiality} → ${proposed.confidentiality}` });
  }

  const exFields = new Map(existing.fields.map((f) => [f.name, f]));
  const mergedFields = [...existing.fields];
  for (const pf of proposed.fields) {
    const ef = exFields.get(pf.name);
    if (!ef) { addedFields.push(pf.name); mergedFields.push(pf); continue; }
    if (ef.dataType !== pf.dataType) {
      conflicts.push({ kind: "field-type-mismatch", schema: q, field: pf.name, detail: `${ef.dataType} vs ${pf.dataType}` });
    }
    if (!!ef.keyField !== !!pf.keyField) {
      conflicts.push({ kind: "key-mismatch", schema: q, field: pf.name, detail: `keyField ${!!ef.keyField} vs ${!!pf.keyField}` });
    }
    if (!!ef.personalData !== !!pf.personalData) {
      conflicts.push({ kind: "personal-data-mismatch", schema: q, field: pf.name, detail: `personalData ${!!ef.personalData} vs ${!!pf.personalData}` });
    }
    const ec = ef.confidentiality ?? existing.confidentiality;
    const pc = pf.confidentiality ?? proposed.confidentiality;
    if (confRank(pc) < confRank(ec)) {
      conflicts.push({ kind: "confidentiality-downgrade", schema: q, field: pf.name, detail: `${ec} → ${pc}` });
    }
    if (!sameConstraints(ef.constraints, pf.constraints)) {
      conflicts.push({ kind: "field-constraint-mismatch", schema: q, field: pf.name, detail: "constraints differ" });
    }
  }

  const exRels = new Map((existing.relationships ?? []).map((r) => [r.name, r]));
  const mergedRels = [...(existing.relationships ?? [])];
  for (const pr of proposed.relationships ?? []) {
    const er = exRels.get(pr.name);
    if (!er) { addedRels.push(pr.name); mergedRels.push(pr); continue; }
    if (er.relationshipType !== pr.relationshipType || er.relatedSchema !== pr.relatedSchema) {
      conflicts.push({ kind: "relationship-mismatch", schema: q, field: pr.name, detail: `${er.relationshipType}->${er.relatedSchema} vs ${pr.relationshipType}->${pr.relatedSchema}` });
    }
  }

  const hasAdditions = addedFields.length + addedRels.length > 0;
  const status: CompareStatus = conflicts.length ? "conflict" : hasAdditions ? "mergeable" : "identical";
  const result: CompareResult = { schema: q, status, conflicts, additions: { fields: addedFields, relationships: addedRels } };
  if (status !== "conflict") {
    result.merged = { ...existing, fields: mergedFields, relationships: mergedRels.length ? mergedRels : existing.relationships };
  }
  return result;
}

export type RegistryEntryStatus = "new" | CompareStatus;

export interface RegistryCheckEntry {
  schema: string;
  status: RegistryEntryStatus;
  conflicts: SchemaConflict[];
  additions: { fields: string[]; relationships: string[] };
}

export interface RegistryCheckResult {
  entries: RegistryCheckEntry[];
  /** Cross-namespace look-alikes (same Name + field shape, different owner) — possible duplication. */
  duplicateCandidates: SchemaConflict[];
  hasConflicts: boolean;
}

/** A registry is the set of already-registered shared schemas, keyed by qualified name. */
export type SchemaRegistry = Record<string, SchemaDescriptor>;

const fieldShapeKey = (s: SchemaDescriptor): string =>
  s.fields.map((f) => `${f.name}:${f.dataType}`).sort().join(",");

/**
 * Check a batch of proposed schemas (an app being published) against the registry.
 * Reports per-schema status (new / identical / mergeable / conflict) and flags
 * cross-owner duplicate candidates (same Name + field shape) so the same data isn't
 * replicated under two tables.
 */
export function checkAgainstRegistry(proposed: SchemaDescriptor[], registry: SchemaRegistry): RegistryCheckResult {
  const entries: RegistryCheckEntry[] = [];
  for (const p of proposed) {
    const q = qualifiedName(p);
    const existing = registry[q];
    if (!existing) {
      entries.push({ schema: q, status: "new", conflicts: [], additions: { fields: [], relationships: [] } });
      continue;
    }
    const cmp = compareSchema(existing, p);
    entries.push({ schema: q, status: cmp.status, conflicts: cmp.conflicts, additions: cmp.additions });
  }

  // Duplicate candidates: a proposed schema whose Name+shape matches a registered schema
  // under a DIFFERENT qualified name/owner → likely the same data modeled twice.
  const duplicateCandidates: SchemaConflict[] = [];
  for (const p of proposed) {
    const pq = qualifiedName(p);
    const pShape = fieldShapeKey(p);
    for (const [rq, r] of Object.entries(registry)) {
      if (rq === pq) continue;
      if (r.name === p.name && fieldShapeKey(r) === pShape && r.owner !== p.owner) {
        duplicateCandidates.push({
          kind: "duplicate-candidate", schema: pq,
          detail: `looks identical to ${rq} (owner ${r.owner}) — consider a shared common table instead of duplicating`,
        });
      }
    }
  }

  const hasConflicts = entries.some((e) => e.status === "conflict");
  return { entries, duplicateCandidates, hasConflicts };
}

/**
 * Apply a batch into the registry: new + mergeable schemas are written (additively
 * merged); a conflict throws with the offending conflicts (the publish is blocked
 * until resolved). Returns a NEW registry (input is not mutated).
 */
export function mergeIntoRegistry(registry: SchemaRegistry, proposed: SchemaDescriptor[]): SchemaRegistry {
  const out: SchemaRegistry = { ...registry };
  for (const p of proposed) {
    const q = qualifiedName(p);
    const existing = out[q];
    if (!existing) { out[q] = p; continue; }
    const cmp = compareSchema(existing, p);
    if (cmp.status === "conflict") {
      throw new Error(`schema conflict for ${q}: ${cmp.conflicts.map((c) => `${c.kind}${c.field ? `(${c.field})` : ""}`).join(", ")}`);
    }
    out[q] = cmp.merged!;
  }
  return out;
}
