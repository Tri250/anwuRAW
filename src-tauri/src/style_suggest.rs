//! AI 风格调色建议（「一句话调色」）
//!
//! 借鉴 language-guided-lut 的「语言引导调色」思路：把用户的自然语言描述
//! （如「清透日系，阴影偏青」）映射为一组非破坏性调整参数（adjustments schema，
//! 与 AI 追色/一键增强输出同构，可撤销、可二次编辑）。
//!
//! ## 实现说明（本地零模型方案 A）
//! 项目内 CLIP 为「图文联合」ONNX 导出（forward 必须同时喂图），没有纯文本
//! 编码通路，无法做 text→text 零样本比对。因此采用确定性的本地双语词库映射：
//! 词库命中加权得分决定风格，得分换算置信度，风格携带预置参数配方。
//! 命中为空时不猜测（confidence=0、无补丁，交由上层回退 AI 一键增强）。
//!
//! 在基础词库匹配之上做了四类增强：
//! 1. 否定语义反转：紧邻否定词（「不要日系」/ "not japanese"）的词条不计分，
//!    改记入 `negated_terms` 供结果卡提示「已忽略否定描述」；
//! 2. 程度副词：「稍微/很」等映射为强度系数（0.5 / 1.3），只缩放参数不换风格；
//! 3. 多意图混合：两个意图得分接近时按得分占比对补丁做逐键线性插值（`blended`）；
//! 4. 图像自适应（可选 `image_path`）：按画面亮度统计归一化曝光/对比
//!    （`imageAdapted`），加载失败时静默降级为纯文本结果。
//!
//! 后续若接入云端参考图链路（方案 B）：由云端生成调色参考小图后走
//! `crate::color_transfer` 的 MKL 拟合，本模块的词库可作为提示词构造器
//! （见 `ai_generate_style_reference`）。

use serde_json::{json, Value};
use tauri::Manager;

/// 分区色光参数（colorGrading 分区）
struct ZoneGrade {
    hue: f64,
    saturation: f64,
    luminance: f64,
}

impl ZoneGrade {
    const fn new(hue: f64, saturation: f64, luminance: f64) -> Self {
        Self {
            hue,
            saturation,
            luminance,
        }
    }
    fn to_json(&self) -> Value {
        json!({
            "hue": self.hue,
            "saturation": self.saturation,
            "luminance": self.luminance,
        })
    }
}

/// 风格定义：id、中文名、双语词库（词, 权重）、参数配方、英文生成提示
/// （`prompt_en` 供方案 B 云参考图文生图使用；SD 后端对英文提示更稳）。
pub struct StyleDef {
    pub id: &'static str,
    pub name: &'static str,
    pub keywords: &'static [(&'static str, f64)],
    pub patch: fn() -> Value,
    pub prompt_en: &'static str,
}

// ---------------------------------------------------------------------------
// 否定词前置检测
// ---------------------------------------------------------------------------

/// 中文否定词（双字优先匹配，避免单字误吞）
const CN_NEGATION_WORDS: &[&str] = &["不要", "不能", "不宜", "避免", "无需", "去掉"];
/// 中文否定词（单字）
const CN_NEGATION_CHARS: &[char] = &['别', '勿', '莫', '非', '不'];
/// 允许隔在否定词与词条之间的修饰字（「不要太」「不要那么」「不想要」等）
const CN_MODIFIER_CHARS: &[char] = &['要', '太', '是', '那', '么', '想', '得'];
/// 英文否定词（长词优先，便于词边界判断）
const EN_NEGATION_WORDS: &[&str] = &["without", "avoid", "never", "not", "no"];
/// 中文紧邻窗口（字符数）：否定词(≤2) + 修饰字(≤3) + 余量
const CN_NEGATION_WINDOW: usize = 6;
/// 最多剥离的修饰字个数，防止长距离误报
const CN_MAX_MODIFIER_STRIPS: usize = 3;
/// 英文紧邻窗口（字符数）：需容纳 "photo without " 这类紧邻前缀
const EN_NEGATION_WINDOW: usize = 16;

/// 判断起始于 `chars[start]` 的词条命中是否被紧邻前缀否定。
///
/// 全程基于 `char` 切片操作，UTF-8 安全。中文取紧邻前 6 字符窗口，剥离至多
/// 3 个修饰字后检查是否以否定词结尾；英文取紧邻前 16 字符窗口，去尾部空白
/// 后按词边界（前置字符非字母数字）匹配否定词。
fn is_negated_before(chars: &[char], start: usize) -> bool {
    if start == 0 {
        return false;
    }
    let before = &chars[..start];

    // 中文路径：小窗口 + 剥离修饰字
    let cn_len = before.len().min(CN_NEGATION_WINDOW);
    let mut window: Vec<char> = before[before.len() - cn_len..].to_vec();
    let mut stripped = 0;
    while stripped < CN_MAX_MODIFIER_STRIPS {
        match window.last() {
            Some(&c) if CN_MODIFIER_CHARS.contains(&c) || c.is_whitespace() => {
                window.pop();
                stripped += 1;
            }
            _ => break,
        }
    }
    let cn_tail: String = window.iter().collect();
    if CN_NEGATION_WORDS.iter().any(|w| cn_tail.ends_with(w))
        || CN_NEGATION_CHARS.iter().any(|&c| cn_tail.ends_with(c))
    {
        return true;
    }

    // 英文路径：词边界检查（"not "/"without " 等）
    let en_len = before.len().min(EN_NEGATION_WINDOW);
    let en_tail: String = before[before.len() - en_len..].iter().collect();
    let trimmed = en_tail.trim_end();
    for word in EN_NEGATION_WORDS {
        if trimmed.ends_with(word) {
            let boundary_ok = trimmed[..trimmed.len() - word.len()]
                .chars()
                .next_back()
                .map_or(true, |c| !c.is_ascii_alphanumeric());
            if boundary_ok {
                return true;
            }
        }
    }
    false
}

// ---------------------------------------------------------------------------
// 程度副词 → 强度系数
// ---------------------------------------------------------------------------

const WEAK_INTENSITY: f64 = 0.5;
const STRONG_INTENSITY: f64 = 1.3;

/// 弱副词：整体收敛到一半强度
const WEAK_ADVERBS: &[&str] = &["稍微", "轻微", "略", "一点点", "一点", "slightly", "subtle"];
/// 强副词：增强到 1.3 倍；与弱副词同时出现时取强
const STRONG_ADVERBS: &[&str] = &[
    "很", "非常", "强烈", "重度", "极", "超", "very", "strong", "intense", "heavily",
];

/// 扫描全文检测程度副词，返回强度系数（1.0 表示无副词、不缩放）。
fn detect_intensity(lower: &str) -> f64 {
    if STRONG_ADVERBS.iter().any(|a| lower.contains(a)) {
        STRONG_INTENSITY
    } else if WEAK_ADVERBS.iter().any(|a| lower.contains(a)) {
        WEAK_INTENSITY
    } else {
        1.0
    }
}

/// 对补丁 JSON 做强度缩放（只作用于参数，不改变风格选择）：
/// - 顶层标量数值字段 ×k；
/// - colorGrading 各分区的 saturation/luminance ×k，hue 不动；
/// - curves 控制点 y' = x + (y-x)·k（x 不变，保持网格与升序）。
fn scale_patch_by_intensity(patch: &mut Value, k: f64) {
    if (k - 1.0).abs() < f64::EPSILON {
        return;
    }
    let Some(obj) = patch.as_object_mut() else {
        return;
    };
    let keys: Vec<String> = obj.keys().cloned().collect();
    for key in keys {
        match key.as_str() {
            "colorGrading" => {
                if let Some(cg) = obj.get_mut("colorGrading").and_then(Value::as_object_mut) {
                    for (_zone, z) in cg.iter_mut() {
                        if let Some(zo) = z.as_object_mut() {
                            scale_obj_number(zo, "saturation", k);
                            scale_obj_number(zo, "luminance", k);
                        }
                    }
                }
            }
            "curves" => {
                if let Some(curves) = obj.get_mut("curves").and_then(Value::as_object_mut) {
                    for (_ch, pts) in curves.iter_mut() {
                        let Some(arr) = pts.as_array_mut() else {
                            continue;
                        };
                        for p in arr.iter_mut() {
                            let Some(pair) = p.as_array_mut() else {
                                continue;
                            };
                            if pair.len() != 2 {
                                continue;
                            }
                            let (Some(x), Some(y)) =
                                (pair[0].as_f64(), pair[1].as_f64())
                            else {
                                continue;
                            };
                            pair[1] = json!(x + (y - x) * k);
                        }
                    }
                }
            }
            _ => {
                let v = obj.get(&key).and_then(Value::as_f64);
                if let Some(v) = v {
                    obj.insert(key, json!(v * k));
                }
            }
        }
    }
}

/// 对对象内指定数值字段乘以 `k`（字段不存在或非数值则跳过）。
fn scale_obj_number(obj: &mut serde_json::Map<String, Value>, key: &str, k: f64) {
    let v = obj.get(key).and_then(Value::as_f64);
    if let Some(v) = v {
        obj.insert(key.to_string(), json!(v * k));
    }
}

// ---------------------------------------------------------------------------
// 多意图混合
// ---------------------------------------------------------------------------

/// 混合信息：第二风格 id 与两组补丁的权重 [w_best, w_second]（和为 1）。
pub struct BlendInfo {
    pub with_id: &'static str,
    pub weights: [f64; 2],
}

/// 按权重 `wa`/`wb` 对两个同构补丁做逐键线性插值。
/// curves 控制点 x 网格不一致（或通道集合不同）时返回 None → 退回仅 best。
fn blend_patches(a: &Value, b: &Value, wa: f64, wb: f64) -> Option<Value> {
    let ao = a.as_object()?;
    let bo = b.as_object()?;
    let mut out = serde_json::Map::new();
    for (k, av) in ao {
        let merged = match bo.get(k) {
            Some(bv) => match k.as_str() {
                "colorGrading" => blend_color_grading(av, bv, wa, wb)?,
                "curves" => blend_curves(av, bv, wa, wb)?,
                _ => blend_scalar(av, bv, wa, wb),
            },
            None => scale_single_value(av, wa),
        };
        out.insert(k.clone(), merged);
    }
    for (k, bv) in bo {
        if !ao.contains_key(k) {
            out.insert(k.clone(), scale_single_value(bv, wb));
        }
    }
    Some(Value::Object(out))
}

/// 标量插值：双方均为数值 → 加权平均；否则保留 a。
fn blend_scalar(a: &Value, b: &Value, wa: f64, wb: f64) -> Value {
    match (a.as_f64(), b.as_f64()) {
        (Some(x), Some(y)) => json!(x * wa + y * wb),
        _ => a.clone(),
    }
}

/// 仅单方存在的值：数值乘其权重，其余原样保留。
fn scale_single_value(v: &Value, w: f64) -> Value {
    match v.as_f64() {
        Some(x) => json!(x * w),
        None => v.clone(),
    }
}

/// colorGrading 插值：双方都有分区 → 三参数加权平均；仅一方有 →
/// 该方 saturation/luminance 乘其权重、hue 取该方。
fn blend_color_grading(a: &Value, b: &Value, wa: f64, wb: f64) -> Option<Value> {
    let ao = a.as_object()?;
    let bo = b.as_object()?;
    let mut out = serde_json::Map::new();
    for (zone, av) in ao {
        let merged = match bo.get(zone) {
            Some(bv) => {
                let mut zo = serde_json::Map::new();
                for field in ["hue", "saturation", "luminance"] {
                    if let (Some(x), Some(y)) = (
                        av.get(field).and_then(Value::as_f64),
                        bv.get(field).and_then(Value::as_f64),
                    ) {
                        zo.insert(field.to_string(), json!(x * wa + y * wb));
                    }
                }
                Value::Object(zo)
            }
            None => single_zone_value(av, wa),
        };
        out.insert(zone.clone(), merged);
    }
    for (zone, bv) in bo {
        if !ao.contains_key(zone) {
            out.insert(zone.clone(), single_zone_value(bv, wb));
        }
    }
    Some(Value::Object(out))
}

/// 单方独有的分区：hue 取该方，saturation/luminance 乘其权重。
fn single_zone_value(zone: &Value, w: f64) -> Value {
    let mut zo = serde_json::Map::new();
    if let Some(h) = zone.get("hue") {
        zo.insert("hue".to_string(), h.clone());
    }
    // 从源分区取值后缩放（scale_obj_number 只缩放已存在字段，
    // 不能作用在新建的空对象上，否则独有分区的 sat/lum 会被整体丢掉）。
    for key in ["saturation", "luminance"] {
        if let Some(v) = zone.get(key).and_then(Value::as_f64) {
            zo.insert(key.to_string(), json!(v * w));
        }
    }
    Value::Object(zo)
}

/// curves 插值：所有风格控制点 x 网格相同（0,64,128,192,255）→ 直接 y 加权
/// 平均；通道集合或网格不同 → 返回 None（调用方退回仅 best）。
fn blend_curves(a: &Value, b: &Value, wa: f64, wb: f64) -> Option<Value> {
    let ao = a.as_object()?;
    let bo = b.as_object()?;
    if ao.len() != bo.len() {
        return None;
    }
    let mut out = serde_json::Map::new();
    for (ch, av) in ao {
        let bv = bo.get(ch)?;
        let pa = av.as_array()?;
        let pb = bv.as_array()?;
        if pa.len() != pb.len() {
            return None;
        }
        let mut merged = Vec::with_capacity(pa.len());
        for (pa_pt, pb_pt) in pa.iter().zip(pb.iter()) {
            let xa = pa_pt.get(0).and_then(Value::as_f64)?;
            let ya = pa_pt.get(1).and_then(Value::as_f64)?;
            let xb = pb_pt.get(0).and_then(Value::as_f64)?;
            let yb = pb_pt.get(1).and_then(Value::as_f64)?;
            if (xa - xb).abs() > 1e-9 {
                return None;
            }
            merged.push(json!([xa, ya * wa + yb * wb]));
        }
        out.insert(ch.clone(), Value::Array(merged));
    }
    Some(Value::Object(out))
}

// ---------------------------------------------------------------------------
// 图像自适应
// ---------------------------------------------------------------------------

/// 画面亮度统计（0..1 区间），供参数归一化使用。
pub struct ImageStats {
    pub mean_luminance: f64,
    pub highlight_clip: f64,
    pub shadow_clip: f64,
}

/// 从解码后的图片计算亮度统计：长边 >1024 时先等比缩到 ≤1024，
/// 再按 luma 统计均值、高光裁切（>0.98）与阴影裁切（<0.02）占比。
fn image_luminance_stats(img: &image::DynamicImage) -> ImageStats {
    const ANALYSIS_MAX_DIM: u32 = 1024;
    let (w, h) = (img.width(), img.height());
    let downscaled;
    let analysis = if w.max(h) > ANALYSIS_MAX_DIM {
        downscaled = img.thumbnail(ANALYSIS_MAX_DIM, ANALYSIS_MAX_DIM);
        &downscaled
    } else {
        img
    };
    let luma = analysis.to_luma8();
    let total = luma.len() as f64;
    if total == 0.0 {
        return ImageStats {
            mean_luminance: 0.5,
            highlight_clip: 0.0,
            shadow_clip: 0.0,
        };
    }
    let mut sum = 0.0f64;
    let mut highlight = 0u64;
    let mut shadow = 0u64;
    for &v in luma.iter() {
        let x = v as f64 / 255.0;
        sum += x;
        if x > 0.98 {
            highlight += 1;
        } else if x < 0.02 {
            shadow += 1;
        }
    }
    ImageStats {
        mean_luminance: sum / total,
        highlight_clip: highlight as f64 / total,
        shadow_clip: shadow as f64 / total,
    }
}

/// 从磁盘加载图片并计算亮度统计。复用 color_transfer::load_analysis_image
/// 统一入口：Android SAF content:// URI 经 ContentResolver 读取（此前直接
/// std::fs::read，SAF 导入图的图像自适应在 Android 上静默失效）、iCloud 占位
/// 检测与 RAW 解码同源。仅用于统计：任何失败都由调用方静默降级。
fn analyze_image_stats(
    path: &str,
    settings: &crate::app_settings::AppSettings,
) -> Result<ImageStats, String> {
    let img = crate::color_transfer::load_analysis_image(path, settings)?;
    Ok(image_luminance_stats(&img))
}

/// 按画面亮度统计归一化补丁参数（纯函数，便于直接单测）：
/// - highlight_clip > 0.02 且 exposure > 0 → exposure ×= (1 - 2·clip).clamp(0.3, 1.0)；
/// - mean_luminance < 0.32 且 contrast < 0 → contrast ×= 0.5；
/// - mean_luminance > 0.72 且 exposure > 0 → exposure ×= 0.5。
fn scale_patch_by_image_stats(patch: &mut Value, stats: &ImageStats) {
    let Some(obj) = patch.as_object_mut() else {
        return;
    };

    if stats.highlight_clip > 0.02 {
        let exposure = obj.get("exposure").and_then(Value::as_f64);
        if let Some(exp) = exposure.filter(|&e| e > 0.0) {
            let factor = (1.0 - 2.0 * stats.highlight_clip).clamp(0.3, 1.0);
            obj.insert("exposure".to_string(), json!(exp * factor));
        }
    }
    if stats.mean_luminance < 0.32 {
        let contrast = obj.get("contrast").and_then(Value::as_f64);
        if let Some(c) = contrast.filter(|&c| c < 0.0) {
            obj.insert("contrast".to_string(), json!(c * 0.5));
        }
    }
    if stats.mean_luminance > 0.72 {
        let exposure = obj.get("exposure").and_then(Value::as_f64);
        if let Some(exp) = exposure.filter(|&e| e > 0.0) {
            obj.insert("exposure".to_string(), json!(exp * 0.5));
        }
    }
}

// ---------------------------------------------------------------------------
// 建议主流程
// ---------------------------------------------------------------------------

/// 置信度换算：score / (score + 0.75)。
/// 1 个命中 ≈ 0.57，2 个 ≈ 0.73，3+ 个 ≈ 0.8。
fn score_to_confidence(score: f64) -> f64 {
    if score <= 0.0 {
        0.0
    } else {
        score / (score + 0.75)
    }
}

/// 建议结果
pub struct StyleSuggestion {
    pub style_id: Option<&'static str>,
    pub style_name: Option<String>,
    pub confidence: f64,
    /// 各风格得分（按得分降序）
    pub scores: Vec<(&'static str, f64)>,
    pub matched_terms: Vec<String>,
    /// 被否定语义忽略的词条（结果卡提示「已忽略否定描述」）
    pub negated_terms: Vec<String>,
    /// 程度副词强度系数（1.0 = 未缩放）
    pub intensity: f64,
    /// 多意图混合信息（None = 未混合）
    pub blended: Option<BlendInfo>,
    /// 图像自适应统计（None = 未自适应）
    pub image_adapted: Option<ImageStats>,
    pub adjustments: Option<Value>,
}

impl StyleSuggestion {
    pub fn to_json(&self) -> Value {
        let mut obj = serde_json::Map::new();
        obj.insert("styleId".into(), json!(self.style_id));
        obj.insert("styleName".into(), json!(self.style_name));
        obj.insert("confidence".into(), json!(self.confidence));
        obj.insert(
            "scores".into(),
            json!(self
                .scores
                .iter()
                .map(|(id, s)| json!({ "id": id, "score": s }))
                .collect::<Vec<_>>()),
        );
        obj.insert("matchedTerms".into(), json!(self.matched_terms));
        obj.insert("adjustments".into(), json!(self.adjustments));
        if !self.negated_terms.is_empty() {
            obj.insert("negatedTerms".into(), json!(self.negated_terms));
        }
        if (self.intensity - 1.0).abs() > f64::EPSILON {
            obj.insert("intensity".into(), json!(self.intensity));
        }
        if let Some(b) = &self.blended {
            obj.insert(
                "blended".into(),
                json!({ "withId": b.with_id, "weights": b.weights }),
            );
        }
        if let Some(s) = &self.image_adapted {
            obj.insert(
                "imageAdapted".into(),
                json!({
                    "meanLuminance": s.mean_luminance,
                    "highlightClip": s.highlight_clip,
                    "shadowClip": s.shadow_clip,
                }),
            );
        }
        Value::Object(obj)
    }
}

const STYLE_DEFS: &[StyleDef] = &[
    StyleDef {
        id: "clear_japanese",
        prompt_en: "bright airy Japanese photography, soft diffused light, clean pastel tones, high key",
        name: "清透日系",
        keywords: &[
            ("日系", 2.0),
            ("日式", 2.0),
            ("清透", 2.0),
            ("空气感", 1.5),
            ("奶油", 1.0),
            ("小清新", 1.5),
            ("淡雅", 1.0),
            ("通透", 1.0),
            ("japanese", 2.0),
            ("airy", 1.5),
        ],
        patch: || {
            json!({
                "exposure": 0.35,
                "contrast": -6.0,
                "highlights": -12.0,
                "shadows": 18.0,
                "blacks": -4.0,
                "whites": 4.0,
                "vibrance": 12.0,
                "colorGrading": {
                    "shadows": ZoneGrade::new(200.0, 8.0, -4.0).to_json(),
                    "highlights": ZoneGrade::new(190.0, 6.0, 2.0).to_json(),
                },
                "curves": {
                    "red":   [[0, 16], [64, 74], [128, 128], [192, 192], [255, 244]],
                    "green": [[0, 16], [64, 74], [128, 128], [192, 192], [255, 244]],
                    "blue":  [[0, 18], [64, 76], [128, 128], [192, 190], [255, 242]],
                },
            })
        },
    },
    StyleDef {
        id: "cinematic",
        prompt_en: "cinematic film still, teal and orange color grade, deep contrast, shallow depth of field",
        name: "电影感",
        keywords: &[
            ("电影", 2.0),
            ("电影感", 2.5),
            ("青橙", 2.0),
            ("冷暖", 1.0),
            ("大片", 1.5),
            ("悬疑", 1.0),
            ("cinematic", 2.0),
            ("teal", 1.5),
        ],
        patch: || {
            json!({
                "exposure": -0.15,
                "contrast": 14.0,
                "highlights": -20.0,
                "shadows": -8.0,
                "blacks": -6.0,
                "vibrance": 6.0,
                "colorGrading": {
                    "shadows": ZoneGrade::new(215.0, 14.0, -4.0).to_json(),
                    "highlights": ZoneGrade::new(35.0, 12.0, 2.0).to_json(),
                },
                "curves": {
                    "red":   [[0, 0], [64, 54], [128, 128], [192, 204], [255, 255]],
                    "green": [[0, 0], [64, 54], [128, 128], [192, 204], [255, 255]],
                    "blue":  [[0, 0], [64, 52], [128, 128], [192, 206], [255, 255]],
                },
            })
        },
    },
    StyleDef {
        id: "retro_film",
        prompt_en: "vintage 35mm film photograph, faded warm tones, grain, halation, lifted blacks",
        name: "复古胶片",
        keywords: &[
            ("复古", 2.0),
            ("胶片", 1.5),
            ("怀旧", 2.0),
            ("做旧", 2.0),
            ("老照片", 1.5),
            ("颗粒", 1.0),
            ("vintage", 2.0),
            ("retro", 2.0),
            ("film", 1.0),
        ],
        patch: || {
            json!({
                "exposure": 0.2,
                "contrast": -10.0,
                "blacks": 10.0,
                "whites": -4.0,
                "vibrance": -10.0,
                "colorGrading": {
                    "shadows": ZoneGrade::new(60.0, 8.0, 4.0).to_json(),
                    "midtones": ZoneGrade::new(40.0, 6.0, 0.0).to_json(),
                    "highlights": ZoneGrade::new(45.0, 4.0, 2.0).to_json(),
                },
                "curves": {
                    "red":   [[0, 22], [64, 82], [128, 130], [192, 196], [255, 246]],
                    "green": [[0, 22], [64, 82], [128, 130], [192, 196], [255, 246]],
                    "blue":  [[0, 20], [64, 78], [128, 126], [192, 190], [255, 238]],
                },
            })
        },
    },
    StyleDef {
        id: "monochrome",
        prompt_en: "black and white monochrome photograph, rich tonal contrast, fine grain",
        name: "黑白",
        keywords: &[
            ("黑白", 2.5),
            ("灰度", 2.0),
            ("单色", 2.0),
            ("去色", 2.0),
            ("monochrome", 2.5),
            ("black and white", 2.5),
            ("grayscale", 2.0),
        ],
        patch: || {
            json!({
                "saturation": -100.0,
                "contrast": 12.0,
                "structure": 8.0,
                "curves": {
                    "red":   [[0, 0], [64, 52], [128, 128], [192, 204], [255, 255]],
                    "green": [[0, 0], [64, 52], [128, 128], [192, 204], [255, 255]],
                    "blue":  [[0, 0], [64, 52], [128, 128], [192, 204], [255, 255]],
                },
            })
        },
    },
    StyleDef {
        id: "cyberpunk",
        prompt_en: "cyberpunk night city, neon magenta and cyan lighting, rain reflections, high contrast",
        name: "赛博朋克",
        keywords: &[
            ("赛博", 2.5),
            ("朋克", 2.0),
            ("霓虹", 2.0),
            ("紫青", 1.5),
            ("未来感", 1.5),
            ("cyberpunk", 2.5),
            ("neon", 2.0),
        ],
        patch: || {
            json!({
                "exposure": -0.1,
                "contrast": 18.0,
                "highlights": -8.0,
                "vibrance": 25.0,
                "colorGrading": {
                    "shadows": ZoneGrade::new(260.0, 20.0, -6.0).to_json(),
                    "midtones": ZoneGrade::new(300.0, 10.0, 0.0).to_json(),
                    "highlights": ZoneGrade::new(190.0, 15.0, 2.0).to_json(),
                },
                "curves": {
                    "red":   [[0, 4], [64, 56], [128, 128], [192, 200], [255, 255]],
                    "green": [[0, 4], [64, 56], [128, 128], [192, 200], [255, 255]],
                    "blue":  [[0, 8], [64, 60], [128, 130], [192, 198], [255, 255]],
                },
            })
        },
    },
    StyleDef {
        id: "fresh_green",
        prompt_en: "fresh nature photography, lush green forest, soft clean light, natural colors",
        name: "森系清新",
        keywords: &[
            ("森系", 2.0),
            ("森林", 2.0),
            ("绿意", 2.0),
            ("自然", 1.0),
            ("植物", 1.5),
            ("forest", 2.0),
            ("green", 1.5),
            ("nature", 1.0),
        ],
        patch: || {
            json!({
                "exposure": 0.25,
                "contrast": 4.0,
                "shadows": 10.0,
                "vibrance": 15.0,
                "colorGrading": {
                    "shadows": ZoneGrade::new(140.0, 8.0, -2.0).to_json(),
                    "midtones": ZoneGrade::new(120.0, 6.0, 0.0).to_json(),
                    "highlights": ZoneGrade::new(90.0, 4.0, 2.0).to_json(),
                },
                "curves": {
                    "red":   [[0, 12], [64, 72], [128, 130], [192, 194], [255, 248]],
                    "green": [[0, 12], [64, 72], [128, 130], [192, 194], [255, 248]],
                    "blue":  [[0, 14], [64, 74], [128, 128], [192, 192], [255, 246]],
                },
            })
        },
    },
    StyleDef {
        id: "warm_golden",
        prompt_en: "golden hour portrait, warm sunset light, soft glow, amber tones",
        name: "暖阳夕晒",
        keywords: &[
            ("暖阳", 2.5),
            ("夕阳", 2.0),
            ("日落", 2.0),
            ("金色", 2.0),
            ("黄昏", 2.0),
            ("秋色", 1.5),
            ("温暖", 1.0),
            ("warm", 1.5),
            ("golden", 2.0),
            ("sunset", 2.0),
        ],
        patch: || {
            json!({
                "exposure": 0.3,
                "temperature": 12.0,
                "tint": 4.0,
                "contrast": 6.0,
                "vibrance": 10.0,
                "colorGrading": {
                    "shadows": ZoneGrade::new(50.0, 6.0, 0.0).to_json(),
                    "highlights": ZoneGrade::new(40.0, 12.0, 2.0).to_json(),
                },
                "curves": {
                    "red":   [[0, 10], [64, 74], [128, 132], [192, 196], [255, 250]],
                    "green": [[0, 10], [64, 72], [128, 130], [192, 194], [255, 250]],
                    "blue":  [[0, 6], [64, 66], [128, 124], [192, 186], [255, 240]],
                },
            })
        },
    },
    StyleDef {
        id: "moody_dark",
        prompt_en: "moody low key photograph, dark desaturated tones, cool shadows, dramatic light",
        name: "暗调情绪",
        keywords: &[
            ("暗调", 2.5),
            ("暗", 1.5),
            ("低调", 1.5),
            ("情绪", 2.0),
            ("压抑", 2.0),
            ("深沉", 2.0),
            ("暗黑", 2.0),
            ("深色", 1.5),
            ("dark", 1.5),
            ("moody", 2.0),
            ("low-key", 2.0),
        ],
        patch: || {
            json!({
                "exposure": -0.3,
                "contrast": 10.0,
                "blacks": -10.0,
                "highlights": -6.0,
                "vibrance": -8.0,
                "colorGrading": {
                    "shadows": ZoneGrade::new(230.0, 12.0, -6.0).to_json(),
                    "midtones": ZoneGrade::new(220.0, 4.0, -2.0).to_json(),
                },
                "curves": {
                    "red":   [[0, 0], [64, 48], [128, 126], [192, 200], [255, 252]],
                    "green": [[0, 0], [64, 48], [128, 126], [192, 200], [255, 252]],
                    "blue":  [[0, 2], [64, 50], [128, 128], [192, 198], [255, 250]],
                },
            })
        },
    },
];

/// 根据用户自然语言描述推断风格并产出参数配方。
///
/// - 命中为空（含全部命中被否定）：`style_id=None`、`adjustments=None`
///   （上层回退 AI 一键增强）；
/// - 命中非空：取最高分风格，confidence 由得分换算；平票时取词库中更靠前
///   （更常用）的风格；
/// - 双意图得分接近（(best-second)/best < 0.35）时按得分占比插值混合两组补丁；
/// - 程度副词决定强度系数（0.5 / 1.3），只缩放参数不改变风格选择。
pub fn suggest_style(text: &str) -> StyleSuggestion {
    let lower = text.to_lowercase();
    let chars: Vec<char> = lower.chars().collect();
    let mut scores: Vec<(&'static str, f64)> = STYLE_DEFS.iter().map(|d| (d.id, 0.0)).collect();
    let mut matched_terms: Vec<String> = Vec::new();
    let mut negated_terms: Vec<String> = Vec::new();

    for def in STYLE_DEFS {
        let idx = scores.iter().position(|(id, _)| *id == def.id).unwrap();
        for (term, weight) in def.keywords {
            let term_lower: Vec<char> = term.to_lowercase().chars().collect();
            let mut hit = false;
            let mut live = false;
            for (start, window) in chars.windows(term_lower.len()).enumerate() {
                if window == term_lower.as_slice() {
                    hit = true;
                    if !is_negated_before(&chars, start) {
                        live = true;
                        break;
                    }
                }
            }
            if live {
                scores[idx].1 += weight;
                if !matched_terms.iter().any(|t| t == *term) {
                    matched_terms.push((*term).to_string());
                }
            } else if hit {
                // 紧邻否定词：不计分、不进 matchedTerms，仅记录供结果卡提示
                if !negated_terms.iter().any(|t| t == *term) {
                    negated_terms.push((*term).to_string());
                }
            }
        }
    }
    scores.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    let (best_id, best_score) = scores[0];
    if best_score <= 0.0 {
        return StyleSuggestion {
            style_id: None,
            style_name: None,
            confidence: 0.0,
            scores,
            matched_terms,
            negated_terms,
            intensity: 1.0,
            blended: None,
            image_adapted: None,
            adjustments: None,
        };
    }
    let def = STYLE_DEFS.iter().find(|d| d.id == best_id).unwrap();

    // 多意图混合：第二意图得分接近时按各自得分占比插值
    let mut patch = (def.patch)();
    let mut style_name = def.name.to_string();
    let mut blended = None;
    if let Some((second_id, second_score)) = scores.get(1).copied() {
        if second_score > 0.0 && (best_score - second_score) / best_score < 0.35 {
            let second_def = STYLE_DEFS.iter().find(|d| d.id == second_id).unwrap();
            let total = best_score + second_score;
            let w1 = best_score / total;
            let w2 = second_score / total;
            if let Some(merged) = blend_patches(&patch, &(second_def.patch)(), w1, w2) {
                patch = merged;
                style_name = format!("{} × {}", def.name, second_def.name);
                blended = Some(BlendInfo {
                    with_id: second_id,
                    weights: [w1, w2],
                });
            }
        }
    }

    // 程度副词：只缩放参数，不改变风格选择
    let intensity = detect_intensity(&lower);
    scale_patch_by_intensity(&mut patch, intensity);

    StyleSuggestion {
        style_id: Some(def.id),
        style_name: Some(style_name),
        confidence: score_to_confidence(best_score),
        scores,
        matched_terms,
        negated_terms,
        intensity,
        blended,
        image_adapted: None,
        adjustments: Some(patch),
    }
}

/// 「一句话调色」命令：自然语言描述 → 风格 + 非破坏性参数补丁。
/// 纯本地词库映射，无网络/模型依赖，瞬时返回。
///
/// `image_path` 可选：提供时在后台线程解码图片（长边 ≤1024）统计亮度，
/// 按高光/阴影裁切与均值归一化曝光/对比；加载失败时静默跳过自适应。
#[tauri::command]
pub async fn ai_style_suggest(
    app_handle: tauri::AppHandle,
    prompt: String,
    image_path: Option<String>,
) -> Value {
    let mut suggestion = suggest_style(&prompt);

    if let Some(path) = image_path.filter(|p| !p.trim().is_empty()) {
        let settings = crate::app_settings::load_settings(app_handle).unwrap_or_default();
        let stats = tauri::async_runtime::spawn_blocking(move || {
            analyze_image_stats(&path, &settings)
        })
        .await
        .ok()
        .and_then(|r| r.ok());
        if let Some(stats) = stats {
            if let Some(patch) = suggestion.adjustments.as_mut() {
                scale_patch_by_image_stats(patch, &stats);
            }
            suggestion.image_adapted = Some(stats);
        }
    }

    suggestion.to_json()
}

/// 提示词 → 云端生成提示：命中风格时用风格英文提示（SD 后端对英文更稳），
/// 未命中时透传原始提示。返回（生成提示, 命中风格 id）。
fn generation_prompt_for(text: &str) -> (String, Option<&'static str>) {
    let suggestion = suggest_style(text);
    match suggestion.style_id {
        Some(id) => {
            let prompt = STYLE_DEFS
                .iter()
                .find(|d| d.id == id)
                .map(|d| d.prompt_en)
                .unwrap_or(text);
            (prompt.to_string(), Some(id))
        }
        None => (text.to_string(), None),
    }
}

/// 云参考图生成命令（方案 B）：提示词 → 云端文生图 → 缓存 PNG 路径。
///
/// 前端拿到 path 后作为多样片之一喂给 `compute_color_match`
/// （MKL 传输的目标分布即生成图的 Oklab 统计，与本地样片可混合聚合）。
/// 无 token 时返回 `CLOUD_AUTH_REQUIRED`（前端引导登录 Pro）。
#[tauri::command]
pub async fn ai_generate_style_reference(
    app_handle: tauri::AppHandle,
    prompt: String,
    token: Option<String>,
) -> Result<Value, String> {
    let token = token.ok_or_else(|| "CLOUD_AUTH_REQUIRED".to_string())?;
    let (generation_prompt, style_id) = generation_prompt_for(&prompt);
    let image = crate::ai_connector::process_cloud_generation(
        crate::ai_connector::CLOUD_BASE_URL,
        generation_prompt.clone(),
        &token,
    )
    .await
    .map_err(|e| e.to_string())?;
    // 落缓存目录：style_reference_<纳秒时间戳>.png（仅作统计参考，不进相册）
    let cache_dir = app_handle
        .path()
        .app_cache_dir()
        .map_err(|e| format!("缓存目录不可用: {e}"))?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let path = cache_dir.join(format!("style_reference_{nanos:x}.png"));
    image.save(&path).map_err(|e| format!("保存参考图失败: {e}"))?;
    Ok(json!({
        "path": path.to_string_lossy(),
        "styleId": style_id,
        "generationPrompt": generation_prompt,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 按键路径取数值（测试辅助）
    fn num(v: &Value, path: &[&str]) -> f64 {
        let mut cur = v;
        for p in path {
            cur = cur
                .get(p)
                .unwrap_or_else(|| panic!("路径存在: {path:?}"));
        }
        cur.as_f64().expect("应为数值")
    }

    #[test]
    fn test_matched_styles() {
        let cases = [
            ("帮我调成清透日系的感觉", "clear_japanese"),
            ("要一点电影感，青橙色调", "cinematic"),
            ("复古胶片风，做旧一点", "retro_film"),
            ("转成黑白", "monochrome"),
            ("赛博朋克霓虹感", "cyberpunk"),
            ("森系清新，绿意盎然", "fresh_green"),
            ("暖阳夕阳金色", "warm_golden"),
            ("暗调情绪片", "moody_dark"),
        ];
        for (text, expected) in cases {
            let s = suggest_style(text);
            assert_eq!(
                s.style_id,
                Some(expected),
                "text={text} 应命中 {expected}，实际 {:?}（得分 {:?}）",
                s.style_id,
                s.scores
            );
            assert!(s.adjustments.is_some(), "命中风格应产出补丁");
            assert!(s.confidence > 0.5, "置信度应 >0.5，实际 {}", s.confidence);
        }
    }

    #[test]
    fn test_english_input() {
        let s = suggest_style("make it cinematic with teal shadows");
        assert_eq!(s.style_id, Some("cinematic"));
        let s = suggest_style("black and white please");
        assert_eq!(s.style_id, Some("monochrome"));
    }

    #[test]
    fn test_unmatched_returns_none() {
        let s = suggest_style("随便调调看");
        assert!(s.style_id.is_none(), "未命中不应猜风格");
        assert!(s.adjustments.is_none());
        assert_eq!(s.confidence, 0.0);
        let s = suggest_style("");
        assert!(s.style_id.is_none());
    }

    #[test]
    fn test_patch_schema_complete() {
        for def in STYLE_DEFS {
            let patch = (def.patch)();
            let obj = patch.as_object().expect("补丁应为对象");
            // colorGrading 分区必须带齐三参数
            if let Some(cg) = obj.get("colorGrading") {
                for zone in ["shadows", "midtones", "highlights"] {
                    if let Some(z) = cg.get(zone) {
                        assert!(z.get("hue").is_some(), "{}/{} 缺 hue", def.id, zone);
                        assert!(z.get("saturation").is_some(), "{}/{} 缺 saturation", def.id, zone);
                        assert!(z.get("luminance").is_some(), "{}/{} 缺 luminance", def.id, zone);
                        let hue = z["hue"].as_f64().unwrap();
                        assert!((0.0..=360.0).contains(&hue), "{} hue={hue}", def.id);
                        let sat = z["saturation"].as_f64().unwrap();
                        assert!((0.0..=100.0).contains(&sat), "{} sat={sat}", def.id);
                        let lum = z["luminance"].as_f64().unwrap();
                        assert!((-100.0..=100.0).contains(&lum), "{} lum={lum}", def.id);
                    }
                }
            }
            // curves 控制点必须为 [x, y] 且 x 升序、0..255
            if let Some(curves) = obj.get("curves") {
                for (ch, points) in curves.as_object().unwrap() {
                    let pts = points.as_array().unwrap();
                    let mut prev_x = -1.0;
                    for p in pts {
                        let x = p[0].as_f64().unwrap();
                        let y = p[1].as_f64().unwrap();
                        assert!((0.0..=255.0).contains(&x), "{}/{}/{} x={}", def.id, ch, "x", x);
                        assert!((0.0..=255.0).contains(&y), "{}/{}/{} y={}", def.id, ch, "y", y);
                        assert!(x > prev_x, "{}/{}/{} x 非升序", def.id, ch, "x");
                        prev_x = x;
                    }
                }
            }
        }
    }

    #[test]
    fn test_keywords_unique_per_style_scope() {
        // 每个风格的词条在其自身列表内不重复
        for def in STYLE_DEFS {
            let mut seen = std::collections::HashSet::new();
            for (term, _) in def.keywords {
                assert!(seen.insert(*term), "{} 词条重复: {}", def.id, term);
            }
        }
    }

    #[test]
    fn test_prompt_en_present_for_cloud_generation() {
        // 方案 B 云参考图消费：每个风格都必须有非空英文生成提示
        for def in STYLE_DEFS {
            assert!(!def.prompt_en.trim().is_empty(), "{} 缺英文生成提示", def.id);
            assert!(def.prompt_en.len() >= 20, "{} 英文提示过短", def.id);
        }
    }

    #[test]
    fn test_generation_prompt_mapping() {
        // 命中风格 → 英文生成提示；未命中 → 透传原始提示
        let (p, id) = generation_prompt_for("来点电影感，青橙色调");
        assert_eq!(id, Some("cinematic"));
        assert!(p.contains("cinematic"), "应替换为风格英文提示，实际 {p}");
        let (p, id) = generation_prompt_for("随便说说而已");
        assert_eq!(id, None);
        assert_eq!(p, "随便说说而已");
    }

    // ---------------- 否定语义反转 ----------------

    #[test]
    fn test_negation_reversal_chinese() {
        let cases = [
            "不要日系",
            "不要太清透",
            "不要那么日系",
            "不想要日系",
            "别太清透",
            "避免颗粒",
            "去掉日系",
        ];
        for text in cases {
            let s = suggest_style(text);
            assert!(s.style_id.is_none(), "{text} 不应命中风格，实际 {:?}", s.style_id);
            assert!(s.adjustments.is_none(), "{text} 不应产出补丁");
            assert!(!s.negated_terms.is_empty(), "{text} 应记录被否定词条");
            assert!(s.matched_terms.is_empty(), "{text} 不应有活词条");
        }
        // 控制组：无否定时正常命中
        let s = suggest_style("日系清透");
        assert_eq!(s.style_id, Some("clear_japanese"));
        assert!(s.negated_terms.is_empty());
    }

    #[test]
    fn test_negation_mixed_live_and_negated() {
        // 一半否定一半命中：命中风格保留，否定词条只进 negatedTerms
        let s = suggest_style("日系但不要胶片");
        assert_eq!(s.style_id, Some("clear_japanese"));
        assert!(s.matched_terms.iter().any(|t| t == "日系"));
        assert!(s.negated_terms.iter().any(|t| t == "胶片"));
        assert!(s.negated_terms.iter().all(|t| t != "日系"));
        assert!(s.adjustments.is_some());
        assert!((s.confidence - score_to_confidence(2.0)).abs() < 1e-9);
    }

    #[test]
    fn test_negation_english() {
        let s = suggest_style("not japanese");
        assert!(s.style_id.is_none(), "not japanese 不应命中");
        assert!(s.negated_terms.iter().any(|t| t == "japanese"));

        let s = suggest_style("no teal please");
        assert!(s.style_id.is_none());
        assert!(s.negated_terms.iter().any(|t| t == "teal"));

        // 词边界误报控制："cannot" 中的 "not" 不应触发否定
        let s = suggest_style("cannot understand, just japanese style");
        assert_eq!(s.style_id, Some("clear_japanese"));
        assert!(s.negated_terms.is_empty());

        // 控制组：正常英文不受影响
        let s = suggest_style("make it cinematic with teal shadows");
        assert_eq!(s.style_id, Some("cinematic"));
        assert!(s.negated_terms.is_empty());
    }

    // ---------------- 程度副词 ----------------

    #[test]
    fn test_intensity_weak_scales_params() {
        let s = suggest_style("稍微电影感");
        assert_eq!(s.style_id, Some("cinematic"), "副词不改变风格选择");
        assert!((s.intensity - 0.5).abs() < 1e-9);
        let patch = s.adjustments.as_ref().unwrap();
        // cinematic contrast 14.0 → ×0.5 = 7.0
        assert!((num(patch, &["contrast"]) - 7.0).abs() < 1e-9);
        assert!((num(patch, &["exposure"]) - (-0.075)).abs() < 1e-9);
    }

    #[test]
    fn test_intensity_strong_scales_params() {
        let s = suggest_style("非常电影感");
        assert_eq!(s.style_id, Some("cinematic"));
        assert!((s.intensity - 1.3).abs() < 1e-9);
        let patch = s.adjustments.as_ref().unwrap();
        assert!((num(patch, &["contrast"]) - 14.0 * 1.3).abs() < 1e-9);
        // to_json 应带 intensity 字段
        let j = s.to_json();
        assert!((j["intensity"].as_f64().unwrap() - 1.3).abs() < 1e-9);
    }

    #[test]
    fn test_intensity_strong_dominates_weak() {
        // 强弱副词同时出现 → 取强副词
        let s = suggest_style("非常电影感，稍微暗一点");
        assert_eq!(s.style_id, Some("cinematic"));
        assert!((s.intensity - 1.3).abs() < 1e-9);
        assert!(s.blended.is_none(), "第二意图分差过大不应混合");
        let patch = s.adjustments.as_ref().unwrap();
        assert!((num(patch, &["contrast"]) - 14.0 * 1.3).abs() < 1e-9);
    }

    #[test]
    fn test_intensity_scales_curves_and_colorgrading() {
        let s = suggest_style("稍微日系");
        assert_eq!(s.style_id, Some("clear_japanese"));
        assert!((s.intensity - 0.5).abs() < 1e-9);
        let patch = s.adjustments.as_ref().unwrap();
        // 顶层标量：exposure 0.35 → 0.175，blacks -4 → -2
        assert!((num(patch, &["exposure"]) - 0.175).abs() < 1e-9);
        assert!((num(patch, &["blacks"]) - (-2.0)).abs() < 1e-9);
        // colorGrading：saturation/luminance ×0.5，hue 不动
        assert!((num(patch, &["colorGrading", "shadows", "saturation"]) - 4.0).abs() < 1e-9);
        assert!((num(patch, &["colorGrading", "shadows", "luminance"]) - (-2.0)).abs() < 1e-9);
        assert!((num(patch, &["colorGrading", "shadows", "hue"]) - 200.0).abs() < 1e-9);
        // curves：y' = x + (y-x)·k，x 保持不变（[64,74] → [64,69]）
        let pt = &patch["curves"]["red"][1];
        assert!((pt[0].as_f64().unwrap() - 64.0).abs() < 1e-9, "curves x 不变");
        assert!((pt[1].as_f64().unwrap() - 69.0).abs() < 1e-9, "y' = 64 + 10×0.5");
    }

    #[test]
    fn test_to_json_optional_fields() {
        // 无任何增强 → 新字段全部省略，旧字段名保持不变
        let j = suggest_style("随便调调看").to_json();
        assert!(j.get("styleId").is_some() && j.get("matchedTerms").is_some());
        assert!(j.get("negatedTerms").is_none());
        assert!(j.get("intensity").is_none());
        assert!(j.get("blended").is_none());
        assert!(j.get("imageAdapted").is_none());

        // 否定 → negatedTerms 出现
        let j = suggest_style("不要日系").to_json();
        assert!(j["negatedTerms"].as_array().is_some());

        // 副词 → intensity 出现
        let j = suggest_style("稍微电影感").to_json();
        assert!((j["intensity"].as_f64().unwrap() - 0.5).abs() < 1e-9);

        // 混合 → blended 出现
        let j = suggest_style("日系但暗一点").to_json();
        assert_eq!(j["blended"]["withId"], "moody_dark");
    }

    // ---------------- 多意图混合 ----------------

    #[test]
    fn test_blend_multi_intent() {
        // 日系 2.0 vs 暗 1.5 → (2-1.5)/2 = 0.25 < 0.35 → 混合
        let s = suggest_style("日系但暗一点");
        assert_eq!(s.style_id, Some("clear_japanese"));
        assert!(s.adjustments.is_some(), "混合后仍应产出补丁");
        let b = s.blended.expect("应产生混合");
        assert_eq!(b.with_id, "moody_dark");
        assert!((b.weights[0] + b.weights[1] - 1.0).abs() < 1e-9, "权重和为 1");
        assert!(b.weights[0] > b.weights[1], "best 权重更大");
        assert_eq!(s.style_name.as_deref(), Some("清透日系 × 暗调情绪"));
        // 第二意图进入 scores 且有分
        let second = s.scores.iter().find(|(id, _)| *id == "moody_dark").unwrap();
        assert!(second.1 > 0.0);
    }

    #[test]
    fn test_blend_interpolation_known_values() {
        // 构造已知输入验证逐键线性插值（w1=0.6, w2=0.4）
        let a = json!({
            "exposure": 0.35,
            "contrast": -6.0,
            "blacks": -4.0,
            "colorGrading": {
                "shadows": { "hue": 200.0, "saturation": 8.0, "luminance": -4.0 },
                "highlights": { "hue": 190.0, "saturation": 6.0, "luminance": 2.0 }
            },
            "curves": {
                "red": [[0.0, 16.0], [64.0, 74.0], [128.0, 128.0], [192.0, 192.0], [255.0, 244.0]]
            }
        });
        let b = json!({
            "exposure": -0.15,
            "contrast": 14.0,
            "colorGrading": {
                "shadows": { "hue": 215.0, "saturation": 14.0, "luminance": -4.0 }
            },
            "curves": {
                "red": [[0.0, 0.0], [64.0, 54.0], [128.0, 128.0], [192.0, 204.0], [255.0, 255.0]]
            }
        });
        let m = blend_patches(&a, &b, 0.6, 0.4).expect("同网格应混合");
        // 双方都有 → 加权平均：0.35×0.6 + (-0.15)×0.4 = 0.15
        assert!((num(&m, &["exposure"]) - 0.15).abs() < 1e-9);
        assert!((num(&m, &["contrast"]) - (-6.0 * 0.6 + 14.0 * 0.4)).abs() < 1e-9);
        // 仅 a 有 → 乘 a 的权重：-4×0.6 = -2.4
        assert!((num(&m, &["blacks"]) - (-2.4)).abs() < 1e-9);
        // 分区双方都有 → 三参数加权平均：hue 200×0.6+215×0.4 = 206
        assert!((num(&m, &["colorGrading", "shadows", "hue"]) - 206.0).abs() < 1e-9);
        assert!((num(&m, &["colorGrading", "shadows", "saturation"]) - 10.4).abs() < 1e-9);
        // 仅 a 有分区 → sat/lum ×w，hue 取该方
        assert!((num(&m, &["colorGrading", "highlights", "hue"]) - 190.0).abs() < 1e-9);
        assert!((num(&m, &["colorGrading", "highlights", "saturation"]) - 3.6).abs() < 1e-9);
        // curves：x 不变，y 加权平均：74×0.6 + 54×0.4 = 66
        let pt = &m["curves"]["red"][1];
        assert!((pt[0].as_f64().unwrap() - 64.0).abs() < 1e-9);
        assert!((pt[1].as_f64().unwrap() - 66.0).abs() < 1e-9);
    }

    #[test]
    fn test_blend_grid_mismatch_falls_back() {
        let a = json!({ "curves": { "red": [[0.0, 16.0], [64.0, 74.0], [128.0, 128.0], [192.0, 192.0], [255.0, 244.0]] } });
        let b = json!({ "curves": { "red": [[0.0, 0.0], [32.0, 54.0], [128.0, 128.0], [192.0, 204.0], [255.0, 255.0]] } });
        assert!(blend_patches(&a, &b, 0.6, 0.4).is_none(), "x 网格不同不混合");
        let b = json!({ "curves": { "green": [[0.0, 0.0], [64.0, 54.0], [128.0, 128.0], [192.0, 204.0], [255.0, 255.0]] } });
        assert!(blend_patches(&a, &b, 0.6, 0.4).is_none(), "通道集合不同不混合");
    }

    // ---------------- 图像自适应 ----------------

    #[test]
    fn test_scale_patch_by_image_stats() {
        // ① 高光溢出 → 压正 exposure：clip 0.1 → 因子 0.8
        let mut patch = json!({ "exposure": 0.35, "contrast": -6.0 });
        scale_patch_by_image_stats(
            &mut patch,
            &ImageStats {
                mean_luminance: 0.25,
                highlight_clip: 0.1,
                shadow_clip: 0.0,
            },
        );
        assert!((num(&patch, &["exposure"]) - 0.28).abs() < 1e-9);
        // ② 暗图 + 负对比 → 减半：-6 → -3
        assert!((num(&patch, &["contrast"]) - (-3.0)).abs() < 1e-9);

        // ③ 亮图 + 正 exposure → 减半：0.35 → 0.175
        let mut patch = json!({ "exposure": 0.35 });
        scale_patch_by_image_stats(
            &mut patch,
            &ImageStats {
                mean_luminance: 0.8,
                highlight_clip: 0.0,
                shadow_clip: 0.0,
            },
        );
        assert!((num(&patch, &["exposure"]) - 0.175).abs() < 1e-9);

        // ① 的因子下限 clamp 0.3：clip 0.5 → (1-1)=0 → 0.3
        let mut patch = json!({ "exposure": 0.35 });
        scale_patch_by_image_stats(
            &mut patch,
            &ImageStats {
                mean_luminance: 0.5,
                highlight_clip: 0.5,
                shadow_clip: 0.0,
            },
        );
        assert!((num(&patch, &["exposure"]) - 0.105).abs() < 1e-9);

        // 无裁切、亮度居中 → 原样
        let mut patch = json!({ "exposure": 0.35, "contrast": -6.0 });
        scale_patch_by_image_stats(
            &mut patch,
            &ImageStats {
                mean_luminance: 0.5,
                highlight_clip: 0.0,
                shadow_clip: 0.0,
            },
        );
        assert!((num(&patch, &["exposure"]) - 0.35).abs() < 1e-9);
        assert!((num(&patch, &["contrast"]) - (-6.0)).abs() < 1e-9);
    }

    #[test]
    fn test_image_luminance_stats_synthetic() {
        use image::Rgb;
        // 纯白图：mean=1.0，highlight_clip=1.0
        let white = image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            64,
            32,
            Rgb([255, 255, 255]),
        ));
        let s = image_luminance_stats(&white);
        assert!((s.mean_luminance - 1.0).abs() < 1e-9);
        assert!((s.highlight_clip - 1.0).abs() < 1e-9);
        assert!((s.shadow_clip - 0.0).abs() < 1e-9);

        // 纯黑图：mean=0.0，shadow_clip=1.0
        let black = image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            64,
            32,
            Rgb([0, 0, 0]),
        ));
        let s = image_luminance_stats(&black);
        assert!((s.mean_luminance - 0.0).abs() < 1e-9);
        assert!((s.shadow_clip - 1.0).abs() < 1e-9);
        assert!((s.highlight_clip - 0.0).abs() < 1e-9);

        // 中灰图：无裁切
        let gray = image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            64,
            32,
            Rgb([128, 128, 128]),
        ));
        let s = image_luminance_stats(&gray);
        assert!((s.mean_luminance - 128.0 / 255.0).abs() < 1e-9);
        assert!((s.highlight_clip - 0.0).abs() < 1e-9);
        assert!((s.shadow_clip - 0.0).abs() < 1e-9);

        // 长边 >1024 触发缩放路径：结果不变（纯色图）
        let big = image::DynamicImage::ImageRgb8(image::RgbImage::from_pixel(
            1100,
            64,
            Rgb([255, 255, 255]),
        ));
        let s = image_luminance_stats(&big);
        assert!((s.mean_luminance - 1.0).abs() < 1e-9);
        assert!((s.highlight_clip - 1.0).abs() < 1e-9);
    }
}
