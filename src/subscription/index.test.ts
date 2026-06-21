import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { registerSchemas, type SqlDb } from "../db/index.js";
import {
  SUITE_TIER_IDS, SUITE_TIERS, tierRank, tierAtLeast, nextTier,
  subscriptionActive, suiteEntitlement, createSuiteEntitlement,
  allowedModelClasses, isModelClassAllowed, assertModelClassAllowed,
  marketplacePublishMode, canEarnOnMarketplace,
  EMPTY_USAGE, remainingCloudTokens, recordCloudUsage, applyTopUp, cloudTurnDecision,
  cloudLegAllowed,
  SUITE_SUBSCRIPTION_SCHEMA, createSubscriptionStore,
  type SuiteSubscription,
} from "./index.js";

const NOW = "2026-06-21T00:00:00.000Z";
const LATER = "2026-12-31T00:00:00.000Z";
const PAST = "2026-01-01T00:00:00.000Z";

function realDb(): { db: SqlDb; raw: DatabaseSync } {
  const raw = new DatabaseSync(":memory:");
  const db: SqlDb = {
    select: async (sql, params = []) => raw.prepare(sql).all(...(params as never[])) as never,
    execute: async (sql, params = []) => {
      if (!params || (params as unknown[]).length === 0) { raw.exec(sql); return {}; }
      const r = raw.prepare(sql).run(...(params as never[]));
      return { rowsAffected: Number(r.changes), lastInsertId: Number(r.lastInsertRowid) };
    },
  };
  return { db, raw };
}

describe("suite tiers — exactly three, no patron/partner", () => {
  it("has exactly essential/plus/max ascending", () => {
    expect(SUITE_TIER_IDS).toEqual(["essential", "plus", "max"]);
    expect(tierRank("essential")).toBe(0);
    expect(tierRank("max")).toBe(2);
    expect(tierAtLeast("plus", "essential")).toBe(true);
    expect(tierAtLeast("essential", "plus")).toBe(false);
    expect(nextTier("essential")).toBe("plus");
    expect(nextTier("max")).toBeNull();
  });

  it("all features available from tier 1 — tiers differ only on allowance/models/earning", () => {
    // Allowance strictly increases.
    expect(SUITE_TIERS.essential.cloudTokenAllowance).toBeLessThan(SUITE_TIERS.plus.cloudTokenAllowance);
    expect(SUITE_TIERS.plus.cloudTokenAllowance).toBeLessThan(SUITE_TIERS.max.cloudTokenAllowance);
  });
});

describe("model access (axis 2)", () => {
  it("essential & plus = own-hosted / economy; max adds frontier-latest", () => {
    expect(allowedModelClasses("essential")).toEqual(["own-hosted", "third-party-economy"]);
    expect(allowedModelClasses("plus")).toEqual(["own-hosted", "third-party-economy"]);
    expect(allowedModelClasses("max")).toContain("frontier-latest");
    expect(isModelClassAllowed("plus", "frontier-latest")).toBe(false);
    expect(isModelClassAllowed("max", "frontier-latest")).toBe(true);
  });

  it("assertModelClassAllowed throws with an upgrade hint below max", () => {
    expect(() => assertModelClassAllowed("max", "frontier-latest")).not.toThrow();
    expect(() => assertModelClassAllowed("essential", "frontier-latest")).toThrow(/Max/);
  });
});

describe("marketplace earning (axis 3)", () => {
  it("essential = freeware only; plus/max may monetize", () => {
    expect(marketplacePublishMode("essential")).toBe("freeware");
    expect(canEarnOnMarketplace("essential")).toBe(false);
    expect(canEarnOnMarketplace("plus")).toBe(true);
    expect(canEarnOnMarketplace("max")).toBe(true);
  });
});

describe("entitlement", () => {
  const sub: SuiteSubscription = { tier: "plus", expiresAt: LATER };

  it("active strictly before expiry; entitlement is all-or-nothing", () => {
    expect(subscriptionActive(sub, NOW)).toBe(true);
    expect(subscriptionActive({ tier: "max", expiresAt: PAST }, NOW)).toBe(false);
    expect(subscriptionActive(null, NOW)).toBe(false);

    const ent = suiteEntitlement(sub, NOW);
    expect(ent.premiumActive).toBe(true);
    expect(ent.tier).toBe("plus");
    expect(ent.unlocks).toContain("myworkassistant");
    expect(suiteEntitlement(null, NOW).unlocks).toEqual([]);
  });

  it("createSuiteEntitlement reflects the injected snapshot", () => {
    const ent = createSuiteEntitlement(() => ({ subscription: sub, nowIso: NOW }));
    expect(ent.premiumActive()).toBe(true);
    expect(ent.tier()).toBe("plus");
    const none = createSuiteEntitlement(() => ({ subscription: null, nowIso: NOW }));
    expect(none.premiumActive()).toBe(false);
    expect(none.tier()).toBeNull();
  });
});

describe("cloud-token metering (axis 1)", () => {
  it("allowance + top-ups − used, floored at 0; BYO is uncapped", () => {
    const plus: SuiteSubscription = { tier: "plus", expiresAt: LATER };
    let usage = recordCloudUsage(EMPTY_USAGE, 200_000);
    expect(remainingCloudTokens(plus, usage)).toBe(SUITE_TIERS.plus.cloudTokenAllowance - 200_000);
    usage = applyTopUp(usage, 50_000);
    expect(remainingCloudTokens(plus, usage)).toBe(SUITE_TIERS.plus.cloudTokenAllowance - 200_000 + 50_000);
    expect(remainingCloudTokens({ ...plus, byoKey: true }, usage)).toBe("uncapped");
  });

  it("cloudTurnDecision: allow / at-cap (explicit choices) / unavailable — never silent", () => {
    const plus: SuiteSubscription = { tier: "plus", expiresAt: LATER };
    expect(cloudTurnDecision({ subscription: plus, usage: EMPTY_USAGE, estimatedTokens: 1000, localOnly: false, nowIso: NOW }).kind).toBe("allow");
    const atCap = cloudTurnDecision({ subscription: plus, usage: { cloudTokensUsed: SUITE_TIERS.plus.cloudTokenAllowance, topUpTokens: 0 }, estimatedTokens: 1000, localOnly: false, nowIso: NOW });
    expect(atCap.kind).toBe("at-cap");
    if (atCap.kind === "at-cap") expect(atCap.choices).toContain("degrade-to-local");
    expect(cloudTurnDecision({ subscription: plus, usage: EMPTY_USAGE, estimatedTokens: 1, localOnly: true, nowIso: NOW })).toEqual({ kind: "unavailable", reason: "local-only" });
    expect(cloudTurnDecision({ subscription: null, usage: EMPTY_USAGE, estimatedTokens: 1, localOnly: false, nowIso: NOW })).toEqual({ kind: "unavailable", reason: "no-subscription" });
  });

  it("cloudLegAllowed: needs an active subscription and not local-only", () => {
    expect(cloudLegAllowed({ hasActiveSubscription: true, localOnly: false })).toBe(true);
    expect(cloudLegAllowed({ hasActiveSubscription: true, localOnly: true })).toBe(false);
    expect(cloudLegAllowed({ hasActiveSubscription: false, localOnly: false })).toBe(false);
  });
});

describe("SuiteSubscription store (shared common row)", () => {
  it("round-trips through the shared table; registerSchemas creates it", async () => {
    const { db } = realDb();
    await registerSchemas(db, [SUITE_SUBSCRIPTION_SCHEMA]);
    const store = createSubscriptionStore(db);
    expect(await store.get()).toBeNull();

    await store.set({ tier: "max", expiresAt: LATER, byoKey: true }, NOW);
    expect(await store.get()).toEqual({ tier: "max", expiresAt: LATER, byoKey: true });

    // Single row: a second set overwrites (no second subscription).
    await store.set({ tier: "essential", expiresAt: LATER }, NOW);
    expect(await store.get()).toEqual({ tier: "essential", expiresAt: LATER });

    await store.clear();
    expect(await store.get()).toBeNull();
  });

  it("ensure() creates the table standalone (no registry)", async () => {
    const { db } = realDb();
    const store = createSubscriptionStore(db);
    await store.ensure();
    await store.set({ tier: "plus", expiresAt: LATER }, NOW);
    expect((await store.get())?.tier).toBe("plus");
  });

  it("is core-owned + shared (one copy across apps)", () => {
    expect(SUITE_SUBSCRIPTION_SCHEMA.owner).toBe("common");
    expect(SUITE_SUBSCRIPTION_SCHEMA.shared).toBe(true);
  });
});
