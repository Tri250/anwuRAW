//! Crystal 移动端（W3）：场景识别。
//!
//! 双通道实现（P0-1，release v2.1.16）：
//! 1. **CLIP 零样本分类**（首选）：复用文本蒙版 / AI 标签同款
//!    `clip_model.onnx` + tokenizer（零新增下载），对 4 类场景的 prompt
//!    ensemble（每类 8 条英文提示）做一次前向，softmax 概率按类内平均
//!    得到场景置信度——概率语义替代手工权重合成。
//! 2. **统计启发式**（降级链）：CLIP 模型未下载（调用方用免下载初始化
//!    判定）或推理失败时，完整回落到基于真实像素统计的启发式（天空蓝/
//!    植被绿/暖色/皮肤比例 + 亮度分位）。
//!
//! 两条通道共用同一展示门槛（`DISPLAY_CONFIDENCE_GATE` = 0.75）：低于
//! 门槛时 scene 返回空串，前端按「无场景推荐」降级、不阻塞编辑。
//! CLIP 通道另有批内分位数校准（`batch_calibrate`）：一整组连贯场景
//! （如夜景相册）的原始概率可能整体落在门槛下方，按最近一批的分布
//! 校准，避免批次被整体压掉。
//! 输入为已加载原图的缩略（启发式 64px / CLIP 224px），避免 RAW 全图
//! 二次解码。

use std::collections::VecDeque;
use std::sync::Mutex;

use crate::ai_processing::ClipModels;
use image::{DynamicImage, GenericImageView};
use ndarray::Array;
use ort::value::Tensor;
use serde::Serialize;

/// 与移动端 AiRecommendCard 的展示门槛一致（原方案边界：≥0.75 才展示）。
pub const DISPLAY_CONFIDENCE_GATE: f32 = 0.75;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SceneClassification {
    /// "landscape" | "portrait" | "night" | "food"；空串表示无可靠判别。
    pub scene: String,
    pub confidence: f32,
    /// 判别来源："clip"（零样本 CLIP 通道）|"heuristic"（统计启发式）。
    /// 参照 ZhaJinWenQianCake 的可诊断性契约：能力来源必须如实上报，
    /// 前端与日志据此区分置信度语义（二者 confidence 不可比）。
    pub source: String,
    pub tags: Vec<String>,
}

#[derive(Clone, Copy, Debug, Default)]
struct Stats {
    mean_luma: f32,
    dark_ratio: f32,
    contrast: f32,
    /// 天空蓝占上三分之一像素的比例。
    sky_ratio: f32,
    green_ratio: f32,
    /// 暖色高饱和像素（食物特征）比例。
    warm_ratio: f32,
    skin_ratio: f32,
    mean_sat: f32,
}

fn clamp01(v: f32) -> f32 {
    v.clamp(0.0, 1.0)
}

fn collect_stats(img: &DynamicImage) -> Stats {
    let small = img.thumbnail(64, 64);
    let rgba = small.to_rgba8();
    let (w, h) = rgba.dimensions();
    if w == 0 || h == 0 {
        return Stats::default();
    }

    let sky_rows = (h / 3).max(1);
    let total = (w * h) as f32;
    let sky_total = (w * sky_rows) as f32;

    let mut dark = 0u32;
    let mut sky_blue = 0u32;
    let mut green = 0u32;
    let mut warm = 0u32;
    let mut skin = 0u32;
    let mut luma_sum = 0f32;
    let mut sat_sum = 0f32;
    let mut lumas: Vec<f32> = Vec::with_capacity((w * h) as usize);

    for (_x, y, px) in rgba.enumerate_pixels() {
        let r = px[0] as f32;
        let g = px[1] as f32;
        let b = px[2] as f32;
        let luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255.0;
        let max = r.max(g).max(b);
        let min = r.min(g).min(b);
        let sat = if max > 0.0 { (max - min) / max } else { 0.0 };

        luma_sum += luma;
        sat_sum += sat;
        lumas.push(luma);
        if luma < 0.25 {
            dark += 1;
        }

        // HSV 色相（0..360），供天空/植被/暖色判别。
        let (hue, _sat_h, val) = hsv_from_rgb(r / 255.0, g / 255.0, b / 255.0);
        if y < sky_rows && (190.0..=260.0).contains(&hue) && sat > 0.22 && val > 0.3 {
            sky_blue += 1;
        }
        if (70.0..=165.0).contains(&hue) && sat > 0.2 && val > 0.2 {
            green += 1;
        }
        if (hue <= 50.0 || hue >= 330.0) && sat > 0.3 && val > 0.25 {
            warm += 1;
        }
        // 经典皮肤启发（0-255 域）：R>95, G>40, B>20, max-min>15, |R-G|>15, R>G, R>B。
        if r > 95.0
            && g > 40.0
            && b > 20.0
            && max - min > 15.0
            && (r - g).abs() > 15.0
            && r > g
            && g > b
        {
            skin += 1;
        }
    }

    lumas.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let p = |q: f32| -> f32 {
        let idx = ((lumas.len() as f32 - 1.0) * q)
            .round()
            .clamp(0.0, lumas.len() as f32 - 1.0) as usize;
        lumas[idx]
    };
    let contrast = (p(0.9) - p(0.1)).max(0.0);

    Stats {
        mean_luma: luma_sum / total,
        dark_ratio: dark as f32 / total,
        contrast,
        sky_ratio: sky_blue as f32 / sky_total,
        green_ratio: green as f32 / total,
        warm_ratio: warm as f32 / total,
        skin_ratio: skin as f32 / total,
        mean_sat: sat_sum / total,
    }
}

fn hsv_from_rgb(r: f32, g: f32, b: f32) -> (f32, f32, f32) {
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let d = max - min;
    let v = max;
    let s = if max > 0.0 { d / max } else { 0.0 };
    let h = if d <= 0.0 {
        0.0
    } else if (max - r).abs() < f32::EPSILON {
        60.0 * (((g - b) / d) % 6.0)
    } else if (max - g).abs() < f32::EPSILON {
        60.0 * ((b - r) / d + 2.0)
    } else {
        60.0 * ((r - g) / d + 4.0)
    };
    (h.rem_euclid(360.0), s, v)
}

/// 对单类打分（0..1）：信号强度子项 + 亮度/环境合法性子项。
fn score_landscape(s: &Stats) -> f32 {
    let sig = clamp01((s.sky_ratio.max(s.green_ratio) - 0.12) / 0.33);
    let bright_ok = clamp01(s.mean_luma / 0.25);
    sig * 0.7 + clamp01(s.contrast / 0.5) * 0.15 + bright_ok * 0.15
}

fn score_portrait(s: &Stats) -> f32 {
    let sig = clamp01((s.skin_ratio - 0.05) / 0.3);
    let env_ok = 1.0 - clamp01((s.green_ratio.max(s.sky_ratio) - 0.35) / 0.3);
    let bright_ok = clamp01(s.mean_luma / 0.25);
    sig * 0.65 + env_ok * 0.2 + bright_ok * 0.15
}

fn score_night(s: &Stats) -> f32 {
    let sig = clamp01((0.5 - s.mean_luma) / 0.38);
    sig * 0.55 + clamp01(s.dark_ratio / 0.85) * 0.35 + (1.0 - clamp01(s.mean_sat / 0.8)) * 0.1
}

fn score_food(s: &Stats) -> f32 {
    let sig = clamp01((s.warm_ratio - 0.08) / 0.35);
    let sat_ok = clamp01(s.mean_sat / 0.4);
    let bright_ok = clamp01(s.mean_luma / 0.3);
    sig * 0.6 + sat_ok * 0.2 + bright_ok * 0.2
}

/// 识别当前已加载原图的场景（统计启发式通道）。置信度 = 主类强度 - 次类惩罚；
/// 低于展示门槛时 scene 返回空串，前端按"无场景推荐"降级。
pub fn classify(img: &DynamicImage) -> SceneClassification {
    // 退化输入（0 尺寸）直接返回无判别；thumbnail 对 0 尺寸会钳制为
    // ≥1 像素，导致全黑 1x1 被误判为夜景，故在入口拦截。
    let (img_w, img_h) = img.dimensions();
    if img_w == 0 || img_h == 0 {
        return SceneClassification {
            source: "heuristic".to_string(),
            scene: String::new(),
            confidence: 0.0,
            tags: Vec::new(),
        };
    }

    let s = collect_stats(img);
    let candidates: [(&str, f32); 4] = [
        ("landscape", score_landscape(&s)),
        ("portrait", score_portrait(&s)),
        ("night", score_night(&s)),
        ("food", score_food(&s)),
    ];
    let (best, best_score) = candidates
        .iter()
        .copied()
        .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
        .unwrap_or(("", 0.0));
    let second_score = candidates
        .iter()
        .copied()
        .filter(|(name, _)| *name != best)
        .map(|(_, v)| v)
        .fold(0.0f32, f32::max);

    let confidence = clamp01(best_score * 1.15 - second_score * 0.3);
    if best_score < 0.3 || confidence < DISPLAY_CONFIDENCE_GATE {
        return SceneClassification {
            source: "heuristic".to_string(),
            scene: String::new(),
            confidence,
            tags: Vec::new(),
        };
    }

    SceneClassification {
            source: "heuristic".to_string(),
        scene: best.to_string(),
        confidence,
        tags: vec![format!("luma {:.2}", s.mean_luma)],
    }
}

/* ------------------------------ CLIP 零样本通道（P0-1） ------------------------------ */

/// CLIP 零样本 prompt ensemble：每类 8 条英文提示（CLIP 论文的提示集成做法，
/// 与 tokenizer/模型的英文训练分布一致）。类内概率平均作为该类置信度。
const SCENE_PROMPTS: [(&str, [&str; 8]); 4] = [
    (
        "landscape",
        [
            "a photo of a landscape",
            "a photo of mountains and sky",
            "a wide scenic view of nature",
            "a photo of a forest and trees",
            "a photo of a lake and mountains",
            "a photo of a field under the sky",
            "a photo of a beach and the ocean",
            "a photo of the countryside",
        ],
    ),
    (
        "portrait",
        [
            "a portrait photo of a person",
            "a close-up photo of a face",
            "a photo of a man",
            "a photo of a woman",
            "a selfie of a person",
            "a studio portrait of a person",
            "a photo of a person smiling",
            "a headshot photo of a person",
        ],
    ),
    (
        "night",
        [
            "a photo taken at night",
            "a night scene with city lights",
            "a dark photo of the night sky",
            "a photo of a street at night",
            "a low light photo at night",
            "a photo of fireworks at night",
            "a photo of stars in the night sky",
            "a dimly lit photo after sunset",
        ],
    ),
    (
        "food",
        [
            "a close-up photo of food",
            "a photo of a meal on a plate",
            "a photo of a dessert",
            "a photo of a drink",
            "a photo of food on a table",
            "a photo of a cooked dish",
            "a photo of a burger and fries",
            "a photo of a bowl of soup",
        ],
    ),
];

/// 批内校准窗口：保留最近这么多次 CLIP 原始最佳概率（会话内滑动窗口，
/// 只记录 CLIP 通道——启发式的置信度是另一套手工合成分，语义不同）。
const SCENE_BATCH_WINDOW: usize = 24;
/// 批次连贯性下限：窗口中位数低于该值视为「混杂相册」，不做批内提升。
const SCENE_BATCH_FLOOR: f32 = 0.6;
/// 启动批内校准所需的最小样本数（样本不足时只信单图绝对概率）。
const SCENE_BATCH_MIN_SAMPLES: usize = 8;

static RECENT_SCENE_PROBS: Mutex<VecDeque<f32>> = Mutex::new(VecDeque::new());

/// 纯函数：给定本图原始最佳概率与最近一批原始概率，返回校准后置信度。
/// - 原始概率已过门槛：原样返回（无需校准）；
/// - 样本不足或批次不连贯（中位数 < 0.6）：原样返回——宁可不出推荐，
///   也不把混杂相册里的低置信图推上门槛；
/// - 本图不低于批次中位数且批次连贯：提升到展示门槛。一整组夜景的
///   概率分布通常整体落在 0.75 下方，按批内相对水平仍有推荐价值
///   （阈值取批次自身分位数，不用固定常数）。
fn batch_calibrate(raw: f32, recent: &[f32]) -> f32 {
    if raw >= DISPLAY_CONFIDENCE_GATE || recent.len() < SCENE_BATCH_MIN_SAMPLES {
        return raw;
    }
    let mut sorted: Vec<f32> = recent.to_vec();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let median = sorted[sorted.len() / 2];
    if median >= SCENE_BATCH_FLOOR && raw >= median {
        return DISPLAY_CONFIDENCE_GATE;
    }
    raw
}

fn push_recent_scene_prob(raw: f32) {
    let mut recent = RECENT_SCENE_PROBS.lock().unwrap();
    if recent.len() == SCENE_BATCH_WINDOW {
        recent.pop_front();
    }
    recent.push_back(raw);
}

/// CLIP 零样本场景分类（首选通道）。推理失败（会话损坏 / OOM 等）时
/// 诚实降级到统计启发式，与「模型未下载」的降级链汇合。
pub fn classify_with_clip(clip: &ClipModels, img: &DynamicImage) -> SceneClassification {
    let (img_w, img_h) = img.dimensions();
    if img_w == 0 || img_h == 0 {
        return SceneClassification {
            source: "clip".to_string(),
            scene: String::new(),
            confidence: 0.0,
            tags: Vec::new(),
        };
    }

    let Some(probs) = clip_scene_probabilities(clip, img) else {
        log::warn!("CLIP scene inference failed, falling back to pixel statistics");
        return classify(img);
    };

    let (best_idx, best) = probs
        .iter()
        .enumerate()
        .max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))
        .map(|(i, &v)| (i, v))
        .unwrap_or((0, 0.0));

    let recent: Vec<f32> = RECENT_SCENE_PROBS
        .lock()
        .unwrap()
        .iter()
        .copied()
        .collect();
    let confidence = batch_calibrate(best, &recent);
    push_recent_scene_prob(best);

    let tags = vec![format!("clip {:.2}", best)];
    if confidence < DISPLAY_CONFIDENCE_GATE {
        return SceneClassification {
            source: "clip".to_string(),
            scene: String::new(),
            confidence,
            tags,
        };
    }

    SceneClassification {
            source: "clip".to_string(),
        scene: SCENE_PROMPTS[best_idx].0.to_string(),
        confidence,
        tags,
    }
}

/// 跑一次 CLIP 前向（图像塔 + 32 条场景提示文本塔），返回 4 类场景概率。
/// 输入约定与 tagging 的 `generate_tags_with_clip` 完全一致：inputs!
/// 位置序为 [input_ids, pixel_values, attention_mask]，输出 logits_per_image
/// （该 ONNX 导出已含训练学得的 logit_scale），softmax 即概率。任何一步
/// 失败返回 None（调用方降级）。
fn clip_scene_probabilities(clip: &ClipModels, img: &DynamicImage) -> Option<[f32; 4]> {
    let image_input = crate::tagging::preprocess_clip_image(img);

    let prompts: Vec<String> = SCENE_PROMPTS
        .iter()
        .flat_map(|(_, ps)| ps.iter().map(|s| s.to_string()))
        .collect();
    let encodings = clip.tokenizer.encode_batch(prompts.clone(), true).ok()?;
    let max_len = encodings
        .iter()
        .map(|e| e.get_ids().len())
        .max()
        .unwrap_or(0);
    if max_len == 0 {
        return None;
    }

    let mut ids_data = Vec::new();
    let mut mask_data = Vec::new();
    for encoding in encodings {
        let mut ids: Vec<i64> = encoding.get_ids().iter().map(|&i| i as i64).collect();
        let mut mask: Vec<i64> = encoding
            .get_attention_mask()
            .iter()
            .map(|&m| m as i64)
            .collect();
        ids.resize(max_len, 0);
        mask.resize(max_len, 0);
        ids_data.extend_from_slice(&ids);
        mask_data.extend_from_slice(&mask);
    }
    let ids_array = Array::from_shape_vec((prompts.len(), max_len), ids_data).ok()?;
    let mask_array = Array::from_shape_vec((prompts.len(), max_len), mask_data).ok()?;

    let image_val =
        Tensor::from_array(image_input.into_dyn().as_standard_layout().into_owned()).ok()?;
    let ids_val = Tensor::from_array(ids_array.into_dyn().as_standard_layout().into_owned()).ok()?;
    let mask_val = Tensor::from_array(mask_array.into_dyn().as_standard_layout().into_owned()).ok()?;

    let mut session = clip.model.lock().unwrap();
    let outputs = crate::ai_processing::gpu_inference(session.run(ort::inputs![
        ids_val, image_val, mask_val
    ]))
    .ok()?;
    let logits_dyn = outputs[0].try_extract_array::<f32>().ok()?.to_owned();
    let logits = logits_dyn
        .into_dimensionality::<ndarray::Dim<[usize; 2]>>()
        .ok()?;
    let row = logits.row(0);
    if row.len() != prompts.len() {
        return None;
    }
    let max = row.iter().fold(f32::NEG_INFINITY, |a, &b| a.max(b));
    let exps: Vec<f32> = row.iter().map(|&x| (x - max).exp()).collect();
    let sum: f32 = exps.iter().sum();
    if !sum.is_finite() || sum <= 0.0 {
        return None;
    }

    // 类内平均：prompt ensemble 的概率平均（该 ONNX 为图像+文本联合导出，
    // 拿不到裸 embedding，故按 CLIP 论文集成做法的概率形式平均）。
    let mut probs = [0f32; 4];
    let mut idx = 0usize;
    for (slot, (_, ps)) in probs.iter_mut().zip(SCENE_PROMPTS.iter()) {
        let group = &exps[idx..idx + ps.len()];
        *slot = group.iter().sum::<f32>() / (ps.len() as f32 * sum);
        idx += ps.len();
    }
    Some(probs)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    fn solid(w: u32, h: u32, color: [u8; 4]) -> DynamicImage {
        DynamicImage::ImageRgba8(image::ImageBuffer::from_fn(w, h, |_, _| Rgba(color)))
    }

    #[test]
    fn night_scene_detected_with_high_confidence() {
        // 大面积深色 + 少量灯光：夜景统计特征。
        let img = DynamicImage::ImageRgba8(image::ImageBuffer::from_fn(64, 64, |x, y| {
            if x > 40 && y > 40 {
                Rgba([240, 200, 120, 255])
            } else if x % 9 == 0 && y % 7 == 0 {
                Rgba([90, 90, 110, 255])
            } else {
                Rgba([18, 20, 30, 255])
            }
        }));
        let result = classify(&img);
        assert_eq!(
            result.scene, "night",
            "expected night, got {}",
            result.scene
        );
        assert!(result.confidence >= DISPLAY_CONFIDENCE_GATE);
    }

    #[test]
    fn sky_landscape_detected() {
        // 上 1/3 蓝天 + 下部绿色植被。
        let img = DynamicImage::ImageRgba8(image::ImageBuffer::from_fn(64, 64, |_x, y| {
            if y < 20 {
                Rgba([110, 170, 235, 255])
            } else {
                Rgba([70, 130, 60, 255])
            }
        }));
        let result = classify(&img);
        assert_eq!(
            result.scene, "landscape",
            "expected landscape, got {}",
            result.scene
        );
        assert!(result.confidence >= DISPLAY_CONFIDENCE_GATE);
    }

    #[test]
    fn uniform_ambiguous_image_has_no_scene() {
        // 纯灰图：无任何场景信号，必须返回空 scene（前端据此隐藏配方）。
        let result = classify(&solid(64, 64, [128, 128, 128, 255]));
        assert_eq!(result.scene, "");
    }

    #[test]
    fn empty_image_is_safe() {
        let result = classify(&solid(0, 0, [0, 0, 0, 255]));
        assert_eq!(result.scene, "");
        assert!(result.confidence >= 0.0 && result.confidence <= 1.0);
    }

    #[test]
    fn batch_calibrate_passes_high_confidence() {
        // 已过门槛的原始概率不受批内校准影响。
        assert_eq!(batch_calibrate(0.9, &[0.4; 12]), 0.9);
    }

    #[test]
    fn batch_calibrate_needs_enough_samples() {
        // 样本不足 8 个：只信单图绝对概率，不做批内提升。
        let recent = [0.7f32; 4];
        assert_eq!(batch_calibrate(0.68, &recent), 0.68);
    }

    #[test]
    fn batch_calibrate_rejects_incoherent_batch() {
        // 混杂相册（中位数 0.3 < 0.6）：不把低置信图推上门槛。
        let recent = [0.3f32; 12];
        assert_eq!(batch_calibrate(0.5, &recent), 0.5);
    }

    #[test]
    fn batch_calibrate_promotes_top_of_coherent_batch() {
        // 一整组夜景：原始概率整体落在门槛下方，但批次连贯（中位数 ≥ 0.6）。
        // 不低于批次中位数的图提升到门槛，避免整批被压掉；低于中位数不提升。
        let recent: Vec<f32> = (0..12).map(|i| 0.60 + i as f32 * 0.01).collect();
        let top = batch_calibrate(0.70, &recent);
        assert!(
            top >= DISPLAY_CONFIDENCE_GATE,
            "coherent batch top should be promoted, got {top}"
        );
        let bottom = batch_calibrate(0.61, &recent);
        assert!(
            bottom < DISPLAY_CONFIDENCE_GATE,
            "below-median image should stay gated, got {bottom}"
        );
    }

    /// P0-1：prompt 表完整性——4 类 × 每类 8 条、类名与前端 SceneKey
    /// 对齐、无空串。clip_scene_probabilities 按每类固定条数做组内平均，
    /// 表结构被破坏会静默错分（组边界错位），故钉死。
    #[test]
    fn scene_prompt_table_integrity() {
        assert_eq!(SCENE_PROMPTS.len(), 4);
        let names: Vec<&str> = SCENE_PROMPTS.iter().map(|(name, _)| *name).collect();
        assert_eq!(names, vec!["landscape", "portrait", "night", "food"]);
        for (name, prompts) in SCENE_PROMPTS.iter() {
            assert_eq!(prompts.len(), 8, "{name} must have 8 prompts");
            assert!(
                prompts.iter().all(|p| !p.trim().is_empty()),
                "{name} has an empty prompt"
            );
        }
    }

    /// P0-1：批内校准窗口——push 超过窗口容量必须淘汰最旧样本。批次
    /// 校准依赖窗口只反映"最近一批"，否则早期图片的概率会污染新批次的
    /// 中位数（参照仓库"阈值取批次自身分位数"口径的前提）。
    #[test]
    fn recent_scene_prob_window_is_bounded() {
        for i in 0..(SCENE_BATCH_WINDOW as i32 + 5) {
            push_recent_scene_prob(i as f32 / 100.0);
        }
        let recent = RECENT_SCENE_PROBS.lock().unwrap();
        assert_eq!(recent.len(), SCENE_BATCH_WINDOW);
        // 最旧的 5 条被淘汰：队首是第 5 次推入的值
        assert_eq!(recent.front(), Some(&(5f32 / 100.0)));
        assert_eq!(
            recent.back(),
            Some(&((SCENE_BATCH_WINDOW as i32 + 4) as f32 / 100.0))
        );
    }
}
