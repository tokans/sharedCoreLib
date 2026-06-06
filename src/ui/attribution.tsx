/**
 * Publisher attribution — app-agnostic.
 *
 * Every suite app shows a single, identical "Supported by Tokans.org" line in its
 * bottom status bar. Defining it here (instead of per app) keeps the wording, the
 * URL, and the behaviour consistent across the whole suite and lets one change lift
 * every installed app.
 *
 * Tailwind-purge-safe by design: this component bakes in NO utility classes (that is
 * the same reason the heavier UI kit isn't extracted yet — see CONTRACT.md §4). The
 * APP supplies the look via `className`, exactly like `cn`. External navigation is
 * injectable (`onActivate`) so a Tauri shell can route the link through its OS opener
 * instead of the webview, mirroring the marketplace's `openExternal`.
 */
import * as React from "react";

/** Publisher home page the attribution links to. */
export const TOKANS_URL = "https://tokans.org";

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
}

/**
 * The "Supported by Tokans.org" attribution to drop into an app's bottom status bar.
 * Renders an external link by default; pass `onActivate` (Tauri opener) to control
 * navigation, or `asText` for a non-interactive label.
 */
export function SupportedByTokans({
  className,
  href = TOKANS_URL,
  onActivate,
  asText,
}: SupportedByTokansProps): React.ReactElement {
  if (asText) {
    return (
      <span className={className} data-tokans-attribution="">
        {SUPPORTED_BY_LABEL}
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
        {SUPPORTED_BY_LABEL}
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
      {SUPPORTED_BY_LABEL}
    </a>
  );
}
