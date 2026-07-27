/**
 * Snapping a data row's cells to a header's columns.
 *
 * Cells cannot be matched to columns by array index: a row missing a value
 * (no debit on a credit row, no TAN on a summary line) simply has no cell
 * there, so index N means a different column on different rows. Position is
 * the only reliable key, which is why this is the last place in the pipeline
 * where geometry is consulted — after this, everything is keyed by header text.
 */
import type { PositionalCell } from "./positional";

export interface Column {
  /** The header cell's own text — becomes the record key. */
  text: string;
  x: number;
  width: number;
}

/** Default cap on how far a cell may sit from a column's header x and still
 *  belong to it. Generous enough for realistic per-row jitter (right-aligned
 *  numbers, shifted glyph origins) but well under the gap to an unrelated
 *  table's columns — without a cap, nearest-neighbour matching always finds
 *  *some* column no matter how far away, silently attributing a completely
 *  different table's content to whichever column is least far. */
export const MAX_COLUMN_DISTANCE = 50;

/**
 * Span containment is checked BEFORE point distance, and that order is
 * load-bearing. A header whose label glues two sub-columns' text into one
 * wide cell (a bank statement's "Value Dt Withdrawal Amt.") sits far to the
 * LEFT of where its own right-aligned data actually renders — close enough to
 * the NEXT column's header that raw point distance to that neighbour wins.
 * That makes point matching succeed on the WRONG column outright (a real HDFC
 * statement had two thirds of its withdrawals land in the deposit column this
 * way), so a fallback that only runs after point matching fails never gets a
 * chance to correct it. A cell's x actually falling inside a column's printed
 * span is the stronger signal; point distance stays as the fallback for
 * zero-width columns and for cells no span contains.
 */
export function nearestColumn(
  cell: PositionalCell,
  columns: Column[],
  maxDistance = MAX_COLUMN_DISTANCE,
): Column | null {
  for (const col of columns) {
    if (col.width > 0 && cell.x >= col.x && cell.x <= col.x + col.width) return col;
  }

  let best: Column | null = null;
  let bestDist = Infinity;
  for (const col of columns) {
    const dist = Math.abs(cell.x - col.x);
    if (dist < bestDist) {
      bestDist = dist;
      best = col;
    }
  }
  return bestDist <= maxDistance ? best : null;
}

/** Snaps every cell of a row into its column, joining multiple cells landing
 *  in the same column with a space. Cells too far from every column are
 *  reported via `unmatched` rather than dropped, so a caller can account for
 *  them instead of losing them silently. */
export function alignRow(
  cells: PositionalCell[],
  columns: Column[],
  maxDistance = MAX_COLUMN_DISTANCE,
): { matched: Record<string, string>; unmatched: string[] } {
  const matched: Record<string, string> = {};
  const unmatched: string[] = [];
  for (const cell of cells) {
    const col = nearestColumn(cell, columns, maxDistance);
    const text = cell.text.trim();
    if (!text) continue;
    if (!col) {
      unmatched.push(text);
      continue;
    }
    matched[col.text] = matched[col.text] ? `${matched[col.text]} ${text}` : text;
  }
  return { matched, unmatched };
}

/** How many of a row's cells land in one of `columns` — the evidence that a
 *  candidate header row actually governs this row. */
export function alignmentScore(cells: PositionalCell[], columns: Column[], maxDistance = MAX_COLUMN_DISTANCE): number {
  let n = 0;
  for (const cell of cells) {
    if (cell.text.trim() && nearestColumn(cell, columns, maxDistance)) n++;
  }
  return n;
}
