import { describe, it, expect } from "vitest";
import {
  standardTopTiers, hasPatronAccess, becomePatronVisible, resolveTier,
  type TierDef, type PatronPartnerCtx,
} from "./index.js";

interface Ctx extends PatronPartnerCtx { days: number }
const earned: TierDef<Ctx>[] = [
  { key: "newcomer", label: "Newcomer", criteria: "start", reached: () => true },
  { key: "regular", label: "Regular", criteria: "7 days", reached: (c) => c.days >= 7 },
  { key: "expert", label: "Expert", criteria: "20 days", reached: (c) => c.days >= 20 },
];
const ladder: TierDef<Ctx>[] = [...earned, ...standardTopTiers<Ctx>()];
const ctx = (over: Partial<Ctx> = {}): Ctx => ({ days: 0, isPatron: false, isPartner: false, ...over });

describe("standard top tiers (Patron / Partner)", () => {
  it("are grant tiers in order patron→partner", () => {
    const top = standardTopTiers<Ctx>();
    expect(top.map((t) => t.key)).toEqual(["patron", "partner"]);
    expect(top.every((t) => t.grant)).toBe(true);
  });

  it("resolve highest: partner outranks patron, patron outranks earned", () => {
    expect(resolveTier(ladder, ctx({ isPartner: true })).key).toBe("partner");
    expect(resolveTier(ladder, ctx({ isPatron: true })).key).toBe("patron");
    expect(resolveTier(ladder, ctx({ isPartner: true })).key).toBe("partner"); // partner implies patron bar
    expect(resolveTier(ladder, ctx({ days: 25 })).key).toBe("expert");          // earned, no grant
  });

  it("hasPatronAccess is true for a Patron OR a Partner", () => {
    expect(hasPatronAccess(ctx({ isPatron: true }))).toBe(true);
    expect(hasPatronAccess(ctx({ isPartner: true }))).toBe(true);
    expect(hasPatronAccess(ctx())).toBe(false);
  });

  it("becomePatronVisible: after the 2nd earned tier, hidden once a Patron", () => {
    expect(becomePatronVisible(ladder, ctx({ days: 0 }))).toBe(false); // only Newcomer reached
    expect(becomePatronVisible(ladder, ctx({ days: 7 }))).toBe(true);  // reached Regular (2nd earned)
    expect(becomePatronVisible(ladder, ctx({ days: 7, isPatron: true }))).toBe(false); // already a Patron
  });
});
