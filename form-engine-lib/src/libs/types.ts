// ─────────────────────────────────────────────────────────────────────────────
// TypeScript types for Form Engine Manifest v4.0.0
// Mirrors form_schema_v5.yaml
// ─────────────────────────────────────────────────────────────────────────────

export type ConfidentialityType = "Public" | "Internal" | "Confidential" | "Restricted" | "Secret";
export type EditabilityType = "Mutable" | "MutableIfNull" | "Immutable" | "Generated";
export type NumberType = "int" | "long" | "float" | "double" | "decimal2" | "decimal4" | "decimal6" | "NPS";
export type FormState = "draft" | "active" | "deprecated" | "archived";
export type GroupType = "OneOf" | "AnyOf" | "AllOf" | "Index";
export type RenderMode = "inline" | "modal" | "panel";
export type AccessLevel = "Self" | "Delegated" | "Team" | "Reportee" | "Category";
export type RoleCategory = "Customer" | "Employee" | "Partner" | "Contractor" | "Automaton";
export type LayoutType = "single-page" | "wizard" | "grid";

// ─── Engine ───────────────────────────────────────────────────────────────────
export interface EngineConfig {
  mode?: "reactive" | "static";
  evaluation_order?: "dependency" | "declaration";
  error_mode?: "fail-fast" | "collect-all";
  debounce_ms?: number;
}

// ─── Conditions ───────────────────────────────────────────────────────────────
export type ConditionOp =
  | "eq" | "neq" | "in" | "not_in" | "gt" | "gte" | "lt" | "lte"
  | "contains" | "starts_with" | "ends_with" | "is_empty" | "is_not_empty"
  | "is_true" | "is_false";

export interface SimpleCondition {
  field: string;
  op: ConditionOp;
  value?: unknown;
}

export interface ExpressionCondition {
  expression: string;
  description?: string;
}

export interface CompositeCondition {
  all?: ConditionOrRef[];
  any?: ConditionOrRef[];
  not?: ConditionOrRef;
}

export interface ConditionRef {
  ref: string;
}

export type ConditionOrRef =
  | SimpleCondition
  | ExpressionCondition
  | CompositeCondition
  | ConditionRef;

export interface NamedCondition {
  description?: string;
  expression?: string;
  condition?: ConditionOrRef;
}

// ─── Choices ──────────────────────────────────────────────────────────────────
export interface StaticChoice {
  value: string | number | boolean;
  label: string;
  group?: string;
  icon?: string;
  disabled?: boolean;
}

export interface DynamicChoicesConfig {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  query_params?: Record<string, string>;
  body_template?: string;
  response_path?: string;
  value_key: string;
  label_key: string;
  group_key?: string;
  search_param?: string;
  depends_on?: string;
  cache_ttl_seconds?: number;
  option_filter?: Record<string, string>;
}

/** Schema-conformant wrapper: choices: { dynamic: { url, value_key, label_key } } */
export interface DynamicChoicesWrapper {
  dynamic: DynamicChoicesConfig;
}

/** Schema-conformant wrapper: choices: { static: [...] } */
export interface StaticChoicesWrapper {
  static: StaticChoice[];
}

/** Named manifest data-source reference: choices: { source_ref: "myDataSource" } */
export interface SourceRefConfig {
  source_ref: string;
}

/**
 * ChoiceSource — all forms accepted by the engine:
 *   { dynamic: {...} }   schema-conformant dynamic source (preferred)
 *   { source_ref: "x" }  reference to a manifest-level data_sources entry
 *   { static: [...] }    explicit static wrapper
 *   StaticChoice[]       bare array (legacy / most common)
 *   DynamicChoicesConfig flat inline dynamic (backward compat)
 *   string               plain alias (rarely used)
 */
export type ChoiceSource =
  | DynamicChoicesWrapper
  | SourceRefConfig
  | StaticChoicesWrapper
  | StaticChoice[]
  | DynamicChoicesConfig
  | string;

// ─── Validation ───────────────────────────────────────────────────────────────
export interface ValidationRule {
  type:
    | "required" | "regex" | "min" | "max" | "min_length" | "max_length"
    | "min_date" | "max_date" | "min_selected" | "max_selected"
    | "expression" | "custom" | "async";
  value?: unknown;
  expression?: string;
  message?: string;
  handler?: string;
  rule_ref?: string;
}

export interface FieldValidation {
  rules?: ValidationRule[];
  rule_ref?: string;
}

// ─── Actions ──────────────────────────────────────────────────────────────────
export interface ActionRef {
  action: string;
  params?: Record<string, unknown>;
}

export interface Branch {
  condition: ConditionOrRef;
  goto: string;
  description?: string;
}

// ─── Computed Field ───────────────────────────────────────────────────────────
export interface ComputedField {
  expression: string;
  type_hint?: "string" | "number" | "boolean" | "date" | "datetime";
}

// ─── Field Base ───────────────────────────────────────────────────────────────
export interface FieldBase {
  id: string;
  label?: string;
  description?: string;
  placeholder?: string;
  hint?: string;
  required?: boolean;
  disabled?: boolean;
  readonly?: boolean;
  default?: unknown;
  computed?: ComputedField;
  bind?: string;
  condition?: ConditionOrRef;
  on_change?: ActionRef;
  branches?: Branch[];
  validation?: FieldValidation;
  validate_on?: "blur" | "change" | "submit";
  width?: "full" | "half" | "third";
  col_span?: number;
  confidentiality?: ConfidentialityType;
  personal_data?: boolean;
  purpose?: string;
  retention_days?: number;
  system_generated?: boolean;
  summary_field?: boolean;
  key_field?: boolean;
  advanced?: boolean;
  ui_only?: boolean;
  one_of_group?: string;
  permission_ref?: string;
  visible_access_levels?: AccessLevel[];
  tags?: Record<string, string>;
  editability?: EditabilityType;
}

// ─── Field Types ──────────────────────────────────────────────────────────────
export interface TextField extends FieldBase {
  type: "text";
  display_as?: "input" | "password" | "email" | "url" | "tel" | "search";
  min_length?: number;
  max_length?: number;
  pattern?: string;
  pattern_message?: string;
  autocomplete?: string;
}

export interface MultilineField extends FieldBase {
  type: "multiline";
  rows?: number;
  max_length?: number;
  resize?: "none" | "vertical" | "both";
}

export interface RichTextField extends FieldBase {
  type: "richtext";
  toolbar?: string[];
  max_length?: number;
}

export interface BooleanField extends FieldBase {
  type: "boolean";
  display_as?: "switch" | "checkbox" | "yes-no-radio";
  true_label?: string;
  false_label?: string;
}

export interface NumberField extends FieldBase {
  type: "number";
  number_type?: NumberType;
  signed?: boolean;
  multiple_of?: number;
  display_as?: "input" | "slider" | "stepper";
  min?: number;
  max?: number;
  step?: number;
  decimal_places?: number;
  prefix?: string;
  suffix?: string;
}

export interface SelectField extends FieldBase {
  type: "select";
  choices: ChoiceSource;
  display_as?: "auto" | "radio" | "dropdown" | "button-group";
  allow_others?: boolean;
  others_type?: "text" | "number";
  option_filter?: Record<string, string>;
}

export interface MultiselectField extends FieldBase {
  type: "multiselect";
  choices: ChoiceSource;
  display_as?: "auto" | "checkbox" | "dropdown" | "tag-input";
  min_selected?: number;
  max_selected?: number;
  allow_others?: boolean;
  others_type?: "text" | "number";
  option_filter?: Record<string, string>;
}

export interface DateField extends FieldBase {
  type: "date";
  use_current?: boolean;
  min_date?: string;
  max_date?: string;
  disable_weekends?: boolean;
  disable_dates?: string[];
  date_format?: string;
}

export interface TimeField extends FieldBase {
  type: "time";
  min_time?: string;
  max_time?: string;
  step_minutes?: number;
  use_24h?: boolean;
}

export interface DateTimeField extends FieldBase {
  type: "datetime";
  use_current?: boolean;
  min_date?: string;
  max_date?: string;
  disable_weekends?: boolean;
  disable_dates?: string[];
  date_format?: string;
  min_time?: string;
  max_time?: string;
  step_minutes?: number;
  use_24h?: boolean;
}

export interface DateRangeField extends FieldBase {
  type: "daterange";
  min_date?: string;
  max_date?: string;
  disable_weekends?: boolean;
  disable_dates?: string[];
  date_format?: string;
  min_range_days?: number;
  max_range_days?: number;
}

export interface FileField extends FieldBase {
  type: "file";
  accept?: string;
  max_size_mb?: number;
  max_files?: number;
  storage?: "memory" | "base64" | "tauri-fs";
}

export interface RatingField extends FieldBase {
  type: "rating";
  max?: number;
  display_as?: "stars" | "numeric-scale" | "emoji-scale";
  low_label?: string;
  high_label?: string;
}

export interface ColorField extends FieldBase {
  type: "color";
  format?: "hex" | "rgba" | "hsl";
  presets?: string[];
}

export interface JsonField extends FieldBase {
  type: "json";
  schema?: Record<string, unknown>;
  rows?: number;
}

export interface SignatureField extends FieldBase {
  type: "signature";
  canvas_width?: number;
  canvas_height?: number;
  stroke_color?: string;
}

export interface LocationField extends FieldBase {
  type: "location";
  mode?: "coordinates" | "address-search" | "map-pin";
  geocoding_source?: string;
}

export interface HiddenField extends FieldBase {
  type: "hidden";
  value_from: "default" | "context" | "query-param" | "computed";
  context_key?: string;
  query_param?: string;
}

export interface BoundField extends FieldBase {
  bind: string;
}

export type FormField =
  | TextField | MultilineField | RichTextField | BooleanField
  | NumberField | SelectField | MultiselectField | DateField
  | TimeField | DateTimeField | DateRangeField | FileField
  | RatingField | ColorField | JsonField | SignatureField
  | LocationField | HiddenField | BoundField;

// ─── Section / Page ───────────────────────────────────────────────────────────
export interface Collection {
  min_items?: number;
  max_items?: number;
  add_label?: string;
  remove_label?: string;
  item_title_template?: string;
  sortable?: boolean;
  default_expanded?: boolean;
}

export interface CrossFieldValidation {
  fields: string[];
  rule: string;
  message: string;
}

export interface FieldGroup {
  name: string;
  description?: string;
  applicable_on: string[];
  group_type: GroupType;
  message?: string;
  index_type?: "NonUnique" | "Unique" | "Text";
  tags?: Record<string, string>;
}

export interface Section {
  id?: string;
  title?: string;
  description?: string;
  icon?: string;
  condition?: ConditionOrRef;
  bind_prefix?: string;
  component?: string;
  collection?: Collection;
  fields?: FormField[];
  cross_field_validations?: CrossFieldValidation[];
  groups?: FieldGroup[];
}

export interface Page {
  id: string;
  title: string;
  description?: string;
  icon?: string;
  condition?: ConditionOrRef;
  on_enter?: ActionRef;
  on_exit?: ActionRef;
  sections: Section[];
}

// ─── Submit Action ─────────────────────────────────────────────────────────────
export interface SubmitAction {
  type: "rest" | "local" | "none";
  url?: string;
  method?: "POST" | "PUT" | "PATCH";
  headers?: Record<string, string>;
  transform_handler?: string;
  handler_name?: string;
  success_message?: string;
  error_message?: string;
}

// ─── Form ──────────────────────────────────────────────────────────────────────
export interface FormAccess {
  feature_ref?: string;
  allowed_role_categories?: RoleCategory[];
  auth_context_key?: string;
  submit_requires?: "create" | "update" | "deactivate" | "reactivate" | "upload";
  read_requires?: "read" | "download" | "print" | "share";
}

export interface FormLayout {
  type: LayoutType;
  columns?: number;
}

export interface DraftConfig {
  persistence?: "localStorage" | "sessionStorage" | "tauri-fs" | "custom" | "none";
  auto_save?: boolean;
  draft_key?: string;
}

export interface SubmitButtonConfig {
  label?: string;
  position?: "bottom" | "top" | "both";
  loading_label?: string;
  icon?: string;
}

export interface FormDef {
  title: string;
  description?: string;
  version: string;
  form_state?: FormState;
  tags?: Record<string, string>;
  confidentiality?: ConfidentialityType;
  retention_days?: number;
  access?: FormAccess;
  model?: string;
  state?: DraftConfig;
  layout: FormLayout;
  submit_label?: string;
  draft_label?: string;
  submit_button?: SubmitButtonConfig;
  pages?: Page[];
  sections?: Section[];
  on_submit?: SubmitAction;
  /**
   * When false, the built-in "🎉 success" screen is NOT shown after a successful
   * submit. Instead the form stays mounted and the caller's onSubmit handler is
   * responsible for the next step (e.g. redirect after a server response).
   * Used by signin/signup forms. Defaults to true.
   */
  show_success_screen?: boolean;
}

// ─── Data Sources ─────────────────────────────────────────────────────────────
export interface DataSourceDef {
  type: "rest" | "local" | "graphql";
  description?: string;
  endpoint?: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  query_params?: Record<string, string>;
  body_template?: string;
  response_path?: string;
  value_key?: string;
  label_key?: string;
  group_key?: string;
  search_param?: string;
  depends_on?: string;
  cache_ttl_seconds?: number;
}

export interface ActionDef {
  type: "set_field" | "show_section" | "hide_section" | "navigate" | "api_call" | "emit_event" | "custom";
  description?: string;
  params?: string[];
  handler?: string;
}

export interface NamedValidationRule {
  type: string;
  description?: string;
  value?: unknown;
  expression?: string;
  message?: string;
  handler?: string;
}

// ─── Manifest ─────────────────────────────────────────────────────────────────
export interface FormManifest {
  manifest_id: string;
  manifest_version?: string;
  engine?: EngineConfig;
  namespaces?: string[];
  conditions?: Record<string, NamedCondition>;
  validation?: { rules?: Record<string, NamedValidationRule> };
  actions?: Record<string, ActionDef>;
  data_sources?: Record<string, DataSourceDef>;
  components?: Record<string, Section>;
  i18n?: Record<string, Record<string, string>>;
  forms?: Record<string, FormDef>;
}

// ─── Form State (runtime) ─────────────────────────────────────────────────────
export type FieldAnswers = Record<string, unknown>;

export interface FormErrors {
  [fieldId: string]: string[];
}

export interface FormContext {
  userId?: string;
  auth?: {
    read?: boolean;
    create?: boolean;
    update?: boolean;
    accessLevel?: AccessLevel;
    fields?: string[];
    filters?: Record<string, string>;
  };
  [key: string]: unknown;
}

// ─── API Types ────────────────────────────────────────────────────────────────
export interface ManifestSummary {
  manifest_id: string;
  manifest_version: string;
  forms: Array<{
    form_id: string;
    title: string;
    version: string;
    form_state: FormState;
    layout_type: LayoutType;
  }>;
  created_at?: string;
  updated_at?: string;
}

export interface FormSubmissionPayload {
  form_id: string;
  manifest_id?: string;
  answers: FieldAnswers;
  draft?: boolean;
  context?: FormContext;
}

export interface FormSubmissionResponse {
  submission_id: string;
  form_id: string;
  status: "accepted" | "draft_saved" | "rejected";
  errors?: FormErrors;
  message?: string;
}
