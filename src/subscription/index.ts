/**
 * One suite subscription (decision 20) — the single paid entitlement across the
 * whole suite.
 *
 * Model:
 *   - ONE active subscription unlocks everything non-free in EVERY app
 *     ({@link SUITE_UNLOCKS}: myLifeAssistant, myWorkAssistant, and the embedded
 *     premium in the free apps). There is no per-product subscription, no
 *     cross-discount, and NO Patron/Partner tier — a suite subscriber already sits
 *     above what those grant elsewhere.
 *   - There are exactly THREE pricing tiers — `essential | plus | max`. ALL product
 *     FEATURES are available from the first (essential) tier; tiers differ only on
 *     three cost-linked axes:
 *       1. CLOUD-TOKEN ALLOWANCE — the cloud-leg-through-backend is metered (local
 *          SLM usage and BYO keys are not). The primary axis for plus/max.
 *       2. MODEL ACCESS — essential & plus may use our own-hosted models or cheaper
 *          third-party frontier; `max` additionally unlocks the latest frontier
 *          models ({@link allowedModelClasses}).
 *       3. MARKETPLACE EARNING — essential publishes freeware only; plus & max may
 *          MONETIZE what they publish ({@link marketplacePublishMode}).
 *   - BYO inference keys BYPASS the allowance caps entirely. Nothing degrades
 *     silently at the cap: {@link cloudTurnDecision} returns explicit user choices.
 *
 * This module computes entitlement / metering / policy; it mints nothing and does no
 * crypto. Pure/DI: no globals, no network, no clock — callers pass `nowIso`. The
 * persisted subscription record + its DAO live in {@link ./store}.
 */

// ── Tiers ────────────────────────────────────────────────────────────────────

/** The three suite pricing tiers, low → high. */
export type SuiteTierId = "essential" | "plus" | "max";

/** Tier ids in ascending order (price/allowance/access all increase along it). */
export const SUITE_TIER_IDS: readonly SuiteTierId[] = ["essential", "plus", "max"] as const;

/**
 * Inference model classes a tier may route the cloud leg to:
 *   - `own-hosted` — our own-hosted models;
 *   - `third-party-economy` — cheaper third-party frontier models;
 *   - `frontier-latest` — the latest frontier models (the premium of `max`).
 */
export type ModelAccessClass = "own-hosted" | "third-party-economy" | "frontier-latest";

/** How a tier may publish to the marketplace. */
export type MarketplacePublishMode = "freeware" | "monetizable";

export interface SuiteTier {
  id: SuiteTierId;
  label: string;
  /** Cloud tokens included per billing period — the primary axis tiers differ on. */
  cloudTokenAllowance: number;
  /** Inference model classes the cloud leg may use at this tier. */
  modelAccess: readonly ModelAccessClass[];
  /** Whether published marketplace items may be monetized (else freeware-only). */
  marketplacePublish: MarketplacePublishMode;
}

/**
 * The tier ladder. Allowance numbers are the product defaults; PRICE lives in the
 * injected {@link PricingPolicy} (price tracks cost — never hard-coded here). Model
 * access and marketplace-earning are policy, not price.
 */
export const SUITE_TIERS: Record<SuiteTierId, SuiteTier> = {
  essential: {
    id: "essential",
    label: "Essential",
    cloudTokenAllowance: 200_000,
    modelAccess: ["own-hosted", "third-party-economy"],
    marketplacePublish: "freeware",
  },
  plus: {
    id: "plus",
    label: "Plus",
    cloudTokenAllowance: 1_000_000,
    modelAccess: ["own-hosted", "third-party-economy"],
    marketplacePublish: "monetizable",
  },
  max: {
    id: "max",
    label: "Max",
    cloudTokenAllowance: 5_000_000,
    modelAccess: ["own-hosted", "third-party-economy", "frontier-latest"],
    marketplacePublish: "monetizable",
  },
};

/** Ascending rank of a tier (essential = 0). */
export function tierRank(tier: SuiteTierId): number {
  return SUITE_TIER_IDS.indexOf(tier);
}

/** Whether `tier` is at least `min` on the ladder. */
export function tierAtLeast(tier: SuiteTierId, min: SuiteTierId): boolean {
  return tierRank(tier) >= tierRank(min);
}

/** The next tier up, or null at the top (`max`). For upsell copy. */
export function nextTier(tier: SuiteTierId): SuiteTierId | null {
  return SUITE_TIER_IDS[tierRank(tier) + 1] ?? null;
}

// ── What the one key unlocks ──────────────────────────────────────────────────

/** Everything the ONE suite subscription unlocks — all together, never piecemeal. */
export const SUITE_UNLOCKS = ["mylifeassistant", "myworkassistant", "embedded-premium"] as const;
export type SuiteUnlock = (typeof SUITE_UNLOCKS)[number];

/** The user's ONE suite subscription record (client-local; receipts live with the backend). */
export interface SuiteSubscription {
  tier: SuiteTierId;
  /** ISO expiry; the subscription is active strictly before this instant. */
  expiresAt: string;
  /** A BYO inference key is configured — allowance caps do not apply. */
  byoKey?: boolean;
}

/** Is the subscription active at `nowIso`? */
export function subscriptionActive(sub: SuiteSubscription | null | undefined, nowIso: string): boolean {
  return Boolean(sub && nowIso < sub.expiresAt);
}

/** What the one subscription unlocks right now: everything, or nothing. */
export function suiteEntitlement(
  sub: SuiteSubscription | null | undefined,
  nowIso: string,
): { premiumActive: boolean; tier: SuiteTierId | null; unlocks: readonly SuiteUnlock[] } {
  const premiumActive = subscriptionActive(sub, nowIso);
  return {
    premiumActive,
    tier: premiumActive ? sub!.tier : null,
    unlocks: premiumActive ? SUITE_UNLOCKS : [],
  };
}

/** Minimal entitlement surface a feature gate consumes (premium IS the one subscription). */
export interface SuiteEntitlement {
  premiumActive(): boolean;
  /** The active tier, or null when there is no active subscription. */
  tier(): SuiteTierId | null;
}

/**
 * Build the {@link SuiteEntitlement} a feature gate consumes. DI: the caller injects
 * how the current subscription + clock are read (e.g. a store snapshot).
 */
export function createSuiteEntitlement(
  read: () => { subscription: SuiteSubscription | null | undefined; nowIso: string },
): SuiteEntitlement {
  return {
    premiumActive: () => {
      const { subscription, nowIso } = read();
      return subscriptionActive(subscription, nowIso);
    },
    tier: () => {
      const { subscription, nowIso } = read();
      return subscriptionActive(subscription, nowIso) ? subscription!.tier : null;
    },
  };
}

// ── Model access (axis 2) ─────────────────────────────────────────────────────

/** The model classes the cloud leg may use at a tier. */
export function allowedModelClasses(tier: SuiteTierId): readonly ModelAccessClass[] {
  return SUITE_TIERS[tier].modelAccess;
}

/** Whether a tier may route to a given model class. */
export function isModelClassAllowed(tier: SuiteTierId, cls: ModelAccessClass): boolean {
  return SUITE_TIERS[tier].modelAccess.includes(cls);
}

/**
 * Enforce model access at the gateway-routing seam: throws if `tier` may not use
 * `cls`. The thrown message names the lowest tier that unlocks the class so the
 * caller can surface an upgrade nudge.
 */
export function assertModelClassAllowed(tier: SuiteTierId, cls: ModelAccessClass): void {
  if (isModelClassAllowed(tier, cls)) return;
  const unlocksAt = SUITE_TIER_IDS.find((t) => isModelClassAllowed(t, cls));
  throw new Error(
    `model class "${cls}" is not available on the ${SUITE_TIERS[tier].label} tier` +
      (unlocksAt ? ` — upgrade to ${SUITE_TIERS[unlocksAt].label} to use it` : ""),
  );
}

// ── Marketplace earning (axis 3) ──────────────────────────────────────────────

/** How this tier may publish to the marketplace (freeware-only vs monetizable). */
export function marketplacePublishMode(tier: SuiteTierId): MarketplacePublishMode {
  return SUITE_TIERS[tier].marketplacePublish;
}

/** Whether this tier may EARN on the marketplace (monetize published items). */
export function canEarnOnMarketplace(tier: SuiteTierId): boolean {
  return SUITE_TIERS[tier].marketplacePublish === "monetizable";
}

// ── Cloud-token metering (axis 1; BYO bypasses; top-ups at the cap) ────────────

/** Cloud-token usage for the CURRENT billing period (local SLM tokens never counted). */
export interface TokenUsage {
  /** Cloud-leg tokens consumed this period. */
  cloudTokensUsed: number;
  /** Extra tokens bought as inference top-ups this period. */
  topUpTokens: number;
}

export const EMPTY_USAGE: TokenUsage = { cloudTokensUsed: 0, topUpTokens: 0 };

/**
 * Tokens left this period: tier allowance + top-ups − used, floored at 0. With a BYO
 * key the caps do not apply at all → `"uncapped"`.
 */
export function remainingCloudTokens(
  sub: SuiteSubscription,
  usage: TokenUsage,
): number | "uncapped" {
  if (sub.byoKey) return "uncapped";
  const allowance = SUITE_TIERS[sub.tier].cloudTokenAllowance + usage.topUpTokens;
  return Math.max(0, allowance - usage.cloudTokensUsed);
}

/** Record cloud-leg consumption (pure — returns the new usage). */
export function recordCloudUsage(usage: TokenUsage, tokens: number): TokenUsage {
  return { ...usage, cloudTokensUsed: usage.cloudTokensUsed + Math.max(0, tokens) };
}

/** Apply a purchased inference top-up (pure — returns the new usage). */
export function applyTopUp(usage: TokenUsage, tokens: number): TokenUsage {
  return { ...usage, topUpTokens: usage.topUpTokens + Math.max(0, tokens) };
}

/** The explicit choices offered at the cap — the user decides; NEVER silent. */
export const AT_CAP_CHOICES = ["upgrade-tier", "buy-top-up", "degrade-to-local"] as const;
export type AtCapChoice = (typeof AT_CAP_CHOICES)[number];

export type CloudTurnDecision =
  /** Within allowance (or BYO) — the cloud turn may proceed. */
  | { kind: "allow"; remaining: number | "uncapped" }
  /** The allowance is exhausted; the caller MUST surface choices (never silent). */
  | { kind: "at-cap"; choices: readonly AtCapChoice[]; nudge: string }
  /** The cloud leg is not available (no active subscription / local-only mode). */
  | { kind: "unavailable"; reason: "local-only" | "no-subscription" };

/**
 * Decide whether a cloud-leg turn of `estimatedTokens` may run. Pure. Local-only mode
 * and a missing/expired subscription make the cloud leg unavailable; a BYO key is
 * always within cap; otherwise the tier allowance (+ top-ups) is enforced with an
 * EXPLICIT at-cap verdict — silent degradation is impossible by construction because
 * the decision carries the user-facing choices instead of a fallback.
 */
export function cloudTurnDecision(opts: {
  subscription: SuiteSubscription | null | undefined;
  usage: TokenUsage;
  estimatedTokens: number;
  localOnly: boolean;
  nowIso: string;
}): CloudTurnDecision {
  if (opts.localOnly) return { kind: "unavailable", reason: "local-only" };
  if (!subscriptionActive(opts.subscription, opts.nowIso)) {
    return { kind: "unavailable", reason: "no-subscription" };
  }
  const remaining = remainingCloudTokens(opts.subscription as SuiteSubscription, opts.usage);
  if (remaining === "uncapped" || remaining >= opts.estimatedTokens) {
    return { kind: "allow", remaining };
  }
  return { kind: "at-cap", choices: AT_CAP_CHOICES, nudge: NUDGE_AT_CAP };
}

/** Whether the cloud leg may run, given subscription + mode (caps are separate). */
export function cloudLegAllowed(opts: { hasActiveSubscription: boolean; localOnly: boolean }): boolean {
  if (opts.localOnly) return false;
  return opts.hasActiveSubscription;
}

// ── Pricing (per tier; price tracks cost — injected, never baked) ──────────────

export interface PricingPolicy {
  /** List price per tier, minor units. */
  tierPricesMinor: Record<SuiteTierId, number>;
  currency: string;
}

// ── Nudge copy (one-subscription wording; no Patron/Partner) ───────────────────

export const NUDGE_SUBSCRIBE =
  "One suite subscription unlocks everything premium — myLifeAssistant, myWorkAssistant and every embedded premium feature in the free apps.";

export const NUDGE_AT_CAP =
  "You've used this period's cloud-token allowance. Upgrade your tier, buy an inference top-up, or continue on the local model — your choice; we never switch silently.";

export * from "./store.js";
