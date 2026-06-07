/**
 * Publisher attribution — app-agnostic.
 *
 * Every suite app shows a single, identical "Supported by Tokans.org" line — with the
 * Tokans mark — in its bottom status bar. Defining it here (instead of per app) keeps
 * the wording, the logo, the URL, and the behaviour consistent across the whole suite
 * and lets one change lift every installed app.
 *
 * Tailwind-purge-safe by design: this component bakes in NO utility classes (that is
 * the same reason the heavier UI kit isn't extracted yet — see CONTRACT.md §4). The
 * APP supplies the look via `className`, exactly like `cn`. The logo is a baked data
 * URI ({@link TOKANS_LOGO_DATA_URI}) so it needs no per-app asset. External navigation
 * is injectable (`onActivate`) so a Tauri shell can route the link through its OS opener
 * instead of the webview, mirroring the marketplace's `openExternal` — this is how the
 * link opens in the user's real browser rather than the app webview.
 */
import * as React from "react";
import { TOKANS_LOGO_DATA_URI } from "./tokansLogo.js";

/** Publisher home page the attribution links to (canonical www host). */
export const TOKANS_URL = "https://www.tokans.org";

/** Canonical attribution wording shown in every app's status bar. */
export const SUPPORTED_BY_LABEL = "Supported by Tokans.org";

/** Pure accessor for the attribution text + target — handy for non-React shells/tests. */
export function tokansAttribution(): { label: string; href: string } {
  return { label: SUPPORTED_BY_LABEL, href: TOKANS_URL };
}

export interface SupportedByTokansProps {
  /** App-supplied classes for the status-bar look (kept out of the lib so Tailwind doesn't purge them). */
  className?: string;
  /** Override the link target. Defaults to {@link TOKANS_URL}. */
  href?: string;
  /**
   * Open the link yourself instead of the default anchor navigation — wire this to the
   * Tauri OS opener so the URL launches in the user's browser, not the app webview.
   * When provided, the element renders as a button-like link and calls this on click.
   */
  onActivate?: (href: string) => void;
  /** Render plain text with no link — e.g. a shell that forbids outbound navigation. */
  asText?: boolean;
  /** Override the baked logo's sizing/spacing classes. When unset, an inline style sizes it to 1em. */
  logoClassName?: string;
  /** Drop the logo and render the label alone. */
  hideLogo?: boolean;
}

/**
 * Logo + label, laid out inline so the attribution renders correctly even when the
 * app's `className` doesn't establish a flex row. Sizing/spacing default to inline
 * styles (1em tall, tracking the font size) and are overridable via `logoClassName` —
 * neither path bakes a Tailwind utility class, keeping the component purge-safe.
 */
function attributionContent(hideLogo?: boolean, logoClassName?: string): React.ReactNode {
  return (
    <>
      {!hideLogo && (
        <img
          src={TOKANS_LOGO_DATA_URI}
          alt=""
          aria-hidden="true"
          className={logoClassName}
          style={
            logoClassName
              ? undefined
              : { height: "1em", width: "auto", verticalAlign: "-0.15em", marginRight: "0.4em" }
          }
        />
      )}
      <span>{SUPPORTED_BY_LABEL}</span>
    </>
  );
}

/**
 * The "Supported by Tokans.org" attribution — Tokans mark + wording — to drop into an
 * app's bottom status bar. Renders an external link by default; pass `onActivate`
 * (Tauri opener) so the link opens in the user's real browser, or `asText` for a
 * non-interactive label.
 */
export function SupportedByTokans({
  className,
  href = TOKANS_URL,
  onActivate,
  asText,
  logoClassName,
  hideLogo,
}: SupportedByTokansProps): React.ReactElement {
  const content = attributionContent(hideLogo, logoClassName);

  if (asText) {
    return (
      <span className={className} data-tokans-attribution="">
        {content}
      </span>
    );
  }

  if (onActivate) {
    return (
      <a
        className={className}
        href={href}
        data-tokans-attribution=""
        role="link"
        onClick={(e) => {
          e.preventDefault();
          onActivate(href);
        }}
      >
        {content}
      </a>
    );
  }

  return (
    <a
      className={className}
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      data-tokans-attribution=""
    >
      {content}
    </a>
  );
}
