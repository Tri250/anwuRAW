use crate::android_integration::is_android_content_uri;
#[cfg(target_os = "android")]
use crate::android_integration::{
    get_android_cached_lut_path, read_android_content_uri, resolve_android_content_uri_name,
};
use anyhow::anyhow;
use image::{DynamicImage, GenericImageView, Rgb, Rgb32FImage};
use include_dir::{Dir, include_dir};
use serde::{Deserialize, Serialize};
use std::fs::{File, copy, create_dir_all, read_dir};
use std::io::{BufRead, BufReader, Cursor};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use base64::{Engine as _, engine::general_purpose};
use mozjpeg_rs::{Encoder, Preset};
use tauri::{AppHandle, Manager, State};

use crate::AppState;
use crate::cache_utils::calculate_transform_hash;
use crate::image_processing::{
    RenderRequest, get_all_adjustments_from_json, process_and_get_dynamic_image,
    resolve_tonemapper_override_from_handle,
};

#[derive(Debug, Clone)]
pub struct Lut {
    pub size: u32,
    pub data: Vec<f32>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LutEntry {
    pub name: String,
    pub path: String,
    pub is_built_in: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LutPreviewRequest {
    pub path: String,
    pub is_built_in: bool,
}

#[derive(Serialize)]
pub struct LutParseResult {
    pub size: u32,
}

#[derive(Serialize)]
pub struct LutPreview {
    pub path: String,
    pub thumb: Option<String>,
}

fn strip_verbatim(path: &Path) -> PathBuf {
    let s = path.to_string_lossy();
    PathBuf::from(s.strip_prefix(r"\\?\").unwrap_or(&s).to_string())
}

// 内置 LUT 编译期内嵌：Android 上 bundle.resources 被打进 APK assets（虚拟路径），
// std::fs::read_dir / File::open 无法访问，导致 list_recipe_luts / 内置胶片列表恒为空，
// 场景增强面板的大师配方芯片全部呈禁用态（v1.6.18 Android 实测回归）。
// 与 lens_correction.rs 的 lensfun_db 采用同一 include_dir 方案，保证全平台一致；
// 桌面端同时消除 AppImage 挂载点漂移导致的资源路径问题。
static EMBEDDED_FILM_LUTS: Dir<'_> = include_dir!("$CARGO_MANIFEST_DIR/resources/film_luts");
static EMBEDDED_RECIPE_LUTS: Dir<'_> =
    include_dir!("$CARGO_MANIFEST_DIR/resources/master_recipe_luts");

/// 内嵌 LUT 的虚拟路径前缀：`builtin://<scheme_dir>/<file_name>`，
/// 作为稳定标识持久化到会话（lutPath），跨会话/跨安装位置永远有效。
pub const BUILTIN_LUT_PREFIX: &str = "builtin://";

pub fn is_builtin_lut_path(path: &str) -> bool {
    path.starts_with(BUILTIN_LUT_PREFIX)
}

/// 从内嵌资源读取 LUT 字节。仅接受 `builtin://film_luts/...` 与
/// `builtin://master_recipe_luts/...` 两种白名单目录，文件名精确匹配（无遍历风险）。
fn builtin_lut_bytes(path: &str) -> Option<&'static [u8]> {
    let rest = path.strip_prefix(BUILTIN_LUT_PREFIX)?;
    let (scheme_dir, file_name) = rest.split_once('/')?;
    if file_name.is_empty() {
        return None;
    }
    let dir = match scheme_dir {
        "film_luts" => &EMBEDDED_FILM_LUTS,
        "master_recipe_luts" => &EMBEDDED_RECIPE_LUTS,
        _ => return None,
    };
    dir.get_file(file_name).map(|f| f.contents())
}

/// 枚举内嵌 LUT 目录为 LutEntry 列表（与 list_luts_in_dir 同构：仅受支持扩展名、按名排序）
fn list_luts_in_embedded(dir: &Dir<'_>, scheme_dir: &str) -> Vec<LutEntry> {
    let mut entries: Vec<LutEntry> = Vec::new();
    for file in dir.files() {
        let file_path = Path::new(file.path());
        let extension = file_path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase();
        let is_supported = matches!(
            extension.as_str(),
            "cube" | "3dl" | "png" | "jpg" | "jpeg" | "tiff"
        );
        if !is_supported {
            continue;
        }
        let name = file_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("LUT")
            .to_string();
        entries.push(LutEntry {
            name,
            path: format!(
                "{}{}/{}",
                BUILTIN_LUT_PREFIX,
                scheme_dir,
                file.path().display()
            ),
            is_built_in: true,
        });
    }
    entries.sort_by_key(|a| a.name.to_lowercase());
    entries
}

fn film_luts_dir(app_handle: &AppHandle) -> Option<PathBuf> {
    app_handle
        .path()
        .resolve("resources/film_luts", tauri::path::BaseDirectory::Resource)
        .ok()
        .map(|p| strip_verbatim(&p))
}

pub(crate) fn master_recipe_luts_dir(app_handle: &AppHandle) -> Option<PathBuf> {
    app_handle
        .path()
        .resolve(
            "resources/master_recipe_luts",
            tauri::path::BaseDirectory::Resource,
        )
        .ok()
        .map(|p| strip_verbatim(&p))
}

pub fn get_luts_dir(app_data_dir: &Path) -> anyhow::Result<PathBuf> {
    let luts_dir = app_data_dir.join("luts");
    if !luts_dir.exists() {
        create_dir_all(&luts_dir)?;
    }
    Ok(luts_dir)
}

pub fn list_luts_in_dir(dir: &Path, is_built_in: bool) -> anyhow::Result<Vec<LutEntry>> {
    let mut entries: Vec<LutEntry> = Vec::new();
    if !dir.exists() {
        return Ok(entries);
    }
    for entry in read_dir(dir)? {
        let path = entry?.path();
        let extension = path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase();

        let is_supported = matches!(
            extension.as_str(),
            "cube" | "3dl" | "png" | "jpg" | "jpeg" | "tiff"
        );

        if is_supported {
            let name = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("LUT")
                .to_string();

            entries.push(LutEntry {
                name,
                path: strip_verbatim(&path).to_string_lossy().into_owned(),
                is_built_in,
            });
        }
    }
    entries.sort_by_key(|a| a.name.to_lowercase());
    Ok(entries)
}

fn unique_lut_destination(dir: &Path, stem: &str, extension: &str) -> PathBuf {
    let mut candidate = dir.join(format!("{}.{}", stem, extension));
    let mut suffix = 1;
    while candidate.exists() && suffix < 1000 {
        candidate = dir.join(format!("{} ({}).{}", stem, suffix, extension));
        suffix += 1;
    }
    candidate
}

pub fn import_luts_to_dir(dir: &Path, source_paths: &[String]) -> anyhow::Result<Vec<LutEntry>> {
    for source in source_paths {
        if let Err(error) = parse_lut_file(source) {
            log::warn!("Skipping invalid LUT '{}': {}", source, error);
            continue;
        }

        #[cfg(target_os = "android")]
        if is_android_content_uri(source) {
            if let Err(error) = import_android_lut(source) {
                log::error!("Failed to import LUT from '{}': {}", source, error);
            }
            continue;
        }

        let source_path = Path::new(source);
        let stem = source_path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("LUT");
        let extension = source_path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("cube")
            .to_lowercase();
        let destination = unique_lut_destination(dir, stem, &extension);
        if let Err(error) = copy(source_path, &destination) {
            log::error!("Failed to copy LUT '{}': {}", source, error);
        }
    }
    list_luts_in_dir(dir, false)
}

#[cfg(target_os = "android")]
fn import_android_lut(source: &str) -> anyhow::Result<()> {
    let resolved_name = resolve_android_content_uri_name(source)
        .map_err(|e| anyhow!("Failed to resolve content URI: {}", e))?;
    let stem = Path::new(&resolved_name)
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("LUT")
        .to_string();
    let extension = Path::new(&resolved_name)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("cube")
        .to_lowercase();
    let bytes = read_android_content_uri(source)
        .map_err(|e| anyhow!("Failed to read content URI: {}", e))?;

    let cache_path = get_android_cached_lut_path(source, &extension)?;
    let cache_dir = cache_path
        .parent()
        .ok_or_else(|| anyhow!("Invalid cache path"))?
        .to_path_buf();
    let destination = unique_lut_destination(&cache_dir, &stem, &extension);
    std::fs::write(&destination, &bytes)?;
    Ok(())
}

fn parse_cube(reader: impl BufRead) -> anyhow::Result<Lut> {
    let mut size: Option<u32> = None;
    let mut data: Vec<f32> = Vec::new();
    let mut line_num = 0;

    for line in reader.lines() {
        line_num += 1;
        let line = line?;
        let trimmed = line.trim();

        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }

        let parts: Vec<&str> = trimmed.split_whitespace().collect();
        if parts.is_empty() {
            continue;
        }

        match parts[0].to_uppercase().as_str() {
            "TITLE" | "DOMAIN_MIN" | "DOMAIN_MAX" => continue,

            "LUT_3D_SIZE" => {
                if parts.len() < 2 {
                    return Err(anyhow!(
                        "Malformed LUT_3D_SIZE on line {}: '{}'",
                        line_num,
                        line
                    ));
                }
                size = Some(parts[1].parse().map_err(|e| {
                    anyhow!(
                        "Failed to parse LUT_3D_SIZE on line {}: '{}'. Error: {}",
                        line_num,
                        line,
                        e
                    )
                })?);
            }
            _ => {
                if size.is_some() {
                    if parts.len() < 3 {
                        return Err(anyhow!(
                            "Invalid data line on line {}: '{}'. Expected 3 float values, found {}",
                            line_num,
                            line,
                            parts.len()
                        ));
                    }
                    let r: f32 = parts[0].parse().map_err(|e| {
                        anyhow!(
                            "Failed to parse R value on line {}: '{}'. Error: {}",
                            line_num,
                            line,
                            e
                        )
                    })?;
                    let g: f32 = parts[1].parse().map_err(|e| {
                        anyhow!(
                            "Failed to parse G value on line {}: '{}'. Error: {}",
                            line_num,
                            line,
                            e
                        )
                    })?;
                    let b: f32 = parts[2].parse().map_err(|e| {
                        anyhow!(
                            "Failed to parse B value on line {}: '{}'. Error: {}",
                            line_num,
                            line,
                            e
                        )
                    })?;
                    data.push(r);
                    data.push(g);
                    data.push(b);
                }
            }
        }
    }

    let lut_size = size.ok_or(anyhow!("LUT_3D_SIZE not found in .cube file"))?;
    let expected_len = (lut_size * lut_size * lut_size * 3) as usize;
    if data.len() != expected_len {
        return Err(anyhow!(
            "LUT data size mismatch. Expected {} float values (for size {}), but found {}. The file may be corrupt or incomplete.",
            expected_len,
            lut_size,
            data.len()
        ));
    }

    Ok(Lut {
        size: lut_size,
        data,
    })
}

fn parse_3dl(reader: impl BufRead) -> anyhow::Result<Lut> {
    let mut data: Vec<f32> = Vec::new();

    for line in reader.lines() {
        let line = line?;
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('#') {
            continue;
        }
        let parts: Vec<&str> = trimmed.split_whitespace().collect();
        if parts.len() == 3 {
            let r: f32 = parts[0].parse()?;
            let g: f32 = parts[1].parse()?;
            let b: f32 = parts[2].parse()?;
            data.push(r);
            data.push(g);
            data.push(b);
        }
    }

    let total_values = data.len();
    if total_values == 0 {
        return Err(anyhow!("No data found in 3DL file"));
    }
    let num_entries = total_values / 3;
    let size = (num_entries as f64).cbrt().round() as u32;

    if size * size * size != num_entries as u32 {
        return Err(anyhow!(
            "Invalid 3DL LUT data size: the number of entries ({}) is not a perfect cube.",
            num_entries
        ));
    }

    Ok(Lut { size, data })
}

fn parse_hald(image: DynamicImage) -> anyhow::Result<Lut> {
    let (width, height) = image.dimensions();
    if width != height {
        return Err(anyhow!(
            "HALD image must be square, but dimensions are {}x{}",
            width,
            height
        ));
    }

    let total_pixels = width * height;
    let size = (total_pixels as f64).cbrt().round() as u32;

    if size * size * size != total_pixels {
        return Err(anyhow!(
            "Invalid HALD image dimensions: total pixels ({}) is not a perfect cube.",
            total_pixels
        ));
    }

    let mut data = Vec::with_capacity((total_pixels * 3) as usize);
    let rgb_image = image.to_rgb8();

    for pixel in rgb_image.pixels() {
        data.push(pixel[0] as f32 / 255.0);
        data.push(pixel[1] as f32 / 255.0);
        data.push(pixel[2] as f32 / 255.0);
    }

    Ok(Lut { size, data })
}

pub fn parse_lut_file(path_str: &str) -> anyhow::Result<Lut> {
    let normalized_path_str = path_str.strip_prefix(r"\\?\").unwrap_or(path_str);

    if normalized_path_str.starts_with(r"\\") || normalized_path_str.starts_with("//") {
        return Err(anyhow!("Network paths (UNC) are not allowed for LUTs"));
    }

    if path_str.contains("..") {
        return Err(anyhow!("Directory traversal (..) is not allowed"));
    }

    let path = std::path::Path::new(path_str);
    if let Some(std::path::Component::Prefix(prefix)) = path.components().next() {
        match prefix.kind() {
            std::path::Prefix::UNC(_, _)
            | std::path::Prefix::VerbatimUNC(_, _)
            | std::path::Prefix::DeviceNS(_) => {
                return Err(anyhow!("Device/UNC prefix paths are not allowed"));
            }
            _ => {}
        }
    }

    let (extension, bytes): (String, Option<Vec<u8>>) =
        if let Some(embedded) = builtin_lut_bytes(normalized_path_str) {
            // 内嵌虚拟路径（builtin://film_luts/...、builtin://master_recipe_luts/...）：
            // 直接从编译期内嵌资源读取，不触达文件系统
            let ext = Path::new(normalized_path_str)
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_lowercase();
            (ext, Some(embedded.to_vec()))
        } else if cfg!(target_os = "android") && is_android_content_uri(path_str) {
            #[cfg(target_os = "android")]
            {
                let resolved_name = resolve_android_content_uri_name(path_str)
                    .unwrap_or_else(|_| path_str.to_string());
                let ext = Path::new(&resolved_name)
                    .extension()
                    .and_then(|s| s.to_str())
                    .unwrap_or("cube")
                    .to_lowercase();
                let uri_bytes = read_android_content_uri(path_str).map_err(|e| anyhow!("{}", e))?;
                (ext, Some(uri_bytes))
            }
            #[cfg(not(target_os = "android"))]
            {
                (String::new(), None)
            }
        } else {
            let ext = Path::new(path_str)
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_lowercase();
            (ext, None)
        };

    match extension.as_str() {
        "cube" => {
            if let Some(b) = bytes {
                parse_cube(BufReader::new(Cursor::new(b)))
            } else {
                let file = File::open(path_str)?;
                parse_cube(BufReader::new(file))
            }
        }
        "3dl" => {
            if let Some(b) = bytes {
                parse_3dl(BufReader::new(Cursor::new(b)))
            } else {
                let file = File::open(path_str)?;
                parse_3dl(BufReader::new(file))
            }
        }
        "png" | "jpg" | "jpeg" | "tiff" => {
            let img = if let Some(b) = bytes {
                image::load_from_memory(&b)?
            } else {
                image::open(path_str)?
            };
            parse_hald(img)
        }
        _ => Err(anyhow!("Unsupported LUT file format: {}", extension)),
    }
}

pub fn generate_identity_lut_image(size: u32) -> DynamicImage {
    let width = size;
    let height = size * size;
    let mut img = Rgb32FImage::new(width, height);

    for z in 0..size {
        for y in 0..size {
            for x in 0..size {
                let r = x as f32 / (size - 1) as f32;
                let g = y as f32 / (size - 1) as f32;
                let b = z as f32 / (size - 1) as f32;

                img.put_pixel(x, z * size + y, Rgb([r, g, b]));
            }
        }
    }

    DynamicImage::ImageRgb32F(img)
}

pub fn convert_image_to_cube_lut(image: &DynamicImage, size: u32) -> Result<Vec<u8>, String> {
    let f32_image = image.to_rgb32f();
    let mut out = String::new();

    out.push_str(&format!("LUT_3D_SIZE {}\n", size));
    out.push_str("DOMAIN_MIN 0.0 0.0 0.0\n");
    out.push_str("DOMAIN_MAX 1.0 1.0 1.0\n");

    for z in 0..size {
        for y in 0..size {
            for x in 0..size {
                let pixel = f32_image.get_pixel(x, z * size + y);
                out.push_str(&format!(
                    "{:.6} {:.6} {:.6}\n",
                    pixel[0].clamp(0.0, 1.0),
                    pixel[1].clamp(0.0, 1.0),
                    pixel[2].clamp(0.0, 1.0)
                ));
            }
        }
    }

    Ok(out.into_bytes())
}

pub fn get_or_load_lut(state: &State<AppState>, path: &str) -> Result<Arc<Lut>, String> {
    let mut cache = state.lut_cache.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(lut) = cache.get(path) {
        return Ok(lut.clone());
    }

    // 路径自愈：跨会话安装位置变化（如 AppImage 挂载点每次启动都不同）会让旧会话
    // 持久化的配方 LUT 绝对路径失效，渲染/导出/预览等所有消费链路都会静默丢 LUT。
    // 失效路径的文件名若命中内置大师配方资源目录中的同名文件，回退到当前安装位置，
    // 与前端 Basic.tsx 的运行时自愈等价（此处覆盖不经前端面板的批量导出等链路）。
    // 内嵌虚拟路径（builtin://）本身稳定存在，直接短路，无需自愈。
    let resolved = if is_builtin_lut_path(path) {
        path.to_string()
    } else if !std::path::Path::new(path).exists() {
        std::path::Path::new(path)
            .file_name()
            .and_then(|n| n.to_str())
            .and_then(|name| {
                state
                    .recipe_luts_dir
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .as_ref()
                    .map(|dir| dir.join(name))
            })
            .filter(|candidate| candidate.exists())
            .map(|candidate| candidate.to_string_lossy().to_string())
            .unwrap_or_else(|| path.to_string())
    } else {
        path.to_string()
    };

    if resolved != path
        && let Some(lut) = cache.get(&resolved).cloned()
    {
        cache.insert(path.to_string(), lut.clone());
        return Ok(lut);
    }

    let lut = parse_lut_file(&resolved).map_err(|e| e.to_string())?;
    let arc_lut = Arc::new(lut);
    cache.insert(resolved.clone(), arc_lut.clone());
    if resolved != path {
        // 以旧路径为别名再缓存一份，避免每次调用都重复 exists() 探测
        cache.insert(path.to_string(), arc_lut.clone());
    }
    Ok(arc_lut)
}

#[tauri::command]
pub fn list_luts(app_handle: AppHandle) -> Result<Vec<LutEntry>, String> {
    let mut all_luts = Vec::new();

    // 内置胶片模拟：编译期内嵌资源（Android APK assets 无法用 std::fs 枚举，
    // 资源目录路径在 AppImage 下也会漂移；内嵌列表全平台一致且不可被用户删除）
    all_luts.extend(list_luts_in_embedded(&EMBEDDED_FILM_LUTS, "film_luts"));

    let data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let luts_dir = get_luts_dir(&data_dir).map_err(|e| e.to_string())?;

    #[cfg(target_os = "android")]
    {
        if let Ok(user_luts) = list_luts_in_dir(&luts_dir, false) {
            all_luts.extend(user_luts);
        }
        if let Ok(cached) = list_luts_in_cache() {
            all_luts.extend(cached);
        }
    }
    #[cfg(not(target_os = "android"))]
    {
        if let Ok(user_luts) = list_luts_in_dir(&luts_dir, false) {
            all_luts.extend(user_luts);
        }
    }

    Ok(all_luts)
}

#[cfg(target_os = "android")]
fn get_lut_cache_dir() -> anyhow::Result<PathBuf> {
    let cache_path = get_android_cached_lut_path("_", "tmp")?;
    cache_path
        .parent()
        .ok_or_else(|| anyhow!("Invalid cache path"))
        .map(|p| p.to_path_buf())
}

#[cfg(target_os = "android")]
fn list_luts_in_cache() -> anyhow::Result<Vec<LutEntry>> {
    let cache_dir = get_lut_cache_dir()?;

    if !cache_dir.exists() {
        return Ok(Vec::new());
    }

    let mut entries: Vec<LutEntry> = Vec::new();
    for entry in read_dir(&cache_dir)? {
        let path = entry?.path();
        let extension = path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_lowercase();

        let is_supported = matches!(
            extension.as_str(),
            "cube" | "3dl" | "png" | "jpg" | "jpeg" | "tiff"
        );

        if is_supported {
            let name = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("LUT")
                .to_string();
            entries.push(LutEntry {
                name,
                path: strip_verbatim(&path).to_string_lossy().into_owned(),
                is_built_in: false,
            });
        }
    }
    entries.sort_by_key(|a| a.name.to_lowercase());
    Ok(entries)
}

#[tauri::command]
pub fn list_recipe_luts(_app_handle: AppHandle) -> Result<Vec<LutEntry>, String> {
    // 大师配方内置外观（display-referred LUT），仅供场景增强面板按配方定位文件路径；
    // 不进入 list_luts 的胶片模拟网格，也不允许被用户删除。
    // 编译期内嵌列举：Android APK assets 无法用 std::fs 枚举，fs 版在 Android 恒为空
    Ok(list_luts_in_embedded(
        &EMBEDDED_RECIPE_LUTS,
        "master_recipe_luts",
    ))
}

#[tauri::command]
pub fn import_luts(
    app_handle: AppHandle,
    source_paths: Vec<String>,
) -> Result<Vec<LutEntry>, String> {
    let data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let luts_dir = get_luts_dir(&data_dir).map_err(|e| e.to_string())?;
    import_luts_to_dir(&luts_dir, &source_paths).map_err(|e| e.to_string())?;

    list_luts(app_handle)
}

#[tauri::command]
pub fn remove_lut(app_handle: AppHandle, path: String) -> Result<Vec<LutEntry>, String> {
    let data_dir = app_handle
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?;
    let luts_dir = strip_verbatim(&get_luts_dir(&data_dir).map_err(|e| e.to_string())?);
    let target_path = strip_verbatim(Path::new(&path));

    // 内嵌虚拟路径不存在于文件系统，且内置外观不允许被删除
    if is_builtin_lut_path(&path) {
        return Err("Cannot delete built-in film emulations".to_string());
    }

    if let Some(resource_path) = film_luts_dir(&app_handle)
        && target_path.starts_with(&resource_path)
    {
        return Err("Cannot delete built-in film emulations".to_string());
    }

    #[cfg(target_os = "android")]
    {
        let cache_dir = strip_verbatim(&get_lut_cache_dir().map_err(|e| e.to_string())?);
        if !target_path.starts_with(&luts_dir) && !target_path.starts_with(&cache_dir) {
            return Err(
                "Access denied: Cannot remove files outside the user LUT directory".to_string(),
            );
        }
    }
    #[cfg(not(target_os = "android"))]
    if !target_path.starts_with(&luts_dir) {
        return Err(
            "Access denied: Cannot remove files outside the user LUT directory".to_string(),
        );
    }

    if target_path.exists() {
        std::fs::remove_file(&target_path).map_err(|e| e.to_string())?;
    } else {
        return Err("LUT file not found".to_string());
    }

    list_luts(app_handle)
}

fn render_lut_swatch(
    context: &crate::image_processing::GpuContext,
    state: &State<AppState>,
    base_image: &DynamicImage,
    transform_hash: u64,
    adjustments: crate::image_processing::AllAdjustments,
    lut_path: &str,
) -> Option<String> {
    let lut = get_or_load_lut(state, lut_path).ok()?;
    let processed = process_and_get_dynamic_image(
        context,
        state,
        base_image,
        transform_hash,
        RenderRequest {
            adjustments,
            mask_bitmaps: &[],
            lut: Some(lut),
            roi: None,
        },
        "generate_lut_previews",
    )
    .ok()?;

    let rgb = processed.to_rgb8();
    let (width, height) = rgb.dimensions();
    let bytes = Encoder::new(Preset::BaselineFastest)
        .quality(80)
        .encode_rgb(&rgb.into_vec(), width, height)
        .ok()?;
    Some(format!(
        "data:image/jpeg;base64,{}",
        general_purpose::STANDARD.encode(&bytes)
    ))
}

#[tauri::command]
pub fn generate_lut_previews(
    luts: Vec<LutPreviewRequest>,
    size: u32,
    state: State<AppState>,
    app_handle: AppHandle,
) -> Result<Vec<LutPreview>, String> {
    let context = crate::image_processing::get_or_init_gpu_context(&state, &app_handle)?;
    let loaded_image = state
        .original_image
        .lock()
        .unwrap()
        .clone()
        .ok_or("No original image loaded for LUT previews")?;
    let is_raw = loaded_image.is_raw;

    let base_json = serde_json::json!({});
    let (base_image, _scale, _offset) =
        crate::generate_transformed_preview(&state, &loaded_image, &base_json, size)?;

    let tm_override = resolve_tonemapper_override_from_handle(&app_handle, is_raw);
    let transform_hash = calculate_transform_hash(&base_json);

    let previews = luts
        .into_iter()
        .map(|request| {
            let swatch_lut_json = serde_json::json!({
                "lutPath": "preview",
                "lutIntensity": 100,
                "lutIsSceneReferred": request.is_built_in,
                "sectionVisibility": { "effects": true }
            });
            let swatch_adjustments =
                get_all_adjustments_from_json(&swatch_lut_json, is_raw, tm_override);

            let thumb = render_lut_swatch(
                &context,
                &state,
                &base_image,
                transform_hash,
                swatch_adjustments,
                &request.path,
            );
            LutPreview {
                path: request.path,
                thumb,
            }
        })
        .collect();

    Ok(previews)
}

#[tauri::command]
pub fn load_and_parse_lut(path: String, state: State<AppState>) -> Result<LutParseResult, String> {
    let lut = parse_lut_file(&path).map_err(|e| e.to_string())?;
    let lut_size = lut.size;

    let mut cache = state.lut_cache.lock().unwrap_or_else(|e| e.into_inner());
    cache.insert(path, Arc::new(lut));

    Ok(LutParseResult { size: lut_size })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 生成 2³ 恒等 cube 文本（.cube 数据序：R 最快变化）
    fn identity_cube_text(size: u32) -> String {
        let mut s = format!("TITLE Identity\nLUT_3D_SIZE {}\n\n", size);
        for b in 0..size {
            for g in 0..size {
                for r in 0..size {
                    let n = (size - 1) as f32;
                    s.push_str(&format!(
                        "{:.6} {:.6} {:.6}\n",
                        r as f32 / n,
                        g as f32 / n,
                        b as f32 / n
                    ));
                }
            }
        }
        s
    }

    #[test]
    fn tc_lut_parse_cube_identity_values() {
        // 恒等 LUT：data[0]=(0,0,0) 且 R 最快变化，data[1]=(1,0,0)
        let lut = parse_cube(std::io::Cursor::new(identity_cube_text(2))).expect("parse ok");
        assert_eq!(lut.size, 2);
        assert_eq!(lut.data.len(), 8 * 3);
        assert_eq!(lut.data[0], 0.0);
        assert_eq!(lut.data[1], 0.0);
        assert_eq!(lut.data[2], 0.0);
        assert_eq!(lut.data[3], 1.0, "R fastest varying");
        assert_eq!(lut.data[4], 0.0);
        // 末点 = (1,1,1)
        let last = &lut.data[21..24];
        assert_eq!(last, [1.0, 1.0, 1.0]);
    }

    #[test]
    fn tc_lut_parse_cube_rejects_size_mismatch() {
        // 声明 2³ 但只给 4 行数据：必须报错（防止半截 LUT 进入渲染管线）
        let mut text = String::from("LUT_3D_SIZE 2\n");
        for _ in 0..4 {
            text.push_str("0.5 0.5 0.5\n");
        }
        assert!(parse_cube(std::io::Cursor::new(text)).is_err());
    }

    #[test]
    fn tc_lut_parse_cube_rejects_size_before_data() {
        // 数据行出现在 LUT_3D_SIZE 之前：必须报错
        let text = "0.5 0.5 0.5\nLUT_3D_SIZE 2\n0.5 0.5 0.5\n";
        assert!(parse_cube(std::io::Cursor::new(text)).is_err());
    }

    #[test]
    fn tc_lut_parse_cube_tolerates_comments_and_domain() {
        // 注释/TITLE/DOMAIN 行被忽略
        let text_body = identity_cube_text(2);
        let data_lines = text_body.splitn(3, '\n').last().unwrap().to_string();
        let text =
            "# comment\nTITLE t\nDOMAIN_MIN 0.0 0.0 0.0\nDOMAIN_MAX 1.0 1.0 1.0\nLUT_3D_SIZE 2\n"
                .to_string()
                + &data_lines;
        let lut = parse_cube(std::io::Cursor::new(text)).expect("parse ok");
        assert_eq!(lut.size, 2);
    }

    #[test]
    fn tc_lut_identity_image_roundtrip() {
        // generate_identity_lut_image → convert_image_to_cube_lut 应产出恒等映射
        let img = generate_identity_lut_image(4);
        let bytes = convert_image_to_cube_lut(&img, 4).expect("convert ok");
        let text = String::from_utf8(bytes).expect("utf8");
        let lut = parse_cube(std::io::Cursor::new(text)).expect("parse ok");
        assert_eq!(lut.size, 4);
        assert_eq!(lut.data.len(), 64 * 3);
        // 抽查角落：首条目 = (0,0,0)；(b=3,g=3,r=0) 条目 = (0,1,1)；末条目 = (1,1,1)
        assert_eq!(lut.data[0], 0.0);
        assert_eq!(lut.data[1], 0.0);
        let idx = |r: u32, g: u32, b: u32| ((b * 16 + g * 4 + r) * 3) as usize;
        let bg_corner = idx(0, 3, 3);
        assert!((lut.data[bg_corner] - 0.0).abs() < 1e-5);
        assert!(
            (lut.data[bg_corner + 1] - 1.0).abs() < 1e-5,
            "G=1 at g_idx=3"
        );
        assert!(
            (lut.data[bg_corner + 2] - 1.0).abs() < 1e-5,
            "B=1 at b_idx=3"
        );
        assert!((lut.data[63 * 3] - 1.0).abs() < 1e-5, "last entry R");
    }

    #[test]
    fn tc_lut_builtin_lists_all_recipes_and_films() {
        // 内嵌列举：14 个大师配方 + 6 枚内置胶片（license txt 不进入列表）
        let recipes = list_luts_in_embedded(&EMBEDDED_RECIPE_LUTS, "master_recipe_luts");
        assert_eq!(recipes.len(), 14);
        for entry in &recipes {
            assert!(entry.is_built_in);
            assert!(entry.path.starts_with(BUILTIN_LUT_PREFIX));
            assert!(!entry.name.is_empty());
        }
        let films = list_luts_in_embedded(&EMBEDDED_FILM_LUTS, "film_luts");
        assert_eq!(films.len(), 6);
        assert!(films.iter().all(|e| e.path.ends_with(".cube")));
        // 列表按名排序（大小写不敏感），与 fs 版 list_luts_in_dir 语义一致
        let names = films
            .iter()
            .map(|e| e.name.to_lowercase())
            .collect::<Vec<_>>();
        let mut sorted = names.clone();
        sorted.sort();
        assert_eq!(names, sorted);
    }

    #[test]
    fn tc_lut_builtin_parse_roundtrip() {
        // 内嵌虚拟路径可直接解析（渲染/导出/预热全链路共用 parse_lut_file）
        let recipe_path = format!(
            "{}master_recipe_luts/hamada_daylight_pro_v2.cube",
            BUILTIN_LUT_PREFIX
        );
        assert!(is_builtin_lut_path(&recipe_path));
        let lut = parse_lut_file(&recipe_path).expect("embedded recipe lut parses");
        assert!(lut.size >= 2);
        assert_eq!(
            lut.data.len(),
            (lut.size * lut.size * lut.size * 3) as usize
        );

        let film_path = format!("{}film_luts/K-Portra 400.cube", BUILTIN_LUT_PREFIX);
        let film_lut = parse_lut_file(&film_path).expect("embedded film lut parses");
        assert_eq!(
            film_lut.data.len(),
            (film_lut.size * film_lut.size * film_lut.size * 3) as usize
        );
    }

    #[test]
    fn tc_lut_builtin_scheme_guard() {
        // 非内嵌路径不误判
        assert!(!is_builtin_lut_path("/usr/share/luts/x.cube"));
        assert!(!is_builtin_lut_path("C:\\luts\\x.cube"));
        // 白名单目录之外 / 空文件名 / 目录遍历一律不命中
        assert!(builtin_lut_bytes("builtin://unknown_dir/x.cube").is_none());
        assert!(builtin_lut_bytes("builtin://film_luts/").is_none());
        assert!(builtin_lut_bytes("builtin://film_luts/../master_recipe_luts/x.cube").is_none());
        assert!(builtin_lut_bytes("builtin://master_recipe_luts/../../../etc/passwd").is_none());
        // 内嵌中不存在的文件名：解析报错（回退 fs 分支 File::open 失败）
        assert!(
            parse_lut_file(&format!(
                "{}master_recipe_luts/not_exist.cube",
                BUILTIN_LUT_PREFIX
            ))
            .is_err()
        );
    }
}
