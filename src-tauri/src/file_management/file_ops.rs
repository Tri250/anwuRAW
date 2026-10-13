//! W5-E2 自 file_management.rs 四拆（此域：文件操作域：复制/移动/删除/重命名/去重/导入。）。
//! 原文件共享管线经 mod.rs 重导出，路径与拆分前完全一致。

use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use anyhow::Result;
use chrono::{DateTime, Utc};
use tauri::{AppHandle, Emitter};
use uuid::Uuid;
use crate::exif_processing;
use crate::formats::is_supported_image_file;
use crate::image_processing::ImageMetadata;

use super::*;

#[tauri::command]
pub fn create_folder(path: String) -> Result<(), String> {
    let path_obj = Path::new(&path);
    if let (Some(parent), Some(new_folder_name_os)) = (path_obj.parent(), path_obj.file_name())
        && let Some(new_folder_name) = new_folder_name_os.to_str()
        && parent.exists()
    {
        for entry in fs::read_dir(parent).map_err(|e| e.to_string())? {
            if let Ok(entry) = entry
                && entry.file_name().to_string_lossy().to_lowercase()
                    == new_folder_name.to_lowercase()
            {
                return Err("A folder with that name already exists.".to_string());
            }
        }
    }
    fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_folder(path: String, new_name: String, app_handle: AppHandle) -> Result<(), String> {
    let p = Path::new(&path);
    if !p.is_dir() {
        return Err("Path is not a directory.".to_string());
    }
    if let Some(parent) = p.parent() {
        for entry in fs::read_dir(parent).map_err(|e| e.to_string())? {
            if let Ok(entry) = entry
                && entry.file_name().to_string_lossy().to_lowercase() == new_name.to_lowercase()
                && entry.path() != p
            {
                return Err("A folder with that name already exists.".to_string());
            }
        }
        let new_path = parent.join(&new_name);
        fs::rename(p, &new_path).map_err(|e| e.to_string())?;

        let new_folder_str = new_path.to_string_lossy().into_owned();
        sync_album_path_changes(&app_handle, None, None, Some((&path, &new_folder_str)));

        Ok(())
    } else {
        Err("Could not determine parent directory.".to_string())
    }
}

#[tauri::command]
pub fn delete_folder(path: String, app_handle: AppHandle) -> Result<(), String> {
    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    {
        if let Err(trash_error) = trash::delete(&path) {
            log::warn!(
                "Failed to move folder to trash: {}. Falling back to permanent delete.",
                trash_error
            );
            fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
        }
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    {
        fs::remove_dir_all(&path).map_err(|e| e.to_string())?;
    }

    let mut deletions = HashSet::new();
    deletions.insert(path);
    sync_album_path_changes(&app_handle, None, Some(&deletions), None);

    Ok(())
}

#[tauri::command]
pub fn duplicate_file(
    path: String,
    target_album_id: Option<String>,
    app_handle: AppHandle,
) -> Result<String, String> {
    let (source_path, source_sidecar_path) = parse_virtual_path(&path);
    if !source_path.is_file() {
        return Err("Source path is not a file.".to_string());
    }

    let parent = source_path
        .parent()
        .ok_or("Could not get parent directory")?;
    let stem = source_path
        .file_stem()
        .and_then(|s| s.to_str())
        .ok_or("Could not get file stem")?;
    let extension = source_path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("");

    let mut counter = 1;
    let mut dest_path;
    loop {
        let new_stem = if counter == 1 {
            format!("{}_copy", stem)
        } else {
            format!("{}_copy_{}", stem, counter - 1)
        };
        dest_path = parent.join(format!("{}.{}", new_stem, extension));
        if !dest_path.exists() {
            break;
        }
        counter += 1;
    }

    fs::copy(&source_path, &dest_path).map_err(|e| e.to_string())?;

    if source_sidecar_path.exists()
        && let Some(dest_str) = dest_path.to_str()
    {
        let (_, dest_sidecar_path) = parse_virtual_path(dest_str);
        fs::copy(&source_sidecar_path, &dest_sidecar_path).map_err(|e| e.to_string())?;
    }

    let mut source_rrexif_name = source_path.file_name().unwrap().to_os_string();
    source_rrexif_name.push(".rrexif");
    let source_rrexif = source_path.with_file_name(source_rrexif_name);

    if source_rrexif.exists() {
        let mut dest_rrexif_name = dest_path.file_name().unwrap().to_os_string();
        dest_rrexif_name.push(".rrexif");
        let dest_rrexif = dest_path.with_file_name(dest_rrexif_name);
        let _ = fs::copy(&source_rrexif, &dest_rrexif);
    }

    let dest_path_str = dest_path.to_string_lossy().into_owned();

    if let Some(album_id) = target_album_id {
        let _ = add_to_album(album_id, vec![dest_path_str.clone()], app_handle);
    }

    Ok(dest_path_str)
}

fn find_all_associated_files(source_image_path: &Path) -> Result<Vec<PathBuf>, String> {
    let mut associated_files = vec![source_image_path.to_path_buf()];

    let mut rrexif_name = source_image_path
        .file_name()
        .unwrap_or_default()
        .to_os_string();
    rrexif_name.push(".rrexif");
    let rrexif_path = source_image_path.with_file_name(rrexif_name);

    if rrexif_path.exists() {
        associated_files.push(rrexif_path);
    }

    let parent_dir = source_image_path
        .parent()
        .ok_or("Could not determine parent directory")?;
    let source_filename = source_image_path
        .file_name()
        .ok_or("Could not get source filename")?
        .to_string_lossy();

    let primary_sidecar_name = format!("{}.rrdata", source_filename);
    let virtual_copy_prefix = format!("{}.", source_filename);

    if let Ok(entries) = fs::read_dir(parent_dir) {
        for entry in entries.filter_map(Result::ok) {
            let entry_path = entry.path();
            if !entry_path.is_file() {
                continue;
            }

            let entry_os_filename = entry.file_name();
            let entry_filename = entry_os_filename.to_string_lossy();

            if entry_filename == primary_sidecar_name
                || (entry_filename.starts_with(&virtual_copy_prefix)
                    && entry_filename.ends_with(".rrdata"))
            {
                associated_files.push(entry_path);
            }
        }
    }

    Ok(associated_files)
}

#[tauri::command]
pub fn copy_files(source_paths: Vec<String>, destination_folder: String) -> Result<(), String> {
    let dest_path = Path::new(&destination_folder);
    if !dest_path.is_dir() {
        return Err(format!(
            "Destination is not a folder: {}",
            destination_folder
        ));
    }

    let unique_source_images: HashSet<PathBuf> = source_paths
        .iter()
        .map(|p| parse_virtual_path(p).0)
        .collect();

    let mut operations_to_perform = Vec::new();

    for source_image_path in &unique_source_images {
        let all_files_to_copy = find_all_associated_files(source_image_path)?;

        let source_parent = source_image_path
            .parent()
            .ok_or("Could not get parent directory")?;

        if source_parent == dest_path {
            let stem = source_image_path
                .file_stem()
                .and_then(|s| s.to_str())
                .ok_or("Could not get file stem")?;
            let extension = source_image_path
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("");

            let mut counter = 1;
            let new_base_path = loop {
                let new_stem = format!("{}_copy_{}", stem, counter);
                let temp_path = source_parent.join(format!("{}.{}", new_stem, extension));
                if !temp_path.exists() {
                    break temp_path;
                }
                counter += 1;
            };
            let new_filename = new_base_path.file_name().unwrap().to_string_lossy();

            for original_file in all_files_to_copy {
                let original_full_filename = original_file.file_name().unwrap().to_string_lossy();
                let source_base_filename = source_image_path.file_name().unwrap().to_string_lossy();
                let new_dest_filename =
                    original_full_filename.replacen(&*source_base_filename, &new_filename, 1);

                let final_dest_path = dest_path.join(new_dest_filename);
                operations_to_perform.push((original_file, final_dest_path));
            }
        } else {
            for file_to_copy in all_files_to_copy {
                if let Some(file_name) = file_to_copy.file_name() {
                    let dest_file_path = dest_path.join(file_name);

                    if dest_file_path.exists() {
                        return Err(format!(
                            "Copy aborted: File already exists at destination: {}",
                            dest_file_path.display()
                        ));
                    }

                    operations_to_perform.push((file_to_copy, dest_file_path));
                }
            }
        }
    }

    for (source, dest) in operations_to_perform {
        fs::copy(&source, &dest)
            .map_err(|e| format!("Copy failed for {}: {}", source.display(), e))?;
    }

    Ok(())
}

#[tauri::command]
pub fn move_files(
    source_paths: Vec<String>,
    destination_folder: String,
    app_handle: AppHandle,
) -> Result<(), String> {
    let dest_path = Path::new(&destination_folder);
    if !dest_path.is_dir() {
        return Err(format!(
            "Destination is not a folder: {}",
            destination_folder
        ));
    }

    let unique_source_images: HashSet<PathBuf> = source_paths
        .iter()
        .map(|p| parse_virtual_path(p).0)
        .collect();

    let mut operations_to_perform = Vec::new();
    let mut renames = HashMap::new();

    for source_image_path in &unique_source_images {
        let source_parent = source_image_path
            .parent()
            .ok_or("Could not get parent directory")?;

        if source_parent == dest_path {
            return Err("Cannot move files into the same folder they are already in.".to_string());
        }

        let all_files_to_move = find_all_associated_files(source_image_path)?;

        for file_to_move in &all_files_to_move {
            if let Some(file_name) = file_to_move.file_name() {
                let dest_file_path = dest_path.join(file_name);

                if dest_file_path.exists() {
                    return Err(format!(
                        "Move aborted: File already exists at destination: {}",
                        dest_file_path.display()
                    ));
                }

                operations_to_perform.push((file_to_move.clone(), dest_file_path));
            }
        }

        let dest_image_path = dest_path.join(source_image_path.file_name().unwrap());
        renames.insert(
            source_image_path.to_string_lossy().into_owned(),
            dest_image_path.to_string_lossy().into_owned(),
        );
    }

    for (source, dest) in operations_to_perform {
        if fs::rename(&source, &dest).is_err() {
            fs::copy(&source, &dest)
                .map_err(|e| format!("Move failed during copy for {}: {}", source.display(), e))?;

            if let Err(e) = fs::remove_file(&source) {
                log::warn!(
                    "Moved file successfully, but failed to delete original {}: {}",
                    source.display(),
                    e
                );
            }
        }
    }

    sync_album_path_changes(&app_handle, Some(&renames), None, None);

    Ok(())

}

#[tauri::command]
pub fn show_in_finder(path: String) -> Result<(), String> {
    let (source_path, _) = parse_virtual_path(&path);

    #[cfg(target_os = "windows")]
    {
        let source_path_str = source_path.to_string_lossy().to_string();
        Command::new("explorer")
            .args(["/select,", &source_path_str])
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "macos")]
    {
        let source_path_str = source_path.to_string_lossy().to_string();
        Command::new("open")
            .args(["-R", &source_path_str])
            .spawn()
            .map_err(|e| e.to_string())?;
    }

    #[cfg(target_os = "linux")]
    {
        if let Some(parent) = source_path.parent() {
            Command::new("xdg-open")
                .arg(parent)
                .spawn()
                .map_err(|e| e.to_string())?;
        } else {
            return Err("Could not get parent directory".into());
        }
    }

    #[cfg(target_os = "android")]
    {
        return Err("Show in File Manager is not natively supported via CLI on Android.".into());
    }

    #[cfg(target_os = "ios")]
    {
        return Err("Show in File Manager is not supported on iOS.".into());
    }

    Ok(())
}

#[tauri::command]
pub fn delete_files_from_disk(paths: Vec<String>, app_handle: AppHandle) -> Result<(), String> {
    let mut files_to_trash = HashSet::new();
    let mut deletions = HashSet::new();

    for path_str in paths {
        let (source_path, sidecar_path) = parse_virtual_path(&path_str);
        deletions.insert(path_str.clone());

        if path_str.contains("?vc=") {
            if sidecar_path.exists() {
                files_to_trash.insert(sidecar_path);
            }
        } else {
            if source_path.exists() {
                match find_all_associated_files(&source_path) {
                    Ok(associated_files) => {
                        for file in associated_files {
                            files_to_trash.insert(file);
                        }
                    }
                    Err(e) => {
                        log::warn!(
                            "Could not find associated files for {}: {}",
                            source_path.display(),
                            e
                        );
                    }
                }
            }
        }
    }

    if files_to_trash.is_empty() {
        return Ok(());
    }

    let final_paths_to_delete: Vec<PathBuf> = files_to_trash.into_iter().collect();

    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    if let Err(trash_error) = trash::delete_all(&final_paths_to_delete) {
        log::warn!(
            "Failed to move files to trash: {}. Falling back to permanent delete.",
            trash_error
        );
        for path in final_paths_to_delete {
            if path.is_file() {
                if let Err(e) = fs::remove_file(&path) {
                    log::warn!("Failed to delete file {}: {}", path.display(), e);
                }
            } else if path.is_dir()
                && let Err(e) = fs::remove_dir_all(&path)
            {
                log::warn!("Failed to delete directory {}: {}", path.display(), e);
            }
        }
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    for path in final_paths_to_delete {
        if path.is_file() {
            if let Err(e) = fs::remove_file(&path) {
                log::warn!("Failed to delete file {}: {}", path.display(), e);
            }
        } else if path.is_dir() {
            if let Err(e) = fs::remove_dir_all(&path) {
                log::warn!("Failed to delete directory {}: {}", path.display(), e);
            }
        }
    }

    sync_album_path_changes(&app_handle, None, Some(&deletions), None);

    Ok(())
}

#[tauri::command]
pub fn delete_files_with_associated(
    paths: Vec<String>,
    app_handle: AppHandle,
) -> Result<(), String> {
    if paths.is_empty() {
        return Ok(());
    }

    let mut files_to_trash = HashSet::new();
    let mut deletions = HashSet::new();

    for path_str in &paths {
        deletions.insert(path_str.clone());
        let (source_path, _) = parse_virtual_path(path_str);
        match find_all_associated_files(&source_path) {
            Ok(associated) => {
                for file in associated {
                    files_to_trash.insert(file);
                }
            }
            Err(e) => {
                log::warn!(
                    "Could not find associated files for {}: {}",
                    source_path.display(),
                    e
                );
            }
        }
    }

    if files_to_trash.is_empty() {
        return Ok(());
    }

    let final_paths_to_delete: Vec<PathBuf> = files_to_trash.into_iter().collect();

    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
    if let Err(trash_error) = trash::delete_all(&final_paths_to_delete) {
        log::warn!(
            "Failed to move files to trash: {}. Falling back to permanent delete.",
            trash_error
        );
        for path in final_paths_to_delete {
            if path.is_file()
                && let Err(e) = fs::remove_file(&path)
            {
                log::warn!("Failed to delete file {}: {}", path.display(), e);
            }
        }
    }

    #[cfg(not(any(target_os = "windows", target_os = "macos", target_os = "linux")))]
    for path in final_paths_to_delete {
        if path.is_file() {
            if let Err(e) = fs::remove_file(&path) {
                log::warn!("Failed to delete file {}: {}", path.display(), e);
            }
        }
    }

    sync_album_path_changes(&app_handle, None, Some(&deletions), None);

    Ok(())

}

#[tauri::command]
pub async fn import_files(
    source_paths: Vec<String>,
    destination_folder: String,
    settings: ImportSettings,
    app_handle: AppHandle,
) -> Result<(), String> {
    let total_files = source_paths.len();
    let _ = app_handle.emit("import-start", serde_json::json!({ "total": total_files }));

    tauri::async_runtime::spawn_blocking(move || {
        for (i, source_path_str) in source_paths.iter().enumerate() {
            let _ = app_handle.emit(
                "import-progress",
                serde_json::json!({ "current": i, "total": total_files, "path": source_path_str }),
            );

            let import_result: Result<(), String> = (|| {
                #[cfg(target_os = "android")]
                if is_android_content_uri(source_path_str) {
                    let resolved_name = resolve_android_content_uri_name(source_path_str)?;
                    let source_bytes = read_android_content_uri(source_path_str)?;
                    let source_name_path = Path::new(&resolved_name);
                    let file_date = exif_processing::get_creation_date_from_bytes(
                        &resolved_name,
                        &source_bytes,
                    );

                    let mut final_dest_folder = PathBuf::from(&destination_folder);
                    if settings.organize_by_date {
                        let date_format_str = settings
                            .date_folder_format
                            .replace("YYYY", "%Y")
                            .replace("MM", "%m")
                            .replace("DD", "%d");
                        let subfolder = file_date.format(&date_format_str).to_string();
                        final_dest_folder.push(subfolder);
                    }

                    fs::create_dir_all(&final_dest_folder)
                        .map_err(|e| format!("Failed to create destination folder: {}", e))?;

                    let new_stem = generate_filename_from_template(
                        &settings.filename_template,
                        source_name_path,
                        i + 1,
                        total_files,
                        &file_date,
                    );
                    let extension = source_name_path
                        .extension()
                        .and_then(|s| s.to_str())
                        .unwrap_or("");
                    let new_filename = format!("{}.{}", new_stem, extension);
                    let dest_file_path = final_dest_folder.join(new_filename);

                    if dest_file_path.exists() {
                        return Err(format!(
                            "File already exists at destination: {}",
                            dest_file_path.display()
                        ));
                    }

                    fs::write(&dest_file_path, source_bytes).map_err(|e| e.to_string())?;

                    if settings.delete_after_import {
                        log::info!(
                            "Skipping delete_after_import for Android content URI source: {}",
                            source_path_str
                        );
                    }

                    return Ok(());
                }

                let (source_path, source_sidecar) = parse_virtual_path(source_path_str);
                if !source_path.exists() {
                    return Err(format!("Source file not found: {}", source_path_str));
                }

                let file_date = exif_processing::get_creation_date_from_path(&source_path);

                let mut final_dest_folder = PathBuf::from(&destination_folder);
                if settings.organize_by_date {
                    let date_format_str = settings
                        .date_folder_format
                        .replace("YYYY", "%Y")
                        .replace("MM", "%m")
                        .replace("DD", "%d");
                    let subfolder = file_date.format(&date_format_str).to_string();
                    final_dest_folder.push(subfolder);
                }

                fs::create_dir_all(&final_dest_folder)
                    .map_err(|e| format!("Failed to create destination folder: {}", e))?;

                let new_stem = generate_filename_from_template(
                    &settings.filename_template,
                    &source_path,
                    i + 1,
                    total_files,
                    &file_date,
                );
                let extension = source_path
                    .extension()
                    .and_then(|s| s.to_str())
                    .unwrap_or("");
                let new_filename = format!("{}.{}", new_stem, extension);
                let dest_file_path = final_dest_folder.join(new_filename);

                if dest_file_path.exists() {
                    return Err(format!(
                        "File already exists at destination: {}",
                        dest_file_path.display()
                    ));
                }

                fs::copy(&source_path, &dest_file_path).map_err(|e| e.to_string())?;
                if source_sidecar.exists()
                    && let Some(dest_str) = dest_file_path.to_str()
                {
                    let (_, dest_sidecar) = parse_virtual_path(dest_str);
                    fs::copy(&source_sidecar, &dest_sidecar).map_err(|e| e.to_string())?;
                }

                let mut source_rrexif_name = source_path.file_name().unwrap().to_os_string();
                source_rrexif_name.push(".rrexif");
                let source_rrexif = source_path.with_file_name(source_rrexif_name);

                if source_rrexif.exists() {
                    let mut dest_rrexif_name = dest_file_path.file_name().unwrap().to_os_string();
                    dest_rrexif_name.push(".rrexif");
                    let dest_rrexif = dest_file_path.with_file_name(dest_rrexif_name);
                    let _ = fs::copy(&source_rrexif, &dest_rrexif);
                }

                if settings.delete_after_import {
                    #[cfg(any(target_os = "windows", target_os = "macos", target_os = "linux"))]
                    {
                        if let Err(trash_error) = trash::delete(&source_path) {
                            log::warn!(
                                "Failed to trash source file {}: {}. Deleting permanently.",
                                source_path.display(),
                                trash_error
                            );
                            fs::remove_file(&source_path).map_err(|e| e.to_string())?;
                        }
                        if source_sidecar.exists()
                            && let Err(trash_error) = trash::delete(&source_sidecar)
                        {
                            log::warn!(
                                "Failed to trash source sidecar {}: {}. Deleting permanently.",
                                source_sidecar.display(),
                                trash_error
                            );
                            fs::remove_file(&source_sidecar).map_err(|e| e.to_string())?;
                        }
                    }

                    #[cfg(not(any(
                        target_os = "windows",
                        target_os = "macos",
                        target_os = "linux"
                    )))]
                    {
                        fs::remove_file(&source_path).map_err(|e| e.to_string())?;
                        if source_sidecar.exists() {
                            fs::remove_file(&source_sidecar).map_err(|e| e.to_string())?;
                        }
                        if source_rrexif.exists() {
                            let _ = fs::remove_file(&source_rrexif);
                        }
                    }
                }

                Ok(())
            })();

            if let Err(e) = import_result {
                eprintln!("Failed to import {}: {}", source_path_str, e);
                let _ = app_handle.emit("import-error", e);
                continue;
            }
        }

        let _ = app_handle.emit(
            "import-progress",
            serde_json::json!({ "current": total_files, "total": total_files, "path": "" }),
        );
        let _ = app_handle.emit("import-complete", ());
    });

    Ok(())
}

pub fn generate_filename_from_template(
    template: &str,
    original_path: &std::path::Path,
    sequence: usize,
    total: usize,
    file_date: &DateTime<Utc>,
) -> String {
    let stem = original_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("image");
    let sequence_str = format!(
        "{:0width$}",
        sequence,
        width = total.to_string().len().max(1)
    );
    let local_date = file_date.with_timezone(&chrono::Local);

    // 路径安全：过滤用户可控模板里的路径分隔符，防止 ../ 和 \\ 穿越
    let template: String = template
        .chars()
        .map(|c| if c == '/' || c == '\\' { '_' } else { c })
        .collect();
    let template_has_sequence = template.contains("{sequence}");

    let mut result = template;
    result = result.replace("{original_filename}", stem);
    result = result.replace("{sequence}", &sequence_str);
    result = result.replace("{YYYY}", &local_date.format("%Y").to_string());
    result = result.replace("{MM}", &local_date.format("%m").to_string());
    result = result.replace("{DD}", &local_date.format("%d").to_string());
    result = result.replace("{hh}", &local_date.format("%H").to_string());
    result = result.replace("{mm}", &local_date.format("%M").to_string());

    // 多图场景安全兜底：模板未显式包含 {sequence} 时自动追加序号，
    // 防止不同目录同名文件导出到同一目标时静默覆盖。
    // 单图场景 (total<=1) 保持用户原始意图不追加。
    if total > 1 && !template_has_sequence {
        result = format!("{}_{}", result, sequence_str);
    }

    result
}

#[tauri::command]
pub fn rename_files(
    paths: Vec<String>,
    name_template: String,
    app_handle: AppHandle,
) -> Result<Vec<String>, String> {
    if paths.is_empty() {
        return Ok(Vec::new());
    }

    let mut operations: Vec<(PathBuf, PathBuf)> = Vec::new();
    let mut final_new_paths = Vec::with_capacity(paths.len());
    let mut renames = HashMap::new();

    for (i, path_str) in paths.iter().enumerate() {
        let (original_path, _) = parse_virtual_path(path_str);
        if !original_path.exists() {
            return Err(format!("File not found: {}", path_str));
        }

        let parent = original_path
            .parent()
            .ok_or("Could not get parent directory")?;
        let extension = original_path
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("");

        let file_date = exif_processing::get_creation_date_from_path(&original_path);

        let new_stem = generate_filename_from_template(
            &name_template,
            &original_path,
            i + 1,
            paths.len(),
            &file_date,
        );
        let new_filename = format!("{}.{}", new_stem, extension);
        let new_path = parent.join(new_filename);

        if new_path.exists() && new_path != original_path {
            return Err(format!(
                "A file with the name {} already exists.",
                new_path.display()
            ));
        }

        operations.push((original_path, new_path));
    }

    let mut sidecar_operations: Vec<(PathBuf, PathBuf)> = Vec::new();
    for (original_path, new_path) in &operations {
        let parent = original_path
            .parent()
            .ok_or("Could not get parent directory")?;
        let original_filename_str = original_path.file_name().unwrap().to_string_lossy();
        let new_filename_str = new_path.file_name().unwrap().to_string_lossy();

        if let Ok(entries) = fs::read_dir(parent) {
            for entry in entries.filter_map(Result::ok) {
                let entry_path = entry.path();
                let entry_os_filename = entry.file_name();
                let entry_filename = entry_os_filename.to_string_lossy();

                if entry_filename.starts_with(&format!("{}.", original_filename_str))
                    && entry_filename.ends_with(".rrdata")
                {
                    let new_sidecar_filename =
                        entry_filename.replacen(&*original_filename_str, &new_filename_str, 1);
                    let new_sidecar_path = parent.join(new_sidecar_filename);
                    sidecar_operations.push((entry_path, new_sidecar_path));
                } else if entry_filename == format!("{}.rrdata", original_filename_str) {
                    let mut new_sidecar_name = new_path.file_name().unwrap().to_os_string();
                    new_sidecar_name.push(".rrdata");
                    let new_sidecar_path = new_path.with_file_name(new_sidecar_name);

                    sidecar_operations.push((entry_path, new_sidecar_path));
                }
            }
        }

        let mut old_rrexif_name = original_path.file_name().unwrap().to_os_string();
        old_rrexif_name.push(".rrexif");
        let old_rrexif = original_path.with_file_name(old_rrexif_name);

        if old_rrexif.exists() {
            let mut new_rrexif_name = new_path.file_name().unwrap().to_os_string();
            new_rrexif_name.push(".rrexif");
            let new_rrexif = new_path.with_file_name(new_rrexif_name);
            sidecar_operations.push((old_rrexif, new_rrexif));
        }
    }
    operations.extend(sidecar_operations);

    for (old_path, new_path) in operations {
        if let Err(e) = fs::rename(&old_path, &new_path) {
            log::warn!(
                "Failed to rename {} to {}: {}",
                old_path.display(),
                new_path.display(),
                e
            );
            continue;
        }

        let old_str = old_path.to_string_lossy().into_owned();
        let new_str = new_path.to_string_lossy().into_owned();

        renames.insert(old_str, new_str.clone());

        if is_supported_image_file(&new_path) {
            final_new_paths.push(new_str);
        }
    }

    sync_album_path_changes(&app_handle, Some(&renames), None, None);

    Ok(final_new_paths)
}

#[tauri::command]
pub fn create_virtual_copy(
    source_virtual_path: String,
    target_album_id: Option<String>,
    app_handle: AppHandle,
) -> Result<String, String> {
    let (source_path, source_sidecar_path) = parse_virtual_path(&source_virtual_path);

    let new_copy_id = Uuid::new_v4().to_string()[..6].to_string();
    let new_virtual_path = format!("{}?vc={}", source_path.to_string_lossy(), new_copy_id);
    let (_, new_sidecar_path) = parse_virtual_path(&new_virtual_path);

    if source_sidecar_path.exists() {
        fs::copy(&source_sidecar_path, &new_sidecar_path)
            .map_err(|e| format!("Failed to copy sidecar file: {}", e))?;
    } else {
        let default_metadata = ImageMetadata::default();
        let json_string =
            serde_json::to_string_pretty(&default_metadata).map_err(|e| e.to_string())?;
        fs::write(new_sidecar_path, json_string).map_err(|e| e.to_string())?;
    }

    if let Some(album_id) = target_album_id {
        let _ = add_to_album(album_id, vec![new_virtual_path.clone()], app_handle);
    }

    Ok(new_virtual_path)
}

