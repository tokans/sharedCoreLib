import { KahaniverseClient } from './client.js';
import type { UniverseInput, ComicInput } from './types.js';

/**
 * A single already-rendered comic page, in memory. `bytes` are the encoded image
 * (webp/png/jpeg) — the caller has already composited + compressed the page (e.g. a
 * Tauri app rasterizing its editor DOM to a webp Blob), so — unlike the folder/CLI
 * path in {@link ./upload.ts} — no `sharp` re-encode happens here. A two-page spread
 * is ONE wide image with `spread: true`.
 */
export interface ComicPageImage {
  bytes: Uint8Array;
  /** MIME of `bytes`, e.g. "image/webp". */
  contentType: string;
  /** Two-page spread (wide). */
  spread?: boolean;
}

/** A cover image supplied in memory (uploaded first) or as an already-hosted URL. */
type CoverRef = { bytes: Uint8Array; contentType: string } | { url: string };

/**
 * What a previous {@link uploadComicImages} run produced, one entry per page in
 * reading order. Persist {@link UploadComicImagesResult.manifest} between runs and
 * pass it back as `prior` so a re-run re-uploads + re-links ONLY the pages whose
 * image or spread changed. Entries are matched to pages by index, so keep page
 * order stable across runs (append/edit in place rather than reordering).
 */
export interface PriorPage {
  hash: string;
  pageId: string;
  url: string;
  spread?: boolean;
}

export interface UploadComicImagesOptions {
  /** Universe metadata; `coverImage` defaults to the first page when omitted. */
  universe: Omit<UniverseInput, 'coverImage'> & { coverImage?: CoverRef };
  /** Comic metadata; `coverImage` defaults to the first page when omitted. */
  comic: Omit<ComicInput, 'coverImage'> & { coverImage?: CoverRef };
  /** Pages in reading order (cover first). */
  pages: ComicPageImage[];
  /** Manifest from the previous run (index-aligned) for incremental re-uploads. */
  prior?: PriorPage[];
  /** Parallel image uploads (default 4). */
  concurrency?: number;
  onProgress?: (msg: string) => void;
}

export interface UploadComicImagesResult {
  universeId: string;
  storyId: string;
  totalPages: number;
  uploaded: number; // images sent this run (new + changed)
  committed: number; // new pages created this run
  updated: number; // existing pages re-linked to a changed image this run
  /** Persist and pass back as `prior` next run. One entry per page, in order. */
  manifest: PriorPage[];
  url: string; // reader deep link
}

/** sha256 of image bytes — the change key. Works in Node 18+ and browsers. */
async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as unknown as ArrayBuffer);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Concurrency-limited map, preserving nothing (side-effect writes into `out`). */
async function pool<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>): Promise<void> {
  const queue = items.map((item, index) => ({ item, index }));
  const run = async (): Promise<void> => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      await worker(next.item, next.index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

/**
 * Resolve a cover to a hosted URL. An explicit URL passes through; explicit in-memory
 * bytes are uploaded; otherwise we REUSE `fallbackUrl` — the already-uploaded first page
 * (the cover page) — so the comic's story-card cover is literally the cover page image,
 * with no duplicate upload.
 */
async function resolveCover(
  client: KahaniverseClient,
  cover: CoverRef | undefined,
  fallbackUrl: string,
  name: string,
): Promise<string> {
  if (!cover) return fallbackUrl;
  if ('url' in cover) return cover.url;
  const ext = cover.contentType.split('/')[1] ?? 'webp';
  return client.uploadImage(cover.bytes, `${name}-cover.${ext}`, cover.contentType);
}

/**
 * Upload a comic that has already been rendered to in-memory page images (the
 * browser/Tauri analog of {@link uploadComic}). Uploads every page image first
 * (concurrency-limited) so the cover page's URL can double as the universe/comic
 * story-card cover, ensures the universe + comic exist, then commits every page in ONE
 * batch. Not resumable (no on-disk sidecar) — it's a single interactive "Upload" action.
 */
export async function uploadComicImages(
  client: KahaniverseClient,
  opts: UploadComicImagesOptions,
): Promise<UploadComicImagesResult> {
  const log = opts.onProgress ?? (() => {});
  const { pages, prior } = opts;
  if (!pages.length) throw new Error('No page images to upload');

  // 0) Hash every page and classify against the prior manifest (index-aligned).
  //    A page is UNCHANGED when a prior entry has the same hash and spread — its
  //    URL/pageId are reused with no upload. Otherwise it's NEW (no prior pageId)
  //    or CHANGED (prior pageId present) and needs (re)uploading.
  const hashes = await Promise.all(pages.map(p => sha256(p.bytes)));
  const urls = new Array<string>(pages.length);
  const changed = pages.map((p, i) => {
    const prev = prior?.[i];
    const same = prev && prev.hash === hashes[i] && (prev.spread ?? false) === (p.spread ?? false);
    if (same) urls[i] = prev!.url; // reuse — no upload
    return !same;
  });

  // 1) Upload only the changed/new pages, keeping order.
  const toUpload = pages.map((_, i) => i).filter(i => changed[i]);
  let done = 0;
  await pool(toUpload, opts.concurrency ?? 4, async (i) => {
    const page = pages[i];
    const ext = page.contentType.split('/')[1] ?? 'webp';
    urls[i] = await client.uploadImage(page.bytes, `${i + 1}.${ext}`, page.contentType);
    done += 1;
    log(`  ↑ page ${i + 1}/${pages.length} (${(page.bytes.byteLength / 1024).toFixed(0)} KB${page.spread ? ', spread' : ''}) — ${done}/${toUpload.length} uploaded`);
  });

  // 2) Universe (cover defaults to the cover page = first page's URL).
  log(`Ensuring universe "${opts.universe.slug}"…`);
  const universe = await client.ensureUniverse(opts.universe.slug, {
    ...opts.universe,
    coverImage: await resolveCover(client, opts.universe.coverImage, urls[0], opts.universe.slug),
  });

  // 3) Comic — its story-card cover defaults to the cover page too.
  log(`Ensuring comic "${opts.comic.slug}"…`);
  const comic = await client.ensureComic(universe.id, {
    ...opts.comic,
    coverImage: await resolveCover(client, opts.comic.coverImage, urls[0], opts.comic.slug),
  });

  // 4a) Append NEW pages (no prior pageId) in ONE batch, in reading order.
  const appendIdx = pages.map((_, i) => i).filter(i => changed[i] && !prior?.[i]?.pageId);
  const pageIds = new Array<string>(pages.length);
  prior?.forEach((p, i) => { if (p?.pageId) pageIds[i] = p.pageId; }); // carry unchanged/updated ids
  let committed = 0;
  if (appendIdx.length) {
    log(`Committing ${appendIdx.length} new page(s)…`);
    const created = await client.batchComicPages(
      comic.id,
      appendIdx.map(i => ({ illustration: urls[i], spread: pages[i].spread })),
    );
    created.forEach((c, k) => { pageIds[appendIdx[k]] = c.id; });
    committed = created.length;
  }

  // 4b) Update CHANGED pages that already existed (prior pageId) in ONE batch;
  //     the server reclaims each replaced blob.
  const updateIdx = pages.map((_, i) => i).filter(i => changed[i] && prior?.[i]?.pageId);
  let updated = 0;
  if (updateIdx.length) {
    log(`Updating ${updateIdx.length} changed page(s)…`);
    await client.updateComicPages(
      comic.id,
      updateIdx.map(i => ({ id: prior![i]!.pageId, illustration: urls[i], spread: pages[i].spread })),
    );
    updated = updateIdx.length;
  }

  const manifest: PriorPage[] = pages.map((p, i) => ({
    hash: hashes[i], pageId: pageIds[i], url: urls[i], spread: p.spread ?? false,
  }));

  return {
    universeId: universe.id,
    storyId: comic.id,
    totalPages: pages.length,
    uploaded: toUpload.length,
    committed,
    updated,
    manifest,
    url: `/comics/${universe.slug}/${comic.slug ?? opts.comic.slug}/1`,
  };
}
