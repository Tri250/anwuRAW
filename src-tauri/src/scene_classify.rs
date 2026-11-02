//! Crystal 移动端（W3）：场景识别。
//!
//! 基于真实像素统计（对当前已加载原图降采样后计算亮度/色相分布）做
//! 风景/人像/夜景/美食四类判别，输出置信度。这是无训练模型时的诚实实现：
//! 只输出统计特征可支撑的场景；置信度由特征强度与类间间隔共同决定，
//! 低置信度场景由前端静默降级（推荐卡不展示场景配方，不阻塞编辑）。
//! 输入为已加载原图的 `imageops` 缩略（64px 级），避免 RAW 全图二次解码。

use image::{DynamicImage, GenericImageView};
use serde::Serialize;

/// 与移动端 AiRecommendCard 的展示门槛一致（原方案边界：≥0.75 才展示）。
pub const DISPLAY_CONFIDENCE_GATE: f32 = 0.75;

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SceneClassification {
    /// "landscape" | "portrait" | "night" | "food"；空串表示无可靠判别。
    pub scene: String,
    pub confidence: f32,
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
        if r > 95.0 && g > 40.0 && b > 20.0 && max - min > 15.0 && (r - g).abs() > 15.0 && r > g && g > b {
            skin += 1;
        }
    }

    lumas.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let p = |q: f32| -> f32 {
        let idx = ((lumas.len() as f32 - 1.0) * q).round().clamp(0.0, lumas.len() as f32 - 1.0) as usize;
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

/// 识别当前已加载原图的场景。置信度 = 主类强度 - 次类惩罚；
/// 低于展示门槛时 scene 返回空串，前端按“无场景推荐”降级。
pub fn classify(img: &DynamicImage) -> SceneClassification {
    // 退化输入（0 尺寸）直接返回无判别；thumbnail 对 0 尺寸会钳制为
    // ≥1 像素，导致全黑 1x1 被误判为夜景，故在入口拦截。
    let (img_w, img_h) = img.dimensions();
    if img_w == 0 || img_h == 0 {
        return SceneClassification {
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
            scene: String::new(),
            confidence,
            tags: Vec::new(),
        };
    }

    SceneClassification {
        scene: best.to_string(),
        confidence,
        tags: vec![format!("luma {:.2}", s.mean_luma)],
    }
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
        assert_eq!(result.scene, "night", "expected night, got {}", result.scene);
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
        assert_eq!(result.scene, "landscape", "expected landscape, got {}", result.scene);
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
        let result = classify(&solid(0, 0, [0, 0, 0, 0]));
        assert_eq!(result.scene, "");
        assert!(result.confidence >= 0.0 && result.confidence <= 1.0);
    }
}
