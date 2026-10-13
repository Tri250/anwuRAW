//! 渲染会话调度（W4-D1 / AR-3）：主视图 / 缩略图 / 批量 三级优先级的最小实现。
//!
//! 优先级模型：
//! - **Interactive（主视图）**：`apply_adjustments` 命令流经 latest-wins 预览
//!   worker 天然合并（start_preview_worker）；每个任务处理前向调度器登记
//!   交互窗口。
//! - **Thumbnail（缩略图）**：worker 在每张缩略图生成前 `wait_slot()` ——
//!   交互窗口内阻塞让路，滑杆连续拖动持续顺延窗口直至静默。
//! - **Batch（导出/批处理）**：spawn_blocking 闭包内同样 `wait_slot()`。
//!
//! 取消沿用各域既有 token（thumbnail_cancellation_token / export token），
//! 调度器不新增生命周期；窗口过期自动放行，无饿死风险（20ms 轮询粒度）。

use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

/// 交互优先级窗口：一次主视图任务让缩略图/批量让路的时长。
/// apply_adjustments 每次触发都会顺延，连续拖动期间窗口持续存在。
pub const DEFAULT_INTERACTIVE_WINDOW_MS: u64 = 400;
const POLL_INTERVAL_MS: u64 = 20;

#[derive(Default)]
pub struct RenderScheduler {
    interactive_until_ms: AtomicU64,
}

impl RenderScheduler {
    pub fn new() -> Self {
        Self::default()
    }

    fn now_ms() -> u64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_millis() as u64)
            .unwrap_or(0)
    }

    /// 主视图活动登记：以默认窗口顺延交互优先级。
    pub fn mark_interactive(&self) {
        self.mark_interactive_for(DEFAULT_INTERACTIVE_WINDOW_MS);
    }

    /// 以指定窗口顺延交互优先级（fetch_max 保证并发登记单调不回退）。
    pub fn mark_interactive_for(&self, window_ms: u64) {
        let until = Self::now_ms().saturating_add(window_ms);
        self.interactive_until_ms.fetch_max(until, Ordering::SeqCst);
    }

    /// 交互窗口是否活跃（Thumbnail/Batch 让路判定）
    pub fn interactive_active(&self) -> bool {
        Self::now_ms() < self.interactive_until_ms.load(Ordering::SeqCst)
    }

    /// Thumbnail/Batch 任务在每次 GPU 提交前调用：交互期间阻塞让路，
    /// 取消 token 置位即刻返回（不阻塞取消语义）。
    pub fn wait_slot(&self, cancel: &AtomicBool) {
        loop {
            if cancel.load(Ordering::SeqCst) || !self.interactive_active() {
                return;
            }
            std::thread::sleep(Duration::from_millis(POLL_INTERVAL_MS));
        }
    }

    /// 非阻塞探测（异步上下文轮询用）
    pub fn try_acquire(&self) -> bool {
        !self.interactive_active()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    /// 交互窗口随时间自然过期
    #[test]
    fn d1_interactive_window_expires() {
        let s = RenderScheduler::new();
        assert!(!s.interactive_active());
        s.mark_interactive_for(80);
        assert!(s.interactive_active());
        std::thread::sleep(Duration::from_millis(140));
        assert!(!s.interactive_active(), "窗口过期后应自动放行");
    }

    /// fetch_max 并发登记单调：更短的窗口不得回退更长的登记
    #[test]
    fn d1_mark_is_monotonic() {
        let s = RenderScheduler::new();
        s.mark_interactive_for(500);
        s.mark_interactive_for(1); // 短窗口不得覆盖
        assert!(s.interactive_active());
        let until = s.interactive_until_ms.load(Ordering::SeqCst);
        let now = RenderScheduler::now_ms();
        assert!(
            until >= now.saturating_add(300),
            "短窗口回退了长窗口登记: until={until}, now={now}"
        );
    }

    /// 空闲时 wait_slot 立即返回（无让路开销）
    #[test]
    fn d1_wait_slot_immediate_when_idle() {
        let s = RenderScheduler::new();
        let cancel = AtomicBool::new(false);
        let start = std::time::Instant::now();
        s.wait_slot(&cancel);
        assert!(start.elapsed() < Duration::from_millis(100));
    }

    /// 交互期间让路：阻塞至窗口过期后放行
    #[test]
    fn d1_wait_slot_yields_until_window_expires() {
        let s = RenderScheduler::new();
        let cancel = AtomicBool::new(false);
        s.mark_interactive_for(80);
        let start = std::time::Instant::now();
        s.wait_slot(&cancel);
        let elapsed = start.elapsed();
        assert!(elapsed >= Duration::from_millis(60), "未让路: {elapsed:?}");
        assert!(elapsed < Duration::from_millis(1000), "过期后未放行: {elapsed:?}");
    }

    /// 取消优先：交互窗口再长，取消即刻解除阻塞
    #[test]
    fn d1_wait_slot_cancel_aborts() {
        let s = Arc::new(RenderScheduler::new());
        let cancel = Arc::new(AtomicBool::new(false));
        s.mark_interactive_for(60_000);

        let s2 = Arc::clone(&s);
        let c2 = Arc::clone(&cancel);
        let canceller = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(40));
            c2.store(true, Ordering::SeqCst);
            let _ = s2; // 保持调度器引用
        });

        let start = std::time::Instant::now();
        s.wait_slot(&cancel);
        let elapsed = start.elapsed();
        canceller.join().unwrap();
        assert!(
            elapsed < Duration::from_millis(2000),
            "取消后未及时解除阻塞: {elapsed:?}"
        );
    }

    /// try_acquire 非阻塞语义
    #[test]
    fn d1_try_acquire_reflects_window() {
        let s = RenderScheduler::new();
        assert!(s.try_acquire());
        s.mark_interactive_for(100);
        assert!(!s.try_acquire());
    }
}
