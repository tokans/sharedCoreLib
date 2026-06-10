import { describe, it, expect } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  pickOrientation, useViewportWidth, themeStyle, DEFAULT_THEME, chromeActions, AppHarness,
  type HarnessRenderContext,
} from "./harness.js";

describe("responsive transform (pure, SSR-safe)", () => {
  it("stacks vertically below the breakpoint, rows above it", () => {
    expect(pickOrientation(500)).toBe("vertical");
    expect(pickOrientation(1200)).toBe("horizontal");
    expect(pickOrientation(700, 640)).toBe("horizontal"); // custom breakpoint
  });
});

describe("theming tokens", () => {
  it("maps tokens to CSS custom properties; DEFAULT_THEME covers the vocabulary", () => {
    expect(themeStyle({ "color-accent": "#0a0", radius: "8px" })).toEqual({ "--color-accent": "#0a0", "--radius": "8px" });
    expect(themeStyle()).toEqual({});
    expect(themeStyle(DEFAULT_THEME)["--color-accent" as keyof React.CSSProperties]).toBe("#2563eb");
    expect(Object.keys(DEFAULT_THEME)).toEqual(expect.arrayContaining(["color-bg", "color-fg", "color-accent", "radius", "nav-width"]));
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

describe("AppHarness composition + orientation-aware slots", () => {
  it("reflects orientation from width and honors a forced override", () => {
    expect(AppHarness({ slots: { main: "M" }, width: 1200 }).props["data-orientation"]).toBe("horizontal");
    expect(AppHarness({ slots: { main: "M" }, width: 400 }).props["data-orientation"]).toBe("vertical");
    expect(AppHarness({ slots: { main: "M" }, width: 1200, orientation: "vertical" }).props["data-orientation"]).toBe("vertical");
  });

  it("render-fn slots receive the live layout context (sidebar ⇄ bottom-bar from one harness)", () => {
    const navFor = (w: number) =>
      renderToStaticMarkup(
        React.createElement(AppHarness, {
          width: w,
          slots: {
            main: "content",
            nav: (ctx: HarnessRenderContext) => (ctx.orientation === "horizontal" ? "SIDEBAR" : "BOTTOMBAR"),
          },
        }),
      );
    expect(navFor(1300)).toContain("SIDEBAR");
    expect(navFor(400)).toContain("BOTTOMBAR");
  });
});

describe("SSR render-equivalence (renders the same in Tauri + browser, no window access)", () => {
  const el = React.createElement(AppHarness, {
    width: 1280,
    theme: { "color-accent": "#123456" },
    chrome: { tier: 2, onPatron: () => {}, onMarketplace: () => {}, onSettings: () => {}, onExternal: () => {} },
    slots: { nav: "NAV", main: "MAIN", side: "SIDE", footer: "FOOT" },
  });

  it("renders to static markup in a pure (no-window) environment without throwing", () => {
    expect(typeof globalThis.window).toBe("undefined"); // vitest node env: no DOM globals
    const html = renderToStaticMarkup(el);
    expect(html).toContain('data-app-harness=""');
    expect(html).toContain('data-orientation="horizontal"');
    expect(html).toMatch(/NAV|MAIN|SIDE|FOOT/);
    expect(html).toContain("Become a Patron");   // tier-2 chrome
    expect(html).toContain("Supported by Tokans.org"); // baked attribution
    expect(html).toContain("--color-accent:#123456"); // theme token as CSS var
  });

  it("is deterministic — identical output across renders (Tauri webview == browser)", () => {
    expect(renderToStaticMarkup(el)).toBe(renderToStaticMarkup(el));
  });
});

describe("useViewportWidth (SSR-safe hook)", () => {
  it("returns the initial width on the server / before mount (no window at render)", () => {
    const Probe = () => React.createElement("div", { "data-w": useViewportWidth(1024) });
    // SSR render: useEffect does not run, so it must return the initial (no window access)
    expect(renderToStaticMarkup(React.createElement(Probe))).toContain('data-w="1024"');
  });
});
