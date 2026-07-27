use pdfium_render::prelude::*;
use serde::Serialize;

#[derive(Debug, thiserror::Error)]
pub enum PdfLibError {
    #[error("failed to load PDFium native library: {0}")]
    BindingFailed(String),
    #[error("PDF is password-protected and no candidate password matched")]
    PasswordRequired,
    #[error("failed to parse PDF: {0}")]
    ParseFailed(String),
}

/// A single glyph as reported directly by PDFium, before any word/line grouping.
#[derive(Debug, Clone, Serialize)]
pub struct CharBox {
    pub page_index: u32,
    pub ch: char,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

/// A word-level text cell, produced by [`crate::words::group_chars_into_words`] from
/// [`CharBox`]es, and consumed by [`crate::table::reconstruct_table`].
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct TextCell {
    pub page_index: u32,
    pub text: String,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

pub fn bind_pdfium(pdfium_library_path: &str) -> Result<Pdfium, PdfLibError> {
    let bindings = Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path(
        pdfium_library_path,
    ))
    .map_err(|e| PdfLibError::BindingFailed(e.to_string()))?;
    Ok(Pdfium::new(bindings))
}

/// Tries opening `bytes` first with no password, then with each candidate in order.
/// Returns the candidate password that worked (`None` if the document was never encrypted).
///
/// Password verification itself is delegated entirely to PDFium's native `/Encrypt`
/// handling (the same code Chrome uses) — this function only sequences candidates.
pub fn open_with_password_candidates<'a>(
    pdfium: &'a Pdfium,
    bytes: &'a [u8],
    candidates: &[String],
) -> Result<(PdfDocument<'a>, Option<String>), PdfLibError> {
    if let Ok(doc) = pdfium.load_pdf_from_byte_slice(bytes, None) {
        return Ok((doc, None));
    }

    for candidate in candidates {
        if let Ok(doc) = pdfium.load_pdf_from_byte_slice(bytes, Some(candidate)) {
            return Ok((doc, Some(candidate.clone())));
        }
    }

    Err(PdfLibError::PasswordRequired)
}

/// Extracts every visible glyph on every page, with PDFium's per-character bounding box.
///
/// This is deliberately char-level rather than using PDFium's own `segments()` grouping:
/// many table/report-generating tools position each field with its own text-showing
/// operator and no literal space glyph between fields, and `segments()`'s internal
/// grouping does not reliably align with field boundaries in that case (confirmed by
/// hand — a "Description" / "Amount" pair rendered as separate `Tj` calls came back as
/// "DescriptionAm" / "onAmount"). Word boundaries are reconstructed geometrically instead,
/// in [`crate::words::group_chars_into_words`].
pub fn extract_char_boxes(document: &PdfDocument) -> Result<Vec<CharBox>, PdfLibError> {
    let mut out = Vec::new();

    for (page_index, page) in document.pages().iter().enumerate() {
        let text = page
            .text()
            .map_err(|e| PdfLibError::ParseFailed(e.to_string()))?;

        for char in text.chars().iter() {
            let Some(ch) = char.unicode_char() else {
                continue;
            };

            let Ok(bounds) = char.loose_bounds() else {
                continue;
            };

            out.push(CharBox {
                page_index: page_index as u32,
                ch,
                x: bounds.left().value,
                y: bounds.bottom().value,
                width: bounds.width().value,
                height: bounds.height().value,
            });
        }
    }

    Ok(out)
}
