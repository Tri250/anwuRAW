//! Objective render-quality metrics (v2.0 plan M0-2).
//!
//! These tests run the real GPU pipeline headless (lavapipe/llvmpipe on CI)
//! over the deterministic golden fixtures and assert *measurable* image
//! properties instead of byte snapshots:
//!
//! | test                             | property                                      |
//! |----------------------------------|-----------------------------------------------|
//! | colorchecker_neutrals_stay_neutral | white balance keeps gray patches neutral    |
//! | colorchecker_delta_e_vs_reference | neutral render matches BabelColor ΔE2000    |
//! | gray_ramp_gradient_no_banding    | smooth gradient stays smooth in 8-bit output  |
//! | edge_contrast_sharpening_metrics | detail tools engage at mid luma, gated at 0/1 |
//! | sky_backlit_smooth_sky_residual  | smooth areas stay smooth (noise/banding)      |
//! | iso_noise_denoise_reduces_sigma  | denoise cuts synthetic ISO noise              |
//! | sky_backlit_highlights_controlled| sky doesn't clip, ridge silhouette stays dark |
//! | preview_vs_export_render_order_consistency | preview/export WYSIWYG gap (R1 KPI) |
//!
//! Thresholds are deliberately loose: they catch algorithm regressions, not
//! float-rounding drift (the golden harness in `bench/golden` covers that).
//! Each test prints its measured values so failures are diagnosable.
//!
//! GPU tests need a wgpu adapter; without one they print SKIP and pass, since
//! the golden render regression (which does run in CI with lavapipe) is the
//! actual output gate.

use std::collections::HashMap;
use std::f64::consts::PI;
use std::sync::{Arc, Mutex, OnceLock};

use image::DynamicImage;
use serde_json::Value;

use crate::app_state::AppState;
use crate::as_shot::AsShot;
use crate::golden_fixtures::{self, Rgb16Image};
use crate::gpu_processing::{
    RenderOutputPrecision, RenderRequest, process_and_get_dynamic_image_with_precision,
};
use crate::image_processing::{
    GpuContext, get_all_adjustments_from_json, resolve_render_options,
};
use crate::metrics::{delta_e_2000, srgb_to_lab};

// Fixed adjustment snapshots, shared with bench/golden (compile-time embedded
// so the tests stay hermetic).
const PARAMS_COLORCHECKER: &str = include_str!("../../bench/golden/params/colorchecker.json");
const PARAMS_GRAY_RAMP: &str = include_str!("../../bench/golden/params/gray-ramp.json");
const PARAMS_EDGE_CONTRAST: &str = include_str!("../../bench/golden/params/edge-contrast.json");
const PARAMS_SKY_BACKLIT: &str = include_str!("../../bench/golden/params/sky-backlit.json");
const PARAMS_ISO_NOISE: &str = include_str!("../../bench/golden/params/iso-noise.json");
const PARAMS_PORTRAIT: &str = include_str!("../../bench/golden/params/portrait.json");

// ---------------------------------------------------------------- harness --

fn fixtures() -> &'static HashMap<&'static str, Rgb16Image> {
    static FIXTURES: OnceLock<HashMap<&'static str, Rgb16Image>> = OnceLock::new();
    FIXTURES.get_or_init(|| golden_fixtures::fixtures().into_iter().collect())
}

fn fixture(name: &str) -> &'static Rgb16Image {
    fixtures()
        .get(name)
        .unwrap_or_else(|| panic!("unknown golden fixture {name}"))
}

/// Headless compute-only wgpu context (no surface; Linux uses lavapipe when
/// WGPU_BACKEND=Vulkan is set). `None` when no adapter is available.
fn gpu_context() -> Option<&'static GpuContext> {
    static CTX: OnceLock<Option<GpuContext>> = OnceLock::new();
    CTX.get_or_init(build_context).as_ref()
}

fn build_context() -> Option<GpuContext> {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        ..Default::default()
    }))
    .ok()?;
    let mut required_features = wgpu::Features::empty();
    if adapter
        .features()
        .contains(wgpu::Features::TEXTURE_ADAPTER_SPECIFIC_FORMAT_FEATURES)
    {
        required_features |= wgpu::Features::TEXTURE_ADAPTER_SPECIFIC_FORMAT_FEATURES;
    }
    let limits = adapter.limits();
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("Objective Test Device"),
        required_features,
        required_limits: limits.clone(),
        ..Default::default()
    }))
    .ok()?;
    Some(GpuContext {
        device: Arc::new(device),
        queue: Arc::new(queue),
        limits,
        adapter_info: adapter.get_info(),
        display: Arc::new(Mutex::new(None)),
    })
}

/// Render a fixture through the real pipeline with a fixed adjustments
/// snapshot, at 16-bit output precision.
fn render(image: &str, params: &str) -> Rgb16Image {
    render_image(DynamicImage::ImageRgb16(fixture(image).clone()), params)
}

/// Render an arbitrary base image through the real pipeline (same path as
/// `render`; accepts pre-downscaled inputs for the preview/export tests).
fn render_image(base: DynamicImage, params: &str) -> Rgb16Image {
    let context = gpu_context().expect("no wgpu adapter; GPU objective tests cannot run");
    let state = AppState::default();
    let js: Value = serde_json::from_str(params).expect("invalid params JSON");
    let (transformed, _) = crate::adjustment_utils::apply_all_transformations(base, &js);
    let settings = crate::app_settings::AppSettings::default();
    let adjustments =
        get_all_adjustments_from_json(&js, false, AsShot::reference(), resolve_render_options(&settings, false));
    let output = process_and_get_dynamic_image_with_precision(
        context,
        &state,
        transformed.as_ref(),
        0,
        RenderRequest {
            adjustments,
            mask_bitmaps: &[],
            mask_cache_key: None,
            lut: None,
            roi: None,
        },
        "objective-test",
        RenderOutputPrecision::SixteenBit,
    )
    .expect("pipeline render failed");
    output.to_rgb16()
}

// ---------------------------------------------------------------- helpers --

/// Rec.601 luma on the 8-bit code scale (matches display rendering).
fn luma8(img: &Rgb16Image, x: u32, y: u32) -> f32 {
    let p = img.get_pixel(x, y).0;
    (0.299 * p[0] as f32 + 0.587 * p[1] as f32 + 0.114 * p[2] as f32) / 257.0
}

/// Mean CIE Lab of a rectangular region (sRGB-encoded input).
fn region_mean_lab(img: &Rgb16Image, x0: u32, y0: u32, w: u32, h: u32) -> [f32; 3] {
    let mut sum = [0.0f64; 3];
    let mut n = 0u64;
    for y in y0..y0 + h {
        for x in x0..x0 + w {
            let p = img.get_pixel(x, y).0.map(|v| v as f32 / 65535.0);
            let lab = srgb_to_lab(p);
            for c in 0..3 {
                sum[c] += lab[c] as f64;
            }
            n += 1;
        }
    }
    let inv = 1.0 / n as f64;
    [sum[0] * inv, sum[1] * inv, sum[2] * inv].map(|v| v as f32)
}

/// Per-channel standard deviation of a region on the 8-bit code scale.
fn region_sigma8(img: &Rgb16Image, x0: u32, y0: u32, w: u32, h: u32) -> [f32; 3] {
    let n = (w * h) as f64;
    let mut mean = [0.0f64; 3];
    for y in y0..y0 + h {
        for x in x0..x0 + w {
            let p = img.get_pixel(x, y).0.map(|v| v as f64 / 257.0);
            for c in 0..3 {
                mean[c] += p[c];
            }
        }
    }
    for m in &mut mean {
        *m /= n;
    }
    let mut var = [0.0f64; 3];
    for y in y0..y0 + h {
        for x in x0..x0 + w {
            let p = img.get_pixel(x, y).0.map(|v| v as f64 / 257.0);
            for c in 0..3 {
                var[c] += (p[c] - mean[c]).powi(2);
            }
        }
    }
    var.map(|v| (v / n).sqrt() as f32)
}

/// Fraction of pixels clipped to (near) white in all channels.
fn clipped_fraction(img: &Rgb16Image, threshold: u16) -> f32 {
    let (w, h) = img.dimensions();
    let mut clipped = 0u64;
    for p in img.pixels() {
        if p.0[0] >= threshold && p.0[1] >= threshold && p.0[2] >= threshold {
            clipped += 1;
        }
    }
    clipped as f32 / (w * h) as f32
}

/// Longest run of identical 8-bit luma values along one row.
fn longest_identical_run(img: &Rgb16Image, y: u32) -> usize {
    let (w, _) = img.dimensions();
    let mut best = 1usize;
    let mut run = 1usize;
    let quant = |x: u32| (luma8(img, x, y) + 0.5) as i32;
    let mut prev = quant(0);
    for x in 1..w {
        let v = quant(x);
        if v == prev {
            run += 1;
            best = best.max(run);
        } else {
            run = 1;
        }
        prev = v;
    }
    best
}

/// Longest run of identical 16-bit luma values along one row. This is the
/// posterization probe: an internal 8-bit stage pins the output to the
/// 257-code grid and shows up here as long runs, while a true 16-bit pipeline
/// advances the gradient almost every pixel.
fn longest_identical_run16(img: &Rgb16Image, y: u32) -> usize {
    let (w, _) = img.dimensions();
    let mut best = 1usize;
    let mut run = 1usize;
    let quant = |x: u32| {
        let p = img.get_pixel(x, y).0;
        (0.299 * p[0] as f64 + 0.587 * p[1] as f64 + 0.114 * p[2] as f64).round() as i64
    };
    let mut prev = quant(0);
    for x in 1..w {
        let v = quant(x);
        if v == prev {
            run += 1;
            best = best.max(run);
        } else {
            run = 1;
        }
        prev = v;
    }
    best
}

/// (mean ΔE2000, max ΔE2000, 16-bit luma PSNR dB) between two same-size
/// renders — the end-to-end perceptual difference metric.
fn compare_images(a: &Rgb16Image, b: &Rgb16Image) -> (f64, f64, f64) {
    assert_eq!(a.dimensions(), b.dimensions(), "image size mismatch");
    let luma16 = |p: [u16; 3]| 0.299 * p[0] as f64 + 0.587 * p[1] as f64 + 0.114 * p[2] as f64;
    let mut de_sum = 0.0f64;
    let mut de_max = 0.0f64;
    let mut sq = 0.0f64;
    let mut n = 0u64;
    for (pa, pb) in a.pixels().zip(b.pixels()) {
        let la = srgb_to_lab(pa.0.map(|v| v as f32 / 65535.0));
        let lb = srgb_to_lab(pb.0.map(|v| v as f32 / 65535.0));
        let de = delta_e_2000(la, lb) as f64;
        de_sum += de;
        de_max = de_max.max(de);
        let d = luma16(pa.0) - luma16(pb.0);
        sq += d * d;
        n += 1;
    }
    let psnr = 10.0 * (65535.0f64 * 65535.0 / (sq / n as f64)).log10();
    (de_sum / n as f64, de_max, psnr)
}

/// Radix-2 FFT magnitude spectrum. The input is zero-padded to the next power
/// of two, so any window length works (padding only interpolates the spectrum;
/// the MTF crossing point is preserved).
fn fft_magnitude(samples: &[f64]) -> Vec<f64> {
    let mut n = 1usize;
    while n < samples.len() {
        n <<= 1;
    }
    let mut re = vec![0.0f64; n];
    let mut im = vec![0.0f64; n];
    re[..samples.len()].copy_from_slice(samples);
    let mut j = 0usize;
    for i in 1..n {
        let mut bit = n >> 1;
        while j & bit != 0 {
            j ^= bit;
            bit >>= 1;
        }
        j ^= bit;
        if i < j {
            re.swap(i, j);
            im.swap(i, j);
        }
    }
    let mut len = 2usize;
    while len <= n {
        let ang = -2.0 * PI / len as f64;
        let (wr, wi) = (ang.cos(), ang.sin());
        let half = len / 2;
        let mut i = 0usize;
        while i < n {
            let (mut cr, mut ci) = (1.0, 0.0);
            for k in 0..half {
                let (ur, ui) = (re[i + k], im[i + k]);
                let (vr, vi) = (re[i + k + half], im[i + k + half]);
                let (tr, ti) = (vr * cr - vi * ci, vr * ci + vi * cr);
                re[i + k] = ur + tr;
                im[i + k] = ui + ti;
                re[i + k + half] = ur - tr;
                im[i + k + half] = ui - ti;
                let (ncr, nci) = (cr * wr - ci * wi, cr * wi + ci * wr);
                cr = ncr;
                ci = nci;
            }
            i += len;
        }
        len <<= 1;
    }
    (0..n).map(|k| (re[k] * re[k] + im[k] * im[k]).sqrt()).collect()
}

/// MTF50 (cycles/pixel) of an edge spread function, Hann-windowed LSF.
/// (An ideal 2-sample step scores 1/3 cyc/px — the box-LSF cosine crossing.)
fn mtf50(esf: &[f64]) -> f64 {
    let n = esf.len();
    let mut lsf = vec![0.0f64; n];
    for i in 1..n - 1 {
        lsf[i] = (esf[i + 1] - esf[i - 1]) / 2.0;
    }
    for (i, w) in lsf.iter_mut().enumerate() {
        let hann = 0.5 - 0.5 * (2.0 * PI * i as f64 / (n - 1) as f64).cos();
        *w *= hann;
    }
    let mag = fft_magnitude(&lsf);
    // The FFT zero-pads to a power of two, so the frequency axis (and the
    // Nyquist bound) must use the padded length, not the ESF length.
    let fft_len = mag.len();
    let dc = mag[0].max(1e-12);
    let norm = |k: usize| mag[k] / dc;
    for k in 2..fft_len / 2 {
        if norm(k) <= 0.5 {
            let prev = norm(k - 1);
            let t = (prev - 0.5) / (prev - norm(k));
            return (k as f64 - 1.0 + t) / fft_len as f64;
        }
    }
    0.5 // never crosses below 0.5: MTF50 at or beyond Nyquist/2
}

/// 10-90% rise distance (pixels) of an edge spread function.
fn rise_distance(esf: &[f64]) -> f64 {
    let m = esf.len() / 8;
    let lo = esf.iter().take(m).sum::<f64>() / m as f64;
    let hi = esf.iter().skip(esf.len() - m).sum::<f64>() / m as f64;
    let span = (hi - lo).max(1e-9);
    let find = |level: f64| -> f64 {
        let target = lo + span * level;
        for i in 1..esf.len() {
            if (esf[i - 1] < target) == (esf[i] >= target) || (esf[i - 1] > target) == (esf[i] <= target)
            {
                let t = (target - esf[i - 1]) / (esf[i] - esf[i - 1]);
                return i as f64 - 1.0 + t;
            }
        }
        f64::NAN
    };
    (find(0.9) - find(0.1)).abs()
}

/// Max deviation outside [0,1] of a normalized edge (halo/overshoot measure).
fn edge_overshoot(esf: &[f64]) -> f64 {
    let m = esf.len() / 8;
    let lo = esf.iter().take(m).sum::<f64>() / m as f64;
    let hi = esf.iter().skip(esf.len() - m).sum::<f64>() / m as f64;
    let span = (hi - lo).max(1e-9);
    esf.iter()
        .map(|v| {
            let n = (*v - lo) / span;
            (n - 1.0).max(-n)
        })
        .fold(0.0, f64::max)
}

// ------------------------------------------------------------------ tests --

#[test]
fn colorchecker_neutrals_stay_neutral() {
    let out = render("colorchecker.png", PARAMS_COLORCHECKER);
    // 6x4 grid of 96px patches, 16px gutters, 32px surround; row 3 is the
    // neutral ramp (white -> black). Measure patch interiors.
    let (pw, gut, pad) = (96u32, 16u32, 32u32);
    let inset = 16u32;
    let mut worst_chroma = 0.0f32;
    let mut reported = Vec::new();
    for col in 0..6u32 {
        let x0 = pad + col * (pw + gut) + inset;
        let y0 = pad + 3 * (pw + gut) + inset;
        let lab = region_mean_lab(&out, x0, y0, pw - 2 * inset, pw - 2 * inset);
        let chroma = lab[1].hypot(lab[2]);
        worst_chroma = worst_chroma.max(chroma);
        reported.push(format!("n{}: L*{:.1} chroma {chroma:.2}", col + 1, lab[0]));
    }
    println!("neutrals -> {}", reported.join(" | "));
    assert!(
        worst_chroma <= 1.5,
        "neutral patch drifted colored: worst chroma {worst_chroma:.2} (ΔE-ish); white balance or tone curve tints grays"
    );
}

#[test]
fn colorchecker_delta_e_vs_reference() {
    // Neutral adjustments: the pipeline must stay transparent, so every patch
    // interior should still match its BabelColor reference within a small
    // ΔE2000 (catches white balance, tone curve and transfer-function drift).
    let out = render("colorchecker.png", "{}");
    let (pw, gut, pad, inset) = (96u32, 16u32, 32u32, 16u32);
    let mut de_sum = 0.0f64;
    let mut de_max = 0.0f64;
    let mut worst_patch = String::new();
    for row in 0..4u32 {
        for col in 0..6u32 {
            let reference = srgb_to_lab(golden_fixtures::COLORCHECKER[(row * 6 + col) as usize]);
            let lab = region_mean_lab(
                &out,
                pad + col * (pw + gut) + inset,
                pad + row * (pw + gut) + inset,
                pw - 2 * inset,
                pw - 2 * inset,
            );
            let de = delta_e_2000(reference, lab) as f64;
            de_sum += de;
            if de > de_max {
                de_max = de;
                worst_patch = format!("row{row} col{col}");
            }
        }
    }
    let de_mean = de_sum / 24.0;
    println!("24-patch ΔE2000 vs BabelColor reference: mean {de_mean:.2}, max {de_max:.2} ({worst_patch})");
    assert!(
        de_mean <= 1.5,
        "color accuracy drifted: mean ΔE2000 {de_mean:.2} vs reference (<=1.5 expected with neutral adjustments)"
    );
    assert!(
        de_max <= 4.0,
        "color accuracy drifted: worst patch ({worst_patch}) ΔE2000 {de_max:.2} vs reference"
    );
}

#[test]
fn gray_ramp_gradient_no_banding() {
    let out = render("gray-ramp.png", PARAMS_GRAY_RAMP);
    // Bottom band (y 176..256) is a continuous gradient across the width.
    let mut worst_run8 = 0usize;
    let mut worst_run16 = 0usize;
    for y in [200u32, 216, 232, 248] {
        let r8 = longest_identical_run(&out, y);
        let r16 = longest_identical_run16(&out, y);
        println!("row {y}: longest identical run = {r8}px (8-bit luma) / {r16}px (16-bit luma)");
        worst_run8 = worst_run8.max(r8);
        worst_run16 = worst_run16.max(r16);
    }
    // Posterization probe on the 16-bit output: the real pipeline holds ~2px
    // runs even where the tone curve flattens; an internal 8-bit stage pins
    // the gradient to ~3.5px steps (longer after curve flattening) and shows
    // up as ~10px runs here.
    assert!(
        worst_run16 <= 8,
        "gradient posterized inside the pipeline: {worst_run16}px identical 16-bit run (<=8 expected; 8-bit luma run was {worst_run8}px)"
    );

    // 8-bit output vs 16-bit output over the gradient: quantization loss only.
    let (w, _) = out.dimensions();
    let mut sq = 0.0f64;
    let mut n = 0u64;
    for y in 200u32..256 {
        for x in 0..w {
            let v16 = luma8(&out, x, y);
            let v8 = ((v16 + 0.5) as u8) as f64;
            sq += (v8 - v16 as f64).powi(2);
            n += 1;
        }
    }
    let psnr = 10.0 * (255.0f64 * 255.0 / (sq / n as f64)).log10();
    println!("gradient 8-bit quantization PSNR = {psnr:.1} dB");
    assert!(psnr >= 35.0, "8-bit gradient PSNR {psnr:.1} dB < 35 dB (banding)");
}

#[test]
fn edge_contrast_sharpening_metrics() {
    let sharp = render("edge-contrast.png", PARAMS_EDGE_CONTRAST);
    let flat = render("edge-contrast.png", "{}");

    // Q1 holds a vertical 0->1 step at x=256; average the ESF over rows.
    let esf_bw = |img: &Rgb16Image| -> Vec<f64> {
        let (x_start, x_end) = (216u32, 296u32);
        let rows = 100u32..156u32;
        let mut esf = vec![0.0f64; (x_end - x_start) as usize];
        for y in rows {
            for (i, x) in (x_start..x_end).enumerate() {
                esf[i] += luma8(img, x, y) as f64;
            }
        }
        let n = (156 - 100) as f64;
        esf.iter_mut().for_each(|v| *v /= n);
        esf
    };

    // Q2 holds a 45-degree 0->0.5 step (qx+qy = 256). Walking the
    // perpendicular (1,1) direction through (639,128) crosses it as a clean
    // 2-sample step at mid luma, where the detail tools fully engage (the
    // shader's shadow/highlight protection gates them out at luma 0 and 1).
    let esf_mid = |img: &Rgb16Image| -> Vec<f64> {
        (-40i32..=40)
            .map(|t| luma8(img, (639 + t) as u32, (128 + t) as u32) as f64)
            .collect()
    };

    let step_amplitude = |esf: &[f64]| {
        let m = esf.len() / 8;
        let lo = esf.iter().take(m).sum::<f64>() / m as f64;
        let hi = esf.iter().skip(esf.len() - m).sum::<f64>() / m as f64;
        hi - lo
    };

    // Mid-tone edge: the detail tools must steepen the transition (narrower
    // 10-90% rise, higher MTF50) with controlled overshoot. Step amplitude is
    // not a signal here — USM leaves the flat plateaus untouched by design.
    let esf_mid_sharp = esf_mid(&sharp);
    let esf_mid_flat = esf_mid(&flat);
    let rise_mid_sharp = rise_distance(&esf_mid_sharp);
    let rise_mid_flat = rise_distance(&esf_mid_flat);
    let mtf_mid_sharp = mtf50(&esf_mid_sharp);
    let mtf_mid_flat = mtf50(&esf_mid_flat);
    let overshoot_mid = edge_overshoot(&esf_mid_sharp);
    println!(
        "mid-tone edge rise: {rise_mid_flat:.2}px -> {rise_mid_sharp:.2}px, MTF50 {mtf_mid_flat:.3} -> {mtf_mid_sharp:.3} cyc/px, overshoot {overshoot_mid:.3}"
    );
    assert!(
        rise_mid_sharp <= rise_mid_flat - 0.02,
        "detail tools did not steepen the mid-tone edge: 10-90% rise {rise_mid_flat:.2}px -> {rise_mid_sharp:.2}px"
    );
    assert!(
        mtf_mid_sharp > mtf_mid_flat,
        "detail tools did not raise mid-tone edge MTF50: {mtf_mid_flat:.3} -> {mtf_mid_sharp:.3} cyc/px"
    );
    assert!(
        overshoot_mid <= 0.15,
        "detail tools halo on the mid-tone edge: overshoot {overshoot_mid:.3}"
    );

    // B/W step: the shadow/highlight protection gates sharpening at luma 0
    // and 1, so this edge must pass through untouched (behavior lock), and
    // the unsharpened render must still read as an ideal edge (MTF50 = 1/3).
    let amp_bw_flat = step_amplitude(&esf_bw(&flat));
    let amp_bw_sharp = step_amplitude(&esf_bw(&sharp));
    let mtf_bw = mtf50(&esf_bw(&flat));
    println!(
        "B/W step amplitude: {amp_bw_flat:.2} -> {amp_bw_sharp:.2} 8-bit codes, MTF50 {mtf_bw:.3} cyc/px"
    );
    assert!(
        (amp_bw_sharp - amp_bw_flat).abs() <= 2.0,
        "shadow/highlight protection leaked on a 0->1 step: amplitude {amp_bw_flat:.2} -> {amp_bw_sharp:.2}"
    );
    assert!(
        (mtf_bw - 1.0 / 3.0).abs() < 0.05,
        "flat B/W step no longer reads as an ideal edge: MTF50 {mtf_bw:.3} cyc/px"
    );
}

#[test]
fn sky_backlit_smooth_sky_residual() {
    let out = render("sky-backlit.png", PARAMS_SKY_BACKLIT);
    // 32x32 sky window (no sun, no ridge): per-column linear fit removes the
    // smooth vertical gradient; what remains is noise/banding.
    let (x0, y0, w, h) = (96u32, 250u32, 32u32, 32u32);
    let mut sq = 0.0f64;
    let mut n = 0u64;
    for x in x0..x0 + w {
        let mut sy = 0.0f64;
        let mut syy = 0.0f64;
        let mut sxy = 0.0f64;
        let mut sx = 0.0f64;
        for (i, y) in (y0..y0 + h).enumerate() {
            let (yi, vi) = (i as f64, luma8(&out, x, y) as f64);
            sy += vi;
            syy += yi * yi;
            sxy += yi * vi;
            sx += yi;
        }
        let m = h as f64;
        let denom = m * syy - sx * sx;
        let slope = (m * sxy - sx * sy) / denom;
        let intercept = (sy - slope * sx) / m;
        for (i, y) in (y0..y0 + h).enumerate() {
            let fit = intercept + slope * i as f64;
            let r = luma8(&out, x, y) as f64 - fit;
            sq += r * r;
            n += 1;
        }
    }
    let sigma = (sq / n as f64).sqrt();
    println!("smooth sky residual sigma = {sigma:.3} 8-bit code values");
    assert!(
        sigma <= 1.0,
        "smooth sky area has {sigma:.3} code-value residual (noise or banding)"
    );
}

#[test]
fn iso_noise_denoise_reduces_sigma() {
    let input = fixture("iso-noise.png").clone();
    let out = render("iso-noise.png", PARAMS_ISO_NOISE);
    // Four 256px patches (clean, ISO400, ISO1600, ISO6400); 2px gutters at the
    // left edge of each patch are excluded.
    let mut in_sigma = [0.0f32; 4];
    let mut out_sigma = [0.0f32; 4];
    for (p, (si, so)) in in_sigma.iter_mut().zip(out_sigma.iter_mut()).enumerate() {
        let x0 = p as u32 * 256 + 2;
        let (s_in, s_out) = (
            region_sigma8(&input, x0, 32, 254, 192),
            region_sigma8(&out, x0, 32, 254, 192),
        );
        *si = (s_in[0] + s_in[1] + s_in[2]) / 3.0;
        *so = (s_out[0] + s_out[1] + s_out[2]) / 3.0;
    }
    println!(
        "patch sigma (8-bit code values) in : {in_sigma:?}\n\
         patch sigma (8-bit code values) out: {out_sigma:?}"
    );
    for iso in 1..4 {
        assert!(
            out_sigma[iso] < in_sigma[iso],
            "ISO patch {iso} not denoised: sigma {:.3} -> {:.3}",
            in_sigma[iso],
            out_sigma[iso]
        );
    }
    assert!(
        out_sigma[3] <= 0.7 * in_sigma[3],
        "ISO6400 denoise too weak: sigma {:.3} -> {:.3}",
        in_sigma[3],
        out_sigma[3]
    );
    assert!(
        out_sigma[0] <= 1.5,
        "clean patch dirtied by denoise: sigma {:.3}",
        out_sigma[0]
    );
}

#[test]
fn sky_backlit_highlights_controlled() {
    let out = render("sky-backlit.png", PARAMS_SKY_BACKLIT);
    let clipped = clipped_fraction(&out, 65025);
    println!("clipped-to-white fraction = {:.3}%", clipped * 100.0);
    assert!(
        clipped <= 0.08,
        "sky blew out: {:.2}% of pixels clipped white",
        clipped * 100.0
    );

    // Ridge silhouette body (below the highest ridge point, y >= 490).
    let lab = region_mean_lab(&out, 300, 490, 400, 20);
    println!("ridge body mean L* = {:.2}", lab[0]);
    assert!(
        lab[0] <= 20.0,
        "ridge silhouette lifted to L* {:.2} (shadow crush/haze leak)",
        lab[0]
    );
}

#[test]
fn preview_vs_export_render_order_consistency() {
    // The editor preview downscales the base (area filter, display space) and
    // then renders adjustments at preview resolution; the export renders at
    // full resolution and Lanczos3-downscales afterwards. Resolution-
    // dependent effects (sharpening radius, clarity, noise reduction, grain)
    // therefore land differently — the R1 WYSIWYG gap. The portrait fixture
    // (smooth gradients + faint texture) is the perceptual worst case; a
    // neutral-params control proves the comparison itself is sound.
    let base = fixture("portrait.png").clone();
    let (fw, fh) = base.dimensions();
    let (pw, ph) = (fw / 2, fh / 2); // half-res preview

    let wysiwyg_gap = |params: &str| -> (f64, f64, f64) {
        // Preview path: downscale first, then render.
        let preview_base = crate::image_processing::downscale_f32_image(
            &DynamicImage::ImageRgb16(base.clone()),
            pw,
            ph,
        );
        let preview_path = render_image(preview_base, params);
        // Export path: render full-res, then Lanczos3 downscale.
        let export_path = render("portrait.png", params);
        let export_path = DynamicImage::ImageRgb16(export_path)
            .resize(pw, ph, image::imageops::FilterType::Lanczos3)
            .to_rgb16();
        compare_images(&preview_path, &export_path)
    };

    let (n_mean, n_max, n_psnr) = wysiwyg_gap("{}");
    println!(
        "preview vs export, neutral params: mean ΔE {n_mean:.2}, max ΔE {n_max:.2}, luma PSNR {n_psnr:.1} dB"
    );
    let (d_mean, d_max, d_psnr) = wysiwyg_gap(PARAMS_PORTRAIT);
    println!(
        "preview vs export, portrait look  : mean ΔE {d_mean:.2}, max ΔE {d_max:.2}, luma PSNR {d_psnr:.1} dB"
    );

    // Control: with no adjustments both orders must nearly agree (only the
    // filter difference on the faint texture remains). A large neutral gap
    // means the comparison or the pipeline itself is broken.
    assert!(
        n_mean <= 1.0,
        "neutral preview/export gap too large: mean ΔE {n_mean:.2} — comparison or pipeline bug"
    );
    // KPI: the portrait-look gap is the R1 baseline M1 must shrink. Loose
    // upper bound only; the printed value tracks the trend across versions.
    assert!(
        d_mean <= 8.0,
        "preview/export gap exploded: mean ΔE {d_mean:.2} with the portrait look"
    );
}

/// Sanity: the metric primitives agree with known references (guards against
/// silently broken helpers making the tests above vacuous).
#[test]
fn metric_helpers_reference_values() {
    // Perfect step: the central-difference LSF is a 2-sample box, whose
    // spectrum is a cosine crossing 0.5 at exactly 1/3 cyc/px.
    let step: Vec<f64> = (0..128).map(|i| if i < 64 { 0.0 } else { 1.0 }).collect();
    let step_mtf = mtf50(&step);
    println!("mtf50(perfect step) = {step_mtf:.4} cyc/px (ideal 0.3333)");
    assert!(
        (step_mtf - 1.0 / 3.0).abs() < 0.01,
        "mtf50(perfect step) = {step_mtf}: an ideal edge must read as 1/3 cyc/px"
    );
    // Linear ramp over N samples: with lo/hi taken from the first/last eighth,
    // the 10-90% rise distance is exactly 0.8 * (N - N/8) samples.
    let ramp: Vec<f64> = (0..100).map(|i| i as f64 / 99.0).collect();
    let expected_rise = 0.8 * (100.0 - 12.0);
    let rise = rise_distance(&ramp);
    println!("rise_distance(linear ramp) = {rise:.2}px (expected {expected_rise:.2}px)");
    assert!(
        (rise - expected_rise).abs() < 1.0,
        "rise_distance(ramp) = {rise:.2}px, expected {expected_rise:.2}px"
    );
    // Pure gray stays gray in Lab.
    let gray = srgb_to_lab([128.0 / 255.0, 128.0 / 255.0, 128.0 / 255.0]);
    assert!(gray[1].abs() < 1e-4 && gray[2].abs() < 1e-4);
    // ΔE of a color against itself is zero.
    let red = srgb_to_lab([1.0, 0.0, 0.0]);
    assert!(delta_e_2000(red, red).abs() < 1e-6);
}
