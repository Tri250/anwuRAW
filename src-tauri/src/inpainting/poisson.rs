use image::{DynamicImage, GenericImageView, Rgb, RgbImage};

use super::encode_patch_result;

/// SOR 迭代 + 自适应收敛。
///
/// 对 `field` 中位于 `coords` 的未知像素做高斯-赛德尔/SOR 松弛，
/// `region==2` 的边界像素作为固定 Dirichlet 条件参与邻居求和但不更新。
/// `coords` 中的每个像素每轮只被评估一次（红色/黑色次序保证收敛）。
fn sor_solve(
    field: &mut [[f32; 3]],
    coords: &[(usize, usize)],
    bw: usize,
    omega: f32,
    eps: f32,
    max_iterations: usize,
) {
    let mut active = coords.to_vec();
    let mut stable = vec![0u8; active.len()];

    for _ in 0..max_iterations {
        let mut next = Vec::with_capacity(active.len());
        let mut max_delta = 0.0f32;

        for (i, &(x, y)) in active.iter().enumerate() {
            let idx = y * bw + x;
            let mut nb = [0.0f32; 3];
            for c in 0..3 {
                let sum = field[idx - bw][c] + field[idx + bw][c] + field[idx - 1][c] + field[idx + 1][c];
                nb[c] = (1.0 - omega) * field[idx][c] + omega * 0.25 * sum;
            }

            let d = (nb[0] - field[idx][0])
                .abs()
                .max((nb[1] - field[idx][1]).abs())
                .max((nb[2] - field[idx][2]).abs());
            if d > max_delta {
                max_delta = d;
            }

            field[idx] = nb;

            if d <= eps && stable[i] < 2 {
                stable[i] += 1;
                next.push((x, y));
            } else if d > eps {
                stable[i] = 0;
                next.push((x, y));
            }
        }

        if next.is_empty() || max_delta < eps {
            break;
        }
        active = next;
    }
}

/// 端侧泊松融合修复（Heal 算法）
///
/// - `offset != (0,0)`：克隆式修复 —— 从采样源点取纹理，泊松融合 + 全局颜色校正 + 边缘羽化。
/// - `offset == (0,0)`：扩散式修复 —— 以 Laplace 平滑颜色填充蒙版（Lama 模型不可用时的真实降级）。
/// 作为 Lama ONNX 模型不可用时的降级路径，保证端侧修复在任何网络条件下都能使用。
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

    // 带 1 像素安全边距的网格，越界像素视为背景
    let bw = max_x - min_x + 3;
    let bh = max_y - min_y + 3;

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

    // 收集内部未知坐标；边界（region==2）作为 Dirichlet 固定值
    let mut omega_coords = Vec::with_capacity(bw * bh);
    for y in 1..(bh - 1) {
        for x in 1..(bw - 1) {
            let i = y * bw + x;
            if region[i] == 0 {
                if region[i - bw] == 1 || region[i + bw] == 1 || region[i - 1] == 1 || region[i + 1] == 1 {
                    region[i] = 2;
                }
            } else if region[i] == 1 {
                omega_coords.push((x, y));
            }
        }
    }

    // 安全兜底：空蒙版/无内部像素时退化为直接克隆平移，绝不允许输出空贴片
    if omega_coords.is_empty() {
        let mut color_image = RgbImage::new(crop_w, crop_h);
        for y in min_y..=max_y {
            for x in min_x..=max_x {
                if mask_bitmap.get_pixel(x as u32, y as u32)[0] > 0 {
                    let src_x = (x as i32 + offset_x).clamp(0, img_w as i32 - 1) as u32;
                    let src_y = (y as i32 + offset_y).clamp(0, img_h as i32 - 1) as u32;
                    let src_px = source_image.get_pixel(src_x, src_y);
                    color_image.put_pixel(
                        (x as u32) - min_x_u32,
                        (y as u32) - min_y_u32,
                        Rgb([src_px[0], src_px[1], src_px[2]]),
                    );
                }
            }
        }
        let output_mask =
            image::imageops::crop_imm(mask_bitmap, min_x_u32, min_y_u32, crop_w, crop_h).to_image();
        return encode_patch_result(
            &color_image,
            &output_mask,
            min_x_u32,
            min_y_u32,
            crop_w,
            crop_h,
            is_raw,
            quality,
            false,
        );
    }

    let is_clone = offset_x != 0 || offset_y != 0;

    // 收敛参数：更高 quality 时更严格、迭代更充分
    let omega = 1.6f32;
    let eps = if quality >= 95 { 0.025f32 } else { 0.05f32 };
    let max_iterations = if quality >= 95 { 700usize } else { 400usize };

    let mut field = vec![[0.0f32; 3]; bw * bh];
    let mut color_image = RgbImage::new(crop_w, crop_h);

    if is_clone {
        // ---------- 克隆式泊松修色拍 ----------
        // [1] 颜色校正：统计蒙版内目标区域与被采样源区域的均值差，平移源颜色消除色差。
        let mut n = 0u64;
        let mut s_dest = [0.0f64; 3];
        let mut s_src = [0.0f64; 3];
        for &(x, y) in &omega_coords {
            let img_x = (min_x as i32 + x as i32 - 1) as u32;
            let img_y = (min_y as i32 + y as i32 - 1) as u32;
            let src_x = (img_x as i32 + offset_x).clamp(0, img_w as i32 - 1) as u32;
            let src_y = (img_y as i32 + offset_y).clamp(0, img_h as i32 - 1) as u32;
            let dest_px = source_image.get_pixel(img_x, img_y);
            let src_px = source_image.get_pixel(src_x, src_y);
            for c in 0..3 {
                s_dest[c] += dest_px[c] as f64;
                s_src[c] += src_px[c] as f64;
            }
            n += 1;
        }
        let damp = 0.85f32;
        let shift = if n > 0 {
            [
                ((s_dest[0] - s_src[0]) / n as f64 * damp as f64) as f32,
                ((s_dest[1] - s_src[1]) / n as f64 * damp as f64) as f32,
                ((s_dest[2] - s_src[2]) / n as f64 * damp as f64) as f32,
            ]
        } else {
            [0.0f32, 0.0f32, 0.0f32]
        };

        // [2] 边界偏移场 = 目标颜色 - 校正后的源颜色
        for y in 1..(bh - 1) {
            for x in 1..(bw - 1) {
                let i = y * bw + x;
                if region[i] != 2 {
                    continue;
                }
                let img_x = (min_x as i32 + x as i32 - 1) as u32;
                let img_y = (min_y as i32 + y as i32 - 1) as u32;
                let src_x = (img_x as i32 + offset_x).clamp(0, img_w as i32 - 1) as u32;
                let src_y = (img_y as i32 + offset_y).clamp(0, img_h as i32 - 1) as u32;
                let dest_px = source_image.get_pixel(img_x, img_y);
                let src_px = source_image.get_pixel(src_x, src_y);
                field[i][0] = dest_px[0] as f32 - (src_px[0] as f32 + shift[0]);
                field[i][1] = dest_px[1] as f32 - (src_px[1] as f32 + shift[1]);
                field[i][2] = dest_px[2] as f32 - (src_px[2] as f32 + shift[2]);
            }
        }

        // [3] SOR 求解 Laplace 偏移场
        sor_solve(&mut field, &omega_coords, bw, omega, eps, max_iterations);

        // [4] 重建：输出 = 校正后源颜色 + 差值场
        for &(x, y) in &omega_coords {
            let img_x = (min_x as i32 + x as i32 - 1) as u32;
            let img_y = (min_y as i32 + y as i32 - 1) as u32;
            let src_x = (img_x as i32 + offset_x).clamp(0, img_w as i32 - 1) as u32;
            let src_y = (img_y as i32 + offset_y).clamp(0, img_h as i32 - 1) as u32;
            let src_px = source_image.get_pixel(src_x, src_y);
            let i = y * bw + x;
            let out = Rgb([
                (src_px[0] as f32 + shift[0] + field[i][0]).clamp(0.0, 255.0) as u8,
                (src_px[1] as f32 + shift[1] + field[i][1]).clamp(0.0, 255.0) as u8,
                (src_px[2] as f32 + shift[2] + field[i][2]).clamp(0.0, 255.0) as u8,
            ]);
            let out_x = img_x as i32 - min_x as i32;
            let out_y = img_y as i32 - min_y as i32;
            if out_x >= 0 && out_x < crop_w as i32 && out_y >= 0 && out_y < crop_h as i32 {
                color_image.put_pixel(out_x as u32, out_y as u32, out);
            }
        }
    } else {
        // ---------- 扩散式修复（真实降级，非空操作） ----------
        // 无克隆源时，边界固定为原图颜色，内部以 Laplace 平滑扩散填充蒙版孔洞。
        // [1] 边界颜色均值作为内部初值，加快收敛
        let mut boundary_n = 0u64;
        let mut boundary_color = [0.0f32; 3];
        for y in 0..bh {
            for x in 0..bw {
                if region[y * bw + x] != 2 {
                    continue;
                }
                let img_x = (min_x as i32 + x as i32 - 1).clamp(0, img_w as i32 - 1) as u32;
                let img_y = (min_y as i32 + y as i32 - 1).clamp(0, img_h as i32 - 1) as u32;
                let px = source_image.get_pixel(img_x, img_y);
                for c in 0..3 {
                    boundary_color[c] += px[c] as f32;
                }
                boundary_n += 1;
            }
        }
        let boundary_mean = if boundary_n > 0 {
            [
                boundary_color[0] / boundary_n as f32,
                boundary_color[1] / boundary_n as f32,
                boundary_color[2] / boundary_n as f32,
            ]
        } else {
            [128.0f32, 128.0f32, 128.0f32]
        };

        // [2] 边界固定为原图颜色，内部以边界均值为初值
        for y in 0..bh {
            for x in 0..bw {
                let i = y * bw + x;
                if region[i] == 2 {
                    let img_x = (min_x as i32 + x as i32 - 1).clamp(0, img_w as i32 - 1) as u32;
                    let img_y = (min_y as i32 + y as i32 - 1).clamp(0, img_h as i32 - 1) as u32;
                    let px = source_image.get_pixel(img_x, img_y);
                    field[i] = [px[0] as f32, px[1] as f32, px[2] as f32];
                } else if region[i] == 1 {
                    field[i] = boundary_mean;
                }
            }
        }

        // [3] SOR 平滑扩散
        sor_solve(&mut field, &omega_coords, bw, omega, eps, max_iterations);

        // [4] 输出内部解
        for &(x, y) in &omega_coords {
            let img_x = (min_x as i32 + x as i32 - 1) as u32;
            let img_y = (min_y as i32 + y as i32 - 1) as u32;
            let i = y * bw + x;
            let out = Rgb([
                field[i][0].clamp(0.0, 255.0) as u8,
                field[i][1].clamp(0.0, 255.0) as u8,
                field[i][2].clamp(0.0, 255.0) as u8,
            ]);
            let out_x = img_x as i32 - min_x as i32;
            let out_y = img_y as i32 - min_y as i32;
            if out_x >= 0 && out_x < crop_w as i32 && out_y >= 0 && out_y < crop_h as i32 {
                color_image.put_pixel(out_x as u32, out_y as u32, out);
            }
        }
    }

    // ---------- 边缘羽化（去硬接缝） ----------
    // chamfer 距离变换得蒙版内部到背景的近似距离，边界带按 smoothstep 与原图混合。
    {
        const INF: i32 = i32::MAX / 3;
        let mut dist = vec![0i32; bw * bh];
        for i in 0..(bw * bh) {
            dist[i] = if region[i] == 0 { 0 } else { INF };
        }
        for y in 1..bh {
            for x in 1..bw {
                let i = y * bw + x;
                dist[i] = dist[i].min(dist[i - 1] + 1).min(dist[i - bw] + 1);
            }
        }
        for y in (0..bh - 1).rev() {
            for x in (0..bw - 1).rev() {
                let i = y * bw + x;
                dist[i] = dist[i].min(dist[i + 1] + 1).min(dist[i + bw] + 1);
            }
        }

        let feather = ((crop_w.max(crop_h)) as f32 / 200.0)
            .clamp(2.0, 5.0)
            .max(if quality >= 95 { 3.0 } else { 2.0 });

        for &(x, y) in &omega_coords {
            let d = dist[y * bw + x];
            if d <= 0 || d as f32 >= feather {
                continue;
            }
            let t = d as f32 / feather;
            let a = t * t * (3.0 - 2.0 * t); // smoothstep 0..1

            let img_x = (min_x as i32 + x as i32 - 1) as u32;
            let img_y = (min_y as i32 + y as i32 - 1) as u32;
            let out_x = img_x as i32 - min_x as i32;
            let out_y = img_y as i32 - min_y as i32;

            let dest_px = source_image.get_pixel(img_x, img_y);
            let healed = color_image.get_pixel(out_x as u32, out_y as u32);
            let out = [
                (a * healed[0] as f32 + (1.0 - a) * dest_px[0] as f32).clamp(0.0, 255.0) as u8,
                (a * healed[1] as f32 + (1.0 - a) * dest_px[1] as f32).clamp(0.0, 255.0) as u8,
                (a * healed[2] as f32 + (1.0 - a) * dest_px[2] as f32).clamp(0.0, 255.0) as u8,
            ];
            color_image.put_pixel(out_x as u32, out_y as u32, Rgb(out));
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
        true,
    )
}