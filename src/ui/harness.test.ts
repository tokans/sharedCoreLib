import { describe, it, expect } from "vitest";
import { pickOrientation, themeStyle, chromeActions, AppHarness } from "./harness.js";

describe("responsive transform (pure, SSR-safe)", () => {
  it("stacks vertically below the breakpoint, rows above it", () => {
    expect(pickOrientation(500)).toBe("vertical");
    expect(pickOrientation(1200)).toBe("horizontal");
    expect(pickOrientation(700, 640)).toBe("horizontal"); // custom breakpoint
  });
});

describe("theming tokens", () => {
  it("maps tokens to CSS custom properties", () => {
    expect(themeStyle({ accent: "#0a0", radius: "8px" })).toEqual({ "--accent": "#0a0", "--radius": "8px" });
    expect(themeStyle()).toEqual({});
  });
});

describe("chrome visibility", () => {
  it("Patron only from tier ≥ 2; marketplace/settings when wired", () => {
    expect(chromeActions({ tier: 1, onPatron: () => {}, onSettings: () => {} })).toEqual(["settings"]);
    expect(chromeActions({ tier: 2, onPatron: () => {}, onMarketplace: () => {}, onSettings: () => {} }))
      .toEqual(["patron", "marketplace", "settings"]);
    expect(chromeActions({})).toEqual([]);
  });
});

describe("AppHarness composition", () => {
  it("renders identically given the same width (no window access) and reflects orientation", () => {
    const el = AppHarness({ slots: { main: "M" }, width: 1200 });
    expect(el.props["data-orientation"]).toBe("horizontal");
    const mobile = AppHarness({ slots: { main: "M" }, width: 400 });
    expect(mobile.props["data-orientation"]).toBe("vertical");
    // forced orientation overrides width
    const forced = AppHarness({ slots: { main: "M" }, width: 1200, orientation: "vertical" });
    expect(forced.props["data-orientation"]).toBe("vertical");
  });
});
