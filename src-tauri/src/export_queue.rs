//! W8-H1: ExportJob 队列 —— 运行中暂停/续跑、中断后续跑、失败清单与重试。
//!
//! 纯状态机（不依赖 tauri 运行时），由 export_processing::export_images_impl 接线：
//! - `begin_job` 在任务派发前登记（items = 原始虚拟路径串，含 vc= 标记）
//! - 每个 item 完成/失败即时登记（因取消产生的失败不计入清单）
//! - `finalize` 在任务收尾时落账（active → last record）
//! - `resume_plan` = 未完成项（含失败项重跑）；`failed_retry_plan` = 仅失败项

use std::collections::HashSet;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;

use crate::export_processing::{ExportAdjustmentsMode, ExportSettings};

const PAUSE_POLL_INTERVAL_MS: u64 = 100;

/// 单条导出失败记录（path 保留原始虚拟路径串，重试时原样回放）。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportFailure {
    pub index: usize,
    pub path: String,
    pub error: String,
}

/// 导出任务状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ExportJobStatus {
    Running,
    Completed,
    Cancelled,
}

/// 导出参数快照（续跑/重试时原样重建 export_images_impl 调用）。
#[derive(Clone)]
pub struct JobConfig {
    pub output_folder_or_file: String,
    pub is_explicit_file_path: bool,
    pub base_origin_folders: Vec<String>,
    pub export_settings: ExportSettings,
    pub output_format: String,
    pub adjustments_mode: ExportAdjustmentsMode,
}

/// 队列快照（UI/命令消费）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportJobSnapshot {
    pub job_id: u64,
    pub status: ExportJobStatus,
    pub paused: bool,
    pub total: usize,
    pub completed: usize,
    pub failed: usize,
    pub failures: Vec<ExportFailure>,
}

struct ActiveJob {
    id: u64,
    items: Vec<String>,
    config: JobConfig,
    pause_flag: Arc<AtomicBool>,
    completed: Mutex<HashSet<usize>>,
    failures: Mutex<Vec<ExportFailure>>,
}

struct JobRecord {
    id: u64,
    items: Vec<String>,
    config: JobConfig,
    completed: HashSet<usize>,
    failures: Vec<ExportFailure>,
    status: ExportJobStatus,
}

#[derive(Default)]
struct QueueInner {
    active: Option<ActiveJob>,
    last: Option<JobRecord>,
}

/// 全局导出任务队列（AppState 持有 Arc）。
#[derive(Default)]
pub struct ExportJobManager {
    next_id: AtomicU64,
    inner: Mutex<QueueInner>,
}

fn lock_mutex<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

fn record_from_active(job: ActiveJob, status: ExportJobStatus) -> JobRecord {
    let completed = job
        .completed
        .into_inner()
        .unwrap_or_else(|e| e.into_inner());
    let failures = job.failures.into_inner().unwrap_or_else(|e| e.into_inner());
    JobRecord {
        id: job.id,
        items: job.items,
        config: job.config,
        completed,
        failures,
        status,
    }
}

impl ExportJobManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// 登记新任务；若存在残留 active（异常路径）则以 Cancelled 落账，失败清单不丢。
    pub fn begin_job(&self, items: Vec<String>, config: JobConfig) -> u64 {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        let mut inner = lock_mutex(&self.inner);
        if let Some(prev) = inner.active.take() {
            inner.last = Some(record_from_active(prev, ExportJobStatus::Cancelled));
        }
        inner.active = Some(ActiveJob {
            id,
            items,
            config,
            pause_flag: Arc::new(AtomicBool::new(false)),
            completed: Mutex::new(HashSet::new()),
            failures: Mutex::new(Vec::new()),
        });
        id
    }

    pub fn active_id(&self) -> Option<u64> {
        lock_mutex(&self.inner).active.as_ref().map(|j| j.id)
    }

    pub fn pause(&self) -> Result<(), String> {
        let flag = {
            let inner = lock_mutex(&self.inner);
            inner
                .active
                .as_ref()
                .map(|j| Arc::clone(&j.pause_flag))
                .ok_or_else(|| "No export job is running.".to_string())?
        };
        flag.store(true, Ordering::SeqCst);
        Ok(())
    }

    pub fn unpause(&self) -> Result<(), String> {
        let flag = {
            let inner = lock_mutex(&self.inner);
            inner
                .active
                .as_ref()
                .map(|j| Arc::clone(&j.pause_flag))
                .ok_or_else(|| "No export job is running.".to_string())?
        };
        flag.store(false, Ordering::SeqCst);
        Ok(())
    }

    pub fn is_paused(&self) -> bool {
        lock_mutex(&self.inner)
            .active
            .as_ref()
            .map(|j| j.pause_flag.load(Ordering::SeqCst))
            .unwrap_or(false)
    }

    pub fn record_success(&self, job_id: u64, index: usize) {
        let mut inner = lock_mutex(&self.inner);
        if let Some(job) = inner.active.as_mut() {
            if job.id == job_id {
                lock_mutex(&job.completed).insert(index);
            }
        }
    }

    pub fn record_failure(&self, job_id: u64, index: usize, path: &str, error: String) {
        let mut inner = lock_mutex(&self.inner);
        if let Some(job) = inner.active.as_mut() {
            if job.id == job_id {
                lock_mutex(&job.failures).push(ExportFailure {
                    index,
                    path: path.to_string(),
                    error,
                });
            }
        }
    }

    /// active → last 落账（id 不匹配返回 false；调用方据此忽略陈旧任务）。
    pub fn finalize(&self, job_id: u64, status: ExportJobStatus) -> bool {
        let job = {
            let mut inner = lock_mutex(&self.inner);
            match inner.active.as_ref() {
                Some(j) if j.id == job_id => inner.active.take().unwrap(),
                _ => return false,
            }
        };
        let record = record_from_active(job, status);
        lock_mutex(&self.inner).last = Some(record);
        true
    }

    /// 当前任务快照：active 优先（Running），否则最近一次落账记录。
    pub fn snapshot(&self) -> Option<ExportJobSnapshot> {
        let inner = lock_mutex(&self.inner);
        if let Some(job) = inner.active.as_ref() {
            let completed = lock_mutex(&job.completed).len();
            let failures = lock_mutex(&job.failures).clone();
            return Some(ExportJobSnapshot {
                job_id: job.id,
                status: ExportJobStatus::Running,
                paused: job.pause_flag.load(Ordering::SeqCst),
                total: job.items.len(),
                completed,
                failed: failures.len(),
                failures,
            });
        }
        inner.last.as_ref().map(|r| ExportJobSnapshot {
            job_id: r.id,
            status: r.status,
            paused: false,
            total: r.items.len(),
            completed: r.completed.len(),
            failed: r.failures.len(),
            failures: r.failures.clone(),
        })
    }

    /// 中断续跑计划：last 为 Cancelled 时返回（配置, 未完成项——含失败项, 按原序）。
    pub fn resume_plan(&self) -> Option<(JobConfig, Vec<String>)> {
        let inner = lock_mutex(&self.inner);
        let record = inner.last.as_ref()?;
        if record.status != ExportJobStatus::Cancelled {
            return None;
        }
        let remaining: Vec<String> = record
            .items
            .iter()
            .enumerate()
            .filter(|(i, _)| !record.completed.contains(i))
            .map(|(_, p)| p.clone())
            .collect();
        Some((record.config.clone(), remaining))
    }

    /// 失败重试计划：last 失败清单非空时返回（配置, 仅失败项路径, 按索引序）。
    pub fn failed_retry_plan(&self) -> Option<(JobConfig, Vec<String>)> {
        let inner = lock_mutex(&self.inner);
        let record = inner.last.as_ref()?;
        if record.failures.is_empty() {
            return None;
        }
        let paths = record.failures.iter().map(|f| f.path.clone()).collect();
        Some((record.config.clone(), paths))
    }

    /// 同步等待暂停解除（spawn_blocking 内使用）；取消即返回。
    pub fn wait_while_paused_sync(&self, cancelled: &AtomicBool) {
        while self.is_paused() && !cancelled.load(Ordering::SeqCst) {
            std::thread::sleep(Duration::from_millis(PAUSE_POLL_INTERVAL_MS));
        }
    }

    /// 异步等待暂停解除（派发循环使用）；取消即返回。
    pub async fn wait_while_paused_async(&self, cancelled: &AtomicBool) {
        while self.is_paused() && !cancelled.load(Ordering::SeqCst) {
            tokio::time::sleep(Duration::from_millis(PAUSE_POLL_INTERVAL_MS)).await;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;

    fn test_config() -> JobConfig {
        JobConfig {
            output_folder_or_file: "/tmp/out".into(),
            is_explicit_file_path: false,
            base_origin_folders: vec!["/tmp/src".into()],
            export_settings: crate::export_processing::ExportSettings {
                jpeg_quality: 90,
                resize: None,
                keep_metadata: true,
                preserve_timestamps: true,
                strip_gps: false,
                filename_template: None,
                watermark: None,
                export_masks: false,
                preserve_folders: false,
                color_space: Default::default(),
                bit_depth: 8,
            },
            output_format: "jpg".into(),
            adjustments_mode:
                crate::export_processing::ExportAdjustmentsMode::GlobalOverride(Value::Null),
        }
    }

    fn items(n: usize) -> Vec<String> {
        (0..n).map(|i| format!("/img/{i:03}.nef")).collect()
    }

    #[test]
    fn begin_job_reports_running_snapshot() {
        let m = ExportJobManager::new();
        assert!(m.snapshot().is_none());
        let id = m.begin_job(items(3), test_config());
        let snap = m.snapshot().unwrap();
        assert_eq!(snap.job_id, id);
        assert_eq!(snap.status, ExportJobStatus::Running);
        assert_eq!(snap.total, 3);
        assert!(!snap.paused);
    }

    #[test]
    fn pause_unpause_roundtrip_requires_active_job() {
        let m = ExportJobManager::new();
        assert!(m.pause().is_err());
        m.begin_job(items(1), test_config());
        m.pause().unwrap();
        assert!(m.is_paused());
        assert!(m.snapshot().unwrap().paused);
        m.unpause().unwrap();
        assert!(!m.is_paused());
    }

    #[test]
    fn record_success_and_failure_accounting() {
        let m = ExportJobManager::new();
        let id = m.begin_job(items(4), test_config());
        m.record_success(id, 0);
        m.record_success(id, 1);
        m.record_failure(id, 2, "/img/002.nef", "boom".into());
        // 陈旧 job_id 忽略
        m.record_success(id + 999, 3);
        let snap = m.snapshot().unwrap();
        assert_eq!(snap.completed, 2);
        assert_eq!(snap.failed, 1);
        assert_eq!(snap.failures[0].path, "/img/002.nef");
        assert_eq!(snap.failures[0].error, "boom");
    }

    #[test]
    fn finalize_moves_active_to_last_record() {
        let m = ExportJobManager::new();
        let id = m.begin_job(items(2), test_config());
        m.record_success(id, 0);
        assert!(m.finalize(id, ExportJobStatus::Completed));
        assert!(m.active_id().is_none());
        let snap = m.snapshot().unwrap();
        assert_eq!(snap.status, ExportJobStatus::Completed);
        assert_eq!(snap.completed, 1);
        assert_eq!(snap.total, 2);
    }

    #[test]
    fn finalize_wrong_id_is_noop() {
        let m = ExportJobManager::new();
        let id = m.begin_job(items(1), test_config());
        assert!(!m.finalize(id + 1, ExportJobStatus::Completed));
        assert_eq!(m.active_id(), Some(id));
    }

    #[test]
    fn interrupted_100_item_job_resumes_remaining() {
        let m = ExportJobManager::new();
        let all = items(100);
        let id = m.begin_job(all.clone(), test_config());
        for (i, p) in all.iter().enumerate().take(37) {
            m.record_success(id, i);
            let _ = p;
        }
        for i in 37..40 {
            m.record_failure(id, i, &all[i], "disk full".into());
        }
        // 模拟中断：落账为 Cancelled
        assert!(m.finalize(id, ExportJobStatus::Cancelled));

        let snap = m.snapshot().unwrap();
        assert_eq!(snap.status, ExportJobStatus::Cancelled);
        assert_eq!(snap.completed, 37);
        assert_eq!(snap.failed, 3);

        // 续跑 = 未完成项（含失败项重跑），保持原序
        let (config, remaining) = m.resume_plan().unwrap();
        assert_eq!(remaining.len(), 63);
        assert!(!remaining.contains(&all[0]));
        assert!(!remaining.contains(&all[36]));
        assert_eq!(&remaining[..3], &all[37..40]);
        assert_eq!(remaining[3], all[40]);
        assert_eq!(remaining[62], all[99]);
        assert_eq!(config.output_folder_or_file, "/tmp/out");
        assert_eq!(config.export_settings.jpeg_quality, 90);

        // 失败重试 = 仅失败项
        let (_, failed_only) = m.failed_retry_plan().unwrap();
        assert_eq!(failed_only, all[37..40].to_vec());
    }

    #[test]
    fn resume_plan_none_for_completed_job() {
        let m = ExportJobManager::new();
        let id = m.begin_job(items(2), test_config());
        m.finalize(id, ExportJobStatus::Completed).then_some(()).unwrap();
        assert!(m.resume_plan().is_none());
        // 无失败清单时重试计划也为空
        assert!(m.failed_retry_plan().is_none());
    }

    #[test]
    fn begin_supersedes_stale_active_as_cancelled() {
        let m = ExportJobManager::new();
        let stale = m.begin_job(items(3), test_config());
        m.record_failure(stale, 1, "/img/001.nef", "io".into());
        let fresh = m.begin_job(items(5), test_config());
        // 新任务在跑
        assert_eq!(m.active_id(), Some(fresh));
        assert_eq!(m.snapshot().unwrap().total, 5);
        // 陈旧任务被落账为 Cancelled，失败清单保留
        // （active 存在时 snapshot 优先展示 active；resume_plan 读 last）
        let (config, remaining) = m.resume_plan().unwrap();
        assert_eq!(remaining.len(), 3); // 无完成项 → 全部续跑
        assert_eq!(config.output_format, "jpg");
    }

    #[test]
    fn wait_while_paused_unpauses() {
        let m = Arc::new(ExportJobManager::new());
        m.begin_job(items(1), test_config());
        m.pause().unwrap();
        let m2 = Arc::clone(&m);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            m2.unpause().unwrap();
        });
        let never_cancelled = AtomicBool::new(false);
        let start = std::time::Instant::now();
        m.wait_while_paused_sync(&never_cancelled);
        assert!(start.elapsed() < Duration::from_secs(5));
        assert!(!m.is_paused());
    }

    #[test]
    fn wait_while_paused_returns_on_cancel() {
        let m = Arc::new(ExportJobManager::new());
        m.begin_job(items(1), test_config());
        m.pause().unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let c2 = Arc::clone(&cancelled);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(50));
            c2.store(true, Ordering::SeqCst);
        });
        let start = std::time::Instant::now();
        m.wait_while_paused_sync(&cancelled);
        assert!(start.elapsed() < Duration::from_secs(2));
        // 因取消返回，但暂停标记仍在（任务终止路径处理）
        assert!(m.is_paused());
    }

    #[tokio::test]
    async fn wait_while_paused_async_returns_on_cancel() {
        let m = Arc::new(ExportJobManager::new());
        m.begin_job(items(1), test_config());
        m.pause().unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let c2 = Arc::clone(&cancelled);
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            c2.store(true, Ordering::SeqCst);
        });
        let start = std::time::Instant::now();
        m.wait_while_paused_async(&cancelled).await;
        assert!(start.elapsed() < Duration::from_secs(2));
    }
}
