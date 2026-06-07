/**
 * useFormEngine — convenience hook for components that want to interact
 * with the form engine store without direct Zustand imports.
 *
 * Backend connectivity is NOT handled here. Pass an `onSubmit` callback
 * to FormEngine (or set one via FormEngineProvider / configureFormEngine)
 * to wire in your own API layer.
 *
 * Usage:
 *   const { answers, setAnswer, errors, submit } = useFormEngine();
 */
import { useCallback, useEffect } from "react";
import { useFormEngineStore } from "../store/form-engine-store";
import { getConfig } from "../libs/config";
import type { FieldAnswers, FormContext, FormManifest } from "../libs/types";

// ─── Return type ──────────────────────────────────────────────────────────────

export interface SubmitResult {
  /** true if the form was valid and onSubmit resolved without throwing */
  ok: boolean;
  /** The filtered, validated payload that was passed to onSubmit */
  payload: FieldAnswers;
  /** Whatever the onSubmit handler returned (undefined if none was set) */
  data?: unknown;
  /** Error thrown by onSubmit, if any */
  error?: Error;
}

export interface UseFormEngineReturn {
  // ─── State ──────────────────────────────────────────────────────────────────
  answers: FieldAnswers;
  errors: Record<string, string[]>;
  currentPageIndex: number;
  submitting: boolean;
  submitted: boolean;

  // ─── Field interaction ───────────────────────────────────────────────────────
  setAnswer: (fieldId: string, value: unknown) => void;
  touchField: (fieldId: string) => void;
  getFieldError: (fieldId: string) => string[];

  // ─── Navigation ──────────────────────────────────────────────────────────────
  nextPage: () => boolean;
  prevPage: () => void;
  goToPage: (index: number) => void;

  // ─── Submission ──────────────────────────────────────────────────────────────
  /**
   * Validate the form and call the onSubmit handler (from config or the
   * optional `onSubmit` override argument).
   *
   * The hook never calls any backend directly — that is the caller's job.
   */
  submit: (opts?: {
    formId?: string;
    manifestId?: string;
    draft?: boolean;
    context?: FormContext;
    /** Per-call override — takes precedence over the global config.onSubmit */
    onSubmit?: (manifestId: string, formId: string, answers: FieldAnswers) => Promise<unknown>;
  }) => Promise<SubmitResult>;

  // ─── Utilities ───────────────────────────────────────────────────────────────
  reset: () => void;
  validateAll: () => boolean;
  getPayload: () => FieldAnswers;
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export function useFormEngine(): UseFormEngineReturn {
  const store = useFormEngineStore();

  const submit = useCallback(async (opts: {
    formId?: string;
    manifestId?: string;
    draft?: boolean;
    context?: FormContext;
    onSubmit?: (manifestId: string, formId: string, answers: FieldAnswers) => Promise<unknown>;
  } = {}): Promise<SubmitResult> => {
    const {
      answers, formId, manifest,
      validateAllFields, setSubmitting, setSubmitted, getSubmitPayload,
    } = useFormEngineStore.getState();

    const fid = opts.formId ?? formId ?? "";
    const mid = opts.manifestId ?? manifest?.manifest_id ?? "";

    if (!opts.draft && !validateAllFields()) {
      return { ok: false, payload: {} };
    }

    const payload = opts.draft ? answers : getSubmitPayload();

    // Resolve the submit handler: per-call override → global config → none
    const handler =
      opts.onSubmit ??
      getConfig().onSubmit;

    setSubmitting(true);
    try {
      let data: unknown;
      if (handler) {
        data = await handler(mid, fid, payload);
      }
      if (!opts.draft) setSubmitted(true);
      return { ok: true, payload, data };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error("[useFormEngine] submit error:", error);
      return { ok: false, payload, error };
    } finally {
      setSubmitting(false);
    }
  }, []);

  return {
    answers: store.answers,
    errors: store.errors,
    currentPageIndex: store.currentPageIndex,
    submitting: store.submitting,
    submitted: store.submitted,

    setAnswer: store.setAnswer,
    touchField: store.touchField,
    getFieldError: store.getFieldError,

    nextPage: store.nextPage,
    prevPage: store.prevPage,
    goToPage: store.goToPage,

    submit,
    reset: store.reset,
    validateAll: store.validateAllFields,
    getPayload: store.getSubmitPayload,
  };
}

/**
 * Initialize the form engine for a given manifest + formId.
 * Call this inside a useEffect in the component mounting the form.
 */
export function useFormEngineInit(
  manifest: FormManifest | null,
  formId: string | null,
  options?: { initialAnswers?: FieldAnswers; context?: FormContext },
) {
  const init = useFormEngineStore(s => s.init);

  // Initialise inside an effect — never during render. Calling the store's
  // `set` during render triggers React "update during render" warnings and
  // would reset in-progress answers on every parent re-render. Re-init only
  // when the form identity (manifest id + formId) changes.
  useEffect(() => {
    if (manifest && formId) {
      init(manifest, formId, options?.initialAnswers, options?.context);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [manifest?.manifest_id, formId]);

  return useFormEngineStore();
}
