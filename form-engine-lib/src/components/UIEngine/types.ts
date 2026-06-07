/**
 * UIEngine Type Definitions
 * Aligned with ui_system.schema.yaml v1.0.0
 *
 * Merged from:
 *   form_schema_v4.yaml    — Form Engine Manifest (v4.0.0)
 *   ui_design.yaml         — UI Design Manifest (v1.0.0)
 *   design_additions.yaml  — UI Design Patch (v1.0.0 additions)
 *
 * New sections:
 *   Themes    — named registry, inheritance, role-based overrides, dark-mode, runtime switching
 *   Templates — parametrized reusable screen / component / form templates
 */

import { FormDef, FormManifest } from "../../libs/types";

// ─────────────────────────────────────────────────────────────────────────────
// ENUMS
// ─────────────────────────────────────────────────────────────────────────────

export enum ComponentType {
  Tree = 'Tree',
  Table = 'Table',
  Form = 'Form',
  VerticalList = 'VerticalList',
  HorizontalList = 'HorizontalList',
  Search = 'Search',
  Card = 'Card',
  Tile = 'Tile',
  // New in ui_system_schema
  FileGallery = 'FileGallery',
  FilterBuilder = 'FilterBuilder',
  Avatar = 'Avatar',
  Custom = 'Custom',
}

export enum LayoutDirection {
  Center = 'Center',
  Top = 'Top',
  Bottom = 'Bottom',
  Left = 'Left',
  Right = 'Right',
  Floating = 'Floating',
  Modal = 'Modal',
}

export enum ButtonType {
  Flat = 'Flat',
  Bevel = 'Bevel',
  Swipe = 'Swipe',
  Hover = 'Hover',
}

export enum ButtonActionType {
  CaptchaCheckSubmit = 'CaptchaCheckSubmit',
  Submit = 'Submit',
  Clear = 'Clear',
  Cancel = 'Cancel',
  Logout = 'Logout',
  Toggle = 'Toggle',
  Custom = 'Custom',
}

export enum ScreenAccessType {
  Stacked = 'Stacked',
  Drawer = 'Drawer',
  PopupMenuTop = 'PopupMenuTop',
  PopupMenuBottom = 'PopupMenuBottom',
}

export enum IconType {
  SVG = 'svg',
  PNG = 'png',
  Lucide = 'lucide',
  FontAwesome = 'fontawesome',
  Custom = 'custom',
}

export enum ButtonStyle {
  Flat = 'flat',
  Outlined = 'outlined',
  Contained = 'contained',
  Text = 'text',
}

/** Controls when / how a component's fetched data is cached. */
export type UIPersistenceType = 'LRU' | 'Session' | 'Profile' | 'AppFirstLoad' | 'InApp';

/** How a choice / enum field renders its options inside a component. */
export type ChoiceRenderType = 'radio' | 'checkbox' | 'dropDown' | 'autoFill' | 'pick';

// ─────────────────────────────────────────────────────────────────────────────
// UAM — ACCESS LEVEL & ROLE CATEGORY
// (authoritative definitions; mirror uam#AccessLevel / uam#RoleCategory)
// ─────────────────────────────────────────────────────────────────────────────

export type AccessLevel = 'Self' | 'Delegated' | 'Team' | 'Reportee' | 'Category';
export type RoleCategory = 'Customer' | 'Employee' | 'Partner' | 'Contractor' | 'Automaton';

export interface ResolvedAuth {
  userId?: string;
  schemaId?: string;
  roleCategory?: RoleCategory;
  roleNames?: string[];
  features?: string[];
  read?: boolean;
  create?: boolean;
  update?: boolean;
  deactivate?: boolean;
  reactivate?: boolean;
  upload?: boolean;
  download?: boolean;
  print?: boolean;
  share?: boolean;
  accessLevel?: AccessLevel;
  fields?: string[];
  filters?: Record<string, string>;
}

// ─────────────────────────────────────────────────────────────────────────────
// THEMES — named registry (new in ui_system_schema)
// ─────────────────────────────────────────────────────────────────────────────

export interface ThemeDefinition {
  label?: string;
  extends?: string;
  colors?: Record<string, string>;
  typography?: {
    font_family_default?: string;
    font_family_mono?: string;
    scale: Record<string, string | number>;
  };
  spacing?: Record<string, string | number>;
  radius?: Record<string, string | number>;
  elevation?: Record<string, string>;
  motion?: {
    duration_fast_ms?: number;
    duration_standard_ms?: number;
    duration_slow_ms?: number;
    easing_standard?: string;
    easing_decelerate?: string;
    easing_accelerate?: string;
    /** When true, transitions are replaced with instant cuts (prefers-reduced-motion). */
    reduced_motion?: boolean;
  };
  dark_mode?: Record<string, string>;
  selectable?: boolean;
  /** 6-digit hex without '#' used for theme picker swatches. */
  preview_color?: string;
}

/** @deprecated Alias for ThemeDefinition kept for backwards compat. */
export interface Theme extends ThemeDefinition {}

// ─────────────────────────────────────────────────────────────────────────────
// ICON REGISTRY
// ─────────────────────────────────────────────────────────────────────────────

export interface IconEntry {
  type: IconType;
  path?: string;
  name?: string;
  component?: string;
  alt?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// BREAKPOINTS
// ─────────────────────────────────────────────────────────────────────────────

export interface Breakpoint {
  min_width_px: number;
  max_width_px?: number | null;
  label?: string;
  columns?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// NAVIGATION
// ─────────────────────────────────────────────────────────────────────────────

export interface Route {
  screen: string;
  path?: string;
  params?: Record<string, string>;
  auth_required?: boolean;
  feature_ref?: string;
}

export interface NavigationConfig {
  initial_screen: string;
  type: 'tab_bar' | 'drawer' | 'stack' | 'none';
  tab_bar_position?: 'top' | 'bottom';
  routes?: Record<string, Route>;
  guards?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// TRANSITIONS & ANIMATIONS
// ─────────────────────────────────────────────────────────────────────────────

export interface Transition {
  type:
    | 'fade'
    | 'slide_left'
    | 'slide_right'
    | 'slide_up'
    | 'slide_down'
    | 'scale'
    | 'flip'
    | 'shared_element'
    | 'custom';
  duration_ms?: number;
  easing?: string;
  delay_ms?: number;
  custom_handler?: string;
  shared_element_tag?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// ACCESSIBILITY
// ─────────────────────────────────────────────────────────────────────────────

export interface AccessibilityProps {
  label?: string;
  hint?: string;
  role?:
    | 'button' | 'link' | 'heading' | 'image' | 'list' | 'listitem'
    | 'checkbox' | 'radio' | 'switch' | 'slider' | 'tab' | 'tabpanel'
    | 'dialog' | 'alert' | 'status' | 'none';
  live_region?: 'off' | 'polite' | 'assertive';
  keyboard_shortcut?: string;
  focus_order?: number;
  min_touch_target_px?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// LOADING STATES
// ─────────────────────────────────────────────────────────────────────────────

export interface LoadingState {
  style?: 'spinner' | 'skeleton' | 'shimmer' | 'progress_bar' | 'overlay' | 'none';
  skeleton_rows?: number;
  overlay_opacity?: number;
  min_display_ms?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// CONDITIONS
// ─────────────────────────────────────────────────────────────────────────────

export type ConditionOrRef =
  | string
  | { ref: string }
  | {
      field: string;
      operator:
        | 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte'
        | 'in' | 'not_in' | 'contains' | 'starts_with'
        | 'ends_with' | 'is_empty' | 'is_not_empty';
      value?: any;
    };

// ─────────────────────────────────────────────────────────────────────────────
// BUTTONS
// ─────────────────────────────────────────────────────────────────────────────

export interface Button {
  name: string;
  label?: string;
  button_type?: ButtonType;
  on_press: string;
  custom_handler?: string;
  icon_ref?: string;
  icon_path?: string;
  background_pic_path?: string;
  text_size?: number | string;
  /** Text / icon colour. */
  foreground_color?: string;
  /** Background fill. */
  background_color?: string;
  /** Border colour. Renders only when set. */
  border_color?: string;
  disabled_condition?: ConditionOrRef;
  hidden_condition?: ConditionOrRef;
  accessibility?: AccessibilityProps;
  confirm_dialog_ref?: string;
  analytics_event?: string;
}

export interface ButtonReference {
  button_ref: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// DATA BINDING
// ─────────────────────────────────────────────────────────────────────────────

export interface Pagination {
  type?: 'cursor' | 'page_number' | 'offset' | 'none';
  page_size?: number;
  page_param?: string;
  size_param?: string;
}

export interface SortConfig {
  field?: string;
  direction?: 'asc' | 'desc';
}

export interface DataBinding {
  source_ref?: string;
  query_params?: Record<string, string>;
  write_action_ref?: string;
  delete_action_ref?: string;
  pagination?: Pagination;
  sort?: SortConfig;
  polling_interval_ms?: number | null;
  optimistic_updates?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPONENT LIFECYCLE
// ─────────────────────────────────────────────────────────────────────────────

export interface ComponentLifecycle {
  on_mount?: string;
  on_unmount?: string;
  on_focus?: string;
  on_blur?: string;
  on_data_load?: string;
  on_data_error?: string;
  on_refresh?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// GESTURE HANDLING
// ─────────────────────────────────────────────────────────────────────────────

export interface GestureHandler {
  gesture:
    | 'tap' | 'double_tap' | 'long_press'
    | 'swipe_left' | 'swipe_right' | 'swipe_up' | 'swipe_down'
    | 'pinch' | 'spread' | 'rotate';
  action_ref: string;
  condition?: ConditionOrRef;
  min_distance_px?: number;
  long_press_duration_ms?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// STATE FEEDBACK
// ─────────────────────────────────────────────────────────────────────────────

export interface EmptyState {
  text?: string;
  icon_ref?: string;
  action_ref?: string;
}

export interface ErrorState {
  text?: string;
  icon_ref?: string;
  retry_action_ref?: string;
}

export interface StateConfig {
  loading_state?: LoadingState;
  empty_state?: EmptyState;
  error_state?: ErrorState;
}

// ─────────────────────────────────────────────────────────────────────────────
// FORM EMBED CONFIG (new)
// ─────────────────────────────────────────────────────────────────────────────

export interface FormEmbedConfig {
  mode?: 'inline' | 'modal' | 'drawer' | 'panel';
  /** Key from manifest "buttons". Required when mode=modal/drawer/panel. */
  trigger_button_ref?: string;
  /** Maps form field IDs to context expressions for pre-filling. */
  pre_fill?: Record<string, string>;
  /** Key of a manifest action invoked after successful form submission. */
  on_submit_action_ref?: string;
  /** Overrides the embedded form's submit_label. */
  submit_label_override?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// SPECIALISED COMPONENT CONFIGS (new — from design_additions)
// ─────────────────────────────────────────────────────────────────────────────

export interface FileComponentConfig {
  allow_pictures?: boolean;
  allow_files?: boolean;
  allowed_file_types?: string[];
  max_file_size_mb?: number;
  upload_enabled?: boolean;
  delete_enabled?: boolean;
  download_enabled?: boolean;
  thumbnail_size?: 'small' | 'medium' | 'large';
  layout?: 'grid' | 'list';
  category_filter?: boolean;
  tag_filter?: boolean;
}

export interface FilterBuilderConfig {
  filterable_fields?: string[];
  allowed_operators?: Array<
    | 'and' | 'or' | 'not' | 'equals' | 'unequals'
    | 'is' | 'is not'
    | 'greater than' | 'less than'
    | 'greater than or equal to' | 'less than or equal to'
    | 'in' | 'not in' | 'exists' | 'be'
  >;
  max_conditions?: number;
  allow_nesting?: boolean;
  output_action_ref?: string;
  preset_filters?: Array<{ label: string; expression: string }>;
}

export interface AvatarConfig {
  show_photo?: boolean;
  show_nick_name?: boolean;
  fallback_style?: 'initials' | 'icon' | 'placeholder';
  fallback_icon_ref?: string;
  size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl';
  shape?: 'circle' | 'rounded' | 'square';
  show_online_indicator?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// WIDGET MAP (new — from design_additions)
// ─────────────────────────────────────────────────────────────────────────────

export interface WidgetMap {
  enum?: string;
  choice?: string;
  string?: string;
  multiLineText?: string;
  number?: string;
  boolean?: string;
  date?: string;
  any?: string;
  id?: string;
  secret?: string;
  reference?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// ROLE PREFERENCE OVERRIDE (new — from design_additions)
// ─────────────────────────────────────────────────────────────────────────────

export interface RolePreferenceOverride {
  theme_extends?: string;
  default_locale?: string;
  default_currency?: string;
  hidden_screens?: string[];
  hidden_components?: string[];
  column_visibility?: Record<string, string[]>;
  show_pro_fields?: boolean;
  items_per_page?: number;
  date_format?: string;
  active_features?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// SCREEN AUTH RULES (new)
// ─────────────────────────────────────────────────────────────────────────────

export interface ScreenAuthRules {
  require_auth?: boolean;
  require_access_levels?: AccessLevel[];
  require_permissions?: string[];
  redirect_on_denied?: string;
  denied_toast_ref?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// TEMPLATES (new)
// ─────────────────────────────────────────────────────────────────────────────

export interface TemplateVariable {
  name: string;
  type:
    | 'string' | 'boolean' | 'number'
    | 'screen_ref' | 'component_ref' | 'form_ref'
    | 'schema_ref' | 'feature_ref' | 'icon_ref'
    | 'data_source_ref' | 'action_ref';
  required?: boolean;
  default?: any;
  description?: string;
}

export interface ScreenTemplate {
  label?: string;
  description?: string;
  variables: TemplateVariable[];
  screen: Screen;
  tags?: Record<string, string>;
}

export interface ComponentTemplate {
  label?: string;
  description?: string;
  variables: TemplateVariable[];
  component: Component;
  tags?: Record<string, string>;
}

export interface FormTemplate {
  label?: string;
  description?: string;
  variables: TemplateVariable[];
  /** FormDef — typed as any to avoid circular dep with libs/types. */
  form: Record<string, any>;
  tags?: Record<string, string>;
}

export interface TemplateRegistry {
  screen_templates?: Record<string, ScreenTemplate>;
  component_templates?: Record<string, ComponentTemplate>;
  form_templates?: Record<string, FormTemplate>;
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPONENTS
// ─────────────────────────────────────────────────────────────────────────────

export interface SubComponentPlacement {
  component_ref: string;
  direction: LayoutDirection;
  breakpoint?: string;
  hidden_condition?: ConditionOrRef;
  /**
   * Flex-weight for Left / Right panels.
   * Controls how the horizontal space is divided between panels when no Center
   * content is present. A Left with span=2 and a Right with span=1 (default)
   * gives a 2 : 1 split — hero takes two-thirds, auth card takes one-third.
   *
   * On portrait / narrow screens (< 768 px wide OR height > width) the layout
   * switches to a vertical stack and span is ignored; each panel fills 100 %
   * of the viewport width.
   *
   * @default 1
   */
  span?: number;
}

export interface Component {
  name: string;
  label?: string;
  type: ComponentType;

  // Data binding
  schema_ref?: string;
  /** Key of a form definition from the manifest "forms" map. Required when type=Form. */
  form_ref?: string;
  form_embed?: FormEmbedConfig;
  data_binding?: DataBinding;

  // Display
  text?: string;
  text_size?: number | string;

  /**
   * COLOR OVERRIDES
   * ───────────────
   * All color fields accept:
   *   - CSS named colors  → "white", "transparent", "crimson"
   *   - Pre-hashed hex    → "#6366f1", "#fff"
   *   - Bare hex digits   → "6366f1"   (# is added automatically)
   *   - Any CSS color fn  → "rgb(99,102,241)", "hsl(239,84%,67%)"
   *
   * When set, these override the corresponding value that would otherwise come
   * from the active theme, scoped to this component only.
   */

  /** Background of the component container (card / wrapper div). */
  background_color?: string;

  /** Text / icon colour for the component container and its label. */
  foreground_color?: string;

  /** Border colour of the component container. Renders only when set. */
  border_color?: string;

  /**
   * Background fill applied to every <input>, <select>, and <textarea>
   * rendered inside this component.
   */
  input_background_color?: string;

  /**
   * Text colour applied to every <input>, <select>, and <textarea>
   * rendered inside this component.
   */
  input_text_color?: string;

  /**
   * Border colour applied to every <input>, <select>, and <textarea>
   * rendered inside this component.
   */
  input_border_color?: string;

  /**
   * Text colour used specifically for form-field labels rendered inside
   * this component. Falls back to foreground_color → theme.on_surface.
   */
  label_color?: string;

  background_pic_path?: string;

  // Field / column overrides
  fields?: string[];
  /** Maps field names → widget names, overriding widget_map defaults for this component. */
  field_widget_overrides?: Record<string, string>;
  sections?: string[];

  // Sub-components
  sub_components?: SubComponentPlacement[];

  // Actions
  actions?: (Button | ButtonReference)[];

  // Persistence
  ui_persistence?: UIPersistenceType;

  // Choice rendering override
  choice_render?: ChoiceRenderType;

  // Specialised configs
  /** Required when type=FileGallery. */
  file_config?: FileComponentConfig;
  /** Required when type=FilterBuilder. */
  filter_config?: FilterBuilderConfig;
  /** Required when type=Avatar. */
  avatar_config?: AvatarConfig;

  // Schema rendering flags
  show_pro_fields?: boolean;
  enable_branching?: boolean;
  sectioned?: boolean;
  field_validation_hints?: boolean;

  // Layout & responsive
  breakpoint_overrides?: Record<string, object>;

  // Auth-based visibility
  feature_ref?: string;
  hidden_condition?: ConditionOrRef;
  visible_access_levels?: AccessLevel[];

  // Theme override
  /** Key from manifest "themes". Scopes a sub-theme to this component only. */
  theme_ref?: string;

  // Lifecycle, feedback, gestures, accessibility, analytics
  lifecycle?: ComponentLifecycle;
  loading_state?: LoadingState;
  empty_state?: EmptyState;
  error_state?: ErrorState;
  gestures?: GestureHandler[];
  accessibility?: AccessibilityProps;
  transition_in?: string;
  transition_out?: string;
  analytics_id?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// TOASTS & DIALOGS
// ─────────────────────────────────────────────────────────────────────────────

export interface Toast {
  message: string;
  severity?: 'info' | 'success' | 'warning' | 'error';
  duration_ms?: number;
  position?: 'top' | 'top_left' | 'top_right' | 'bottom' | 'bottom_left' | 'bottom_right';
  action_label?: string;
  action_ref?: string;
  icon_ref?: string;
}

export interface Dialog {
  title: string;
  body?: string;
  icon_ref?: string;
  severity?: 'info' | 'success' | 'warning' | 'error' | 'neutral';
  dismissible?: boolean;
  primary_action?: Button;
  secondary_action?: Button;
  component_ref?: string;
  max_width_px?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// SCREENS
// ─────────────────────────────────────────────────────────────────────────────

export interface SecondaryScreenLink {
  screen_ref: string;
  access_type: ScreenAccessType;
  menu_label?: string;
  menu_order?: number;
  hidden_condition?: ConditionOrRef;
  params?: Record<string, string>;
}

export interface StatusBar {
  style?: 'light' | 'dark' | 'auto';
  background_color?: string;
}

export interface Screen {
  name: string;
  label?: string;
  icon_ref?: string;
  icon_path?: string;
  is_home?: boolean;
  nav_order?: number;
  components?: SubComponentPlacement[];
  secondary_screens?: SecondaryScreenLink[];

  // Auth-based access
  feature_ref?: string;
  allowed_role_categories?: RoleCategory[];
  /** Consolidated auth rules applied after feature_ref and role category checks. */
  auth_rules?: ScreenAuthRules;

  // Appearance
  background_color?: string;
  background_pic_path?: string;
  /** Key from manifest "themes". Overrides the active_theme for this screen only. */
  theme_ref?: string;

  // Lifecycle
  on_enter?: string;
  on_exit?: string;
  on_back?: string;
  transition_in?: string;
  transition_out?: string;
  status_bar?: StatusBar;
  analytics_id?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// FEATURES
// ─────────────────────────────────────────────────────────────────────────────

export interface Feature {
  /** Must match a uam#Feature name. */
  name: string;
  label?: string;
  confidentiality?: string;
  /** Component keys gated by this feature. */
  components?: string[];
  /** Screen keys gated by this feature. */
  screens?: string[];
  /** Form IDs gated by this feature. */
  forms?: string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// UI SYSTEM MANIFEST  (unified top-level — replaces UIDesignManifest)
// ─────────────────────────────────────────────────────────────────────────────

export interface UISystemManifest {
  // Document identity
  manifest_id: string;
  manifest_version?: string;
  description?: string;
  namespaces?: Array<string>;

  // Form Engine (from form_schema_v4.yaml) — kept as opaque maps here;
  // FormEngine components consume them directly via libs/types.
  engine?: Record<string, any>;
  types?: Record<string, any>;
  models?: Record<string, any>;
  conditions?: Record<string, any>;
  validation?: Record<string, any>;
  actions?: Record<string, any>;
  data_sources?: Record<string, any>;
  i18n?: Record<string, Record<string, string>>;
  tracking?: Record<string, any>;
  forms?: Record<string, FormDef>;

  // UI Layer (from ui_design.yaml)
  icons?: Record<string, IconEntry>;
  breakpoints?: Record<string, Breakpoint>;
  navigation?: NavigationConfig;
  features?: Record<string, Feature>;
  buttons?: Record<string, Button>;
  components?: Record<string, Component>;
  screens?: Record<string, Screen>;
  toasts?: Record<string, Toast>;
  dialogs?: Record<string, Dialog>;
  transitions?: Record<string, Transition>;

  // Widget Map & Role Preferences (from design_additions.yaml)
  widget_map?: WidgetMap;
  role_preferences?: Record<string, RolePreferenceOverride>;

  // Themes (new)
  /**
   * Named theme definitions. Built-in base names (provided by runtime):
   *   default | material | ios-hig | fluent
   */
  themes?: Record<string, ThemeDefinition>;
  /**
   * Key of the theme used as the application default.
   * @default "default"
   */
  active_theme?: string;

  // Templates (new)
  templates?: TemplateRegistry;
}

/**
 * @deprecated Use UISystemManifest. This alias exists for backwards compatibility.
 */
export type UIDesignManifest = UISystemManifest;

// ─────────────────────────────────────────────────────────────────────────────
// RUNTIME STATE & CONTEXT
// ─────────────────────────────────────────────────────────────────────────────

export interface UIEngineState {
  currentScreenKey: string;
  currentBreakpoint: string;
  isDarkMode: boolean;
  isAuthenticated: boolean;
  userRoleCategories: string[];
  enabledFeatures: string[];
  componentStates: Record<string, Record<string, any>>;
  navigationStack: string[];
  /** Resolved auth object — populated at runtime from the UAM service. */
  resolvedAuth?: ResolvedAuth;
  /** The currently active theme key (initialised from manifest.active_theme). */
  activeThemeKey: string;
}

export interface UIEngineContextValue {
  manifest: UISystemManifest;
  state: UIEngineState;
  handlers: UIEngineHandlers;
  dispatch: (action: UIEngineAction) => void;
}

export interface UIEngineHandlers {
  [key: string]: (context: any) => Promise<void> | void;
}

// ─────────────────────────────────────────────────────────────────────────────
// ACTIONS & REDUCERS
// ─────────────────────────────────────────────────────────────────────────────

export type UIEngineAction =
  | { type: 'SET_SCREEN'; payload: string }
  | { type: 'PUSH_SCREEN'; payload: string }
  | { type: 'POP_SCREEN' }
  | { type: 'SET_BREAKPOINT'; payload: string }
  | { type: 'SET_DARK_MODE'; payload: boolean }
  | { type: 'SET_AUTHENTICATED'; payload: boolean }
  | { type: 'SET_ROLE_CATEGORIES'; payload: string[] }
  | { type: 'SET_ENABLED_FEATURES'; payload: string[] }
  | { type: 'SET_COMPONENT_STATE'; payload: { componentId: string; state: Record<string, any> } }
  | { type: 'UPDATE_COMPONENT_STATE'; payload: { componentId: string; updates: Record<string, any> } }
  | { type: 'SET_RESOLVED_AUTH'; payload: ResolvedAuth }
  | { type: 'SET_ACTIVE_THEME'; payload: string };