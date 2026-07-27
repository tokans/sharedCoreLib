# kahaniverse-sdk

Upload **stories** and **comics** to the Vercel-hosted Kahaniverse backend from
your machine. Designed for the Hobby plan: the client does the heavy lifting
(image compression) and each comic is committed in a **single** bulk request, so
the backend stays cheap and fast.

## How it works

```
SDK  ──(NextAuth session cookie)──▶  /api/universes, /api/stories   (metadata, GET/POST)
SDK  ──(compressed webp, ×N)──────▶  /api/upload                     (→ Vercel Blob CDN)
SDK  ──(one batch)────────────────▶  /api/stories/{id}/pages/batch   (all pages, 1 call)
```

Comics reuse the existing `stories`/`pages` tables (`kind='comic'`), so they get
reactions and listings for free but never mix into story feeds. A comic is a
linear stack of full-page images (single or two-page spread), read at
`/comics/{universe}/{comic}/{page}` — view-only, not editable online.

## Auth

The SDK replays a **NextAuth (Auth.js v5) session token** — the same JWT your
browser holds — so it hits the very same `auth()`-guarded routes the app uses.
The login form is Turnstile-gated, so copy the token rather than scripting login:

1. Log in to Kahaniverse in your browser.
2. DevTools → Application → Cookies → copy the value of
   `authjs.session-token` (local) or `__Secure-authjs.session-token` (prod).
3. Export it:

```bash
export KAHANIVERSE_BASE_URL="http://localhost:3000"
export KAHANIVERSE_SESSION_TOKEN="<paste the cookie value>"
```

## CLI

Folder layout — one folder per comic, images named so they sort in reading order:

```
comics/exodus-2120/issue-01/
  comic.json          # optional metadata (see below)
  001.jpg  002.jpg  003.jpg  004.jpg  ...
```

`comic.json` (optional; CLI flags override it):

```json
{
  "universe": { "slug": "exodus-2120", "name": "Exodus 2120",
                "concept": "Humanity's last colony ship reaches Kepler-9c.",
                "coverImage": "cover.png", "genres": ["scienceFiction"] },
  "comic":    { "slug": "issue-01", "title": "Issue 01: Landfall",
                "synopsis": "The colonists take their first steps.",
                "coverImage": "001.jpg" },
  "spreads":  [4, 5]
}
```

Run it:

```bash
npm install
npm run build
node dist/cli.js upload-comic --dir ./comics/exodus-2120/issue-01
# …or during dev:
npx tsx src/cli.ts upload-comic --dir ./comics/exodus-2120/issue-01 --spreads 4,5
```

It is **idempotent and resumable** — a `.kahaniverse-upload.json` sidecar in the
folder records each page's uploaded URL and created id, so re-running after a
failure skips finished work and never duplicates pages.

## Programmatic

```ts
import { KahaniverseClient, uploadComic } from 'kahaniverse-sdk';

const client = new KahaniverseClient({
  baseUrl: process.env.KAHANIVERSE_BASE_URL!,
  sessionToken: process.env.KAHANIVERSE_SESSION_TOKEN!,
});

await uploadComic(client, {
  dir: './comics/exodus-2120/issue-01',
  universe: { slug: 'exodus-2120', name: 'Exodus 2120', concept: '…', coverImage: 'cover.png' },
  comic:    { slug: 'issue-01', title: 'Issue 01: Landfall', synopsis: '…' },
  spreads:  [4, 5],
  onProgress: console.log,
});
```

Spreads are auto-detected from aspect ratio (width ≥ 1.2 × height); use `spreads`
to force specific pages.
