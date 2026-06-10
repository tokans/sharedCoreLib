/**
 * FeatureGuard — app-agnostic, promoted into core (Phase 6). Renders a gated feature's
 * children when it's unlocked for the ACTIVE PERSON, else a locked fallback. Reveal/tier
 * state is person-linked (keyed by (user, app)) so multi-user works; single-user free is
 * the one primary user (`PRIMARY_USER_KEY`).
 *
 * SSR-safe + purge-safe like the rest of the UI: no `window` at import, no baked utility
 * classes — the locked UI is injected via `renderLocked` so each app keeps its look/routing.
 */
import * as React from "react";
import type { FeatureGate } from "./index.js";

export interface FeatureGuardProps<TFlags> {
  gate: FeatureGate<TFlags>;
  /** The active person's computed flags. */
  flags: TFlags;
  /** False until the first refresh resolves — render `renderLoading` (or nothing) meanwhile. */
  loaded?: boolean;
  /** The active person this guard is evaluated for (audit/keying); defaults handled by the app. */
  userKey?: string;
  children: React.ReactNode;
  /** App-supplied locked-state UI (CTA, routing, unlock-in-place dialog). */
  renderLocked: (gate: FeatureGate<TFlags>) => React.ReactNode;
  /** Optional placeholder while `loaded` is false (avoids flashing the locked screen). */
  renderLoading?: () => React.ReactNode;
}

/**
 * Gate `children` behind `gate.isUnlocked(flags)` for the active person. While `loaded` is
 * explicitly false, show `renderLoading` (or nothing) to avoid flashing a locked screen.
 */
export function FeatureGuard<TFlags>(props: FeatureGuardProps<TFlags>): React.ReactElement {
  if (props.loaded === false) {
    return <>{props.renderLoading ? props.renderLoading() : null}</>;
  }
  const unlocked = props.gate.isUnlocked(props.flags);
  return <>{unlocked ? props.children : props.renderLocked(props.gate)}</>;
}
