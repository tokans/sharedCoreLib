/**
 * @scandoc/core — the domain-agnostic scanned-document reading engine for the myLife
 * suite. Turns *recognized* document text into clean tokens, fuzzy-matches it against
 * an app-supplied vocabulary, and tiers each field by confidence for human review.
 *
 * SCOPE: this is the pure, testable text-processing engine + the typed recognition
 * seam. It carries NO domain knowledge (no drug formulary, no lab vocabulary, no
 * document categories) — apps supply those. It also carries NO OCR engine yet: the
 * `Recognizer` interface is the plug point for a future local/offline OCR sidecar.
 *
 * Everything here is pure: no DB, no network, no models, no LLM, no React. Heavy deps
 * (if a review UI ever lands) would be peerDependencies — see README.
 */
export {
  collapseWhitespace,
  splitLines,
  normalizeToken,
  digitsFromOcr,
  parseOcrNumber,
  stripLineMarker,
  stripFormPrefix,
  canonicalForm,
} from "./normalize";

export { levenshtein, similarity, rankMatches, type RankedMatch } from "./fuzzy";

export {
  tierByConfidence,
  requiresConfirmation,
  AUTO_THRESHOLD,
  DISAMBIGUATE_THRESHOLD,
  type ConfidenceTier,
  type FieldSource,
} from "./confidence";

export {
  nativeTextRecognizer,
  type CaptureKind,
  type CaptureInput,
  type RecognizedToken,
  type RecognizedDoc,
  type Recognizer,
} from "./recognize";

export { fieldFrom, type Field, type FieldFromOpts } from "./field";
