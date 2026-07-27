/**
 * The INTERIM positional document — geometry-reconstructed rows and cells,
 * exactly what a PDF text-extraction pass (or a spreadsheet/delimited-text
 * adapter) produces before any structure is inferred.
 *
 * This is a debug artifact and a builder input, never a consumer contract.
 * Apps dump it to a diagnostic log so a real-world parse failure can be
 * inspected from the raw geometry; they must not map domain types off it
 * directly (that is what `DocModel` is for). The distinction is the whole
 * point of this module's existence: geometry in, structure out.
 */

/** One reconstructed cell: text plus the horizontal span it occupied.
 *  Mirrors the Rust `TableCell` that the PDFium-backed extractor serializes,
 *  and the synthetic spans that spreadsheet/delimited adapters fabricate. */
export interface PositionalCell {
  text: string;
  x: number;
  width: number;
}

export interface PositionalRow {
  /** 0-based page (PDF), sheet (workbook), or 0 for delimited text. */
  page: number;
  /** 0-based index of this row WITHIN its page. */
  row: number;
  cells: PositionalCell[];
}

export interface PositionalDoc {
  rows: PositionalRow[];
  pages: number;
}

/** The wire shape the native PDF extractor emits (serde snake_case). Adapted
 *  rather than used directly so the library's own types stay idiomatic and a
 *  future extractor with a different wire format only needs a new adapter. */
export interface NativeTableRow {
  page_index: number;
  row_index: number;
  cells: PositionalCell[];
}

export function fromNativeRows(rows: NativeTableRow[]): PositionalDoc {
  const pages = new Set<number>();
  for (const r of rows) pages.add(r.page_index);
  return {
    rows: rows.map((r) => ({ page: r.page_index, row: r.row_index, cells: r.cells })),
    pages: pages.size,
  };
}

/** Cells with actual content, trimmed. Blank cells carry no information for
 *  structuring — only their absence does, and that is read from the count. */
export function populated(row: PositionalRow): PositionalCell[] {
  return row.cells.filter((c) => c.text.trim() !== "");
}

export function isBlank(row: PositionalRow): boolean {
  return populated(row).length === 0;
}

/** The row's full text, single-spaced. */
export function rowText(row: PositionalRow): string {
  return populated(row)
    .map((c) => c.text.trim())
    .join(" ");
}

/** The row's left edge — its indentation. The only geometric quantity the
 *  builder consults for hierarchy, and it never escapes into the DocModel:
 *  it is resolved to an integer `level` during the build. */
export function indentOf(row: PositionalRow): number {
  const cells = populated(row);
  return cells.length ? cells[0].x : 0;
}

/** A whitespace- and case-normalized signature used for equality between
 *  rows: repeated-header detection (the same header reprinted at every page
 *  break must CONTINUE a table, not start a new one) and verbatim-repeat
 *  page-furniture detection both key off this. */
export function rowSignature(row: PositionalRow): string {
  return populated(row)
    .map((c) => c.text.trim().toLowerCase().replace(/\s+/g, " "))
    .join("|");
}

/** Rewrites every cell with `fn`, dropping cells that end up empty. Used to
 *  strip pattern-matched page furniture (see `DocModelOptions.stripPatterns`)
 *  that is glued onto a real cell rather than occupying a row of its own. */
export function mapCells(doc: PositionalDoc, fn: (text: string) => string): PositionalDoc {
  return {
    pages: doc.pages,
    rows: doc.rows.map((r) => ({
      ...r,
      cells: r.cells.map((c) => ({ ...c, text: fn(c.text) })).filter((c) => c.text.trim() !== ""),
    })),
  };
}
