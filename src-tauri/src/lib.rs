#[cfg(not(all(target_os = "windows", target_arch = "aarch64")))]
use mimalloc::MiMalloc;

#[cfg(not(all(target_os = "windows", target_arch = "aarch64")))]
#[global_allocator]
static GLOBAL: MiMalloc = MiMalloc;

mod adjustment_utils;
mod ai_acceleration;
mod ai_commands;
mod ai_connector;
mod ai_processing;
mod alignment_core;
mod android_integration;
mod app_settings;
mod app_state;
mod asset_manifest;
mod cache_utils;
mod camera_tethering;
mod channel_mixer;
mod color_range_mask;
mod commands;
mod compose_queue;
mod culling;
mod denoising;
mod detect_straighten;
mod exif_processing;
mod export_encoders;
mod export_processing;
mod export_queue;
mod file_management;
mod focus_stacking;
mod formats;
mod gpu_backends;
mod gpu_processing;
mod hdr_deghosting;
mod image_loader;
mod image_processing;
mod inpainting;
mod iptc_processing;
mod launch_request;
mod lens_blur;
mod lens_correction;
mod library_index;
mod luminance_range_mask;
mod lut_processing;
mod mask_generation;
mod metadata_migration;
mod model_manifest;
mod multi_exposure;
mod negative_conversion;
mod panorama_stitching;
mod panorama_utils;
mod param_matrix;
#[cfg(feature = "golden-tests")]
pub mod golden_harness;
mod preset_converter;
mod raw_processing;
mod render_scheduler;
mod split_toning;
mod tagging;
mod tagging_utils;
mod window_customizer;

use tauri::Manager;

use crate::window_customizer::PinchZoomDisablePlugin;
pub use adjustment_utils::*;
pub use android_integration::*;
pub use app_settings::*;
pub use app_state::*;
pub use launch_request::*;

/// W5-E3 装配化入口：命令分域注册见 commands/，setup/状态/事件分发见 commands::system。
pub fn run() {
    let _ = rayon::ThreadPoolBuilder::new()
        .stack_size(8 * 1024 * 1024)
        .build_global();

    let mut builder = tauri::Builder::default();

    let args: Vec<String> = std::env::args().skip(1).collect();
    let launch_req = crate::launch_request::parse_launch_args(&args);
    let is_headless = matches!(launch_req, crate::launch_request::LaunchRequest::HeadlessExport(_));

    #[cfg(not(any(target_os = "android", target_os = "ios")))]
    {
        if !is_headless {
            builder = builder.plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
                log::info!(
                    "New instance launched with args: {:?}. Focusing main window.",
                    argv
                );
                if let Some(window) = app.get_webview_window("main") {
                    if let Err(e) = window.unminimize() {
                        log::error!("Failed to unminimize window: {}", e);
                    }
                    if let Err(e) = window.set_focus() {
                        log::error!("Failed to set focus on window: {}", e);
                    }
                }

                let forwarded_args = argv.get(1..).unwrap_or(&[]);
                crate::launch_request::emit_launch_request(
                    app,
                    crate::launch_request::parse_launch_args(forwarded_args),
                );
            }));
        }
    }

    builder
        .plugin(tauri_plugin_os::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(PinchZoomDisablePlugin)
        .on_window_event(|window, event| if let tauri::WindowEvent::Resized(size) = event {
            let state = window.state::<crate::app_state::AppState>();
            if let Some(ctx) = state.gpu_context.lock().unwrap_or_else(|e| e.into_inner()).as_ref()
                && let Ok(mut display_lock) = ctx.display.try_lock()
                    && let Some(display) = display_lock.as_mut() {
                        display.config.width = size.width.max(1);
                        display.config.height = size.height.max(1);
                        display.surface.configure(&ctx.device, &display.config);
                        display.render(&ctx.device, &ctx.queue);
                    }
        })
        .setup(move |app| crate::commands::system::bootstrap_setup(app, launch_req))
        .manage(crate::commands::system::app_state())
        .invoke_handler(tauri::generate_handler![
            // ---- engine ----
            commands::engine::apply_adjustments,
            commands::engine::generate_preview_for_path,
            commands::engine::generate_preset_preview,
            commands::engine::generate_uncropped_preview,
            commands::engine::preview_geometry_transform,
            commands::engine::get_image_dimensions,
            commands::engine::update_wgpu_transform,
            commands::engine::cancel_thumbnail_generation,
            commands::engine::load_image,
            commands::engine::is_image_cached,
            commands::engine::calculate_auto_adjustments,
            commands::engine::generate_mask_overlay,
            commands::engine::detect_straighten_angle,
            commands::engine::generate_color_range_mask_command,
            commands::engine::generate_luminance_range_mask_command,
            commands::engine::apply_channel_mixer_command,
            commands::engine::apply_split_toning_command,
            commands::engine::preview_negative_conversion,
            commands::engine::convert_negatives,
            // ---- library ----
            commands::library::fetch_community_presets,
            commands::library::generate_all_community_previews,
            commands::library::load_and_parse_lut,
            commands::library::list_luts,
            commands::library::import_luts,
            commands::library::remove_lut,
            commands::library::generate_lut_previews,
            commands::library::get_supported_file_types,
            commands::library::list_images_in_dir,
            commands::library::list_images_recursive,
            commands::library::library_index_query,
            commands::library::library_index_stats,
            commands::library::get_folder_tree,
            commands::library::get_folder_children,
            commands::library::get_pinned_folder_trees,
            commands::library::load_presets,
            commands::library::save_presets,
            commands::library::get_or_create_internal_library_root,
            commands::library::handle_import_presets_from_file,
            commands::library::handle_import_legacy_presets_from_file,
            commands::library::handle_import_presets_from_files,
            commands::library::handle_export_presets_to_file,
            commands::library::save_community_preset,
            commands::library::get_albums,
            commands::library::save_albums,
            commands::library::add_to_album,
            commands::library::get_album_images,
            commands::library::start_background_indexing,
            commands::library::clear_ai_tags,
            commands::library::clear_all_tags,
            commands::library::add_tag_for_paths,
            commands::library::remove_tag_for_paths,
            commands::library::cull_images,
            // ---- files ----
            commands::files::save_temp_file,
            commands::files::update_thumbnail_queue,
            commands::files::create_folder,
            commands::files::delete_folder,
            commands::files::copy_files,
            commands::files::move_files,
            commands::files::rename_folder,
            commands::files::rename_files,
            commands::files::duplicate_file,
            commands::files::show_in_finder,
            commands::files::delete_files_from_disk,
            commands::files::delete_files_with_associated,
            commands::files::import_files,
            commands::files::create_virtual_copy,
            commands::files::clear_thumbnail_cache,
            // ---- metadata ----
            commands::metadata::update_exif_fields,
            commands::metadata::read_exif_for_paths,
            commands::metadata::save_metadata_and_update_thumbnail,
            commands::metadata::apply_adjustments_to_paths,
            commands::metadata::load_metadata,
            commands::metadata::reset_adjustments_for_paths,
            commands::metadata::apply_auto_adjustments_to_paths,
            commands::metadata::clear_all_sidecars,
            commands::metadata::set_color_label_for_paths,
            commands::metadata::set_rating_for_paths,
            commands::metadata::get_lensfun_makers,
            commands::metadata::get_lensfun_lenses_for_maker,
            commands::metadata::autodetect_lens,
            commands::metadata::get_lens_distortion_params,
            commands::metadata::read_iptc_metadata,
            commands::metadata::write_iptc_metadata,
            commands::metadata::batch_update_iptc_metadata,
            // ---- ai ----
            commands::ai::get_active_ai_execution_provider,
            commands::ai::download_optional_model,
            commands::ai::generate_ai_subject_mask,
            commands::ai::get_model_download_info,
            commands::ai::model_status_list,
            commands::ai::precompute_ai_subject_mask,
            commands::ai::generate_ai_foreground_mask,
            commands::ai::generate_ai_sky_mask,
            commands::ai::generate_ai_depth_mask,
            commands::ai::check_ai_connector_status,
            commands::ai::test_ai_connector_connection,
            commands::ai::generate_full_image_depth_map,
            commands::ai::invoke_generative_replace_with_mask_def,
            commands::ai::generate_manual_cleanup_patch,
            commands::ai::generate_liquify_patch,
            commands::ai::generate_retouch_patch,
            commands::ai::generate_auto_erase_patch,
            commands::ai::apply_denoising,
            commands::ai::batch_denoise_images,
            commands::ai::save_denoised_image,
            // ---- export ----
            commands::export::export_images,
            commands::export::export_with_icc_and_depth,
            commands::export::cancel_export,
            commands::export::estimate_export_sizes,
            commands::export::pause_export,
            commands::export::resume_export,
            commands::export::retry_failed_exports,
            commands::export::get_export_job_status,
            // ---- compose ----
            commands::compose::merge_hdr,
            commands::compose::save_hdr,
            commands::compose::save_collage,
            commands::compose::cancel_compose_job,
            commands::compose::get_compose_job_status,
            commands::compose::stitch_panorama,
            commands::compose::save_panorama,
            commands::compose::stitch_focus_stack,
            commands::compose::save_focus_stack,
            // ---- system ----
            commands::system::get_log_file_path,
            commands::system::frontend_log,
            commands::system::frontend_ready,
            commands::system::clear_session_caches,
            commands::system::clear_image_caches,
            commands::system::load_settings,
            commands::system::save_settings,
            commands::system::is_tethering_supported,
            commands::system::resolve_android_content_uri_name,
            commands::system::tether_list_cameras,
            commands::system::tether_connect,
            commands::system::tether_get_settings,
            commands::system::tether_set_setting,
            commands::system::tether_capture,
            commands::system::tether_get_preview,
            commands::system::tether_autofocus,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(crate::commands::system::on_run_event);
}
