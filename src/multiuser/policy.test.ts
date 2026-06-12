import { describe, it, expect } from "vitest";
import {
  createMemberClassPolicy, createChildSoftPolicy,
  CHILD_SOFT_DEFAULT_RULES, SENSITIVE_FEATURE_CATEGORIES,
  type MemberClassRule,
} from "./policy.js";

describe("createMemberClassPolicy", () => {
  it("no rules ⇒ everything allowed for everyone (free single-user unchanged)", () => {
    const p = createMemberClassPolicy([]);
    expect(p.isFeatureAllowed("owner", "anything")).toBe(true);
    expect(p.isFeatureAllowed("child_user", "anything")).toBe(true);
    expect(p.isFeatureAllowed(null, "anything")).toBe(true);
  });

  it("absent/null/unknown member class normalizes to owner", () => {
    const p = createMemberClassPolicy([{ memberClass: "owner", effect: "deny", features: ["x"] }]);
    expect(p.isFeatureAllowed(null, "x")).toBe(false);
    expect(p.isFeatureAllowed(undefined, "x")).toBe(false);
    expect(p.isFeatureAllowed("garbage", "x")).toBe(false); // unknown ⇒ owner
    expect(p.isFeatureAllowed("adult", "x")).toBe(true); // rule targets owner only
  });

  it("matches by explicit feature key, by class list, and by '*'", () => {
    const p = createMemberClassPolicy([
      { memberClass: ["child_user", "managed_dependent"], effect: "deny", features: ["networth"] },
      { memberClass: "*", effect: "deny", features: ["admin-only"] },
    ]);
    expect(p.isFeatureAllowed("child_user", "networth")).toBe(false);
    expect(p.isFeatureAllowed("managed_dependent", "networth")).toBe(false);
    expect(p.isFeatureAllowed("adult", "networth")).toBe(true);
    expect(p.isFeatureAllowed("owner", "admin-only")).toBe(false);
    expect(p.isFeatureAllowed("child_user", "other")).toBe(true);
  });

  it("matches by category tags supplied per call", () => {
    const p = createMemberClassPolicy([
      { memberClass: "child_user", effect: "deny", categories: ["finance"] },
    ]);
    expect(p.isFeatureAllowed("child_user", "budgets", ["finance"])).toBe(false);
    expect(p.isFeatureAllowed("child_user", "budgets", ["health"])).toBe(true);
    expect(p.isFeatureAllowed("child_user", "budgets")).toBe(true); // untagged ⇒ no category match
    expect(p.isFeatureAllowed("adult", "budgets", ["finance"])).toBe(true);
  });

  it("first matching rule wins — an app allow-override beats a later deny", () => {
    const rules: MemberClassRule[] = [
      { memberClass: "child_user", effect: "allow", features: ["pocket-money"] },
      { memberClass: "child_user", effect: "deny", categories: ["finance"] },
    ];
    const p = createMemberClassPolicy(rules);
    expect(p.isFeatureAllowed("child_user", "pocket-money", ["finance"])).toBe(true);
    expect(p.isFeatureAllowed("child_user", "networth", ["finance"])).toBe(false);
  });

  it("a rule with neither features nor categories is class-wide", () => {
    const p = createMemberClassPolicy([{ memberClass: "managed_dependent", effect: "deny" }]);
    expect(p.isFeatureAllowed("managed_dependent", "anything")).toBe(false);
    expect(p.isFeatureAllowed("child_user", "anything")).toBe(true);
  });
});

describe("child-soft defaults (UI-soft only — no confidentiality claim)", () => {
  it("hides sensitive-category features from child_user and managed_dependent only", () => {
    const p = createChildSoftPolicy();
    for (const cat of SENSITIVE_FEATURE_CATEGORIES) {
      expect(p.isFeatureAllowed("child_user", "f", [cat])).toBe(false);
      expect(p.isFeatureAllowed("managed_dependent", "f", [cat])).toBe(false);
      expect(p.isFeatureAllowed("adult", "f", [cat])).toBe(true);
      expect(p.isFeatureAllowed("owner", "f", [cat])).toBe(true);
    }
    // non-sensitive features stay open for children
    expect(p.isFeatureAllowed("child_user", "f", ["journal"])).toBe(true);
    expect(p.isFeatureAllowed("child_user", "f")).toBe(true);
  });

  it("default vocabulary covers finance / credentials / estate", () => {
    expect([...SENSITIVE_FEATURE_CATEGORIES]).toEqual(["finance", "credentials", "estate"]);
    expect(CHILD_SOFT_DEFAULT_RULES).toHaveLength(1);
    expect(CHILD_SOFT_DEFAULT_RULES[0]!.effect).toBe("deny");
  });

  it("app extraRules are evaluated before the defaults (overridable)", () => {
    const p = createChildSoftPolicy([
      { memberClass: "child_user", effect: "allow", features: ["savings-goal"] },
    ]);
    expect(p.isFeatureAllowed("child_user", "savings-goal", ["finance"])).toBe(true);
    expect(p.isFeatureAllowed("child_user", "networth", ["finance"])).toBe(false);
  });
});
