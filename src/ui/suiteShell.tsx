/**
 * SuiteShell — the suite's shared, opinionated responsive app shell (CONTRACT.md §4.1).
 *
 * One styled shell every app uses so desktop and mobile look consistent across the suite:
 *   - **Desktop (md+)**: a left sidebar (brand · optional top slot · full nav · footer with the
 *     app's secondary actions + the "Supported by Tokans" attribution), and a slim top bar whose
 *     right edge holds the injected `profile` slot + the optional tier-gated `account` button.
 *   - **Mobile (< md)**: a top bar (brand left, profile/account right) + a fixed **three-button**
 *     bottom bar — **[home] · [center] · [More]**:
 *       · *home* — a NavLink to the app's primary destination (label is app-defined, e.g. "Today").
 *       · *center* — adaptive: hidden with 0 `centralActions`, a plain button that runs the action
 *         with exactly 1, and a raised FAB that opens a bottom sheet listing them with 2+.
 *       · *More* — opens a right-side drawer with the rest of the nav + the suite-standard
 *         actions the shell renders itself ("More Apps" via `moreAppsTo`, "Report an issue" via
 *         `onReportIssue`) + the app's own `actions` (donate / emergency / …) + the attribution.
 *
 * Decoupling: the shell renders the styled chrome; the app supplies **data + slots**. Nav items
 * carry a precomputed `state` ("open" | "nudge") so the shell never imports app gating. Routing
 * uses `react-router-dom` (the suite standard); the `profile` slot and `account` button keep the
 * shell free of login/multi-user semantics — free apps stay login-less (invariant 1/3), and the
 * `account` button only appears at tier ≥ 2.
 *
 * Primitive-kit member (CONTRACT.md §4.2): it bakes Tailwind utilities, so the consuming app must
 * use the shared preset + `theme.css` and add `../sharedCoreLib/src/ui/**` to its `content` globs.
 */
import * as React from "react";
import { NavLink, useLocation } from "react-router-dom";
import { Bug, ChevronDown, ChevronUp, LayoutGrid, MoreHorizontal, Plus, type LucideIcon } from "lucide-react";
import { cn } from "./cn.js";
import { Sheet, SheetContent, SheetClose } from "./sheet.js";
import { SupportedByTokans } from "./attribution.js";

/** A navigation destination. `state` is precomputed by the app from its own gating. */
export interface SuiteNavItem {
  to: string;
  label: string;
  icon: LucideIcon;
  /** Marks the single mobile bottom-bar "home" button. Falls back to the first item if unset. */
  home?: boolean;
  /** NavLink `end` (exact match) — set for "/". */
  end?: boolean;
  /** "open" (default) or "nudge" (shown dimmed with a lock + hint). Hidden items: omit them. */
  state?: "open" | "nudge";
  /** Tooltip shown on a nudge item (the unlock hint). */
  lockHint?: string;
}

/** A button-like action (sidebar footer, More drawer, or central sheet). `to` ⇒ link; else `onSelect`. */
export interface SuiteAction {
  key: string;
  label: string;
  icon: LucideIcon;
  to?: string;
  onSelect?: () => void;
  /** Visual emphasis. "danger" is for destructive/emergency actions. */
  tone?: "default" | "primary" | "danger";
}

/** Optional built-in account button (top-right). Rendered only at tier ≥ 2 — free apps stay login-less. */
export interface SuiteAccount {
  tier: number;
  /** Single initial / short text for the avatar; falls back to a user glyph. */
  avatarText?: string;
  label?: string;
  onClick?: () => void;
}

export interface SuiteShellProps {
  /** Brand lockup (icon + name) shown in the sidebar header and the mobile top bar. */
  brand: React.ReactNode;
  /** Full navigation list. Shown in full on the desktop sidebar; the non-home items fill "More". */
  nav: SuiteNavItem[];
  /** Page content (the router `<Outlet/>`). */
  children: React.ReactNode;

  /** Mobile center button actions (adaptive: 0 → hidden, 1 → plain button, 2+ → FAB + bottom sheet). */
  centralActions?: SuiteAction[];
  /** Center button label/icon (FAB + its accessible label; sheet title). Defaults: "Menu" / Plus. */
  centralLabel?: string;
  centralIcon?: LucideIcon;

  /**
   * Route of the app's marketplace page (e.g. "/suite"). When set, the shell renders the
   * suite-standard **"More Apps"** entry (consistent icon/label across apps) ahead of `actions`.
   */
  moreAppsTo?: string;
  /**
   * Opens the app's issue-reporting flow (each app's destination differs — a dialog, a prefilled
   * GitHub URL, …). When set, the shell renders the suite-standard **"Report an issue"** entry.
   */
  onReportIssue?: () => void;
  /** App-specific secondary actions (donate / emergency …) — shown in More + the sidebar footer. */
  actions?: SuiteAction[];
  /** App-specific extra content appended inside the More drawer (below the actions). */
  moreExtra?: React.ReactNode;
  /** Optional content above the nav inside More (e.g. a tier badge). */
  moreHeader?: React.ReactNode;

  /** Optional content above the nav in the desktop sidebar (e.g. a tier badge). */
  sidebarTop?: React.ReactNode;

  /** Top-right injected slot (app-owned): e.g. myHealth's family-profile button + drawer. */
  profile?: React.ReactNode;
  /** Optional built-in account button (top-right, tier ≥ 2). */
  account?: SuiteAccount;

  /** OS opener for the attribution link (Tauri). When absent, the attribution renders as text. */
  onExternal?: (href: string) => void;
  /** Classes for the centered content wrapper (e.g. "mx-auto max-w-3xl"). Default: full width. */
  contentClassName?: string;
}

const TONE_CLASS: Record<NonNullable<SuiteAction["tone"]>, string> = {
  default: "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
  primary: "text-primary hover:bg-primary/10",
  danger: "bg-destructive font-semibold text-destructive-foreground hover:opacity-90",
};

function navLinkClass(state: SuiteNavItem["state"]) {
  return ({ isActive }: { isActive: boolean }) =>
    cn(
      "flex items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
      isActive ? "bg-accent text-accent-foreground" : "hover:bg-accent/60",
      state === "nudge" && "text-muted-foreground",
    );
}

/** A row in the More drawer / sidebar footer: link (`to`) or button (`onSelect`). */
function ActionRow({ action, onNavigate }: { action: SuiteAction; onNavigate?: () => void }) {
  const Icon = action.icon;
  const cls = cn(
    "flex w-full items-center gap-3 rounded-md px-3 py-2 text-sm transition-colors",
    TONE_CLASS[action.tone ?? "default"],
  );
  const inner = (
    <>
      <Icon className="h-4 w-4 shrink-0" />
      <span className="flex-1 text-left">{action.label}</span>
    </>
  );
  if (action.to) {
    return (
      <NavLink to={action.to} className={cls} onClick={onNavigate}>
        {inner}
      </NavLink>
    );
  }
  return (
    <button
      type="button"
      className={cls}
      onClick={() => {
        onNavigate?.();
        action.onSelect?.();
      }}
    >
      {inner}
    </button>
  );
}

/**
 * A vertically-scrollable region for the desktop sidebar nav. The scrollbar is hidden; instead,
 * floating chevron buttons fade in at the top/bottom edge **only when** there is more to scroll in
 * that direction, and brighten on hover. This keeps the sidebar's own height independent of the
 * page content — a long nav scrolls inside the sidebar without affecting (or being affected by) the
 * main content's scroll.
 */
function SidebarScrollArea({ children }: { children: React.ReactNode }): React.ReactElement {
  const ref = React.useRef<HTMLDivElement>(null);
  const [canUp, setCanUp] = React.useState(false);
  const [canDown, setCanDown] = React.useState(false);

  const update = React.useCallback(() => {
    const el = ref.current;
    if (!el) return;
    setCanUp(el.scrollTop > 1);
    setCanDown(el.scrollTop + el.clientHeight < el.scrollHeight - 1);
  }, []);

  React.useEffect(() => {
    update();
    const el = ref.current;
    if (!el) return;
    // Re-evaluate when the viewport, the scroll region, or its contents change size.
    const ro = new ResizeObserver(update);
    ro.observe(el);
    for (const child of Array.from(el.children)) ro.observe(child);
    window.addEventListener("resize", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [update]);

  const scrollByStep = (dir: 1 | -1) =>
    ref.current?.scrollBy({ top: dir * 160, behavior: "smooth" });

  const edgeBtn =
    "absolute inset-x-0 z-10 flex h-7 items-center justify-center text-muted-foreground " +
    "opacity-60 transition-opacity hover:opacity-100";

  return (
    <div className="group/scroll relative min-h-0 flex-1">
      {canUp && (
        <button
          type="button"
          aria-label="Scroll navigation up"
          onClick={() => scrollByStep(-1)}
          className={cn(edgeBtn, "top-0 bg-gradient-to-b from-card via-card/90 to-transparent")}
        >
          <ChevronUp className="h-4 w-4" />
        </button>
      )}
      <div
        ref={ref}
        onScroll={update}
        className="h-full overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {children}
      </div>
      {canDown && (
        <button
          type="button"
          aria-label="Scroll navigation down"
          onClick={() => scrollByStep(1)}
          className={cn(edgeBtn, "bottom-0 bg-gradient-to-t from-card via-card/90 to-transparent")}
        >
          <ChevronDown className="h-4 w-4" />
        </button>
      )}
    </div>
  );
}

export function SuiteShell(props: SuiteShellProps): React.ReactElement {
  const {
    brand, nav, children, centralActions = [], centralLabel = "Menu", centralIcon,
    moreAppsTo, onReportIssue, actions = [], moreExtra, moreHeader, sidebarTop, profile, account,
    onExternal, contentClassName,
  } = props;

  // Suite-standard chrome first (same icon/label/order in every app), then the app's own actions.
  const allActions: SuiteAction[] = [
    ...(moreAppsTo
      ? [{ key: "suite:more-apps", label: "More Apps", icon: LayoutGrid, to: moreAppsTo }]
      : []),
    ...(onReportIssue
      ? [{ key: "suite:report-issue", label: "Report an issue", icon: Bug, onSelect: onReportIssue }]
      : []),
    ...actions,
  ];

  const [moreOpen, setMoreOpen] = React.useState(false);
  const [centralOpen, setCentralOpen] = React.useState(false);
  const { pathname } = useLocation();

  const homeItem = nav.find((it) => it.home) ?? nav[0];
  // The mobile More list = nav minus the home tab and minus any destination already reachable
  // as a central-action button (so it isn't listed twice on mobile). The desktop sidebar still
  // shows the full nav.
  const centralRoutes = new Set(centralActions.map((a) => a.to).filter(Boolean));
  const moreItems = nav.filter((it) => it !== homeItem && !centralRoutes.has(it.to));
  const moreActive = moreItems.some((it) => it.to === pathname);

  const CenterIcon = centralIcon ?? Plus;
  const attribution = (
    <SupportedByTokans
      onActivate={onExternal}
      asText={!onExternal}
      className="flex items-center justify-center gap-1.5 rounded-md px-3 py-2 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
    />
  );

  function fireCentral() {
    if (centralActions.length === 1) centralActions[0].onSelect?.();
    else if (centralActions.length > 1) setCentralOpen(true);
  }

  const accountButton =
    account && account.tier >= 2 ? (
      <button
        type="button"
        onClick={account.onClick}
        aria-label={account.label ?? "Account"}
        title={account.label ?? "Account"}
        className="flex h-9 w-9 items-center justify-center rounded-full bg-primary/10 text-sm font-semibold text-primary transition-colors hover:bg-primary/20"
      >
        {account.avatarText?.trim().charAt(0).toUpperCase() || "·"}
      </button>
    ) : null;

  return (
    // The shell is bounded to the viewport height so only <main> scrolls — the sidebar's height is
    // independent of the page content (it never grows with, or scrolls away with, tall content).
    <div className="flex h-screen w-full flex-col overflow-hidden md:flex-row">
      {/* Desktop sidebar — fixed full-height; its nav scrolls inside SidebarScrollArea. */}
      <aside className="hidden w-60 shrink-0 flex-col border-r bg-card md:flex">
        <div className="flex items-center gap-2 px-4 py-4 text-lg font-semibold">{brand}</div>
        {sidebarTop}
        <SidebarScrollArea>
          <nav className="mt-2 flex flex-col gap-1 px-2 pb-2">
            {nav.map((it) => {
              const Icon = it.icon;
              return (
                <NavLink
                  key={it.to}
                  to={it.to}
                  end={it.end ?? it.to === "/"}
                  className={navLinkClass(it.state)}
                  title={it.state === "nudge" ? it.lockHint : undefined}
                >
                  <Icon className="h-4 w-4" />
                  <span className="flex-1">{it.label}</span>
                  {it.state === "nudge" && <LockGlyph />}
                </NavLink>
              );
            })}
          </nav>
        </SidebarScrollArea>
        <div className="flex flex-col gap-1 border-t p-2">
          {allActions.map((a) => (
            <ActionRow key={a.key} action={a} />
          ))}
          {attribution}
        </div>
      </aside>

      {/* Main column */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Top bar: brand (mobile only) left, profile/account right (both viewports). */}
        <header className="flex items-center justify-between border-b bg-card px-4 py-3">
          <div className="flex items-center gap-2 font-semibold md:invisible">{brand}</div>
          <div className="flex items-center gap-2">
            {accountButton}
            {profile}
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto px-4 py-6 pb-24 md:px-8 md:pb-8">
          <div className={cn("w-full", contentClassName)}>{children}</div>
        </main>
      </div>

      {/* Mobile bottom bar: [home] · [center] · [More] */}
      <nav className="fixed inset-x-0 bottom-0 z-10 flex items-stretch justify-around border-t bg-card pb-[var(--safe-bottom,env(safe-area-inset-bottom))] md:hidden">
        {homeItem && (
          <NavLink
            to={homeItem.to}
            end={homeItem.end ?? homeItem.to === "/"}
            className={({ isActive }) =>
              cn(
                "flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px]",
                isActive ? "text-primary" : "text-muted-foreground",
              )
            }
          >
            <homeItem.icon className="h-5 w-5" />
            {homeItem.label}
          </NavLink>
        )}

        {centralActions.length === 1 ? (
          (() => {
            const A = centralActions[0];
            const AIcon = A.icon;
            const centerCls = "flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px]";
            // A single central action may be a link (`to`) or a button (`onSelect`). Render the
            // matching element so a link-based central button actually navigates.
            return A.to ? (
              <NavLink
                to={A.to}
                end={A.to === "/"}
                className={({ isActive }) =>
                  cn(centerCls, isActive ? "text-primary" : "text-muted-foreground")
                }
              >
                <AIcon className="h-5 w-5" />
                {A.label}
              </NavLink>
            ) : (
              <button
                type="button"
                onClick={fireCentral}
                className={cn(centerCls, "text-muted-foreground")}
              >
                <AIcon className="h-5 w-5" />
                {A.label}
              </button>
            );
          })()
        ) : centralActions.length > 1 ? (
          <button
            type="button"
            onClick={fireCentral}
            aria-label={centralLabel}
            className="flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] text-muted-foreground"
          >
            <span className="-mt-3 flex h-12 w-12 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-lg">
              <CenterIcon className="h-6 w-6" />
            </span>
            {centralLabel}
          </button>
        ) : null}

        <button
          type="button"
          onClick={() => setMoreOpen(true)}
          className={cn(
            "flex flex-1 flex-col items-center gap-0.5 py-2 text-[11px]",
            moreActive ? "text-primary" : "text-muted-foreground",
          )}
        >
          <MoreHorizontal className="h-5 w-5" />
          More
        </button>
      </nav>

      {/* More drawer */}
      <Sheet open={moreOpen} onOpenChange={setMoreOpen}>
        <SheetContent side="right" title="More">
          <div className="flex flex-1 flex-col overflow-y-auto p-2">
            {moreHeader && <div className="px-1 pb-2">{moreHeader}</div>}
            <nav className="flex flex-col gap-1">
              {moreItems.map((it) => {
                const Icon = it.icon;
                // NOT `SheetClose asChild`: Radix Slot string-joins `className` props, which
                // destroys NavLink's function form (the class attribute becomes the stringified
                // function and the row loses all styling). Close the drawer via onClick instead.
                return (
                  <NavLink
                    key={it.to}
                    to={it.to}
                    end={it.end ?? it.to === "/"}
                    className={navLinkClass(it.state)}
                    title={it.state === "nudge" ? it.lockHint : undefined}
                    onClick={() => setMoreOpen(false)}
                  >
                    <Icon className="h-4 w-4" />
                    <span className="flex-1">{it.label}</span>
                    {it.state === "nudge" && <LockGlyph />}
                  </NavLink>
                );
              })}
            </nav>
            {allActions.length > 0 && (
              <div className="mt-2 flex flex-col gap-1 border-t pt-2">
                {allActions.map((a) => (
                  <SheetClose asChild key={a.key}>
                    <div>
                      <ActionRow action={a} onNavigate={() => setMoreOpen(false)} />
                    </div>
                  </SheetClose>
                ))}
              </div>
            )}
            {moreExtra}
          </div>
          <div className="mt-auto border-t p-2">{attribution}</div>
        </SheetContent>
      </Sheet>

      {/* Central bottom sheet (only used when there are 2+ central actions) */}
      <Sheet open={centralOpen} onOpenChange={setCentralOpen}>
        <SheetContent side="bottom" title={centralLabel}>
          <div className="flex flex-col gap-1 px-2 pb-3">
            {centralActions.map((a) => (
              <SheetClose asChild key={a.key}>
                <div>
                  <ActionRow action={a} onNavigate={() => setCentralOpen(false)} />
                </div>
              </SheetClose>
            ))}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}

/** Small lock glyph for nudge nav items (kept inline to avoid a hard lucide import at module top). */
function LockGlyph() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      className="h-3.5 w-3.5 opacity-70" aria-hidden="true">
      <rect x="3" y="11" width="18" height="11" rx="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  );
}
