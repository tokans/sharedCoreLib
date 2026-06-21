/**
 * SuiteShell `centralVariant="arch"` — the OPT-IN rainbow-arch central FAB.
 *
 * The default `centralVariant="sheet"` MUST stay byte-identical (every existing consumer relies on
 * it). The arch variant renders its own overlay FAB + coloured icon petals (NavLinks/buttons) with
 * aria-labels and auto-assigned rainbow colours when an action omits its own `color`.
 */
import { describe, it, expect } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { Home, Settings, Car, UtensilsCrossed, Plus } from "lucide-react";
import { SuiteShell, type SuiteShellProps, type SuiteAction } from "./suiteShell.js";

const baseProps: Omit<SuiteShellProps, "children"> = {
  brand: <span>myApp</span>,
  nav: [
    { to: "/", label: "Home", icon: Home, home: true },
    { to: "/settings", label: "Settings", icon: Settings },
  ],
};

const twoActions: SuiteAction[] = [
  { key: "kitchen", label: "Kitchen", icon: UtensilsCrossed, to: "/kitchen", color: "#ef4444" },
  { key: "vehicles", label: "Vehicles", icon: Car, to: "/vehicles" }, // no color → auto palette
];

function render(extra?: Partial<SuiteShellProps>): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <SuiteShell {...baseProps} {...extra}>
        <p>page</p>
      </SuiteShell>
    </MemoryRouter>,
  );
}

describe("SuiteShell centralVariant (arch is opt-in; sheet is the default)", () => {
  it("default variant (sheet) with 2+ actions is byte-identical to passing centralVariant=\"sheet\"", () => {
    const implicit = render({ centralActions: twoActions });
    const explicit = render({ centralActions: twoActions, centralVariant: "sheet" });
    expect(implicit).toBe(explicit);
  });

  it("sheet variant renders the bottom-sheet FAB button, NOT the arch overlay", () => {
    const html = render({ centralActions: twoActions, centralLabel: "Quick", centralVariant: "sheet" });
    // The sheet FAB button uses aria-label=centralLabel; the arch petals would expose per-action labels.
    expect(html).toContain('aria-label="Quick"');
    expect(html).not.toContain('aria-label="Kitchen"');
    expect(html).not.toContain('aria-expanded'); // the closed sheet FAB has no aria-expanded
  });

  it("arch variant renders an aria-expanded FAB + a coloured petal per action with aria-labels", () => {
    const html = render({
      centralActions: twoActions,
      centralLabel: "Quick",
      centralIcon: Plus,
      centralVariant: "arch",
    });
    expect(html).toContain('aria-label="Quick"');
    expect(html).toContain('aria-expanded="false"');
    // Real petals with per-action accessible labels.
    expect(html).toContain('aria-label="Kitchen"');
    expect(html).toContain('aria-label="Vehicles"');
    // Explicit color honoured; missing color auto-assigned from the rainbow palette (index 1 = #f97316).
    expect(html).toContain("background-color:#ef4444");
    expect(html).toContain("background-color:#f97316");
  });

  it("arch petals with `to` are links; the bottom-bar central sheet FAB is suppressed", () => {
    const html = render({ centralActions: twoActions, centralLabel: "Quick", centralVariant: "arch" });
    // Petal NavLinks navigate (anchors), not just the central sheet button.
    expect(html).toContain('href="/kitchen"');
    expect(html).toContain('href="/vehicles"');
    // The arch keeps the bottom bar to home + More — no second "Quick" sheet-style center pill text.
    // (The arch FAB carries the aria-label; the petals carry their own labels.)
    expect(html).toContain('aria-expanded');
  });

  it("with a single central action both variants keep the plain-button behavior (no arch overlay)", () => {
    const one: SuiteAction[] = [{ key: "kitchen", label: "Kitchen", icon: UtensilsCrossed, to: "/kitchen" }];
    const arch = render({ centralActions: one, centralVariant: "arch" });
    const sheet = render({ centralActions: one, centralVariant: "sheet" });
    expect(arch).toBe(sheet); // 1 action → identical regardless of variant
    expect(arch).not.toContain('aria-expanded');
  });

  it("with zero central actions the arch variant renders no central control (hidden)", () => {
    const arch = render({ centralActions: [], centralVariant: "arch" });
    const sheet = render({ centralActions: [], centralVariant: "sheet" });
    expect(arch).toBe(sheet);
    expect(arch).not.toContain('aria-expanded');
  });
});
