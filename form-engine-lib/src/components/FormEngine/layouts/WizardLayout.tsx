"use client";

import React, { useState } from "react";
import type { FormManifest, FormDef, FieldAnswers, Section } from "../../../libs/types";
import { useFormEngineStore } from "../../../store/form-engine-store";
import { getConfig } from "../../../libs/config";
import { FieldRouter } from "../index";
import { CollectionRenderer, ProFieldsSection } from "../CollectionRenderer";
import { cn } from "../../../libs/utils";

interface LayoutProps {
  manifest: FormManifest;
  form: FormDef;
  formId: string;
  /**
   * Called after a successful submit on the final wizard page.
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

export function WizardLayout({ manifest, form, formId, onSubmit, onDraftSave, readOnly }: LayoutProps) {
  const {
    currentPageIndex, nextPage, prevPage,
    getVisiblePages, getVisibleSections,
    setSubmitting, setSubmitted, submitting, errors
  } = useFormEngineStore();

  const [submitError, setSubmitError] = useState<string | null>(null);

  const visiblePages = getVisiblePages();
  const currentPage = visiblePages[currentPageIndex];
  const isLastPage = currentPageIndex === visiblePages.length - 1;
  const totalErrors = Object.values(errors).flat().length;

  const submitLabel = form.submit_button?.label ?? form.submit_label ?? "Submit";
  const loadingLabel = form.submit_button?.loading_label ?? "Submitting…";

  const handleNext = () => {
    nextPage();
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitError(null);
    const { validatePage, getSubmitPayload } = useFormEngineStore.getState();
    if (!validatePage(currentPageIndex)) return;
    setSubmitting(true);
    try {
      const payload = getSubmitPayload();

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

  if (!currentPage) return null;

  return (
    <form onSubmit={handleSubmit} noValidate className="flex flex-col min-h-[500px]">
      {/* Step indicator */}
      <div className="mb-8">
        <div className="flex items-center gap-0">
          {visiblePages.map((page, idx) => {
            const isActive = idx === currentPageIndex;
            const isDone = idx < currentPageIndex;
            return (
              <React.Fragment key={page.id}>
                <div className="flex flex-col items-center gap-1.5 flex-shrink-0">
                  <button
                    type="button"
                    onClick={() => idx < currentPageIndex && useFormEngineStore.getState().goToPage(idx)}
                    className={cn(
                      "h-9 w-9 rounded-full flex items-center justify-center text-sm font-semibold transition-all border-2",
                      isActive && "bg-blue-600 border-blue-600 text-white shadow-md scale-110",
                      isDone && "bg-blue-600 border-blue-600 text-white cursor-pointer hover:opacity-80",
                      !isActive && !isDone && "bg-white border-gray-300 text-gray-400"
                    )}
                  >
                    {isDone ? "✓" : idx + 1}
                  </button>
                  <span className={cn(
                    "text-xs font-medium max-w-[80px] text-center",
                    isActive ? "text-blue-600" : "text-gray-400"
                  )}>
                    {page.title}
                  </span>
                </div>
                {idx < visiblePages.length - 1 && (
                  <div className={cn(
                    "flex-1 h-0.5 mt-[-18px] mx-1 transition-colors",
                    isDone ? "bg-blue-500" : "bg-gray-200"
                  )} />
                )}
              </React.Fragment>
            );
          })}
        </div>
      </div>

      {/* Page content */}
      <div className="flex-1">
        <div className="mb-6">
          <h2 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{currentPage.title}</h2>
          {currentPage.description && (
            <p className="mt-1 text-sm text-gray-500">{currentPage.description}</p>
          )}
        </div>
        <div className="space-y-6">
          {getVisibleSections(currentPage.sections).map(section => (
            <SectionRenderer key={section.id} section={section} />
          ))}
        </div>
      </div>

      {/* Inline submit error */}
      {submitError && (
        <div className="mt-4 flex items-start gap-2.5 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950/30 dark:text-red-400">
          <span className="mt-0.5 flex-shrink-0 text-red-500">⚠</span>
          <span>{submitError}</span>
        </div>
      )}

      {/* Navigation */}
      <div className="mt-8 flex items-center justify-between pt-6 border-t border-gray-200 dark:border-gray-700">
        <div className="flex gap-3">
          {currentPageIndex > 0 && (
            <button
              type="button"
              onClick={prevPage}
              className="px-4 py-2 rounded-lg border border-gray-300 text-sm font-medium hover:bg-gray-50 transition-colors"
            >
              ← Back
            </button>
          )}
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
        </div>
        <div className="flex items-center gap-4">
          {totalErrors > 0 && (
            <span className="text-sm text-red-500">
              {totalErrors} error{totalErrors !== 1 ? "s" : ""}
            </span>
          )}
          {isLastPage ? (
            <button
              type="submit"
              disabled={submitting || readOnly}
              data-submit-btn
              className="px-6 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 disabled:opacity-60 transition-all shadow-sm"
            >
              {submitting ? (
                <span className="flex items-center gap-2">
                  <span className="inline-block h-4 w-4 rounded-full border-2 border-white border-t-transparent animate-spin" />
                  {loadingLabel}
                </span>
              ) : submitLabel}
            </button>
          ) : (
            <button
              type="button"
              onClick={handleNext}
              className="px-6 py-2 rounded-lg bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 transition-all shadow-sm"
            >
              Continue →
            </button>
          )}
        </div>
      </div>
    </form>
  );
}

// ─── Section renderer with pro-fields support ─────────────────────────────────
export function SectionRenderer({ section }: { section: Section }) {
  const { getVisibleFields } = useFormEngineStore();

  if (section.collection) {
    return (
      <div className="rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
        {section.title && (
          <div className="px-5 py-3 bg-gray-50 dark:bg-gray-800/60 border-b border-gray-200 dark:border-gray-700">
            <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">{section.title}</h3>
            {section.description && <p className="text-xs text-gray-500 mt-0.5">{section.description}</p>}
          </div>
        )}
        <div className="p-5">
          <CollectionRenderer section={section} collection={section.collection} bindPrefix={section.bind_prefix} />
        </div>
      </div>
    );
  }

  const allVisible = getVisibleFields(section.fields ?? []);
  const basicFields = allVisible.filter(f => !f.advanced);
  const proFields   = allVisible.filter(f => !!f.advanced);

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700 overflow-hidden">
      {section.title && (
        <div className="px-5 py-3 bg-gray-50 dark:bg-gray-800/60 border-b border-gray-200 dark:border-gray-700">
          <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">{section.title}</h3>
          {section.description && <p className="text-xs text-gray-500 mt-0.5">{section.description}</p>}
        </div>
      )}
      <div className="p-5 space-y-4">
        <div className="grid grid-cols-2 gap-x-4 gap-y-5">
          {basicFields.map(field => (
            <div key={field.id} className={cn(
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
      </div>
    </div>
  );
}
