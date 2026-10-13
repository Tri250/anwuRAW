//! 基准图资产生成器（Task 2）—— 16 张程序化合成图，16bit RGB。
//!
//! 设计原则：
//! - **纯函数确定性**：同函数两次调用输出 byte 级一致（TR-2.1 幂等），噪声用内嵌
//!   xorshift64，零依赖、零版权风险（全程序化生成，无外部素材）；
//! - **harness 内存直用**：处理管线直接消费 `Rgb16`（无 IO），落盘 PNG 仅用于
//!   人工查看与 TR-2.2 解码验证；
//! - **覆盖面**：每张图针对一类调整算子的敏感性设计（清单见 `all_images` 注释）。

pub const W: u32 = 256;
pub const H: u32 = 160;
const PX: usize = (W * H) as usize;

pub type Rgb16 = Vec<u16>; // len = W*H*3, 值域 0..=65535

pub struct GoldenImage {
    pub id: &'static str,
    /// 人工查看基准图清单时的说明文字（测试代码不消费）
    #[allow(dead_code)]
    pub desc: &'static str,
    pub data: Rgb16,
}

/// xorshift64 —— 确定性伪随机（跨平台字节一致，无外部种子）
struct Rng(u64);

impl Rng {
    fn new(seed: u64) -> Self {
        Rng(seed | 1)
    }
    fn next_u16(&mut self) -> u16 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.0 = x;
        (x >> 48) as u16
    }
    fn next_f64(&mut self) -> f64 {
        self.next_u16() as f64 / 65535.0
    }
}

fn put(data: &mut Rgb16, x: u32, y: u32, r: f64, g: f64, b: f64) {
    let i = (y * W + x) as usize * 3;
    data[i] = r.clamp(0.0, 65535.0).round() as u16;
    data[i + 1] = g.clamp(0.0, 65535.0).round() as u16;
    data[i + 2] = b.clamp(0.0, 65535.0).round() as u16;
}

// ---------- 16 张基准图（对照任务书清单） ----------

/// 1-3. 线性渐变（水平/垂直/对角）—— 曝光/对比度/曲线的基准敏感图
fn gradient(dir: u8) -> Rgb16 {
    let mut d = vec![0u16; PX * 3];
    for y in 0..H {
        for x in 0..W {
            let t = match dir {
                0 => x as f64 / (W - 1) as f64,
                1 => y as f64 / (H - 1) as f64,
                _ => (x + y) as f64 / (W + H - 2) as f64,
            };
            let v = t * 65535.0;
            put(&mut d, x, y, v, v, v);
        }
    }
    d
}

/// 4. 24 色卡（ColorChecker 标准 sRGB 值，BabelColor 公开数据）—— 色温/HSL/饱和度的色相覆盖
const CHECKER: [[u8; 3]; 24] = [
    [115, 82, 68],
    [194, 150, 130],
    [98, 122, 157],
    [87, 108, 67],
    [133, 128, 177],
    [103, 189, 170],
    [214, 126, 44],
    [80, 91, 166],
    [193, 90, 99],
    [94, 60, 108],
    [157, 188, 64],
    [224, 163, 46],
    [56, 61, 150],
    [70, 148, 73],
    [175, 54, 60],
    [231, 199, 31],
    [187, 86, 149],
    [8, 133, 161],
    [243, 243, 242],
    [200, 200, 200],
    [160, 160, 160],
    [122, 122, 121],
    [85, 85, 85],
    [52, 52, 52],
];

fn color_checker() -> Rgb16 {
    let mut d = vec![0u16; PX * 3];
    // 6 列 × 4 行网格，含 1px 黑色分隔
    let cols = 6u32;
    let rows = 4u32;
    let cw = W / cols;
    let ch = H / rows;
    for y in 0..H {
        for x in 0..W {
            let cx = x / cw;
            let cy = y / ch;
            let idx = (cy * cols + cx) as usize % 24;
            let sep = x % cw == 0 || y % ch == 0;
            let c = if sep { [0, 0, 0] } else { CHECKER[idx] };
            put(
                &mut d,
                x,
                y,
                c[0] as f64 * 257.0,
                c[1] as f64 * 257.0,
                c[2] as f64 * 257.0,
            );
        }
    }
    d
}

/// 5. HDR 高反差 —— 阴影/高光/曲线端点行为
fn hdr_contrast() -> Rgb16 {
    let mut d = vec![0u16; PX * 3];
    for y in 0..H {
        for x in 0..W {
            let v = if x < W / 2 - 4 {
                1200.0 + y as f64 * 6.0
            } else if x > W / 2 + 4 {
                58000.0 + y as f64 * 20.0
            } else {
                32768.0
            };
            put(&mut d, x, y, v, v, v);
        }
    }
    d
}

/// 6. 单色噪声场 —— 降噪/锐化评估（亮度噪声）
fn mono_noise() -> Rgb16 {
    let mut rng = Rng::new(0xA1_07);
    let mut d = vec![0u16; PX * 3];
    let signal = 32768.0;
    for y in 0..H {
        for x in 0..W {
            let n = (rng.next_f64() - 0.5) * 24000.0;
            let v = signal + n;
            put(&mut d, x, y, v, v, v);
        }
    }
    d
}

/// 7. 肤色模拟渐变 —— 局部调整/色相敏感区
fn skin_tone() -> Rgb16 {
    let mut rng = Rng::new(0x51_11);
    let mut d = vec![0u16; PX * 3];
    for y in 0..H {
        for x in 0..W {
            let t = (x + y) as f64 / (W + H - 2) as f64;
            let n = (rng.next_f64() - 0.5) * 900.0;
            let r = (240.0 - t * 45.0) * 257.0 + n;
            let g = (182.0 - t * 45.0) * 257.0 + n;
            let b = (160.0 - t * 45.0) * 257.0 + n;
            put(&mut d, x, y, r, g, b);
        }
    }
    d
}

/// 8. 饱和色块锐边 —— HSL/震铃效应/色度采样敏感
fn saturated_edges() -> Rgb16 {
    let mut d = vec![0u16; PX * 3];
    let quads: [[f64; 3]; 4] = [
        [65535.0, 0.0, 0.0],     // 红
        [0.0, 65535.0, 0.0],     // 绿
        [0.0, 0.0, 65535.0],     // 蓝
        [65535.0, 65535.0, 0.0], // 黄
    ];
    for y in 0..H {
        for x in 0..W {
            let qx = x / (W / 2);
            let qy = y / (H / 2);
            let c = quads[(qy * 2 + qx) as usize];
            put(&mut d, x, y, c[0], c[1], c[2]);
        }
    }
    d
}

/// 9. 极暗场 —— 阴影提亮/黑场吸管的噪声与条带表现
fn dark_field() -> Rgb16 {
    let mut rng = Rng::new(0xDA_11);
    let mut d = vec![0u16; PX * 3];
    for y in 0..H {
        for x in 0..W {
            let v = rng.next_f64() * 1800.0;
            put(&mut d, x, y, v, v, v);
        }
    }
    d
}

/// 10. 极亮场 —— 高光滚降/白场溢出
fn bright_field() -> Rgb16 {
    let mut rng = Rng::new(0xB2_11);
    let mut d = vec![0u16; PX * 3];
    for y in 0..H {
        for x in 0..W {
            let v = 63500.0 + rng.next_f64() * 2035.0;
            put(&mut d, x, y, v, v, v);
        }
    }
    d
}

/// 11. 中间调模拟 —— 常规影调的回归锚点
fn midtone() -> Rgb16 {
    let mut rng = Rng::new(0x1D_11);
    let mut d = vec![0u16; PX * 3];
    for y in 0..H {
        for x in 0..W {
            let t = x as f64 / (W - 1) as f64;
            let n = (rng.next_f64() - 0.5) * 500.0;
            let v = 31000.0 + t * 2000.0 + n;
            put(&mut d, x, y, v, v, v);
        }
    }
    d
}

/// 12. 高频细节（1px 棋盘）—— 清晰度/结构/锐化的混叠敏感
fn high_freq() -> Rgb16 {
    let mut d = vec![0u16; PX * 3];
    for y in 0..H {
        for x in 0..W {
            let v = if (x + y) % 2 == 0 { 65535.0 } else { 0.0 };
            put(&mut d, x, y, v, v, v);
        }
    }
    d
}

/// 13. 低频大尺度渐变 —— 局部对比/清晰度的纹理区敏感
fn low_freq() -> Rgb16 {
    let mut d = vec![0u16; PX * 3];
    for y in 0..H {
        for x in 0..W {
            let t = x as f64 / (W - 1) as f64;
            let v = 32768.0 + 28000.0 * (t * std::f64::consts::PI).sin();
            put(&mut d, x, y, v, v, v);
        }
    }
    d
}

/// 14. 信号 + 近高斯混合噪声 —— 降噪强度/纹理保留
fn mixed_noise() -> Rgb16 {
    let mut rng = Rng::new(0x3E_14);
    let mut d = vec![0u16; PX * 3];
    for y in 0..H {
        for x in 0..W {
            let t = y as f64 / (H - 1) as f64;
            // 4 次均匀均值近似高斯
            let g = (0.0 + rng.next_f64() + rng.next_f64() + rng.next_f64() + rng.next_f64() - 2.0)
                * 7000.0;
            let v = 16000.0 + t * 32000.0 + g;
            let slight = rng.next_f64() * 400.0;
            put(&mut d, x, y, v + slight, v, v - slight);
        }
    }
    d
}

/// 15. 16bit 精细灰阶斜坡（每列 +1）—— 曲线/色阶的量化步进敏感
fn gray_ramp16() -> Rgb16 {
    let mut d = vec![0u16; PX * 3];
    for y in 0..H {
        for x in 0..W {
            let v = (x as u64 * 65535 / (W - 1) as u64) as f64;
            put(&mut d, x, y, v, v, v);
        }
    }
    d
}

/// 16. 通道分离渐变 —— 白平衡/色温偏移的通道独立敏感
fn channel_split() -> Rgb16 {
    let mut d = vec![0u16; PX * 3];
    for y in 0..H {
        for x in 0..W {
            let t = x as f64 / (W - 1) as f64;
            let r = t * 65535.0;
            let g = (1.0 - t) * 65535.0;
            let b = 32768.0;
            put(&mut d, x, y, r, g, b);
        }
    }
    d
}

/// 全部 16 张基准图（顺序即任务书清单顺序）
pub fn all_images() -> Vec<GoldenImage> {
    vec![
        GoldenImage {
            id: "gradient_h",
            desc: "水平线性渐变（曝光/对比）",
            data: gradient(0),
        },
        GoldenImage {
            id: "gradient_v",
            desc: "垂直线性渐变（曲线行敏感）",
            data: gradient(1),
        },
        GoldenImage {
            id: "gradient_diag",
            desc: "对角渐变（双向敏感性）",
            data: gradient(2),
        },
        GoldenImage {
            id: "color_checker",
            desc: "24 色卡（色相全覆盖）",
            data: color_checker(),
        },
        GoldenImage {
            id: "hdr_contrast",
            desc: "HDR 高反差（阴影/高光端点）",
            data: hdr_contrast(),
        },
        GoldenImage {
            id: "mono_noise",
            desc: "单色噪声场（降噪/锐化）",
            data: mono_noise(),
        },
        GoldenImage {
            id: "skin_tone",
            desc: "肤色模拟渐变（局部/色相）",
            data: skin_tone(),
        },
        GoldenImage {
            id: "saturated_edges",
            desc: "饱和色块锐边（HSL/混叠）",
            data: saturated_edges(),
        },
        GoldenImage {
            id: "dark_field",
            desc: "极暗场（阴影/黑场）",
            data: dark_field(),
        },
        GoldenImage {
            id: "bright_field",
            desc: "极亮场（高光/白场）",
            data: bright_field(),
        },
        GoldenImage {
            id: "midtone",
            desc: "中间调（常规回归锚点）",
            data: midtone(),
        },
        GoldenImage {
            id: "high_freq",
            desc: "高频棋盘（清晰度/结构）",
            data: high_freq(),
        },
        GoldenImage {
            id: "low_freq",
            desc: "低频正弦（局部对比）",
            data: low_freq(),
        },
        GoldenImage {
            id: "mixed_noise",
            desc: "信号+近高斯噪声（降噪强度）",
            data: mixed_noise(),
        },
        GoldenImage {
            id: "gray_ramp16",
            desc: "16bit 灰阶斜坡（量化步进）",
            data: gray_ramp16(),
        },
        GoldenImage {
            id: "channel_split",
            desc: "通道分离渐变（白平衡）",
            data: channel_split(),
        },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    /// TR-2.1: 同一生成器两次全量调用输出 byte 级一致（幂等）
    #[test]
    fn generator_is_deterministic() {
        let a = all_images();
        let b = all_images();
        assert_eq!(a.len(), b.len());
        for (x, y) in a.iter().zip(b.iter()) {
            assert_eq!(x.id, y.id);
            assert_eq!(x.data, y.data, "image {} not deterministic", x.id);
        }
    }

    /// 结构完整性：16 张、尺寸正确（16bit 值域由 u16 类型保证）
    #[test]
    fn structure_valid() {
        let imgs = all_images();
        assert_eq!(imgs.len(), 16);
        for img in &imgs {
            assert_eq!(img.data.len(), PX * 3, "{}", img.id);
        }
    }
}
