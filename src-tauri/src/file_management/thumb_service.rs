//! W5-E2 自 file_management.rs 四拆（此域：缩略图服务域：缩略图生成/缓存/进度/worker 池。）。
//! 原文件共享管线经 mod.rs 重导出，路径与拆分前完全一致。

use std::borrow::Cow;
use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::Ordering;
use anyhow::Result;
use image::codecs::jpeg::JpegEncoder;
use image::{DynamicImage, GenericImageView, ImageBuffer, Luma};
use tauri::{AppHandle, Emitter, Manager};
use crate::AppState;
use crate::app_settings::*;
use crate::exif_processing;
use crate::formats::is_raw_file;
use crate::gpu_processing;
use crate::image_loader;
use crate::image_processing::GpuContext;
use crate::image_processing::{Crop, ImageMetadata, apply_coarse_rotation, apply_crop, apply_flip, apply_geometry_warp, apply_rotation, get_all_adjustments_from_json};
use crate::mask_generation::MaskDefinition;

use super::*;


pub(crate) fn resolve_thumbnail_cache_dir(app_handle: &AppHandle) -> std::result::Result<PathBuf, String> {
    let cache_dir = app_handle
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?;
    let thumb_cache_dir = cache_dir.join("thumbnails");
    if !thumb_cache_dir.exists() {
        fs::create_dir_all(&thumb_cache_dir).map_err(|e| e.to_string())?;
    }
    Ok(thumb_cache_dir)
}

pub(crate) fn emit_thumbnail_cache_setup_error(app_handle: &AppHandle, path: &str, reason: &str) {
    let _ = app_handle.emit(
        "thumbnail-generation-error",
        serde_json::json!({ "path": path, "reason": reason }),
    );
}

fn compute_thumbnail_cache_hash(path_str: &str, adjustments_bytes: &[u8]) -> Option<String> {
    let (source_path, _) = parse_virtual_path(path_str);

    let img_mod_time = fs::metadata(&source_path)
        .ok()?
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();

    let mut hasher = blake3::Hasher::new();
    hasher.update(path_str.as_bytes());
    hasher.update(&img_mod_time.to_le_bytes());
    hasher.update(adjustments_bytes);
    Some(hasher.finalize().to_hex().to_string())
}


fn find_embedded_jpeg(exif: &exif::Exif, ifd: exif::In) -> Option<&[u8]> {
    let offset = exif
        .get_field(exif::Tag::JPEGInterchangeFormat, ifd)?
        .value
        .get_uint(0)? as usize;
    let len = exif
        .get_field(exif::Tag::JPEGInterchangeFormatLength, ifd)?
        .value
        .get_uint(0)? as usize;
    exif.buf().get(offset..offset + len)
}

fn apply_exif_orientation(img: DynamicImage, orientation: u32) -> DynamicImage {
    match orientation {
        2 => img.fliph(),
        3 => img.rotate180(),
        4 => img.flipv(),
        5 => img.rotate90().fliph(),
        6 => img.rotate90(),
        7 => img.rotate270().fliph(),
        8 => img.rotate270(),
        _ => img,
    }
}

fn try_load_embedded_raw_preview(source_path: &Path, target_res: u32) -> Option<DynamicImage> {
    let mmap = read_file_mapped(source_path).ok()?;
    let exif = exif_processing::read_exif(&mmap)?;

    let (jpeg_bytes, ifd) = find_embedded_jpeg(&exif, exif::In::PRIMARY)
        .map(|b| (b, exif::In::PRIMARY))
        .or_else(|| {
            find_embedded_jpeg(&exif, exif::In::THUMBNAIL).map(|b| (b, exif::In::THUMBNAIL))
        })?;

    let img = image::load_from_memory_with_format(jpeg_bytes, image::ImageFormat::Jpeg).ok()?;

    if img.width().max(img.height()) < (target_res as f32 * 0.95) as u32 {
        return None;
    }

    let orientation = exif
        .get_field(exif::Tag::Orientation, ifd)
        .and_then(|f| f.value.get_uint(0))
        .unwrap_or(1);

    Some(apply_exif_orientation(img, orientation))
}

pub fn generate_thumbnail_data(
    path_str: &str,
    gpu_context: Option<&GpuContext>,
    preloaded_image: Option<&DynamicImage>,
    app_handle: &AppHandle,
) -> anyhow::Result<DynamicImage> {
    let (source_path, sidecar_path) = parse_virtual_path(path_str);
    let source_path_str = source_path.to_string_lossy().to_string();
    let is_raw = is_raw_file(&source_path_str);

    let metadata: Option<ImageMetadata> = if is_cloud_placeholder(&sidecar_path) {
        enqueue_metadata(
            app_handle,
            path_str.to_string(),
            source_path.clone(),
            sidecar_path.clone(),
        );
        None
    } else {
        fs::read_to_string(&sidecar_path)
            .ok()
            .and_then(|content| serde_json::from_str(&content).ok())
    };

    let adjustments = metadata
        .as_ref()
        .map_or(serde_json::Value::Null, |m| m.adjustments.clone());

    let settings = load_settings(app_handle.clone()).unwrap_or_default();
    let always_decode_raw = settings.always_decode_raw_thumbnails.unwrap_or(false);

    if is_raw
        && adjustments.is_null()
        && preloaded_image.is_none()
        && !always_decode_raw
        && gpu_context.is_none()
    {
        let target_res = settings.medium_thumbnail_resolution.unwrap_or(1280);
        if let Some(preview) = try_load_embedded_raw_preview(&source_path, target_res) {
            return Ok(preview);
        }
    }

    // W3-C1 AR-2：缩略图展示路径全 GPU 化 —— GPU 上下文（含 lavapipe 软件回退）
    // 可用时，无论是否编辑一律走 GPU 管线：未编辑/无 metadata 的 RAW 观感统一至
    // GPU mode0（与主视图一致），不在此处做 CPU 展示算子近似。
    if let Some(context) = gpu_context {
        let state = app_handle.state::<AppState>();
        let target_res = settings.medium_thumbnail_resolution.unwrap_or(1280);

        let base_cache_hash = crate::cache_utils::calculate_thumbnail_base_hash(&adjustments);

        let crop_data: Option<Crop> = serde_json::from_value(adjustments["crop"].clone()).ok();

        let cached_base: Option<(Arc<DynamicImage>, f32)> = {
            let cache = state
                .thumbnail_geometry_cache
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if let Some((cached_hash, img, scale)) = cache.get(path_str) {
                let mut sufficient_resolution = true;
                if let Some(c) = &crop_data
                    && c.width > 0.0
                    && c.height > 0.0
                {
                    let final_crop_max_dim =
                        (c.width as f32 * *scale).max(c.height as f32 * *scale);
                    if final_crop_max_dim < (target_res as f32 * 0.95) {
                        sufficient_resolution = false;
                    }
                }

                if *cached_hash == base_cache_hash && sufficient_resolution {
                    Some((Arc::clone(img), *scale))
                } else {
                    None
                }
            } else {
                None
            }
        };

        let (processing_base_arc, total_scale) = if let Some((arc_img, scale)) = cached_base {
            (arc_img, scale)
        } else {
            let mut raw_scale_factor = 1.0f32;

            let composite_image = if let Some(img) = preloaded_image {
                image_loader::composite_patches_on_image(img, &adjustments)?
            } else {
                let mmap_guard;
                let vec_guard;

                let file_slice: &[u8] = match read_file_mapped(&source_path) {
                    Ok(mmap) => {
                        mmap_guard = Some(mmap);
                        mmap_guard.as_ref().unwrap()
                    }
                    Err(e) => {
                        if preloaded_image.is_none() {
                            log::warn!("Fallback read for {}: {}", source_path_str, e);
                        }
                        let bytes = fs::read(&source_path).map_err(|io_err| {
                            anyhow::anyhow!(
                                "Fallback read failed for {}: {}",
                                source_path_str,
                                io_err
                            )
                        })?;
                        vec_guard = Some(bytes);
                        vec_guard.as_ref().unwrap()
                    }
                };

                let img = image_loader::load_and_composite(
                    file_slice,
                    &source_path_str,
                    &adjustments,
                    true,
                    &settings,
                    None,
                )?;

                if is_raw {
                    raw_scale_factor = crate::raw_processing::get_fast_demosaic_scale_factor(
                        file_slice,
                        img.width(),
                        img.height(),
                    );
                }
                img
            };

            let warped_image =
                apply_geometry_warp(Cow::Borrowed(&composite_image), &adjustments);

            let blurred_image = crate::lens_blur::apply_lens_blur(warped_image, &adjustments);

            let orientation_steps =
                adjustments["orientationSteps"].as_u64().unwrap_or(0) as u8;
            let coarse_rotated_image = apply_coarse_rotation(blurred_image, orientation_steps);

            let (full_w, full_h) = coarse_rotated_image.dimensions();

            let mut processing_dim = target_res;
            if let Some(c) = &crop_data
                && c.width > 0.0
                && c.height > 0.0
            {
                let crop_max_dim_loaded = c.width.max(c.height) * raw_scale_factor as f64;
                let full_max_dim = full_w.max(full_h) as f64;
                if crop_max_dim_loaded > 0.0 {
                    processing_dim = ((target_res as f64 * full_max_dim / crop_max_dim_loaded)
                        .round() as u32)
                        .min(full_w.max(full_h));
                }
            }

            let (base, gpu_scale) = if full_w > processing_dim || full_h > processing_dim {
                let base = crate::image_processing::downscale_f32_image(
                    &coarse_rotated_image,
                    processing_dim,
                    processing_dim,
                );
                let scale = if full_w > 0 {
                    base.width() as f32 / full_w as f32
                } else {
                    1.0
                };
                (base, scale)
            } else {
                (coarse_rotated_image.into_owned(), 1.0)
            };

            let total_scale = gpu_scale * raw_scale_factor;

            let mut cache = state
                .thumbnail_geometry_cache
                .lock()
                .unwrap_or_else(|e| e.into_inner());
            if cache.len() >= 8 {
                let key_to_remove = cache.keys().next().cloned();
                if let Some(key) = key_to_remove {
                    cache.remove(&key);
                }
            }

            let base_arc = Arc::new(base);
            cache.insert(
                path_str.to_string(),
                (base_cache_hash, Arc::clone(&base_arc), total_scale),
            );

            (base_arc, total_scale)
        };

        let rotation_degrees = adjustments["rotation"].as_f64().unwrap_or(0.0) as f32;
        let flip_horizontal = adjustments["flipHorizontal"]
            .as_bool()
            .unwrap_or(false);
        let flip_vertical = adjustments["flipVertical"].as_bool().unwrap_or(false);

        let flipped_image = apply_flip(
            Cow::Borrowed(&*processing_base_arc),
            flip_horizontal,
            flip_vertical,
        );
        let rotated_image = apply_rotation(flipped_image, rotation_degrees);

        let scaled_crop_json = if let Some(c) = &crop_data {
            serde_json::to_value(Crop {
                x: c.x * total_scale as f64,
                y: c.y * total_scale as f64,
                width: c.width * total_scale as f64,
                height: c.height * total_scale as f64,
            })
            .unwrap_or(serde_json::Value::Null)
        } else {
            serde_json::Value::Null
        };

        let cropped_preview = apply_crop(rotated_image, &scaled_crop_json);
        let (preview_w, preview_h) = cropped_preview.dimensions();
        let unscaled_crop_offset = crop_data.map_or((0.0, 0.0), |c| (c.x as f32, c.y as f32));

        let mask_definitions: Vec<MaskDefinition> = adjustments
            .get("masks")
            .and_then(|m| serde_json::from_value(m.clone()).ok())
            .unwrap_or_else(Vec::new);

        let mask_bitmaps: Vec<ImageBuffer<Luma<u8>, Vec<u8>>> = mask_definitions
            .iter()
            .filter_map(|def| {
                crate::mask_generation::get_cached_or_generate_mask(
                    &state,
                    def,
                    preview_w,
                    preview_h,
                    total_scale,
                    (
                        unscaled_crop_offset.0 * total_scale,
                        unscaled_crop_offset.1 * total_scale,
                    ),
                    &adjustments,
                )
            })
            .collect();

        let tm_override = crate::image_processing::resolve_tonemapper_override(&settings, is_raw);
        let gpu_adjustments = get_all_adjustments_from_json(&adjustments, is_raw, tm_override);
        let lut_path = adjustments["lutPath"].as_str();
        let lut = lut_path.and_then(|p| {
            let mut cache = state.lut_cache.lock().unwrap_or_else(|e| e.into_inner());
            if let Some(cached_lut) = cache.get(p) {
                return Some(cached_lut.clone());
            }
            if let Ok(loaded_lut) = crate::lut_processing::parse_lut_file(p) {
                let arc_lut = Arc::new(loaded_lut);
                cache.insert(p.to_string(), arc_lut.clone());
                return Some(arc_lut);
            }
            None
        });

        let mut hasher = DefaultHasher::new();
        path_str.hash(&mut hasher);
        adjustments.to_string().hash(&mut hasher);
        let unique_hash = hasher.finish();

        if let Ok(processed_image) = gpu_processing::process_and_get_dynamic_image(
            context,
            &state,
            cropped_preview.as_ref(),
            unique_hash,
            gpu_processing::RenderRequest {
                adjustments: gpu_adjustments,
                mask_bitmaps: &mask_bitmaps,
                lut,
                roi: None,
            },
            "generate_thumbnail_data",
        ) {
            return Ok(processed_image);
        } else {
            return Ok(cropped_preview.into_owned());
        }
    }

    // AR-2：无 GPU 上下文时的兜底路径 —— 后端选择策略（vulkan → lavapipe → GL）
    // 保证 GPU 上下文几乎恒存在，此处仅返回几何处理的降级缩略图；
    // CPU 展示算子（AGX tonemap / 默认 RAW 处理）已随引擎单实现退役。
    let final_image = if let Some(img) = preloaded_image {
        image_loader::composite_patches_on_image(img, &adjustments)?
    } else {
        match read_file_mapped(&source_path) {
            Ok(mmap) => image_loader::load_and_composite(
                &mmap,
                &source_path_str,
                &adjustments,
                true,
                &settings,
                None,
            )?,
            Err(e) => {
                log::warn!("Fallback read for {}: {}", source_path_str, e);
                let bytes = fs::read(&source_path)?;
                image_loader::load_and_composite(
                    &bytes,
                    &source_path_str,
                    &adjustments,
                    true,
                    &settings,
                    None,
                )?
            }
        }
    };

    let fallback_orientation_steps = adjustments["orientationSteps"].as_u64().unwrap_or(0) as u8;
    Ok(apply_coarse_rotation(Cow::Owned(final_image), fallback_orientation_steps).into_owned())
}

fn encode_thumbnail(image: &DynamicImage, target_width: u32) -> Result<Vec<u8>> {
    let thumbnail = crate::image_processing::downscale_f32_image(image, target_width, target_width);
    let mut buf = Cursor::new(Vec::new());
    let mut encoder = JpegEncoder::new_with_quality(&mut buf, 75);
    encoder.encode_image(&thumbnail.to_rgb8())?;
    Ok(buf.into_inner())
}

pub(crate) fn generate_single_thumbnail_and_cache(
    path_str: &str,
    thumb_cache_dir: &Path,
    gpu_context: Option<&GpuContext>,
    preloaded_image: Option<&DynamicImage>,
    force_regenerate: bool,
    app_handle: &AppHandle,
    settings: &AppSettings,
) -> Option<(String, String, u8, bool)> {
    let (source_path, sidecar_path) = parse_virtual_path(path_str);

    let (rating, is_edited, adjustments_bytes) = if is_cloud_placeholder(&sidecar_path) {
        enqueue_metadata(
            app_handle,
            path_str.to_string(),
            source_path.clone(),
            sidecar_path.clone(),
        );
        (0, false, Vec::new())
    } else if let Ok(content) = fs::read_to_string(&sidecar_path) {
        if let Ok(meta) = serde_json::from_str::<ImageMetadata>(&content) {
            let is_raw = crate::formats::is_raw_file(path_str);
            let tm = crate::image_processing::resolve_tonemapper_override(settings, is_raw);
            (
                meta.rating,
                crate::image_processing::is_image_edited(&meta.adjustments, is_raw, tm),
                serde_json::to_vec(&meta.adjustments).unwrap_or_default(),
            )
        } else {
            (0, false, Vec::new())
        }
    } else {
        (0, false, Vec::new())
    };

    let cache_hash = compute_thumbnail_cache_hash(path_str, &adjustments_bytes)?;

    let small_path = thumb_cache_dir.join(format!("{}_small.jpg", cache_hash));
    let medium_path = thumb_cache_dir.join(format!("{}_medium.jpg", cache_hash));

    if !force_regenerate && small_path.exists() && medium_path.exists() {
        return Some((
            small_path.to_string_lossy().into_owned(),
            medium_path.to_string_lossy().into_owned(),
            rating,
            is_edited,
        ));
    }

    if is_cloud_placeholder(&source_path) {
        return None;
    }

    let target_width_small = settings.small_thumbnail_resolution.unwrap_or(480);
    let target_width_medium = settings.medium_thumbnail_resolution.unwrap_or(1280);

    if let Ok(thumb_image) =
        generate_thumbnail_data(path_str, gpu_context, preloaded_image, app_handle)
        && let (Ok(small_data), Ok(medium_data)) = (
            encode_thumbnail(&thumb_image, target_width_small),
            encode_thumbnail(&thumb_image, target_width_medium),
        )
    {
        let _ = fs::write(&small_path, &small_data);
        let _ = fs::write(&medium_path, &medium_data);
        return Some((
            small_path.to_string_lossy().into_owned(),
            medium_path.to_string_lossy().into_owned(),
            rating,
            is_edited,
        ));
    }
    None
}

fn prefetch_source_file(path_str: &str) {
    let (source_path, _) = parse_virtual_path(path_str);
    if let Ok(mut file) = std::fs::File::open(&source_path) {
        let _ = std::io::copy(&mut file, &mut std::io::sink());
    }
}

pub fn start_thumbnail_workers(app_handle: tauri::AppHandle) {
    let state = app_handle.state::<crate::AppState>();
    let manager = state.thumbnail_manager.clone();
    let settings = load_settings(app_handle.clone()).unwrap_or_default();
    let thread_count = settings.thumbnail_worker_threads.unwrap_or(4).clamp(1, 16);

    for _ in 0..thread_count {
        let app_clone = app_handle.clone();
        let manager_clone = manager.clone();

        std::thread::spawn(move || {
            loop {
                let path_to_process: String = {
                    let mut queue = manager_clone
                        .queue
                        .lock()
                        .unwrap_or_else(|e| e.into_inner());
                    while queue.is_empty() {
                        queue = manager_clone.cvar.wait(queue).unwrap();
                    }
                    let path = queue.pop_back().unwrap();

                    let mut processing = manager_clone
                        .processing_now
                        .lock()
                        .unwrap_or_else(|e| e.into_inner());
                    if processing.contains(&path) {
                        let state = app_clone.state::<crate::AppState>();
                        increment_thumbnail_progress(&state, &app_clone);
                        continue;
                    }
                    processing.insert(path.clone());
                    path
                };

                let state = app_clone.state::<crate::AppState>();
                let gpu_context =
                    crate::gpu_processing::get_or_init_gpu_context(&state, &app_clone).ok();

                let current_settings = load_settings(app_clone.clone()).unwrap_or_default();

                if let Ok(cache_dir) = get_thumb_cache_dir(&app_clone) {
                    if manager_clone.rotational_disk.load(Ordering::Relaxed) {
                        let _io_permit = manager_clone
                            .io_gate
                            .lock()
                            .unwrap_or_else(|e| e.into_inner());
                        prefetch_source_file(&path_to_process);
                    }

                    let result = generate_single_thumbnail_and_cache(
                        &path_to_process,
                        &cache_dir,
                        gpu_context.as_ref(),
                        None,
                        false,
                        &app_clone,
                        &current_settings,
                    );

                    if let Some((small_path, medium_path, rating, is_edited)) = result {
                        emit_thumbnail_generated(
                            &app_clone,
                            &path_to_process,
                            &small_path,
                            &medium_path,
                            rating,
                            is_edited,
                        );
                    }
                    increment_thumbnail_progress(&state, &app_clone);
                }
                manager_clone
                    .processing_now
                    .lock()
                    .unwrap()
                    .remove(&path_to_process);
            }
        });
    }
}

#[tauri::command]
pub fn update_thumbnail_queue(
    paths: Vec<String>,
    app_handle: tauri::AppHandle,
) -> Result<(), String> {
    let state = app_handle.state::<crate::AppState>();

    let mut queue = state
        .thumbnail_manager
        .queue
        .lock()
        .unwrap_or_else(|e| e.into_inner());

    if paths.is_empty() {
        queue.clear();
        let mut tracker = state
            .thumbnail_progress
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        tracker.total = 0;
        tracker.completed = 0;
        drop(tracker);

        let _ = app_handle.emit(
            "thumbnail-progress",
            serde_json::json!({ "current": 0, "total": 0 }),
        );
        state.thumbnail_manager.cvar.notify_all();
        return Ok(());
    }

    let mut unique_paths = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for path in paths {
        if seen.insert(path.clone()) {
            unique_paths.push(path);
        }
    }

    queue.retain(|p| !seen.contains(p));

    while queue.len() + unique_paths.len() > 500 {
        queue.pop_front();
    }

    if state
        .thumbnail_manager
        .rotational_disk
        .load(Ordering::Relaxed)
    {
        unique_paths.sort();
        for path in unique_paths.into_iter().rev() {
            queue.push_back(path);
        }
    } else {
        for path in unique_paths {
            queue.push_back(path);
        }
    }

    let queue_len = queue.len();
    drop(queue);

    let mut tracker = state
        .thumbnail_progress
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    tracker.total = tracker.completed + queue_len;

    let current = tracker.completed;
    let total = tracker.total;
    drop(tracker);

    let _ = app_handle.emit(
        "thumbnail-progress",
        serde_json::json!({ "current": current, "total": total }),
    );

    state.thumbnail_manager.cvar.notify_all();
    Ok(())
}

pub fn add_to_thumbnail_queue(state: &AppState, count: usize, app_handle: &AppHandle) {
    let mut tracker = state
        .thumbnail_progress
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    tracker.total += count;
    let current = tracker.completed;
    let total = tracker.total;
    drop(tracker);

    let _ = app_handle.emit(
        "thumbnail-progress",
        serde_json::json!({ "current": current, "total": total }),
    );
}

pub fn increment_thumbnail_progress(state: &AppState, app_handle: &AppHandle) {
    let mut tracker = state
        .thumbnail_progress
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    tracker.completed += 1;
    let current = tracker.completed;
    let total = tracker.total;

    if current >= total {
        tracker.total = 0;
        tracker.completed = 0;
        drop(tracker);

        let _ = app_handle.emit(
            "thumbnail-progress",
            serde_json::json!({ "current": 0, "total": 0 }),
        );
        let _ = app_handle.emit("thumbnail-generation-complete", true);
    } else {
        drop(tracker);
        let _ = app_handle.emit(
            "thumbnail-progress",
            serde_json::json!({ "current": current, "total": total }),
        );
    }
}

pub fn emit_thumbnail_generated(
    app_handle: &AppHandle,
    path: &str,
    small_thumbnail_path: &str,
    medium_thumbnail_path: &str,
    rating: u8,
    is_edited: bool,
) {
    let _ = app_handle.emit(
        "thumbnail-generated",
        serde_json::json!({
            "path": path,
            "thumbnailPath": small_thumbnail_path,
            "previewPath": medium_thumbnail_path,
            "rating": rating,
            "is_edited": is_edited
        }),
    );

}

#[tauri::command]
pub fn clear_thumbnail_cache(app_handle: AppHandle) -> Result<(), String> {
    let cache_dir = app_handle
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?;
    let thumb_cache_dir = cache_dir.join("thumbnails");

    if thumb_cache_dir.exists() {
        fs::remove_dir_all(&thumb_cache_dir)
            .map_err(|e| format!("Failed to remove thumbnail cache: {}", e))?;
    }

    fs::create_dir_all(&thumb_cache_dir)
        .map_err(|e| format!("Failed to recreate thumbnail cache directory: {}", e))?;

    Ok(())

}

pub fn get_thumb_cache_dir(app_handle: &AppHandle) -> Result<PathBuf, String> {
    let cache_dir = app_handle
        .path()
        .app_cache_dir()
        .map_err(|e| e.to_string())?;
    let thumb_cache_dir = cache_dir.join("thumbnails");
    if !thumb_cache_dir.exists() {
        fs::create_dir_all(&thumb_cache_dir).map_err(|e| e.to_string())?;
    }
    Ok(thumb_cache_dir)
}

pub fn get_cache_key_hash(path_str: &str) -> Option<String> {
    let (_, sidecar_path) = parse_virtual_path(path_str);

    let adjustments_bytes = if let Ok(content) = fs::read_to_string(&sidecar_path) {
        if let Ok(meta) = serde_json::from_str::<ImageMetadata>(&content) {
            serde_json::to_vec(&meta.adjustments).unwrap_or_default()
        } else {
            Vec::new()
        }
    } else {
        Vec::new()
    };

    compute_thumbnail_cache_hash(path_str, &adjustments_bytes)
}

pub fn get_cached_or_generate_thumbnail_image(
    path_str: &str,
    app_handle: &AppHandle,
    gpu_context: Option<&GpuContext>,
) -> Result<DynamicImage> {
    let thumb_cache_dir = get_thumb_cache_dir(app_handle).map_err(|e| anyhow::anyhow!(e))?;
    let settings = load_settings(app_handle.clone()).unwrap_or_default();
    let target_width_small = settings.small_thumbnail_resolution.unwrap_or(480);
    let target_width_medium = settings.medium_thumbnail_resolution.unwrap_or(1280);

    if let Some(cache_hash) = get_cache_key_hash(path_str) {
        let cache_path = thumb_cache_dir.join(format!("{}_medium.jpg", cache_hash));

        if cache_path.exists() {
            if let Ok(image) = image::open(&cache_path) {
                return Ok(image);
            }
            eprintln!(
                "Could not open cached thumbnail, regenerating: {:?}",
                cache_path
            );
        }

        let thumb_image = generate_thumbnail_data(path_str, gpu_context, None, app_handle)?;
        if let (Ok(small_data), Ok(medium_data)) = (
            encode_thumbnail(&thumb_image, target_width_small),
            encode_thumbnail(&thumb_image, target_width_medium),
        ) {
            let _ = fs::write(
                thumb_cache_dir.join(format!("{}_small.jpg", cache_hash)),
                &small_data,
            );
            let _ = fs::write(
                thumb_cache_dir.join(format!("{}_medium.jpg", cache_hash)),
                &medium_data,
            );
        }

        Ok(thumb_image)
    } else {
        generate_thumbnail_data(path_str, gpu_context, None, app_handle)
    }
}
