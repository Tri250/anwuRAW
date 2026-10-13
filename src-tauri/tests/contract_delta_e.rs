//! ΔE2000 度量模块契约测试入口（Task 1, TR-1.1 / TR-1.2）。
//!
//! 核心断言在 `tests/golden/delta_e.rs` 与 `tests/golden/stats.rs` 的内联
//! 单测中；本文件作为 cargo test 的可发现入口并复跑关键校验。

mod golden;

use golden::delta_e::{delta_e_2000, srgb8_to_lab};
use golden::stats::compare_rgb8;

/// TR-1.1: Sharma 2005 官方 34 组向量全部通过（容差 1e-4）
#[test]
fn tr_1_1_sharma_vectors_pass() {
    // 实现在 golden::delta_e 内联测试覆盖，此处复验 4 组关键向量
    let cases: [([f64; 3], [f64; 3], f64); 4] = [
        (
            [50.0000, 2.6772, -79.7751],
            [50.0000, 0.0000, -82.7485],
            2.0425,
        ),
        (
            [50.0000, 2.4900, -0.0010],
            [50.0000, -2.4900, 0.0011],
            7.2195,
        ),
        (
            [50.0000, 2.5000, 0.0000],
            [56.0000, -27.0000, -3.0000],
            31.9030,
        ),
        (
            [2.0776, 0.0795, -1.1350],
            [0.9033, -0.0636, -0.5514],
            0.9082,
        ),
    ];
    for (lab1, lab2, expected) in cases {
        assert!((delta_e_2000(&lab1, &lab2) - expected).abs() < 1e-4);
    }
}

/// TR-1.2: 相同图像零偏差；已知偏差落在预期区间且不误报超阈
#[test]
fn tr_1_2_identical_and_known_deviation() {
    let img: Vec<u8> = (0..32 * 32 * 3)
        .map(|i| ((i * 97 + 13) % 256) as u8)
        .collect();
    let stats = compare_rgb8(&img, &img, 32, 32);
    assert_eq!(stats.mean, 0.0);
    assert_eq!(stats.max, 0.0);

    // 深蓝 → 红的单像素大偏差（ΔE 远超 2.0）必须被捕获
    let mut other = img.clone();
    other[0] = 255;
    other[1] = 0;
    other[2] = 0;
    let stats = compare_rgb8(&img, &other, 32, 32);
    // 单像素大偏差摊到 1024 像素上 mean 很小，但 max 与超阈计数必须捕捉到
    assert!(
        stats.mean > 0.02,
        "expected visible deviation, mean {}",
        stats.mean
    );
    assert!(stats.max > 2.0, "expected > 2.0 max, got {}", stats.max);
    assert!(stats.pixels_over_threshold >= 1);
    assert_eq!(stats.max_position, (0, 0), "max deviation at first pixel");
}

/// sRGB → Lab 链路 sanity（CIELAB 轴向：b* 正=黄/负=蓝，a* 正=品红/负=绿）
#[test]
fn srgb_lab_direction_sanity() {
    let blue = srgb8_to_lab([0, 0, 255]);
    assert!(
        blue[2] < -50.0,
        "blue b* should be strongly negative: {}",
        blue[2]
    );
    assert!(blue[1] > 20.0, "blue a* should lean magenta: {}", blue[1]);

    let green = srgb8_to_lab([0, 255, 0]);
    assert!(
        green[1] < -50.0,
        "green a* should be strongly negative: {}",
        green[1]
    );

    let yellow = srgb8_to_lab([255, 255, 0]);
    assert!(
        yellow[2] > 50.0,
        "yellow b* should be strongly positive: {}",
        yellow[2]
    );
}
