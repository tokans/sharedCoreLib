/**
 * Feature-gating framework — app-agnostic.
 *
 * Provides the reusable shape of a feature gate and a Zustand store factory that
 * standardises the prerequisite-tracking pattern: start locked, `refresh()` to
 * recompute flags from app data, and (critically) treat everything as UNLOCKED in
 * a plain browser / dev preview (no DB) so previews aren't stuck behind a locked
 * screen.
 *
 * The APP supplies: its flag shape, the gate definitions + copy, and the
 * `computeFlags()` adapter that queries its OWN data. The `FeatureGuard` React
 * component stays in each app because its locked-state UI, routing, and any
 * unlock-in-place dialogs are app-specific.
 */
import { create, type StoreApi, type UseBoundStore } from "zustand";
import { isTauri } from "../env/index.js";

export * from "./featureGuard.js";
export * from "./disclosure.js";

/** A progressively-unlocked feature, gated on a boolean predicate over the app's flags. */
export interface FeatureGate<TFlags, K extends string = string> {
  key: K;
  /** True when the feature is available. */
  isUnlocked: (flags: TFlags) => boolean;
  /** Headline shown on the locked screen. */
  lockedTitle: string;
  /** How to unlock — shown on the locked screen and as the nav tooltip. */
  unlockHint: string;
  /** Call-to-action button label. */
  ctaLabel: string;
  /** Where the CTA navigates. Omit when the feature unlocks in place. */
  ctaTo?: string;
}

/** Convenience predicate mirroring `gate.isUnlocked(flags)`. */
export function isFeatureUnlocked<TFlags>(gate: FeatureGate<TFlags>, flags: TFlags): boolean {
  return gate.isUnlocked(flags);
}

// ── Person-linked reveal state (Phase 6 — multi-user substrate) ──────────────
// Tier/reveal state is keyed by (user, app) so multi-user works: each person reveals the
// ladder independently. Single-user free = the one primary user (`"self"`). The key is the
// stable storage/namespacing handle for a person's reveal state in an app.

/** Canonical for the single primary user; every app agrees on this when not multi-user. */
export const PRIMARY_USER_KEY = "self";

/** Namespaced reveal-state key for (user, app[, gate]) — never collide across people/apps. */
export function revealKey(userKey: string, appId: string, gateKey?: string): string {
  const base = `reveal:${userKey}:${appId}`;
  return gateKey ? `${base}:${gateKey}` : base;
}

// ── Nudge (Phase 6) — one dismissible cross-sell at the top of the free ladder ──

export type Tier = "free" | "registered" | "patron" | "paid";

export interface NudgeContext {
  /** True once the user has revealed every FREE feature by usage (top of the ladder). */
  atTopOfFreeLadder: boolean;
  tier: Tier;
  /** Has this person already dismissed the nudge? (Person-linked.) */
  dismissed: boolean;
}

export interface Nudge {
  target: string;   // target app id (e.g. "mylifeassistant")
  title: string;
  body: string;
  ctaLabel: string;
}

/**
 * Pick the single nudge to show, or null. Rules: only at the top of the free ladder, only
 * for a non-paid user who hasn't dismissed it, only when the target app exists in the suite
 * catalog and isn't already installed. Exactly one, dismissible — never nag.
 */
export function pickNudge(
  ctx: NudgeContext,
  opts: { target: Nudge; catalogHas: (appId: string) => boolean; installed: (appId: string) => boolean },
): Nudge | null {
  if (ctx.dismissed) return null;
  if (ctx.tier === "paid") return null;
  if (!ctx.atTopOfFreeLadder) return null;
  if (!opts.catalogHas(opts.target.target) || opts.installed(opts.target.target)) return null;
  return opts.target;
}

export interface GatingStoreConfig<TFlags extends object> {
  /** Flag values before the first refresh (typically all-locked). */
  initialFlags: TFlags;
  /** Flags returned in a browser/dev preview (no DB) so previews aren't locked. */
  unlockedAll: TFlags;
  /** Compute live flags from the app's own data. Only invoked inside Tauri. */
  computeFlags: () => Promise<Partial<TFlags>>;
  /**
   * Optional entitlement override: when this resolves true, ALL features unlock
   * (`unlockedAll`) without consulting `computeFlags`. Wire it to Patron/Partner
   * status (`hasPatronAccess`) so a Patron gets instant access to every feature.
   */
  override?: () => Promise<boolean>;
}

/** Bookkeeping added to the app's flag fields in the store. */
export interface GatingState {
  /** False until the first refresh resolves (avoid flashing a locked screen). */
  loaded: boolean;
  /** Recompute the flags from app data (or unlock-all in a browser). */
  refresh: () => Promise<void>;
}

/**
 * Build a Zustand store of `TFlags & GatingState`. Identical pattern across apps;
 * only the three config adapters differ.
 */
export function createGatingStore<TFlags extends object>(
  cfg: GatingStoreConfig<TFlags>,
): UseBoundStore<StoreApi<TFlags & GatingState>> {
  return create<TFlags & GatingState>((set) => ({
    ...cfg.initialFlags,
    loaded: false,
    refresh: async () => {
      if (!isTauri()) {
        set({ ...cfg.unlockedAll, loaded: true } as Partial<TFlags & GatingState>);
        return;
      }
      try {
        // A Patron/Partner unlocks everything — skip the per-feature computation.
        if (cfg.override && (await cfg.override())) {
          set({ ...cfg.unlockedAll, loaded: true } as Partial<TFlags & GatingState>);
          return;
        }
        const flags = await cfg.computeFlags();
        set({ ...flags, loaded: true } as Partial<TFlags & GatingState>);
      } catch (e) {
        console.error("Failed to refresh feature gating:", e);
        set({ loaded: true } as Partial<TFlags & GatingState>);
      }
    },
  }));
}
