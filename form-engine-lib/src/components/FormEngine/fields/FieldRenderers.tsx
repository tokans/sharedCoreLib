"use client";

import React from "react";
import type {
  FormField, TextField, MultilineField, BooleanField, NumberField,
  SelectField, MultiselectField, DateField, RatingField, FileField,
  StaticChoice,
} from "../../../libs/types";
import { cn } from "../../../libs/utils";
import { useFormEngineStore } from "../../../store/form-engine-store";

// ─── Dynamic choices config (mirrors DynamicChoicesConfig in schema) ──────────
interface DynamicChoicesConfig {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  response_path?: string;
  value_key: string;
  label_key: string;
  group_key?: string;
  cache_ttl_seconds?: number;
}

// Simple in-memory cache for dynamic choices
const _choicesCache: Record<string, { data: StaticChoice[]; ts: number }> = {};

/**
 * Fetch choices from a dynamic data source.
 * Handles both absolute URLs and relative paths (prefixed with NEXT_PUBLIC_API_URL).
 */
function useDynamicChoices(config: DynamicChoicesConfig | null): {
  choices: StaticChoice[];
  loading: boolean;
  error: string | null;
} {
  const [choices, setChoices] = React.useState<StaticChoice[]>([]);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const cacheKey = config ? `${config.url}|${config.value_key}|${config.label_key}` : "";
  const ttl = (config?.cache_ttl_seconds ?? 60) * 1000;

  React.useEffect(() => {
    if (!config?.url) return;

    // Check cache
    const cached = _choicesCache[cacheKey];
    if (cached && Date.now() - cached.ts < ttl) {
      setChoices(cached.data);
      return;
    }

    setLoading(true);
    setError(null);

    // Absolute URLs are used as-is. Relative URLs (e.g. "/api/choices")
    // resolve against the current origin — the browser handles it natively.
    const url = config.url;

    fetch(url, {
      method: config.method ?? "GET",
      headers: config.headers,
    })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data) => {
        // Traverse response_path (e.g. "data.items")
        let items: unknown = data;
        if (config.response_path) {
          for (const part of config.response_path.split(".")) {
            items = (items as Record<string, unknown>)?.[part];
          }
        }
        if (!Array.isArray(items)) items = [];
        const mapped = (items as Record<string, unknown>[]).map((item) => ({
          value: String(item[config.value_key] ?? ""),
          label: String(item[config.label_key] ?? item[config.value_key] ?? ""),
          group: config.group_key ? String(item[config.group_key] ?? "") : undefined,
        }));
        _choicesCache[cacheKey] = { data: mapped, ts: Date.now() };
        setChoices(mapped);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, [cacheKey, ttl]); // eslint-disable-line react-hooks/exhaustive-deps

  return { choices, loading, error };
}

/**
 * Inspect a field's `choices` prop and return the static list (if any).
 * Handles three formats:
 *   1. Raw array         (legacy / most YAML files use this)
 *   2. { static: [...] } (schema-conformant)
 *   3. { dynamic: {...} } / { source_ref: "..." }  → not static, returns []
 */
function resolveStaticChoices(choices: unknown): StaticChoice[] {
  if (!choices) return [];
  if (Array.isArray(choices)) return choices as StaticChoice[];
  const c = choices as Record<string, unknown>;
  if (Array.isArray(c.static)) return c.static as StaticChoice[];
  return [];
}

/**
 * Hook: returns the manifest's `data_sources` map for source_ref resolution.
 * Stable identity per render — safe to use in dependency arrays via key fields.
 */
function useDataSources(): Record<string, DynamicChoicesConfig> {
  return useFormEngineStore(
    (s) => (s.manifest?.data_sources as Record<string, DynamicChoicesConfig> | undefined) ?? {}
  );
}

/**
 * Extract the DynamicChoicesConfig from a field's `choices` prop.
 * Supports both `{ dynamic: {...} }` and `{ source_ref: "name" }` — the latter
 * is resolved against the manifest's top-level `data_sources` map.
 */
function getDynamicConfig(
  choices: unknown,
  dataSources: Record<string, DynamicChoicesConfig>
): DynamicChoicesConfig | null {
  if (!choices || Array.isArray(choices)) return null;
  const c = choices as Record<string, unknown>;
  if (c.dynamic && typeof c.dynamic === "object") return c.dynamic as DynamicChoicesConfig;
  if (typeof c.source_ref === "string") {
    const src = dataSources[c.source_ref];
    if (!src) return null;
    const endpoint = (src as unknown as { endpoint?: string; url?: string }).endpoint
                  ?? (src as unknown as { url?: string }).url;
    if (!endpoint) return null;
    return { ...src, url: endpoint };
  }
  return null;
}

// ─── Shared Field Wrapper ─────────────────────────────────────────────────────
interface FieldWrapperProps {
  label?: string;
  required?: boolean;
  hint?: string;
  description?: string;
  errors?: string[];
  children: React.ReactNode;
  width?: "full" | "half" | "third";
  className?: string;
}

export function FieldWrapper({
  label, required, hint, description, errors, children, width = "full", className
}: FieldWrapperProps) {
  return (
    <div className={cn(
      className,
      "flex flex-col gap-1.5 p-4 col-span-2",
      width === "half" && "col-span-1",
      width === "third" && "col-span-1",
    )}>
      {label && (
        <label className="text-sm font-medium text-gray-700 dark:text-gray-300">
          {label}
          {required && <span className="text-red-500 ml-1">*</span>}
        </label>
      )}
      {description && <p className="text-xs text-gray-500">{description}</p>}
      {children}
      {hint && !errors?.length && <p className="text-xs text-gray-400">{hint}</p>}
      {errors?.map((e, i) => (
        <p key={i} className="text-xs text-red-500 flex items-center gap-1">
          <span>⚠</span> {e}
        </p>
      ))}
    </div>
  );
}

// ─── Text Field ───────────────────────────────────────────────────────────────
interface FieldProps<T extends FormField> {
  field: T;
  value: unknown;
  onChange: (val: unknown) => void;
  onBlur?: () => void;
  errors?: string[];
  disabled?: boolean;
}

export function TextFieldRenderer({ field, value, onChange, onBlur, errors, disabled }: FieldProps<TextField>) {
  const f = field as TextField;
  const inputType = f.display_as && f.display_as !== "input" ? f.display_as : "text";
  return (
    <FieldWrapper label={f.label} required={f.required} hint={f.hint}
      description={f.description} errors={errors} width={f.width}>
      <input
        type={f.confidentiality === "Secret" ? "password" : inputType}
        value={String(value ?? "")}
        onChange={e => onChange(e.target.value)}
        onBlur={onBlur}
        placeholder={f.placeholder}
        autoComplete={f.autocomplete}
        disabled={disabled || f.disabled}
        
        readOnly={f.readonly}
        maxLength={f.max_length}
        className={cn(
          "w-full rounded-lg border px-3 py-2 text-sm transition-colors",
          "border-gray-300 bg-white focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20",
          "dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100",
          "disabled:opacity-50 disabled:cursor-not-allowed",
          errors?.length && "border-red-400 focus:border-red-500 focus:ring-red-500/20"
        )}
      />
    </FieldWrapper>
  );
}

// ─── Multiline Field ──────────────────────────────────────────────────────────
export function MultilineFieldRenderer({ field, value, onChange, onBlur, errors, disabled }: FieldProps<MultilineField>) {
  const f = field as MultilineField;
  const current = String(value ?? "");
  return (
    <FieldWrapper label={f.label} required={f.required} hint={f.hint}
      description={f.description} errors={errors} width={f.width}>
      <div className="relative">
        <textarea
          value={current}
          onChange={e => onChange(e.target.value)}
          onBlur={onBlur}
          placeholder={f.placeholder}
          disabled={disabled || f.disabled}
          readOnly={f.readonly}
          rows={f.rows ?? 4}
          maxLength={f.max_length}
          style={{ resize: f.resize === "none" ? "none" : f.resize === "both" ? "both" : "vertical" }}
          className={cn(
            "w-full rounded-lg border px-3 py-2 text-sm transition-colors",
            "border-gray-300 bg-white focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20",
            "dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100",
            errors?.length && "border-red-400"
          )}
        />
        {f.max_length && (
          <span className="absolute bottom-2 right-3 text-xs text-gray-400">
            {current.length}/{f.max_length}
          </span>
        )}
      </div>
    </FieldWrapper>
  );
}

// ─── Boolean Field ────────────────────────────────────────────────────────────
export function BooleanFieldRenderer({ field, value, onChange, errors, disabled }: FieldProps<BooleanField>) {
  const f = field as BooleanField;
  const checked = value === true;
  const displayAs = f.display_as ?? "switch";

  if (displayAs === "yes-no-radio") {
    return (
      <FieldWrapper label={f.label} required={f.required} hint={f.hint}
        description={f.description} errors={errors} width={f.width}>
        <div className="flex gap-4">
          {[true, false].map((v) => (
            <label key={String(v)} className="flex items-center gap-2 cursor-pointer">
              <input
                type="radio"
                checked={value === v}
                onChange={() => onChange(v)}
                disabled={disabled || f.disabled}
                className="accent-blue-600"
              />
              <span className="text-sm">{v ? (f.true_label ?? "Yes") : (f.false_label ?? "No")}</span>
            </label>
          ))}
        </div>
      </FieldWrapper>
    );
  }

  if (displayAs === "checkbox") {
    return (
      <FieldWrapper hint={f.hint} description={f.description} errors={errors} width={f.width}>
        <label className={cn(
          "flex items-start gap-3 cursor-pointer",
          (disabled || f.disabled) && "opacity-50 cursor-not-allowed"
        )}>
          <input
            type="checkbox"
            checked={checked}
            onChange={e => onChange(e.target.checked)}
            disabled={disabled || f.disabled}
            className="mt-0.5 h-4 w-4 rounded accent-blue-600"
          />
          <span className="text-sm text-gray-700 dark:text-gray-300">
            {f.label}{f.required && <span className="text-red-500 ml-1">*</span>}
          </span>
        </label>
      </FieldWrapper>
    );
  }

  // Switch
  return (
    <FieldWrapper hint={f.hint} description={f.description} errors={errors} width={f.width}>
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
          {f.label}{f.required && <span className="text-red-500 ml-1">*</span>}
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={checked}
          onClick={() => !disabled && !f.disabled && onChange(!checked)}
          disabled={disabled || f.disabled}
          className={cn(
            "relative inline-flex h-6 w-11 items-center rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500/40",
            checked ? "bg-blue-600" : "bg-gray-300 dark:bg-gray-600",
            (disabled || f.disabled) && "opacity-50 cursor-not-allowed"
          )}
        >
          <span className={cn(
            "inline-block h-4 w-4 transform rounded-full bg-white transition-transform shadow",
            checked ? "translate-x-6" : "translate-x-1"
          )} />
        </button>
      </div>
    </FieldWrapper>
  );
}

// ─── Number Field ─────────────────────────────────────────────────────────────
export function NumberFieldRenderer({ field, value, onChange, onBlur, errors, disabled }: FieldProps<NumberField>) {
  const f = field as NumberField;
  const displayAs = f.display_as ?? "input";

  if (displayAs === "slider") {
    const min = f.min ?? 0;
    const max = f.max ?? 100;
    const val = Number(value ?? min);
    return (
      <FieldWrapper label={f.label} required={f.required} hint={f.hint}
        description={f.description} errors={errors} width={f.width}>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min={min} max={max} step={f.step ?? 1}
            value={val}
            onChange={e => onChange(Number(e.target.value))}
            disabled={disabled || f.disabled}
            className="flex-1 accent-blue-600"
          />
          <span className="text-sm font-medium w-12 text-center">
            {f.prefix}{val}{f.suffix}
          </span>
        </div>
      </FieldWrapper>
    );
  }

  if (displayAs === "stepper") {
    const val = Number(value ?? 0);
    const step = f.step ?? 1;
    return (
      <FieldWrapper label={f.label} required={f.required} hint={f.hint}
        description={f.description} errors={errors} width={f.width}>
        <div className="flex items-center gap-2">
          {f.prefix && <span className="text-sm text-gray-500">{f.prefix}</span>}
          <button type="button" onClick={() => onChange(val - step)}
            disabled={disabled || (f.min != null && val <= f.min)}
            className="h-8 w-8 rounded-full border border-gray-300 text-lg font-bold hover:bg-gray-50 disabled:opacity-40">
            −
          </button>
          <span className="w-16 text-center font-medium">{val}</span>
          <button type="button" onClick={() => onChange(val + step)}
            disabled={disabled || (f.max != null && val >= f.max)}
            className="h-8 w-8 rounded-full border border-gray-300 text-lg font-bold hover:bg-gray-50 disabled:opacity-40">
            +
          </button>
          {f.suffix && <span className="text-sm text-gray-500">{f.suffix}</span>}
        </div>
      </FieldWrapper>
    );
  }

  return (
    <FieldWrapper label={f.label} required={f.required} hint={f.hint}
      description={f.description} errors={errors} width={f.width}>
      <div className="relative flex items-center">
        {f.prefix && (
          <span className="absolute left-3 text-sm text-gray-500 pointer-events-none">{f.prefix}</span>
        )}
        <input
          type="number"
          value={value == null ? "" : String(value)}
          onChange={e => onChange(e.target.value === "" ? null : Number(e.target.value))}
          onBlur={onBlur}
          min={f.min} max={f.max} step={f.step ?? 1}
          placeholder={f.placeholder}
          disabled={disabled || f.disabled}
          readOnly={f.readonly}
          className={cn(
            "w-full rounded-lg border px-3 py-2 text-sm",
            "border-gray-300 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20",
            "dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100",
            f.prefix && "pl-8", f.suffix && "pr-10",
            errors?.length && "border-red-400"
          )}
        />
        {f.suffix && (
          <span className="absolute right-3 text-sm text-gray-500 pointer-events-none">{f.suffix}</span>
        )}
      </div>
    </FieldWrapper>
  );
}

// ─── Select Field ─────────────────────────────────────────────────────────────
export function SelectFieldRenderer({ field, value, onChange, onBlur, errors, disabled }: FieldProps<SelectField>) {
  const f = field as SelectField;
  const dataSources = useDataSources();
  const dynamicConfig = getDynamicConfig(f.choices, dataSources);
  const { choices: dynamicChoices, loading, error: fetchError } = useDynamicChoices(dynamicConfig);
  const staticChoices = resolveStaticChoices(f.choices);
  const choices = dynamicConfig ? dynamicChoices : staticChoices;
  const displayAs = f.display_as ?? "auto";
  const useRadio = displayAs === "radio" || (displayAs === "auto" && choices.length <= 4);

  // ── Dynamic loading / error states ───────────────────────────────────────
  if (loading) {
    return (
      <FieldWrapper label={f.label} required={f.required} hint={f.hint}
        description={f.description} errors={errors} width={f.width}>
        <div className="flex items-center gap-2 h-10 px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 text-sm text-gray-400">
          <span className="h-3.5 w-3.5 rounded-full border-2 border-gray-300 border-t-blue-500 animate-spin flex-shrink-0" />
          Loading options…
        </div>
      </FieldWrapper>
    );
  }
  if (fetchError) {
    return (
      <FieldWrapper label={f.label} required={f.required} hint={f.hint}
        description={f.description} errors={[...(errors ?? []), `Could not load options: ${fetchError}`]} width={f.width}>
        <div className="h-10 px-3 rounded-lg border border-red-200 bg-red-50 dark:bg-red-950/20 flex items-center text-sm text-red-500">
          ⚠ Failed to load options
        </div>
      </FieldWrapper>
    );
  }

  if (displayAs === "button-group" || (displayAs === "auto" && !dynamicConfig && choices.length <= 3)) {
    return (
      <FieldWrapper label={f.label} required={f.required} hint={f.hint}
        description={f.description} errors={errors} width={f.width}>
        <div className="flex flex-wrap gap-2">
          {choices.map(choice => (
            <button
              key={String(choice.value)}
              type="button"
              onClick={() => onChange(value === choice.value ? null : choice.value)}
              disabled={disabled || f.disabled || choice.disabled}
              className={cn(
                "px-4 py-2 rounded-lg border text-sm font-medium transition-all",
                value === choice.value
                  ? "bg-blue-600 border-blue-600 text-white shadow-sm"
                  : "bg-white border-gray-300 text-gray-700 hover:border-blue-400 hover:bg-blue-50",
                (disabled || choice.disabled) && "opacity-40 cursor-not-allowed"
              )}
            >
              {choice.icon && <span className="mr-1">{choice.icon}</span>}
              {choice.label}
            </button>
          ))}
        </div>
      </FieldWrapper>
    );
  }

  if (useRadio && !dynamicConfig) {
    return (
      <FieldWrapper label={f.label} required={f.required} hint={f.hint}
        description={f.description} errors={errors} width={f.width}>
        <div className="flex flex-col gap-2">
          {choices.map(choice => (
            <label key={String(choice.value)}
              className={cn("flex items-center gap-3 cursor-pointer p-2 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700/50",
                value === choice.value && "bg-blue-50 dark:bg-blue-900/20"
              )}>
              <input
                type="radio"
                checked={value === choice.value}
                onChange={() => onChange(choice.value)}
                disabled={disabled || f.disabled || choice.disabled}
                className="accent-blue-600"
              />
              <span className="text-sm">{choice.label}</span>
            </label>
          ))}
        </div>
      </FieldWrapper>
    );
  }

  // Default: dropdown (always used for dynamic sources)
  const selectedLabel = choices.find(c => String(c.value) === String(value))?.label;
  return (
    <FieldWrapper label={f.label} required={f.required} hint={f.hint}
      description={f.description} errors={errors} width={f.width}>
      <div className="relative">
        <select
          value={String(value ?? "")}
          onChange={e => onChange(e.target.value || null)}
          onBlur={onBlur}
          disabled={disabled || f.disabled}
          className={cn(
            "w-full rounded-lg border px-3 py-2 text-sm bg-white appearance-none pr-8",
            "border-gray-300 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20",
            "dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100",
            errors?.length && "border-red-400"
          )}
        >
          <option value="">{f.placeholder ?? "— Select —"}</option>
          {choices.map(choice => (
            <option key={String(choice.value)} value={String(choice.value)} disabled={choice.disabled}>
              {choice.label}
            </option>
          ))}
        </select>
        <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 text-xs">▾</span>
      </div>
    </FieldWrapper>
  );
}

// ─── Multiselect Field ────────────────────────────────────────────────────────
export function MultiselectFieldRenderer({ field, value, onChange, errors, disabled }: FieldProps<MultiselectField>) {
  const f = field as MultiselectField;
  const dataSources = useDataSources();
  const dynamicConfig = getDynamicConfig(f.choices, dataSources);
  const { choices: dynamicChoices, loading: dynLoading, error: dynError } = useDynamicChoices(dynamicConfig);
  const choices = dynamicConfig ? dynamicChoices : resolveStaticChoices(f.choices);
  const selected: (string | number)[] = Array.isArray(value) ? (value as (string | number)[]) : [];
  // Dynamic dropdown defaults to type-to-search dropdown; static defaults to checkboxes.
  const displayAs = f.display_as && f.display_as !== "auto"
    ? f.display_as
    : (dynamicConfig ? "dropdown" : "checkbox");

  const toggle = (v: string | number) => {
    if (selected.includes(v)) onChange(selected.filter(x => x !== v));
    else onChange([...selected, v]);
  };

  if (dynLoading) {
    return (
      <FieldWrapper label={f.label} required={f.required} hint={f.hint}
        description={f.description} errors={errors} width={f.width}>
        <div className="flex items-center gap-2 h-10 px-3 rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 text-sm text-gray-400">
          <span className="h-3.5 w-3.5 rounded-full border-2 border-gray-300 border-t-blue-500 animate-spin flex-shrink-0" />
          Loading options…
        </div>
      </FieldWrapper>
    );
  }
  if (dynError) {
    return (
      <FieldWrapper label={f.label} required={f.required} hint={f.hint}
        description={f.description} errors={[...(errors ?? []), `Could not load options: ${dynError}`]} width={f.width}>
        <div className="h-10 px-3 rounded-lg border border-red-200 bg-red-50 dark:bg-red-950/20 flex items-center text-sm text-red-500">
          ⚠ Failed to load options
        </div>
      </FieldWrapper>
    );
  }

  if (displayAs === "tag-input") {
    return (
      <FieldWrapper label={f.label} required={f.required} hint={f.hint}
        description={f.description} errors={errors} width={f.width}>
        <div className="flex flex-wrap gap-2 p-2 rounded-lg border border-gray-300 dark:border-gray-600 min-h-[42px]">
          {selected.map(v => {
            const choice = choices.find(c => c.value === v);
            return (
              <span key={String(v)} className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300">
                {choice?.label ?? String(v)}
                <button type="button" onClick={() => toggle(v)}
                  className="hover:text-red-600 ml-0.5 leading-none">×</button>
              </span>
            );
          })}
        </div>
        <div className="flex flex-wrap gap-1 mt-1">
          {choices.filter(c => !selected.includes(c.value as string)).map(choice => (
            <button key={String(choice.value)} type="button" onClick={() => toggle(choice.value as string)}
              disabled={disabled || f.max_selected != null && selected.length >= f.max_selected}
              className="px-2 py-0.5 text-xs rounded-full border border-dashed border-gray-300 hover:border-blue-400 hover:bg-blue-50 disabled:opacity-40">
              + {choice.label}
            </button>
          ))}
        </div>
      </FieldWrapper>
    );
  }

  if (displayAs === "dropdown") {
    return (
      <FieldWrapper label={f.label} required={f.required} hint={f.hint}
        description={f.description} errors={errors} width={f.width}>
        <MultiselectDropdown
          choices={choices}
          selected={selected}
          onToggle={toggle}
          disabled={disabled || f.disabled}
          maxSelected={f.max_selected}
          allowOthers={f.allow_others}
          placeholder={f.placeholder}
          hasError={!!errors?.length}
        />
      </FieldWrapper>
    );
  }

  // Default: checkboxes
  return (
    <FieldWrapper label={f.label} required={f.required} hint={f.hint}
      description={f.description} errors={errors} width={f.width}>
      <div className="flex flex-col gap-2">
        {choices.map(choice => (
          <label key={String(choice.value)} className="flex items-center gap-3 cursor-pointer p-1.5 rounded hover:bg-gray-50">
            <input
              type="checkbox"
              checked={selected.includes(choice.value as string)}
              onChange={() => toggle(choice.value as string)}
              disabled={disabled || choice.disabled ||
                (!selected.includes(choice.value as string) && f.max_selected != null && selected.length >= f.max_selected)}
              className="h-4 w-4 rounded accent-blue-600"
            />
            <span className="text-sm">{choice.label}</span>
          </label>
        ))}
      </div>
    </FieldWrapper>
  );
}

// ─── Multiselect Dropdown subcomponent (type-to-search combobox) ──────────────
interface MultiselectDropdownProps {
  choices: StaticChoice[];
  selected: (string | number)[];
  onToggle: (v: string | number) => void;
  disabled?: boolean;
  maxSelected?: number;
  allowOthers?: boolean;
  placeholder?: string;
  hasError?: boolean;
}

function MultiselectDropdown({
  choices, selected, onToggle, disabled, maxSelected, allowOthers, placeholder, hasError,
}: MultiselectDropdownProps) {
  const [query, setQuery] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const containerRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    function onDocClick(e: MouseEvent) {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, []);

  const selectedSet = new Set(selected.map(String));
  const q = query.trim().toLowerCase();
  const filtered = choices.filter(c =>
    !selectedSet.has(String(c.value)) &&
    (!q || c.label.toLowerCase().includes(q) || String(c.value).toLowerCase().includes(q))
  );
  const atMax = maxSelected != null && selected.length >= maxSelected;
  const hasExactMatch = choices.some(c =>
    c.label.toLowerCase() === q || String(c.value).toLowerCase() === q
  );
  const canAddOther = allowOthers && q.length > 0 && !hasExactMatch && !selectedSet.has(q);

  return (
    <div ref={containerRef} className="relative">
      <div
        className={cn(
          "flex flex-wrap items-center gap-1.5 px-2 py-1.5 rounded-lg border bg-white min-h-[42px] cursor-text",
          "border-gray-300 focus-within:border-blue-500 focus-within:ring-2 focus-within:ring-blue-500/20",
          "dark:border-gray-600 dark:bg-gray-800",
          hasError && "border-red-400",
          disabled && "opacity-60 cursor-not-allowed"
        )}
        onClick={() => !disabled && setOpen(true)}
      >
        {selected.map(v => {
          const choice = choices.find(c => String(c.value) === String(v));
          return (
            <span key={String(v)} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300">
              {choice?.label ?? String(v)}
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); onToggle(v); }}
                disabled={disabled}
                className="hover:text-red-600 ml-0.5 leading-none"
                aria-label={`Remove ${choice?.label ?? v}`}
              >×</button>
            </span>
          );
        })}
        <input
          type="text"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === "Backspace" && query === "" && selected.length > 0) {
              onToggle(selected[selected.length - 1]);
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (filtered.length > 0 && !atMax) {
                onToggle(filtered[0].value as string);
                setQuery("");
              } else if (canAddOther && !atMax) {
                onToggle(query.trim());
                setQuery("");
              }
            } else if (e.key === "Escape") {
              setOpen(false);
            }
          }}
          disabled={disabled || atMax}
          placeholder={selected.length === 0 ? (placeholder ?? "Type to search…") : ""}
          className="flex-1 min-w-[8ch] bg-transparent outline-none text-sm placeholder:text-gray-400 dark:text-gray-100"
        />
        <span className="pointer-events-none text-gray-400 text-xs">▾</span>
      </div>

      {open && !disabled && (
        <div className="absolute z-10 mt-1 w-full max-h-60 overflow-auto rounded-lg border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 shadow-lg">
          {atMax && (
            <div className="px-3 py-2 text-xs text-amber-600">Maximum {maxSelected} selected.</div>
          )}
          {!atMax && filtered.length === 0 && !canAddOther && (
            <div className="px-3 py-2 text-sm text-gray-400">
              {q ? "No matches" : selected.length === choices.length ? "All selected" : "Start typing…"}
            </div>
          )}
          {!atMax && filtered.map(choice => (
            <button
              key={String(choice.value)}
              type="button"
              disabled={choice.disabled}
              onClick={() => { onToggle(choice.value as string); setQuery(""); }}
              className={cn(
                "w-full text-left px-3 py-2 text-sm hover:bg-blue-50 dark:hover:bg-blue-900/20 flex items-center justify-between gap-2",
                choice.disabled && "opacity-40 cursor-not-allowed"
              )}
            >
              <span>{choice.label}</span>
              {choice.group && (
                <span className="text-[10px] uppercase tracking-wider text-gray-400">{choice.group}</span>
              )}
            </button>
          ))}
          {!atMax && canAddOther && (
            <button
              type="button"
              onClick={() => { onToggle(query.trim()); setQuery(""); }}
              className="w-full text-left px-3 py-2 text-sm text-blue-700 hover:bg-blue-50 border-t border-gray-100 dark:border-gray-700"
            >
              + Add "{query.trim()}"
            </button>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Date Field ───────────────────────────────────────────────────────────────
export function DateFieldRenderer({ field, value, onChange, onBlur, errors, disabled }: FieldProps<DateField>) {
  const f = field as DateField;
  return (
    <FieldWrapper label={f.label} required={f.required} hint={f.hint}
      description={f.description} errors={errors} width={f.width}>
      <input
        type="date"
        value={String(value ?? "")}
        onChange={e => onChange(e.target.value || null)}
        onBlur={onBlur}
        min={f.min_date?.startsWith("today") ? undefined : f.min_date}
        max={f.max_date?.startsWith("today") ? undefined : f.max_date}
        disabled={disabled || f.disabled}
        readOnly={f.readonly}
        className={cn(
          "w-full rounded-lg border px-3 py-2 text-sm",
          "border-gray-300 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20",
          "dark:border-gray-600 dark:bg-gray-800 dark:text-gray-100",
          errors?.length && "border-red-400"
        )}
      />
    </FieldWrapper>
  );
}

// ─── Rating Field ─────────────────────────────────────────────────────────────
export function RatingFieldRenderer({ field, value, onChange, errors, disabled }: FieldProps<RatingField>) {
  const f = field as RatingField;
  const max = f.max ?? 5;
  const current = Number(value ?? 0);
  const displayAs = f.display_as ?? "stars";

  if (displayAs === "numeric-scale") {
    return (
      <FieldWrapper label={f.label} required={f.required} hint={f.hint}
        description={f.description} errors={errors} width={f.width}>
        <div className="flex flex-col gap-2">
          <div className="flex gap-1">
            {Array.from({ length: max }, (_, i) => i + 1).map(n => (
              <button key={n} type="button"
                onClick={() => !disabled && onChange(n)}
                className={cn(
                  "h-9 w-9 rounded-lg border text-sm font-medium transition-all",
                  current === n
                    ? "bg-blue-600 border-blue-600 text-white"
                    : "border-gray-300 hover:border-blue-400 hover:bg-blue-50"
                )}>
                {n}
              </button>
            ))}
          </div>
          <div className="flex justify-between text-xs text-gray-400">
            <span>{f.low_label ?? "Poor"}</span>
            <span>{f.high_label ?? "Excellent"}</span>
          </div>
        </div>
      </FieldWrapper>
    );
  }

  const emojis = ["😢", "😕", "😐", "🙂", "😄"];
  if (displayAs === "emoji-scale") {
    return (
      <FieldWrapper label={f.label} required={f.required} hint={f.hint}
        description={f.description} errors={errors} width={f.width}>
        <div className="flex gap-2">
          {Array.from({ length: max }, (_, i) => i + 1).map(n => (
            <button key={n} type="button" onClick={() => !disabled && onChange(n)}
              className={cn(
                "text-3xl transition-all",
                current === n ? "scale-125" : "opacity-50 hover:opacity-80"
              )}>
              {emojis[Math.floor((n - 1) * emojis.length / max)]}
            </button>
          ))}
        </div>
      </FieldWrapper>
    );
  }

  // Stars
  return (
    <FieldWrapper label={f.label} required={f.required} hint={f.hint}
      description={f.description} errors={errors} width={f.width}>
      <div className="flex gap-1">
        {Array.from({ length: max }, (_, i) => i + 1).map(n => (
          <button key={n} type="button" onClick={() => !disabled && onChange(n)}
            className={cn("text-2xl transition-all", disabled && "cursor-not-allowed")}>
            <span className={n <= current ? "text-yellow-400" : "text-gray-300"}>★</span>
          </button>
        ))}
      </div>
    </FieldWrapper>
  );
}

// ─── File Field ───────────────────────────────────────────────────────────────
export function FileFieldRenderer({ field, value, onChange, errors, disabled }: FieldProps<FileField>) {
  const f = field as FileField;
  const files: File[] = Array.isArray(value) ? (value as File[]) : [];

  return (
    <FieldWrapper label={f.label} required={f.required} hint={f.hint}
      description={f.description} errors={errors} width={f.width}>
      <label className={cn(
        "flex flex-col items-center justify-center gap-2 p-6 rounded-lg border-2 border-dashed cursor-pointer transition-colors",
        "border-gray-300 hover:border-blue-400 hover:bg-blue-50/50",
        (disabled || f.disabled) && "opacity-50 cursor-not-allowed"
      )}>
        <span className="text-2xl">📎</span>
        <span className="text-sm text-gray-600">
          {files.length > 0
            ? files.map(f => f.name).join(", ")
            : `Drop files or click to upload`}
        </span>
        {f.accept && <span className="text-xs text-gray-400">{f.accept}</span>}
        {f.max_size_mb && <span className="text-xs text-gray-400">Max {f.max_size_mb}MB</span>}
        <input
          type="file"
          className="sr-only"
          accept={f.accept}
          multiple={f.max_files != null && f.max_files > 1}
          disabled={disabled || f.disabled}
          onChange={e => {
            const list = Array.from(e.target.files ?? []);
            onChange(f.max_files === 1 ? list[0] : list);
          }}
        />
      </label>
    </FieldWrapper>
  );
}

// ─── Color Field ──────────────────────────────────────────────────────────────
export function ColorFieldRenderer({ field, value, onChange, errors, disabled }: FieldProps<any>) {
  const f = field;
  return (
    <FieldWrapper label={f.label} required={f.required} hint={f.hint}
      description={f.description} errors={errors} width={f.width}>
      <div className="flex items-center gap-3">
        <input
          type="color"
          value={String(value ?? "#000000")}
          onChange={e => onChange(e.target.value)}
          disabled={disabled || f.disabled}
          className="h-10 w-16 rounded border border-gray-300 cursor-pointer"
        />
        <span className="text-sm font-mono text-gray-600">{String(value ?? "#000000")}</span>
        {f.presets?.length > 0 && (
          <div className="flex gap-1">
            {f.presets.map((p: string) => (
              <button key={p} type="button" onClick={() => onChange(p)}
                className="h-6 w-6 rounded-full border-2 border-white shadow"
                style={{ backgroundColor: p }} title={p} />
            ))}
          </div>
        )}
      </div>
    </FieldWrapper>
  );
}
