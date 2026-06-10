import { describe, it, expect } from "vitest";
import {
  buildSnapshot, wrapSlice, openSlice, generateRecipientPassphrase, isReleaseEligible,
  BREAKGLASS_SCHEMAS, type BreakGlassContributor, type ContributorSection,
} from "./index.js";
import { validateDescriptor } from "../schema/index.js";

const TIERS = ["nominee", "executor", "full"]; // low → high

function contributor(module: string, sections: ContributorSection[]): BreakGlassContributor {
  return { module, sections: () => sections };
}

const finance = contributor("myfinance", [
  { module: "myfinance", minTier: "nominee", title: "Emergency contacts", data: { ice: "spouse: 99999" } },
  { module: "myfinance", minTier: "executor", title: "Accounts", data: { bank: "•••• 1234" } },
  { module: "myfinance", minTier: "full", title: "Full statement", data: { balance: 500000 } },
]);
const health = contributor("myhealth", [
  { module: "myhealth", minTier: "nominee", title: "Blood group", data: { blood: "O+" } },
  { module: "myhealth", minTier: "full", title: "Medical history", data: { conditions: ["asthma"] } },
]);

describe("tier redaction (buildSnapshot)", () => {
  it("a nominee sees only minTier=nominee sections", async () => {
    const snap = await buildSnapshot([finance, health], "nominee", TIERS, { now: "2026-06-10T00:00:00Z" });
    expect(snap.sections.map((s) => s.title).sort()).toEqual(["Blood group", "Emergency contacts"]);
  });
  it("an executor sees nominee + executor, not full", async () => {
    const snap = await buildSnapshot([finance, health], "executor", TIERS, { now: "x" });
    const titles = snap.sections.map((s) => s.title);
    expect(titles).toContain("Accounts");
    expect(titles).not.toContain("Full statement");
    expect(titles).not.toContain("Medical history");
  });
  it("full sees everything", async () => {
    const snap = await buildSnapshot([finance, health], "full", TIERS, { now: "x" });
    expect(snap.sections).toHaveLength(5);
  });
  it("rejects an unknown tier", async () => {
    await expect(buildSnapshot([finance], "ghost", TIERS)).rejects.toThrow(/unknown/);
  });
});

describe("recipient slice (zero-knowledge) + free reader", () => {
  it("wrap → open round-trips with the passphrase only (no license/entitlement)", async () => {
    const snap = await buildSnapshot([finance, health], "executor", TIERS, { now: "2026-06-10T00:00:00Z" });
    const pass = generateRecipientPassphrase();
    const blob = await wrapSlice(snap, pass);
    const opened = await openSlice(blob, pass); // ← no account, no tier, no license param
    expect(opened.sections.map((s) => s.title)).toEqual(snap.sections.map((s) => s.title));
  });

  it("the slice is undecryptable without the passphrase (vendor cannot read)", async () => {
    const snap = await buildSnapshot([finance], "nominee", TIERS, { now: "x" });
    const blob = await wrapSlice(snap, generateRecipientPassphrase());
    // ciphertext, not plaintext JSON; and a wrong passphrase fails
    expect(() => JSON.parse(new TextDecoder().decode(blob))).toThrow();
    await expect(openSlice(blob, generateRecipientPassphrase())).rejects.toThrow();
  });

  it("tolerates user formatting of the passphrase", async () => {
    const snap = await buildSnapshot([finance], "nominee", TIERS, { now: "x" });
    const pass = generateRecipientPassphrase();
    const blob = await wrapSlice(snap, pass);
    const opened = await openSlice(blob, ` ${pass.toLowerCase().replace(/-/g, " ")} `);
    expect(opened.tier).toBe("nominee");
  });
});

describe("staleness trigger (dead-man's-switch)", () => {
  it("eligible only after the threshold of inactivity", () => {
    const policy = { thresholdDays: 30 };
    expect(isReleaseEligible(policy, "2026-05-01T00:00:00Z", "2026-05-20T00:00:00Z")).toBe(false); // 19d
    expect(isReleaseEligible(policy, "2026-05-01T00:00:00Z", "2026-06-10T00:00:00Z")).toBe(true);  // 40d
  });
});

describe("ledger schemas", () => {
  it("grant + audit descriptors validate and are common shared tables", () => {
    for (const s of BREAKGLASS_SCHEMAS) {
      expect(validateDescriptor(s).ok).toBe(true);
      expect(s.owner).toBe("common");
    }
  });
});
