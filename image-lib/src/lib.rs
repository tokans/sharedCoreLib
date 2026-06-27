//! Shared image edit/processing engine for myLife's Tauri apps — non-destructive recipe ops
//! (rotate/flip/crop/brightness/contrast/saturation/named filters) PLUS watermark-removal
//! inpainting ({@link inpaint}). Originally myMemories' `edit.rs`; promoted here so
//! myWorkAssistant's comic studio (Image Properties, watermark removal) and any future
//! image-editing app/feature reuse ONE engine instead of re-implementing it.
//!
//! Pure logic only — no Tauri commands, no file I/O policy. Each app's own `src-tauri`
//! supplies a thin command layer matching ITS OWN storage model (myMemories: file paths;
//! myWorkAssistant: in-memory bytes via the content-addressed asset store) and calls into
//! this crate for the actual pixel work.

pub mod inpaint;

use std::io::Cursor;

use image::{DynamicImage, GrayImage, ImageFormat, RgbaImage};
use serde::Deserialize;

/// Decode guards: reject decompression bombs before allocating.
pub const MAX_DECODE_PIXELS: u64 = 200_000_000;
pub const MAX_DECODE_BYTES: u64 = 768 * 1024 * 1024;

/// One pure edit step. `op` is the JSON discriminator (snake_case).
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case")]
pub enum EditOp {
    /// Rotate clockwise by 90/180/270 degrees (other values are ignored).
    Rotate { degrees: i32 },
    FlipH,
    FlipV,
    /// Crop to a normalized rectangle (0..1) of the current image.
    Crop { x: f32, y: f32, w: f32, h: f32 },
    /// -1..1 → darker..brighter.
    Brightness { value: f32 },
    /// -1..1 → lower..higher contrast.
    Contrast { value: f32 },
    /// -1..1 → grayscale..oversaturated.
    Saturation { value: f32 },
    /// Named look: grayscale | sepia | warm | cool | ink | pencil.
    Filter { name: String },
}

#[derive(Debug, Clone, Deserialize, Default)]
pub struct Recipe {
    #[serde(default)]
    pub ops: Vec<EditOp>,
}

pub fn parse_recipe(recipe: &str) -> Result<Recipe, String> {
    serde_json::from_str(recipe).map_err(|e| format!("bad recipe: {e}"))
}

/// Decode an image file, rejecting anything over the decode-pixel/byte budget.
pub fn decode_bounded_path(path: &str) -> Result<DynamicImage, String> {
    if let Ok((w, h)) = image::image_dimensions(path) {
        if (w as u64) * (h as u64) > MAX_DECODE_PIXELS {
            return Err("image exceeds decode pixel budget".into());
        }
    }
    let mut reader = image::ImageReader::open(path)
        .map_err(|e| e.to_string())?
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(MAX_DECODE_BYTES);
    reader.limits(limits);
    reader.decode().map_err(|e| e.to_string())
}

/// Decode in-memory image bytes (the comic studio's content-addressed asset model — no file
/// path), rejecting anything over the decode-pixel/byte budget.
pub fn decode_bounded_bytes(bytes: &[u8]) -> Result<DynamicImage, String> {
    if bytes.len() as u64 > MAX_DECODE_BYTES {
        return Err("image exceeds decode byte budget".into());
    }
    let mut reader = image::ImageReader::new(Cursor::new(bytes))
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    let mut limits = image::Limits::default();
    limits.max_alloc = Some(MAX_DECODE_BYTES);
    reader.limits(limits);
    let img = reader.decode().map_err(|e| e.to_string())?;
    if (img.width() as u64) * (img.height() as u64) > MAX_DECODE_PIXELS {
        return Err("image exceeds decode pixel budget".into());
    }
    Ok(img)
}

/// Encode to PNG bytes.
pub fn encode_png(img: &DynamicImage) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    img.write_to(&mut Cursor::new(&mut bytes), ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(bytes)
}

pub fn apply_op(img: DynamicImage, op: &EditOp) -> DynamicImage {
    match op {
        EditOp::Rotate { degrees } => match degrees.rem_euclid(360) {
            90 => img.rotate90(),
            180 => img.rotate180(),
            270 => img.rotate270(),
            _ => img,
        },
        EditOp::FlipH => img.fliph(),
        EditOp::FlipV => img.flipv(),
        EditOp::Crop { x, y, w, h } => {
            let (iw, ih) = (img.width(), img.height());
            let cx = (x.clamp(0.0, 1.0) * iw as f32) as u32;
            let cy = (y.clamp(0.0, 1.0) * ih as f32) as u32;
            let cw = (w.clamp(0.0, 1.0) * iw as f32).round().max(1.0) as u32;
            let ch = (h.clamp(0.0, 1.0) * ih as f32).round().max(1.0) as u32;
            let cw = cw.min(iw.saturating_sub(cx)).max(1);
            let ch = ch.min(ih.saturating_sub(cy)).max(1);
            img.crop_imm(cx, cy, cw, ch)
        }
        EditOp::Brightness { value } => img.brighten((value.clamp(-1.0, 1.0) * 100.0) as i32),
        EditOp::Contrast { value } => img.adjust_contrast(value.clamp(-1.0, 1.0) * 50.0),
        EditOp::Saturation { value } => {
            let mut buf = img.to_rgba8();
            adjust_saturation(&mut buf, value.clamp(-1.0, 1.0));
            DynamicImage::ImageRgba8(buf)
        }
        EditOp::Filter { name } => apply_filter(img, name),
    }
}

/// Saturation around per-pixel luma: factor 0 = grayscale, 1 = unchanged, 2 = doubled.
fn adjust_saturation(img: &mut RgbaImage, sat: f32) {
    let factor = 1.0 + sat;
    for p in img.pixels_mut() {
        let [r, g, b, a] = p.0;
        let l = 0.299 * r as f32 + 0.587 * g as f32 + 0.114 * b as f32;
        p.0 = [
            (l + (r as f32 - l) * factor).clamp(0.0, 255.0) as u8,
            (l + (g as f32 - l) * factor).clamp(0.0, 255.0) as u8,
            (l + (b as f32 - l) * factor).clamp(0.0, 255.0) as u8,
            a,
        ];
    }
}

fn apply_filter(img: DynamicImage, name: &str) -> DynamicImage {
    match name {
        "grayscale" => {
            let mut buf = img.to_rgba8();
            for p in buf.pixels_mut() {
                let [r, g, b, a] = p.0;
                let l = (0.299 * r as f32 + 0.587 * g as f32 + 0.114 * b as f32) as u8;
                p.0 = [l, l, l, a];
            }
            DynamicImage::ImageRgba8(buf)
        }
        "sepia" => channel_matrix(img, [[0.393, 0.769, 0.189], [0.349, 0.686, 0.168], [0.272, 0.534, 0.131]]),
        // Warm: lift reds, drop blues. Cool: the inverse.
        "warm" => tint(img, 18, 6, -16),
        "cool" => tint(img, -16, 4, 20),
        "ink" => xdog_ink(img),
        "pencil" => pencil_sketch(img),
        _ => img,
    }
}

fn channel_matrix(img: DynamicImage, m: [[f32; 3]; 3]) -> DynamicImage {
    let mut buf = img.to_rgba8();
    for p in buf.pixels_mut() {
        let [r, g, b, a] = p.0;
        let (rf, gf, bf) = (r as f32, g as f32, b as f32);
        p.0 = [
            (m[0][0] * rf + m[0][1] * gf + m[0][2] * bf).clamp(0.0, 255.0) as u8,
            (m[1][0] * rf + m[1][1] * gf + m[1][2] * bf).clamp(0.0, 255.0) as u8,
            (m[2][0] * rf + m[2][1] * gf + m[2][2] * bf).clamp(0.0, 255.0) as u8,
            a,
        ];
    }
    DynamicImage::ImageRgba8(buf)
}

fn tint(img: DynamicImage, dr: i32, dg: i32, db: i32) -> DynamicImage {
    let mut buf = img.to_rgba8();
    for p in buf.pixels_mut() {
        let [r, g, b, a] = p.0;
        p.0 = [
            (r as i32 + dr).clamp(0, 255) as u8,
            (g as i32 + dg).clamp(0, 255) as u8,
            (b as i32 + db).clamp(0, 255) as u8,
            a,
        ];
    }
    DynamicImage::ImageRgba8(buf)
}

fn to_gray(img: &DynamicImage) -> GrayImage {
    img.to_luma8()
}

/// XDoG "ink" line drawing: difference of two Gaussian blurs at different scales → crisp
/// edges, softened with a tanh ramp.
fn xdog_ink(img: DynamicImage) -> DynamicImage {
    let gray = to_gray(&img);
    let (w, h) = gray.dimensions();
    let sigma = 0.8f32;
    let k = 1.6f32;
    let tau = 0.985f32;
    let phi = 10.0f32;
    let eps = -0.02f32;
    let g1 = image::imageops::blur(&gray, sigma);
    let g2 = image::imageops::blur(&gray, sigma * k);
    let mut out = RgbaImage::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let a = g1.get_pixel(x, y).0[0] as f32 / 255.0;
            let b = g2.get_pixel(x, y).0[0] as f32 / 255.0;
            let dog = a - tau * b;
            let ink = if dog >= eps { 1.0 } else { 1.0 + (phi * (dog - eps)).tanh() };
            let v = (ink.clamp(0.0, 1.0) * 255.0) as u8;
            out.put_pixel(x, y, image::Rgba([v, v, v, 255]));
        }
    }
    DynamicImage::ImageRgba8(out)
}

/// Classic pencil-sketch via the color-dodge of gray over its inverted blur.
fn pencil_sketch(img: DynamicImage) -> DynamicImage {
    let gray = to_gray(&img);
    let (w, h) = gray.dimensions();
    let mut inv = GrayImage::new(w, h);
    for (x, y, p) in gray.enumerate_pixels() {
        inv.put_pixel(x, y, image::Luma([255 - p.0[0]]));
    }
    let blurred = image::imageops::blur(&inv, 12.0);
    let mut out = RgbaImage::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let g = gray.get_pixel(x, y).0[0] as u32;
            let b = blurred.get_pixel(x, y).0[0] as u32;
            let denom = (255 - b).max(1);
            let v = ((g * 255) / denom).min(255) as u8;
            out.put_pixel(x, y, image::Rgba([v, v, v, 255]));
        }
    }
    DynamicImage::ImageRgba8(out)
}

/// Optionally downscale (for a fast preview — geometry ops are normalized and uniform ops are
/// resolution-independent, so the look matches the full-resolution export), then apply every
/// recipe op in order.
pub fn render_recipe(mut img: DynamicImage, recipe: &Recipe, max_dim: Option<u32>) -> DynamicImage {
    if let Some(md) = max_dim {
        if img.width().max(img.height()) > md {
            img = img.thumbnail(md, md);
        }
    }
    for op in &recipe.ops {
        img = apply_op(img, op);
    }
    img
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_recipe_with_known_ops() {
        let r = parse_recipe(
            r#"{"ops":[{"op":"rotate","degrees":90},{"op":"brightness","value":0.2},{"op":"filter","name":"ink"}]}"#,
        )
        .unwrap();
        assert_eq!(r.ops.len(), 3);
    }

    #[test]
    fn empty_recipe_is_valid() {
        assert_eq!(parse_recipe("{}").unwrap().ops.len(), 0);
        assert_eq!(parse_recipe(r#"{"ops":[]}"#).unwrap().ops.len(), 0);
    }

    #[test]
    fn rejects_malformed_json() {
        assert!(parse_recipe("not json").is_err());
    }

    fn synthetic(w: u32, h: u32) -> DynamicImage {
        let mut buf = RgbaImage::new(w, h);
        for (x, y, p) in buf.enumerate_pixels_mut() {
            *p = image::Rgba([(x * 32) as u8, (y * 32) as u8, 128, 255]);
        }
        DynamicImage::ImageRgba8(buf)
    }

    #[test]
    fn renders_ops_on_a_synthetic_image() {
        let recipe = parse_recipe(
            r#"{"ops":[
                {"op":"crop","x":0,"y":0,"w":0.5,"h":0.5},
                {"op":"rotate","degrees":270},
                {"op":"flip_h"},
                {"op":"saturation","value":0.5},
                {"op":"contrast","value":0.3},
                {"op":"filter","name":"pencil"}
            ]}"#,
        )
        .unwrap();
        let out = render_recipe(synthetic(8, 8), &recipe, Some(64));
        assert!(out.width() > 0 && out.height() > 0);
    }

    #[test]
    fn decode_bounded_bytes_round_trips_through_png() {
        let png = encode_png(&synthetic(8, 8)).unwrap();
        let decoded = decode_bounded_bytes(&png).unwrap();
        assert_eq!((decoded.width(), decoded.height()), (8, 8));
    }
}
