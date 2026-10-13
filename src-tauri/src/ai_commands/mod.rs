//! AI 命令汇聚层（W7-G4 拆分：capability 蒙版能力 / management 模型管理 / connector 可选连接器）。
//!
//! 外部（commands/ai.rs 与 generate_handler）继续经 `crate::ai_commands::<cmd>` 访问，
//! 路径与拆分前完全一致。

pub mod capability;
pub mod connector;
pub mod management;

pub use capability::{
    generate_ai_depth_mask, generate_ai_foreground_mask, generate_ai_sky_mask,
    generate_ai_subject_mask, generate_full_image_depth_map, precompute_ai_subject_mask,
};
pub use connector::{check_ai_connector_status, test_ai_connector_connection};
pub use management::{ModelDownloadInfo, download_optional_model, get_model_download_info};

// W7-G4: 命令宏按定义路径重导出（generate_handler 经 commands::ai::<cmd> 查找）。
pub use capability::{
    __cmd__generate_ai_depth_mask, __cmd__generate_ai_foreground_mask, __cmd__generate_ai_sky_mask,
    __cmd__generate_ai_subject_mask, __cmd__generate_full_image_depth_map,
    __cmd__precompute_ai_subject_mask, __tauri_command_name_generate_ai_depth_mask,
    __tauri_command_name_generate_ai_foreground_mask, __tauri_command_name_generate_ai_sky_mask,
    __tauri_command_name_generate_ai_subject_mask,
    __tauri_command_name_generate_full_image_depth_map,
    __tauri_command_name_precompute_ai_subject_mask,
};
pub use connector::{
    __cmd__check_ai_connector_status, __cmd__test_ai_connector_connection,
    __tauri_command_name_check_ai_connector_status,
    __tauri_command_name_test_ai_connector_connection,
};
pub use management::{
    __cmd__download_optional_model, __cmd__get_model_download_info,
    __tauri_command_name_download_optional_model, __tauri_command_name_get_model_download_info,
};
