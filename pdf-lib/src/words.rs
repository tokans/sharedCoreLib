use crate::pdfium::{CharBox, TextCell};
use std::collections::BTreeMap;

/// Groups raw per-character boxes into words using same-line + x-gap heuristics.
///
/// Characters are re-sorted spatially (top-to-bottom, then left-to-right) before grouping,
/// independent of the order they appear in the PDF's content stream — report-generating
/// tools frequently emit fields out of visual order. A word boundary is any whitespace
/// character, or a horizontal gap larger than `max(min_gap, gap_factor * char_height)`.
///
/// `line_tol`: max y-difference for two characters to be considered on the same line.
/// `gap_factor`: word-break threshold as a multiple of the current character's height.
/// `min_gap`: absolute floor for the word-break threshold, in PDF points.
pub fn group_chars_into_words(
    chars: &[CharBox],
    line_tol: f32,
    gap_factor: f32,
    min_gap: f32,
) -> Vec<TextCell> {
    let mut by_page: BTreeMap<u32, Vec<&CharBox>> = BTreeMap::new();
    for c in chars {
        by_page.entry(c.page_index).or_default().push(c);
    }

    let mut result = Vec::new();

    for (page_index, mut page_chars) in by_page {
        page_chars.sort_by(|a, b| {
            b.y.partial_cmp(&a.y)
                .unwrap()
                .then(a.x.partial_cmp(&b.x).unwrap())
        });

        let mut lines: Vec<Vec<&CharBox>> = Vec::new();
        let mut current_line_y: Option<f32> = None;
        for c in page_chars {
            match current_line_y {
                Some(y) if (y - c.y).abs() <= line_tol => {
                    lines.last_mut().expect("line exists once current_line_y is set").push(c);
                }
                _ => {
                    lines.push(vec![c]);
                    current_line_y = Some(c.y);
                }
            }
        }

        for mut line in lines {
            line.sort_by(|a, b| a.x.partial_cmp(&b.x).unwrap());

            let mut word_chars: Vec<&CharBox> = Vec::new();
            let mut prev_end_x: Option<f32> = None;

            for c in &line {
                let gap = prev_end_x.map(|end| c.x - end).unwrap_or(0.0);
                let threshold = min_gap.max(gap_factor * c.height.max(1.0));
                let is_break = c.ch.is_whitespace() || (prev_end_x.is_some() && gap > threshold);

                if is_break && !word_chars.is_empty() {
                    result.push(word_from_chars(page_index, &word_chars));
                    word_chars.clear();
                }

                if !c.ch.is_whitespace() {
                    word_chars.push(c);
                }

                prev_end_x = Some(c.x + c.width);
            }

            if !word_chars.is_empty() {
                result.push(word_from_chars(page_index, &word_chars));
            }
        }
    }

    result
}

fn word_from_chars(page_index: u32, chars: &[&CharBox]) -> TextCell {
    let text: String = chars.iter().map(|c| c.ch).collect();
    let x = chars.iter().map(|c| c.x).fold(f32::MAX, f32::min);
    let end_x = chars.iter().map(|c| c.x + c.width).fold(f32::MIN, f32::max);
    let y = chars.iter().map(|c| c.y).fold(f32::MAX, f32::min);
    let height = chars.iter().map(|c| c.height).fold(f32::MIN, f32::max);

    TextCell {
        page_index,
        text,
        x,
        y,
        width: end_x - x,
        height,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cb(page: u32, ch: char, x: f32, y: f32, width: f32) -> CharBox {
        CharBox { page_index: page, ch, x, y, width, height: 9.0 }
    }

    #[test]
    fn splits_words_by_large_gap_with_no_literal_space() {
        // "Description" then "Amount" positioned by separate Tj calls with a big gap
        // and no literal space glyph in between — the exact failure mode found against
        // a real PDFium binary via segments().
        let mut chars = vec![];
        let mut x = 10.0;
        for ch in "Description".chars() {
            chars.push(cb(0, ch, x, 100.0, 6.0));
            x += 6.0;
        }
        x += 30.0; // big gap, no space char
        for ch in "Amount".chars() {
            chars.push(cb(0, ch, x, 100.0, 6.0));
            x += 6.0;
        }

        let words = group_chars_into_words(&chars, 4.0, 0.5, 3.0);

        assert_eq!(words.len(), 2);
        assert_eq!(words[0].text, "Description");
        assert_eq!(words[1].text, "Amount");
    }

    #[test]
    fn keeps_a_word_together_despite_tiny_kerning_gaps() {
        let chars = vec![
            cb(0, 'D', 10.0, 100.0, 6.0),
            cb(0, 'a', 16.3, 100.0, 6.0),
            cb(0, 't', 22.1, 100.0, 6.0),
            cb(0, 'e', 27.9, 100.0, 6.0),
        ];

        let words = group_chars_into_words(&chars, 4.0, 0.5, 3.0);

        assert_eq!(words.len(), 1);
        assert_eq!(words[0].text, "Date");
    }

    #[test]
    fn splits_on_literal_whitespace_even_without_a_big_gap() {
        let chars = vec![
            cb(0, 'A', 10.0, 100.0, 6.0),
            cb(0, ' ', 16.0, 100.0, 3.0),
            cb(0, 'B', 19.0, 100.0, 6.0),
        ];

        let words = group_chars_into_words(&chars, 4.0, 0.5, 3.0);

        assert_eq!(words.len(), 2);
        assert_eq!(words[0].text, "A");
        assert_eq!(words[1].text, "B");
    }

    #[test]
    fn reorders_chars_spatially_regardless_of_input_order() {
        // Simulates a content stream that emits the second column before the first.
        let chars = vec![
            cb(0, 'B', 60.0, 100.0, 6.0),
            cb(0, 'A', 10.0, 100.0, 6.0),
        ];

        let words = group_chars_into_words(&chars, 4.0, 0.5, 3.0);

        assert_eq!(words.len(), 2);
        assert_eq!(words[0].text, "A");
        assert_eq!(words[1].text, "B");
    }
}
