//! 快照回归 harness（spec: v2-engine-contract-tests, Task 4）。
//!
//! 仅在 `golden-tests` feature 下编译（dev 资产，不进生产二进制）。
//! 因 `get_global_adjustments_from_json` 为 pub(crate)，集成测试无法直接调用，
//! 故渲染驱动置于 lib 内；案例绑定哪张基准图由测试侧（tests/contract_snapshot.rs）
//! 组合决定 —— 基准图清单的唯一事实源是 tests/golden/generator.rs，
//! 参数清单的唯一事实源是 param_matrix.rs。
//!
//! 渲染路径与生产 process_and_get_dynamic_image_inner 完全一致：
//! Rgb16 → rgba32f → f16 → Rgba16Float 纹理 → GpuProcessor::run → RGBA8 读回。
//! 输出不做 f32 重采样，直接 RGBA8 → RGB8 与基线做 ΔE2000 对比（零编码器介入）。

use std::sync::{Arc, Mutex};

use half::f16;
use image::{DynamicImage, GenericImageView};
use serde_json::{Value, json};
use wgpu::util::{DeviceExt, TextureDataOrder};

use crate::image_processing::{AllAdjustments, get_global_adjustments_from_json};
use crate::lut_processing::Lut;
use crate::param_matrix::{MATRIX, TONE_MAPPER_LEVELS, levels};

pub use crate::gpu_processing::GpuProcessor;
pub use crate::image_processing::GpuContext;
// CPU/GPU 一致性 harness（Task 5）所需的 CPU 侧实现
pub use crate::image_processing::{
    apply_cpu_agx_tonemap, apply_cpu_default_raw_processing, apply_srgb_to_linear,
};

/// 单个快照案例：某张基准图 × 某组 adjustments（+ 可选合成 LUT）
pub struct CaseSpec {
    pub id: String,
    pub image_id: &'static str,
    pub adjustment: Value,
    pub lut: Option<Arc<Lut>>,
}

/// 合成 LUT 种类（程序化构造，零外部素材）
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LutKind {
    /// 8³ 对比度增强 LUT（斜率 1.4）
    Contrast,
}

/// 构建 3D LUT（.cube 布局约定：r 分量变化最快）
pub fn build_lut(kind: LutKind) -> Arc<Lut> {
    match kind {
        LutKind::Contrast => {
            let size = 8u32;
            let n = (size * size * size) as usize;
            let mut data = Vec::with_capacity(n * 3);
            let coord = |c: u32| c as f32 / (size - 1) as f32;
            let contrast = |v: f32| ((v - 0.5) * 1.4 + 0.5).clamp(0.0, 1.0);
            for b in 0..size {
                for g in 0..size {
                    for r in 0..size {
                        data.push(contrast(coord(r)));
                        data.push(contrast(coord(g)));
                        data.push(contrast(coord(b)));
                    }
                }
            }
            Arc::new(Lut { size, data })
        }
    }
}

fn slug(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect()
}

fn base_visibility(all: bool) -> Value {
    json!({
        "sectionVisibility": {
            "basic": all, "color": all, "details": all, "effects": all, "curves": all
        }
    })
}

fn inject(obj: &mut Value, section: &str, key: &str, v: Value) {
    let map = obj.as_object_mut().unwrap();
    let target = match section {
        "colorGrading" | "colorCalibration" => map
            .entry(section.to_string())
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .unwrap(),
        _ => map,
    };
    target.insert(key.to_string(), v);
}

/// 恒等案例：全部默认值（同时覆盖无 default 参数的 L2=0 档与有 default 参数的 d 档）
pub fn identity_case(image_id: &'static str) -> CaseSpec {
    CaseSpec {
        id: format!("{image_id}__identity"),
        image_id,
        adjustment: base_visibility(true),
        lut: None,
    }
}

/// 隔离标量案例：单参数 × 非默认档（L0=-2s, L1=-s, L3=+s, L4=+2s；L2 由恒等案例覆盖）。
/// lutIntensity 除外 —— has_lut=0 时 shader 门控为恒等，由 lut_cases 用真实 LUT 覆盖。
pub fn scalar_cases(image_id: &'static str) -> Vec<CaseSpec> {
    let mut cases = Vec::new();
    for spec in MATRIX {
        if spec.section == "effects" && spec.key == "lutIntensity" {
            continue;
        }
        for level in [0usize, 1, 3, 4] {
            let mut adj = base_visibility(true);
            inject(&mut adj, spec.section, spec.key, json!(levels(spec)[level]));
            cases.push(CaseSpec {
                id: format!(
                    "{image_id}__{}__{}__L{level}",
                    slug(spec.section),
                    slug(spec.key)
                ),
                image_id,
                adjustment: adj,
                lut: None,
            });
        }
    }
    cases
}

/// 全矩阵复合案例：全部标量同时注入同档位（交互回归）；lutIntensity/lutPath 不注入
pub fn composite_case(level_idx: usize, image_id: &'static str) -> CaseSpec {
    let mut adj = base_visibility(true);
    for spec in MATRIX {
        if spec.section == "effects" && spec.key == "lutIntensity" {
            continue;
        }
        inject(
            &mut adj,
            spec.section,
            spec.key,
            json!(levels(spec)[level_idx]),
        );
    }
    inject(&mut adj, "", "toneMapper", json!("basic"));
    CaseSpec {
        id: format!("{image_id}__composite__L{level_idx}"),
        image_id,
        adjustment: adj,
        lut: None,
    }
}

/// toneMapper 枚举案例（basic 档由恒等案例覆盖）
pub fn tonemapper_cases(image_id: &'static str) -> Vec<CaseSpec> {
    TONE_MAPPER_LEVELS
        .iter()
        .filter(|tm| **tm != "basic")
        .map(|tm| {
            let mut adj = base_visibility(true);
            inject(&mut adj, "", "toneMapper", json!(tm));
            CaseSpec {
                id: format!("{image_id}__toneMapper__{tm}"),
                image_id,
                adjustment: adj,
                lut: None,
            }
        })
        .collect()
}

/// 结构参数案例（curves / hsl / colorGrading / showClipping），绑定对各自算子最敏感的基准图
pub fn structural_cases() -> Vec<CaseSpec> {
    let pts = |n: usize, y_max: f64| -> Value {
        json!((0..n)
            .map(|i| json!({"x": (i * 255 / (n - 1)) as f64, "y": (i as f64 * y_max / (n - 1) as f64)}))
            .collect::<Vec<_>>())
    };
    let mut cases = Vec::new();

    // curves 3 组形态 × mixed_noise
    for (n, y_max, tag) in [
        (2usize, 255.0, "2pt"),
        (8, 200.0, "8pt"),
        (16, 160.0, "16pt"),
    ] {
        let mut adj = base_visibility(true);
        let curve = pts(n, y_max);
        inject(
            &mut adj,
            "",
            "curves",
            json!({ "luma": curve, "red": curve, "green": curve, "blue": curve }),
        );
        cases.push(CaseSpec {
            id: format!("mixed_noise__curves__{tag}"),
            image_id: "mixed_noise",
            adjustment: adj,
            lut: None,
        });
    }

    // hsl 全 8 色 × skin_tone（复合）+ 单色reds × color_checker（隔离）
    let mut adj = base_visibility(true);
    inject(
        &mut adj,
        "",
        "hsl",
        json!({
            "reds": { "hue": 10.0, "saturation": 20.0, "luminance": 30.0 },
            "oranges": { "hue": -10.0, "saturation": -20.0, "luminance": -30.0 },
            "yellows": { "hue": 10.0, "saturation": 20.0, "luminance": 30.0 },
            "greens": { "hue": -10.0, "saturation": -20.0, "luminance": -30.0 },
            "aquas": { "hue": 10.0, "saturation": 20.0, "luminance": 30.0 },
            "blues": { "hue": -10.0, "saturation": -20.0, "luminance": -30.0 },
            "purples": { "hue": 10.0, "saturation": 20.0, "luminance": 30.0 },
            "magentas": { "hue": -10.0, "saturation": -20.0, "luminance": -30.0 }
        }),
    );
    cases.push(CaseSpec {
        id: "skin_tone__hsl__all8".into(),
        image_id: "skin_tone",
        adjustment: adj,
        lut: None,
    });
    let mut adj = base_visibility(true);
    inject(
        &mut adj,
        "",
        "hsl",
        json!({ "reds": { "hue": 30.0, "saturation": -80.0, "luminance": 50.0 } }),
    );
    cases.push(CaseSpec {
        id: "color_checker__hsl__reds".into(),
        image_id: "color_checker",
        adjustment: adj,
        lut: None,
    });

    // colorGrading 全区间 × color_checker
    let mut adj = base_visibility(true);
    inject(
        &mut adj,
        "",
        "colorGrading",
        json!({
            "shadows": { "hue": 30.0, "saturation": 250.0, "luminance": -100.0 },
            "midtones": { "hue": -45.0, "saturation": 500.0, "luminance": 250.0 },
            "highlights": { "hue": 180.0, "saturation": 100.0, "luminance": 0.0 },
            "global": { "hue": 90.0, "saturation": 50.0, "luminance": 50.0 },
            "blending": 75.0, "balance": 40.0
        }),
    );
    cases.push(CaseSpec {
        id: "color_checker__colorGrading__full".into(),
        image_id: "color_checker",
        adjustment: adj,
        lut: None,
    });

    // showClipping × hdr_contrast（高反差下裁剪指示最敏感）
    let mut adj = base_visibility(true);
    inject(&mut adj, "", "showClipping", json!(true));
    cases.push(CaseSpec {
        id: "hdr_contrast__showClipping__on".into(),
        image_id: "hdr_contrast",
        adjustment: adj,
        lut: None,
    });

    cases
}

/// 真实 LUT 案例（has_lut=1 + 程序化对比度 LUT × 2 档强度）× saturated_edges
pub fn lut_cases() -> Vec<CaseSpec> {
    let lut = build_lut(LutKind::Contrast);
    [50.0, 100.0]
        .into_iter()
        .map(|intensity| {
            let mut adj = base_visibility(true);
            inject(&mut adj, "", "lutPath", json!("/synthetic/contrast.cube"));
            inject(&mut adj, "effects", "lutIntensity", json!(intensity));
            CaseSpec {
                id: format!("saturated_edges__lut__i{intensity}"),
                image_id: "saturated_edges",
                adjustment: adj,
                lut: Some(Arc::clone(&lut)),
            }
        })
        .collect()
}

/// 请求 GPU 上下文（lavapipe / 实体 GPU 皆可；无适配器返回 None 由调用方 skip）
pub fn request_gpu_context() -> Option<GpuContext> {
    let mut desc = wgpu::InstanceDescriptor::new_without_display_handle_from_env();
    desc.backends = match std::env::var("WGPU_BACKEND").as_deref() {
        Ok("vulkan") => wgpu::Backends::VULKAN,
        Ok("gl") => wgpu::Backends::GL,
        Ok("metal") => wgpu::Backends::METAL,
        Ok("dx12") => wgpu::Backends::DX12,
        _ => wgpu::Backends::all(),
    };
    desc.flags = wgpu::InstanceFlags::empty();
    let instance = wgpu::Instance::new(desc);
    let adapter =
        pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions::default()))
            .ok()?;
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("snapshot-harness-device"),
        required_features: wgpu::Features::empty(),
        required_limits: adapter.limits().clone(),
        experimental_features: wgpu::ExperimentalFeatures::default(),
        memory_hints: wgpu::MemoryHints::MemoryUsage,
        trace: wgpu::Trace::Off,
    }))
    .ok()?;
    Some(GpuContext {
        device: Arc::new(device),
        queue: Arc::new(queue),
        limits: adapter.limits().clone(),
        display: Arc::new(Mutex::new(None)),
    })
}

/// 单案例渲染：与生产路径一致的纹理构建 → GPU dispatch → RGBA8 读回。
/// processor 尺寸应按生产规则取 256 对齐后的 max 尺寸。
/// `is_raw` 传给解析器（影响 is_raw_image 与 srgb→linear 初始转换分支）。
pub fn render_case(
    ctx: &GpuContext,
    processor: &GpuProcessor,
    img: &DynamicImage,
    adjustment: &Value,
    is_raw: bool,
    lut: Option<Arc<Lut>>,
) -> Result<Vec<u8>, String> {
    let (width, height) = img.dimensions();
    let global = get_global_adjustments_from_json(adjustment, is_raw, None);
    let adjustments = AllAdjustments {
        global,
        ..AllAdjustments::default()
    };
    let request = crate::gpu_processing::RenderRequest {
        adjustments,
        mask_bitmaps: &[],
        lut,
        roi: None,
    };

    let f16_data: Vec<f16> = img
        .to_rgba32f()
        .into_raw()
        .into_iter()
        .map(f16::from_f32)
        .collect();
    let texture = ctx.device.create_texture_with_data(
        &ctx.queue,
        &wgpu::TextureDescriptor {
            label: Some("snapshot-input"),
            size: wgpu::Extent3d {
                width,
                height,
                depth_or_array_layers: 1,
            },
            mip_level_count: 1,
            sample_count: 1,
            dimension: wgpu::TextureDimension::D2,
            format: wgpu::TextureFormat::Rgba16Float,
            usage: wgpu::TextureUsages::TEXTURE_BINDING | wgpu::TextureUsages::COPY_DST,
            view_formats: &[],
        },
        TextureDataOrder::MipMajor,
        bytemuck::cast_slice(&f16_data),
    );
    let view = texture.create_view(&Default::default());

    let (pixels, _w, _h, _x, _y) = processor.run(&view, width, height, request, false, false)?;
    Ok(pixels)
}
