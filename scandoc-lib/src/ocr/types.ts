/**
 * DI contracts for the Tesseract OCR recognizer (`@scandoc/core/ocr`).
 *
 * The lib carries the OCR *engine* (tesseract.js + pdf.js orchestration) but NONE of
 * the host environment: every byte of network/filesystem I/O and every concrete asset
 * URL is injected by the consuming app (CONTRACT §1 — DI, no app-specific strings).
 * This keeps the lib bundler-agnostic (it is built by tsup/tsc, so it cannot use
 * Vite-only `?url`/`?worker` imports) and platform-agnostic (a Tauri app, a plain
 * browser, or a test all supply their own `OcrAssetHost`).
 *
 * INVARIANT (suite #1/#7): nothing here egresses on its own. The ONLY network call is
 * the app-provided `download()` of the language data from an app-allowlisted host, and
 * the bytes are SHA-256-verified before they are ever used.
 */

/** Progress signal surfaced to the app during provisioning + recognition. */
export interface OcrProgress {
  phase: "download" | "verify" | "recognize";
  /** Bytes received / fraction recognized (0..1 for recognize). */
  received?: number;
  /** Total bytes when known (download). */
  total?: number;
}

/** Thrown when an `AbortSignal` cancels provisioning or recognition. */
export class OcrCancelled extends Error {
  constructor(message = "OCR cancelled") {
    super(message);
    this.name = "OcrCancelled";
  }
}

/** Thrown when downloaded language data fails its SHA-256 integrity check. */
export class OcrIntegrityError extends Error {
  constructor(
    public readonly expected: string,
    public readonly actual: string,
  ) {
    super(`OCR asset integrity check failed (expected ${expected}, got ${actual})`);
    this.name = "OcrIntegrityError";
  }
}

/** Options threaded into a single download. */
export interface DownloadOptions {
  onProgress?: (received: number, total?: number) => void;
  signal?: AbortSignal;
}

/**
 * App-injected I/O adapter. The lib NEVER imports Tauri/Node/browser FS or HTTP — the
 * app implements these against its own environment (Tauri plugin-http/fs in myHealth,
 * an in-memory stub in tests).
 */
export interface OcrAssetHost {
  /** Download a URL to bytes. The app allowlists the host; the lib verifies the bytes. */
  download(url: string, opts?: DownloadOptions): Promise<Uint8Array>;
  /** Is `name` already cached on this device? */
  hasCached(name: string): Promise<boolean>;
  /** Read a previously cached file (for re-verification). */
  readCached(name: string): Promise<Uint8Array>;
  /** Persist verified bytes under `name`. */
  writeCached(name: string, bytes: Uint8Array): Promise<void>;
  /**
   * Resolve a fetchable, same-origin/asset URL for the cache DIRECTORY so the OCR worker
   * can load the language file offline (e.g. Tauri `convertFileSrc`). Tesseract's
   * `langPath` is a directory — it appends `<lang>.traineddata.gz` itself, so the cached
   * file MUST be named exactly that.
   */
  cacheDirUrl(): Promise<string>;
}

/**
 * Everything the recognizer needs. The asset paths (`workerPath`/`corePath`/
 * `pdfWorkerSrc`) point at files the APP bundles same-origin (offline); only the
 * language data is fetched once via `host.download` and then cached + verified.
 */
export interface TesseractRecognizerConfig {
  host: OcrAssetHost;
  /** Base URL the language file is downloaded from (app-allowlisted). */
  baseUrl: string;
  /** Cached/served name of the gzipped language data. */
  langFile: string;
  /** Lowercase hex SHA-256 the downloaded `langFile` must match. */
  langSha256: string;
  /** Tesseract language code (e.g. "eng"). */
  lang: string;
  /** App-bundled URL of the tesseract.js worker script (same-origin, offline). */
  workerPath: string;
  /** App-bundled directory URL containing tesseract-core wasm (same-origin, offline). */
  corePath: string;
}
