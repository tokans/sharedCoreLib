/**
 * AppHarness — the suite's responsive composition shell (the "UI framework" apps migrate
 * their bespoke AppShell onto). One tight contract (four slots + a single config object) that
 * owns:
 *   - **slot composition** — `nav` / `main` / `side` / `footer`, content injected via props.
 *     Each slot may be a node OR a render-fn `(ctx) => node` so an app can show a desktop
 *     sidebar AND a mobile bottom-bar from the same harness (it gets the live orientation).
 *   - **the horizontal↔vertical responsive transform** — desktop/web lay `nav | main | side`
 *     in a row; mobile stacks them in a column (nav at top or bottom via `verticalNavPosition`).
 *     The decision is a PURE function of an injected width (no `window` at import → SSR-safe
 *     for the paid apps' web target). Feed `width` from {@link useViewportWidth}.
 *   - **common chrome** — Patron (visible from tier 2), Supported-by-Tokans, Settings, and
 *     Marketplace (from `suite`) — each an injected action so the shell stays app-agnostic.
 *   - **per-app theming** — {@link SuiteThemeTokens} applied as CSS custom properties
 *     (no baked utilities → purge-safe; apps style via `className`s + these tokens).
 *
 * To migrate: replace the app's `AppShell` with `<AppHarness>`, inject the nav as an
 * orientation-aware render-fn (sidebar ⇄ bottom-bar), pass `width={useViewportWidth()}`, wire
 * the chrome callbacks (Settings route, Patron CTA, `onMarketplace` → the app's marketplace
 * page built on `sharedcorelib/suite` `createAppCatalog`). See CONTRACT.md §4.1.
 */
import * as React from "react";
import { SupportedByTokans } from "./attribution.js";

export type Orientation = "horizontal" | "vertical";

/** Pure responsive decision: stack vertically below `breakpoint`, else lay out in a row. */
export function pickOrientation(width: number, breakpoint = 768): Orientation {
  return width < breakpoint ? "vertical" : "horizontal";
}

/**
 * SSR-safe viewport width. Returns `initial` on the server and before mount (no `window`
 * access at import or first render); subscribes to `resize` in the browser/Tauri webview.
 * `<AppHarness width={useViewportWidth()} />` is the turnkey wiring.
 */
export function useViewportWidth(initial = 1024): number {
  const [width, setWidth] = React.useState(initial);
  React.useEffect(() => {
    if (typeof window === "undefined") return;
    const onResize = () => setWidth(window.innerWidth);
    onResize();
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return width;
}

// ── Theming ──────────────────────────────────────────────────────────────────

/**
 * The canonical theme-token vocabulary every suite app sets (applied as `--<token>` CSS
 * custom properties). Apps override these; primitives + the harness read them. Keeping the
 * names in one place is what makes theming consistent across the suite. Extra app-specific
 * tokens are allowed (the map is open), but these are the shared contract.
 */
export type SuiteThemeToken =
  | "color-bg" | "color-fg" | "color-card" | "color-muted" | "color-accent"
  | "color-accent-fg" | "color-border" | "color-danger" | "color-patron"
  | "radius" | "font-sans" | "space-unit" | "nav-width";

export type ThemeTokens = Partial<Record<SuiteThemeToken, string>> & Record<string, string>;

/** A neutral default theme — a starting point apps spread over and override. */
export const DEFAULT_THEME: ThemeTokens = {
  "color-bg": "#ffffff",
  "color-fg": "#0a0a0a",
  "color-card": "#f7f7f8",
  "color-muted": "#6b7280",
  "color-accent": "#2563eb",
  "color-accent-fg": "#ffffff",
  "color-border": "#e5e7eb",
  "color-danger": "#dc2626",
  "color-patron": "#e11d48",
  "radius": "8px",
  "font-sans": "system-ui, sans-serif",
  "space-unit": "0.25rem",
  "nav-width": "14rem",
};

export function themeStyle(tokens?: ThemeTokens): React.CSSProperties {
  const style: Record<string, string> = {};
  for (const [k, v] of Object.entries(tokens ?? {})) style[`--${k}`] = v;
  return style as React.CSSProperties;
}

// ── Slots + chrome ────────────────────────────────────────────────────────────

/** Context handed to render-fn slots so they can adapt to the live layout. */
export interface HarnessRenderContext { orientation: Orientation; width: number }

/** A slot is a node, or a render-fn that receives the live layout context. */
export type HarnessSlot = React.ReactNode | ((ctx: HarnessRenderContext) => React.ReactNode);

function renderSlot(slot: HarnessSlot | undefined, ctx: HarnessRenderContext): React.ReactNode {
  return typeof slot === "function" ? (slot as (c: HarnessRenderContext) => React.ReactNode)(ctx) : slot ?? null;
}

export interface HarnessChrome {
  /** Tier (1=free … ). Patron chrome is visible from tier 2 (registered+). */
  tier?: number;
  onPatron?: () => void;
  onSettings?: () => void;
  /** Open the app's marketplace page (built on `sharedcorelib/suite` `createAppCatalog`). */
  onMarketplace?: () => void;
  /** Open an external URL via the OS opener (Tauri) rather than the webview. */
  onExternal?: (href: string) => void;
  /** Labels (i18n / per-app wording). Sensible English defaults. */
  labels?: { patron?: string; marketplace?: string; settings?: string };
}

export interface AppHarnessProps {
  slots: { nav?: HarnessSlot; main: HarnessSlot; side?: HarnessSlot; footer?: HarnessSlot };
  /** Current viewport width (from {@link useViewportWidth}). Drives the responsive transform. */
  width: number;
  breakpoint?: number;
  /** Force an orientation (tests / kiosk). Overrides the width-based decision. */
  orientation?: Orientation;
  /** In vertical (mobile) layout, place the nav slot at the top or bottom (bottom-bar). Default "bottom". */
  verticalNavPosition?: "top" | "bottom";
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
 * The responsive shell. Renders identically in Tauri and the browser (no `window` access at
 * import or render), so it is SSR-safe — the app feeds `width` from its own observer/hook.
 */
export function AppHarness(props: AppHarnessProps): React.ReactElement {
  const orientation = props.orientation ?? pickOrientation(props.width, props.breakpoint);
  const ctx: HarnessRenderContext = { orientation, width: props.width };
  const chrome = props.chrome ?? {};
  const labels = chrome.labels ?? {};
  const actions = chromeActions(chrome);
  const navAtBottom = orientation === "vertical" && (props.verticalNavPosition ?? "bottom") === "bottom";

  const nav = props.slots.nav != null ? <nav data-slot="nav">{renderSlot(props.slots.nav, ctx)}</nav> : null;

  return (
    <div
      className={props.className}
      data-app-harness=""
      data-orientation={orientation}
      style={{ display: "flex", flexDirection: "column", minHeight: "100%", ...themeStyle(props.theme) }}
    >
      <header data-harness-chrome="" style={{ display: "flex", flexDirection: "row" }}>
        {actions.includes("patron") && (
          <button type="button" data-chrome="patron" onClick={chrome.onPatron}>{labels.patron ?? "Become a Patron"}</button>
        )}
        {actions.includes("marketplace") && (
          <button type="button" data-chrome="marketplace" onClick={chrome.onMarketplace}>{labels.marketplace ?? "Marketplace"}</button>
        )}
        {actions.includes("settings") && (
          <button type="button" data-chrome="settings" onClick={chrome.onSettings}>{labels.settings ?? "Settings"}</button>
        )}
      </header>

      <div
        data-harness-body=""
        style={{ display: "flex", flexDirection: orientation === "horizontal" ? "row" : "column", flex: 1 }}
      >
        {!navAtBottom && nav}
        <main data-slot="main" style={{ flex: 1 }}>{renderSlot(props.slots.main, ctx)}</main>
        {props.slots.side != null && <aside data-slot="side">{renderSlot(props.slots.side, ctx)}</aside>}
        {navAtBottom && nav}
      </div>

      <footer data-slot="footer" data-harness-footer="" style={{ display: "flex", flexDirection: "row" }}>
        {renderSlot(props.slots.footer, ctx)}
        <SupportedByTokans onActivate={chrome.onExternal} asText={!chrome.onExternal} />
      </footer>
    </div>
  );
}
