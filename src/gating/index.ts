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
