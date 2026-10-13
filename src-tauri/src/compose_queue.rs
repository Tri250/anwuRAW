//! W8-H3: ComposeJob 队列 —— 统一四合成模态（HDR 合并/全景拼接/焦点堆栈/多重曝光）
//! 的进度/取消/重试协议。纯状态机（不依赖 tauri 运行时），由命令层接线：
//!
//! - `begin_job` 在管线派发前登记（inputs = 原始输入路径串，重试时原样回放）
//! - 管线在各自然阶段边界调用 `set_phase`（百分比推进）与 `set_message`（子步骤明细）
//! - 管线在循环粒度调用 `checkpoint`，取消即返回 Err 短路退出
//! - `finalize` 在任务收尾时落账（active → last record）
//! - `retry_plan` = 最近一次 Cancelled/Failed 任务的 (modality, inputs)，重试 = 同输入重跑
//!
//! 多重曝光（MultiExposure）为协议预留成员：阶段表已定义，管线在 M3 落地时接入。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use serde::Serialize;

/// 合成模态（四模态共用同一 Job 协议）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ComposeModality {
    Hdr,
    Panorama,
    FocusStack,
    MultiExposure,
}

impl ComposeModality {
    /// 模态标准阶段表（有序；百分比 = 已进入阶段序号 / 总阶段数）。
    pub fn phases(self) -> &'static [&'static str] {
        match self {
            Self::Hdr => &["load", "align", "merge", "preview"],
            Self::Panorama => &["load", "match", "order", "warp", "preview"],
            Self::FocusStack => &["load", "align", "measure", "labels", "blend", "preview"],
            Self::MultiExposure => &["load", "blend", "preview"],
        }
    }
}

/// 合成任务状态。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ComposeJobStatus {
    Running,
    Completed,
    Cancelled,
    Failed,
}

/// 队列快照（UI/命令消费；I8 JobProgress 统一组件的数据源）。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ComposeJobSnapshot {
    pub job_id: u64,
    pub modality: ComposeModality,
    pub status: ComposeJobStatus,
    pub inputs: Vec<String>,
    pub phase: String,
    pub message: Option<String>,
    pub phase_index: usize,
    pub phase_total: usize,
    pub percent: u8,
}

struct ActiveJob {
    id: u64,
    modality: ComposeModality,
    inputs: Vec<String>,
    cancel: Arc<AtomicBool>,
    phase_index: Mutex<usize>,
    phase: Mutex<String>,
    message: Mutex<Option<String>>,
}

struct JobRecord {
    id: u64,
    modality: ComposeModality,
    inputs: Vec<String>,
    status: ComposeJobStatus,
    phase: String,
    message: Option<String>,
    percent: u8,
}

#[derive(Default)]
struct QueueInner {
    active: Option<ActiveJob>,
    last: Option<JobRecord>,
}

/// 全局合成任务队列（AppState 持有 Arc）。单活跃任务：合成管线重量级，
/// 新任务登记时残留 active 以 Cancelled 落账（与 ExportJobManager 同策略）。
#[derive(Default)]
pub struct ComposeJobManager {
    next_id: AtomicU64,
    inner: Mutex<QueueInner>,
}

fn lock_mutex<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

pub const CANCELLED_MSG: &str = "Compose job cancelled.";

impl ComposeJobManager {
    pub fn new() -> Self {
        Self::default()
    }

    /// 登记新任务；若存在残留 active（异常路径）则以 Cancelled 落账。
    pub fn begin_job(&self, modality: ComposeModality, inputs: Vec<String>) -> u64 {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        let mut inner = lock_mutex(&self.inner);
        if let Some(prev) = inner.active.take() {
            let record = record_from_active(&prev, ComposeJobStatus::Cancelled);
            inner.last = Some(record);
        }
        let phase = modality.phases()[0].to_string();
        inner.active = Some(ActiveJob {
            id,
            modality,
            inputs,
            cancel: Arc::new(AtomicBool::new(false)),
            phase_index: Mutex::new(0),
            phase: Mutex::new(phase),
            message: Mutex::new(None),
        });
        id
    }

    pub fn active_id(&self) -> Option<u64> {
        lock_mutex(&self.inner).active.as_ref().map(|j| j.id)
    }

    /// 取消当前活跃任务；无活跃任务时报错。
    pub fn cancel(&self) -> Result<(), String> {
        let flag = {
            let inner = lock_mutex(&self.inner);
            inner
                .active
                .as_ref()
                .map(|j| Arc::clone(&j.cancel))
                .ok_or_else(|| "No compose job is running.".to_string())?
        };
        flag.store(true, Ordering::SeqCst);
        Ok(())
    }

    pub fn is_cancelled(&self, job_id: u64) -> bool {
        let inner = lock_mutex(&self.inner);
        inner
            .active
            .as_ref()
            .filter(|j| j.id == job_id)
            .map(|j| j.cancel.load(Ordering::SeqCst))
            .unwrap_or(false)
    }

    /// 取消标记句柄（管线内低成本轮询）；任务不存在时返回 None。
    pub fn cancel_flag(&self, job_id: u64) -> Option<Arc<AtomicBool>> {
        let inner = lock_mutex(&self.inner);
        inner
            .active
            .as_ref()
            .filter(|j| j.id == job_id)
            .map(|j| Arc::clone(&j.cancel))
    }

    /// 管线取消检查点：任务已被取消时返回 Err 短路退出（其余一律 Ok）。
    pub fn checkpoint(&self, job_id: u64) -> Result<(), String> {
        if self.is_cancelled(job_id) {
            Err(CANCELLED_MSG.to_string())
        } else {
            Ok(())
        }
    }

    /// 推进到命名阶段（百分比随阶段表推进）；未知阶段名忽略。
    pub fn set_phase(&self, job_id: u64, phase: &str) {
        let mut inner = lock_mutex(&self.inner);
        if let Some(job) = inner.active.as_mut().filter(|j| j.id == job_id) {
            if let Some(index) = job.modality.phases().iter().position(|p| *p == phase) {
                *lock_mutex(&job.phase_index) = index;
                *lock_mutex(&job.phase) = phase.to_string();
            }
        }
    }

    /// 子步骤明细（不推进百分比；同时作为旧版逐模态事件的正文）。
    pub fn set_message(&self, job_id: u64, message: &str) {
        let mut inner = lock_mutex(&self.inner);
        if let Some(job) = inner.active.as_mut().filter(|j| j.id == job_id) {
            *lock_mutex(&job.message) = Some(message.to_string());
        }
    }

    /// active → last 落账（id 不匹配返回 false；调用方据此忽略陈旧任务）。
    pub fn finalize(&self, job_id: u64, status: ComposeJobStatus) -> bool {
        let job = {
            let mut inner = lock_mutex(&self.inner);
            match inner.active.as_ref() {
                Some(j) if j.id == job_id => inner.active.take().unwrap(),
                _ => return false,
            }
        };
        let record = record_from_active(&job, status);
        lock_mutex(&self.inner).last = Some(record);
        true
    }

    /// 当前任务快照：active 优先（Running），否则最近一次落账记录。
    pub fn snapshot(&self) -> Option<ComposeJobSnapshot> {
        let inner = lock_mutex(&self.inner);
        if let Some(job) = inner.active.as_ref() {
            let phase_total = job.modality.phases().len();
            let phase_index = *lock_mutex(&job.phase_index);
            let phase = lock_mutex(&job.phase).clone();
            let message = lock_mutex(&job.message).clone();
            return Some(ComposeJobSnapshot {
                job_id: job.id,
                modality: job.modality,
                status: ComposeJobStatus::Running,
                inputs: job.inputs.clone(),
                phase,
                message,
                phase_index,
                phase_total,
                percent: (phase_index * 100 / phase_total) as u8,
            });
        }
        inner.last.as_ref().map(|r| ComposeJobSnapshot {
            job_id: r.id,
            modality: r.modality,
            status: r.status,
            inputs: r.inputs.clone(),
            phase: r.phase.clone(),
            message: r.message.clone(),
            phase_index: if r.status == ComposeJobStatus::Completed {
                r.modality.phases().len()
            } else {
                (r.percent as usize) * r.modality.phases().len() / 100
            },
            phase_total: r.modality.phases().len(),
            percent: match r.status {
                ComposeJobStatus::Completed => 100,
                _ => r.percent,
            },
        })
    }

    /// 重试计划：最近一次落账为 Cancelled/Failed 时返回 (modality, inputs)。
    pub fn retry_plan(&self) -> Option<(ComposeModality, Vec<String>)> {
        let inner = lock_mutex(&self.inner);
        let record = inner.last.as_ref()?;
        match record.status {
            ComposeJobStatus::Cancelled | ComposeJobStatus::Failed => {
                Some((record.modality, record.inputs.clone()))
            }
            _ => None,
        }
    }
}

fn record_from_active(job: &ActiveJob, status: ComposeJobStatus) -> JobRecord {
    let phase_total = job.modality.phases().len();
    let phase_index = *lock_mutex(&job.phase_index);
    JobRecord {
        id: job.id,
        modality: job.modality,
        inputs: job.inputs.clone(),
        status,
        phase: lock_mutex(&job.phase).clone(),
        message: lock_mutex(&job.message).clone(),
        percent: match status {
            ComposeJobStatus::Completed => 100,
            _ => (phase_index * 100 / phase_total) as u8,
        },
    }
}

/// 管线侧任务句柄：阶段推进 + 子步骤上报 + 取消轮询（不含 tauri 依赖），
/// 由命令层构造并传入 spawn_blocking 管线（全 Arc 字段，克隆廉价）。
#[derive(Clone)]
pub struct ComposeJobHandle {
    pub manager: Arc<ComposeJobManager>,
    pub job_id: u64,
    pub cancel: Arc<AtomicBool>,
}

impl ComposeJobHandle {
    /// 登记新任务并返回管线句柄（失败清单/落账语义见 ComposeJobManager）。
    pub fn begin(
        manager: &Arc<ComposeJobManager>,
        modality: ComposeModality,
        inputs: Vec<String>,
    ) -> Self {
        let job_id = manager.begin_job(modality, inputs);
        let cancel = manager
            .cancel_flag(job_id)
            .expect("active job must expose cancel flag");
        Self {
            manager: Arc::clone(manager),
            job_id,
            cancel,
        }
    }

    pub fn phase(&self, phase: &str) {
        self.manager.set_phase(self.job_id, phase);
    }

    pub fn message(&self, msg: &str) {
        self.manager.set_message(self.job_id, msg);
    }

    pub fn checkpoint(&self) -> Result<(), String> {
        self.manager.checkpoint(self.job_id)
    }

    pub fn is_cancelled(&self) -> bool {
        self.cancel.load(Ordering::SeqCst)
    }

    /// 收尾落账：Err 即取消/失败（按取消标记区分），Ok 即完成。
    pub fn finalize(&self, result: &Result<(), String>) {
        let status = match result {
            Ok(()) => ComposeJobStatus::Completed,
            Err(_) if self.is_cancelled() => ComposeJobStatus::Cancelled,
            Err(_) => ComposeJobStatus::Failed,
        };
        self.manager.finalize(self.job_id, status);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inputs(n: usize) -> Vec<String> {
        (0..n).map(|i| format!("/img/{i:03}.nef")).collect()
    }

    #[test]
    fn modality_phase_tables_are_ordered_and_unique() {
        for m in [
            ComposeModality::Hdr,
            ComposeModality::Panorama,
            ComposeModality::FocusStack,
            ComposeModality::MultiExposure,
        ] {
            let phases = m.phases();
            assert!(!phases.is_empty());
            assert_eq!(phases[0], "load");
            assert_eq!(*phases.last().unwrap(), "preview");
            let mut sorted = phases.to_vec();
            sorted.sort_unstable();
            sorted.dedup();
            assert_eq!(sorted.len(), phases.len(), "{m:?} phases not unique");
        }
    }

    #[test]
    fn begin_job_reports_running_snapshot_with_first_phase() {
        let m = ComposeJobManager::new();
        assert!(m.snapshot().is_none());
        let id = m.begin_job(ComposeModality::Hdr, inputs(3));
        let snap = m.snapshot().unwrap();
        assert_eq!(snap.job_id, id);
        assert_eq!(snap.status, ComposeJobStatus::Running);
        assert_eq!(snap.modality, ComposeModality::Hdr);
        assert_eq!(snap.phase, "load");
        assert_eq!(snap.phase_total, 4);
        assert_eq!(snap.percent, 0);
        assert_eq!(snap.inputs.len(), 3);
    }

    #[test]
    fn phase_progression_advances_percent() {
        let m = ComposeJobManager::new();
        let id = m.begin_job(ComposeModality::FocusStack, inputs(5));
        m.set_phase(id, "align");
        assert_eq!(m.snapshot().unwrap().percent, 16); // 1/6
        m.set_phase(id, "blend");
        assert_eq!(m.snapshot().unwrap().percent, 66); // 4/6
        m.set_message(id, "Blending frame 3 of 5...");
        let snap = m.snapshot().unwrap();
        assert_eq!(snap.percent, 66);
        assert_eq!(snap.message.as_deref(), Some("Blending frame 3 of 5..."));
    }

    #[test]
    fn unknown_phase_name_is_ignored() {
        let m = ComposeJobManager::new();
        let id = m.begin_job(ComposeModality::Panorama, inputs(2));
        m.set_phase(id, "match");
        m.set_phase(id, "not-a-phase");
        let snap = m.snapshot().unwrap();
        assert_eq!(snap.phase, "match");
        assert_eq!(snap.percent, 20);
    }

    #[test]
    fn stale_job_id_is_ignored_by_mutations() {
        let m = ComposeJobManager::new();
        let id = m.begin_job(ComposeModality::Hdr, inputs(2));
        m.set_phase(id + 999, "merge");
        m.set_message(id + 999, "x");
        let snap = m.snapshot().unwrap();
        assert_eq!(snap.phase, "load");
        assert!(snap.message.is_none());
        assert!(!m.is_cancelled(id + 999));
    }

    #[test]
    fn cancel_flags_active_job_and_checkpoint_short_circuits() {
        let m = ComposeJobManager::new();
        let id = m.begin_job(ComposeModality::Panorama, inputs(4));
        assert!(m.checkpoint(id).is_ok());
        m.cancel().unwrap();
        assert!(m.is_cancelled(id));
        assert_eq!(m.checkpoint(id).unwrap_err(), CANCELLED_MSG);
        // 无活跃任务时取消报错
        assert!(m.begin_job(ComposeModality::Hdr, inputs(2)) > id);
        m.finalize(m.active_id().unwrap(), ComposeJobStatus::Completed);
        assert!(m.cancel().is_err());
    }

    #[test]
    fn finalize_moves_active_to_last_record() {
        let m = ComposeJobManager::new();
        let id = m.begin_job(ComposeModality::Hdr, inputs(3));
        m.set_phase(id, "preview");
        assert!(m.finalize(id, ComposeJobStatus::Completed));
        assert!(m.active_id().is_none());
        let snap = m.snapshot().unwrap();
        assert_eq!(snap.status, ComposeJobStatus::Completed);
        assert_eq!(snap.percent, 100);
        assert_eq!(snap.phase_index, 4); // 全阶段完成
        assert!(!m.finalize(id, ComposeJobStatus::Failed)); // 重复落账无效
    }

    #[test]
    fn cancelled_record_keeps_percent_at_cancel_point() {
        let m = ComposeJobManager::new();
        let id = m.begin_job(ComposeModality::FocusStack, inputs(4));
        m.set_phase(id, "measure"); // 2/6
        m.finalize(id, ComposeJobStatus::Cancelled);
        let snap = m.snapshot().unwrap();
        assert_eq!(snap.status, ComposeJobStatus::Cancelled);
        assert_eq!(snap.percent, 33);
        assert_eq!(snap.phase, "measure");
    }

    #[test]
    fn failed_record_carries_error_message() {
        let m = ComposeJobManager::new();
        let id = m.begin_job(ComposeModality::Hdr, inputs(2));
        m.set_message(id, "Failed to read image /img/001.nef: io error");
        m.finalize(id, ComposeJobStatus::Failed);
        let snap = m.snapshot().unwrap();
        assert_eq!(snap.status, ComposeJobStatus::Failed);
        assert!(snap.message.unwrap().contains("io error"));
    }

    #[test]
    fn begin_supersedes_stale_active_as_cancelled() {
        let m = ComposeJobManager::new();
        let stale = m.begin_job(ComposeModality::Panorama, inputs(3));
        m.set_phase(stale, "warp");
        m.set_message(stale, "Stitching image 2 of 3");
        let fresh = m.begin_job(ComposeModality::Hdr, inputs(5));
        assert_eq!(m.active_id(), Some(fresh));
        assert_eq!(m.snapshot().unwrap().modality, ComposeModality::Hdr);
        // 陈旧任务以 Cancelled 落账，进度保留
        let (modality, retried) = m.retry_plan().unwrap();
        assert_eq!(modality, ComposeModality::Panorama);
        assert_eq!(retried.len(), 3);
    }

    #[test]
    fn retry_plan_only_for_cancelled_or_failed() {
        let m = ComposeJobManager::new();
        // Completed → 无重试
        let id = m.begin_job(ComposeModality::Hdr, inputs(2));
        m.finalize(id, ComposeJobStatus::Completed);
        assert!(m.retry_plan().is_none());
        // Cancelled → 重试
        let id = m.begin_job(ComposeModality::FocusStack, inputs(7));
        m.finalize(id, ComposeJobStatus::Cancelled);
        let (modality, plan) = m.retry_plan().unwrap();
        assert_eq!(modality, ComposeModality::FocusStack);
        assert_eq!(plan.len(), 7);
        // Failed → 重试
        let id = m.begin_job(ComposeModality::Panorama, inputs(4));
        m.finalize(id, ComposeJobStatus::Failed);
        assert!(m.retry_plan().is_some());
    }

    #[test]
    fn percent_rounds_down_across_all_modalities() {
        for m in [
            ComposeModality::Hdr,
            ComposeModality::Panorama,
            ComposeModality::FocusStack,
            ComposeModality::MultiExposure,
        ] {
            let mgr = ComposeJobManager::new();
            let id = mgr.begin_job(m, inputs(2));
            let total = m.phases().len();
            for (i, phase) in m.phases().iter().enumerate() {
                mgr.set_phase(id, phase);
                let expect = (i * 100 / total) as u8;
                assert_eq!(mgr.snapshot().unwrap().percent, expect, "{m:?}:{phase}");
            }
        }
    }
}
