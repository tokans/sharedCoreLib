/**
 * PDF → image rasterization for the OCR path.
 *
 * Tesseract OCRs images, not PDFs, so a scanned PDF must be rendered to canvases
 * first. We use pdf.js (the LEGACY build — it avoids module-worker / top-level-await
 * pitfalls in older webviews) and render each page to a real `<canvas>` (broad webview
 * support; not OffscreenCanvas).
 *
 * The pdf.js MODULE is injected by the app (the lib is built by tsup/tsc and the heavy
 * peerDep can only be resolved/bundled from the app's compilation, not from this lib's
 * symlinked dist). The app also supplies the worker URL it bundled — nothing is fetched
 * from a CDN.
 */

/** A loose shape of just the pdf.js surface we touch (peerDep module, typed locally). */
export interface PdfJsLike {
  GlobalWorkerOptions: { workerSrc: string };
  getDocument(src: { data: Uint8Array }): { promise: Promise<PdfDocLike> };
}
interface PdfDocLike {
  numPages: number;
  getPage(n: number): Promise<PdfPageLike>;
  destroy(): Promise<void> | void;
}
interface PdfPageLike {
  getViewport(opts: { scale: number }): { width: number; height: number };
  render(opts: { canvasContext: CanvasRenderingContext2D; viewport: { width: number; height: number } }): {
    promise: Promise<void>;
  };
  cleanup?(): void;
}

/** The pdf.js module as imported by the app (ESM default or namespace). */
export type PdfjsModule = PdfJsLike | { default: PdfJsLike };

/** Largest page dimension we render, to bound memory on huge scans. */
const MAX_DIM = 4000;

/**
 * Rasterize the first `maxPages` of a PDF to canvases at `scale` (≈150–200 DPI at 2).
 * `pdfjsModule` is the app-imported pdf.js; `workerSrc` is the app-bundled worker URL.
 * Caller is responsible for OCR'ing + then discarding the canvases.
 */
export async function rasterizePdf(
  pdfjsModule: PdfjsModule,
  bytes: Uint8Array,
  workerSrc: string,
  maxPages = 5,
  scale = 2,
): Promise<HTMLCanvasElement[]> {
  const pdfjs = ("default" in pdfjsModule ? pdfjsModule.default : pdfjsModule) as PdfJsLike;
  pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;
  const doc = await pdfjs.getDocument({ data: bytes }).promise;
  const canvases: HTMLCanvasElement[] = [];
  try {
    const pages = Math.min(maxPages, doc.numPages);
    for (let n = 1; n <= pages; n++) {
      const page = await doc.getPage(n);
      let viewport = page.getViewport({ scale });
      // Clamp very large pages down so we never allocate an enormous canvas.
      const longest = Math.max(viewport.width, viewport.height);
      if (longest > MAX_DIM) viewport = page.getViewport({ scale: (scale * MAX_DIM) / longest });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const ctx = canvas.getContext("2d");
      if (!ctx) throw new Error("2D canvas context unavailable for PDF rasterization");
      await page.render({ canvasContext: ctx, viewport }).promise;
      page.cleanup?.();
      canvases.push(canvas);
      // Yield to the event loop between pages so the webview can paint progress and
      // stay responsive — multi-page rasterization is the one main-thread phase of OCR
      // (recognition itself runs in a worker).
      if (n < pages) await new Promise((r) => setTimeout(r, 0));
    }
    return canvases;
  } finally {
    await doc.destroy();
  }
}
