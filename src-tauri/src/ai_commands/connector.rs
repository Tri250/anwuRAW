//! W7-G4 AI 连接器命令（可选、默认关闭）。
//!
//! ai_connector 仅在用户显式配置 `ai_provider = "ai-connector"` 且填写
//! `ai_connector_address`（自建本地推理服务器）时启用；settings 默认
//! `ai_connector_address: None`，端侧路径完全独立于本模块（依赖图审计 W7-G4）。

use crate::ai_connector;
use crate::app_settings::load_settings;

#[tauri::command]
pub async fn check_ai_connector_status(app_handle: tauri::AppHandle) {
    let settings = load_settings(app_handle.clone()).unwrap_or_default();
    let is_connected = if let Some(address) = settings.ai_connector_address {
        ai_connector::check_status(&address).await.unwrap_or(false)
    } else {
        false
    };
    use tauri::Emitter;
    let _ = app_handle.emit(
        "ai-connector-status-update",
        serde_json::json!({ "connected": is_connected }),
    );
}

#[tauri::command]
pub async fn test_ai_connector_connection(address: String) -> Result<(), String> {
    match ai_connector::check_status(&address).await {
        Ok(true) => Ok(()),
        Ok(false) => Err("Server reachable but returned bad health status".to_string()),
        Err(e) => Err(e.to_string()),
    }
}
