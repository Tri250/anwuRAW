//! 图像对比统计：逐像素 ΔE2000 → 汇总指标（mean/max/p99/超阈计数）+ top-N 偏差列表。

use super::delta_e::{delta_e_2000, srgb8_to_lab};

/// 单像素偏差详情（harness 失败报告用）
#[derive(Debug, Clone)]
pub struct PixelDelta {
    pub de: f64,
    pub x: u32,
    pub y: u32,
    pub a: [u8; 3],
    pub b: [u8; 3],
}

/// 全图对比汇总指标
#[derive(Debug, Clone)]
pub struct DeltaStats {
    pub mean: f64,
    pub max: f64,
    pub p99: f64,
    /// ΔE 超过 `WORST_THRESHOLD` 的像素数
    pub pixels_over_threshold: usize,
    /// 最大偏差像素位置 (x, y)
    pub max_position: (u32, u32),
}

/// 快照回归失败阈值（AC-2）：mean < 0.5 且 max < 2.0
pub const MAX_MEAN: f64 = 0.5;
pub const MAX_SINGLE: f64 = 2.0;

/// CPU/GPU 一致性阈值（AC-4）：ΔE2000 mean < 1.0
/// （仅 contract_consistency 消费；其余测试 target 编译时该常量视为 dead_code）
#[allow(dead_code)]
pub const CONSISTENCY_MAX_MEAN: f64 = 1.0;

/// RGB8 全图逐像素对比（两图长度必须一致且 = w*h*3）
pub fn compare_rgb8(a: &[u8], b: &[u8], width: u32, height: u32) -> DeltaStats {
    let n = width as usize * height as usize;
    assert_eq!(a.len(), b.len(), "image buffer length mismatch");
    assert_eq!(
        a.len(),
        n * 3,
        "image buffer size does not match dimensions"
    );

    let mut sum = 0.0;
    let mut max = 0.0f64;
    let mut max_pos = (0u32, 0u32);
    let mut over = 0usize;
    let mut all = Vec::with_capacity(n);

    for y in 0..height {
        for x in 0..width {
            let i = (y * width + x) as usize * 3;
            let pa = [a[i], a[i + 1], a[i + 2]];
            let pb = [b[i], b[i + 1], b[i + 2]];
            let de = delta_e_2000(&srgb8_to_lab(pa), &srgb8_to_lab(pb));
            sum += de;
            all.push(de);
            if de > max {
                max = de;
                max_pos = (x, y);
            }
            if de > MAX_SINGLE {
                over += 1;
            }
        }
    }

    all.sort_by(|x, y| x.partial_cmp(y).expect("ΔE is finite"));
    let p99 = all[((n as f64 * 0.99).floor() as usize).min(n - 1)];

    DeltaStats {
        mean: sum / n as f64,
        max,
        p99,
        pixels_over_threshold: over,
        max_position: max_pos,
    }
}

/// 全图 top-N 偏差像素（失败报告 top-10 用）
pub fn top_deltas(a: &[u8], b: &[u8], width: u32, height: u32, n: usize) -> Vec<PixelDelta> {
    let n_px = width as usize * height as usize;
    assert_eq!(a.len(), b.len());
    assert_eq!(a.len(), n_px * 3);

    let mut deltas: Vec<PixelDelta> = Vec::with_capacity(n_px);
    for y in 0..height {
        for x in 0..width {
            let i = (y * width + x) as usize * 3;
            let pa = [a[i], a[i + 1], a[i + 2]];
            let pb = [b[i], b[i + 1], b[i + 2]];
            let de = delta_e_2000(&srgb8_to_lab(pa), &srgb8_to_lab(pb));
            deltas.push(PixelDelta {
                de,
                x,
                y,
                a: pa,
                b: pb,
            });
        }
    }
    deltas.sort_by(|p, q| q.de.partial_cmp(&p.de).expect("ΔE is finite"));
    deltas.truncate(n);
    deltas
}

#[cfg(test)]
mod tests {
    use super::*;

    /// TR-1.2a: 相同图像 mean = max = 0
    #[test]
    fn identical_images_zero() {
        let img: Vec<u8> = (0..16 * 16 * 3)
            .map(|i| ((i * 37 + 11) % 256) as u8)
            .collect();
        let stats = compare_rgb8(&img, &img, 16, 16);
        assert_eq!(stats.mean, 0.0);
        assert_eq!(stats.max, 0.0);
        assert_eq!(stats.pixels_over_threshold, 0);
    }

    /// TR-1.2b: 已知偏差图像 mean 落在预期区间（全图 R 通道 +1/255，中间灰区 ΔE ≈ 0.4-0.9）
    #[test]
    fn known_deviation_band() {
        let a: Vec<u8> = vec![128; 8 * 8 * 3];
        let mut b = a.clone();
        for px in b.as_chunks_mut::<3>().0 {
            px[0] = px[0].saturating_add(1);
        }
        let stats = compare_rgb8(&a, &b, 8, 8);
        assert!(
            stats.mean > 0.2 && stats.mean < 1.2,
            "mean {} not in expected band",
            stats.mean
        );
        // 全图均匀 +1 → 无像素超 2.0 阈值
        assert_eq!(stats.pixels_over_threshold, 0);
    }

    /// top_deltas 返回按偏差降序、数量正确
    #[test]
    fn top_deltas_sorted() {
        let a: Vec<u8> = vec![100; 4 * 4 * 3];
        let mut b = a.clone();
        // 像素 (1,1)（= 索引 5）改成强蓝 → 最大偏差
        b[5 * 3] = 30;
        b[5 * 3 + 2] = 220;
        let top = top_deltas(&a, &b, 4, 4, 10);
        assert_eq!(top.len(), 10);
        assert!(top[0].de >= top[1].de);
        assert_eq!((top[0].x, top[0].y), (1, 1));
    }
}
