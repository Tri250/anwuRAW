//! 快照基线 IO 与对比验证（Task 4）。
//!
//! 基线存储：`tests/snapshot_baseline/<case_id>.png`（RGB8 PNG，无损确定性编码）。
//! 输出 RGBA8 → RGB8（丢 alpha，读回 alpha 恒定不携带信息）后与基线做 ΔE2000。

// 本模块被多个测试二进制共享，多数 target 只用其中一部分 API
#![allow(dead_code)]

use std::path::PathBuf;

use super::stats::{DeltaStats, MAX_MEAN, MAX_SINGLE, compare_rgb8, top_deltas};

pub fn baseline_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests")
        .join("snapshot_baseline")
}

pub fn baseline_path(id: &str) -> PathBuf {
    baseline_dir().join(format!("{id}.png"))
}

pub fn rgba8_to_rgb8(rgba: &[u8]) -> Vec<u8> {
    rgba.as_chunks::<4>()
        .0
        .iter()
        .flat_map(|px| &px[..3])
        .copied()
        .collect()
}

/// 保存基线（RGB8 PNG），返回文件字节数
pub fn save_baseline(case_id: &str, rgba: &[u8], w: u32, h: u32) -> Result<u64, String> {
    let rgb = rgba8_to_rgb8(rgba);
    let img = image::RgbImage::from_raw(w, h, rgb).ok_or("dimensions mismatch")?;
    let path = baseline_path(case_id);
    img.save_with_format(&path, image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    std::fs::metadata(&path)
        .map_err(|e| e.to_string())
        .map(|m| m.len())
}

/// 读取基线为 RGB8（尺寸漂移直接 panic —— 基准图尺寸变更必须重建基线）
pub fn load_baseline(case_id: &str, w: u32, h: u32) -> Option<Vec<u8>> {
    let img = image::open(baseline_path(case_id)).ok()?;
    let rgb = img.to_rgb8();
    assert_eq!(
        (rgb.width(), rgb.height()),
        (w, h),
        "baseline {case_id} dimensions {}x{} != expected {w}x{h} — regenerate baselines",
        rgb.width(),
        rgb.height()
    );
    Some(rgb.into_raw())
}

/// 列出基线目录中现存 case id（去 .png 后缀）
pub fn existing_baseline_ids() -> Vec<String> {
    let dir = baseline_dir();
    let mut ids: Vec<String> = std::fs::read_dir(&dir)
        .map(|rd| {
            rd.filter_map(|e| e.ok())
                .filter_map(|e| {
                    let name = e.file_name().into_string().ok()?;
                    name.strip_suffix(".png").map(|s| s.to_string())
                })
                .collect()
        })
        .unwrap_or_default();
    ids.sort();
    ids
}

/// 单案例验证：阈值 mean < 0.5 且 max < 2.0；失败返回含 top-10 偏差明细的报告
pub fn verify_case(
    case_id: &str,
    rgba: &[u8],
    baseline_rgb: &[u8],
    w: u32,
    h: u32,
) -> Result<DeltaStats, String> {
    let rendered_rgb = rgba8_to_rgb8(rgba);
    let stats = compare_rgb8(baseline_rgb, &rendered_rgb, w, h);
    if stats.mean < MAX_MEAN && stats.max < MAX_SINGLE {
        Ok(stats)
    } else {
        let top = top_deltas(baseline_rgb, &rendered_rgb, w, h, 10);
        let report = top
            .iter()
            .map(|p| {
                format!(
                    "  ({:>3},{:>3}) ΔE={:6.3}  baseline={:?}  rendered={:?}",
                    p.x, p.y, p.de, p.a, p.b
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        Err(format!(
            "case {case_id} 超阈: mean={:.4} (阈值<{MAX_MEAN})  max={:.4} @ {:?} (阈值<{MAX_SINGLE})  p99={:.4}  超阈像素={}\nTop-10 偏差:\n{report}",
            stats.mean, stats.max, stats.max_position, stats.p99, stats.pixels_over_threshold
        ))
    }
}
