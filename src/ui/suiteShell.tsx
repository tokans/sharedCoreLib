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
import { Bug, ChevronDown, ChevronUp, Handshake, Heart, LayoutGrid, MoreHorizontal, PanelLeftClose, PanelLeftOpen, Plus, RotateCw, type LucideIcon } from "lucide-react";
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
  /**
   * ADDITIVE — petal colour (hex, e.g. "#ef4444") for the `centralVariant="arch"` rainbow FAB only.
   * Ignored by the sheet/More/sidebar rows (those use `tone`). When omitted, the arch auto-assigns
   * a colour from a built-in rainbow palette by index, so the arch is always colourful.
   */
  color?: string;
}

/**
 * The suite-standard support call-to-action (donate → partner). The shell owns the full state
 * machine so it is identical across apps; the app supplies only its donation state + the openers
 * (and, where terminology differs, label overrides). Resolution order:
 *   1. `isPartner` (or `hidden`) ⇒ no CTA (top of the support ladder / suppressed);
 *   2. `pending` (donated, signed grant not imported yet) ⇒ **"Restart after donation"** → `onRestart`;
 *   3. `isSupporter` + offer open ⇒ **"Become a Partner"** → `onPartner`;
 *   4. `isSupporter` + `partnerOfferActive === false` ⇒ **"Reopen Partner signup"** → `onReopen`;
 *   5. otherwise ⇒ **"Donate to support"** → `onDonate`.
 */
export interface SuiteSupport {
  /** Has the user donated (Supporter / Patron)? When true the CTA flips to the partner ladder. */
  isSupporter: boolean;
  /** Already a Partner? When true the CTA is hidden (top of the support ladder). */
  isPartner?: boolean;
  /** Donated but the signed grant isn't imported yet — show a "restart / import" CTA. */
  pending?: boolean;
  /** Is the time-limited Partner offer currently open? Defaults to open (`true`) when omitted. */
  partnerOfferActive?: boolean;
  /** Open the donation flow (shown when not yet a Supporter). */
  onDonate: () => void;
  /** Open the partner / professional signup (shown once a Supporter, offer open). */
  onPartner: () => void;
  /** Re-open the Partner window via re-donation (Supporter, offer closed). Falls back to `onDonate`. */
  onReopen?: () => void;
  /** Import / scan for the grant after donating (pending). Falls back to `onDonate`. */
  onRestart?: () => void;
  /** Force-hide the CTA (e.g. until the app's chosen tier threshold is reached). */
  hidden?: boolean;
  /** Per-app label overrides — terminology differs ("Donate to support" vs "Become a Patron"). */
  labels?: { donate?: string; partner?: string; reopen?: string; restart?: string };
}

/** Resolve the suite-standard support CTA from donation state, or null when none should show. */
export function supportCta(support: SuiteSupport | undefined): SuiteAction | null {
  if (!support || support.hidden || support.isPartner) return null;
  const L = support.labels ?? {};
  if (!support.isSupporter && support.pending) {
    return { key: "suite:support-restart", label: L.restart ?? "Restart after donation", icon: RotateCw, onSelect: support.onRestart ?? support.onDonate, tone: "primary" };
  }
  if (support.isSupporter) {
    if (support.partnerOfferActive === false) {
      return { key: "suite:partner-reopen", label: L.reopen ?? "Reopen Partner signup", icon: Handshake, onSelect: support.onReopen ?? support.onDonate, tone: "primary" };
    }
    return { key: "suite:partner", label: L.partner ?? "Become a Partner", icon: Handshake, onSelect: support.onPartner, tone: "primary" };
  }
  return { key: "suite:donate", label: L.donate ?? "Donate to support", icon: Heart, onSelect: support.onDonate, tone: "primary" };
}

/** Optional built-in account button (top-right). Rendered only at tier ≥ 2 — free apps stay login-less. */
export interface SuiteAccount {
  tier: number;
  /** Single initial / short text for the avatar; falls back to a user glyph. */
  avatarText?: string;
  label?: string;
  onClick?: () => void;
}

/** A switchable member shown in the user-switch affordance. */
export interface SuiteUserSwitchMember {
  /** Stable member key (e.g. the person_key). */
  key: string;
  label: string;
  /** Single initial / short text for the avatar; falls back to the label's first character. */
  avatarText?: string;
}

/**
 * ADDITIVE (K0.4.3) — the multi-user switch affordance, PAID-GATED BY CONSTRUCTION: the
 * shell renders it ONLY when this prop is provided AND `members.length > 1`. A free
 * single-primary-user app passes nothing and the chrome is pixel-identical to today
 * (invariant 3: free tier stays login-less and visually unchanged). Member management
 * itself lives in myLifeAssistant — this is just the injected switcher slot.
 */
export interface SuiteUserSwitch {
  /** Key of the active member. */
  current: string;
  members: SuiteUserSwitchMember[];
  onSwitch: (memberKey: string) => void;
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
   * ADDITIVE — how the 2+ `centralActions` are presented on mobile:
   *   - `"sheet"` (default) → a raised FAB that opens a bottom sheet listing the actions (unchanged).
   *   - `"arch"` → a raised FAB that fans the actions out in a **rainbow semicircular arch** of
   *     coloured icon petals (scrim + Escape to close; petals are real NavLinks/buttons). Each
   *     petal's colour comes from `SuiteAction.color`, else a built-in rainbow palette by index.
   * With 0/1 central actions both variants behave identically (hidden / plain button).
   */
  centralVariant?: "sheet" | "arch";

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
  /**
   * ADDITIVE — the suite-standard **support call-to-action**, rendered by the shell itself so the
   * donate→partner flip is identical in every app (CONTRACT §4.1). The shell resolves which CTA to
   * show from the donation state:
   *   - already a Partner ⇒ no CTA (top of the support ladder);
   *   - already a Supporter/Patron (donated) ⇒ **"Become a Partner"** (Handshake) → `onPartner`;
   *   - otherwise ⇒ **"Donate to support"** (Heart) → `onDonate`.
   * Set `hidden` to suppress it (e.g. until an app's chosen tier threshold). Apps pass the booleans
   * from their own tier/grant state; the labels, icons, order, and flip live in core.
   */
  support?: SuiteSupport;
  /** App-specific extra content appended inside the More drawer (below the actions). */
  moreExtra?: React.ReactNode;
  /** Optional content above the nav inside More (e.g. a tier badge). */
  moreHeader?: React.ReactNode;

  /** Optional content above the nav in the desktop sidebar (e.g. a tier badge). */
  sidebarTop?: React.ReactNode;

  /**
   * ADDITIVE — an app-owned slot centered in the DESKTOP top bar only (md+, where the
   * sidebar layout has the room), between the (desktop-invisible) brand and the
   * profile/account/userSwitch group on the right. For a page-level action bar (e.g. a
   * content editor's Save/Submit buttons) that wants to sit in the SAME row as the profile
   * icon rather than stacking its own header underneath. Never shown on mobile — the app
   * should render its own compact fallback there. Hidden entirely when omitted — existing
   * apps are pixel-identical.
   */
  topBarCenter?: React.ReactNode;
  /**
   * ADDITIVE — also render `topBarCenter` in the MOBILE top bar (by default it is desktop-only).
   * Opt-in so existing apps that supply a desktop-only centre slot are unaffected; apps that want
   * their top-bar content (e.g. a reader's page controls) available on phones set this true and
   * make that content responsive/compact.
   */
  topBarCenterOnMobile?: boolean;
  /** Top-right injected slot (app-owned): e.g. myHealth's family-profile button + drawer. */
  profile?: React.ReactNode;
  /** Optional built-in account button (top-right, tier ≥ 2). */
  account?: SuiteAccount;
  /** ADDITIVE (K0.4.3): paid multi-user switcher — rendered ONLY when provided AND members.length > 1. */
  userSwitch?: SuiteUserSwitch;

  /** OS opener for the attribution link (Tauri). When absent, the attribution renders as text. */
  onExternal?: (href: string) => void;
  /** Classes for the centered content wrapper (e.g. "mx-auto max-w-3xl"). Default: full width. */
  contentClassName?: string;

  /**
   * ADDITIVE — collapse the desktop sidebar to an icon-only rail (frees width for the page
   * content; the same idea as `sharedcorelib/ui`'s `ExplorerPanel`). Controlled: both props
   * must be supplied to opt in. Omitting either keeps today's fixed-width sidebar, pixel-
   * identical for every app that hasn't adopted this yet.
   */
  sidebarCollapsed?: boolean;
  onSidebarCollapsedChange?: (collapsed: boolean) => void;
}

const TONE_CLASS: Record<NonNullable<SuiteAction["tone"]>, string> = {
  default: "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
  primary: "text-primary hover:bg-primary/10",
  danger: "bg-destructive font-semibold text-destructive-foreground hover:opacity-90",
};

/**
 * Built-in rainbow palette for the `centralVariant="arch"` petals — used (by index, cycling) for any
 * action that omits its own `color`, so the arch is always colourful without the app specifying hues.
 */
const ARCH_PALETTE = [
  "#ef4444", "#f97316", "#f59e0b", "#22c55e", "#3b82f6", "#6366f1", "#8b5cf6", "#ec4899",
];

/** Radius of the arch (px) and the angular sweep across the upper semicircle (degrees). */
const ARCH_RADIUS = 128;
const ARCH_START = 200; // left-ish
const ARCH_END = 340; // right-ish

/** Polar → screen offset for petal `i` of `n`, along the upper arch (y is negative = upward). */
function archPetalOffset(i: number, n: number): { x: number; y: number } {
  const t = n <= 1 ? 0.5 : i / (n - 1);
  const deg = ARCH_START + t * (ARCH_END - ARCH_START);
  const rad = (deg * Math.PI) / 180;
  return { x: Math.cos(rad) * ARCH_RADIUS, y: Math.sin(rad) * ARCH_RADIUS };
}

/**
 * The rainbow-arch central FAB (mobile-only; rendered when `centralVariant="arch"` and there are 2+
 * `centralActions`). Tapping the FAB fans the actions out in a coloured semicircular arch of icon
 * petals; the scrim or Escape closes it. Petals are real NavLinks (`to`) or buttons (`onSelect`)
 * with aria-labels; the FAB carries `aria-expanded`. A faithful port of myHome's QuickFab geometry.
 */
function CentralArch({
  actions, label, icon: CenterIcon,
}: { actions: SuiteAction[]; label: string; icon: LucideIcon }): React.ReactElement {
  const [open, setOpen] = React.useState(false);
  const { pathname } = useLocation();

  // Close on route change (a petal navigated) and on Escape.
  React.useEffect(() => setOpen(false), [pathname]);
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const petalInner = (a: SuiteAction, i: number) => {
    const Icon = a.icon;
    return (
      <>
        <span
          className="flex h-12 w-12 items-center justify-center rounded-full text-white shadow-lg ring-2 ring-white/70 transition-transform group-hover:scale-110 group-focus-visible:scale-110 dark:ring-white/30"
          style={{ backgroundColor: a.color ?? ARCH_PALETTE[i % ARCH_PALETTE.length] }}
        >
          <Icon className="h-5 w-5" />
        </span>
        <span className="mt-1 max-w-[5.5rem] rounded-full bg-card/95 px-2 py-0.5 text-center text-[10px] font-medium leading-tight text-foreground shadow-sm">
          {a.label}
        </span>
      </>
    );
  };

  return (
    <>
      {/* Scrim — closes the fan; fades in only while open. */}
      <button
        type="button"
        aria-hidden={!open}
        tabIndex={-1}
        onClick={() => setOpen(false)}
        className={cn(
          "fixed inset-0 z-30 bg-foreground/20 backdrop-blur-[1px] transition-opacity duration-200 md:hidden",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />

      {/* Anchor for the FAB + the arch of petals. Lift above the home indicator. */}
      <div className="pointer-events-none fixed inset-x-0 bottom-[calc(0.75rem_+_var(--safe-bottom,env(safe-area-inset-bottom)))] z-40 flex justify-center md:hidden">
        <div className="pointer-events-auto relative">
          {/* Petals — absolutely centred on the FAB, translated out along the arch. */}
          {actions.map((a, i) => {
            const { x, y } = archPetalOffset(i, actions.length);
            const style: React.CSSProperties = {
              transform: open
                ? `translate(calc(-50% + ${x}px), calc(-50% + ${y}px))`
                : "translate(-50%, -50%) scale(0.4)",
              opacity: open ? 1 : 0,
              pointerEvents: open ? "auto" : "none",
              transition: "transform 320ms cubic-bezier(0.34,1.56,0.64,1), opacity 200ms ease",
              transitionDelay: open ? `${i * 35}ms` : `${(actions.length - i) * 20}ms`,
            };
            const cls = "group absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 flex-col items-center";
            return a.to ? (
              <NavLink
                key={a.key}
                to={a.to}
                aria-label={a.label}
                title={a.label}
                tabIndex={open ? 0 : -1}
                className={cls}
                style={style}
              >
                {petalInner(a, i)}
              </NavLink>
            ) : (
              <button
                key={a.key}
                type="button"
                aria-label={a.label}
                title={a.label}
                tabIndex={open ? 0 : -1}
                onClick={() => { setOpen(false); a.onSelect?.(); }}
                className={cls}
                style={style}
              >
                {petalInner(a, i)}
              </button>
            );
          })}

          {/* The FAB itself. */}
          <button
            type="button"
            aria-label={label}
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="relative flex h-14 w-14 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-xl ring-4 ring-background transition-transform active:scale-95"
          >
            <CenterIcon
              className="h-7 w-7 transition-transform duration-300"
              style={{ transform: open ? "rotate(135deg)" : "rotate(0deg)" }}
            />
          </button>
        </div>
      </div>
    </>
  );
}

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
  const inner = React.useRef<HTMLDivElement>(null);
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
    // Observe just the container + the single content wrapper (not every nav child) —
    // one observation catches content growth without an N-item observer fan-out.
    const ro = new ResizeObserver(update);
    ro.observe(el);
    if (inner.current) ro.observe(inner.current);
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
        <div ref={inner}>{children}</div>
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
    centralVariant = "sheet",
    moreAppsTo, onReportIssue, actions = [], support, moreExtra, moreHeader, sidebarTop, topBarCenter, topBarCenterOnMobile, profile, account, userSwitch,
    onExternal, contentClassName, sidebarCollapsed, onSidebarCollapsedChange,
  } = props;
  // Controlled opt-in: both the value AND the setter must be supplied, or the sidebar stays
  // at today's fixed width (existing apps that haven't adopted this are unaffected).
  const sidebarCollapsible = onSidebarCollapsedChange !== undefined;
  const collapsed = sidebarCollapsible && !!sidebarCollapsed;

  // Suite-standard chrome first (same icon/label/order in every app), then the app's own actions,
  // then the suite-standard support CTA (donate → partner, resolved in core so it's identical
  // everywhere). Memoized so the shell (re-rendered on every navigation + drawer toggle) doesn't
  // rebuild these arrays/Set each render.
  const allActions = React.useMemo<SuiteAction[]>(() => {
    const supportAction = supportCta(support);
    return [
      ...(moreAppsTo
        ? [{ key: "suite:more-apps", label: "More Apps", icon: LayoutGrid, to: moreAppsTo }]
        : []),
      ...(onReportIssue
        ? [{ key: "suite:report-issue", label: "Report an issue", icon: Bug, onSelect: onReportIssue }]
        : []),
      ...actions,
      ...(supportAction ? [supportAction] : []),
    ];
  }, [moreAppsTo, onReportIssue, actions, support]);

  const [moreOpen, setMoreOpen] = React.useState(false);
  const [centralOpen, setCentralOpen] = React.useState(false);
  const { pathname } = useLocation();

  const homeItem = React.useMemo(() => nav.find((it) => it.home) ?? nav[0], [nav]);
  // The mobile More list = nav minus the home tab and minus any destination already reachable
  // as a central-action button (so it isn't listed twice on mobile). The desktop sidebar still
  // shows the full nav.
  const centralRoutes = React.useMemo(
    () => new Set(centralActions.map((a) => a.to).filter(Boolean)),
    [centralActions],
  );
  const moreItems = React.useMemo(
    () => nav.filter((it) => it !== homeItem && !centralRoutes.has(it.to)),
    [nav, homeItem, centralRoutes],
  );
  const moreActive = moreItems.some((it) => it.to === pathname);

  const CenterIcon = centralIcon ?? Plus;
  // The rainbow arch is an opt-in central variant: it renders its own overlay FAB + petals, so when
  // active (2+ actions) the bottom-bar keeps a 2-slot layout (home · More) and the central sheet is
  // not used. The default "sheet" variant is byte-identical to before.
  const useArch = centralVariant === "arch" && centralActions.length > 1;
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

  // PAID-GATED BY CONSTRUCTION (K0.4.3): nothing renders unless the prop exists AND there is
  // more than one member — a free single-primary-user app is pixel-identical without it.
  const userSwitchEl =
    userSwitch && userSwitch.members.length > 1 ? (
      <div className="flex items-center gap-1" role="group" aria-label="Switch user">
        {userSwitch.members.map((m) => (
          <button
            key={m.key}
            type="button"
            onClick={() => { if (m.key !== userSwitch.current) userSwitch.onSwitch(m.key); }}
            aria-pressed={m.key === userSwitch.current}
            aria-label={`Switch to ${m.label}`}
            title={m.label}
            className={cn(
              "flex h-8 w-8 items-center justify-center rounded-full text-xs font-semibold transition-colors",
              m.key === userSwitch.current
                ? "bg-primary text-primary-foreground"
                : "bg-muted text-muted-foreground hover:bg-accent hover:text-accent-foreground",
            )}
          >
            {(m.avatarText ?? m.label).trim().charAt(0).toUpperCase() || "·"}
          </button>
        ))}
      </div>
    ) : null;

  return (
    // The shell is bounded to the viewport height so only <main> scrolls — the sidebar's height is
    // independent of the page content (it never grows with, or scrolls away with, tall content).
    <div className="flex h-screen w-full flex-col overflow-hidden md:flex-row">
      {/* Desktop sidebar — fixed full-height; its nav scrolls inside SidebarScrollArea.
          Collapsible to an icon-only rail when the app opts in (sidebarCollapsed +
          onSidebarCollapsedChange both supplied) — see ExplorerPanel for the same idea
          applied to an app-owned panel. */}
      <aside className={cn("hidden shrink-0 flex-col border-r bg-card md:flex", collapsed ? "w-14" : "w-60")}>
        <div className={cn("flex items-center gap-2 px-4 py-4 text-lg font-semibold", collapsed && "justify-center px-2")}>
          {collapsed ? null : brand}
        </div>
        {!collapsed && sidebarTop}
        <SidebarScrollArea>
          <nav className={cn("mt-2 flex flex-col gap-1 px-2 pb-2", collapsed && "items-center px-1")}>
            {nav.map((it) => {
              const Icon = it.icon;
              return (
                <NavLink
                  key={it.to}
                  to={it.to}
                  end={it.end ?? it.to === "/"}
                  className={navLinkClass(it.state)}
                  title={collapsed ? it.label : it.state === "nudge" ? it.lockHint : undefined}
                >
                  <Icon className="h-4 w-4 shrink-0" />
                  {!collapsed && <span className="flex-1">{it.label}</span>}
                  {!collapsed && it.state === "nudge" && <LockGlyph />}
                </NavLink>
              );
            })}
          </nav>
        </SidebarScrollArea>
        <div className={cn("flex flex-col gap-1 border-t p-2", collapsed && "items-center")}>
          {sidebarCollapsible && (
            <button
              type="button"
              aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
              onClick={() => onSidebarCollapsedChange?.(!collapsed)}
              className="flex h-8 w-8 items-center justify-center self-end rounded text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground"
            >
              {collapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
            </button>
          )}
          {!collapsed && allActions.map((a) => (
            <ActionRow key={a.key} action={a} />
          ))}
          {!collapsed && attribution}
        </div>
      </aside>

      {/* Main column */}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        {/* Top bar: brand (mobile only) left, an optional app-injected centre slot, then
            profile/account right (both viewports). Pads for the notch/status bar (top)
            and a landscape notch (left/right). */}
        <header className="relative flex items-center justify-between gap-3 border-b bg-card pb-3 pl-[calc(1rem_+_var(--safe-left,env(safe-area-inset-left)))] pr-[calc(1rem_+_var(--safe-right,env(safe-area-inset-right)))] pt-[calc(0.75rem_+_var(--safe-top,env(safe-area-inset-top)))]">
          {/* CHANGED md:invisible to md:hidden */}
          <div className="flex items-center gap-2 font-semibold md:hidden">{brand}</div>
          
          {/* LEFT-aligned container filling the remaining space */}
          {topBarCenter && (
            <div className={cn("min-w-0 flex-1 items-center justify-start gap-3", topBarCenterOnMobile ? "flex" : "hidden md:flex")}>{topBarCenter}</div>
          )}
          <div className="flex items-center gap-2">
            {userSwitchEl}
            {accountButton}
            {profile}
          </div>
        </header>

        <main className="min-h-0 flex-1 overflow-y-auto py-6 pl-[calc(1rem_+_var(--safe-left,env(safe-area-inset-left)))] pr-[calc(1rem_+_var(--safe-right,env(safe-area-inset-right)))] pb-[calc(6rem_+_var(--safe-bottom,env(safe-area-inset-bottom)))] md:px-8 md:pb-8">
          <div className={cn("w-full", contentClassName)}>{children}</div>
        </main>
      </div>

      {/* Mobile bottom bar: [home] · [center] · [More] */}
      <nav className="fixed inset-x-0 bottom-0 z-10 flex items-stretch justify-around border-t bg-card pb-[var(--safe-bottom,env(safe-area-inset-bottom))] pl-[env(safe-area-inset-left)] pr-[env(safe-area-inset-right)] md:hidden">
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
        ) : centralActions.length > 1 && !useArch ? (
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

      {/* Central bottom sheet (default "sheet" variant only, with 2+ central actions) */}
      {!useArch && (
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
      )}

      {/* Central rainbow arch (opt-in "arch" variant only, with 2+ central actions) */}
      {useArch && <CentralArch actions={centralActions} label={centralLabel} icon={CenterIcon} />}
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
