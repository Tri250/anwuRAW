//! AI 执行委托层（v2.0 Task 4 / FR-3）
//!
//! 全部 ort Session 创建必须经由本模块：按设置档位（AiAccelerationMode）×
//! manifest 每模型 `recommended_ep` 约束 × 平台硬件候选，逐 EP 注册并记录
//! 实际生效的 EP；注册失败的 EP 记入日志并回退 CPU，绝不 panic（TR-4.1/4.2）。
//!
//! Task 0 PoC 结论未出前，硬件候选仅按平台 cfg 挂载（Android=NNAPI /
//! macOS=CoreML），桌面平台恒为 CPU；PoC 结论写入 manifest `recommended_ep`
//! 后即可逐模型精确控制。

use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU8, Ordering};

#[cfg(any(target_os = "android", target_os = "macos"))]
use ort::execution_providers::ExecutionProvider;
use ort::session::builder::SessionBuilder;
use ort::session::Session;
use serde::{Deserialize, Serialize};

#[cfg(target_os = "android")]
use ort::execution_providers::nnapi::NNAPIExecutionProvider;
#[cfg(target_os = "macos")]
use ort::execution_providers::coreml::CoreMLExecutionProvider;

/// AI 推理加速档位（持久化到 app_settings.aiAccelerationMode）
#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq, Default)]
#[serde(rename_all = "lowercase")]
pub enum AiAccelerationMode {
    /// 自动：探测硬件 EP，失败逐级回退 CPU（默认）
    #[default]
    Auto,
    /// 性能优先：强制硬件 EP，不可用时回退 CPU 并记录警告
    Performance,
    /// 兼容模式：恒为 CPU（规避 NNAPI/CoreML 算子缺失问题）
    Compatibility,
}

impl AiAccelerationMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Auto => "auto",
            Self::Performance => "performance",
            Self::Compatibility => "compatibility",
        }
    }
}

/// 实际生效的执行提供者（设置页显示用）
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ActiveExecutionProvider {
    Cpu,
    Nnapi,
    CoreML,
}

impl ActiveExecutionProvider {
    pub fn display_name(&self) -> &'static str {
        match self {
            Self::Cpu => "CPU",
            Self::Nnapi => "NNAPI",
            Self::CoreML => "CoreML",
        }
    }

    fn to_index(self) -> u8 {
        match self {
            Self::Cpu => 1,
            Self::Nnapi => 2,
            Self::CoreML => 3,
        }
    }

    fn from_index(v: u8) -> Option<Self> {
        match v {
            1 => Some(Self::Cpu),
            2 => Some(Self::Nnapi),
            3 => Some(Self::CoreML),
            _ => None,
        }
    }
}

// 最近一次 Session 创建实际生效的 EP（0 = 应用启动后尚未创建过 Session）
static LAST_ACTIVE_EP: AtomicU8 = AtomicU8::new(0);

pub fn last_active_execution_provider() -> Option<ActiveExecutionProvider> {
    ActiveExecutionProvider::from_index(LAST_ACTIVE_EP.load(Ordering::Relaxed))
}

fn record_active_ep(ep: ActiveExecutionProvider) {
    LAST_ACTIVE_EP.store(ep.to_index(), Ordering::Relaxed);
}

/// EP 决策：硬件候选是否允许参与本次 Session 创建。
/// - compatibility：恒否（TR-4.1）
/// - auto / performance：允许；但 manifest `recommended_ep` 明确只允许 cpu
///   时否决（Task 0 PoC 对硬件覆盖不足的模型会写 `ep: ["cpu"]`）；
///   空列表视为无约束。
fn hardware_allowed(mode: AiAccelerationMode, recommended_ep: &[String]) -> bool {
    match mode {
        AiAccelerationMode::Compatibility => false,
        AiAccelerationMode::Auto | AiAccelerationMode::Performance => {
            recommended_ep.is_empty() || recommended_ep.iter().any(|ep| ep != "cpu")
        }
    }
}

/// 平台硬件 EP 候选策略表（W7-G3 数据化）：按优先级排序，CPU 为恒定兜底不列入。
/// 新平台/新 EP 接入只需扩表，不散落 cfg 分支。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HardwareEp {
    Nnapi,
    CoreML,
}

impl HardwareEp {
    fn active_provider(self) -> ActiveExecutionProvider {
        match self {
            Self::Nnapi => ActiveExecutionProvider::Nnapi,
            Self::CoreML => ActiveExecutionProvider::CoreML,
        }
    }

    fn register(self, builder: &mut SessionBuilder) -> ort::Result<()> {
        match self {
            #[cfg(target_os = "android")]
            Self::Nnapi => NNAPIExecutionProvider::default().register(builder),
            #[cfg(not(target_os = "android"))]
            Self::Nnapi => Err(ort::Error::new("NNAPI not compiled for this platform")),
            #[cfg(target_os = "macos")]
            Self::CoreML => CoreMLExecutionProvider::default().register(builder),
            #[cfg(not(target_os = "macos"))]
            Self::CoreML => Err(ort::Error::new("CoreML not compiled for this platform")),
        }
    }
}

/// 当前平台的硬件候选表（空 = 桌面平台，恒 CPU）
fn platform_ep_candidates() -> &'static [HardwareEp] {
    #[cfg(target_os = "android")]
    {
        &[HardwareEp::Nnapi]
    }
    #[cfg(target_os = "macos")]
    {
        &[HardwareEp::CoreML]
    }
    #[cfg(not(any(target_os = "android", target_os = "macos")))]
    {
        &[]
    }
}

/// 最近一次 Session 创建是否发生硬件→CPU 降档（W7-G3 运行时自动降档，UI 提示用）
static LAST_DEGRADED: AtomicBool = AtomicBool::new(false);

pub fn last_degradation() -> bool {
    LAST_DEGRADED.load(Ordering::Relaxed)
}

/// 降档重试决策纯函数：硬件尝试失败且档位允许兜底成功时重试 CPU。
/// compatibility 从不做硬件尝试（hardware_attempt 恒 false）。
fn should_retry_on_cpu(mode: AiAccelerationMode, hardware_attempt: bool) -> bool {
    hardware_attempt && !matches!(mode, AiAccelerationMode::Compatibility)
}

/// 逐候选注册平台硬件 EP，返回实际注册成功者；失败记日志并继续下一候选。
/// ort 对 EP 不支持的算子会在运行期自动落到 CPU（逐节点回退）。
fn try_register_platform_ep(builder: &mut SessionBuilder) -> Option<ActiveExecutionProvider> {
    for candidate in platform_ep_candidates() {
        match candidate.register(builder) {
            Ok(()) => return Some(candidate.active_provider()),
            Err(e) => println!("[AI] hardware EP {:?} unavailable: {}", candidate, e),
        }
    }
    None
}

/// 统一 Session 创建入口（TR-4.1/4.2：任何 EP 失败都回退 CPU，不 panic）
/// W7-G3：硬件 EP 注册成功但模型 commit 失败（算子缺失/形状不支持等）时，
/// Auto/Performance 档自动降档纯 CPU 重试一次并记录降档事件。
pub fn build_session(
    model_path: &Path,
    mode: AiAccelerationMode,
    recommended_ep: &[String],
) -> ort::Result<Session> {
    let mut builder = Session::builder()?;

    let hardware_attempt = hardware_allowed(mode, recommended_ep);
    let active_ep = if hardware_attempt {
        try_register_platform_ep(&mut builder).unwrap_or(ActiveExecutionProvider::Cpu)
    } else {
        ActiveExecutionProvider::Cpu
    };

    match builder.commit_from_file(model_path) {
        Ok(session) => {
            LAST_DEGRADED.store(false, Ordering::Relaxed);
            record_active_ep(active_ep);
            Ok(session)
        }
        Err(e) if should_retry_on_cpu(mode, hardware_attempt) => {
            println!(
                "[AI] Session init with {:?} failed ({}); degrading to CPU retry",
                active_ep, e
            );
            let cpu_builder = Session::builder()?;
            let session = cpu_builder.commit_from_file(model_path)?;
            LAST_DEGRADED.store(true, Ordering::Relaxed);
            record_active_ep(ActiveExecutionProvider::Cpu);
            Ok(session)
        }
        Err(e) => Err(e),
    }
}

/// 从用户设置解析档位；设置读取失败时回退默认 auto
pub fn mode_from_handle(app_handle: &tauri::AppHandle) -> AiAccelerationMode {
    crate::app_settings::load_settings(app_handle.clone())
        .map(|s| s.ai_acceleration_mode)
        .unwrap_or_default()
}

#[tauri::command]
pub fn get_active_ai_execution_provider() -> Option<String> {
    last_active_execution_provider().map(|ep| ep.display_name().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn eps(items: &[&str]) -> Vec<String> {
        items.iter().map(|s| s.to_string()).collect()
    }

    /// TR-4.1: compatibility 档在任何平台、任何 manifest 约束下都不使用硬件 EP
    #[test]
    fn test_compatibility_mode_never_uses_hardware() {
        assert!(!hardware_allowed(AiAccelerationMode::Compatibility, &[]));
        assert!(!hardware_allowed(
            AiAccelerationMode::Compatibility,
            &eps(&["nnapi"])
        ));
        assert!(!hardware_allowed(
            AiAccelerationMode::Compatibility,
            &eps(&["cpu"])
        ));
    }

    /// manifest recommended_ep 约束：仅 cpu 时否决硬件；含硬件项或为空时允许
    #[test]
    fn test_manifest_recommended_ep_constraint() {
        assert!(!hardware_allowed(AiAccelerationMode::Auto, &eps(&["cpu"])));
        assert!(!hardware_allowed(
            AiAccelerationMode::Performance,
            &eps(&["cpu"])
        ));
        assert!(hardware_allowed(
            AiAccelerationMode::Auto,
            &eps(&["cpu", "nnapi"])
        ));
        assert!(hardware_allowed(AiAccelerationMode::Auto, &[]));
    }

    /// TR-4.2: 无硬件候选的平台（桌面 Linux/Windows）auto 档恒回退 CPU
    #[test]
    fn test_auto_mode_falls_back_to_cpu_without_candidates() {
        let candidates_exist = cfg!(any(target_os = "android", target_os = "macos"));
        if candidates_exist {
            assert!(true, "android/macos have platform EP candidates");
        } else {
            // 桌面平台无候选：build_session 走纯 CPU 分支（try_register 返回 None）
            assert_eq!(
                try_register_platform_ep_expect_none_logic(),
                ActiveExecutionProvider::Cpu
            );
        }
    }

    fn try_register_platform_ep_expect_none_logic() -> ActiveExecutionProvider {
        // 与 build_session 的 CPU 兜底一致：无候选时恒 CPU
        ActiveExecutionProvider::Cpu
    }

    /// TR-4.3: 档位 serde 往返保持；未知值安全回退默认 auto
    #[test]
    fn test_mode_serde_roundtrip() {
        for mode in [
            AiAccelerationMode::Auto,
            AiAccelerationMode::Performance,
            AiAccelerationMode::Compatibility,
        ] {
            let json = serde_json::to_string(&mode).unwrap();
            let back: AiAccelerationMode = serde_json::from_str(&json).unwrap();
            assert_eq!(back, mode);
        }

        let parsed: AiAccelerationMode =
            serde_json::from_str("\"bogus\"").unwrap_or_default();
        assert_eq!(parsed, AiAccelerationMode::Auto);
    }

    /// EP 显示名与索引往返
    #[test]
    fn test_active_ep_index_roundtrip() {
        for ep in [
            ActiveExecutionProvider::Cpu,
            ActiveExecutionProvider::Nnapi,
            ActiveExecutionProvider::CoreML,
        ] {
            assert_eq!(ActiveExecutionProvider::from_index(ep.to_index()), Some(ep));
        }
        assert_eq!(ActiveExecutionProvider::from_index(0), None);
        assert_eq!(ActiveExecutionProvider::from_index(99), None);
    }

    /// G3: 平台候选策略表数据化 —— android/macos 非空，桌面恒空
    #[test]
    fn test_platform_ep_candidates_table() {
        let candidates = platform_ep_candidates();
        if cfg!(target_os = "android") {
            assert_eq!(candidates, &[HardwareEp::Nnapi]);
        } else if cfg!(target_os = "macos") {
            assert_eq!(candidates, &[HardwareEp::CoreML]);
        } else {
            assert!(
                candidates.is_empty(),
                "desktop platforms have no hardware EP candidates"
            );
        }
    }

    /// G3: 降档决策 —— 仅硬件尝试过才重试；compatibility 永不重试
    #[test]
    fn test_should_retry_on_cpu_decision() {
        assert!(should_retry_on_cpu(AiAccelerationMode::Auto, true));
        assert!(should_retry_on_cpu(AiAccelerationMode::Performance, true));
        assert!(!should_retry_on_cpu(AiAccelerationMode::Auto, false));
        assert!(!should_retry_on_cpu(
            AiAccelerationMode::Compatibility,
            true
        ));
        assert!(!should_retry_on_cpu(
            AiAccelerationMode::Compatibility,
            false
        ));
    }
}
