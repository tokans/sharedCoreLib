import { create } from "zustand";
import { persist } from "zustand/middleware";
import type {
  FormManifest, FormDef, FieldAnswers, FormErrors,
  FormContext, Page, Section, FormField, ConditionOrRef,
} from "../libs/types";
import { evaluateCondition, evaluateComputed, validateField } from "../libs/condition-evaluator";

interface FormEngineState {
  manifest: FormManifest | null;
  formId: string | null;
  form: FormDef | null;
  answers: FieldAnswers;
  errors: FormErrors;
  touched: Set<string>;
  currentPageIndex: number;
  submitting: boolean;
  submitted: boolean;
  context: FormContext;

  init: (manifest: FormManifest, formId: string, initialAnswers?: FieldAnswers, context?: FormContext) => void;
  setAnswer: (fieldId: string, value: unknown) => void;
  setAnswers: (answers: FieldAnswers) => void;
  touchField: (fieldId: string) => void;
  validateAllFields: () => boolean;
  validatePage: (pageIndex: number) => boolean;
  nextPage: () => boolean;
  prevPage: () => void;
  goToPage: (index: number) => void;
  setSubmitting: (v: boolean) => void;
  setSubmitted: (v: boolean) => void;
  reset: () => void;

  getVisiblePages: () => Page[];
  getVisibleSections: (sections: Section[]) => Section[];
  getVisibleFields: (fields: FormField[]) => FormField[];
  isPageValid: (pageIndex: number) => boolean;
  getFieldError: (fieldId: string) => string[];
  getComputedValue: (fieldId: string) => unknown;
  getSubmitPayload: () => FieldAnswers;
}

export const useFormEngineStore = create<FormEngineState>()(
  persist(
    (set, get) => ({
      manifest: null,
      formId: null,
      form: null,
      answers: {},
      errors: {},
      touched: new Set(),
      currentPageIndex: 0,
      submitting: false,
      submitted: false,
      context: {},

      init: (manifest, formId, initialAnswers = {}, context = {}) => {
        const form = manifest?.forms?.[formId] ?? null;
        const answers = { ...initialAnswers };
        if (form) {
          const allFields = collectAllFields(form);
          for (const field of allFields) {
            if (field.id in answers) continue;
            if (field.default !== undefined) answers[field.id] = field.default;
            const f = field as unknown as Record<string, unknown>;
            if (f.use_current) {
              if (f.type === "date") answers[field.id] = new Date().toISOString().split("T")[0];
              if (f.type === "datetime") answers[field.id] = new Date().toISOString();
            }
          }
        }
        set({ manifest, formId, form, answers, errors: {}, touched: new Set(), currentPageIndex: 0, context, submitted: false });
      },

      setAnswer: (fieldId, value) => {
        set(state => {
          const newAnswers = { ...state.answers, [fieldId]: value };
          const computed = recomputeFields(state.form, newAnswers, state.context);
          const merged = { ...newAnswers, ...computed };
          const newErrors = { ...state.errors };
          delete newErrors[fieldId];
          return { answers: merged, errors: newErrors };
        });
      },

      setAnswers: (answers) => set(state => {
        const computed = recomputeFields(state.form, answers, state.context);
        return { answers: { ...answers, ...computed } };
      }),

      touchField: (fieldId) => set(state => {
        const touched = new Set(state.touched);
        touched.add(fieldId);
        const field = findField(state.form, fieldId);
        const errors = { ...state.errors };
        if (field) {
          const errs = validateField(field, state.answers[fieldId], state.answers);
          if (errs.length > 0) errors[fieldId] = errs;
          else delete errors[fieldId];
        }
        return { touched, errors };
      }),

      validateAllFields: () => {
        const { form, answers, manifest } = get();
        if (!form) return true;
        const namedConds = manifest?.conditions ?? {};
        const errors: FormErrors = {};
        const allFields = collectAllFields(form);
        for (const field of allFields) {
          if (field.condition && !evaluateCondition(field.condition, answers, namedConds)) continue;
          if (field.ui_only || field.system_generated) continue;
          const errs = validateField(field, answers[field.id], answers);
          if (errs.length > 0) errors[field.id] = errs;
        }
        set({ errors });
        return Object.keys(errors).length === 0;
      },

      validatePage: (pageIndex) => {
        const { form, answers, manifest } = get();
        if (!form || !form.pages) return true;
        const namedConds = manifest?.conditions ?? {};
        const pages = getVisiblePagesFromForm(form, answers, namedConds);
        const page = pages[pageIndex];
        if (!page) return true;
        const errors: FormErrors = {};
        for (const section of page.sections) {
          if (section.condition && !evaluateCondition(section.condition, answers, namedConds)) continue;
          for (const field of (section.fields ?? [])) {
            if (field.condition && !evaluateCondition(field.condition, answers, namedConds)) continue;
            if (field.ui_only || field.system_generated) continue;
            const errs = validateField(field, answers[field.id], answers);
            if (errs.length > 0) errors[field.id] = errs;
          }
        }
        set(state => ({ errors: { ...state.errors, ...errors } }));
        return Object.keys(errors).length === 0;
      },

      nextPage: () => {
        const { currentPageIndex, validatePage } = get();
        const valid = validatePage(currentPageIndex);
        if (!valid) return false;
        const { form, answers, manifest } = get();
        if (!form?.pages) return true;
        const pages = getVisiblePagesFromForm(form, answers, manifest?.conditions ?? {});
        if (currentPageIndex < pages.length - 1) {
          set({ currentPageIndex: currentPageIndex + 1 });
        }
        return true;
      },

      prevPage: () => set(state => ({ currentPageIndex: Math.max(0, state.currentPageIndex - 1) })),
      goToPage: (index) => set({ currentPageIndex: index }),
      setSubmitting: (v) => set({ submitting: v }),
      setSubmitted: (v) => set({ submitted: v }),

      reset: () => set({
        answers: {},
        errors: {},
        touched: new Set(),
        currentPageIndex: 0,
        submitting: false,
        submitted: false,
      }),

      getVisiblePages: () => {
        const { form, answers, manifest } = get();
        if (!form?.pages) return [];
        return getVisiblePagesFromForm(form, answers, manifest?.conditions ?? {});
      },

      getVisibleSections: (sections) => {
        const { answers, manifest } = get();
        return sections.filter(s =>
          !s.condition || evaluateCondition(s.condition, answers, manifest?.conditions ?? {})
        );
      },

      getVisibleFields: (fields) => {
        const { answers, manifest } = get();
        return fields.filter(f =>
          !f.condition || evaluateCondition(f.condition, answers, manifest?.conditions ?? {})
        );
      },

      isPageValid: (pageIndex) => {
        const { form, answers, manifest, errors } = get();
        if (!form?.pages) return true;
        const pages = getVisiblePagesFromForm(form, answers, manifest?.conditions ?? {});
        const page = pages[pageIndex];
        if (!page) return true;
        return !page.sections.some(s =>
          (s.fields ?? []).some(f => (errors[f.id]?.length ?? 0) > 0)
        );
      },

      getFieldError: (fieldId) => get().errors[fieldId] ?? [],

      getComputedValue: (fieldId) => {
        const { form, answers, context } = get();
        if (!form) return undefined;
        const field = findField(form, fieldId);
        if (!field?.computed) return undefined;
        return evaluateComputed(field.computed.expression, answers, context);
      },

      getSubmitPayload: () => {
        const { form, answers, manifest } = get();
        if (!form) return answers;
        const namedConds = manifest?.conditions ?? {};
        const payload: FieldAnswers = {};
        const sections = form.pages
          ? form.pages.flatMap(p => {
              if (p.condition && !evaluateCondition(p.condition, answers, namedConds)) return [];
              return p.sections;
            })
          : (form.sections ?? []);
        for (const section of sections) {
          if (section.condition && !evaluateCondition(section.condition, answers, namedConds)) continue;
          for (const field of (section.fields ?? [])) {
            if (field.condition && !evaluateCondition(field.condition, answers, namedConds)) continue;
            if (field.ui_only || field.system_generated) continue;
            if (field.id in answers) payload[field.id] = answers[field.id];
          }
        }
        return payload;
      },
    }),
    {
      name: "form-engine-draft",
      partialize: (state) => ({
        answers: state.answers,
        currentPageIndex: state.currentPageIndex,
        formId: state.formId,
      }),
    }
  )
);

// ─── Helpers ──────────────────────────────────────────────────────────────────
function collectAllFields(form: FormDef): FormField[] {
  const sections = form.pages
    ? form.pages.flatMap(p => p.sections)
    : (form.sections ?? []);
  return sections.flatMap(s => s.fields ?? []);
}

function findField(form: FormDef | null, fieldId: string): FormField | undefined {
  if (!form) return undefined;
  return collectAllFields(form).find(f => f.id === fieldId);
}

function getVisiblePagesFromForm(
  form: FormDef,
  answers: FieldAnswers,
  namedConds: Record<string, unknown>
): Page[] {
  return (form.pages ?? []).filter(p =>
    !p.condition || evaluateCondition(p.condition as ConditionOrRef, answers, namedConds as never)
  );
}

function recomputeFields(form: FormDef | null, answers: FieldAnswers, context: FormContext): FieldAnswers {
  if (!form) return {};
  const computed: FieldAnswers = {};
  for (const field of collectAllFields(form)) {
    if (field.computed) {
      computed[field.id] = evaluateComputed(field.computed.expression, answers, context);
    }
  }
  return computed;
}
