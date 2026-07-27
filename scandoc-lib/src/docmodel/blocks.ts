/**
 * Grouping analyzed rows into structural blocks — the step that decides what
 * each region of the document IS.
 *
 * The decisions are contextual, which is why they can't live in `classify.ts`:
 * a text-only three-cell row is a table header when data rows follow it and a
 * key/value line when they don't; a text-only row inside a table is a wrapped
 * continuation of the row above, but the same row outside a table is a
 * section heading. Every domain parser in the consuming app used to make
 * these calls for itself, with its own thresholds and its own bugs.
 */
import { alignRow, alignmentScore, nearestColumn, type Column } from "./align";
import { isDataShaped, isHeaderShaped, isStandaloneLabel, type RowFeatures } from "./classify";
import type { DocModelOptions } from "./types";

/** How many consecutive text-only rows may fold onto the record above before
 *  the table is declared over. A genuine wrapped narration or deductor name
 *  runs to one, occasionally two lines; a restated letterhead/address block
 *  between pages has the same "no identifying field" shape but runs on for
 *  many, and without a cap it glues itself onto an increasingly wrong record. */
const MAX_CONSECUTIVE_FOLDS = 2;

/** How far ahead to look for the data row that would confirm a candidate
 *  header, before concluding nothing follows it. */
const HEADER_CONFIRM_LOOKAHEAD = 6;

/** How many rows after a header may still be part of that header. Real
 *  multi-line headers run to two, occasionally three, physical lines. */
const HEADER_WRAP_LOOKAHEAD = 3;

/** How far past an interruption to look for the table resuming. A restated
 *  letterhead or address block runs to a handful of lines. */
const RESUME_LOOKAHEAD = 8;

export interface RawRecord {
  cells: Record<string, string>;
  /** The row's printed cell texts in reading order — see `DocRecord.parts`. */
  parts: string[];
  /** Cell text that landed in no column — kept so a mapper can see it rather
   *  than the builder deciding on its behalf that it was noise. */
  unmatched: string[];
  children: Block[];
}

export interface RawProperty {
  key: string;
  value: string | null;
  extras: string[];
}

interface BlockBase {
  indent: number;
  page: number;
  /** `[start, end)` flat indexes into the interim `PositionalDoc.rows`. */
  rows: [number, number];
}

export type Block =
  | (BlockBase & { kind: "heading"; text: string })
  | (BlockBase & { kind: "table"; columns: Column[]; records: RawRecord[] })
  | (BlockBase & { kind: "properties"; entries: RawProperty[] })
  | (BlockBase & { kind: "text"; text: string });

type SigIndex = Map<string, number[]>;

function buildSigIndex(features: RowFeatures[]): SigIndex {
  const index: SigIndex = new Map();
  features.forEach((f, i) => {
    if (!f.signature) return;
    const list = index.get(f.signature);
    if (list) list.push(i);
    else index.set(f.signature, [i]);
  });
  return index;
}

/** Header cell text becomes the record key, so duplicates (two "Amount"
 *  columns) must be disambiguated or the second silently overwrites the
 *  first. Suffixing preserves both and keeps the original text readable. */
function buildColumns(f: RowFeatures): Column[] {
  const seen = new Map<string, number>();
  return f.cells.map((cell) => {
    const base = cell.text.trim();
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    return { text: n > 1 ? `${base} (${n})` : base, x: cell.x, width: cell.width };
  });
}

/**
 * Whether a header-shaped row genuinely introduces a table.
 *
 * Two independent pieces of evidence, either sufficient:
 *  - the same row recurs elsewhere in the document — only a table header
 *    gets reprinted verbatim (page-break reprints), and page furniture that
 *    also recurs was already removed upstream;
 *  - a data-shaped row follows shortly and its cells land in this row's
 *    columns.
 *
 * The second check is what keeps a two-cell identity line ("PAN of Assessee |
 * ABCDE1234F", followed by more of the same) from being read as a table
 * header with one garbage record: those rows carry no number and no date, so
 * nothing ever confirms the header, and the region falls through to key/value.
 */
function looksLikeTableHeader(index: number, features: RowFeatures[], sigIndex: SigIndex, opts: DocModelOptions): boolean {
  const f = features[index];
  if (!isHeaderShaped(f, opts)) return false;
  if ((sigIndex.get(f.signature)?.length ?? 0) > 1) return true;

  const columns = buildColumns(f);
  for (let j = index + 1; j < features.length && j - index <= HEADER_CONFIRM_LOOKAHEAD; j++) {
    const g = features[j];
    if (g.blank) continue;
    if (isDataShaped(g)) return alignmentScore(g.cells, columns) >= Math.min(2, columns.length);
    if (isHeaderShaped(g, opts)) {
      // Another header-shaped row before any data. Usually that means neither
      // governs a table — two adjacent key/value lines ("PAN | ...", then
      // "Name | ...") look exactly like this, and reading the first as a
      // header would turn the second into one garbage record.
      //
      // Unless it is NARROWER and adjacent, in which case it is this header's
      // own wrapped second line: Form 26AS prints a six-column header and
      // then a two-cell row carrying the tails of two of those labels. Keep
      // scanning for the data row past a line of that shape only.
      if (g.cells.length < f.cells.length && j - index <= HEADER_WRAP_LOOKAHEAD) continue;
      return false;
    }
  }
  return false;
}

/**
 * Whether a header encountered *inside* an open table nests under it (a
 * sub-table printed beneath one record, as Form 26AS prints a per-transaction
 * breakup under every deductor) rather than ending it.
 *
 * `ancestors` is checked first and is what makes the recursion terminate: a
 * sub-table's own scan will eventually meet the enclosing table's header
 * again, and by the "outer resumes later" rule below that header would look
 * nested inside the sub-table, nesting the two into each other forever.
 * Seeing an ancestor's signature means we are unwinding, not descending.
 */
function isNestedHeader(
  index: number,
  features: RowFeatures[],
  outer: RowFeatures,
  sigIndex: SigIndex,
  opts: DocModelOptions,
  ancestors: string[],
  dataIndent: number | null,
): boolean {
  const f = features[index];
  if (ancestors.includes(f.signature)) return false;
  const tolerance = opts.indentTolerance ?? 8;
  if (f.indent > outer.indent + tolerance) return true;
  if ((sigIndex.get(outer.signature) ?? []).some((idx) => idx > index)) return true;

  // Neither the header nor a later reprint of the outer header settles it, so
  // look at the rows the candidate governs: if they are indented relative to
  // this table's own data rows, they belong to a sub-table.
  //
  // Without this, a breakup nests only when the outer header happens to be
  // reprinted after it — which is true for every deductor in a Form 26AS
  // EXCEPT the last one, whose transactions would silently become top-level
  // rows of the deductor table.
  if (dataIndent === null) return false;
  for (let j = index + 1; j < features.length; j++) {
    if (features[j].blank) continue;
    if (!isDataShaped(features[j])) continue;
    return features[j].indent > dataIndent + tolerance;
  }
  return false;
}

/**
 * Whether the next non-blank row after `index` opens a DIFFERENT table —
 * which makes the row at `index` that table's caption or section heading,
 * never the wrapped tail of the record above it.
 *
 * `currentHeaderSig` is what keeps this from firing on the most ordinary
 * wrap there is. A label that overflows at the bottom of a page is followed
 * immediately by the same table's header, reprinted at the top of the next
 * page; treating that reprint as "a new table starts here" would break the
 * table at every page boundary and orphan the continuation line as a section
 * heading. A reprint of the header we are already inside is a continuation,
 * not a new table.
 */
function startsNewTable(
  index: number,
  features: RowFeatures[],
  sigIndex: SigIndex,
  opts: DocModelOptions,
  currentHeaderSig: string,
): boolean {
  for (let j = index + 1; j < features.length; j++) {
    if (features[j].blank) continue;
    if (features[j].signature === currentHeaderSig) return false;
    return looksLikeTableHeader(j, features, sigIndex, opts);
  }
  return false;
}

/**
 * Folds a text-only row onto the record above it. Cells that land in a column
 * extend that column's value, which beats the older per-parser convention of
 * always appending to the name column: a wrapped narration lands under the
 * description, a wrapped deductor name under the deductor.
 *
 * With one correction — a fold never extends a cell holding a NUMBER.
 * Amounts do not wrap, so stray text landing in an amount column's x-band (a
 * reference code, a footnote marker) is not a continuation of that figure;
 * appending it would turn a parseable amount into an unparseable string and
 * silently zero the row. Such text is redirected to the first non-numeric
 * column, which is where a wrap actually belongs.
 */
function foldOnto(record: RawRecord, f: RowFeatures, columns: Column[], opts: DocModelOptions): void {
  const separator = opts.foldSeparator ?? " ";
  const parseDate = opts.parseDate ?? (() => null);
  const isNumeric = (text: string | undefined): boolean => text != null && opts.parseNumber(text) !== null;
  // Where redirected text goes. Neither a number nor a date can be continued
  // by a wrapped line, and appending to either destroys it — gluing a stray
  // fragment onto "01/04/2026" yields "01/04/2026Page No: 1", which no longer
  // parses as a date, silently dropping the whole transaction. The narration
  // column is the only place a wrap belongs.
  const isDataLike = (text: string | undefined): boolean =>
    text != null && (isNumeric(text) || parseDate(text) !== null);
  const textColumn = columns.find((c) => !isDataLike(record.cells[c.text]));
  const append = (key: string, text: string): void => {
    record.cells[key] = record.cells[key] ? `${record.cells[key]}${separator}${text}` : text;
  };

  record.parts.push(...f.cells.map((c) => c.text.trim()).filter(Boolean));

  const { matched, unmatched } = alignRow(f.cells, columns);

  // Whether this row carried anything that is plainly narration — text that
  // landed on a column not already holding a number or a date, or text that
  // landed nowhere at all.
  //
  // That decides what to do with the rest. A row whose ONLY content sits on
  // an amount column is the wrapped label itself, drifting into a neighbour's
  // x band, and belongs on the narration ("Ref: XYZ" continuing a deductor's
  // name). A row that ALREADY contributed narration and additionally dropped
  // something on an amount column is carrying a stray fragment beside it — a
  // page number, a footnote marker — and appending that to the narration
  // would pollute a description on every page of the document.
  const carriesNarration =
    unmatched.length > 0 || Object.keys(matched).some((key) => !isDataLike(record.cells[key]));

  for (const [key, text] of Object.entries(matched)) {
    if (isDataLike(record.cells[key])) {
      if (carriesNarration) record.unmatched.push(text);
      else if (textColumn) append(textColumn.text, text);
      continue;
    }
    append(key, text);
  }
  if (unmatched.length && columns.length) {
    append((textColumn ?? columns[0]).text, unmatched.join(separator));
  }
}

/**
 * Whether every cell of a candidate header-wrap line sits within (plus a
 * little slack) the x-range the header's own columns actually span.
 *
 * A genuine wrapped column label is printed directly above the column(s) it
 * labels, so it is always at least as narrow as the header it extends. A
 * section banner or restated identity line ("----- Annexure to ... -----",
 * a reprinted PAN/name block) can independently satisfy the cardinality-only
 * `shapedLikeHeaderWrap` shape test above — fewer cells, no data, printed
 * shortly after something that looked like a header — while spanning most or
 * all of the page width, far wider than the header it would be "wrapping".
 * Without this check that banner gets glued onto the nearest column instead
 * of surviving as its own heading, which silently deletes the one section
 * boundary a mapper relies on to avoid double-counting a restated section
 * (verified against a real TIS export: the "Annexure" banner was swallowed
 * this way, so its whole restated section read as new income on top of the
 * summary already counted above it).
 */
function fitsWithinHeaderSpan(cells: RowFeatures["cells"], columns: Column[]): boolean {
  const left = Math.min(...columns.map((c) => c.x));
  const right = Math.max(...columns.map((c) => c.x + c.width));
  const slack = 20;
  return cells.every((c) => c.x >= left - slack && c.x + c.width <= right + slack);
}

/**
 * Merges a wrapped second header line into the column labels it sits above,
 * so a column ends up named "Total TDS Deposited" rather than "Total TDS".
 *
 * Fragments that land in no column are attributed to the nearest one with no
 * distance cap. A header fragment always belongs to SOME column — it is a
 * label, printed above data — and the cap exists to stop unrelated *data*
 * being absorbed, which cannot apply here. Dropping it instead would lose
 * exactly the words that disambiguate two similarly-named columns.
 */
function extendHeader(columns: Column[], f: RowFeatures): void {
  for (const cell of f.cells) {
    const text = cell.text.trim();
    if (!text) continue;
    const target = nearestColumn(cell, columns, Infinity);
    if (target) target.text = `${target.text} ${text}`;
  }
}

/**
 * Whether this table continues after the interruption at `index`.
 *
 * A blank row means "the previous line did not wrap into this one", but it
 * does NOT mean the table is over: statements restate a customer/letterhead
 * block mid-table, separated by a blank, and then carry straight on with more
 * transactions. Ending the table there loses every row after it — they fall
 * out as a headerless key/value region and never reach the mapper.
 *
 * The table is over when nothing further aligns to it. Looking for a data row
 * that still lands in these columns distinguishes the two cases directly.
 */
function tableResumes(index: number, features: RowFeatures[], columns: Column[], opts: DocModelOptions): boolean {
  let seen = 0;
  for (let j = index; j < features.length && seen < RESUME_LOOKAHEAD; j++) {
    const g = features[j];
    if (g.blank) continue;
    seen++;
    if (isHeaderShaped(g, opts) && g.cells.length >= columns.length) return false; // a different table starts
    if (isDataShaped(g) && alignmentScore(g.cells, columns) >= Math.min(2, columns.length)) return true;
  }
  return false;
}

function consumeTable(
  start: number,
  features: RowFeatures[],
  sigIndex: SigIndex,
  opts: DocModelOptions,
  ancestors: string[],
): { block: Block; next: number } {
  const header = features[start];
  const columns = buildColumns(header);
  const records: RawRecord[] = [];
  const nested = [...ancestors, header.signature];
  const tolerance = opts.indentTolerance ?? 8;
  /** A row starting left of the table's own left edge is not part of it. Only
   *  enforced for a NESTED table, where breaking hands the row back to the
   *  enclosing table that does own it (Form 26AS's next deductor row, sitting
   *  left of the per-transaction sub-table it follows). At top level there is
   *  nothing to hand back to, so the permissive reading is kept — a header
   *  whose own first column is unlabelled legitimately starts right of its
   *  data. */
  const outdented = (f: RowFeatures): boolean => ancestors.length > 0 && f.indent < header.indent - tolerance;
  let foldCount = 0;
  /** Whether a text-only row may still be read as the previous record's
   *  wrapped continuation. A blank row is a real gap: whatever follows it is
   *  a new block, not the tail of the line above. This is what keeps a
   *  section heading printed after a blank ("^PART-II - ...^") from being
   *  glued onto the last record of the table before it. */
  let foldAllowed = false;
  /** Index of the most recent occurrence of this table's header, so a wrapped
   *  header line is recognized after every reprint, not just the first. */
  let lastHeaderAt = start;
  /** Records pushed since that header occurrence. A header's wrapped line can
   *  only appear BEFORE the first data row under it; once a record exists, a
   *  text-only row is a continuation or noise, never more header. Without
   *  this the rule swallows ordinary wrapped narrations. */
  let recordsSinceHeader = 0;
  /** Signatures already identified as this header's wrapped line, so the same
   *  line is recognized again after every reprint. */
  const headerWrapSigs = new Set<string>();
  /** Indent of this table's own data rows, used to spot a sub-table whose
   *  rows sit further right. Set from the first record. */
  let dataIndent: number | null = null;
  let end = start + 1;
  let i = start + 1;

  while (i < features.length) {
    const f = features[i];
    if (f.blank) {
      foldAllowed = false;
      i++;
      continue;
    }

    // The same header reprinted at a page break: the table continues.
    if (f.signature === header.signature) {
      lastHeaderAt = i;
      recordsSinceHeader = 0;
      foldCount = 0;
      end = ++i;
      continue;
    }

    // The header's own wrapped continuation line. Checked before the new-table
    // branch below, because such a line looks exactly like a valid narrow
    // header on its own terms — text-only, with the data rows beneath it
    // landing in its columns. Read that way it hijacks the table, and every
    // deductor row becomes a record of "Credited/Deposited".
    //
    // Before the first data row it is recognized by shape. After a reprint it
    // cannot be, because a genuine wrapped VALUE from the previous page looks
    // identical — so the discriminator there is that a header's wrap is part
    // of the header and therefore recurs verbatim, whereas a wrapped value is
    // unique. Only signatures already seen as a wrap are skipped.
    const shapedLikeHeaderWrap =
      records.length === 0 &&
      !isDataShaped(f) &&
      f.cells.length < header.cells.length &&
      i - lastHeaderAt <= HEADER_WRAP_LOOKAHEAD &&
      fitsWithinHeaderSpan(f.cells, columns);
    if (shapedLikeHeaderWrap || (recordsSinceHeader === 0 && headerWrapSigs.has(f.signature))) {
      // Merge into the labels once; every later occurrence is the same words.
      if (records.length === 0) extendHeader(columns, f);
      headerWrapSigs.add(f.signature);
      end = ++i;
      continue;
    }

    if (isHeaderShaped(f, opts) && looksLikeTableHeader(i, features, sigIndex, opts)) {
      if (records.length && isNestedHeader(i, features, header, sigIndex, opts, nested, dataIndent)) {
        const sub = consumeTable(i, features, sigIndex, opts, nested);
        records[records.length - 1].children.push(sub.block);
        foldCount = 0;
        i = sub.next;
        end = i;
        continue;
      }
      break; // a genuinely new, sibling table
    }

    if (isDataShaped(f)) {
      if (outdented(f)) break;
      const { matched, unmatched } = alignRow(f.cells, columns);
      // A data row none of whose cells land in this table's columns belongs
      // to something else entirely — end the table rather than absorb it.
      if (Object.keys(matched).length === 0) break;
      records.push({
        cells: matched,
        parts: f.cells.map((c) => c.text.trim()).filter(Boolean),
        children: [],
        unmatched,
      });
      if (dataIndent === null) dataIndent = f.indent;
      foldCount = 0;
      foldAllowed = true;
      recordsSinceHeader++;
      end = ++i;
      continue;
    }

    // A text-only row: the previous record's wrapped continuation, or the
    // start of something else. It is only ever the former when it sits at or
    // right of the table's left edge, follows a record with no gap, and isn't
    // the caption of a table about to start.
    // A text-only row. Whether it continues the record above, is noise inside
    // the table, or ends the table is decided here.
    const verdict = records.length === 0 ? "break" : opts.continuation?.(f.text) ?? "fold";
    const interrupted = !foldAllowed && !tableResumes(i, features, columns, opts);
    const ended =
      verdict === "break" ||
      interrupted ||
      outdented(f) ||
      startsNewTable(i, features, sigIndex, opts, header.signature);

    if (!ended) {
      // Past the fold cap the row is no longer plausibly a wrap — but a
      // long unrelated block sitting mid-table (a restated address, a
      // sub-table's header) does not mean the table is over, and the older
      // per-parser code skipped such rows for exactly that reason. Keep the
      // table open and park the text where it stays visible instead of
      // silently corrupting a keyed cell.
      if (verdict === "skip" || !foldAllowed || foldCount >= MAX_CONSECUTIVE_FOLDS) {
        records[records.length - 1].unmatched.push(f.text);
      } else {
        foldOnto(records[records.length - 1], f, columns, opts);
        foldCount++;
      }
      end = ++i;
      continue;
    }

    break;
  }

  return {
    block: {
      kind: "table",
      columns,
      records,
      indent: header.indent,
      page: header.row.page,
      rows: [start, end],
    },
    next: end,
  };
}

/**
 * Reads one headerless key/value region. Two row shapes land here, and the
 * split between them is what the user-facing contract calls "a table with no
 * header":
 *  - a row carrying data cells: the text cells are the key, the first data
 *    cell the value, a second one the `extra` (a comparative-year figure, a
 *    running balance, a tax amount — which of those varies by document, so
 *    it is surfaced rather than interpreted);
 *  - a row of pure text: all but the last cell form the key, the last is the
 *    value ("PAN of Assessee | ABCDE1234F").
 */
function consumeProperties(
  start: number,
  features: RowFeatures[],
  opts: DocModelOptions,
): { block: Block; next: number } {
  const entries: RawProperty[] = [];
  const parseDate = opts.parseDate ?? (() => null);
  const isData = (text: string): boolean => opts.parseNumber(text) !== null || parseDate(text) !== null;

  let i = start;
  let end = start;
  while (i < features.length) {
    const f = features[i];
    if (f.blank) {
      i++;
      continue;
    }
    if (f.cells.length < 2) break;
    if (isHeaderShaped(f, opts) && f.cells.length > 2 && entries.length > 0) break;

    const texts = f.cells.map((c) => c.text.trim());
    const dataTexts = texts.filter(isData);
    if (dataTexts.length > 0) {
      entries.push({
        key: texts.filter((t) => !isData(t)).join(" "),
        value: dataTexts[0] ?? null,
        extras: dataTexts.slice(1),
      });
    } else {
      entries.push({ key: texts.slice(0, -1).join(" "), value: texts[texts.length - 1], extras: [] });
    }
    end = ++i;
  }

  return {
    block: {
      kind: "properties",
      entries,
      indent: features[start].indent,
      page: features[start].row.page,
      rows: [start, end],
    },
    next: end,
  };
}

export function groupBlocks(features: RowFeatures[], opts: DocModelOptions): Block[] {
  const sigIndex = buildSigIndex(features);
  const blocks: Block[] = [];
  let i = 0;

  while (i < features.length) {
    const f = features[i];
    if (f.blank) {
      i++;
      continue;
    }

    if (looksLikeTableHeader(i, features, sigIndex, opts)) {
      const { block, next } = consumeTable(i, features, sigIndex, opts, []);
      blocks.push(block);
      i = next;
      continue;
    }

    if (isStandaloneLabel(f)) {
      blocks.push({ kind: "heading", text: f.text, indent: f.indent, page: f.row.page, rows: [i, i + 1] });
      i++;
      continue;
    }

    if (f.cells.length >= 2) {
      const { block, next } = consumeProperties(i, features, opts);
      // A region that produced nothing must still advance, or this loop spins.
      if (next > i) {
        blocks.push(block);
        i = next;
        continue;
      }
    }

    blocks.push({ kind: "text", text: f.text, indent: f.indent, page: f.row.page, rows: [i, i + 1] });
    i++;
  }

  return blocks;
}
