//! 快照回归契约测试（spec: v2-engine-contract-tests, Task 4）。
//!
//! 整个文件在 `golden-tests` feature 下才编译：
//! ```sh
//! # 回归验证（CI 门禁模式）
//! cargo test --features golden-tests --test contract_snapshot
//! # 显式重建基线（首跑 / 有意变更后）
//! cargo test --features golden-baseline-update --test contract_snapshot
//! ```
//!
//! 案例矩阵（366 例）：
//! - identity × 16 张基准图（全默认输出）
//! - 40 标量 × 4 非默认档（L0/L1/L3/L4）× 2 代表图（gradient_v 色调轴 / color_checker 色相轴）
//! - 全矩阵复合 ±s × 2 代表图
//! - toneMapper 枚举 5 档 × 2 代表图
//! - curves 3 形态 / hsl 2 例 / colorGrading 全区间 / showClipping
//! - 真实合成 LUT × 2 档强度
//!
//! TR-4.3 为 harness 自检：注入亚可视 LSB 级偏差必须被捕获且报告位置精确（纯 CPU，无 GPU）。
//! 阈值标定依据：均匀 ±1 LSB 漂移的 mean ΔE2000 ≈ 0.16-0.45，落在 mean<0.5 门限的
//! 设计容差内（容忍编码器/舍入噪声）——故捕获路径演示用 2 LSB 注入，+1 LSB 仅断言
//! 灵敏度下限（可测且 >0.2）；单像素强扰动演示定位精度（max/top-1 位置精确命中）。

#![cfg(feature = "golden-tests")]

use std::collections::HashMap;
use std::time::Instant;

use image::{DynamicImage, ImageBuffer, Rgb};
use rapidraw_lib::golden_harness::{
    CaseSpec, GpuContext, GpuProcessor, composite_case, identity_case, lut_cases, render_case,
    request_gpu_context, scalar_cases, structural_cases, tonemapper_cases,
};

use golden::generator::{H, W, all_images};

mod golden;

const REPRESENTATIVE_IMAGES: [&str; 2] = ["gradient_v", "color_checker"];

/// 案例全集（确定性顺序；基线文件一一对应）
fn build_all_cases() -> Vec<CaseSpec> {
    let mut cases: Vec<CaseSpec> = Vec::new();
    for img in all_images() {
        cases.push(identity_case(img.id));
    }
    for image_id in REPRESENTATIVE_IMAGES {
        cases.extend(scalar_cases(image_id));
        cases.push(composite_case(1, image_id));
        cases.push(composite_case(3, image_id));
        cases.extend(tonemapper_cases(image_id));
    }
    cases.extend(structural_cases());
    cases.extend(lut_cases());
    cases
}

fn load_images() -> HashMap<&'static str, DynamicImage> {
    all_images()
        .into_iter()
        .map(|g| {
            let buf = ImageBuffer::<Rgb<u16>, Vec<u16>>::from_raw(W, H, g.data)
                .expect("generator dimensions must match W×H");
            (g.id, DynamicImage::ImageRgb16(buf))
        })
        .collect()
}

fn make_processor(ctx: &GpuContext) -> GpuProcessor {
    let max_w = (W + 255) & !255; // 与生产 256 对齐规则一致
    let max_h = (H + 255) & !255;
    GpuProcessor::new(ctx.clone(), max_w, max_h).expect("GpuProcessor::new")
}

/// TR-4.1: 全矩阵首跑生成基线成功（--features golden-baseline-update）
#[cfg(feature = "golden-baseline-update")]
#[test]
fn tr_4_1_generate_baseline() {
    use golden::snapshot::{existing_baseline_ids, save_baseline};

    let Some(ctx) = request_gpu_context() else {
        panic!("基线生成需要 GPU/lavapipe 适配器（安装 mesa-vulkan-drivers）");
    };
    let processor = make_processor(&ctx);
    let images = load_images();
    let cases = build_all_cases();

    // 重建语义：清空旧基线，杜绝陈旧文件残留
    let dir = golden::snapshot::baseline_dir();
    std::fs::create_dir_all(&dir).expect("create baseline dir");
    for entry in std::fs::read_dir(&dir).unwrap().flatten() {
        let p = entry.path();
        if p.extension().is_some_and(|e| e == "png") {
            std::fs::remove_file(&p).expect("remove stale baseline");
        }
    }

    let start = Instant::now();
    let mut total_bytes = 0u64;
    for (i, case) in cases.iter().enumerate() {
        let img = &images[case.image_id];
        let rgba = render_case(
            &ctx,
            &processor,
            img,
            &case.adjustment,
            false,
            case.lut.clone(),
        )
        .unwrap_or_else(|e| panic!("case {} render failed: {e}", case.id));
        assert_eq!(
            rgba.len(),
            (W * H * 4) as usize,
            "case {} output size",
            case.id
        );
        let bytes = save_baseline(&case.id, &rgba, W, H)
            .unwrap_or_else(|e| panic!("case {} baseline save failed: {e}", case.id));
        total_bytes += bytes;
        if (i + 1) % 50 == 0 {
            println!("baseline {}/{} ...", i + 1, cases.len());
        }
    }
    println!(
        "TR-4.1 基线生成完成：{} 例，{} KiB，耗时 {:.1?}",
        cases.len(),
        total_bytes / 1024,
        start.elapsed()
    );
    assert_eq!(
        existing_baseline_ids().len(),
        cases.len(),
        "基线数量应与案例数一致"
    );
}

/// TR-4.2: 回归验证 —— 渲染全部案例与基线 ΔE 对比（mean<0.5 且 max<2.0）
#[cfg(not(feature = "golden-baseline-update"))]
#[test]
fn tr_4_2_snapshot_regression() {
    use golden::snapshot::{existing_baseline_ids, load_baseline, verify_case};

    let Some(ctx) = request_gpu_context() else {
        println!(
            "SKIP: no wgpu adapter available (no GPU / lavapipe). Install mesa-vulkan-drivers."
        );
        return;
    };
    let processor = make_processor(&ctx);
    let images = load_images();
    let cases = build_all_cases();

    // 陈旧基线检测：案例集与基线文件集必须一致
    let case_ids: Vec<String> = cases.iter().map(|c| c.id.clone()).collect();
    let existing = existing_baseline_ids();
    let missing: Vec<&String> = case_ids
        .iter()
        .filter(|id| !existing.contains(id))
        .collect();
    let stale: Vec<&String> = existing
        .iter()
        .filter(|id| !case_ids.contains(id))
        .collect();
    assert!(
        missing.is_empty(),
        "缺少 {} 个基线（首次运行请执行 cargo test --features golden-baseline-update --test contract_snapshot）:\n{}",
        missing.len(),
        missing
            .iter()
            .take(10)
            .map(|s| s.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    );
    assert!(
        stale.is_empty(),
        "存在 {} 个陈旧基线（案例已删除/更名，请重建基线）:\n{}",
        stale.len(),
        stale
            .iter()
            .take(10)
            .map(|s| s.as_str())
            .collect::<Vec<_>>()
            .join("\n")
    );

    let start = Instant::now();
    let mut failures: Vec<String> = Vec::new();
    let mut max_mean_overall = 0.0f64;
    for (i, case) in cases.iter().enumerate() {
        let img = &images[case.image_id];
        let baseline = load_baseline(&case.id, W, H)
            .unwrap_or_else(|| panic!("case {} baseline unreadable", case.id));
        let result = render_case(
            &ctx,
            &processor,
            img,
            &case.adjustment,
            false,
            case.lut.clone(),
        )
        .and_then(|rgba| verify_case(&case.id, &rgba, &baseline, W, H));
        match result {
            Ok(stats) => max_mean_overall = max_mean_overall.max(stats.mean),
            Err(report) => failures.push(report),
        }
        if (i + 1) % 100 == 0 {
            println!("verified {}/{} ...", i + 1, cases.len());
        }
    }
    println!(
        "TR-4.2 快照回归：{} 例，全程最大 mean ΔE={:.4}，耗时 {:.1?}，失败 {} 例",
        cases.len(),
        max_mean_overall,
        start.elapsed(),
        failures.len()
    );
    assert!(
        failures.is_empty(),
        "{} 例超阈:\n\n{}",
        failures.len(),
        failures.join("\n\n")
    );
}

/// TR-4.3: 注入 LSB 级偏差演示 —— harness 必须捕获且报告精确（harness 自检，无 GPU）
#[test]
fn tr_4_3_injected_deviation_captured() {
    use golden::snapshot::verify_case;
    use golden::stats::{MAX_MEAN, compare_rgb8, top_deltas};

    let (w, h) = (32u32, 32u32);
    let to_rgba = |rgb: &[u8]| -> Vec<u8> {
        rgb.as_chunks::<3>()
            .0
            .iter()
            .flat_map(|px| [px[0], px[1], px[2], 255])
            .collect()
    };
    let bump = |rgb: &mut Vec<u8>, n: u8| {
        for px in rgb.as_chunks_mut::<3>().0 {
            px[0] = px[0].saturating_add(n);
            px[1] = px[1].saturating_add(n);
            px[2] = px[2].saturating_add(n);
        }
    };

    // 灵敏度下限：中间调均匀 +1 LSB 可测（mean > 0.2），且在设计容差内不误报
    let baseline1: Vec<u8> = vec![128; (w * h * 3) as usize];
    let mut rendered1 = baseline1.clone();
    bump(&mut rendered1, 1);
    let floor = compare_rgb8(&baseline1, &rendered1, w, h);
    assert!(
        floor.mean > 0.2 && floor.mean <= MAX_MEAN,
        "+1 LSB 灵敏度下限异常：mean ΔE={:.4}（应 0.2 < mean ≤ {MAX_MEAN}）",
        floor.mean
    );

    // 捕获路径：中间调均匀 +2 LSB（亚可视漂移）→ mean 超阈值 → verify_case 必须失败并含 top-10 报告
    let mut rendered2 = baseline1.clone();
    bump(&mut rendered2, 2);
    let stats = compare_rgb8(&baseline1, &rendered2, w, h);
    assert!(
        stats.mean > MAX_MEAN,
        "2 LSB 注入的 mean ΔE={:.4} 应超阈值 {MAX_MEAN}",
        stats.mean
    );
    let err = verify_case("demo_2lsb", &to_rgba(&rendered2), &baseline1, w, h).unwrap_err();
    assert!(err.contains("超阈"), "报告应标记超阈：{err}");

    // 定位精度：中间调单像素强扰动 —— max/top-1 位置必须精确命中 (7,5)
    let baseline3: Vec<u8> = vec![128; (w * h * 3) as usize];
    let mut rendered3 = baseline3.clone();
    let (poke_x, poke_y) = (7usize, 5usize);
    let i = (poke_y * w as usize + poke_x) * 3;
    rendered3[i] = rendered3[i].wrapping_add(40);
    rendered3[i + 1] = rendered3[i + 1].wrapping_sub(30);
    rendered3[i + 2] = rendered3[i + 2].wrapping_add(60);
    let stats2 = compare_rgb8(&baseline3, &rendered3, w, h);
    assert_eq!(
        stats2.max_position,
        (poke_x as u32, poke_y as u32),
        "max 偏差位置必须精确"
    );
    let top = top_deltas(&baseline3, &rendered3, w, h, 10);
    assert_eq!(
        (top[0].x, top[0].y),
        (poke_x as u32, poke_y as u32),
        "top-1 偏差位置必须精确"
    );
    let err2 = verify_case("demo_poke", &to_rgba(&rendered3), &baseline3, w, h).unwrap_err();
    assert!(err2.contains("(  7,  5)"), "报告应包含扰动坐标：{err2}");

    // 反向演示：未扰动输出必须通过（避免 harness 误报）
    verify_case("demo_clean", &to_rgba(&baseline1), &baseline1, w, h).expect("零偏差必须通过验证");
    println!(
        "TR-4.3 注入偏差演示通过：+1 LSB mean ΔE={:.3}（容差内不误报）、+2 LSB mean ΔE={:.3}（捕获）、单像素定位精确、零偏差通过",
        floor.mean, stats.mean
    );
}
