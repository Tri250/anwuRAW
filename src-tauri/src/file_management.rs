//! W5-E2 自原 file_management.rs 单体四拆：根模块 = 共享底座 + 子域装配。
//! 域划分：file_ops（文件操作）、library_scan（图库扫描/相册/文件夹树/预设库）、
//! metadata_repo（元数据仓储/sidecar/XMP 同步）、thumb_service（缩略图服务）。
//! 原有 `crate::file_management::X` 调用路径经 pub use 全量重导出，外部调用点零变更。

// W5-E2 四拆子模块。pub 以便 commands/ 域 façade 按定义路径重导出 __cmd__ 宏。
pub mod file_ops;
pub mod library_scan;
pub mod metadata_repo;
pub mod thumb_service;

pub use file_ops::*;
pub use library_scan::*;
pub use metadata_repo::*;
pub use thumb_service::*;

use memmap2::{Mmap, MmapOptions};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

// ======================= 预设模型（预设库域共享数据结构） =======================

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct Preset {
    pub id: String,
    pub name: String,
    pub adjustments: Value,
    #[serde(rename = "includeMasks", skip_serializing_if = "Option::is_none")]
    pub include_masks: Option<bool>,
    #[serde(
        rename = "includeCropTransform",
        skip_serializing_if = "Option::is_none"
    )]
    pub include_crop_transform: Option<bool>,
    #[serde(rename = "presetType", skip_serializing_if = "Option::is_none")]
    pub preset_type: Option<String>,
    #[serde(rename = "favorite", default, skip_serializing_if = "Option::is_none")]
    pub favorite: Option<bool>,
}

#[derive(Serialize)]
pub(crate) struct ExportPresetFile<'a> {
    pub(crate) creator: &'a str,
    pub(crate) presets: &'a [PresetItem],
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PresetFolder {
    pub id: String,
    pub name: String,
    pub children: Vec<Preset>,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub enum PresetItem {
    Preset(Preset),
    Folder(PresetFolder),
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PresetFile {
    pub presets: Vec<PresetItem>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PresetImportFailure {
    pub file_name: String,
    pub error: String,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PresetImportResult {
    pub presets: Vec<PresetItem>,
    pub failures: Vec<PresetImportFailure>,
}

// ========================= 共享文件读取底座 =========================

#[derive(Debug)]
pub enum ReadFileError {
    Io(std::io::Error),
    Locked,
    Empty,
    NotFound,
    Invalid,
}

impl fmt::Display for ReadFileError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            ReadFileError::Io(err) => write!(f, "IO error: {}", err),
            ReadFileError::Locked => write!(f, "File is locked"),
            ReadFileError::Empty => write!(f, "File is empty"),
            ReadFileError::NotFound => write!(f, "File not found"),
            ReadFileError::Invalid => write!(f, "Invalid file"),
        }
    }
}

pub fn parse_virtual_path(virtual_path: &str) -> (PathBuf, PathBuf) {
    let (source_path_str, copy_id) = if let Some((base, id)) = virtual_path.rsplit_once("?vc=") {
        (base.to_string(), Some(id.to_string()))
    } else {
        (virtual_path.to_string(), None)
    };

    // 安全加固：canonicalize 过滤 ".." / "." / 软链接穿越。
    // 若文件尚不存在（删除/移动场景）则跳过 canonicalize，仅做路径分隔符规范。
    let source_path = PathBuf::from(source_path_str);
    let source_path = source_path.canonicalize().unwrap_or(source_path);

    let sidecar_filename = if let Some(id) = copy_id {
        format!(
            "{}.{}.rrdata",
            source_path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy(),
            id
        )
    } else {
        format!(
            "{}.rrdata",
            source_path
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
        )
    };

    let sidecar_path = source_path.with_file_name(sidecar_filename);
    (source_path, sidecar_path)
}

/// Checks if the given path exists and is an iCloud placeholder file on macOS.
#[cfg(target_os = "macos")]
pub fn is_cloud_placeholder(path: &Path) -> bool {
    use std::os::unix::ffi::OsStrExt;
    const SF_DATALESS: u32 = 0x4000_0000;

    let c_path = match std::ffi::CString::new(path.as_os_str().as_bytes()) {
        Ok(p) => p,
        Err(_) => return false,
    };
    let mut stat_buf: libc::stat = unsafe { std::mem::zeroed() };
    let ret = unsafe { libc::lstat(c_path.as_ptr(), &mut stat_buf) };
    ret == 0 && (stat_buf.st_flags & SF_DATALESS) != 0
}

#[cfg(not(target_os = "macos"))]
pub fn is_cloud_placeholder(_path: &Path) -> bool {
    false
}

pub fn read_file_mapped(path: &Path) -> Result<Mmap, ReadFileError> {
    if !path.exists() {
        return Err(ReadFileError::NotFound);
    }
    if !path.is_file() {
        return Err(ReadFileError::Invalid);
    }
    if path.metadata().map_err(ReadFileError::Io)?.len() == 0 {
        return Err(ReadFileError::Empty);
    }
    let file = fs::File::open(path).map_err(ReadFileError::Io)?;
    if file.try_lock_shared().is_err() {
        return Err(ReadFileError::Locked);
    }
    let mmap = unsafe {
        MmapOptions::new()
            .len(file.metadata().map_err(ReadFileError::Io)?.len() as usize)
            .map(&file)
            .map_err(ReadFileError::Io)?
    };
    Ok(mmap)
}
