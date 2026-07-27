/**
 * Browser/webview entry point — the subset of the SDK that runs without Node built-ins.
 * It deliberately does NOT re-export {@link ./upload.ts} (uses `node:fs`) or
 * {@link ./image.ts} (uses `sharp`); a browser caller composites + compresses images
 * itself (e.g. via a canvas) and uploads them in memory with {@link uploadComicImages}.
 *
 * Consumed as `kahaniverse-sdk/web`.
 */
export { KahaniverseClient, KahaniverseError } from './client.js';
export { uploadComicImages } from './uploadImages.js';
export type { ClientConfig, Universe, Story, UniverseInput, ComicInput } from './types.js';
export type { ComicPageImage, UploadComicImagesOptions, UploadComicImagesResult, PriorPage } from './uploadImages.js';
