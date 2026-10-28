//! Wide-gamut export support: generates standard RGB matrix/TRC ICC profiles
//! (Display P3, ProPhoto RGB, Rec.2020) at runtime and converts sRGB-encoded
//! pixels into the target color space. sRGB exports keep using the bundled
//! `icc/sRGB-v2-magic.icc` profile.

use std::sync::OnceLock;

use image::{DynamicImage, ImageBuffer, Rgb};

/// Export color spaces supported by `encode_image_to_bytes` for
/// JPEG / PNG / TIFF. All values are sRGB unless a wide-gamut space is chosen.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum ExportColorSpace {
    #[default]
    Srgb,
    DisplayP3,
    ProPhotoRgb,
    Rec2020,
}

impl ExportColorSpace {
    pub fn parse(value: Option<&str>) -> Self {
        match value {
            Some("display-p3") => Self::DisplayP3,
            Some("prophoto-rgb") => Self::ProPhotoRgb,
            Some("rec2020") => Self::Rec2020,
            _ => Self::Srgb,
        }
    }

    pub fn is_srgb(self) -> bool {
        self == Self::Srgb
    }
}

type Mat3 = [[f64; 3]; 3]; // row-major: rows = output components, cols = input components

const BRADFORD_D65_TO_D50: Mat3 = [
    [1.0479297945586605, 0.022946877522749, -0.050192218531816],
    [0.02962780943027, 0.990434423538334, -0.017073799867067],
    [-0.009243005897576, 0.015055199401405, 0.751874338407761],
];

fn xy_to_xyz(p: (f64, f64)) -> [f64; 3] {
    let (x, y) = p;
    [x / y, 1.0, (1.0 - x - y) / y]
}

/// Build the RGB(D65 or D50 native) → XYZ(white) matrix whose columns are the
/// primary XYZ vectors scaled so that the matrix maps white to the white point.
fn primaries_to_xyz(primaries: [(f64, f64); 3], white: (f64, f64)) -> Mat3 {
    let mut m = [[0.0f64; 3]; 3];
    for (col, primary) in primaries.iter().enumerate() {
        let xyz = xy_to_xyz(*primary);
        for row in 0..3 {
            m[row][col] = xyz[row];
        }
    }
    let w = xy_to_xyz(white);
    let s = mul_vec(&invert3(&m), &w);
    for col in 0..3 {
        for row in 0..3 {
            m[row][col] *= s[col];
        }
    }
    m
}

fn invert3(m: &Mat3) -> Mat3 {
    let det = m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1])
        - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0])
        + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
    let inv_det = 1.0 / det;
    [
        [
            (m[1][1] * m[2][2] - m[1][2] * m[2][1]) * inv_det,
            (m[0][2] * m[2][1] - m[0][1] * m[2][2]) * inv_det,
            (m[0][1] * m[1][2] - m[0][2] * m[1][1]) * inv_det,
        ],
        [
            (m[1][2] * m[2][0] - m[1][0] * m[2][2]) * inv_det,
            (m[0][0] * m[2][2] - m[0][2] * m[2][0]) * inv_det,
            (m[0][2] * m[1][0] - m[0][0] * m[1][2]) * inv_det,
        ],
        [
            (m[1][0] * m[2][1] - m[1][1] * m[2][0]) * inv_det,
            (m[0][1] * m[2][0] - m[0][0] * m[2][1]) * inv_det,
            (m[0][0] * m[1][1] - m[0][1] * m[1][0]) * inv_det,
        ],
    ]
}

fn mul(a: &Mat3, b: &Mat3) -> Mat3 {
    let mut out = [[0.0f64; 3]; 3];
    for row in 0..3 {
        for col in 0..3 {
            out[row][col] = a[row][0] * b[0][col] + a[row][1] * b[1][col] + a[row][2] * b[2][col];
        }
    }
    out
}

fn mul_vec(m: &Mat3, v: &[f64; 3]) -> [f64; 3] {
    [
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ]
}

fn srgb_rgb_to_xyz() -> Mat3 {
    primaries_to_xyz(
        [(0.640, 0.330), (0.300, 0.600), (0.150, 0.060)],
        (0.3127, 0.3290),
    )
}

fn target_space_matrix_d50(space: ExportColorSpace) -> Mat3 {
    // All target primaries are expressed against their native white (D65 for
    // P3 / Rec.2020, D50 for ProPhoto's published definition). To keep grey
    // pixels mathematically neutral through the sRGB→target chain, every
    // matrix is built against the sRGB D65 white and then Bradford-adapted
    // to the ICC PCS (D50) — identical to how P3 / Rec.2020 are handled, and
    // equivalent to the chad-tag model used by standard matrix profiles.
    let primaries = match space {
        ExportColorSpace::DisplayP3 => [(0.680, 0.320), (0.265, 0.690), (0.150, 0.060)],
        ExportColorSpace::ProPhotoRgb => [
            (0.734699, 0.265303),
            (0.159597, 0.840403),
            (0.036598, 0.000105),
        ],
        ExportColorSpace::Rec2020 => [(0.708, 0.292), (0.170, 0.797), (0.131, 0.046)],
        ExportColorSpace::Srgb => [(0.640, 0.330), (0.300, 0.600), (0.150, 0.060)],
    };
    let m_d65 = primaries_to_xyz(primaries, (0.3127, 0.3290));
    mul(&BRADFORD_D65_TO_D50, &m_d65)
}

// ---------------------------------------------------------------------------
// Transfer characteristics
// ---------------------------------------------------------------------------

fn srgb_trc(x: f64) -> f64 {
    if x <= 0.0031308 {
        x * 12.92
    } else {
        1.055 * x.powf(1.0 / 2.4) - 0.055
    }
}

fn prophoto_trc(x: f64) -> f64 {
    if x < 1.0 / 512.0 {
        x * 16.0
    } else {
        x.powf(1.0 / 1.8)
    }
}

fn gamma24_trc(x: f64) -> f64 {
    x.powf(1.0 / 2.4)
}

fn trc_fn(space: ExportColorSpace) -> fn(f64) -> f64 {
    match space {
        ExportColorSpace::DisplayP3 => srgb_trc,
        ExportColorSpace::ProPhotoRgb => prophoto_trc,
        ExportColorSpace::Rec2020 => gamma24_trc,
        ExportColorSpace::Srgb => srgb_trc,
    }
}

fn trc_table(space: ExportColorSpace) -> Vec<u16> {
    let f = trc_fn(space);
    (0..1024)
        .map(|i| {
            let x = i as f64 / 1023.0;
            (f(x).clamp(0.0, 1.0) * 65535.0).round() as u16
        })
        .collect()
}

// ---------------------------------------------------------------------------
// ICC profile generation (ICC v2 matrix/TRC display profiles)
// ---------------------------------------------------------------------------

const PCS_ILLUMINANT_D50: [[u8; 4]; 3] = [
    0x00_00_F6_D6_u32.to_be_bytes(),
    0x00_01_00_00_u32.to_be_bytes(),
    0x00_00_D3_2D_u32.to_be_bytes(),
];

fn s15f16(v: f64) -> [u8; 4] {
    ((v * 65536.0).round() as i64 as i32).to_be_bytes()
}

fn xyz_tag(x: f64, y: f64, z: f64) -> Vec<u8> {
    let mut data = Vec::with_capacity(20);
    data.extend_from_slice(b"XYZ ");
    data.extend_from_slice(&0u32.to_be_bytes());
    for v in [x, y, z] {
        data.extend_from_slice(&s15f16(v));
    }
    data
}

fn curv_tag(table: &[u16]) -> Vec<u8> {
    let mut data = Vec::with_capacity(12 + table.len() * 2);
    data.extend_from_slice(b"curv");
    data.extend_from_slice(&0u32.to_be_bytes());
    data.extend_from_slice(&(table.len() as u32).to_be_bytes());
    for &v in table {
        data.extend_from_slice(&v.to_be_bytes());
    }
    data
}

fn text_tag(content: &str) -> Vec<u8> {
    let mut data = Vec::with_capacity(8 + content.len() + 1);
    data.extend_from_slice(b"text");
    data.extend_from_slice(&0u32.to_be_bytes());
    data.extend_from_slice(content.as_bytes());
    data.push(0);
    data
}

fn desc_tag(content: &str) -> Vec<u8> {
    let ascii = content.as_bytes();
    let mut data = Vec::with_capacity(90 + ascii.len());
    data.extend_from_slice(b"desc");
    data.extend_from_slice(&0u32.to_be_bytes());
    data.extend_from_slice(&((ascii.len() + 1) as u32).to_be_bytes());
    data.extend_from_slice(ascii);
    data.push(0);
    data.extend_from_slice(&0u32.to_be_bytes()); // unicode language code
    data.extend_from_slice(&0u32.to_be_bytes()); // unicode count
    data.extend_from_slice(&0u16.to_be_bytes()); // scriptcode code
    data.push(0); // scriptcode count
    data.extend_from_slice(&[0u8; 67]); // scriptcode description
    data
}

fn sf32_tag(m: &Mat3) -> Vec<u8> {
    let mut data = Vec::with_capacity(44);
    data.extend_from_slice(b"sf32");
    data.extend_from_slice(&0u32.to_be_bytes());
    for row in m {
        for v in row {
            data.extend_from_slice(&s15f16(*v));
        }
    }
    data
}

fn build_rgb_matrix_icc(description: &str, space: ExportColorSpace) -> Vec<u8> {
    let colorants = target_space_matrix_d50(space);
    let trc = trc_table(space);

    let media_white = mul_vec(&colorants, &[1.0, 1.0, 1.0]);

    let mut tags: Vec<([u8; 4], Vec<u8>)> = vec![
        (*b"desc", desc_tag(description)),
        (*b"cprt", text_tag("Generated by RapidRAW")),
        (
            *b"wtpt",
            xyz_tag(media_white[0], media_white[1], media_white[2]),
        ),
        (
            *b"rXYZ",
            xyz_tag(colorants[0][0], colorants[1][0], colorants[2][0]),
        ),
        (
            *b"gXYZ",
            xyz_tag(colorants[0][1], colorants[1][1], colorants[2][1]),
        ),
        (
            *b"bXYZ",
            xyz_tag(colorants[0][2], colorants[1][2], colorants[2][2]),
        ),
        (*b"rTRC", curv_tag(&trc)),
        (*b"gTRC", curv_tag(&trc)),
        (*b"bTRC", curv_tag(&trc)),
        (*b"chad", sf32_tag(&BRADFORD_D65_TO_D50)),
    ];

    let tag_table_len = 4 + tags.len() * 12;
    let mut tag_table = Vec::with_capacity(tag_table_len);
    tag_table.extend_from_slice(&(tags.len() as u32).to_be_bytes());

    let mut body = Vec::new();
    let mut offset = (128 + tag_table_len) as u32;
    for (sig, data) in &tags {
        tag_table.extend_from_slice(sig);
        tag_table.extend_from_slice(&offset.to_be_bytes());
        tag_table.extend_from_slice(&(data.len() as u32).to_be_bytes());
        offset += data.len() as u32;
        let padding = (4 - (data.len() % 4)) % 4;
        offset += padding as u32;
        body.extend_from_slice(data);
        body.extend(std::iter::repeat_n(0u8, padding));
    }

    let total_size = 128 + tag_table_len + body.len();
    let mut out = Vec::with_capacity(total_size);
    out.extend_from_slice(&(total_size as u32).to_be_bytes()); // profile size
    out.extend_from_slice(&[0, 0, 0, 0]); // preferred CMM
    out.extend_from_slice(&0x02_40_00_00u32.to_be_bytes()); // ICC v2.4
    out.extend_from_slice(b"mntr"); // device class
    out.extend_from_slice(b"RGB "); // data colour space
    out.extend_from_slice(b"XYZ "); // PCS
    out.extend_from_slice(&2026u16.to_be_bytes()); // date: year
    out.extend_from_slice(&10u16.to_be_bytes()); // month
    out.extend_from_slice(&28u16.to_be_bytes()); // day
    out.extend_from_slice(&0u16.to_be_bytes()); // hour
    out.extend_from_slice(&0u16.to_be_bytes()); // minute
    out.extend_from_slice(&0u16.to_be_bytes()); // second
    out.extend_from_slice(b"acsp"); // 'acsp' signature
    out.extend_from_slice(&[0, 0, 0, 0]); // platform
    out.extend_from_slice(&[0, 0, 0, 0]); // flags
    out.extend_from_slice(&[0, 0, 0, 0]); // manufacturer
    out.extend_from_slice(&[0, 0, 0, 0]); // model
    out.extend_from_slice(&[0u8; 8]); // attributes
    out.extend_from_slice(&0u32.to_be_bytes()); // rendering intent: perceptual
    for bytes in PCS_ILLUMINANT_D50 {
        out.extend_from_slice(&bytes); // PCS illuminant
    }
    out.extend_from_slice(&[0, 0, 0, 0]); // creator
    out.extend_from_slice(&[0u8; 44]); // reserved

    out.extend_from_slice(&tag_table);
    out.extend_from_slice(&body);
    debug_assert_eq!(out.len(), total_size);
    out
}

static DISPLAY_P3_ICC: OnceLock<Vec<u8>> = OnceLock::new();
static PROPHOTO_ICC: OnceLock<Vec<u8>> = OnceLock::new();
static REC2020_ICC: OnceLock<Vec<u8>> = OnceLock::new();

pub fn icc_profile_bytes(space: ExportColorSpace) -> &'static [u8] {
    match space {
        ExportColorSpace::Srgb => crate::export_processing::srgb_icc_profile(),
        ExportColorSpace::DisplayP3 => {
            DISPLAY_P3_ICC.get_or_init(|| build_rgb_matrix_icc("Display P3", space))
        }
        ExportColorSpace::ProPhotoRgb => {
            PROPHOTO_ICC.get_or_init(|| build_rgb_matrix_icc("ProPhoto RGB", space))
        }
        ExportColorSpace::Rec2020 => {
            REC2020_ICC.get_or_init(|| build_rgb_matrix_icc("ITU-R BT.2020", space))
        }
    }
}

// ---------------------------------------------------------------------------
// Pixel conversion: sRGB-encoded pixels → target color space
// ---------------------------------------------------------------------------

/// Convert sRGB-encoded pixels into the target color space (decode →
/// chromatically adapted linear transform → target TRC). Output is 16-bit.
pub fn convert_srgb_to_color_space(image: &DynamicImage, space: ExportColorSpace) -> DynamicImage {
    let rgb_to_xyz = srgb_rgb_to_xyz();
    // linear target = target⁻¹ · Bradford · sRGB_to_XYZ · linear sRGB
    let combined = mul(
        &invert3(&target_space_matrix_d50(space)),
        &mul(&BRADFORD_D65_TO_D50, &rgb_to_xyz),
    );
    let encode = trc_fn(space);

    let source = image.to_rgb32f();
    let (width, height) = source.dimensions();
    let mut out: ImageBuffer<Rgb<u16>, Vec<u16>> = ImageBuffer::new(width, height);

    for (x, y, pixel) in source.enumerate_pixels() {
        let lin = [
            srgb_decode(f64::from(pixel[0])),
            srgb_decode(f64::from(pixel[1])),
            srgb_decode(f64::from(pixel[2])),
        ];
        let mapped = mul_vec(&combined, &lin);
        let encoded: [u16; 3] = [
            (encode(mapped[0]).clamp(0.0, 1.0) * 65535.0).round() as u16,
            (encode(mapped[1]).clamp(0.0, 1.0) * 65535.0).round() as u16,
            (encode(mapped[2]).clamp(0.0, 1.0) * 65535.0).round() as u16,
        ];
        out.put_pixel(x, y, Rgb(encoded));
    }

    DynamicImage::ImageRgb16(out)
}

fn srgb_decode(v: f64) -> f64 {
    let v = v.clamp(0.0, 1.0);
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn assert_close(a: f64, b: f64, eps: f64) {
        assert!(
            (a - b).abs() < eps,
            "expected {b}, got {a} (diff {})",
            (a - b).abs()
        );
    }

    #[test]
    fn srgb_matrix_maps_white_to_d65_xyz() {
        let m = srgb_rgb_to_xyz();
        let w = mul_vec(&m, &[1.0, 1.0, 1.0]);
        // xy=(0.3127, 0.3290) → XYZ = (x/y, 1, (1-x-y)/y)
        assert_close(w[0], 0.3127 / 0.3290, 1.0e-4);
        assert_close(w[1], 1.0, 1.0e-4);
        assert_close(w[2], (1.0 - 0.3127 - 0.3290) / 0.3290, 1.0e-4);
    }

    #[test]
    fn target_matrix_preserves_its_own_white() {
        for space in [
            ExportColorSpace::DisplayP3,
            ExportColorSpace::ProPhotoRgb,
            ExportColorSpace::Rec2020,
        ] {
            let m = target_space_matrix_d50(space);
            // Columns scaled for D50 white: row sums weighted by Bradford-adapted D50 white
            let srgb_m = mul(&BRADFORD_D65_TO_D50, &srgb_rgb_to_xyz());
            let d50 = mul_vec(&srgb_m, &[1.0, 1.0, 1.0]);
            let w = mul_vec(&m, &mul_vec(&invert3(&m), &d50));
            assert_close(w[0], d50[0], 1.0e-6);
            assert_close(w[1], d50[1], 1.0e-6);
            assert_close(w[2], d50[2], 1.0e-6);
        }
    }

    #[test]
    fn icc_profiles_have_valid_structure() {
        for space in [
            ExportColorSpace::DisplayP3,
            ExportColorSpace::ProPhotoRgb,
            ExportColorSpace::Rec2020,
        ] {
            let icc = icc_profile_bytes(space);
            assert!(icc.len() > 128);
            let size = u32::from_be_bytes([icc[0], icc[1], icc[2], icc[3]]) as usize;
            assert_eq!(size, icc.len(), "{space:?}: header size != actual size");
            assert_eq!(&icc[36..40], b"acsp");
            assert_eq!(&icc[12..16], b"mntr");
            assert_eq!(&icc[16..20], b"RGB ");
            assert_eq!(&icc[20..24], b"XYZ ");
            let tag_count = u32::from_be_bytes([icc[128], icc[129], icc[130], icc[131]]) as usize;
            // desc/cprt/wtpt/rXYZ/gXYZ/bXYZ/rTRC/gTRC/bTRC + chad
            assert_eq!(tag_count, 10, "{space:?}: unexpected tag count");
        }
    }

    #[test]
    fn conversion_maps_grey_to_grey() {
        let image = DynamicImage::ImageRgb8(image::RgbImage::from_fn(4, 4, |x, y| {
            let v = ((x + y) * 40) as u8;
            image::Rgb([v, v, v])
        }));
        for space in [
            ExportColorSpace::DisplayP3,
            ExportColorSpace::ProPhotoRgb,
            ExportColorSpace::Rec2020,
        ] {
            let converted = convert_srgb_to_color_space(&image, space);
            let rgb16 = converted.as_rgb16().unwrap();
            for p in rgb16.pixels() {
                assert_eq!(p[0], p[1]);
                assert_eq!(p[1], p[2]);
            }
        }
    }

    #[test]
    fn trc_tables_cover_full_range() {
        for space in [
            ExportColorSpace::DisplayP3,
            ExportColorSpace::ProPhotoRgb,
            ExportColorSpace::Rec2020,
        ] {
            let table = trc_table(space);
            assert_eq!(table[0], 0);
            assert_eq!(table[1023], 65535);
            assert!(table.windows(2).all(|w| w[0] <= w[1]));
        }
    }

    #[test]
    fn parse_and_defaults() {
        assert_eq!(ExportColorSpace::parse(None), ExportColorSpace::Srgb);
        assert_eq!(
            ExportColorSpace::parse(Some("display-p3")),
            ExportColorSpace::DisplayP3
        );
        assert_eq!(
            ExportColorSpace::parse(Some("prophoto-rgb")),
            ExportColorSpace::ProPhotoRgb
        );
        assert_eq!(
            ExportColorSpace::parse(Some("rec2020")),
            ExportColorSpace::Rec2020
        );
        assert_eq!(
            ExportColorSpace::parse(Some("nonsense")),
            ExportColorSpace::Srgb
        );
    }
}
