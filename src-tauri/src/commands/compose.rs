//! W5-E1 合成域命令：HDR 合并/全景拼接/焦点堆栈/拼贴保存。

use std::fs;
use std::io::Cursor;

use base64::{Engine as _, engine::general_purpose};
use image::{DynamicImage, ImageFormat};
use image_hdr::hdr_merge_images;
use image_hdr::input::HDRInput;
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};

use crate::AppState;
use crate::app_settings::*;
use crate::compose_queue::{ComposeJobHandle, ComposeModality};
use crate::file_management::{parse_virtual_path, read_file_mapped};
use crate::hdr_deghosting::{align_hdr_frames, assert_uniform_dimensions, load_hdr_frames};
use crate::image_loader::{composite_patches_on_image, load_and_composite};
use crate::image_processing::{
    RenderRequest, apply_linear_to_srgb, get_all_adjustments_from_json, get_or_init_gpu_context,
    process_and_get_dynamic_image, resolve_tonemapper_override,
};
use crate::mask_generation::{MaskDefinition, get_cached_or_generate_mask};

#[tauri::command]
pub async fn merge_hdr(
    paths: Vec<String>,
    app_handle: tauri::AppHandle,
    state: tauri::State<'_, AppState>,
) -> Result<(), String> {
    if paths.len() < 2 {
        return Err("Please select at least two images to merge.".to_string());
    }

    let hdr_result_handle = state.hdr_result.clone();
    let settings = load_settings(app_handle.clone()).unwrap_or_default();

    // W8-H3: 统一 ComposeJob 协议（进度/取消/落账）
    let job = ComposeJobHandle::begin(
        &state.compose_job_manager,
        ComposeModality::Hdr,
        paths.clone(),
    );

    let job_task = job.clone();
    let task = tokio::task::spawn_blocking(move || -> Result<(), String> {
        let report = {
            let ah = app_handle.clone();
            let job = &job_task;
            move |msg: &str| {
                let _ = ah.emit("hdr-progress", msg);
                job.message(msg);
            }
        };

        job_task.phase("load");
        let mut frames = load_hdr_frames(&paths, &settings, &report, &job_task.cancel)?;
        assert_uniform_dimensions(&frames)?;

        job_task.phase("align");
        align_hdr_frames(&mut frames, &report, &job_task.cancel)?;
        job_task.checkpoint()?;

        let images: Vec<HDRInput> = frames
            .iter()
            .map(|(path, img, exposure, gains)| {
                HDRInput::with_image(img, *exposure, *gains)
                    .map_err(|e| format!("Failed to prepare HDR input for {}: {}", path, e))
            })
            .collect::<Result<Vec<HDRInput>, String>>()?;

        job_task.phase("merge");
        log::info!("Starting HDR merge of {} images", images.len());
        let mut hdr_merged = hdr_merge_images(&mut images.into()).map_err(|e| e.to_string())?;
        hdr_merged =
            image_hdr::stretch::apply_histogram_stretch(&hdr_merged).map_err(|e| e.to_string())?;
        hdr_merged = apply_linear_to_srgb(hdr_merged);
        log::info!("HDR merge completed");
        job_task.checkpoint()?;

        job_task.phase("preview");
        let _ = app_handle.emit("hdr-progress", "Creating preview...");
        let mut buf = Cursor::new(Vec::new());
        if let Err(e) = hdr_merged.to_rgb8().write_to(&mut buf, ImageFormat::Png) {
            return Err(format!("Failed to encode hdr preview: {}", e));
        }

        let base64_str = general_purpose::STANDARD.encode(buf.get_ref());
        let final_base64 = format!("data:image/png;base64,{}", base64_str);

        *hdr_result_handle.lock().unwrap_or_else(|e| e.into_inner()) = Some(hdr_merged);

        let _ = app_handle.emit(
            "hdr-complete",
            serde_json::json!({
                "base64": final_base64,
            }),
        );
        Ok(())
    });

    let result = match task.await {
        Ok(r) => r,
        Err(e) => Err(format!("Task failed: {}", e)),
    };
    job.finalize(&result);
    result
}

// W8-H3: 合成队列命令（四模态共用协议）
#[tauri::command]
pub fn cancel_compose_job(state: tauri::State<'_, AppState>) -> Result<(), String> {
    state.compose_job_manager.cancel()
}

#[tauri::command]
pub fn get_compose_job_status(
    state: tauri::State<'_, AppState>,
) -> Option<crate::compose_queue::ComposeJobSnapshot> {
    state.compose_job_manager.snapshot()
}

#[tauri::command]
pub async fn save_hdr(
    first_path_str: String,
    output_format: Option<String>,
    state: tauri::State<'_, AppState>,
) -> Result<String, String> {
    let hdr_image = state
        .hdr_result
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .take()
        .ok_or_else(|| {
            "No hdr image found in memory to save. It might have already been saved.".to_string()
        })?;

    // W8-H2: HDR 导出扩展点 —— 显式格式（png/tiff/exr）优先，None 保持既有自适应语义
    let hdr_format = crate::export_encoders::resolve_hdr_output_format(
        &hdr_image,
        output_format.as_deref(),
    )?;
    let (extension, image_to_save) = crate::export_encoders::prepare_hdr_image(&hdr_image, hdr_format);

    let (first_path, _) = parse_virtual_path(&first_path_str);
    let parent_dir = first_path
        .parent()
        .ok_or_else(|| "Could not determine parent directory of the first image.".to_string())?;
    let stem = first_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("hdr");

    let output_filename = format!("{}_Hdr.{}", stem, extension);
    let output_path = parent_dir.join(output_filename);

    image_to_save
        .save(&output_path)
        .map_err(|e| format!("Failed to save hdr image: {}", e))?;

    let (real_path, _) = crate::file_management::parse_virtual_path(&first_path_str);
    let _ =
        crate::exif_processing::write_rrexif_sidecar(&real_path.to_string_lossy(), &output_path);

    Ok(output_path.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn save_collage(base64_data: String, first_path_str: String) -> Result<String, String> {
    let data_url_prefix = "data:image/png;base64,";
    if !base64_data.starts_with(data_url_prefix) {
        return Err("Invalid base64 data format".to_string());
    }
    let encoded_data = &base64_data[data_url_prefix.len()..];

    let decoded_bytes = general_purpose::STANDARD
        .decode(encoded_data)
        .map_err(|e| format!("Failed to decode base64: {}", e))?;

    let (first_path, _) = parse_virtual_path(&first_path_str);
    let parent_dir = first_path
        .parent()
        .ok_or_else(|| "Could not determine parent directory of the first image.".to_string())?;
    let stem = first_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("collage");

    let output_filename = format!("{}_Collage.png", stem);
    let output_path = parent_dir.join(output_filename);

    fs::write(&output_path, &decoded_bytes)
        .map_err(|e| format!("Failed to save collage image: {}", e))?;

    Ok(output_path.to_string_lossy().to_string())
}


pub use crate::focus_stacking::{save_focus_stack, stitch_focus_stack};
pub use crate::panorama_stitching::{save_panorama, stitch_panorama};

// W5-E1: 命令宏按定义路径重导出（generate_handler 经 commands::compose::<cmd> 查找）。
// 本文件命令（merge_hdr/save_hdr/save_collage）的 __cmd__ 宏由 #[tauri::command] 自动 pub use。
pub use super::super::focus_stacking::{
    __cmd__save_focus_stack, __cmd__stitch_focus_stack, __tauri_command_name_save_focus_stack,
    __tauri_command_name_stitch_focus_stack,
};
pub use super::super::panorama_stitching::{
    __cmd__save_panorama, __cmd__stitch_panorama, __tauri_command_name_save_panorama,
    __tauri_command_name_stitch_panorama,
};
