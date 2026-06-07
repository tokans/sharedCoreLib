/**
 * UIEngine Core Context and Hooks
 *
 * PATCHED — additions over the original:
 *  1. `customComponents` — registry mapping Custom component names to React impls.
 *     Passed through to CustomRenderer so external callers can register their own
 *     components without forking the library.
 *  2. `engineContext` — arbitrary runtime values (e.g. { mode: "signin" }).
 *     Injected into useConditionEvaluator so string hidden_condition expressions
 *     can reference `context.*` and have them evaluated correctly.
 *  Both are optional so all existing call-sites remain unchanged.
 */

import React, {
  createContext,
  useContext,
  useReducer,
  useCallback,
  useMemo,
  ReactNode,
  Context,
} from "react";
import {
  UIEngineContextValue,
  UISystemManifest,
  UIEngineState,
  UIEngineAction,
  UIEngineHandlers,
  ThemeDefinition,
  ResolvedAuth,
} from "./types";
import { evaluateComputed } from "../../libs/condition-evaluator";

// ─────────────────────────────────────────────────────────────────────────────
// CUSTOM COMPONENT REGISTRY TYPE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Props injected by the engine into every registered Custom component.
 *
 *  context  — the engineContext object passed to UIEngineProvider / UIManifestRenderer
 *  handlers — the full ActionHandlerMap so custom components can fire on_press actions
 *  children — pre-rendered sub_components resolved by ComponentRenderer; the custom
 *             component can render them directly or ignore them and manage its own layout
 */
export interface CustomComponentProps {
  context: Record<string, unknown>;
  handlers: UIEngineHandlers;
  children?: React.ReactNode;
}

/** Maps a component `name` (as declared in manifest.components) to its React implementation. */
export type CustomComponentRegistry = Record<
  string,
  React.ComponentType<CustomComponentProps>
>;

// ─────────────────────────────────────────────────────────────────────────────
// EXTENDED CONTEXT VALUE
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Re-declare UIEngineContextValue with the two new optional fields.
 * The original interface is imported from types.ts; we extend it here to avoid
 * modifying generated type files.
 */
export interface ExtendedUIEngineContextValue extends UIEngineContextValue {
  /** Registry of Custom component implementations. */
  customComponents?: CustomComponentRegistry;
  /**
   * Arbitrary runtime key-value pairs available to condition evaluators and
   * Custom component implementations. Renamed to `engineContext` internally to
   * avoid shadowing React's own `context` naming convention.
   */
  engineContext?: Record<string, unknown>;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONTEXT CREATION
// ─────────────────────────────────────────────────────────────────────────────

const UIEngineContext: Context<ExtendedUIEngineContextValue | undefined> =
  createContext<ExtendedUIEngineContextValue | undefined>(undefined);

export { UIEngineContext };

// ─────────────────────────────────────────────────────────────────────────────
// FALLBACK THEME
// ─────────────────────────────────────────────────────────────────────────────

const EMPTY_THEME: ThemeDefinition = {
  colors: {},
  typography: { scale: {} },
  spacing: {},
  radius: {},
  elevation: {},
  motion: {},
};

// ─────────────────────────────────────────────────────────────────────────────
// INITIAL STATE
// ─────────────────────────────────────────────────────────────────────────────

export function createInitialState(manifest: UISystemManifest): UIEngineState {
  const activeThemeKey = manifest.active_theme ?? "default";
  return {
    currentScreenKey: manifest.navigation?.initial_screen ?? "",
    currentBreakpoint: getInitialBreakpoint(manifest),
    isDarkMode: false,
    isAuthenticated: false,
    userRoleCategories: [],
    enabledFeatures: Object.keys(manifest.features ?? {}),
    componentStates: {},
    navigationStack: manifest.navigation
      ? [manifest.navigation.initial_screen]
      : [],
    resolvedAuth: undefined,
    activeThemeKey,
  };
}

function getInitialBreakpoint(manifest: UISystemManifest): string {
  const breakpoints = Object.entries(manifest.breakpoints ?? {}).sort(
    ([, a], [, b]) => a.min_width_px - b.min_width_px
  );
  return breakpoints[0]?.[0] || "default";
}

// ─────────────────────────────────────────────────────────────────────────────
// REDUCER  (unchanged from original)
// ─────────────────────────────────────────────────────────────────────────────

export function uiEngineReducer(
  state: UIEngineState,
  action: UIEngineAction
): UIEngineState {
  switch (action.type) {
    case "SET_SCREEN":
      return {
        ...state,
        currentScreenKey: action.payload,
        navigationStack: [action.payload],
      };
    case "PUSH_SCREEN":
      return {
        ...state,
        currentScreenKey: action.payload,
        navigationStack: [...state.navigationStack, action.payload],
      };
    case "POP_SCREEN": {
      const newStack = state.navigationStack.slice(0, -1);
      return {
        ...state,
        currentScreenKey:
          newStack[newStack.length - 1] || state.navigationStack[0],
        navigationStack:
          newStack.length > 0 ? newStack : state.navigationStack,
      };
    }
    case "SET_BREAKPOINT":
      return { ...state, currentBreakpoint: action.payload };
    case "SET_DARK_MODE":
      return { ...state, isDarkMode: action.payload };
    case "SET_AUTHENTICATED":
      return { ...state, isAuthenticated: action.payload };
    case "SET_ROLE_CATEGORIES":
      return { ...state, userRoleCategories: action.payload };
    case "SET_ENABLED_FEATURES":
      return { ...state, enabledFeatures: action.payload };
    case "SET_COMPONENT_STATE":
      return {
        ...state,
        componentStates: {
          ...state.componentStates,
          [action.payload.componentId]: action.payload.state,
        },
      };
    case "UPDATE_COMPONENT_STATE":
      return {
        ...state,
        componentStates: {
          ...state.componentStates,
          [action.payload.componentId]: {
            ...state.componentStates[action.payload.componentId],
            ...action.payload.updates,
          },
        },
      };
    case "SET_RESOLVED_AUTH":
      return { ...state, resolvedAuth: action.payload };
    case "SET_ACTIVE_THEME":
      return { ...state, activeThemeKey: action.payload };
    default:
      return state;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PROVIDER COMPONENT
// ─────────────────────────────────────────────────────────────────────────────

interface UIEngineProviderProps {
  manifest: UISystemManifest;
  handlers?: UIEngineHandlers;
  /** Registry of Custom component React implementations. */
  customComponents?: CustomComponentRegistry;
  /**
   * Runtime context values available to condition expressions and Custom impls.
   * Example: `{ mode: "signin" }` lets hidden_condition `"context.mode !== 'signin'"`
   * be evaluated correctly.
   */
  engineContext?: Record<string, unknown>;
  children: ReactNode;
}

export function UIEngineProvider({
  manifest,
  handlers = {},
  customComponents,
  engineContext,
  children,
}: UIEngineProviderProps) {
  const [state, dispatch] = useReducer(uiEngineReducer, manifest, createInitialState);

  const value: ExtendedUIEngineContextValue = useMemo(
    () => ({ manifest, state, handlers, dispatch, customComponents, engineContext }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [manifest, state, handlers, customComponents, engineContext]
  );

  return React.createElement(UIEngineContext.Provider, { value }, children);
}

// ─────────────────────────────────────────────────────────────────────────────
// HOOKS
// ─────────────────────────────────────────────────────────────────────────────

export function useUIEngine(): ExtendedUIEngineContextValue {
  const context = useContext(UIEngineContext);
  if (!context) {
    throw new Error("useUIEngine must be used within a UIEngineProvider");
  }
  return context;
}

export function useCurrentScreen() {
  const { manifest, state } = useUIEngine();
  return manifest.screens?.[state.currentScreenKey];
}

export function useComponent(componentKey: string) {
  const { manifest } = useUIEngine();
  return manifest.components?.[componentKey];
}

export function useButton(buttonKey: string) {
  const { manifest } = useUIEngine();
  return manifest.buttons?.[buttonKey];
}

export function useIcon(iconKey: string) {
  const { manifest } = useUIEngine();
  return manifest.icons?.[iconKey];
}

export function useTheme(): ThemeDefinition {
  const { manifest, state } = useUIEngine();
  const isDark = state.isDarkMode;
  const themes = manifest.themes ?? {};
  const activeKey = state.activeThemeKey;
  const theme = themes[activeKey] ?? EMPTY_THEME;

  return {
    ...theme,
    colors: {
      ...theme.colors,
      ...(isDark && theme.dark_mode ? theme.dark_mode : {}),
    },
  };
}

export function useBreakpoint() {
  const { manifest, state } = useUIEngine();
  return (manifest.breakpoints ?? {})[state.currentBreakpoint];
}

export function useNavigation() {
  const { dispatch, state } = useUIEngine();
  return {
    push: useCallback(
      (screenKey: string) => dispatch({ type: "PUSH_SCREEN", payload: screenKey }),
      [dispatch]
    ),
    pop: useCallback(() => dispatch({ type: "POP_SCREEN" }), [dispatch]),
    setScreen: useCallback(
      (screenKey: string) => dispatch({ type: "SET_SCREEN", payload: screenKey }),
      [dispatch]
    ),
    currentScreen: state.currentScreenKey,
    canGoBack: state.navigationStack.length > 1,
  };
}

export function useComponentState(componentId: string) {
  const { state, dispatch } = useUIEngine();
  const componentState = state.componentStates[componentId] || {};

  const setState = useCallback(
    (newState: Record<string, any>) =>
      dispatch({
        type: "SET_COMPONENT_STATE",
        payload: { componentId, state: newState },
      }),
    [componentId, dispatch]
  );

  const updateState = useCallback(
    (updates: Record<string, any>) =>
      dispatch({
        type: "UPDATE_COMPONENT_STATE",
        payload: { componentId, updates },
      }),
    [componentId, dispatch]
  );

  return { state: componentState, setState, updateState };
}

export function useFeatureGate(featureRef: string | undefined) {
  const { state } = useUIEngine();
  return featureRef ? state.enabledFeatures.includes(featureRef) : true;
}

export function useAccessControl(
  requiredRoles: string[] | undefined,
  requiredAccessLevels: string[] | undefined
) {
  const { state } = useUIEngine();

  const hasRoleAccess =
    !requiredRoles ||
    requiredRoles.length === 0 ||
    requiredRoles.some((r) => state.userRoleCategories.includes(r));

  const hasAccessLevel =
    !requiredAccessLevels ||
    requiredAccessLevels.length === 0 ||
    (state.resolvedAuth?.accessLevel != null &&
      requiredAccessLevels.includes(state.resolvedAuth.accessLevel));

  return hasRoleAccess && hasAccessLevel;
}

export function useResolvedAuth(): ResolvedAuth | undefined {
  const { state } = useUIEngine();
  return state.resolvedAuth;
}

export function useAuthFieldFilter(): (fieldId: string) => boolean {
  const { state } = useUIEngine();
  const allowedFields = state.resolvedAuth?.fields;
  if (!allowedFields || allowedFields.length === 0) return () => true;
  const set = new Set(allowedFields);
  return (fieldId: string) => set.has(fieldId);
}

/**
 * PATCHED — string branch now evaluates the expression using `new Function` with
 * `context` (engineContext) and `state` (componentStates) in scope.
 *
 * This powers hidden_condition strings like `"context.mode !== 'signin'"` that
 * reference the runtime engineContext passed to UIEngineProvider.
 *
 * Security note: only call this with expressions sourced from your own manifests,
 * not from untrusted user input.
 */
export function useConditionEvaluator() {
  const { state, engineContext } = useUIEngine();

  return useCallback(
    (
      condition:
        | string
        | { ref?: string; field?: string; operator?: string; value?: any }
        | undefined
    ): boolean => {
      if (!condition) return true;

      // ── String expression (e.g. "context.mode !== 'signin'") ──────────────
      // Evaluated with the SAST-safe interpreter (no eval / no new Function).
      // `context.*` resolves against engineContext and `fields.*` against
      // componentStates. This keeps the "zero eval" security guarantee intact
      // and removes the need for `unsafe-eval` in the CSP.
      if (typeof condition === "string") {
        const states = (state.componentStates ?? {}) as Record<string, unknown>;
        const ctx = (engineContext ?? {}) as Record<string, unknown>;
        return Boolean(evaluateComputed(condition, states, ctx));
      }

      // ── Named condition ref (manifest.conditions[ref]) ────────────────────
      if ("ref" in condition) {
        // Named condition resolution — placeholder; extend when manifest.conditions lands
        return true;
      }

      // ── Field-operator-value condition (uses componentStates) ─────────────
      if ("field" in condition && "operator" in condition) {
        const { field, operator, value } = condition;
        const fieldValue = (state.componentStates as any)[field!];

        switch (operator) {
          case "eq":           return fieldValue === value;
          case "ne":           return fieldValue !== value;
          case "gt":           return fieldValue > value;
          case "gte":          return fieldValue >= value;
          case "lt":           return fieldValue < value;
          case "lte":          return fieldValue <= value;
          case "in":           return Array.isArray(value) && value.includes(fieldValue);
          case "not_in":       return !Array.isArray(value) || !value.includes(fieldValue);
          case "contains":     return String(fieldValue).includes(String(value));
          case "starts_with":  return String(fieldValue).startsWith(String(value));
          case "ends_with":    return String(fieldValue).endsWith(String(value));
          case "is_empty":     return !fieldValue || (fieldValue as any).length === 0;
          case "is_not_empty": return !!fieldValue && (fieldValue as any).length > 0;
          default:             return true;
        }
      }

      return true;
    },
    [state, engineContext]
  );
}

export function useResponsiveValue<T>(
  values: Record<string, T>,
  defaultValue: T
): T {
  const { state } = useUIEngine();
  return values[state.currentBreakpoint] ?? values["default"] ?? defaultValue;
}

export function useTransition(transitionKey: string | undefined) {
  const { manifest } = useUIEngine();
  if (!transitionKey) return undefined;
  return manifest.transitions?.[transitionKey];
}

export function useToast(toastKey: string | undefined) {
  const { manifest } = useUIEngine();
  if (!toastKey) return undefined;
  return manifest.toasts?.[toastKey];
}

export function useDialog(dialogKey: string | undefined) {
  const { manifest } = useUIEngine();
  if (!dialogKey) return undefined;
  return manifest.dialogs?.[dialogKey];
}

export function useThemeRegistry(): Record<string, ThemeDefinition> {
  const { manifest } = useUIEngine();
  return manifest.themes ?? {};
}

export function useThemeSwitcher() {
  const { dispatch } = useUIEngine();
  return useCallback(
    (themeKey: string) =>
      dispatch({ type: "SET_ACTIVE_THEME", payload: themeKey }),
    [dispatch]
  );
}