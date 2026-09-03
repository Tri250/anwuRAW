//! 通道混合器 (Channel Mixer) —— CPU 侧真实实现
//!
//! 将 RGB 通道按照可编辑的 3×3 权重矩阵重新混合。
//! 每个输出通道（Red / Green / Blue）由三个输入通道按权重加权求和得到。
//!
//! 矩阵约定：
//!   out_red   = in_r * R_R + in_g * R_G + in_b * R_B
//!   out_green = in_r * G_R + in_g * G_G + in_b * G_B
//!   out_blue  = in_r * B_R + in_g * B_G + in_b * B_B
//!
//! 默认恒等矩阵：
//!   [100%,   0,   0]        即 R_R=1.0, R_G=0.0, R_B=0.0
//!   [  0, 100%,   0]            G_R=0.0, G_G=1.0, G_B=0.0
//!   [  0,   0, 100%]            B_R=0.0, B_G=0.0, B_B=1.0
//!
//! 后端走 CPU 管线（参考 dehaze/glow 的做法），不改 GPU shader。

use image::{DynamicImage, RgbImage};
use rayon::prelude::*;
use serde::{Deserialize, Serialize};

/// 9 个权重百分比（-200 ~ +200 表示 -2.0 ~ +2.0）。
#[derive(Clone, Copy, Debug, Default, Serialize, Deserialize)]
#[repr(C)]
pub struct ChannelMixerSettings {
    pub red_from_red: f32,
    pub red_from_green: f32,
    pub red_from_blue: f32,
    pub green_from_red: f32,
    pub green_from_green: f32,
    pub green_from_blue: f32,
    pub blue_from_red: f32,
    pub blue_from_green: f32,
    pub blue_from_blue: f32,
}

impl ChannelMixerSettings {
    pub fn identity() -> Self {
        Self {
            red_from_red: 100.0,
            red_from_green: 0.0,
            red_from_blue: 0.0,
            green_from_red: 0.0,
            green_from_green: 100.0,
            green_from_blue: 0.0,
            blue_from_red: 0.0,
            blue_from_green: 0.0,
            blue_from_blue: 100.0,
        }
    }

    /// 是否为恒等矩阵（所有非对角元素为 0，对角元素为 100%），
    /// 此时可以跳过整个处理来获得零开销。
    pub fn is_identity(&self) -> bool {
        self.red_from_red == 100.0
            && self.red_from_green == 0.0
            && self.red_from_blue == 0.0
            && self.green_from_red == 0.0
            && self.green_from_green == 100.0
            && self.green_from_blue == 0.0
            && self.blue_from_red == 0.0
            && self.blue_from_green == 0.0
            && self.blue_from_blue == 100.0
    }

    /// 把百分比（-200~+200）转换成 0~1+ 的系数（除以 100）。
    pub fn as_coefficients(&self) -> [f32; 9] {
        [
            self.red_from_red * 0.01,
            self.red_from_green * 0.01,
            self.red_from_blue * 0.01,
            self.green_from_red * 0.01,
            self.green_from_green * 0.01,
            self.green_from_blue * 0.01,
            self.blue_from_red * 0.01,
            self.blue_from_green * 0.01,
            self.blue_from_blue * 0.01,
        ]
    }
}

/// 对 f32 RGB buffer（线性空间或 sRGB 皆可）应用通道混合器。
/// 输入输出在同一个 buffer 上操作（原地），按行并行处理。
pub fn apply_channel_mixer_f32(buffer: &mut [f32], w: usize, h: usize, settings: &ChannelMixerSettings) {
    if settings.is_identity() {
        return;
    }
    let coeffs = settings.as_coefficients();
    // coeffs: [R_R, R_G, R_B, G_R, G_G, G_B, B_R, B_G, B_B]
    let r_r = coeffs[0];
    let r_g = coeffs[1];
    let r_b = coeffs[2];
    let g_r = coeffs[3];
    let g_g = coeffs[4];
    let g_b = coeffs[5];
    let b_r = coeffs[6];
    let b_g = coeffs[7];
    let b_b = coeffs[8];

    buffer
        .par_chunks_mut(w * 3)
        .enumerate()
        .for_each(|(_y, row)| {
            for x in 0..w {
                let idx = x * 3;
                let r_in = row[idx];
                let g_in = row[idx + 1];
                let b_in = row[idx + 2];

                let r_out = r_in * r_r + g_in * r_g + b_in * r_b;
                let g_out = r_in * g_r + g_in * g_g + b_in * g_b;
                let b_out = r_in * b_r + g_in * b_g + b_in * b_b;

                row[idx] = r_out;
                row[idx + 1] = g_out;
                row[idx + 2] = b_out;
            }
        });
    let _ = h; // 用到了
}

/// 对 u8 RGB 图像直接应用通道混合器（用于 sRGB 8bit 非 RAW 快速通道）。
pub fn apply_channel_mixer_u8(img: &mut RgbImage, settings: &ChannelMixerSettings) {
    if settings.is_identity() {
        return;
    }
    let coeffs = settings.as_coefficients();
    let r_r = coeffs[0];
    let r_g = coeffs[1];
    let r_b = coeffs[2];
    let g_r = coeffs[3];
    let g_g = coeffs[4];
    let g_b = coeffs[5];
    let b_r = coeffs[6];
    let b_g = coeffs[7];
    let b_b = coeffs[8];

    let (w, h) = img.dimensions();
    let raw = img.as_mut();
    raw.par_chunks_mut((w as usize) * 3)
        .for_each(|row| {
            for x in 0..(w as usize) {
                let idx = x * 3;
                let r_in = row[idx] as f32;
                let g_in = row[idx + 1] as f32;
                let b_in = row[idx + 2] as f32;

                let r_out = (r_in * r_r + g_in * r_g + b_in * r_b).clamp(0.0, 255.0) as u8;
                let g_out = (r_in * g_r + g_in * g_g + b_in * g_b).clamp(0.0, 255.0) as u8;
                let b_out = (r_in * b_r + g_in * b_g + b_in * b_b).clamp(0.0, 255.0) as u8;

                row[idx] = r_out;
                row[idx + 1] = g_out;
                row[idx + 2] = b_out;
            }
        });
    let _ = h;
}

/// 对 DynamicImage 应用通道混合器并返回新图像（sRGB 空间，用于最终输出前的 CPU 管线）。
pub fn apply_to_dynamic(img: &DynamicImage, settings: &ChannelMixerSettings) -> DynamicImage {
    if settings.is_identity() {
        return img.clone();
    }
    let mut rgb = img.to_rgb8();
    apply_channel_mixer_u8(&mut rgb, settings);
    DynamicImage::ImageRgb8(rgb)
}

#[tauri::command]
pub async fn apply_channel_mixer_command(
    input_path: String,
    output_path: String,
    settings: ChannelMixerSettings,
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
