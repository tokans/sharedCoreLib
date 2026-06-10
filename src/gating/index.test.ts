import { describe, it, expect } from "vitest";
import {
  isFeatureUnlocked, revealKey, PRIMARY_USER_KEY, pickNudge, FeatureGuard,
  type FeatureGate, type NudgeContext, type Nudge,
} from "./index.js";

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
