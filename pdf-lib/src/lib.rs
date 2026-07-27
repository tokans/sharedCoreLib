pub mod archive;
pub mod pdfium;
pub mod table;
pub mod words;

pub use archive::extract_zip_entry;
pub use pdfium::{
    CharBox, PdfLibError, TextCell, bind_pdfium, extract_char_boxes, open_with_password_candidates,
};
pub use table::{TableRow, reconstruct_table};
pub use words::group_chars_into_words;

/// Tuning knobs for the char -> word -> table pipeline. Defaults are tuned for typical
/// 9-12pt statement/report text; callers with unusual fonts can override.
#[derive(Debug, Clone, Copy)]
pub struct ExtractionTuning {
    pub line_tol: f32,
    pub word_gap_factor: f32,
    pub word_min_gap: f32,
    pub row_tol: f32,
    /// Max horizontal gap between adjacent words to merge them into the same cell
    /// (e.g. a multi-word description); larger gaps are treated as a column boundary.
    pub cell_gap_tol: f32,
}

impl Default for ExtractionTuning {
    fn default() -> Self {
        Self {
            line_tol: 3.0,
            word_gap_factor: 0.5,
            word_min_gap: 3.0,
            row_tol: 4.0,
            cell_gap_tol: 15.0,
        }
    }
}

/// Full pipeline: an opened [`pdfium_render::prelude::PdfDocument`] -> reconstructed table rows.
pub fn extract_table(
    document: &pdfium_render::prelude::PdfDocument,
    tuning: ExtractionTuning,
) -> Result<Vec<TableRow>, PdfLibError> {
    let chars = extract_char_boxes(document)?;
    let words = group_chars_into_words(
        &chars,
        tuning.line_tol,
        tuning.word_gap_factor,
        tuning.word_min_gap,
    );
    Ok(reconstruct_table(&words, tuning.row_tol, tuning.cell_gap_tol))
}
