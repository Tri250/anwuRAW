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
//! 后续若接入云端参考图链路（方案 B）：由云端生成调色参考小图后走
//! `crate::color_transfer` 的 MKL 拟合，本模块的词库可作为提示词构造器。

use serde_json::{json, Value};

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

/// 风格定义：id、中文名、双语词库（词, 权重）、参数配方。
pub struct StyleDef {
    pub id: &'static str,
    pub name: &'static str,
    pub keywords: &'static [(&'static str, f64)],
    pub patch: fn() -> Value,
}

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
    pub style_name: Option<&'static str>,
    pub confidence: f64,
    /// 各风格得分（按得分降序）
    pub scores: Vec<(&'static str, f64)>,
    pub matched_terms: Vec<String>,
    pub adjustments: Option<Value>,
}

impl StyleSuggestion {
    pub fn to_json(&self) -> Value {
        json!({
            "styleId": self.style_id,
            "styleName": self.style_name,
            "confidence": self.confidence,
            "scores": self.scores.iter().map(|(id, s)| json!({ "id": id, "score": s })).collect::<Vec<_>>(),
            "matchedTerms": self.matched_terms,
            "adjustments": self.adjustments,
        })
    }
}

const STYLE_DEFS: &[StyleDef] = &[
    StyleDef {
        id: "clear_japanese",
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
        name: "暗调情绪",
        keywords: &[
            ("暗调", 2.5),
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

/// 命中单个词条（大小写不敏感）。
fn contains_term(haystack_lower: &str, term_lower: &str) -> bool {
    haystack_lower.contains(term_lower)
}

/// 根据用户自然语言描述推断风格并产出参数配方。
///
/// - 命中为空：`style_id=None`、`adjustments=None`（上层回退 AI 一键增强）；
/// - 命中非空：取最高分风格，confidence 由得分换算；平票时取词库中更靠前
///   （更常用）的风格。
pub fn suggest_style(text: &str) -> StyleSuggestion {
    let lower = text.to_lowercase();
    let mut scores: Vec<(&'static str, f64)> = STYLE_DEFS.iter().map(|d| (d.id, 0.0)).collect();
    let mut matched_terms: Vec<String> = Vec::new();

    for def in STYLE_DEFS {
        let idx = scores.iter().position(|(id, _)| *id == def.id).unwrap();
        for (term, weight) in def.keywords {
            if contains_term(&lower, &term.to_lowercase()) {
                scores[idx].1 += weight;
                if !matched_terms.iter().any(|t| t == *term) {
                    matched_terms.push((*term).to_string());
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
            adjustments: None,
        };
    }
    let def = STYLE_DEFS.iter().find(|d| d.id == best_id).unwrap();
    StyleSuggestion {
        style_id: Some(def.id),
        style_name: Some(def.name),
        confidence: score_to_confidence(best_score),
        scores,
        matched_terms,
        adjustments: Some((def.patch)()),
    }
}

/// 「一句话调色」命令：自然语言描述 → 风格 + 非破坏性参数补丁。
/// 纯本地词库映射，无网络/模型依赖，瞬时返回。
#[tauri::command]
pub fn ai_style_suggest(prompt: String) -> Value {
    suggest_style(&prompt).to_json()
}

#[cfg(test)]
mod tests {
    use super::*;

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
}
