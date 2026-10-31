//! Golden rendering regression tests (plan §6, M0-1 "Golden 渲染回归").
//!
//! Concept
//! -------
//! The six fixed scene classes from the plan (色卡 / 14 级灰阶 / 高反差边缘 /
//! 天空·逆光 / 人像 / ISO 噪声合成) are generated **in-test** (no binary
//! fixtures are committed) and rendered through the deterministic pure-CPU
//! reference pipeline in `src/testing/harness.rs` with fixed parameter
//! snapshots. The 8-bit outputs are pinned by blake3 hashes stored as text in
//! `tests/golden/golden_snapshot.json`.
//!
//! Generation / regeneration
//! -------------------------
//! ```sh
//! # Rewrite the snapshot from current behavior (review the diff!):
//! cargo test -p RapidRAW --features golden-gen -- --ignored --nocapture golden
//! ```
//! The generator is the feature-gated, `#[ignore]`d test at the bottom of
//! this file. Deleting `golden_snapshot.json` and running the normal suite
//! has the same effect (bootstrap mode, see below) but is not the preferred
//! workflow.
//!
//! CI gating
//! ---------
//! 1. `golden_snapshot_matches_pinned_hashes` fails on any hash drift with
//!    review instructions.
//! 2. The CI workflow runs `git diff --exit-code src-tauri/tests/golden/`
//!    after `cargo test`, so a bootstrapped (not yet committed) snapshot
//!    breaks the build until it is committed deliberately.
//!
//! Determinism
//! -----------
//! The hashed path uses only IEEE-754-exact arithmetic (see the harness
//! docs), so hashes are stable across platforms and builds. Perceptual
//! checks that must stay tolerance-based (PSNR / SSIM / ΔE2000, plan M0-2)
//! live in `golden_metric_invariants` and never compare hashes.

mod common;

use std::path::PathBuf;

use common::testing::harness::{self, CurvePoint, FloatImage, ReferenceParams};
use common::testing::metrics;
use image::DynamicImage;
use serde::Deserialize;

const SNAPSHOT_VERSION: u32 = 1;

#[derive(Deserialize)]
struct GoldenSnapshot {
    version: u32,
    cases: Vec<GoldenCaseRef>,
}

#[derive(Deserialize)]
struct GoldenCaseRef {
    name: String,
    hash: String,
}

struct GoldenCase {
    name: String,
    scene: DynamicImage,
    params: ReferenceParams,
}

fn assert_close(actual: f64, expected: f64, tol: f64, what: &str) {
    assert!(
        (actual - expected).abs() <= tol,
        "{what}: expected {expected}, got {actual} (tol {tol})"
    );
}

fn punch_params() -> ReferenceParams {
    ReferenceParams {
        exposure_gain: 1.25,
        wb_gains: [1.06, 1.0, 0.94],
        saturation: 1.18,
        contrast: 0.25,
        curve: vec![
            CurvePoint::new(0.0, 0.0),
            CurvePoint::new(64.0, 56.0),
            CurvePoint::new(128.0, 128.0),
            CurvePoint::new(192.0, 206.0),
            CurvePoint::new(255.0, 255.0),
        ],
        usm_amount: 0.55,
        usm_threshold: 0.02,
        grain_amount: 0.03,
        grain_seed: 7,
    }
}

fn soft_params() -> ReferenceParams {
    ReferenceParams {
        exposure_gain: 0.85,
        wb_gains: [0.98, 1.0, 1.03],
        saturation: 0.7,
        contrast: -0.1,
        curve: vec![
            CurvePoint::new(0.0, 0.0),
            CurvePoint::new(128.0, 168.0),
            CurvePoint::new(255.0, 255.0),
        ],
        usm_amount: 0.0,
        usm_threshold: 0.0,
        grain_amount: 0.0,
        grain_seed: 1,
    }
}

/// The golden matrix: 6 scene classes × 3 parameter snapshots.
fn golden_cases() -> Vec<GoldenCase> {
    let scenes: [(&str, DynamicImage); 6] = [
        ("color_card", harness::scene_color_card(96, 64)),
        ("gray_ramp", harness::scene_gray_ramp(120, 40)),
        (
            "high_contrast_edge",
            harness::scene_high_contrast_edge(96, 64),
        ),
        ("backlit_sky", harness::scene_backlit_sky(64, 96)),
        ("portrait", harness::scene_portrait(80, 100)),
        ("iso_noise", harness::scene_iso_noise(64, 64, 1234, 0.08)),
    ];
    let mut cases = Vec::with_capacity(scenes.len() * 3);
    for (scene_name, scene) in scenes {
        for (suffix, params) in [
            ("neutral", ReferenceParams::neutral()),
            ("punch", punch_params()),
            ("soft", soft_params()),
        ] {
            cases.push(GoldenCase {
                name: format!("{scene_name}/{suffix}"),
                scene: scene.clone(),
                params,
            });
        }
    }
    cases
}

/// Render one case and return its 8-bit content hash (dimensions mixed in).
fn render_hash(case: &GoldenCase) -> (String, FloatImage, FloatImage) {
    let base = FloatImage::from_dynamic(&case.scene);
    let rendered = harness::render_reference(&base, &case.params);
    let bytes = rendered.to_rgb8_samples();
    let hash = metrics::hash_u8_image(rendered.width, rendered.height, &bytes);
    (hash, base, rendered)
}

fn snapshot_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/golden/golden_snapshot.json")
}

fn write_snapshot(cases: &[GoldenCase]) {
    let mut json = format!("{{\n  \"version\": {SNAPSHOT_VERSION},\n  \"cases\": [\n");
    let entries: Vec<String> = cases
        .iter()
        .map(|c| {
            let (hash, _, _) = render_hash(c);
            format!("    {{ \"name\": \"{}\", \"hash\": \"{}\" }}", c.name, hash)
        })
        .collect();
    json.push_str(&entries.join(",\n"));
    json.push_str("\n  ]\n}\n");

    let path = snapshot_path();
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).expect("create golden dir");
    }
    std::fs::write(&path, json).expect("write golden snapshot");
}

// ---------------------------------------------------------------------------

/// The core golden gate: current render hashes must match the snapshot.
///
/// If the snapshot file is missing (fresh checkout), it is bootstrapped from
/// current behavior: the test writes it, prints a loud warning and passes.
/// CI enforces `git diff --exit-code` on the golden directory so the file
/// gets committed instead of silently re-baselining.
#[test]
fn golden_snapshot_matches_pinned_hashes() {
    let cases = golden_cases();

    // Identity invariant, independent of the snapshot: the neutral pipeline
    // must be an exact byte-level identity.
    for case in &cases {
        if case.name.ends_with("/neutral") {
            let (hash, base, rendered) = render_hash(case);
            let input_hash =
                metrics::hash_u8_image(rendered.width, rendered.height, &base.to_rgb8_samples());
            assert_eq!(
                hash, input_hash,
                "neutral pipeline must be identity for {}",
                case.name
            );
        }
    }

    let path = snapshot_path();
    if !path.exists() {
        write_snapshot(&cases);
        println!(
            "\nWARNING: golden snapshot did not exist and was bootstrapped at {}\n\
             Review `git diff` and commit it; later drift is a hard failure.\n",
            path.display()
        );
        return;
    }

    let content = std::fs::read_to_string(&path).expect("read golden snapshot");
    let snapshot: GoldenSnapshot = serde_json::from_str(&content).expect("parse golden snapshot");
    assert_eq!(
        snapshot.version, SNAPSHOT_VERSION,
        "snapshot version mismatch; regenerate with --features golden-gen"
    );

    let pinned: std::collections::HashMap<&str, &str> = snapshot
        .cases
        .iter()
        .map(|c| (c.name.as_str(), c.hash.as_str()))
        .collect();

    let mut failures = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for case in &cases {
        seen.insert(case.name.as_str());
        let Some(expected) = pinned.get(case.name.as_str()) else {
            failures.push(format!(
                "MISSING in snapshot: {} (regenerate snapshot)",
                case.name
            ));
            continue;
        };
        let (actual, _, _) = render_hash(case);
        if actual != *expected {
            failures.push(format!(
                "DRIFT: {}\n  pinned:  {expected}\n  current: {actual}\n\
                 If the change is intended, regenerate the snapshot with:\n  \
                 cargo test -p RapidRAW --features golden-gen -- --ignored --nocapture golden",
                case.name
            ));
        }
    }
    for name in pinned.keys() {
        if !seen.contains(name) {
            failures.push(format!(
                "STALE snapshot entry: {name} (remove by regenerating)"
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "golden rendering regression ({} case(s)):\n{}",
        failures.len(),
        failures.join("\n")
    );
}

/// Tolerance-based invariants that must hold regardless of hashes
/// (plan M0-2 "客观指标测试" entries that apply to the reference pipeline).
#[test]
fn golden_metric_invariants() {
    let cases = golden_cases();

    for case in &cases {
        let (_, base, rendered) = render_hash(case);
        let out: Vec<f32> = rendered
            .to_rgb8_samples()
            .iter()
            .map(|v| *v as f32 / 255.0)
            .collect();
        let base_q: Vec<f32> = base
            .to_rgb8_samples()
            .iter()
            .map(|v| *v as f32 / 255.0)
            .collect();

        match case.name.as_str() {
            // The neutral pipeline must be a float-level identity.
            name if name.ends_with("/neutral") => {
                assert_close(
                    metrics::max_delta(&rendered.data, &base.data) as f64,
                    0.0,
                    1e-9,
                    &format!("neutral float identity for {name}"),
                );
                assert!(
                    metrics::psnr(&out, &base_q).is_infinite(),
                    "neutral 8-bit output must equal the 8-bit input for {name}"
                );
            }
            // Sharpening must raise edge energy on the high-contrast scene.
            "high_contrast_edge/punch" => {
                let hf = metrics::high_frequency_energy_ratio_rgb(&out, &base.data, 96, 64);
                assert!(
                    hf > 1.0,
                    "punch params must sharpen the edge scene, hf ratio {hf}"
                );
            }
            // Grayscale ordering must survive any parameter snapshot. Band
            // means are compared instead of raw pixels: the punch snapshot
            // adds grain, which breaks pixel-wise monotonicity by design.
            "gray_ramp/neutral" | "gray_ramp/punch" | "gray_ramp/soft" => {
                const RAMP_LEVELS: u32 = 14;
                let w = rendered.width;
                let w_us = w as usize;
                let mut sums = [0.0_f64; RAMP_LEVELS as usize];
                let mut counts = [0.0_f64; RAMP_LEVELS as usize];
                for y in 0..rendered.height as usize {
                    for x in 0..w_us {
                        let band = (x as u32 * RAMP_LEVELS) / w;
                        sums[band as usize] += out[(y * w_us + x) * 3] as f64;
                        counts[band as usize] += 1.0;
                    }
                }
                let means: Vec<f64> = sums.iter().zip(counts.iter()).map(|(s, c)| s / c).collect();
                // Top bands can saturate to the same plateau, where USM halo
                // and grain jitter legitimately order means by ~1e-5; the
                // tolerance stays far below the ramp step (1/13 ≈ 0.077).
                for (i, pair) in means.windows(2).enumerate() {
                    assert!(
                        pair[1] >= pair[0] - 1e-3,
                        "gray ramp band means must stay monotone for {} (band {i}: {} -> {}, means {:?})",
                        case.name,
                        pair[0],
                        pair[1],
                        means
                    );
                }
            }
            // ISO noise: sharpening must amplify flat-field noise energy
            // (the flag future denoise work must turn around).
            "iso_noise/punch" => {
                let hf = metrics::high_frequency_energy_ratio_rgb(&out, &base.data, 64, 64);
                assert!(hf > 1.0, "USM must amplify noise energy, hf ratio {hf}");
            }
            _ => {}
        }
    }

    // Color fidelity: the neutral pipeline must reproduce every color-card
    // patch exactly (ΔE2000 = 0); warm WB gains must produce a visible,
    // bounded warm shift (mean ΔE2000 > 2).
    let card = FloatImage::from_dynamic(&harness::scene_color_card(96, 64));
    let neutral = harness::render_reference(&card, &ReferenceParams::neutral());
    let d_e_identity = metrics::mean_delta_e_2000(&neutral.data, &card.data, 96, 64, 1);
    assert_close(d_e_identity, 0.0, 1e-9, "color card identity ΔE2000");

    let mut warm = ReferenceParams::neutral();
    warm.wb_gains = [1.1, 1.0, 0.9];
    let warmed = harness::render_reference(&card, &warm);
    let d_e_warm = metrics::mean_delta_e_2000(&warmed.data, &neutral.data, 96, 64, 1);
    assert!(
        d_e_warm > 2.0,
        "warm WB must shift color visibly, ΔE2000 {d_e_warm}"
    );

    // Banding stimulus (plan R5-3 metric): after a non-trivial render, 8-bit
    // quantization of the smooth sky gradient must stay above the 45 dB PSNR
    // floor. The soft snapshot keeps every channel strictly inside [0, 1]
    // (no clamp error), so the measured error is pure 8-bit quantization.
    let sky = FloatImage::from_dynamic(&harness::scene_backlit_sky(64, 512));
    let rendered = harness::render_reference(&sky, &soft_params());
    let quantized: Vec<f32> = rendered
        .to_rgb8_samples()
        .iter()
        .map(|v| *v as f32 / 255.0)
        .collect();
    let banding_psnr = metrics::psnr(&quantized, &rendered.data);
    assert!(
        banding_psnr >= 45.0,
        "8-bit sky gradient PSNR {banding_psnr:.2} dB below the 45 dB floor"
    );
}

// ---------------------------------------------------------------------------
// Snapshot generation (feature-gated, run explicitly)
// ---------------------------------------------------------------------------

#[cfg(feature = "golden-gen")]
mod snapshot_gen {
    use super::*;

    #[test]
    #[ignore = "generator: cargo test -p RapidRAW --features golden-gen -- --ignored --nocapture golden"]
    fn golden_generate_snapshot() {
        let cases = golden_cases();
        write_snapshot(&cases);
        println!("golden snapshot written to {}", snapshot_path().display());
        for case in &cases {
            let (hash, _, _) = render_hash(case);
            println!("{:<32} {}", case.name, hash);
        }
    }
}
