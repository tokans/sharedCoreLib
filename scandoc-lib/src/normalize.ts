/**
 * Text normalization for the document-reading pipeline. Operates on text that has
 * *already* been recognized (native-text PDF extraction or OCR — that upstream
 * recognition stage is the `Recognizer` seam in `recognize.ts`, sidecar not yet
 * built). These helpers clean the recognized string before domain-constrained
 * extraction. Pure and deterministic — no DB, no network, no models, no LLM.
 */

/** Collapse runs of whitespace (incl. NBSP) to single spaces and trim. */
export function collapseWhitespace(s: string): string {
  return s.replace(/[\s ]+/g, " ").trim();
}

/** Split into non-empty, whitespace-collapsed lines. */
export function splitLines(text: string): string[] {
  return text
    .split(/\r?\n/)
    .map(collapseWhitespace)
    .filter((l) => l.length > 0);
}

/** Lowercase, strip everything but a–z0–9 — the comparison key for fuzzy match. */
export function normalizeToken(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Coerce a token that *should* be numeric back to digits, undoing the OCR
 * letter↔digit confusions that dominate real scans (O→0, l/I→1, S→5, B→8, Z→2,
 * g→9). Only applied where a number is expected (strengths, lab values), never to
 * a name token, so we don't corrupt real letters.
 */
export function digitsFromOcr(s: string): string {
  return s.replace(/[OoIlSBZg]/g, (c) => {
    switch (c) {
      case "O":
      case "o":
        return "0";
      case "I":
      case "l":
        return "1";
      case "S":
        return "5";
      case "B":
        return "8";
      case "Z":
        return "2";
      case "g":
        return "9";
      default:
        return c;
    }
  });
}

/** Parse an OCR-tolerant number ("l3.5", "O.5", "1,250"), or null if none. */
export function parseOcrNumber(raw: string): number | null {
  const cleaned = digitsFromOcr(raw).replace(/,/g, "").trim();
  const m = cleaned.match(/-?\d+(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

const LINE_MARKERS = /^\s*(?:\d+[.)]\s*|[-*•·]\s*|Rx\b[.:]?\s*)/i;
const FORM_PREFIX = /^\s*(tab\.?|tablet|cap\.?|capsule|syp\.?|syr\.?|syrup|inj\.?|injection|drops?|cream|oint\.?|ointment|susp\.?|suspension)\s+/i;

/** Strip a leading list marker ("1.", "- ", "• ", "Rx ") from a line. */
export function stripLineMarker(line: string): string {
  return line.replace(LINE_MARKERS, "").trim();
}

/** Strip a leading dosage-form word ("Tab.", "Cap", "Syrup") and report it. */
export function stripFormPrefix(line: string): { rest: string; form: string | null } {
  const m = line.match(FORM_PREFIX);
  if (!m) return { rest: line, form: null };
  return { rest: line.slice(m[0].length).trim(), form: canonicalForm(m[1]) };
}

/** Map a recognized form word to its canonical dosage form. */
export function canonicalForm(word: string): string {
  const k = normalizeToken(word);
  if (k.startsWith("tab")) return "tablet";
  if (k.startsWith("cap")) return "capsule";
  if (k.startsWith("sy")) return "syrup";
  if (k.startsWith("inj")) return "injection";
  if (k.startsWith("drop")) return "drops";
  if (k.startsWith("oint")) return "ointment";
  if (k.startsWith("cream")) return "cream";
  if (k.startsWith("susp")) return "suspension";
  return k;
}
