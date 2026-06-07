/**
 * UIEngine Main Export
 * Core UI rendering engine aligned with ui_design.yaml
 */

export * from './types';
export {
  UIEngineContext,
  UIEngineProvider,
  createInitialState,
  uiEngineReducer,
  // Hooks
  useUIEngine,
  useCurrentScreen,
  useComponent,
  useButton,
  useIcon,
  useTheme,
  useBreakpoint,
  useNavigation,
  useComponentState,
  useFeatureGate,
  useAccessControl,
  useResolvedAuth,
  useAuthFieldFilter,
  useConditionEvaluator,
  useResponsiveValue,
  useTransition,
  useToast,
  useDialog,
  useThemeRegistry,
  useThemeSwitcher,
} from './context';

export {
  LoadingIndicator,
  EmptyStateRenderer,
  ErrorStateRenderer,
  ComponentRenderer,
  type ComponentRendererProps,
} from './renderers';

export {
  LayoutContainer,
  ScreenLayout,
  ResponsiveLayout,
  SubComponentPlacementRenderer,
  type LayoutProps,
} from './layout';

