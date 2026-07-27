use crate::pdfium::PdfLibError;
use std::io::{Cursor, Read};
use zip::ZipArchive;

/// Extension preference when a zip contains more than one file (most AIS/26AS/
/// bank "download as zip" exports contain exactly one document, but pick a
/// sensible winner if there's ever more than one).
const PREFERRED_EXTENSIONS: [&str; 4] = ["pdf", "xlsx", "xls", "txt"];

fn pick_entry_index(archive: &mut ZipArchive<Cursor<&[u8]>>) -> Result<usize, PdfLibError> {
    let mut best: Option<(usize, usize)> = None; // (preference rank, index)
    for i in 0..archive.len() {
        let name = archive
            .name_for_index(i)
            .ok_or_else(|| PdfLibError::ParseFailed("zip entry has no name".into()))?
            .to_string();
        if name.ends_with('/') {
            continue; // directory entry
        }
        let ext = name.rsplit('.').next().unwrap_or("").to_lowercase();
        let rank = PREFERRED_EXTENSIONS.iter().position(|e| *e == ext).unwrap_or(PREFERRED_EXTENSIONS.len());
        if best.map(|(r, _)| rank < r).unwrap_or(true) {
            best = Some((rank, i));
        }
    }
    best.map(|(_, i)| i).ok_or_else(|| PdfLibError::ParseFailed("zip archive has no files".into()))
}

/// Extracts the single most relevant file from a (possibly password-protected)
/// zip archive — the common wire format for AIS/26AS/bank-statement "download
/// as zip" exports. Tries no password first, then each candidate in order.
/// Returns the entry's filename, raw decrypted bytes, and the candidate password
/// that worked (`None` if the archive wasn't encrypted).
pub fn extract_zip_entry(
    bytes: &[u8],
    password_candidates: &[String],
) -> Result<(String, Vec<u8>, Option<String>), PdfLibError> {
    let cursor = Cursor::new(bytes);
    let mut archive = ZipArchive::new(cursor).map_err(|e| PdfLibError::ParseFailed(e.to_string()))?;
    let index = pick_entry_index(&mut archive)?;

    if let Ok(mut file) = archive.by_index(index) {
        let mut buf = Vec::new();
        if file.read_to_end(&mut buf).is_ok() {
            return Ok((file.name().to_string(), buf, None));
        }
    }

    for candidate in password_candidates {
        if let Ok(mut file) = archive.by_index_decrypt(index, candidate.as_bytes()) {
            let mut buf = Vec::new();
            if file.read_to_end(&mut buf).is_ok() {
                return Ok((file.name().to_string(), buf, Some(candidate.clone())));
            }
        }
    }

    Err(PdfLibError::PasswordRequired)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use zip::unstable::write::FileOptionsExt;
    use zip::write::SimpleFileOptions;
    use zip::ZipWriter;

    fn make_zip(entries: &[(&str, &[u8])], password: Option<&str>) -> Vec<u8> {
        let mut buf = Vec::new();
        {
            let mut writer = ZipWriter::new(Cursor::new(&mut buf));
            for (name, content) in entries {
                let mut options = SimpleFileOptions::default();
                if let Some(pw) = password {
                    options = options.with_deprecated_encryption(pw.as_bytes());
                }
                writer.start_file(*name, options).unwrap();
                writer.write_all(content).unwrap();
            }
            writer.finish().unwrap();
        }
        buf
    }

    #[test]
    fn extracts_an_unprotected_entry() {
        let zip = make_zip(&[("statement.pdf", b"hello pdf bytes")], None);
        let (name, bytes, password_used) = extract_zip_entry(&zip, &[]).unwrap();
        assert_eq!(name, "statement.pdf");
        assert_eq!(bytes, b"hello pdf bytes");
        assert_eq!(password_used, None);
    }

    #[test]
    fn extracts_a_password_protected_entry_by_trying_candidates() {
        let zip = make_zip(&[("26as.pdf", b"tds data")], Some("abcde1234f15051990"));
        let (name, bytes, password_used) = extract_zip_entry(
            &zip,
            &["wrong-guess".to_string(), "abcde1234f15051990".to_string()],
        )
        .unwrap();
        assert_eq!(name, "26as.pdf");
        assert_eq!(bytes, b"tds data");
        assert_eq!(password_used.as_deref(), Some("abcde1234f15051990"));
    }

    #[test]
    fn errors_when_no_candidate_password_matches() {
        let zip = make_zip(&[("26as.pdf", b"tds data")], Some("realpassword"));
        let err = extract_zip_entry(&zip, &["wrong-guess".to_string()]).unwrap_err();
        assert!(matches!(err, PdfLibError::PasswordRequired));
    }

    #[test]
    fn prefers_a_pdf_entry_over_other_files_when_the_archive_has_several() {
        let zip = make_zip(
            &[("readme.txt", b"ignore me"), ("statement.pdf", b"the real one")],
            None,
        );
        let (name, bytes, _) = extract_zip_entry(&zip, &[]).unwrap();
        assert_eq!(name, "statement.pdf");
        assert_eq!(bytes, b"the real one");
    }
}
