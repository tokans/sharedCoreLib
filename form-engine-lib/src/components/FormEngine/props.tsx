"use client";

// Re-export everything through the error boundary
export { FieldWrapper } from "./fields/FieldRenderers";
export { FormErrorBoundary } from "./FormErrorBoundary";

import React from "react";
import { FormErrorBoundary } from "./FormErrorBoundary";

// Re-export FormEngine wrapped with error boundary as default export
import { FormEngine as FormEngineInner, FieldRouter } from "./index";
export { FieldRouter };

import type { FormManifest, FieldAnswers, FormContext, FormSubmissionResponse } from "../../libs/types";

interface SafeFormEngineProps {
  manifest: FormManifest;
  formId: string;
  initialAnswers?: FieldAnswers;
  context?: FormContext;
  onSubmit?: (payload: FieldAnswers, response?: FormSubmissionResponse) => Promise<void> | void;
  onDraftSave?: (answers: FieldAnswers) => Promise<void> | void;
  readOnly?: boolean;
  /** See FormEngine: when false, suppresses the built-in success screen. */
  showSuccessScreen?: boolean;
}

export function SafeFormEngine(props: SafeFormEngineProps) {
  return (
    <FormErrorBoundary formId={props.formId}>
      <FormEngineInner {...props} />
    </FormErrorBoundary>
  );
}

export { FormEngineInner as FormEngine };
