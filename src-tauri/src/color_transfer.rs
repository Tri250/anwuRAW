//! F-03 AI 追色（样片 → 客片 颜色传递）。
//!
//! Reinhard et al. 2001《Color Transfer between Images》：在 CIE Lab 空间做
//! 均值-方差匹配，再把匹配结果反解为管线既有的非破坏性调整字段
//! （`curves` + `colorGrading`）。输出为可直接编辑/复位的调整补丁，
//! 不烘焙像素。
//!
//! 反解与管线的对应关系（shader.wgsl）：
//! - `apply_color_grading`：线性域加性 tint，`sat/lum` 滑杆值 ÷ 500 后使用；
//!   仅 `saturation > 0` 时叠加 `(hsv_to_rgb(hue,1,1) - 0.5) * sat * mask * strength`。
//! - `apply_curve`：tonemap 之后的编码 sRGB 域逐通道曲线（0..255 控制点）。

use image::{DynamicImage, GenericImageView};
use serde_json::{Value, json};
use std::path::Path;

const ANALYSIS_DIM: u32 = 384;
/// 滑杆 ±100 ÷ 500 = shader 域 ±0.2
const MAX_TINT_SHADER: f64 = 0.2;
/// shadows / midtones / highlights 的 tint 强度（shader.wgsl apply_color_grading）
const ZONE_SAT_STRENGTHS: [f64; 3] = [0.1, 0.6, 0.8];
const ZONE_LUM_STRENGTHS: [f64; 3] = [0.5, 0.8, 1.0];
const LUMA_COEFF: [f64; 3] = [0.2126, 0.7152, 0.0722];
/// CIE Lab 转换用 sRGB(D65) → XYZ 矩阵
const SRGB_TO_XYZ: [[f64; 3]; 3] = [
    [0.4124564, 0.3575761, 0.1804375],
    [0.2126729, 0.7151522, 0.0721750],
    [0.0193339, 0.1191920, 0.9503041],
];
const WHITE_D65: [f64; 3] = [0.95047, 1.0, 1.08883];

struct ImageStats {
    /// 线性域逐通道均值
    lin_mean: [f64; 3],
    /// 分区（shadows/midtones/highlights）线性均值与像素占比
    zone_lin_mean: [[f64; 3]; 3],
    zone_frac: [f64; 3],
    /// 编码像素（0..1），用于模拟
    enc_pixels: Vec<[f32; 3]>,
    luma_hist: [f64; 32],
}

#[derive(Clone, Copy)]
struct TintFit {
    hue: f64,
    /// shader 域（滑杆值 / 500）
    sat: f64,
    lum: f64,
}

fn srgb_decode(v: f64) -> f64 {
    if v <= 0.04045 {
        v / 12.92
    } else {
        ((v + 0.055) / 1.055).powf(2.4)
    }
}

fn srgb_encode(v: f64) -> f64 {
    let v = v.clamp(0.0, 1.0);
    if v <= 0.0031308 {
        v * 12.92
    } else {
        1.055 * v.powf(1.0 / 2.4) - 0.055
    }
}

fn to_linear(enc: [f64; 3]) -> [f64; 3] {
    [
        srgb_decode(enc[0]),
        srgb_decode(enc[1]),
        srgb_decode(enc[2]),
    ]
}

fn to_enc(lin: [f64; 3]) -> [f64; 3] {
    [
        srgb_encode(lin[0]),
        srgb_encode(lin[1]),
        srgb_encode(lin[2]),
    ]
}

fn lab_f(t: f64) -> f64 {
    const EPS: f64 = 216.0 / 24389.0;
    const K: f64 = 24389.0 / 27.0;
    if t > EPS {
        t.cbrt()
    } else {
        (K * t + 16.0) / 116.0
    }
}

fn linear_to_lab(lin: [f64; 3]) -> [f64; 3] {
    let xyz: Vec<f64> = SRGB_TO_XYZ
        .iter()
        .map(|row| row.iter().zip(lin.iter()).map(|(a, b)| a * b).sum())
        .collect();
    let f: Vec<f64> = xyz
        .iter()
        .zip(WHITE_D65.iter())
        .map(|(c, w)| lab_f(c / w))
        .collect();
    [
        116.0 * f[1] - 16.0,
        500.0 * (f[0] - f[1]),
        200.0 * (f[1] - f[2]),
    ]
}

fn delta_e76(a: [f64; 3], b: [f64; 3]) -> f64 {
    let d0 = a[0] - b[0];
    let d1 = a[1] - b[1];
    let d2 = a[2] - b[2];
    (d0 * d0 + d1 * d1 + d2 * d2).sqrt()
}

/// shader.wgsl `hsv_to_rgb(vec3(h, 1, 1))`：gamma 域纯色相颜色。
fn wheel_rgb(h_deg: f64) -> [f64; 3] {
    let h = h_deg.rem_euclid(360.0);
    let x = 1.0 - ((h / 60.0) % 2.0 - 1.0).abs();
    let (r, g, b) = if h < 60.0 {
        (1.0, x, 0.0)
    } else if h < 120.0 {
        (x, 1.0, 0.0)
    } else if h < 180.0 {
        (0.0, 1.0, x)
    } else if h < 240.0 {
        (0.0, x, 1.0)
    } else if h < 300.0 {
        (x, 0.0, 1.0)
    } else {
        (1.0, 0.0, x)
    };
    [r, g, b]
}

/// shader.wgsl `get_luma`
fn luma(lin: [f64; 3]) -> f64 {
    lin[0] * LUMA_COEFF[0] + lin[1] * LUMA_COEFF[1] + lin[2] * LUMA_COEFF[2]
}

/// shader.wgsl `apply_color_grading` 的分区权重（blending=50、balance=0）。
fn zone_masks(l: f64) -> [f64; 3] {
    let feather = 0.2 * 0.5;
    let shadow = 1.0 - smoothstep(0.1 - feather, 0.1 + feather, l);
    let highlight = smoothstep(0.5 - feather, 0.5 + feather, l);
    let midtone = (1.0 - shadow - highlight).max(0.0);
    [shadow, midtone, highlight]
}

fn smoothstep(edge0: f64, edge1: f64, x: f64) -> f64 {
    let t = ((x - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

/// 对期望的线性域偏移向量 v，拟合 `sat_s·s·d(hue) + sat_l·lum·[1,1,1]`（s ≥ 0）。
/// 固定 hue 下按最小二乘解 (s, lum)，在 0..360 网格上取残差最小者。
/// `sat_s`/`sat_l` 为该分区的 tint 亮度强度（shader.wgsl）。
fn fit_tint(v: [f64; 3], sat_s: f64, sat_l: f64) -> TintFit {
    let mean_v = (v[0] + v[1] + v[2]) / 3.0;
    let u = [v[0] - mean_v, v[1] - mean_v, v[2] - mean_v];
    let u_norm = (u[0] * u[0] + u[1] * u[1] + u[2] * u[2]).sqrt();
    if u_norm < 1e-6 {
        // 纯亮度偏移，无色相可表达
        let lum = (mean_v / sat_l).clamp(-MAX_TINT_SHADER, MAX_TINT_SHADER);
        return TintFit {
            hue: 0.0,
            sat: 0.0,
            lum,
        };
    }
    let mut best = TintFit {
        hue: 0.0,
        sat: 0.0,
        lum: 0.0,
    };
    let mut best_resid = f64::INFINITY;
    for h in 0..360 {
        let d = wheel_rgb(h as f64);
        let mean_d = (d[0] + d[1] + d[2]) / 3.0;
        let dc = [
            sat_s * (d[0] - mean_d),
            sat_s * (d[1] - mean_d),
            sat_s * (d[2] - mean_d),
        ];
        let dc2 = dc[0] * dc[0] + dc[1] * dc[1] + dc[2] * dc[2];
        if dc2 < 1e-9 {
            continue;
        }
        let s = (u[0] * dc[0] + u[1] * dc[1] + u[2] * dc[2]) / dc2;
        if s <= 1e-5 {
            continue; // shader 仅支持正向 tint（saturation > 0 才生效）
        }
        let s_clamped = s.min(MAX_TINT_SHADER);
        let resid2 = u_norm * u_norm - s_clamped * s_clamped * dc2;
        if resid2 < best_resid {
            best_resid = resid2;
            best = TintFit {
                hue: h as f64,
                sat: s_clamped,
                lum: ((mean_v - s_clamped * sat_s * mean_d) / sat_l)
                    .clamp(-MAX_TINT_SHADER, MAX_TINT_SHADER),
            };
        }
    }
    best
}

impl TintFit {
    /// 单个像素（mask=1）的线性域贡献
    fn shift(&self, sat_s: f64, sat_l: f64) -> [f64; 3] {
        let d = wheel_rgb(self.hue);
        [
            sat_s * self.sat * d[0] + sat_l * self.lum,
            sat_s * self.sat * d[1] + sat_l * self.lum,
            sat_s * self.sat * d[2] + sat_l * self.lum,
        ]
    }

    fn is_zero(&self) -> bool {
        self.sat.abs() < 1e-4 && self.lum.abs() < 1e-4
    }
}

fn analyze_image(img: &DynamicImage) -> ImageStats {
    let thumb = img.thumbnail(ANALYSIS_DIM, ANALYSIS_DIM);
    let (width, height) = thumb.dimensions();
    let enc_f32 = thumb.to_rgb32f();
    let pixel_count = (width * height) as f64;

    let enc_pixels: Vec<[f32; 3]> = enc_f32
        .chunks_exact(3)
        .map(|c| [c[0], c[1], c[2]])
        .collect();

    let lin_pixels: Vec<[f64; 3]> = enc_pixels
        .iter()
        .map(|p| to_linear([p[0] as f64, p[1] as f64, p[2] as f64]))
        .collect();

    let mut lin_sum = [0f64; 3];
    let mut zone_sum = [[0f64; 3]; 3];
    let mut zone_n = [0f64; 3];
    let mut luma_hist = [0f64; 32];
    for lin in &lin_pixels {
        for c in 0..3 {
            lin_sum[c] += lin[c];
        }
        let l = luma(*lin);
        let masks = zone_masks(l);
        for z in 0..3 {
            if masks[z] > 0.5 {
                zone_n[z] += 1.0;
                for c in 0..3 {
                    zone_sum[z][c] += lin[c];
                }
            }
        }
        let enc_y = srgb_encode(l.clamp(0.0, 1.0));
        let bin = ((enc_y * 32.0) as usize).min(31);
        luma_hist[bin] += 1.0;
    }

    let lin_mean = [
        lin_sum[0] / pixel_count,
        lin_sum[1] / pixel_count,
        lin_sum[2] / pixel_count,
    ];
    let zone_lin_mean = std::array::from_fn(|z| {
        if zone_n[z] > 0.0 {
            [
                zone_sum[z][0] / zone_n[z],
                zone_sum[z][1] / zone_n[z],
                zone_sum[z][2] / zone_n[z],
            ]
        } else {
            lin_mean
        }
    });

    ImageStats {
        lin_mean,
        zone_lin_mean,
        zone_frac: [
            zone_n[0] / pixel_count,
            zone_n[1] / pixel_count,
            zone_n[2] / pixel_count,
        ],
        enc_pixels,
        luma_hist,
    }
}

/// 逐通道分位数匹配曲线（编码域 0..255 控制点）。
/// 以 tint 后的预测编码值 vs 样片编码值的分位数构造单调控制点，
/// 渲染端 curves 以 monotone cubic 插值执行；对单调映射可近乎精确复原。
fn fit_curves_quantile(
    pred_ch: &[Vec<f64>; 3],
    sample_ch: &[Vec<f64>; 3],
) -> [Option<Vec<[f64; 2]>>; 3] {
    const QUANTILES: [f64; 7] = [0.02, 0.15, 0.35, 0.5, 0.65, 0.85, 0.98];
    const MIN_PIXELS: usize = 16;
    let mut out: [Option<Vec<[f64; 2]>>; 3] = [const { None }; 3];
    for c in 0..3 {
        let mut p: Vec<f64> = pred_ch[c].clone();
        let mut s: Vec<f64> = sample_ch[c].clone();
        if p.len() < MIN_PIXELS || s.len() < MIN_PIXELS {
            continue;
        }
        p.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        s.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let quantile = |v: &[f64], q: f64| -> f64 {
            let idx = (q * (v.len() - 1) as f64).round() as usize;
            v[idx]
        };

        let pts: Vec<[f64; 2]> = QUANTILES
            .iter()
            .map(|&q| [quantile(&p, q) * 255.0, quantile(&s, q) * 255.0])
            .collect();

        // 端点锚：用最近两点线性外推至 0 / 255
        let slope0 = if pts[0][0] > 1.0 {
            (pts[1][1] - pts[0][1]) / (pts[1][0] - pts[0][0]).max(1e-3)
        } else {
            1.0
        };
        let y0 = (pts[0][1] - slope0 * pts[0][0]).clamp(0.0, 255.0);
        let n = pts.len();
        let slope1 = if pts[n - 1][0] < 254.0 {
            (pts[n - 1][1] - pts[n - 2][1]) / (pts[n - 1][0] - pts[n - 2][0]).max(1e-3)
        } else {
            1.0
        };
        let y255 = (pts[n - 1][1] + slope1 * (255.0 - pts[n - 1][0])).clamp(0.0, 255.0);

        let mut full: Vec<[f64; 2]> = Vec::with_capacity(n + 2);
        full.push([0.0, y0]);
        full.extend(pts);
        full.push([255.0, y255]);

        // x 严格递增、y 单调不减整理
        let mut mono: Vec<[f64; 2]> = Vec::with_capacity(full.len());
        for &[x, y] in &full {
            if let Some(&[lx, ly]) = mono.last() {
                if x <= lx + 0.5 || y < ly - 0.5 {
                    continue;
                }
            }
            mono.push([x, y]);
        }

        // 恒等检测：所有点近似 y=x → 不输出曲线
        if mono.len() < 3 || mono.iter().all(|&[x, y]| (y - x).abs() < 1.5) {
            continue;
        }
        out[c] = Some(mono);
    }
    out
}

/// 分段线性插值执行曲线（0..1 域；控制点为 0..255）。
fn apply_curve_map(enc: f64, curve: Option<&[[f64; 2]]>) -> f64 {
    let Some(pts) = curve else { return enc };
    if pts.len() < 2 {
        return enc;
    }
    let v = (enc * 255.0).clamp(0.0, 255.0);
    let slope = |i: usize| -> f64 {
        let dx = pts[i + 1][0] - pts[i][0];
        if dx.abs() < 1e-3 {
            0.0
        } else {
            (pts[i + 1][1] - pts[i][1]) / dx
        }
    };
    let y = if v <= pts[0][0] {
        pts[0][1] + slope(0) * (v - pts[0][0])
    } else if v >= pts[pts.len() - 1][0] {
        let n = pts.len();
        pts[n - 1][1] + slope(n - 2) * (v - pts[n - 1][0])
    } else {
        for w in pts.windows(2) {
            if v <= w[1][0] {
                let dx = w[1][0] - w[0][0];
                let t = if dx < 1e-3 { 0.0 } else { (v - w[0][0]) / dx };
                return (w[0][1] + t * (w[1][1] - w[0][1])) / 255.0;
            }
        }
        v
    };
    (y / 255.0).clamp(0.0, 1.0)
}

fn chi_square(h1: &[f64; 32], h2: &[f64; 32]) -> f64 {
    let n1: f64 = h1.iter().sum();
    let n2: f64 = h2.iter().sum();
    if n1 < 1.0 || n2 < 1.0 {
        return 0.0;
    }
    let mut chi = 0.0;
    for i in 0..32 {
        let a = h1[i] / n1;
        let b = h2[i] / n2;
        chi += (a - b) * (a - b) / (a + b + 1e-9);
    }
    chi * 0.5
}

pub fn compute_color_transfer(
    sample: &DynamicImage,
    target: &DynamicImage,
) -> Result<(Value, Value), String> {
    let s = analyze_image(sample);
    let t = analyze_image(target);
    if s.enc_pixels.is_empty() || t.enc_pixels.is_empty() {
        return Err("Empty image".to_string());
    }

    // 阶段 1：全局 tint（线性域，先于曲线，符合管线顺序；全局强度 sat=1.0/lum=1.0）
    let v_global = [
        s.lin_mean[0] - t.lin_mean[0],
        s.lin_mean[1] - t.lin_mean[1],
        s.lin_mean[2] - t.lin_mean[2],
    ];
    let global = fit_tint(v_global, 1.0, 1.0);
    let gs = global.shift(1.0, 1.0);

    // 阶段 2：分区 tint（在全局之后的残余，逐分区强度反解）
    let mut zones = [TintFit {
        hue: 0.0,
        sat: 0.0,
        lum: 0.0,
    }; 3];
    for z in 0..3 {
        if t.zone_frac[z] < 0.02 {
            continue;
        }
        // 分区内像素期望的残余均值偏移 = 分区均值差 - 全局 tint 已覆盖部分
        let residual = [
            s.zone_lin_mean[z][0] - t.zone_lin_mean[z][0] - gs[0],
            s.zone_lin_mean[z][1] - t.zone_lin_mean[z][1] - gs[1],
            s.zone_lin_mean[z][2] - t.zone_lin_mean[z][2] - gs[2],
        ];
        if residual.iter().all(|c| c.abs() < 1e-5) {
            continue;
        }
        let fit = fit_tint(residual, ZONE_SAT_STRENGTHS[z], ZONE_LUM_STRENGTHS[z]);
        if !fit.is_zero() {
            zones[z] = fit;
        }
    }

    // 阶段 3：模拟 全局+分区 tint 后的编码域，拟合逐通道曲线
    let zone_shifts: Vec<[f64; 3]> = (0..3)
        .map(|z| zones[z].shift(ZONE_SAT_STRENGTHS[z], ZONE_LUM_STRENGTHS[z]))
        .collect();
    let mut pred_enc_ch: [Vec<f64>; 3] = [Vec::new(), Vec::new(), Vec::new()];
    let t_lin: Vec<[f64; 3]> = t
        .enc_pixels
        .iter()
        .map(|p| to_linear([p[0] as f64, p[1] as f64, p[2] as f64]))
        .collect();
    for lin in &t_lin {
        let l = luma(*lin);
        let masks = zone_masks(l);
        let mut out = [0f64; 3];
        for c in 0..3 {
            let mut v = lin[c] + gs[c];
            for z in 0..3 {
                v += zone_shifts[z][c] * masks[z];
            }
            out[c] = v;
        }
        let enc = to_enc(out);
        for c in 0..3 {
            pred_enc_ch[c].push(enc[c]);
        }
    }
    let sample_enc_ch: [Vec<f64>; 3] =
        std::array::from_fn(|c| s.enc_pixels.iter().map(|p| p[c] as f64).collect());
    let curves = fit_curves_quantile(&pred_enc_ch, &sample_enc_ch);

    // 最终模拟（tint → 编码 → 曲线），计算度量
    let sample_lin: Vec<[f64; 3]> = s
        .enc_pixels
        .iter()
        .map(|p| to_linear([p[0] as f64, p[1] as f64, p[2] as f64]))
        .collect();
    let mut de_before = 0.0;
    let mut de_after = 0.0;
    let mut hist_after = [0f64; 32];
    for i in 0..t_lin.len() {
        let lin_t = t_lin[i];
        let l = luma(lin_t);
        let masks = zone_masks(l);
        let mut v = [0f64; 3];
        for c in 0..3 {
            let mut x = lin_t[c] + gs[c];
            for z in 0..3 {
                x += zone_shifts[z][c] * masks[z];
            }
            v[c] = apply_curve_map(srgb_encode(x.clamp(0.0, 1.0)), curves[c].as_deref());
        }
        let lin_final = to_linear(v);
        let bin = ((v[0] * 0.2126 + v[1] * 0.7152 + v[2] * 0.0722) * 32.0) as usize;
        hist_after[bin.min(31)] += 1.0;
        // 抽样计算 ΔE（1/4 像素）控制开销
        if i % 4 == 0 {
            let lab_t = linear_to_lab(lin_t);
            let lab_f = linear_to_lab(lin_final);
            let lab_s = linear_to_lab(sample_lin[i]);
            de_before += delta_e76(lab_t, lab_s);
            de_after += delta_e76(lab_f, lab_s);
        }
    }
    let sampled = (t_lin.len() / 4).max(1) as f64;
    de_before /= sampled;
    de_after /= sampled;

    // 输出补丁（仅非默认字段）
    let mut patch = serde_json::Map::new();
    let mut cg = serde_json::Map::new();
    let global_json = json!({
        "hue": global.hue, "saturation": global.sat * 500.0, "luminance": global.lum * 500.0,
    });
    if !global.is_zero() {
        cg.insert("global".into(), global_json);
    }
    for (name, fit) in [("shadows", 0), ("midtones", 1), ("highlights", 2)] {
        if !zones[fit].is_zero() {
            cg.insert(
                name.into(),
                json!({
                    "hue": zones[fit].hue,
                    "saturation": zones[fit].sat * 500.0,
                    "luminance": zones[fit].lum * 500.0,
                }),
            );
        }
    }
    if !cg.is_empty() {
        patch.insert("colorGrading".into(), Value::Object(cg));
    }
    let mut curves_json = serde_json::Map::new();
    for (name, curve) in [
        ("red", &curves[0]),
        ("green", &curves[1]),
        ("blue", &curves[2]),
    ] {
        if let Some(pts) = curve {
            let mut prev_x = -1.0;
            let points: Vec<Value> = pts
                .iter()
                .map(|[x, y]| {
                    let xr = (*x).round().clamp(0.0, 255.0).max(prev_x + 1.0);
                    prev_x = xr;
                    json!({ "x": xr, "y": (*y).round().clamp(0.0, 255.0) })
                })
                .collect();
            curves_json.insert((*name).into(), Value::Array(points));
        }
    }
    if !curves_json.is_empty() {
        patch.insert("curves".into(), Value::Object(curves_json));
    }

    let metrics = json!({
        "deltaEMeanBefore": de_before,
        "deltaEMeanAfter": de_after,
        "deltaEReduction": if de_before > 1e-6 { ((1.0 - de_after / de_before) * 100.0).clamp(0.0, 100.0) } else { 0.0 },
        "chiSquareBefore": chi_square(&t.luma_hist, &s.luma_hist),
        "chiSquareAfter": chi_square(&hist_after, &s.luma_hist),
    });
    Ok((Value::Object(patch), metrics))
}

/// F-04d：计算掩膜区域内像素的线性域均值（mask ≥ 128 视为选中）。
pub fn region_mean_linear(image: &DynamicImage, mask: &image::GrayImage) -> Option<[f64; 3]> {
    let (w, h) = image.dimensions();
    if mask.width() != w || mask.height() != h {
        return None;
    }
    let rgb = image.to_rgb32f();
    let mut sum = [0f64; 3];
    let mut n = 0f64;
    for (x, y, m) in mask.enumerate_pixels() {
        if m[0] < 128 {
            continue;
        }
        let px = rgb.get_pixel(x, y);
        let lin = to_linear([px[0] as f64, px[1] as f64, px[2] as f64]);
        for c in 0..3 {
            sum[c] += lin[c];
        }
        n += 1.0;
    }
    (n > 0.0).then(|| [sum[0] / n, sum[1] / n, sum[2] / n])
}

/// 将期望的线性域偏移反解为 colorGrading.global 滑杆值 (hue, saturation, luminance)。
pub fn tint_sliders_for_shift(v: [f64; 3]) -> (f64, f64, f64) {
    let fit = fit_tint(v, 1.0, 1.0);
    (fit.hue, fit.sat * 500.0, fit.lum * 500.0)
}

fn load_analysis_image(
    path: &str,
    settings: &crate::app_settings::AppSettings,
) -> Result<DynamicImage, String> {
    if crate::file_management::is_cloud_placeholder(Path::new(path)) {
        return Err(format!("'{}' is stored in iCloud and not downloaded", path));
    }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    crate::image_loader::load_base_image_from_bytes(&bytes, path, true, settings, None)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn compute_color_match(
    app_handle: tauri::AppHandle,
    sample_path: String,
    target_path: String,
) -> Result<Value, String> {
    tokio::task::spawn_blocking(move || -> Result<Value, String> {
        let settings = crate::app_settings::load_settings(app_handle).unwrap_or_default();
        let sample = load_analysis_image(&sample_path, &settings)?;
        let target = load_analysis_image(&target_path, &settings)?;
        let (adjustments, metrics) = compute_color_transfer(&sample, &target)?;
        Ok(json!({ "adjustments": adjustments, "metrics": metrics }))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{Rgb, RgbImage};

    fn gradient_image() -> DynamicImage {
        let mut img = RgbImage::new(128, 128);
        for (x, y, pixel) in img.enumerate_pixels_mut() {
            let r = (x * 255 / 127) as u8;
            let g = (y * 255 / 127) as u8;
            let b = ((x + y) * 255 / 254) as u8;
            *pixel = Rgb([r, g, b]);
        }
        DynamicImage::ImageRgb8(img)
    }

    /// 模拟样片：暖色偏移 + 提亮 + 饱和度拉伸
    fn warm_sample(base: &DynamicImage) -> DynamicImage {
        let mut img = RgbImage::new(base.width(), base.height());
        let rgb = base.to_rgb8();
        for (x, y, pixel) in img.enumerate_pixels_mut() {
            let p = rgb.get_pixel(x, y);
            let lin = to_linear([
                p[0] as f64 / 255.0,
                p[1] as f64 / 255.0,
                p[2] as f64 / 255.0,
            ]);
            let shifted = [
                (lin[0] * 1.25 + 0.02).clamp(0.0, 1.0),
                (lin[1] * 1.05).clamp(0.0, 1.0),
                (lin[2] * 0.85).clamp(0.0, 1.0),
            ];
            let enc = to_enc(shifted);
            *pixel = Rgb([
                (enc[0] * 255.0).round() as u8,
                (enc[1] * 255.0).round() as u8,
                (enc[2] * 255.0).round() as u8,
            ]);
        }
        DynamicImage::ImageRgb8(img)
    }

    #[test]
    fn test_identity_returns_empty_patch() {
        let img = gradient_image();
        let (patch, metrics) = compute_color_transfer(&img, &img).unwrap();
        assert!(
            patch.get("colorGrading").is_none(),
            "identity 应无 colorGrading"
        );
        assert!(patch.get("curves").is_none(), "identity 应无 curves");
        assert!(metrics["deltaEMeanAfter"].as_f64().unwrap() < 0.5);
    }

    #[test]
    fn test_synthetic_match_reduces_delta_e() {
        let target = gradient_image();
        let sample = warm_sample(&target);
        let (patch, metrics) = compute_color_transfer(&sample, &target).unwrap();
        let before = metrics["deltaEMeanBefore"].as_f64().unwrap();
        let after = metrics["deltaEMeanAfter"].as_f64().unwrap();
        assert!(before > 2.0, "合成样片应有明显差异，before={before}");
        // 验收标准：差异下降 ≥ 60%
        assert!(
            after < before * 0.4,
            "追色后 ΔE 应下降 ≥60%，before={before}, after={after}, patch={patch}"
        );
    }

    #[test]
    fn test_patch_values_within_slider_ranges() {
        let target = gradient_image();
        let sample = warm_sample(&target);
        let (patch, _) = compute_color_transfer(&sample, &target).unwrap();
        if let Some(cg) = patch.get("colorGrading") {
            for zone in ["global", "shadows", "midtones", "highlights"] {
                if let Some(z) = cg.get(zone) {
                    let hue = z["hue"].as_f64().unwrap();
                    let sat = z["saturation"].as_f64().unwrap();
                    let lum = z["luminance"].as_f64().unwrap();
                    assert!((0.0..=360.0).contains(&hue), "hue={hue}");
                    assert!((0.0..=100.0).contains(&sat), "sat={sat}");
                    assert!((-100.0..=100.0).contains(&lum), "lum={lum}");
                }
            }
        }
    }
}
