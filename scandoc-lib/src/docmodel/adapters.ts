/**
 * Adapters that turn non-PDF sources into the same interim `PositionalDoc`
 * the PDF extractor produces, so one structuring pipeline serves every input.
 *
 * The trick that makes this work is that "x position" need not come from a
 * glyph. A spreadsheet column and a delimited field are already unambiguous
 * columns; giving them evenly spaced synthetic slots wide enough apart that
 * gap-based merging never joins two of them lets the entire downstream
 * pipeline — header detection, column snapping, indent nesting — run
 * unmodified on input that never had geometry at all.
 *
 * Empty leading fields are deliberately preserved as slots rather than
 * collapsed, because in several real formats they ARE the nesting signal:
 * Form 26AS's text export marks every row of a deductor's embedded
 * per-transaction table with a leading empty field, which becomes exactly the
 * indent that `isNestedHeader` reads.
 */
import { fromNativeRows, type PositionalCell, type PositionalDoc, type PositionalRow } from "./positional";

/** Horizontal spacing between synthetic columns, and the width each occupies.
 *  The 10-unit gutter is wide enough that nothing merges and narrow enough
 *  that a cell always falls inside its own column's span. */
export const COLUMN_SLOT = 100;
export const CELL_WIDTH = 90;

/** Indent tolerance appropriate for synthetic slots — half a slot, so one
 *  empty leading field reads as one level of nesting and jitter reads as
 *  none. PDF points need a far smaller value (see `DocModelOptions`). */
export const GRID_INDENT_TOLERANCE = COLUMN_SLOT / 2;

export interface Grid {
  /** Sheet name, or undefined for delimited text. Emitted as a leading
   *  single-cell row so it becomes a section heading covering that sheet. */
  name?: string;
  rows: (string | number | null)[][];
}

function toCells(row: (string | number | null)[]): PositionalCell[] {
  const cells: PositionalCell[] = [];
  row.forEach((value, columnIndex) => {
    const text = value == null ? "" : String(value).trim();
    if (!text) return; // empty slots carry position, not content
    cells.push({ text, x: columnIndex * COLUMN_SLOT, width: CELL_WIDTH });
  });
  return cells;
}

/** One page per grid. A named grid contributes a heading row so a workbook's
 *  sheet names survive into the model as sections. */
export function fromGrids(grids: Grid[]): PositionalDoc {
  const rows: PositionalRow[] = [];
  grids.forEach((grid, page) => {
    let row = 0;
    if (grid.name) {
      rows.push({ page, row: row++, cells: [{ text: grid.name, x: 0, width: CELL_WIDTH }] });
    }
    for (const raw of grid.rows) {
      rows.push({ page, row: row++, cells: toCells(raw) });
    }
  });
  return { rows, pages: Math.max(grids.length, 1) };
}

/** Delimiters worth trying, in no particular order — scoring picks the
 *  winner. Comma is excluded by default: it appears inside real values
 *  (amounts with thousands grouping, addresses) far too often to be told
 *  apart from a separator by frequency alone, and a caller that knows it has
 *  a CSV can pass it explicitly. */
export const DEFAULT_DELIMITERS = ["^", "\t", "|", "~", ";"];

/**
 * Picks whichever candidate actually separates fields, by consistency rather
 * than raw frequency: the real delimiter produces a stable field count across
 * most lines, whereas a character that merely appears often produces a
 * scattered one. Falls back to a run of two-or-more spaces, which is what
 * fixed-width text reports use, and finally to single-column rows.
 */
export function detectDelimiter(text: string, candidates: string[] = DEFAULT_DELIMITERS): string | RegExp | null {
  const lines = text.split(/\r?\n/).filter((l) => l.trim() !== "");
  if (lines.length === 0) return null;
  const sample = lines.slice(0, 200);

  let best: { delimiter: string | RegExp; score: number } | null = null;
  const score = (delimiter: string | RegExp): number => {
    const counts = sample.map((l) => l.split(delimiter).length);
    const multi = counts.filter((n) => n > 1);
    // One line is enough evidence when it is all there is — a single
    // delimited row is a legitimate (if small) input, and demanding two
    // rejected it outright.
    if (multi.length < Math.max(1, sample.length * 0.3)) return 0;
    // Reward the mode's share of lines: a genuine delimiter yields the same
    // field count on most rows of a table.
    const tally = new Map<number, number>();
    for (const n of multi) tally.set(n, (tally.get(n) ?? 0) + 1);
    const modeShare = Math.max(...tally.values()) / sample.length;
    return modeShare * multi.length;
  };

  for (const candidate of [...candidates, /\s{2,}/]) {
    const s = score(candidate);
    if (s > 0 && (!best || s > best.score)) best = { delimiter: candidate, score: s };
  }
  return best?.delimiter ?? null;
}

export interface DelimitedOptions {
  delimiter?: string | RegExp;
  candidates?: string[];
}

/** Turns a plain-text export into a positional grid. Blank lines are kept as
 *  empty rows: they separate blocks, and dropping them merges regions the
 *  document meant to keep apart. */
export function fromDelimitedText(text: string, opts: DelimitedOptions = {}): PositionalDoc {
  const delimiter = opts.delimiter ?? detectDelimiter(text, opts.candidates);
  const lines = text.split(/\r?\n/);
  const grid: (string | null)[][] = lines.map((line) =>
    delimiter === null ? [line] : line.split(delimiter).map((f) => f.trim()),
  );
  return fromGrids([{ rows: grid }]);
}

/**
 * What a document-intake layer hands over: reconstructed PDF rows, sheet
 * grids, or raw text.
 *
 * Declared structurally rather than imported so this package and whatever
 * produces the extraction (in this suite, `sharedcorelib/docintake`) compose
 * without either depending on the other — one is a pure text-processing
 * engine, the other reaches for native and crypto capabilities, and coupling
 * them would drag those into every consumer of this one.
 */
export type Extraction =
  | { kind: "pdf"; rows: { page_index: number; row_index: number; cells: PositionalCell[] }[] }
  | { kind: "grid"; grids: Grid[] }
  | { kind: "text"; text: string };

/** Normalizes any extraction into the interim positional document. */
export function fromExtraction(extraction: Extraction, opts: DelimitedOptions = {}): PositionalDoc {
  switch (extraction.kind) {
    case "pdf":
      return fromNativeRows(extraction.rows);
    case "grid":
      return fromGrids(extraction.grids);
    case "text":
      return fromDelimitedText(extraction.text, opts);
  }
}

/** The indent tolerance appropriate to an extraction's coordinate space —
 *  PDF points are tight, synthetic grid slots are an order of magnitude
 *  wider. Getting this wrong silently flattens or over-nests every section,
 *  so it is derived rather than left to each caller to remember. */
export function indentToleranceFor(extraction: Extraction, pdfTolerance = 8): number {
  return extraction.kind === "pdf" ? pdfTolerance : GRID_INDENT_TOLERANCE;
}
