//! Objective image-quality metrics for the M0 test foundation (plan §6,
//! M0-2 "客观指标测试" and M0-3 "一致性测试").
//!
//! Pure-CPU implementations with no panics on well-formed input. Color math
//! runs in `f64`; pixel metrics accept interleaved RGB `f32` samples in
//! `[0.0, 1.0]` (the normalization used by `DynamicImage::to_rgba32f` after
//! division by 255). Determinism notes:
//!
//! - Hash functions ([`hash_bytes`], [`hash_f32_image`], [`hash_u8_image`])
//!   are bit-exact and safe as golden references because the CPU pipeline
//!   they hash only uses IEEE-754-exact operations (see `harness`).
//! - PSNR/SSIM/CIEDE2000 go through `log10`/`exp`/`sin` from libm, whose last
//!   ulp may differ between platforms; they are therefore only used with
//!   tolerance thresholds, never with byte-exact expectations (plan M0-5).

use blake3::Hasher;

/// Rec.709 luma coefficients (same primaries as the shader's `LUMA_COEFF`).
const LUMA_R: f32 = 0.2126;
const LUMA_G: f32 = 0.7152;
const LUMA_B: f32 = 0.0722;

// ---------------------------------------------------------------------------
// Simple sample metrics
// ---------------------------------------------------------------------------

/// Worst-case absolute per-sample difference between two interleaved buffers.
///
/// # Panics
/// Panics when the buffers have different lengths.
pub fn max_delta(a: &[f32], b: &[f32]) -> f32 {
    assert_eq!(a.len(), b.len(), "max_delta: sample count mismatch");
    a.iter()
        .zip(b.iter())
        .map(|(x, y)| (x - y).abs())
        .fold(0.0_f32, f32::max)
}

/// Mean squared error between two interleaved buffers.
pub fn mse(a: &[f32], b: &[f32]) -> f64 {
    assert_eq!(a.len(), b.len(), "mse: sample count mismatch");
    let sum: f64 = a
        .iter()
        .zip(b.iter())
        .map(|(x, y)| {
            let d = (*x - *y) as f64;
            d * d
        })
        .sum();
    sum / a.len().max(1) as f64
}

/// PSNR in dB for normalized samples with a peak value of 1.0.
///
/// Returns [`f64::INFINITY`] for bit-identical buffers.
pub fn psnr(a: &[f32], b: &[f32]) -> f64 {
    let m = mse(a, b);
    if m == 0.0 {
        return f64::INFINITY;
    }
    10.0 * (1.0_f64 / m).log10()
}

/// PSNR in dB for 8-bit sample buffers (peak value 255).
pub fn psnr_u8(a: &[u8], b: &[u8]) -> f64 {
    assert_eq!(a.len(), b.len(), "psnr_u8: sample count mismatch");
    let sum: f64 = a
        .iter()
        .zip(b.iter())
        .map(|(x, y)| {
            let d = (*x as f64 - *y as f64).abs();
            d * d
        })
        .sum();
    let m = sum / a.len().max(1) as f64;
    if m == 0.0 {
        return f64::INFINITY;
    }
    10.0 * (255.0_f64 * 255.0 / m).log10()
}

// ---------------------------------------------------------------------------
// SSIM (Wang et al. 2004)
// ---------------------------------------------------------------------------

/// Rec.709 luma plane of an interleaved RGB buffer.
pub fn luma_plane(rgb: &[f32], width: usize, height: usize) -> Vec<f32> {
    assert_eq!(rgb.len(), width * height * 3, "luma_plane: size mismatch");
    rgb.chunks_exact(3)
        .map(|px| LUMA_R * px[0] + LUMA_G * px[1] + LUMA_B * px[2])
        .collect()
}

fn gaussian_kernel_1d(sigma: f64, radius: usize) -> Vec<f64> {
    let mut kernel = Vec::with_capacity(2 * radius + 1);
    let denom = 2.0 * sigma * sigma;
    for i in 0..=(2 * radius) {
        let x = i as f64 - radius as f64;
        kernel.push((-x * x / denom).exp());
    }
    let sum: f64 = kernel.iter().sum();
    kernel.iter().map(|k| k / sum).collect()
}

/// Separable Gaussian filter with clamped (replicated) borders.
fn gaussian_filter(plane: &[f64], width: usize, height: usize, kernel: &[f64]) -> Vec<f64> {
    let radius = kernel.len() / 2;
    let mut tmp = vec![0.0_f64; plane.len()];
    let mut out = vec![0.0_f64; plane.len()];

    // Horizontal pass.
    for y in 0..height {
        for x in 0..width {
            let mut acc = 0.0;
            for (k, &w) in kernel.iter().enumerate() {
                let sx = (x + k).saturating_sub(radius).min(width - 1);
                acc += w * plane[y * width + sx];
            }
            tmp[y * width + x] = acc;
        }
    }
    // Vertical pass.
    for y in 0..height {
        for x in 0..width {
            let mut acc = 0.0;
            for (k, &w) in kernel.iter().enumerate() {
                let sy = (y + k).saturating_sub(radius).min(height - 1);
                acc += w * tmp[sy * width + x];
            }
            out[y * width + x] = acc;
        }
    }
    out
}

/// Mean SSIM between two luma planes (Wang et al. 2004: 11x11 Gaussian
/// window, sigma 1.5, dynamic range L = 1.0). Inputs must be equal-length
/// planes of `width * height` samples.
pub fn ssim_plane(a: &[f32], b: &[f32], width: usize, height: usize) -> f64 {
    assert_eq!(a.len(), b.len(), "ssim_plane: plane length mismatch");
    assert_eq!(a.len(), width * height, "ssim_plane: plane size mismatch");

    let sigma = 1.5_f64;
    let radius = 5_usize; // 11x11 window
    let kernel = gaussian_kernel_1d(sigma, radius);
    let c1 = (0.01_f64).powi(2);
    let c2 = (0.03_f64).powi(2);

    let x: Vec<f64> = a.iter().map(|v| *v as f64).collect();
    let y: Vec<f64> = b.iter().map(|v| *v as f64).collect();
    let mu_x = gaussian_filter(&x, width, height, &kernel);
    let mu_y = gaussian_filter(&y, width, height, &kernel);

    let xx: Vec<f64> = x.iter().map(|v| v * v).collect();
    let yy: Vec<f64> = y.iter().map(|v| v * v).collect();
    let xy: Vec<f64> = x.iter().zip(y.iter()).map(|(u, v)| u * v).collect();

    let mu_xx = gaussian_filter(&xx, width, height, &kernel);
    let mu_yy = gaussian_filter(&yy, width, height, &kernel);
    let mu_xy = gaussian_filter(&xy, width, height, &kernel);

    let mut total = 0.0_f64;
    for i in 0..x.len() {
        let mx = mu_x[i];
        let my = mu_y[i];
        let vx = (mu_xx[i] - mx * mx).max(0.0);
        let vy = (mu_yy[i] - my * my).max(0.0);
        let vxy = mu_xy[i] - mx * my;
        let num = (2.0 * mx * my + c1) * (2.0 * vxy + c2);
        let den = (mx * mx + my * my + c1) * (vx + vy + c2);
        total += num / den;
    }
    total / x.len().max(1) as f64
}

/// Mean SSIM between two interleaved RGB buffers, computed on the Rec.709
/// luma plane.
pub fn ssim(rgb_a: &[f32], rgb_b: &[f32], width: usize, height: usize) -> f64 {
    let la = luma_plane(rgb_a, width, height);
    let lb = luma_plane(rgb_b, width, height);
    ssim_plane(&la, &lb, width, height)
}

// ---------------------------------------------------------------------------
// Color difference (CIEDE2000)
// ---------------------------------------------------------------------------

/// sRGB (D65) to CIELAB conversion for one normalized RGB triple.
pub fn srgb_to_lab(rgb: [f32; 3]) -> [f64; 3] {
    // sRGB EOTF (decode), D65 reference white.
    let lin: Vec<f64> = rgb
        .iter()
        .map(|c| {
            let c = (*c as f64).clamp(0.0, 1.0);
            if c <= 0.04045 {
                c / 12.92
            } else {
                ((c + 0.055) / 1.055).powf(2.4)
            }
        })
        .collect();

    let x = 0.4124564 * lin[0] + 0.3575761 * lin[1] + 0.1804375 * lin[2];
    let y = 0.2126729 * lin[0] + 0.7151522 * lin[1] + 0.0721750 * lin[2];
    let z = 0.0193339 * lin[0] + 0.1191920 * lin[1] + 0.9503041 * lin[2];

    // D65 white point.
    const XN: f64 = 0.95047;
    const YN: f64 = 1.0;
    const ZN: f64 = 1.08883;
    let fx = lab_f(x / XN);
    let fy = lab_f(y / YN);
    let fz = lab_f(z / ZN);

    [116.0 * fy - 16.0, 500.0 * (fx - fy), 200.0 * (fy - fz)]
}

fn lab_f(t: f64) -> f64 {
    const DELTA: f64 = 6.0 / 29.0;
    if t > DELTA * DELTA * DELTA {
        t.cbrt()
    } else {
        t / (3.0 * DELTA * DELTA) + 4.0 / 29.0
    }
}

/// CIEDE2000 color difference between two CIELAB colors (Sharma et al. 2005
/// formulation, including the hue-mean edge cases).
pub fn delta_e_2000(lab1: [f64; 3], lab2: [f64; 3]) -> f64 {
    let (l1, a1, b1) = (lab1[0], lab1[1], lab1[2]);
    let (l2, a2, b2) = (lab2[0], lab2[1], lab2[2]);

    // 25^7, exact in f64 (used twice below).
    const POW25_7: f64 = 6_103_515_625.0;

    let c1 = (a1 * a1 + b1 * b1).sqrt();
    let c2 = (a2 * a2 + b2 * b2).sqrt();
    let c_bar = (c1 + c2) / 2.0;
    let c_bar7 = c_bar.powi(7);
    let g = 0.5 * (1.0 - (c_bar7 / (c_bar7 + POW25_7)).sqrt());

    let a1p = (1.0 + g) * a1;
    let a2p = (1.0 + g) * a2;
    let c1p = (a1p * a1p + b1 * b1).sqrt();
    let c2p = (a2p * a2p + b2 * b2).sqrt();

    let h1p = if c1p == 0.0 { 0.0 } else { hue_angle(b1, a1p) };
    let h2p = if c2p == 0.0 { 0.0 } else { hue_angle(b2, a2p) };

    let d_l = l2 - l1;
    let d_c = c2p - c1p;
    let d_h = if c1p * c2p == 0.0 {
        0.0
    } else if (h2p - h1p).abs() <= 180.0 {
        h2p - h1p
    } else if h2p - h1p > 180.0 {
        h2p - h1p - 360.0
    } else {
        h2p - h1p + 360.0
    };
    let d_big_h = 2.0 * (c1p * c2p).sqrt() * (radians(d_h) / 2.0).sin();

    let l_bar = (l1 + l2) / 2.0;
    let c_bar_p = (c1p + c2p) / 2.0;

    let h_bar = if c1p * c2p == 0.0 {
        h1p + h2p
    } else if (h1p - h2p).abs() <= 180.0 {
        (h1p + h2p) / 2.0
    } else if h1p + h2p < 360.0 {
        (h1p + h2p + 360.0) / 2.0
    } else {
        (h1p + h2p - 360.0) / 2.0
    };

    let rad_1 = radians(h_bar - 30.0);
    let rad_2 = radians(2.0 * h_bar);
    let rad_3 = radians(3.0 * h_bar + 6.0);
    let rad_4 = radians(4.0 * h_bar - 63.0);
    let t = 1.0 - 0.17 * rad_1.cos() + 0.24 * rad_2.cos() + 0.32 * rad_3.cos() - 0.20 * rad_4.cos();
    let hue_offset = (h_bar - 275.0) / 25.0;
    let d_theta = 30.0 * (-(hue_offset * hue_offset)).exp();
    let c_bar_p7 = c_bar_p.powi(7);
    let r_c = 2.0 * (c_bar_p7 / (c_bar_p7 + POW25_7)).sqrt();
    let l_sq = (l_bar - 50.0) * (l_bar - 50.0);
    let s_l = 1.0 + 0.015 * l_sq / (20.0 + l_sq).sqrt();
    let s_c = 1.0 + 0.045 * c_bar_p;
    let s_h = 1.0 + 0.015 * c_bar_p * t;
    let r_t = -(radians(2.0 * d_theta)).sin() * r_c;

    let term_l = d_l / s_l;
    let term_c = d_c / s_c;
    let term_h = d_big_h / s_h;
    (term_l * term_l + term_c * term_c + term_h * term_h + r_t * term_c * term_h).sqrt()
}

/// Hue angle in degrees in `[0, 360)`.
fn hue_angle(b: f64, ap: f64) -> f64 {
    let h = b.atan2(ap).to_degrees();
    if h < 0.0 { h + 360.0 } else { h }
}

fn radians(deg: f64) -> f64 {
    deg * std::f64::consts::PI / 180.0
}

/// Mean CIEDE2000 between two interleaved RGB buffers, sampled on a grid with
/// the given step in both axes (step 1 = every pixel).
pub fn mean_delta_e_2000(
    rgb_a: &[f32],
    rgb_b: &[f32],
    width: usize,
    height: usize,
    step: usize,
) -> f64 {
    assert_eq!(rgb_a.len(), rgb_b.len(), "mean_delta_e_2000: size mismatch");
    assert_eq!(rgb_a.len(), width * height * 3);
    let step = step.max(1);
    let mut total = 0.0_f64;
    let mut count = 0_usize;
    for y in (0..height).step_by(step) {
        for x in (0..width).step_by(step) {
            let i = (y * width + x) * 3;
            let la = srgb_to_lab([rgb_a[i], rgb_a[i + 1], rgb_a[i + 2]]);
            let lb = srgb_to_lab([rgb_b[i], rgb_b[i + 1], rgb_b[i + 2]]);
            total += delta_e_2000(la, lb);
            count += 1;
        }
    }
    if count == 0 {
        0.0
    } else {
        total / count as f64
    }
}

// ---------------------------------------------------------------------------
// Sharpness proxies
// ---------------------------------------------------------------------------

/// Sum of squared central-difference gradient magnitudes over a luma plane
/// (interior pixels only). A sharpness/texture-energy proxy used by the R2
/// acceptance metrics and the M0-3 high-frequency energy comparison.
pub fn gradient_energy(plane: &[f32], width: usize, height: usize) -> f64 {
    assert_eq!(
        plane.len(),
        width * height,
        "gradient_energy: size mismatch"
    );
    let mut total = 0.0_f64;
    if width < 3 || height < 3 {
        return 0.0;
    }
    for y in 1..height - 1 {
        for x in 1..width - 1 {
            let i = y * width + x;
            let gx = plane[i + 1] - plane[i - 1];
            let gy = plane[i + width] - plane[i - width];
            let g = (gx * gx + gy * gy) as f64;
            total += g;
        }
    }
    total
}

/// Ratio of gradient energies between two same-size images (M0-3
/// "高频能量比"). Guarded against division by zero.
pub fn high_frequency_energy_ratio(a: &[f32], b: &[f32], width: usize, height: usize) -> f64 {
    let ea = gradient_energy(a, width, height);
    let eb = gradient_energy(b, width, height);
    if eb <= f64::EPSILON {
        return if ea <= f64::EPSILON {
            1.0
        } else {
            f64::INFINITY
        };
    }
    ea / eb
}

/// Interleaved-RGB variant of [`high_frequency_energy_ratio`]: both buffers
/// are reduced to Rec.709 luma planes first, matching [`ssim`]'s input
/// convention.
pub fn high_frequency_energy_ratio_rgb(a: &[f32], b: &[f32], width: usize, height: usize) -> f64 {
    high_frequency_energy_ratio(
        &luma_plane(a, width, height),
        &luma_plane(b, width, height),
        width,
        height,
    )
}

// ---------------------------------------------------------------------------
// Deterministic content hashes (blake3)
// ---------------------------------------------------------------------------

/// blake3 hex digest of raw bytes.
pub fn hash_bytes(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

fn hash_samples(width: u32, height: u32, raw: &[u8]) -> String {
    let mut hasher = Hasher::new();
    hasher.update(&width.to_le_bytes());
    hasher.update(&height.to_le_bytes());
    hasher.update(raw);
    hasher.finalize().to_hex().to_string()
}

/// Bit-exact blake3 digest of an interleaved f32 image (dimensions mixed in).
/// Endianness: little-endian bit patterns (all supported targets).
pub fn hash_f32_image(width: u32, height: u32, samples: &[f32]) -> String {
    let mut bytes = Vec::with_capacity(samples.len() * 4);
    for s in samples {
        bytes.extend_from_slice(&s.to_bits().to_le_bytes());
    }
    hash_samples(width, height, &bytes)
}

/// blake3 digest of an 8-bit image buffer (dimensions mixed in).
pub fn hash_u8_image(width: u32, height: u32, samples: &[u8]) -> String {
    hash_samples(width, height, samples)
}
