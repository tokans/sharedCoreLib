/**
 * @form-engine/react — library entry point
 *
 * This library renders forms and UI defined as YAML manifests.
 * It has zero backend dependencies — all network I/O is the consuming
 * application's responsibility, wired in via `onSubmit` / `onDraftSave`.
 *
 * Quick start:
 *   npm install @form-engine/react
 *
 *   import { FormEngine, FormEngineProvider } from "@form-engine/react";
 *
 *   <FormEngineProvider config={{ localManifests: { onboarding: manifest } }}>
 *     <FormEngine
 *       manifest={manifest}
 *       formId="onboarding"
 *       onSubmit={async (payload) => {
 *         await myApi.post("/submissions", payload);
 *       }}
 *     />
 *   </FormEngineProvider>
 *
 * ─── Backend connectivity ──────────────────────────────────────────────────────
 * The library does NOT export an API client. Build your own in the app:
 *
 *   // app/libs/api.ts  (lives outside this library)
 *   export async function submitForm(manifestId, formId, answers) {
 *     return fetch("/api/submissions", { method: "POST", body: JSON.stringify(...) });
 *   }
 *
 * Then wire it in via FormEngineProvider:
 *   <FormEngineProvider config={{ onSubmit: submitForm }}>
 *     ...
 *   </FormEngineProvider>
 */

// ─── Core components ───────────────────────────────────────────────────────────
export { FormEngine, FieldRouter }         from "./components/FormEngine";
export { SafeFormEngine }                  from "./components/FormEngine/safe";
export { FormErrorBoundary }               from "./components/FormEngine/FormErrorBoundary";
export { FormEngineProvider }              from "./components/FormEngineProvider";

// ─── UIEngine (YAML-driven layout renderer) ───────────────────────────────────
export {
  UIEngineProvider, UIEngineContext,
  ComponentRenderer, LayoutContainer, ScreenLayout, ResponsiveLayout,
  // Core hooks
  useUIEngine, useCurrentScreen, useNavigation, useTheme,
  useComponentState, useFeatureGate, useAccessControl,
  // New hooks (ui_system_schema v1.0.0)
  useResolvedAuth, useAuthFieldFilter,
  useThemeRegistry, useThemeSwitcher,
  useToast, useDialog, useTransition,
  useBreakpoint, useButton, useComponent, useIcon,
  useConditionEvaluator, useResponsiveValue,
}                                          from "./components/UIEngine";

// UIEngine Types (ui_system_schema v1.0.0)
export type {
  UISystemManifest,
  UIDesignManifest,
  ThemeDefinition,
  Theme,
  ResolvedAuth,
  ScreenAuthRules,
  RolePreferenceOverride,
  WidgetMap,
  FormEmbedConfig,
  FileComponentConfig,
  FilterBuilderConfig,
  AvatarConfig,
  TemplateRegistry,
  ScreenTemplate,
  ComponentTemplate,
  FormTemplate,
  TemplateVariable,
  Feature,
  Screen,
  Component,
  Button,
  NavigationConfig,
  Route,
}                                          from "./components/UIEngine";

// ─── Configuration ─────────────────────────────────────────────────────────────
export {
  configureFormEngine,
  getConfig,
  useFormEngineConfig,
  FormEngineContext,
}                                          from "./libs/config";

// ─── Hooks ─────────────────────────────────────────────────────────────────────
export { useFormEngine, useFormEngineInit } from "./hooks/useFormEngine";
export { useFormEngineStore }              from "./store/form-engine-store";

// ─── Manifest loading ──────────────────────────────────────────────────────────
export { loadManifest }                    from "./libs/manifest-loader";

// ─── Pure utilities (no network) ──────────────────────────────────────────────
export { evaluateCondition, evaluateComputed, validateField } from "./libs/condition-evaluator";
export { cn, formatDate, debounce }        from "./libs/utils";

// ─── Types ─────────────────────────────────────────────────────────────────────
export type {
  // Manifest & form structure
  FormManifest, FormDef, FormLayout,
  Page, Section, Collection, SubmitAction, SubmitButtonConfig,

  // Fields
  FormField, FieldBase,
  TextField, MultilineField, RichTextField, BooleanField, NumberField,
  SelectField, MultiselectField, DateField, TimeField, DateTimeField,
  DateRangeField, FileField, RatingField, ColorField, JsonField,
  SignatureField, LocationField, HiddenField, BoundField,

  // Conditions
  ConditionOrRef, SimpleCondition, CompositeCondition, ExpressionCondition,
  ConditionRef, NamedCondition,

  // Choices
  StaticChoice, DynamicChoicesConfig,
  DynamicChoicesWrapper, StaticChoicesWrapper, SourceRefConfig, ChoiceSource,

  // Runtime state
  FieldAnswers, FormErrors, FormContext,

  // Enums
  FormState, ConfidentialityType, NumberType,
  AccessLevel, RoleCategory, LayoutType,
} from "./libs/types";

export type { FormEngineConfig } from "./libs/config";
export type { SubmitResult }     from "./hooks/useFormEngine";
