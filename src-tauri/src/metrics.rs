//! Image comparison metrics shared by the golden render regression harness
//! (`examples/golden_metrics.rs`) and the objective quality tests
//! (`image_processing` test modules).
//!
//! Everything here is deterministic and dependency-light so the same numbers
//! are produced by the app binary, the example CLI and `cargo test`.

use image::DynamicImage;

/// 16-bit RGB image type. The image crate (0.25) only aliases `RgbImage` (u8)
/// and `Rgb32FImage`, so 16-bit comparisons spell the buffer type out.
pub type Rgb16Image = image::ImageBuffer<image::Rgb<u16>, Vec<u16>>;

/// sRGB (0..1, display-encoded) -> CIE L*a*b* (D65 white point).
pub fn srgb_to_lab(rgb: [f32; 3]) -> [f32; 3] {
    let linear = rgb.map(|c| {
        if c <= 0.04045 {
            c / 12.92
        } else {
            ((c + 0.055) / 1.055).powf(2.4)
        }
    });
    // sRGB D65 -> XYZ (Y normalized to 1).
    let x = 0.4124564 * linear[0] + 0.3575761 * linear[1] + 0.1804375 * linear[2];
    let y = 0.2126729 * linear[0] + 0.7151522 * linear[1] + 0.0721750 * linear[2];
    let z = 0.0193339 * linear[0] + 0.119_192 * linear[1] + 0.9503041 * linear[2];
    // D65 white point.
    let (xn, yn, zn) = (0.95047, 1.0, 1.08883);
    let f = |t: f32| {
        if t > 216.0 / 24389.0 {
            t.cbrt()
        } else {
            t * (24389.0 / 27.0) / 116.0 + 16.0 / 116.0
        }
    };
    let fx = f(x / xn);
    let fy = f(y / yn);
    let fz = f(z / zn);
    [
        116.0 * fy - 16.0,
        500.0 * (fx - fy),
        200.0 * (fy - fz),
    ]
}

/// CIEDE2000 color difference (Sharma, Wu & Dalal 2005, kL = kC = kH = 1).
pub fn delta_e_2000(lab1: [f32; 3], lab2: [f32; 3]) -> f32 {
    let (l1, a1, b1) = (lab1[0], lab1[1], lab1[2]);
    let (l2, a2, b2) = (lab2[0], lab2[1], lab2[2]);

    let c1 = a1.hypot(b1);
    let c2 = a2.hypot(b2);
    let c_bar = (c1 + c2) * 0.5;
    let c_bar7 = c_bar.powi(7);
    let g = 0.5 * (1.0 - (c_bar7 / (c_bar7 + 25.0f32.powi(7))).sqrt());

    let a1p = (1.0 + g) * a1;
    let a2p = (1.0 + g) * a2;

    let c1p = a1p.hypot(b1);
    let c2p = a2p.hypot(b2);
    let h1p = b1.atan2(a1p).to_degrees().rem_euclid(360.0);
    let h2p = b2.atan2(a2p).to_degrees().rem_euclid(360.0);

    let delta_lp = l2 - l1;
    let delta_cp = c2p - c1p;

    let delta_hp = if c1p * c2p == 0.0 {
        0.0
    } else if (h2p - h1p).abs() <= 180.0 {
        h2p - h1p
    } else if h2p - h1p > 180.0 {
        h2p - h1p - 360.0
    } else {
        h2p - h1p + 360.0
    };
    let delta_hp = 2.0 * (c1p * c2p).sqrt() * (delta_hp.to_radians() * 0.5).sin();

    let l_bar_p = (l1 + l2) * 0.5;
    let c_bar_p = (c1p + c2p) * 0.5;

    let h_bar_p = if c1p * c2p == 0.0 {
        h1p + h2p
    } else if (h1p - h2p).abs() <= 180.0 {
        (h1p + h2p) * 0.5
    } else if h1p + h2p < 360.0 {
        (h1p + h2p + 360.0) * 0.5
    } else {
        (h1p + h2p - 360.0) * 0.5
    };

    let t = 1.0 - 0.17 * (h_bar_p - 30.0).to_radians().cos()
        + 0.24 * (2.0 * h_bar_p).to_radians().cos()
        + 0.32 * (3.0 * h_bar_p + 6.0).to_radians().cos()
        - 0.20 * (4.0 * h_bar_p - 63.0).to_radians().cos();

    let delta_theta = 30.0 * (-(((h_bar_p - 275.0) / 25.0).powi(2))).exp();
    let c_bar_p7 = c_bar_p.powi(7);
    let r_c = 2.0 * (c_bar_p7 / (c_bar_p7 + 25.0f32.powi(7))).sqrt();
    let s_l = 1.0 + (0.015 * (l_bar_p - 50.0).powi(2)) / (20.0 + (l_bar_p - 50.0).powi(2)).sqrt();
    let s_c = 1.0 + 0.045 * c_bar_p;
    let s_h = 1.0 + 0.015 * c_bar_p * t;
    let r_t = -(2.0 * delta_theta.to_radians()).sin() * r_c;

    let term_l = delta_lp / s_l;
    let term_c = delta_cp / s_c;
    let term_h = delta_hp / s_h;
    (term_l.powi(2) + term_c.powi(2) + term_h.powi(2) + r_t * term_c * term_h)
        .max(0.0)
        .sqrt()
}

/// Full comparison report between two images of identical dimensions.
///
/// `stride` samples every Nth pixel in each axis (1 = every pixel) to bound
/// the runtime on large exports.
#[derive(Debug, Clone, PartialEq)]
pub struct ImageComparison {
    pub pixels_compared: usize,
    pub mean_delta_e: f64,
    pub p95_delta_e: f64,
    pub p99_delta_e: f64,
    pub max_delta_e: f64,
    pub psnr: f64,
    pub ssim: f64,
}

impl ImageComparison {
    /// True when both images are bit-identical after decoding.
    pub fn is_identical(&self) -> bool {
        self.psnr.is_infinite() && self.ssim == 1.0
    }
}

/// Compare two same-sized RGB images. Returns `None` on dimension mismatch.
///
/// PSNR uses the 16-bit peak (65535); SSIM runs on 8-bit luminance with 8x8
/// uniform windows (Wang et al. 2004), the standard banding/artifact detector.
pub fn compare_rgb16(a: &Rgb16Image, b: &Rgb16Image) -> Option<ImageComparison> {
    compare_rgb16_strided(a, b, 1)
}

pub fn compare_rgb16_strided(
    a: &Rgb16Image,
    b: &Rgb16Image,
    stride: u32,
) -> Option<ImageComparison> {
    let (w, h) = a.dimensions();
    if b.dimensions() != (w, h) {
        return None;
    }
    let stride = stride.max(1);

    let mut sum_sq_err: f64 = 0.0;
    let mut count: u64 = 0;
    let mut deltas: Vec<f32> = Vec::new();
    for y in (0..h).step_by(stride as usize) {
        for x in (0..w).step_by(stride as usize) {
            let pa = a.get_pixel(x, y).0;
            let pb = b.get_pixel(x, y).0;
            for c in 0..3 {
                let d = pa[c] as f64 - pb[c] as f64;
                sum_sq_err += d * d;
            }
            let lab_a = srgb_to_lab(pa.map(|v| v as f32 / 65535.0));
            let lab_b = srgb_to_lab(pb.map(|v| v as f32 / 65535.0));
            deltas.push(delta_e_2000(lab_a, lab_b));
            count += 1;
        }
    }
    if count == 0 {
        return Some(ImageComparison {
            pixels_compared: 0,
            mean_delta_e: 0.0,
            p95_delta_e: 0.0,
            p99_delta_e: 0.0,
            max_delta_e: 0.0,
            psnr: f64::INFINITY,
            ssim: 1.0,
        });
    }

    let mse = sum_sq_err / (count as f64 * 3.0);
    let psnr = if mse == 0.0 {
        f64::INFINITY
    } else {
        10.0 * ((65535.0f64 * 65535.0) / mse).log10()
    };

    deltas.sort_by(|x, y| x.partial_cmp(y).unwrap_or(std::cmp::Ordering::Equal));
    let percentile = |p: f64| -> f64 {
        let idx = ((deltas.len() - 1) as f64 * p).round() as usize;
        deltas[idx.min(deltas.len() - 1)] as f64
    };
    let mean_delta_e = deltas.iter().map(|d| *d as f64).sum::<f64>() / deltas.len() as f64;

    let ssim = ssim_gray_u8(&to_luma_u8(a), &to_luma_u8(b));

    Some(ImageComparison {
        pixels_compared: count as usize,
        mean_delta_e,
        p95_delta_e: percentile(0.95),
        p99_delta_e: percentile(0.99),
        max_delta_e: *deltas.last().unwrap() as f64,
        psnr,
        ssim,
    })
}

/// Convenience wrapper: decode any two image files and compare them as 16-bit
/// RGB (8-bit inputs are scaled by 257 so both sides share one scale).
pub fn compare_files(
    reference: &std::path::Path,
    candidate: &std::path::Path,
    stride: u32,
) -> Result<ImageComparison, String> {
    let a = load_rgb16(reference)?;
    let b = load_rgb16(candidate)?;
    compare_rgb16_strided(&a, &b, stride).ok_or_else(|| {
        format!(
            "Dimension mismatch: {} ({:?}) vs {} ({:?})",
            reference.display(),
            a.dimensions(),
            candidate.display(),
            b.dimensions()
        )
    })
}

pub fn load_rgb16(path: &std::path::Path) -> Result<Rgb16Image, String> {
    let img = image::open(path).map_err(|e| format!("Failed to decode {}: {}", path.display(), e))?;
    Ok(img.to_rgb16())
}

/// Compare two decoded images of arbitrary bit depth.
pub fn compare_dynamic(
    a: &DynamicImage,
    b: &DynamicImage,
    stride: u32,
) -> Option<ImageComparison> {
    compare_rgb16_strided(&a.to_rgb16(), &b.to_rgb16(), stride)
}

fn to_luma_u8(img: &Rgb16Image) -> image::GrayImage {
    let (w, h) = img.dimensions();
    let mut out = image::GrayImage::new(w, h);
    for y in 0..h {
        for x in 0..w {
            let p = img.get_pixel(x, y).0;
            // Rec. 601 luma on the 8-bit scale (matches display rendering).
            let luma = (0.299 * p[0] as f32 + 0.587 * p[1] as f32 + 0.114 * p[2] as f32) / 257.0;
            out.put_pixel(x, y, image::Luma([luma.round().clamp(0.0, 255.0) as u8]));
        }
    }
    out
}

/// Mean SSIM over 8x8 uniform windows, stride 8, on 8-bit grayscale.
fn ssim_gray_u8(a: &image::GrayImage, b: &image::GrayImage) -> f64 {
    let (w, h) = a.dimensions();
    if b.dimensions() != (w, h) || w < 8 || h < 8 {
        return if a == b { 1.0 } else { 0.0 };
    }
    let c1 = (0.01 * 255.0f64).powi(2);
    let c2 = (0.03 * 255.0f64).powi(2);
    let mut total = 0.0;
    let mut windows = 0u64;
    for wy in (0..h - 7).step_by(8) {
        for wx in (0..w - 7).step_by(8) {
            let mut sa = 0.0;
            let mut sb = 0.0;
            let mut saa = 0.0;
            let mut sbb = 0.0;
            let mut sab = 0.0;
            for dy in 0..8 {
                for dx in 0..8 {
                    let va = a.get_pixel(wx + dx, wy + dy).0[0] as f64;
                    let vb = b.get_pixel(wx + dx, wy + dy).0[0] as f64;
                    sa += va;
                    sb += vb;
                    saa += va * va;
                    sbb += vb * vb;
                    sab += va * vb;
                }
            }
            let n = 64.0;
            let ma = sa / n;
            let mb = sb / n;
            let va = saa / n - ma * ma;
            let vb = sbb / n - mb * mb;
            let cov = sab / n - ma * mb;
            let ssim = ((2.0 * ma * mb + c1) * (2.0 * cov + c2))
                / ((ma * ma + mb * mb + c1) * (va + vb + c2));
            total += ssim;
            windows += 1;
        }
    }
    if windows == 0 { 1.0 } else { total / windows as f64 }
}

#[cfg(test)]
mod tests {
    use super::*;

    // Reference pairs from Sharma et al. (2005), "The CIEDE2000 Color-Difference
    // Formula", Table 1 (expected ΔE00 rounded to 4 decimals).
    const SHARMA_PAIRS: [([f32; 3], [f32; 3], f64); 6] = [
        ([50.0, 2.6772, -79.7751], [50.0, 0.0, -82.7485], 2.0425),
        ([50.0, 3.1571, -77.2803], [50.0, 0.0, -82.7485], 2.8615),
        ([50.0, 2.8361, -74.0200], [50.0, 0.0, -82.7485], 3.4412),
        ([50.0, -1.3802, -84.2814], [50.0, 0.0, -82.7485], 1.0000),
        ([50.0, -1.1848, -84.8006], [50.0, 0.0, -82.7485], 1.0000),
        ([50.0, -0.9009, -85.5211], [50.0, 0.0, -82.7485], 1.0000),
    ];

    #[test]
    fn delta_e_2000_matches_sharma_reference_pairs() {
        for (lab1, lab2, expected) in SHARMA_PAIRS {
            let got = delta_e_2000(lab1, lab2) as f64;
            assert!(
                (got - expected).abs() < 5e-4,
                "ΔE00({lab1:?}, {lab2:?}) = {got}, expected {expected}"
            );
        }
    }

    #[test]
    fn delta_e_2000_identical_colors_is_zero() {
        let lab = srgb_to_lab([0.3, 0.6, 0.9]);
        assert!(delta_e_2000(lab, lab).abs() < 1e-6);
    }

    #[test]
    fn srgb_to_lab_known_values() {
        // sRGB white and mid gray.
        let white = srgb_to_lab([1.0, 1.0, 1.0]);
        assert!((white[0] - 100.0).abs() < 0.01, "L* = {}", white[0]);
        assert!(white[1].abs() < 0.01 && white[2].abs() < 0.01);
        let mid = srgb_to_lab([128.0 / 255.0, 128.0 / 255.0, 128.0 / 255.0]);
        // sRGB #808080 (128/255) has L* ≈ 53.59; exactly 0.5 encodes to 53.38.
        assert!((mid[0] - 53.585).abs() < 0.05, "L* = {}", mid[0]);
        let red = srgb_to_lab([1.0, 0.0, 0.0]);
        // sRGB red has L* ≈ 53.24, a* ≈ 80.09, b* ≈ 67.20.
        assert!((red[0] - 53.24).abs() < 0.05, "L* = {}", red[0]);
        assert!((red[1] - 80.09).abs() < 0.05, "a* = {}", red[1]);
        assert!((red[2] - 67.20).abs() < 0.05, "b* = {}", red[2]);
    }

    #[test]
    fn psnr_infinite_and_ssim_one_for_identical_images() {
        let img = Rgb16Image::from_fn(64, 64, |x, y| {
            image::Rgb([
                ((x * 257) % 65536) as u16,
                ((y * 257) % 65536) as u16,
                32768,
            ])
        });
        let cmp = compare_rgb16(&img, &img).unwrap();
        assert!(cmp.psnr.is_infinite());
        assert_eq!(cmp.ssim, 1.0);
        assert!(cmp.is_identical());
        assert_eq!(cmp.pixels_compared, 64 * 64);
    }

    #[test]
    fn one_off_by_one_code_value_is_below_one_delta_e() {
        let base = Rgb16Image::from_pixel(32, 32, image::Rgb([32768, 32768, 32768]));
        let mut shifted = base.clone();
        for p in shifted.pixels_mut() {
            p.0[0] += 1;
        }
        let cmp = compare_rgb16(&base, &shifted).unwrap();
        assert!(cmp.max_delta_e < 0.01, "max ΔE = {}", cmp.max_delta_e);
        assert!(!cmp.is_identical());
    }

    #[test]
    fn dimension_mismatch_returns_none() {
        let a = Rgb16Image::new(8, 8);
        let b = Rgb16Image::new(9, 8);
        assert!(compare_rgb16(&a, &b).is_none());
    }
}
