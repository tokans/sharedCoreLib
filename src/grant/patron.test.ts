import { describe, it, expect } from "vitest";
import {
  createPatronStore,
  partnerWindowOpen,
  PATRON_SINCE_KEY,
  PARTNER_SINCE_KEY,
  PATRON_PENDING_KEY,
  PARTNER_WINDOW_MONTHS,
  type PatronSettings,
} from "./index.js";

function fakeSettings(): PatronSettings & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return { map, get: async (k) => map.get(k) ?? null, set: async (k, v) => void map.set(k, v) };
}

describe("partnerWindowOpen", () => {
  it("is open inside the window and closed after", () => {
    expect(partnerWindowOpen("2026-01-01", "2026-02-01")).toBe(true);
    expect(partnerWindowOpen("2026-01-01", `2026-0${PARTNER_WINDOW_MONTHS + 1}-02`)).toBe(false);
    expect(partnerWindowOpen("not-a-date", "2026-02-01")).toBe(false);
  });
});

describe("createPatronStore", () => {
  it("records a donation and derives an active offer window", async () => {
    const s = fakeSettings();
    const store = createPatronStore(s);
    await store.markDonationPending();
    expect((await store.getState("2026-01-01")).pending).toBe(true);

    await store.recordDonation("2026-01-01");
    expect(s.map.get(PATRON_SINCE_KEY)).toBe("2026-01-01");
    expect(s.map.get(PATRON_PENDING_KEY)).toBe("0");

    const st = await store.getState("2026-01-15");
    expect(st).toMatchObject({ isPatron: true, donationDate: "2026-01-01", partnerOfferActive: true, pending: false, isPartner: false });
  });

  it("partner outranks patron and clears pending", async () => {
    const s = fakeSettings();
    const store = createPatronStore(s);
    await store.recordPartner("2026-03-10");
    expect(s.map.get(PARTNER_SINCE_KEY)).toBe("2026-03-10");
    const st = await store.getState("2026-03-11");
    expect(st.isPartner).toBe(true);
    expect(st.isPatron).toBe(true);
  });
});
