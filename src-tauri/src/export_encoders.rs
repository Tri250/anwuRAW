//! W8-H1: 导出编码器注册表 —— 格式 × 色深 × ICC 能力单一数据源。
//!
//! 注册表是「哪些格式可编码、支持几 bit、能否嵌 ICC」的唯一权威：
//! - 校验前置（fail fast）：显式导出命令先过 `validate_encode_request`
//! - 编码函数按 spec 分发；管线兼容入口 `encode_image_to_bytes` 保持旧行为
//! - ICC/色彩空间变换自 export_processing 迁入，外部路径经 re-export 保持不变

use std::io::Cursor;

use image::codecs::jpeg::JpegEncoder;
use image::{DynamicImage, GenericImageView, ImageFormat};
use jxl_encoder::{
    LosslessConfig, LossyConfig, PixelLayout,
    api::{calibrated_jxl_quality, quality_to_distance},
};

use crate::export_processing::ExportColorSpace;

// ---------------------------------------------------------------------------
// 色彩空间变换（自 export_processing 迁入）
// ---------------------------------------------------------------------------

// sRGB → XYZ(D65) 变换矩阵（行主序）
const SRGB_TO_XYZ: [[f32; 3]; 3] = [
    [0.4124564, 0.3575761, 0.1804375],
    [0.2126729, 0.7151522, 0.0721750],
    [0.0193339, 0.119_192, 0.9503041],
];

// XYZ(D65) → Display P3 (Apple)
const XYZ_TO_DISPLAY_P3: [[f32; 3]; 3] = [
    [2.493_497, -0.9313836, -0.4027108],
    [-0.829_489, 1.7626641, 0.0236247],
    [0.0358458, -0.0761724, 0.9568845],
];

// XYZ(D65) → Adobe RGB (1998)
const XYZ_TO_ADOBE_RGB: [[f32; 3]; 3] = [
    [2.0415879, -0.565_007, -0.347_325],
    [-0.9692436, 1.8759675, 0.0415551],
    [0.0134443, -0.1183624, 1.0151749],
];

// XYZ(D65) → ProPhoto RGB (ROMM-RGB)
// primaries: R=(0.7347,0.2653), G=(0.1596,0.8404), B=(0.0366,0.0001), WP=D65
// 由 primaries + wp 精确推导：XYZ→primary 逆矩阵
const XYZ_TO_PRO_PHOTO: [[f32; 3]; 3] = [
    [1.3904536, -0.2640605, -0.0528020],
    [-0.5376556, 1.488_939, 0.0202733],
    [0.0000000, 0.0000000, 0.918_225],
];

fn mat_mul_3x3(a: [[f32; 3]; 3], b: [[f32; 3]; 3]) -> [[f32; 3]; 3] {
    let mut out = [[0.0f32; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            out[i][j] = a[i][0] * b[0][j] + a[i][1] * b[1][j] + a[i][2] * b[2][j];
        }
    }
    out
}

pub fn apply_color_space_transform(image: &DynamicImage, target: &ExportColorSpace) -> DynamicImage {
    if matches!(target, ExportColorSpace::Srgb) {
        return image.clone();
    }

    // sRGB → 目标空间 3x3 矩阵（先 sRGB→XYZ，再 XYZ→目标）
    let transform = match target {
        ExportColorSpace::DisplayP3 => mat_mul_3x3(XYZ_TO_DISPLAY_P3, SRGB_TO_XYZ),
        ExportColorSpace::AdobeRgb => mat_mul_3x3(XYZ_TO_ADOBE_RGB, SRGB_TO_XYZ),
        ExportColorSpace::ProPhoto => mat_mul_3x3(XYZ_TO_PRO_PHOTO, SRGB_TO_XYZ),
        ExportColorSpace::Srgb => return image.clone(),
    };

    // 使用 16-bit float buffer 做高精度变换，再降到目标位深
    let rgba16 = image.to_rgba16();
    let (w, h) = rgba16.dimensions();
    let mut out_buf = Vec::with_capacity((w * h * 4) as usize);

    for pixel in rgba16.pixels() {
        let r = pixel[0] as f32 / 65535.0;
        let g = pixel[1] as f32 / 65535.0;
        let b = pixel[2] as f32 / 65535.0;
        let a = pixel[3];

        let nr = (transform[0][0] * r + transform[0][1] * g + transform[0][2] * b).clamp(0.0, 1.0);
        let ng = (transform[1][0] * r + transform[1][1] * g + transform[1][2] * b).clamp(0.0, 1.0);
        let nb = (transform[2][0] * r + transform[2][1] * g + transform[2][2] * b).clamp(0.0, 1.0);

        out_buf.push((nr * 65535.0) as u16);
        out_buf.push((ng * 65535.0) as u16);
        out_buf.push((nb * 65535.0) as u16);
        out_buf.push(a);
    }

    let out: image::ImageBuffer<image::Rgba<u16>, Vec<u16>> =
        image::ImageBuffer::from_raw(w, h, out_buf).unwrap();
    DynamicImage::ImageRgba16(out)
}

// ---------------------------------------------------------------------------
// ICC Profile 嵌入（自 export_processing 迁入）
// ---------------------------------------------------------------------------

/// ICC profile 嵌入策略
#[derive(Clone, Copy, Debug, serde::Deserialize, serde::Serialize)]
pub enum IccProfileType {
    #[serde(rename = "srgb")]
    Srgb,
    #[serde(rename = "adobergb")]
    AdobeRgb,
    #[serde(rename = "displayp3")]
    DisplayP3,
    #[serde(rename = "keep")]
    KeepOriginal,
}

/// 根据请求的类型返回对应 ICC profile 字节。
/// - `KeepOriginal` 返回 `None`，表示不嵌入 ICC。
/// - 其他类型目前统一返回内置的 sRGB ICC v2 profile，后续可扩展为各色彩空间的真实 profile。
pub fn get_icc_profile_bytes(profile: IccProfileType) -> Option<Vec<u8>> {
    match profile {
        IccProfileType::KeepOriginal => None,
        _ => Some(build_minimal_srgb_icc()),
    }
}

/// 构建最小可用的 sRGB ICC v2 profile。
fn build_minimal_srgb_icc() -> Vec<u8> {
    static SRGB_ICC_V2: &[u8] = include_bytes!("icc/srgb-v2.icc");
    SRGB_ICC_V2.to_vec()
}

/// 给 JPEG 字节流嵌入 ICC_APP13 marker（FF ED）。
/// 保留原有所有 APP markers（已存在的 ICC_APP13 段会被替换）。
pub fn embed_icc_in_jpeg(jpeg_bytes: &[u8], icc_bytes: &[u8]) -> Result<Vec<u8>, String> {
    if jpeg_bytes.len() < 4 || jpeg_bytes[0] != 0xFF || jpeg_bytes[1] != 0xD8 {
        return Err("Not a valid JPEG".to_string());
    }

    let header = b"ICC_PROFILE\0";
    let mut seg_content = Vec::new();
    seg_content.extend_from_slice(header);
    seg_content.push(1); // chunk count
    seg_content.push(1); // chunk index (1-based)
    seg_content.extend_from_slice(icc_bytes);

    let content_len = seg_content.len() as u16;
    let seg_len_be: [u8; 2] = (content_len + 2).to_be_bytes(); // length 字段包含自身 2 字节

    let mut full_seg = Vec::new();
    full_seg.push(0xFF);
    full_seg.push(0xED);
    full_seg.extend_from_slice(&seg_len_be);
    full_seg.extend_from_slice(&seg_content);

    // 重建 JPEG：去掉旧的 ICC_APP13，在 SOI 之后、第一个其他 marker 之前插入新的
    let mut out = Vec::new();
    out.push(0xFF);
    out.push(0xD8); // SOI

    let mut pos: usize = 2;
    let mut inserted = false;

    while pos + 2 < jpeg_bytes.len() {
        // 跳过连续的 0xFF 填充
        while pos < jpeg_bytes.len() && jpeg_bytes[pos] == 0xFF {
            pos += 1;
        }
        if pos >= jpeg_bytes.len() {
            break;
        }
        let marker = jpeg_bytes[pos];
        pos += 1;

        // EOI / SOS：到达图像数据尾部，停止
        if marker == 0xD9 || marker == 0xDA {
            break;
        }

        if pos + 2 > jpeg_bytes.len() {
            break;
        }
        let length = (jpeg_bytes[pos] as usize) << 8 | jpeg_bytes[pos + 1] as usize;
        if length < 2 {
            break;
        }
        let seg_start = pos - 1;
        let seg_end = pos + length;
        if seg_end > jpeg_bytes.len() {
            break;
        }

        // 跳过旧的 ICC_APP13 段
        if marker == 0xED {
            pos = seg_end;
            continue;
        }

        // 在 SOI 之后的第一个 marker 之前插入新的 ICC_APP13
        if !inserted {
            out.extend_from_slice(&full_seg);
            inserted = true;
        }

        out.extend_from_slice(&jpeg_bytes[seg_start..seg_end]);
        pos = seg_end;
    }

    // 追加剩余的图像数据（从 marker 位置到末尾）
    if pos < jpeg_bytes.len() {
        out.extend_from_slice(&jpeg_bytes[pos..]);
    }

    // 确保 JPEG 以 EOI (FF D9) 结尾
    if out.len() < 2 || out[out.len() - 2] != 0xFF || out[out.len() - 1] != 0xD9 {
        out.push(0xFF);
        out.push(0xD9);
    }

    Ok(out)
}

// ---------------------------------------------------------------------------
// 编码器注册表（W8-H1 核心）
// ---------------------------------------------------------------------------

/// ICC 嵌入能力。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IccEmbedding {
    /// 不支持 ICC 嵌入。
    None,
    /// JPEG APP13（FF ED）marker 嵌入。
    JpegApp13,
}

/// 单个输出格式的编码能力规格。
#[derive(Debug, Clone, Copy)]
pub struct EncoderSpec {
    /// 规范扩展名（小写）。
    pub format: &'static str,
    /// 接受的别名（含规范名本身）。
    pub aliases: &'static [&'static str],
    /// MIME 类型（Android 图库写入路径使用独立映射，暂未消费）。
    #[allow(dead_code)]
    pub mime: &'static str,
    /// 支持的位深列表（8/16）。
    pub bit_depths: &'static [u8],
    /// ICC 嵌入能力。
    pub icc: IccEmbedding,
}

/// 全部可导出图像格式的编码器注册表。
/// cube（LUT）不是图像格式，不在此表；由导出管线单独分支处理。
pub const ENCODER_REGISTRY: &[EncoderSpec] = &[
    EncoderSpec {
        format: "jpg",
        aliases: &["jpg", "jpeg"],
        mime: "image/jpeg",
        bit_depths: &[8],
        icc: IccEmbedding::JpegApp13,
    },
    EncoderSpec {
        format: "png",
        aliases: &["png"],
        mime: "image/png",
        bit_depths: &[8, 16],
        icc: IccEmbedding::None,
    },
    EncoderSpec {
        format: "tiff",
        aliases: &["tiff", "tif"],
        mime: "image/tiff",
        bit_depths: &[8, 16],
        icc: IccEmbedding::None,
    },
    EncoderSpec {
        format: "webp",
        aliases: &["webp"],
        mime: "image/webp",
        bit_depths: &[8],
        icc: IccEmbedding::None,
    },
    EncoderSpec {
        format: "avif",
        aliases: &["avif"],
        mime: "image/avif",
        bit_depths: &[8],
        icc: IccEmbedding::None,
    },
    EncoderSpec {
        format: "jxl",
        aliases: &["jxl"],
        mime: "image/jxl",
        bit_depths: &[8],
        icc: IccEmbedding::None,
    },
];

/// 大小写不敏感的注册表查询（按规范名或别名）。
pub fn lookup_encoder(format: &str) -> Option<&'static EncoderSpec> {
    let needle = format.to_lowercase();
    ENCODER_REGISTRY
        .iter()
        .find(|s| s.format == needle || s.aliases.contains(&needle.as_str()))
}

/// 位深归一化：>=16 → 16，其余 → 8（与既有管线判定一致）。
pub fn normalize_bit_depth(bit_depth: u8) -> u8 {
    if bit_depth >= 16 {
        16
    } else {
        8
    }
}

/// 校验位深组合，返回归一化后的位深。
pub fn validate_bit_depth(spec: &EncoderSpec, bit_depth: u8) -> Result<u8, String> {
    let normalized = normalize_bit_depth(bit_depth);
    if spec.bit_depths.contains(&normalized) {
        Ok(normalized)
    } else {
        Err(format!(
            "{} does not support {}-bit output (supported: {:?})",
            spec.format, normalized, spec.bit_depths
        ))
    }
}

/// 校验 ICC 请求组合：仅在格式声明嵌入能力时接受真实嵌入请求。
/// `None`/`"keep"`/未知值不触发嵌入（未知值沿用既有语义 → KeepOriginal）。
pub fn validate_icc_request(spec: &EncoderSpec, icc_profile: Option<&str>) -> Result<(), String> {
    let wants_embed = matches!(icc_profile, Some(p) if !p.is_empty() && p != "keep");
    if wants_embed && spec.icc == IccEmbedding::None {
        return Err(format!(
            "ICC profile embedding is not supported for '{}' (supported: JPEG)",
            spec.format
        ));
    }
    Ok(())
}

/// 显式导出请求的组合校验入口（格式 × 色深 × ICC）。
pub fn validate_encode_request(
    format: &str,
    bit_depth: u8,
    icc_profile: Option<&str>,
) -> Result<&'static EncoderSpec, String> {
    let spec = lookup_encoder(format)
        .ok_or_else(|| format!("Unsupported file format: {}", format))?;
    validate_bit_depth(spec, bit_depth)?;
    validate_icc_request(spec, icc_profile)?;
    Ok(spec)
}

// ---------------------------------------------------------------------------
// 编码函数（自 export_processing 迁入，按 spec 分发）
// ---------------------------------------------------------------------------

fn encode_jxl(image: &DynamicImage, jpeg_quality: u8) -> Result<Vec<u8>, String> {
    let (width, height) = image.dimensions();
    let has_alpha = image.color().has_alpha();

    if jpeg_quality == 100 {
        if has_alpha {
            let rgba = image.to_rgba8();
            LosslessConfig::new()
                .encode(rgba.as_raw(), width, height, PixelLayout::Rgba8)
                .map_err(|e| format!("Failed to encode lossless JXL: {}", e))
        } else {
            let rgb = image.to_rgb8();
            LosslessConfig::new()
                .encode(rgb.as_raw(), width, height, PixelLayout::Rgb8)
                .map_err(|e| format!("Failed to encode lossless JXL: {}", e))
        }
    } else {
        let jxl_quality = calibrated_jxl_quality(jpeg_quality as f32);
        let distance = quality_to_distance(jxl_quality);

        if has_alpha {
            let rgba = image.to_rgba8();
            LossyConfig::new(distance)
                .encode(rgba.as_raw(), width, height, PixelLayout::Rgba8)
                .map_err(|e| format!("Failed to encode lossy JXL: {}", e))
        } else {
            let rgb = image.to_rgb8();
            LossyConfig::new(distance)
                .encode(rgb.as_raw(), width, height, PixelLayout::Rgb8)
                .map_err(|e| format!("Failed to encode lossy JXL: {}", e))
        }
    }
}

fn encode_webp(image: &DynamicImage, jpeg_quality: u8) -> Result<Vec<u8>, String> {
    let encoder =
        webp::Encoder::from_image(image).map_err(|_| "Failed to create WebP encoder".to_string())?;
    let webp_mem = encoder.encode(jpeg_quality as f32);
    Ok(webp_mem.to_vec())
}

fn encode_jpeg(image: &DynamicImage, jpeg_quality: u8) -> Result<Vec<u8>, String> {
    let rgb_image = image.to_rgb8();
    let mut buf = Vec::new();
    let mut cursor = Cursor::new(&mut buf);
    let encoder = JpegEncoder::new_with_quality(&mut cursor, jpeg_quality);
    rgb_image
        .write_with_encoder(encoder)
        .map_err(|e| e.to_string())?;
    Ok(buf)
}

fn encode_png(image: &DynamicImage, bit_depth: u8) -> Result<Vec<u8>, String> {
    // PNG 根据 bit_depth 选择 8/16-bit；带 alpha 的图像保留 alpha 通道
    let has_alpha = image.color().has_alpha();
    let image_to_encode = if bit_depth >= 16 {
        if has_alpha {
            DynamicImage::ImageRgba16(image.to_rgba16())
        } else {
            DynamicImage::ImageRgb16(image.to_rgb16())
        }
    } else if has_alpha {
        DynamicImage::ImageRgba8(image.to_rgba8())
    } else {
        image.to_rgb8().into()
    };
    let mut buf = Vec::new();
    let mut cursor = Cursor::new(&mut buf);
    image_to_encode
        .write_to(&mut cursor, ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    Ok(buf)
}

fn encode_tiff(image: &DynamicImage, bit_depth: u8) -> Result<Vec<u8>, String> {
    // TIFF 根据 bit_depth 选择 8/16-bit；带 alpha 的图像保留 alpha 通道
    let has_alpha = image.color().has_alpha();
    let image_to_encode = if bit_depth >= 16 {
        if has_alpha {
            DynamicImage::ImageRgba16(image.to_rgba16())
        } else {
            DynamicImage::ImageRgb16(image.to_rgb16())
        }
    } else if has_alpha {
        DynamicImage::ImageRgba8(image.to_rgba8())
    } else {
        image.to_rgb8().into()
    };
    let mut buf = Vec::new();
    let mut cursor = Cursor::new(&mut buf);
    image_to_encode
        .write_to(&mut cursor, ImageFormat::Tiff)
        .map_err(|e| e.to_string())?;
    Ok(buf)
}

fn encode_avif(image: &DynamicImage) -> Result<Vec<u8>, String> {
    let mut buf = Vec::new();
    let mut cursor = Cursor::new(&mut buf);
    image
        .write_to(&mut cursor, ImageFormat::Avif)
        .map_err(|e| e.to_string())?;
    Ok(buf)
}

/// 按注册表规格分发编码。
pub fn encode_with_spec(
    image: &DynamicImage,
    spec: &EncoderSpec,
    jpeg_quality: u8,
    bit_depth: u8,
) -> Result<Vec<u8>, String> {
    match spec.format {
        "jpg" => encode_jpeg(image, jpeg_quality),
        "png" => encode_png(image, normalize_bit_depth(bit_depth)),
        "tiff" => encode_tiff(image, normalize_bit_depth(bit_depth)),
        "webp" => encode_webp(image, jpeg_quality),
        "avif" => encode_avif(image),
        "jxl" => encode_jxl(image, jpeg_quality),
        other => Err(format!("Unsupported file format: {}", other)),
    }
}

/// 导出管线兼容入口（保持原签名与行为）。
/// 位深仅对 png/tiff 有意义；非注册表格式（如 cube）返回错误。
pub fn encode_image_to_bytes(
    image: &DynamicImage,
    output_format: &str,
    jpeg_quality: u8,
    _color_space: &ExportColorSpace,
    bit_depth: u8,
) -> Result<Vec<u8>, String> {
    let spec = lookup_encoder(output_format)
        .ok_or_else(|| format!("Unsupported file format: {}", output_format))?;
    encode_with_spec(image, spec, jpeg_quality, normalize_bit_depth(bit_depth))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgba};

    fn test_image() -> DynamicImage {
        DynamicImage::ImageRgba8(ImageBuffer::from_fn(32, 32, |x, y| {
            Rgba([(x * 8) as u8, (y * 8) as u8, 128, 255])
        }))
    }

    #[test]
    fn registry_consistency() {
        assert!(!ENCODER_REGISTRY.is_empty());
        let mut names = Vec::new();
        for spec in ENCODER_REGISTRY {
            assert!(!spec.format.is_empty());
            assert!(spec.format.chars().all(|c| c.is_ascii_lowercase()));
            assert!(spec.aliases.contains(&spec.format));
            assert!(spec.mime.starts_with("image/"));
            assert!(!spec.bit_depths.is_empty());
            let mut sorted = spec.bit_depths.to_vec();
            sorted.sort_unstable();
            assert_eq!(sorted, spec.bit_depths.to_vec());
            names.push(spec.format);
        }
        let unique: std::collections::HashSet<_> = names.clone();
        assert_eq!(unique.len(), names.len());
    }

    #[test]
    fn lookup_case_insensitive_with_aliases() {
        assert_eq!(lookup_encoder("JPG").unwrap().format, "jpg");
        assert_eq!(lookup_encoder("jpeg").unwrap().format, "jpg");
        assert_eq!(lookup_encoder("TIFF").unwrap().format, "tiff");
        assert_eq!(lookup_encoder("tif").unwrap().format, "tiff");
        assert!(lookup_encoder("cube").is_none());
        assert!(lookup_encoder("").is_none());
    }

    #[test]
    fn validate_bit_depth_combinations() {
        let jpg = lookup_encoder("jpg").unwrap();
        let png = lookup_encoder("png").unwrap();
        assert_eq!(validate_bit_depth(jpg, 8).unwrap(), 8);
        assert!(validate_bit_depth(jpg, 16).is_err());
        assert_eq!(validate_bit_depth(png, 8).unwrap(), 8);
        assert_eq!(validate_bit_depth(png, 16).unwrap(), 16);
        // 非法中间值归一化
        assert_eq!(validate_bit_depth(png, 10).unwrap(), 16);
        assert_eq!(validate_bit_depth(png, 4).unwrap(), 8);
    }

    #[test]
    fn validate_icc_combinations() {
        let jpg = lookup_encoder("jpg").unwrap();
        let png = lookup_encoder("png").unwrap();
        assert!(validate_icc_request(jpg, Some("srgb")).is_ok());
        assert!(validate_icc_request(jpg, Some("keep")).is_ok());
        assert!(validate_icc_request(jpg, None).is_ok());
        assert!(validate_icc_request(png, None).is_ok());
        assert!(validate_icc_request(png, Some("srgb")).is_err());
        assert!(validate_icc_request(png, Some("displayp3")).is_err());
    }

    #[test]
    fn validate_encode_request_rejects_unknown_format() {
        let err = validate_encode_request("cube", 8, None).unwrap_err();
        assert!(err.contains("Unsupported file format"));
    }

    #[test]
    fn encode_png_magic_and_depth() {
        let bytes = encode_png(&test_image(), 8).unwrap();
        assert_eq!(&bytes[..8], &[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]);
        // IHDR bit depth 字节位于 offset 24（带 alpha → RGBA8）
        assert_eq!(bytes[24], 8);

        let bytes16 = encode_png(&test_image(), 16).unwrap();
        assert_eq!(bytes16[24], 16);
    }

    #[test]
    fn encode_jpeg_and_tiff_magic() {
        let jpeg = encode_jpeg(&test_image(), 90).unwrap();
        assert_eq!(&jpeg[..3], &[0xFF, 0xD8, 0xFF]);

        let tiff8 = encode_tiff(&test_image(), 8).unwrap();
        assert!(tiff8.starts_with(b"II*\0") || tiff8.starts_with(b"MM\0*"));

        let tiff16 = encode_tiff(&test_image(), 16).unwrap();
        assert!(tiff16.len() > 100);
    }

    #[test]
    fn encode_webp_and_jxl_nonempty() {
        let webp = encode_webp(&test_image(), 90).unwrap();
        assert!(webp.starts_with(b"RIFF"));
        assert_eq!(&webp[8..12], b"WEBP");

        let jxl_lossy = encode_jxl(&test_image(), 85).unwrap();
        assert!(!jxl_lossy.is_empty());
        let jxl_lossless = encode_jxl(&test_image(), 100).unwrap();
        assert!(!jxl_lossless.is_empty());
    }

    #[test]
    fn encode_image_to_bytes_rejects_unknown() {
        let err = encode_image_to_bytes(&test_image(), "bmp", 90, &ExportColorSpace::Srgb, 8)
            .unwrap_err();
        assert!(err.contains("Unsupported file format"));
    }

    #[test]
    fn embed_icc_replaces_existing_app13() {
        let jpeg = encode_jpeg(&test_image(), 90).unwrap();
        assert_eq!(count_icc_app13(&jpeg), 0);

        let icc = get_icc_profile_bytes(IccProfileType::Srgb).unwrap();
        let once = embed_icc_in_jpeg(&jpeg, &icc).unwrap();
        assert_eq!(count_icc_app13(&once), 1);
        assert!(app13_payload_matches(&once, &icc));

        let twice = embed_icc_in_jpeg(&once, &icc).unwrap();
        assert_eq!(count_icc_app13(&twice), 1);
        assert!(app13_payload_matches(&twice, &icc));
        assert!(twice.ends_with(&[0xFF, 0xD9]));
    }

    #[test]
    fn embed_icc_rejects_non_jpeg() {
        assert!(embed_icc_in_jpeg(b"not a jpeg", b"x").is_err());
        assert!(embed_icc_in_jpeg(&[], b"x").is_err());
    }

    #[test]
    fn icc_profile_bytes_signature() {
        assert!(get_icc_profile_bytes(IccProfileType::KeepOriginal).is_none());
        let icc = get_icc_profile_bytes(IccProfileType::AdobeRgb).unwrap();
        assert!(icc.len() > 100);
        // ICC 头部：offset 36..40 为 'acsp' 签名
        assert_eq!(&icc[36..40], b"acsp");
    }

    #[test]
    fn color_space_transform_srgb_identity_and_determinism() {
        let img = test_image();
        let srgb = apply_color_space_transform(&img, &ExportColorSpace::Srgb);
        assert_eq!(srgb.dimensions(), img.dimensions());

        let p3_a = apply_color_space_transform(&img, &ExportColorSpace::DisplayP3);
        let p3_b = apply_color_space_transform(&img, &ExportColorSpace::DisplayP3);
        assert_eq!(p3_a.dimensions(), img.dimensions());
        assert_eq!(p3_a.to_rgba16().as_raw(), p3_b.to_rgba16().as_raw());

        let adobe = apply_color_space_transform(&img, &ExportColorSpace::AdobeRgb);
        assert_eq!(adobe.dimensions(), img.dimensions());
        let pro = apply_color_space_transform(&img, &ExportColorSpace::ProPhoto);
        assert_eq!(pro.dimensions(), img.dimensions());
    }

    // --- helpers ---

    fn count_icc_app13(jpeg: &[u8]) -> usize {
        let mut count = 0;
        let mut pos = 2usize; // SOI
        while pos + 4 <= jpeg.len() {
            if jpeg[pos] != 0xFF {
                break;
            }
            let marker = jpeg[pos + 1];
            if marker == 0xD9 || marker == 0xDA {
                break;
            }
            let length = ((jpeg[pos + 2] as usize) << 8) | jpeg[pos + 3] as usize;
            if marker == 0xED
                && jpeg[pos + 4..pos + 4 + 12].starts_with(b"ICC_PROFILE\0")
            {
                count += 1;
            }
            pos += 2 + length;
        }
        count
    }

    fn app13_payload_matches(jpeg: &[u8], icc: &[u8]) -> bool {
        let mut pos = 2usize;
        while pos + 4 <= jpeg.len() {
            if jpeg[pos] != 0xFF {
                break;
            }
            let marker = jpeg[pos + 1];
            if marker == 0xD9 || marker == 0xDA {
                break;
            }
            let length = ((jpeg[pos + 2] as usize) << 8) | jpeg[pos + 3] as usize;
            if marker == 0xED && jpeg[pos + 4..pos + 4 + 12].starts_with(b"ICC_PROFILE\0") {
                let payload = &jpeg[pos + 4 + 14..pos + 2 + length];
                return payload == icc;
            }
            pos += 2 + length;
        }
        false
    }
}
