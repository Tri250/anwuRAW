//! 程序化天空检测——ESAM3 sky prompt 不可用时的诚实降级路线。
//!
//! 参照 ZhaJinWenQianCake `engine/sky.py` 的零推理成本路线：
//! 颜色似然（蓝天色相带 ∪ 过曝低饱和）× 地平线衰减 × 上部先验，
//! 纯 CPU 像素运算，无神经网络依赖。掩膜质量低于 ESAM3（无分割约束，
//! 白墙/白衣可能误判），因此：
//! 1. 仅在 ESAM3 sky prompt 缺失时启用，结果通过 `ai_source = "procedural"`
//!    如实标注；
//! 2. 覆盖率守卫：掩膜覆盖 >85% 视为整图误判（白墙场景），诚实返回失败
//!    而不是产出一张全图被换的破坏性结果（参照 bgclean purity guard 思想）。
//!
//! 契约（与参照仓库对齐的三个约束）：
//! - 地平线约束：逐行似然从上往下找峰值 45% 行，该行以下强制清零——
//!   玻璃幕墙/水面的蓝天反光不该被替换；
//! - 上部强先验：越靠上越可能是天空，压地面亮斑误判；
//! - 输出为软掩膜（0-255 GrayImage），与 ESAM3 路径同构，直接进羽化合成。

use image::{DynamicImage, GrayImage};

/// 覆盖率守卫阈值：超过即认为颜色判据把非天空主体判了进去。
const MAX_COVERAGE: f32 = 0.85;

/// 单像素天空证据：`h` 度（0-360）、`s`/`v` 0-1。
///
/// 返回 `(似然, 是否由过曝白主导)`。主检测循环与单元测试共用这一处判据，
/// 避免蓝色带/高光公式在两处漂移；`bright` 主导的检出会被覆盖率与高光
/// 占比守卫进一步约束（该路径没有分割模型，不能凭颜色猜整片天空）。
fn sky_likelihood_pixel(h: f32, s: f32, v: f32) -> (f32, bool) {
    // 蓝天：190..250° 色相带，饱和适中、有一定亮度
    let blue = (1.0 - (h - 220.0).abs() / 40.0).clamp(0.0, 1.0)
        * ((s - 0.08) / 0.25).clamp(0.0, 1.0)
        * (v / 0.5).clamp(0.0, 1.0);
    // 过曝/阴天：极亮 + 极低饱和（白墙场景由覆盖率守卫兜底）
    let bright = ((v - 0.72) / 0.2).clamp(0.0, 1.0) * ((0.18 - s) / 0.18).clamp(0.0, 1.0);
    if blue >= bright {
        (blue.clamp(0.0, 1.0), false)
    } else {
        (bright.clamp(0.0, 1.0), true)
    }
}

/// 逐行似然 → 地平线行号（该行以下视为非天空）。
///
/// 参照 sky.py：顶部 1/4 的行均值峰值 ×0.45 作为衰减阈值，从上往下
/// 第一处低于阈值的行即地平线；顶 1/4 无有效信号时不强加地平线
/// （返回 h，等效于不裁剪——交给覆盖率守卫判断）。
fn detect_horizon(row_means: &[f32]) -> usize {
    let h = row_means.len();
    if h < 8 {
        return h;
    }
    let peak = row_means[..h / 4].iter().cloned().fold(0.0_f32, f32::max);
    if peak <= 0.05 {
        return h;
    }
    let thr = peak * 0.45;
    row_means.iter().position(|&m| m < thr).unwrap_or(h)
}

/// 5×5 结构元的形态学开运算（先腐蚀后膨胀），去除细碎误判斑点。
fn morph_open(mask: &[u8], w: usize, h: usize) -> Vec<u8> {
    let erode = |src: &[u8]| -> Vec<u8> {
        let mut out = vec![255u8; w * h];
        for y in 0..h {
            for x in 0..w {
                let mut min = 255u8;
                for dy in -2..=2i32 {
                    for dx in -2..=2i32 {
                        let ny = y as i32 + dy;
                        let nx = x as i32 + dx;
                        if ny >= 0 && ny < h as i32 && nx >= 0 && nx < w as i32 {
                            min = min.min(src[(ny as usize) * w + nx as usize]);
                        }
                    }
                }
                out[y * w + x] = min;
            }
        }
        out
    };
    let eroded = erode(mask);
    // 膨胀 = 对腐蚀结果取 5×5 邻域最大值
    let mut out = vec![0u8; w * h];
    for y in 0..h {
        for x in 0..w {
            let mut max = 0u8;
            for dy in -2..=2i32 {
                for dx in -2..=2i32 {
                    let ny = y as i32 + dy;
                    let nx = x as i32 + dx;
                    if ny >= 0 && ny < h as i32 && nx >= 0 && nx < w as i32 {
                        max = max.max(eroded[(ny as usize) * w + nx as usize]);
                    }
                }
            }
            out[y * w + x] = max;
        }
    }
    out
}

/// 程序化天空检测结果。
#[derive(Debug)]
pub struct ProceduralSky {
    pub mask: GrayImage,
    /// 掩膜覆盖率（>0.5 像素占比），供诊断/日志。
    pub coverage: f32,
    /// 地平线行号（该行以下掩膜为零）。
    pub horizon_row: usize,
}

/// 主入口：从 RGB 图产出软天空掩膜。
///
/// 失败语义：整图覆盖率超守卫阈值时返回 `Err`——调用方把它当作
/// 「未找到天空」诚实上报，绝不输出全图替换结果。
pub fn detect_procedural_sky(img: &DynamicImage) -> Result<ProceduralSky, String> {
    let rgb = img.to_rgb8();
    let (w, h) = (rgb.width() as usize, rgb.height() as usize);
    if w == 0 || h == 0 {
        return Err("empty image".into());
    }

    // 似然 + 逐行均值（单遍）。同时记录每个像素的判据来源：
    // 蓝色带是有信息量的天空证据；过曝低饱和（bright）对白墙/白衣/高光
    // 无判别力（参照仓库正是因此要求 bright 必须与分割相交）——程序化
    // 路线没有分割，用守卫限制 bright 主导的检出。
    let mut like = vec![0.0_f32; w * h];
    let mut from_bright = vec![false; w * h];
    let mut row_sums = vec![0.0_f32; h];
    for (i, p) in rgb.pixels().enumerate() {
        let (r, g, b) = (
            p[0] as f32 / 255.0,
            p[1] as f32 / 255.0,
            p[2] as f32 / 255.0,
        );
        let max = r.max(g).max(b);
        let min = r.min(g).min(b);
        let v = max;
        let s = if max <= 0.0 { 0.0 } else { (max - min) / max };
        let hh = if max - min <= 1e-6 {
            0.0
        } else if max == r {
            60.0 * (((g - b) / (max - min)) % 6.0)
        } else if max == g {
            60.0 * ((b - r) / (max - min) + 2.0)
        } else {
            60.0 * ((r - g) / (max - min) + 4.0)
        };
        let hh = if hh < 0.0 { hh + 360.0 } else { hh };
        // 单一真源：检测循环与单元测试共用同一个像素判据函数。
        let (l, is_bright) = sky_likelihood_pixel(hh, s, v);
        like[i] = l;
        from_bright[i] = is_bright;
        row_sums[i / w] += like[i];
    }
    let row_means: Vec<f32> = row_sums.iter().map(|s| s / w as f32).collect();
    let horizon = detect_horizon(&row_means);

    // 地平线衰减（5% 图高过渡带）+ 上部先验 + 软阈值
    let fade_band = (h as f32 * 0.05).max(1.0);
    let mut mask = vec![0u8; w * h];
    let mut coverage_px = 0usize;
    let mut bright_px = 0usize;
    for y in 0..h {
        let rows = y as f32;
        let fade = ((horizon as f32 + fade_band - rows) / fade_band).clamp(0.0, 1.0);
        let prior = (1.0 - rows / (h as f32 * 0.75)).clamp(0.25, 1.0);
        for x in 0..w {
            let l = like[y * w + x] * fade * prior;
            let m = ((l - 0.25) / 0.30).clamp(0.0, 1.0);
            let v = (m * 255.0).round() as u8;
            if v > 127 {
                coverage_px += 1;
                if from_bright[y * w + x] {
                    bright_px += 1;
                }
            }
            mask[y * w + x] = v;
        }
    }

    let coverage = coverage_px as f32 / (w * h) as f32;
    // 守卫 1：全图级误判（颜色判据把整个画面判成了天空）
    if coverage > MAX_COVERAGE {
        return Err(format!(
            "sky-like colour covers {:.0}% of the frame; refusing a full-frame \
             replacement (procedural detector needs the AI model for this image)",
            coverage * 100.0
        ));
    }
    // 守卫 2：检出区主要由过曝白贡献——白墙/白衣/大面积高光没有可判别的
    // 天空颜色证据（参照仓库要求 bright 与分割相交的原因），诚实拒绝。
    let bright_share = if coverage_px > 0 {
        bright_px as f32 / coverage_px as f32
    } else {
        0.0
    };
    if bright_share > 0.9 && coverage > 0.25 {
        return Err(format!(
            "detected sky region is {:.0}% blown-out highlights with no blue-sky \
             evidence; refusing a guess (download the AI sky model for this image)",
            bright_share * 100.0
        ));
    }

    let opened = morph_open(&mask, w, h);
    let gray = GrayImage::from_raw(w as u32, h as u32, opened)
        .ok_or_else(|| "failed to build procedural sky mask".to_string())?;
    Ok(ProceduralSky {
        mask: gray,
        coverage,
        horizon_row: horizon,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage};

    fn solid(rgb_img: [u8; 3], w: u32, hh: u32) -> DynamicImage {
        let mut img = RgbImage::new(w, hh);
        for y in 0..hh {
            for x in 0..w {
                img.put_pixel(x, y, Rgb(rgb_img));
            }
        }
        DynamicImage::ImageRgb8(img)
    }

    /// 上蓝下绿的合成「风景」图：蓝色上半应被检出，绿色下半应清零。
    #[test]
    fn detects_blue_sky_above_horizon() {
        let (w, hh) = (64u32, 64u32);
        let mut img = RgbImage::new(w, hh);
        for y in 0..hh {
            for x in 0..w {
                let c = if y < 32 {
                    [70, 130, 220]
                } else {
                    [40, 120, 50]
                };
                img.put_pixel(x, y, Rgb(c));
            }
        }
        let result = detect_procedural_sky(&DynamicImage::ImageRgb8(img));
        let sky = result.expect("blue sky scene should detect");
        assert!(sky.coverage > 0.1, "coverage too low: {}", sky.coverage);
        assert!(
            sky.horizon_row < 60,
            "horizon should sit in the lower part, got {}",
            sky.horizon_row
        );
        // 地平线以下强制清零
        let below = sky.mask.get_pixel(32, 63)[0];
        assert_eq!(below, 0, "ground row must stay zero");
        // 地平线以上应有检出
        let above = sky.mask.get_pixel(32, 8)[0];
        assert!(above > 127, "sky row should be detected, got {}", above);
    }

    /// 纯黑图：无任何天空信号 → 覆盖率 0，掩膜全零。
    #[test]
    fn dark_frame_yields_empty_mask() {
        let sky =
            detect_procedural_sky(&solid([8, 8, 10], 32, 32)).expect("dark frame should not error");
        assert!(sky.coverage < 0.01);
        assert_eq!(sky.horizon_row, 32);
        assert!(sky.mask.pixels().all(|p| p[0] == 0));
    }

    /// 纯白「墙」占满全图：覆盖率守卫必须拒绝，而不是返回全图掩膜。
    #[test]
    fn full_frame_whitewall_is_rejected_by_coverage_guard() {
        let result = detect_procedural_sky(&solid([248, 248, 246], 32, 32));
        let err = result.expect_err("white wall must trip the coverage guard");
        assert!(err.contains("refusing"), "unexpected error: {err}");
    }

    /// 覆盖率低于守卫阈值时不误拒（蓝天占 60% 的正常画面）。
    #[test]
    fn partial_sky_passes_guard() {
        let (w, hh) = (48u32, 48u32);
        let mut img = RgbImage::new(w, hh);
        for y in 0..hh {
            for x in 0..w {
                let c = if y < 24 { [80, 140, 230] } else { [30, 30, 34] };
                img.put_pixel(x, y, Rgb(c));
            }
        }
        let sky = detect_procedural_sky(&DynamicImage::ImageRgb8(img))
            .expect("partial sky should pass the guard");
        assert!(sky.coverage > 0.1 && sky.coverage < MAX_COVERAGE);
    }

    /// 单调性：同一画面加大天空信号强度（更饱和的蓝），检出似然不降低。
    #[test]
    fn likelihood_is_monotonic_in_signal_strength() {
        let (weak, _) = sky_likelihood_pixel(220.0, 0.12, 0.6);
        let (strong, _) = sky_likelihood_pixel(220.0, 0.30, 0.8);
        assert!(strong >= weak, "stronger sky signal must not score lower");
        // 色相偏离中心带时似然下降
        let (offband, _) = sky_likelihood_pixel(300.0, 0.30, 0.8);
        assert!(offband < strong);
    }
}
