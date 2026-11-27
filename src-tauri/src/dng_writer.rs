//! Minimal linear DNG writer (P1-1).
//!
//! Writes a DNG 1.4 "linear raw" file (PhotometricInterpretation = 34892,
//! LinearRaw) from 16-bit RGB data: TIFF little-endian, one IFD, single
//! strip, no SubIFD/thumbnail. The input is expected to be sRGB-referred
//! (display-referred) 16-bit data as produced by the export pipeline; values
//! are converted to scene-linear before writing so downstream raw developers
//! see a properly linear DNG.
//!
//! Required DNG tags for LinearRaw are included (DNGVersion, UniqueCameraModel,
//! ColorMatrix1 with D65→sRGB primaries, AsShotNeutral, CalibrationIlluminant1
//! = D65). This is intentionally the minimum viable set — enough for RawTherapee,
//! darktable and FastRawViewer to open the file as a raw image.

use image::{ImageBuffer, Rgb};

const PHOTOMETRIC_LINEAR_RAW: u16 = 34892;
const CALIBRATION_ILLUMINANT_D65: u16 = 21;
const CAMERA_MAKE: &str = "anwuRAW";
const CAMERA_MODEL: &str = "anwuRAW Linear DNG";

// TIFF field types
const TYPE_BYTE: u16 = 1;
const TYPE_ASCII: u16 = 2;
const TYPE_SHORT: u16 = 3;
const TYPE_LONG: u16 = 4;
const TYPE_RATIONAL: u16 = 5;
const TYPE_SRATIONAL: u16 = 10;

fn srgb_to_linear(c: f32) -> f32 {
    let c = (c / 65535.0).clamp(0.0, 1.0);
    if c <= 0.04045 {
        c / 12.92
    } else {
        ((c + 0.055) / 1.055).powf(2.4)
    }
}

/// XYZ (D65) → linear sRGB primaries matrix, ×10 000 as SRATIONAL pairs.
const COLOR_MATRIX1: [[i32; 2]; 9] = [
    [32406, 10000],
    [-15372, 10000],
    [-4986, 10000],
    [-9689, 10000],
    [18758, 10000],
    [415, 10000],
    [557, 10000],
    [-2040, 10000],
    [10570, 10000],
];

struct Entry {
    tag: u16,
    kind: u16,
    count: u32,
    /// Inline ≤ 4-byte payload (little-endian, value in the first 4 bytes).
    inline: Option<u32>,
    /// External payload bytes (counts > 4 bytes).
    payload: Option<Vec<u8>>,
}

impl Entry {
    fn inline_u32(tag: u16, v: u32) -> Entry {
        Entry { tag, kind: TYPE_LONG, count: 1, inline: Some(v), payload: None }
    }
    fn inline_u16(tag: u16, kind: u16, v: u16) -> Entry {
        Entry { tag, kind, count: 1, inline: Some(v as u32), payload: None }
    }
    fn external(tag: u16, kind: u16, count: u32, payload: Vec<u8>) -> Entry {
        Entry { tag, kind, count, inline: None, payload: Some(payload) }
    }
}

fn ascii_payload(s: &str) -> Vec<u8> {
    let mut v = s.as_bytes().to_vec();
    v.push(0);
    v
}

/// Encodes an sRGB-referred 16-bit RGB image as a minimal linear DNG.
pub fn encode_linear_dng(
    image: &ImageBuffer<Rgb<u16>, Vec<u16>>,
    model_override: Option<&str>,
) -> Result<Vec<u8>, String> {
    let (width, height) = image.dimensions();
    if width == 0 || height == 0 {
        return Err("Cannot write an empty DNG.".to_string());
    }

    // Strip data: scene-linear 16-bit samples, interleaved RGB.
    let mut strip = Vec::with_capacity((width as usize) * (height as usize) * 6);
    for px in image.pixels() {
        for c in 0..3 {
            let lin = srgb_to_linear(px[c] as f32);
            let v = (lin * 65535.0 + 0.5).min(65535.0) as u16;
            strip.extend_from_slice(&v.to_le_bytes());
        }
    }

    let model = model_override.unwrap_or(CAMERA_MODEL);

    // Tag ids must be ascending in a TIFF IFD.
    let mut entries: Vec<Entry> = vec![
        Entry::inline_u16(0x00FE, TYPE_LONG, 0), // NewSubfileType: full res
        Entry::inline_u32(0x0100, width),
        Entry::inline_u32(0x0101, height),
        Entry::external(
            0x0102,
            TYPE_SHORT,
            3,
            [16u16, 16, 16].iter().flat_map(|v| v.to_le_bytes()).collect(),
        ), // BitsPerSample
        Entry::inline_u16(0x0103, TYPE_SHORT, 1), // Compression: none
        Entry::inline_u16(0x0106, TYPE_SHORT, PHOTOMETRIC_LINEAR_RAW),
        Entry::external(0x010F, TYPE_ASCII, CAMERA_MAKE.len() as u32 + 1, ascii_payload(CAMERA_MAKE)),
        Entry::external(0x0110, TYPE_ASCII, model.len() as u32 + 1, ascii_payload(model)),
        Entry { tag: 0x0111, kind: TYPE_LONG, count: 1, inline: Some(0), payload: None }, // StripOffsets (patched)
        Entry::inline_u16(0x0115, TYPE_SHORT, 3), // SamplesPerPixel
        Entry::inline_u32(0x0116, height),        // RowsPerStrip (single strip)
        Entry { tag: 0x0117, kind: TYPE_LONG, count: 1, inline: Some(strip.len() as u32), payload: None }, // StripByteCounts
        Entry::inline_u16(0x011C, TYPE_SHORT, 1), // PlanarConfiguration: chunky
        Entry::external(
            0x0153,
            TYPE_SHORT,
            3,
            [1u16, 1, 1].iter().flat_map(|v| v.to_le_bytes()).collect(),
        ), // SampleFormat: unsigned int
        // 0xC612 DNGVersion = 1.4.0.0 (4 bytes fit inline)
        Entry { tag: 0xC612, kind: TYPE_BYTE, count: 4, inline: Some(0x00_00_04_01), payload: None },
        Entry::external(0xC614, TYPE_ASCII, model.len() as u32 + 1, ascii_payload(model)),
        Entry::external(
            0xC621,
            TYPE_SRATIONAL,
            9,
            COLOR_MATRIX1.iter().flat_map(|p| [p[0].to_le_bytes(), p[1].to_le_bytes()].concat()).collect(),
        ),
        Entry::external(
            0xC627,
            TYPE_RATIONAL,
            3,
            [[1u32, 1], [1, 1], [1, 1]].iter().flat_map(|p| [p[0].to_le_bytes(), p[1].to_le_bytes()].concat()).collect(),
        ), // AsShotNeutral: neutral (data is sRGB-referred)
        Entry::inline_u16(0xC65A, TYPE_SHORT, CALIBRATION_ILLUMINANT_D65),
    ];
    entries.sort_by_key(|e| e.tag);

    let ifd_count = entries.len() as u16;
    let ifd_size = 2 + entries.len() * 12 + 4;
    let mut external_offset = 8 + ifd_size;

    // Assign payload offsets (in entry order = ascending tag order).
    for entry in &mut entries {
        if let Some(payload) = entry.payload.as_mut() {
            entry.inline = Some(external_offset as u32);
            external_offset += payload.len();
            if payload.len() % 2 == 1 {
                external_offset += 1; // TIFF word alignment
            }
        }
    }

    let strip_offset = external_offset as u32;

    // Patch StripOffsets (and keep StripByteCounts correct) before assembly.
    for entry in &mut entries {
        if entry.tag == 0x0111 {
            entry.inline = Some(strip_offset);
        }
    }

    // Assemble.
    let mut out = Vec::with_capacity(strip_offset as usize + strip.len());
    out.extend_from_slice(b"II");
    out.extend_from_slice(&42u16.to_le_bytes());
    out.extend_from_slice(&8u32.to_le_bytes()); // IFD0 offset
    out.extend_from_slice(&ifd_count.to_le_bytes());
    for entry in &entries {
        out.extend_from_slice(&entry.tag.to_le_bytes());
        out.extend_from_slice(&entry.kind.to_le_bytes());
        out.extend_from_slice(&entry.count.to_le_bytes());
        out.extend_from_slice(&entry.inline.unwrap_or(0).to_le_bytes());
    }
    out.extend_from_slice(&0u32.to_le_bytes()); // next IFD = none
    for entry in &entries {
        if let Some(payload) = &entry.payload {
            let pad = out.len() % 2;
            if pad == 1 {
                out.push(0);
            }
            out.extend_from_slice(payload);
        }
    }
    debug_assert_eq!(out.len(), strip_offset as usize);
    out.extend_from_slice(&strip);

    Ok(out)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal little-endian TIFF/DNG parser used to validate the writer.
    struct ParsedDng {
        width: u32,
        height: u32,
        bits: Vec<u16>,
        photometric: u16,
        samples: u16,
        dng_version: [u8; 4],
        strip: (u32, u32), // offset, byte count
        color_matrix1: Vec<f32>,
        as_shot_neutral: Vec<f32>,
        calibration_light: u16,
    }

    fn parse(bytes: &[u8]) -> ParsedDng {
        assert_eq!(&bytes[0..2], b"II");
        assert_eq!(u16::from_le_bytes([bytes[2], bytes[3]]), 42);
        let ifd = u32::from_le_bytes(bytes[4..8].try_into().unwrap()) as usize;
        let count = u16::from_le_bytes([bytes[ifd], bytes[ifd + 1]]) as usize;

        let read_val = |kind: u16, count: u32, v: u32, raw: &[u8]| -> Vec<u64> {
            let n = count as usize;
            match kind {
                TYPE_BYTE => v.to_le_bytes()[..n.min(4)].iter().map(|&b| b as u64).collect(),
                TYPE_SHORT => {
                    let bytes = if n * 2 <= 4 {
                        v.to_le_bytes().to_vec()
                    } else {
                        raw[v as usize..v as usize + n * 2].to_vec()
                    };
                    (0..n).map(|i| u16::from_le_bytes([bytes[i * 2], bytes[i * 2 + 1]]) as u64).collect()
                }
                TYPE_LONG => {
                    let bytes = if n * 4 <= 4 {
                        v.to_le_bytes().to_vec()
                    } else {
                        raw[v as usize..v as usize + n * 4].to_vec()
                    };
                    (0..n).map(|i| u32::from_le_bytes(bytes[i * 4..i * 4 + 4].try_into().unwrap()) as u64).collect()
                }
                TYPE_RATIONAL | TYPE_SRATIONAL => {
                    let off = v as usize;
                    (0..n)
                        .map(|i| {
                            let num = u32::from_le_bytes(raw[off + i * 8..off + i * 8 + 4].try_into().unwrap());
                            let den = u32::from_le_bytes(raw[off + i * 8 + 4..off + i * 8 + 8].try_into().unwrap());
                            ((num as u64) << 32) | den as u64
                        })
                        .collect()
                }
                _ => vec![],
            }
        };

        let mut p = ParsedDng {
            width: 0,
            height: 0,
            bits: vec![],
            photometric: 0,
            samples: 0,
            dng_version: [0; 4],
            strip: (0, 0),
            color_matrix1: vec![],
            as_shot_neutral: vec![],
            calibration_light: 0,
        };
        for e in 0..count {
            let base = ifd + 2 + e * 12;
            let tag = u16::from_le_bytes([bytes[base], bytes[base + 1]]);
            let kind = u16::from_le_bytes([bytes[base + 2], bytes[base + 3]]);
            let cnt = u32::from_le_bytes(bytes[base + 4..base + 8].try_into().unwrap());
            let val = u32::from_le_bytes(bytes[base + 8..base + 12].try_into().unwrap());
            let vals = read_val(kind, cnt, val, bytes);
            match tag {
                0x0100 => p.width = vals[0] as u32,
                0x0101 => p.height = vals[0] as u32,
                0x0102 => p.bits = vals.iter().map(|&v| v as u16).collect(),
                0x0106 => p.photometric = vals[0] as u16,
                0x0111 => p.strip.0 = vals[0] as u32,
                0x0115 => p.samples = vals[0] as u16,
                0x0117 => p.strip.1 = vals[0] as u32,
                0xC612 => {
                    let inline = val.to_le_bytes();
                    p.dng_version.copy_from_slice(&inline);
                }
                0xC621 => p.color_matrix1 = vals.iter().map(|v| (v >> 32) as i32 as f32 / (v & 0xFFFF_FFFF) as f32).collect(),
                0xC627 => p.as_shot_neutral = vals.iter().map(|v| (v >> 32) as f32 / (v & 0xFFFF_FFFF) as f32).collect(),
                0xC65A => p.calibration_light = vals[0] as u16,
                _ => {}
            }
        }
        p
    }

    #[test]
    fn linear_dng_structure_and_strip_content() {
        // 2×1 image with known sRGB-referred 16-bit values.
        let mut img = ImageBuffer::new(2, 1);
        img.put_pixel(0, 0, Rgb([0, 0, 0]));
        img.put_pixel(1, 0, Rgb([65535, 32768, 4369]));

        let bytes = encode_linear_dng(&img, None).expect("encode");
        let parsed = parse(&bytes);

        assert_eq!(parsed.width, 2);
        assert_eq!(parsed.height, 1);
        assert_eq!(parsed.photometric, 34892);
        assert_eq!(parsed.samples, 3);
        assert_eq!(parsed.bits, vec![16, 16, 16]);
        assert_eq!(parsed.dng_version, [1, 4, 0, 0]);
        assert_eq!(parsed.calibration_light, 21);
        assert_eq!(parsed.strip.1, 2 * 1 * 6);
        // ColorMatrix1 first element ≈ 3.2406; AsShotNeutral = 1.0.
        assert!((parsed.color_matrix1[0] - 3.2406).abs() < 1e-3);
        assert!((parsed.as_shot_neutral[0] - 1.0).abs() < 1e-6);

        // Strip content: black pixel → 0; mid point 32768 (sRGB-encoded u16)
        // → linear ≈ 0.2140 → ≈ 14028; smallest value 4369 (u16) → ≈ 367.
        // Strip layout for the 2×1 image: pixel0 = [0,0,0], pixel1 =
        // [65535, 32768, 4369] → 6 u16 samples, indices 0..5.
        let strip = &bytes[parsed.strip.0 as usize..(parsed.strip.0 + parsed.strip.1) as usize];
        let v = |i: usize| u16::from_le_bytes([strip[i * 2], strip[i * 2 + 1]]);
        assert_eq!(v(0), 0);
        assert_eq!(v(1), 0);
        assert_eq!(v(2), 0);
        assert_eq!(v(3), 65535);
        // srgb_to_linear takes the raw u16 domain (it divides by 65535 itself).
        let mid = srgb_to_linear(32768.0) * 65535.0;
        assert!((v(4) as f32 - mid).abs() < 2.0, "got {}", v(4));
        let low = srgb_to_linear(4369.0) * 65535.0;
        assert!((v(5) as f32 - low).abs() < 2.0, "got {}", v(5));
    }

    #[test]
    fn strip_offset_matches_payload_start() {
        let mut img = ImageBuffer::new(3, 2);
        for y in 0..2 {
            for x in 0..3 {
                img.put_pixel(x, y, Rgb([(x * 20000) as u16, (y * 30000) as u16, 1]));
            }
        }
        let bytes = encode_linear_dng(&img, Some("Test Cam")).expect("encode");
        let parsed = parse(&bytes);
        // Everything between the IFD external payloads and the strip is tag
        // data; the strip must start exactly where StripOffsets says.
        assert!(parsed.strip.0 > 0);
        assert_eq!(bytes.len() as u32, parsed.strip.0 + parsed.strip.1);
    }
}
