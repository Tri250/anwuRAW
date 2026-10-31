//! Unit tests proving the metric math on known inputs (plan §6, M0-2).
//!
//! Reference values:
//! - CIEDE2000 pairs are from the Sharma, Wu & Dalal (2005) test dataset
//!   (values confirmed with an independent implementation).
//! - sRGB→Lab values are the standard D65 references.
//! - PSNR/SSIM expectations are derived analytically in the tests.

mod common;

use common::testing::harness::{self, CurvePoint, FloatImage, Lcg, TetrahedralLut};
use common::testing::metrics;

fn assert_close(actual: f64, expected: f64, tol: f64, what: &str) {
    assert!(
        (actual - expected).abs() <= tol,
        "{what}: expected {expected}, got {actual} (tol {tol})"
    );
}

// ---------------------------------------------------------------------------
// max_delta / PSNR
// ---------------------------------------------------------------------------

#[test]
fn max_delta_reports_worst_sample() {
    let a = [0.1_f32, 0.5, 0.9];
    let b = [0.2_f32, 0.4, 0.3];
    assert_close(metrics::max_delta(&a, &b) as f64, 0.6, 1e-6, "max_delta");
    assert_close(
        metrics::max_delta(&a, &a) as f64,
        0.0,
        1e-6,
        "max_delta self",
    );
}

#[test]
#[should_panic(expected = "sample count mismatch")]
fn max_delta_rejects_length_mismatch() {
    let _ = metrics::max_delta(&[0.1_f32], &[0.1_f32, 0.2_f32]);
}

#[test]
fn psnr_of_constant_offset_matches_closed_form() {
    // Constant images differing by d: mse = d², psnr = -20·log10(d).
    let a = vec![0.25_f32; 16 * 16 * 3];
    let b = vec![0.25_f32 + 0.01_f32; 16 * 16 * 3];
    let expected = -20.0 * (0.01_f64).log10();
    assert_close(metrics::psnr(&a, &b), expected, 1e-4, "psnr offset");
}

#[test]
fn psnr_is_infinite_for_identical_buffers() {
    let a = vec![0.37_f32; 1024];
    assert!(metrics::psnr(&a, &a).is_infinite());
    assert!(metrics::psnr_u8(&[7_u8; 16], &[7_u8; 16]).is_infinite());
}

#[test]
fn psnr_u8_matches_closed_form() {
    // Constant buffers differing by 8: mse = 64, psnr = 10·log10(255²/64).
    let a = [100_u8; 64];
    let b = [108_u8; 64];
    let expected = 10.0 * (255.0_f64 * 255.0 / 64.0).log10();
    assert_close(metrics::psnr_u8(&a, &b), expected, 1e-9, "psnr_u8");
}

// ---------------------------------------------------------------------------
// SSIM
// ---------------------------------------------------------------------------

#[test]
fn ssim_of_identical_images_is_one() {
    let img = harness::scene_backlit_sky(64, 96);
    let a = FloatImage::from_dynamic(&img);
    assert_close(
        metrics::ssim(&a.data, &a.data, 64, 96),
        1.0,
        1e-9,
        "ssim self",
    );
}

#[test]
fn ssim_of_two_uniform_images_matches_analytic_value() {
    // Gaussian window over uniform images leaves them uniform, so every
    // window score equals the closed form:
    //   (2·μx·μy + C1)(C2) / (μx² + μy² + C1)(C2)   with σ² = σxy = 0.
    let (mx, my) = (0.25_f64, 0.75_f64);
    let (c1, _c2) = (1e-4_f64, 9e-4_f64);
    let expected = (2.0 * mx * my + c1) / (mx * mx + my * my + c1);

    let a = vec![0.25_f32; 24 * 24 * 3];
    let b = vec![0.75_f32; 24 * 24 * 3];
    assert_close(
        metrics::ssim(&a, &b, 24, 24),
        expected,
        1e-6,
        "ssim uniform",
    );
}

#[test]
fn ssim_is_symmetric_and_bounded() {
    let img_a = FloatImage::from_dynamic(&harness::scene_high_contrast_edge(96, 64));
    let img_b = harness::usm_sharpen(&img_a, 0.8, 0.01);
    let s1 = metrics::ssim(&img_a.data, &img_b.data, 96, 64);
    let s2 = metrics::ssim(&img_b.data, &img_a.data, 96, 64);
    assert_close(s1, s2, 1e-12, "ssim symmetric");
    assert!(s1 <= 1.0 + 1e-9, "ssim must not exceed 1, got {s1}");
    assert!(
        s1 > 0.0,
        "sharpened vs original must stay positive, got {s1}"
    );
}

#[test]
fn ssim_penalizes_inverted_structure() {
    // White noise vs its inverse: the high local variance makes the
    // contrast/structure term dominate, so the mean score goes deeply
    // negative. (A smooth ramp would not: with σ² << C² the C2 stabilization
    // drives every window term toward +1, which is standard SSIM behavior.)
    let w = 64;
    let h = 64;
    let mut rng = Lcg::new(123);
    let mut a = Vec::with_capacity(w * h * 3);
    let mut b = Vec::with_capacity(w * h * 3);
    for _ in 0..w * h {
        let v = rng.next_f32();
        a.extend_from_slice(&[v, v, v]);
        b.extend_from_slice(&[1.0 - v, 1.0 - v, 1.0 - v]);
    }
    let s = metrics::ssim(&a, &b, w, h);
    assert!(s < 0.1, "inverted noise should score very low, got {s}");
}

// ---------------------------------------------------------------------------
// CIEDE2000 (Sharma et al. 2005 dataset) and sRGB → Lab
// ---------------------------------------------------------------------------

#[test]
fn delta_e_2000_matches_published_reference_pairs() {
    // (Lab1, Lab2, expected ΔE00) — Sharma, Wu & Dalal 2005 test data.
    let pairs: [([f64; 3], [f64; 3], f64); 9] = [
        ([50.0, 2.6772, -79.7751], [50.0, 0.0, -82.7485], 2.0425),
        ([50.0, 3.1571, -77.2803], [50.0, 0.0, -82.7485], 2.8615),
        ([50.0, 2.8361, -74.0200], [50.0, 0.0, -82.7485], 3.4412),
        ([50.0, -1.0, 2.0], [50.0, 0.0, 0.0], 2.3669),
        ([50.0, 2.5, 0.0], [73.0, 25.0, -18.0], 27.1492),
        ([50.0, 2.5, 0.0], [61.0, -5.0, 29.0], 22.8977),
        ([50.0, 2.5, 0.0], [56.0, -27.0, -3.0], 31.9030),
        ([50.0, 2.5, 0.0], [58.0, 24.0, 15.0], 19.4535),
        (
            [60.2574, -34.0099, 36.2677],
            [60.4626, -34.1751, 39.4387],
            1.2644,
        ),
    ];
    for (i, (lab1, lab2, expected)) in pairs.iter().enumerate() {
        assert_close(
            metrics::delta_e_2000(*lab1, *lab2),
            *expected,
            1e-4,
            &format!("ciede2000 pair {i}"),
        );
    }
}

#[test]
fn delta_e_2000_is_zero_for_equal_colors() {
    assert_close(
        metrics::delta_e_2000([50.0, 0.0, 0.0], [50.0, 0.0, 0.0]),
        0.0,
        1e-12,
        "dE00 self",
    );
}

#[test]
fn srgb_to_lab_matches_reference_values() {
    // D65 reference values for sRGB primaries.
    let white = metrics::srgb_to_lab([1.0, 1.0, 1.0]);
    // 1e-5 (not 1e-6): the sRGB→XYZ matrix rows are not exactly normalized in
    // f64 (ΣY = 1.0000001), which alone puts white L* at 100.0000038.
    assert_close(white[0], 100.0, 1e-5, "white L*");
    assert_close(white[1], 0.0, 1e-4, "white a*");
    assert_close(white[2], 0.0, 1e-4, "white b*");

    let black = metrics::srgb_to_lab([0.0, 0.0, 0.0]);
    assert_close(black[0], 0.0, 1e-9, "black L*");

    let red = metrics::srgb_to_lab([1.0, 0.0, 0.0]);
    assert_close(red[0], 53.2408, 1e-3, "red L*");
    assert_close(red[1], 80.0925, 1e-3, "red a*");
    assert_close(red[2], 67.2032, 1e-3, "red b*");
}

// ---------------------------------------------------------------------------
// Gradient energy / high-frequency ratio
// ---------------------------------------------------------------------------

#[test]
fn gradient_energy_is_zero_for_constant_plane() {
    let plane = vec![0.5_f32; 32 * 32];
    assert_close(
        metrics::gradient_energy(&plane, 32, 32),
        0.0,
        1e-12,
        "flat energy",
    );
}

#[test]
fn gradient_energy_grows_with_edge_steepness() {
    // Soft edge (2px transition) vs hard edge (1px transition).
    let w = 32;
    let h = 16;
    let mut soft = vec![0.0_f32; w * h];
    let mut hard = vec![0.0_f32; w * h];
    for y in 0..h {
        for x in 0..w {
            soft[y * w + x] = ((x as f32 - 16.0) / 4.0).clamp(0.0, 1.0);
            hard[y * w + x] = if x >= 16 { 1.0 } else { 0.0 };
        }
    }
    assert!(
        metrics::gradient_energy(&hard, w, h) > metrics::gradient_energy(&soft, w, h),
        "hard edge must carry more gradient energy"
    );
}

#[test]
fn high_frequency_ratio_is_one_for_identical_and_detects_sharpening() {
    let img = FloatImage::from_dynamic(&harness::scene_high_contrast_edge(96, 64));
    assert_close(
        metrics::high_frequency_energy_ratio_rgb(&img.data, &img.data, 96, 64),
        1.0,
        1e-12,
        "hf ratio self",
    );
    let sharpened = harness::usm_sharpen(&img, 0.8, 0.01);
    let ratio = metrics::high_frequency_energy_ratio_rgb(&sharpened.data, &img.data, 96, 64);
    assert!(ratio > 1.0, "sharpening must raise hf energy, got {ratio}");
}

// ---------------------------------------------------------------------------
// Content hashes
// ---------------------------------------------------------------------------

#[test]
fn hashes_are_stable_and_dimension_aware() {
    let a = vec![0.5_f32; 8 * 8 * 3];
    let b = vec![0.5_f32 + f32::EPSILON; 8 * 8 * 3];
    let ha = metrics::hash_f32_image(8, 8, &a);
    assert_eq!(
        ha,
        metrics::hash_f32_image(8, 8, &a),
        "hash must be deterministic"
    );
    assert_ne!(
        ha,
        metrics::hash_f32_image(8, 8, &b),
        "value change must change hash"
    );
    assert_ne!(
        ha,
        metrics::hash_f32_image(16, 4, &a),
        "dimensions must affect hash"
    );
    assert_eq!(
        metrics::hash_bytes(b"rapidraw"),
        metrics::hash_bytes(b"rapidraw")
    );
    assert_eq!(
        metrics::hash_u8_image(4, 4, &[128_u8; 48]),
        metrics::hash_u8_image(4, 4, &[128_u8; 48])
    );
}

// ---------------------------------------------------------------------------
// Lanczos3 resampler properties
// ---------------------------------------------------------------------------

#[test]
fn lanczos3_preserves_constant_images() {
    let src = vec![0.42_f32; 64 * 48];
    let out = harness::lanczos3_resize_plane(&src, 64, 48, 24, 18);
    assert_eq!(out.len(), 24 * 18);
    for v in &out {
        assert_close(*v as f64, 0.42, 1e-5, "constant preserved");
    }
}

#[test]
fn lanczos3_upscale_preserves_constant_images() {
    let src = vec![0.77_f32; 8 * 8];
    let out = harness::lanczos3_resize_plane(&src, 8, 8, 32, 32);
    for v in &out {
        assert_close(*v as f64, 0.77, 1e-5, "constant upscale preserved");
    }
}

#[test]
fn lanczos3_impulse_total_response_matches_area_ratio() {
    // The resampler preserves intensity, not total energy: an interior unit
    // impulse must come out with total response ≈ (dw·dh)/(w·h).
    let w: u32 = 64;
    let h: u32 = 64;
    let mut src = vec![0.0_f32; (w * h) as usize];
    src[32 * w as usize + 32] = 1.0;
    let out = harness::lanczos3_resize_plane(&src, w, h, 48, 48);
    let sum: f64 = out.iter().map(|v| *v as f64).sum();
    let expected = (48.0 * 48.0) / (64.0 * 64.0);
    assert_close(sum, expected, 1e-2, "impulse total response");
}

#[test]
fn lanczos3_preserves_the_mean_of_a_ramp() {
    let w = 128;
    let h = 32;
    let src: Vec<f32> = (0..w * h)
        .map(|i| (i % w) as f32 / (w - 1) as f32)
        .collect();
    let in_mean: f64 = src.iter().map(|v| *v as f64).sum::<f64>() / src.len() as f64;
    let out = harness::lanczos3_resize_plane(&src, w, h, 40, 10);
    let out_mean: f64 = out.iter().map(|v| *v as f64).sum::<f64>() / out.len() as f64;
    assert_close(out_mean, in_mean, 1e-3, "ramp mean preserved");
}

// ---------------------------------------------------------------------------
// Curve evaluation (port of shader.wgsl apply_curve)
// ---------------------------------------------------------------------------

#[test]
fn identity_curve_is_exact() {
    let curve = harness::identity_curve();
    for i in 0..=10 {
        let v = i as f32 / 10.0;
        assert_close(
            harness::eval_curve(&curve, v) as f64,
            v as f64,
            1e-6,
            "identity curve",
        );
    }
}

#[test]
fn curve_passes_through_control_points() {
    let curve = vec![
        CurvePoint::new(0.0, 0.0),
        CurvePoint::new(64.0, 32.0),
        CurvePoint::new(192.0, 224.0),
        CurvePoint::new(255.0, 255.0),
    ];
    assert_close(
        harness::eval_curve(&curve, 64.0 / 255.0) as f64,
        32.0 / 255.0,
        1e-6,
        "at 64",
    );
    assert_close(
        harness::eval_curve(&curve, 192.0 / 255.0) as f64,
        224.0 / 255.0,
        1e-6,
        "at 192",
    );
}

#[test]
fn curve_clamps_outside_control_range() {
    let curve = vec![CurvePoint::new(32.0, 40.0), CurvePoint::new(224.0, 200.0)];
    assert_close(
        harness::eval_curve(&curve, 0.0) as f64,
        40.0 / 255.0,
        1e-6,
        "below range",
    );
    assert_close(
        harness::eval_curve(&curve, 1.0) as f64,
        200.0 / 255.0,
        1e-6,
        "above range",
    );
}

#[test]
fn monotone_curve_stays_monotone() {
    let curve = vec![
        CurvePoint::new(0.0, 0.0),
        CurvePoint::new(64.0, 56.0),
        CurvePoint::new(128.0, 128.0),
        CurvePoint::new(192.0, 206.0),
        CurvePoint::new(255.0, 255.0),
    ];
    let mut prev = -1.0_f64;
    for i in 0..=255 {
        let v = harness::eval_curve(&curve, i as f32 / 255.0) as f64;
        assert!(
            v >= prev - 1e-6,
            "curve must be monotone at {i}: {v} < {prev}"
        );
        prev = v;
    }
}

#[test]
fn curve_tangent_suppression_limits_overshoot() {
    // A curve with a local maximum: the WGSL zero-crossing tangent rule must
    // flatten the peak instead of overshooting beyond the control point.
    let curve = vec![
        CurvePoint::new(0.0, 0.0),
        CurvePoint::new(128.0, 200.0),
        CurvePoint::new(255.0, 60.0),
    ];
    let mut max_v = 0.0_f64;
    for i in 0..=255 {
        let v = harness::eval_curve(&curve, i as f32 / 255.0) as f64;
        max_v = max_v.max(v);
    }
    assert!(
        max_v <= 200.0 / 255.0 + 1e-6,
        "tangent suppression must prevent overshoot, got {max_v}"
    );
    assert_close(
        harness::eval_curve(&curve, 1.0) as f64,
        60.0 / 255.0,
        1e-6,
        "endpoint",
    );
}

#[test]
fn curve_with_fewer_than_two_points_is_identity() {
    for i in 0..=10 {
        let v = i as f32 / 10.0;
        assert_close(
            harness::eval_curve(&[], v) as f64,
            v as f64,
            1e-9,
            "empty curve",
        );
        assert_close(
            harness::eval_curve(&[CurvePoint::new(10.0, 90.0)], v) as f64,
            v as f64,
            1e-9,
            "single point curve",
        );
    }
}

// ---------------------------------------------------------------------------
// Tetrahedral LUT (port of shader.wgsl sample_lut_tetrahedral)
// ---------------------------------------------------------------------------

#[test]
fn identity_lut_is_exact_everywhere() {
    // The identity map is linear, and tetrahedral interpolation reproduces
    // linear maps exactly.
    let lut = TetrahedralLut::from_fn(33, |c| c);
    let mut rng = Lcg::new(42);
    for _ in 0..500 {
        let c = [rng.next_f32(), rng.next_f32(), rng.next_f32()];
        let out = lut.interpolate(c);
        for ch in 0..3 {
            assert_close(out[ch] as f64, c[ch] as f64, 1e-6, "identity lut");
        }
    }
}

#[test]
fn lut_reproduces_grid_nodes_exactly() {
    let lut = TetrahedralLut::from_fn(17, |c| [c[1], c[0], c[2]]); // swap R/G
    let n = 16.0_f32;
    for i in 0..=16 {
        for j in 0..=16 {
            let c = [i as f32 / n, j as f32 / n, 0.25];
            let out = lut.interpolate(c);
            assert_close(out[0] as f64, c[1] as f64, 1e-6, "node swap r");
            assert_close(out[1] as f64, c[0] as f64, 1e-6, "node swap g");
            assert_close(out[2] as f64, c[2] as f64, 1e-6, "node swap b");
        }
    }
}

#[test]
fn lut_interpolation_matches_nonlinear_transfer_within_tolerance() {
    // A nonlinear (sqrt) LUT at 33³. For a per-channel transfer the
    // tetrahedral result reduces to 1-D linear interpolation on the grid, so
    // the worst-case error is bounded by |f''|·h²/8 (~1.2e-3 at x ≥ 0.1).
    // Inputs stay ≥ 0.1 because sqrt is too steep near zero for any grid.
    let lut = TetrahedralLut::from_fn(33, |c| [c[0].sqrt(), c[1].sqrt(), c[2].sqrt()]);
    let mut rng = Lcg::new(7);
    let mut worst = 0.0_f64;
    for _ in 0..300 {
        let c = [
            0.1 + 0.9 * rng.next_f32(),
            0.1 + 0.9 * rng.next_f32(),
            0.1 + 0.9 * rng.next_f32(),
        ];
        let out = lut.interpolate(c);
        for ch in 0..3 {
            let err = (out[ch] as f64 - (c[ch] as f64).sqrt()).abs();
            worst = worst.max(err);
        }
    }
    assert!(
        worst < 0.005,
        "sqrt LUT interpolation error too large: {worst}"
    );
}

#[test]
fn lut_clamps_out_of_range_input() {
    let lut = TetrahedralLut::from_fn(9, |c| c);
    let out = lut.interpolate([-0.5, 1.5, 0.5]);
    assert_close(out[0] as f64, 0.0, 1e-6, "clamp low");
    assert_close(out[1] as f64, 1.0, 1e-6, "clamp high");
}
