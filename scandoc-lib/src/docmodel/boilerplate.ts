/**
 * Page-furniture removal — the two distinct kinds real documents produce.
 *
 * 1. **Verbatim repeats**: a letterhead line, a footer disclaimer, a GSTIN
 *    notice reprinted identically on every page, interleaved with real rows
 *    rather than confined to a header/footer region the extractor could
 *    separate. A genuine data row is made unique by its own date/amount, so
 *    byte-identical recurrence is a reliable, corpus-independent signal.
 *
 * 2. **Templated repeats**: the same footer with a page number and timestamp
 *    baked in, so no two occurrences are identical and (1) can never catch
 *    them. Worse, these frequently render tight enough to be glued onto a
 *    real cell rather than occupying a row of their own, corrupting that
 *    cell's text. Only a caller-supplied pattern can recognize these, and it
 *    has to be applied as a per-cell strip, not a row drop.
 *
 * A repeated TABLE HEADER is explicitly not furniture: it is the signal that
 * a table continues across a page break, and dropping it would split one
 * table into several (or, worse, orphan the rows that follow it).
 *
 * Two rules keep those apart, and both are needed:
 *
 * - **The first occurrence is content.** A letterhead states the account
 *   number, the address, the statement period; a page header states the PAN
 *   and the financial year. Dropping every copy loses that from the document
 *   entirely. Only the reprints are furniture.
 *
 * - **A header must actually govern rows.** Shape alone cannot tell a column
 *   header from a letterhead line — both are two or three text cells with no
 *   number among them. What separates them is whether the rows underneath
 *   line up with the columns it declares. A real HDFC statement prints its
 *   `Date | Narration | …` header once, on page one, and reprints a
 *   `From : … | To : … | Statement of account` line on all 43; exempting that
 *   line as a "header" made it capture every transaction from page two
 *   onward into a table with no date column, and 495 of 510 rows were
 *   silently dropped by the mapper.
 */
import { mapCells, type PositionalDoc } from "./positional";
import { analyze, isDataShaped, isHeaderShaped, type RowFeatures } from "./classify";
import { alignmentScore, type Column } from "./align";
import type { DocModelOptions } from "./types";

/** How far past a candidate header to look for rows it governs. A header is
 *  followed by its data within a few lines, even across a page break. */
const HEADER_GOVERNS_LOOKAHEAD = 6;

/** Cells of a following row that must land in this row's columns for it to
 *  count as their header. One is not evidence — a wrapped narration's left
 *  edge coincides with almost any left-most column. */
const MIN_GOVERNED_CELLS = 2;

/** Cells of a governed row the columns may fail to account for. A header
 *  declares where its data goes, so a row it governs lands in its columns
 *  almost entirely; slack for one covers a stray fragment or an off-template
 *  marker. Counting matches alone is not enough — a label wide enough to span
 *  an unrelated column collects the odd cell by coincidence, which is exactly
 *  how the statement's period line accumulated two matches per row while
 *  accounting for barely a third of the transaction. */
const MAX_UNACCOUNTED_CELLS = 1;

/**
 * Whether a header-shaped row actually acts as the header of what follows it,
 * rather than merely looking like one.
 *
 * Alignment is the test because it is the same question the grouper will ask
 * when it maps those rows into columns: if their cells do not land in this
 * row's columns, it cannot be their header no matter what it looks like.
 */
function governsFollowingRows(index: number, features: RowFeatures[], opts: DocModelOptions): boolean {
  const columns: Column[] = features[index].cells.map((c) => ({ text: c.text.trim(), x: c.x, width: c.width }));
  if (columns.length === 0) return false;

  let seen = 0;
  for (let j = index + 1; j < features.length && seen < HEADER_GOVERNS_LOOKAHEAD; j++) {
    const f = features[j];
    if (f.blank) continue;
    seen++;
    if (!isDataShaped(f)) continue;
    const aligned = alignmentScore(f.cells, columns);
    if (aligned < Math.min(MIN_GOVERNED_CELLS, columns.length)) continue;
    if (aligned >= f.cells.length - MAX_UNACCOUNTED_CELLS) return true;
  }
  return false;
}

/** Applies `stripPatterns` to every cell, then drops rows left empty. */
export function stripPatterns(doc: PositionalDoc, patterns: RegExp[]): PositionalDoc {
  if (patterns.length === 0) return doc;
  return mapCells(doc, (text) => {
    let out = text;
    for (const pattern of patterns) {
      // Rebuilt per call so a caller-supplied /g regex's lastIndex can never
      // leak between cells and silently skip matches.
      out = out.replace(new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g"), "");
    }
    return out.trim();
  });
}

/** Row indexes (into `doc.rows`) that are verbatim-repeated furniture. */
export function findRepeatedRows(doc: PositionalDoc, opts: DocModelOptions): Set<number> {
  const minRepeats = opts.boilerplateMinRepeats ?? 3;
  const features = analyze(doc.rows, opts);

  const counts = new Map<string, number>();
  for (const f of features) {
    if (f.signature) counts.set(f.signature, (counts.get(f.signature) ?? 0) + 1);
  }

  const seen = new Set<string>();
  const furniture = new Set<number>();
  features.forEach((f: RowFeatures, i: number) => {
    if (!f.signature || (counts.get(f.signature) ?? 0) < minRepeats) return;

    // Figures are content, never furniture. Two transactions can be identical
    // — same section, date, amount, tax — and a real Form 26AS contains such
    // a pair; deleting them as "repeats" silently removes money from a tax
    // document. Furniture that does carry a number (a dated footer, "Page 3
    // of 43") is `stripPatterns`' job, which is pattern-driven and cannot
    // mistake a transaction for a caption.
    if (isDataShaped(f)) return;

    // A repeated one-liner is a footer or a disclaimer: the same sentence at
    // the foot of every page, carrying nothing the document doesn't say
    // elsewhere. Every copy goes — keeping one only lets it fold into the
    // narration of whichever record it happens to land beside.
    if (!isHeaderShaped(f, opts)) {
      furniture.add(i);
      return;
    }

    if (governsFollowingRows(i, features, opts)) return; // a header, continuing its table

    // A repeated multi-cell block that governs nothing is a masthead — the
    // address block, the PAN/name/period line. Its content is real and stated
    // once; the other 42 copies are furniture.
    if (!seen.has(f.signature)) {
      seen.add(f.signature);
      return;
    }
    furniture.add(i);
  });
  return furniture;
}

/** Applies both passes, returning the cleaned document and how many rows the
 *  repeat pass removed (surfaced as a build warning so a wrongly-aggressive
 *  threshold is visible rather than silent). */
export function stripFurniture(
  doc: PositionalDoc,
  opts: DocModelOptions,
): { doc: PositionalDoc; removed: number } {
  const stripped = stripPatterns(doc, opts.stripPatterns ?? []);
  const repeated = findRepeatedRows(stripped, opts);
  if (repeated.size === 0) return { doc: stripped, removed: 0 };
  return {
    doc: { pages: stripped.pages, rows: stripped.rows.filter((_, i) => !repeated.has(i)) },
    removed: repeated.size,
  };
}
