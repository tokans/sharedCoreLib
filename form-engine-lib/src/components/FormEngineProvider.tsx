"use client";

/**
 * FormEngineProvider
 *
 * Wrap your application (or just the part that uses the Form Engine) with this
 * provider to supply local manifests and global submit/draft-save handlers.
 *
 * The library has no backend of its own. All network I/O goes through the
 * callbacks you pass here (or directly as props on <FormEngine>).
 *
 * @example
 * // Minimal — local manifests only, no backend calls
 * <FormEngineProvider config={{ localManifests: { onboarding: manifest } }}>
 *   <App />
 * </FormEngineProvider>
 *
 * @example
 * // With a global submit handler that talks to your API
 * <FormEngineProvider
 *   config={{
 *     localManifests: { onboarding: manifest },
 *     onSubmit: async (manifestId, formId, answers) => {
 *       await myApi.post("/submissions", { manifestId, formId, answers });
 *     },
 *     onDraftSave: async (manifestId, formId, answers) => {
 *       localStorage.setItem(`draft:${formId}`, JSON.stringify(answers));
 *     },
 *   }}
 * >
 *   <App />
 * </FormEngineProvider>
 */

import React, { useEffect } from "react";
import {
  FormEngineContext,
  configureFormEngine,
  type FormEngineConfig,
} from "../libs/config";

interface FormEngineProviderProps {
  config: FormEngineConfig;
  children: React.ReactNode;
}

export function FormEngineProvider({ config, children }: FormEngineProviderProps) {
  // Sync React context → module-level singleton on every config change.
  // This ensures hooks and layout components (which can't use React context
  // directly) also see the latest config.
  useEffect(() => {
    configureFormEngine(config);
  }, [config]);

  return (
    <FormEngineContext.Provider value={config}>
      {children}
    </FormEngineContext.Provider>
  );
}
