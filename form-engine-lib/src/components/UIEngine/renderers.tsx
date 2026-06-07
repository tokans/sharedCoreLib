"use client";

/**
 * UIEngine Component Renderers
 *
 * PATCHED — additions over the original:
 *
 *  CustomRenderer
 *    Previously a dashed placeholder. Now:
 *    1. Looks up `customComponents[component.name]` from the extended engine context.
 *    2. Walks `component.sub_components` (filtered by hidden_condition), resolves each
 *       child from `manifest.components`, and renders them recursively via
 *       ComponentRenderer — no import from layout.tsx needed (avoids circular dep).
 *    3. Passes `{ context, handlers, children }` to the registered React implementation.
 *    4. Falls back to the original dashed placeholder when no implementation is registered.
 *
 *  All other renderers and ComponentRenderer are unchanged.
 */

import React, { useMemo, useCallback } from "react";
import { Component, ComponentType, LoadingState, StateConfig } from "./types";
import {
  useUIEngine,
  useComponentState,
  useFeatureGate,
  useConditionEvaluator,
  useAccessControl,
  useTheme,
} from "./context";

// ─────────────────────────────────────────────────────────────────────────────
// COLOR RESOLVER
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Converts a manifest color value to a valid CSS color string.
 *
 * Manifest authors may write colors in several ways:
 *   "ffffff"    → "#ffffff"   bare hex (legacy / shorthand) — prefix added
 *   "#6366f1"   → "#6366f1"  already has #                 — passed through
 *   "white"     → "white"    CSS named color               — passed through
 *   "rgb(…)"    → "rgb(…)"   function notation             — passed through
 *   "hsl(…)"    → "hsl(…)"   function notation             — passed through
 *
 * The previous code did `#${value}` unconditionally, turning "white" into
 * "#white" (invalid) and "#aabbcc" into "##aabbcc" (also invalid).
 */
function resolveColor(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  // Named color (starts with a letter), already-prefixed hex, or function notation
  if (/^[a-zA-Z]/.test(raw) || raw.startsWith("#") || raw.startsWith("rgb") || raw.startsWith("hsl")) {
    return raw;
  }
  // Bare hex digits — add the missing #
  return `#${raw}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPONENT COLOR OVERRIDES
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolved color set for a component.
 *
 * Every property is a valid CSS color string (or undefined when not set in
 * either the component override or the active theme).
 *
 * Precedence (highest → lowest):
 *   1. Component-level override   (e.g. component.background_color)
 *   2. Active theme token         (e.g. theme.colors.surface)
 *   3. Hard-coded safe default
 */
export interface ComponentColors {
  /** Container background */
  background:      string;
  /** Container text / icon colour */
  foreground:      string;
  /** Container border (undefined = no border) */
  border:          string | undefined;
  /** Background of every input/select/textarea inside this component */
  inputBackground: string;
  /** Text colour of every input/select/textarea inside this component */
  inputText:       string;
  /** Border colour of every input/select/textarea inside this component */
  inputBorder:     string;
  /** Label text colour for form fields inside this component */
  label:           string;
  /** Primary / accent colour (buttons, focus rings) — theme-only, no per-component override */
  primary:         string;
  /** Error colour */
  error:           string;
}

/**
 * Merges per-component color overrides onto the active theme tokens,
 * returning a stable `ComponentColors` object.
 *
 * Usage:
 *   const colors = useComponentColors(component);
 *   <div style={{ backgroundColor: colors.background, color: colors.foreground }}>
 */
export function useComponentColors(component: Component): ComponentColors {
  const theme = useTheme();
  const tc = theme.colors ?? {};

  return useMemo<ComponentColors>(() => ({
    background:      resolveColor(component.background_color)      ?? tc.surface        ?? "#FFFFFF",
    foreground:      resolveColor(component.foreground_color)      ?? tc.on_surface     ?? "#111827",
    border:          resolveColor(component.border_color),
    inputBackground: resolveColor(component.input_background_color) ?? tc.surface_variant ?? tc.surface ?? "#F9FAFB",
    inputText:       resolveColor(component.input_text_color)       ?? tc.on_surface     ?? "#111827",
    inputBorder:     resolveColor(component.input_border_color)     ?? tc.outline        ?? "#D1D5DB",
    label:           resolveColor(component.label_color)            ?? resolveColor(component.foreground_color) ?? tc.on_surface ?? "#374151",
    primary:         tc.primary  ?? "#6366F1",
    error:           tc.error    ?? "#BA1A1A",
  }), [
    component.background_color, component.foreground_color, component.border_color,
    component.input_background_color, component.input_text_color, component.input_border_color,
    component.label_color, tc,
  ]);
}

// ─────────────────────────────────────────────────────────────────────────────
// LOADING STATE RENDERER  (unchanged)
// ─────────────────────────────────────────────────────────────────────────────

export function LoadingIndicator({ loadingState }: { loadingState?: LoadingState }) {
  const style = loadingState?.style ?? "skeleton";
  const theme = useTheme();

  if (style === "none") return null;

  const commonStyle: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    minHeight: "100px",
    color: theme.colors?.on_surface || "#666",
  };

  if (style === "spinner") {
    return (
      <div style={commonStyle}>
        <div
          style={{
            width: "40px",
            height: "40px",
            border: `4px solid ${theme.colors?.surface || "#eee"}`,
            borderTop: `4px solid ${theme.colors?.primary || "#007AFF"}`,
            borderRadius: "50%",
            animation: "spin 1s linear infinite",
          }}
        />
      </div>
    );
  }

  if (style === "skeleton" || style === "shimmer") {
    const rows = loadingState?.skeleton_rows ?? 3;
    return (
      <div style={commonStyle}>
        <div style={{ width: "100%" }}>
          {Array.from({ length: rows }).map((_, i) => (
            <div
              key={i}
              style={{
                height: "20px",
                backgroundColor: theme.colors?.surface || "#eee",
                marginBottom: "12px",
                borderRadius: theme.radius?.default || "4px",
                animation: style === "shimmer" ? "shimmer 2s infinite" : "none",
              }}
            />
          ))}
        </div>
      </div>
    );
  }

  if (style === "progress_bar") {
    return (
      <div style={{ width: "100%", height: "4px", backgroundColor: theme.colors?.surface || "#eee", borderRadius: "2px", overflow: "hidden" }}>
        <div style={{ height: "100%", backgroundColor: theme.colors?.primary || "#007AFF", animation: "progress 2s ease-in-out infinite" }} />
      </div>
    );
  }

  if (style === "overlay") {
    const opacity = loadingState?.overlay_opacity ?? 0.6;
    return (
      <div style={{ position: "fixed", inset: 0, backgroundColor: `rgba(0,0,0,${opacity})`, display: "flex", alignItems: "center", justifyContent: "center" }}>
        <div style={commonStyle}>
          <div style={{ width: "40px", height: "40px", border: "4px solid rgba(255,255,255,0.3)", borderTop: "4px solid white", borderRadius: "50%", animation: "spin 1s linear infinite" }} />
        </div>
      </div>
    );
  }

  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// EMPTY / ERROR STATE RENDERERS  (unchanged)
// ─────────────────────────────────────────────────────────────────────────────

export function EmptyStateRenderer({ component }: { component: Component }) {
  const { manifest } = useUIEngine();
  const theme = useTheme();
  const empty = component.empty_state;
  if (!empty) return null;
  const actionButton = empty.action_ref ? manifest.buttons?.[empty.action_ref] : null;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "200px", padding: "24px", textAlign: "center", color: theme.colors?.on_surface || "#666" }}>
      {empty.text && <p style={{ fontSize: theme.typography?.scale.body_md || "14px", marginBottom: actionButton ? "16px" : "0" }}>{empty.text}</p>}
      {actionButton && (
        <button style={{ padding: "8px 16px", backgroundColor: theme.colors?.primary || "#007AFF", color: "white", border: "none", borderRadius: theme.radius?.default || "4px", cursor: "pointer" }}>
          {actionButton.label || "Action"}
        </button>
      )}
    </div>
  );
}

export function ErrorStateRenderer({ component }: { component: Component }) {
  const { manifest } = useUIEngine();
  const theme = useTheme();
  const error = component.error_state;
  if (!error) return null;
  const retryButton = error.retry_action_ref ? manifest.buttons?.[error.retry_action_ref] : null;
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", minHeight: "200px", padding: "24px", textAlign: "center", color: theme.colors?.error || "#BA1A1A" }}>
      {error.text && <p style={{ fontSize: theme.typography?.scale.body_md || "14px", marginBottom: retryButton ? "16px" : "0" }}>{error.text}</p>}
      {retryButton && (
        <button style={{ padding: "8px 16px", backgroundColor: theme.colors?.error || "#BA1A1A", color: "white", border: "none", borderRadius: theme.radius?.default || "4px", cursor: "pointer" }}>
          {retryButton.label || "Retry"}
        </button>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TYPE-SPECIFIC RENDERERS  (unchanged from original)
// ─────────────────────────────────────────────────────────────────────────────

function TreeRenderer({ component }: { component: Component }) {
  const theme = useTheme();
  return (
    <div style={{ padding: "12px", backgroundColor: theme.colors?.surface || "#FFF", borderRadius: theme.radius?.default || "4px" }}>
      <p style={{ fontSize: theme.typography?.scale.body_sm || "12px" }}>Tree: {component.label || component.name}</p>
    </div>
  );
}

function TableRenderer({ component }: { component: Component }) {
  const theme = useTheme();
  return (
    <div style={{ padding: "12px", backgroundColor: theme.colors?.surface || "#FFF", borderRadius: theme.radius?.default || "4px", overflowX: "auto" }}>
      <p style={{ fontSize: theme.typography?.scale.body_sm || "12px" }}>Table: {component.label || component.name}</p>
    </div>
  );
}

function FormRenderer({ component }: { component: Component }) {
  const { manifest } = useUIEngine();
  if (component.form_ref) return <FormEngineWrapper component={component} manifest={manifest} />;
  if (component.schema_ref) return <SchemaBasedFormRenderer component={component} manifest={manifest} />;
  const theme = useTheme();
  return (
    <div style={{ padding: "16px", backgroundColor: theme.colors?.surface || "#FFF", borderRadius: theme.radius?.default || "4px", border: `2px dashed ${theme.colors?.outline || "#E0E0E0"}` }}>
      <p style={{ fontSize: theme.typography?.scale.body_md || "14px", margin: 0 }}>{component.label || "Form"}</p>
      <p style={{ fontSize: theme.typography?.scale.body_sm || "12px", margin: "8px 0 0 0", color: theme.colors?.on_surface || "#666" }}>No form_ref or schema_ref specified</p>
    </div>
  );
}

interface FormEngineWrapperProps { component: Component; manifest: any; }

function FormEngineWrapper({ component, manifest }: FormEngineWrapperProps) {
  const theme = useTheme();
  const colors = useComponentColors(component);
  const { handlers } = useUIEngine();
  const { state: compState, updateState } = useComponentState(component.name);
  const [isSubmitting, setIsSubmitting] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const formManifest = useMemo(
    () => ({ manifest_id: manifest.manifest_id as string, forms: (manifest.forms ?? {}) as Record<string, any> }),
    [manifest.manifest_id, manifest.forms]
  );

  const FormEngineComponent = React.lazy(() =>
    import("../FormEngine/index").then((m) => ({ default: m.FormEngine }))
  );

  const handleFormSubmit = useCallback(
    async (formData: Record<string, any>) => {
      try {
        setIsSubmitting(true);
        setError(null);
        if (component.data_binding?.write_action_ref) {
          const handler = handlers[component.data_binding.write_action_ref];
          if (handler) await handler({ formData, componentId: component.name, componentState: compState });
        }
        updateState({ lastSubmitted: new Date().toISOString(), data: formData });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Form submission failed");
        if (component.lifecycle?.on_data_error) {
          const handler = handlers[component.lifecycle.on_data_error];
          if (handler) await handler({ error: err, componentId: component.name });
        }
      } finally {
        setIsSubmitting(false);
      }
    },
    [component, handlers, compState, updateState]
  );

  // Resolve on_submit handler from the form definition itself
  const resolvedSubmitHandler = useMemo(() => {
    const form = manifest.forms?.[component.form_ref ?? ""];
    const handlerName = form?.on_submit?.handler_name;
    if (handlerName && handlers[handlerName]) {
      return async (data: Record<string, any>) => {
        try {
          setIsSubmitting(true);
          setError(null);
          await handlers[handlerName](data);
        } catch (err) {
          setError(err instanceof Error ? err.message : "Submission failed");
        } finally {
          setIsSubmitting(false);
        }
      };
    }
    return handleFormSubmit;
  }, [manifest, component.form_ref, handlers, handleFormSubmit]);

  return (
    <div style={{
      padding: theme.spacing?.md || "16px",
      backgroundColor: colors.background,
      color: colors.foreground,
      borderRadius: theme.radius?.default || "4px",
      ...(colors.border ? { border: `1px solid ${colors.border}` } : {}),
    }}>
      {component.label && (
        <h3 style={{ margin: "0 0 16px 0", fontSize: theme.typography?.scale.headline_md || "18px", color: colors.foreground }}>
          {component.label}
        </h3>
      )}
      {error && (
        <div style={{ padding: "12px", marginBottom: "16px", backgroundColor: colors.error + "20", border: `1px solid ${colors.error}`, borderRadius: theme.radius?.default || "4px", color: colors.error, fontSize: theme.typography?.scale.body_sm || "12px" }}>
          {error}
        </div>
      )}
      <React.Suspense fallback={<LoadingIndicator loadingState={component.loading_state || { style: "skeleton", skeleton_rows: 5 }} />}>
        {component.form_ref != null && (
          <FormEngineComponent
            formId={component.form_ref}
            onSubmit={resolvedSubmitHandler}
            readOnly={isSubmitting}
            context={compState}
            manifest={formManifest}
          />
        )}
      </React.Suspense>
      {isSubmitting && <div style={{ marginTop: "16px" }}><LoadingIndicator loadingState={component.loading_state} /></div>}
    </div>
  );
}

interface SchemaBasedFormRendererProps { component: Component; manifest: any; }

function SchemaBasedFormRenderer({ component, manifest }: SchemaBasedFormRendererProps) {
  const theme = useTheme();
  const colors = useComponentColors(component);
  const { handlers } = useUIEngine();
  const [isSubmitting, setIsSubmitting] = React.useState(false);

  const handleSubmit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    try {
      if (component.data_binding?.write_action_ref) {
        const handler = handlers[component.data_binding.write_action_ref];
        if (handler) await handler({ componentId: component.name });
      }
    } finally {
      setIsSubmitting(false);
    }
  }, [component, handlers]);

  return (
    <form onSubmit={handleSubmit} style={{
      padding: theme.spacing?.md || "16px",
      backgroundColor: colors.background,
      color: colors.foreground,
      borderRadius: theme.radius?.default || "4px",
      ...(colors.border ? { border: `1px solid ${colors.border}` } : {}),
    }}>
      {component.label && <h3 style={{ margin: "0 0 16px 0", fontSize: theme.typography?.scale.headline_md || "18px", color: colors.foreground }}>{component.label}</h3>}
      {component.text  && <p  style={{ margin: "0 0 16px 0", fontSize: theme.typography?.scale.body_md  || "14px", color: colors.foreground }}>{component.text}</p>}
      <div style={{ marginBottom: "16px", minHeight: "100px" }}>
        {component.fields?.map(fieldName => (
          <div key={fieldName} style={{ marginBottom: "12px" }}>
            <label style={{ display: "block", fontSize: theme.typography?.scale.body_sm || "12px", fontWeight: "bold", marginBottom: "4px", color: colors.label }}>
              {fieldName}
            </label>
            <input
              type="text"
              placeholder={`Enter ${fieldName}`}
              style={{
                width: "100%",
                padding: "8px",
                border: `1px solid ${colors.inputBorder}`,
                borderRadius: theme.radius?.default || "4px",
                fontSize: theme.typography?.scale.body_sm || "12px",
                backgroundColor: colors.inputBackground,
                color: colors.inputText,
              }}
            />
          </div>
        ))}
      </div>
      <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
        {component.actions?.map((action, idx) => {
          const button = "button_ref" in action ? manifest.buttons?.[action.button_ref] : action;
          const btnBg  = resolveColor(button?.background_color) ?? colors.primary;
          const btnFg  = resolveColor(button?.foreground_color) ?? "white";
          const btnBorder = resolveColor(button?.border_color);
          return (
            <button key={idx} type={button?.on_press === "Submit" ? "submit" : "button"} disabled={isSubmitting}
              style={{
                padding: "8px 16px",
                backgroundColor: btnBg,
                color: btnFg,
                border: btnBorder ? `1px solid ${btnBorder}` : "none",
                borderRadius: theme.radius?.default || "4px",
                cursor: isSubmitting ? "not-allowed" : "pointer",
                opacity: isSubmitting ? 0.6 : 1,
              }}>
              {button?.label || "Submit"}
            </button>
          );
        })}
      </div>
    </form>
  );
}

function VerticalListRenderer({ component }: { component: Component }) {
  const theme = useTheme();
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "8px", padding: "12px", backgroundColor: theme.colors?.surface || "#FFF", borderRadius: theme.radius?.default || "4px" }}>
      <p style={{ fontSize: theme.typography?.scale.body_sm || "12px" }}>List (Vertical): {component.label || component.name}</p>
    </div>
  );
}

function HorizontalListRenderer({ component }: { component: Component }) {
  const theme = useTheme();
  return (
    <div style={{ display: "flex", flexDirection: "row", gap: "12px", padding: "12px", overflowX: "auto", backgroundColor: theme.colors?.surface || "#FFF", borderRadius: theme.radius?.default || "4px" }}>
      <p style={{ fontSize: theme.typography?.scale.body_sm || "12px" }}>List (Horizontal): {component.label || component.name}</p>
    </div>
  );
}

function SearchRenderer({ component }: { component: Component }) {
  const theme = useTheme();
  return (
    <div style={{ padding: "12px" }}>
      <input type="text" placeholder={component.label || "Search..."} style={{ width: "100%", padding: "8px 12px", border: `1px solid ${theme.colors?.primary || "#007AFF"}`, borderRadius: theme.radius?.default || "4px", fontSize: theme.typography?.scale.body_md || "14px" }} />
    </div>
  );
}

function CardRenderer({ component }: { component: Component }) {
  const theme = useTheme();
  return (
    <div style={{ padding: "16px", backgroundColor: theme.colors?.surface || "#FFF", borderRadius: theme.radius?.default || "4px", boxShadow: theme.elevation?.default || "0 2px 4px rgba(0,0,0,0.1)" }}>
      {component.label && <h3 style={{ margin: "0 0 8px 0", fontSize: theme.typography?.scale.headline_md || "16px" }}>{component.label}</h3>}
      {component.text && <p style={{ margin: 0, fontSize: theme.typography?.scale.body_md || "14px", color: theme.colors?.on_surface || "#666" }}>{component.text}</p>}
    </div>
  );
}

function TileRenderer({ component }: { component: Component }) {
  const theme = useTheme();
  return (
    <div style={{ padding: "16px", backgroundColor: theme.colors?.surface || "#FFF", borderRadius: theme.radius?.default || "4px", textAlign: "center", cursor: "pointer" }}>
      {component.label && <h4 style={{ margin: "0 0 8px 0", fontSize: theme.typography?.scale.body_md || "14px" }}>{component.label}</h4>}
      {component.text && <p style={{ margin: 0, fontSize: theme.typography?.scale.body_sm || "12px", color: theme.colors?.on_surface || "#666" }}>{component.text}</p>}
    </div>
  );
}

function FileGalleryRenderer({ component }: { component: Component }) {
  const theme = useTheme();
  const cfg = component.file_config;
  const layout = cfg?.layout ?? "grid";
  const containerStyle: React.CSSProperties =
    layout === "grid"
      ? { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(120px, 1fr))", gap: theme.spacing?.sm || "8px", padding: theme.spacing?.md || "16px", backgroundColor: theme.colors?.surface || "#FFF", borderRadius: theme.radius?.default || "4px" }
      : { display: "flex", flexDirection: "column", gap: theme.spacing?.sm || "8px", padding: theme.spacing?.md || "16px", backgroundColor: theme.colors?.surface || "#FFF", borderRadius: theme.radius?.default || "4px" };
  return (
    <div>
      {component.label && <p style={{ margin: `0 0 ${theme.spacing?.sm || "8px"} 0`, fontWeight: "bold", fontSize: theme.typography?.scale.body_md || "14px" }}>{component.label}</p>}
      <div style={containerStyle}>
        {[1, 2, 3].map((i) => (
          <div key={i} style={{ height: "90px", backgroundColor: theme.colors?.surface_variant || "#F5F5F5", borderRadius: theme.radius?.default || "4px", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "24px" }}>📎</div>
        ))}
      </div>
      {cfg?.upload_enabled && (
        <button style={{ marginTop: theme.spacing?.sm || "8px", padding: "6px 14px", backgroundColor: theme.colors?.primary || "#007AFF", color: "white", border: "none", borderRadius: theme.radius?.default || "4px", cursor: "pointer", fontSize: theme.typography?.scale.body_sm || "12px" }}>Upload</button>
      )}
    </div>
  );
}

function FilterBuilderRenderer({ component }: { component: Component }) {
  const theme = useTheme();
  const cfg = component.filter_config;
  const [conditions, setConditions] = React.useState<Array<{ field: string; op: string; value: string }>>([]);

  const addCondition = () => {
    const firstField = cfg?.filterable_fields?.[0] ?? "";
    setConditions((prev) => [...prev, { field: firstField, op: "equals", value: "" }]);
  };
  const removeCondition = (idx: number) => setConditions((prev) => prev.filter((_, i) => i !== idx));
  const updateCondition = (idx: number, key: "field" | "op" | "value", val: string) =>
    setConditions((prev) => prev.map((c, i) => (i === idx ? { ...c, [key]: val } : c)));
  const maxReached = cfg?.max_conditions != null && conditions.length >= cfg.max_conditions;

  return (
    <div style={{ padding: theme.spacing?.md || "16px", backgroundColor: theme.colors?.surface || "#FFF", borderRadius: theme.radius?.default || "4px", border: `1px solid ${theme.colors?.outline || "#E0E0E0"}` }}>
      {component.label && <p style={{ margin: `0 0 ${theme.spacing?.sm || "8px"} 0`, fontWeight: "bold" }}>{component.label}</p>}
      {conditions.map((cond, idx) => (
        <div key={idx} style={{ display: "flex", gap: "8px", marginBottom: "8px", alignItems: "center" }}>
          <select value={cond.field} onChange={(e) => updateCondition(idx, "field", e.target.value)} style={{ padding: "4px 8px", border: `1px solid ${theme.colors?.outline || "#E0E0E0"}`, borderRadius: theme.radius?.default || "4px" }}>
            {(cfg?.filterable_fields ?? []).map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
          <select value={cond.op} onChange={(e) => updateCondition(idx, "op", e.target.value)} style={{ padding: "4px 8px", border: `1px solid ${theme.colors?.outline || "#E0E0E0"}`, borderRadius: theme.radius?.default || "4px" }}>
            {(cfg?.allowed_operators ?? ["equals", "unequals"]).map((op) => <option key={op} value={op}>{op}</option>)}
          </select>
          <input value={cond.value} onChange={(e) => updateCondition(idx, "value", e.target.value)} placeholder="value" style={{ flex: 1, padding: "4px 8px", border: `1px solid ${theme.colors?.outline || "#E0E0E0"}`, borderRadius: theme.radius?.default || "4px" }} />
          <button onClick={() => removeCondition(idx)} style={{ padding: "4px 8px", backgroundColor: theme.colors?.error || "#BA1A1A", color: "white", border: "none", borderRadius: theme.radius?.default || "4px", cursor: "pointer" }}>✕</button>
        </div>
      ))}
      <button onClick={addCondition} disabled={maxReached} style={{ padding: "6px 14px", backgroundColor: maxReached ? (theme.colors?.outline || "#E0E0E0") : (theme.colors?.primary || "#007AFF"), color: maxReached ? (theme.colors?.on_surface || "#666") : "white", border: "none", borderRadius: theme.radius?.default || "4px", cursor: maxReached ? "default" : "pointer" }}>
        + Add Filter
      </button>
    </div>
  );
}

function AvatarRenderer({ component }: { component: Component }) {
  const theme = useTheme();
  const cfg = component.avatar_config;
  const size = cfg?.size ?? "md";
  const shape = cfg?.shape ?? "circle";
  const sizePx: Record<string, number> = { xs: 24, sm: 32, md: 40, lg: 56, xl: 72 };
  const px = sizePx[size] ?? 40;
  const borderRadius = shape === "circle" ? "50%" : shape === "rounded" ? `${px * 0.2}px` : "0";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
      <div style={{ position: "relative", display: "inline-block" }}>
        <div style={{ width: px, height: px, borderRadius, backgroundColor: theme.colors?.primary || "#007AFF", display: "flex", alignItems: "center", justifyContent: "center", color: "white", fontWeight: "bold", fontSize: px * 0.4, overflow: "hidden", flexShrink: 0 }}>
          {cfg?.fallback_style === "icon" ? "👤" : component.label?.[0]?.toUpperCase() ?? "?"}
        </div>
        {cfg?.show_online_indicator && (
          <span style={{ position: "absolute", bottom: 0, right: 0, width: px * 0.28, height: px * 0.28, borderRadius: "50%", backgroundColor: theme.colors?.success || "#1B8A5A", border: `2px solid ${theme.colors?.surface || "#FFF"}` }} />
        )}
      </div>
      {cfg?.show_nick_name && component.label && (
        <span style={{ fontSize: theme.typography?.scale.body_md || "14px", color: theme.colors?.on_surface || "#000" }}>{component.label}</span>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// CUSTOM RENDERER  (PATCHED)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Renders a `type: Custom` component.
 *
 * Resolution order:
 *  1. Look up `component.name` in the `customComponents` registry from UIEngineContext.
 *  2. If found, walk `component.sub_components` — resolve each child from
 *     `manifest.components`, filter by `hidden_condition`, and render recursively
 *     via `ComponentRenderer`. Pass the resulting React nodes as `children` to the
 *     registered implementation together with `engineContext` and `handlers`.
 *  3. If NOT found in the registry, render the original dashed placeholder so
 *     unregistered custom components are visually flagged in development.
 *
 * Why recursive ComponentRenderer instead of SubComponentPlacementRenderer from layout.tsx?
 *   `layout.tsx` imports `ComponentRenderer` from this file, so importing layout here
 *   would create a circular dependency. Calling ComponentRenderer directly is safe and
 *   keeps direction-based layout as a screen-level concern; the custom component impl
 *   is responsible for its own internal layout.
 */
function CustomRenderer({ component }: { component: Component }) {
  const theme = useTheme();
  const { manifest, handlers, customComponents, engineContext } = useUIEngine();
  const evaluateCondition = useConditionEvaluator();

  // Walk sub_components — filter by hidden_condition, resolve from manifest
  const resolvedChildren: React.ReactNode = useMemo(() => {
    const placements = component.sub_components;
    if (!placements || placements.length === 0) return undefined;

    const nodes = placements
      .filter((p) => {
        if (!p.hidden_condition) return true;
        // hidden_condition = true means hide; we keep the placement when condition is FALSE
        return !evaluateCondition(p.hidden_condition);
      })
      .map((p, idx) => {
        const child = manifest.components?.[p.component_ref];
        if (!child) {
          console.warn(`[UIEngine] sub_component ref not found: "${p.component_ref}" (parent: "${component.name}")`);
          return null;
        }
        return (
          <ComponentRenderer
            key={`${p.component_ref}-${idx}`}
            component={child}
            componentId={p.component_ref}
          />
        );
      })
      .filter(Boolean);

    return nodes.length > 0 ? <>{nodes}</> : undefined;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [component.sub_components, manifest.components, evaluateCondition]);

  // Look up registered implementation
  const Impl = customComponents?.[component.name];

  if (Impl) {
    return (
      <Impl
        context={engineContext ?? {}}
        handlers={handlers}
      >
        {resolvedChildren}
      </Impl>
    );
  }

  // Fallback placeholder — shown when a Custom component has no registered impl
  return (
    <div
      style={{
        padding: theme.spacing?.md || "16px",
        border: `2px dashed ${theme.colors?.outline || "#E0E0E0"}`,
        borderRadius: theme.radius?.default || "4px",
        textAlign: "center",
        color: theme.colors?.on_surface || "#666",
        fontSize: theme.typography?.scale.body_sm || "12px",
      }}
    >
      Custom: <strong>{component.name}</strong>
      {component.label && <span style={{ marginLeft: "4px" }}>({component.label})</span>}
      {component.sub_components && component.sub_components.length > 0 && (
        <div style={{ marginTop: "8px", opacity: 0.6 }}>
          [{component.sub_components.length} sub-component(s) — register "{component.name}" in customComponents to render]
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN COMPONENT RENDERER  (unchanged except Custom dispatch)
// ─────────────────────────────────────────────────────────────────────────────

export interface ComponentRendererProps {
  component: Component;
  componentId: string;
  isLoading?: boolean;
  isEmpty?: boolean;
  isError?: boolean;
}

export const ComponentRenderer = React.memo(function ComponentRenderer({
  component,
  componentId,
  isLoading = false,
  isEmpty = false,
  isError = false,
}: ComponentRendererProps) {
  const featureEnabled = useFeatureGate(component.feature_ref);
  const evaluateCondition = useConditionEvaluator();
  const hasAccess = useAccessControl(component.visible_access_levels, undefined);

  const isHidden =
    component.hidden_condition &&
    !evaluateCondition(component.hidden_condition);

  if (!featureEnabled || isHidden || !hasAccess) return null;

  // Only apply overrides that were explicitly set — don't paint a white box
  // over every component that has no color override in the manifest.
  const hasColorOverride =
    component.background_color ||
    component.foreground_color ||
    component.border_color;

  const containerStyle: React.CSSProperties = hasColorOverride
    ? {
        backgroundColor: resolveColor(component.background_color),
        color:           resolveColor(component.foreground_color),
        ...(component.border_color ? { border: `1px solid ${resolveColor(component.border_color)}` } : {}),
      }
    : {};

  if (isLoading) return <div style={containerStyle}><LoadingIndicator loadingState={component.loading_state} /></div>;
  if (isEmpty)   return <div style={containerStyle}><EmptyStateRenderer component={component} /></div>;
  if (isError)   return <div style={containerStyle}><ErrorStateRenderer component={component} /></div>;

  let content: React.ReactNode;

  switch (component.type) {
    case ComponentType.Tree:           content = <TreeRenderer           component={component} />; break;
    case ComponentType.Table:          content = <TableRenderer          component={component} />; break;
    case ComponentType.Form:           content = <FormRenderer           component={component} />; break;
    case ComponentType.VerticalList:   content = <VerticalListRenderer   component={component} />; break;
    case ComponentType.HorizontalList: content = <HorizontalListRenderer component={component} />; break;
    case ComponentType.Search:         content = <SearchRenderer         component={component} />; break;
    case ComponentType.Card:           content = <CardRenderer           component={component} />; break;
    case ComponentType.Tile:           content = <TileRenderer           component={component} />; break;
    case ComponentType.FileGallery:    content = <FileGalleryRenderer    component={component} />; break;
    case ComponentType.FilterBuilder:  content = <FilterBuilderRenderer  component={component} />; break;
    case ComponentType.Avatar:         content = <AvatarRenderer         component={component} />; break;
    case ComponentType.Custom:
      // CustomRenderer handles its own sub_components and registry dispatch —
      // no extra container div so the custom impl has full styling control.
      return <CustomRenderer component={component} />;
    default:
      content = <div>Unknown component type: {(component as any).type}</div>;
  }

  return <div style={containerStyle}>{content}</div>;
});

ComponentRenderer.displayName = "ComponentRenderer";