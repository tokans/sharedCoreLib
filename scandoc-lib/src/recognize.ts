/**
 * The recognition seam — the typed boundary between *capture/recognition* (turning
 * a PDF, scanned PDF, or phone photo into text) and the pure text-processing engine
 * in this lib (normalize / fuzzy / confidence).
 *
 * The whole engine "operates on text that has *already* been recognized." This
 * interface is the plug point where a real OCR sidecar (capture quality gate, image
 * normalization, native-PDF text extraction, PaddleOCR/Tesseract) lands LATER
 * without touching any downstream consumer. No sidecar ships today — the only
 * recognizer here is `nativeTextRecognizer`, the offline identity recognizer for
 * already-text input and for tests.
 *
 * INVARIANT (suite #1/#7): nothing here egresses. A real recognizer must run fully
 * local/offline (no cloud OCR, no network); this lib never persists or transmits.
 */
import type { FieldSource } from "./confidence";

/** How a document arrived. Drives which recognition path a real recognizer takes. */
export type CaptureKind = "native-text-pdf" | "scanned-pdf" | "photo" | "plain-text";

/** A document handed to a recognizer. Either raw bytes (+ kind) or already-known text. */
export interface CaptureInput {
  kind: CaptureKind;
  /** Document bytes for OCR paths (scanned-pdf / photo). Stays on-device. */
  bytes?: Uint8Array;
  /** Already-recognized text (native-text-pdf / plain-text). */
  text?: string;
  /** Optional hint of expected language(s) for a future OCR engine. */
  langs?: string[];
}

/** Optional per-token confidence from an OCR engine (a real recognizer may fill this). */
export interface RecognizedToken {
  text: string;
  /** 0..1 OCR confidence for this token. */
  confidence: number;
}

/** The output of recognition: the recognized text + where it came from. */
export interface RecognizedDoc {
  text: string;
  /** Provenance feeding `requiresConfirmation`: native text is trusted, OCR is not. */
  source: FieldSource;
  /** Per-token confidences when the recognizer is a real OCR engine; omitted otherwise. */
  perToken?: RecognizedToken[];
}

/** A capture→text recognizer. The OCR sidecar will implement this interface. */
export interface Recognizer {
  recognize(input: CaptureInput): Promise<RecognizedDoc>;
}

/**
 * The offline identity recognizer: passes already-known text through unchanged,
 * tagging native-text/plain-text as `native-text` (trusted) and any bytes-only
 * input as `ocr` with empty text (no OCR engine bundled yet). This is what
 * consumers use today and what tests run against; a real recognizer is a drop-in
 * replacement.
 */
export function nativeTextRecognizer(): Recognizer {
  return {
    async recognize(input: CaptureInput): Promise<RecognizedDoc> {
      if (typeof input.text === "string") {
        const source: FieldSource =
          input.kind === "native-text-pdf" || input.kind === "plain-text" ? "native-text" : "ocr";
        return { text: input.text, source };
      }
      // Bytes-only input would need a real OCR engine, which is not bundled.
      return { text: "", source: "ocr" };
    },
  };
}
