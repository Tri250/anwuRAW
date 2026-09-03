//! 颜色范围蒙版 (Color Range Mask) —— CPU 侧真实实现
//!
//! 在 HSV 颜色空间中根据色相范围 + 饱和度范围选择像素，
//! 并支持高斯模糊羽化 + 反选 + 混合模式。

#![allow(
    dead_code,
    clippy::needless_range_loop,
    clippy::vec_init_then_push,
    clippy::manual_range_contains,
    clippy::collapsible_if,
    clippy::excessive_precision
)]
use image::{DynamicImage, GenericImageView, GrayImage, RgbImage};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
pub struct ColorRangeSettings {
    /// 选中的主色相（度 0-360）
    pub hue_center: f32,
    /// 色相容差（度）
    pub hue_tolerance: f32,
    /// 饱和度下限（0-1）
    pub min_saturation: f32,
    /// 饱和度上限（0-1）
    pub max_saturation: f32,
    /// 亮度下限（0-1）
    pub min_value: f32,
    /// 亮度上限（0-1）
    pub max_value: f32,
    /// 羽化强度（像素半径，最终会被 clamp 到 min(w,h)/4）
    pub feather: f32,
    /// 是否反选
    pub invert: bool,
}

impl ColorRangeSettings {
    pub fn default_select_red() -> Self {
        Self {
            hue_center: 0.0,
            hue_tolerance: 15.0,
            min_saturation: 0.3,
            max_saturation: 1.0,
            min_value: 0.15,
            max_value: 1.0,
            feather: 10.0,
            invert: false,
        }
    }
}

fn rgb_to_hsv(r: f32, g: f32, b: f32) -> (f32, f32, f32) {
    let r = r.clamp(0.0, 1.0);
    let g = g.clamp(0.0, 1.0);
    let b = b.clamp(0.0, 1.0);
    let max = r.max(g.max(b));
    let min = r.min(g.min(b));
    let d = max - min;
    let h = if d < 1e-6 {
        0.0
    } else if max == r {
        60.0 * (((g - b) / d) % 6.0)
    } else if max == g {
        60.0 * ((b - r) / d + 2.0)
    } else {
        60.0 * ((r - g) / d + 4.0)
    };
    let h = ((h % 360.0) + 360.0) % 360.0;
    let s = if max < 1e-6 { 0.0 } else { d / max };
    (h, s, max)
}

/// 角度距离（处理环绕：359° 和 1° 的距离是 2°）
fn hue_distance(h1: f32, h2: f32) -> f32 {
    let d = (h1 - h2).abs() % 360.0;
    d.min(360.0 - d)
}

/// 生成原始（未羽化）蒙版。每个像素根据是否在颜色范围内输出 0 或 255。
fn generate_raw_mask(img: &RgbImage, settings: &ColorRangeSettings) -> GrayImage {
    let (w, h) = img.dimensions();
    let mut mask = GrayImage::new(w, h);
    let raw = mask.as_mut();
    let pixels = img.as_raw();
    let w_usize = w as usize;

    raw.par_chunks_mut(w_usize)
        .enumerate()
        .for_each(|(y, row)| {
            for x in 0..w_usize {
                let pi = (y * w_usize + x) * 3;
                let r = pixels[pi] as f32 / 255.0;
                let g = pixels[pi + 1] as f32 / 255.0;
                let b = pixels[pi + 2] as f32 / 255.0;
                let (hue, sat, val) = rgb_to_hsv(r, g, b);

                let hue_ok = hue_distance(hue, settings.hue_center) <= settings.hue_tolerance;
                let sat_ok = sat >= settings.min_saturation && sat <= settings.max_saturation;
                let val_ok = val >= settings.min_value && val <= settings.max_value;

                let inside = hue_ok && sat_ok && val_ok;
                let v = if settings.invert { !inside } else { inside };
                row[x] = if v { 255u8 } else { 0u8 };
            }
        });
    mask
}

/// 二维高斯模糊（分离式），应用到 GrayImage。
/// sigma 将自动转换为核大小（odd, radius ≈ 3*sigma）。
pub fn gaussian_blur_gray(mask: &GrayImage, sigma: f32) -> GrayImage {
    if sigma < 0.5 {
        return mask.clone();
    }
    let (w, h) = mask.dimensions();
    let w_usize = w as usize;
    let h_usize = h as usize;

    let radius = (sigma * 3.0).ceil() as usize;
    let kernel_size = 2 * radius + 1;
    let mut kernel = vec![0.0f32; kernel_size];
    let mut sum = 0.0f32;
    for i in 0..kernel_size {
        let x = (i as i32 - radius as i32) as f32;
        let v = (-x * x / (2.0 * sigma * sigma)).exp();
        kernel[i] = v;
        sum += v;
    }
    for k in &mut kernel {
        *k /= sum;
    }

    let input: Vec<f32> = mask.as_raw().iter().map(|&v| v as f32).collect();
    let mut intermediate = vec![0.0f32; w_usize * h_usize];
    let mut output = vec![0.0f32; w_usize * h_usize];

    // X 方向
    intermediate
        .par_chunks_mut(w_usize)
        .enumerate()
        .for_each(|(y, row)| {
            for x in 0..w_usize {
                let mut v = 0.0f32;
                for k in 0..kernel_size {
                    let xi =
                        (x as i32 + k as i32 - radius as i32).clamp(0, w_usize as i32 - 1) as usize;
                    v += input[y * w_usize + xi] * kernel[k];
                }
                row[x] = v;
            }
        });
    // Y 方向
    output
        .par_chunks_mut(w_usize)
        .enumerate()
        .for_each(|(y, row)| {
            for x in 0..w_usize {
                let mut v = 0.0f32;
                for k in 0..kernel_size {
                    let yi =
                        (y as i32 + k as i32 - radius as i32).clamp(0, h_usize as i32 - 1) as usize;
                    v += intermediate[yi * w_usize + x] * kernel[k];
                }
                row[x] = v;
            }
        });

    let bytes: Vec<u8> = output.iter().map(|&v| v.clamp(0.0, 255.0) as u8).collect();
    GrayImage::from_raw(w, h, bytes).expect("valid mask")
}

/// 主入口：从 DynamicImage 生成 8bit 灰度蒙版。
pub fn generate_mask(img: &DynamicImage, settings: &ColorRangeSettings) -> GrayImage {
    let rgb = img.to_rgb8();
    let mut mask = generate_raw_mask(&rgb, settings);

    if settings.feather > 0.0 {
        let (w, h) = img.dimensions();
        let max_sigma = (w.min(h) as f32 / 4.0).max(1.0);
        let sigma = settings.feather.min(max_sigma);
        mask = gaussian_blur_gray(&mask, sigma);
    }
    mask
}

#[tauri::command]
pub fn generate_color_range_mask_command(
    image_path: String,
    output_path: String,
    settings: ColorRangeSettings,
) -> Result<(), String> {
    let img = image::open(&image_path).map_err(|e| e.to_string())?;
    let mask = generate_mask(&img, &settings);
    mask.save(&output_path).map_err(|e| e.to_string())?;
    Ok(())
}
