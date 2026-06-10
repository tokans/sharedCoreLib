/**
 * UI foundation — app-agnostic.
 *
 * Two tiers of export:
 *
 *  1. **Purge-safe** (no `content`-config change needed): `cn` (clsx + tailwind-merge), the
 *     suite-wide publisher **attribution** ("Supported by Tokans.org"), and the unstyled
 *     responsive **`AppHarness`** primitive. None bake Tailwind utility classes.
 *
 *  2. **Primitive UI kit** (requires the §4.2 theming + content-glob policy): the shared
 *     **`Sheet`** drawer and the opinionated **`SuiteShell`** (sidebar + mobile top bar +
 *     three-button bottom bar + central sheet + More drawer + profile slot + tier-gated account
 *     button). These bake Tailwind utilities, so a consuming app MUST use the shared Tailwind
 *     preset (`sharedcorelib/tailwind-preset`) + base `theme.css` (`sharedcorelib/ui/theme.css`)
 *     and add `../sharedCoreLib/src/ui/**` to its Tailwind `content` globs, or the classes purge.
 *
 * Still in-app (next UI step): the shadcn primitives (Button/Input/Dialog/…) and `FiniteSetInput`
 * (needs the app's master-data hook injected). See CONTRACT.md §4.
 */
export { cn, type ClassValue } from "./cn.js";

export {
  SupportedByTokans,
  tokansAttribution,
  SUPPORTED_BY_LABEL,
  TOKANS_URL,
  type SupportedByTokansProps,
} from "./attribution.js";
export { TOKANS_LOGO_DATA_URI } from "./tokansLogo.js";
export {
  AppHarness, pickOrientation, useViewportWidth, themeStyle, chromeActions,
  DEFAULT_THEME,
  type Orientation, type ThemeTokens, type SuiteThemeToken,
  type HarnessChrome, type AppHarnessProps, type HarnessSlot, type HarnessRenderContext,
} from "./harness.js";

// Primitive UI kit (Tailwind-styled — requires the §4.2 preset + theme.css + content glob).
export { Sheet, SheetClose, SheetContent, type SheetSide, type SheetContentProps } from "./sheet.js";
export {
  SuiteShell,
  type SuiteShellProps, type SuiteNavItem, type SuiteAction, type SuiteAccount,
} from "./suiteShell.js";
