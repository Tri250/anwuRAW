//! W5-E1 元数据域命令：sidecar/EXIF/评分色标/IPTC/镜头元数据。
//! body 位于 file_management::metadata_repo / iptc_processing / lens_correction。

pub use crate::file_management::{
    apply_adjustments_to_paths, apply_auto_adjustments_to_paths, clear_all_sidecars,
    load_metadata, read_exif_for_paths, reset_adjustments_for_paths,
    save_metadata_and_update_thumbnail, set_color_label_for_paths, set_rating_for_paths,
    update_exif_fields,
};
pub use crate::iptc_processing::{batch_update_iptc_metadata, read_iptc_metadata, write_iptc_metadata};
pub use crate::lens_correction::{
    autodetect_lens, get_lens_distortion_params, get_lensfun_lenses_for_maker, get_lensfun_makers,
};

// W5-E1: 命令宏按定义路径重导出（generate_handler 经 commands::metadata::<cmd> 查找）。
pub use super::super::file_management::metadata_repo::{
    __cmd__apply_adjustments_to_paths, __cmd__apply_auto_adjustments_to_paths,
    __cmd__clear_all_sidecars, __cmd__load_metadata, __cmd__read_exif_for_paths,
    __cmd__reset_adjustments_for_paths, __cmd__save_metadata_and_update_thumbnail,
    __cmd__set_color_label_for_paths, __cmd__set_rating_for_paths, __cmd__update_exif_fields,
    __tauri_command_name_apply_adjustments_to_paths,
    __tauri_command_name_apply_auto_adjustments_to_paths,
    __tauri_command_name_clear_all_sidecars, __tauri_command_name_load_metadata,
    __tauri_command_name_read_exif_for_paths, __tauri_command_name_reset_adjustments_for_paths,
    __tauri_command_name_save_metadata_and_update_thumbnail,
    __tauri_command_name_set_color_label_for_paths, __tauri_command_name_set_rating_for_paths,
    __tauri_command_name_update_exif_fields,
};
pub use super::super::iptc_processing::{
    __cmd__batch_update_iptc_metadata, __cmd__read_iptc_metadata, __cmd__write_iptc_metadata,
    __tauri_command_name_batch_update_iptc_metadata, __tauri_command_name_read_iptc_metadata,
    __tauri_command_name_write_iptc_metadata,
};
pub use super::super::lens_correction::{
    __cmd__autodetect_lens, __cmd__get_lens_distortion_params,
    __cmd__get_lensfun_lenses_for_maker, __cmd__get_lensfun_makers,
    __tauri_command_name_autodetect_lens, __tauri_command_name_get_lens_distortion_params,
    __tauri_command_name_get_lensfun_lenses_for_maker, __tauri_command_name_get_lensfun_makers,
};
