//! HDR gain map support (ISO 21496-1 / "Ultra HDR" style) — P0-4.
//!
//! A gain map image pairs an SDR JPEG with a small grayscale map that records
//! the log2 ratio between the HDR and SDR renditions, allowing compliant
//! readers to reconstruct a wider-dynamic-range result. This module provides:
//!
//! - HDR→SDR tone mapping with chroma compression for highlights (DNG 1.7
//!   anchors: reference white `0.25·2^(2+BaselineExposure)`, middle grey
//!   `0.1845` linear = 118/255 sRGB-encoded).
//! - Gain map generation (`gain = log2((hdr + o) / (sdr + o))`, max over
//!   channels) with linear+gamma value normalization (see quantization note).
//! - A JPEG container writer/reader: base SDR JPEG + XMP APP1 (Adobe `gm:`
//!   gain map metadata) + MPF APP2 with the grayscale map as the secondary
//!   image (the layout used by Android Ultra HDR files).
//! - Gain map application (SDR + map + headroom → linear HDR).
//!
//! Deliberately additive: nothing here touches the preview pipeline or
//! `PROCESSING_VERSION`.

use std::path::Path;

use base64::Engine as _;
use image::codecs::jpeg::JpegEncoder;
use image::{DynamicImage, ExtendedColorType, GenericImageView, GrayImage, ImageBuffer, ImageEncoder, Luma, Rgb, RgbImage};

/// DNG 1.7 middle grey in scene-linear terms; tone-mapped output anchors this
/// value at sRGB 118/255 (the SDR middle grey, asserted in tests).
pub const MID_GRAY_LINEAR: f32 = 0.1845;
#[cfg(test)]
pub const SDR_MID_GRAY: f32 = 118.0 / 255.0;
/// Shared numerator offset from the ISO 21496-1 examples.
pub const GAIN_OFFSET: f32 = 1.0 / 64.0;
/// Reference white (log2 stops) above SDR white for full reconstruction.
pub const DEFAULT_HDR_CAPACITY: f32 = 4.0;

const XMP_MIME: &[u8] = b"http://ns.adobe.com/xap/1.0/\0";
const MPF_SIG: &[u8] = b"MPF\0";
/// JPEG APP1/APP2 marker length: length word (2 bytes) is included in it.
const SEG_LEN_SKIP: usize = 2;

// ---------------------------------------------------------------------------
// Metadata
// ---------------------------------------------------------------------------

/// Gain map metadata (Adobe `gm:` XMP schema / ISO 21496-1 subset).
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GainMapMetadata {
    pub gain_map_min: f32,
    pub gain_map_max: f32,
    pub gamma: f32,
    pub offset_sdr: f32,
    pub offset_hdr: f32,
    pub hdr_capacity_min: f32,
    pub hdr_capacity_max: f32,
    pub base_rendition_is_hdr: bool,
}

impl Default for GainMapMetadata {
    fn default() -> Self {
        Self {
            gain_map_min: 0.0,
            gain_map_max: 0.0,
            gamma: 1.0,
            offset_sdr: GAIN_OFFSET,
            offset_hdr: GAIN_OFFSET,
            hdr_capacity_min: 0.0,
            hdr_capacity_max: DEFAULT_HDR_CAPACITY,
            base_rendition_is_hdr: false,
        }
    }
}

impl GainMapMetadata {
    fn fmt(v: f32) -> String {
        // 4 significant decimals are plenty for 8-bit-quantized maps.
        format!("{v:.4}")
    }

    pub fn to_xmp(&self) -> String {
        let base = if self.base_rendition_is_hdr { "True" } else { "False" };
        format!(
            "<x:xmpmeta xmlns:x=\"adobe:ns:meta/\">\
<rdf:RDF xmlns:rdf=\"http://www.w3.org/1999/02/22-rdf-syntax-ns#\">\
<rdf:Description rdf:about=\"\" xmlns:gm=\"http://ns.adobe.com/gainmap/1.0/\" \
gm:GainMapMin=\"{}\" gm:GainMapMax=\"{}\" gm:Gamma=\"{}\" \
gm:OffsetSDR=\"{}\" gm:OffsetHDR=\"{}\" gm:HDRCapacityMin=\"{}\" \
gm:HDRCapacityMax=\"{}\" gm:BaseRenditionIsHDR=\"{}\"/>\
</rdf:RDF></x:xmpmeta>",
            Self::fmt(self.gain_map_min),
            Self::fmt(self.gain_map_max),
            Self::fmt(self.gamma),
            Self::fmt(self.offset_sdr),
            Self::fmt(self.offset_hdr),
            Self::fmt(self.hdr_capacity_min),
            Self::fmt(self.hdr_capacity_max),
            base,
        )
    }

    /// Tolerant reader: accepts decimal floats and `n/d` rationals.
    fn parse_val(xmp: &str, key: &str) -> Option<f32> {
        let needle = format!("gm:{key}=\"");
        let start = xmp.find(&needle)? + needle.len();
        let rest = &xmp[start..];
        let end = rest.find('"')?;
        let raw = &rest[..end];
        if let Some((n, d)) = raw.split_once('/') {
            let num: f32 = n.trim().parse().ok()?;
            let den: f32 = d.trim().parse().ok()?;
            if den == 0.0 {
                return None;
            }
            return Some(num / den);
        }
        raw.trim().parse().ok()
    }

    pub fn from_xmp(xmp: &str) -> Option<Self> {
        // Only treat packets that actually carry the gain map schema.
        if !xmp.contains("xmlns:gm=") {
            return None;
        }
        let mut meta = GainMapMetadata::default();
        meta.gain_map_min = Self::parse_val(xmp, "GainMapMin")?;
        meta.gain_map_max = Self::parse_val(xmp, "GainMapMax")?;
        meta.gamma = Self::parse_val(xmp, "Gamma").unwrap_or(1.0);
        meta.offset_sdr = Self::parse_val(xmp, "OffsetSDR").unwrap_or(GAIN_OFFSET);
        meta.offset_hdr = Self::parse_val(xmp, "OffsetHDR").unwrap_or(GAIN_OFFSET);
        meta.hdr_capacity_min = Self::parse_val(xmp, "HDRCapacityMin").unwrap_or(0.0);
        meta.hdr_capacity_max = Self::parse_val(xmp, "HDRCapacityMax").unwrap_or(DEFAULT_HDR_CAPACITY);
        meta.base_rendition_is_hdr = xmp.contains("gm:BaseRenditionIsHDR=\"True\"");
        if meta.gamma <= 0.0 {
            meta.gamma = 1.0;
        }
        Some(meta)
    }
}

// ---------------------------------------------------------------------------
// Transfer helpers + tone mapping
// ---------------------------------------------------------------------------

/// DNG 1.7 reference white: `0.25 · 2^(2 + BaselineExposure)`.
pub fn reference_white(baseline_exposure: f32) -> f32 {
    0.25f32 * (2.0f32).powf(2.0 + baseline_exposure)
}

pub fn srgb_to_linear(c: f32) -> f32 {
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

pub fn linear_to_srgb(c: f32) -> f32 {
    if c <= 0.003_130_8 {
        c * 12.92
    } else {
        1.055 * c.powf(1.0 / 2.4) - 0.055
    }
}

// Gain map value quantization note: normalized linearly between GainMapMin/Max
// with the metadata gamma curve (identity at γ=1). A sigmoid compression was
// evaluated and rejected: the 8-bit endpoints decode to unbounded gains once
// JPEG noise pushes a sample to 0/255, so ISO-style linear+gamma is used.
// Tone curve: anchored power curve (monotonic, mid grey → SDR middle grey,
// reference white → 1.0) with Rec709 luma chroma compression above the knee.

fn rec709_luma(lin: [f32; 3]) -> f32 {
    0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
}

/// Tone-maps an sRGB-encoded HDR f32 image into an SDR 8-bit rendition.
///
/// Pipeline per pixel: decode to scene-linear → compress chroma above the
/// middle-grey knee (highlight desaturation) → anchored power curve
/// (`mid grey → SDR mid grey`, `reference white → 1.0`) → sRGB encode.
pub fn tone_map_hdr_to_sdr(hdr: &ImageBuffer<Rgb<f32>, Vec<f32>>, baseline_exposure: f32) -> RgbImage {
    let ref_white = reference_white(baseline_exposure);
    // Exponent anchoring mid grey and reference white exactly.
    let (mid_n, ref_n) = (MID_GRAY_LINEAR.max(1e-6), ref_white.max(MID_GRAY_LINEAR + 1e-6));
    let exponent = MID_GRAY_LINEAR.ln() / (mid_n / ref_n).ln();

    let (w, h) = hdr.dimensions();
    let mut out = RgbImage::new(w, h);
    for (x, y, pixel) in hdr.enumerate_pixels() {
        let lin = [
            srgb_to_linear(pixel[0].max(0.0)),
            srgb_to_linear(pixel[1].max(0.0)),
            srgb_to_linear(pixel[2].max(0.0)),
        ];
        let luma = rec709_luma(lin);
        // Chroma compression: progressively pull channels toward luma above
        // the knee so saturated highlights don't clip into color casts.
        let over = (luma / MID_GRAY_LINEAR - 1.0).max(0.0);
        let chroma_scale = 1.0 / (1.0 + over);
        let mut sdr = [0u8; 3];
        for c in 0..3 {
            let compressed = luma + (lin[c] - luma) * chroma_scale;
            let normalized = (compressed / ref_white).max(0.0).min(1.0);
            let mapped = normalized.powf(exponent);
            let encoded = linear_to_srgb(mapped).clamp(0.0, 1.0);
            sdr[c] = (encoded * 255.0 + 0.5) as u8;
        }
        out.put_pixel(x, y, Rgb(sdr));
    }
    out
}

/// Result of [`generate_gain_map`].
pub struct GeneratedGainMap {
    pub metadata: GainMapMetadata,
    pub map: GrayImage,
}

/// Computes the grayscale gain map between the HDR source and the SDR
/// rendition: `gain = log2((hdr_lin + o_hdr) / (sdr_lin + o_sdr))`, taking the
/// maximum across channels (ISO 21496-1 single-channel recommendation).
pub fn generate_gain_map(
    hdr: &ImageBuffer<Rgb<f32>, Vec<f32>>,
    sdr: &RgbImage,
) -> GeneratedGainMap {
    // The SDR rendition was tone mapped against this reference white.
    let (w, h) = hdr.dimensions();
    let mut min_gain = f32::MAX;
    let mut max_gain = f32::MIN;
    // First pass: gain range.
    let mut gains: Vec<u8> = Vec::with_capacity((w * h) as usize);
    let mut raw: Vec<f32> = Vec::with_capacity((w * h) as usize);
    for (x, y, pixel) in hdr.enumerate_pixels() {
        let sdr_px = sdr.get_pixel(x, y);
        let mut g = f32::MIN;
        for c in 0..3 {
            let hdr_lin = srgb_to_linear(pixel[c].max(0.0));
            let sdr_lin = srgb_to_linear(sdr_px[c] as f32 / 255.0);
            let ratio = (hdr_lin + GAIN_OFFSET) / (sdr_lin + GAIN_OFFSET);
            g = g.max(ratio.log2());
        }
        min_gain = min_gain.min(g);
        max_gain = max_gain.max(g);
        raw.push(g);
    }
    if max_gain < min_gain {
        max_gain = min_gain;
    }
    let span = (max_gain - min_gain).max(1e-6);
    for g in &raw {
        let norm = ((g - min_gain) / span).clamp(0.0, 1.0);
        gains.push((norm * 255.0 + 0.5) as u8);
    }
    let mut map = GrayImage::new(w, h);
    for (i, v) in gains.into_iter().enumerate() {
        let x = (i as u32) % w;
        let y = (i as u32) / w;
        map.put_pixel(x, y, Luma([v]));
    }
    GeneratedGainMap {
        metadata: GainMapMetadata {
            gain_map_min: min_gain,
            gain_map_max: max_gain,
            gamma: 1.0,
            offset_sdr: GAIN_OFFSET,
            offset_hdr: GAIN_OFFSET,
            hdr_capacity_min: 0.0,
            hdr_capacity_max: max_gain.max(0.0),
            base_rendition_is_hdr: false,
        },
        map,
    }
}

/// Reconstructs linear HDR from the SDR base + gain map at `headroom` stops.
/// `headroom = 0` yields the SDR rendition itself.
pub fn apply_gain_map(
    sdr: &RgbImage,
    map: &GrayImage,
    metadata: &GainMapMetadata,
    headroom: f32,
) -> ImageBuffer<Rgb<f32>, Vec<f32>> {
    let (w, h) = sdr.dimensions();
    let mut out = ImageBuffer::new(w, h);
    // Display headroom → weight within the stored capacity range.
    let capacity = (metadata.hdr_capacity_max - metadata.hdr_capacity_min).max(1e-6);
    let weight = ((headroom - metadata.hdr_capacity_min) / capacity).clamp(0.0, 1.0);
    let span = (metadata.gain_map_max - metadata.gain_map_min).max(1e-6);
    for (x, y, sdr_px) in sdr.enumerate_pixels() {
        let map_px = if map.width() == w && map.height() == h {
            map.get_pixel(x, y)[0]
        } else {
            // Downsampled maps are sampled nearest at half resolution.
            map.get_pixel((x / 2).min(map.width() - 1), (y / 2).min(map.height() - 1))[0]
        };
        let norm = (map_px as f32 / 255.0).powf(metadata.gamma);
        let gain = metadata.gain_map_min + norm * span;
        let gain_eff = gain * weight;
        let mut lin = [0f32; 3];
        for c in 0..3 {
            let sdr_lin = srgb_to_linear(sdr_px[c] as f32 / 255.0);
            lin[c] = ((sdr_lin + metadata.offset_sdr) * 2f32.powf(gain_eff)) - metadata.offset_hdr;
        }
        out.put_pixel(x, y, Rgb(lin));
    }
    out
}

// ---------------------------------------------------------------------------
// JPEG container (XMP APP1 + MPF APP2 + appended secondary image)
// ---------------------------------------------------------------------------

fn encode_gray_jpeg(map: &GrayImage, quality: u8) -> Result<Vec<u8>, String> {
    let mut buf = std::io::Cursor::new(Vec::new());
    let enc = JpegEncoder::new_with_quality(&mut buf, quality.clamp(30, 100));
    enc.write_image(map.as_raw(), map.width(), map.height(), ExtendedColorType::L8)
        .map_err(|e| format!("Failed to encode gain map JPEG: {e}"))?;
    Ok(buf.into_inner())
}

fn encode_sdr_jpeg(sdr: &RgbImage, quality: u8) -> Result<Vec<u8>, String> {
    let mut buf = std::io::Cursor::new(Vec::new());
    let enc = JpegEncoder::new_with_quality(&mut buf, quality.clamp(30, 100));
    enc.write_image(sdr.as_raw(), sdr.width(), sdr.height(), ExtendedColorType::Rgb8)
        .map_err(|e| format!("Failed to encode SDR base JPEG: {e}"))?;
    Ok(buf.into_inner())
}

fn app1_xmp_segment(xmp: &str) -> Vec<u8> {
    let mut seg = Vec::with_capacity(XMP_MIME.len() + xmp.len() + 4);
    seg.push(0xFF);
    seg.push(0xE1);
    let len = XMP_MIME.len() + xmp.len() + SEG_LEN_SKIP;
    seg.extend_from_slice(&(len as u16).to_be_bytes());
    seg.extend_from_slice(XMP_MIME);
    seg.extend_from_slice(xmp.as_bytes());
    seg
}

/// Minimal MPF APP2 (big-endian TIFF) with two entries: the primary (this
/// file) and the secondary gain-map image. Data offsets are relative to the
/// MPF TIFF header start (CIPA DC-007 style, as Android Ultra HDR readers
/// expect). Returns the segment bytes plus the within-segment position of the
/// secondary-offset field so the caller can patch it once the final layout is
/// known.
fn build_mpf_segment(secondary_size: u32) -> (Vec<u8>, usize) {
    // tiff layout: "MM" 002A ifd_offset=8 | IFD(3 entries) next=0 | entries
    let ifd_pos: usize = 8;
    let mp_entries_pos = ifd_pos + 2 + 3 * 12 + 4;
    let tiff_len = mp_entries_pos + 32;

    let mut seg = Vec::with_capacity(tiff_len + 8);
    seg.push(0xFF);
    seg.push(0xE2);
    let payload_len = 4 + tiff_len; // "MPF\0" + tiff
    seg.extend_from_slice(&((payload_len + SEG_LEN_SKIP) as u16).to_be_bytes());
    seg.extend_from_slice(MPF_SIG);
    // TIFF header
    seg.extend_from_slice(b"MM");
    seg.extend_from_slice(&0x002Au16.to_be_bytes());
    seg.extend_from_slice(&(ifd_pos as u32).to_be_bytes());
    // MP Index IFD
    seg.extend_from_slice(&3u16.to_be_bytes());
    // 0xB000 MPFVersion LONG 1 = 0x00000100
    seg.extend_from_slice(&0xB000u16.to_be_bytes());
    seg.extend_from_slice(&4u16.to_be_bytes()); // LONG
    seg.extend_from_slice(&1u32.to_be_bytes()); // count
    seg.extend_from_slice(&0x0000_0100u32.to_be_bytes());
    // 0xB001 NumberOfImages LONG 1 = 2
    seg.extend_from_slice(&0xB001u16.to_be_bytes());
    seg.extend_from_slice(&4u16.to_be_bytes());
    seg.extend_from_slice(&1u32.to_be_bytes());
    seg.extend_from_slice(&2u32.to_be_bytes());
    // 0xB002 MPEntry LONG n → offset to entries
    seg.extend_from_slice(&0xB002u16.to_be_bytes());
    seg.extend_from_slice(&4u16.to_be_bytes());
    seg.extend_from_slice(&2u32.to_be_bytes()); // two images
    seg.extend_from_slice(&(mp_entries_pos as u32).to_be_bytes());
    seg.extend_from_slice(&0u32.to_be_bytes()); // next IFD = none
    // MP entries
    // Primary: attributes 0, size 0 (unknown until MPF inserted), offset 0.
    seg.extend_from_slice(&0u32.to_be_bytes());
    seg.extend_from_slice(&0u32.to_be_bytes());
    seg.extend_from_slice(&0u32.to_be_bytes());
    seg.extend_from_slice(&0u32.to_be_bytes());
    // Secondary: type 3 ("large thumbnail"), size, offset patched by the
    // caller once the final layout is known.
    let attr: u32 = 0x0003_0000;
    seg.extend_from_slice(&attr.to_be_bytes());
    seg.extend_from_slice(&secondary_size.to_be_bytes());
    let offset_field_pos = seg.len();
    seg.extend_from_slice(&0u32.to_be_bytes());
    seg.extend_from_slice(&0u32.to_be_bytes()); // dependent image 1 entry
    (seg, offset_field_pos)
}

/// Encodes an "Ultra HDR"-style JPEG: SDR base + XMP APP1 metadata + MPF APP2
/// pointing at the appended gain-map JPEG.
pub fn encode_ultra_hdr_jpeg(
    hdr: &ImageBuffer<Rgb<f32>, Vec<f32>>,
    baseline_exposure: f32,
    quality: u8,
) -> Result<Vec<u8>, String> {
    let sdr = tone_map_hdr_to_sdr(hdr, baseline_exposure);
    let generated = generate_gain_map(hdr, &sdr);
    encode_ultra_hdr_from_parts(&sdr, &generated.map, &generated.metadata, quality)
}

/// Assembles the container from already-computed parts (shared by the encoder
/// and tests that supply synthetic maps).
pub fn encode_ultra_hdr_from_parts(
    sdr: &RgbImage,
    map: &GrayImage,
    metadata: &GainMapMetadata,
    quality: u8,
) -> Result<Vec<u8>, String> {
    let primary = encode_sdr_jpeg(sdr, quality)?;
    let secondary = encode_gray_jpeg(map, quality)?;

    // Layout: SOI + APP1(XMP) + APP2(MPF) + primary rest + secondary JPEG.
    let xmp_seg = app1_xmp_segment(&metadata.to_xmp());
    let (mpf_seg, offset_field_pos) = build_mpf_segment(secondary.len() as u32);

    let mut out = Vec::with_capacity(primary.len() + secondary.len() + xmp_seg.len() + mpf_seg.len());
    out.extend_from_slice(&primary[0..2]); // SOI
    out.extend_from_slice(&xmp_seg);
    out.extend_from_slice(&mpf_seg);
    out.extend_from_slice(&primary[2..]);
    let secondary_pos = out.len();
    out.extend_from_slice(&secondary);

    // Patch the secondary data offset. Segment layout inside `out`:
    //   FF E2 | len(2) | "MPF\0"(4) | TIFF...  → TIFF header starts 8 bytes
    //   after the segment start; `offset_field_pos` already counts the
    //   FF/len prefix, so the absolute field position is seg_start + pos.
    let mpf_seg_start = 2 + xmp_seg.len();
    let tiff_start = mpf_seg_start + 8;
    let rel = (secondary_pos - tiff_start) as u32;
    let field_pos = mpf_seg_start + offset_field_pos;
    out[field_pos..field_pos + 4].copy_from_slice(&rel.to_be_bytes());
    Ok(out)
}

/// Recovered gain map payload.
pub struct DecodedGainMap {
    pub metadata: GainMapMetadata,
    pub map: GrayImage,
}

/// Extracts (metadata, gain map image) from an Ultra HDR-style JPEG.
pub fn decode_gain_map_jpeg(bytes: &[u8]) -> Result<DecodedGainMap, String> {
    let mut xmp: Option<String> = None;
    let mut mpf: Option<(usize, Vec<u8>)> = None; // (payload file offset, payload)
    let mut i = 2usize;
    if bytes.len() < 4 || bytes[0] != 0xFF || bytes[1] != 0xD8 {
        return Err("Not a JPEG file.".to_string());
    }
    while i + 4 <= bytes.len() {
        if bytes[i] != 0xFF {
            return Err("Corrupt JPEG segment stream.".to_string());
        }
        let marker = bytes[i + 1];
        if marker == 0xD9 || marker == 0xDA {
            break; // EOI or start of scan — segments end here
        }
        if marker == 0x01 || (0xD0..=0xD7).contains(&marker) {
            i += 2; // standalone markers
            continue;
        }
        let len = u16::from_be_bytes([bytes[i + 2], bytes[i + 3]]) as usize;
        if len < 2 || i + 2 + len > bytes.len() {
            return Err("Corrupt JPEG segment length.".to_string());
        }
        let payload_start = i + 4;
        let payload = &bytes[payload_start..i + 2 + len];
        match marker {
            0xE1 if payload.starts_with(XMP_MIME) => {
                xmp = Some(String::from_utf8_lossy(&payload[XMP_MIME.len()..]).to_string());
            }
            0xE2 if payload.starts_with(MPF_SIG) => {
                mpf = Some((payload_start, payload.to_vec()));
            }
            _ => {}
        }
        i = i + 2 + len;
    }
    let xmp = xmp.ok_or("No XMP gain map metadata found.")?;
    let metadata = GainMapMetadata::from_xmp(&xmp).ok_or("XMP does not carry gain map metadata.")?;
    let (mpf_offset, mpf) = mpf.ok_or("No MPF segment found.")?;

    // Parse MPF TIFF (big endian) to find the secondary image entry.
    let tiff = &mpf[4..];
    if tiff.len() < 8 || &tiff[0..2] != b"MM" {
        return Err("Unsupported MPF endianness.".to_string());
    }
    let ifd_pos = u32::from_be_bytes([tiff[4], tiff[5], tiff[6], tiff[7]]) as usize;
    if ifd_pos + 2 > tiff.len() {
        return Err("Corrupt MPF IFD.".to_string());
    }
    let entries = u16::from_be_bytes([tiff[ifd_pos], tiff[ifd_pos + 1]]) as usize;
    let mut secondary: Option<(u32, u32)> = None;
    for e in 0..entries {
        let base = ifd_pos + 2 + e * 12;
        if base + 12 > tiff.len() {
            break;
        }
        let tag = u16::from_be_bytes([tiff[base], tiff[base + 1]]);
        if tag == 0xB002 {
            let table = u32::from_be_bytes([
                tiff[base + 8],
                tiff[base + 9],
                tiff[base + 10],
                tiff[base + 11],
            ]) as usize;
            // Entry 1 (= secondary image) sits 16 bytes into the MP entries
            // array: attributes @0, size @4, data offset @8.
            let entry1 = table + 16;
            if entry1 + 12 <= tiff.len() {
                let size = u32::from_be_bytes([
                    tiff[entry1 + 4],
                    tiff[entry1 + 5],
                    tiff[entry1 + 6],
                    tiff[entry1 + 7],
                ]);
                let off = u32::from_be_bytes([
                    tiff[entry1 + 8],
                    tiff[entry1 + 9],
                    tiff[entry1 + 10],
                    tiff[entry1 + 11],
                ]);
                secondary = Some((size, off));
            }
        }
    }
    let (size, off) = secondary.ok_or("MPF has no secondary image entry.")?;
    // Entries array: entry 0 = primary (this file), entry 1 = secondary.
    let abs = mpf_offset + 4 + off as usize;
    if abs + size as usize > bytes.len() {
        return Err("Gain map data outside file bounds.".to_string());
    }
    let map_img = image::load_from_memory(&bytes[abs..abs + size as usize])
        .map_err(|e| format!("Failed to decode gain map image: {e}"))?
        .to_luma8();
    Ok(DecodedGainMap { metadata, map: map_img })
}

// ---------------------------------------------------------------------------
// Convenience helpers used by commands
// ---------------------------------------------------------------------------

/// Loads any image file as an sRGB-encoded Rgb<f32> buffer (what the HDR
/// merge pipeline stores before writing HDR TIFFs).
pub fn load_hdr_f32(path: &Path) -> Result<ImageBuffer<Rgb<f32>, Vec<f32>>, String> {
    let img = image::open(path)
        .map_err(|e| format!("Failed to open {}: {e}", path.display()))?;
    let dynamic: DynamicImage = img;
    Ok(match dynamic {
        DynamicImage::ImageRgb32F(buf) => buf,
        other => {
            let (w, h) = other.dimensions();
            let mut out = ImageBuffer::new(w, h);
            let rgb8 = other.to_rgb8();
            for (x, y, p) in rgb8.enumerate_pixels() {
                // 8/16-bit inputs are already display-referred sRGB values.
                out.put_pixel(
                    x,
                    y,
                    Rgb([
                        p[0] as f32 / 255.0,
                        p[1] as f32 / 255.0,
                        p[2] as f32 / 255.0,
                    ]),
                );
            }
            out
        }
    })
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GainMapExportInfo {
    pub path: String,
    pub gain_map_min: f32,
    pub gain_map_max: f32,
    pub reference_white: f32,
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GainMapInfo {
    pub has_gain_map: bool,
    pub gain_map_min: Option<f32>,
    pub gain_map_max: Option<f32>,
    pub gamma: Option<f32>,
    pub hdr_capacity_max: Option<f32>,
    pub map_width: Option<u32>,
    pub map_height: Option<u32>,
}

/// Writes an Ultra HDR-style JPEG from an HDR-capable source file.
#[tauri::command]
pub fn export_gain_map_jpeg(
    source_path: String,
    dest_path: String,
    baseline_exposure: Option<f32>,
    quality: Option<u8>,
) -> Result<GainMapExportInfo, String> {
    let hdr = load_hdr_f32(Path::new(&source_path))?;
    let be = baseline_exposure.unwrap_or(0.0);
    let bytes = encode_ultra_hdr_jpeg(&hdr, be, quality.unwrap_or(92))?;
    // Atomic write: temp + rename so a crash never leaves a partial JPEG.
    let dest = Path::new(&dest_path);
    let tmp = dest.with_file_name(format!(
        "{}.part",
        dest.file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_else(|| "export".to_string())
    ));
    std::fs::write(&tmp, &bytes)
        .map_err(|e| format!("Failed to write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, dest).map_err(|e| {
        let _ = std::fs::remove_file(&tmp);
        format!("Failed to finalize {}: {e}", dest.display())
    })?;
    let generated = generate_gain_map(&hdr, &tone_map_hdr_to_sdr(&hdr, be));
    Ok(GainMapExportInfo {
        path: dest_path,
        gain_map_min: generated.metadata.gain_map_min,
        gain_map_max: generated.metadata.gain_map_max,
        reference_white: reference_white(be),
    })
}

/// Reads gain map metadata from a JPEG (without decoding the map pixels).
#[tauri::command]
pub fn read_gain_map_jpeg(source_path: String) -> Result<GainMapInfo, String> {
    let bytes = std::fs::read(&source_path)
        .map_err(|e| format!("Failed to read {}: {e}", source_path))?;
    match decode_gain_map_jpeg(&bytes) {
        Ok(decoded) => Ok(GainMapInfo {
            has_gain_map: true,
            gain_map_min: Some(decoded.metadata.gain_map_min),
            gain_map_max: Some(decoded.metadata.gain_map_max),
            gamma: Some(decoded.metadata.gamma),
            hdr_capacity_max: Some(decoded.metadata.hdr_capacity_max),
            map_width: Some(decoded.map.width()),
            map_height: Some(decoded.map.height()),
        }),
        Err(_) => Ok(GainMapInfo {
            has_gain_map: false,
            gain_map_min: None,
            gain_map_max: None,
            gamma: None,
            hdr_capacity_max: None,
            map_width: None,
            map_height: None,
        }),
    }
}

/// Reconstructs the HDR rendition (base64 PNG preview) from a gain map JPEG
/// at `headroom` display stops. Values beyond SDR white are clipped in the
/// preview PNG; the underlying math keeps full float precision.
#[tauri::command]
pub fn preview_gain_map_hdr(source_path: String, headroom: f32) -> Result<String, String> {
    let bytes = std::fs::read(&source_path)
        .map_err(|e| format!("Failed to read {}: {e}", source_path))?;
    let decoded = decode_gain_map_jpeg(&bytes)?;
    let sdr_img = image::load_from_memory(&bytes)
        .map_err(|e| format!("Failed to decode base JPEG: {e}"))?
        .to_rgb8();
    let hdr = apply_gain_map(&sdr_img, &decoded.map, &decoded.metadata, headroom);
    // Preview: re-encode through the same tone pipeline (clamped to SDR white).
    let preview = tone_map_hdr_to_sdr(&hdr, -1.0); // -1.0 BE ≈ neutral re-encode
    let mut buf = std::io::Cursor::new(Vec::new());
    preview
        .write_to(&mut buf, image::ImageFormat::Png)
        .map_err(|e| format!("Failed to encode preview: {e}"))?;
    let b64 = base64::engine::general_purpose::STANDARD.encode(buf.into_inner());
    Ok(format!("data:image/png;base64,{b64}"))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn hdr_fixture() -> ImageBuffer<Rgb<f32>, Vec<f32>> {
        // 4×4 synthetic scene: mid grey, SDR white, 2 stops, 4 stops, black.
        let mut img = ImageBuffer::new(4, 4);
        let vals: [[f32; 3]; 4] = [
            [0.1845, 0.1845, 0.1845], // mid grey (sRGB-encoded 0.4627 in)
            [1.0, 1.0, 1.0],          // SDR white
            [2.0, 2.0, 2.0],          // +1 stop over white (sRGB-encoded)
            [4.0, 4.0, 4.0],          // +2 stops over white
        ];
        for x in 0..4u32 {
            for y in 0..4u32 {
                let v = vals[x as usize];
                // Convert scene-linear to the sRGB-encoded storage domain.
                let enc = linear_to_srgb(v[0]);
                img.put_pixel(x, y, Rgb([enc, enc, enc]));
            }
        }
        img
    }

    #[test]
    fn reference_white_matches_dng_formula() {
        assert!((reference_white(0.0) - 1.0).abs() < 1e-6);
        assert!((reference_white(1.0) - 2.0).abs() < 1e-6);
        assert!((reference_white(-1.0) - 0.5).abs() < 1e-6);
        assert!((reference_white(-2.0) - 0.25).abs() < 1e-6);
    }

    #[test]
    fn tone_map_preserves_mid_grey() {
        let hdr = hdr_fixture();
        for be in [0.0f32, 1.0, -1.0] {
            let sdr = tone_map_hdr_to_sdr(&hdr, be);
            let mid = sdr.get_pixel(0, 0);
            let expected = (SDR_MID_GRAY * 255.0).round() as u8;
            assert!(
                (mid[0] as i32 - expected as i32).abs() <= 1,
                "BE={be}: mid grey {} != {expected}",
                mid[0]
            );
            // SDR white and above clip to white. Use the 4.0-linear pixel:
            // it is at/above reference white for BE ∈ {-1, 0, +1}
            // (ref = 0.5 / 1.0 / 2.0).
            assert_eq!(sdr.get_pixel(3, 0)[0], 255);
        }
    }

    #[test]
    fn gain_map_range_and_reconstruction() {
        let hdr = hdr_fixture();
        let sdr = tone_map_hdr_to_sdr(&hdr, 0.0);
        let generated = generate_gain_map(&hdr, &sdr);
        // Black pixel → gain 0; 4.0-linear pixel → ~2 stops over SDR white.
        assert!(generated.metadata.gain_map_min.abs() < 0.1);
        assert!(
            (generated.metadata.gain_map_max - 2.0).abs() < 0.1,
            "max gain {}",
            generated.metadata.gain_map_max
        );

        // Full-capacity reconstruction of the 4-stop pixel (apply returns
        // scene-linear values).
        let rebuilt = apply_gain_map(&sdr, &generated.map, &generated.metadata, 2.0);
        let px = rebuilt.get_pixel(3, 0);
        assert!(
            (px[0] - 4.0).abs() < 0.05,
            "reconstructed {} vs 4.0 linear",
            px[0]
        );

        // Headroom 0 reproduces the SDR rendition.
        let flat = apply_gain_map(&sdr, &generated.map, &generated.metadata, 0.0);
        let sdr_lin = srgb_to_linear(sdr.get_pixel(3, 0)[0] as f32 / 255.0);
        assert!((flat.get_pixel(3, 0)[0] - sdr_lin).abs() < 1e-4);
    }

    #[test]
    fn xmp_roundtrip() {
        let meta = GainMapMetadata {
            gain_map_min: -0.5,
            gain_map_max: 2.25,
            gamma: 1.0,
            offset_sdr: GAIN_OFFSET,
            offset_hdr: GAIN_OFFSET,
            hdr_capacity_min: 0.0,
            hdr_capacity_max: 2.25,
            base_rendition_is_hdr: false,
        };
        let xmp = meta.to_xmp();
        let parsed = GainMapMetadata::from_xmp(&xmp).expect("parse xmp");
        assert!((parsed.gain_map_min - meta.gain_map_min).abs() < 1e-3);
        assert!((parsed.gain_map_max - meta.gain_map_max).abs() < 1e-3);
        assert!((parsed.hdr_capacity_max - meta.hdr_capacity_max).abs() < 1e-3);
        assert!(!parsed.base_rendition_is_hdr);
        // Non-gain-map XMP is rejected.
        assert!(GainMapMetadata::from_xmp("<x:xmpmeta><rdf:RDF/></rdf:RDF></x:xmpmeta>").is_none());
    }

    #[test]
    fn container_roundtrip() {
        let hdr = hdr_fixture();
        let bytes = encode_ultra_hdr_jpeg(&hdr, 0.0, 90).expect("encode");
        assert_eq!(&bytes[0..2], &[0xFF, 0xD8]);

        let decoded = decode_gain_map_jpeg(&bytes).expect("decode");
        assert!((decoded.metadata.gain_map_max - 2.0).abs() < 0.15);
        assert_eq!(decoded.map.width(), 4);
        assert_eq!(decoded.map.height(), 4);

        // Reconstruction through the container matches the direct pipeline
        // (JPEG compression on the map introduces a small tolerance).
        let sdr_img = image::load_from_memory(&bytes).expect("base decode").to_rgb8();
        let rebuilt = apply_gain_map(&sdr_img, &decoded.map, &decoded.metadata, 2.0);
        let px = rebuilt.get_pixel(3, 0);
        assert!((px[0] - 4.0).abs() < 0.15, "got {} linear", px[0]);
    }

    #[test]
    fn decode_rejects_plain_jpeg() {
        let sdr = tone_map_hdr_to_sdr(&hdr_fixture(), 0.0);
        let plain = encode_sdr_jpeg(&sdr, 90).expect("plain jpeg");
        assert!(decode_gain_map_jpeg(&plain).is_err());
    }
}
