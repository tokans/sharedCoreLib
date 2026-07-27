import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { KahaniverseClient } from './client.js';
import { prepareImage } from './image.js';
import type { UniverseInput, ComicInput } from './types.js';

const SIDECAR = '.kahaniverse-upload.json';
const IMAGE_RE = /\.(jpe?g|png|webp)$/i;

interface Sidecar {
  universeId?: string;
  storyId?: string;
  // Keyed by source filename. Two hashes track two independent states so the run
  // is resumable across a failure at any point:
  //   committedHash — sha256 of the bytes the DB row currently reflects (advances
  //                   only after a successful append/update). Change detection
  //                   compares this to the file's current hash.
  //   uploadedHash  — sha256 of the bytes we've already pushed to `url` (may be
  //                   ahead of committedHash when a commit hasn't landed yet), so
  //                   a resumed run reuses the blob instead of re-uploading it.
  pages: Record<string, {
    committedHash?: string;
    uploadedHash?: string;
    url?: string;
    pageId?: string;
    spread: boolean;
  }>;
}

/** sha256 of a source file's bytes — the change key for idempotent re-runs. */
async function hashFile(abs: string): Promise<string> {
  return createHash('sha256').update(await fs.readFile(abs)).digest('hex');
}

export interface UploadComicOptions {
  /** Folder of page images, e.g. ./comics/{universe}/{comic}. */
  dir: string;
  /** Universe: full metadata creates it if missing; slug-only requires it to exist. */
  universe: UniverseInput;
  comic: ComicInput;
  /** Explicit 1-based page numbers that are two-page spreads. */
  spreads?: number[];
  /** Detect spreads from aspect ratio too (default true). */
  autoSpread?: boolean;
  /** Parallel image uploads (default 4). */
  concurrency?: number;
  onProgress?: (msg: string) => void;
}

export interface UploadComicResult {
  universeId: string;
  storyId: string;
  totalPages: number;
  uploaded: number;   // images sent this run (new + changed)
  committed: number;  // new pages created this run
  updated: number;    // existing pages re-linked to a changed image this run
  url: string;        // reader deep link
}

/** Natural sort so 2.png < 10.png. */
function naturalSort(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

async function readSidecar(dir: string): Promise<Sidecar> {
  try {
    return JSON.parse(await fs.readFile(path.join(dir, SIDECAR), 'utf8')) as Sidecar;
  } catch {
    return { pages: {} };
  }
}
async function writeSidecar(dir: string, s: Sidecar): Promise<void> {
  await fs.writeFile(path.join(dir, SIDECAR), JSON.stringify(s, null, 2));
}

/** Upload a local image (or pass through an http(s) URL). */
async function resolveImageUrl(client: KahaniverseClient, dir: string, ref: string): Promise<string> {
  if (/^https?:\/\//i.test(ref)) return ref;
  const abs = path.isAbsolute(ref) ? ref : path.join(dir, ref);
  const prepared = await prepareImage(abs);
  return client.uploadImage(prepared.buffer, path.basename(abs).replace(IMAGE_RE, '.webp'), prepared.contentType);
}

async function pool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  const queue = [...items];
  const run = async (): Promise<void> => {
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) await worker(next);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

/**
 * Push a folder of images up as a linear comic. Idempotent and resumable: a
 * sidecar in `dir` records each page's uploaded URL and created id, so a re-run
 * after a partial failure skips finished work and never duplicates pages. The
 * whole comic is committed in ONE batch request to keep Hobby load minimal.
 */
export async function uploadComic(
  client: KahaniverseClient,
  opts: UploadComicOptions,
): Promise<UploadComicResult> {
  const log = opts.onProgress ?? (() => {});
  const { dir } = opts;
  const autoSpread = opts.autoSpread ?? true;
  const spreadSet = new Set(opts.spreads ?? []);

  const sidecar = await readSidecar(dir);

  // Page files in reading order.
  const files = (await fs.readdir(dir))
    .filter(f => IMAGE_RE.test(f))
    .sort(naturalSort);
  if (!files.length) throw new Error(`No page images (${IMAGE_RE}) found in ${dir}`);

  // 1) Universe.
  log(`Ensuring universe "${opts.universe.slug}"…`);
  const universe = await client.ensureUniverse(opts.universe.slug, {
    ...opts.universe,
    coverImage: await resolveImageUrl(client, dir, opts.universe.coverImage),
  });
  sidecar.universeId = universe.id;
  await writeSidecar(dir, sidecar);

  // 2) Comic (default cover = first page).
  log(`Ensuring comic "${opts.comic.slug}"…`);
  const comic = await client.ensureComic(universe.id, {
    ...opts.comic,
    coverImage: await resolveImageUrl(client, dir, opts.comic.coverImage ?? files[0]),
  });
  sidecar.storyId = comic.id;
  await writeSidecar(dir, sidecar);

  // 3) Hash every source file, then upload the ones whose bytes we don't already
  //    have a blob for (new files, or edits whose hash differs from uploadedHash).
  //    Unchanged, already-uploaded files are skipped. Concurrency-limited.
  const currentHash: Record<string, string> = {};
  for (const f of files) currentHash[f] = await hashFile(path.join(dir, f));

  const needsUpload = (f: string): boolean => {
    const e = sidecar.pages[f];
    return !e?.url || e.uploadedHash !== currentHash[f];
  };
  const toUpload = files.filter(needsUpload);

  let uploaded = 0;
  await pool(toUpload, opts.concurrency ?? 4, async (file) => {
    const abs = path.join(dir, file);
    const prepared = await prepareImage(abs);
    const pageNo = files.indexOf(file) + 1;
    const spread = spreadSet.has(pageNo) || (autoSpread && prepared.wide);
    const url = await client.uploadImage(prepared.buffer, file.replace(IMAGE_RE, '.webp'), prepared.contentType);
    // Keep committedHash/pageId untouched — they still describe the DB row until a
    // commit/update below lands. A changed page keeps its pageId (→ update path);
    // a new page has none yet (→ append path).
    const prev = sidecar.pages[file];
    sidecar.pages[file] = {
      ...prev,
      spread,
      url,
      uploadedHash: currentHash[file],
    };
    await writeSidecar(dir, sidecar);
    uploaded += 1;
    log(`  ↑ ${file} (${(prepared.buffer.byteLength / 1024).toFixed(0)} KB${spread ? ', spread' : ''})`);
  });

  // 4a) Commit NEW pages (uploaded, never committed) in ONE batch — append to the
  //     tail. committedHash advances only here, so a failure leaves them retryable.
  const appendFiles = files.filter(f => sidecar.pages[f]?.url && !sidecar.pages[f]?.pageId);
  let committed = 0;
  if (appendFiles.length) {
    log(`Committing ${appendFiles.length} new page(s) in one batch…`);
    const created = await client.batchComicPages(
      comic.id,
      appendFiles.map(f => ({ illustration: sidecar.pages[f].url!, spread: sidecar.pages[f].spread })),
    );
    created.forEach((p, i) => {
      const e = sidecar.pages[appendFiles[i]];
      e.pageId = p.id;
      e.committedHash = e.uploadedHash;
    });
    await writeSidecar(dir, sidecar);
    committed = created.length;
  }

  // 4b) Update CHANGED pages (already committed, but the file's bytes differ from
  //     what the DB reflects) in ONE batch — re-links each to its new image; the
  //     server reclaims the old blob. committedHash advances only on success.
  const updateFiles = files.filter(f => {
    const e = sidecar.pages[f];
    return e?.pageId && e.url && e.committedHash !== currentHash[f];
  });
  let updated = 0;
  if (updateFiles.length) {
    log(`Updating ${updateFiles.length} changed page(s) in one batch…`);
    await client.updateComicPages(
      comic.id,
      updateFiles.map(f => ({ id: sidecar.pages[f].pageId!, illustration: sidecar.pages[f].url!, spread: sidecar.pages[f].spread })),
    );
    updateFiles.forEach(f => { sidecar.pages[f].committedHash = sidecar.pages[f].uploadedHash; });
    await writeSidecar(dir, sidecar);
    updated = updateFiles.length;
  }

  return {
    universeId: universe.id,
    storyId: comic.id,
    totalPages: files.length,
    uploaded,
    committed,
    updated,
    url: `/comics/${universe.slug}/${comic.slug ?? opts.comic.slug}/1`,
  };
}
