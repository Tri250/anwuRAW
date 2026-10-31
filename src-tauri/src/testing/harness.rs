//! Deterministic pure-CPU reference pipeline for the M0 golden/consistency
//! tests (plan §6, M0-1 "Golden 渲染回归" and M0-3 "一致性测试").
//!
//! Everything in this module is built to be **cross-platform bit-stable** so
//! that blake3 hashes of its outputs can serve as golden references:
//!
//! - Pixel arithmetic only uses IEEE-754-exact operations (`+ - * /`,
//!   `sqrt`, `min`/`max`, `floor`/`ceil`/`round`, `abs`, `clamp`). No
//!   `powf`/`exp`/`sin` on the hashed path. (`sin`/`exp` appear only in
//!   Lanczos/Gaussian *weights*, in `f64`, where a possible 1-ulp libm
//!   difference is ~8 orders of magnitude below the f32 rounding margin.)
//! - Noise comes from a local LCG ([`Lcg`]), not the `rand` crate, so scene
//!   generation does not depend on RNG crate behavior.
//! - Quantization to 8-bit uses `(v * 255 + 0.5).floor()`.
//!
//! The pipeline mirrors a subset of the main WGSL pass stage order
//! (exposure → white-balance gains → saturation → contrast → curve → USM →
//! grain) and re-implements two GPU algorithms as reference oracles for
//! future M1/M2/R5 work:
//!
//! - [`eval_curve`]: cubic-Hermite tone-curve interpolation, a faithful port
//!   of `apply_curve`/`interpolate_cubic_hermite` in `shaders/shader.wgsl`.
//! - [`TetrahedralLut::interpolate`]: tetrahedral 3D-LUT interpolation, a
//!   faithful port of `sample_lut_tetrahedral` in `shaders/shader.wgsl`.
//!
//! `wgpu`/GPU paths cannot run headless in CI; these references give the
//! golden suite something stable to pin while remaining cheap to evaluate.

use image::{DynamicImage, GenericImageView, ImageBuffer, Rgb};

/// Width × height × interleaved RGB samples in `[0.0, 1.0]`.
#[derive(Debug, Clone)]
pub struct FloatImage {
    pub width: u32,
    pub height: u32,
    pub data: Vec<f32>,
}

impl FloatImage {
    /// Decode any `DynamicImage` through 8-bit RGB into normalized samples.
    pub fn from_dynamic(img: &DynamicImage) -> Self {
        let (width, height) = img.dimensions();
        let raw = img.to_rgb8().into_raw();
        let data = raw.iter().map(|v| *v as f32 / 255.0).collect();
        FloatImage {
            width,
            height,
            data,
        }
    }

    /// Quantize to 8-bit samples (round-half-up, clamped).
    pub fn to_rgb8_samples(&self) -> Vec<u8> {
        self.data
            .iter()
            .map(|v| (v.clamp(0.0, 1.0) * 255.0 + 0.5).floor() as u8)
            .collect()
    }

    /// Re-encode as an 8-bit `DynamicImage`.
    pub fn to_dynamic(&self) -> DynamicImage {
        let bytes = self.to_rgb8_samples();
        let width = self.width;
        let buf = ImageBuffer::from_fn(self.width, self.height, |x, y| {
            let i = ((y * width + x) * 3) as usize;
            Rgb([bytes[i], bytes[i + 1], bytes[i + 2]])
        });
        DynamicImage::ImageRgb8(buf)
    }

    /// Extract one channel as a single-plane buffer.
    pub fn plane(&self, channel: usize) -> Vec<f32> {
        self.data.iter().skip(channel).step_by(3).copied().collect()
    }

    /// Reassemble from three single-plane buffers.
    pub fn from_planes(r: &[f32], g: &[f32], b: &[f32], width: u32, height: u32) -> Self {
        let len = (width * height) as usize;
        assert_eq!(r.len(), len, "from_planes: plane length mismatch");
        let mut data = Vec::with_capacity(len * 3);
        for i in 0..len {
            data.push(r[i]);
            data.push(g[i]);
            data.push(b[i]);
        }
        FloatImage {
            width,
            height,
            data,
        }
    }
}

// ---------------------------------------------------------------------------
// Deterministic PRNG (LCG, Knuth MMIX constants)
// ---------------------------------------------------------------------------

/// Small deterministic PRNG so synthetic scenes and grain do not depend on
/// the `rand` crate or on system entropy.
#[derive(Debug, Clone)]
pub struct Lcg {
    state: u64,
}

impl Lcg {
    pub fn new(seed: u64) -> Self {
        Lcg {
            state: seed.wrapping_mul(0x9E3779B97F4A7C15) | 1,
        }
    }

    fn next_u32(&mut self) -> u32 {
        self.state = self
            .state
            .wrapping_mul(6364136223846793005)
            .wrapping_add(1442695040888963407);
        (self.state >> 32) as u32
    }

    /// Uniform sample in `[0, 1)` with 24-bit resolution.
    pub fn next_f32(&mut self) -> f32 {
        (self.next_u32() >> 8) as f32 / 16_777_216.0
    }

    /// Uniform sample in `[0, 1)` with 53-bit resolution.
    pub fn next_f64(&mut self) -> f64 {
        ((self.next_u32() as f64 * 4_294_967_296.0) + self.next_u32() as f64)
            / 18_446_744_073_709_551_616.0
    }
}

// ---------------------------------------------------------------------------
// Synthetic scenes (plan M0-1: the six fixed test image classes)
// ---------------------------------------------------------------------------

/// Approximate sRGB values of the 24-patch X-Rite ColorChecker.
const COLOR_CARD_PATCHES: [[u8; 3]; 24] = [
    [115, 82, 68],
    [194, 150, 130],
    [98, 122, 155],
    [87, 108, 67],
    [133, 128, 177],
    [103, 189, 170],
    [214, 126, 44],
    [80, 91, 166],
    [193, 128, 127],
    [94, 73, 52],
    [157, 188, 64],
    [224, 163, 46],
    [56, 61, 150],
    [70, 148, 73],
    [175, 54, 60],
    [231, 199, 31],
    [187, 86, 149],
    [8, 133, 161],
    [243, 243, 242],
    [200, 200, 200],
    [160, 160, 160],
    [122, 122, 121],
    [85, 85, 85],
    [52, 52, 52],
];

/// 24-patch color card on a mid-gray field ("色卡").
pub fn scene_color_card(width: u32, height: u32) -> DynamicImage {
    let cols = 6_u32;
    let rows = 4_u32;
    let buf = ImageBuffer::from_fn(width, height, |x, y| {
        let col = (x * cols) / width;
        let row = (y * rows) / height;
        let idx = (row * cols + col) as usize % COLOR_CARD_PATCHES.len();
        let p = COLOR_CARD_PATCHES[idx];
        Rgb(p)
    });
    DynamicImage::ImageRgb8(buf)
}

/// 14-level grayscale ramp ("14 级灰阶"), vertical bands left to right.
pub fn scene_gray_ramp(width: u32, height: u32) -> DynamicImage {
    let levels = 14_u32;
    let buf = ImageBuffer::from_fn(width, height, |x, _| {
        let step = (x * levels) / width;
        let v = (step * 255) / (levels - 1);
        Rgb([v as u8, v as u8, v as u8])
    });
    DynamicImage::ImageRgb8(buf)
}

/// High-contrast slanted edge plus a bright square on dark ground
/// ("高反差边缘") — the classic slanted-edge stimulus for MTF-style checks.
pub fn scene_high_contrast_edge(width: u32, height: u32) -> DynamicImage {
    let slope = 0.25_f32;
    let buf = ImageBuffer::from_fn(width, height, |x, y| {
        let xf = x as f32;
        let yf = y as f32;
        let edge_x = 0.35 * width as f32 + slope * yf;
        let v: f32 = if xf < edge_x { 0.06 } else { 0.94 };
        let in_square = xf > 0.7 * width as f32
            && xf < 0.9 * width as f32
            && yf > 0.15 * height as f32
            && yf < 0.55 * height as f32;
        let v = if in_square { 1.0 } else { v };
        let c = (v * 255.0 + 0.5).floor() as u8;
        Rgb([c, c, c])
    });
    DynamicImage::ImageRgb8(buf)
}

/// Backlit sky: smooth vertical gradient, sun disc, dark silhouette
/// ("天空/逆光") — the banding-sensitive class.
pub fn scene_backlit_sky(width: u32, height: u32) -> DynamicImage {
    let buf = ImageBuffer::from_fn(width, height, |x, y| {
        let t = y as f32 / height.max(1) as f32;
        // Sky gradient from warm horizon to deep blue zenith.
        let mut r = 0.85 - 0.55 * t;
        let mut g = 0.72 - 0.38 * t;
        let mut b = 0.55 + 0.25 * t;
        // Sun disc near the horizon.
        let sx = x as f32 - 0.68 * width as f32;
        let sy = y as f32 - 0.22 * height as f32;
        let dist = (sx * sx + sy * sy).sqrt();
        if dist < 0.07 * width as f32 {
            r = 1.0;
            g = 0.97;
            b = 0.9;
        }
        // Ground silhouette.
        if t > 0.78 {
            let k = ((t - 0.78) / 0.22).clamp(0.0, 1.0);
            r *= 1.0 - k;
            g *= 1.0 - k;
            b *= 1.0 - k;
        }
        let enc = |v: f32| (v.clamp(0.0, 1.0) * 255.0 + 0.5).floor() as u8;
        Rgb([enc(r), enc(g), enc(b)])
    });
    DynamicImage::ImageRgb8(buf)
}

/// Synthetic portrait: smooth skin-tone blob with shading on a dark
/// background plus a gray reference strip ("人像").
pub fn scene_portrait(width: u32, height: u32) -> DynamicImage {
    let buf = ImageBuffer::from_fn(width, height, |x, y| {
        let xf = x as f32 / width.max(1) as f32;
        let yf = y as f32 / height.max(1) as f32;
        // Elliptical "face" region with horizontal shading.
        let dx = (xf - 0.5) / 0.28;
        let dy = (yf - 0.46) / 0.38;
        let d2 = dx * dx + dy * dy;
        let shade = 1.0 - 0.35 * (xf - 0.3).clamp(0.0, 1.0);
        let (r, g, b) = if d2 < 1.0 {
            (0.86 * shade, 0.68 * shade, 0.58 * shade)
        } else {
            (0.12, 0.11, 0.12)
        };
        // Neutral gray strip on the right for luma sanity checks.
        let (r, g, b) = if xf > 0.93 {
            (0.5, 0.5, 0.5)
        } else {
            (r, g, b)
        };
        let enc = |v: f32| (v.clamp(0.0, 1.0) * 255.0 + 0.5).floor() as u8;
        Rgb([enc(r), enc(g), enc(b)])
    });
    DynamicImage::ImageRgb8(buf)
}

/// Mid-gray field with additive pseudo-Gaussian noise (Irwin-Hall: sum of 4
/// uniforms minus 2, scaled to `sigma`) — the "ISO 噪声合成" class.
pub fn scene_iso_noise(width: u32, height: u32, seed: u64, sigma: f32) -> DynamicImage {
    let mut rng = Lcg::new(seed);
    // Var(Irwin-Hall n=4) = 4/12 = 1/3.
    let scale = sigma / (1.0_f32 / 3.0).sqrt();
    let buf = ImageBuffer::from_fn(width, height, |_, _| {
        let noise =
            (rng.next_f32() + rng.next_f32() + rng.next_f32() + rng.next_f32() - 2.0) * scale;
        let v = (0.5 + noise).clamp(0.0, 1.0);
        let c = (v * 255.0 + 0.5).floor() as u8;
        Rgb([c, c, c])
    });
    DynamicImage::ImageRgb8(buf)
}

// ---------------------------------------------------------------------------
// Reference point / local ops (IEEE-exact arithmetic only)
// ---------------------------------------------------------------------------

/// Multiplicative exposure in linear-ish sample space.
pub fn exposure(v: f32, gain: f32) -> f32 {
    v * gain
}

/// Per-channel white-balance gains.
pub fn white_balance(v: f32, channel: usize, gains: [f32; 3]) -> f32 {
    v * gains[channel % 3]
}

/// Saturation around the Rec.709 luma of the pixel (`s = 1` is identity).
pub fn saturation(r: f32, g: f32, b: f32, s: f32) -> (f32, f32, f32) {
    // `s == 1.0` must be a *bit-exact* no-op: the general formula
    // `luma + (c - luma) * s` round-trips through catastrophic-cancellation
    // territory and is not guaranteed to return `c` exactly, which would
    // break the neutral golden-identity invariant.
    if s == 1.0 {
        return (r, g, b);
    }
    let luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    (
        luma + (r - luma) * s,
        luma + (g - luma) * s,
        luma + (b - luma) * s,
    )
}

/// Contrast as a convex combination with the pixel's own smoothstep
/// (`amount = 0` is identity, mid-gray is fixed).
pub fn contrast_s_curve(v: f32, amount: f32) -> f32 {
    let x = v.clamp(0.0, 1.0);
    let s = x * x * (3.0 - 2.0 * x);
    x * (1.0 - amount) + s * amount
}

/// 3×3 box blur of a single plane with clamped borders (USM base).
fn box_blur3_plane(plane: &[f32], width: usize, height: usize) -> Vec<f32> {
    let mut tmp = vec![0.0_f32; plane.len()];
    let mut out = vec![0.0_f32; plane.len()];
    for y in 0..height {
        let row = y * width;
        for x in 0..width {
            let l = if x == 0 { x } else { x - 1 };
            let r = if x + 1 == width { x } else { x + 1 };
            tmp[row + x] = (plane[row + l] + plane[row + x] + plane[row + r]) / 3.0;
        }
    }
    for y in 0..height {
        let up = if y == 0 { 0 } else { y - 1 };
        let dn = if y + 1 == height { y } else { y + 1 };
        for x in 0..width {
            out[y * width + x] =
                (tmp[up * width + x] + tmp[y * width + x] + tmp[dn * width + x]) / 3.0;
        }
    }
    out
}

/// Unsharp mask with the shader's cubic soft-threshold `d³/(d²+t)`
/// (`amount = 0` is identity). Mirrors the USM spirit of `shader.wgsl`
/// (soft threshold + clamp) with a fixed 1px box kernel.
pub fn usm_sharpen(img: &FloatImage, amount: f32, threshold: f32) -> FloatImage {
    let width = img.width as usize;
    let height = img.height as usize;
    let t = threshold * threshold + 1e-6;
    let mut data = vec![0.0_f32; img.data.len()];
    for channel in 0..3 {
        let plane = img.plane(channel);
        let blur = box_blur3_plane(&plane, width, height);
        for (i, (&v, &bl)) in plane.iter().zip(blur.iter()).enumerate() {
            let d = v - bl;
            let d2 = d * d;
            let soft = d2 * d / (d2 + t);
            // Write back interleaved — FloatImage stores RGB per pixel.
            data[i * 3 + channel] = v + amount * soft;
        }
    }
    FloatImage {
        width: img.width,
        height: img.height,
        data,
    }
}

// ---------------------------------------------------------------------------
// Tone curve (port of shader.wgsl apply_curve / interpolate_cubic_hermite)
// ---------------------------------------------------------------------------

/// Curve control point in 0..255 coordinates (same domain as the app).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct CurvePoint {
    pub x: f32,
    pub y: f32,
}

impl CurvePoint {
    pub fn new(x: f32, y: f32) -> Self {
        CurvePoint { x, y }
    }
}

/// The identity curve (`[0,0] → [255,255]`).
pub fn identity_curve() -> Vec<CurvePoint> {
    vec![CurvePoint::new(0.0, 0.0), CurvePoint::new(255.0, 255.0)]
}

fn interpolate_cubic_hermite(x: f32, p1: CurvePoint, p2: CurvePoint, m1: f32, m2: f32) -> f32 {
    let dx = p2.x - p1.x;
    if dx <= 0.0 {
        return p1.y;
    }
    let t = (x - p1.x) / dx;
    let t2 = t * t;
    let t3 = t2 * t;
    let h00 = 2.0 * t3 - 3.0 * t2 + 1.0;
    let h10 = t3 - 2.0 * t2 + t;
    let h01 = -2.0 * t3 + 3.0 * t2;
    let h11 = t3 - t2;
    h00 * p1.y + h10 * m1 * dx + h01 * p2.y + h11 * m2 * dx
}

/// Evaluate the tone curve at `val` in `[0, 1]`. Faithful port of
/// `apply_curve` in `shaders/shader.wgsl` (endpoint clamping, zero-crossing
/// tangent suppression and the alpha/beta tangent-length limit included).
pub fn eval_curve(points: &[CurvePoint], val: f32) -> f32 {
    let count = points.len();
    if count < 2 {
        return val;
    }
    let x = val * 255.0;
    let first = points[0];
    if x <= first.x {
        return first.y / 255.0;
    }
    let last = points[count - 1];
    if x >= last.x {
        return last.y / 255.0;
    }
    for i in 0..15 {
        if i >= count - 1 {
            break;
        }
        let p2 = points[i + 1];
        if x <= p2.x {
            let p1 = points[i];
            let p0 = points[if i == 0 { 0 } else { i - 1 }];
            let p3 = points[(count - 1).min(i + 2)];
            let delta_before = (p1.y - p0.y) / (p1.x - p0.x).max(0.001);
            let delta_current = (p2.y - p1.y) / (p2.x - p1.x).max(0.001);
            let delta_after = (p3.y - p2.y) / (p3.x - p2.x).max(0.001);
            let mut tangent_p1 = if i == 0 {
                delta_current
            } else if delta_before * delta_current <= 0.0 {
                0.0
            } else {
                (delta_before + delta_current) / 2.0
            };
            let mut tangent_p2 = if i + 1 == count - 1 {
                delta_current
            } else if delta_current * delta_after <= 0.0 {
                0.0
            } else {
                (delta_current + delta_after) / 2.0
            };
            if delta_current != 0.0 {
                let alpha = tangent_p1 / delta_current;
                let beta = tangent_p2 / delta_current;
                if alpha * alpha + beta * beta > 9.0 {
                    let tau = 3.0 / (alpha * alpha + beta * beta).sqrt();
                    tangent_p1 *= tau;
                    tangent_p2 *= tau;
                }
            }
            let result_y = interpolate_cubic_hermite(x, p1, p2, tangent_p1, tangent_p2);
            return (result_y / 255.0).clamp(0.0, 1.0);
        }
    }
    last.y / 255.0
}

// ---------------------------------------------------------------------------
// Lanczos3 resampler (plan M0-3: the single shared resampler)
// ---------------------------------------------------------------------------

fn lanczos3_window(x: f64) -> f64 {
    let ax = x.abs();
    if ax >= 3.0 {
        return 0.0;
    }
    if ax == 0.0 {
        return 1.0;
    }
    let px = std::f64::consts::PI * x;
    let sinc = px.sin() / px;
    let px3 = px / 3.0;
    sinc * (px3.sin() / px3)
}

/// Per-output-pixel tap list: `(source index (already clamped), weight)`.
/// Weights are normalized over the (unclamped) tap window.
fn axis_weights(src_len: u32, dst_len: u32) -> Vec<Vec<(usize, f64)>> {
    let scale = dst_len as f64 / src_len as f64;
    let filter_scale = if scale < 1.0 { 1.0 / scale } else { 1.0 };
    let support = 3.0 * filter_scale;
    let mut taps = Vec::with_capacity(dst_len as usize);
    for i in 0..dst_len {
        let center = (i as f64 + 0.5) / scale - 0.5;
        let lo = (center - support).ceil() as i64;
        let hi = (center + support).floor() as i64;
        let mut row: Vec<(usize, f64)> = Vec::new();
        let mut sum = 0.0_f64;
        for s in lo..=hi {
            let w = lanczos3_window((s as f64 - center) / filter_scale);
            let idx = (s.clamp(0, src_len as i64 - 1)) as usize;
            row.push((idx, w));
            sum += w;
        }
        if row.is_empty() {
            let idx = (center.round().clamp(0.0, src_len as f64 - 1.0)) as usize;
            row.push((idx, 1.0));
        } else if sum != 0.0 {
            for entry in &mut row {
                entry.1 /= sum;
            }
        }
        taps.push(row);
    }
    taps
}

/// Lanczos3 resize of a single plane (`src.len() == w * h`).
pub fn lanczos3_resize_plane(src: &[f32], w: u32, h: u32, dw: u32, dh: u32) -> Vec<f32> {
    assert_eq!(src.len(), (w * h) as usize, "resize_plane: size mismatch");
    let wx = axis_weights(w, dw);
    let wy = axis_weights(h, dh);
    // Horizontal pass: w × dh.
    let mut tmp = vec![0.0_f64; dw as usize * h as usize];
    for y in 0..h as usize {
        let row = y * w as usize;
        for (dx, xw) in wx.iter().enumerate() {
            let mut acc = 0.0_f64;
            for &(sx, wt) in xw {
                acc += wt * src[row + sx] as f64;
            }
            tmp[y * dw as usize + dx] = acc;
        }
    }
    // Vertical pass: dw × dh.
    let mut out = vec![0.0_f64; dw as usize * dh as usize];
    for (dy, yw) in wy.iter().enumerate() {
        for dx in 0..dw as usize {
            let mut acc = 0.0_f64;
            for &(sy, wt) in yw {
                acc += wt * tmp[sy * dw as usize + dx];
            }
            out[dy * dw as usize + dx] = acc;
        }
    }
    out.iter().map(|v| *v as f32).collect()
}

/// Lanczos3 resize of an interleaved RGB [`FloatImage`].
pub fn lanczos3_resize(img: &FloatImage, dw: u32, dh: u32) -> FloatImage {
    let r = lanczos3_resize_plane(&img.plane(0), img.width, img.height, dw, dh);
    let g = lanczos3_resize_plane(&img.plane(1), img.width, img.height, dw, dh);
    let b = lanczos3_resize_plane(&img.plane(2), img.width, img.height, dw, dh);
    FloatImage::from_planes(&r, &g, &b, dw, dh)
}

// ---------------------------------------------------------------------------
// Tetrahedral 3D LUT (port of shader.wgsl sample_lut_tetrahedral)
// ---------------------------------------------------------------------------

/// 3D LUT with tetrahedral interpolation, mirroring the WGSL oracle. Grid
/// indexing: `((b * size + g) * size + r)`.
pub struct TetrahedralLut {
    size: u32,
    grid: Vec<[f32; 3]>,
}

impl TetrahedralLut {
    /// Build a `size³` LUT by sampling `f` on the regular grid
    /// (`size > 1`, coordinates in `[0, 1]`).
    pub fn from_fn(size: u32, f: impl Fn([f32; 3]) -> [f32; 3]) -> Self {
        assert!(size > 1, "LUT size must be > 1");
        let n = size as usize;
        let last = size as f32 - 1.0;
        let mut grid = Vec::with_capacity(n * n * n);
        for b in 0..size {
            for g in 0..size {
                for r in 0..size {
                    let coord = [r as f32 / last, g as f32 / last, b as f32 / last];
                    grid.push(f(coord));
                }
            }
        }
        TetrahedralLut { size, grid }
    }

    fn at(&self, r: i32, g: i32, b: i32) -> [f32; 3] {
        let n = self.size as usize;
        self.grid[(b as usize * n + g as usize) * n + r as usize]
    }

    /// Tetrahedral interpolation of `rgb` in `[0, 1]³`. Exact port of
    /// `sample_lut_tetrahedral` (same branch structure and coefficient form).
    pub fn interpolate(&self, rgb: [f32; 3]) -> [f32; 3] {
        let dims = self.size as f32;
        let size = dims - 1.0;
        let scaled = [
            rgb[0].clamp(0.0, 1.0) * size,
            rgb[1].clamp(0.0, 1.0) * size,
            rgb[2].clamp(0.0, 1.0) * size,
        ];
        let i0 = scaled[0].floor() as i32;
        let i1 = scaled[1].floor() as i32;
        let i2 = scaled[2].floor() as i32;
        let f = [
            scaled[0] - i0 as f32,
            scaled[1] - i1 as f32,
            scaled[2] - i2 as f32,
        ];
        let max_i = self.size as i32 - 1;
        let (c0r, c0g, c0b) = (i0, i1, i2);
        let (c1r, c1g, c1b) = (
            (i0 + 1).min(max_i),
            (i1 + 1).min(max_i),
            (i2 + 1).min(max_i),
        );

        let c000 = self.at(c0r, c0g, c0b);
        let c111 = self.at(c1r, c1g, c1b);

        let res = if f[0] > f[1] {
            if f[1] > f[2] {
                let c100 = self.at(c1r, c0g, c0b);
                let c110 = self.at(c1r, c1g, c0b);
                [
                    c000[0] * (1.0 - f[0])
                        + c100[0] * (f[0] - f[1])
                        + c110[0] * (f[1] - f[2])
                        + c111[0] * f[2],
                    c000[1] * (1.0 - f[0])
                        + c100[1] * (f[0] - f[1])
                        + c110[1] * (f[1] - f[2])
                        + c111[1] * f[2],
                    c000[2] * (1.0 - f[0])
                        + c100[2] * (f[0] - f[1])
                        + c110[2] * (f[1] - f[2])
                        + c111[2] * f[2],
                ]
            } else if f[0] > f[2] {
                let c100 = self.at(c1r, c0g, c0b);
                let c101 = self.at(c1r, c0g, c1b);
                [
                    c000[0] * (1.0 - f[0])
                        + c100[0] * (f[0] - f[2])
                        + c101[0] * (f[2] - f[1])
                        + c111[0] * f[1],
                    c000[1] * (1.0 - f[0])
                        + c100[1] * (f[0] - f[2])
                        + c101[1] * (f[2] - f[1])
                        + c111[1] * f[1],
                    c000[2] * (1.0 - f[0])
                        + c100[2] * (f[0] - f[2])
                        + c101[2] * (f[2] - f[1])
                        + c111[2] * f[1],
                ]
            } else {
                let c001 = self.at(c0r, c0g, c1b);
                let c101 = self.at(c1r, c0g, c1b);
                [
                    c000[0] * (1.0 - f[2])
                        + c001[0] * (f[2] - f[0])
                        + c101[0] * (f[0] - f[1])
                        + c111[0] * f[1],
                    c000[1] * (1.0 - f[2])
                        + c001[1] * (f[2] - f[0])
                        + c101[1] * (f[0] - f[1])
                        + c111[1] * f[1],
                    c000[2] * (1.0 - f[2])
                        + c001[2] * (f[2] - f[0])
                        + c101[2] * (f[0] - f[1])
                        + c111[2] * f[1],
                ]
            }
        } else if f[2] > f[1] {
            let c001 = self.at(c0r, c0g, c1b);
            let c011 = self.at(c0r, c1g, c1b);
            [
                c000[0] * (1.0 - f[2])
                    + c001[0] * (f[2] - f[1])
                    + c011[0] * (f[1] - f[0])
                    + c111[0] * f[0],
                c000[1] * (1.0 - f[2])
                    + c001[1] * (f[2] - f[1])
                    + c011[1] * (f[1] - f[0])
                    + c111[1] * f[0],
                c000[2] * (1.0 - f[2])
                    + c001[2] * (f[2] - f[1])
                    + c011[2] * (f[1] - f[0])
                    + c111[2] * f[0],
            ]
        } else if f[2] > f[0] {
            let c010 = self.at(c0r, c1g, c0b);
            let c011 = self.at(c0r, c1g, c1b);
            [
                c000[0] * (1.0 - f[1])
                    + c010[0] * (f[1] - f[2])
                    + c011[0] * (f[2] - f[0])
                    + c111[0] * f[0],
                c000[1] * (1.0 - f[1])
                    + c010[1] * (f[1] - f[2])
                    + c011[1] * (f[2] - f[0])
                    + c111[1] * f[0],
                c000[2] * (1.0 - f[1])
                    + c010[2] * (f[1] - f[2])
                    + c011[2] * (f[2] - f[0])
                    + c111[2] * f[0],
            ]
        } else {
            let c010 = self.at(c0r, c1g, c0b);
            let c110 = self.at(c1r, c1g, c0b);
            [
                c000[0] * (1.0 - f[1])
                    + c010[0] * (f[1] - f[0])
                    + c110[0] * (f[0] - f[2])
                    + c111[0] * f[2],
                c000[1] * (1.0 - f[1])
                    + c010[1] * (f[1] - f[0])
                    + c110[1] * (f[0] - f[2])
                    + c111[1] * f[2],
                c000[2] * (1.0 - f[1])
                    + c010[2] * (f[1] - f[0])
                    + c110[2] * (f[0] - f[2])
                    + c111[2] * f[2],
            ]
        };
        res
    }
}

// ---------------------------------------------------------------------------
// Reference pipeline
// ---------------------------------------------------------------------------

/// Fixed parameter snapshot for the reference pipeline ("固定参数快照",
/// plan M0-1). Field values are plain multipliers/amounts (not stops) so no
/// transcendental functions are needed on the hashed path.
#[derive(Debug, Clone)]
pub struct ReferenceParams {
    pub exposure_gain: f32,
    pub wb_gains: [f32; 3],
    pub saturation: f32,
    pub contrast: f32,
    /// Luma curve in 0..255 coordinates, applied to every channel
    /// (empty = no curve).
    pub curve: Vec<CurvePoint>,
    pub usm_amount: f32,
    pub usm_threshold: f32,
    pub grain_amount: f32,
    pub grain_seed: u64,
}

impl ReferenceParams {
    /// All-neutral parameters: the pipeline must be an exact identity.
    pub fn neutral() -> Self {
        ReferenceParams {
            exposure_gain: 1.0,
            wb_gains: [1.0, 1.0, 1.0],
            saturation: 1.0,
            contrast: 0.0,
            curve: Vec::new(),
            usm_amount: 0.0,
            usm_threshold: 0.0,
            grain_amount: 0.0,
            grain_seed: 1,
        }
    }
}

/// Apply the reference pipeline (stage order mirrors the main WGSL pass
/// subset: exposure → WB → saturation → contrast → curve → USM → grain).
pub fn render_reference(img: &FloatImage, params: &ReferenceParams) -> FloatImage {
    let mut out = Vec::with_capacity(img.data.len());
    for px in img.data.chunks_exact(3) {
        let mut rgb = [
            exposure(px[0], params.exposure_gain),
            exposure(px[1], params.exposure_gain),
            exposure(px[2], params.exposure_gain),
        ];
        for (ch, v) in rgb.iter_mut().enumerate() {
            *v = white_balance(*v, ch, params.wb_gains);
        }
        let (r, g, b) = saturation(rgb[0], rgb[1], rgb[2], params.saturation);
        rgb = [r, g, b];
        for v in rgb.iter_mut() {
            *v = contrast_s_curve(*v, params.contrast);
        }
        if !params.curve.is_empty() {
            for v in rgb.iter_mut() {
                *v = eval_curve(&params.curve, *v);
            }
        }
        out.extend_from_slice(&rgb);
    }
    let mut img = FloatImage {
        width: img.width,
        height: img.height,
        data: out,
    };
    if params.usm_amount != 0.0 {
        img = usm_sharpen(&img, params.usm_amount, params.usm_threshold);
    }
    if params.grain_amount != 0.0 {
        let mut rng = Lcg::new(params.grain_seed);
        for v in img.data.iter_mut() {
            *v += (rng.next_f32() - 0.5) * params.grain_amount;
        }
    }
    img
}
