//! W5-E1 文件操作域命令：复制/移动/删除/重命名/导入/虚拟副本/缩略图队列/临时文件。
//! body 位于 file_management::file_ops / thumb_service。

use tempfile::NamedTempFile;
use std::io::Write;

#[tauri::command]
pub async fn save_temp_file(bytes: Vec<u8>) -> Result<String, String> {
    let mut temp_file = NamedTempFile::new().map_err(|e| e.to_string())?;
    temp_file.write_all(&bytes).map_err(|e| e.to_string())?;
    let (_file, path) = temp_file.keep().map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().to_string())
}

pub use crate::file_management::{
    clear_thumbnail_cache, copy_files, create_folder, create_virtual_copy, delete_files_from_disk,
    delete_files_with_associated, delete_folder, duplicate_file, import_files, move_files,
    rename_files, rename_folder, show_in_finder, update_thumbnail_queue,
};

// W5-E1: 本文件命令为 pub，tauri 宏自动生成 pub use；跨模块命令宏按定义路径重导出。
pub use super::super::file_management::file_ops::{
    __cmd__copy_files, __cmd__create_folder, __cmd__create_virtual_copy,
    __cmd__delete_files_from_disk, __cmd__delete_files_with_associated, __cmd__delete_folder,
    __cmd__duplicate_file, __cmd__import_files, __cmd__move_files, __cmd__rename_files,
    __cmd__rename_folder, __cmd__show_in_finder, __tauri_command_name_copy_files,
    __tauri_command_name_create_folder, __tauri_command_name_create_virtual_copy,
    __tauri_command_name_delete_files_from_disk, __tauri_command_name_delete_files_with_associated,
    __tauri_command_name_delete_folder, __tauri_command_name_duplicate_file,
    __tauri_command_name_import_files, __tauri_command_name_move_files,
    __tauri_command_name_rename_files, __tauri_command_name_rename_folder,
    __tauri_command_name_show_in_finder,
};
pub use super::super::file_management::thumb_service::{
    __cmd__clear_thumbnail_cache, __cmd__update_thumbnail_queue,
    __tauri_command_name_clear_thumbnail_cache, __tauri_command_name_update_thumbnail_queue,
};
