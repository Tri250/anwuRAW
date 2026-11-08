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
    /// 原图宽高（空间对应 ΔE 的门控与宽高比诊断用；聚合统计置 0 表示非单图）。
    /// 配对本身在分析缩略图上进行：原图同尺寸 ⇒ 缩略图必同尺寸，下标直配安全。
    width: u32,
    height: u32,
    /// 线性域逐通道均值
    lin_mean: [f64; 3],
    /// 分区（shadows/midtones/highlights）线性均值与像素占比
    zone_lin_mean: [[f64; 3]; 3],
    zone_frac: [f64; 3],
    /// 编码像素（0..1），用于模拟
    enc_pixels: Vec<[f32; 3]>,
    luma_hist: [f64; 32],
    /// Oklab 高斯统计：全局 + 三分区（MKL 传输的输入）
    global_gauss: Gaussian,
    zone_gauss: [Gaussian; 3],
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

/* ------------------------------ Oklab + MKL 协方差传输（借鉴 language-guided-lut） ------------------------------ */

/// Oklab（Björn Ottosson）常数：linear sRGB → LMS → Oklab，及其逆映射。
/// 相比 CIE Lab，Oklab 在感知均匀性上更接近理想，青-黄轴的预测畸变更小，
/// 协方差传输（MKL）对色相旋转的表达更稳定。
const OKLAB_M1: [[f64; 3]; 3] = [
    [0.4122214708, 0.5363325363, 0.0514459929],
    [0.2119034982, 0.6806995451, 0.1073969566],
    [0.0883024619, 0.2817188376, 0.6299787005],
];
const OKLAB_M2: [[f64; 3]; 3] = [
    [0.2104542553, 0.7936177850, -0.0040720468],
    [1.9779984951, -2.4285922050, 0.4505937099],
    [0.0259040371, 0.7827717662, -0.8086757660],
];
/// Oklab → LMS'（cube 前），LMS' → linear sRGB。
const OKLAB_M1_INV: [[f64; 3]; 3] = [
    [1.0, 0.3963377774, 0.2158037573],
    [1.0, -0.1055613458, -0.0638541728],
    [1.0, -0.0894841775, -1.2914855480],
];
const OKLAB_M2_INV: [[f64; 3]; 3] = [
    [4.0767416621, -3.3077115913, 0.2309699292],
    [-1.2684380046, 2.6097574011, -0.3413193965],
    [-0.0041960863, -0.7034186147, 1.7076147010],
];
/// 协方差正则化（与 language-guided-lut 一致）：保证可逆与数值稳定。
const COV_REG: f64 = 1e-6;
/// MKL 协方差不变式 `A·C_s·Aᵀ ≈ C_t` 的相对误差阈值。
const MKL_INVARIANT_TOL: f64 = 1e-5;

fn mat3_vec(m: &[[f64; 3]; 3], v: [f64; 3]) -> [f64; 3] {
    [
        m[0][0] * v[0] + m[0][1] * v[1] + m[0][2] * v[2],
        m[1][0] * v[0] + m[1][1] * v[1] + m[1][2] * v[2],
        m[2][0] * v[0] + m[2][1] * v[1] + m[2][2] * v[2],
    ]
}

fn mat3_mul(a: &[[f64; 3]; 3], b: &[[f64; 3]; 3]) -> [[f64; 3]; 3] {
    let mut out = [[0.0; 3]; 3];
    for i in 0..3 {
        for j in 0..3 {
            out[i][j] = (0..3).map(|k| a[i][k] * b[k][j]).sum();
        }
    }
    out
}

fn mat3_transpose(m: &[[f64; 3]; 3]) -> [[f64; 3]; 3] {
    [
        [m[0][0], m[1][0], m[2][0]],
        [m[0][1], m[1][1], m[2][1]],
        [m[0][2], m[1][2], m[2][2]],
    ]
}

fn mat3_frobenius(m: &[[f64; 3]; 3]) -> f64 {
    m.iter()
        .flat_map(|row| row.iter())
        .map(|v| v * v)
        .sum::<f64>()
        .sqrt()
}

/// 线性域 RGB → Oklab。
fn to_oklab(lin: [f64; 3]) -> [f64; 3] {
    let lms = mat3_vec(&OKLAB_M1, lin);
    let c = [
        lms[0].max(0.0).cbrt(),
        lms[1].max(0.0).cbrt(),
        lms[2].max(0.0).cbrt(),
    ];
    mat3_vec(&OKLAB_M2, c)
}

/// Oklab → 线性域 RGB（不做 gamma 编码，保持管线线性域）。
fn from_oklab(lab: [f64; 3]) -> [f64; 3] {
    let lms = mat3_vec(&OKLAB_M1_INV, lab);
    let l = [lms[0].powi(3), lms[1].powi(3), lms[2].powi(3)];
    mat3_vec(&OKLAB_M2_INV, l)
}

/// Oklab 高斯统计（均值 + 协方差，协方差加 `1e-6·I` 正则）。
#[derive(Clone, Copy, Debug, Default)]
struct Gaussian {
    mean: [f64; 3],
    cov: [[f64; 3]; 3],
    count: u64,
}

impl Gaussian {
    fn is_empty(&self) -> bool {
        self.count == 0
    }
}

/// 累加器：在线计算 Oklab 高斯统计（避免物化样本列表）。
#[derive(Default)]
struct GaussianAccumulator {
    n: u64,
    sum: [f64; 3],
    /// 上三角外积和：xx, xy, xz, yy, yz, zz
    outer: [f64; 6],
}

impl GaussianAccumulator {
    fn push(&mut self, v: [f64; 3]) {
        self.n += 1;
        self.sum[0] += v[0];
        self.sum[1] += v[1];
        self.sum[2] += v[2];
        self.outer[0] += v[0] * v[0];
        self.outer[1] += v[0] * v[1];
        self.outer[2] += v[0] * v[2];
        self.outer[3] += v[1] * v[1];
        self.outer[4] += v[1] * v[2];
        self.outer[5] += v[2] * v[2];
    }

    fn finish(&self) -> Gaussian {
        if self.n == 0 {
            return Gaussian::default();
        }
        let n = self.n as f64;
        let mean = [self.sum[0] / n, self.sum[1] / n, self.sum[2] / n];
        let mut cov = [[0.0; 3]; 3];
        if self.n > 1 {
            // 样本协方差（N-1），与 numpy.cov 一致
            let d = n - 1.0;
            let raw = [
                [self.outer[0], self.outer[1], self.outer[2]],
                [self.outer[1], self.outer[3], self.outer[4]],
                [self.outer[2], self.outer[4], self.outer[5]],
            ];
            for i in 0..3 {
                for j in 0..3 {
                    cov[i][j] = (raw[i][j] - n * mean[i] * mean[j]) / d;
                }
            }
        }
        for i in 0..3 {
            cov[i][i] += COV_REG;
        }
        Gaussian {
            mean,
            cov,
            count: self.n,
        }
    }
}

/// 对称矩阵特征分解（Jacobi 旋转法），返回 (特征值, 特征向量列矩阵)。
fn sym_eigen(m: &[[f64; 3]; 3]) -> ([f64; 3], [[f64; 3]; 3]) {
    let mut a = *m;
    let mut v = [[1.0, 0.0, 0.0], [0.0, 1.0, 0.0], [0.0, 0.0, 1.0]];
    for _ in 0..64 {
        // 找最大非对角元
        let (mut p, mut q, mut max_off) = (0usize, 1usize, 0.0f64);
        for i in 0..3 {
            for j in (i + 1)..3 {
                if a[i][j].abs() > max_off {
                    max_off = a[i][j].abs();
                    p = i;
                    q = j;
                }
            }
        }
        if max_off < 1e-15 {
            break;
        }
        let app = a[p][p];
        let aqq = a[q][q];
        let apq = a[p][q];
        let tau = (aqq - app) / (2.0 * apq);
        let t = if tau >= 0.0 {
            1.0 / (tau + (1.0 + tau * tau).sqrt())
        } else {
            -1.0 / (-tau + (1.0 + tau * tau).sqrt())
        };
        let c = 1.0 / (1.0 + t * t).sqrt();
        let s = t * c;
        // 旋转 A
        for i in 0..3 {
            let (aip, aiq) = (a[i][p], a[i][q]);
            a[i][p] = c * aip - s * aiq;
            a[i][q] = s * aip + c * aiq;
        }
        for j in 0..3 {
            let (apj, aqj) = (a[p][j], a[q][j]);
            a[p][j] = c * apj - s * aqj;
            a[q][j] = s * apj + c * aqj;
        }
        // 旋转 V（累积特征向量）
        for i in 0..3 {
            let (vip, viq) = (v[i][p], v[i][q]);
            v[i][p] = c * vip - s * viq;
            v[i][q] = s * vip + c * viq;
        }
    }
    ([a[0][0], a[1][1], a[2][2]], v)
}

/// PSD 矩阵幂：V·diag(max(λ, floor)^p)·Vᵀ。
/// 负指数（开方逆）使用相对特征值下限，避免把嵌套协方差的正平方根
/// 截断到常数而人为放大色度（与 language-guided-lut 同口径）。
fn psd_power(m: &[[f64; 3]; 3], exponent: f64) -> [[f64; 3]; 3] {
    let (eval, evec) = sym_eigen(m);
    let floor = if exponent < 0.0 {
        eval.iter().cloned().fold(f64::NEG_INFINITY, f64::max) * 1e-12
    } else {
        0.0
    };
    let floor = floor.max(1e-15);
    let mut d = [[0.0; 3]; 3];
    for i in 0..3 {
        d[i][i] = eval[i].max(floor).powf(exponent);
    }
    mat3_mul(&mat3_mul(&evec, &d), &mat3_transpose(&evec))
}

/// MKL 线性 Monge-Kantorovitch 传输（Pitié & Kokaram 2007）：
/// `A = C_s^(-1/2)·(C_s^(1/2)·C_t·C_s^(1/2))^(1/2)·C_s^(-1/2)`，`b = μ_t - A·μ_s`。
/// 返回 (A, b, 协方差不变式相对误差)。不变量超阈值时返回 Err（调用方降级）。
fn mkl_transport(src: &Gaussian, dst: &Gaussian) -> Result<([[f64; 3]; 3], [f64; 3], f64), String> {
    let cs_half = psd_power(&src.cov, 0.5);
    let cs_inv_half = psd_power(&src.cov, -0.5);
    let mid = mat3_mul(&mat3_mul(&cs_half, &dst.cov), &cs_half);
    let mid_sqrt = psd_power(&mid, 0.5);
    let a = mat3_mul(&mat3_mul(&cs_inv_half, &mid_sqrt), &cs_inv_half);
    // 对称化，消掉特征分解/迭代的数值不对称
    let a = [
        [a[0][0], (a[0][1] + a[1][0]) / 2.0, (a[0][2] + a[2][0]) / 2.0],
        [(a[1][0] + a[0][1]) / 2.0, a[1][1], (a[1][2] + a[2][1]) / 2.0],
        [(a[2][0] + a[0][2]) / 2.0, (a[2][1] + a[1][2]) / 2.0, a[2][2]],
    ];
    let acsa = mat3_mul(&mat3_mul(&a, &src.cov), &mat3_transpose(&a));
    let denom = mat3_frobenius(&dst.cov).max(1e-15);
    let err = mat3_frobenius(&[
        [
            acsa[0][0] - dst.cov[0][0],
            acsa[0][1] - dst.cov[0][1],
            acsa[0][2] - dst.cov[0][2],
        ],
        [
            acsa[1][0] - dst.cov[1][0],
            acsa[1][1] - dst.cov[1][1],
            acsa[1][2] - dst.cov[1][2],
        ],
        [
            acsa[2][0] - dst.cov[2][0],
            acsa[2][1] - dst.cov[2][1],
            acsa[2][2] - dst.cov[2][2],
        ],
    ]) / denom;
    if !err.is_finite() {
        return Err("MKL invariant is not finite".to_string());
    }
    if err > MKL_INVARIANT_TOL {
        return Err(format!(
            "MKL covariance invariant failed: relative error {err:.2e}"
        ));
    }
    let b = [
        dst.mean[0] - (a[0][0] * src.mean[0] + a[0][1] * src.mean[1] + a[0][2] * src.mean[2]),
        dst.mean[1] - (a[1][0] * src.mean[0] + a[1][1] * src.mean[1] + a[1][2] * src.mean[2]),
        dst.mean[2] - (a[2][0] * src.mean[0] + a[2][1] * src.mean[1] + a[2][2] * src.mean[2]),
    ];
    Ok((a, b, err))
}

/* ------------------------------ 多参考图聚合（借鉴 language-guided-lut aggregate） ------------------------------ */

/// 多样片统计聚合模式（language-guided-lut METHODS 的子集）。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum AggregateMode {
    /// 统计量平均：Σ wᵢ·Cᵢ（无迭代，最稳）
    MeanCov,
    /// Wasserstein 重心：不动点解（Alvarez-Esteban et al. 2008）
    Bures,
    /// 稳健加权重心：W2 medoid + 软截尾权重后的 Bures
    RobustBures,
}

impl Default for AggregateMode {
    /// 与 language-guided-lut 默认一致：多样片精修走 bures。
    fn default() -> Self {
        Self::Bures
    }
}

impl AggregateMode {
    /// 命令参数字符串 → 模式（未知值返回 None，由调用方报错）。
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "mean-cov" => Some(Self::MeanCov),
            "bures" => Some(Self::Bures),
            "robust-bures" => Some(Self::RobustBures),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::MeanCov => "mean-cov",
            Self::Bures => "bures",
            Self::RobustBures => "robust-bures",
        }
    }
}

fn mat3_sub(a: &[[f64; 3]; 3], b: &[[f64; 3]; 3]) -> [[f64; 3]; 3] {
    std::array::from_fn(|i| std::array::from_fn(|j| a[i][j] - b[i][j]))
}

/// 两个 Oklab 高斯的 Bures/Wasserstein-2 距离平方：
/// ‖μa-μb‖² + tr(Ca + Cb - 2·(Ca^½·Cb·Ca^½)^½)。
fn gaussian_w2_sq(a: &Gaussian, b: &Gaussian) -> f64 {
    let d = [a.mean[0] - b.mean[0], a.mean[1] - b.mean[1], a.mean[2] - b.mean[2]];
    let mean_sq = d[0] * d[0] + d[1] * d[1] + d[2] * d[2];
    let root = psd_power(&a.cov, 0.5);
    let mid = mat3_mul(&mat3_mul(&root, &b.cov), &root);
    let mid_root = psd_power(&mid, 0.5);
    let trace = (a.cov[0][0] + a.cov[1][1] + a.cov[2][2])
        + (b.cov[0][0] + b.cov[1][1] + b.cov[2][2])
        - 2.0 * (mid_root[0][0] + mid_root[1][1] + mid_root[2][2]);
    (mean_sq + trace).max(0.0)
}

/// 协方差 W2 重心（Alvarez-Esteban et al. 2008 不动点）：
/// `C ← C^(-1/2)·(Σ wᵢ·(C^(1/2)·Cᵢ·C^(1/2))^(1/2))²·C^(-1/2)`。
/// 与 language-guided-lut `covariance_barycenter` 同参数
/// （相对步长 tol 1e-9 / 最多 256 轮 / 收敛后残差复核 1e-7）。
fn covariance_barycenter(covs: &[[[f64; 3]; 3]], weights: &[f64]) -> Result<[[f64; 3]; 3], String> {
    let active: Vec<usize> = weights
        .iter()
        .enumerate()
        .filter(|(_, w)| **w > 0.0)
        .map(|(i, _)| i)
        .collect();
    if active.is_empty() {
        return Err("barycenter: no active weights".to_string());
    }
    if active.len() == 1 {
        return Ok(covs[active[0]]);
    }
    // 初值：加权平均（mean-cov）
    let mut current = [[0.0; 3]; 3];
    for &i in &active {
        for r in 0..3 {
            for c in 0..3 {
                current[r][c] += weights[i] * covs[i][r][c];
            }
        }
    }
    let mean_root = |current: &[[f64; 3]; 3]| -> [[f64; 3]; 3] {
        let root = psd_power(current, 0.5);
        let mut acc = [[0.0; 3]; 3];
        for &i in &active {
            let m = mat3_mul(&mat3_mul(&root, &covs[i]), &root);
            let m_root = psd_power(&m, 0.5);
            for r in 0..3 {
                for c in 0..3 {
                    acc[r][c] += weights[i] * m_root[r][c];
                }
            }
        }
        acc
    };
    for _ in 1..=256 {
        let inv = psd_power(&current, -0.5);
        let roots = mean_root(&current);
        let sq = mat3_mul(&roots, &roots);
        let mut following = mat3_mul(&mat3_mul(&inv, &sq), &inv);
        // 对称化，消掉幂运算的数值不对称
        for r in 0..3 {
            for c in (r + 1)..3 {
                let v = (following[r][c] + following[c][r]) / 2.0;
                following[r][c] = v;
                following[c][r] = v;
            }
        }
        let delta = mat3_frobenius(&mat3_sub(&following, &current))
            / mat3_frobenius(&current).max(1e-15);
        current = following;
        if delta < 1e-9 {
            let residual = mat3_frobenius(&mat3_sub(&current, &mean_root(&current)))
                / mat3_frobenius(&current).max(1e-15);
            if residual < 1e-7 {
                return Ok(current);
            }
        }
    }
    Err("Gaussian barycenter did not converge; inspect the image set or use mean-cov".to_string())
}

/// 加权中位数（权重累积过半的第一个顺序样本，stable）。
fn weighted_median(values: &[f64], weights: &[f64]) -> f64 {
    let mut order: Vec<usize> = (0..values.len()).collect();
    order.sort_by(|&a, &b| values[a].partial_cmp(&values[b]).unwrap_or(std::cmp::Ordering::Equal));
    let total: f64 = weights.iter().sum();
    let mut acc = 0.0;
    for &i in &order {
        acc += weights[i];
        if acc >= total * 0.5 {
            return values[i];
        }
    }
    values[*order.last().unwrap()]
}

/// 稳健权重（robust-bures）：W2 medoid + 到 medoid 距离的软截尾。
/// 规则与 language-guided-lut `robust_weights` 一致；少于 3 个活跃样本不重加权。
fn robust_weights(gaussians: &[Gaussian], base: &[f64]) -> Vec<f64> {
    let active: Vec<usize> = base
        .iter()
        .enumerate()
        .filter(|(_, w)| **w > 0.0)
        .map(|(i, _)| i)
        .collect();
    if active.len() < 3 {
        return base.to_vec();
    }
    let n = gaussians.len();
    let mut dist = vec![vec![0.0f64; n]; n];
    for (pos, &i) in active.iter().enumerate() {
        for &j in &active[pos + 1..] {
            let d = gaussian_w2_sq(&gaussians[i], &gaussians[j]).sqrt();
            dist[i][j] = d;
            dist[j][i] = d;
        }
    }
    // 加权 medoid：min Σⱼ d(i,j)·wⱼ
    let mut medoid = active[0];
    let mut best = f64::INFINITY;
    for &i in &active {
        let s: f64 = active.iter().map(|&j| dist[i][j] * base[j]).sum();
        if s < best {
            best = s;
            medoid = i;
        }
    }
    let d: Vec<f64> = active.iter().map(|&i| dist[medoid][i]).collect();
    let w: Vec<f64> = active.iter().map(|&i| base[i]).collect();
    let median = weighted_median(&d, &w);
    let mad = weighted_median(
        &d.iter().map(|v| (v - median).abs()).collect::<Vec<_>>(),
        &w,
    );
    let cutoff = (median + 2.5 * 1.4826 * mad).max(1e-4);
    let mut eff = base.to_vec();
    for (k, &i) in active.iter().enumerate() {
        eff[i] = base[i] * (cutoff / d[k].max(1e-12)).min(1.0);
    }
    let sum: f64 = eff.iter().sum();
    if sum > 0.0 {
        for w in eff.iter_mut() {
            *w /= sum;
        }
    }
    eff
}

/// 聚合多张参考图的 Oklab 高斯统计（全局或单个分区）。
/// 均值恒为加权平均；协方差按模式计算。单活跃样本原样返回。
fn aggregate_gaussians(
    gaussians: &[Gaussian],
    weights: &[f64],
    mode: AggregateMode,
) -> Result<Gaussian, String> {
    let active: Vec<usize> = weights
        .iter()
        .enumerate()
        .filter(|(_, w)| **w > 0.0)
        .map(|(i, _)| i)
        .collect();
    if active.is_empty() {
        return Err("aggregate: no active samples".to_string());
    }
    if active.len() == 1 {
        return Ok(gaussians[active[0]]);
    }
    let wsum: f64 = active.iter().map(|&i| weights[i]).sum();
    let mut mean = [0.0f64; 3];
    let mut count = 0u64;
    for &i in &active {
        for c in 0..3 {
            mean[c] += weights[i] * gaussians[i].mean[c];
        }
        count += gaussians[i].count;
    }
    for c in 0..3 {
        mean[c] /= wsum;
    }
    let cov = match mode {
        AggregateMode::MeanCov => {
            let mut cov = [[0.0; 3]; 3];
            for &i in &active {
                for r in 0..3 {
                    for c in 0..3 {
                        cov[r][c] += weights[i] * gaussians[i].cov[r][c];
                    }
                }
            }
            cov
        }
        AggregateMode::Bures | AggregateMode::RobustBures => {
            let covs: Vec<[[f64; 3]; 3]> = active.iter().map(|&i| gaussians[i].cov).collect();
            let w = if mode == AggregateMode::RobustBures {
                robust_weights(gaussians, weights)
            } else {
                weights.to_vec()
            };
            covariance_barycenter(&covs, &w)?
        }
    };
    Ok(Gaussian { mean, cov, count })
}

/// 聚合多张样片的完整统计量。
///
/// - 像素分布（`enc_pixels`/`luma_hist`）：直接拼接——曲线拟合目标即混合分布；
/// - 一阶矩（`lin_mean`/`zone_*`）：按像素数加权（仅 MKL 不可用的 legacy 降级路径消费）；
/// - Oklab 高斯：每张样片等权（与 language-guided-lut 默认权重一致），按模式聚合；
/// - 黑白判定：多数票（过半样片近中性 → 走黑白路由）。
fn aggregate_image_stats(stats: &[ImageStats], mode: AggregateMode) -> Result<(ImageStats, bool), String> {
    let n = stats.len();
    let weights = vec![1.0 / n as f64; n];
    let px: Vec<f64> = stats.iter().map(|s| s.enc_pixels.len() as f64).collect();
    let px_sum: f64 = px.iter().sum();
    let w_px = |i: usize| {
        if px_sum > 0.0 {
            px[i] / px_sum
        } else {
            1.0 / n as f64
        }
    };

    let total_px: usize = px.iter().sum::<f64>() as usize;
    let mut enc_pixels: Vec<[f32; 3]> = Vec::with_capacity(total_px);
    let mut luma_hist = [0.0f64; 32];
    for s in stats {
        enc_pixels.extend_from_slice(&s.enc_pixels);
        for (b, h) in luma_hist.iter_mut().enumerate() {
            *h += s.luma_hist[b];
        }
    }

    let mut lin_mean = [0.0f64; 3];
    let mut zone_lin_mean = [[0.0f64; 3]; 3];
    let mut zone_frac = [0.0f64; 3];
    for (i, s) in stats.iter().enumerate() {
        let w = w_px(i);
        for c in 0..3 {
            lin_mean[c] += w * s.lin_mean[c];
        }
        for z in 0..3 {
            zone_frac[z] += w * s.zone_frac[z];
            for c in 0..3 {
                zone_lin_mean[z][c] += w * s.zone_lin_mean[z][c];
            }
        }
    }

    let active_global: Vec<usize> = (0..n)
        .filter(|&i| !stats[i].global_gauss.is_empty())
        .collect();
    if active_global.is_empty() {
        return Err("Empty image".to_string());
    }
    let gaussians: Vec<Gaussian> = active_global.iter().map(|&i| stats[i].global_gauss).collect();
    let g_weights: Vec<f64> = active_global.iter().map(|&i| weights[i]).collect();
    let global_gauss = aggregate_gaussians(&gaussians, &g_weights, mode)?;
    let mut zone_gauss = [Gaussian::default(); 3];
    for z in 0..3 {
        let az: Vec<usize> = (0..n)
            .filter(|&i| !stats[i].zone_gauss[z].is_empty())
            .collect();
        if az.is_empty() {
            continue;
        }
        let gz: Vec<Gaussian> = az.iter().map(|&i| stats[i].zone_gauss[z]).collect();
        let wz: Vec<f64> = az.iter().map(|&i| weights[i]).collect();
        zone_gauss[z] = aggregate_gaussians(&gz, &wz, mode)?;
    }

    // 黑白多数票：过半样片近中性才走黑白路由（混合样片集按主基调判定）
    let mono_votes = stats
        .iter()
        .filter(|s| classify_monochrome(&s.enc_pixels))
        .count();
    let monochrome = mono_votes * 2 > n;

    Ok((
        ImageStats {
            // 拼接分布：单图宽高不再有意义，置 0（空间配对只看 s_list）
            width: 0,
            height: 0,
            lin_mean,
            zone_lin_mean,
            zone_frac,
            enc_pixels,
            luma_hist,
            global_gauss,
            zone_gauss,
        },
        monochrome,
    ))
}

/// 参考图近中性（黑白）判定：通道差 spread 统计（借鉴 language-guided-lut monochrome.py）。
/// 平均 spread ≤2 且 spread>4 的像素占比 ≤1%、spread>12 占比 ≤0.01% 视为黑白。
/// 阈值口径与 Python 原版一致（0..255 域），输入为 0..1 归一化像素，故在函数内换算。
fn classify_monochrome(enc_pixels: &[[f32; 3]]) -> bool {
    if enc_pixels.is_empty() {
        return false;
    }
    let mut spread_sum = 0.0f64;
    let mut mild = 0u64;
    let mut strong = 0u64;
    for p in enc_pixels {
        // 0..1 → 0..255 域，与阈值 2/4/12 同口径
        let spread = (p[0].max(p[1]).max(p[2]) - p[0].min(p[1]).min(p[2])) as f64 * 255.0;
        spread_sum += spread;
        if spread > 4.0 {
            mild += 1;
        }
        if spread > 12.0 {
            strong += 1;
        }
    }
    let n = enc_pixels.len() as f64;
    spread_sum / n <= 2.0 && (mild as f64) / n <= 0.01 && (strong as f64) / n <= 0.0001
}

fn analyze_image(img: &DynamicImage) -> ImageStats {
    // 缩略图只降不升：小于 ANALYSIS_DIM 的图保持原尺寸。thumbnail 会把
    // 小图放大到框内上限，导致不同尺寸的输入被归一成同尺寸缩略图，
    // 空间级 ΔE“同宽同高才配对”的契约（尺寸不同 ⇒ null）随之失效。
    let owned_thumb;
    let thumb = if img.width() > ANALYSIS_DIM || img.height() > ANALYSIS_DIM {
        owned_thumb = Some(img.thumbnail(ANALYSIS_DIM, ANALYSIS_DIM));
        owned_thumb.as_ref().unwrap()
    } else {
        img
    };
    // 门控/诊断用原图尺寸（任务契约“样片与目标图同宽同高”）；统计与配对
    // 都在缩略图上进行：原图同尺寸 ⇒ 缩略图必同尺寸，下标直配安全。
    let (width, height) = (img.width(), img.height());
    let (thumb_width, thumb_height) = thumb.dimensions();
    let enc_f32 = thumb.to_rgb32f();
    let pixel_count = (thumb_width * thumb_height) as f64;

    let enc_pixels: Vec<[f32; 3]> = enc_f32.as_chunks::<3>().0.to_vec();

    let lin_pixels: Vec<[f64; 3]> = enc_pixels
        .iter()
        .map(|p| to_linear([p[0] as f64, p[1] as f64, p[2] as f64]))
        .collect();

    let mut lin_sum = [0f64; 3];
    let mut zone_sum = [[0f64; 3]; 3];
    let mut zone_n = [0f64; 3];
    let mut luma_hist = [0f64; 32];
    // Oklab 高斯累加器：全局 + 三分区（与线性域 zone 判定同一 zone_masks）
    let mut gauss_global = GaussianAccumulator::default();
    let mut gauss_zone: [GaussianAccumulator; 3] = [
        GaussianAccumulator::default(),
        GaussianAccumulator::default(),
        GaussianAccumulator::default(),
    ];
    for lin in &lin_pixels {
        for c in 0..3 {
            lin_sum[c] += lin[c];
        }
        let l = luma(*lin);
        let masks = zone_masks(l);
        let lab = to_oklab(*lin);
        gauss_global.push(lab);
        for z in 0..3 {
            if masks[z] > 0.5 {
                zone_n[z] += 1.0;
                for c in 0..3 {
                    zone_sum[z][c] += lin[c];
                }
                gauss_zone[z].push(lab);
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
        width,
        height,
        lin_mean,
        zone_lin_mean,
        zone_frac: [
            zone_n[0] / pixel_count,
            zone_n[1] / pixel_count,
            zone_n[2] / pixel_count,
        ],
        enc_pixels,
        luma_hist,
        global_gauss: gauss_global.finish(),
        zone_gauss: [
            gauss_zone[0].finish(),
            gauss_zone[1].finish(),
            gauss_zone[2].finish(),
        ],
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
            if let Some(&[lx, ly]) = mono.last()
                && (x <= lx + 0.5 || y < ly - 0.5)
            {
                continue;
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

/// MKL 传输强度参数（0..1）：strength 整体、tone 只缩放 Oklab L 轴（明暗）、
/// color 只缩放 a/b 轴（色彩）。借鉴 language-guided-lut 的强度三分解，
/// 使「只调氛围不改明暗」成为一阶能力。
#[derive(Clone, Copy, Debug)]
pub struct TransferStrength {
    pub strength: f64,
    pub tone_strength: f64,
    pub color_strength: f64,
}

impl Default for TransferStrength {
    fn default() -> Self {
        Self {
            strength: 1.0,
            tone_strength: 1.0,
            color_strength: 1.0,
        }
    }
}

impl TransferStrength {
    fn sanitized(&self) -> Self {
        let clamp01 = |v: f64| if v.is_finite() { v.clamp(0.0, 1.0) } else { 1.0 };
        Self {
            strength: clamp01(self.strength),
            tone_strength: clamp01(self.tone_strength),
            color_strength: clamp01(self.color_strength),
        }
    }
}

/// 对目标像素的 Oklab 坐标应用 MKL 仿射映射，按强度分解缩放 L 与 a/b 轴，
/// 返回线性域增量（mapped - original）。
fn mkl_delta(
    a: &[[f64; 3]; 3],
    b: [f64; 3],
    lab: [f64; 3],
    lin: [f64; 3],
    k: &TransferStrength,
) -> [f64; 3] {
    let mapped = mat3_vec(a, lab);
    let mut d = [
        mapped[0] + b[0] - lab[0],
        mapped[1] + b[1] - lab[1],
        mapped[2] + b[2] - lab[2],
    ];
    d[0] *= k.tone_strength * k.strength;
    d[1] *= k.color_strength * k.strength;
    d[2] *= k.color_strength * k.strength;
    let out = from_oklab([lab[0] + d[0], lab[1] + d[1], lab[2] + d[2]]);
    [out[0] - lin[0], out[1] - lin[1], out[2] - lin[2]]
}

/// MKL 正向映射算子（阶段 0.5 逐像素增量与 hybrid LUT 烘焙共用，保证数学同源）：
/// 对线性域像素按 zone_masks 加权合并分区/全局仿射传输（分区缺失回退全局，
/// 再回退任意可用映射；`mkl_delta` 内含强度三分解），返回映射后的线性域 RGB。
/// 无任何可用传输时恒等返回。
fn apply_mkl_forward(
    transports: &[Option<([[f64; 3]; 3], [f64; 3])>; 4],
    fallback: Option<([[f64; 3]; 3], [f64; 3])>,
    k: &TransferStrength,
    lin: [f64; 3],
) -> [f64; 3] {
    let lab = to_oklab(lin);
    let masks = zone_masks(luma(lin));
    let mut out = lin;
    for z in 0..3 {
        let Some((a, b)) = transports[z + 1].or(transports[0]).or(fallback) else {
            continue;
        };
        let dz = mkl_delta(&a, b, lab, lin, k);
        for c in 0..3 {
            out[c] += masks[z] * dz[c];
        }
    }
    out
}

pub fn compute_color_transfer(
    samples: &[DynamicImage],
    target: &DynamicImage,
    strength: TransferStrength,
    aggregate_mode: AggregateMode,
    bake_hybrid_lut: bool,
) -> Result<(Value, Value, Option<String>), String> {
    if samples.is_empty() {
        return Err("No sample image".to_string());
    }
    let t = analyze_image(target);
    if t.enc_pixels.is_empty() {
        return Err("Empty image".to_string());
    }
    let s_list: Vec<ImageStats> = samples.iter().map(analyze_image).collect();
    if s_list.iter().any(|s| s.enc_pixels.is_empty()) {
        return Err("Empty image".to_string());
    }
    let (s, monochrome) = aggregate_image_stats(&s_list, aggregate_mode)?;
    let k = strength.sanitized();

    // 阶段 0：MKL 协方差传输求解（全局 + 三分区）。源 = 客片（被调色），
    // 目标 = 样片（期望风格，多样片时已按聚合模式合并）。任何分区不变量
    // 校验失败只丢弃该分区，全部失败时整体降级为一阶矩（Reinhard 均值差）路径。
    // transports[0] = 全局，transports[1..=3] = shadow/mid/highlight。
    let mut transports: [Option<([[f64; 3]; 3], [f64; 3])>; 4] = [None; 4];
    let mut invariant_err_max = 0.0f64;
    let mut mkl_error: Option<String> = None;
    if !monochrome {
        if !t.global_gauss.is_empty() && !s.global_gauss.is_empty() {
            match mkl_transport(&t.global_gauss, &s.global_gauss) {
                Ok((a, b, err)) => {
                    transports[0] = Some((a, b));
                    invariant_err_max = invariant_err_max.max(err);
                }
                Err(e) => mkl_error = Some(e),
            }
        }
        for z in 0..3 {
            if t.zone_frac[z] < 0.02
                || t.zone_gauss[z].is_empty()
                || s.zone_gauss[z].is_empty()
            {
                continue;
            }
            match mkl_transport(&t.zone_gauss[z], &s.zone_gauss[z]) {
                Ok((a, b, err)) => {
                    transports[z + 1] = Some((a, b));
                    invariant_err_max = invariant_err_max.max(err);
                }
                Err(e) => {
                    log::warn!("MKL zone {z} transport failed, falling back: {e}");
                }
            }
        }
    }
    let use_mkl = transports.iter().any(|t| t.is_some());
    // 分区/全局均缺失时的兜底映射（use_mkl 为 true 时必然存在）
    let transport_fallback: Option<([[f64; 3]; 3], [f64; 3])> =
        transports.iter().find_map(|t| t.as_ref()).copied();
    if !use_mkl && !monochrome {
        log::warn!(
            "color transfer: MKL unavailable ({}), degrading to first-order mean matching",
            mkl_error.unwrap_or_else(|| "empty statistics".to_string())
        );
    }

    // 阶段 0.5：逐像素增量。MKL 可用时按 zone_masks 加权合并各分区映射
    // （分区缺失回退全局映射）；否则用常数均值差 + 分区均值差残余，
    // 与旧版 Reinhard 路径逐位等价。
    let t_lin: Vec<[f64; 3]> = t
        .enc_pixels
        .iter()
        .map(|p| to_linear([p[0] as f64, p[1] as f64, p[2] as f64]))
        .collect();
    let v_legacy = [
        s.lin_mean[0] - t.lin_mean[0],
        s.lin_mean[1] - t.lin_mean[1],
        s.lin_mean[2] - t.lin_mean[2],
    ];
    let zone_residual_legacy: [[f64; 3]; 3] = std::array::from_fn(|z| {
        [
            s.zone_lin_mean[z][0] - t.zone_lin_mean[z][0] - v_legacy[0],
            s.zone_lin_mean[z][1] - t.zone_lin_mean[z][1] - v_legacy[1],
            s.zone_lin_mean[z][2] - t.zone_lin_mean[z][2] - v_legacy[2],
        ]
    });
    let mut global_delta_sum = [0f64; 3];
    let mut zone_delta_sum = [[0f64; 3]; 3];
    let mut zone_delta_n = [0f64; 3];
    for lin in &t_lin {
        let l = luma(*lin);
        let masks = zone_masks(l);
        let d = if monochrome {
            [0.0; 3]
        } else if use_mkl {
            let mut d = apply_mkl_forward(&transports, transport_fallback, &k, *lin);
            for c in 0..3 {
                d[c] -= lin[c];
            }
            d
        } else {
            let mut d = v_legacy;
            for z in 0..3 {
                for c in 0..3 {
                    d[c] += masks[z] * zone_residual_legacy[z][c];
                }
            }
            d
        };
        for c in 0..3 {
            global_delta_sum[c] += d[c];
        }
        for z in 0..3 {
            if masks[z] > 0.5 {
                zone_delta_n[z] += 1.0;
                for c in 0..3 {
                    zone_delta_sum[z][c] += d[c];
                }
            }
        }
    }
    let n_px = t_lin.len().max(1) as f64;
    let v_global = [
        global_delta_sum[0] / n_px,
        global_delta_sum[1] / n_px,
        global_delta_sum[2] / n_px,
    ];

    // 阶段 1：全局 tint（线性域，先于曲线，符合管线顺序；全局强度 sat=1.0/lum=1.0）
    let global = fit_tint(v_global, 1.0, 1.0);
    let gs = global.shift(1.0, 1.0);

    // 阶段 2：分区 tint（在全局之后的残余，逐分区强度反解）
    let mut zones = [TintFit {
        hue: 0.0,
        sat: 0.0,
        lum: 0.0,
    }; 3];
    for z in 0..3 {
        if monochrome || t.zone_frac[z] < 0.02 || zone_delta_n[z] <= 0.0 {
            continue;
        }
        // 分区内像素期望的残余偏移 = 分区平均增量 - 全局 tint 已覆盖部分
        let residual = [
            zone_delta_sum[z][0] / zone_delta_n[z] - gs[0],
            zone_delta_sum[z][1] / zone_delta_n[z] - gs[1],
            zone_delta_sum[z][2] / zone_delta_n[z] - gs[2],
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
    let mut curves = fit_curves_quantile(&pred_enc_ch, &sample_enc_ch);
    // 整体强度作用于曲线：仅缩放与恒等映射的偏离量（tone/color 分解已由
    // tint 目标与 MKL 增量承载）
    if (k.strength - 1.0).abs() > 1e-9 {
        for curve in curves.iter_mut().flatten() {
            for pt in curve.iter_mut() {
                pt[1] = pt[0] + (pt[1] - pt[0]) * k.strength;
            }
        }
    }

    // 最终模拟（tint → 编码 → 曲线），计算度量
    let sample_lin: Vec<[f64; 3]> = s
        .enc_pixels
        .iter()
        .map(|p| to_linear([p[0] as f64, p[1] as f64, p[2] as f64]))
        .collect();
    // 空间对应配对（D-TN-02 度量口径分层）：仅当某张样片与客片原图同宽
    // 同高时，才能按 (x, y) 一一对应配对计算 ΔE；否则该指标置 null（分布级
    // 口径仍可用）。配对在分析缩略图上进行：原图同尺寸 ⇒ 缩略图同尺寸，
    // 行主序像素下标直配。
    let (t_w, t_h) = (t.width, t.height);
    let spatial_samples_lin: Vec<Vec<[f64; 3]>> = s_list
        .iter()
        .filter(|st| st.width == t_w && st.height == t_h && t_w > 0)
        .map(|st| {
            st.enc_pixels
                .iter()
                .map(|p| to_linear([p[0] as f64, p[1] as f64, p[2] as f64]))
                .collect()
        })
        .collect();
    // 宽高比诊断：任一样片与客片原图宽高比不同即为 true
    //（整数叉积比较，避免浮点除法）
    let sample_aspect_mismatch = s_list
        .iter()
        .any(|st| st.width * t_h != t_w * st.height);
    let mut de_before = 0.0;
    let mut de_after = 0.0;
    let mut de_spatial_sum = 0.0f64;
    let mut spatial_pairs = 0u64;
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
        // 抽样计算 ΔE（1/4 像素）控制开销。
        // 样片与客片缩略图尺寸/张数不同（多样片为拼接分布），分布级指标按
        // 确定性跨步配对：i % n 保证不越界且覆盖整条参考分布（口径＝分布级）。
        if i % 4 == 0 {
            let lab_t = linear_to_lab(lin_t);
            let lab_f = linear_to_lab(lin_final);
            let lab_s = linear_to_lab(sample_lin[i % sample_lin.len()]);
            de_before += delta_e76(lab_t, lab_s);
            de_after += delta_e76(lab_f, lab_s);
            // 空间级口径：同尺寸样片按下标直配（同一 (x, y)）
            for sp_lin in &spatial_samples_lin {
                let lab_sp = linear_to_lab(sp_lin[i]);
                de_spatial_sum += delta_e76(lab_f, lab_sp);
                spatial_pairs += 1;
            }
        }
    }
    let sampled = (t_lin.len() / 4).max(1) as f64;
    de_before /= sampled;
    de_after /= sampled;
    let delta_e_spatial =
        (spatial_pairs > 0).then(|| de_spatial_sum / spatial_pairs as f64);

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
        // MKL 诊断（借鉴 language-guided-lut 的可诊断性契约）：
        // mklUsed 是否启用协方差传输；mklInvariantError 为 A·C_s·Aᵀ≈C_t
        // 不变式的最大相对误差；monochromeReference 样片是否走了黑白路由。
        "mklUsed": use_mkl,
        "mklInvariantError": invariant_err_max,
        "monochromeReference": monochrome,
        // 多样片聚合（大师配方）：样片张数与所用聚合模式
        "sampleCount": s_list.len(),
        "aggregateMode": aggregate_mode.as_str(),
        // 度量口径分层（D-TN-02）：deltaEMean* 为分布级口径（跨步取模配对，
        // 不要求像素空间对应）；deltaEDistribution 与 deltaEMeanAfter 同值，
        // 用于前端在语义上显式选择分布级口径。deltaESpatial 仅在样片与客片
        // 同宽同高时按空间对应像素计算，否则为 null。
        "deltaEDistribution": de_after,
        "deltaESpatial": delta_e_spatial,
        "sampleAspectMismatch": sample_aspect_mismatch,
        "pairedPixels": spatial_pairs,
    });
    // hybrid 双载体（D-TN-01）：把本次传输烘焙为 33³ .cube 文本。
    // MKL 可用时烘焙仿射传输本体（与阶段 0.5 共用 apply_mkl_forward，含分区
    // 掩膜与强度分解）；无原始仿射矩阵时（黑白路由 / 全部 MKL 失败）退化为
    // 直接求值 params 管线（tint+曲线，与最终模拟同一纯函数），保证 LUT 与
    // params 输出数学同源。
    let lut_text = bake_hybrid_lut.then(|| {
        if use_mkl {
            bake_cube_lut(|lin| apply_mkl_forward(&transports, transport_fallback, &k, lin))
        } else {
            bake_cube_lut(|lin: [f64; 3]| {
                let masks = zone_masks(luma(lin));
                let mut enc = [0f64; 3];
                for c in 0..3 {
                    let mut x = lin[c] + gs[c];
                    for z in 0..3 {
                        x += zone_shifts[z][c] * masks[z];
                    }
                    enc[c] = apply_curve_map(srgb_encode(x.clamp(0.0, 1.0)), curves[c].as_deref());
                }
                to_linear(enc)
            })
        }
    });
    Ok((Value::Object(patch), metrics, lut_text))
}

/// 将线性域→线性域的传输映射烘焙为 33³ 三通道 .cube 文本（纯函数，便于单测）。
/// 网格点为 sRGB 编码域 0..1（标准 .cube 顺序：r 最快变化，g 次之，b 最慢）；
/// 每个网格点经 sRGB 解码 → `transfer`（线性域）→ sRGB 编码并截断到 0..1。
fn bake_cube_lut(transfer: impl Fn([f64; 3]) -> [f64; 3]) -> String {
    const GRID: usize = 33;
    let max = (GRID - 1) as f64;
    let mut out = String::with_capacity(GRID * GRID * GRID * 24);
    out.push_str("TITLE \"color match hybrid LUT\"\n");
    out.push_str("# MKL color transfer baked to a 33^3 sRGB grid (color_transfer.rs)\n");
    out.push_str("LUT_3D_SIZE 33\n");
    out.push_str("DOMAIN_MIN 0.0 0.0 0.0\n");
    out.push_str("DOMAIN_MAX 1.0 1.0 1.0\n");
    for b in 0..GRID {
        for g in 0..GRID {
            for r in 0..GRID {
                let enc_in = [r as f64 / max, g as f64 / max, b as f64 / max];
                let mapped = to_enc(transfer(to_linear(enc_in)));
                out.push_str(&format!(
                    "{:.6} {:.6} {:.6}\n",
                    mapped[0], mapped[1], mapped[2]
                ));
            }
        }
    }
    out
}

/// 把 hybrid LUT 文本写入缓存目录 `color_match_luts/<纳秒hex>.cube`，返回路径。
fn write_hybrid_lut(app_handle: &tauri::AppHandle, cube_text: &str) -> Result<String, String> {
    use tauri::Manager;
    let dir = app_handle
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?
        .join("color_match_luts");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    let path = dir.join(format!("{nanos:x}.cube"));
    std::fs::write(&path, cube_text).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into_owned())
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

/// 统一的「分析用图加载」入口：iCloud 占位检测 + Android content:// URI
/// （SAF）分支 + 常规磁盘读取，RAW 经 image_loader 兼容解码。
/// 追色（compute_color_match）与风格词调色图像自适应（style_suggest）共用。
pub(crate) fn load_analysis_image(
    path: &str,
    settings: &crate::app_settings::AppSettings,
) -> Result<DynamicImage, String> {
    if crate::file_management::is_cloud_placeholder(Path::new(path)) {
        return Err(format!("'{}' is stored in iCloud and not downloaded", path));
    }
    // Android SAF 文件选择返回 content:// URI，需经 ContentResolver 读字节
    // （与预设/LUT 导入同链路）；否则 std::fs::read 会直接失败。
    #[cfg(target_os = "android")]
    if crate::android_integration::is_android_content_uri(path) {
        let bytes = crate::android_integration::read_android_content_uri(path)?;
        return crate::image_loader::load_base_image_from_bytes(&bytes, path, true, settings, None)
            .map_err(|e| e.to_string());
    }
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    crate::image_loader::load_base_image_from_bytes(&bytes, path, true, settings, None)
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn compute_color_match(
    app_handle: tauri::AppHandle,
    // 单样片（向后兼容）；sample_paths 非空时忽略
    sample_path: Option<String>,
    target_path: String,
    // 整体强度（0..1，默认 1.0）
    strength: Option<f64>,
    // 明暗强度（0..1，默认 1.0）：只缩放 Oklab L 轴增量
    tone_strength: Option<f64>,
    // 色彩强度（0..1，默认 1.0）：只缩放 Oklab a/b 轴增量
    color_strength: Option<f64>,
    // 多样片（大师配方）：非空时优先于 sample_path
    sample_paths: Option<Vec<String>>,
    // 聚合模式：mean-cov / bures / robust-bures（默认 bures）
    aggregate: Option<String>,
    // 输出载体模式（D-TN-01 双载体）："params"（默认，仅返回非破坏性调整
    // 参数，行为与旧版完全一致）或 "hybrid"（同时把本次 MKL 仿射传输烘焙为
    // 33³ .cube LUT 落盘到缓存目录，经 hybridLutPath 返回路径）
    output_mode: Option<String>,
) -> Result<Value, String> {
    let paths = match sample_paths {
        Some(p) if !p.is_empty() => p,
        _ => sample_path.into_iter().collect(),
    };
    if paths.is_empty() {
        return Err("No sample image".to_string());
    }
    let mode = match aggregate.as_deref() {
        None => AggregateMode::default(),
        Some(s) => AggregateMode::parse(s)
            .ok_or_else(|| format!("Unknown aggregate mode: {s} (mean-cov|bures|robust-bures)"))?,
    };
    let hybrid = match output_mode.as_deref() {
        None | Some("params") => false,
        Some("hybrid") => true,
        Some(s) => return Err(format!("Unknown output mode: {s} (params|hybrid)")),
    };
    tokio::task::spawn_blocking(move || -> Result<Value, String> {
        let settings = crate::app_settings::load_settings(app_handle.clone()).unwrap_or_default();
        let target = load_analysis_image(&target_path, &settings)?;
        let samples: Vec<DynamicImage> = paths
            .iter()
            .map(|p| load_analysis_image(p, &settings))
            .collect::<Result<_, _>>()?;
        let strength = TransferStrength {
            strength: strength.unwrap_or(1.0),
            tone_strength: tone_strength.unwrap_or(1.0),
            color_strength: color_strength.unwrap_or(1.0),
        };
        let (adjustments, metrics, lut_text) =
            compute_color_transfer(&samples, &target, strength, mode, hybrid)?;
        // fitResidual：把 MKL 协方差不变式诊断值提到顶层（两种模式都返回）
        let fit_residual = metrics
            .get("mklInvariantError")
            .and_then(Value::as_f64)
            .unwrap_or(0.0);
        let mut response = json!({
            "adjustments": adjustments,
            "metrics": metrics,
            "fitResidual": fit_residual,
        });
        if hybrid {
            // LUT 落盘失败不阻塞 params 主载体（hybridLutPath 置 null 降级）
            let lut_path = match lut_text {
                Some(text) => write_hybrid_lut(&app_handle, &text)
                    .map(Some)
                    .unwrap_or_else(|e| {
                        log::warn!("color match: hybrid LUT write failed: {e}");
                        None
                    }),
                None => None,
            };
            response["hybridLutPath"] = lut_path
                .map(Value::String)
                .unwrap_or(Value::Null);
        }
        Ok(response)
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

    /// 测试便捷入口：多样片传输（克隆小图，避免测试里管理所有权）。
    fn run_transfer(
        samples: &[&DynamicImage],
        target: &DynamicImage,
        strength: TransferStrength,
        mode: AggregateMode,
    ) -> (Value, Value) {
        let owned: Vec<DynamicImage> = samples.iter().map(|i| (*i).clone()).collect();
        let (patch, metrics, _lut) =
            compute_color_transfer(&owned, target, strength, mode, false)
                .expect("transfer should succeed");
        (patch, metrics)
    }

    #[test]
    fn test_identity_returns_empty_patch() {
        let img = gradient_image();
        let (patch, metrics) = run_transfer(
            &[&img],
            &img,
            TransferStrength::default(),
            AggregateMode::Bures,
        );
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
        let (patch, metrics) = run_transfer(
            &[&sample],
            &target,
            TransferStrength::default(),
            AggregateMode::Bures,
        );
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
        let (patch, _) = run_transfer(
            &[&sample],
            &target,
            TransferStrength::default(),
            AggregateMode::Bures,
        );
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

    #[test]
    fn test_oklab_roundtrip() {
        // Oklab 正逆变换应在编码域闭环（线性域）
        for enc in [
            [0.0f64, 0.0, 0.0],
            [1.0, 1.0, 1.0],
            [0.5, 0.5, 0.5],
            [0.9, 0.1, 0.2],
            [0.1, 0.8, 0.6],
            [0.25, 0.35, 0.75],
        ] {
            let lin = to_linear(enc);
            let lab = to_oklab(lin);
            let back = from_oklab(lab);
            for c in 0..3 {
                assert!(
                    (back[c] - lin[c]).abs() < 1e-6,
                    "Oklab 往返误差过大: enc={enc:?} c={c} {back:?} vs {lin:?}"
                );
            }
        }
    }

    #[test]
    fn test_mkl_transport_maps_covariance_and_mean() {
        // 构造两组 Oklab 高斯：源（低反差、偏青）与目标（高反差、偏暖）
        let mut acc_s = GaussianAccumulator::default();
        let mut acc_t = GaussianAccumulator::default();
        // 简单确定性伪随机（LCG），避免引入 rand 依赖
        let mut seed = 42u64;
        let mut next = || {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            ((seed >> 33) as f64 / (u32::MAX as f64)) * 2.0 - 1.0
        };
        for _ in 0..20000 {
            // 源：a/b 平面较窄、整体偏负 a（偏青）
            let s = [0.5 + 0.03 * next(), -0.05 + 0.02 * next(), -0.04 + 0.02 * next()];
            // 目标：a/b 平面更宽、整体偏正 a（偏暖）
            let t = [0.55 + 0.08 * next(), 0.06 + 0.06 * next(), 0.05 + 0.06 * next()];
            acc_s.push(s);
            acc_t.push(t);
        }
        let src = acc_s.finish();
        let dst = acc_t.finish();
        let (a, b, err) = mkl_transport(&src, &dst).expect("MKL 应求解成功");
        assert!(err <= MKL_INVARIANT_TOL, "不变式误差 {err:.2e} 超阈值");
        // 均值应精确映射到目标均值
        let mapped_mean = mat3_vec(&a, src.mean);
        let expected_b = [
            dst.mean[0] - mapped_mean[0],
            dst.mean[1] - mapped_mean[1],
            dst.mean[2] - mapped_mean[2],
        ];
        for c in 0..3 {
            assert!((b[c] - expected_b[c]).abs() < 1e-9, "b 向量不一致");
        }
        // 传输后的协方差应贴近目标协方差（MKL 的核心保证）
        let acsa = mat3_mul(&mat3_mul(&a, &src.cov), &mat3_transpose(&a));
        for i in 0..3 {
            for j in 0..3 {
                let rel = (acsa[i][j] - dst.cov[i][j]).abs() / dst.cov[i][j].abs().max(1e-6);
                assert!(rel < 1e-3, "协方差元素 [{i}][{j}] 相对误差 {rel:.2e}");
            }
        }
    }

    #[test]
    fn test_monochrome_classification() {
        // 纯灰度图应判定为黑白
        let mut gray = RgbImage::new(32, 32);
        for (x, y, p) in gray.enumerate_pixels_mut() {
            let v = ((x + y) * 4).min(255) as u8;
            *p = Rgb([v, v, v]);
        }
        let gray_pixels: Vec<[f32; 3]> = gray
            .pixels()
            .map(|p| [p[0] as f32 / 255.0, p[1] as f32 / 255.0, p[2] as f32 / 255.0])
            .collect();
        assert!(classify_monochrome(&gray_pixels), "灰度图应判定为黑白");
        // 彩色图不应判定为黑白
        let mut color = RgbImage::new(32, 32);
        for (x, y, p) in color.enumerate_pixels_mut() {
            *p = Rgb([(x * 8 % 256) as u8, (y * 4 % 256) as u8, 128]);
        }
        let color_pixels: Vec<[f32; 3]> = color
            .pixels()
            .map(|p| [p[0] as f32 / 255.0, p[1] as f32 / 255.0, p[2] as f32 / 255.0])
            .collect();
        assert!(!classify_monochrome(&color_pixels), "彩色图不应判定为黑白");
    }

    #[test]
    fn test_monochrome_reference_skips_tint() {
        // 黑白样片：应跳过 colorGrading tint，仅走曲线
        let target = gradient_image();
        let mut gray = RgbImage::new(128, 128);
        for (x, y, p) in gray.enumerate_pixels_mut() {
            let v = ((x + y) * 255 / 254) as u8;
            *p = Rgb([v, v, v]);
        }
        let gray = DynamicImage::ImageRgb8(gray);
        let (patch, metrics) = run_transfer(
            &[&gray],
            &target,
            TransferStrength::default(),
            AggregateMode::Bures,
        );
        assert!(
            patch.get("colorGrading").is_none(),
            "黑白参考不应输出 colorGrading，patch={patch}"
        );
        assert!(
            metrics["monochromeReference"].as_bool().unwrap(),
            "应标记黑白路由"
        );
        assert!(!metrics["mklUsed"].as_bool().unwrap(), "黑白路由不走 MKL");
    }

    #[test]
    fn test_strength_zero_is_near_identity() {
        // 强度为 0 时补丁应接近恒等（ΔE 几乎不下降）
        let target = gradient_image();
        let sample = warm_sample(&target);
        let (patch, metrics) = run_transfer(
            &[&sample],
            &target,
            TransferStrength {
                strength: 0.0,
                tone_strength: 1.0,
                color_strength: 1.0,
            },
            AggregateMode::Bures,
        );
        let before = metrics["deltaEMeanBefore"].as_f64().unwrap();
        let after = metrics["deltaEMeanAfter"].as_f64().unwrap();
        assert!(
            after > before * 0.9,
            "strength=0 应接近恒等，before={before}, after={after}, patch={patch}"
        );
    }

    #[test]
    fn test_color_strength_zero_preserves_tone() {
        // color_strength=0 时明暗仍应改善（ΔE 下降），但色度增量被抑制：
        // 与全强度相比，补丁中 tint 饱和度应不更大。
        let target = gradient_image();
        let sample = warm_sample(&target);
        let (full, _) = run_transfer(
            &[&sample],
            &target,
            TransferStrength::default(),
            AggregateMode::Bures,
        );
        let (no_color, _) = run_transfer(
            &[&sample],
            &target,
            TransferStrength {
                strength: 1.0,
                tone_strength: 1.0,
                color_strength: 0.0,
            },
            AggregateMode::Bures,
        );
        let sat_of = |patch: &Value| -> f64 {
            patch
                .get("colorGrading")
                .and_then(|cg| cg.get("global"))
                .and_then(|g| g.get("saturation"))
                .and_then(|s| s.as_f64())
                .unwrap_or(0.0)
        };
        assert!(
            sat_of(&no_color) <= sat_of(&full) + 1e-6,
            "color_strength=0 的全局 tint 饱和度不应更大: {} vs {}",
            sat_of(&no_color),
            sat_of(&full)
        );
    }

    #[test]
    fn test_mkl_invariant_rejects_degenerate() {
        // 非有限协方差必须被拒绝，而不是产出错误传输
        let mut g = Gaussian::default();
        g.count = 10;
        g.mean = [0.5, 0.0, 0.0];
        g.cov = [[f64::NAN, 0.0, 0.0], [0.0, 1e-6, 0.0], [0.0, 0.0, 1e-6]];
        let h = Gaussian {
            mean: [0.5, 0.0, 0.0],
            cov: [[1e-6, 0.0, 0.0], [0.0, 1e-6, 0.0], [0.0, 0.0, 1e-6]],
            count: 10,
        };
        assert!(mkl_transport(&g, &h).is_err(), "非有限协方差应拒绝");
    }

    /* ------------------------------ 多图聚合（P1-2） ------------------------------ */

    fn gauss(mean: [f64; 3], diag: [f64; 3], count: u64) -> Gaussian {
        Gaussian {
            mean,
            cov: [
                [diag[0], 0.0, 0.0],
                [0.0, diag[1], 0.0],
                [0.0, 0.0, diag[2]],
            ],
            count,
        }
    }

    /// 纯灰度图（黑白路由测试用）
    fn gray_image(size: u32) -> DynamicImage {
        let mut gray = RgbImage::new(size, size);
        for (x, y, p) in gray.enumerate_pixels_mut() {
            let v = ((x + y) * 255 / (2 * size as u32 - 2).max(1)) as u8;
            *p = Rgb([v, v, v]);
        }
        DynamicImage::ImageRgb8(gray)
    }

    /// 第二张暖色样片：与 warm_sample 同基调、不同幅度（聚合测试用）
    fn warm_sample_variant(base: &DynamicImage) -> DynamicImage {
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
                (lin[0] * 1.12 + 0.01).clamp(0.0, 1.0),
                (lin[1] * 1.02).clamp(0.0, 1.0),
                (lin[2] * 0.93).clamp(0.0, 1.0),
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
    fn test_aggregate_mode_parse() {
        assert_eq!(AggregateMode::parse("mean-cov"), Some(AggregateMode::MeanCov));
        assert_eq!(AggregateMode::parse("bures"), Some(AggregateMode::Bures));
        assert_eq!(
            AggregateMode::parse("robust-bures"),
            Some(AggregateMode::RobustBures)
        );
        assert_eq!(AggregateMode::parse("pooled"), None);
        assert_eq!(AggregateMode::parse(""), None);
    }

    #[test]
    fn test_bures_barycenter_diagonal_geometric_mean() {
        // 对角协方差的不动点逐特征值独立：λ̄ = (√λ₁+√λ₂)²/4（等权）
        let a = gauss([0.5, 0.0, 0.0], [1.0, 1.0, 1.0], 100);
        let b = gauss([0.5, 0.0, 0.0], [4.0, 4.0, 4.0], 100);
        let cov = covariance_barycenter(&[a.cov, b.cov], &[0.5, 0.5]).expect("应收敛");
        for i in 0..3 {
            assert!(
                (cov[i][i] - 2.25).abs() < 1e-6,
                "特征值重心应≈2.25，实际 {}",
                cov[i][i]
            );
            for j in 0..3 {
                if i != j {
                    assert!(cov[i][j].abs() < 1e-9, "非对角应保持为 0");
                }
            }
        }
    }

    #[test]
    fn test_bures_barycenter_single_and_bounded() {
        // 单样本原样返回
        let a = gauss([0.5, 0.1, 0.0], [0.8, 0.4, 0.2], 100);
        let cov = covariance_barycenter(&[a.cov], &[1.0]).expect("单样本应直接返回");
        for i in 0..3 {
            for j in 0..3 {
                assert!((cov[i][j] - a.cov[i][j]).abs() < 1e-12);
            }
        }
        // 重心逐特征值介于输入之间（不会超出极值）
        let b = gauss([0.5, 0.1, 0.0], [3.0, 0.9, 0.05], 100);
        let cov = covariance_barycenter(&[a.cov, b.cov], &[0.5, 0.5]).expect("应收敛");
        for i in 0..3 {
            let lo = a.cov[i][i].min(b.cov[i][i]);
            let hi = a.cov[i][i].max(b.cov[i][i]);
            assert!(
                (lo - 1e-9..=hi + 1e-9).contains(&cov[i][i]),
                "重心特征值 {} 应介于 {lo} 与 {hi} 之间",
                cov[i][i]
            );
        }
    }

    #[test]
    fn test_robust_weights_clip_outlier() {
        // 两个近邻 + 一个远离的样片：离群权重应被软截尾压到很低
        let inlier_a = gauss([0.5, 0.0, 0.0], [0.01, 0.01, 0.01], 100);
        let inlier_b = gauss([0.51, 0.0, 0.0], [0.01, 0.01, 0.01], 100);
        let outlier = gauss([3.0, 0.0, 0.0], [0.01, 0.01, 0.01], 100);
        let eff = robust_weights(
            &[inlier_a, inlier_b, outlier],
            &[1.0 / 3.0, 1.0 / 3.0, 1.0 / 3.0],
        );
        assert!(
            eff[2] < 0.05,
            "离群样片权重应被压到 <0.05，实际 {:?}",
            eff
        );
        assert!(
            (eff[0] - eff[1]).abs() < 0.02 && eff[0] > 0.4,
            "两个近邻应均分剩余权重，实际 {:?}",
            eff
        );
        // 少于 3 个活跃样本不重加权
        let same = robust_weights(&[inlier_a, outlier], &[0.5, 0.5]);
        assert!((same[0] - 0.5).abs() < 1e-12 && (same[1] - 0.5).abs() < 1e-12);
    }

    #[test]
    fn test_multi_sample_transfer_reduces_delta_e() {
        // 大师配方：两张同基调样片聚合后仍应显著降低 ΔE
        let target = gradient_image();
        let s1 = warm_sample(&target);
        let s2 = warm_sample_variant(&target);
        let (patch, metrics) = run_transfer(
            &[&s1, &s2],
            &target,
            TransferStrength::default(),
            AggregateMode::Bures,
        );
        let before = metrics["deltaEMeanBefore"].as_f64().unwrap();
        let after = metrics["deltaEMeanAfter"].as_f64().unwrap();
        assert!(
            after < before * 0.7,
            "多样片聚合后 ΔE 应下降 ≥30%，before={before}, after={after}, patch={patch}"
        );
        assert_eq!(metrics["sampleCount"].as_u64().unwrap(), 2);
        assert_eq!(metrics["aggregateMode"].as_str().unwrap(), "bures");
    }

    #[test]
    fn test_aggregate_modes_all_produce_patches() {
        for mode in [
            AggregateMode::MeanCov,
            AggregateMode::Bures,
            AggregateMode::RobustBures,
        ] {
            let target = gradient_image();
            let s1 = warm_sample(&target);
            let s2 = warm_sample_variant(&target);
            let (patch, metrics) =
                run_transfer(&[&s1, &s2], &target, TransferStrength::default(), mode);
            assert!(
                patch.get("colorGrading").is_some() || patch.get("curves").is_some(),
                "{mode:?} 应产出补丁，patch={patch}"
            );
            assert!(metrics["mklUsed"].as_bool().unwrap(), "{mode:?} 应走 MKL");
            assert_eq!(metrics["aggregateMode"].as_str().unwrap(), mode.as_str());
        }
    }

    #[test]
    fn test_multi_sample_monochrome_majority() {
        // 过半样片为黑白 → 走黑白路由（跳过 tint）；否则不走
        let target = gradient_image();
        let color = warm_sample(&target);
        let gray = gray_image(128);
        let (patch, metrics) = run_transfer(
            &[&gray, &gray, &color],
            &target,
            TransferStrength::default(),
            AggregateMode::Bures,
        );
        assert!(metrics["monochromeReference"].as_bool().unwrap());
        assert!(patch.get("colorGrading").is_none(), "黑白路由不应输出 tint");
        let (patch2, metrics2) = run_transfer(
            &[&gray, &color, &color],
            &target,
            TransferStrength::default(),
            AggregateMode::Bures,
        );
        assert!(!metrics2["monochromeReference"].as_bool().unwrap());
        assert!(patch2.get("colorGrading").is_some(), "彩色为主应输出 tint");
    }

    #[test]
    fn test_delta_e_pairing_survives_size_mismatch() {
        // 样片与客片缩略图像素数不同时（不同宽高比 / 多样片拼接），
        // ΔE 参考配对必须按跨步取模而不是直接下标（旧路径会越界 panic）。
        let mut small = RgbImage::new(64, 128);
        for (x, _y, p) in small.enumerate_pixels_mut() {
            let v = (x * 255 / 63) as u8;
            *p = Rgb([v, (v as u16 * 9 / 10) as u8, (v as u16 * 4 / 5) as u8]);
        }
        let small = DynamicImage::ImageRgb8(small);
        let target = gradient_image(); // 128×128，与样片 64×128 像素数不同
        let (patch, metrics) = run_transfer(
            &[&small],
            &target,
            TransferStrength::default(),
            AggregateMode::Bures,
        );
        assert!(
            metrics["deltaEMeanAfter"].as_f64().unwrap().is_finite(),
            "尺寸不匹配时度量应仍为有限值，metrics={metrics}"
        );
        assert!(
            patch.get("curves").is_some() || patch.get("colorGrading").is_some(),
            "应仍产出补丁，patch={patch}"
        );
    }

    /* ------------------------------ hybrid 双载体 LUT（D-TN-01） ------------------------------ */

    /// 解析 .cube 文本：返回 (LUT_3D_SIZE, DOMAIN_MIN, DOMAIN_MAX, 数据行)
    fn parse_cube(text: &str) -> (u32, [f64; 3], [f64; 3], Vec<[f64; 3]>) {
        let mut size = 0u32;
        let mut dmin = [f64::NAN; 3];
        let mut dmax = [f64::NAN; 3];
        let mut data = Vec::new();
        for line in text.lines() {
            let line = line.trim();
            if line.is_empty() || line.starts_with('#') || line.starts_with("TITLE") {
                continue;
            }
            if let Some(rest) = line.strip_prefix("LUT_3D_SIZE") {
                size = rest.trim().parse().expect("LUT_3D_SIZE 应为整数");
                continue;
            }
            if let Some(rest) = line.strip_prefix("DOMAIN_MIN") {
                for (i, v) in rest.split_whitespace().enumerate() {
                    dmin[i] = v.parse().unwrap();
                }
                continue;
            }
            if let Some(rest) = line.strip_prefix("DOMAIN_MAX") {
                for (i, v) in rest.split_whitespace().enumerate() {
                    dmax[i] = v.parse().unwrap();
                }
                continue;
            }
            let vals: Vec<f64> = line
                .split_whitespace()
                .map(|v| v.parse().expect("数据行应为浮点数"))
                .collect();
            assert_eq!(vals.len(), 3, "数据行应为三通道: {line}");
            data.push([vals[0], vals[1], vals[2]]);
        }
        (size, dmin, dmax, data)
    }

    #[test]
    fn test_bake_cube_lut_shape_and_domain() {
        // 恒等传输：校验 33³ 网格、头部关键字、角点值域与 r 最快变化的顺序
        let text = bake_cube_lut(|lin| lin);
        let (size, dmin, dmax, data) = parse_cube(&text);
        assert_eq!(size, 33, "LUT_3D_SIZE 应为 33");
        assert_eq!(data.len(), 33usize.pow(3), "数据行应为 33³ 条");
        assert!(dmin.iter().all(|&v| v == 0.0), "DOMAIN_MIN 应为 0 0 0");
        assert!(dmax.iter().all(|&v| v == 1.0), "DOMAIN_MAX 应为 1 1 1");
        assert!(
            data.iter().flatten().all(|&v| (0.0..=1.0).contains(&v)),
            "所有输出值都应在 0..1 内"
        );
        // 角点：第一个点 (0,0,0) → 黑，最后一个点 (1,1,1) → 白
        for c in 0..3 {
            assert!(data[0][c] < 1e-6, "首行应为黑，实际 {:?}", data[0]);
            assert!((data[data.len() - 1][c] - 1.0).abs() < 1e-6, "末行应为白");
        }
        // 标准 .cube 顺序：r 最快变化 → 第 2 行输入为 (1/32, 0, 0)
        let step = 1.0 / 32.0;
        assert!((data[1][0] - step).abs() < 1e-6 && data[1][1] < 1e-6 && data[1][2] < 1e-6);
    }

    #[test]
    fn test_bake_cube_lut_identity_roundtrip() {
        // 恒等传输烘焙结果应≈恒等：所有网格点往返误差 < 1e-3（含中心点）
        let text = bake_cube_lut(|lin| lin);
        let (_, _, _, data) = parse_cube(&text);
        const GRID: usize = 33;
        let max = (GRID - 1) as f64;
        let mut checked = 0usize;
        for idx in (0..data.len()).step_by(97) {
            let b = (idx / (GRID * GRID)) as f64;
            let g = ((idx / GRID) % GRID) as f64;
            let r = (idx % GRID) as f64;
            let enc_in = [r / max, g / max, b / max];
            for c in 0..3 {
                assert!(
                    (data[idx][c] - enc_in[c]).abs() < 1e-3,
                    "恒等烘焙往返误差过大: in={enc_in:?} out={:?}",
                    data[idx]
                );
            }
            checked += 1;
        }
        // 中心点 (16,16,16) = 0.5 灰，显式断言
        let center = 16 * GRID * GRID + 16 * GRID + 16;
        for c in 0..3 {
            assert!(
                (data[center][c] - 0.5).abs() < 1e-3,
                "中心点往返误差应 <1e-3，实际 {}",
                data[center][c]
            );
        }
        assert!(checked > 300, "抽样点过少: {checked}");
    }

    #[test]
    fn test_bake_cube_lut_applies_transfer() {
        // 已知线性域增益（R×1.25）应精确体现在网格点上
        let text = bake_cube_lut(|mut lin| {
            lin[0] *= 1.25;
            lin
        });
        let (_, _, _, data) = parse_cube(&text);
        const GRID: usize = 33;
        let idx = 16 * GRID * GRID + 16 * GRID + 16; // 输入 (0.5, 0.5, 0.5)
        let lin_in = to_linear([0.5, 0.5, 0.5]);
        let expected = to_enc([lin_in[0] * 1.25, lin_in[1], lin_in[2]]);
        for c in 0..3 {
            assert!(
                (data[idx][c] - expected[c]).abs() < 1e-6,
                "网格点 {c} 通道应等于期望值 {:.6}，实际 {}",
                expected[c],
                data[idx][c]
            );
        }
    }

    #[test]
    fn test_hybrid_bake_returns_cube_text() {
        // hybrid 开关：返回值第三项应为合法 .cube 文本，params 主载体不受影响
        let target = gradient_image();
        let sample = warm_sample(&target);
        let owned = vec![sample.clone()];
        let (patch, metrics, lut) = compute_color_transfer(
            &owned,
            &target,
            TransferStrength::default(),
            AggregateMode::Bures,
            true,
        )
        .expect("transfer should succeed");
        let text = lut.expect("hybrid 模式应返回 LUT 文本");
        assert!(text.starts_with("TITLE"));
        assert!(text.contains("LUT_3D_SIZE 33"));
        let (size, _, _, data) = parse_cube(&text);
        assert_eq!(size, 33);
        assert_eq!(data.len(), 33usize.pow(3));
        assert!(
            patch.get("curves").is_some() || patch.get("colorGrading").is_some(),
            "hybrid 模式仍应返回 params 补丁，patch={patch}"
        );
        assert!(metrics["mklUsed"].as_bool().unwrap());
        assert!(metrics["pairedPixels"].as_u64().unwrap() > 0);
        // params 模式（开关关闭）不应烘焙 LUT
        let owned2 = vec![sample.clone()];
        let (_, _, lut3) = compute_color_transfer(
            &owned2,
            &target,
            TransferStrength::default(),
            AggregateMode::Bures,
            false,
        )
        .expect("transfer should succeed");
        assert!(lut3.is_none(), "params 模式不应烘焙 LUT");
        assert!(metrics["pairedPixels"].as_u64().unwrap() > 0);
    }

    /* ------------------------------ 度量口径分层（D-TN-02） ------------------------------ */

    #[test]
    fn test_delta_e_spatial_null_on_aspect_mismatch() {
        // 宽高比不同（64×128 vs 128×128）：deltaESpatial 必须为 null 且不 panic
        let mut small = RgbImage::new(64, 128);
        for (x, _y, p) in small.enumerate_pixels_mut() {
            let v = (x * 255 / 63) as u8;
            *p = Rgb([v, (v as u16 * 9 / 10) as u8, (v as u16 * 4 / 5) as u8]);
        }
        let small = DynamicImage::ImageRgb8(small);
        let target = gradient_image();
        let (_, metrics) =
            run_transfer(&[&small], &target, TransferStrength::default(), AggregateMode::Bures);
        assert!(
            metrics["deltaESpatial"].is_null(),
            "宽高比不同时 deltaESpatial 应为 null，metrics={metrics}"
        );
        assert_eq!(
            metrics["sampleAspectMismatch"].as_bool().unwrap(),
            true,
            "应标记宽高比失配"
        );
        assert_eq!(metrics["pairedPixels"].as_u64().unwrap(), 0);
        // 分布级指标仍为有限值（兼容口径不受影响）
        assert!(metrics["deltaEDistribution"].as_f64().unwrap().is_finite());
        assert!(metrics["deltaEMeanAfter"].as_f64().unwrap().is_finite());
    }

    #[test]
    fn test_delta_e_spatial_finite_when_same_size() {
        // 同尺寸（128×128 vs 128×128）：空间级 ΔE 应为有限值且有实际配对
        let target = gradient_image();
        let sample = warm_sample(&target);
        let (_, metrics) =
            run_transfer(&[&sample], &target, TransferStrength::default(), AggregateMode::Bures);
        let spatial = metrics["deltaESpatial"]
            .as_f64()
            .expect("同尺寸应有空间级 ΔE，metrics={metrics}");
        assert!(spatial.is_finite(), "deltaESpatial 应为有限值");
        assert_eq!(metrics["sampleAspectMismatch"].as_bool().unwrap(), false);
        assert!(
            metrics["pairedPixels"].as_u64().unwrap() > 0,
            "应存在实际配对像素，metrics={metrics}"
        );
        // deltaEDistribution 与 deltaEMeanAfter 同值（分布级口径别名）
        assert_eq!(
            metrics["deltaEDistribution"].as_f64().unwrap(),
            metrics["deltaEMeanAfter"].as_f64().unwrap()
        );
    }

    #[test]
    fn test_delta_e_spatial_null_same_aspect_different_size() {
        // 同宽高比（1:1）但尺寸不同（64×64 vs 128×128）：不算宽高比失配，
        // 但缩略图不同宽高 ⇒ 空间配对不可用、配对数为 0
        let mut square = RgbImage::new(64, 64);
        for (x, y, p) in square.enumerate_pixels_mut() {
            let v = ((x + y) * 255 / 126) as u8;
            *p = Rgb([v, v, 255 - v]);
        }
        let square = DynamicImage::ImageRgb8(square);
        let target = gradient_image();
        let (_, metrics) =
            run_transfer(&[&square], &target, TransferStrength::default(), AggregateMode::Bures);
        assert!(
            metrics["deltaESpatial"].is_null(),
            "尺寸不同时 deltaESpatial 应为 null，metrics={metrics}"
        );
        assert_eq!(
            metrics["sampleAspectMismatch"].as_bool().unwrap(),
            false,
            "同宽高比不应标记失配"
        );
        assert_eq!(metrics["pairedPixels"].as_u64().unwrap(), 0);
    }
}
