//! Selection-based erase / background-removal: build a 1-byte-per-pixel mask via colour-key
//! (global colour match, not a connected flood-fill), a freehand LASSO polygon, a BRUSH stroke
//! (the eraser tool), or a RECT/ELLIPSE shape — then commit it as transparency. Magic-wand
//! selection itself is already covered by `inpaint::magic_wand_mask`/`dilate_mask` (reused
//! as-is here); this module is the OTHER selection methods plus the shared "make it
//! transparent" commit step every one of them ends with.

use image::RgbaImage;

/// Global colour-key: every pixel within `tolerance` of `target`, anywhere in the image (not
/// just a connected blob the way `magic_wand_mask` is) — the "remove this background colour"
/// tool.
pub fn color_key_mask(img: &RgbaImage, target: [u8; 3], tolerance: f32) -> Vec<u8> {
    let (w, h) = img.dimensions();
    let tol2 = tolerance * tolerance * 3.0;
    let mut mask = vec![0u8; (w * h) as usize];
    for (i, p) in img.pixels().enumerate() {
        let dr = p.0[0] as f32 - target[0] as f32;
        let dg = p.0[1] as f32 - target[1] as f32;
        let db = p.0[2] as f32 - target[2] as f32;
        if dr * dr + dg * dg + db * db <= tol2 {
            mask[i] = 1;
        }
    }
    mask
}

/// Even-odd point-in-polygon test.
fn point_in_polygon(px: f32, py: f32, poly: &[(f32, f32)]) -> bool {
    let mut inside = false;
    let n = poly.len();
    let mut j = n - 1;
    for i in 0..n {
        let (xi, yi) = poly[i];
        let (xj, yj) = poly[j];
        if (yi > py) != (yj > py) {
            let slope = (xj - xi) / (yj - yi);
            let xint = xi + (py - yi) * slope;
            if px < xint {
                inside = !inside;
            }
        }
        j = i;
    }
    inside
}

/// A freehand lasso selection: fill the polygon traced by `points_frac` (fractions 0..1 of the
/// image's own size, as drawn by the user). Fewer than 3 points selects nothing.
pub fn lasso_mask(width: u32, height: u32, points_frac: &[(f32, f32)]) -> Vec<u8> {
    let mut mask = vec![0u8; (width * height) as usize];
    if points_frac.len() < 3 {
        return mask;
    }
    let poly: Vec<(f32, f32)> = points_frac
        .iter()
        .map(|(x, y)| (x * width as f32, y * height as f32))
        .collect();
    for y in 0..height {
        for x in 0..width {
            if point_in_polygon(x as f32 + 0.5, y as f32 + 0.5, &poly) {
                mask[(y * width + x) as usize] = 1;
            }
        }
    }
    mask
}

/// The eraser tool: stamp a filled circle of `radius_frac` (fraction of the image WIDTH) at
/// every point along the dragged path (fractions 0..1), unioned into one mask.
pub fn brush_mask(width: u32, height: u32, points_frac: &[(f32, f32)], radius_frac: f32) -> Vec<u8> {
    let mut mask = vec![0u8; (width * height) as usize];
    let r = (radius_frac * width as f32).max(1.0);
    let r2 = r * r;
    for &(px, py) in points_frac {
        let cx = px * width as f32;
        let cy = py * height as f32;
        let x0 = (cx - r).floor().max(0.0) as u32;
        let x1 = (cx + r).ceil().min(width as f32 - 1.0) as u32;
        let y0 = (cy - r).floor().max(0.0) as u32;
        let y1 = (cy + r).ceil().min(height as f32 - 1.0) as u32;
        if x1 < x0 || y1 < y0 {
            continue;
        }
        for y in y0..=y1 {
            for x in x0..=x1 {
                let dx = x as f32 + 0.5 - cx;
                let dy = y as f32 + 0.5 - cy;
                if dx * dx + dy * dy <= r2 {
                    mask[(y * width + x) as usize] = 1;
                }
            }
        }
    }
    mask
}

pub enum ShapeKind {
    Rect,
    Ellipse,
}

/// A rectangular or elliptical shape selection (fractions 0..1 of the image's own size) —
/// "select this region and delete it."
pub fn shape_mask(width: u32, height: u32, kind: ShapeKind, x: f32, y: f32, w: f32, h: f32) -> Vec<u8> {
    let mut mask = vec![0u8; (width * height) as usize];
    let x0 = (x * width as f32) as i64;
    let y0 = (y * height as f32) as i64;
    let rw = (w * width as f32) as i64;
    let rh = (h * height as f32) as i64;
    let cx = x0 as f32 + rw as f32 / 2.0;
    let cy = y0 as f32 + rh as f32 / 2.0;
    let rx = rw as f32 / 2.0;
    let ry = rh as f32 / 2.0;
    for py in 0..height as i64 {
        for px in 0..width as i64 {
            let inside = match kind {
                ShapeKind::Rect => px >= x0 && px < x0 + rw && py >= y0 && py < y0 + rh,
                ShapeKind::Ellipse => {
                    if rx <= 0.0 || ry <= 0.0 {
                        false
                    } else {
                        let nx = (px as f32 + 0.5 - cx) / rx;
                        let ny = (py as f32 + 0.5 - cy) / ry;
                        nx * nx + ny * ny <= 1.0
                    }
                }
            };
            if inside {
                mask[(py as u32 * width + px as u32) as usize] = 1;
            }
        }
    }
    mask
}

/// Commit a mask as transparency (alpha = 0) — the shared "erase" step every selection method
/// (lasso, magic-wand, colour-key, brush, shape) ends with.
pub fn apply_alpha_mask(img: &mut RgbaImage, mask: &[u8]) {
    for (i, p) in img.pixels_mut().enumerate() {
        if mask[i] != 0 {
            p.0[3] = 0;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    fn checkerboard(w: u32, h: u32) -> RgbaImage {
        let mut img = RgbaImage::new(w, h);
        for y in 0..h {
            for x in 0..w {
                let v = if (x + y) % 2 == 0 { 200 } else { 40 };
                img.put_pixel(x, y, Rgba([v, v, v, 255]));
            }
        }
        img
    }

    #[test]
    fn color_key_selects_matching_pixels_anywhere() {
        let mut img = RgbaImage::new(4, 1);
        img.put_pixel(0, 0, Rgba([0, 255, 0, 255]));
        img.put_pixel(1, 0, Rgba([10, 10, 10, 255]));
        img.put_pixel(2, 0, Rgba([0, 250, 5, 255]));
        img.put_pixel(3, 0, Rgba([10, 10, 10, 255]));
        let mask = color_key_mask(&img, [0, 255, 0], 20.0);
        assert_eq!(mask, vec![1, 0, 1, 0]);
    }

    #[test]
    fn lasso_fills_a_triangle() {
        let mask = lasso_mask(10, 10, &[(0.1, 0.1), (0.9, 0.1), (0.5, 0.9)]);
        assert!(mask.iter().any(|&m| m != 0));
        // The far corners (outside the triangle) should not be selected.
        assert_eq!(mask[0], 0); // top-left corner pixel
    }

    #[test]
    fn lasso_with_fewer_than_3_points_selects_nothing() {
        let mask = lasso_mask(10, 10, &[(0.1, 0.1), (0.9, 0.9)]);
        assert!(mask.iter().all(|&m| m == 0));
    }

    #[test]
    fn brush_mask_stamps_a_circle_at_each_point() {
        let mask = brush_mask(20, 20, &[(0.5, 0.5)], 0.1);
        let count = mask.iter().filter(|&&m| m != 0).count();
        assert!(count > 0);
        // Centre pixel must be selected.
        assert_eq!(mask[10 * 20 + 10], 1);
    }

    #[test]
    fn shape_mask_rect_and_ellipse_differ() {
        let rect = shape_mask(20, 20, ShapeKind::Rect, 0.25, 0.25, 0.5, 0.5);
        let ellipse = shape_mask(20, 20, ShapeKind::Ellipse, 0.25, 0.25, 0.5, 0.5);
        let rect_count = rect.iter().filter(|&&m| m != 0).count();
        let ellipse_count = ellipse.iter().filter(|&&m| m != 0).count();
        assert!(rect_count > ellipse_count); // the ellipse is inscribed in the rect
    }

    #[test]
    fn apply_alpha_mask_zeroes_alpha_on_masked_pixels_only() {
        let mut img = checkerboard(4, 4);
        let mut mask = vec![0u8; 16];
        mask[5] = 1;
        apply_alpha_mask(&mut img, &mask);
        assert_eq!(img.get_pixel(1, 1).0[3], 0);
        assert_eq!(img.get_pixel(0, 0).0[3], 255);
    }
}
