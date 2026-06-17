import { describe, it, expect } from "vitest";
import {
  rankVisibility,
  tierVisibility,
  gateVisibility,
  type TieredGate,
  type TierDisclosure,
} from "./disclosure.js";

// A tiny app model: a 3-tier ladder (t1 < t2 < t3) with boolean flags.
interface Flags { has1: boolean; has2: boolean; has3: boolean; hasPrereq: boolean }
type Tier = "t1" | "t2" | "t3";

const RANK: Record<Tier, number> = { t1: 1, t2: 2, t3: 3 };
const disclosure: TierDisclosure<Flags, Tier> = {
  rankOf: (t) => RANK[t],
  clearedRank: (f) => (f.has3 ? 3 : f.has2 ? 2 : f.has1 ? 1 : 0),
};
const flags = (over: Partial<Flags> = {}): Flags => ({
  has1: false, has2: false, has3: false, hasPrereq: false, ...over,
});

describe("rankVisibility — the one-tier-ahead rule", () => {
  it("cleared (gap ≤ 0) → open, exactly one ahead → nudge, further → hidden", () => {
    expect(rankVisibility(-1)).toBe("open");
    expect(rankVisibility(0)).toBe("open");
    expect(rankVisibility(1)).toBe("nudge");
    expect(rankVisibility(2)).toBe("hidden");
    expect(rankVisibility(5)).toBe("hidden");
  });
});

describe("tierVisibility", () => {
  it("reveals exactly one tier ahead from the cleared rank", () => {
    expect(tierVisibility("t1", flags(), disclosure)).toBe("nudge"); // base, one below
    expect(tierVisibility("t2", flags(), disclosure)).toBe("hidden"); // two below
    expect(tierVisibility("t1", flags({ has1: true }), disclosure)).toBe("open");
    expect(tierVisibility("t2", flags({ has1: true }), disclosure)).toBe("nudge");
    expect(tierVisibility("t3", flags({ has1: true, has2: true }), disclosure)).toBe("nudge");
    expect(tierVisibility("t3", flags({ has1: true, has2: true, has3: true }), disclosure)).toBe("open");
  });
});

describe("gateVisibility", () => {
  const tierGate: TieredGate<Flags, "feat2", Tier> = {
    key: "feat2",
    isUnlocked: (f) => f.has2,
    tier: "t2",
    lockedTitle: "Feature 2",
    unlockHint: "Reach tier 2.",
    ctaLabel: "Go",
  };
  const prereqNudge: TieredGate<Flags, "prereq", Tier> = {
    key: "prereq",
    isUnlocked: (f) => f.hasPrereq,
    lockBehavior: "nudge",
    lockedTitle: "Prereq",
    unlockHint: "Do the prerequisite.",
    ctaLabel: "Go",
  };
  const prereqHide: TieredGate<Flags, "secret", Tier> = {
    ...prereqNudge, key: "secret", lockBehavior: "hide",
  };

  it("an unlocked gate is open regardless of tier", () => {
    expect(gateVisibility(tierGate, flags({ has2: true }), disclosure)).toBe("open");
  });
  it("a locked tier gate follows the one-tier-ahead rule", () => {
    expect(gateVisibility(tierGate, flags(), disclosure)).toBe("hidden"); // two below
    expect(gateVisibility(tierGate, flags({ has1: true }), disclosure)).toBe("nudge"); // one below
  });
  it("a prerequisite gate honors its static lockBehavior", () => {
    expect(gateVisibility(prereqNudge, flags(), disclosure)).toBe("nudge");
    expect(gateVisibility(prereqNudge, flags({ hasPrereq: true }), disclosure)).toBe("open");
    expect(gateVisibility(prereqHide, flags(), disclosure)).toBe("hidden");
  });
});
