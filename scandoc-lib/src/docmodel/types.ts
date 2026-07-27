/**
 * The DocModel: a positionless, nested, document-shaped representation of
 * *any* extracted document — the single contract a consuming app maps onto
 * its own domain types.
 *
 * The deliberate constraint is that NOTHING here carries x/y geometry. Glyph
 * coordinates are an artifact of how a PDF happens to be drawn; they are the
 * builder's INPUT (see `positional.ts`) and they belong in a debug dump, not
 * in the structure a domain parser reads. Every previous generation of this
 * pipeline handed positional rows straight to domain parsers, which is why
 * every one of them ended up re-implementing header detection, indent
 * nesting, row folding and page-furniture stripping for itself.
 *
 * Provenance is preserved without geometry via `DocRef` — enough to point a
 * debug dump or a review UI back at the source rows, not enough to let a
 * consumer start doing geometry again.
 */

/** Where a node came from in the interim positional document. `rows` is a
 *  `[start, end)` range of flat indexes into `PositionalDoc.rows`, so a debug
 *  dump or review UI can jump straight to the source geometry; `page` is the
 *  0-based page (or sheet, or the single synthetic page delimited text
 *  produces) the node starts on, for human readability. */
export interface DocRef {
  page: number;
  rows: [number, number];
}

/**
 * A leaf value — always the source text, never coerced.
 *
 * Coercion here would be lossy in exactly the places that matter: an account
 * number or challan serial loses its leading zeros, a "1,00,000" loses the
 * grouping that identifies its locale, a "5,000.00 CR" loses its sign marker.
 * The app already owns amount and date parsing (it has to — those rules are
 * locale-specific), so the builder classifies cells as data-shaped without
 * ever converting them. That is why `DocModelOptions.parseNumber` exists and
 * why its result is discarded after the header-versus-data decision.
 */
export type DocValue = string | null;

/**
 * One row of a table with a detected header, keyed by that header's own text.
 *
 * `children` is how a table-within-a-table is represented: a sub-table that
 * the source document prints *underneath* one data row (Form 26AS prints a
 * per-transaction breakup under every deductor; AIS prints a source-wise
 * detail table under every category) is attached to the record it belongs to,
 * rather than being flattened into sibling rows of the outer table or dropped
 * as unrecognized noise.
 */
export interface DocRecord {
  cells: Record<string, DocValue>;
  /**
   * The row's printed cells, in reading order, before they were keyed by
   * header.
   *
   * Keying by header is lossy whenever a document's columns are packed
   * tighter than its header spans — several cells then land in one column and
   * are joined, so `"1"` and `"2025-26"` arrive as `"1 2025-26"` and neither
   * is recoverable by splitting (a value can legitimately contain spaces).
   * That is not an edge case in this corpus: tax and bank exports routinely
   * glue a serial number onto a year, or an amount onto a code.
   *
   * A mapper that needs to anchor on an exact token (a financial-year cell, a
   * fixed-format identifier) reads these instead. This is reading ORDER, not
   * geometry — no coordinate survives here.
   */
  parts: string[];
  /**
   * Text from this row's region that belonged to no column — a cell too far
   * from every header, or a line the caller's `continuation` hook classified
   * as noise inside the table.
   *
   * Present so the builder never has to choose between corrupting a keyed
   * cell and dropping content: neither is acceptable, and a mapper that cares
   * can look. Absent when there was none.
   */
  unmatched?: string[];
  children?: DocNode[];
}

export interface DocTable {
  kind: "table";
  /** The nearest preceding heading-ish row, when one was found immediately
   *  above the header — many tables are introduced by a caption line that is
   *  not itself a section heading for anything else. */
  title?: string;
  headers: string[];
  records: DocRecord[];
  ref: DocRef;
}

/** One key/value pair from a headerless two-column region. */
export interface DocProperty {
  key: string;
  value: DocValue;
  /**
   * Any further values on the same row, in printed order.
   *
   * A headerless row is not limited to two columns — a comparative-year
   * figure, a running total, a Gross/Qualifying/Deductible trio. Keeping only
   * one of them silently dropped the rest, which for a row like
   * "Q1 <ref> <paid> <deducted> <deposited>" meant losing a real figure with
   * no warning anywhere.
   */
  extras?: string[];
  children?: DocNode[];
}

/**
 * A headerless region whose rows carry (label, value) — the shape of a
 * computation sheet's line items, a document's identity block ("PAN of
 * Assessee: ABCDE1234F"), a summary panel. Distinct from `DocTable` because
 * there is no header row to key records by: here the FIRST populated cell is
 * the key and the remaining populated cell is the value.
 */
export interface DocProperties {
  kind: "properties";
  title?: string;
  entries: DocProperty[];
  ref: DocRef;
}

/** A titled region containing other nodes. Nesting comes from the source
 *  document's own indentation and heading hierarchy; `level` is the resolved
 *  depth (0 = top level), not a raw indent measurement. */
export interface DocSection {
  kind: "section";
  title: string;
  level: number;
  children: DocNode[];
  ref: DocRef;
}

/**
 * Free-standing text that belonged to no table and no key/value region — a
 * disclaimer paragraph, a note, an unrecognized layout.
 *
 * This node exists so the model can honestly claim to capture EVERYTHING in
 * the document. A builder that silently drops what it doesn't understand
 * produces a model whose absences are indistinguishable from a document that
 * genuinely lacked that content, which is precisely the failure mode
 * (silent data loss on an unrecognized section) this pipeline has hit before.
 */
export interface DocText {
  kind: "text";
  text: string;
  ref: DocRef;
}

export type DocNode = DocSection | DocTable | DocProperties | DocText;

/** What the document was before it was structured — carried through so a
 *  mapper can, for instance, treat a spreadsheet-sourced statement slightly
 *  differently from a PDF-sourced one without re-sniffing the file. */
export type DocSourceKind = "pdf" | "xlsx" | "xls" | "txt" | "csv";

export interface DocModel {
  source: {
    filename: string;
    kind: DocSourceKind;
    /** Pages for a PDF, sheets for a workbook, 1 for delimited text. */
    pages: number;
  };
  children: DocNode[];
  /** Structural observations worth surfacing during review (a table whose
   *  rows didn't all align to its header, a region that stayed unstructured).
   *  NOT domain warnings — a mapper adds its own on top. */
  warnings: string[];
}

/**
 * Everything the builder needs that is locale- or corpus-specific, injected
 * by the consuming app (CONTRACT §5: DI factories, no module-level globals,
 * no domain strings baked into the library).
 */
export interface DocModelOptions {
  /** Returns a number when the cell text IS one, else null. Drives the
   *  header-vs-data decision throughout the builder, so its strictness
   *  matters: a `parseNumber` that accepts bare years will read a date column
   *  header as data. */
  parseNumber: (text: string) => number | null;
  /** Returns a normalized date when the cell text is one, else null. Used
   *  only to keep date cells from being mistaken for headers; the builder
   *  emits the ORIGINAL text, never the normalized date, so a mapper stays
   *  in control of date interpretation. */
  parseDate?: (text: string) => string | null;
  /** Text matching any of these is stripped from every cell before
   *  structuring — the "same footer, different page number every time" class
   *  of page furniture that verbatim-repeat detection cannot catch. */
  stripPatterns?: RegExp[];
  /**
   * What a text-only row inside a table means. Defaults to `"fold"` — the
   * previous record's wrapped continuation.
   *
   * Three outcomes rather than a yes/no, because "not a continuation" is two
   * genuinely different situations and picking the wrong one loses data:
   *  - `"skip"` — noise inside the table (a nested sub-table's ALL-CAPS
   *    header). The table CONTINUES; the text is preserved on the preceding
   *    record's `unmatched` rather than glued into a keyed cell.
   *  - `"break"` — the table is over and something else begins (a section
   *    banner). Ending here is what stops the rows after it being read as
   *    more of this table.
   *
   * Only the caller can tell these apart, and the answer differs by document:
   * an ALL-CAPS line under an AIS category is a sub-table header to skip,
   * while the same shape under a bank-statement narration is the rest of the
   * narration and must fold.
   */
  continuation?: (text: string) => "fold" | "skip" | "break";
  /**
   * What to put between a value and the wrapped line folded onto it.
   * Defaults to a space.
   *
   * Bank statements need `""`: a narration that overflows its line wraps
   * wherever the column ends, frequently mid-word, so
   * `"SOME MERCHANT SERVICE-CF.DUM"` continues as `"MYCOMPANYNAME REF00001"`
   * and a space would corrupt the reference. Tax documents wrap at word
   * boundaries and need the space. Neither is a safe default for the other,
   * so the caller says which.
   */
  foldSeparator?: string;
  /** A row whose full text repeats at least this many times verbatim across
   *  the document is page furniture and is dropped. A genuine data row is
   *  made unique by its own date/amount, so verbatim recurrence is a reliable
   *  corpus-independent signal. */
  boilerplateMinRepeats?: number;
  /** How far apart two rows' first-cell x positions can be and still count
   *  as the same indent level. Source-unit dependent (PDF points vs. the
   *  synthetic 100-unit slots a spreadsheet/delimited row uses), so callers
   *  adapting non-PDF input should scale it. */
  indentTolerance?: number;
  /** Minimum populated, non-numeric cells for a row to be considered a table
   *  header rather than a heading or a key/value line. */
  headerMinCells?: number;
  /**
   * How a section decides it has ended.
   *
   * `"headings-only"` (default): only another heading closes a section;
   * content always attaches to the innermost open one, in reading order.
   * Required by formats whose headings are indented but whose content is
   * not — Form 26AS's text export brackets every part heading in the field
   * delimiter (`^PART-I - Details...^`), so the heading sits one synthetic
   * column to the right of the table it introduces. Under indent nesting
   * that table would close the very section it belongs to.
   *
   * `"indent"`: a content block further left than the open section's heading
   * also closes it. Correct for documents that genuinely indent content
   * under its heading — a CA's computation sheet, where a trailing "Total
   * Income" line at the left margin really does belong outside the schedule
   * printed above it.
   */
  sectionNesting?: "headings-only" | "indent";
}
