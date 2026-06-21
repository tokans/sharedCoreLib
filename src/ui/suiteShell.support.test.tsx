/**
 * The suite-standard support CTA (donate → partner), resolved in core so every app behaves
 * identically. Asserts the pure {@link supportCta} resolver + that the shell renders the right
 * label (SSR markup, like the other SuiteShell tests).
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { SuiteShell, supportCta, type SuiteSupport } from "./suiteShell.js";

const base: SuiteSupport = { isSupporter: false, onDonate: () => {}, onPartner: () => {} };

describe("supportCta — donate → partner flip", () => {
  it("non-supporter ⇒ Donate to support", () => {
    expect(supportCta(base)?.label).toBe("Donate to support");
    expect(supportCta(base)?.key).toBe("suite:donate");
  });

  it("supporter ⇒ Become a Partner (the flip)", () => {
    const cta = supportCta({ ...base, isSupporter: true });
    expect(cta?.label).toBe("Become a Partner");
    expect(cta?.key).toBe("suite:partner");
  });

  it("supporter + offer closed ⇒ Reopen Partner signup → onReopen", () => {
    const cta = supportCta({ ...base, isSupporter: true, partnerOfferActive: false });
    expect(cta?.label).toBe("Reopen Partner signup");
    expect(cta?.key).toBe("suite:partner-reopen");
  });

  it("pending donation (not yet imported) ⇒ Restart after donation → onRestart", () => {
    const cta = supportCta({ ...base, pending: true });
    expect(cta?.label).toBe("Restart after donation");
    expect(cta?.key).toBe("suite:support-restart");
  });

  it("partner ⇒ no CTA (top of the support ladder)", () => {
    expect(supportCta({ ...base, isSupporter: true, isPartner: true })).toBeNull();
  });

  it("label overrides apply (e.g. myFinance's 'Become a Patron')", () => {
    expect(supportCta({ ...base, labels: { donate: "Become a Patron" } })?.label).toBe("Become a Patron");
  });

  it("onReopen / onRestart fall back to onDonate when omitted", () => {
    let donated = 0;
    const s: SuiteSupport = { ...base, onDonate: () => { donated++; } };
    supportCta({ ...s, isSupporter: true, partnerOfferActive: false })?.onSelect?.();
    supportCta({ ...s, pending: true })?.onSelect?.();
    expect(donated).toBe(2);
  });

  it("hidden ⇒ no CTA; undefined ⇒ no CTA", () => {
    expect(supportCta({ ...base, hidden: true })).toBeNull();
    expect(supportCta(undefined)).toBeNull();
  });

  it("the shell renders the resolved label and flips with supporter state", () => {
    const shell = (support: SuiteSupport) =>
      renderToStaticMarkup(
        <MemoryRouter>
          <SuiteShell brand="X" nav={[{ to: "/", label: "Home", icon: () => null }]} support={support}>
            <div />
          </SuiteShell>
        </MemoryRouter>,
      );
    expect(shell(base)).toContain("Donate to support");
    expect(shell(base)).not.toContain("Become a Partner");
    expect(shell({ ...base, isSupporter: true })).toContain("Become a Partner");
  });
});
