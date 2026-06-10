/**
 * Shared-entity spine — app-agnostic (`person` ↔ `asset` ↔ `document`, with `event`
 * on the timeline). Modeled ONCE in core and read/written by every app; never
 * re-modeled locally (suite invariant 6).
 *
 * Design (base-context v3 §9.11–9.12):
 *   - `person` is **identity only** — a stable `person_key` (anchored on the ICE
 *     `person_key`; `"self"` canonical for the primary user), display name,
 *     relationship-to-self, basic contacts, optional DOB/photo. Domain data lives in
 *     per-app **facet** tables keyed by `person_key` (field-level ownership: health
 *     owns medical facets, finance owns contact facets, …).
 *   - `person_relationship` is a **dormant edge table** (empty until a feature needs
 *     it) — the multi-user perspective substrate: relationship-to-active-user is later
 *     derived from these objective edges rather than stored per viewer.
 *   - `event`, `document`, `asset` link to `person` (and each other) by explicit
 *     reference. Identity is **explicit-reference**: pick-an-existing or create — there
 *     is **no auto-merge**. A guided-merge helper only *suggests* likely duplicates.
 *
 * All four schemas are `owner: "common"` shared tables (a single copy in the suite DB),
 * so writes go through the co-owned store here (like the ICE card), not the owner-gated
 * `createSharedDb.write`. DI/pure: everything runs against an injected {@link SqlDb}.
 */
import { createTableSql, tableName, type SqlDb } from "../db/index.js";
import type { SchemaDescriptor } from "../schema/index.js";
import { slugifyName } from "../ice/index.js";

// ── Schemas (the frozen entity spine; also published to contracts/) ──────────

/** `person` — thin identity. No domain data; apps attach facets keyed by `person_key`. */
export const PERSON_SCHEMA: SchemaDescriptor = {
  namespace: "common",
  name: "Person",
  plural: "People",
  dbAlias: "common_person",
  schemaType: "Table",
  confidentiality: "Confidential",
  owner: "common",
  shared: true,
  purpose: "One shared identity per person across the suite; apps attach domain facets by person_key.",
  fields: [
    { name: "person_key", dataType: "id", keyField: true, editability: "Immutable", description: "stable per-person key ('self' or a name slug)" },
    { name: "display_name", dataType: "string", personalData: true, purpose: "Name shown for this person across apps.", description: "display name" },
    { name: "relationship_to_self", dataType: "string", description: "objective relationship to the primary user (self/spouse/child/parent/friend/...)" },
    { name: "contact_phone", dataType: "string", personalData: true, purpose: "Reach this person.", description: "primary phone" },
    { name: "contact_email", dataType: "string", personalData: true, purpose: "Reach this person.", description: "primary email" },
    { name: "dob", dataType: "date", personalData: true, purpose: "Disambiguate identity / age-aware features.", description: "date of birth (optional)" },
    { name: "photo", dataType: "string", personalData: true, purpose: "Recognize this person in the UI.", description: "encrypted-blob ref to an avatar (optional)" },
    { name: "updated_at", dataType: "date", description: "ISO timestamp of the last edit" },
    { name: "source_app", dataType: "string", description: "app id that last wrote this row" },
  ],
};

/** `person_relationship` — DORMANT objective-edge table (empty until a feature needs it). */
export const PERSON_RELATIONSHIP_SCHEMA: SchemaDescriptor = {
  namespace: "common",
  name: "PersonRelationship",
  plural: "PersonRelationships",
  dbAlias: "common_person_relationship",
  schemaType: "Table",
  confidentiality: "Confidential",
  owner: "common",
  shared: true,
  purpose: "Objective relationship edges between people; substrate for multi-user perspective (derive relationship-to-active-user).",
  fields: [
    { name: "id", dataType: "id", keyField: true, editability: "Immutable", description: "edge id" },
    { name: "from_person", dataType: "id", required: true, index: "NonUnique", description: "person_key of the source" },
    { name: "to_person", dataType: "id", required: true, index: "NonUnique", description: "person_key of the target" },
    { name: "type", dataType: "string", required: true, description: "edge type (parent_of/spouse_of/sibling_of/...)" },
    { name: "updated_at", dataType: "date", description: "ISO timestamp of the last edit" },
    { name: "source_app", dataType: "string", description: "app id that last wrote this row" },
  ],
};

/** `event` — a dated item on the timeline, linking person/asset/document. */
export const EVENT_SCHEMA: SchemaDescriptor = {
  namespace: "common",
  name: "Event",
  plural: "Events",
  dbAlias: "common_event",
  schemaType: "Event",
  confidentiality: "Confidential",
  owner: "common",
  shared: true,
  purpose: "Shared timeline item that any app can place and read (birthdays, purchases, appointments, ...).",
  fields: [
    { name: "id", dataType: "id", keyField: true, editability: "Immutable", description: "event id" },
    { name: "date", dataType: "date", required: true, index: "NonUnique", description: "when the event occurs (ISO)" },
    { name: "title", dataType: "string", required: true, personalData: true, purpose: "Human label for the timeline item.", description: "event title" },
    { name: "person_key", dataType: "id", index: "NonUnique", description: "linked person (optional)" },
    { name: "asset_id", dataType: "id", index: "NonUnique", description: "linked asset (optional)" },
    { name: "document_id", dataType: "id", index: "NonUnique", description: "linked document (optional)" },
    { name: "notes", dataType: "string", personalData: true, purpose: "Free-text detail for the event.", description: "notes (optional)" },
    { name: "updated_at", dataType: "date", description: "ISO timestamp of the last edit" },
    { name: "source_app", dataType: "string", description: "app id that last wrote this row" },
  ],
};

/** `document` — encrypted-blob metadata + links to person/asset. */
export const DOCUMENT_SCHEMA: SchemaDescriptor = {
  namespace: "common",
  name: "Document",
  plural: "Documents",
  dbAlias: "common_document",
  schemaType: "Table",
  confidentiality: "Restricted",
  owner: "common",
  shared: true,
  purpose: "Metadata for an encrypted document blob, shared across apps and linkable to people/assets.",
  fields: [
    { name: "id", dataType: "id", keyField: true, editability: "Immutable", description: "document id" },
    { name: "title", dataType: "string", required: true, personalData: true, purpose: "Human label for the document.", description: "document title" },
    { name: "blob_ref", dataType: "string", description: "opaque reference to the encrypted blob (path/id) — never the plaintext" },
    { name: "mime", dataType: "string", description: "MIME type" },
    { name: "person_key", dataType: "id", index: "NonUnique", description: "linked person (optional)" },
    { name: "asset_id", dataType: "id", index: "NonUnique", description: "linked asset (optional)" },
    { name: "updated_at", dataType: "date", description: "ISO timestamp of the last edit" },
    { name: "source_app", dataType: "string", description: "app id that last wrote this row" },
  ],
};

/** `asset` — a thing of value owned by a person, with proof documents. */
export const ASSET_SCHEMA: SchemaDescriptor = {
  namespace: "common",
  name: "Asset",
  plural: "Assets",
  dbAlias: "common_asset",
  schemaType: "Table",
  confidentiality: "Restricted",
  owner: "common",
  shared: true,
  purpose: "A shared record of an owned thing of value (account/vehicle/property/collection), linkable to a person and proof documents.",
  fields: [
    { name: "id", dataType: "id", keyField: true, editability: "Immutable", description: "asset id" },
    { name: "type", dataType: "enum", required: true, constraints: { enumValues: ["account", "vehicle", "property", "collection", "other"] }, description: "asset kind" },
    { name: "label", dataType: "string", required: true, personalData: true, purpose: "Human label for the asset.", description: "display label" },
    { name: "value", dataType: "number", personalData: true, purpose: "Net-worth / estate aggregation.", description: "current value (optional)", constraints: { unit: "INR" } },
    { name: "owner", dataType: "id", index: "NonUnique", description: "person_key of the owner (optional)" },
    { name: "proof_document_id", dataType: "id", description: "linked proof document (optional)" },
    { name: "updated_at", dataType: "date", description: "ISO timestamp of the last edit" },
    { name: "source_app", dataType: "string", description: "app id that last wrote this row" },
  ],
};

/** Every entity schema, in dependency order (person first). */
export const ENTITY_SCHEMAS: SchemaDescriptor[] = [
  PERSON_SCHEMA, PERSON_RELATIONSHIP_SCHEMA, EVENT_SCHEMA, DOCUMENT_SCHEMA, ASSET_SCHEMA,
];

// ── Row types ────────────────────────────────────────────────────────────────

export interface Person {
  person_key: string;
  display_name?: string | null;
  relationship_to_self?: string | null;
  contact_phone?: string | null;
  contact_email?: string | null;
  dob?: string | null;
  photo?: string | null;
  updated_at?: string | null;
  source_app?: string | null;
}

export interface PersonRelationship {
  id: string;
  from_person: string;
  to_person: string;
  type: string;
  updated_at?: string | null;
  source_app?: string | null;
}

export interface EventRow {
  id: string;
  date: string;
  title: string;
  person_key?: string | null;
  asset_id?: string | null;
  document_id?: string | null;
  notes?: string | null;
  updated_at?: string | null;
  source_app?: string | null;
}

export interface DocumentRow {
  id: string;
  title: string;
  blob_ref?: string | null;
  mime?: string | null;
  person_key?: string | null;
  asset_id?: string | null;
  updated_at?: string | null;
  source_app?: string | null;
}

export interface Asset {
  id: string;
  type: "account" | "vehicle" | "property" | "collection" | "other";
  label: string;
  value?: number | null;
  owner?: string | null;
  proof_document_id?: string | null;
  updated_at?: string | null;
  source_app?: string | null;
}

/** A suggested duplicate for guided merge (never auto-applied). */
export interface DuplicateSuggestion {
  candidate: Person;
  /** Why it's a candidate: matching name and/or DOB. */
  reasons: ("same-name" | "same-dob")[];
}

// ── Store ──────────────────────────────────────────────────────────────────

export interface EntitiesStore {
  /** Create every entity table if absent (idempotent). */
  ensure(): Promise<void>;

  // person — identity, explicit-reference (no auto-merge)
  listPeople(): Promise<Person[]>;
  getPerson(personKey: string): Promise<Person | null>;
  /** Insert/replace a person identity row. */
  upsertPerson(p: Person): Promise<void>;
  /**
   * Explicit-reference identity: return the existing person for `person_key`, or create a
   * thin identity from `seed` if absent. NEVER merges two identities. The caller decides
   * the key (e.g. `"self"`, or a name slug via {@link personKeyFor}).
   */
  pickOrCreatePerson(personKey: string, seed?: Partial<Person>): Promise<Person>;
  /** Guided merge: people who *look* like duplicates of `p` (same name/DOB). Suggest only. */
  suggestDuplicates(p: Pick<Person, "display_name" | "dob"> & { person_key?: string }): Promise<DuplicateSuggestion[]>;
  removePerson(personKey: string): Promise<void>;

  // event / document / asset — explicit-reference links
  listEvents(opts?: { personKey?: string }): Promise<EventRow[]>;
  upsertEvent(e: EventRow): Promise<void>;
  listDocuments(opts?: { personKey?: string }): Promise<DocumentRow[]>;
  upsertDocument(d: DocumentRow): Promise<void>;
  listAssets(opts?: { owner?: string }): Promise<Asset[]>;
  upsertAsset(a: Asset): Promise<void>;
  /** Assets owned by a person plus their summed value (net-worth aggregation). */
  assetsForOwner(personKey: string): Promise<{ assets: Asset[]; total: number }>;
}

const q = (name: string): string => `"${name.replace(/[^A-Za-z0-9_]/g, "_")}"`;

function upsertInto<T>(
  db: SqlDb, schema: SchemaDescriptor, row: T, cols: (keyof T)[],
): Promise<unknown> {
  const present = cols.filter((c) => row[c] !== undefined);
  const placeholders = present.map(() => "?").join(", ");
  return db.execute(
    `INSERT OR REPLACE INTO ${q(tableName(schema))} (${present.map((c) => q(String(c))).join(", ")}) VALUES (${placeholders})`,
    present.map((c) => (row[c] ?? null) as unknown),
  );
}

const PERSON_COLS: (keyof Person)[] = ["person_key", "display_name", "relationship_to_self", "contact_phone", "contact_email", "dob", "photo", "updated_at", "source_app"];
const EVENT_COLS: (keyof EventRow)[] = ["id", "date", "title", "person_key", "asset_id", "document_id", "notes", "updated_at", "source_app"];
const DOC_COLS: (keyof DocumentRow)[] = ["id", "title", "blob_ref", "mime", "person_key", "asset_id", "updated_at", "source_app"];
const ASSET_COLS: (keyof Asset)[] = ["id", "type", "label", "value", "owner", "proof_document_id", "updated_at", "source_app"];

/**
 * A handle on the shared entity tables, bound to an injected {@link SqlDb}. `appId` is
 * stamped into `source_app` on writes (provenance + per-app sync scoping later).
 */
export function createEntitiesStore(db: SqlDb, opts: { appId: string }): EntitiesStore {
  const T = {
    person: q(tableName(PERSON_SCHEMA)),
    event: q(tableName(EVENT_SCHEMA)),
    document: q(tableName(DOCUMENT_SCHEMA)),
    asset: q(tableName(ASSET_SCHEMA)),
  };
  const stamp = <T extends { updated_at?: string | null; source_app?: string | null }>(row: T): T => ({
    ...row,
    source_app: row.source_app ?? opts.appId,
  });

  const store: EntitiesStore = {
    ensure: async () => {
      for (const s of ENTITY_SCHEMAS) for (const sql of createTableSql(s)) await db.execute(sql);
    },

    listPeople: () => db.select<Person>(`SELECT * FROM ${T.person}`),
    getPerson: async (personKey) => (await db.select<Person>(`SELECT * FROM ${T.person} WHERE person_key = ?`, [personKey]))[0] ?? null,
    upsertPerson: (p) => upsertInto(db, PERSON_SCHEMA, stamp(p), PERSON_COLS).then(() => undefined),
    removePerson: async (personKey) => { await db.execute(`DELETE FROM ${T.person} WHERE person_key = ?`, [personKey]); },

    pickOrCreatePerson: async (personKey, seed) => {
      const existing = await store.getPerson(personKey);
      if (existing) return existing;
      const fresh: Person = stamp({ person_key: personKey, ...seed });
      await store.upsertPerson(fresh);
      return fresh;
    },

    suggestDuplicates: async ({ display_name, dob, person_key }) => {
      const all = await store.listPeople();
      const nameKey = display_name ? slugifyName(display_name) : null;
      const out: DuplicateSuggestion[] = [];
      for (const c of all) {
        if (person_key && c.person_key === person_key) continue;
        const reasons: DuplicateSuggestion["reasons"] = [];
        if (nameKey && c.display_name && slugifyName(c.display_name) === nameKey) reasons.push("same-name");
        if (dob && c.dob && c.dob === dob) reasons.push("same-dob");
        if (reasons.length) out.push({ candidate: c, reasons });
      }
      return out;
    },

    listEvents: async (o) =>
      o?.personKey
        ? db.select<EventRow>(`SELECT * FROM ${T.event} WHERE person_key = ? ORDER BY date`, [o.personKey])
        : db.select<EventRow>(`SELECT * FROM ${T.event} ORDER BY date`),
    upsertEvent: (e) => upsertInto(db, EVENT_SCHEMA, stamp(e), EVENT_COLS).then(() => undefined),

    listDocuments: async (o) =>
      o?.personKey
        ? db.select<DocumentRow>(`SELECT * FROM ${T.document} WHERE person_key = ?`, [o.personKey])
        : db.select<DocumentRow>(`SELECT * FROM ${T.document}`),
    upsertDocument: (d) => upsertInto(db, DOCUMENT_SCHEMA, stamp(d), DOC_COLS).then(() => undefined),

    listAssets: async (o) =>
      o?.owner
        ? db.select<Asset>(`SELECT * FROM ${T.asset} WHERE owner = ?`, [o.owner])
        : db.select<Asset>(`SELECT * FROM ${T.asset}`),
    upsertAsset: (a) => upsertInto(db, ASSET_SCHEMA, stamp(a), ASSET_COLS).then(() => undefined),

    assetsForOwner: async (personKey) => {
      const assets = await store.listAssets({ owner: personKey });
      const total = assets.reduce((sum, a) => sum + (typeof a.value === "number" ? a.value : 0), 0);
      return { assets, total };
    },
  };
  return store;
}

/**
 * Stable `person_key` for an identity: `"self"` for the primary user (so every app agrees
 * on the main person), else a slug of the name. Mirrors the ICE card key so the `person`
 * row and the ICE card share one key per person.
 */
export function personKeyFor(opts: { isSelf: boolean; name: string }): string {
  return opts.isSelf ? "self" : slugifyName(opts.name);
}
