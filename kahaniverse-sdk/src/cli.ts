#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { KahaniverseClient } from './client.js';
import { uploadComic, type UploadComicOptions } from './upload.js';
import type { UniverseInput, ComicInput } from './types.js';

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      out[key] = val;
    }
  }
  return out;
}

const USAGE = `
kahaniverse upload-comic --dir <folder> [options]

  Uploads a folder of page images as a linear, view-only comic. Idempotent and
  resumable (a .kahaniverse-upload.json sidecar tracks progress).

Auth (env):
  KAHANIVERSE_BASE_URL       e.g. https://kahaniverse.com  (or --base-url)
  KAHANIVERSE_SESSION_TOKEN  NextAuth session JWT from a logged-in browser
                             (DevTools → Cookies → authjs.session-token)

Metadata: put a comic.json in the folder, and/or pass flags (flags win):
  {
    "universe": { "slug": "exodus-2120", "name": "Exodus 2120",
                  "concept": "…", "coverImage": "cover.png", "genres": ["scienceFiction"] },
    "comic":    { "slug": "issue-01", "title": "Issue 01: Landfall",
                  "synopsis": "…", "coverImage": "001.jpg" },
    "spreads":  [4, 5]
  }

Options:
  --dir <folder>          (required) images named so they sort in reading order
  --universe <slug>       universe slug (must exist unless comic.json describes it)
  --slug <comicSlug>      comic slug → /comics/{universe}/{slug}
  --title <text>          comic title
  --synopsis <text>       comic synopsis
  --spreads 4,5           1-based page numbers that are two-page spreads
  --no-auto-spread        disable aspect-ratio spread detection
  --concurrency <n>       parallel uploads (default 4)
  --base-url <url>        overrides KAHANIVERSE_BASE_URL
`;

async function loadConfigFile(dir: string): Promise<any> {
  try { return JSON.parse(await fs.readFile(path.join(dir, 'comic.json'), 'utf8')); }
  catch { return {}; }
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd !== 'upload-comic') { console.log(USAGE); process.exit(cmd ? 1 : 0); }

  const flags = parseArgs(rest);
  const dir = flags.dir;
  if (!dir) { console.error('Error: --dir is required\n' + USAGE); process.exit(1); }

  const baseUrl = flags['base-url'] ?? process.env.KAHANIVERSE_BASE_URL;
  const sessionToken = process.env.KAHANIVERSE_SESSION_TOKEN;
  if (!baseUrl || !sessionToken) {
    console.error('Error: set KAHANIVERSE_BASE_URL and KAHANIVERSE_SESSION_TOKEN (see --help)');
    process.exit(1);
  }

  const cfg = await loadConfigFile(dir);

  const universe: UniverseInput = {
    slug:       flags.universe ?? cfg.universe?.slug,
    name:       cfg.universe?.name ?? flags.universe,
    concept:    cfg.universe?.concept ?? 'A shared universe on Kahaniverse.',
    coverImage: cfg.universe?.coverImage ?? cfg.comic?.coverImage ?? '',
    genres:     cfg.universe?.genres ?? [],
    era:        cfg.universe?.era,
    world:      cfg.universe?.world,
    isMature:   cfg.universe?.isMature ?? false,
  };
  const comic: ComicInput = {
    slug:      flags.slug ?? cfg.comic?.slug,
    title:     flags.title ?? cfg.comic?.title,
    synopsis:  flags.synopsis ?? cfg.comic?.synopsis ?? '',
    coverImage: cfg.comic?.coverImage,
    genreTags: cfg.comic?.genreTags ?? [],
    isMature:  cfg.comic?.isMature ?? false,
  };
  if (!universe.slug) { console.error('Error: universe slug required (--universe or comic.json)'); process.exit(1); }
  if (!comic.slug || !comic.title) { console.error('Error: comic slug and title required (--slug/--title or comic.json)'); process.exit(1); }
  if (!universe.coverImage) universe.coverImage = comic.coverImage ?? '';

  const spreads = (flags.spreads ?? (cfg.spreads ?? []).join(','))
    .toString().split(',').map(s => Number(s.trim())).filter(Boolean);

  const opts: UploadComicOptions = {
    dir,
    universe,
    comic,
    spreads,
    autoSpread: flags['no-auto-spread'] !== 'true',
    concurrency: flags.concurrency ? Number(flags.concurrency) : 4,
    onProgress: (m) => console.log(m),
  };

  const client = new KahaniverseClient({ baseUrl, sessionToken });
  const who = await client.whoami();
  if (!who) { console.error('Error: session token is invalid or expired — copy a fresh one from your browser'); process.exit(1); }
  console.log(`Authenticated as author ${who.id}`);

  const res = await uploadComic(client, opts);
  console.log(`\n✔ Done. ${res.committed} new, ${res.updated} changed page(s); ${res.totalPages} total.`);
  console.log(`  Read it at: ${baseUrl}${res.url}`);
}

main().catch((e) => { console.error('\n✖', e?.message ?? e); process.exit(1); });
