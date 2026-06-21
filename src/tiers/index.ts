/**
 * Engagement-tier ladder resolution — app-agnostic, pure, no React/icons.
 *
 * An app supplies its OWN ordered ladder (N tiers, low → high), each with a local
 * `reached(ctx)` predicate over an app-defined context, and marks grant-only tiers
 * (donation/partner-style) with `grant: true`. There is NO hardcoded 3-tier ladder
 * here — myFinance ships 3 earned tiers, myHealth may ship 4; both reuse this.
 *
 * Display concerns (icon, colour, label copy) live on the app's own tier objects,
 * which extend {@link TierDef}; the generics below preserve that richer element
 * type, so `resolveTier(appTiers, ctx)` returns an app tier, not a stripped one.
 */

export interface TierDef<TCtx> {
  /** Stable key, e.g. "expert". */
  key: string;
  /** Human label. */
  label: string;
  /** One-line description of how this tier is reached. */
  criteria: string;
  /** True when the context qualifies for this tier. */
  reached: (ctx: TCtx) => boolean;
  /**
   * Grant-only tier (e.g. patron/partner) — activated by an external signal, not
   * progressed toward. Excluded from {@link nextEarnedTiers}. A grant tier may
   * still outrank earned ones if it is placed later in the ladder.
   */
  grant?: boolean;
}

/**
 * The highest tier whose predicate the context satisfies. The ladder is given
 * low → high; resolution walks it highest-first, so a grant tier placed late
 * (e.g. patron) outranks an earlier earned tier (e.g. expert). Falls back to the
 * first (lowest) tier.
 */
export function resolveTier<TCtx, T extends TierDef<TCtx>>(tiers: T[], ctx: TCtx): T {
  for (let i = tiers.length - 1; i >= 0; i--) {
    if (tiers[i]!.reached(ctx)) return tiers[i]!;
  }
  return tiers[0]!;
}

/**
 * Whether the context clears one specific tier's OWN bar — tested against that
 * tier's predicate, NOT the resolved tier. This is what lets a higher grant tier
 * (patron) coexist with an earned-feature gate (expert) without stripping it.
 */
export function tierReached<TCtx, T extends TierDef<TCtx>>(
  tiers: T[],
  key: string,
  ctx: TCtx,
): boolean {
  const t = tiers.find((x) => x.key === key);
  return t ? t.reached(ctx) : false;
}

/**
 * Earned (non-grant) tiers the context has NOT yet reached, in ascending order —
 * the "next up" progression list. Grant tiers are excluded (they are opt-in
 * actions, not milestones); an always-reached base tier never appears.
 */
export function nextEarnedTiers<TCtx, T extends TierDef<TCtx>>(tiers: T[], ctx: TCtx): T[] {
  return tiers.filter((t) => !t.grant && !t.reached(ctx));
}

// ── Standard top tiers (Patron / Partner) — shared by EVERY suite app ─────────
//
// Patron and Partner are the highest two tiers across the whole suite, so they are
// defined ONCE here (like common masters) instead of being re-declared per app. An
// app builds its ladder as `[...itsEarnedTiers, ...decorate(standardTopTiers())]`,
// adding only display fields (icon/colour). Both are `grant` tiers:
//   - **Patron**  — granted on a donation (a receive-only completion handoff; see
//     `sharedcorelib/grant`). A Patron gets instant access to all features.
//   - **Partner** — activated when the user enrolls as a professional at tokans.org;
//     the app only RECEIVES the resulting status. Partner outranks (implies) Patron.

export const PATRON_TIER_KEY = "patron";
export const PARTNER_TIER_KEY = "partner";

/** The minimal context the standard top tiers read. App tier contexts extend this. */
export interface PatronPartnerCtx {
  /** A donation was completed (Patron). */
  isPatron: boolean;
  /** Enrolled as a professional Partner (implies Patron-level access). */
  isPartner: boolean;
}

/**
 * The two standard top tiers, low→high (patron, then partner). A Partner satisfies
 * the Patron bar too (so a Partner who never donated still unlocks Patron features).
 * Apps spread these at the END of their ladder and add display fields.
 */
export function standardTopTiers<TCtx extends PatronPartnerCtx>(): TierDef<TCtx>[] {
  return [
    {
      key: PATRON_TIER_KEY,
      label: "Patron",
      criteria: "Support the project with a donation.",
      grant: true,
      reached: (c) => c.isPatron || c.isPartner,
    },
    {
      key: PARTNER_TIER_KEY,
      label: "Partner",
      criteria: "Enroll as a professional partner.",
      grant: true,
      reached: (c) => c.isPartner,
    },
  ];
}

/** True once the context has reached Patron-level access (donated OR a Partner). */
export function hasPatronAccess(ctx: PatronPartnerCtx): boolean {
  return ctx.isPatron || ctx.isPartner;
}

// ── Dev/test tier override (pure) ─────────────────────────────────────────────
//
// A DEV-ONLY mechanism to preview a tier without meeting its real criteria, shared by
// every app (myMemories/myHealth/… each re-implemented it). The PURE resolver lives here;
// the browser plumbing (`createTierOverride`) + the floating `TestTierChooser` UI live in
// `sharedcorelib/ui` (so they sit under the already-scanned Tailwind content glob). The
// override is purely a CLIENT-SIDE preview: it grants NO real entitlement and mints nothing.

/** Override values meaning "no override" (clear the preview). */
const TIER_OVERRIDE_CLEAR = new Set(["", "clear", "off", "none", "live"]);

/**
 * Resolve a dev tier override from its sources, first valid wins: an explicit URL `?tier=`
 * value, then the persisted value, then a build-time start tier. Returns null when nothing
 * valid is set or the value is a clear sentinel. Pure — sources are injected (no `window`,
 * no `import.meta`), so it's unit-testable and SSR-safe. Matching is case-insensitive.
 */
export function resolveTierOverride(
  sources: { urlTier?: string | null; stored?: string | null; startTier?: string | null },
  validKeys: readonly string[],
): string | null {
  for (const raw of [sources.urlTier, sources.stored, sources.startTier]) {
    if (raw == null) continue;
    const v = raw.trim().toLowerCase();
    if (TIER_OVERRIDE_CLEAR.has(v)) return null;
    const match = validKeys.find((k) => k.toLowerCase() === v);
    if (match) return match;
  }
  return null;
}

/**
 * Whether to surface the **"Become a Patron"** call-to-action: visible once the user
 * has reached the SECOND earned (non-grant) tier of the ladder. Returns false if the
 * context is already a Patron (no point offering it) or the ladder has < 2 earned tiers.
 */
export function becomePatronVisible<TCtx extends PatronPartnerCtx, T extends TierDef<TCtx>>(
  tiers: T[],
  ctx: TCtx,
): boolean {
  if (hasPatronAccess(ctx)) return false;
  const second = tiers.filter((t) => !t.grant)[1];
  return second ? second.reached(ctx) : false;
}
