//! Stage-timing performance benchmark (v2.0 plan M0-4).
//!
//! Measures the real GPU pipeline headless (lavapipe on CI) over a
//! deterministic synthetic scene:
//!
//! | scenario        | what it measures                                        |
//! |-----------------|---------------------------------------------------------|
//! | preview-1080p   | interactive frame wall clock (P50/P95) + per-stage GPU ns, cold (first frame) and warm (blur/GF cache hits) |
//! | export-45mp     | full-resolution 16-bit export wall clock + per-stage GPU ns |
//! | memory          | peak RSS across the export vs the base image bytes      |
//!
//! Per-stage numbers come from the `RAPIDRAW_STAGE_TIMING=1` wgpu timestamp
//! probe (see `gpu_processing::StageProbe`); wall clock is measured around the
//! full `process_and_get_dynamic_image_*` call, so it includes CPU submit and
//! readback cost — the honest end-user number for the CPU-preview path.
//!
//! The report is JSON (see `examples/bench_stages.rs`) so
//! `bench/perf/compare-perf.mjs` can diff two runs and gate regressions.

use std::path::Path;
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Instant;

use serde::Serialize;

use crate::app_state::AppState;
use crate::as_shot::AsShot;
use crate::gpu_processing::{
    RenderOutputPrecision, RenderRequest, StageTimings, process_and_get_dynamic_image_with_precision,
};
use crate::image_processing::{GpuContext, get_all_adjustments_from_json, resolve_render_options};

/// Adjustment snapshot shared with the golden set (portrait look: exposure,
/// shadows, clarity, luma/color NR, grain, vignette, temperature) — exercises
/// denoise, USM, local contrast, grain and vignette in one render.
const PARAMS: &str = include_str!("../../bench/golden/params/portrait.json");

pub struct BenchConfig {
    /// Preview frame width/height (default 1920×1080).
    pub preview_width: u32,
    pub preview_height: u32,
    /// Steady-state preview iterations (default 24; first is the cold frame).
    pub preview_iterations: u32,
    /// Export width/height (default 9000×5000 = 45MP).
    pub export_width: u32,
    pub export_height: u32,
}

impl Default for BenchConfig {
    fn default() -> Self {
        Self {
            preview_width: 1920,
            preview_height: 1080,
            preview_iterations: 24,
            export_width: 9000,
            export_height: 5000,
        }
    }
}

#[derive(Serialize)]
pub struct Stats {
    pub mean_ms: f64,
    pub p50_ms: f64,
    pub p95_ms: f64,
    pub max_ms: f64,
}

impl Stats {
    fn from_ms(mut samples: Vec<f64>) -> Self {
        samples.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let n = samples.len();
        let mean = samples.iter().sum::<f64>() / n as f64;
        let pick = |q: f64| -> f64 {
            let idx = ((q * n as f64).ceil() as usize).clamp(1, n) - 1;
            samples[idx]
        };
        Self {
            mean_ms: mean,
            p50_ms: pick(0.5),
            p95_ms: pick(0.95),
            max_ms: samples[n - 1],
        }
    }
}

#[derive(Serialize)]
pub struct BenchReport {
    pub version: u32,
    pub adapter: String,
    pub backend: String,
    /// Whether the wgpu timestamp probe was active (false → stage fields zero).
    pub stage_timing: bool,
    pub preview: PreviewReport,
    pub export: ExportReport,
    pub memory: MemoryReport,
}

#[derive(Serialize)]
pub struct PreviewReport {
    pub width: u32,
    pub height: u32,
    pub iterations: u32,
    pub params: &'static str,
    /// Wall clock over every iteration (includes the cold first frame).
    pub wall_ms: Stats,
    /// Wall clock without the cold first frame (what a slider drag feels like).
    pub wall_ms_steady: Stats,
    /// GPU stage breakdown of the cold frame (GF coeffs + blurs + main).
    pub stages_cold: StageTimings,
    /// GPU stage breakdown of the last (fully cached) frame.
    pub stages_warm: StageTimings,
}

#[derive(Serialize)]
pub struct ExportReport {
    pub width: u32,
    pub height: u32,
    pub wall_ms: f64,
    pub stages: StageTimings,
}

#[derive(Serialize)]
pub struct MemoryReport {
    /// Peak RSS (VmHWM) after the export, bytes.
    pub peak_rss_bytes: Option<u64>,
    /// RSS right before the export render started, bytes.
    pub baseline_rss_bytes: Option<u64>,
    /// Peak minus baseline: lower bound of the export working set, bytes.
    pub growth_bytes: Option<u64>,
    /// Base image bytes (16-bit RGB, the export input).
    pub base_bytes: u64,
    pub growth_ratio: Option<f64>,
}

// ---------------------------------------------------------------- context --

fn gpu_context() -> Option<&'static GpuContext> {
    static CTX: OnceLock<Option<GpuContext>> = OnceLock::new();
    CTX.get_or_init(build_context).as_ref()
}

fn build_context() -> Option<GpuContext> {
    let instance = wgpu::Instance::new(wgpu::InstanceDescriptor::new_without_display_handle_from_env());
    let adapter = pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
        power_preference: wgpu::PowerPreference::HighPerformance,
        ..Default::default()
    }))
    .ok()?;
    let mut required_features = wgpu::Features::empty();
    if adapter
        .features()
        .contains(wgpu::Features::TEXTURE_ADAPTER_SPECIFIC_FORMAT_FEATURES)
    {
        required_features |= wgpu::Features::TEXTURE_ADAPTER_SPECIFIC_FORMAT_FEATURES;
    }
    if adapter.features().contains(
        wgpu::Features::TIMESTAMP_QUERY | wgpu::Features::TIMESTAMP_QUERY_INSIDE_ENCODERS,
    ) {
        required_features |=
            wgpu::Features::TIMESTAMP_QUERY | wgpu::Features::TIMESTAMP_QUERY_INSIDE_ENCODERS;
    }
    let limits = adapter.limits();
    let (device, queue) = pollster::block_on(adapter.request_device(&wgpu::DeviceDescriptor {
        label: Some("Stage Bench Device"),
        required_features,
        required_limits: limits.clone(),
        ..Default::default()
    }))
    .ok()?;
    Some(GpuContext {
        device: Arc::new(device),
        queue: Arc::new(queue),
        limits,
        adapter_info: adapter.get_info(),
        display: Arc::new(Mutex::new(None)),
    })
}

// ------------------------------------------------------------------ scene --

/// Deterministic synthetic "landscape": warm sky gradient, sun disk with
/// falloff, sinusoidal ridge silhouette, textured ground with fine detail.
/// 16-bit RGB, sRGB display-encoded like a normal import.
fn synthetic_scene(width: u32, height: u32) -> crate::golden_fixtures::Rgb16Image {
    let mut img = crate::golden_fixtures::Rgb16Image::new(width, height);
    let (w, h) = (width as f32, height as f32);
    let horizon = h * 0.62;
    for (x, y, px) in img.enumerate_pixels_mut() {
        let (fx, fy) = (x as f32 / w, y as f32 / h);
        let rgb = if fy < horizon / h {
            // Sky: vertical gradient from warm highlight to cool horizon.
            let t = fy / (horizon / h);
            let warm = (1.0 - t).powf(1.4);
            let sun = {
                let dx = fx - 0.68;
                let dy = fy - 0.22;
                let d = (dx * dx * 1.6 + dy * dy).sqrt();
                (-d * 14.0).exp() * 1.2 + (-d * 3.0).exp() * 0.35
            };
            let base = 0.55 + 0.35 * (1.0 - t) + sun * 0.9;
            [
                (base * (0.62 + 0.38 * warm)).min(1.0),
                (base * (0.70 + 0.30 * warm)).min(1.0),
                (base * (0.88 - 0.20 * warm)).min(1.0),
            ]
        } else {
            // Ground: mid-dark with ridge silhouette and fine texture.
            let ridge_y = horizon / h - 0.10 * (fx * 9.0).sin() * (fx * 3.0).cos().abs();
            let above_ridge = fy < ridge_y * 1.0;
            let detail = ((fx * 240.0).sin() * (fy * 200.0).cos() * 0.5
                + (fx * 37.0 + fy * 53.0).sin() * 0.5)
                * 0.012;
            let shade = if above_ridge { 0.06 } else { 0.30 };
            let v = (shade + detail).clamp(0.0, 1.0);
            [v * 0.92, v * 0.95, v]
        };
        px.0[0] = (rgb[0].clamp(0.0, 1.0) * 65535.0) as u16;
        px.0[1] = (rgb[1].clamp(0.0, 1.0) * 65535.0) as u16;
        px.0[2] = (rgb[2].clamp(0.0, 1.0) * 65535.0) as u16;
    }
    img
}

// ----------------------------------------------------------------- render --

fn render_once(
    context: &GpuContext,
    state: &AppState,
    base: &image::DynamicImage,
    precision: RenderOutputPrecision,
) -> Result<image::DynamicImage, String> {
    let js: serde_json::Value = serde_json::from_str(PARAMS).expect("valid params");
    let (transformed, _) = crate::adjustment_utils::apply_all_transformations(base.clone(), &js);
    let settings = crate::app_settings::AppSettings::default();
    let adjustments = get_all_adjustments_from_json(
        &js,
        false,
        AsShot::reference(),
        resolve_render_options(&settings, false),
    );
    process_and_get_dynamic_image_with_precision(
        context,
        state,
        transformed.as_ref(),
        0,
        RenderRequest {
            adjustments,
            mask_bitmaps: &[],
            mask_cache_key: None,
            lut: None,
            roi: None,
        },
        "stage-bench",
        precision,
    )
}

fn last_stage_timings(state: &AppState) -> StageTimings {
    state
        .gpu_processor
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
        .and_then(|s| s.processor.last_stage_timings())
        .unwrap_or_default()
}

// ----------------------------------------------------------------- memory --

#[cfg(target_os = "linux")]
fn rss_kb(field: &str) -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    status
        .lines()
        .find(|l| l.starts_with(field))
        .and_then(|l| l.split_whitespace().nth(1))
        .and_then(|v| v.parse::<u64>().ok())
        .map(|kb| kb * 1024)
}

#[cfg(not(target_os = "linux"))]
fn rss_kb(_field: &str) -> Option<u64> {
    None
}

// -------------------------------------------------------------------- run --

pub fn run(config: &BenchConfig) -> Result<BenchReport, String> {
    let context = gpu_context().ok_or("no wgpu adapter available")?;
    let info = context.adapter_info.clone();
    let state = AppState::default();
    let stage_timing = std::env::var("RAPIDRAW_STAGE_TIMING").ok().as_deref() == Some("1");

    // -- preview: 1080p frames, cold + steady state -------------------------
    let preview_base = image::DynamicImage::ImageRgb16(synthetic_scene(
        config.preview_width,
        config.preview_height,
    ));
    let mut wall = Vec::with_capacity(config.preview_iterations as usize);
    let mut stages_cold = StageTimings::default();
    let mut stages_warm = StageTimings::default();
    for i in 0..config.preview_iterations {
        let start = Instant::now();
        render_once(context, &state, &preview_base, RenderOutputPrecision::EightBit)?;
        wall.push(start.elapsed().as_secs_f64() * 1000.0);
        if i == 0 {
            stages_cold = last_stage_timings(&state);
        }
        stages_warm = last_stage_timings(&state);
    }
    let steady: Vec<f64> = wall[1..].to_vec();

    // -- export: full-resolution 16-bit render ------------------------------
    let export_base = image::DynamicImage::ImageRgb16(synthetic_scene(
        config.export_width,
        config.export_height,
    ));
    let base_bytes = export_base.as_bytes().len() as u64;
    let baseline_rss = rss_kb("VmRSS:");
    let start = Instant::now();
    render_once(context, &state, &export_base, RenderOutputPrecision::SixteenBit)?;
    let export_wall_ms = start.elapsed().as_secs_f64() * 1000.0;
    let export_stages = last_stage_timings(&state);
    let peak_rss = rss_kb("VmHWM:");

    let growth_bytes = match (peak_rss, baseline_rss) {
        (Some(peak), Some(base)) => Some(peak.saturating_sub(base)),
        _ => None,
    };
    let memory = MemoryReport {
        peak_rss_bytes: peak_rss,
        baseline_rss_bytes: baseline_rss,
        growth_bytes,
        base_bytes,
        growth_ratio: growth_bytes.map(|g| g as f64 / base_bytes as f64),
    };

    Ok(BenchReport {
        version: 1,
        adapter: info.name,
        backend: format!("{:?}", info.backend),
        stage_timing,
        preview: PreviewReport {
            width: config.preview_width,
            height: config.preview_height,
            iterations: config.preview_iterations,
            params: "portrait",
            wall_ms: Stats::from_ms(wall),
            wall_ms_steady: Stats::from_ms(steady),
            stages_cold,
            stages_warm,
        },
        export: ExportReport {
            width: config.export_width,
            height: config.export_height,
            wall_ms: export_wall_ms,
            stages: export_stages,
        },
        memory,
    })
}

/// Human-readable summary table (also written into the JSON `summary` field by
/// the CLI wrapper).
pub fn format_summary(report: &BenchReport) -> String {
    let ns_ms = |ns: u64| ns as f64 / 1e6;
    let stage_line = |s: &StageTimings| -> String {
        format!(
            "guided {:.2} | flare {:.2} | blur {:.2}/{:.2}/{:.2}/{:.2} | main {:.2} ({} tiles)",
            ns_ms(s.guided_coeffs_ns),
            ns_ms(s.flare_ns),
            ns_ms(s.blur_ns[0]),
            ns_ms(s.blur_ns[1]),
            ns_ms(s.blur_ns[2]),
            ns_ms(s.blur_ns[3]),
            ns_ms(s.main_ns),
            s.main_tiles,
        )
    };
    let mut out = String::new();
    out.push_str(&format!(
        "adapter: {} ({})\nstage timing: {}\n\n",
        report.adapter, report.backend, report.stage_timing
    ));
    out.push_str(&format!(
        "preview {}x{} ({} iters, params={}):\n  wall  mean {:.2} | p50 {:.2} | p95 {:.2} | max {:.2} ms\n  steady mean {:.2} | p50 {:.2} | p95 {:.2} ms\n  stages cold: {}\n  stages warm: {}\n\n",
        report.preview.width,
        report.preview.height,
        report.preview.iterations,
        report.preview.params,
        report.preview.wall_ms.mean_ms,
        report.preview.wall_ms.p50_ms,
        report.preview.wall_ms.p95_ms,
        report.preview.wall_ms.max_ms,
        report.preview.wall_ms_steady.mean_ms,
        report.preview.wall_ms_steady.p50_ms,
        report.preview.wall_ms_steady.p95_ms,
        stage_line(&report.preview.stages_cold),
        stage_line(&report.preview.stages_warm),
    ));
    out.push_str(&format!(
        "export {}x{}: wall {:.1} ms\n  stages: {}\n\n",
        report.export.width, report.export.height, report.export.wall_ms, stage_line(&report.export.stages),
    ));
    if let (Some(peak), Some(growth), Some(ratio)) = (
        report.memory.peak_rss_bytes,
        report.memory.growth_bytes,
        report.memory.growth_ratio,
    ) {
        out.push_str(&format!(
            "memory: peak RSS {:.0} MiB | export growth {:.0} MiB | base {:.0} MiB | growth/base {:.2}x\n",
            peak as f64 / (1 << 20) as f64,
            growth as f64 / (1 << 20) as f64,
            report.memory.base_bytes as f64 / (1 << 20) as f64,
            ratio,
        ));
    } else {
        out.push_str("memory: not available on this platform\n");
    }
    out
}

/// Write the JSON report to `path` (creating parent directories).
pub fn write_report(report: &BenchReport, path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json = serde_json::to_string_pretty(report).map_err(|e| e.to_string())?;
    std::fs::write(path, json).map_err(|e| e.to_string())
}
