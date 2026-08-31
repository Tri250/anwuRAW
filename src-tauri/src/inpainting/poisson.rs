use image::{DynamicImage, GenericImageView, Rgb, RgbImage};

use super::encode_patch_result;

/// 端侧泊松融合修复（Heal 算法）
///
/// 完整真实实现：SOR 迭代 + 自适应收敛。
/// 用于 Heal 工具的泊松融合，也作为 Lama ONNX 模型不可用时的降级路径，
/// 保证端侧修复在任何网络条件下都能使用。
pub fn poisson_heal_fill(
    source_image: &DynamicImage,
    mask_bitmap: &image::GrayImage,
    bounds: (usize, usize, usize, usize),
    offset_x: i32,
    offset_y: i32,
    is_raw: bool,
    quality: u8,
) -> Result<String, String> {
    let (min_x, max_x, min_y, max_y) = bounds;
    let (img_w, img_h) = source_image.dimensions();

    let min_x_u32 = min_x as u32;
    let min_y_u32 = min_y as u32;
    let crop_w = (max_x - min_x + 1) as u32;
    let crop_h = (max_y - min_y + 1) as u32;

    let bw = max_x - min_x + 3;
    let bh = max_y - min_y + 3;

    let mut v_r = vec![0.0f32; bw * bh];
    let mut v_g = vec![0.0f32; bw * bh];
    let mut v_b = vec![0.0f32; bw * bh];

    let mut region = vec![0u8; bw * bh];

    for y in 0..bh {
        for x in 0..bw {
            let img_x = min_x as i32 + x as i32 - 1;
            let img_y = min_y as i32 + y as i32 - 1;

            if img_x >= 0
                && img_x < img_w as i32
                && img_y >= 0
                && img_y < img_h as i32
                && mask_bitmap.get_pixel(img_x as u32, img_y as u32)[0] > 0
            {
                region[y * bw + x] = 1;
            }
        }
    }

    let mut omega_coords = Vec::with_capacity(bw * bh);

    for y in 1..(bh - 1) {
        for x in 1..(bw - 1) {
            if region[y * bw + x] == 0 {
                if region[(y - 1) * bw + x] == 1
                    || region[(y + 1) * bw + x] == 1
                    || region[y * bw + x - 1] == 1
                    || region[y * bw + x + 1] == 1
                {
                    region[y * bw + x] = 2;

                    let img_x = (min_x as i32 + x as i32 - 1) as u32;
                    let img_y = (min_y as i32 + y as i32 - 1) as u32;

                    let src_x = (img_x as i32 + offset_x).clamp(0, img_w as i32 - 1) as u32;
                    let src_y = (img_y as i32 + offset_y).clamp(0, img_h as i32 - 1) as u32;

                    let dest_px = source_image.get_pixel(img_x, img_y);
                    let src_px = source_image.get_pixel(src_x, src_y);

                    v_r[y * bw + x] = dest_px[0] as f32 - src_px[0] as f32;
                    v_g[y * bw + x] = dest_px[1] as f32 - src_px[1] as f32;
                    v_b[y * bw + x] = dest_px[2] as f32 - src_px[2] as f32;
                }
            } else if region[y * bw + x] == 1 {
                omega_coords.push((x, y));
            }
        }
    }

    let omega = 1.6f32;
    let eps = 0.05f32;
    let max_iterations = 400usize;
    let mut active_coords = omega_coords.clone();
    let mut stable_sweeps = vec![0u8; active_coords.len()];

    for _ in 0..max_iterations {
        let mut next_active = Vec::with_capacity(active_coords.len());
        let mut max_delta = 0.0f32;

        for (i, &(x, y)) in active_coords.iter().enumerate() {
            let idx = y * bw + x;
            let sum_r = v_r[idx - bw] + v_r[idx + bw] + v_r[idx - 1] + v_r[idx + 1];
            let sum_g = v_g[idx - bw] + v_g[idx + bw] + v_g[idx - 1] + v_g[idx + 1];
            let sum_b = v_b[idx - bw] + v_b[idx + bw] + v_b[idx - 1] + v_b[idx + 1];

            let nb_r = (1.0 - omega) * v_r[idx] + omega * 0.25 * sum_r;
            let nb_g = (1.0 - omega) * v_g[idx] + omega * 0.25 * sum_g;
            let nb_b = (1.0 - omega) * v_b[idx] + omega * 0.25 * sum_b;

            let d_r = (nb_r - v_r[idx]).abs();
            let d_g = (nb_g - v_g[idx]).abs();
            let d_b = (nb_b - v_b[idx]).abs();
            let d = d_r.max(d_g.max(d_b));
            if d > max_delta {
                max_delta = d;
            }

            v_r[idx] = nb_r;
            v_g[idx] = nb_g;
            v_b[idx] = nb_b;

            if d <= eps && stable_sweeps[i] < 2 {
                stable_sweeps[i] += 1;
                next_active.push((x, y));
            } else if d > eps {
                stable_sweeps[i] = 0;
                next_active.push((x, y));
            }
        }

        if next_active.is_empty() || max_delta < eps {
            break;
        }
        active_coords = next_active;
    }

    let mut color_image = RgbImage::new(crop_w, crop_h);
    for &(x, y) in &omega_coords {
        let img_x = (min_x as i32 + x as i32 - 1) as u32;
        let img_y = (min_y as i32 + y as i32 - 1) as u32;

        let src_x = (img_x as i32 + offset_x).clamp(0, img_w as i32 - 1) as u32;
        let src_y = (img_y as i32 + offset_y).clamp(0, img_h as i32 - 1) as u32;
        let src_px = source_image.get_pixel(src_x, src_y);

        let idx = y * bw + x;
        let out_r = (src_px[0] as f32 + v_r[idx]).clamp(0.0, 255.0) as u8;
        let out_g = (src_px[1] as f32 + v_g[idx]).clamp(0.0, 255.0) as u8;
        let out_b = (src_px[2] as f32 + v_b[idx]).clamp(0.0, 255.0) as u8;

        let out_x = img_x as i32 - min_x as i32;
        let out_y = img_y as i32 - min_y as i32;
        if out_x >= 0 && out_x < crop_w as i32 && out_y >= 0 && out_y < crop_h as i32 {
            color_image.put_pixel(out_x as u32, out_y as u32, Rgb([out_r, out_g, out_b]));
        }
    }

    let output_mask =
        image::imageops::crop_imm(mask_bitmap, min_x_u32, min_y_u32, crop_w, crop_h).to_image();

    encode_patch_result(
        &color_image,
        &output_mask,
        min_x_u32,
        min_y_u32,
        crop_w,
        crop_h,
        is_raw,
        quality,
        false,
    )
}
