//! Manual smoke test against a real PDFium binary. Not run in CI.
//! Usage: cargo run --example smoke -- <path-to-pdfium-dll-dir>

use pdf_lib::{extract_table, open_with_password_candidates, ExtractionTuning};
use pdfium_render::prelude::Pdfium;

fn make_unprotected_pdf() -> Vec<u8> {
    let stream = "BT\n/F1 12 Tf\n10 150 Td\n(Date) Tj\n90 0 Td\n(Description) Tj\n100 0 Td\n(Amount) Tj\nET\nBT\n/F1 12 Tf\n10 130 Td\n(01/04/2026) Tj\n90 0 Td\n(Salary credit) Tj\n100 0 Td\n(50000) Tj\nET\n";
    let objects = format!(
        "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n\
         2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n\
         3 0 obj\n<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 5 0 R >> >> /MediaBox [0 0 350 200] /Contents 4 0 R >>\nendobj\n\
         4 0 obj\n<< /Length {} >>\nstream\n{}endstream\nendobj\n\
         5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n",
        stream.len(),
        stream
    );
    format!(
        "%PDF-1.4\n{}xref\n0 1\n0000000000 65535 f \ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n0\n%%EOF",
        objects
    )
    .into_bytes()
}

fn main() {
    let lib_dir = std::env::args().nth(1).expect("pass the directory containing pdfium.dll");
    let bindings = Pdfium::bind_to_library(Pdfium::pdfium_platform_library_name_at_path(&lib_dir))
        .expect("bind to pdfium library");
    let pdfium = Pdfium::new(bindings);

    let bytes = make_unprotected_pdf();
    let candidates = vec!["wrong-password".to_string()];
    let (doc, used_password) =
        open_with_password_candidates(&pdfium, &bytes, &candidates).expect("open pdf");
    println!("opened OK, password used: {:?}", used_password);

    let rows = extract_table(&doc, ExtractionTuning::default()).expect("extract table");
    println!("reconstructed {} rows:", rows.len());
    for r in &rows {
        println!("  row {}: {:?}", r.row_index, r.cells);
    }
}
