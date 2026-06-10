/**
 * AppHarness — the suite's responsive composition shell (Phase 6). One tight contract
 * (fixed slots + a single config object) that owns:
 *   - **slot composition** — `nav` / `main` / `side` / `footer`, content injected via props.
 *   - **the horizontal↔vertical responsive transform** — desktop/web lay `nav | main | side`
 *     in a row; mobile stacks them in a column. The decision is a PURE function of an
 *     injected width (no `window` at import → SSR-safe for the paid apps' web target).
 *   - **common chrome** — Patron (visible from tier 2), Supported-by-Tokans, Settings, and
 *     Marketplace (from `suite`) — each an injected action so the shell stays app-agnostic.
 *   - **per-app theming** — tokens applied as CSS custom properties (no baked utilities).
 *
 * Purge-safe: bakes in NO Tailwind classes; the app styles via `className`s + theme tokens.
 */
import * as React from "react";
import { SupportedByTokans } from "./attribution.js";

export type Orientation = "horizontal" | "vertical";

/** Pure responsive decision: stack vertically below `breakpoint`, else lay out in a row. */
export function pickOrientation(width: number, breakpoint = 768): Orientation {
  return width < breakpoint ? "vertical" : "horizontal";
}

/** Per-app theme tokens → applied as CSS custom properties (`--<token>`). */
export type ThemeTokens = Record<string, string>;

export function themeStyle(tokens?: ThemeTokens): React.CSSProperties {
  const style: Record<string, string> = {};
  for (const [k, v] of Object.entries(tokens ?? {})) style[`--${k}`] = v;
  return style as React.CSSProperties;
}

export interface HarnessChrome {
  /** Tier (1=free … ). Patron chrome is visible from tier 2 (registered+). */
  tier?: number;
  onPatron?: () => void;
  onSettings?: () => void;
  onMarketplace?: () => void;
  /** Open an external URL via the OS opener (Tauri) rather than the webview. */
  onExternal?: (href: string) => void;
}

export interface AppHarnessProps {
  slots: { nav?: React.ReactNode; main: React.ReactNode; side?: React.ReactNode; footer?: React.ReactNode };
  /** Current viewport width (from the app's resize observer). Drives the responsive transform. */
  width: number;
  breakpoint?: number;
  /** Force an orientation (tests / kiosk). Overrides the width-based decision. */
  orientation?: Orientation;
  chrome?: HarnessChrome;
  theme?: ThemeTokens;
  className?: string;
}

/** Which chrome actions to render, given the tier. Patron only from tier ≥ 2. Pure (tested). */
export function chromeActions(chrome: HarnessChrome = {}): ("patron" | "marketplace" | "settings")[] {
  const out: ("patron" | "marketplace" | "settings")[] = [];
  if ((chrome.tier ?? 1) >= 2 && chrome.onPatron) out.push("patron");
  if (chrome.onMarketplace) out.push("marketplace");
  if (chrome.onSettings) out.push("settings");
  return out;
}

/**
 * The responsive shell. Renders identically in Tauri and the browser (no `window` access),
 * so it is SSR-safe — the app feeds `width` from its own observer.
 */
export function AppHarness(props: AppHarnessProps): React.ReactElement {
  const orientation = props.orientation ?? pickOrientation(props.width, props.breakpoint);
  const chrome = props.chrome ?? {};
  const actions = chromeActions(chrome);

  return (
    <div
      className={props.className}
      data-app-harness=""
      data-orientation={orientation}
      style={{ display: "flex", flexDirection: "column", ...themeStyle(props.theme) }}
    >
      <header data-harness-chrome="" style={{ display: "flex", flexDirection: "row" }}>
        {actions.includes("patron") && (
          <button type="button" data-chrome="patron" onClick={chrome.onPatron}>Become a Patron</button>
        )}
        {actions.includes("marketplace") && (
          <button type="button" data-chrome="marketplace" onClick={chrome.onMarketplace}>Marketplace</button>
        )}
        {actions.includes("settings") && (
          <button type="button" data-chrome="settings" onClick={chrome.onSettings}>Settings</button>
        )}
      </header>

      <div
        data-harness-body=""
        style={{ display: "flex", flexDirection: orientation === "horizontal" ? "row" : "column", flex: 1 }}
      >
        {props.slots.nav && <nav data-slot="nav">{props.slots.nav}</nav>}
        <main data-slot="main" style={{ flex: 1 }}>{props.slots.main}</main>
        {props.slots.side && <aside data-slot="side">{props.slots.side}</aside>}
      </div>

      <footer data-slot="footer" data-harness-footer="" style={{ display: "flex", flexDirection: "row" }}>
        {props.slots.footer}
        <SupportedByTokans onActivate={chrome.onExternal} asText={!chrome.onExternal} />
      </footer>
    </div>
  );
}
