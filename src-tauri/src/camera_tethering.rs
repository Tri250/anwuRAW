#![allow(unused_variables)]

use serde::Serialize;
use std::collections::HashMap;
use tauri::ipc::Response;

#[cfg(feature = "tethering")]
use crate::AppState;
#[cfg(feature = "tethering")]
use std::sync::Arc;
#[cfg(feature = "tethering")]
use std::sync::atomic::{AtomicBool, Ordering};
#[cfg(feature = "tethering")]
use tauri::{Emitter, Manager};

#[derive(Serialize)]
pub struct CameraConfigChoice {
    pub name: String,
    pub current_value: String,
    pub choices: Vec<String>,
}

#[cfg(feature = "tethering")]
pub struct CameraSession {
    pub context: Option<gphoto2::Context>,
    pub camera: Option<gphoto2::Camera>,
}

#[cfg(not(feature = "tethering"))]
pub struct CameraSession {}

impl CameraSession {
    pub fn new() -> Self {
        #[cfg(feature = "tethering")]
        {
            Self {
                context: gphoto2::Context::new().ok(),
                camera: None,
            }
        }
        #[cfg(not(feature = "tethering"))]
        {
            Self {}
        }
    }
}

unsafe impl Send for CameraSession {}
unsafe impl Sync for CameraSession {}

#[tauri::command]
pub async fn tether_list_cameras() -> Result<Vec<String>, String> {
    #[cfg(feature = "tethering")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            let context = gphoto2::Context::new()
                .map_err(|e| format!("Failed to create gphoto2 context: {}", e))?;
            let cameras = gphoto2::Camera::autodetect(&context).map_err(|e| e.to_string())?;
            Ok(cameras
                .into_iter()
                .map(|c| format!("{} ({})", c.model, c.port))
                .collect())
        })
        .await
        .map_err(|e| format!("Task panicked: {}", e))?
    }
    #[cfg(not(feature = "tethering"))]
    Err("Tethering is not supported in this build.".into())
}

#[tauri::command]
pub async fn tether_connect(app_handle: tauri::AppHandle) -> Result<String, String> {
    #[cfg(feature = "tethering")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            let state = app_handle.state::<AppState>();

            {
                let mut session = state.camera_session.lock().unwrap();
                session.camera = None;
            }

            std::thread::sleep(std::time::Duration::from_millis(150));

            let context = gphoto2::Context::new()
                .map_err(|e| format!("Failed to initialize gphoto2 context: {}", e))?;

            let cameras = gphoto2::Camera::autodetect(&context).map_err(|e| e.to_string())?;
            let descriptor = cameras.into_iter().next().ok_or("No camera found")?;

            let camera = match gphoto2::Camera::open(&context, &descriptor.model, &descriptor.port)
            {
                Ok(cam) => cam,
                Err(_) => {
                    std::thread::sleep(std::time::Duration::from_millis(300));
                    gphoto2::Camera::open(&context, &descriptor.model, &descriptor.port)
                        .map_err(|e| format!("Failed to connect to camera: {}", e))?
                }
            };

            if let Ok(widget) = camera.get_single_config(&context, "capturetarget") {
                let choices = widget.choices().unwrap_or_default();
                if let Some(ram_choice) = choices.iter().find(|c| {
                    let lower = c.to_lowercase();
                    lower.contains("ram") || lower.contains("sdram")
                }) {
                    let _ = widget.set_choice(ram_choice);
                    let _ = camera.set_single_config(&context, "capturetarget", &widget);
                }
            }

            for drive_key in &["drivemode", "drive-mode"] {
                if let Ok(widget) = camera.get_single_config(&context, drive_key) {
                    let choices = widget.choices().unwrap_or_default();
                    if let Some(single_choice) = choices.iter().find(|c| {
                        let lower = c.to_lowercase();
                        lower.contains("single") || lower == "1" || lower.contains("standard")
                    }) {
                        let _ = widget.set_choice(single_choice);
                        let _ = camera.set_single_config(&context, drive_key, &widget);
                        break;
                    }
                }
            }

            let _ = camera.capture_preview(&context);

            for _ in 0..15 {
                if let Ok(event) =
                    camera.wait_for_event(&context, std::time::Duration::from_millis(30))
                    && let gphoto2::CameraEvent::Timeout = event
                {
                    break;
                }
            }

            let model_name = descriptor.model.clone();

            {
                let mut session = state.camera_session.lock().unwrap();
                session.context = Some(context);
                session.camera = Some(camera);
            }

            Ok(format!("Connected to {}", model_name))
        })
        .await
        .map_err(|e| format!("Task panicked: {}", e))?
    }
    #[cfg(not(feature = "tethering"))]
    Err("Tethering is not supported in this build.".into())
}

#[tauri::command]
pub async fn tether_get_settings(
    app_handle: tauri::AppHandle,
) -> Result<HashMap<String, CameraConfigChoice>, String> {
    #[cfg(feature = "tethering")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            use gphoto2::widget::WidgetValue;

            let state = app_handle.state::<AppState>();
            let session = state.camera_session.lock().unwrap();
            let camera = session.camera.as_ref().ok_or("No camera connected")?;
            let context = session.context.as_ref().ok_or("No context initialized")?;

            let keys_to_query: [(&str, &[&str]); 8] = [
                ("iso", &["iso", "iso-speed", "ISO"]),
                (
                    "shutterspeed",
                    &["shutterspeed", "exposure-time", "exposurespeed"],
                ),
                ("aperture", &["f-number", "aperture", "fnumber"]),
                ("whitebalance", &["whitebalance", "white-balance"]),
                (
                    "colortemperature",
                    &[
                        "colortemperature",
                        "colortemp",
                        "wbcolortemperature",
                        "whitebalancetemperature",
                    ],
                ),
                (
                    "exposurecompensation",
                    &["exposurecompensation", "exposurebias", "exposure-bias"],
                ),
                (
                    "exposuremode",
                    &[
                        "autoexposuremode",
                        "expprogram",
                        "shootingmode",
                        "exposure-program",
                    ],
                ),
                (
                    "meteringmode",
                    &["meteringmode", "metering-mode", "exposuremeteringmode"],
                ),
            ];

            let mut attempts = 0;
            let mut map = HashMap::new();

            while attempts < 3 {
                map.clear();

                for &b_key in &["batterylevel", "battery", "battery-level"] {
                    if let Ok(widget) = camera.get_single_config(context, b_key) {
                        let current_value = match widget.value() {
                            Ok(WidgetValue::Choice(s)) => s,
                            Ok(WidgetValue::Text(s)) => s,
                            Ok(WidgetValue::Range(f)) => f.to_string(),
                            _ => continue,
                        };
                        map.insert(
                            "batterylevel".to_string(),
                            CameraConfigChoice {
                                name: "batterylevel".to_string(),
                                current_value,
                                choices: vec![],
                            },
                        );
                        break;
                    }
                }

                for (frontend_key, aliases) in keys_to_query.iter() {
                    for &camera_key in *aliases {
                        if let Ok(widget) = camera.get_single_config(context, camera_key) {
                            let current_value = match widget.value() {
                                Ok(WidgetValue::Choice(s)) => s,
                                Ok(WidgetValue::Text(s)) => s,
                                Ok(WidgetValue::Range(f)) => f.to_string(),
                                _ => continue,
                            };

                            let choices = widget.choices().unwrap_or_default();

                            map.insert(
                                frontend_key.to_string(),
                                CameraConfigChoice {
                                    name: frontend_key.to_string(),
                                    current_value,
                                    choices,
                                },
                            );
                            break;
                        }
                    }
                }

                let has_glitched_values = map.values().any(|cfg| {
                    cfg.current_value.contains("65535")
                        || cfg.current_value.contains("Unknown value 0000")
                });

                if !has_glitched_values && !map.is_empty() {
                    break;
                }

                attempts += 1;
                let _ = camera.wait_for_event(context, std::time::Duration::from_millis(200));
            }

            Ok(map)
        })
        .await
        .map_err(|e| format!("Task panicked: {}", e))?
    }
    #[cfg(not(feature = "tethering"))]
    Err("Tethering is not supported in this build.".into())
}

#[tauri::command]
pub async fn tether_set_setting(
    app_handle: tauri::AppHandle,
    setting_name: String,
    value: String,
) -> Result<(), String> {
    #[cfg(feature = "tethering")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            use gphoto2::widget::WidgetType;

            let state = app_handle.state::<AppState>();
            let session = state.camera_session.lock().unwrap();
            let camera = session.camera.as_ref().ok_or("No camera connected")?;
            let context = session.context.as_ref().ok_or("No context initialized")?;

            let aliases: &[&str] = match setting_name.as_str() {
                "iso" => &["iso", "iso-speed", "ISO"],
                "shutterspeed" => &["shutterspeed", "exposure-time", "exposurespeed"],
                "aperture" => &["f-number", "aperture", "fnumber"],
                "whitebalance" => &["whitebalance", "white-balance"],
                "colortemperature" => &[
                    "colortemperature",
                    "colortemp",
                    "wbcolortemperature",
                    "whitebalancetemperature",
                ],
                "exposurecompensation" => {
                    &["exposurecompensation", "exposurebias", "exposure-bias"]
                }
                "exposuremode" => &[
                    "autoexposuremode",
                    "expprogram",
                    "shootingmode",
                    "exposure-program",
                ],
                "meteringmode" => &["meteringmode", "metering-mode", "exposuremeteringmode"],
                _ => &[],
            };

            let mut applied = false;
            let mut last_err = None;

            for &camera_key in aliases {
                if let Ok(widget) = camera.get_single_config(context, camera_key)
                    && let Ok(widget_type) = widget.widget_type()
                {
                    let set_ok = match widget_type {
                        WidgetType::Radio | WidgetType::Menu => widget.set_choice(&value).is_ok(),
                        WidgetType::Text => widget.set_text(&value).is_ok(),
                        _ => {
                            let clean_val = value.replace("K", "").trim().to_string();
                            if let Ok(parsed_f) = clean_val.parse::<f32>() {
                                widget
                                    .set_value(&gphoto2::widget::WidgetValue::Range(parsed_f))
                                    .is_ok()
                            } else {
                                false
                            }
                        }
                    };

                    if set_ok {
                        match camera.set_single_config(context, camera_key, &widget) {
                            Ok(_) => {
                                applied = true;
                                break;
                            }
                            Err(e) => {
                                let msg = e.to_string().to_lowercase();
                                if msg.contains("read-only")
                                    || msg.contains("readonly")
                                    || msg.contains("locked")
                                {
                                    last_err = Some(format!(
                                        "{} is physically locked (e.g. physical dial).",
                                        setting_name
                                    ));
                                } else {
                                    last_err =
                                        Some(format!("Failed to set {}: {}", setting_name, e));
                                }
                            }
                        }
                    }
                }
            }

            if !applied {
                if let Some(err) = last_err {
                    return Err(err);
                }
                return Err(format!("Failed to set {} to {}", setting_name, value));
            }

            Ok(())
        })
        .await
        .map_err(|e| format!("Task panicked: {}", e))?
    }
    #[cfg(not(feature = "tethering"))]
    Err("Tethering is not supported in this build.".into())
}

#[tauri::command]
pub async fn tether_autofocus(app_handle: tauri::AppHandle) -> Result<(), String> {
    #[cfg(feature = "tethering")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            let state = app_handle.state::<AppState>();
            let session = state.camera_session.lock().unwrap();
            let camera = session.camera.as_ref().ok_or("No camera connected")?;
            let context = session.context.as_ref().ok_or("No context initialized")?;

            let mut triggered_key = None;

            for &af_key in &["autofocusdrive", "autofocus", "eosviewfinder"] {
                if let Ok(widget) = camera.get_single_config(context, af_key) {
                    let mut success = false;

                    if widget.set_choice("1").is_ok() || widget.set_choice("On").is_ok() {
                        if camera.set_single_config(context, af_key, &widget).is_ok() {
                            success = true;
                        }
                    } else if widget
                        .set_value(&gphoto2::widget::WidgetValue::Toggle(true))
                        .is_ok()
                        && camera.set_single_config(context, af_key, &widget).is_ok()
                    {
                        success = true;
                    }

                    if success {
                        triggered_key = Some(af_key);
                        break;
                    }
                }
            }

            let _ = camera.wait_for_event(context, std::time::Duration::from_millis(1000));

            if let Some(key) = triggered_key
                && let Ok(widget) = camera.get_single_config(context, key)
            {
                let _ = widget.set_choice("0");
                let _ = widget.set_choice("Off");
                let _ = widget.set_value(&gphoto2::widget::WidgetValue::Toggle(false));
                let _ = camera.set_single_config(context, key, &widget);
            }

            Ok(())
        })
        .await
        .map_err(|e| format!("Task panicked: {}", e))?
    }
    #[cfg(not(feature = "tethering"))]
    Err("Tethering is not supported in this build.".into())
}

#[tauri::command]
pub async fn tether_get_preview(app_handle: tauri::AppHandle) -> Result<Response, String> {
    #[cfg(feature = "tethering")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            let state = app_handle.state::<AppState>();
            let session = state.camera_session.lock().unwrap();
            let camera = session.camera.as_ref().ok_or("No camera connected")?;
            let context = session.context.as_ref().ok_or("No context initialized")?;

            let file = camera
                .capture_preview(context)
                .map_err(|e| format!("Failed to capture preview: {}", e))?;

            let data = file.data().map_err(|e| e.to_string())?;

            Ok(Response::new(data.to_vec()))
        })
        .await
        .map_err(|e| format!("Task panicked: {}", e))?
    }
    #[cfg(not(feature = "tethering"))]
    Err("Tethering is not supported in this build.".into())
}

/// E4: performs a single tethered capture and saves it under
/// `destination_folder` (or the temp dir). Extracted from `tether_capture` so
/// the interval-capture loop can reuse it.
#[cfg(feature = "tethering")]
fn capture_and_save(
    camera: &gphoto2::Camera,
    context: &gphoto2::Context,
    destination_folder: Option<String>,
) -> Result<std::path::PathBuf, String> {
    while let Ok(event) = camera.wait_for_event(context, std::time::Duration::from_millis(10)) {
        if let gphoto2::CameraEvent::Timeout = event {
            break;
        }
    }

    let camera_file_path = camera
        .capture_image(context)
        .map_err(|e| format!("Capture failed: {}", e))?;

    let file = camera
        .download(context, &camera_file_path)
        .map_err(|e| format!("Download failed: {}", e))?;

    let save_dir =
        destination_folder.unwrap_or_else(|| std::env::temp_dir().to_string_lossy().to_string());
    let output_path = std::path::Path::new(&save_dir).join(&camera_file_path.name);

    std::fs::write(&output_path, file.data().map_err(|e| e.to_string())?)
        .map_err(|e| format!("Failed to save captured file: {}", e))?;

    let _ = camera.delete_file(context, &camera_file_path.folder, &camera_file_path.name);

    Ok(output_path)
}

#[tauri::command]
pub async fn tether_capture(
    app_handle: tauri::AppHandle,
    destination_folder: Option<String>,
) -> Result<String, String> {
    #[cfg(feature = "tethering")]
    {
        tauri::async_runtime::spawn_blocking(move || {
            let state = app_handle.state::<AppState>();
            let session = state.camera_session.lock().unwrap();
            let camera = session.camera.as_ref().ok_or("No camera connected")?;
            let context = session.context.as_ref().ok_or("No context initialized")?;

            let output_path = capture_and_save(camera, context, destination_folder)?;
            Ok(output_path.to_string_lossy().to_string())
        })
        .await
        .map_err(|e| format!("Task panicked: {}", e))?
    }
    #[cfg(not(feature = "tethering"))]
    Err("Tethering is not supported in this build.".into())
}

/// E4: starts a tethered interval-capture loop. Each captured file path is
/// streamed to the frontend through `on_capture` and additionally emitted as a
/// `tether-interval-capture` event; failures are reported via
/// `tether-interval-error` without aborting the loop. The loop runs until
/// `tether_stop_interval_capture` is called or `max_shots` is reached, then
/// emits `tether-interval-stopped`.
#[tauri::command]
pub fn tether_start_interval_capture(
    app_handle: tauri::AppHandle,
    destination_folder: Option<String>,
    interval_ms: Option<u64>,
    max_shots: Option<u32>,
    on_capture: tauri::ipc::Channel,
) -> Result<(), String> {
    #[cfg(feature = "tethering")]
    {
        let state = app_handle.state::<AppState>();

        {
            let token_lock = state.tether_interval_token.lock().unwrap();
            if token_lock
                .as_ref()
                .is_some_and(|token| !token.load(Ordering::SeqCst))
            {
                return Err("Interval capture is already running.".to_string());
            }
        }

        let settings = crate::app_settings::load_settings(app_handle.clone()).ok();
        let interval = interval_ms
            .or_else(|| settings.as_ref().and_then(|s| s.tether_capture_interval_ms))
            .unwrap_or(5000)
            .clamp(500, 3_600_000);

        let token = Arc::new(AtomicBool::new(false));
        *state.tether_interval_token.lock().unwrap() = Some(Arc::clone(&token));

        std::thread::spawn(move || {
            let state = app_handle.state::<AppState>();
            log::info!(
                "Tether interval capture started (interval {} ms, max shots {:?})",
                interval,
                max_shots
            );
            let mut shots: u32 = 0;

            loop {
                if token.load(Ordering::SeqCst) {
                    break;
                }

                // Hold the session lock only for the duration of one shot so
                // manual captures and settings changes stay responsive.
                let capture_result = {
                    let session = state.camera_session.lock().unwrap();
                    match (session.camera.as_ref(), session.context.as_ref()) {
                        (Some(camera), Some(context)) => {
                            capture_and_save(camera, context, destination_folder.clone())
                        }
                        _ => Err("No camera connected".to_string()),
                    }
                };

                match capture_result {
                    Ok(path) => {
                        shots += 1;
                        let path_str = path.to_string_lossy().to_string();
                        let _ = on_capture.send(tauri::ipc::InvokeResponseBody::Json(
                            serde_json::json!({ "path": path_str }).to_string(),
                        ));
                        let _ = app_handle.emit(
                            "tether-interval-capture",
                            serde_json::json!({ "path": path_str }),
                        );
                        if max_shots.is_some_and(|max| shots >= max) {
                            break;
                        }
                    }
                    Err(e) => {
                        log::warn!("Tether interval capture failed: {}", e);
                        let _ = app_handle
                            .emit("tether-interval-error", serde_json::json!({ "error": e }));
                    }
                }

                // Sleep in small slices so stopping stays responsive.
                let mut waited = 0_u64;
                while waited < interval && !token.load(Ordering::SeqCst) {
                    let slice = 100.min(interval - waited);
                    std::thread::sleep(std::time::Duration::from_millis(slice));
                    waited += slice;
                }
            }

            *state.tether_interval_token.lock().unwrap() = None;
            let _ = app_handle.emit(
                "tether-interval-stopped",
                serde_json::json!({ "shots": shots }),
            );
            log::info!("Tether interval capture stopped after {} shot(s)", shots);
        });

        Ok(())
    }
    #[cfg(not(feature = "tethering"))]
    Err("Tethering is not supported in this build.".into())
}

/// E4: requests the running interval-capture loop to stop. Returns once the
/// stop flag is set; the loop thread emits `tether-interval-stopped` when it
/// has finished the current shot.
#[tauri::command]
pub fn tether_stop_interval_capture(app_handle: tauri::AppHandle) -> Result<(), String> {
    #[cfg(feature = "tethering")]
    {
        let state = app_handle.state::<AppState>();
        if let Some(token) = state.tether_interval_token.lock().unwrap().as_ref() {
            token.store(true, Ordering::SeqCst);
        }
        Ok(())
    }
    #[cfg(not(feature = "tethering"))]
    Ok(())
}
