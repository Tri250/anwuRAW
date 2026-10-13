//! W5-E1 AI 域命令：模型管理/生成式蒙版/深度/修补/降噪。

pub use crate::ai_acceleration::get_active_ai_execution_provider;
pub use crate::ai_commands::{
    check_ai_connector_status, download_optional_model, generate_ai_depth_mask,
    generate_ai_foreground_mask, generate_ai_sky_mask, generate_ai_subject_mask,
    generate_full_image_depth_map, get_model_download_info, model_status_list,
    precompute_ai_subject_mask, test_ai_connector_connection,
};
pub use crate::denoising::{apply_denoising, batch_denoise_images, save_denoised_image};
pub use crate::inpainting::{
    generate_auto_erase_patch, generate_manual_cleanup_patch, generate_liquify_patch,
    generate_retouch_patch, invoke_generative_replace_with_mask_def,
};

// W5-E1: 命令宏按定义路径重导出（generate_handler 经 commands::ai::<cmd> 查找）。
pub use super::super::ai_acceleration::{
    __cmd__get_active_ai_execution_provider, __tauri_command_name_get_active_ai_execution_provider,
};
pub use super::super::ai_commands::{
    __cmd__check_ai_connector_status, __cmd__download_optional_model,
    __cmd__generate_ai_depth_mask, __cmd__generate_ai_foreground_mask, __cmd__generate_ai_sky_mask,
    __cmd__generate_ai_subject_mask, __cmd__generate_full_image_depth_map,
    __cmd__get_model_download_info, __cmd__model_status_list, __cmd__precompute_ai_subject_mask,
    __cmd__test_ai_connector_connection, __tauri_command_name_check_ai_connector_status,
    __tauri_command_name_download_optional_model, __tauri_command_name_generate_ai_depth_mask,
    __tauri_command_name_generate_ai_foreground_mask, __tauri_command_name_generate_ai_sky_mask,
    __tauri_command_name_generate_ai_subject_mask, __tauri_command_name_generate_full_image_depth_map,
    __tauri_command_name_get_model_download_info, __tauri_command_name_model_status_list,
    __tauri_command_name_precompute_ai_subject_mask,
    __tauri_command_name_test_ai_connector_connection,
};
pub use super::super::denoising::{
    __cmd__apply_denoising, __cmd__batch_denoise_images, __cmd__save_denoised_image,
    __tauri_command_name_apply_denoising, __tauri_command_name_batch_denoise_images,
    __tauri_command_name_save_denoised_image,
};
pub use super::super::inpainting::{
    __cmd__generate_auto_erase_patch, __cmd__generate_manual_cleanup_patch,
    __cmd__generate_liquify_patch, __cmd__generate_retouch_patch,
    __cmd__invoke_generative_replace_with_mask_def, __tauri_command_name_generate_auto_erase_patch,
    __tauri_command_name_generate_manual_cleanup_patch, __tauri_command_name_generate_liquify_patch,
    __tauri_command_name_generate_retouch_patch,
    __tauri_command_name_invoke_generative_replace_with_mask_def,
};
