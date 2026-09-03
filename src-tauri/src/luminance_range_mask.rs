//! 亮度范围蒙版 (Luminance Range Mask) —— CPU 侧真实实现
//!
//! 计算每个像素的感知亮度（OKLab L 通道近似），根据
//! [min_luminance, max_luminance] 阈值区间 + 羽化强度生成 8bit 灰度蒙版。

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
pub struct LuminanceRangeSettings {
    /// 亮度下限（0-1）
    pub min_luminance: f32,
    /// 亮度上限（0-1）
    pub max_luminance: f32,
    /// 过渡区宽度（软过渡：实际阈值会扩展到 min-bandwidth ~ max+bandwidth，
    /// 在过渡区内做 smoothstep）
    pub bandwidth: f32,
    /// 羽化（高斯模糊半径，像素）
    pub feather: f32,
    /// 反选
    pub invert: bool,
}

impl LuminanceRangeSettings {
    pub fn select_shadows() -> Self {
        Self {
            min_luminance: 0.0,
            max_luminance: 0.35,
            bandwidth: 0.05,
            feather: 12.0,
            invert: false,
        }
    }
    pub fn select_highlights() -> Self {
        Self {
            min_luminance: 0.65,
            max_luminance: 1.0,
            bandwidth: 0.05,
            feather: 12.0,
            invert: false,
        }
    }
    pub fn select_midtones() -> Self {
        Self {
            min_luminance: 0.3,
            max_luminance: 0.7,
            bandwidth: 0.05,
            feather: 8.0,
            invert: false,
        }
    }
}

/// 感知亮度（sRGB → OKLab 的 L 通道近似）
fn compute_luminance(r: f32, g: f32, b: f32) -> f32 {
    let l_ = 0.412_221_46 * r + 0.536_332_55 * g + 0.051_445_995 * b;
    let m_ = 0.211_903_5 * r + 0.680_699_5 * g + 0.107_396_96 * b;
    let s_ = 0.088_302_46 * r + 0.281_718_85 * g + 0.629_978_7 * b;
    let l = l_.cbrt();
    let m = m_.cbrt();
    let s = s_.cbrt();
    0.210_454_26 * l + 0.793_617_8 * m - 0.004_072_047 * s
}

/// smoothstep 过渡函数
fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
    let t = ((x - e0) / (e1 - e0.max(e0))).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// 生成原始蒙版（带带宽软过渡）
fn generate_raw_mask(img: &RgbImage, s: &LuminanceRangeSettings) -> GrayImage {
    let (w, h) = img.dimensions();
    let mut mask = GrayImage::new(w, h);
    let raw = mask.as_mut();
    let pixels = img.as_raw();
    let w_usize = w as usize;

    let lo = s.min_luminance - s.bandwidth;
    let hi_lo = s.min_luminance;
    let lo_hi = s.max_luminance;
    let hi = s.max_luminance + s.bandwidth;

    raw.par_chunks_mut(w_usize)
        .enumerate()
        .for_each(|(y, row)| {
            for x in 0..w_usize {
                let pi = (y * w_usize + x) * 3;
                let r = pixels[pi] as f32 / 255.0;
                let g = pixels[pi + 1] as f32 / 255.0;
                let b = pixels[pi + 2] as f32 / 255.0;
                let lum = compute_luminance(r, g, b);

                let val = if lum < hi_lo {
                    if lum < lo {
                        0.0
                    } else {
                        smoothstep(lo, hi_lo, lum)
                    }
                } else if lum > lo_hi {
                    if lum > hi {
                        0.0
                    } else {
                        // lum ∈ [lo_hi, hi]：从 1 → 0
                        1.0 - smoothstep(lo_hi, hi, lum)
                    }
                } else {
                    1.0
                };

                let v = if s.invert { 1.0 - val } else { val };
                row[x] = (v.clamp(0.0, 1.0) * 255.0) as u8;
            }
        });
    mask
}

/// 复用 color_range_mask 里的高斯模糊
fn gaussian_blur_gray(mask: &GrayImage, sigma: f32) -> GrayImage {
    crate::color_range_mask::gaussian_blur_gray(mask, sigma)
}

/// 主入口
pub fn generate_mask(img: &DynamicImage, settings: &LuminanceRangeSettings) -> GrayImage {
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
pub fn generate_luminance_range_mask_command(
    image_path: String,
    output_path: String,
    settings: LuminanceRangeSettings,
) -> Result<(), String> {
    let img = image::open(&image_path).map_err(|e| e.to_string())?;
    let mask = generate_mask(&img, &settings);
    mask.save(&output_path).map_err(|e| e.to_string())?;
    Ok(())
}
