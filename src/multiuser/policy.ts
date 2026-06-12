/**
 * Member-class feature policy (K0.4.2) — the **UI-soft** gating layer for multi-user.
 *
 * A policy maps `(member_class, feature)` → allowed/denied so apps can hide or lock
 * features from restricted members (e.g. a `child_user`). React-free and DI-pure: the
 * app builds a policy from rules and feeds the verdict into the person-linked
 * `FeatureGuard` (additive `memberAccess` prop in `sharedcorelib/gating`).
 *
 * ⚠ SOFT gating ONLY. This layer makes **no confidentiality claims**: a denied feature
 * is hidden/locked in the UI, nothing more. Data that must be unreadable by another
 * member belongs in a private compartment (`sharedcorelib/multiuser` compartment
 * primitives) — that boundary is crypto-hard; this one is cosmetic.
 *
 * Semantics:
 *   - Rules are evaluated in order; the FIRST rule matching `(memberClass, feature)`
 *     decides (`allow`/`deny`). No matching rule ⇒ ALLOWED (additive: a free
 *     single-user app that configures nothing behaves exactly as today).
 *   - An absent/null member class is normalized to `owner` (the single primary user).
 *   - A rule matches a feature by explicit key (`features`) and/or by generic
 *     sensitivity **category tags** (`categories`) the app attaches to its gates —
 *     core never hard-codes app feature strings. A rule with neither matches EVERY
 *     feature of the targeted classes.
 */
import { memberClassOf, type MemberClass } from "../entities/index.js";

/** One `(member_class, feature)` policy rule. First match wins. */
export interface MemberClassRule {
  /** Class(es) this rule targets; `"*"` = every class. */
  memberClass: MemberClass | MemberClass[] | "*";
  effect: "allow" | "deny";
  /** Explicit feature keys this rule targets; `"*"` = every feature. */
  features?: string[] | "*";
  /** Generic sensitivity categories (matched against the categories the app tags a feature with). */
  categories?: string[];
}

/** The compiled policy: a pure `(member_class, feature)` → allowed verdict. */
export interface MemberClassPolicy {
  /**
   * Is `feature` allowed for a member of `memberClass`? `categories` are the app's
   * sensitivity tags for that feature (used by category-based rules). Absent/null
   * member class ⇒ `owner`. No matching rule ⇒ true.
   */
  isFeatureAllowed(
    memberClass: MemberClass | string | null | undefined,
    feature: string,
    categories?: readonly string[],
  ): boolean;
  /** The rules this policy was built from (introspection/debugging). */
  readonly rules: readonly MemberClassRule[];
}

function ruleTargetsClass(rule: MemberClassRule, mc: MemberClass): boolean {
  if (rule.memberClass === "*") return true;
  return Array.isArray(rule.memberClass) ? rule.memberClass.includes(mc) : rule.memberClass === mc;
}

function ruleTargetsFeature(rule: MemberClassRule, feature: string, categories: readonly string[]): boolean {
  if (rule.features === undefined && rule.categories === undefined) return true; // class-wide rule
  if (rule.features === "*") return true;
  if (rule.features?.includes(feature)) return true;
  return (rule.categories ?? []).some((c) => categories.includes(c));
}

/** Build a {@link MemberClassPolicy} from ordered rules (first match wins; default allow). */
export function createMemberClassPolicy(rules: MemberClassRule[]): MemberClassPolicy {
  const frozen = [...rules];
  return {
    rules: frozen,
    isFeatureAllowed: (memberClass, feature, categories = []) => {
      const mc = memberClassOf({ member_class: memberClass ?? null });
      for (const rule of frozen) {
        if (ruleTargetsClass(rule, mc) && ruleTargetsFeature(rule, feature, categories)) {
          return rule.effect === "allow";
        }
      }
      return true; // no rule ⇒ allowed (single-user/free behavior unchanged)
    },
  };
}

// ── Child-soft defaults ──────────────────────────────────────────────────────

/**
 * Generic sensitivity categories the default child-soft rule-set hides. These are
 * VOCABULARY, not app ids: an app tags its own gates (e.g. a net-worth page as
 * `"finance"`, a password manager as `"credentials"`, nominee/will features as
 * `"estate"`) and the default rules hide anything so tagged from `child_user` /
 * `managed_dependent` members.
 */
export const SENSITIVE_FEATURE_CATEGORIES = ["finance", "credentials", "estate"] as const;

/** A generic sensitivity category from the default vocabulary. */
export type SensitiveFeatureCategory = (typeof SENSITIVE_FEATURE_CATEGORIES)[number];

/**
 * The documented default rule-set: deny sensitive-category features to `child_user`
 * and `managed_dependent`; everything else (and every other class) stays allowed.
 * UI-soft only — see the module header.
 */
export const CHILD_SOFT_DEFAULT_RULES: readonly MemberClassRule[] = [
  {
    memberClass: ["child_user", "managed_dependent"],
    effect: "deny",
    categories: [...SENSITIVE_FEATURE_CATEGORIES],
  },
];

/**
 * Convenience: a policy of `extraRules` (evaluated first — the app's overrides) followed
 * by {@link CHILD_SOFT_DEFAULT_RULES}.
 */
export function createChildSoftPolicy(extraRules: MemberClassRule[] = []): MemberClassPolicy {
  return createMemberClassPolicy([...extraRules, ...CHILD_SOFT_DEFAULT_RULES]);
}
