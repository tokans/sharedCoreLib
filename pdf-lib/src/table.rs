use crate::pdfium::TextCell;
use serde::Serialize;
use std::collections::BTreeMap;

/// A reconstructed table cell: possibly multiple words joined by a space (e.g. a
/// multi-word transaction description).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TableCell {
    pub text: String,
    pub x: f32,
    pub width: f32,
}

/// One reconstructed row of a table detected on a page.
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TableRow {
    pub page_index: u32,
    pub row_index: u32,
    pub cells: Vec<TableCell>,
}

/// Reconstructs table rows from word-level text cells using coordinate clustering.
///
/// Two passes:
/// 1. **Rows**: words within `row_tol` of a row's first word's y are grouped into that row.
/// 2. **Columns**: within each row independently, adjacent words (sorted by x) whose
///    gap is at most `gutter_tol` are merged into one cell — this is what keeps a
///    multi-word field like "Salary credit" together, while a wider gap starts a new
///    cell. Column boundaries are decided **per row, never across rows**: an earlier
///    design inferred one shared set of column bands from the union of every word's
///    span across the whole page, which let a chain of small per-row gaps (each valid
///    for a *different* row) transitively bridge every column boundary in sequence —
///    on a large real statement (hundreds of rows) this reliably collapsed the entire
///    table into a single column. Scoping the merge to one row at a time means a
///    single unusually dense row can misjudge only its own cells, never the rest of
///    the table.
///
/// This mirrors the geometric heuristic Docling's classical (non-VLM) table pipeline
/// uses on top of PDFium-extracted cells — no ML model involved, which is sufficient for
/// the clean, digitally-generated tables in bank/tax statements (as opposed to arbitrary
/// scanned documents). Pathologically tight column padding (narrower than a normal
/// inter-word space) can still fool this heuristic — that's an inherent limit of
/// geometry-only reconstruction, not something worth chasing here.
pub fn reconstruct_table(words: &[TextCell], row_tol: f32, gutter_tol: f32) -> Vec<TableRow> {
    let mut by_page: BTreeMap<u32, Vec<&TextCell>> = BTreeMap::new();
    for word in words {
        by_page.entry(word.page_index).or_default().push(word);
    }

    let mut result = Vec::new();

    for (page_index, mut page_words) in by_page {
        // PDF y-axis increases upward; reading order is top-to-bottom.
        page_words.sort_by(|a, b| b.y.partial_cmp(&a.y).unwrap());

        let mut rows: Vec<Vec<&TextCell>> = Vec::new();
        let mut current_row_y: Option<f32> = None;

        for word in page_words {
            match current_row_y {
                Some(y) if (y - word.y).abs() <= row_tol => {
                    rows.last_mut().expect("row exists once current_row_y is set").push(word);
                }
                _ => {
                    rows.push(vec![word]);
                    current_row_y = Some(word.y);
                }
            }
        }

        for row in &mut rows {
            row.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap());
        }

        for (row_index, row) in rows.into_iter().enumerate() {
            result.push(TableRow {
                page_index,
                row_index: row_index as u32,
                cells: merge_row_into_cells(&row, gutter_tol),
            });
        }
    }

    result
}

/// Merges one row's words (already sorted by x) into cells: adjacent words whose gap
/// is at most `gutter_tol` join into the same cell, a wider gap starts a new one.
fn merge_row_into_cells(row: &[&TextCell], gutter_tol: f32) -> Vec<TableCell> {
    let mut cells: Vec<TableCell> = Vec::new();

    for word in row {
        match cells.last_mut() {
            Some(cell) if word.x - (cell.x + cell.width) <= gutter_tol => {
                cell.text.push(' ');
                cell.text.push_str(&word.text);
                cell.width = (word.x + word.width) - cell.x;
            }
            _ => cells.push(TableCell {
                text: word.text.clone(),
                x: word.x,
                width: word.width,
            }),
        }
    }

    cells
}

#[cfg(test)]
mod tests {
    use super::*;

    fn word(page: u32, text: &str, x: f32, y: f32, width: f32) -> TextCell {
        TextCell {
            page_index: page,
            text: text.to_string(),
            x,
            y,
            width,
            height: 10.0,
        }
    }

    fn cell_texts(row: &TableRow) -> Vec<String> {
        row.cells.iter().map(|c| c.text.clone()).collect()
    }

    #[test]
    fn groups_a_clean_grid_into_rows_and_columns() {
        // Realistic report spacing: a generous gutter (~25pt) between columns.
        let words = vec![
            word(0, "Date", 10.0, 100.0, 25.0),
            word(0, "Description", 100.0, 100.0, 65.0),
            word(0, "Amount", 220.0, 100.0, 40.0),
            word(0, "01/04/2026", 10.0, 88.0, 60.0),
            // "Salary credit" arrives as two separate words, as it does through the
            // real char -> word pipeline (a genuine literal space between them).
            word(0, "Salary", 100.0, 88.0, 35.0),
            word(0, "credit", 137.0, 88.0, 35.0),
            word(0, "50000", 220.0, 88.0, 30.0),
        ];

        let rows = reconstruct_table(&words, 4.0, 15.0);

        assert_eq!(rows.len(), 2);
        assert_eq!(cell_texts(&rows[0]), vec!["Date", "Description", "Amount"]);
        assert_eq!(cell_texts(&rows[1]), vec!["01/04/2026", "Salary credit", "50000"]);
    }

    #[test]
    fn keeps_a_genuine_column_gap_as_a_separate_cell() {
        let words = vec![word(0, "Salary", 10.0, 88.0, 30.0), word(0, "credit", 170.0, 88.0, 30.0)];

        let rows = reconstruct_table(&words, 4.0, 15.0);

        assert_eq!(cell_texts(&rows[0]), vec!["Salary", "credit"]);
    }

    #[test]
    fn a_dense_row_never_collapses_columns_for_other_rows() {
        // Three clean rows, each with a genuine ~40pt gap between the two columns —
        // in isolation every row would split into 2 cells.
        let mut words = vec![
            word(0, "Date", 10.0, 200.0, 30.0),
            word(0, "Amount", 100.0, 200.0, 40.0),
            word(0, "01/04/2026", 10.0, 190.0, 60.0),
            word(0, "50000", 100.0, 190.0, 30.0),
            word(0, "02/04/2026", 10.0, 180.0, 60.0),
            word(0, "60000", 100.0, 180.0, 30.0),
        ];
        // One unrelated row bridges the SAME x-range with a chain of tightly-packed
        // words (gap <= gutter_tol at every step) — e.g. a long wrapped narration.
        // Under the old whole-page union-of-spans design this row's bridging alone
        // was enough to merge the "Date" and "Amount" bands for every row on the
        // page; per-row scoping must confine the effect to this row only.
        words.push(word(0, "Some", 10.0, 170.0, 25.0));
        words.push(word(0, "very", 38.0, 170.0, 20.0));
        words.push(word(0, "long", 61.0, 170.0, 20.0));
        words.push(word(0, "wrapped", 84.0, 170.0, 40.0));
        words.push(word(0, "narration", 127.0, 170.0, 40.0));

        let rows = reconstruct_table(&words, 4.0, 15.0);

        assert_eq!(rows.len(), 4);
        assert_eq!(cell_texts(&rows[0]), vec!["Date", "Amount"]);
        assert_eq!(cell_texts(&rows[1]), vec!["01/04/2026", "50000"]);
        assert_eq!(cell_texts(&rows[2]), vec!["02/04/2026", "60000"]);
        assert_eq!(cell_texts(&rows[3]), vec!["Some very long wrapped narration"]);
    }

    #[test]
    fn tolerates_small_coordinate_jitter_within_tolerance() {
        let words = vec![
            word(0, "Date", 10.0, 100.0, 20.0),
            word(0, "Amount", 160.0, 101.5, 30.0),
            word(0, "01/04/2026", 11.2, 88.0, 55.0),
            word(0, "50000", 158.5, 87.1, 25.0),
        ];

        let rows = reconstruct_table(&words, 4.0, 15.0);

        assert_eq!(rows.len(), 2);
        assert_eq!(cell_texts(&rows[0]), vec!["Date", "Amount"]);
        assert_eq!(cell_texts(&rows[1]), vec!["01/04/2026", "50000"]);
    }

    #[test]
    fn separates_rows_beyond_tolerance() {
        let words = vec![word(0, "A", 0.0, 100.0, 10.0), word(0, "B", 0.0, 50.0, 10.0)];

        let rows = reconstruct_table(&words, 4.0, 15.0);

        assert_eq!(rows.len(), 2);
    }

    #[test]
    fn keeps_pages_independent() {
        let words = vec![word(0, "A", 0.0, 100.0, 10.0), word(1, "B", 0.0, 100.0, 10.0)];

        let rows = reconstruct_table(&words, 4.0, 15.0);

        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].page_index, 0);
        assert_eq!(rows[1].page_index, 1);
    }
}
