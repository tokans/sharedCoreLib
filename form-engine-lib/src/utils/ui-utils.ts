/**
 * UIEngine & UIBuilder Utilities
 * Helper functions for manifest validation, theme handling, and utilities
 */

import {
  UIDesignManifest,
  Theme,
  Breakpoint,
  Component,
  Button,
  ConditionOrRef,
} from '../components/UIEngine/types';
import { evaluateComputed } from '../libs/condition-evaluator';

// ─────────────────────────────────────────────────────────────────────────────
// MANIFEST VALIDATION
// ─────────────────────────────────────────────────────────────────────────────

export interface ValidationError {
  path: string;
  message: string;
  severity: 'error' | 'warning';
}

export function validateManifest(manifest: UIDesignManifest): ValidationError[] {
  const errors: ValidationError[] = [];

  // Check required fields
  if (!manifest.manifest_id) {
    errors.push({
      path: 'manifest_id',
      message: 'manifest_id is required',
      severity: 'error',
    });
  }

  if (!manifest.themes) {
    errors.push({
      path: 'theme',
      message: 'theme configuration is required',
      severity: 'error',
    });
  }

  if (!manifest.navigation) {
    errors.push({
      path: 'navigation',
      message: 'navigation configuration is required',
      severity: 'error',
    });
  }

  if (!manifest.navigation?.initial_screen) {
    errors.push({
      path: 'navigation.initial_screen',
      message: 'initial_screen must be specified',
      severity: 'error',
    });
  }

  // Check initial screen exists
  if (manifest.navigation?.initial_screen && !manifest.screens?.[manifest.navigation.initial_screen]) {
    errors.push({
      path: 'navigation.initial_screen',
      message: `Screen "${manifest.navigation.initial_screen}" referenced but not defined`,
      severity: 'error',
    });
  }

  // Validate component references
  Object.entries(manifest.components || {}).forEach(([componentKey, component]) => {
    if (component.sub_components) {
      component.sub_components.forEach((sub, idx) => {
        if (!manifest.components?.[sub.component_ref]) {
          errors.push({
            path: `components.${componentKey}.sub_components[${idx}]`,
            message: `Sub-component "${sub.component_ref}" not found`,
            severity: 'error',
          });
        }
      });
    }

    if (component.actions) {
      component.actions.forEach((action, idx) => {
        if ('button_ref' in action && !manifest.buttons?.[action.button_ref]) {
          errors.push({
            path: `components.${componentKey}.actions[${idx}]`,
            message: `Button "${action.button_ref}" not found`,
            severity: 'error',
          });
        }
      });
    }
  });

  // Validate screen component references
  Object.entries(manifest.screens || {}).forEach(([screenKey, screen]) => {
    screen.components?.forEach((placement, idx) => {
      if (!manifest.components?.[placement.component_ref]) {
        errors.push({
          path: `screens.${screenKey}.components[${idx}]`,
          message: `Component "${placement.component_ref}" not found`,
          severity: 'error',
        });
      }
    });
  });

  return errors;
}

// ─────────────────────────────────────────────────────────────────────────────
// THEME UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

export function getThemeVariable(theme: Theme, path: string): string | number | undefined {
  const keys = path.split('.');
  let value: any = theme;

  for (const key of keys) {
    if (value && typeof value === 'object' && key in value) {
      value = value[key];
    } else {
      return undefined;
    }
  }

  return value;
}

export function applyThemeToDOM(theme: Theme, isDarkMode: boolean = false) {
  const colors = {
    ...theme.colors,
    ...(isDarkMode && theme.dark_mode ? theme.dark_mode : {}),
  };

  // Set CSS custom properties
  const root = document.documentElement;

  Object.entries(colors).forEach(([key, value]) => {
    root.style.setProperty(`--color-${key}`, value);
  });

  if (theme.typography) {
    root.style.setProperty(
      '--font-family-default',
      theme.typography.font_family_default || 'system-ui, sans-serif'
    );
    root.style.setProperty(
      '--font-family-mono',
      theme.typography.font_family_mono || 'monospace'
    );

    Object.entries(theme.typography.scale || {}).forEach(([key, value]) => {
      root.style.setProperty(`--font-size-${key}`, String(value));
    });
  }

  if (theme.spacing) {
    Object.entries(theme.spacing).forEach(([key, value]) => {
      root.style.setProperty(`--spacing-${key}`, String(value));
    });
  }

  if (theme.radius) {
    Object.entries(theme.radius).forEach(([key, value]) => {
      root.style.setProperty(`--radius-${key}`, String(value));
    });
  }

  if (theme.motion) {
    root.style.setProperty(
      '--duration-fast',
      `${theme.motion.duration_fast_ms || 100}ms`
    );
    root.style.setProperty(
      '--duration-standard',
      `${theme.motion.duration_standard_ms || 250}ms`
    );
    root.style.setProperty(
      '--duration-slow',
      `${theme.motion.duration_slow_ms || 400}ms`
    );
    root.style.setProperty(
      '--easing-standard',
      theme.motion.easing_standard || 'cubic-bezier(0.4, 0, 0.2, 1)'
    );
  }
}

export function createThemeStylesheet(theme: Theme): string {
  const colors = theme.colors || {};
  const entries = Object.entries(colors)
    .map(([key, value]) => `--color-${key}: ${value};`)
    .join('\n  ');

  return `
:root {
  ${entries}
}
  `.trim();
}

// ─────────────────────────────────────────────────────────────────────────────
// BREAKPOINT UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

export function getCurrentBreakpoint(
  breakpoints: Record<string, Breakpoint>,
  width: number = window.innerWidth
): string {
  const sorted = Object.entries(breakpoints)
    .sort(([, a], [, b]) => b.min_width_px - a.min_width_px);

  for (const [name, bp] of sorted) {
    const maxWidthCheck = bp.max_width_px === undefined || bp.max_width_px === null || width < bp.max_width_px;
    if (width >= bp.min_width_px && maxWidthCheck) {
      return name;
    }
  }

  return Object.entries(breakpoints)[0]?.[0] || 'default';
}

export function getBreakpointMediaQuery(breakpoint: Breakpoint): string {
  let query = `(min-width: ${breakpoint.min_width_px}px)`;
  if (breakpoint.max_width_px !== undefined && breakpoint.max_width_px !== null) {
    query += ` and (max-width: ${breakpoint.max_width_px - 1}px)`;
  }
  return query;
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPONENT UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

export function isComponentVisible(
  component: Component,
  enabledFeatures: string[],
  isDarkMode: boolean,
  userRoles: string[]
): boolean {
  // Check feature gate
  if (component.feature_ref && !enabledFeatures.includes(component.feature_ref)) {
    return false;
  }

  // Check access levels
  if (
    component.visible_access_levels &&
    component.visible_access_levels.length > 0 &&
    !component.visible_access_levels.some(level => userRoles.includes(level))
  ) {
    return false;
  }

  return true;
}

export function getComponentDimensionByBreakpoint(
  component: Component,
  breakpointName: string
): Partial<Component> {
  const overrides = component.breakpoint_overrides?.[breakpointName];
  return overrides ? { ...component, ...overrides } : component;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONDITION EVALUATION
// ─────────────────────────────────────────────────────────────────────────────

export function evaluateSimpleCondition(
  condition: string | undefined,
  context: Record<string, any>
): boolean {
  if (!condition) return true;

  try {
    // SAST-safe: no eval / no new Function. The interpreter resolves
    // `context.*` and `fields.*` references; bare identifiers used in a
    // condition map onto the supplied context object.
    return Boolean(evaluateComputed(condition, context, context));
  } catch (e) {
    console.warn('Failed to evaluate condition:', condition, e);
    return true;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MANIFEST LOADING
// ─────────────────────────────────────────────────────────────────────────────

export async function loadManifestFromJSON(
  json: string | object
): Promise<UIDesignManifest> {
  try {
    const manifest =
      typeof json === 'string' ? JSON.parse(json) : json;
    const errors = validateManifest(manifest);

    if (errors.some(e => e.severity === 'error')) {
      throw new Error(
        `Invalid manifest:\n${errors.map(e => `  ${e.path}: ${e.message}`).join('\n')}`
      );
    }

    return manifest as UIDesignManifest;
  } catch (e) {
    throw new Error(`Failed to load manifest: ${e instanceof Error ? e.message : String(e)}`);
  }
}

export async function loadManifestFromYAML(
  yamlString: string
): Promise<UIDesignManifest> {
  // This requires yaml library - you'll need to install it
  // import YAML from 'yaml';
  // const json = YAML.parse(yamlString);
  // return loadManifestFromJSON(json);

  throw new Error('YAML loading requires external library. Use loadManifestFromJSON instead.');
}

// ─────────────────────────────────────────────────────────────────────────────
// NAVIGATION UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

export function getHomeScreens(manifest: UIDesignManifest) {
  return Object.entries(manifest.screens || {})
    .filter(([, screen]) => screen.is_home)
    .sort((a, b) => (a[1].nav_order || 0) - (b[1].nav_order || 0))
    .map(([key]) => key);
}

export function resolveRoute(manifest: UIDesignManifest, path: string) {
  const routes = manifest.navigation?.routes || {};

  for (const [routeName, route] of Object.entries(routes)) {
    if (route.path === path) {
      return route;
    }
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// ANIMATION UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

export function getTransitionStyles(transitionType: string, duration: number = 250) {
  switch (transitionType) {
    case 'fade':
      return {
        initial: { opacity: 0 },
        animate: { opacity: 1 },
        exit: { opacity: 0 },
        transition: { duration: duration / 1000 },
      };

    case 'slide_left':
      return {
        initial: { x: '100%', opacity: 0 },
        animate: { x: 0, opacity: 1 },
        exit: { x: '-100%', opacity: 0 },
        transition: { duration: duration / 1000 },
      };

    case 'slide_right':
      return {
        initial: { x: '-100%', opacity: 0 },
        animate: { x: 0, opacity: 1 },
        exit: { x: '100%', opacity: 0 },
        transition: { duration: duration / 1000 },
      };

    case 'scale':
      return {
        initial: { scale: 0.95, opacity: 0 },
        animate: { scale: 1, opacity: 1 },
        exit: { scale: 0.95, opacity: 0 },
        transition: { duration: duration / 1000 },
      };

    default:
      return {
        initial: {},
        animate: {},
        exit: {},
        transition: {},
      };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// ACCESSIBILITY UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

export function getAccessibilityProps(ariaLabel?: string, role?: string, hint?: string) {
  return {
    'aria-label': ariaLabel,
    role,
    'aria-description': hint,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORT ALL UTILITIES
// ─────────────────────────────────────────────────────────────────────────────

export const UIBuildingUtils = {
  validateManifest,
  getThemeVariable,
  applyThemeToDOM,
  createThemeStylesheet,
  getCurrentBreakpoint,
  getBreakpointMediaQuery,
  isComponentVisible,
  getComponentDimensionByBreakpoint,
  evaluateSimpleCondition,
  loadManifestFromJSON,
  loadManifestFromYAML,
  getHomeScreens,
  resolveRoute,
  getTransitionStyles,
  getAccessibilityProps,
};
