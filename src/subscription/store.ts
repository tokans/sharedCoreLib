/**
 * Persistence for the ONE suite subscription — a single shared ("common") row in
 * the suite DB so EVERY app reads the same subscription (one key, all apps).
 *
 * The table is core-owned (`owner: "common"`, `shared: true`) and holds exactly one
 * row (`id = "current"`). Apps register {@link SUITE_SUBSCRIPTION_SCHEMA} via
 * `registerSchemas` at boot and read it through {@link createSubscriptionStore};
 * writes are the billing layer's job (myLifeAssistant owns checkout). DI/pure: runs
 * against an injected {@link SqlDb} (the Tauri SQL plugin in-app, a fake in tests).
 */
import { createTableSql, type SqlDb } from "../db/index.js";
import type { SchemaDescriptor } from "../schema/index.js";
import type { SuiteSubscription, SuiteTierId } from "./index.js";

/** The fixed primary key of the single suite-subscription row. */
export const SUITE_SUBSCRIPTION_ID = "current";

/**
 * The shared suite-subscription table. ONE copy in the suite DB, read by every app.
 * Confidential (billing state) but carries no secret material — `byo_key` is a flag,
 * not the key itself, which stays in the per-app vault.
 */
export const SUITE_SUBSCRIPTION_SCHEMA: SchemaDescriptor = {
  namespace: "common",
  name: "SuiteSubscription",
  plural: "SuiteSubscriptions",
  description: "The one active suite subscription (tier + expiry) shared across all apps.",
  purpose: "Drive premium entitlement and tier-based limits uniformly across the suite.",
  schemaType: "Table",
  confidentiality: "Confidential",
  owner: "common",
  shared: true,
  fields: [
    { name: "id", dataType: "id", keyField: true, editability: "Immutable",
      description: 'Singleton row id (always "current").' },
    { name: "tier", dataType: "enum", required: true,
      constraints: { enumValues: ["essential", "plus", "max"] },
      description: "Active pricing tier." },
    { name: "expires_at", dataType: "date", required: true,
      description: "ISO expiry; the subscription is active strictly before this instant." },
    { name: "byo_key", dataType: "boolean",
      description: "A BYO inference key is configured — allowance caps do not apply." },
    { name: "updated_at", dataType: "date",
      description: "When this record was last written." },
  ],
  tags: ["subscription", "billing", "common"],
};

interface SubscriptionRow {
  id: string;
  tier: string;
  expires_at: string;
  byo_key: number | boolean | null;
  updated_at: string | null;
}

export interface SubscriptionStore {
  /** Create the shared table if absent (idempotent). Registered apps can rely on
   *  `registerSchemas` instead; this exists for standalone/test use. */
  ensure(): Promise<void>;
  /** The current suite subscription, or null when none is recorded. */
  get(): Promise<SuiteSubscription | null>;
  /** Upsert the single suite-subscription row. */
  set(sub: SuiteSubscription, nowIso: string): Promise<void>;
  /** Remove the subscription (back to the free, unentitled state). */
  clear(): Promise<void>;
}

const TABLE = `"common_SuiteSubscription"`;

/** A DAO over the shared suite-subscription row. */
export function createSubscriptionStore(db: SqlDb): SubscriptionStore {
  return {
    ensure: async () => {
      for (const sql of createTableSql(SUITE_SUBSCRIPTION_SCHEMA)) await db.execute(sql);
    },

    get: async () => {
      const rows = await db.select<SubscriptionRow>(
        `SELECT id, tier, expires_at, byo_key, updated_at FROM ${TABLE} WHERE id = ?`,
        [SUITE_SUBSCRIPTION_ID],
      );
      const r = rows[0];
      if (!r) return null;
      const sub: SuiteSubscription = {
        tier: r.tier as SuiteTierId,
        expiresAt: r.expires_at,
      };
      if (r.byo_key) sub.byoKey = true;
      return sub;
    },

    set: async (sub, nowIso) => {
      await db.execute(
        `INSERT OR REPLACE INTO ${TABLE} (id, tier, expires_at, byo_key, updated_at) ` +
          `VALUES (?, ?, ?, ?, ?)`,
        [SUITE_SUBSCRIPTION_ID, sub.tier, sub.expiresAt, sub.byoKey ? 1 : 0, nowIso],
      );
    },

    clear: async () => {
      await db.execute(`DELETE FROM ${TABLE} WHERE id = ?`, [SUITE_SUBSCRIPTION_ID]);
    },
  };
}
