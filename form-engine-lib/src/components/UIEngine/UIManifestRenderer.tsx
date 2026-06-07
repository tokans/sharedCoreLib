"use client";

/**
 * UIManifestRenderer
 *
 * PATCHED — two new optional props over the original:
 *
 *  customComponents
 *    Registry of React implementations for `type: Custom` manifest components.
 *    Keyed by `component.name`. Each implementation receives:
 *      { context, handlers, children }
 *    where `children` are the engine-resolved sub_components (if any are declared
 *    on the component in the manifest).
 *
 *  context
 *    Arbitrary runtime key-value pairs made available to:
 *      - hidden_condition string expressions (e.g. "context.mode !== 'signin'")
 *      - Custom component implementations via their `context` prop
 *    This is passed to UIEngineProvider as `engineContext` (renamed internally to
 *    avoid collision with React's own "context" naming).
 *
 * All existing call-sites that omit both new props continue to work unchanged.
 */

import React, { useMemo } from "react";

import {
  UIEngineProvider,
  ScreenLayout,
  UIEngineHandlers,
} from "./index";
import type { CustomComponentRegistry } from "./context";
import type { UISystemManifest, SubComponentPlacement } from "./types";
import type { FieldAnswers } from "../../libs/types";

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

/** Map of action-key → handler invoked by FormEngine on_submit / Button on_press */
export type ActionHandlerMap = Record<
  string,
  (answers: FieldAnswers) => Promise<void> | void
>;

interface UIManifestRendererProps {
  /** Full UISystemManifest (schema-conformant YAML parsed to JS object) */
  manifest: UISystemManifest;
  /** Key of the screen to render (from manifest.screens) */
  screenKey: string;
  /**
   * Handlers wired to:
   *  - FormEngine `on_submit.handler_name` (local submit)
   *  - Button `on_press` when action type is "custom"
   *  - ActionDef `handler` field
   */
  handlers?: ActionHandlerMap;
  /**
   * Registry mapping Custom component names to React implementations.
   * Each implementation receives { context, handlers, children } where children
   * are the engine-resolved sub_components declared on the manifest component.
   *
   * Example:
   *   customComponents={{
   *     background_grid: BackgroundGrid,
   *     auth_card: AuthCardWrapper,
   *   }}
   */
  customComponents?: CustomComponentRegistry;
  /**
   * Runtime context values injected into:
   *  - hidden_condition string expressions via the `context` variable
   *    (e.g. `"context.mode !== 'signin'"` on a sub_component placement)
   *  - Custom component implementations via their `context` prop
   *
   * Example:
   *   context={{ mode: "signin" }}
   */
  context?: Record<string, unknown>;
  /** Extra CSS class on the outermost div */
  className?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Component
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Renders a single screen from a UISystemManifest.
 *
 * Self-contained: boots its own UIEngineProvider so it can be dropped into any
 * React tree without an ancestor engine context. If you already have an ancestor
 * UIEngineProvider, use ScreenLayout directly.
 */
export function UIManifestRenderer({
  manifest,
  screenKey,
  handlers = {},
  customComponents,
  context,
  className,
}: UIManifestRendererProps) {
  const screen = manifest.screens?.[screenKey];

  if (!screen) {
    console.warn(
      `[UIManifestRenderer] screen "${screenKey}" not found in manifest "${manifest.manifest_id}"`
    );
    return null;
  }

  // Cast ActionHandlerMap → UIEngineHandlers
  const engineHandlers = useMemo<UIEngineHandlers>(
    () =>
      Object.fromEntries(
        Object.entries(handlers).map(([k, fn]) => [
          k,
          async (ctx: unknown) => fn(ctx as FieldAnswers),
        ])
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [handlers]
  );

  const placements: SubComponentPlacement[] = screen.components ?? [];

  return (
    <UIEngineProvider
      manifest={manifest}
      handlers={engineHandlers}
      customComponents={customComponents}
      engineContext={context}
    >
      <div
        className={className}
        style={{ display: "flex", flexDirection: "column", minHeight: "100%" }}
      >
        {/*
         * ScreenLayout renders the full direction-based layout:
         *   Modal / Top / Left / Center / Right / Floating / Bottom
         *
         * Each placement → SubComponentPlacementRenderer → ComponentRenderer.
         * ComponentRenderer dispatches Custom types to CustomRenderer, which
         * resolves the registered implementation and passes engine-walked
         * sub_components as children.
         */}
        <ScreenLayout componentPlacements={placements} />
      </div>
    </UIEngineProvider>
  );
}