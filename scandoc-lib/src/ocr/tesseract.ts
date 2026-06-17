/**
 * The Tesseract OCR recognizer — a real `Recognizer` (drop-in for `nativeTextRecognizer`).
 *
 * Already-text input passes through unchanged. Bytes-only input (a phone photo or a
 * scanned PDF) is OCR'd entirely on-device via tesseract.js (WASM in the webview — no
 * native sidecar). The language data is provisioned once (download + SHA-256 verify +
 * cache) and reused offline forever after; the worker + core wasm are app-bundled.
 *
 * INVARIANTS:
 *  - Output ALWAYS carries `source: "ocr"`, never `"native-text"`, so downstream
 *    `requiresConfirmation` keeps drug/dosage/lab confirm-required — OCR is never
 *    authority.
 *  - No network beyond the app-allowlisted, hash-verified language download.
 *
 * tesseract.js + pdf.js are peerDependencies, loaded with bare dynamic imports (kept
 * external by the bundler) and injectable for tests.
 */
import type { CaptureInput, RecognizedDoc, RecognizedToken, Recognizer } from "../recognize";
import type { FieldSource } from "../confidence";
import type { TesseractRecognizerConfig, OcrProgress } from "./types";
import { OcrCancelled } from "./types";
import { provisionLang } from "./assets";

/** A loose shape of just the tesseract.js surface we touch (peerDep, typed locally). */
interface TesseractWord {
  text: string;
  confidence: number;
}
interface TesseractResult {
  data: { text: string; words?: TesseractWord[] };
}
interface TesseractWorker {
  recognize(image: string | HTMLCanvasElement): Promise<TesseractResult>;
  // tesseract.js v5 returns a ConfigResult here; we don't use it, so keep it loose.
  terminate(): Promise<unknown>;
}
export type CreateWorker = (
  lang: string,
  oem: number,
  opts: Record<string, unknown>,
) => Promise<TesseractWorker>;

/**
 * App-injected seams. The heavy peerDeps (tesseract.js + pdf.js) are loaded by the APP,
 * not the lib — a bare `import("tesseract.js")` from this symlinked lib's dist wouldn't
 * resolve to the app's installed copy, and only the app's bundler can chunk them. So the
 * app passes `loadCreateWorker` + `rasterize`; tests inject fakes through the same seams.
 */
export interface TesseractRecognizerDeps {
  onProgress?: (p: OcrProgress) => void;
  signal?: AbortSignal;
  /** REQUIRED (app-injected): load tesseract.js's `createWorker`. */
  loadCreateWorker?: () => Promise<CreateWorker>;
  /** REQUIRED for PDFs (app-injected): rasterize PDF bytes to canvases (app owns pdf.js). */
  rasterize?: (bytes: Uint8Array) => Promise<HTMLCanvasElement[]>;
  /** Override the lang provisioning (defaults to `provisionLang`). */
  provision?: (opts: { onProgress?: (r: number, t?: number) => void; signal?: AbortSignal }) => Promise<string>;
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new OcrCancelled();
}

export function createTesseractRecognizer(
  config: TesseractRecognizerConfig,
  deps: TesseractRecognizerDeps = {},
): Recognizer {
  const provision =
    deps.provision ??
    ((opts) =>
      provisionLang(
        { host: config.host, baseUrl: config.baseUrl, langFile: config.langFile, langSha256: config.langSha256 },
        opts,
      ));
  const rasterize = deps.rasterize;
  const loadCreateWorker = deps.loadCreateWorker;

  return {
    async recognize(input: CaptureInput): Promise<RecognizedDoc> {
      // Already-recognized text: pass through (native-text for trusted PDF/plain text).
      if (typeof input.text === "string") {
        const source: FieldSource =
          input.kind === "native-text-pdf" || input.kind === "plain-text" ? "native-text" : "ocr";
        return { text: input.text, source };
      }
      if (!input.bytes) return { text: "", source: "ocr" };

      throwIfAborted(deps.signal);
      deps.onProgress?.({ phase: "download" });
      const langPath = await provision({
        onProgress: (received, total) => deps.onProgress?.({ phase: "download", received, total }),
        signal: deps.signal,
      });
      throwIfAborted(deps.signal);

      // Build the image set: a photo is one image; a scanned PDF is one image per page.
      const images: (string | HTMLCanvasElement)[] = [];
      let objectUrl: string | null = null;
      if (input.kind === "scanned-pdf") {
        if (!rasterize) throw new Error("OCR: no PDF rasterizer injected (app must supply `rasterize`).");
        const canvases = await rasterize(input.bytes);
        images.push(...canvases);
      } else {
        objectUrl = URL.createObjectURL(new Blob([input.bytes as unknown as BlobPart]));
        images.push(objectUrl);
      }
      throwIfAborted(deps.signal);

      if (!loadCreateWorker) throw new Error("OCR: no worker loader injected (app must supply `loadCreateWorker`).");
      const createWorker = await loadCreateWorker();
      const worker = await createWorker(config.lang, 1, {
        workerPath: config.workerPath,
        corePath: config.corePath,
        langPath,
        gzip: true,
        workerBlobURL: false,
        cacheMethod: "none",
        logger: (m: { progress?: number }) =>
          deps.onProgress?.({ phase: "recognize", received: m.progress ?? 0, total: 1 }),
      });

      try {
        const texts: string[] = [];
        const perToken: RecognizedToken[] = [];
        for (const image of images) {
          throwIfAborted(deps.signal);
          const { data } = await worker.recognize(image);
          if (data.text.trim()) texts.push(data.text.trim());
          for (const w of data.words ?? []) {
            perToken.push({ text: w.text, confidence: w.confidence / 100 });
          }
        }
        return { text: texts.join("\n\n"), source: "ocr", perToken: perToken.length ? perToken : undefined };
      } finally {
        await worker.terminate();
        if (objectUrl) URL.revokeObjectURL(objectUrl);
      }
    },
  };
}
