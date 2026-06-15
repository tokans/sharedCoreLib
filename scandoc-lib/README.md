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
  and `nativeTextRecognizer()`. This is the **seam** where a real local OCR sidecar will
  plug in later; **no OCR engine ships yet**.
- **`field`** — an OPTIONAL `Field<T>` + `fieldFrom` contract for new extractors to share
  one confidence-tiered field shape.

It carries **no domain knowledge** — no drug formulary, no lab vocabulary, no document
categories. Apps supply those (e.g. myHealth keeps `formulary.ts` / `labVocab.ts` /
`extractPrescription` / `extractLab` in-app). It also carries **no OCR engine, no capture
pipeline** — those are the future sidecar that implements `Recognizer`.

## Discipline (mirrors the suite CONTRACT)

- **Pure / dependency-injected, no module globals.** Plain functions + an injected
  `Recognizer`. No DB, no network, no models, no LLM, no React.
- **No egress** (suite invariants #1/#7). A real recognizer must run fully local/offline;
  this lib never persists or transmits, and never stores document bytes.
- **Heavy deps would be peerDependencies.** None today (the engine is dependency-free); a
  future review UI would take `react` as a peer, never bundle it.

## Develop

```bash
npm install
npm run build      # tsup → dist/ (cjs + esm + d.ts)
npm test           # vitest (pure unit tests, node env)
```

> Status: extracted from `myHealth/src/import/` (the generic normalize/fuzzy/confidence
> engine) plus the new recognition seam. The OCR/recognition sidecar (capture quality
> gate, image normalization, native-PDF text, PaddleOCR/Tesseract) is **not built** — it
> implements `Recognizer` when it lands.
