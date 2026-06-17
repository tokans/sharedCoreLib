# @scandoc/core

The myLife suite's **domain-agnostic scanned-document reading engine**. It turns
*recognized* document text (from a native-text PDF, a scanned PDF, or a phone photo)
into clean tokens, fuzzy-matches them against an **app-supplied** vocabulary, and tiers
each field by confidence so a human only reviews what needs it.

It is the shared substrate behind any myLife app that reads documents — **myHealth**
(prescriptions, lab reports) and **myDocs** (IDs, contracts, certificates) today — added
the same way as `sharedcorelib` and `@form-engine/react`:

```jsonc
// an app's package.json
"@scandoc/core": "file:../sharedCoreLib/scandoc-lib"
```

```ts
import { splitLines, rankMatches, tierByConfidence, requiresConfirmation } from "@scandoc/core";
```

## What's in scope (and what isn't)

This package is the **pure text-processing engine + a recognition seam**. It carries:

- **`normalize`** — OCR-noise cleanup: `collapseWhitespace`, `splitLines`,
  `normalizeToken`, `digitsFromOcr` / `parseOcrNumber` (letter↔digit fixups: O→0, l/I→1,
  S→5…), `stripLineMarker`, `stripFormPrefix`, `canonicalForm`.
- **`fuzzy`** — dependency-free `levenshtein` / `similarity` and `rankMatches` (snap a
  noisy read to the closest entry in a vocabulary; the score is the confidence).
- **`confidence`** — `tierByConfidence` (auto / disambiguate / manual) and
  `requiresConfirmation(source, safetyCritical)`. The *mechanism* lives here; the
  *policy* (which fields are safety-critical) is the app's.
- **`recognize`** — the `Recognizer` interface (`recognize(CaptureInput) → RecognizedDoc`)
  and `nativeTextRecognizer()` (the offline native-text/plain-text fast path). This is the
  **seam** where OCR plugs in.
- **`field`** — an OPTIONAL `Field<T>` + `fieldFrom` contract for new extractors to share
  one confidence-tiered field shape.

It carries **no domain knowledge** — no drug formulary, no lab vocabulary, no document
categories. Apps supply those (e.g. myHealth keeps `formulary.ts` / `labVocab.ts` /
`extractPrescription` / `extractLab` in-app).

### `@scandoc/core/ocr` — optional Tesseract recognizer (separate subpath)

A real `Recognizer` backed by **Tesseract** (`tesseract.js`, WASM) for image / scanned-PDF
bytes — kept on a **separate subpath** so the pure engine above stays dependency-free and
only OCR consumers pull the heavy peers.

- `createTesseractRecognizer(config, deps)` → a `Recognizer` (drop-in for
  `nativeTextRecognizer`). Output always carries `source: "ocr"` (never authority).
- `provisionLang` / `isLangProvisioned` / `sha256Hex` — **download-once** language data:
  fetch → SHA-256-verify **before** caching → reuse offline. `rasterizePdf` — pdf.js
  page→canvas for scanned PDFs.
- **DI:** the lib carries the orchestration but **no host and no bundling** — the app
  injects all I/O (`OcrAssetHost`) *and* the peer modules themselves (`loadCreateWorker: ()
  => import("tesseract.js")`, a `rasterize` over an app-imported `pdfjs-dist`). A bare
  import of those from this lib's symlinked dist wouldn't resolve to the app's copy, and
  only the app's bundler can code-split them. `tesseract.js` + `pdfjs-dist` are optional
  **peerDependencies**.

A heavier native PaddleOCR/VLM capture pipeline could still implement `Recognizer` later.

## Discipline (mirrors the suite CONTRACT)

- **Pure / dependency-injected, no module globals.** Plain functions + an injected
  `Recognizer`. No DB, no network, no models, no LLM, no React.
- **No egress** (suite invariants #1/#7). A real recognizer must run fully local/offline;
  this lib never persists or transmits, and never stores document bytes.
- **Heavy deps are peerDependencies.** The pure engine is dependency-free; the optional
  `@scandoc/core/ocr` subpath declares `tesseract.js` + `pdfjs-dist` as (optional) peers,
  injected by the app. A future review UI would take `react` as a peer, never bundle it.

## Develop

```bash
npm install
npm run build      # tsup → dist/ (cjs + esm + d.ts)
npm test           # vitest (pure unit tests, node env)
```

> Status: extracted from `myHealth/src/import/` (the generic normalize/fuzzy/confidence
> engine) plus the recognition seam, now with a **free Tesseract recognizer**
> (`@scandoc/core/ocr`). A heavier capture pipeline (quality gate, image normalization,
> PaddleOCR/VLM) can still implement `Recognizer` later.
