//! AI 自动拉直 —— 基于霍夫变换的水平线检测
//!
//! 流程：
//!   1. 下采样原图到长边 ≤ 800px（保证移动端毫秒级响应）
//!   2. 灰度转换
//!   3. Sobel 边缘检测（计算梯度 + 梯度方向）
//!   4. 概率霍夫变换（PPHT）检测线段
//!   5. 过滤水平线（角度范围 -30° ~ +30°）
//!   6. 按累计长度加权平均，输出主水平线角度（弧度）
//!
//! 返回角度 = 建议旋转的角（负号表示顺时针，正号表示逆时针），
//! 前端直接填入 adjustments.rotation 字段即可。

#![allow(
    dead_code,
    clippy::needless_range_loop,
    clippy::vec_init_then_push,
    clippy::manual_range_contains,
    clippy::collapsible_if,
    clippy::excessive_precision
)]
use image::{DynamicImage, GenericImageView, GrayImage};
use std::collections::HashMap;

/// 把角度（弧度）归一化到 (-π/2, π/2] 区间
fn normalize_angle(a: f32) -> f32 {
    let half = std::f32::consts::FRAC_PI_2;

    ((a + half) % std::f32::consts::PI + std::f32::consts::PI) % std::f32::consts::PI - half
}

/// 计算 Sobel 梯度 + 方向（单通道 f32 buffer）
/// 返回 (grad_x, grad_y) 两个同尺寸的 f32 buffer
fn sobel_gradient(gray: &[f32], w: usize, h: usize) -> (Vec<f32>, Vec<f32>) {
    let mut gx = vec![0.0f32; w * h];
    let mut gy = vec![0.0f32; w * h];

    for y in 1..(h - 1) {
        for x in 1..(w - 1) {
            let idx = y * w + x;
            let tl = gray[idx - w - 1];
            let tc = gray[idx - w];
            let tr = gray[idx - w + 1];
            let ml = gray[idx - 1];
            let mr = gray[idx + 1];
            let bl = gray[idx + w - 1];
            let bc = gray[idx + w];
            let br = gray[idx + w + 1];

            let sx = -tl + tr - 2.0 * ml + 2.0 * mr - bl + br;
            let sy = -tl - 2.0 * tc - tr + bl + 2.0 * bc + br;

            gx[idx] = sx;
            gy[idx] = sy;
        }
    }
    (gx, gy)
}

/// 概率霍夫变换检测线段（简化版）。
/// 只输出极坐标 (rho, theta) 及对应累计值的 top-N。
/// - theta_bins: 角度分桶数（精度 π/theta_bins 弧度）
/// - threshold: 累加器阈值（超过此值的桶才输出）
fn probabilistic_hough(
    gx: &[f32],
    gy: &[f32],
    w: usize,
    h: usize,
    theta_bins: usize,
    threshold: i32,
    min_grad: f32,
) -> Vec<(i32, usize, i32)> {
    let diag: usize = (((w * w + h * h) as f32).sqrt() as usize) + 1;
    let half_diag = diag as i32;
    let rho_bins = diag * 2 + 1; // 让 rho ∈ [-half_diag, +half_diag]
    let n_theta = theta_bins;
    let d_theta = std::f32::consts::PI / n_theta as f32;

    let mut accumulator = vec![0i32; rho_bins * n_theta];

    // 收集边缘点（高梯度点）
    let mut edge_points = Vec::new();
    for y in 0..h {
        for x in 0..w {
            let idx = y * w + x;
            let gx_v = gx[idx];
            let gy_v = gy[idx];
            let mag = (gx_v * gx_v + gy_v * gy_v).sqrt();
            if mag > min_grad {
                edge_points.push((x as f32, y as f32, mag, gx_v, gy_v));
            }
        }
    }

    if edge_points.is_empty() {
        return Vec::new();
    }

    // 随机采样点来加速（PPHT 核心思想）
    let sample_count = (edge_points.len() / 4).clamp(5_000, 200_000);

    let mut rng_state: u64 = 42;
    let mut pick = || {
        rng_state = rng_state.wrapping_mul(6364136223846793005).wrapping_add(1);
        (rng_state >> 33) as usize
    };
    for _ in 0..sample_count {
        let ei = pick() % edge_points.len();
        let (x, y, _mag, _gx, _gy) = edge_points[ei];

        // 只扫描一个角度范围（水平线：θ ∈ [π/3, 2π/3]，即接近 90°）
        let theta_start = (n_theta as f32 * 0.33) as usize;
        let theta_end = (n_theta as f32 * 0.67) as usize;
        for ti in theta_start..=theta_end.min(n_theta - 1) {
            let theta = ti as f32 * d_theta;
            let rho = x * theta.cos() + y * theta.sin();
            let rho_bin_idx = (rho + half_diag as f32) as usize;
            if rho_bin_idx < rho_bins {
                accumulator[rho_bin_idx * n_theta + ti] += 1;
            }
        }
    }

    // 找峰值
    let mut peaks = Vec::new();
    for rho_bin in 0..rho_bins {
        for ti in 0..n_theta {
            let v = accumulator[rho_bin * n_theta + ti];
            if v >= threshold {
                peaks.push((rho_bin as i32 - half_diag, ti, v));
            }
        }
    }
    peaks.sort_by_key(|a| std::cmp::Reverse(a.2));
    peaks.truncate(50);
    peaks
}

/// 主入口：对输入图像做水平直线检测，返回主水平线的角度（弧度）。
/// 返回 0.0 表示无法可靠检测。
pub fn detect_horizon_angle(img: &DynamicImage) -> f32 {
    let (w_orig, h_orig) = img.dimensions();

    // 下采样
    let max_side = 800u32;
    let scale = if w_orig.max(h_orig) > max_side {
        max_side as f32 / w_orig.max(h_orig) as f32
    } else {
        1.0
    };
    let w = (w_orig as f32 * scale) as u32;
    let h = (h_orig as f32 * scale) as u32;
    let resized = img.resize(w.max(1), h.max(1), image::imageops::FilterType::Triangle);

    // 灰度
    let gray_img = resized.to_luma8();
    let (gw, gh) = gray_img.dimensions();
    let gray_f32: Vec<f32> = gray_img
        .as_raw()
        .iter()
        .map(|&v| v as f32 / 255.0)
        .collect();

    // 高斯模糊轻量（3×3 简单核）
    let gw_usize = gw as usize;
    let gh_usize = gh as usize;
    let mut blurred = vec![0.0f32; gw_usize * gh_usize];
    for y in 1..(gh_usize - 1) {
        for x in 1..(gw_usize - 1) {
            let idx = y * gw_usize + x;
            blurred[idx] = (gray_f32[idx - gw_usize - 1]
                + 2.0 * gray_f32[idx - gw_usize]
                + gray_f32[idx - gw_usize + 1]
                + 2.0 * gray_f32[idx - 1]
                + 4.0 * gray_f32[idx]
                + 2.0 * gray_f32[idx + 1]
                + gray_f32[idx + gw_usize - 1]
                + 2.0 * gray_f32[idx + gw_usize]
                + gray_f32[idx + gw_usize + 1])
                / 16.0;
        }
    }

    let (gx, gy) = sobel_gradient(&blurred, gw_usize, gh_usize);

    // 边缘最小强度：约灰度范围的 10%
    let edges = probabilistic_hough(&gx, &gy, gw_usize, gh_usize, 180, 35, 0.10);

    // 按角度聚类，找到最密集的水平线
    let mut angle_buckets: HashMap<i32, (f32, i32)> = HashMap::new();
    let bin_size = 2; // 2° 一个桶
    let _d_theta_deg = 1.0; // 霍夫中 theta 以度表示时的分辨率

    for (_rho, ti, count) in &edges {
        let theta_rad = (*ti as f32) * (std::f32::consts::PI / 180.0);
        // 计算线的角度（斜率角度）：theta = π/2 是水平线, θ=0 是垂直线
        // 我们想要的是直线的方向角
        let line_angle_rad = theta_rad - std::f32::consts::FRAC_PI_2;
        let line_angle_deg = line_angle_rad.to_degrees();
        let line_angle_deg = ((line_angle_deg + 180.0) % 180.0 + 180.0) % 180.0 - 90.0;

        // 只保留接近水平的线（±30°）
        if line_angle_deg.abs() > 30.0 {
            continue;
        }

        let bucket = (line_angle_deg / bin_size as f32).round() as i32;
        let entry = angle_buckets.entry(bucket).or_insert((0.0, 0));
        entry.0 += line_angle_deg * (*count as f32);
        entry.1 += count;
    }

    if angle_buckets.is_empty() {
        return 0.0;
    }

    // 找到 count 最大的桶
    let best_bucket = angle_buckets
        .iter()
        .max_by_key(|(_, (_, c))| *c)
        .map(|(k, v)| (*k, *v));

    match best_bucket {
        Some((_, (sum_deg, count))) if count > 0 => {
            let avg_deg = sum_deg / count as f32;
            let avg_rad = avg_deg.to_radians();
            // 归一化到 (-π/2, π/2]
            normalize_angle(avg_rad)
        }
        _ => 0.0,
    }
}

#[allow(dead_code)]
fn _keep_gray(_: GrayImage) {}

#[tauri::command]
pub fn detect_straighten_angle(path: String) -> Result<f32, String> {
    let img = image::open(&path).map_err(|e| e.to_string())?;
    Ok(detect_horizon_angle(&img))
}
