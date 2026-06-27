import { describe, it, expect } from "vitest";
import * as React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DevFloatingPanel } from "./devFloatingPanel.js";

describe("DevFloatingPanel", () => {
  it("renders nothing when dev is false, even if defaultOpen is true", () => {
    const html = renderToStaticMarkup(
      <DevFloatingPanel dev={false} defaultOpen>
        <p>secret dev content</p>
      </DevFloatingPanel>,
    );
    expect(html).toBe("");
  });

  it("collapsed by default: shows the round toggle button, not the children", () => {
    const html = renderToStaticMarkup(
      <DevFloatingPanel dev>
        <p>role switcher here</p>
      </DevFloatingPanel>,
    );
    expect(html).toContain('aria-label="Open Dev tools"');
    expect(html).not.toContain("role switcher here");
  });

  it("defaultOpen renders the title and children, plus a close button", () => {
    const html = renderToStaticMarkup(
      <DevFloatingPanel dev defaultOpen title="Dev: role & tier">
        <p>role switcher here</p>
      </DevFloatingPanel>,
    );
    expect(html).toContain("Dev: role &amp; tier");
    expect(html).toContain("role switcher here");
    expect(html).toContain('aria-label="Close Dev: role &amp; tier"');
  });
});
