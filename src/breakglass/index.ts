/**
 * Break-glass — app-agnostic emergency disclosure of a redacted slice of the user's data
 * to a trusted recipient (nominee/executor), local-first and free at the safety floor.
 *
 * The CONTRACT is frozen here first (this module ships the interfaces + mechanism); each
 * app *lifts its own disclosure logic* against it (myFinance first — see prompt 03 — then
 * myHealth as the second consumer). Pieces:
 *
 *   - **Contributor interface** — a module declares, per access tier, what it exposes
 *     ({@link BreakGlassContributor}). The module does its OWN redaction; core only
 *     assembles + tier-filters.
 *   - **Tier redaction** — a recipient at tier T sees every section whose `minTier ≤ T`
 *     (tiers ordered low→high). {@link buildSnapshot}.
 *   - **Recipient slice-wrapping** — seal a snapshot under a **system-generated
 *     high-entropy passphrase** the user hands the recipient out-of-band. Zero-knowledge:
 *     the vendor (and any escrow) only ever holds ciphertext. {@link wrapSlice}.
 *   - **Free standalone reader** — {@link openSlice} opens a slice with ONLY the passphrase:
 *     no account, no license, no entitlement. The safety floor stays free + login-less.
 *   - **Grant ledger + audit log + staleness/trigger** — schemas + pure helpers for who
 *     holds what tier, an append-only audit trail, and the dead-man's-switch condition.
 *     (Escrow *release* is gated by `account`'s 2FA in Phase 4; decryption is ALWAYS the
 *     passphrase — 2FA never decrypts.)
 *
 * ⚠ CRYPTO subsystem — flagged for human review (break-glass disclosure; never vendor-held).
 */
import { encryptJson, decryptJson } from "../crypto/index.js";
import { generateRecoveryKey } from "../recovery/index.js";
import { createTableSql, tableName, type SqlDb } from "../db/index.js";
import type { SchemaDescriptor } from "../schema/index.js";

const SLICE_AAD = "sharedcorelib/breakglass/slice/v1";

// ── Contributor contract (frozen) ───────────────────────────────────────────

/** An access tier label, e.g. "nominee" | "executor" | "full". Ordered low→high in config. */
export type BreakGlassTier = string;

/** One disclosable section a module exposes, already redacted by that module. */
export interface ContributorSection {
  /** The contributing module/app id (provenance + audit). */
  module: string;
  /** Minimum tier a recipient needs to see this section. */
  minTier: BreakGlassTier;
  title: string;
  /** Redacted, recipient-safe data. The module guarantees nothing above `minTier` leaks here. */
  data: Record<string, unknown>;
}

/**
 * A module's break-glass contributor. The app implements this in its OWN repo (myFinance
 * lifts its existing logic onto this shape); core never holds module-specific strings.
 */
export interface BreakGlassContributor {
  module: string;
  /** All sections this module can disclose, each tagged with its `minTier`. */
  sections(): ContributorSection[] | Promise<ContributorSection[]>;
}

/** A redacted, recipient-facing snapshot at a given tier. */
export interface BreakGlassSnapshot {
  tier: BreakGlassTier;
  generatedAt: string;
  sections: ContributorSection[];
}

const tierRank = (order: BreakGlassTier[], t: BreakGlassTier): number => {
  const i = order.indexOf(t);
  if (i < 0) throw new Error(`unknown break-glass tier: ${t}`);
  return i;
};

/**
 * Assemble a tier-redacted snapshot: collect every contributor's sections and keep only
 * those whose `minTier ≤ recipientTier`. Pure (clock is injected for determinism).
 */
export async function buildSnapshot(
  contributors: BreakGlassContributor[],
  recipientTier: BreakGlassTier,
  tierOrder: BreakGlassTier[],
  opts: { now?: string } = {},
): Promise<BreakGlassSnapshot> {
  const max = tierRank(tierOrder, recipientTier);
  const sections: ContributorSection[] = [];
  for (const c of contributors) {
    for (const s of await c.sections()) {
      if (tierRank(tierOrder, s.minTier) <= max) sections.push(s);
    }
  }
  return { tier: recipientTier, generatedAt: opts.now ?? new Date().toISOString(), sections };
}

// ── Recipient slice (zero-knowledge) + free reader ──────────────────────────

/** A system-generated high-entropy passphrase the user hands a recipient out-of-band. */
export function generateRecipientPassphrase(): string {
  return generateRecoveryKey(20, 5);
}

/** Seal a snapshot for a recipient under their passphrase. The blob is opaque ciphertext. */
export async function wrapSlice(snapshot: BreakGlassSnapshot, passphrase: string): Promise<Uint8Array> {
  return encryptJson(snapshot, passphrase.replace(/[\s-]+/g, "").toUpperCase(), { aad: SLICE_AAD });
}

/**
 * Open a recipient slice with ONLY the passphrase — no account, no license, no entitlement.
 * This is the free standalone reader path; never gate it. Throws on a wrong passphrase.
 */
export async function openSlice(blob: Uint8Array, passphrase: string): Promise<BreakGlassSnapshot> {
  return decryptJson<BreakGlassSnapshot>(blob, passphrase.replace(/[\s-]+/g, "").toUpperCase(), { aad: SLICE_AAD });
}

// ── Escrow-release hook (release gated by account's 2FA; decrypt is ALWAYS the passphrase) ──

export interface BreakGlassEscrow {
  /** Push the recipient slice as ciphertext (registered tier). */
  publish(recipientId: string, blob: Uint8Array): Promise<void>;
  /**
   * Release the ciphertext to a recipient. The 2FA/dead-man's-switch GATE lives in
   * `account`; this only returns the (still-encrypted) blob. Decryption needs the passphrase.
   */
  release(recipientId: string): Promise<Uint8Array | null>;
}

// ── Staleness / dead-man's-switch trigger (pure) ────────────────────────────

export interface StalenessPolicy {
  /** Days of no "I'm here" heartbeat before a break-glass release becomes eligible. */
  thresholdDays: number;
}

/** True when `now - lastSeen ≥ thresholdDays` — the release becomes eligible (user is notified first). */
export function isReleaseEligible(policy: StalenessPolicy, lastSeenIso: string, nowIso: string): boolean {
  const days = (Date.parse(nowIso) - Date.parse(lastSeenIso)) / 86_400_000;
  return Number.isFinite(days) && days >= policy.thresholdDays;
}

// ── Grant ledger + audit log (schemas + store) ──────────────────────────────

export const BREAKGLASS_GRANT_SCHEMA: SchemaDescriptor = {
  namespace: "common", name: "BreakGlassGrant", plural: "BreakGlassGrants",
  dbAlias: "common_breakglass_grant", schemaType: "Table", confidentiality: "Restricted",
  owner: "common", shared: true,
  purpose: "Who may break-glass into the user's data, and at which tier.",
  fields: [
    { name: "recipient_id", dataType: "id", keyField: true, description: "stable recipient id (a person_key or external contact id)" },
    { name: "person_key", dataType: "id", index: "NonUnique", description: "the recipient as a person, if modeled" },
    { name: "tier", dataType: "string", required: true, description: "granted access tier" },
    { name: "status", dataType: "string", required: true, description: "pending|active|revoked" },
    { name: "created_at", dataType: "date", description: "ISO timestamp" },
    { name: "source_app", dataType: "string", description: "app id that wrote this grant" },
  ],
};

export const BREAKGLASS_AUDIT_SCHEMA: SchemaDescriptor = {
  namespace: "common", name: "BreakGlassAudit", plural: "BreakGlassAudits",
  dbAlias: "common_breakglass_audit", schemaType: "Table", confidentiality: "Restricted",
  owner: "common", shared: true,
  purpose: "Append-only audit trail of break-glass grants, snapshots, and releases.",
  fields: [
    { name: "id", dataType: "id", keyField: true, description: "audit row id" },
    { name: "ts", dataType: "date", required: true, index: "NonUnique", description: "ISO timestamp" },
    { name: "actor", dataType: "string", description: "who/what performed the action" },
    { name: "action", dataType: "string", required: true, description: "grant|revoke|snapshot|publish|release" },
    { name: "detail", dataType: "string", description: "free-text detail (no secrets)" },
  ],
};

export const BREAKGLASS_SCHEMAS: SchemaDescriptor[] = [BREAKGLASS_GRANT_SCHEMA, BREAKGLASS_AUDIT_SCHEMA];

export interface BreakGlassGrant {
  recipient_id: string;
  person_key?: string | null;
  tier: BreakGlassTier;
  status: "pending" | "active" | "revoked";
  created_at?: string | null;
  source_app?: string | null;
}

export interface BreakGlassAuditRow {
  id: string;
  ts: string;
  actor?: string | null;
  action: "grant" | "revoke" | "snapshot" | "publish" | "release";
  detail?: string | null;
}

export interface BreakGlassLedger {
  ensure(): Promise<void>;
  grants(): Promise<BreakGlassGrant[]>;
  putGrant(g: BreakGlassGrant): Promise<void>;
  /** Append an audit row (append-only). */
  audit(row: BreakGlassAuditRow): Promise<void>;
  auditLog(): Promise<BreakGlassAuditRow[]>;
}

const qi = (s: string) => `"${s.replace(/[^A-Za-z0-9_]/g, "_")}"`;

export function createBreakGlassLedger(db: SqlDb, opts: { appId: string }): BreakGlassLedger {
  const gT = qi(tableName(BREAKGLASS_GRANT_SCHEMA));
  const aT = qi(tableName(BREAKGLASS_AUDIT_SCHEMA));
  return {
    ensure: async () => {
      for (const s of BREAKGLASS_SCHEMAS) for (const sql of createTableSql(s)) await db.execute(sql);
    },
    grants: () => db.select<BreakGlassGrant>(`SELECT * FROM ${gT}`),
    putGrant: async (g) => {
      const row = { ...g, source_app: g.source_app ?? opts.appId };
      const cols = ["recipient_id", "person_key", "tier", "status", "created_at", "source_app"] as const;
      await db.execute(
        `INSERT OR REPLACE INTO ${gT} (${cols.map(qi).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
        cols.map((c) => row[c] ?? null),
      );
    },
    audit: async (r) => {
      const cols = ["id", "ts", "actor", "action", "detail"] as const;
      await db.execute(
        `INSERT OR REPLACE INTO ${aT} (${cols.map(qi).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`,
        cols.map((c) => r[c] ?? null),
      );
    },
    auditLog: () => db.select<BreakGlassAuditRow>(`SELECT * FROM ${aT} ORDER BY ts`),
  };
}
