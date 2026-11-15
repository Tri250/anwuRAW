//! Performance regression gate (delivery item ③: 性能基准纳入发布门禁).
//!
//! Unlike `performance_skeleton.rs` (measures and prints, never asserts),
//! this gate is wired into CI (`ci.yml` → `performance-gate`, release build)
//! and enforces two classes of budgets that are robust across runner
//! hardware:
//!
//! 1. **Structural complexity ratios** — the cost of a composed stage
//!    relative to a cheaper sibling *on the same machine in the same run*
//!    (machine-independent by construction):
//!    - full render (tone + USM + grain) ≤ 10× tone-only (catches
//!      accidental per-pixel allocations / quadratic blur regressions);
//!    - rotate90 ≤ 10× the no-op geometry pass (rotation is memcpy-bound);
//!    - warp geometry ≤ 60× the no-op pass (catches unbounded sampling
//!      loops — healthy warp is ~10–30× copy);
//! 2. **Catastrophic absolute ceilings** (release build; calibrated to be
//!    10–100× above healthy timings so only severe regressions trip, never
//!    runner jitter):
//!    - 1200×675 tone render < 1000 ms, full render < 2500 ms;
//!    - 3000×2000 no-op geometry < 2000 ms, rotate90 < 3000 ms,
//!      warp < 8000 ms;
//!    - metrics: SSIM (240×135) < 800 ms, ΔE2000 (96×64) < 500 ms,
//!      hash (1200×675×3) < 800 ms.
//!
//! Run in CI with `cargo test --release --test performance_gate`.
//! The budgets are intentionally release-only: `#[cfg_attr(debug_assertions, ignore)]`
//! keeps `cargo test` (debug) green locally, mirroring how the golden suite
//! is managed. When touching a hot path, also run the verbose skeleton:
//! `cargo test --release --test performance_skeleton -- --ignored --nocapture`.

mod common;

use common::testing::harness::{self, CurvePoint, FloatImage, ReferenceParams};
use rapidraw_lib::{apply_all_transformations, apply_orientation_and_flip};
use serde_json::json;
use std::hint::black_box;
use std::time::Instant;

fn median_ms(iters: u32, f: impl Fn()) -> f64 {
    f(); // warm-up (allocator caches, lazy statics, page faults)
    let mut samples = Vec::with_capacity(iters as usize);
    for _ in 0..iters {
        let start = Instant::now();
        f();
        samples.push(start.elapsed().as_secs_f64() * 1000.0);
    }
    samples.sort_by(|a, b| a.partial_cmp(b).expect("NaN elapsed time"));
    samples[samples.len() / 2]
}

fn print_rows(rows: &[(&str, f64)]) {
    println!("{:<44} {:>12}", "stage", "ms/call (median)");
    println!("{}", "-".repeat(58));
    for (name, ms) in rows {
        println!("{:<44} {:>12.3}", name, ms);
    }
}

#[cfg_attr(
    debug_assertions,
    ignore = "budgets are calibrated for release builds; run with: cargo test --release --test performance_gate"
)]
#[test]
fn pipeline_render_budgets_hold() {
    const W: u32 = 1200;
    const H: u32 = 675;

    let tone_params = ReferenceParams {
        exposure_gain: 1.1,
        wb_gains: [1.03, 1.0, 0.97],
        saturation: 1.1,
        contrast: 0.15,
        curve: vec![
            CurvePoint::new(0.0, 0.0),
            CurvePoint::new(128.0, 140.0),
            CurvePoint::new(255.0, 255.0),
        ],
        ..ReferenceParams::neutral()
    };
    let mut full_params = tone_params.clone();
    full_params.usm_amount = 0.5;
    full_params.usm_threshold = 0.02;
    full_params.grain_amount = 0.04;

    let base = FloatImage::from_dynamic(&harness::scene_portrait(W, H));

    let tone_ms = median_ms(9, || {
        black_box(harness::render_reference(&base, &tone_params));
    });
    let full_ms = median_ms(9, || {
        black_box(harness::render_reference(&base, &full_params));
    });

    print_rows(&[
        ("render tone-only (1200×675)", tone_ms),
        ("render tone+USM+grain (1200×675)", full_ms),
    ]);

    assert!(
        tone_ms < 1000.0,
        "tone-only render (1200×675) took {tone_ms:.1} ms — catastrophic regression or debug build (ceiling 1000 ms)"
    );
    assert!(
        full_ms < 2500.0,
        "tone+USM+grain render (1200×675) took {full_ms:.1} ms — catastrophic regression or debug build (ceiling 2500 ms)"
    );
    assert!(
        full_ms <= tone_ms * 10.0 + 5.0,
        "structural regression: tone+USM+grain ({full_ms:.1} ms) exceeds 10× tone-only ({tone_ms:.1} ms) — \
         suspect per-pixel allocation or quadratic blur introduced in a composed stage"
    );
}

#[cfg_attr(
    debug_assertions,
    ignore = "budgets are calibrated for release builds; run with: cargo test --release --test performance_gate"
)]
#[test]
fn geometry_budgets_hold() {
    let big = harness::scene_backlit_sky(3000, 2000);

    let noop_ms = median_ms(7, || {
        black_box(apply_all_transformations(&big, &json!({})));
    });
    let rotate_ms = median_ms(7, || {
        black_box(apply_orientation_and_flip(
            &big,
            &json!({ "orientationSteps": 1 }),
        ));
    });
    let warp_ms = median_ms(5, || {
        black_box(apply_all_transformations(
            &big,
            &json!({ "transformDistortion": 12.0, "transformScale": 103.0 }),
        ));
    });

    print_rows(&[
        ("all transformations no-op (3000×2000)", noop_ms),
        ("rotate90 (3000×2000)", rotate_ms),
        ("warp distortion+scale (3000×2000)", warp_ms),
    ]);

    assert!(
        noop_ms < 2000.0,
        "no-op geometry pass (3000×2000) took {noop_ms:.1} ms — catastrophic regression or debug build (ceiling 2000 ms)"
    );
    assert!(
        rotate_ms < 3000.0,
        "rotate90 (3000×2000) took {rotate_ms:.1} ms — catastrophic regression or debug build (ceiling 3000 ms)"
    );
    assert!(
        rotate_ms <= noop_ms * 10.0 + 5.0,
        "structural regression: rotate90 ({rotate_ms:.1} ms) exceeds 10× no-op ({noop_ms:.1} ms) — \
         rotation should stay memcpy-bound"
    );
    assert!(
        warp_ms < 8000.0,
        "warp geometry (3000×2000) took {warp_ms:.1} ms — catastrophic regression or debug build (ceiling 8000 ms)"
    );
    assert!(
        warp_ms <= noop_ms * 60.0 + 5.0,
        "structural regression: warp ({warp_ms:.1} ms) exceeds 60× no-op ({noop_ms:.1} ms) — \
         suspect unbounded sampling loop in the resample path"
    );
}

#[cfg_attr(
    debug_assertions,
    ignore = "budgets are calibrated for release builds; run with: cargo test --release --test performance_gate"
)]
#[test]
fn metrics_budgets_hold() {
    use common::testing::metrics;

    let base = FloatImage::from_dynamic(&harness::scene_portrait(1200, 675));
    let small = harness::lanczos3_resize(&base, 240, 135);
    let card = FloatImage::from_dynamic(&harness::scene_color_card(96, 64));
    let bytes = base.to_rgb8_samples();

    let ssim_ms = median_ms(11, || {
        black_box(metrics::ssim(&small.data, &small.data, 240, 135));
    });
    let delta_ms = median_ms(11, || {
        black_box(metrics::mean_delta_e_2000(&card.data, &card.data, 96, 64, 1));
    });
    let hash_ms = median_ms(11, || {
        black_box(metrics::hash_u8_image(1200, 675, &bytes));
    });

    print_rows(&[
        ("ssim (240×135)", ssim_ms),
        ("mean ΔE2000 (96×64)", delta_ms),
        ("hash_u8_image (1200×675×3)", hash_ms),
    ]);

    assert!(
        ssim_ms < 800.0,
        "SSIM (240×135) took {ssim_ms:.1} ms — catastrophic regression or debug build (ceiling 800 ms)"
    );
    assert!(
        delta_ms < 500.0,
        "ΔE2000 (96×64) took {delta_ms:.1} ms — catastrophic regression or debug build (ceiling 500 ms)"
    );
    assert!(
        hash_ms < 800.0,
        "image hash (1200×675×3) took {hash_ms:.1} ms — catastrophic regression or debug build (ceiling 800 ms)"
    );
}
