import { describe, it, expect } from "vitest";
import {
  isFeatureUnlocked, revealKey, PRIMARY_USER_KEY, pickNudge, FeatureGuard,
  type FeatureGate, type NudgeContext, type Nudge,
} from "./index.js";
import { createChildSoftPolicy } from "../multiuser/policy.js";

interface Flags { pro: boolean }
const gate: FeatureGate<Flags> = {
  key: "pro", isUnlocked: (f) => f.pro, lockedTitle: "Pro", unlockHint: "use more", ctaLabel: "Unlock",
};

describe("feature predicate + person-linked keys", () => {
  it("isFeatureUnlocked mirrors the gate", () => {
    expect(isFeatureUnlocked(gate, { pro: true })).toBe(true);
    expect(isFeatureUnlocked(gate, { pro: false })).toBe(false);
  });
  it("revealKey namespaces by (user, app, gate) — no cross-person/app collision", () => {
    expect(revealKey(PRIMARY_USER_KEY, "myfinance")).toBe("reveal:self:myfinance");
    expect(revealKey("spouse", "myfinance", "pro")).toBe("reveal:spouse:myfinance:pro");
    expect(revealKey("self", "myfinance")).not.toBe(revealKey("spouse", "myfinance"));
  });
});

describe("nudge", () => {
  const target: Nudge = { target: "mylifeassistant", title: "Meet myLifeAssistant", body: "...", ctaLabel: "Explore" };
  const ctx: NudgeContext = { atTopOfFreeLadder: true, tier: "registered", dismissed: false };
  const opts = { target, catalogHas: () => true, installed: () => false };

  it("shows exactly one nudge at the top of the free ladder for a non-paid, non-dismissed user", () => {
    expect(pickNudge(ctx, opts)).toEqual(target);
  });
  it("suppressed when dismissed, paid, not-at-top, already installed, or not in catalog", () => {
    expect(pickNudge({ ...ctx, dismissed: true }, opts)).toBeNull();
    expect(pickNudge({ ...ctx, tier: "paid" }, opts)).toBeNull();
    expect(pickNudge({ ...ctx, atTopOfFreeLadder: false }, opts)).toBeNull();
    expect(pickNudge(ctx, { ...opts, installed: () => true })).toBeNull();
    expect(pickNudge(ctx, { ...opts, catalogHas: () => false })).toBeNull();
  });
});

describe("FeatureGuard (person-linked render gate)", () => {
  it("renders children when unlocked; renderLocked when locked; loading placeholder while not loaded", () => {
    const unlocked = FeatureGuard({ gate, flags: { pro: true }, children: "CONTENT", renderLocked: () => "LOCKED" });
    expect(unlocked.props.children).toBe("CONTENT");
    const locked = FeatureGuard({ gate, flags: { pro: false }, children: "CONTENT", renderLocked: () => "LOCKED" });
    expect(locked.props.children).toBe("LOCKED");
    const loading = FeatureGuard({ gate, flags: { pro: true }, loaded: false, children: "CONTENT", renderLocked: () => "LOCKED", renderLoading: () => "WAIT" });
    expect(loading.props.children).toBe("WAIT");
  });
});

describe("FeatureGuard memberAccess glue (K0.4.2 — UI-soft member-class gate)", () => {
  const childPolicy = createChildSoftPolicy();

  it("without memberAccess the guard behaves exactly as before (free single-user unchanged)", () => {
    const el = FeatureGuard({ gate, flags: { pro: true }, children: "CONTENT", renderLocked: () => "LOCKED" });
    expect(el.props.children).toBe("CONTENT");
  });

  it("a member-class denial renders the locked UI even when flags unlock the feature", () => {
    const el = FeatureGuard({
      gate, flags: { pro: true }, children: "CONTENT", renderLocked: () => "LOCKED",
      memberAccess: { policy: childPolicy, memberClass: "child_user", categories: ["finance"] },
    });
    expect(el.props.children).toBe("LOCKED");
  });

  it("renderDenied takes precedence over renderLocked for a member-class denial", () => {
    const el = FeatureGuard({
      gate, flags: { pro: true }, children: "CONTENT", renderLocked: () => "LOCKED",
      memberAccess: {
        policy: childPolicy, memberClass: "child_user", categories: ["finance"],
        renderDenied: (key) => `DENIED:${key}`,
      },
    });
    expect(el.props.children).toBe("DENIED:pro");
  });

  it("an allowed member class falls through to the normal flag gate", () => {
    const open = FeatureGuard({
      gate, flags: { pro: true }, children: "CONTENT", renderLocked: () => "LOCKED",
      memberAccess: { policy: childPolicy, memberClass: "adult", categories: ["finance"] },
    });
    expect(open.props.children).toBe("CONTENT");
    const stillFlagLocked = FeatureGuard({
      gate, flags: { pro: false }, children: "CONTENT", renderLocked: () => "LOCKED",
      memberAccess: { policy: childPolicy, memberClass: "adult", categories: ["finance"] },
    });
    expect(stillFlagLocked.props.children).toBe("LOCKED");
  });

  it("absent member class ⇒ owner ⇒ never denied by the child-soft defaults", () => {
    const el = FeatureGuard({
      gate, flags: { pro: true }, children: "CONTENT", renderLocked: () => "LOCKED",
      memberAccess: { policy: childPolicy, categories: ["finance", "credentials", "estate"] },
    });
    expect(el.props.children).toBe("CONTENT");
  });
});
