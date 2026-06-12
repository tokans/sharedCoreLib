/**
 * A small, OPTIONAL extraction-framework contract so document-field extractors
 * across the suite share one shape. The recognition + normalize + fuzzy + confidence
 * primitives are the engine; this is sugar that composes `tierByConfidence` +
 * `requiresConfirmation` into one confidence-tiered field record.
 *
 * Adoption is optional — an app may keep its own richer field types (myHealth's
 * `DrugField`/`LabField` predate this and stay as-is). New extractors (e.g. myDocs)
 * can build on `Field<T>` + `fieldFrom` to avoid re-deriving the tiering/confirm
 * logic. Pure and deterministic.
 */
import { type ConfidenceTier, type FieldSource, requiresConfirmation, tierByConfidence } from "./confidence";

/** One confidence-tiered, human-confirmable extracted field. */
export interface Field<T> {
  /** The extracted value, or null when nothing matched well enough. */
  value: T | null;
  /** 0..1 match confidence (e.g. a fuzzy `similarity` score). */
  confidence: number;
  /** Review tier derived from `confidence`. */
  tier: ConfidenceTier;
  /** Where the underlying text came from (drives confirm-required). */
  source: FieldSource;
  /** Whether this field must be human-confirmed before saving. */
  confirmRequired: boolean;
  /** Machine output is never pre-verified; the review UI flips this. */
  verified: boolean;
  /** Ranked alternates for the disambiguation UI (domain-shaped). */
  candidates: ReadonlyArray<{ value: T; score: number }>;
}

/** Options describing how to turn a match into a `Field<T>`. */
export interface FieldFromOpts<T> {
  source: FieldSource;
  /** True when this field is safety-critical for the domain (e.g. drug/dosage). */
  safetyCritical?: boolean;
  candidates?: ReadonlyArray<{ value: T; score: number }>;
}

/**
 * Compose a `Field<T>` from a matched value + confidence: tiers the confidence and
 * applies the confirm-required policy. `verified` always starts false — the review
 * UI is the only thing that sets it true.
 */
export function fieldFrom<T>(value: T | null, confidence: number, opts: FieldFromOpts<T>): Field<T> {
  return {
    value,
    confidence,
    tier: tierByConfidence(confidence),
    source: opts.source,
    confirmRequired: requiresConfirmation(opts.source, opts.safetyCritical ?? false),
    verified: false,
    candidates: opts.candidates ?? [],
  };
}
