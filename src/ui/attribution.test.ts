import { describe, it, expect } from "vitest";
import { tokansAttribution, SUPPORTED_BY_LABEL, TOKANS_URL } from "./attribution.js";
import { TOKANS_LOGO_DATA_URI } from "./tokansLogo.js";

describe("publisher attribution", () => {
  it("exposes the canonical status-bar wording and link", () => {
    expect(SUPPORTED_BY_LABEL).toBe("Supported by Tokans.org");
    expect(TOKANS_URL).toBe("https://www.tokans.org");
  });

  it("tokansAttribution() returns the label + href for non-React shells", () => {
    expect(tokansAttribution()).toEqual({
      label: SUPPORTED_BY_LABEL,
      href: TOKANS_URL,
    });
  });

  it("bakes the logo as a self-contained PNG data URI", () => {
    expect(TOKANS_LOGO_DATA_URI.startsWith("data:image/png;base64,")).toBe(true);
  });
});
