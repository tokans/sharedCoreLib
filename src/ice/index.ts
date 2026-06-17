/**
 * Emergency / ICE contact-extraction primitives — app-agnostic.
 *
 * Deterministic keyword + regex matching (no LLM — a hard constraint of the
 * suite): does an action read as "call/contact someone", and pull a dialable
 * `tel:` / `mailto:` href out of a free-text contact string. The APP supplies its
 * own ICE-card fields, disclaimer copy, and which records carry contacts; this
 * module only provides the pure extraction helpers.
 *
 * It ALSO defines the suite's single **common ICE card** — a shared ("common")
 * table in the suite DB that every entitled app reads and edits, keyed per person,
 * so the same emergency card is never duplicated across apps (see {@link
 * ICE_CARD_SCHEMA} + {@link createIceStore}).
 */
import { createTableSql, tableName, type SqlDb } from "../db/index.js";
import type { SchemaDescriptor } from "../schema/index.js";

/** Verbs/phrases that signal an action involves reaching a person. */
export const CONTACT_PHRASES = [
  "call",
  "contact",
  "phone",
  "ring",
  "dial",
  "reach out",
  "reach",
  "speak to",
  "speak with",
  "talk to",
  "get in touch",
  "notify",
  "inform",
  "tell",
  "email",
  "message",
  "whatsapp",
];

/**
 * True when a note reads as "call/contact someone". Whole-word, case-insensitive
 * matching so "recall" or "information" don't false-trigger. Pass custom phrases
 * to extend/replace the default set.
 */
const phraseRegex = (p: string): RegExp =>
  new RegExp(`(^|[^a-z])${p.replace(/\s+/g, "\\s+")}([^a-z]|$)`);
// Precompile the default phrase set once (this is the hot path); custom phrase
// lists compile on demand.
const DEFAULT_PHRASE_REGEXES = CONTACT_PHRASES.map(phraseRegex);

export function mentionsContact(
  action: string | null | undefined,
  phrases: string[] = CONTACT_PHRASES,
): boolean {
  if (!action) return false;
  const h = action.toLowerCase();
  const regexes = phrases === CONTACT_PHRASES ? DEFAULT_PHRASE_REGEXES : phrases.map(phraseRegex);
  return regexes.some((re) => re.test(h));
}

/**
 * Pull the first phone-number-looking run of digits out of a free-text contact
 * string, returning a `tel:` href, or null when there's nothing dialable. Keeps a
 * leading '+'; requires at least 7 digits so stray numbers don't masquerade.
 */
export function telHref(contact: string | null | undefined): string | null {
  if (!contact) return null;
  const m = contact.match(/\+?[\d][\d\s().-]{6,}\d/);
  if (!m) return null;
  const plus = m[0].trim().startsWith("+");
  const digits = m[0].replace(/\D/g, "");
  if (digits.length < 7) return null;
  return `tel:${plus ? "+" : ""}${digits}`;
}

/** Pull the first email out of a free-text contact string as a `mailto:` href, or null. */
export function mailtoHref(contact: string | null | undefined): string | null {
  if (!contact) return null;
  const m = contact.match(/[^\s<>()]+@[^\s<>()]+\.[a-z]{2,}/i);
  return m ? `mailto:${m[0]}` : null;
}

/** True when a record is ready to act on: an action that needs a contact has one. */
export function hasActionableContact(rec: {
  contact: string | null;
  emergency_action: string | null;
}): boolean {
  return mentionsContact(rec.emergency_action) && !!rec.contact?.trim();
}

// ── The common ICE card (a shared suite-DB table) ────────────────────────────

/**
 * The canonical **common** ICE card schema — a single shared table in the suite DB
 * (`sharedcorelib/db`) that any entitled app may read AND edit, keyed per person.
 * Registered (idempotently) by whichever suite app launches first; because every app
 * registers this identical descriptor there is never a conflict and never a duplicate.
 *
 * Owner is `"common"` (core-owned shared data), so writes do NOT go through the
 * owner-gated governed handle (`createSharedDb.write`) — they go through the
 * co-owned raw helper {@link createIceStore} instead.
 */
export const ICE_CARD_SCHEMA: SchemaDescriptor = {
  namespace: "common",
  name: "IceCard",
  plural: "IceCards",
  dbAlias: "common_ice_card",
  schemaType: "Table",
  confidentiality: "Confidential",
  owner: "common",
  shared: true,
  purpose: "One shared in-case-of-emergency card per person, reused across suite apps.",
  fields: [
    { name: "person_key", dataType: "id", keyField: true, editability: "Immutable", description: "stable per-person key ('self' or a name slug)" },
    { name: "display_name", dataType: "string", personalData: true, purpose: "Name shown on the emergency card.", description: "person's display name" },
    { name: "blood_group", dataType: "string", personalData: true, purpose: "Critical for emergency transfusion decisions.", description: "ABO/Rh blood group" },
    { name: "contact_name", dataType: "string", personalData: true, purpose: "Who to reach in an emergency.", description: "emergency contact name" },
    { name: "contact_phone", dataType: "string", personalData: true, purpose: "Dialable emergency contact number.", description: "emergency contact phone" },
    { name: "contact_email", dataType: "string", personalData: true, purpose: "Emergency contact email.", description: "emergency contact email" },
    { name: "allergies", dataType: "string", personalData: true, purpose: "Allergies first responders must know.", description: "free-text allergy list" },
    { name: "conditions", dataType: "string", personalData: true, purpose: "Conditions first responders must know.", description: "free-text condition list" },
    { name: "medications", dataType: "string", personalData: true, purpose: "Current medications first responders must know.", description: "free-text medication list" },
    { name: "organ_donor", dataType: "boolean", description: "registered organ donor (1/0)" },
    { name: "advance_directive", dataType: "string", personalData: true, purpose: "Advance-directive note for clinicians.", description: "advance-directive note" },
    { name: "notes", dataType: "string", personalData: true, purpose: "Any other emergency note.", description: "free-text note" },
    { name: "updated_at", dataType: "date", description: "ISO timestamp of the last edit" },
    { name: "source_app", dataType: "string", description: "app id that last wrote this card" },
  ],
};

/** A row of the common ICE card. All fields but `person_key` are optional. */
export interface IceCard {
  person_key: string;
  display_name?: string | null;
  blood_group?: string | null;
  contact_name?: string | null;
  contact_phone?: string | null;
  contact_email?: string | null;
  allergies?: string | null;
  conditions?: string | null;
  medications?: string | null;
  /** 1 = registered organ donor, 0/undefined otherwise. */
  organ_donor?: number | null;
  advance_directive?: string | null;
  notes?: string | null;
  updated_at?: string | null;
  source_app?: string | null;
}

/** Read/write access to the shared common ICE card table in the suite DB. */
export interface IceStore {
  /** Create the table if it doesn't exist (idempotent). */
  ensure(): Promise<void>;
  /** Every ICE card. */
  list(): Promise<IceCard[]>;
  /** One person's card, or null. */
  get(personKey: string): Promise<IceCard | null>;
  /** Insert or replace a person's card. */
  upsert(card: IceCard): Promise<void>;
  /** Delete a person's card. */
  remove(personKey: string): Promise<void>;
}

const ICE_COLUMNS: (keyof IceCard)[] = [
  "person_key", "display_name", "blood_group", "contact_name", "contact_phone",
  "contact_email", "allergies", "conditions", "medications", "organ_donor",
  "advance_directive", "notes", "updated_at", "source_app",
];

/**
 * A handle on the shared common ICE card table, bound to an injected {@link SqlDb}
 * (the Tauri SQL plugin in an app, an in-memory fake in tests). This is the co-owned
 * write path for the `common`-owned card — both apps read and edit through it.
 */
export function createIceStore(db: SqlDb): IceStore {
  const table = `"${tableName(ICE_CARD_SCHEMA)}"`;

  return {
    ensure: async () => {
      for (const sql of createTableSql(ICE_CARD_SCHEMA)) await db.execute(sql);
    },
    list: async () => db.select<IceCard>(`SELECT * FROM ${table}`),
    get: async (personKey) => {
      const rows = await db.select<IceCard>(`SELECT * FROM ${table} WHERE person_key = ?`, [personKey]);
      return rows[0] ?? null;
    },
    upsert: async (card) => {
      const cols = ICE_COLUMNS.filter((c) => c === "person_key" || card[c] !== undefined);
      const placeholders = cols.map(() => "?").join(", ");
      await db.execute(
        `INSERT OR REPLACE INTO ${table} (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${placeholders})`,
        cols.map((c) => card[c] ?? null),
      );
    },
    remove: async (personKey) => {
      await db.execute(`DELETE FROM ${table} WHERE person_key = ?`, [personKey]);
    },
  };
}

/** Lower-case, hyphenated slug of a name (for use as a stable person key). */
export function slugifyName(name: string): string {
  return name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unnamed";
}

/**
 * Stable per-person key for the common ICE card: `"self"` for the primary user (so
 * every app agrees on the main card), else a slug of the person's name.
 */
export function iceCardPersonKey(opts: { isSelf: boolean; name: string }): string {
  return opts.isSelf ? "self" : slugifyName(opts.name);
}
