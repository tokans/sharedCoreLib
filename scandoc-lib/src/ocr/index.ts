/**
 * `@scandoc/core/ocr` — the optional, environment-dependent OCR recognizer.
 *
 * Kept as a SEPARATE subpath from the pure text engine (`@scandoc/core`) so apps that
 * only need normalize/fuzzy/confidence never pull tesseract.js or pdf.js. The app
 * injects all I/O + asset URLs via `OcrAssetHost` / `TesseractRecognizerConfig`.
 */
export { createTesseractRecognizer, type TesseractRecognizerDeps, type CreateWorker } from "./tesseract";
export { provisionLang, isLangProvisioned, sha256Hex, type ProvisionLangConfig } from "./assets";
export { rasterizePdf, type PdfJsLike, type PdfjsModule } from "./pdf";
export {
  OcrCancelled,
  OcrIntegrityError,
  type OcrProgress,
  type OcrAssetHost,
  type DownloadOptions,
  type TesseractRecognizerConfig,
} from "./types";
