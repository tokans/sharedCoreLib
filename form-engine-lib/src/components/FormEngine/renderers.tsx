"use client";

import React, { useEffect, useState } from "react";
import type { FormManifest, FormDef, FormField, FieldAnswers, FormContext } from "../../libs/types";
import { useFormEngineStore } from "../../store/form-engine-store";
import {
  TextFieldRenderer, MultilineFieldRenderer, BooleanFieldRenderer,
  NumberFieldRenderer, SelectFieldRenderer, MultiselectFieldRenderer,
  DateFieldRenderer, RatingFieldRenderer, FileFieldRenderer, ColorFieldRenderer,
  FieldWrapper
} from "./fields/FieldRenderers";
import { WizardLayout } from "./layouts/WizardLayout";
import { SinglePageLayout } from "./layouts/SinglePageLayout";

interface FormEngineProps {
  manifest: FormManifest;
  formId: string;
  initialAnswers?: FieldAnswers;
  context?: FormContext;
  /**
   * Called after the form is validated and the user submits.
   * The library passes the filtered payload — send it to your backend here.
   * Throw an Error to surface a message to the user.
   */
  onSubmit?: (payload: FieldAnswers) => Promise<void> | void;
  /**
   * Called when the user saves a draft.
   * Persisting the draft is entirely the app's responsibility.
   */
  onDraftSave?: (answers: FieldAnswers) => Promise<void> | void;
  readOnly?: boolean;
  /**
   * Controls the built-in success screen shown after a successful submit.
   * Precedence: this prop (if provided) → the form's `show_success_screen`
   * flag in the manifest → defaults to `true`.
   *
   * Set to `false` for signin/signup forms: the submit waits for the server
   * response and the form stays mounted, letting your onSubmit handler drive
   * the outcome (e.g. redirect on success, surface an error on failure)
   * instead of flashing a "submitted!" screen.
   */
  showSuccessScreen?: boolean;
}

export function FormEngine({
  manifest, formId, initialAnswers, context, onSubmit, onDraftSave, readOnly, showSuccessScreen
}: FormEngineProps) {
  const { init, form, submitted } = useFormEngineStore();

  // Holds the last submit error so the form can display it in-place.
  // We deliberately do NOT throw — throwing bypasses this component and
  // surfaces in the Next.js dev overlay (or swallows silently in prod).
  const [submitError, setSubmitError] = React.useState<string | null>(null);

  useEffect(() => {
    init(manifest, formId, initialAnswers, context);
    // initialAnswers is intentionally excluded from the dep array:
    // re-initialising on every parent render would reset in-progress answers.
    // If callers need to change initialAnswers, they should also change formId.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifest?.manifest_id, formId]);

  // Clear the error banner whenever the user switches form
  useEffect(() => { setSubmitError(null); }, [formId]);

  if (!form) return (
    <div className="flex items-center justify-center p-12 text-gray-400">
      Form "{formId}" not found in manifest.
    </div>
  );

  // Resolve whether the built-in success screen is allowed.
  // Precedence: explicit prop → manifest form flag → default true.
  const successScreenEnabled =
    showSuccessScreen ?? form.show_success_screen ?? true;

  // Only show success when enabled AND there is NO submit error.
  // If onSubmit threw, `submitted` may have been set by the store already,
  // so we gate on submitError being null as well.
  if (successScreenEnabled && submitted && !submitError) {
    const msg = form.on_submit?.success_message ?? "Form submitted successfully!";
    return (
      <div className="flex flex-col items-center justify-center gap-4 py-16 text-center">
        <div className="text-5xl">🎉</div>
        <h2 className="text-xl font-semibold text-gray-800 dark:text-gray-100">{msg}</h2>
        <button onClick={() => useFormEngineStore.getState().reset()}
          className="mt-2 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm hover:bg-blue-700">
          Submit Another Response
        </button>
      </div>
    );
  }

  /**
   * Wraps the caller's onSubmit so that:
   *  • A thrown Error is caught, stored in state, and re-thrown so the layout
   *    knows not to advance / mark submitted.
   *  • On success the error banner is cleared.
   *
   * Re-throwing is intentional: the layouts use the rejection to avoid calling
   * the store's markSubmitted action. We only suppress it from reaching
   * Next.js's global handler — the layouts' own try/catch handles it locally.
   */
  const wrappedOnSubmit = onSubmit
    ? async (payload: FieldAnswers) => {
        setSubmitError(null);
        try {
          await onSubmit(payload);
          // success — banner stays clear, success screen will render
        } catch (err: unknown) {
          const msg =
            err instanceof Error
              ? err.message
              : typeof err === "string"
              ? err
              : "Submission failed. Please try again.";
          setSubmitError(msg);
          // No re-throw needed: the `submitted && !submitError` gate above
          // blocks the success screen even if the layout calls markSubmitted().
          // Both setSubmitError and the store update are queued before the next
          // render, so React sees them together and the gate holds.
        }
      }
    : undefined;

  const errorBanner = submitError ? (
    <div
      role="alert"
      className="mb-4 flex items-start gap-2.5 rounded-xl px-4 py-3 text-sm"
      style={{
        background: "rgba(239,68,68,.07)",
        border: "1px solid rgba(239,68,68,.22)",
        color: "#dc2626",
      }}
    >
      <span className="flex-shrink-0 mt-0.5">⚠️</span>
      <span className="font-medium leading-snug">{submitError}</span>
    </div>
  ) : null;

  if (form.layout.type === "wizard" && form.pages?.length) {
    return (
      <>
        {errorBanner}
        <WizardLayout manifest={manifest} form={form} formId={formId}
          onSubmit={wrappedOnSubmit} onDraftSave={onDraftSave} readOnly={readOnly} />
      </>
    );
  }

  return (
    <>
      {errorBanner}
      <SinglePageLayout manifest={manifest} form={form} formId={formId}
        onSubmit={wrappedOnSubmit} onDraftSave={onDraftSave} readOnly={readOnly} />
    </>
  );
}

// ─── Universal Field Router ───────────────────────────────────────────────────
interface FieldRouterProps {
  field: FormField;
  disabled?: boolean;
}

export function FieldRouter({ field, disabled }: FieldRouterProps) {
  const { answers, setAnswer, touchField, getFieldError, getComputedValue } = useFormEngineStore();

  const value = field.computed ? getComputedValue(field.id) : answers[field.id];
  const errors = getFieldError(field.id);
  const isDisabled = disabled || field.disabled ||
    field.editability === "Immutable" ||
    field.editability === "Generated" ||
    field.system_generated;
  const isReadOnly = field.readonly ||
    field.editability === "MutableIfNull" && value != null;

  const handleChange = (val: unknown) => {
    setAnswer(field.id, val);
  };

  const handleBlur = () => touchField(field.id);

  const type = (field as unknown as Record<string, unknown>).type as string;

  // Computed field display
  if (field.computed) {
    return (
      <FieldWrapper label={field.label} hint={field.hint} description={field.description} width={field.width}>
        <div className="px-3 py-2 rounded-lg bg-gray-50 border border-gray-200 dark:bg-gray-800/60 dark:border-gray-700 text-sm text-gray-700 dark:text-gray-300">
          {value != null ? String(value) : <span className="text-gray-400 italic">Computing...</span>}
          <span className="ml-2 text-xs text-gray-400">auto-calculated</span>
        </div>
      </FieldWrapper>
    );
  }

  const props = { field, value, onChange: handleChange, onBlur: handleBlur, errors, disabled: isDisabled };

  switch (type) {
    case "text":         return <TextFieldRenderer {...props} field={field as any} />;
    case "multiline":    return <MultilineFieldRenderer {...props} field={field as any} />;
    case "boolean":      return <BooleanFieldRenderer {...props} field={field as any} />;
    case "number":       return <NumberFieldRenderer {...props} field={field as any} />;
    case "select":       return <SelectFieldRenderer {...props} field={field as any} />;
    case "multiselect":  return <MultiselectFieldRenderer {...props} field={field as any} />;
    case "date":         return <DateFieldRenderer {...props} field={field as any} />;
    case "datetime":     return <DateFieldRenderer {...props} field={field as any} />;
    case "daterange":    return <DateFieldRenderer {...props} field={field as any} />;
    case "rating":       return <RatingFieldRenderer {...props} field={field as any} />;
    case "file":         return <FileFieldRenderer {...props} field={field as any} />;
    case "color":        return <ColorFieldRenderer {...props} field={field as any} />;
    case "signature":
      return (
        <FieldWrapper label={field.label} required={field.required} hint={field.hint}
          description={field.description} errors={errors} width={field.width}>
          <SignaturePad value={value} onChange={handleChange} disabled={isDisabled} />
        </FieldWrapper>
      );
    case "location":
      return (
        <FieldWrapper label={field.label} required={field.required} hint={field.hint}
          description={field.description} errors={errors} width={field.width}>
          <LocationInput field={field as any} value={value} onChange={handleChange} onBlur={handleBlur} disabled={isDisabled} />
        </FieldWrapper>
      );
    case "hidden":       return null;
    case "richtext":
      return <MultilineFieldRenderer {...props} field={{ ...field, type: "multiline" } as any} />;
    case "time":
      return (
        <FieldWrapper label={field.label} required={field.required} hint={field.hint}
          description={field.description} errors={errors} width={field.width}>
          <input
            type="time"
            value={String(value ?? "")}
            onChange={e => handleChange(e.target.value || null)}
            onBlur={handleBlur}
            disabled={isDisabled}
            className="w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
          />
        </FieldWrapper>
      );
    case "json":
      return (
        <FieldWrapper label={field.label} required={field.required} hint={field.hint}
          description={field.description} errors={errors} width={field.width}>
          <JsonFieldEditor
            field={field as any}
            value={value}
            onChange={handleChange}
            onBlur={handleBlur}
            disabled={isDisabled}
          />
        </FieldWrapper>
      );
    default:
      return (
        <FieldWrapper label={field.label} width={field.width}>
          <div className="text-sm text-gray-400 italic">Unsupported field type: {type}</div>
        </FieldWrapper>
      );
  }
}


// ─── JsonFieldEditor — smart array/object/raw editor ────────────────────────
// Detects whether the stored value is an array, plain object, or primitive and
// renders the appropriate UI.  Arrays get an "Add item" button + per-item rows;
// objects get a key-value table; everything else falls back to a mono textarea.

interface JsonFieldEditorProps {
  field: { label?: string; rows?: number };
  value: unknown;
  onChange: (v: unknown) => void;
  onBlur?: () => void;
  disabled?: boolean;
}

function JsonFieldEditor({ field, value, onChange, onBlur, disabled }: JsonFieldEditorProps) {
  // Detect value shape
  const isArray  = Array.isArray(value);
  const isObject = !isArray && value !== null && typeof value === "object";
  const rows     = (field as any).rows ?? 6;

  // ── Array mode ─────────────────────────────────────────────────────────────
  if (isArray) {
    const items = value as unknown[];
    const updateItem = (idx: number, val: unknown) =>
      onChange(items.map((it, i) => i === idx ? val : it));
    const removeItem = (idx: number) =>
      onChange(items.filter((_, i) => i !== idx));
    const addItem = () =>
      onChange([...items, typeof items[0] === "object" && items[0] !== null
        ? {} : ""]);

    return (
      <div className="space-y-2">
        {items.length === 0 && (
          <p className="text-xs text-gray-400 italic py-2 text-center">No items yet.</p>
        )}
        {items.map((item, idx) => (
          <ArrayItemRow
            key={idx}
            index={idx}
            item={item}
            disabled={disabled}
            onChange={v => updateItem(idx, v)}
            onRemove={() => removeItem(idx)}
          />
        ))}
        {!disabled && (
          <button
            type="button"
            onClick={addItem}
            onBlur={onBlur}
            className="w-full flex items-center justify-center gap-2 rounded-xl border-2 border-dashed border-gray-300 dark:border-gray-600 px-4 py-2.5 text-sm font-medium text-gray-500 hover:border-blue-400 hover:text-blue-600 transition-colors">
            <span className="text-base leading-none">+</span>
            Add item
          </button>
        )}
      </div>
    );
  }

  // ── Object mode ────────────────────────────────────────────────────────────
  if (isObject) {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    const updateKey = (k: string, v: unknown) => onChange({ ...obj, [k]: v });
    const removeKey = (k: string) => {
      const next = { ...obj };
      delete next[k];
      onChange(next);
    };
    const addKey = () => {
      const newKey = `key_${keys.length + 1}`;
      onChange({ ...obj, [newKey]: "" });
    };

    return (
      <div className="space-y-1.5">
        {keys.map(k => (
          <div key={k} className="flex gap-1.5 items-center">
            <span className="text-xs font-mono text-gray-500 w-28 flex-shrink-0 truncate" title={k}>{k}</span>
            <input
              value={String(obj[k] ?? "")}
              disabled={disabled}
              onChange={e => updateKey(k, e.target.value)}
              onBlur={onBlur}
              className="flex-1 rounded-md border border-gray-200 dark:border-gray-700 px-2 py-1 text-xs bg-white dark:bg-gray-800 focus:border-blue-400 focus:outline-none"
            />
            {!disabled && (
              <button type="button" onClick={() => removeKey(k)}
                className="text-gray-300 hover:text-red-500 text-xs px-1">✕</button>
            )}
          </div>
        ))}
        {!disabled && (
          <button type="button" onClick={addKey} onBlur={onBlur}
            className="text-xs text-blue-600 hover:underline mt-1">+ Add field</button>
        )}
      </div>
    );
  }

  // ── Fallback: raw mono textarea ─────────────────────────────────────────────
  return (
    <textarea
      value={typeof value === "string" ? value : JSON.stringify(value ?? {}, null, 2)}
      onChange={e => {
        try { onChange(JSON.parse(e.target.value)); }
        catch { onChange(e.target.value); }
      }}
      onBlur={onBlur}
      disabled={disabled}
      rows={rows}
      placeholder="{}"
      className="w-full rounded-lg border border-gray-300 dark:border-gray-700 px-3 py-2 text-xs font-mono focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 bg-white dark:bg-gray-800"
    />
  );
}

// ─── Array item row ───────────────────────────────────────────────────────────
function ArrayItemRow({ index, item, onChange, onRemove, disabled }: {
  index: number; item: unknown;
  onChange: (v: unknown) => void; onRemove: () => void; disabled?: boolean;
}) {
  const [expanded, setExpanded] = useState(true);

  if (item !== null && typeof item === "object" && !Array.isArray(item)) {
    const obj = item as Record<string, unknown>;
    const keys = Object.keys(obj);
    return (
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
        {/* row header */}
        <div
          className="flex items-center gap-2 px-3 py-2 bg-gray-50 dark:bg-gray-800/60 cursor-pointer select-none"
          onClick={() => setExpanded(e => !e)}>
          <span className={`text-gray-400 text-xs transition-transform ${expanded ? "rotate-90" : ""}`}>▶</span>
          <span className="flex-1 text-xs font-medium text-gray-600 dark:text-gray-300">
            Item {index + 1}
            {keys.length > 0 && (
              <span className="ml-2 text-gray-400 font-normal">
                {keys.slice(0, 2).map(k => `${k}: ${String(obj[k] ?? "").slice(0,16)}`).join(" · ")}
                {keys.length > 2 ? ` · +${keys.length - 2} more` : ""}
              </span>
            )}
          </span>
          {!disabled && (
            <button type="button" onClick={e => { e.stopPropagation(); onRemove(); }}
              className="text-xs text-red-400 hover:text-red-600 px-2 py-0.5 rounded hover:bg-red-50 transition-colors">
              Remove
            </button>
          )}
        </div>

        {expanded && (
          <div className="p-3 space-y-2">
            {keys.map(k => (
              <div key={k} className="flex gap-2 items-center">
                <label className="text-xs font-medium text-gray-500 w-24 flex-shrink-0 truncate capitalize" title={k}>
                  {k.replace(/_/g, " ")}
                </label>
                {typeof obj[k] === "boolean" ? (
                  <button type="button" disabled={disabled}
                    onClick={() => onChange({ ...obj, [k]: !obj[k] })}
                    className={`relative inline-flex h-5 w-9 rounded-full transition-colors flex-shrink-0 ${obj[k] ? "bg-blue-600" : "bg-gray-300"}`}>
                    <span className={`inline-block h-3 w-3 mt-1 rounded-full bg-white transition-transform ${obj[k] ? "translate-x-5" : "translate-x-1"}`} />
                  </button>
                ) : (
                  <input
                    value={String(obj[k] ?? "")}
                    disabled={disabled}
                    onChange={e => onChange({ ...obj, [k]: e.target.value })}
                    className="flex-1 rounded-md border border-gray-200 dark:border-gray-700 px-2 py-1 text-xs bg-white dark:bg-gray-800 focus:border-blue-400 focus:outline-none"
                  />
                )}
              </div>
            ))}
            {!disabled && keys.length === 0 && (
              <p className="text-xs text-gray-400 italic">Empty object — add keys above.</p>
            )}
          </div>
        )}
      </div>
    );
  }

  // Primitive item
  return (
    <div className="flex gap-1.5 items-center">
      <span className="text-xs text-gray-400 w-6 text-right flex-shrink-0">{index + 1}.</span>
      <input
        value={String(item ?? "")}
        disabled={disabled}
        onChange={e => onChange(e.target.value)}
        className="flex-1 rounded-md border border-gray-200 dark:border-gray-700 px-2 py-1.5 text-xs bg-white dark:bg-gray-800 focus:border-blue-400 focus:outline-none"
        placeholder="value"
      />
      {!disabled && (
        <button type="button" onClick={onRemove}
          className="text-gray-300 hover:text-red-500 text-xs px-1">✕</button>
      )}
    </div>
  );
}

// ─── Signature pad (canvas, no external dependency) ──────────────────────────
// Stores the drawn signature as a PNG data-URL string. Pointer coordinates are
// scaled from the displayed size to the canvas backing store so the stroke
// lands under the cursor regardless of CSS width.
function SignaturePad({ value, onChange, disabled }: {
  value: unknown; onChange: (v: unknown) => void; disabled?: boolean;
}) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const drawing = React.useRef(false);

  const at = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = canvasRef.current!;
    const r = c.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) * (c.width / r.width),
      y: (e.clientY - r.top) * (c.height / r.height),
    };
  };
  const start = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (disabled) return;
    drawing.current = true;
    const ctx = canvasRef.current!.getContext("2d")!;
    const { x, y } = at(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
  };
  const move = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!drawing.current || disabled) return;
    const ctx = canvasRef.current!.getContext("2d")!;
    const { x, y } = at(e);
    ctx.lineTo(x, y);
    ctx.strokeStyle = "#111827";
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    ctx.stroke();
  };
  const end = () => {
    if (!drawing.current) return;
    drawing.current = false;
    onChange(canvasRef.current!.toDataURL("image/png"));
  };
  const clear = () => {
    const c = canvasRef.current!;
    c.getContext("2d")!.clearRect(0, 0, c.width, c.height);
    onChange(null);
  };

  return (
    <div className="space-y-2">
      <canvas
        ref={canvasRef}
        width={600}
        height={160}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={end}
        onPointerLeave={end}
        className="w-full rounded-lg border border-gray-300 bg-white touch-none cursor-crosshair"
        style={{ height: 160 }}
      />
      <div className="flex items-center gap-3">
        {!disabled && (
          <button type="button" onClick={clear} className="text-xs text-gray-500 hover:text-red-500">
            Clear
          </button>
        )}
        {value
          ? <span className="text-xs text-green-600">✓ Signature captured</span>
          : <span className="text-xs text-gray-400">Sign in the box above</span>}
      </div>
    </div>
  );
}

// ─── Location input (address text and/or coordinates) ────────────────────────
// Stores { address?, lat?, lng? }. Renders inputs according to field.mode:
//   address-search → address only | coordinates → lat/lng | map-pin → both.
function LocationInput({ field, value, onChange, onBlur, disabled }: {
  field: { mode?: string };
  value: unknown;
  onChange: (v: unknown) => void;
  onBlur?: () => void;
  disabled?: boolean;
}) {
  const v = (value && typeof value === "object") ? (value as Record<string, unknown>) : {};
  const mode = field.mode ?? "address-search";
  const set = (patch: Record<string, unknown>) => onChange({ ...v, ...patch });
  const inputCls = "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20";

  return (
    <div className="space-y-2">
      {mode !== "coordinates" && (
        <input
          type="text"
          placeholder="Search address…"
          disabled={disabled}
          value={String(v.address ?? "")}
          onChange={e => set({ address: e.target.value })}
          onBlur={onBlur}
          className={inputCls}
        />
      )}
      {mode !== "address-search" && (
        <div className="grid grid-cols-2 gap-2">
          <input
            type="number" step="any" placeholder="Latitude" disabled={disabled}
            value={v.lat == null ? "" : String(v.lat)}
            onChange={e => set({ lat: e.target.value === "" ? null : parseFloat(e.target.value) })}
            onBlur={onBlur}
            className={inputCls}
          />
          <input
            type="number" step="any" placeholder="Longitude" disabled={disabled}
            value={v.lng == null ? "" : String(v.lng)}
            onChange={e => set({ lng: e.target.value === "" ? null : parseFloat(e.target.value) })}
            onBlur={onBlur}
            className={inputCls}
          />
        </div>
      )}
    </div>
  );
}
