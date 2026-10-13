//! W5-E1 图库域命令：社区预设拉取/预览 + 图库扫描/相册/预设库/标签/筛选/LUT 库。

use std::borrow::Cow;
use std::collections::hash_map::DefaultHasher;
use std::collections::HashMap;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::Cursor;

use image::codecs::jpeg::JpegEncoder;
use image::{DynamicImage, GenericImageView, ImageBuffer, Luma, RgbImage};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::AppState;
use crate::app_settings::*;
use crate::file_management::parse_virtual_path;
use crate::formats::is_raw_file;
use crate::image_processing::{
    Crop, RenderRequest, downscale_f32_image, get_all_adjustments_from_json,
    get_or_init_gpu_context, resolve_tonemapper_override_from_handle,
};
use crate::lut_processing;
use crate::mask_generation::{MaskDefinition, generate_mask_bitmap};

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct CommunityPreset {
    pub name: String,
    pub creator: String,
    pub adjustments: Value,
    #[serde(rename = "includeMasks")]
    pub include_masks: Option<bool>,
    #[serde(rename = "includeCropTransform")]
    pub include_crop_transform: Option<bool>,
}

#[tauri::command]
pub async fn fetch_community_presets() -> Result<Vec<CommunityPreset>, String> {
    // GitHub raw 国内镜像降级链：先 ghproxy 加速，失败再走官方
    const PRESET_PATHS: &[&str] = &[
        "https://ghproxy.com/https://raw.githubusercontent.com/CyberTimon/RapidRAW-Presets/main/manifest.json",
        "https://mirror.ghproxy.com/https://raw.githubusercontent.com/CyberTimon/RapidRAW-Presets/main/manifest.json",
        "https://raw.githubusercontent.com/CyberTimon/RapidRAW-Presets/main/manifest.json",
    ];

    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(30))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))?;

    let mut last_err: Option<String> = None;
    for url in PRESET_PATHS {
        let response = match client
            .get(*url)
            .header("User-Agent", "RapidRAW-App")
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                last_err = Some(format!("{} 连接失败: {}", url, e));
                continue;
            }
        };

        if !response.status().is_success() {
            last_err = Some(format!("{} 返回错误: {}", url, response.status()));
            continue;
        }

        match response.json::<Vec<CommunityPreset>>().await {
            Ok(presets) => return Ok(presets),
            Err(e) => {
                last_err = Some(format!("{} 解析失败: {}", url, e));
                continue;
            }
        }
    }

    Err(last_err.unwrap_or_else(|| "所有预设源均不可用".to_string()))
}

#[tauri::command]
pub async fn generate_all_community_previews(
    image_paths: Vec<String>,
    presets: Vec<CommunityPreset>,
    state: tauri::State<'_, AppState>,
    app_handle: tauri::AppHandle,
) -> Result<HashMap<String, Vec<u8>>, String> {
    let context = get_or_init_gpu_context(&state, &app_handle)?;
    let mut results: HashMap<String, Vec<u8>> = HashMap::new();

    const TILE_DIM: u32 = 360;
    const PROCESSING_DIM: u32 = TILE_DIM * 2;

    let settings = load_settings(app_handle.clone()).unwrap_or_default();

    let mut base_thumbnails: Vec<(DynamicImage, bool, f32)> = Vec::new();
    for image_path in image_paths.iter() {
        let (source_path, _) = parse_virtual_path(image_path);
        let source_path_str = source_path.to_string_lossy().to_string();
        let image_bytes = fs::read(&source_path).map_err(|e| e.to_string())?;
        let original_image = crate::image_loader::load_base_image_from_bytes(
            &image_bytes,
            &source_path_str,
            true,
            &settings,
            None,
        )
        .map_err(|e| e.to_string())?;

        let is_raw = is_raw_file(&source_path_str);
        let (orig_w, orig_h) = original_image.dimensions();
        let (base_image, base_scale) = if orig_w > PROCESSING_DIM || orig_h > PROCESSING_DIM {
            let downscaled = downscale_f32_image(&original_image, PROCESSING_DIM, PROCESSING_DIM);
            let scale = downscaled.width() as f32 / orig_w as f32;
            (downscaled, scale)
        } else {
            (original_image, 1.0)
        };

        base_thumbnails.push((base_image, is_raw, base_scale));
    }

    for preset in presets.iter() {
        let mut processed_tiles: Vec<RgbImage> = Vec::new();
        let js_adjustments = &preset.adjustments;

        let mut preset_hasher = DefaultHasher::new();
        preset.name.hash(&mut preset_hasher);
        let preset_hash = preset_hasher.finish();

        for (i, (base_image, is_raw, base_scale)) in base_thumbnails.iter().enumerate() {
            let mut scaled_adjustments = js_adjustments.clone();
            if let Some(crop_val) = scaled_adjustments.get_mut("crop")
                && let Ok(c) = serde_json::from_value::<Crop>(crop_val.clone())
            {
                *crop_val = serde_json::to_value(Crop {
                    x: c.x * (*base_scale as f64),
                    y: c.y * (*base_scale as f64),
                    width: c.width * (*base_scale as f64),
                    height: c.height * (*base_scale as f64),
                })
                .unwrap_or(serde_json::Value::Null);
            }

            let (transformed_image, _scaled_crop_offset) =
                crate::apply_all_transformations(Cow::Borrowed(base_image), &scaled_adjustments);
            let (img_w, img_h) = transformed_image.dimensions();

            let mask_definitions: Vec<MaskDefinition> = scaled_adjustments
                .get("masks")
                .and_then(|m| serde_json::from_value(m.clone()).ok())
                .unwrap_or_else(Vec::new);

            let unscaled_crop_offset = js_adjustments
                .get("crop")
                .and_then(|c| serde_json::from_value::<Crop>(c.clone()).ok())
                .map_or((0.0, 0.0), |c| (c.x as f32, c.y as f32));
            let actual_scaled_crop_offset = (
                unscaled_crop_offset.0 * base_scale,
                unscaled_crop_offset.1 * base_scale,
            );

            let mask_bitmaps: Vec<ImageBuffer<Luma<u8>, Vec<u8>>> = mask_definitions
                .iter()
                .filter_map(|def| {
                    generate_mask_bitmap(
                        def,
                        img_w,
                        img_h,
                        *base_scale,
                        actual_scaled_crop_offset,
                        None,
                    )
                })
                .collect();

            let tm_override = resolve_tonemapper_override_from_handle(&app_handle, *is_raw);
            let all_adjustments =
                get_all_adjustments_from_json(&scaled_adjustments, *is_raw, tm_override);
            let lut_path = js_adjustments["lutPath"].as_str();
            let lut = lut_path.and_then(|p| lut_processing::get_or_load_lut(&state, p).ok());

            let unique_hash = preset_hash.wrapping_add(i as u64);

            let processed_image_dynamic = crate::image_processing::process_and_get_dynamic_image(
                &context,
                &state,
                transformed_image.as_ref(),
                unique_hash,
                RenderRequest {
                    adjustments: all_adjustments,
                    mask_bitmaps: &mask_bitmaps,
                    lut,
                    roi: None,
                },
                "generate_all_community_previews",
            )?;

            // [POST-GPU] channel_mixer + split_toning
            let processed_image_dynamic =
                crate::image_processing::apply_post_gpu_adjustments(processed_image_dynamic, &js_adjustments);

            let processed_image = processed_image_dynamic.to_rgb8();

            let (proc_w, proc_h) = processed_image.dimensions();
            let size = proc_w.min(proc_h);
            let cropped_processed_image = image::imageops::crop_imm(
                &processed_image,
                (proc_w - size) / 2,
                (proc_h - size) / 2,
                size,
                size,
            )
            .to_image();

            let final_tile = image::imageops::resize(
                &cropped_processed_image,
                TILE_DIM,
                TILE_DIM,
                image::imageops::FilterType::Lanczos3,
            );
            processed_tiles.push(final_tile);
        }

        let final_image_buffer = match processed_tiles.len() {
            1 => processed_tiles.remove(0),
            2 => {
                let mut canvas = RgbImage::new(TILE_DIM * 2, TILE_DIM);
                image::imageops::overlay(&mut canvas, &processed_tiles[0], 0, 0);
                image::imageops::overlay(&mut canvas, &processed_tiles[1], TILE_DIM as i64, 0);
                canvas
            }
            4 => {
                let mut canvas = RgbImage::new(TILE_DIM * 2, TILE_DIM * 2);
                image::imageops::overlay(&mut canvas, &processed_tiles[0], 0, 0);
                image::imageops::overlay(&mut canvas, &processed_tiles[1], TILE_DIM as i64, 0);
                image::imageops::overlay(&mut canvas, &processed_tiles[2], 0, TILE_DIM as i64);
                image::imageops::overlay(
                    &mut canvas,
                    &processed_tiles[3],
                    TILE_DIM as i64,
                    TILE_DIM as i64,
                );
                canvas
            }
            _ => continue,
        };

        let mut buf = Cursor::new(Vec::new());
        if final_image_buffer
            .write_with_encoder(JpegEncoder::new_with_quality(&mut buf, 75))
            .is_ok()
        {
            results.insert(preset.name.clone(), buf.into_inner());
        }
    }

    Ok(results)
}


// -------- 图库子域命令重导出（body 位于各源模块） --------
pub use crate::culling::cull_images;
pub use crate::file_management::{
    add_to_album, get_album_images, get_albums, get_folder_children, get_folder_tree,
    get_or_create_internal_library_root, get_pinned_folder_trees, get_supported_file_types,
    handle_export_presets_to_file, handle_import_legacy_presets_from_file,
    handle_import_presets_from_file, handle_import_presets_from_files, list_images_in_dir,
    list_images_recursive, load_presets, save_albums, save_community_preset, save_presets,
};
pub use crate::lut_processing::{
    generate_lut_previews, import_luts, list_luts, load_and_parse_lut, remove_lut,
};
pub use crate::tagging::{
    add_tag_for_paths, clear_ai_tags, clear_all_tags, remove_tag_for_paths,
    start_background_indexing,
};

// W5-E1: 本文件命令为 pub，tauri 宏自动生成 pub use；跨模块命令宏按定义路径重导出。
pub use super::super::culling::{
    __cmd__cull_images, __tauri_command_name_cull_images,
};
pub use super::super::file_management::library_scan::{
    __cmd__add_to_album, __cmd__get_album_images, __cmd__get_albums, __cmd__get_folder_children,
    __cmd__get_folder_tree, __cmd__get_or_create_internal_library_root,
    __cmd__get_pinned_folder_trees, __cmd__get_supported_file_types,
    __cmd__handle_export_presets_to_file, __cmd__handle_import_legacy_presets_from_file,
    __cmd__handle_import_presets_from_file, __cmd__handle_import_presets_from_files,
    __cmd__list_images_in_dir, __cmd__list_images_recursive, __cmd__load_presets,
    __cmd__save_albums, __cmd__save_community_preset, __cmd__save_presets,
    __tauri_command_name_add_to_album, __tauri_command_name_get_album_images,
    __tauri_command_name_get_albums, __tauri_command_name_get_folder_children,
    __tauri_command_name_get_folder_tree, __tauri_command_name_get_or_create_internal_library_root,
    __tauri_command_name_get_pinned_folder_trees, __tauri_command_name_get_supported_file_types,
    __tauri_command_name_handle_export_presets_to_file,
    __tauri_command_name_handle_import_legacy_presets_from_file,
    __tauri_command_name_handle_import_presets_from_file,
    __tauri_command_name_handle_import_presets_from_files,
    __tauri_command_name_list_images_in_dir, __tauri_command_name_list_images_recursive,
    __tauri_command_name_load_presets, __tauri_command_name_save_albums,
    __tauri_command_name_save_community_preset, __tauri_command_name_save_presets,
};
pub use super::super::lut_processing::{
    __cmd__generate_lut_previews, __cmd__import_luts, __cmd__list_luts, __cmd__load_and_parse_lut,
    __cmd__remove_lut, __tauri_command_name_generate_lut_previews,
    __tauri_command_name_import_luts, __tauri_command_name_list_luts,
    __tauri_command_name_load_and_parse_lut, __tauri_command_name_remove_lut,
};
pub use super::super::tagging::{
    __cmd__add_tag_for_paths, __cmd__clear_ai_tags, __cmd__clear_all_tags,
    __cmd__remove_tag_for_paths, __cmd__start_background_indexing,
    __tauri_command_name_add_tag_for_paths, __tauri_command_name_clear_ai_tags,
    __tauri_command_name_clear_all_tags, __tauri_command_name_remove_tag_for_paths,
    __tauri_command_name_start_background_indexing,
};
