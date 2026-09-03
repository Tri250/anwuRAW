//! 分离色调 (Split Toning) —— CPU 侧真实实现
//!
//! 将图像像素按亮度分成高光（Highlights）和阴影（Shadows）两个区域，
//! 分别叠加不同的色相 + 饱和度，平衡滑块控制分界点。
//!
//! 为避免在非线性空间直接叠加导致的色偏，着色在 OKLab 空间做：
//!   1. 计算像素的相对亮度 L（0..1）
//!   2. 由 balance 得到高光/阴影分配权重 w（w ∈ [0,1]，w=1 全高光，w=0 全阴影）
//!   3. 将高光色 / 阴影色分别转换为 OKLab 的 a/b 向量
//!   4. 按 w 线性混合 a/b 偏移量，累加到像素原有 a/b 上
//!   5. 截断饱和度过大的点，转回 sRGB
//!
//! 参数:
//!   shadows_hue/sat    阴影区域色轮值（色相度 0-360、饱和度 0-100）
//!   highlights_hue/sat  高光区域色轮值
//!   balance            滑块 -100..+100；正值偏向高光，负值偏向阴影
//!   enabled            开关

use image::{DynamicImage, Rgb, RgbImage};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
#[repr(C)]
pub struct SplitToningSettings {
    pub shadows_hue: f32,
    pub shadows_saturation: f32,
    pub highlights_hue: f32,
    pub highlights_saturation: f32,
    pub balance: f32,
    pub enabled: bool,
}

impl SplitToningSettings {
    pub fn disabled() -> Self {
        Self::default()
    }

    /// 根据 balance（-100..+100）把像素亮度 L（0..1）映射成高光/阴影权重。
    /// balance = 0 时，分界点在 0.5（对称）；
    /// balance 为正，分界点降低 → 更多像素分到高光；
    /// balance 为负，分界点升高 → 更多像素分到阴影。
    pub fn highlight_weight(&self, l: f32) -> f32 {
        // balance 映射到分界点： -100 → 0.75, 0 → 0.5, +100 → 0.25
        let threshold = 0.5 - self.balance * 0.0025;
        // Sigmoid-like 平滑过渡
        let diff = (l - threshold) * 8.0;
        let w = 1.0 / (1.0 + (-diff).exp());
        w.clamp(0.0, 1.0)
    }
}

/// OKLab 辅助常量 —— 转换矩阵（固定版本）
const SQRT3: f32 = 1.7320508075688772;

/// sRGB → OKLab
fn srgb_to_oklab(r: f32, g: f32, b: f32) -> (f32, f32, f32) {
    let l_ = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
    let m_ = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
    let s_ = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;

    let l = l_.cbrt();
    let m = m_.cbrt();
    let s = s_.cbrt();

    (
        0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
    )
}

/// OKLab → sRGB
fn oklab_to_srgb(l: f32, a: f32, b: f32) -> (f32, f32, f32) {
    let l_ = l + 0.3963377774 * a + 0.2158037573 * b;
    let m_ = l - 0.1055613458 * a - 0.0638541728 * b;
    let s_ = l - 0.0894841775 * a - 1.2914855480 * b;

    let l = l_ * l_ * l_;
    let m = m_ * m_ * m_;
    let s = s_ * s_ * s_;

    (
        4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
        -1.2681437731 * l + 2.6097524920 * m - 0.3416087183 * s,
        -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s,
    )
}

/// HSV(Hue 0..360, Saturation 0..1) → sRGB(0..1)
fn hsv_to_rgb(h: f32, s: f32, v: f32) -> (f32, f32, f32) {
    let s = s.clamp(0.0, 1.0);
    let v = v.clamp(0.0, 1.0);
    if s < 1e-6 {
        return (v, v, v);
    }
    let h = ((h % 360.0) + 360.0) % 360.0;
    let c = v * s;
    let x = c * (1.0 - ((h / 60.0) % 2.0 - 1.0).abs());
    let m = v - c;
    let (r1, g1, b1) = match h {
        0.0..=60.0 => (c, x, 0.0),
        60.0..=120.0 => (x, c, 0.0),
        120.0..=180.0 => (0.0, c, x),
        180.0..=240.0 => (0.0, x, c),
        240.0..=300.0 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    (r1 + m, g1 + m, b1 + m)
}

/// 将某个 hue/sat 色轮值转换成 OKLab 中的 a/b 偏移向量。
/// 偏移量大小由 saturation 控制，方向由 hue 控制。
fn hue_sat_to_oklab_ab(hue_deg: f32, sat_pct: f32) -> (f32, f32) {
    let sat = (sat_pct * 0.01).clamp(0.0, 1.0);
    if sat < 1e-4 {
        return (0.0, 0.0);
    }
    // 用一个中等明度的参考色（L=0.6）来得到色彩方向，之后取其 a/b
    let (r, g, b) = hsv_to_rgb(hue_deg, 1.0, 0.6);
    let (_l, a, oklab_b) = srgb_to_oklab(r, g, b);
    // 归一化后乘以 sat * strength
    let norm = (a * a + oklab_b * oklab_b).sqrt().max(1e-6);
    let strength = sat * 0.28; // 经验系数，使 100% sat 时偏移适度
    (a / norm * strength, oklab_b / norm * strength)
}

/// 对 u8 RGB sRGB 图像应用分离色调。
pub fn apply_split_toning_u8(img: &mut RgbImage, settings: &SplitToningSettings) {
    if !settings.enabled {
        return;
    }
    let (w, h) = img.dimensions();
    let w_usize = w as usize;

    let (sh_ab_a, sh_ab_b) = hue_sat_to_oklab_ab(settings.shadows_hue, settings.shadows_saturation);
    let (hi_ab_a, hi_ab_b) = hue_sat_to_oklab_ab(settings.highlights_hue, settings.highlights_saturation);

    let raw = img.as_mut();
    raw.par_chunks_mut(w_usize * 3)
        .enumerate()
        .for_each(|(_y, row)| {
            for x in 0..w_usize {
                let idx = x * 3;
                let r_in = row[idx] as f32 / 255.0;
                let g_in = row[idx + 1] as f32 / 255.0;
                let b_in = row[idx + 2] as f32 / 255.0;

                let (l, a, oklab_b) = srgb_to_oklab(r_in, g_in, b_in);

                // L ≈ 亮度 (OKLab 的 L 与感知亮度高度相关)
                let w_hi = settings.highlight_weight(l);
                let w_sh = 1.0 - w_hi;

                // 叠加色偏
                let a_out = a + sh_ab_a * w_sh + hi_ab_a * w_hi;
                let b_out = oklab_b + sh_ab_b * w_sh + hi_ab_b * w_hi;

                let (r_o, g_o, b_o) = oklab_to_srgb(l, a_out, b_out);
                row[idx] = (r_o.clamp(0.0, 1.0) * 255.0) as u8;
                row[idx + 1] = (g_o.clamp(0.0, 1.0) * 255.0) as u8;
                row[idx + 2] = (b_o.clamp(0.0, 1.0) * 255.0) as u8;
            }
        });
    let _ = h;
}

/// 对 DynamicImage 应用分离色调并返回新图像。
pub fn apply_to_dynamic(img: &DynamicImage, settings: &SplitToningSettings) -> DynamicImage {
    if !settings.enabled {
        return img.clone();
    }
    let mut rgb = img.to_rgb8();
    apply_split_toning_u8(&mut rgb, settings);
    DynamicImage::ImageRgb8(rgb)
}

/// 占位 Rgb 类型以抑制未使用 warning（后续可能扩展）。
#[allow(dead_code)]
fn _keep_rgb(_: Rgb<u8>) {}

#[tauri::command]
pub async fn apply_split_toning_command(
    input_path: String,
    output_path: String,
    settings: SplitToningSettings,
) -> Result<(), String> {
    use image::codecs::jpeg::JpegEncoder;
    let img = image::open(&input_path).map_err(|e| e.to_string())?;
    let processed = apply_to_dynamic(&img, &settings);
    let mut file = std::fs::File::create(&output_path).map_err(|e| e.to_string())?;
    let rgb = processed.to_rgb8();
    let mut encoder = JpegEncoder::new_with_quality(&mut file, 95);
    encoder.encode(
        rgb.as_raw(),
        rgb.width(),
        rgb.height(),
        image::ExtendedColorType::Rgb8,
    ).map_err(|e| e.to_string())?;
    Ok(())
}
