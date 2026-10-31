//! Performance baseline skeleton (plan §6, M0-4 "性能基线骨架").
//!
//! This test is `#[ignore]`d **by design**: it only measures and prints a
//! table of per-stage CPU timings and makes no timing assertions, so it can
//! never flake a normal CI run. Run it explicitly when touching a hot path:
//!
//! ```sh
//! cargo test --release --test performance_skeleton -- --ignored --nocapture
//! ```
//!
//! The table covers the deterministic CPU reference pipeline (`src/testing/`)
//! at "export" resolution (1200×675), the objective metrics and the
//! production geometry entry points at 3000×2000. Numbers are machine- and
//! build-dependent — compare relative changes on the same machine only.

mod common;

use common::testing::harness::{self, CurvePoint, FloatImage, ReferenceParams};
use common::testing::metrics;
use rapidraw_lib::{
    apply_all_transformations, apply_orientation_and_flip, apply_spatial_transformations,
};
use serde_json::json;
use std::hint::black_box;
use std::time::Instant;

struct Row {
    group: &'static str,
    name: &'static str,
    ms: f64,
}

fn bench(group: &'static str, name: &'static str, iters: u32, f: impl Fn()) -> Row {
    f(); // warm-up (allocator caches, lazy statics, page faults)
    let start = Instant::now();
    for _ in 0..iters {
        f();
    }
    Row {
        group,
        name,
        ms: start.elapsed().as_secs_f64() / f64::from(iters) * 1000.0,
    }
}

fn print_table(rows: &[Row]) {
    println!("{:<14} {:<36} {:>12}", "group", "stage", "ms/call");
    println!("{}", "-".repeat(66));
    for row in rows {
        println!("{:<14} {:<36} {:>12.3}", row.group, row.name, row.ms);
    }
}

#[test]
#[ignore = "perf skeleton: run explicitly with --ignored --nocapture (measures, never asserts)"]
fn cpu_pipeline_baseline() {
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
    let card = FloatImage::from_dynamic(&harness::scene_color_card(96, 64));
    let small = harness::lanczos3_resize(&base, 240, 135);
    let big = harness::scene_backlit_sky(3000, 2000);

    let mut rows = Vec::new();

    // --- Reference CPU pipeline (src/testing/harness.rs) --------------------
    rows.push(bench("scene generation", "harness", 5, || {
        black_box(harness::scene_portrait(W, H));
    }));
    rows.push(bench("from_dynamic (decode)", "harness", 5, || {
        let scene = harness::scene_portrait(W, H);
        black_box(FloatImage::from_dynamic(&scene));
    }));
    rows.push(bench("render tone-only", "harness", 5, || {
        black_box(harness::render_reference(&base, &tone_params));
    }));
    rows.push(bench("render tone+USM+grain", "harness", 5, || {
        black_box(harness::render_reference(&base, &full_params));
    }));
    rows.push(bench("lanczos3 → 384×216", "harness", 5, || {
        black_box(harness::lanczos3_resize(&base, 384, 216));
    }));

    // --- Objective metrics (src/testing/metrics.rs) -------------------------
    rows.push(bench("ssim (240×135)", "metrics", 20, || {
        black_box(metrics::ssim(&small.data, &small.data, 240, 135));
    }));
    rows.push(bench("mean ΔE2000 (96×64)", "metrics", 20, || {
        black_box(metrics::mean_delta_e_2000(
            &card.data, &card.data, 96, 64, 1,
        ));
    }));
    rows.push(bench("hash_u8_image (1200×675×3)", "metrics", 20, || {
        let bytes = base.to_rgb8_samples();
        black_box(metrics::hash_u8_image(W, H, &bytes));
    }));

    // --- Production geometry entry points (3000×2000) -----------------------
    rows.push(bench("rotate90 (3000×2000)", "lib geometry", 3, || {
        black_box(apply_orientation_and_flip(
            &big,
            &json!({ "orientationSteps": 1 }),
        ));
    }));
    rows.push(bench("rotate 15° + crop", "lib geometry", 3, || {
        black_box(apply_spatial_transformations(
            &big,
            &json!({
                "rotation": 15.0,
                "crop": { "x": 100.0, "y": 80.0, "width": 2400.0, "height": 1600.0 }
            }),
        ));
    }));
    rows.push(bench(
        "all transformations (no-op)",
        "lib geometry",
        3,
        || {
            black_box(apply_all_transformations(&big, &json!({})));
        },
    ));
    rows.push(bench(
        "all transformations (warp)",
        "lib geometry",
        3,
        || {
            black_box(apply_all_transformations(
                &big,
                &json!({ "transformDistortion": 12.0, "transformScale": 103.0 }),
            ));
        },
    ));

    println!(
        "\nCPU performance baseline ({}×{} reference scene, 3000×2000 geometry scene)\n\
         Measured values only — no assertions; compare runs on the same machine.\n",
        W, H
    );
    print_table(&rows);
}
