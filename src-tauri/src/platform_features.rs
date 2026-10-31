// v2.0 backend/platform features that are additive to the core pipeline:
// - R1-3/R1-4: wgpu adapter probing (software-renderer detection) with a
//   capability-based preview-renderer decision and frontend reporting.
// - §4 P1: XMP sidecar export/import (round-trip via a full-fidelity blob,
//   best-effort `crs:` mapping for Lightroom interoperability).
// - §4 P1: watched-folder auto-ingest (lightweight std-only polling watcher).
// - §4 P0: AI one-click enhance (three intensity tiers over the existing
//   histogram-based auto analysis) and AI upscale export.
// - E8: editor-interaction awareness helpers shared with thumbnail workers.

use std::collections::{HashMap, HashSet};
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{LazyLock, Mutex};
use std::time::Duration;

use base64::{Engine as _, engine::general_purpose};
use image::{DynamicImage, GenericImageView, ImageFormat};
use serde::Deserialize;
use serde_json::{Value, json};
use tauri::{AppHandle, Emitter, Manager};

use crate::app_state::AppState;

// ---------------------------------------------------------------------------
// R1-3 / R1-4: wgpu adapter probing and preview-renderer decision
// ---------------------------------------------------------------------------

/// Result of probing the wgpu adapter. Cached on `AppState` because the
/// physical adapter does not change while the app runs.
#[derive(Clone, Debug)]
pub struct GpuAdapterProbe {
    pub success: bool,
    pub backend: String,
    pub name: String,
    pub vendor: String,
    pub device: String,
    pub driver: String,
    pub driver_info: String,
    pub device_type: String,
    /// True when the adapter is a software rasterizer (llvmpipe, lavapipe,
    /// SwiftShader, WARP, ...) or probing failed outright.
    pub is_software: bool,
}

/// Serialized adapter report handed to the frontend.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct GpuAdapterReport {
    pub probed: bool,
    pub backend: String,
    pub name: String,
    pub vendor: String,
    pub device: String,
    pub driver: String,
    pub driver_info: String,
    pub device_type: String,
    pub is_software: bool,
    /// Whether the preview path will actually use the wgpu renderer now.
    pub wgpu_rendering_active: bool,
    /// Human-readable explanation of the decision (user-facing reporting).
    pub reason: String,
}

fn software_adapter_markers() -> &'static [&'static str] {
    &[
        "llvmpipe",
        "lavapipe",
        "swiftshader",
        "softpipe",
        "software renderer",
        "software rasterizer",
        "basic render driver",
        "microsoft basic",
        "intel(r) graphics with llvmpipe",
    ]
}

fn describe_adapter(probe: &GpuAdapterProbe) -> String {
    if !probe.success {
        return "no wgpu adapter available".to_string();
    }
    format!("{} ({}, {})", probe.name, probe.backend, probe.device_type)
}

fn probe_gpu_adapter() -> GpuAdapterProbe {
    // The descriptor honors WGPU_BACKEND from the environment, so the user's
    // "processing backend" setting (applied to std::env during setup) is
    // respected by the probe as well.
    let instance_desc = wgpu::InstanceDescriptor::new_without_display_handle_from_env();
    let instance = wgpu::Instance::new(instance_desc);

    let adapter_result =
        pollster::block_on(instance.request_adapter(&wgpu::RequestAdapterOptions {
            power_preference: wgpu::PowerPreference::HighPerformance,
            compatible_surface: None,
            ..Default::default()
        }));

    match adapter_result {
        Ok(adapter) => {
            let info = adapter.get_info();
            let is_software = info.device_type == wgpu::DeviceType::Cpu
                || software_adapter_markers()
                    .iter()
                    .any(|marker| info.name.to_lowercase().contains(marker));
            log::info!(
                "GPU adapter probe: {} (backend {:?}, device type {:?}, driver {} {}, software: {})",
                info.name,
                info.backend,
                info.device_type,
                info.driver,
                info.driver_info,
                is_software
            );
            GpuAdapterProbe {
                success: true,
                backend: format!("{:?}", info.backend),
                name: info.name,
                vendor: format!("0x{:04x}", info.vendor),
                device: format!("0x{:04x}", info.device),
                driver: info.driver,
                driver_info: info.driver_info,
                device_type: format!("{:?}", info.device_type),
                is_software,
            }
        }
        Err(e) => {
            log::warn!("GPU adapter probe failed: {}", e);
            GpuAdapterProbe {
                success: false,
                backend: "None".to_string(),
                name: String::new(),
                vendor: String::new(),
                device: String::new(),
                driver: String::new(),
                driver_info: String::new(),
                device_type: "Unknown".to_string(),
                is_software: true,
            }
        }
    }
}

pub fn get_or_probe_adapter(state: &AppState) -> GpuAdapterProbe {
    {
        let cached = state
            .gpu_adapter_probe
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(probe) = cached.as_ref() {
            return probe.clone();
        }
    }

    let probe = probe_gpu_adapter();
    *state
        .gpu_adapter_probe
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Some(probe.clone());
    probe
}

/// Capability-based decision for using the wgpu preview renderer.
///
/// Desktop platforms keep the existing settings-driven behavior, with one
/// addition: a detected software rasterizer gracefully falls back to the CPU
/// encode path instead of pushing interactive frames through llvmpipe.
///
/// On Linux/Android the preview path stays disabled for now: the GPU compute
/// pipeline works there, but the present-to-webview display layer is not wired
/// up for these platforms yet (the GPU context is created without a surface),
/// so enabling it would yield blank previews. The probe still runs and its
/// result is reported to the frontend so the situation is user-visible and the
/// display-layer enablement (R1-3 follow-up) can flip the decision later.
pub fn wgpu_rendering_decision(
    probe: &GpuAdapterProbe,
    settings: &crate::app_settings::AppSettings,
) -> (bool, String) {
    #[cfg(any(target_os = "linux", target_os = "android"))]
    {
        let adapter = describe_adapter(probe);
        if settings.use_wgpu_renderer == Some(true) && probe.success && !probe.is_software {
            (
                false,
                format!(
                    "Hardware adapter detected ({}), but the wgpu display-surface integration is not enabled on this platform yet; using the CPU preview path.",
                    adapter
                ),
            )
        } else {
            (
                false,
                format!(
                    "wgpu preview disabled on this platform (adapter: {}).",
                    adapter
                ),
            )
        }
    }

    #[cfg(not(any(target_os = "linux", target_os = "android")))]
    {
        if !settings.use_wgpu_renderer.unwrap_or(true) {
            return (false, "wgpu preview disabled in settings.".to_string());
        }
        if !probe.success {
            return (
                false,
                "No wgpu adapter available; using the CPU preview path.".to_string(),
            );
        }
        if probe.is_software {
            return (
                false,
                format!(
                    "Software renderer detected ({}); falling back to the CPU preview path.",
                    probe.name
                ),
            );
        }
        (
            true,
            format!("Hardware adapter: {}.", describe_adapter(probe)),
        )
    }
}

fn report_from_probe(probe: &GpuAdapterProbe, active: bool, reason: String) -> GpuAdapterReport {
    GpuAdapterReport {
        probed: probe.success,
        backend: probe.backend.clone(),
        name: probe.name.clone(),
        vendor: probe.vendor.clone(),
        device: probe.device.clone(),
        driver: probe.driver.clone(),
        driver_info: probe.driver_info.clone(),
        device_type: probe.device_type.clone(),
        is_software: probe.is_software,
        wgpu_rendering_active: active,
        reason,
    }
}

/// Decides whether the current preview frame should go through the wgpu
/// renderer. Called per preview job; the probe itself runs only once.
pub fn resolve_wgpu_rendering(
    state: &AppState,
    settings: &crate::app_settings::AppSettings,
) -> bool {
    let probe = get_or_probe_adapter(state);
    let (active, reason) = wgpu_rendering_decision(&probe, settings);
    if !active {
        log::debug!("wgpu preview renderer not used: {}", reason);
    }
    active
}

#[tauri::command]
pub fn get_gpu_adapter_info(app_handle: AppHandle) -> Result<GpuAdapterReport, String> {
    let state = app_handle.state::<AppState>();
    let probe = get_or_probe_adapter(&state);
    let settings = crate::app_settings::load_settings(app_handle.clone())?;
    let (active, reason) = wgpu_rendering_decision(&probe, &settings);
    Ok(report_from_probe(&probe, active, reason))
}

/// Startup probe + one-shot user-facing report. Runs off the setup thread so
/// adapter enumeration never delays launch.
pub fn start_adapter_reporting(app_handle: AppHandle) {
    std::thread::spawn(move || {
        let state = app_handle.state::<AppState>();
        let probe = get_or_probe_adapter(&state);
        let settings = crate::app_settings::load_settings(app_handle.clone()).unwrap_or_default();
        let (active, reason) = wgpu_rendering_decision(&probe, &settings);
        log::info!("Preview renderer decision: wgpu={} ({})", active, reason);
        let _ = app_handle.emit(
            "gpu-adapter-report",
            report_from_probe(&probe, active, reason),
        );
    });
}

// ---------------------------------------------------------------------------
// E8: editor-interaction awareness (shared with the thumbnail workers)
// ---------------------------------------------------------------------------

/// How long after the last interactive preview render an "editor is busy"
/// state is assumed. Covers slider-drag and zoom interactions, which arrive
/// in bursts.
const INTERACTION_ACTIVE_WINDOW_MS: u64 = 1500;

pub fn now_unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

pub fn is_editor_interacting(state: &AppState) -> bool {
    let last = state.last_interactive_render_ms.load(Ordering::Relaxed);
    last != 0 && now_unix_ms().saturating_sub(last) < INTERACTION_ACTIVE_WINDOW_MS
}

/// Blocks the calling (background) worker while an editor interaction is in
/// flight, bounded by `max_wait`, so background work yields GPU/decode
/// resources to interactive frames instead of interleaving with them.
pub fn yield_to_editor_interactions(state: &AppState, max_wait: Duration) {
    let start = std::time::Instant::now();
    while is_editor_interacting(state) && start.elapsed() < max_wait {
        std::thread::sleep(Duration::from_millis(100));
    }
}

// ---------------------------------------------------------------------------
// §4 P1: XMP sidecar export / import
// ---------------------------------------------------------------------------

/// RapidRAW adjustment key -> Adobe Camera Raw `crs:` attribute. Inverse of
/// the import mapping in `preset_converter::convert_xmp_to_preset`.
const XMP_CRS_MAPPINGS: &[(&str, &str)] = &[
    ("exposure", "Exposure2012"),
    ("contrast", "Contrast2012"),
    ("highlights", "Highlights2012"),
    ("shadows", "Shadows2012"),
    ("whites", "Whites2012"),
    ("blacks", "Blacks2012"),
    ("clarity", "Clarity2012"),
    ("structure", "Texture"),
    ("dehaze", "Dehaze"),
    ("vibrance", "Vibrance"),
    ("saturation", "Saturation"),
    ("vignetteAmount", "PostCropVignetteAmount"),
    ("vignetteMidpoint", "PostCropVignetteMidpoint"),
    ("vignetteFeather", "PostCropVignetteFeather"),
    ("vignetteRoundness", "PostCropVignetteRoundness"),
    ("grainAmount", "GrainAmount"),
    ("grainSize", "GrainSize"),
    ("grainRoughness", "GrainFrequency"),
    ("lumaNoiseReduction", "LuminanceSmoothing"),
    ("colorNoiseReduction", "ColorNoiseReduction"),
    ("chromaticAberrationRedCyan", "ChromaticAberrationRedCyan"),
    (
        "chromaticAberrationBlueYellow",
        "ChromaticAberrationBlueYellow",
    ),
];

/// Best-effort `crs:` attribute block so Lightroom can pick up the common
/// sliders. White-balance and mask data are intentionally omitted here; the
/// full-fidelity state always travels in the RapidRAW blob below.
fn crs_attribute_block(adjustments: &Value) -> String {
    let mut attrs = String::new();
    for (rr_key, crs_key) in XMP_CRS_MAPPINGS {
        if let Some(num) = adjustments.get(*rr_key).and_then(Value::as_f64) {
            if num.abs() < f64::EPSILON {
                continue;
            }
            if *rr_key == "exposure" {
                attrs.push_str(&format!(" crs:{}=\"{:+.4}\"", crs_key, num));
            } else {
                attrs.push_str(&format!(" crs:{}=\"{:+}\"", crs_key, num.round() as i64));
            }
        }
    }
    attrs
}

fn build_xmp_packet(adjustments: &Value) -> String {
    // The complete RapidRAW adjustments travel base64-encoded in a custom
    // namespace. Base64 sidesteps XML escaping for nested structures (masks,
    // curves, ...) and round-trips losslessly through `import_xmp_sidecar`.
    let blob = general_purpose::STANDARD.encode(adjustments.to_string().as_bytes());
    let crs_attrs = crs_attribute_block(adjustments);
    format!(
        r#"<?xpacket begin="&#xFEFF;" id="W5M0MpCehiHzreSzNTczkc9d"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="RapidRAW">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about="" xmlns:crs="http://ns.adobe.com/camera-raw-settings/1.0/" xmlns:rapidraw="http://rapidraw.com/ns/2.0/" crs:PresetType="Normal" crs:ProcessVersion="11.0"{crs_attrs} rapidraw:Adjustments="{blob}">
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>
<?xpacket end="w"?>
"#,
        crs_attrs = crs_attrs,
        blob = blob
    )
}

/// Writes a `.xmp` sidecar next to the source image and returns its path.
#[tauri::command]
pub fn export_xmp_sidecar(
    image_path: String,
    js_adjustments: Value,
    overwrite: Option<bool>,
) -> Result<String, String> {
    let (source_path, _) = crate::file_management::parse_virtual_path(&image_path);
    if !source_path.is_file() {
        return Err(format!("Image not found: {}", source_path.display()));
    }

    let xmp_path = source_path.with_extension("xmp");
    if xmp_path.exists() && overwrite == Some(false) {
        return Err(format!(
            "XMP sidecar already exists: {}",
            xmp_path.display()
        ));
    }

    let packet = build_xmp_packet(&js_adjustments);
    fs_write_atomic(&xmp_path, packet.as_bytes())?;

    log::info!("Exported XMP sidecar to {}", xmp_path.display());
    Ok(xmp_path.to_string_lossy().into_owned())
}

fn fs_write_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let tmp_path = path.with_extension("xmp.tmp");
    std::fs::write(&tmp_path, bytes).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp_path, path).map_err(|e| e.to_string())
}

/// Reads a `.xmp` sidecar and returns RapidRAW adjustments. The RapidRAW
/// blob wins when present (lossless round-trip); otherwise the standard
/// `crs:` mapping from `preset_converter` is used (Lightroom interop).
#[tauri::command]
pub fn import_xmp_sidecar(path: String) -> Result<Value, String> {
    let content =
        std::fs::read_to_string(&path).map_err(|e| format!("Failed to read XMP file: {}", e))?;

    static BLOB_RE: LazyLock<regex::Regex> =
        LazyLock::new(|| regex::Regex::new(r#"rapidraw:Adjustments="([^"]*)""#).unwrap());
    if let Some(cap) = BLOB_RE.captures(&content)
        && let Ok(decoded) = general_purpose::STANDARD.decode(&cap[1])
        && let Ok(adjustments) = serde_json::from_slice::<Value>(&decoded)
    {
        return Ok(adjustments);
    }

    let preset = crate::preset_converter::convert_xmp_to_preset(&content)?;
    Ok(preset.adjustments)
}

// ---------------------------------------------------------------------------
// §4 P1: watched-folder auto-ingest (std-only polling watcher)
// ---------------------------------------------------------------------------

/// A folder the library watches for new images. Persisted in settings.
#[derive(serde::Serialize, serde::Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WatchedFolderConfig {
    pub path: String,
    #[serde(default = "default_watched_enabled")]
    pub enabled: bool,
}

fn default_watched_enabled() -> bool {
    true
}

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WatchedFolderStatus {
    pub path: String,
    pub enabled: bool,
    pub known_images: usize,
    pub pending_images: usize,
    pub last_scan_unix_ms: u64,
    pub last_new_images: Vec<String>,
}

struct FolderScanState {
    known: HashSet<PathBuf>,
    /// Newly seen files waiting for their size to stabilize across two
    /// consecutive scans (guards against importing half-written files).
    pending: HashMap<PathBuf, u64>,
    last_scan_unix_ms: u64,
    last_new_images: Vec<String>,
    enabled: bool,
}

/// Bumped on every (re)configuration; stale watcher threads exit when the
/// generation no longer matches theirs.
static WATCHER_GENERATION: AtomicU64 = AtomicU64::new(0);

static WATCHER_STATUS: LazyLock<Mutex<HashMap<String, FolderScanState>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

#[tauri::command]
pub fn set_watched_folders(
    app_handle: AppHandle,
    folders: Vec<WatchedFolderConfig>,
) -> Result<(), String> {
    let mut settings = crate::app_settings::load_settings(app_handle.clone())?;
    settings.watched_folders = folders.clone();
    crate::app_settings::save_settings(settings, app_handle.clone())?;

    restart_watcher(app_handle, folders);
    Ok(())
}

#[tauri::command]
pub fn get_watched_folder_status(
    app_handle: AppHandle,
) -> Result<Vec<WatchedFolderStatus>, String> {
    let settings = crate::app_settings::load_settings(app_handle)?;
    let status_lock = WATCHER_STATUS.lock().unwrap_or_else(|e| e.into_inner());

    Ok(settings
        .watched_folders
        .iter()
        .map(|folder| match status_lock.get(&folder.path) {
            Some(state) => WatchedFolderStatus {
                path: folder.path.clone(),
                enabled: folder.enabled,
                known_images: state.known.len(),
                pending_images: state.pending.len(),
                last_scan_unix_ms: state.last_scan_unix_ms,
                last_new_images: state.last_new_images.clone(),
            },
            None => WatchedFolderStatus {
                path: folder.path.clone(),
                enabled: folder.enabled,
                known_images: 0,
                pending_images: 0,
                last_scan_unix_ms: 0,
                last_new_images: Vec::new(),
            },
        })
        .collect())
}

/// (Re)starts the polling watcher with the given configuration. Called by the
/// `set_watched_folders` command and at startup for persisted folders.
pub fn restart_watcher(app_handle: AppHandle, folders: Vec<WatchedFolderConfig>) {
    let generation = WATCHER_GENERATION.fetch_add(1, Ordering::SeqCst) + 1;

    // Keep scan state for folders that stay watched so a reconfiguration
    // does not re-announce existing files.
    {
        let mut status = WATCHER_STATUS.lock().unwrap_or_else(|e| e.into_inner());
        status.retain(|path, _| folders.iter().any(|f| &f.path == path));
    }

    if folders.is_empty() {
        return;
    }

    std::thread::spawn(move || watcher_loop(app_handle, folders, generation));
}

fn watcher_loop(app_handle: AppHandle, folders: Vec<WatchedFolderConfig>, generation: u64) {
    const POLL_INTERVAL: Duration = Duration::from_secs(2);

    loop {
        if WATCHER_GENERATION.load(Ordering::SeqCst) != generation {
            return;
        }
        std::thread::sleep(POLL_INTERVAL);
        if WATCHER_GENERATION.load(Ordering::SeqCst) != generation {
            return;
        }
        for folder in &folders {
            if folder.enabled {
                scan_watched_folder(&app_handle, folder);
            }
        }
    }
}

fn scan_watched_folder(app_handle: &AppHandle, folder: &WatchedFolderConfig) {
    // Top-level scan: keeps the watcher cheap even for large libraries and
    // matches typical camera-download / tether-destination layouts.
    let mut current: HashMap<PathBuf, u64> = HashMap::new();
    let dir = Path::new(&folder.path);
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if !path.is_file() || !crate::formats::is_supported_image_file(&path) {
                continue;
            }
            if let Ok(meta) = entry.metadata() {
                current.insert(path, meta.len());
            }
        }
    }

    let mut ready_paths: Vec<String> = Vec::new();
    {
        let mut status_lock = WATCHER_STATUS.lock().unwrap_or_else(|e| e.into_inner());
        let state = status_lock
            .entry(folder.path.clone())
            .or_insert_with(|| FolderScanState {
                known: HashSet::new(),
                pending: HashMap::new(),
                last_scan_unix_ms: 0,
                last_new_images: Vec::new(),
                enabled: folder.enabled,
            });

        state.enabled = folder.enabled;
        state.last_scan_unix_ms = now_unix_ms();

        if state.known.is_empty() && state.pending.is_empty() {
            // First scan: seed the known set without announcing anything so
            // pointing the watcher at an existing library does not flood-import.
            state.known = current.keys().cloned().collect();
        } else {
            for (path, size) in &current {
                if state.known.contains(path) {
                    state.pending.remove(path);
                    continue;
                }
                match state.pending.get(path) {
                    Some(seen_size) if *seen_size == *size && *size > 0 => {
                        state.pending.remove(path);
                        state.known.insert(path.clone());
                        ready_paths.push(path.to_string_lossy().into_owned());
                    }
                    _ => {
                        state.pending.insert(path.clone(), *size);
                    }
                }
            }
            state.pending.retain(|path, _| current.contains_key(path));
        }
    }

    if !ready_paths.is_empty() {
        log::info!(
            "Watched folder {} picked up {} new image(s)",
            folder.path,
            ready_paths.len()
        );
        let _ = app_handle.emit(
            "watched-folder-new-images",
            json!({ "folder": folder.path, "paths": ready_paths }),
        );
    }
}

// ---------------------------------------------------------------------------
// §4 P0: AI one-click enhance (three intensity tiers)
// ---------------------------------------------------------------------------

#[derive(Deserialize, Debug, Clone, Copy)]
#[serde(rename_all = "camelCase")]
pub enum EnhanceIntensity {
    Subtle,
    Standard,
    Strong,
}

/// Computes a one-click enhancement suggestion for the currently loaded image
/// from the existing histogram-driven auto analysis, scaled by the requested
/// intensity tier and finished with a conservative texture polish.
#[tauri::command]
pub fn ai_auto_enhance(
    state: tauri::State<AppState>,
    app_handle: AppHandle,
    intensity: Option<EnhanceIntensity>,
) -> Result<Value, String> {
    let loaded_image = state
        .original_image
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .ok_or("No image loaded for AI enhance")?;

    let render = crate::image_processing::resolve_render_options_from_handle(
        &app_handle,
        loaded_image.is_raw,
    );
    let exposure = crate::image_processing::effective_baseline_exposure(
        &json!({}),
        loaded_image.as_shot,
        render.baseline,
    );
    let results = crate::image_processing::perform_auto_analysis(&loaded_image.image, exposure);
    let mut adjustments = crate::image_processing::auto_results_to_json(
        &results,
        crate::image_processing::AutoAdjustMode::Normal,
    );

    let k = match intensity.unwrap_or(EnhanceIntensity::Standard) {
        EnhanceIntensity::Subtle => 0.6,
        EnhanceIntensity::Standard => 1.0,
        EnhanceIntensity::Strong => 1.4,
    };

    if let Some(obj) = adjustments.as_object_mut() {
        // Exposure is perceptually the strongest lever; keep it subtler than
        // the tonal sliders while everything else scales linearly.
        if let Some(exp) = obj.get("exposure").and_then(Value::as_f64) {
            obj.insert(
                "exposure".to_string(),
                json!((exp * k * 0.8).clamp(-5.0, 5.0)),
            );
        }
        for (key, value) in obj.iter_mut() {
            if key == "exposure" || key == "activeTools" {
                continue;
            }
            if let Some(num) = value.as_f64() {
                *value = json!(num * k);
            }
        }

        // Texture polish on top of the tonal pass — this is what makes the
        // result read as "enhanced" rather than just auto-levels.
        obj.entry("structure".to_string())
            .or_insert_with(|| json!(12.0 * k));
        obj.entry("sharpness".to_string())
            .or_insert_with(|| json!(10.0 * k));
    }

    Ok(adjustments)
}

// ---------------------------------------------------------------------------
// §4 P0: AI upscale export
// ---------------------------------------------------------------------------

/// Long-edge cap so a 4x request on a 100MP file cannot exhaust memory.
const UPSCALE_MAX_DIM: u32 = 8192;

/// Renders the currently loaded image through the full pipeline at an
/// enlarged resolution (Lanczos3 supersampling + the GPU detail/sharpening
/// chain) and writes it to disk, mirroring the export sidecar behavior.
#[tauri::command]
pub async fn ai_upscale_export(
    app_handle: AppHandle,
    image_path: String,
    js_adjustments: Value,
    scale_factor: f32,
    output_path: String,
    file_format: Option<String>,
    jpeg_quality: Option<u8>,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        run_ai_upscale_export(
            &app_handle,
            &image_path,
            &js_adjustments,
            scale_factor,
            &output_path,
            file_format.as_deref(),
            jpeg_quality,
        )
    })
    .await
    .map_err(|e| format!("Task panicked: {}", e))?
}

#[allow(clippy::too_many_arguments)]
fn run_ai_upscale_export(
    app_handle: &AppHandle,
    image_path: &str,
    js_adjustments: &Value,
    scale_factor: f32,
    output_path: &str,
    file_format: Option<&str>,
    jpeg_quality: Option<u8>,
) -> Result<String, String> {
    let state = app_handle.state::<AppState>();
    let context = crate::image_processing::get_or_init_gpu_context(&state, app_handle)?;

    let loaded_image = state
        .original_image
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone()
        .ok_or("No original image loaded")?;
    if crate::file_management::parse_virtual_path(image_path).0
        != crate::file_management::parse_virtual_path(&loaded_image.path).0
    {
        return Err(format!("'{}' is not the loaded image", image_path));
    }

    let scale = scale_factor.clamp(0.25, 4.0);

    // Composite AI patches onto the base image (same first stage as previews).
    let prepared = crate::image_loader::prepare_base_image_cow(
        &loaded_image.image,
        &loaded_image.path,
        js_adjustments,
    )
    .map_err(|e| format!("Failed to prepare base image: {}", e))?;
    let patched: &DynamicImage = match &prepared {
        std::borrow::Cow::Owned(img) => img,
        std::borrow::Cow::Borrowed(img) => img,
    };

    let (transformed, unscaled_crop_offset) = crate::adjustment_utils::apply_all_transformations(
        std::borrow::Cow::Borrowed(patched),
        js_adjustments,
    );

    let (src_w, src_h) = transformed.dimensions();
    let factor = (scale as f64).min(UPSCALE_MAX_DIM as f64 / src_w.max(src_h) as f64);
    let target_w = ((src_w as f64 * factor).round() as u32).max(1);
    let target_h = ((src_h as f64 * factor).round() as u32).max(1);

    // Reserve memory up front so an oversized request fails cleanly instead
    // of thrashing the GPU pipeline.
    let estimate = target_w as u64 * target_h as u64 * 16;
    let _mem_guard = state
        .memory_budget
        .reserve(estimate, None)
        .ok_or("Not enough memory budget for the requested upscale size")?;

    let upscaled = if target_w == src_w && target_h == src_h {
        transformed.into_owned()
    } else {
        DynamicImage::ImageRgb8(image::imageops::resize(
            &transformed.to_rgb8(),
            target_w,
            target_h,
            image::imageops::FilterType::Lanczos3,
        ))
    };

    let scale_for_gpu = if loaded_image.image.width() > 0 {
        upscaled.width() as f32 / loaded_image.image.width() as f32
    } else {
        1.0
    };
    let scaled_crop_offset = (
        unscaled_crop_offset.0 * scale_for_gpu,
        unscaled_crop_offset.1 * scale_for_gpu,
    );

    let mask_definitions: Vec<crate::mask_generation::MaskDefinition> = js_adjustments
        .get("masks")
        .and_then(|m| serde_json::from_value(m.clone()).ok())
        .unwrap_or_default();
    let mask_bitmaps = crate::mask_generation::get_cached_or_generate_masks(
        &state,
        &loaded_image.path,
        &mask_definitions,
        upscaled.width(),
        upscaled.height(),
        scale_for_gpu,
        scaled_crop_offset,
        js_adjustments,
    )
    .bitmaps;

    let is_raw = loaded_image.is_raw;
    let render = crate::image_processing::resolve_render_options_from_handle(app_handle, is_raw);
    let all_adjustments = crate::image_processing::get_all_adjustments_from_json(
        js_adjustments,
        is_raw,
        loaded_image.as_shot,
        render,
    );
    let lut_path = js_adjustments["lutPath"].as_str();
    let lut = lut_path.and_then(|p| crate::lut_processing::get_or_load_lut(&state, p).ok());
    let unique_hash =
        crate::cache_utils::calculate_full_job_hash(&loaded_image.path, js_adjustments)
            ^ (scale.to_bits() as u64);

    let processed = crate::image_processing::process_and_get_dynamic_image(
        &context,
        &state,
        &upscaled,
        unique_hash,
        crate::image_processing::RenderRequest {
            adjustments: all_adjustments,
            mask_bitmaps: &mask_bitmaps,
            mask_cache_key: None,
            lut,
            roi: None,
        },
        "ai_upscale_export",
    )?;

    let format = file_format.unwrap_or("jpeg").to_lowercase();
    let quality = jpeg_quality.unwrap_or(95);
    let bytes: Vec<u8> = match format.as_str() {
        "png" => {
            let mut buf = Cursor::new(Vec::new());
            processed
                .write_to(&mut buf, ImageFormat::Png)
                .map_err(|e| format!("Failed to encode PNG: {}", e))?;
            buf.into_inner()
        }
        "webp" => {
            let encoder = webp::Encoder::from_image(&processed)
                .map_err(|_| "Failed to create WebP encoder".to_string())?;
            encoder.encode(quality as f32).to_vec()
        }
        "tiff" => {
            let mut buf = Cursor::new(Vec::new());
            processed
                .write_to(&mut buf, ImageFormat::Tiff)
                .map_err(|e| format!("Failed to encode TIFF: {}", e))?;
            buf.into_inner()
        }
        _ => {
            let rgb = processed.to_rgb8();
            let mut buf = Cursor::new(Vec::new());
            rgb.write_with_encoder(image::codecs::jpeg::JpegEncoder::new_with_quality(
                &mut buf, quality,
            ))
            .map_err(|e| format!("Failed to encode JPEG: {}", e))?;
            buf.into_inner()
        }
    };

    std::fs::write(output_path, &bytes)
        .map_err(|e| format!("Failed to write upscaled image: {}", e))?;

    let _ =
        crate::exif_processing::write_rrexif_sidecar(&loaded_image.path, Path::new(output_path));

    log::info!(
        "AI upscale export: {}x{} -> {}x{} ({}) written to {}",
        src_w,
        src_h,
        target_w,
        target_h,
        format,
        output_path
    );
    Ok(output_path.to_string())
}
