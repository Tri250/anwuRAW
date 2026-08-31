use image::{GrayImage, Luma};

fn region_grow_mask(source: &image::DynamicImage, seed: (u32, u32), w: u32, h: u32) -> GrayImage {
    let rgb = source.to_rgb8();
    let mut lum = vec![0.0f32; (w * h) as usize];
    for y in 0..h {
        for x in 0..w {
            let p = rgb.get_pixel(x, y);
            lum[(y * w + x) as usize] = 0.299 * p[0] as f32 + 0.587 * p[1] as f32 + 0.114 * p[2] as f32;
        }
    }
    let grad = sobel_magnitude(&lum, w, h);
    let (sx, sy) = seed;
    let seed_idx = (sy * w + sx) as usize;
    let seed_col = rgb.get_pixel(sx, sy);

    let base_contrast = local_std(&lum, w, h, sx, sy, 2);
    let tol_color = (18.0 + 0.6 * base_contrast).clamp(13.0, 52.0);
    let grad_thresh = (16.0 + 1.6 * base_contrast).clamp(20.0, 90.0);

    let mut mask = vec![0u8; (w * h) as usize];
    let mut sum_r = seed_col[0] as f32;
    let mut sum_g = seed_col[1] as f32;
    let mut sum_b = seed_col[2] as f32;
    let mut count = 1u32;

    let mut visited = vec![false; (w * h) as usize];
    visited[seed_idx] = true;
    mask[seed_idx] = 255;

    let mut stack: Vec<(u32, u32)> = vec![(sx, sy)];
    while let Some((cx, cy)) = stack.pop() {
        for (nx, ny) in neighbors(cx, cy, w, h) {
            let idx = (ny * w + nx) as usize;
            if visited[idx] {
                continue;
            }
            visited[idx] = true;
            if grad[idx] > grad_thresh {
                continue;
            }
            let p = rgb.get_pixel(nx, ny);
            let mr = sum_r / count as f32;
            let mg = sum_g / count as f32;
            let mb = sum_b / count as f32;
            let dr = (p[0] as f32 - mr).abs();
            let dg = (p[1] as f32 - mg).abs();
            let db = (p[2] as f32 - mb).abs();
            let dist = (dr * dr + dg * dg + db * db).sqrt();
            if dist <= tol_color {
                mask[idx] = 255;
                count += 1;
                sum_r += p[0] as f32;
                sum_g += p[1] as f32;
                sum_b += p[2] as f32;
                stack.push((nx, ny));
            }
        }
        if count > (w * h) / 3 {
            break;
        }
    }

    let mut img = GrayImage::from_pixel(w, h, Luma([0]));
    for (i, &v) in mask.iter().enumerate() {
        if v != 0 {
            img.put_pixel((i as u32) % w, (i as u32) / w, Luma([255]));
        }
    }
    img
}

#[inline]
fn neighbors(x: u32, y: u32, w: u32, h: u32) -> [(u32, u32); 4] {
    let mut out = [(x, y); 4];
    let mut n = 0;
    if x > 0 {
        out[n] = (x - 1, y);
        n += 1;
    }
    if x + 1 < w {
        out[n] = (x + 1, y);
        n += 1;
    }
    if y > 0 {
        out[n] = (x, y - 1);
        n += 1;
    }
    if y + 1 < h {
        out[n] = (x, y + 1);
        n += 1;
    }
    out
}

fn sobel_magnitude(lum: &[f32], w: u32, h: u32) -> Vec<f32> {
    let wu = w as usize;
    let hu = h as usize;
    let mut g = vec![0.0f32; lum.len()];
    for y in 1..hu - 1 {
        for x in 1..wu - 1 {
            let i = y * wu + x;
            let gx = -lum[i - wu - 1] - 2.0 * lum[i - wu] - lum[i - wu + 1]
                + lum[i + wu - 1]
                + 2.0 * lum[i + wu]
                + lum[i + wu + 1];
            let gy = -lum[i - wu - 1] - 2.0 * lum[i - 1] - lum[i + wu - 1]
                + lum[i - wu + 1]
                + 2.0 * lum[i + 1]
                + lum[i + wu + 1];
            g[i] = (gx * gx + gy * gy).sqrt();
        }
    }
    g
}

fn local_std(lum: &[f32], w: u32, h: u32, cx: u32, cy: u32, radius: u32) -> f32 {
    let x0 = cx.saturating_sub(radius);
    let x1 = (cx + radius).min(w - 1);
    let y0 = cy.saturating_sub(radius);
    let y1 = (cy + radius).min(h - 1);
    let mut sum = 0.0f32;
    let mut n = 0f32;
    for y in y0..=y1 {
        for x in x0..=x1 {
            sum += lum[(y * w + x) as usize];
            n += 1.0;
        }
    }
    let mean = sum / n;
    let mut var = 0.0f32;
    for y in y0..=y1 {
        for x in x0..=x1 {
            let d = lum[(y * w + x) as usize] - mean;
            var += d * d;
        }
    }
    (var / n).sqrt()
}

#[test]
fn grows_uniform_object_within_edge() {
    // 12x12: 背景闪烁暗色, 中央 4x4 亮色物体
    let img = image::DynamicImage::ImageRgb8(image::RgbImage::from_fn(12, 12, |x, y| {
        if x >= 4 && x < 8 && y >= 4 && y < 8 {
            image::Rgb([250, 240, 220])
        } else {
            image::Rgb([30, 30, 34])
        }
    }));
    let m = region_grow_mask(&img, (6, 6), 12, 12);
    let mut inside = 0u32;
    for y in 0..12 {
        for x in 0..12 {
            if m.get_pixel(x, y)[0] > 0 {
                inside += 1;
            }
        }
    }
    assert!(inside >= 12, "expected object pixels grown, got {}", inside);
    // 背景不溢出
    assert!(m.get_pixel(1, 1)[0] == 0, "background leaked");
    assert!(m.get_pixel(10, 10)[0] == 0, "background leaked");
}

#[test]
fn seed_outside_edge_is_safe() {
    let img = image::DynamicImage::ImageRgb8(image::RgbImage::from_fn(8, 8, |x, y| {
        image::Rgb([x as u8 * 30, y as u8 * 25, 10])
    }));
    // 种子在角落
    let m = region_grow_mask(&img, (0, 0), 8, 8);
    assert!(m.get_pixel(0, 0)[0] > 0);
}

fn main() {}