/**
 * Progressive-disclosure visibility — the "one tier ahead" rule, app-agnostic
 * (promoted from myHealth, Phase 6). Every suite app opens minimal and reveals
 * depth as the user earns it: a tier-gated feature is teased (a *nudge* with a
 * one-line CTA) only to users EXACTLY one tier below it, and HIDDEN to anyone
 * further down — so a newcomer never sees features several tiers away.
 *
 * Three visibility states drive that:
 *   - open   — the feature is unlocked; render normally.
 *   - nudge  — locked, but shown with a CTA pointing at the single next action.
 *   - hidden — locked and NOT rendered (two or more tiers away).
 *
 * The MECHANISM (the rank-gap rule + the gate/tier resolvers) lives here. Each
 * APP supplies the data it can't share: its flag shape, its gate definitions,
 * its tier ranking, and how to read the highest cleared rank from the flags —
 * injected via {@link TierDisclosure}. Mirrors the FeatureGate/FeatureGuard split.
 */
import type { FeatureGate } from "./index.js";

/** The three progressive-disclosure states for any gated surface. */
export type GateVisibility = "open" | "nudge" | "hidden";

/**
 * A {@link FeatureGate} that participates in tiered disclosure. A gate is EITHER
 * tier-gated (`tier` set → visibility follows the one-tier-ahead rule) OR a
 * non-tiered prerequisite gate (e.g. "add a family member") that carries a static
 * `lockBehavior`. The two are mutually exclusive.
 */
export interface TieredGate<TFlags, K extends string = string, T extends string = string>
  extends FeatureGate<TFlags, K> {
  /** The tier this feature unlocks at. When set, visibility = the one-tier-ahead rule. */
  tier?: T;
  /** Static lock behavior for a prerequisite (non-tier) gate. Ignored when `tier` is set. */
  lockBehavior?: "nudge" | "hide";
}

/**
 * The core rule, expressed on a rank GAP (`requiredRank - clearedRank`):
 * cleared ⇒ open, exactly one ahead ⇒ nudge, two or more ahead ⇒ hidden.
 */
export function rankVisibility(gap: number): GateVisibility {
  if (gap <= 0) return "open";
  return gap === 1 ? "nudge" : "hidden";
}

/**
 * App-injected tier knowledge: rank a tier (ascending; the base/Starter tier is 0)
 * and read the highest tier rank the current flags clear. Keeps every app-specific
 * name and predicate out of core.
 */
export interface TierDisclosure<TFlags, T extends string> {
  /** Ascending rank for an earned tier (1-based; the base tier is 0). */
  rankOf: (tier: T) => number;
  /** The highest earned-tier rank the flags currently clear (0 = base tier). */
  clearedRank: (flags: TFlags) => number;
}

/** Visibility for a TIER by the one-tier-ahead rule. */
export function tierVisibility<TFlags, T extends string>(
  tier: T,
  flags: TFlags,
  disclosure: TierDisclosure<TFlags, T>,
): GateVisibility {
  return rankVisibility(disclosure.rankOf(tier) - disclosure.clearedRank(flags));
}

/**
 * Visibility for a GATE: an unlocked gate is open; a tier-gated one defers to
 * {@link tierVisibility}; a prerequisite gate honors its static `lockBehavior`.
 */
export function gateVisibility<TFlags, K extends string, T extends string>(
  gate: TieredGate<TFlags, K, T>,
  flags: TFlags,
  disclosure: TierDisclosure<TFlags, T>,
): GateVisibility {
  if (gate.isUnlocked(flags)) return "open";
  if (gate.tier != null) return tierVisibility(gate.tier, flags, disclosure);
  return gate.lockBehavior === "nudge" ? "nudge" : "hidden";
}
