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
import type { MemberClassPolicy } from "../multiuser/policy.js";
import type { MemberClass } from "../entities/index.js";

/**
 * ADDITIVE (K0.4.2) — member-class verdict input for a guard. When supplied, the gate is
 * ALSO checked against the `(member_class, feature)` policy: a denied feature renders the
 * locked UI even if the reveal/tier flags would unlock it. UI-SOFT only — no
 * confidentiality claim; crypto-hard boundaries are the multiuser compartments.
 */
export interface FeatureGuardMemberAccess {
  /** The app's compiled member-class policy (`createMemberClassPolicy` / `createChildSoftPolicy`). */
  policy: Pick<MemberClassPolicy, "isFeatureAllowed">;
  /** The ACTIVE member's class; absent/null ⇒ `owner` (the single primary user). */
  memberClass?: MemberClass | string | null;
  /** The app's sensitivity tags for this gate's feature (e.g. ["finance"]). */
  categories?: readonly string[];
  /** Locked UI for a member-class denial (receives the gate key); falls back to `renderLocked`. */
  renderDenied?: (gateKey: string) => React.ReactNode;
}

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
  /**
   * ADDITIVE (K0.4.2): member-class soft gate. When present, the active member's class is
   * also consulted (`policy.isFeatureAllowed(memberClass, gate.key, categories)`); a denial
   * renders `renderDenied` (else `renderLocked`). Omit it (the free single-user case) and
   * the guard behaves exactly as before.
   */
  memberAccess?: FeatureGuardMemberAccess;
}

/**
 * Gate `children` behind `gate.isUnlocked(flags)` for the active person. While `loaded` is
 * explicitly false, show `renderLoading` (or nothing) to avoid flashing a locked screen.
 * With `memberAccess` supplied, the `(member_class, feature)` policy is enforced first
 * (UI-soft — see {@link FeatureGuardMemberAccess}).
 */
export function FeatureGuard<TFlags>(props: FeatureGuardProps<TFlags>): React.ReactElement {
  if (props.loaded === false) {
    return <>{props.renderLoading ? props.renderLoading() : null}</>;
  }
  const ma = props.memberAccess;
  if (ma && !ma.policy.isFeatureAllowed(ma.memberClass, props.gate.key, ma.categories)) {
    return <>{ma.renderDenied ? ma.renderDenied(props.gate.key) : props.renderLocked(props.gate)}</>;
  }
  const unlocked = props.gate.isUnlocked(props.flags);
  return <>{unlocked ? props.children : props.renderLocked(props.gate)}</>;
}
