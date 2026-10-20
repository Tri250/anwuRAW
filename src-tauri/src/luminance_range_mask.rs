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

// =============================================================================
// 单元测试 — 仅在 `cargo test --lib` 时编译
// 覆盖 TC-LUM-01 ~ TC-LUM-14
// =============================================================================
#[cfg(test)]
mod tests {
    use super::*;

    /// 取像素值
    fn px(img: &image::GrayImage, x: u32, y: u32) -> u8 {
        img.get_pixel(x, y)[0]
    }

    /// 全单色 DynamicImage
    fn solid_rgb(w: u32, h: u32, r: u8, g: u8, b: u8) -> image::DynamicImage {
        let mut img = image::RgbImage::new(w, h);
        for x in 0..w {
            for y in 0..h {
                img.put_pixel(x, y, image::Rgb([r, g, b]));
            }
        }
        image::DynamicImage::ImageRgb8(img)
    }

    #[test]
    fn tc_lum_01_select_shadows_values() {
        let s = LuminanceRangeSettings::select_shadows();
        assert_eq!(s.min_luminance, 0.0);
        assert_eq!(s.max_luminance, 0.35);
        assert_eq!(s.bandwidth, 0.05);
        assert_eq!(s.feather, 12.0);
        assert!(!s.invert);
    }

    #[test]
    fn tc_lum_02_select_highlights_values() {
        let s = LuminanceRangeSettings::select_highlights();
        assert_eq!(s.min_luminance, 0.65);
        assert_eq!(s.max_luminance, 1.0);
    }

    #[test]
    fn tc_lum_03_select_midtones_values() {
        let s = LuminanceRangeSettings::select_midtones();
        assert_eq!(s.min_luminance, 0.3);
        assert_eq!(s.max_luminance, 0.7);
    }

    #[test]
    fn tc_lum_04_compute_luminance_white() {
        let l = compute_luminance(1.0, 1.0, 1.0);
        assert!(l > 0.95 && l <= 1.0, "白色亮度应≈1.0,实际 {}", l);
    }

    #[test]
    fn tc_lum_05_compute_luminance_black() {
        let l = compute_luminance(0.0, 0.0, 0.0);
        assert!(l.abs() < 0.05, "黑色亮度应≈0,实际 {}", l);
    }

    #[test]
    fn tc_lum_06_compute_luminance_midgray_monotonic() {
        let l_black = compute_luminance(0.0, 0.0, 0.0);
        let l_gray = compute_luminance(0.5, 0.5, 0.5);
        let l_white = compute_luminance(1.0, 1.0, 1.0);
        assert!(l_black < l_gray, "黑 < 灰,实际 {} vs {}", l_black, l_gray);
        assert!(l_gray < l_white, "灰 < 白,实际 {} vs {}", l_gray, l_white);
    }

    #[test]
    fn tc_lum_07_smoothstep_midpoint() {
        let v = smoothstep(0.0, 1.0, 0.5);
        // smoothstep(0,1,0.5) = 0.5
        assert!((v - 0.5).abs() < 0.01, "smoothstep 中点应为 0.5,实际 {}", v);
    }

    #[test]
    fn tc_lum_08_smoothstep_below_edge_zero() {
        let v = smoothstep(0.0, 1.0, -1.0);
        assert!(v.abs() < 0.01, "越界下沿应为 0,实际 {}", v);
    }

    #[test]
    fn tc_lum_09_generate_raw_mask_black_image_select_shadows_all_255() {
        let img = solid_rgb(5, 5, 0, 0, 0);
        let rgb = img.to_rgb8();
        let s = LuminanceRangeSettings::select_shadows();
        let mask = generate_raw_mask(&rgb, &s);
        for x in 0..5 {
            for y in 0..5 {
                assert_eq!(px(&mask, x, y), 255, "黑色应命中阴影");
            }
        }
    }

    #[test]
    fn tc_lum_10_generate_raw_mask_black_image_select_highlights_all_zero() {
        let img = solid_rgb(5, 5, 0, 0, 0);
        let rgb = img.to_rgb8();
        let s = LuminanceRangeSettings::select_highlights();
        let mask = generate_raw_mask(&rgb, &s);
        for x in 0..5 {
            for y in 0..5 {
                assert_eq!(px(&mask, x, y), 0, "黑色不在高光范围");
            }
        }
    }

    #[test]
    fn tc_lum_11_generate_raw_mask_bandwidth_produces_smooth_transition() {
        // 构造落入 select_shadows 上过渡区 [lo_hi, hi]=[0.35, 0.40] 的灰像素,
        // OKLab L ≈ (k/255).cbrt();k=13 → v=0.051 → L≈0.37 落入过渡区,
        // smoothstep 应产出 0<v<1 的中间值,证明带宽软过渡生效。
        let mut img = image::RgbImage::new(2, 1);
        img.put_pixel(0, 0, image::Rgb([0, 0, 0])); // 黑:lum≈0 ≥ hi_lo → 全选 255
        img.put_pixel(1, 0, image::Rgb([13, 13, 13])); // 灰:lum≈0.37 ∈ [0.35, 0.40] → 中间值
        let s = LuminanceRangeSettings::select_shadows();
        let mask = generate_raw_mask(&img, &s);
        // 至少存在一个中间值(0<v<255),证明带宽软过渡生效
        let has_intermediate = mask.iter().any(|&v| v > 0 && v < 255);
        assert!(has_intermediate, "带宽过渡应产生中间值");
    }

    #[test]
    fn tc_lum_12_generate_raw_mask_invert_flips() {
        let img = solid_rgb(5, 5, 0, 0, 0); // 黑色,本命中阴影
        let rgb = img.to_rgb8();
        let mut s = LuminanceRangeSettings::select_shadows();
        s.invert = true;
        let mask = generate_raw_mask(&rgb, &s);
        for x in 0..5 {
            for y in 0..5 {
                assert_eq!(px(&mask, x, y), 0, "反选后黑色应不命中");
            }
        }
    }

    #[test]
    fn tc_lum_13_generate_mask_with_feather_does_not_panic() {
        let img = solid_rgb(5, 5, 128, 128, 128);
        let mut s = LuminanceRangeSettings::select_midtones();
        s.feather = 5.0;
        let _mask = generate_mask(&img, &s);
    }

    #[test]
    fn tc_lum_14_generate_luminance_range_mask_command_writes_to_disk() {
        use std::env;
        use std::fs;
        let img = solid_rgb(5, 5, 0, 0, 0);
        let input_path = env::temp_dir().join("rr_test_lum_input.png");
        let output_path = env::temp_dir().join("rr_test_lum_output.png");
        img.save(&input_path).expect("保存输入图像");
        let settings = LuminanceRangeSettings::select_shadows();
        let result = generate_luminance_range_mask_command(
            input_path.to_string_lossy().to_string(),
            output_path.to_string_lossy().to_string(),
            settings,
        );
        assert!(result.is_ok(), "命令应成功,实际 {:?}", result.err());
        assert!(output_path.exists(), "输出文件应存在");
        let _ = fs::remove_file(&input_path);
        let _ = fs::remove_file(&output_path);
    }
}
