//! W5-E2 自 file_management.rs 四拆（此域：元数据仓储域：sidecar 读写、元数据 worker、EXIF/XMP、批量调整落盘。）。
//! 原文件共享管线经 mod.rs 重导出，路径与拆分前完全一致。

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::thread;
use anyhow::Result;
use image::DynamicImage;
use rayon::prelude::*;
use regex::regex;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use walkdir::WalkDir;
use crate::AppState;
use crate::PendingMetadata;
use crate::app_settings::*;
use crate::gpu_processing;
use crate::image_loader;
use crate::image_processing::{ImageMetadata, auto_results_to_json, perform_auto_analysis};
use crate::tagging::COLOR_TAG_PREFIX;

use super::*;


pub(crate) struct ImageFileMetadata {
    pub(crate) is_edited: bool,
    pub(crate) tags: Option<Vec<String>>,
    pub(crate) rating: u8,
    pub(crate) is_raw: bool,
}

pub fn resolve_image_metadata(
    image_path: &Path,
    sidecar_path: &Path,
    enable_xmp_sync: bool,
    settings: &AppSettings,
) -> ImageFileMetadata {
    let mut metadata = crate::exif_processing::load_sidecar(sidecar_path);

    if enable_xmp_sync
        && sync_metadata_from_xmp(image_path, &mut metadata)
        && let Ok(json) = serde_json::to_string_pretty(&metadata)
    {
        let _ = fs::write(sidecar_path, json);
    }

    let is_raw = crate::formats::is_raw_file(image_path);
    let tm_override = crate::image_processing::resolve_tonemapper_override(settings, is_raw);
    let is_edited =
        crate::image_processing::is_image_edited(&metadata.adjustments, is_raw, tm_override);
    ImageFileMetadata {
        is_edited,
        tags: metadata.tags,
        rating: metadata.rating,
        is_raw,
    }
}

fn emit_image_metadata_loaded(
    app_handle: &AppHandle,
    path: &str,
    rating: u8,
    is_edited: bool,
    tags: &Option<Vec<String>>,
) {
    let _ = app_handle.emit(
        "image-metadata-loaded",
        serde_json::json!({ "path": path, "rating": rating, "is_edited": is_edited, "tags": tags }),
    );
}

pub fn enqueue_metadata(
    app_handle: &AppHandle,
    virtual_path: String,
    image_path: PathBuf,
    sidecar_path: PathBuf,
) {
    let state = app_handle.state::<crate::AppState>();
    let manager = &state.metadata_manager;

    let mut pending = manager.pending.lock().unwrap_or_else(|e| e.into_inner());
    if !pending.insert(sidecar_path.clone()) {
        return;
    }
    drop(pending);

    manager
        .queue
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .push_back(PendingMetadata {
            virtual_path,
            image_path,
            sidecar_path,
        });
    manager.cvar.notify_one();
}

// Not compute-heavy — these threads mostly block waiting on iCloud to
// materialize a file, not burning CPU — so a small fixed pool is enough and
// doesn't need a user-facing setting the way thumbnail_worker_threads does.
const METADATA_WORKER_THREADS: usize = 4;

pub fn start_metadata_workers(app_handle: tauri::AppHandle) {
    let state = app_handle.state::<crate::AppState>();
    let manager = state.metadata_manager.clone();

    for _ in 0..METADATA_WORKER_THREADS {
        let app_clone = app_handle.clone();
        let manager_clone = manager.clone();

        std::thread::spawn(move || {
            loop {
                let item = {
                    let mut queue = manager_clone
                        .queue
                        .lock()
                        .unwrap_or_else(|e| e.into_inner());
                    while queue.is_empty() {
                        queue = manager_clone.cvar.wait(queue).unwrap();
                    }
                    queue.pop_front().unwrap()
                };

                let settings = load_settings(app_clone.clone()).unwrap_or_default();
                let enable_xmp_sync = settings.enable_xmp_sync.unwrap_or(false);

                let metadata = resolve_image_metadata(
                    &item.image_path,
                    &item.sidecar_path,
                    enable_xmp_sync,
                    &settings,
                );

                emit_image_metadata_loaded(
                    &app_clone,
                    &item.virtual_path,
                    metadata.rating,
                    metadata.is_edited,
                    &metadata.tags,
                );

                manager_clone
                    .pending
                    .lock()
                    .unwrap()
                    .remove(&item.sidecar_path);
            }
        });
    }
}

#[tauri::command]
pub async fn read_exif_for_paths(
    paths: Vec<String>,
    state: tauri::State<'_, AppState>,
) -> Result<HashMap<String, HashMap<String, String>>, String> {
    let is_hdd = state
        .thumbnail_manager
        .rotational_disk
        .load(Ordering::Relaxed);

    tauri::async_runtime::spawn_blocking(move || {
        let process_path = |virtual_path: &String| {
            let (source_path, _) = parse_virtual_path(virtual_path);
            let source_path_str = source_path.to_string_lossy().to_string();

            let map = if let Some(sidecar_exif) =
                crate::exif_processing::read_rrexif_sidecar(&source_path)
            {
                sidecar_exif
            } else if is_cloud_placeholder(&source_path) {
                HashMap::new()
            } else if let Ok(mmap) = read_file_mapped(&source_path) {
                crate::exif_processing::read_exif_data(&source_path_str, &mmap)
            } else if let Ok(bytes) = fs::read(&source_path) {
                crate::exif_processing::read_exif_data(&source_path_str, &bytes)
            } else {
                HashMap::new()
            };

            if map.is_empty() {
                None
            } else {
                Some((virtual_path.clone(), map))
            }
        };

        let exif_data: HashMap<String, HashMap<String, String>> = if is_hdd {
            paths.iter().filter_map(process_path).collect()
        } else {
            paths.par_iter().filter_map(process_path).collect()
        };

        Ok(exif_data)
    })
    .await
    .unwrap_or_else(|e| Err(format!("Task failed: {}", e)))
}

#[tauri::command]
pub async fn update_exif_fields(
    paths: Vec<String>,
    updates: HashMap<String, String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let errors: Vec<String> = paths
            .par_iter()
            .filter_map(|path| {
                let original_path = Path::new(&path);
                let primary_path = crate::exif_processing::get_primary_sidecar_path(original_path);
                let temp_metadata = crate::exif_processing::load_sidecar(&primary_path);

                let mut exif_data = temp_metadata.exif.unwrap_or_else(|| {
                    if let Some(existing) =
                        crate::exif_processing::read_rrexif_sidecar(original_path)
                    {
                        existing
                    } else if let Ok(mmap) = read_file_mapped(original_path) {
                        crate::exif_processing::read_exif_data_from_bytes(path, &mmap)
                    } else if let Ok(bytes) = fs::read(original_path) {
                        crate::exif_processing::read_exif_data_from_bytes(path, &bytes)
                    } else {
                        HashMap::new()
                    }
                });

                for (k, v) in &updates {
                    let trimmed = v.trim();
                    if trimmed.is_empty() {
                        exif_data.remove(k);
                    } else {
                        exif_data.insert(k.clone(), trimmed.to_string());
                    }
                }

                let mut final_metadata = crate::exif_processing::load_sidecar(&primary_path);
                final_metadata.exif = Some(exif_data);

                match serde_json::to_string_pretty(&final_metadata) {
                    Ok(json) => match std::fs::write(&primary_path, json) {
                        Ok(_) => None,
                        Err(e) => Some(format!("{}: 写入 sidecar 失败: {}", path, e)),
                    },
                    Err(e) => Some(format!("{}: JSON 序列化失败: {}", path, e)),
                }
            })
            .collect();

        if errors.is_empty() {
            Ok(())
        } else {
            Err(format!("部分文件 EXIF 更新失败:\n{}", errors.join("\n")))
        }
    })
    .await
    .map_err(|e| format!("Task failed: {}", e))?
}

pub fn resolve_lens_params_in_adjustments(
    adjustments: &mut Value,
    exif_data: &Option<HashMap<String, String>>,
    lens_db: Option<&crate::lens_correction::LensDatabase>,
) {
    if let Some(map) = adjustments.as_object_mut() {
        let mode = map
            .get("lensCorrectionMode")
            .and_then(|v| v.as_str())
            .unwrap_or("manual");

        if mode == "auto" {
            if let Some(exif) = exif_data {
                let exif_maker = exif.get("Make").map(|s| s.as_str()).unwrap_or("");
                let exif_model = exif.get("LensModel").map(|s| s.as_str()).unwrap_or("");
                if let Some(db) = lens_db {
                    if let Some((detected_maker, detected_model)) =
                        crate::lens_correction::find_best_lens_match(db, exif_maker, exif_model)
                    {
                        map.insert(
                            "lensMaker".to_string(),
                            serde_json::to_value(&detected_maker).unwrap(),
                        );
                        map.insert(
                            "lensModel".to_string(),
                            serde_json::to_value(&detected_model).unwrap(),
                        );
                    } else {
                        map.remove("lensMaker");
                        map.remove("lensModel");
                    }
                }
            } else {
                map.remove("lensMaker");
                map.remove("lensModel");
            }
        }

        if let Some(db) = lens_db {
            let has_valid_lens = match (
                map.get("lensMaker").and_then(|v| v.as_str()),
                map.get("lensModel").and_then(|v| v.as_str()),
            ) {
                (Some(maker), Some(model)) if !maker.is_empty() && !model.is_empty() => {
                    let mut focal_length = 50.0;
                    let mut aperture = None;
                    let mut distance = None;

                    if let Some(exif) = exif_data {
                        if let Some(fl_str) = exif
                            .get("FocalLength")
                            .or(exif.get("FocalLengthIn35mmFilm"))
                            && let Ok(fl) = fl_str.replace(" mm", "").trim().parse::<f32>()
                        {
                            focal_length = fl;
                        }
                        if let Some(ap_str) = exif.get("ApertureValue").or(exif.get("FNumber"))
                            && let Ok(ap) = ap_str.replace("f/", "").trim().parse::<f32>()
                        {
                            aperture = Some(ap);
                        }
                        if let Some(dist_str) = exif.get("SubjectDistance")
                            && let Ok(dist) = dist_str.replace(" m", "").trim().parse::<f32>()
                        {
                            distance = Some(dist);
                        }
                    }

                    if let Some(params) = crate::lens_correction::resolve_lens_params(
                        db,
                        maker,
                        model,
                        focal_length,
                        aperture,
                        distance,
                    ) {
                        map.insert(
                            "lensDistortionParams".to_string(),
                            serde_json::to_value(params).unwrap(),
                        );
                        true
                    } else {
                        false
                    }
                }
                _ => false,
            };

            if !has_valid_lens {
                map.remove("lensDistortionParams");
            }
        }
    }

}

#[tauri::command]
pub fn save_metadata_and_update_thumbnail(
    path: String,
    adjustments: Value,
    app_handle: AppHandle,
    state: tauri::State<AppState>,
) -> Result<(), String> {
    let (source_path, sidecar_path) = parse_virtual_path(&path);

    let mut metadata = crate::exif_processing::load_sidecar(&sidecar_path);

    let mut final_adjustments = adjustments;
    {
        let lens_db_guard = state.lens_db.lock().unwrap_or_else(|e| e.into_inner());
        resolve_lens_params_in_adjustments(
            &mut final_adjustments,
            &metadata.exif,
            lens_db_guard.as_deref(),
        );
    }

    metadata.adjustments = final_adjustments;

    let json_string = serde_json::to_string_pretty(&metadata).map_err(|e| e.to_string())?;
    std::fs::write(&sidecar_path, json_string).map_err(|e| e.to_string())?;

    if let Ok(settings) = load_settings(app_handle.clone())
        && settings.enable_xmp_sync.unwrap_or(false)
    {
        let create_if_missing = settings.create_xmp_if_missing.unwrap_or(false);
        sync_metadata_to_xmp(&source_path, &metadata, create_if_missing);
    }

    let loaded_image_lock = state
        .original_image
        .lock()
        .unwrap_or_else(|e| e.into_inner());
    let preloaded_image_option = if let Some(loaded_image) = loaded_image_lock.as_ref() {
        if loaded_image.path == path {
            Some(loaded_image.image.clone())
        } else {
            None
        }
    } else {
        None
    };
    drop(loaded_image_lock);

    let gpu_context = gpu_processing::get_or_init_gpu_context(&state, &app_handle).ok();
    let app_handle_clone = app_handle.clone();
    let path_clone = path.clone();

    add_to_thumbnail_queue(&state, 1, &app_handle);

    thread::spawn(move || {
        let state = app_handle_clone.state::<AppState>();
        let settings = load_settings(app_handle_clone.clone()).unwrap_or_default();

        let thumb_cache_dir = match resolve_thumbnail_cache_dir(&app_handle_clone) {
            Ok(dir) => dir,
            Err(e) => {
                log::warn!(
                    "Unable to initialize thumbnail cache directory for '{}': {}",
                    path_clone,
                    e
                );
                emit_thumbnail_cache_setup_error(&app_handle_clone, &path_clone, &e);
                increment_thumbnail_progress(&state, &app_handle_clone);
                return;
            }
        };

        let result = generate_single_thumbnail_and_cache(
            &path_clone,
            &thumb_cache_dir,
            gpu_context.as_ref(),
            preloaded_image_option.as_deref(),
            true,
            &app_handle_clone,
            &settings,
        );

        if let Some((small_path, medium_path, rating, is_edited)) = result {
            emit_thumbnail_generated(
                &app_handle_clone,
                &path_clone,
                &small_path,
                &medium_path,
                rating,
                is_edited,
            );
        }

        increment_thumbnail_progress(&state, &app_handle_clone);
    });

    Ok(())
}

#[tauri::command]
pub async fn apply_adjustments_to_paths(
    paths: Vec<String>,
    adjustments: Value,
    app_handle: AppHandle,
) -> Result<(), String> {
    let state = app_handle.state::<AppState>();
    add_to_thumbnail_queue(&state, paths.len(), &app_handle);

    tauri::async_runtime::spawn_blocking(move || {
        let settings = load_settings(app_handle.clone()).unwrap_or_default();
        let enable_xmp_sync = settings.enable_xmp_sync.unwrap_or(false);
        let create_xmp_if_missing = settings.create_xmp_if_missing.unwrap_or(false);

        let lens_db = app_handle
            .state::<AppState>()
            .lens_db
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone();

        let errors: Vec<String> = paths
            .par_iter()
            .filter_map(|path| {
                let (_, sidecar_path) = parse_virtual_path(path);

                let mut existing_metadata = crate::exif_processing::load_sidecar(&sidecar_path);

                let mut new_adjustments = existing_metadata.adjustments;
                if new_adjustments.is_null() {
                    new_adjustments = serde_json::json!({});
                }

                if let (Some(new_map), Some(pasted_map)) =
                    (new_adjustments.as_object_mut(), adjustments.as_object())
                {
                    for (k, v) in pasted_map {
                        new_map.insert(k.clone(), v.clone());
                    }
                }

                resolve_lens_params_in_adjustments(
                    &mut new_adjustments,
                    &existing_metadata.exif,
                    lens_db.as_deref(),
                );

                existing_metadata.adjustments = new_adjustments;

                match serde_json::to_string_pretty(&existing_metadata) {
                    Ok(json_string) => match std::fs::write(&sidecar_path, json_string) {
                        Ok(_) => {
                            if enable_xmp_sync {
                                let source_path = parse_virtual_path(path).0;
                                sync_metadata_to_xmp(
                                    &source_path,
                                    &existing_metadata,
                                    create_xmp_if_missing,
                                );
                            }
                            None
                        }
                        Err(e) => Some(format!("{}: 写入 sidecar 失败: {}", path, e)),
                    },
                    Err(e) => Some(format!("{}: JSON 序列化失败: {}", path, e)),
                }
            })
            .collect();

        if !errors.is_empty() {
            eprintln!(
                "apply_adjustments_to_paths partial errors:\n{}",
                errors.join("\n")
            );
        }

        let state = app_handle.state::<AppState>();
        let thumb_cache_dir = match resolve_thumbnail_cache_dir(&app_handle) {
            Ok(dir) => dir,
            Err(e) => {
                log::warn!("Unable to initialize thumbnail cache directory: {}", e);
                for path in &paths {
                    emit_thumbnail_cache_setup_error(&app_handle, path, &e);
                }
                for _ in 0..paths.len() {
                    increment_thumbnail_progress(&state, &app_handle);
                }
                return;
            }
        };

        let gpu_context = gpu_processing::get_or_init_gpu_context(&state, &app_handle).ok();

        paths.par_iter().for_each(|path_str| {
            let result = generate_single_thumbnail_and_cache(
                path_str,
                &thumb_cache_dir,
                gpu_context.as_ref(),
                None,
                true,
                &app_handle,
                &settings,
            );

            if let Some((small_path, medium_path, rating, is_edited)) = result {
                emit_thumbnail_generated(
                    &app_handle,
                    path_str,
                    &small_path,
                    &medium_path,
                    rating,
                    is_edited,
                );
            }

            increment_thumbnail_progress(&state, &app_handle);
        });
    });

    Ok(())
}

#[tauri::command]
pub async fn reset_adjustments_for_paths(
    paths: Vec<String>,
    app_handle: AppHandle,
) -> Result<(), String> {
    let state = app_handle.state::<AppState>();
    add_to_thumbnail_queue(&state, paths.len(), &app_handle);

    tauri::async_runtime::spawn_blocking(move || {
        let settings = load_settings(app_handle.clone()).unwrap_or_default();
        let enable_xmp_sync = settings.enable_xmp_sync.unwrap_or(false);
        let create_xmp_if_missing = settings.create_xmp_if_missing.unwrap_or(false);

        let errors: Vec<String> = paths
            .par_iter()
            .filter_map(|path| {
                let (_, sidecar_path) = parse_virtual_path(path);
                let mut existing_metadata = crate::exif_processing::load_sidecar(&sidecar_path);
                existing_metadata.adjustments = serde_json::json!({});

                match serde_json::to_string_pretty(&existing_metadata) {
                    Ok(json_string) => match std::fs::write(&sidecar_path, json_string) {
                        Ok(_) => {
                            if enable_xmp_sync {
                                let source_path = parse_virtual_path(path).0;
                                sync_metadata_to_xmp(
                                    &source_path,
                                    &existing_metadata,
                                    create_xmp_if_missing,
                                );
                            }
                            None
                        }
                        Err(e) => Some(format!("{}: 写入 sidecar 失败: {}", path, e)),
                    },
                    Err(e) => Some(format!("{}: JSON 序列化失败: {}", path, e)),
                }
            })
            .collect();

        if !errors.is_empty() {
            eprintln!(
                "reset_adjustments_for_paths partial errors:\n{}",
                errors.join("\n")
            );
        }

        let state = app_handle.state::<AppState>();
        let thumb_cache_dir = match resolve_thumbnail_cache_dir(&app_handle) {
            Ok(dir) => dir,
            Err(e) => {
                log::warn!("Unable to initialize thumbnail cache directory: {}", e);
                for path in &paths {
                    emit_thumbnail_cache_setup_error(&app_handle, path, &e);
                }
                for _ in 0..paths.len() {
                    increment_thumbnail_progress(&state, &app_handle);
                }
                return;
            }
        };

        let gpu_context = gpu_processing::get_or_init_gpu_context(&state, &app_handle).ok();

        paths.par_iter().for_each(|path_str| {
            let result = generate_single_thumbnail_and_cache(
                path_str,
                &thumb_cache_dir,
                gpu_context.as_ref(),
                None,
                true,
                &app_handle,
                &settings,
            );

            if let Some((small_path, medium_path, rating, is_edited)) = result {
                emit_thumbnail_generated(
                    &app_handle,
                    path_str,
                    &small_path,
                    &medium_path,
                    rating,
                    is_edited,
                );
            }

            increment_thumbnail_progress(&state, &app_handle);
        });
    });

    Ok(())
}

#[tauri::command]
pub async fn apply_auto_adjustments_to_paths(
    paths: Vec<String>,
    app_handle: AppHandle,
) -> Result<(), String> {
    let state = app_handle.state::<AppState>();
    add_to_thumbnail_queue(&state, paths.len(), &app_handle);

    tauri::async_runtime::spawn_blocking(move || {
        let settings = load_settings(app_handle.clone()).unwrap_or_default();
        let enable_xmp_sync = settings.enable_xmp_sync.unwrap_or(false);
        let create_xmp_if_missing = settings.create_xmp_if_missing.unwrap_or(false);

        let state = app_handle.state::<AppState>();
        let thumb_cache_dir = match resolve_thumbnail_cache_dir(&app_handle) {
            Ok(dir) => dir,
            Err(e) => {
                log::warn!("Unable to initialize thumbnail cache directory: {}", e);
                for path in &paths {
                    emit_thumbnail_cache_setup_error(&app_handle, path, &e);
                }
                for _ in 0..paths.len() {
                    increment_thumbnail_progress(&state, &app_handle);
                }
                return;
            }
        };

        let gpu_context = gpu_processing::get_or_init_gpu_context(&state, &app_handle).ok();

        paths.par_iter().for_each(|path| {
            let loaded_image: Option<DynamicImage> = (|| -> Result<DynamicImage, String> {
                let (source_path, sidecar_path) = parse_virtual_path(path);
                let source_path_str = source_path.to_string_lossy().to_string();

                let file_bytes = fs::read(&source_path).map_err(|e| e.to_string())?;
                let image = image_loader::load_base_image_from_bytes(
                    &file_bytes,
                    &source_path_str,
                    true,
                    &settings,
                    None,
                )
                .map_err(|e| e.to_string())?;

                let auto_results = perform_auto_analysis(&image);
                let auto_adjustments_json = auto_results_to_json(&auto_results);

                let mut existing_metadata = crate::exif_processing::load_sidecar(&sidecar_path);

                if existing_metadata.adjustments.is_null() {
                    existing_metadata.adjustments = serde_json::json!({});
                }

                if let (Some(existing_map), Some(auto_map)) = (
                    existing_metadata.adjustments.as_object_mut(),
                    auto_adjustments_json.as_object(),
                ) {
                    for (k, v) in auto_map {
                        if k == "sectionVisibility" {
                            if let Some(existing_vis_val) = existing_map.get_mut(k) {
                                if let (Some(existing_vis), Some(auto_vis)) =
                                    (existing_vis_val.as_object_mut(), v.as_object())
                                {
                                    for (vis_k, vis_v) in auto_vis {
                                        existing_vis.insert(vis_k.clone(), vis_v.clone());
                                    }
                                }
                            } else {
                                existing_map.insert(k.clone(), v.clone());
                            }
                        } else {
                            existing_map.insert(k.clone(), v.clone());
                        }
                    }
                }

                let json_string = serde_json::to_string_pretty(&existing_metadata)
                    .map_err(|e| format!("JSON 序列化失败: {}", e))?;
                std::fs::write(&sidecar_path, json_string)
                    .map_err(|e| format!("写入 sidecar 失败: {}", e))?;

                if enable_xmp_sync {
                    sync_metadata_to_xmp(&source_path, &existing_metadata, create_xmp_if_missing);
                }
                Ok(image)
            })()
            .map_err(|e| eprintln!("Failed to apply auto adjustments to {}: {}", path, e))
            .ok();

            let result = generate_single_thumbnail_and_cache(
                path,
                &thumb_cache_dir,
                gpu_context.as_ref(),
                loaded_image.as_ref(),
                true,
                &app_handle,
                &settings,
            );

            if let Some((small_path, medium_path, rating, is_edited)) = result {
                emit_thumbnail_generated(
                    &app_handle,
                    path,
                    &small_path,
                    &medium_path,
                    rating,
                    is_edited,
                );
            }

            increment_thumbnail_progress(&state, &app_handle);
        });
    });

    Ok(())
}

#[tauri::command]
pub fn set_color_label_for_paths(
    paths: Vec<String>,
    color: Option<String>,
    app_handle: AppHandle,
) -> Result<(), String> {
    let settings = load_settings(app_handle.clone()).unwrap_or_default();
    let enable_xmp_sync = settings.enable_xmp_sync.unwrap_or(false);
    let create_xmp_if_missing = settings.create_xmp_if_missing.unwrap_or(false);

    let errors: Vec<String> = paths
        .par_iter()
        .filter_map(|path| {
            let (_, sidecar_path) = parse_virtual_path(path);

            let mut metadata = crate::exif_processing::load_sidecar(&sidecar_path);

            let mut tags = metadata.tags.unwrap_or_default();
            tags.retain(|tag| !tag.starts_with(COLOR_TAG_PREFIX));

            if let Some(c) = &color
                && !c.is_empty()
            {
                tags.push(format!("{}{}", COLOR_TAG_PREFIX, c));
            }

            if tags.is_empty() {
                metadata.tags = None;
            } else {
                metadata.tags = Some(tags);
            }

            match serde_json::to_string_pretty(&metadata) {
                Ok(json_string) => match std::fs::write(&sidecar_path, json_string) {
                    Ok(_) => {
                        if enable_xmp_sync {
                            let source_path = parse_virtual_path(path).0;
                            sync_metadata_to_xmp(&source_path, &metadata, create_xmp_if_missing);
                        }
                        None
                    }
                    Err(e) => Some(format!("{}: 写入 sidecar 失败: {}", path, e)),
                },
                Err(e) => Some(format!("{}: JSON 序列化失败: {}", path, e)),
            }
        })
        .collect();

    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!("部分文件颜色标签更新失败:\n{}", errors.join("\n")))
    }
}

#[tauri::command]
pub fn set_rating_for_paths(
    paths: Vec<String>,
    rating: u8,
    app_handle: AppHandle,
) -> Result<(), String> {
    let settings = load_settings(app_handle.clone()).unwrap_or_default();
    let enable_xmp_sync = settings.enable_xmp_sync.unwrap_or(false);
    let create_xmp_if_missing = settings.create_xmp_if_missing.unwrap_or(false);

    let errors: Vec<String> = paths
        .par_iter()
        .filter_map(|path| {
            let (_, sidecar_path) = parse_virtual_path(path);

            let mut metadata = crate::exif_processing::load_sidecar(&sidecar_path);
            metadata.rating = rating;

            match serde_json::to_string_pretty(&metadata) {
                Ok(json_string) => match std::fs::write(&sidecar_path, json_string) {
                    Ok(_) => {
                        if enable_xmp_sync {
                            let source_path = parse_virtual_path(path).0;
                            sync_metadata_to_xmp(&source_path, &metadata, create_xmp_if_missing);
                        }
                        None
                    }
                    Err(e) => Some(format!("{}: 写入 sidecar 失败: {}", path, e)),
                },
                Err(e) => Some(format!("{}: JSON 序列化失败: {}", path, e)),
            }
        })
        .collect();

    if errors.is_empty() {
        Ok(())
    } else {
        Err(format!("部分文件评分更新失败:\n{}", errors.join("\n")))
    }
}

#[tauri::command]
pub fn load_metadata(path: String, app_handle: AppHandle) -> Result<ImageMetadata, String> {
    let settings = load_settings(app_handle).unwrap_or_default();
    let enable_xmp_sync = settings.enable_xmp_sync.unwrap_or(false);

    let (source_path, sidecar_path) = parse_virtual_path(&path);
    let mut metadata = crate::exif_processing::load_sidecar(&sidecar_path);

    if enable_xmp_sync
        && sync_metadata_from_xmp(&source_path, &mut metadata)
        && let Ok(json) = serde_json::to_string_pretty(&metadata)
    {
        let _ = fs::write(&sidecar_path, json);
    }

    Ok(metadata)

}

#[tauri::command]
pub fn clear_all_sidecars(root_path: String) -> Result<usize, String> {
    if !Path::new(&root_path).exists() {
        return Err(format!("Root path does not exist: {}", root_path));
    }

    let mut deleted_count = 0;
    let walker = WalkDir::new(root_path).into_iter();

    for entry in walker.filter_map(|e| e.ok()) {
        let path = entry.path();
        if path.is_file()
            && let Some(extension) = path.extension()
            && (extension == "rrdata" || extension == "rrexif")
        {
            if fs::remove_file(path).is_ok() {
                deleted_count += 1;
            } else {
                eprintln!("Failed to delete sidecar file: {:?}", path);
            }
        }
    }

    Ok(deleted_count)

}

pub fn extract_xmp_rating(content: &str) -> Option<u8> {
    if let Some(idx) = content.find("xmp:Rating=\"") {
        let start = idx + 12;
        let end = content[start..].find('"').map(|i| start + i)?;
        return content[start..end].parse().ok();
    }
    if let Some(idx) = content.find("<xmp:Rating>") {
        let start = idx + 12;
        let end = content[start..].find('<').map(|i| start + i)?;
        return content[start..end].parse().ok();
    }
    None
}

pub fn extract_xmp_label(content: &str) -> Option<String> {
    if let Some(idx) = content.find("xmp:Label=\"") {
        let start = idx + 11;
        let end = content[start..].find('"').map(|i| start + i)?;
        return Some(content[start..end].to_string());
    }
    if let Some(idx) = content.find("<xmp:Label>") {
        let start = idx + 11;
        let end = content[start..].find('<').map(|i| start + i)?;
        return Some(content[start..end].to_string());
    }
    None
}

pub fn extract_xmp_tags(content: &str) -> Vec<String> {
    let mut tags = Vec::new();
    if let Some(start_idx) = content.find("<dc:subject>")
        && let Some(end_idx) = content[start_idx..].find("</dc:subject>")
    {
        let subject_block = &content[start_idx..start_idx + end_idx];
        let mut current_idx = 0;
        while let Some(li_start) = subject_block[current_idx..].find("<rdf:li>") {
            let val_start = current_idx + li_start + 8;
            if let Some(li_end) = subject_block[val_start..].find("</rdf:li>") {
                tags.push(subject_block[val_start..val_start + li_end].to_string());
                current_idx = val_start + li_end + 9;
            } else {
                break;
            }
        }
    }
    tags
}

pub fn resolve_xmp_path(image_path: &Path) -> Option<PathBuf> {
    let xmp_path = image_path.with_extension("xmp");
    let xmp_path_upper = image_path.with_extension("XMP");
    if xmp_path.exists() {
        Some(xmp_path)
    } else if xmp_path_upper.exists() {
        Some(xmp_path_upper)
    } else {
        None
    }
}

pub fn sync_metadata_from_xmp(source_path: &Path, metadata: &mut ImageMetadata) -> bool {
    let actual_xmp = resolve_xmp_path(source_path);

    let mut changed = false;

    if let Some(xmp_file) = actual_xmp
        && let Ok(content) = fs::read_to_string(&xmp_file)
    {
        if metadata.rating == 0
            && let Some(rating) = extract_xmp_rating(&content)
            && rating != 0
        {
            metadata.rating = rating;
            if let Some(obj) = metadata.adjustments.as_object_mut() {
                obj.insert("rating".to_string(), serde_json::json!(rating));
            } else {
                metadata.adjustments = serde_json::json!({"rating": rating});
            }
            changed = true;
        }

        let xmp_label = extract_xmp_label(&content);
        let xmp_tags = extract_xmp_tags(&content);

        let mut current_tags = metadata.tags.clone().unwrap_or_default();
        let original_len = current_tags.len();
        let had_no_tags = metadata.tags.is_none();

        for tag in xmp_tags {
            if !current_tags.contains(&tag) {
                current_tags.push(tag);
            }
        }

        if let Some(label) = xmp_label {
            let label_tag = format!("{}{}", COLOR_TAG_PREFIX, label.to_lowercase());
            if !current_tags.contains(&label_tag) {
                current_tags.retain(|t| !t.starts_with(COLOR_TAG_PREFIX));
                current_tags.push(label_tag);
            }
        }

        if current_tags.len() != original_len || (had_no_tags && !current_tags.is_empty()) {
            metadata.tags = Some(current_tags);
            changed = true;
        }
    }
    changed
}

pub fn sync_metadata_to_xmp(source_path: &Path, metadata: &ImageMetadata, create_if_missing: bool) {
    let xmp_path = source_path.with_extension("xmp");
    let xmp_path_upper = source_path.with_extension("XMP");

    let mut actual_xmp = if xmp_path.exists() {
        Some(xmp_path.clone())
    } else if xmp_path_upper.exists() {
        Some(xmp_path_upper.clone())
    } else {
        None
    };

    if actual_xmp.is_none() {
        if !create_if_missing {
            return;
        }
        let skeleton = r#"<?xml version="1.0" encoding="UTF-8"?>
<x:xmpmeta xmlns:x="adobe:ns:meta/" x:xmptk="RapidRAW">
 <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
  <rdf:Description rdf:about=""
    xmlns:xmp="http://ns.adobe.com/xap/1.0/"
    xmlns:dc="http://purl.org/dc/elements/1.1/">
  </rdf:Description>
 </rdf:RDF>
</x:xmpmeta>"#;
        if let Err(e) = fs::write(&xmp_path, skeleton) {
            log::error!("Failed to create skeleton XMP: {}", e);
            return;
        }
        actual_xmp = Some(xmp_path);
    }

    if let Some(xmp_file) = actual_xmp
        && let Ok(mut content) = fs::read_to_string(&xmp_file)
    {
        let rating_str = metadata.rating.to_string();
        let re_rating_attr = regex!(r#"xmp:Rating\s*=\s*"[^"]*""#);
        let re_rating_tag = regex!(r#"<xmp:Rating\s*>[^<]*</xmp:Rating>"#);

        if re_rating_attr.is_match(&content) {
            content = re_rating_attr
                .replace(&content, format!("xmp:Rating=\"{}\"", rating_str))
                .to_string();
        } else if re_rating_tag.is_match(&content) {
            content = re_rating_tag
                .replace(&content, format!("<xmp:Rating>{}</xmp:Rating>", rating_str))
                .to_string();
        } else if let Some(last_index) = content.rfind("</rdf:Description>") {
            let (start, end) = content.split_at(last_index);
            content = format!("{} <xmp:Rating>{}</xmp:Rating>\n{}", start, rating_str, end);
        }

        let current_tags = metadata.tags.clone().unwrap_or_default();
        let mut label = None;
        let mut normal_tags = Vec::new();

        for t in current_tags {
            if let Some(color) = t.strip_prefix(COLOR_TAG_PREFIX) {
                let mut c = color.chars();
                let cap_color = match c.next() {
                    None => String::new(),
                    Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
                };
                label = Some(cap_color);
            } else {
                normal_tags.push(t);
            }
        }

        if let Some(lbl) = label {
            let re_label_attr = regex!(r#"xmp:Label\s*=\s*"[^"]*""#);
            let re_label_tag = regex!(r#"<xmp:Label\s*>[^<]*</xmp:Label>"#);

            if re_label_attr.is_match(&content) {
                content = re_label_attr
                    .replace(&content, format!("xmp:Label=\"{}\"", lbl))
                    .to_string();
            } else if re_label_tag.is_match(&content) {
                content = re_label_tag
                    .replace(&content, format!("<xmp:Label>{}</xmp:Label>", lbl))
                    .to_string();
            } else if let Some(last_index) = content.rfind("</rdf:Description>") {
                let (start, end) = content.split_at(last_index);
                content = format!("{} <xmp:Label>{}</xmp:Label>\n{}", start, lbl, end);
            }
        } else {
            let re_label_attr = regex!(r#"\s*xmp:Label\s*=\s*"[^"]*""#);
            let re_label_tag = regex!(r#"\s*<xmp:Label\s*>[^<]*</xmp:Label>"#);
            content = re_label_attr.replace_all(&content, "").to_string();
            content = re_label_tag.replace_all(&content, "").to_string();
        }

        let re_subject = regex!(r#"(?s)<dc:subject>\s*<rdf:Bag>.*?</rdf:Bag>\s*</dc:subject>"#);
        if normal_tags.is_empty() {
            content = re_subject.replace_all(&content, "").to_string();
        } else {
            let mut bag = String::from("<dc:subject>\n    <rdf:Bag>\n");
            for t in normal_tags {
                bag.push_str(&format!("     <rdf:li>{}</rdf:li>\n", t));
            }
            bag.push_str("    </rdf:Bag>\n   </dc:subject>");

            if re_subject.is_match(&content) {
                content = re_subject.replace(&content, bag).to_string();
            } else if let Some(last_index) = content.rfind("</rdf:Description>") {
                let (start, end) = content.split_at(last_index);
                content = format!("{} {}\n  {}", start, bag, end);
            }
        }

        let _ = fs::write(&xmp_file, content);
    }
}
