//! 参数扫描矩阵（spec: v2-engine-contract-tests, Task 3；AR-2 C3 起为生产参数 schema）。
//!
//! **决策记录**：任务书原文要求 TOML 数据文件；实际落地为 Rust 常量表 ——
//! 矩阵需要与 `get_global_adjustments_from_json`（crate 私有）及 `SCALES`
//! （私有常量）做同 crate 断言，TOML 方案要么把解析函数改为 pub（污染生产
//! API），要么复制 SCALES 值（漂移源）。常量表取得同等数据驱动性 + 零 dev 依赖。
//!
//! **AR-2 C3 单源**：本表自 v2.0 起升级为生产参数 schema —— 解析侧
//! `SCALES` 的每个标量 scale/default 均由 `scale()`/`default_of()` 从本表
//! 派生（结构参数 hsl/colorGrading 饱和·亮度除外，见下）。注册表缺项
//! 会在 SCALES 构建时 panic（`scales_resolvable_from_registry` 测试 eagerly
//! 触发），解析回归在测试期即刻暴露。
//!
//! 完整性机制：TR-3.2 在「全参数 +scale 注入」档位下断言关键字段指纹 ——
//! 参数若进矩阵但解析侧丢失 → 字段回默认 → 指纹红（防解析回归）；
//! 解析侧新增参数而矩阵未配 → SCALES 构建 panic（反向完整性）。

/// 标量参数规格：`scale` 必须与 image_processing.rs 的 `SCALES` 对齐
/// （C3 后方向反转：SCALES 由本表派生，对齐关系由构造保证）
pub struct ParamSpec {
    pub section: &'static str,
    pub key: &'static str,
    pub scale: f32,
    /// get_val 的 default 参数（raw 值域，非换算后）
    pub default: Option<f64>,
}

impl ParamSpec {
    const fn new(section: &'static str, key: &'static str, scale: f32) -> Self {
        ParamSpec {
            section,
            key,
            scale,
            default: None,
        }
    }
    const fn with_default(
        section: &'static str,
        key: &'static str,
        scale: f32,
        default: f64,
    ) -> Self {
        ParamSpec {
            section,
            key,
            scale,
            default: Some(default),
        }
    }
}

/// 全部标量参数（与 get_global_adjustments_from_json 的 get_val 调用点一一对应，共 41 条）
pub const MATRIX: &[ParamSpec] = &[
    // basic (7)
    ParamSpec::new("basic", "exposure", 0.8),
    ParamSpec::new("basic", "brightness", 0.8),
    ParamSpec::new("basic", "contrast", 100.0),
    ParamSpec::new("basic", "highlights", 120.0),
    ParamSpec::new("basic", "shadows", 120.0),
    ParamSpec::new("basic", "whites", 30.0),
    ParamSpec::new("basic", "blacks", 40.0),
    // color (5)
    ParamSpec::new("color", "saturation", 100.0),
    ParamSpec::new("color", "temperature", 25.0),
    ParamSpec::new("color", "tint", 100.0),
    ParamSpec::new("color", "vibrance", 100.0),
    ParamSpec::new("color", "hue", 1.0),
    // details (10)
    ParamSpec::new("details", "sharpness", 50.0),
    ParamSpec::new("details", "lumaNoiseReduction", 100.0),
    ParamSpec::new("details", "colorNoiseReduction", 100.0),
    ParamSpec::new("details", "clarity", 125.0),
    ParamSpec::new("details", "dehaze", 750.0),
    ParamSpec::new("details", "structure", 125.0),
    ParamSpec::new("details", "centré", 250.0),
    ParamSpec::new("details", "chromaticAberrationRedCyan", 10000.0),
    ParamSpec::new("details", "chromaticAberrationBlueYellow", 10000.0),
    ParamSpec::with_default("details", "sharpnessThreshold", 100.0, 15.0),
    // effects (10)
    ParamSpec::new("effects", "vignetteAmount", 100.0),
    ParamSpec::with_default("effects", "vignetteMidpoint", 100.0, 50.0),
    ParamSpec::with_default("effects", "vignetteRoundness", 100.0, 0.0),
    ParamSpec::with_default("effects", "vignetteFeather", 100.0, 50.0),
    ParamSpec::new("effects", "grainAmount", 200.0),
    ParamSpec::with_default("effects", "grainSize", 50.0, 25.0),
    ParamSpec::with_default("effects", "grainRoughness", 100.0, 50.0),
    ParamSpec::new("effects", "glowAmount", 100.0),
    ParamSpec::new("effects", "halationAmount", 100.0),
    ParamSpec::new("effects", "flareAmount", 100.0),
    // colorGrading (2) + colorCalibration (7) + hsl 归 color section（另行注入）
    ParamSpec::new("colorGrading", "blending", 100.0),
    ParamSpec::new("colorGrading", "balance", 200.0),
    ParamSpec::new("colorCalibration", "shadowsTint", 400.0),
    ParamSpec::new("colorCalibration", "redHue", 400.0),
    ParamSpec::new("colorCalibration", "redSaturation", 120.0),
    ParamSpec::new("colorCalibration", "greenHue", 400.0),
    ParamSpec::new("colorCalibration", "greenSaturation", 120.0),
    ParamSpec::new("colorCalibration", "blueHue", 400.0),
    ParamSpec::new("colorCalibration", "blueSaturation", 120.0),
    // effects LUT (1)
    ParamSpec::new("effects", "lutIntensity", 100.0),
];

/// 标量档位（raw 值）：无 default → [−2s, −s, 0, +s, +2s]；有 default → [d−2s, d−s, d, d+s, d+2s]
/// （两表语义一致：第 4 档均为 +s，即换算后 default=0 类 → 1.0、default=d 类 → d/s+1）
pub fn levels(spec: &ParamSpec) -> [f64; 5] {
    let s = spec.scale as f64;
    match spec.default {
        None => [-2.0 * s, -s, 0.0, s, 2.0 * s],
        Some(d) => [d - 2.0 * s, d - s, d, d + s, d + 2.0 * s],
    }
}

/// 注册表查 scale（C3 单源入口）：缺项 panic —— 解析侧禁止出现注册表外标量。
pub fn scale(section: &str, key: &str) -> f32 {
    MATRIX
        .iter()
        .find(|s| s.section == section && s.key == key)
        .unwrap_or_else(|| panic!("param registry missing {section}.{key} — SCALES 必须全部由注册表派生"))
        .scale
}

/// 注册表查 default（raw 值域）
pub fn default_of(section: &str, key: &str) -> Option<f64> {
    MATRIX
        .iter()
        .find(|s| s.section == section && s.key == key)
        .unwrap_or_else(|| panic!("param registry missing {section}.{key} — SCALES 必须全部由注册表派生"))
        .default
}

/// toneMapper 枚举全档（解析映射：agx=1 reinhard=2 filmic/filmic_pro=3 gamma=4 none=5 其他=0）
pub const TONE_MAPPER_LEVELS: [&str; 6] =
    ["basic", "agx", "reinhard", "filmic", "filmic_pro", "gamma"];

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image_processing::get_global_adjustments_from_json;
    use serde_json::{Map, Value, json};

    fn base_visibility(all: bool) -> Value {
        json!({
            "sectionVisibility": {
                "basic": all, "color": all, "details": all, "effects": all, "curves": all
            }
        })
    }

    /// 把矩阵全部标量注入指定档位
    fn inject_level(level_idx: usize) -> Value {
        let mut obj = base_visibility(true);
        let map = obj.as_object_mut().unwrap();
        for spec in MATRIX {
            let v = levels(spec)[level_idx];
            let target: &mut Map<String, Value> = if spec.section == "colorGrading" {
                map.entry("colorGrading")
                    .or_insert_with(|| json!({}))
                    .as_object_mut()
                    .unwrap()
            } else if spec.section == "colorCalibration" {
                map.entry("colorCalibration")
                    .or_insert_with(|| json!({}))
                    .as_object_mut()
                    .unwrap()
            } else {
                map
            };
            target.insert(spec.key.to_string(), json!(v));
        }
        // LUT 强度默认依赖 lutPath 存在与否；注入字符串触发 has_lut=1
        map.insert("lutPath".to_string(), json!("/fake/lut.cube"));
        map.insert("toneMapper".to_string(), json!("basic"));
        obj
    }

    /// TR-3.1: 矩阵全部条目 × 全部档位可被解析函数无错消费
    #[test]
    fn tr_3_1_matrix_consumable() {
        for level in 0..5 {
            let adj = inject_level(level);
            let _ = get_global_adjustments_from_json(&adj, false, None);
        }
        // 枚举全档
        for tm in TONE_MAPPER_LEVELS {
            let mut adj = inject_level(2);
            adj.as_object_mut()
                .unwrap()
                .insert("toneMapper".to_string(), json!(tm));
            let parsed = get_global_adjustments_from_json(&adj, false, None);
            let expected = match tm {
                "agx" => 1,
                "reinhard" => 2,
                "filmic" | "filmic_pro" => 3,
                "gamma" => 4,
                _ => 0,
            };
            assert_eq!(parsed.tonemapper_mode, expected, "toneMapper {tm}");
        }
        // bool 参数
        let mut adj = inject_level(2);
        adj.as_object_mut()
            .unwrap()
            .insert("showClipping".to_string(), json!(true));
        adj.as_object_mut()
            .unwrap()
            .insert("lutIsSceneReferred".to_string(), json!(true));
        let parsed = get_global_adjustments_from_json(&adj, false, None);
        assert_eq!(parsed.show_clipping, 1);
        assert_eq!(parsed.lut_is_scene_referred, 1);
        assert_eq!(parsed.has_lut, 1);
    }

    /// TR-3.1b: 结构参数 3 组代表性注入（curves / colorGrading / hsl）
    #[test]
    fn tr_3_1_structural_params() {
        // curves: 2 点（默认形）/ 8 点 / 16 点（容量上限）
        for n in [2usize, 8, 16] {
            let pts: Vec<Value> = (0..n)
                .map(|i| json!({"x": (i * 255 / (n - 1)) as f64, "y": (i * 200 / (n - 1)) as f64}))
                .collect();
            let mut adj = base_visibility(true);
            adj.as_object_mut().unwrap().insert(
                "curves".to_string(),
                json!({ "luma": pts, "red": pts, "green": pts, "blue": pts }),
            );
            let parsed = get_global_adjustments_from_json(&adj, false, None);
            assert_eq!(parsed.luma_curve_count, n.min(16) as u32);
            assert_eq!(parsed.red_curve_count, n.min(16) as u32);
        }
        // colorGrading: 单区间 / 全区间 × 3 键
        let mut adj = base_visibility(true);
        adj.as_object_mut().unwrap().insert(
            "colorGrading".to_string(),
            json!({
                "shadows": { "hue": 30.0, "saturation": 250.0, "luminance": -100.0 },
                "midtones": { "hue": -45.0, "saturation": 500.0, "luminance": 250.0 },
                "highlights": { "hue": 180.0, "saturation": 100.0, "luminance": 0.0 },
                "global": { "hue": 90.0, "saturation": 50.0, "luminance": 50.0 },
                "blending": 75.0, "balance": 40.0
            }),
        );
        let parsed = get_global_adjustments_from_json(&adj, false, None);
        assert_eq!(parsed.color_grading_shadows.hue, 30.0);
        assert!((parsed.color_grading_midtones.saturation - 1.0).abs() < 1e-6);
        assert!((parsed.color_grading_blending - 0.75).abs() < 1e-6);
        assert!((parsed.color_grading_balance - 0.2).abs() < 1e-6);
        // hsl: 8 色全档
        let mut adj = base_visibility(true);
        let hsl: Value = json!({
            "reds": { "hue": 10.0, "saturation": 20.0, "luminance": 30.0 },
            "oranges": { "hue": -10.0, "saturation": -20.0, "luminance": -30.0 },
            "yellows": { "hue": 10.0, "saturation": 20.0, "luminance": 30.0 },
            "greens": { "hue": 10.0, "saturation": 20.0, "luminance": 30.0 },
            "aquas": { "hue": 10.0, "saturation": 20.0, "luminance": 30.0 },
            "blues": { "hue": 10.0, "saturation": 20.0, "luminance": 30.0 },
            "purples": { "hue": 10.0, "saturation": 20.0, "luminance": 30.0 },
            "magentas": { "hue": 10.0, "saturation": 20.0, "luminance": 30.0 }
        });
        adj.as_object_mut().unwrap().insert("hsl".to_string(), hsl);
        let parsed = get_global_adjustments_from_json(&adj, false, None);
        assert!((parsed.hsl[0].hue - 3.0).abs() < 1e-6, "reds hue 10*0.3=3");
        assert!((parsed.hsl[7].saturation - 0.2).abs() < 1e-6);
    }

    /// TR-3.2a: 换算抽查 —— 每 section 代表字段的 scale 精确对齐
    #[test]
    fn tr_3_2_scale_alignment() {
        let mut adj = base_visibility(true);
        {
            let map = adj.as_object_mut().unwrap();
            map.insert("exposure".to_string(), json!(0.8));
            map.insert("contrast".to_string(), json!(100.0));
            map.insert("highlights".to_string(), json!(120.0));
            map.insert("saturation".to_string(), json!(100.0));
            map.insert("hue".to_string(), json!(1.0));
            map.insert("dehaze".to_string(), json!(750.0));
            map.insert("centré".to_string(), json!(250.0));
            map.insert("chromaticAberrationRedCyan".to_string(), json!(10000.0));
            map.insert("vignetteMidpoint".to_string(), json!(50.0));
            map.insert("grainSize".to_string(), json!(25.0));
            map.insert("sharpnessThreshold".to_string(), json!(15.0));
            map.insert("colorCalibration".to_string(), json!({ "redHue": 400.0 }));
        }
        let parsed = get_global_adjustments_from_json(&adj, false, None);
        let cases: [(&str, f32, f32); 11] = [
            ("exposure", parsed.exposure, 1.0),
            ("contrast", parsed.contrast, 1.0),
            ("highlights", parsed.highlights, 1.0),
            ("saturation", parsed.saturation, 1.0),
            ("hue", parsed.hue, 1.0),
            ("dehaze", parsed.dehaze, 1.0),
            ("centré", parsed.centré, 1.0),
            ("ca_red_cyan", parsed.chromatic_aberration_red_cyan, 1.0),
            ("vignette_midpoint", parsed.vignette_midpoint, 0.5),
            ("grain_size", parsed.grain_size, 0.5),
            ("sharpness_threshold", parsed.sharpness_threshold, 0.15),
        ];
        for (name, got, expected) in cases {
            assert!(
                (got - expected).abs() < 1e-6,
                "{name}: got {got}, expected {expected} — 矩阵 scale 与解析侧 SCALES 漂移"
            );
        }
        assert!((parsed.color_calibration.red_hue - 1.0).abs() < 1e-6);
    }

    /// TR-3.2b: 默认可见性关闭 → 全部字段回默认（sectionVisibility 语义回归）
    #[test]
    fn tr_3_2_visibility_off_resets() {
        let mut adj = base_visibility(false);
        {
            let map = adj.as_object_mut().unwrap();
            map.insert("exposure".to_string(), json!(0.8));
            map.insert("contrast".to_string(), json!(100.0));
            map.insert("saturation".to_string(), json!(100.0));
        }
        let parsed = get_global_adjustments_from_json(&adj, false, None);
        assert_eq!(parsed.exposure, 0.0);
        assert_eq!(parsed.contrast, 0.0);
        assert_eq!(parsed.saturation, 0.0);
        // 有 default 的字段在隐藏时回 default 值
        adj.as_object_mut()
            .unwrap()
            .insert("vignetteMidpoint".to_string(), json!(50.0));
        let parsed = get_global_adjustments_from_json(&adj, false, None);
        assert!((parsed.vignette_midpoint - 0.5).abs() < 1e-6);
    }

    /// TR-3.2c: 黄金指纹 —— 全矩阵 +s 档注入下的关键字段值（防解析回归的确定性锚点）
    #[test]
    fn tr_3_2_golden_fingerprint() {
        let adj = inject_level(3); // +scale 档：无 default 字段 → +1.0，有 default → d/s+1
        let parsed = get_global_adjustments_from_json(&adj, false, None);
        let all = |vals: &[f32]| vals.iter().all(|v| (*v - 1.0).abs() < 1e-6);

        assert!(
            all(&[
                parsed.exposure,
                parsed.brightness,
                parsed.contrast,
                parsed.highlights,
                parsed.shadows,
                parsed.whites,
                parsed.blacks
            ]),
            "basic"
        );
        assert!(
            all(&[
                parsed.saturation,
                parsed.temperature,
                parsed.tint,
                parsed.vibrance,
                parsed.hue
            ]),
            "color"
        );
        assert!(
            all(&[
                parsed.sharpness,
                parsed.luma_noise_reduction,
                parsed.color_noise_reduction,
                parsed.clarity,
                parsed.dehaze,
                parsed.structure,
                parsed.centré
            ]),
            "details"
        );
        assert!(
            all(&[
                parsed.chromatic_aberration_red_cyan,
                parsed.chromatic_aberration_blue_yellow
            ]),
            "CA"
        );
        assert!(
            all(&[
                parsed.vignette_amount,
                parsed.grain_amount,
                parsed.glow_amount,
                parsed.halation_amount,
                parsed.flare_amount
            ]),
            "effects-1"
        );
        // 有 default 字段的精确期望值（d/s + 1）
        assert!((parsed.vignette_midpoint - 1.5).abs() < 1e-6);
        assert!((parsed.vignette_roundness - 1.0).abs() < 1e-6);
        assert!((parsed.vignette_feather - 1.5).abs() < 1e-6);
        assert!((parsed.grain_size - 1.5).abs() < 1e-6);
        assert!((parsed.grain_roughness - 1.5).abs() < 1e-6);
        assert!((parsed.sharpness_threshold - 1.15).abs() < 1e-6);
        // LUT：+s 档强度 = 1.0，lutPath 注入 → has_lut=1
        assert!((parsed.lut_intensity - 1.0).abs() < 1e-6);
        assert_eq!(parsed.has_lut, 1);
        // colorGrading 与校准
        assert!((parsed.color_grading_blending - 1.0).abs() < 1e-6);
        assert!((parsed.color_grading_balance - 1.0).abs() < 1e-6);
        assert!(
            all(&[
                parsed.color_calibration.red_hue,
                parsed.color_calibration.green_hue,
                parsed.color_calibration.blue_hue,
                parsed.color_calibration.shadows_tint
            ]),
            "cal-hue"
        );
        assert!(
            all(&[
                parsed.color_calibration.red_saturation,
                parsed.color_calibration.green_saturation,
                parsed.color_calibration.blue_saturation
            ]),
            "cal-sat"
        );
        // 未注入的结构参数保持默认（hsl/curves 由 tr_3_1_structural_params 覆盖）；
        // curves 隐藏段默认注入 2 点恒等曲线 [0,0]-[255,255] → count = 2
        assert_eq!(
            (
                parsed.luma_curve_count,
                parsed.red_curve_count,
                parsed.green_curve_count,
                parsed.blue_curve_count
            ),
            (2, 2, 2, 2)
        );
        assert_eq!((parsed.tonemapper_mode, parsed.is_raw_image), (0, 0));
    }
}
