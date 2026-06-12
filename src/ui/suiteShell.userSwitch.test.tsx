/**
 * K0.4.3 — SuiteShell `userSwitch` affordance: PAID-GATED BY CONSTRUCTION.
 * The free single-primary-user app passes nothing and the rendered chrome must be
 * PIXEL-IDENTICAL (invariant 3); the switcher appears only with >1 members.
 */
import { describe, it, expect } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { Home, Settings } from "lucide-react";
import { SuiteShell, type SuiteShellProps, type SuiteUserSwitch } from "./suiteShell.js";

const baseProps: Omit<SuiteShellProps, "children"> = {
  brand: <span>myApp</span>,
  nav: [
    { to: "/", label: "Home", icon: Home, home: true },
    { to: "/settings", label: "Settings", icon: Settings },
  ],
};

function render(extra?: Partial<SuiteShellProps>): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <SuiteShell {...baseProps} {...extra}>
        <p>page</p>
      </SuiteShell>
    </MemoryRouter>,
  );
}

const twoMembers: SuiteUserSwitch = {
  current: "self",
  members: [
    { key: "self", label: "Anshuman" },
    { key: "spouse", label: "Spouse", avatarText: "S" },
  ],
  onSwitch: () => {},
};

describe("SuiteShell userSwitch (paid-gated by construction)", () => {
  it("free tier: chrome WITHOUT the prop is pixel-identical to before (no switcher markup)", () => {
    const html = render();
    expect(html).not.toContain("Switch user");
    expect(html).not.toContain("aria-pressed");
  });

  it("a single-member userSwitch renders NOTHING — markup identical to passing no prop", () => {
    const without = render();
    const withOne = render({
      userSwitch: { current: "self", members: [{ key: "self", label: "Anshuman" }], onSwitch: () => {} },
    });
    expect(withOne).toBe(without); // pixel-identical free/single-user chrome
  });

  it("an empty-members userSwitch also renders nothing", () => {
    expect(render({ userSwitch: { current: "self", members: [], onSwitch: () => {} } })).toBe(render());
  });

  it("with >1 members the switcher appears, marking the current member pressed", () => {
    const html = render({ userSwitch: twoMembers });
    expect(html).toContain('aria-label="Switch user"');
    expect(html).toContain('aria-label="Switch to Anshuman"');
    expect(html).toContain('aria-label="Switch to Spouse"');
    expect(html).toMatch(/aria-pressed="true"[^>]*aria-label="Switch to Anshuman"|aria-label="Switch to Anshuman"[^>]*aria-pressed="true"/);
    expect(html).toMatch(/aria-pressed="false"[^>]*aria-label="Switch to Spouse"|aria-label="Switch to Spouse"[^>]*aria-pressed="false"/);
  });

  it("adding the switcher does not remove or alter the rest of the chrome", () => {
    const without = render();
    const withSwitch = render({ userSwitch: twoMembers });
    // The switcher is purely additive: stripping the injected group yields the original markup.
    const stripped = withSwitch.replace(/<div class="flex items-center gap-1" role="group" aria-label="Switch user">.*?<\/button><\/div>/s, "");
    expect(stripped).toBe(without);
  });
});
