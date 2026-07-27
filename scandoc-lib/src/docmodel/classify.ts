/**
 * Per-row feature extraction. Deliberately does NOT decide what a row IS —
 * that decision is contextual (a text-only 3-cell row is a header if data
 * rows follow it and a data row if it follows a header), so it belongs to the
 * block grouper. This module only measures.
 */
import type { DocModelOptions } from "./types";
import { indentOf, populated, rowSignature, rowText, type PositionalCell, type PositionalRow } from "./positional";

export interface RowFeatures {
  row: PositionalRow;
  cells: PositionalCell[];
  /** Populated cells that parsed as a number. */
  numericCount: number;
  /** Populated cells that parsed as a date (and not as a number). Counted
   *  separately because a date is data, but unlike a number it frequently
   *  appears in a cell a naive numeric parser would reject. */
  dateCount: number;
  /** Populated cells that are neither — labels, names, headers. */
  textCount: number;
  indent: number;
  signature: string;
  text: string;
  blank: boolean;
}

export function analyze(rows: PositionalRow[], opts: DocModelOptions): RowFeatures[] {
  const parseDate = opts.parseDate ?? (() => null);
  return rows.map((row) => {
    const cells = populated(row);
    let numericCount = 0;
    let dateCount = 0;
    for (const cell of cells) {
      const t = cell.text.trim();
      if (opts.parseNumber(t) !== null) numericCount++;
      else if (parseDate(t) !== null) dateCount++;
    }
    return {
      row,
      cells,
      numericCount,
      dateCount,
      textCount: cells.length - numericCount - dateCount,
      indent: indentOf(row),
      signature: rowSignature(row),
      text: rowText(row),
      blank: cells.length === 0,
    };
  });
}

/** A row that could introduce a table: enough populated cells to have
 *  columns, and no data-shaped cell among them. A header stating a units
 *  caption ("Amount (Rs.)") stays a header because that is text, not a
 *  parsed number. */
export function isHeaderShaped(f: RowFeatures, opts: DocModelOptions): boolean {
  const minCells = opts.headerMinCells ?? 2;
  return !f.blank && f.cells.length >= minCells && f.numericCount === 0 && f.dateCount === 0;
}

/** A row carrying at least one data-shaped cell — the positive signal that
 *  something is a record rather than structure. */
export function isDataShaped(f: RowFeatures): boolean {
  return !f.blank && f.numericCount + f.dateCount > 0;
}

/** A lone label with nothing beside it: a section title, a caption, or a
 *  wrapped continuation of the line above. Which of those it is depends on
 *  what follows, so the grouper decides; this only recognizes the shape. */
export function isStandaloneLabel(f: RowFeatures): boolean {
  return !f.blank && f.cells.length === 1 && f.numericCount === 0 && f.dateCount === 0;
}
