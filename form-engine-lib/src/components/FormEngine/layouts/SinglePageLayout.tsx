"use client";

import React, { useState } from "react";
import type { FormManifest, FormDef, FieldAnswers, Section } from "../../../libs/types";
import { useFormEngineStore } from "../../../store/form-engine-store";
import { getConfig } from "../../../libs/config";
import { FieldRouter } from "../index";
import { CollectionRenderer, ProFieldsSection } from "../CollectionRenderer";
import { cn } from "../../../libs/utils";

/**
 * Validates that all sections have unique, non-null identifiers for React keys
 * @throws Error with helpful YAML fix suggestions if validation fails
 */
function validateSectionKeys(sections: Section[]): void {
  const usedKeys = new Set<string>();
  const errors: string[] = [];

  sections.forEach((section, index) => {
    const sectionKey = section.id ?? section.title;

    if (!sectionKey) {
      errors.push(
        `Section at index ${index} is missing both 'id' and 'title'. ` +
        `Add one of these to your YAML:\n` +
        `  - id: "unique-section-id"  # or\n` +
        `  - title: "Section Title"`
      );
      return;
    }

    if (usedKeys.has(sectionKey)) {
      errors.push(
        `Duplicate section identifier "${sectionKey}" at index ${index}. ` +
        `Each section must have a unique 'id' or 'title'. ` +
        `Add a unique 'id' field or change the 'title' in your YAML.`
      );
    }
    usedKeys.add(sectionKey);
  });

  if (errors.length > 0) {
    throw new Error(
      "Invalid section configuration in form YAML:\n\n" +
      errors.join("\n\n") +
      "\n\nFix your form's sections configuration and reload."
    );
  }
}

/**
 * Validates that all fields have unique, non-null identifiers for React keys
 * @throws Error with helpful YAML fix suggestions if validation fails
 */
function validateFieldKeys(fields: any[], sectionId?: string): void {
  const usedKeys = new Set<string>();
  const errors: string[] = [];
  const sectionRef = sectionId ? ` in section "${sectionId}"` : "";

  fields.forEach((field, index) => {
    const fieldKey = field.id;

    if (!fieldKey) {
      errors.push(
        `Field at index ${index}${sectionRef} is missing 'id'. ` +
        `Add to your YAML:\n` +
        `  - id: "field-unique-id"  # Required for all fields`
      );
      return;
    }

    if (usedKeys.has(fieldKey)) {
      errors.push(
        `Duplicate field identifier "${fieldKey}" at index ${index}${sectionRef}. ` +
        `Each field must have a unique 'id'. ` +
        `Update the 'id' in your YAML.`
      );
    }
    usedKeys.add(fieldKey);
  });

  if (errors.length > 0) {
    throw new Error(
      `Invalid field configuration${sectionRef} in form YAML:\n\n` +
      errors.join("\n\n") +
      "\n\nFix your form's fields configuration and reload."
    );
  }
}

interface LayoutProps {
  manifest: FormManifest;
  form: FormDef;
  formId: string;
  /**
   * Called after a successful submit.
   * The library never calls a backend — this is the app's entry point for
   * sending data. Throw to surface an error to the user.
   */
  onSubmit?: (payload: FieldAnswers) => Promise<void> | void;
  /**
   * Called when the user clicks "Save Draft".
   * Persisting the draft is entirely the app's responsibility.
   */
  onDraftSave?: (answers: FieldAnswers) => Promise<void> | void;
  readOnly?: boolean;
}

export function SinglePageLayout({ manifest, form, formId, onSubmit, onDraftSave, readOnly }: LayoutProps) {
  const {
    getVisibleSections, setSubmitting, setSubmitted, submitting, validateAllFields, errors
  } = useFormEngineStore();

  const [submitError, setSubmitError] = useState<string | null>(null);
  const [validationError, setValidationError] = useState<string | null>(null);

  // Single-page forms may store their fields either at form.sections (flat)
  // or nested inside form.pages[].sections (YAML-canonical structure).
  const rawSections =
    (form.sections?.length ?? 0) > 0
      ? (form.sections ?? [])
      : (form.pages?.flatMap(p => p.sections ?? []) ?? []);

  const sections = getVisibleSections(rawSections);

  React.useEffect(() => {
    try {
      validateSectionKeys(sections);
      setValidationError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid section configuration";
      setValidationError(message);
    }
  }, [sections]);

  const totalErrors = Object.values(errors).flat().length;

  const submitLabel = form.submit_button?.label ?? form.submit_label ?? "Submit";
  const loadingLabel = form.submit_button?.loading_label ?? "Submitting…";

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (validationError) {
      setSubmitError("Cannot submit: Fix the form configuration errors above");
      return;
    }
    setSubmitError(null);
    if (!validateAllFields()) return;
    setSubmitting(true);
    try {
      const payload = useFormEngineStore.getState().getSubmitPayload();

      // Resolve handler: per-form prop → global config → mark submitted locally
      const handler =
        onSubmit ??
        (getConfig().onSubmit
          ? (p: FieldAnswers) =>
              getConfig().onSubmit!(manifest.manifest_id ?? "", formId, p)
          : null);

      if (handler) {
        await handler(payload);
      }
      setSubmitted(true);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Submission failed. Please try again.";
      setSubmitError(message);
      console.error("Submission error:", err);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDraftSave = async () => {
    const answers = useFormEngineStore.getState().answers;

    // Per-form prop takes precedence over global config
    const handler =
      onDraftSave ??
      (getConfig().onDraftSave
        ? (a: FieldAnswers) =>
            getConfig().onDraftSave!(manifest.manifest_id ?? "", formId, a)
        : null);

    if (handler) {
      try {
        await handler(answers);
      } catch { /* surface errors via onDraftSave caller; silent here */ }
    }
  };

  return (
    <form onSubmit={handleSubmit} noValidate className="space-y-6">
      {/* Validation error — shown for malformed YAML configurations */}
      {validationError && (
        <div className="flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
          <span className="mt-0.5 flex-shrink-0 text-lg">⚠️</span>
          <div className="flex-1">
            <p className="font-semibold mb-1">Form Configuration Error</p>
            <pre className="text-xs bg-white dark:bg-gray-900 rounded px-2 py-1 overflow-auto whitespace-pre-wrap font-mono border border-amber-100 dark:border-amber-900/50">
              {validationError}
            </pre>
          </div>
        </div>
      )}

      {!validationError && sections.map((section, index) => (
        <SectionCard key={section.id ?? section.title ?? `section-${index}`} section={section} />
      ))}

      {/* Inline submit error */}
      {submitError && (
        <div className="flex items-start gap-2.5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-400">
          <span className="mt-0.5 flex-shrink-0 text-red-500">⚠</span>
          <span>{submitError}</span>
        </div>
      )}

      <div className="flex items-center justify-between pt-4 border-t border-gray-200 dark:border-gray-700">
        {totalErrors > 0 && (
          <p className="text-sm text-red-500 font-medium">
            ⚠ {totalErrors} error{totalErrors !== 1 ? "s" : ""} – please review above
          </p>
        )}
        <div className="flex gap-3 ml-auto">
          {/* Only show draft button when a handler is wired up */}
          {(onDraftSave ?? getConfig().onDraftSave) && (
            <button
              type="button"
              onClick={handleDraftSave}
              className="px-4 py-2 rounded-lg border border-gray-300 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
            >
              {form.draft_label ?? "Save Draft"}
            </button>
          )}
          <button
            type="submit"
            disabled={submitting || readOnly || !!validationError}
            data-submit-btn
            className="px-6 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 disabled:opacity-60 shadow-sm transition-all"
          >
            {submitting ? (
              <span className="flex items-center gap-2">
                <span className="inline-block h-4 w-4 rounded-full border-2 border-white border-t-transparent animate-spin" />
                {loadingLabel}
              </span>
            ) : submitLabel}
          </button>
        </div>
      </div>
    </form>
  );
}

function SectionCard({ section }: { section: Section }) {
  const { getVisibleFields } = useFormEngineStore();
  const [fieldValidationError, setFieldValidationError] = React.useState<string | null>(null);

  React.useEffect(() => {
    try {
      const fieldsToValidate = section.fields ?? [];
      if (fieldsToValidate.length > 0) {
        validateFieldKeys(fieldsToValidate, section.id ?? section.title);
      }
      setFieldValidationError(null);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid field configuration";
      setFieldValidationError(message);
    }
  }, [section.fields, section.id, section.title]);

  if (section.collection) {
    return (
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden bg-white dark:bg-gray-800/30">
        {section.title && (
          <div className="px-6 py-4 bg-gray-50 dark:bg-gray-800/60 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">{section.title}</h3>
            {section.description && <p className="text-xs text-gray-500 mt-0.5">{section.description}</p>}
          </div>
        )}
        <div className="p-6">
          <CollectionRenderer section={section} collection={section.collection} bindPrefix={section.bind_prefix} />
        </div>
      </div>
    );
  }

  const allVisible = getVisibleFields(section.fields ?? []);
  const basicFields = allVisible.filter(f => !f.advanced);
  const proFields   = allVisible.filter(f => f.advanced);
  if (allVisible.length === 0) return null;

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden bg-white dark:bg-gray-800/30">
      {section.title && (
        <div className="px-6 py-4 bg-gray-50 dark:bg-gray-800/60 border-b border-gray-200 dark:border-gray-700">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-200">{section.title}</h3>
          {section.description && <p className="text-xs text-gray-500 mt-0.5">{section.description}</p>}
        </div>
      )}
      <div className="p-6 space-y-4">
        {fieldValidationError && (
          <div className="flex items-start gap-2.5 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200 mb-4">
            <span className="mt-0.5 flex-shrink-0 text-lg">⚠️</span>
            <div className="flex-1">
              <p className="font-semibold mb-1">Field Configuration Error</p>
              <pre className="text-xs bg-white dark:bg-gray-900 rounded px-2 py-1 overflow-auto whitespace-pre-wrap font-mono border border-amber-100 dark:border-amber-900/50">
                {fieldValidationError}
              </pre>
            </div>
          </div>
        )}

        {!fieldValidationError && (
          <>
            <div className="grid grid-cols-1 gap-x-5 gap-y-6"> {
            //grid-cols-2 is not working for width full
              }
              {basicFields.map((field, index) => (
                <div key={field.id ?? `field-${index}`} className={cn(
                  field.width === "half" ? "col-span-1" :
                  field.width === "third" ? "col-span-1" : "col-span-2"
                )}>
                  <FieldRouter field={field} />
                </div>
              ))}
            </div>
            {proFields.length > 0 && (
              <ProFieldsSection fields={proFields} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
