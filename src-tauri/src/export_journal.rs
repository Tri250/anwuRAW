//! Resumable batch-export journal (G5).
//!
//! Every batch export writes one atomic JSON file under
//! `<app_cache_dir>/export_journal/<job_id>.json` describing the frozen
//! export parameters plus the per-item status. The journal is kept on disk
//! whenever a job finishes with pending/failed items (cancelled or partial
//! failure) so the UI can offer "resume" later; it is deleted as soon as
//! every item completed successfully or when a new export supersedes it.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::export_processing::{ExportAdjustmentsMode, ExportSettings};
use crate::file_management::write_file_atomic;

const JOURNAL_DIR_NAME: &str = "export_journal";

pub const STATUS_PENDING: &str = "pending";
pub const STATUS_DONE: &str = "done";
pub const STATUS_FAILED: &str = "failed";

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct JournalItem {
    pub path: String,
    #[serde(default = "default_item_status")]
    pub status: String,
    #[serde(default)]
    pub out_path: Option<String>,
    #[serde(default)]
    pub error: Option<String>,
}

fn default_item_status() -> String {
    STATUS_PENDING.to_string()
}

#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ExportJobJournal {
    pub job_id: String,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
    pub output_folder_or_file: String,
    pub is_explicit_file_path: bool,
    pub base_origin_folders: Vec<String>,
    pub export_settings: ExportSettings,
    pub output_format: String,
    pub adjustments_mode: ExportAdjustmentsMode,
    pub items: Vec<JournalItem>,
}

/// Lightweight summary returned to the UI for unfinished-job detection.
#[derive(Serialize, Deserialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct UnfinishedJobInfo {
    pub job_id: String,
    pub updated_at_ms: u64,
    pub total_count: usize,
    pub done_count: usize,
    pub failed_count: usize,
    pub pending_count: usize,
    pub first_error: Option<String>,
}

/// Thread-safe handle used by export workers to record per-item progress.
#[derive(Clone)]
pub struct JournalWriter {
    file_path: PathBuf,
    journal: Arc<Mutex<ExportJobJournal>>,
}

fn unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn journal_dir(app_handle: &tauri::AppHandle) -> Result<PathBuf, String> {
    let base = app_handle
        .path()
        .app_cache_dir()
        .map_err(|e| format!("Failed to resolve app cache dir: {}", e))?;
    let dir = base.join(JOURNAL_DIR_NAME);
    fs::create_dir_all(&dir).map_err(|e| format!("Failed to create export journal dir: {}", e))?;
    Ok(dir)
}

fn persist(file_path: &Path, journal: &ExportJobJournal) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(journal)
        .map_err(|e| format!("Failed to serialize export journal: {}", e))?;
    write_file_atomic(file_path, &bytes)
        .map_err(|e| format!("Failed to write export journal: {}", e))
}

/// Creates a fresh journal for a new export job, superseding (deleting) any
/// previous journal files so at most one unfinished job lingers on disk.
#[allow(clippy::too_many_arguments)]
pub fn begin_export_job(
    app_handle: &tauri::AppHandle,
    paths: &[String],
    output_folder_or_file: &str,
    is_explicit_file_path: bool,
    base_origin_folders: &[String],
    export_settings: &ExportSettings,
    output_format: &str,
    adjustments_mode: &ExportAdjustmentsMode,
) -> Result<JournalWriter, String> {
    let dir = journal_dir(app_handle)?;

    if let Ok(entries) = fs::read_dir(&dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|ext| ext.to_str()) == Some("json") {
                let _ = fs::remove_file(&path);
            }
        }
    }

    let now = unix_ms();
    let job_id = format!("export-{}", now);
    let journal = ExportJobJournal {
        job_id: job_id.clone(),
        created_at_ms: now,
        updated_at_ms: now,
        output_folder_or_file: output_folder_or_file.to_string(),
        is_explicit_file_path,
        base_origin_folders: base_origin_folders.to_vec(),
        export_settings: export_settings.clone(),
        output_format: output_format.to_string(),
        adjustments_mode: adjustments_mode.clone(),
        items: paths
            .iter()
            .map(|path| JournalItem {
                path: path.clone(),
                status: STATUS_PENDING.to_string(),
                out_path: None,
                error: None,
            })
            .collect(),
    };

    let file_path = dir.join(format!("{}.json", job_id));
    persist(&file_path, &journal)?;

    Ok(JournalWriter {
        file_path,
        journal: Arc::new(Mutex::new(journal)),
    })
}

impl JournalWriter {
    pub fn mark_done(&self, index: usize, out_path: &str) {
        self.update(|journal| {
            if let Some(item) = journal.items.get_mut(index) {
                item.status = STATUS_DONE.to_string();
                item.out_path = Some(out_path.to_string());
                item.error = None;
            }
        });
    }

    pub fn mark_failed(&self, index: usize, error: &str) {
        self.update(|journal| {
            if let Some(item) = journal.items.get_mut(index) {
                item.status = STATUS_FAILED.to_string();
                item.error = Some(error.to_string());
            }
        });
    }

    fn update<F: FnOnce(&mut ExportJobJournal)>(&self, mutate: F) {
        let mut journal = match self.journal.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        mutate(&mut journal);
        journal.updated_at_ms = unix_ms();
        if let Err(error) = persist(&self.file_path, &journal) {
            log::warn!("Failed to persist export journal: {}", error);
        }
    }

    /// Deletes the journal file when every item completed successfully;
    /// otherwise the journal is kept on disk so the job can be resumed later.
    pub fn finish(&self) {
        let journal = match self.journal.lock() {
            Ok(guard) => guard,
            Err(poisoned) => poisoned.into_inner(),
        };
        if journal.items.iter().all(|item| item.status == STATUS_DONE) {
            let _ = fs::remove_file(&self.file_path);
        }
    }
}

fn load_journal_file(path: &Path) -> Result<ExportJobJournal, String> {
    let content = fs::read_to_string(path)
        .map_err(|e| format!("Failed to read export journal '{}': {}", path.display(), e))?;
    serde_json::from_str(&content)
        .map_err(|e| format!("Failed to parse export journal '{}': {}", path.display(), e))
}

fn is_valid_job_id(job_id: &str) -> bool {
    !job_id.is_empty()
        && job_id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// Reads a frozen journal by id (used by the resume command).
pub fn load_export_job(
    app_handle: &tauri::AppHandle,
    job_id: &str,
) -> Result<ExportJobJournal, String> {
    if !is_valid_job_id(job_id) {
        return Err("Invalid export job id.".to_string());
    }
    let dir = journal_dir(app_handle)?;
    load_journal_file(&dir.join(format!("{}.json", job_id)))
}

/// Returns the most recent journal that still has pending or failed items.
pub fn find_unfinished_export_job(
    app_handle: &tauri::AppHandle,
) -> Result<Option<UnfinishedJobInfo>, String> {
    let dir = journal_dir(app_handle)?;
    let entries = match fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(_) => return Ok(None),
    };

    let mut best: Option<ExportJobJournal> = None;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }
        match load_journal_file(&path) {
            Ok(journal) if journal.items.iter().any(|item| item.status != STATUS_DONE) => {
                let is_newer = best
                    .as_ref()
                    .map(|current| journal.updated_at_ms > current.updated_at_ms)
                    .unwrap_or(true);
                if is_newer {
                    best = Some(journal);
                }
            }
            Ok(_) => {}
            Err(error) => log::warn!("Ignoring unreadable export journal: {}", error),
        }
    }

    Ok(best.map(|journal| {
        let total_count = journal.items.len();
        let done_count = journal
            .items
            .iter()
            .filter(|item| item.status == STATUS_DONE)
            .count();
        let failed_count = journal
            .items
            .iter()
            .filter(|item| item.status == STATUS_FAILED)
            .count();
        let first_error = journal.items.iter().find_map(|item| item.error.clone());
        UnfinishedJobInfo {
            job_id: journal.job_id,
            updated_at_ms: journal.updated_at_ms,
            total_count,
            done_count,
            failed_count,
            pending_count: total_count - done_count - failed_count,
            first_error,
        }
    }))
}

fn discard_export_job_impl(app_handle: &tauri::AppHandle, job_id: &str) -> Result<(), String> {
    if !is_valid_job_id(job_id) {
        return Err("Invalid export job id.".to_string());
    }
    let dir = journal_dir(app_handle)?;
    let path = dir.join(format!("{}.json", job_id));
    if path.exists() {
        fs::remove_file(&path).map_err(|e| format!("Failed to discard export job: {}", e))?;
    }
    Ok(())
}

#[tauri::command]
pub fn get_unfinished_export_job(
    app_handle: tauri::AppHandle,
) -> Result<Option<UnfinishedJobInfo>, String> {
    find_unfinished_export_job(&app_handle)
}

#[tauri::command]
pub fn discard_export_job(app_handle: tauri::AppHandle, job_id: String) -> Result<(), String> {
    discard_export_job_impl(&app_handle, &job_id)
}
