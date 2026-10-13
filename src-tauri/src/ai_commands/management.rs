//! W7-G4 AI 模型管理命令：下载状态查询 / 可选模型显式下载（不做后台自动下载）。
//! W9-I4 模型状态中心：全量三态清单（Missing/Intact/Corrupted）。

use crate::ai_processing::{download_entry, endpoints_from_handle, get_models_dir};

/// 模型下载状态信息（体积预估确认框 / 状态可视化数据层）
#[derive(serde::Serialize)]
pub struct ModelDownloadInfo {
    pub id: String,
    pub display_name: String,
    pub size_bytes: Option<u64>,
    pub downloaded: bool,
    pub optional: bool,
}

/// 模型状态中心条目（W9-I4）：manifest × 本地三态，UI 直接消费
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatusEntry {
    pub model_id: String,
    pub display_name: String,
    pub purpose: String,
    pub filename: String,
    pub size_bytes: Option<u64>,
    pub optional: bool,
    /// missing | intact | corrupted
    pub state: String,
}

/// 全量模型状态清单：integrity::diff_local_models 三态扫描（sha256 校验），
/// 供 AIPanel 模型状态中心渲染装/下载/更新三态。
#[tauri::command]
pub fn model_status_list(app_handle: tauri::AppHandle) -> Result<Vec<ModelStatusEntry>, String> {
    let models_dir = get_models_dir(&app_handle).map_err(|e| e.to_string())?;
    let statuses = crate::model_manifest::integrity::diff_local_models(&models_dir);
    let manifest = crate::model_manifest::ModelManifest::embedded();
    Ok(statuses
        .iter()
        .filter_map(|s| {
            let entry = manifest.get(&s.model_id)?;
            let variant = entry.default_variant()?;
            Some(ModelStatusEntry {
                model_id: entry.id.clone(),
                display_name: entry.display_name.clone(),
                purpose: entry.purpose.clone(),
                filename: s.filename.clone(),
                size_bytes: s.size_bytes,
                optional: variant.optional,
                state: match s.state {
                    crate::model_manifest::integrity::LocalModelState::Missing => "missing",
                    crate::model_manifest::integrity::LocalModelState::Intact => "intact",
                    crate::model_manifest::integrity::LocalModelState::Corrupted => "corrupted",
                }
                .to_string(),
            })
        })
        .collect())
}

/// 批量查询模型下载状态：下载体积预估（size_bytes 来自 manifest，已在线核实）、
/// 是否已下载、是否为可选下载包（optional 模型必须用户明确触发下载）
#[tauri::command]
pub fn get_model_download_info(
    app_handle: tauri::AppHandle,
    ids: Vec<String>,
) -> Result<Vec<ModelDownloadInfo>, String> {
    let models_dir = get_models_dir(&app_handle).map_err(|e| e.to_string())?;
    let manifest = crate::model_manifest::ModelManifest::embedded();
    Ok(ids
        .iter()
        .filter_map(|id| manifest.get(id))
        .map(|entry| ModelDownloadInfo {
            id: entry.id.clone(),
            display_name: entry.display_name.clone(),
            size_bytes: entry.default_variant().and_then(|v| v.size_bytes),
            downloaded: entry
                .filename()
                .map(|f| models_dir.join(f).exists())
                .unwrap_or(false),
            optional: entry
                .default_variant()
                .map(|v| v.optional)
                .unwrap_or(false),
        })
        .collect())
}

/// 显式下载可选模型（用户在体积预估确认框确认后触发；不做后台自动下载）
#[tauri::command]
pub async fn download_optional_model(app_handle: tauri::AppHandle, id: String) -> Result<(), String> {
    let models_dir = get_models_dir(&app_handle).map_err(|e| e.to_string())?;
    let endpoints = endpoints_from_handle(&app_handle);
    download_entry(&app_handle, &models_dir, &endpoints, &id)
        .await
        .map_err(|e| e.to_string())
}
