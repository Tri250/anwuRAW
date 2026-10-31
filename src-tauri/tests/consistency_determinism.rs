//! Consistency and determinism tests (plan §6, M0-3 "一致性测试") plus the
//! XMP → preset conversion round-trip.
//!
//! Three layers:
//!
//! 1. Production CPU geometry paths (exported through the crate root):
//!    golden-by-construction orientation checks, crop/dimension oracle math
//!    and hash-based run-to-run determinism (same input ⇒ identical output).
//! 2. XMP import (`src/preset_converter.rs`): the module is private in
//!    `lib.rs`, so it is compiled directly into this test binary via
//!    `#[path]` against two small shim modules (`file_management::Preset`,
//!    `white_balance` constants) that are pinned to the real sources by a
//!    dedicated sync test below.
//! 3. Dual-resolution consistency: the same reference render at "export" and
//!    "preview" resolution (same 3.125× ratio as 6000 px → 1920 px) must
//!    agree after normalization to a common size (SSIM gate, plan M0-3).

mod common;

// --- Shims for the `#[path]`-included preset_converter ----------------------
// `preset_converter.rs` references `crate::file_management::Preset` and the
// white-balance constants; both are private in the real crate. The replicas
// below must be updated whenever the real definitions change — the
// `preset_shim_stays_in_sync_with_sources` test turns drift into a failure.

mod file_management {
    use serde::{Deserialize, Serialize};
    use serde_json::Value;

    /// Exact replica of `Preset` in `src-tauri/src/file_management.rs`.
    #[derive(Serialize, Deserialize, Debug, Clone)]
    pub struct Preset {
        pub id: String,
        pub name: String,
        pub adjustments: Value,
        #[serde(rename = "includeMasks", skip_serializing_if = "Option::is_none")]
        pub include_masks: Option<bool>,
        #[serde(
            rename = "includeCropTransform",
            skip_serializing_if = "Option::is_none"
        )]
        pub include_crop_transform: Option<bool>,
        #[serde(rename = "presetType", skip_serializing_if = "Option::is_none")]
        pub preset_type: Option<String>,
    }
}

mod white_balance {
    /// Mirrors `MIRED_PER_RELATIVE_UNIT` in `src-tauri/src/white_balance.rs`.
    pub const MIRED_PER_RELATIVE_UNIT: f64 = 1.5;
    /// Mirrors `TINT_PER_RELATIVE_UNIT` in `src-tauri/src/white_balance.rs`.
    pub const TINT_PER_RELATIVE_UNIT: f64 = 1.5;
}

#[path = "../src/preset_converter.rs"]
mod preset_converter;

use common::testing::harness::{self, CurvePoint, FloatImage, ReferenceParams};
use common::testing::metrics;
use image::{DynamicImage, GenericImageView, Rgb, RgbImage};
use rapidraw_lib::{
    apply_all_transformations, apply_orientation_and_flip, apply_spatial_transformations,
    transformed_dimensions,
};
use serde_json::json;
use uuid::Uuid;

/// Deterministic synthetic test image (no binary fixtures are committed).
fn synthetic_image(width: u32, height: u32) -> DynamicImage {
    let buf = RgbImage::from_fn(width, height, |x, y| {
        Rgb([
            ((x * 5 + y * 11) % 256) as u8,
            ((x * 13 + y * 3) % 256) as u8,
            ((x + y) % 256) as u8,
        ])
    });
    DynamicImage::ImageRgb8(buf)
}

fn hash_image(img: &DynamicImage) -> String {
    metrics::hash_u8_image(img.width(), img.height(), &img.to_rgb8().into_raw())
}

// ---------------------------------------------------------------------------
// Geometry: golden-by-construction orientation checks
// ---------------------------------------------------------------------------

#[test]
fn rotate90_matches_clockwise_reference_mapping() {
    let orig_buf = RgbImage::from_fn(3, 2, |x, y| Rgb([(y * 10 + x) as u8, 40, 80]));
    let orig = DynamicImage::ImageRgb8(orig_buf.clone());

    let out = apply_orientation_and_flip(&orig, &json!({ "orientationSteps": 1 }));
    assert_eq!(
        out.dimensions(),
        (2, 3),
        "90° rotation must swap dimensions"
    );

    // Clockwise mapping: out(x, y) = orig(y, H - 1 - x).
    let expected = RgbImage::from_fn(2, 3, |x, y| *orig_buf.get_pixel(y, 1 - x));
    assert_eq!(out.to_rgb8().into_raw(), expected.into_raw());
}

#[test]
fn rotate180_matches_reference_mapping_and_flip_pair() {
    let orig_buf = RgbImage::from_fn(5, 3, |x, y| Rgb([(y * 20 + x) as u8, 9, 200]));
    let orig = DynamicImage::ImageRgb8(orig_buf.clone());

    // 180°: out(x, y) = orig(W - 1 - x, H - 1 - y).
    let expected = RgbImage::from_fn(5, 3, |x, y| *orig_buf.get_pixel(4 - x, 2 - y));

    let rotated = apply_orientation_and_flip(&orig, &json!({ "orientationSteps": 2 }));
    assert_eq!(rotated.to_rgb8().into_raw(), expected.clone().into_raw());

    // flipHorizontal + flipVertical is the same point map as a 180° rotation.
    let flipped = apply_orientation_and_flip(
        &orig,
        &json!({ "flipHorizontal": true, "flipVertical": true }),
    );
    assert_eq!(flipped.to_rgb8().into_raw(), expected.into_raw());
}

#[test]
fn orientation_applied_twice_returns_the_original() {
    let orig = synthetic_image(17, 9);
    let once = apply_orientation_and_flip(&orig, &json!({ "orientationSteps": 2 }));
    let twice = apply_orientation_and_flip(once, &json!({ "orientationSteps": 2 }));
    assert_eq!(hash_image(&orig), hash_image(&twice));
}

#[test]
fn transformed_dimensions_follows_orientation_and_crop() {
    let crop = |x: f64, y: f64, w: f64, h: f64| json!({ "x": x, "y": y, "width": w, "height": h });

    // Without a crop, 90° steps swap the dimensions.
    assert_eq!(transformed_dimensions(100, 60, &json!({})), (100, 60));
    assert_eq!(
        transformed_dimensions(100, 60, &json!({ "orientationSteps": 1 })),
        (60, 100)
    );

    // Crop applies in rotated coordinates: 60×100 canvas, crop 50×70 at (10, 5).
    let adjustments = json!({ "orientationSteps": 1, "crop": crop(10.0, 5.0, 50.0, 70.0) });
    assert_eq!(transformed_dimensions(100, 60, &adjustments), (50, 70));

    // Oversized crops are clamped to the canvas.
    let clamped = json!({ "crop": crop(10.0, 5.0, 200.0, 200.0) });
    assert_eq!(transformed_dimensions(100, 60, &clamped), (90, 55));
}

// ---------------------------------------------------------------------------
// Geometry: run-to-run determinism (hash based)
// ---------------------------------------------------------------------------

#[test]
fn geometry_pipeline_is_bit_deterministic() {
    let img = synthetic_image(64, 48);

    let orientation = json!({ "orientationSteps": 3, "flipHorizontal": true });
    let h1 = hash_image(&apply_orientation_and_flip(&img, &orientation));
    let h2 = hash_image(&apply_orientation_and_flip(&img, &orientation));
    assert_eq!(h1, h2, "orientation+flip must be deterministic");

    let spatial = json!({
        "rotation": 15.0,
        "crop": { "x": 8.0, "y": 6.0, "width": 40.0, "height": 30.0 }
    });
    let (out1, offset1) = apply_spatial_transformations(&img, &spatial);
    let (out2, offset2) = apply_spatial_transformations(&img, &spatial);
    assert_eq!(
        hash_image(&out1),
        hash_image(&out2),
        "rotate+crop must be deterministic"
    );
    assert_eq!(offset1, offset2);
    assert_eq!(
        offset1,
        (8.0, 6.0),
        "crop offset must pass through unchanged"
    );

    let warp = json!({ "transformDistortion": 15.0, "transformScale": 102.0 });
    let (w1, _) = apply_all_transformations(&img, &warp);
    let (w2, _) = apply_all_transformations(&img, &warp);
    assert_eq!(
        hash_image(&w1),
        hash_image(&w2),
        "geometry warp must be deterministic"
    );
}

#[test]
fn apply_all_transformations_with_default_adjustments_is_exact_identity() {
    let img = synthetic_image(48, 32);

    // Empty adjustments: every stage (geometry warp, relight, fog, lens blur,
    // orientation, crop) must take its no-op path and return the same pixels.
    let (out, offset) = apply_all_transformations(&img, &json!({}));
    assert_eq!(out.dimensions(), img.dimensions());
    assert_eq!(
        hash_image(&out),
        hash_image(&img),
        "empty adjustments must not touch pixels"
    );
    assert_eq!(offset, (0.0, 0.0));

    // Unrelated toning keys must not wake the geometry stages either.
    let (out2, _) = apply_all_transformations(&img, &json!({ "exposure": 0.5 }));
    assert_eq!(hash_image(&out2), hash_image(&img));
}

// ---------------------------------------------------------------------------
// XMP → preset conversion (M0-3: adjustment JSON round-trip)
// ---------------------------------------------------------------------------

/// Lightroom-style XMP covering the whole mapping table: direct mappings,
/// scaled mappings (shadows/sharpness/temperature/tint/HSL hue), color
/// grading groups and tone curves with the PV2012 shadow dampening.
const SAMPLE_XMP: &str = r#"<x:xmpmeta xmlns:x="adobe:ns:meta/">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/"
    crs:Version="15.0"
    crs:ProcessVersion="11.0"
    crs:Exposure2012="+15"
    crs:Contrast2012="+10"
    crs:Highlights2012="-20"
    crs:Shadows2012="+20"
    crs:Whites2012="+30"
    crs:Blacks2012="-5"
    crs:Texture="+15"
    crs:Clarity2012="+25"
    crs:Dehaze="+10"
    crs:Vibrance="+5"
    crs:Saturation="-10"
    crs:Sharpness="60"
    crs:SharpenRadius="1.2"
    crs:SharpenDetail="40"
    crs:SharpenEdgeMasking="10"
    crs:LuminanceSmoothing="15"
    crs:ColorNoiseReduction="10"
    crs:GrainAmount="10"
    crs:GrainSize="25"
    crs:GrainFrequency="50"
    crs:Temperature="6800"
    crs:AsShotTemperature="5500"
    crs:Tint="+12"
    crs:HueAdjustmentRed="+8"
    crs:SaturationAdjustmentRed="+10"
    crs:LuminanceAdjustmentBlue="-15"
    crs:SplitToningShadowHue="45"
    crs:SplitToningShadowSaturation="20"
    crs:ColorGradeMidtoneHue="90"
    crs:ColorGradeMidtoneSat="+30"
    crs:SplitToningBalance="-30"
    crs:ColorGradeBlending="50">
   <crs:Name>
    <rdf:Alt>
     <rdf:li xml:lang="x-default">Sunset Warm</rdf:li>
    </rdf:Alt>
   </crs:Name>
   <crs:ToneCurvePV2012>
    <rdf:Seq>
     <rdf:li>0, 0</rdf:li>
     <rdf:li>10, 20</rdf:li>
     <rdf:li>32, 48</rdf:li>
     <rdf:li>128, 140</rdf:li>
     <rdf:li>255, 255</rdf:li>
    </rdf:Seq>
   </crs:ToneCurvePV2012>
   <crs:ToneCurvePV2012Red>
    <rdf:Seq>
     <rdf:li>10, 20</rdf:li>
     <rdf:li>200, 220</rdf:li>
    </rdf:Seq>
   </crs:ToneCurvePV2012Red>
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
"#;

fn expected_adjustments() -> serde_json::Value {
    // Mired convention (see preset_converter.rs): a warmer Kelvin target than
    // the as-shot value maps to a positive relative temperature:
    // -(1e6/T_target − 1e6/T_as_shot) / MIRED_PER_RELATIVE_UNIT.
    let mired_delta = 1_000_000.0_f64 / 6800.0 - 1_000_000.0_f64 / 5500.0;
    let temperature = -mired_delta / 1.5;
    debug_assert!((temperature - 23.1729).abs() < 1e-3);

    // Number types are significant: `serde_json::Number` equality is
    // type-sensitive (i64 15 ≠ f64 15.0), so this fixture pins the exact
    // parse path of every attribute (integer passthrough vs f64 rescale).
    // PV2012 shadow dampening: (10,20) → (10,18), (32,48) → (32,46);
    // points with x ≥ 64 and the red curve are not dampened.
    json!({
        "exposure": 15,
        "contrast": 10,
        "highlights": -20,
        "shadows": 30.0,
        "whites": 30,
        "blacks": -5,
        "clarity": 25,
        "dehaze": 10,
        "vibrance": 5,
        "saturation": -10,
        "structure": 15,
        "sharpenRadius": 1.2,
        "sharpenDetail": 40,
        "sharpenMasking": 10,
        "lumaNoiseReduction": 15,
        "colorNoiseReduction": 10,
        "grainAmount": 10,
        "grainSize": 25,
        "grainRoughness": 50,
        "sharpness": 40.0,
        "temperature": temperature,
        "tint": 8.0,
        "hsl": {
            "reds": { "hue": 6.0, "saturation": 10 },
            "blues": { "luminance": -15 }
        },
        "colorGrading": {
            "blending": 50,
            "balance": -30,
            "shadows": { "hue": 45, "saturation": 20 },
            "midtones": { "hue": 90, "saturation": 30 }
        },
        "curves": {
            "luma": [
                { "x": 0, "y": 0 },
                { "x": 10, "y": 18 },
                { "x": 32, "y": 46 },
                { "x": 128, "y": 140 },
                { "x": 255, "y": 255 }
            ],
            "red": [
                { "x": 10, "y": 20 },
                { "x": 200, "y": 220 }
            ]
        }
    })
}

#[test]
fn xmp_conversion_produces_the_expected_adjustment_json() {
    let preset =
        preset_converter::convert_xmp_to_preset(SAMPLE_XMP).expect("conversion must succeed");

    assert_eq!(preset.name, "Sunset Warm");
    assert_eq!(preset.include_masks, Some(false));
    assert_eq!(preset.include_crop_transform, Some(false));
    assert_eq!(preset.preset_type, Some("style".to_string()));
    assert!(
        Uuid::parse_str(&preset.id).is_ok(),
        "id must be a valid UUID"
    );

    assert_eq!(
        preset.adjustments,
        expected_adjustments(),
        "adjustments JSON must match the mapping table exactly (incl. number types)"
    );
}

#[test]
fn xmp_conversion_is_deterministic_modulo_the_generated_id() {
    let a = preset_converter::convert_xmp_to_preset(SAMPLE_XMP).unwrap();
    let b = preset_converter::convert_xmp_to_preset(SAMPLE_XMP).unwrap();

    assert_eq!(
        a.adjustments, b.adjustments,
        "mapping must be deterministic"
    );
    assert_eq!(a.name, b.name);
    assert_ne!(a.id, b.id, "each import gets a fresh UUID");

    // With the id pinned, the full serialization must be identical.
    let mut a = a;
    let mut b = b;
    a.id = "00000000-0000-0000-0000-000000000000".to_string();
    b.id = a.id.clone();
    assert_eq!(
        serde_json::to_value(&a).unwrap(),
        serde_json::to_value(&b).unwrap()
    );
}

#[test]
fn preset_survives_a_serde_round_trip() {
    let preset = preset_converter::convert_xmp_to_preset(SAMPLE_XMP).unwrap();
    let serialized = serde_json::to_string(&preset).unwrap();
    let reparsed: file_management::Preset = serde_json::from_str(&serialized).unwrap();

    assert_eq!(reparsed.name, preset.name);
    assert_eq!(reparsed.adjustments, preset.adjustments);
    assert_eq!(reparsed.include_masks, preset.include_masks);
    assert_eq!(
        reparsed.include_crop_transform,
        preset.include_crop_transform
    );
    assert_eq!(reparsed.preset_type, preset.preset_type);
    // serde renames must survive the round trip (camelCase on the wire).
    assert!(serialized.contains("\"includeMasks\":false"));
    assert!(serialized.contains("\"presetType\":\"style\""));
}

#[test]
fn preset_shim_stays_in_sync_with_sources() {
    // The shim replicas above are compiled instead of the private originals;
    // these pinned fragments make silent drift of the real definitions a
    // hard failure of this test.
    let fm = include_str!("../src/file_management.rs");
    for fragment in [
        "pub struct Preset {",
        "    pub id: String,",
        "    pub name: String,",
        "    pub adjustments: Value,",
        "    #[serde(rename = \"includeMasks\", skip_serializing_if = \"Option::is_none\")]",
        "    pub include_masks: Option<bool>,",
        "    #[serde(",
        "        rename = \"includeCropTransform\",",
        "        skip_serializing_if = \"Option::is_none\"",
        "    )]",
        "    pub include_crop_transform: Option<bool>,",
        "    #[serde(rename = \"presetType\", skip_serializing_if = \"Option::is_none\")]",
        "    pub preset_type: Option<String>,",
    ] {
        assert!(
            fm.contains(fragment),
            "Preset shim drift: `{fragment}` missing from src/file_management.rs"
        );
    }

    let wb = include_str!("../src/white_balance.rs");
    for fragment in [
        "pub const MIRED_PER_RELATIVE_UNIT: f64 = 1.5;",
        "pub const TINT_PER_RELATIVE_UNIT: f64 = 1.5;",
    ] {
        assert!(
            wb.contains(fragment),
            "white_balance shim drift: `{fragment}` missing from src/white_balance.rs"
        );
    }
}

// ---------------------------------------------------------------------------
// Dual-resolution consistency (plan M0-3)
// ---------------------------------------------------------------------------

#[test]
fn dual_resolution_render_is_consistent() {
    // "Export" resolution 1200×675 and its Lanczos3 preview at 384×216 (same
    // 3.125× ratio as 6000 px → 1920 px) are rendered with identical
    // parameters, then both are normalized to 240×135 for comparison.
    let base = FloatImage::from_dynamic(&harness::scene_portrait(1200, 675));
    let preview_scene = harness::lanczos3_resize(&base, 384, 216);

    let tone = ReferenceParams {
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

    let full = harness::render_reference(&base, &tone);
    let prev = harness::render_reference(&preview_scene, &tone);
    let norm_full = harness::lanczos3_resize(&full, 240, 135);
    let norm_prev = harness::lanczos3_resize(&prev, 240, 135);

    let psnr = metrics::psnr(&norm_full.data, &norm_prev.data);
    let ssim = metrics::ssim(&norm_full.data, &norm_prev.data, 240, 135);
    println!("dual-resolution tone-only: PSNR {psnr:.2} dB, SSIM {ssim:.5}");
    assert!(
        ssim >= 0.98,
        "tone-only dual-resolution SSIM too low: {ssim} (plan target 0.995 once verified)"
    );

    // With sharpening the two paths legitimately differ more (USM acts on
    // different-frequency content per resolution), so the gate is relative:
    // agreement must drop versus tone-only but stay in a sane band, and the
    // sharpened render must carry more high-frequency energy at the matched
    // comparison scale.
    let mut sharp = tone.clone();
    sharp.usm_amount = 0.6;
    sharp.usm_threshold = 0.02;
    let full_s = harness::render_reference(&base, &sharp);
    let prev_s = harness::render_reference(&preview_scene, &sharp);
    let norm_full_s = harness::lanczos3_resize(&full_s, 240, 135);
    let norm_prev_s = harness::lanczos3_resize(&prev_s, 240, 135);

    let ssim_sharp = metrics::ssim(&norm_full_s.data, &norm_prev_s.data, 240, 135);
    let hf = metrics::high_frequency_energy_ratio_rgb(&norm_full_s.data, &norm_full.data, 240, 135);
    println!("dual-resolution with USM: SSIM {ssim_sharp:.5}, hf ratio {hf:.3}");
    assert!(
        ssim_sharp >= 0.75,
        "sharpened dual-resolution SSIM collapsed: {ssim_sharp}"
    );
    assert!(
        ssim_sharp < ssim,
        "sharpening must reduce cross-resolution agreement ({ssim_sharp} ≥ {ssim})"
    );
    assert!(hf > 1.0, "USM must add high-frequency energy, ratio {hf}");
}
