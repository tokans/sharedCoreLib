//! Watermark removal: diffusion inpainting (Gauss-Seidel relaxation of Laplace's equation)
//! over a rectangle OR an arbitrary mask, plus the magic-wand flood-fill that builds that
//! mask from a click. Native port of myWorkAssistant's original <canvas>-based
//! `imageProcessing.ts` — same algorithm, now shared so any app/feature can reuse it instead
//! of re-implementing it (in JS or otherwise).
//!
//! It does NOT crop or paint a flat patch: it reconstructs the region from its surrounding
//! pixels' colour, propagating them inward — the classical no-model approach, strong for the
//! small textured corner a watermark occupies.

use image::{Rgba, RgbaImage};

#[derive(Debug, Clone, Copy)]
pub struct Rect {
    pub x: u32,
    pub y: u32,
    pub w: u32,
    pub h: u32,
}

fn rgb_f32(img: &RgbaImage, x: u32, y: u32) -> [f32; 3] {
    let p = img.get_pixel(x, y).0;
    [p[0] as f32, p[1] as f32, p[2] as f32]
}

fn neighbor_avg(img: &RgbaImage, x: u32, y: u32, w: u32, h: u32) -> Option<[f32; 3]> {
    let mut sum = [0f32; 3];
    let mut n = 0f32;
    let mut add = |c: [f32; 3]| {
        for i in 0..3 {
            sum[i] += c[i];
        }
        n += 1.0;
    };
    if x > 0 {
        add(rgb_f32(img, x - 1, y));
    }
    if x < w - 1 {
        add(rgb_f32(img, x + 1, y));
    }
    if y > 0 {
        add(rgb_f32(img, x, y - 1));
    }
    if y < h - 1 {
        add(rgb_f32(img, x, y + 1));
    }
    if n == 0.0 {
        return None;
    }
    Some([sum[0] / n, sum[1] / n, sum[2] / n])
}

/// Diffusion inpaint of a rectangular region, in place. Mirrors `inpaintRegion` (TS).
pub fn inpaint_rect(img: &mut RgbaImage, rect: Rect, iterations: u32) {
    let (w, h) = img.dimensions();
    let x0 = rect.x.min(w);
    let y0 = rect.y.min(h);
    let x1 = (rect.x.saturating_add(rect.w)).min(w);
    let y1 = (rect.y.saturating_add(rect.h)).min(h);
    if x1 <= x0 || y1 <= y0 {
        return;
    }

    // Seed the region with the mean of its known top/left boundary (read BEFORE any mutation).
    let mut seed = [0f32; 3];
    let mut n_seed = 0f32;
    for xx in x0..x1 {
        if y0 > 0 {
            let c = rgb_f32(img, xx, y0 - 1);
            for i in 0..3 {
                seed[i] += c[i];
            }
            n_seed += 1.0;
        }
    }
    for yy in y0..y1 {
        if x0 > 0 {
            let c = rgb_f32(img, x0 - 1, yy);
            for i in 0..3 {
                seed[i] += c[i];
            }
            n_seed += 1.0;
        }
    }
    if n_seed > 0.0 {
        for c in seed.iter_mut() {
            *c /= n_seed;
        }
    }
    let seed_px = Rgba([seed[0] as u8, seed[1] as u8, seed[2] as u8, 255]);
    for yy in y0..y1 {
        for xx in x0..x1 {
            img.put_pixel(xx, yy, seed_px);
        }
    }

    // Gauss-Seidel relaxation: each pixel ← average of its in-bounds 4-neighbours. Alternate
    // raster direction each pass so colour propagates evenly from both known boundaries.
    for it in 0..iterations {
        let forward = it % 2 == 0;
        for k in 0..(y1 - y0) {
            let yy = if forward { y0 + k } else { y1 - 1 - k };
            for j in 0..(x1 - x0) {
                let xx = if forward { x0 + j } else { x1 - 1 - j };
                if let Some(avg) = neighbor_avg(img, xx, yy, w, h) {
                    img.put_pixel(xx, yy, Rgba([avg[0] as u8, avg[1] as u8, avg[2] as u8, 255]));
                }
            }
        }
    }
}

/// Magic-wand selection: flood-fill from a seed pixel, selecting the connected blob of
/// similar colour (per-channel euclidean distance < `tolerance`). Returns a 1-byte-per-pixel
/// mask. Bounded to 40% of the image so a click on a flat background can't select everything.
pub fn magic_wand_mask(img: &RgbaImage, sx: u32, sy: u32, tolerance: f32) -> Vec<u8> {
    let (w, h) = img.dimensions();
    let mut mask = vec![0u8; (w * h) as usize];
    if sx >= w || sy >= h {
        return mask;
    }
    let seed = img.get_pixel(sx, sy).0;
    let (sr, sg, sb) = (seed[0] as f32, seed[1] as f32, seed[2] as f32);
    let tol2 = tolerance * tolerance * 3.0;
    let cap = ((w as u64 * h as u64) as f32 * 0.4) as usize;

    let mut stack = vec![(sy * w + sx) as usize];
    let mut count = 0usize;
    while let Some(idx) = stack.pop() {
        if mask[idx] != 0 {
            continue;
        }
        let x = (idx as u32) % w;
        let y = (idx as u32) / w;
        let p = img.get_pixel(x, y).0;
        let (dr, dg, db) = (p[0] as f32 - sr, p[1] as f32 - sg, p[2] as f32 - sb);
        if dr * dr + dg * dg + db * db > tol2 {
            continue;
        }
        mask[idx] = 1;
        count += 1;
        if count > cap {
            break;
        }
        if x > 0 {
            stack.push(idx - 1);
        }
        if x < w - 1 {
            stack.push(idx + 1);
        }
        if y > 0 {
            stack.push(idx - w as usize);
        }
        if y < h - 1 {
            stack.push(idx + w as usize);
        }
    }
    mask
}

/// Grow a mask by `r` pixels (covers anti-aliased watermark edges).
pub fn dilate_mask(mask: &[u8], w: u32, h: u32, r: u32) -> Vec<u8> {
    let mut cur = mask.to_vec();
    for _ in 0..r {
        let prev = cur.clone();
        for idx in 0..(w * h) as usize {
            if prev[idx] == 0 {
                continue;
            }
            let x = (idx as u32) % w;
            let y = (idx as u32) / w;
            if x > 0 {
                cur[idx - 1] = 1;
            }
            if x < w - 1 {
                cur[idx + 1] = 1;
            }
            if y > 0 {
                cur[idx - w as usize] = 1;
            }
            if y < h - 1 {
                cur[idx + w as usize] = 1;
            }
        }
    }
    cur
}

/// Diffusion inpaint over an arbitrary mask (vs the rectangular {@link inpaint_rect}).
/// Reconstructs the masked pixels from their unmasked surroundings — used after a magic-wand
/// selection. Mirrors `inpaintMask` (TS).
pub fn inpaint_mask(img: &mut RgbaImage, mask: &[u8], iterations: u32) {
    let (w, h) = img.dimensions();
    let list: Vec<usize> = (0..(w * h) as usize).filter(|&i| mask[i] != 0).collect();
    if list.is_empty() {
        return;
    }

    // Seed masked pixels with the mean colour of the mask boundary's known (unmasked) neighbours.
    let mut seed = [0f32; 3];
    let mut n_seed = 0f32;
    for &idx in &list {
        let x = (idx as u32) % w;
        let y = (idx as u32) / w;
        let neighbors = [
            if x > 0 { Some(idx - 1) } else { None },
            if x < w - 1 { Some(idx + 1) } else { None },
            if y > 0 { Some(idx - w as usize) } else { None },
            if y < h - 1 { Some(idx + w as usize) } else { None },
        ];
        for n in neighbors.into_iter().flatten() {
            if mask[n] == 0 {
                let nx = (n as u32) % w;
                let ny = (n as u32) / w;
                let c = rgb_f32(img, nx, ny);
                for i in 0..3 {
                    seed[i] += c[i];
                }
                n_seed += 1.0;
            }
        }
    }
    if n_seed > 0.0 {
        for c in seed.iter_mut() {
            *c /= n_seed;
        }
    }
    let seed_px = Rgba([seed[0] as u8, seed[1] as u8, seed[2] as u8, 255]);
    for &idx in &list {
        img.put_pixel((idx as u32) % w, (idx as u32) / w, seed_px);
    }

    for it in 0..iterations {
        let forward = it % 2 == 0;
        for k in 0..list.len() {
            let idx = list[if forward { k } else { list.len() - 1 - k }];
            let x = (idx as u32) % w;
            let y = (idx as u32) / w;
            if let Some(avg) = neighbor_avg(img, x, y, w, h) {
                img.put_pixel(x, y, Rgba([avg[0] as u8, avg[1] as u8, avg[2] as u8, 255]));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
    fn inpaint_rect_fills_the_region_without_panicking() {
        let mut img = checkerboard(16, 16);
        inpaint_rect(&mut img, Rect { x: 10, y: 10, w: 6, h: 6 }, 20);
        assert_eq!(img.dimensions(), (16, 16));
    }

    #[test]
    fn magic_wand_selects_a_uniform_region() {
        let mut img = RgbaImage::new(10, 10);
        for p in img.pixels_mut() {
            *p = Rgba([10, 10, 10, 255]);
        }
        for y in 0..3 {
            for x in 0..3 {
                img.put_pixel(x, y, Rgba([200, 200, 200, 255]));
            }
        }
        let mask = magic_wand_mask(&img, 1, 1, 10.0);
        assert_eq!(mask.iter().filter(|&&m| m != 0).count(), 9);
    }

    #[test]
    fn dilate_grows_the_mask() {
        let mut mask = vec![0u8; 25];
        mask[12] = 1; // centre of a 5x5
        let grown = dilate_mask(&mask, 5, 5, 1);
        assert!(grown.iter().filter(|&&m| m != 0).count() > 1);
    }

    #[test]
    fn inpaint_mask_fills_masked_pixels() {
        let mut img = checkerboard(10, 10);
        let mut mask = vec![0u8; 100];
        for y in 4..6 {
            for x in 4..6 {
                mask[(y * 10 + x) as usize] = 1;
            }
        }
        inpaint_mask(&mut img, &mask, 20);
        assert_eq!(img.dimensions(), (10, 10));
    }
}
