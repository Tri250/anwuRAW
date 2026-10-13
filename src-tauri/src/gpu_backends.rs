//! W4-D2 后端选择策略：vulkan（硬件）→ lavapipe（软件 vulkan）→ GL → 明确报错。
//!
//! 策略核为纯函数（`select_backend`），输入适配器探测列表，输出选择结果与
//! 用户可读说明；运行时探测由 `gpu_processing::get_or_init_gpu_context` 调用
//! `probe_adapters` 完成。无 GPU 环境不 panic，返回可操作错误信息。

use serde::Serialize;

/// 从 `wgpu::Backend` 投影的候选后端种类（便于纯函数测试与序列化到前端）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum BackendKind {
    Vulkan,
    Gl,
    Metal,
    Dx12,
    Noop,
}

impl BackendKind {
    pub fn from_wgpu(b: wgpu::Backend) -> Self {
        match b {
            wgpu::Backend::Vulkan => BackendKind::Vulkan,
            wgpu::Backend::Gl => BackendKind::Gl,
            wgpu::Backend::Metal => BackendKind::Metal,
            wgpu::Backend::Dx12 => BackendKind::Dx12,
            wgpu::Backend::Noop => BackendKind::Noop,
            _ => BackendKind::Noop,
        }
    }

    /// 解析 `WGPU_BACKEND` / 设置项中的用户强制后端名。
    pub fn parse(name: &str) -> Option<Self> {
        match name.trim().to_ascii_lowercase().as_str() {
            "vulkan" => Some(BackendKind::Vulkan),
            "gl" | "opengl" => Some(BackendKind::Gl),
            "metal" => Some(BackendKind::Metal),
            "dx12" | "d3d12" => Some(BackendKind::Dx12),
            _ => None,
        }
    }

    pub fn as_wgpu(self) -> wgpu::Backends {
        match self {
            BackendKind::Vulkan => wgpu::Backends::VULKAN,
            BackendKind::Gl => wgpu::Backends::GL,
            BackendKind::Metal => wgpu::Backends::METAL,
            BackendKind::Dx12 => wgpu::Backends::DX12,
            BackendKind::Noop => wgpu::Backends::empty(),
        }
    }
}

/// 从 `wgpu::AdapterInfo` 投影的适配器探测结果。
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct AdapterProbe {
    pub name: String,
    pub backend: BackendKind,
    pub device_type: DeviceKind,
    /// 软件实现（lavapipe/llvmpipe/SwiftShader 等）。
    pub is_software: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DeviceKind {
    DiscreteGpu,
    IntegratedGpu,
    Cpu,
    VirtualGpu,
    Other,
}

impl DeviceKind {
    pub fn from_wgpu(d: wgpu::DeviceType) -> Self {
        match d {
            wgpu::DeviceType::DiscreteGpu => DeviceKind::DiscreteGpu,
            wgpu::DeviceType::IntegratedGpu => DeviceKind::IntegratedGpu,
            wgpu::DeviceType::Cpu => DeviceKind::Cpu,
            wgpu::DeviceType::VirtualGpu => DeviceKind::VirtualGpu,
            wgpu::DeviceType::Other => DeviceKind::Other,
        }
    }
}

/// 判定适配器是否为软件渲染实现（lavapipe/llvmpipe/SwiftShader）。
fn is_software_adapter(name: &str, device_type: wgpu::DeviceType) -> bool {
    let n = name.to_ascii_lowercase();
    n.contains("lavapipe")
        || n.contains("llvmpipe")
        || n.contains("swiftshader")
        || n.contains("softpipe")
        || device_type == wgpu::DeviceType::Cpu
}

/// 由 wgpu 适配器信息构建探测结果。
pub fn probe_from_info(info: &wgpu::AdapterInfo) -> AdapterProbe {
    probe_from_parts(&info.name, info.backend, info.device_type)
}

/// 可测内核：由原始字段构建探测结果。
pub fn probe_from_parts(name: &str, backend: wgpu::Backend, device_type: wgpu::DeviceType) -> AdapterProbe {
    AdapterProbe {
        name: name.to_string(),
        backend: BackendKind::from_wgpu(backend),
        device_type: DeviceKind::from_wgpu(device_type),
        is_software: is_software_adapter(name, device_type),
    }
}

/// 后端选择结果。
#[derive(Debug, Clone, PartialEq)]
pub enum BackendSelection {
    /// 硬件 GPU，直接使用。
    Hardware(AdapterProbe),
    /// 软件回退（lavapipe 等），可用但必须向用户明示。
    SoftwareFallback(AdapterProbe, String),
}

/// 硬件优先级：Discrete > Integrated > 其他 > Virtual > Cpu（软件）。
fn hardware_rank(p: &AdapterProbe) -> u8 {
    if p.is_software {
        return u8::MAX;
    }
    match p.device_type {
        DeviceKind::DiscreteGpu => 0,
        DeviceKind::IntegratedGpu => 1,
        DeviceKind::Other => 2,
        DeviceKind::VirtualGpu => 3,
        DeviceKind::Cpu => u8::MAX,
    }
}

const SOFTWARE_FALLBACK_NOTICE: &str = "未检测到硬件 GPU，已回退到软件渲染（lavapipe）。画面功能完整但速度受限；如需加速请安装/更新显卡驱动或 Vulkan 运行库。";

/// 策略核：输入候选适配器（wgpu 枚举顺序即可），输出选择结果。
///
/// 规则：
/// 1. `forced_backend`（WGPU_BACKEND / 设置项）显式指定时，只在该后端内选择；
///    无匹配则报错并列出实际可用后端。
/// 2. 候选非空时，按硬件优先级选择；全部为软件实现时走 `SoftwareFallback`
///    并携带可操作提示（不失败——端侧可用性优先）。
/// 3. 候选为空 → 可操作错误信息（无 GPU 环境不 panic、不崩溃）。
pub fn select_backend(
    candidates: &[AdapterProbe],
    forced_backend: Option<&str>,
) -> Result<BackendSelection, String> {
    if candidates.is_empty() {
        return Err(no_adapter_message(forced_backend));
    }

    let filtered: Vec<&AdapterProbe> = if let Some(fb) = forced_backend {
        let kind = BackendKind::parse(fb).ok_or_else(|| {
            format!(
                "未知后端 '{fb}'。可用取值：vulkan / gl / metal / dx12（设置项 processing_backend 或 WGPU_BACKEND）。"
            )
        })?;
        let hit: Vec<&AdapterProbe> = candidates.iter().filter(|c| c.backend == kind).collect();
        if hit.is_empty() {
            let available: Vec<&str> = candidates
                .iter()
                .map(|c| match c.backend {
                    BackendKind::Vulkan => "vulkan",
                    BackendKind::Gl => "gl",
                    BackendKind::Metal => "metal",
                    BackendKind::Dx12 => "dx12",
                    BackendKind::Noop => "noop",
                })
                .collect();
            return Err(format!(
                "强制后端 '{fb}' 无可用适配器（检测到：{}）。请改回 'auto' 或移除 WGPU_BACKEND 后重试。",
                available.join(", ")
            ));
        }
        hit
    } else {
        candidates.iter().collect()
    };

    let best = filtered
        .into_iter()
        .min_by_key(|c| (hardware_rank(c), c.name.clone()))
        .expect("non-empty checked above");

    if best.is_software {
        return Ok(BackendSelection::SoftwareFallback(
            best.clone(),
            SOFTWARE_FALLBACK_NOTICE.to_string(),
        ));
    }
    Ok(BackendSelection::Hardware(best.clone()))
}

/// 无 GPU 环境的可操作错误信息（不 panic、不崩溃）。
pub fn no_adapter_message(forced_backend: Option<&str>) -> String {
    let forced_hint = match forced_backend {
        Some(fb) => format!(
            "当前强制后端为 '{fb}'。请先移除 WGPU_BACKEND 环境变量或将设置中处理后端改回 'auto'。\n"
        ),
        None => String::new(),
    };
    format!(
        "无法启动 GPU 渲染：未找到任何可用的图形适配器。\n{forced_hint}\
         可尝试：\n\
         1. 更新显卡驱动；\n\
         2. Linux 用户安装 Vulkan 运行库（如 mesa-vulkan-drivers）；\n\
         3. 无 GPU 环境（CI/容器/远程桌面）可安装 lavapipe（mesa-vulkan-drivers 附带）以启用软件渲染。"
    )
}

#[cfg(test)]
mod backend_strategy_tests {
    use super::*;

    fn probe(name: &str, backend: BackendKind, device: DeviceKind, software: bool) -> AdapterProbe {
        AdapterProbe {
            name: name.to_string(),
            backend,
            device_type: device,
            is_software: software,
        }
    }

    #[test]
    fn hardware_vulkan_preferred_over_software() {
        let cands = vec![
            probe("lavapipe", BackendKind::Vulkan, DeviceKind::Cpu, true),
            probe("RTX 4070", BackendKind::Vulkan, DeviceKind::DiscreteGpu, false),
        ];
        let sel = select_backend(&cands, None).unwrap();
        match sel {
            BackendSelection::Hardware(p) => assert_eq!(p.name, "RTX 4070"),
            other => panic!("expected hardware, got {other:?}"),
        }
    }

    #[test]
    fn discrete_preferred_over_integrated() {
        let cands = vec![
            probe("Intel Iris Xe", BackendKind::Vulkan, DeviceKind::IntegratedGpu, false),
            probe("AMD RX 7600", BackendKind::Vulkan, DeviceKind::DiscreteGpu, false),
        ];
        let sel = select_backend(&cands, None).unwrap();
        match sel {
            BackendSelection::Hardware(p) => assert_eq!(p.name, "AMD RX 7600"),
            other => panic!("expected hardware, got {other:?}"),
        }
    }

    #[test]
    fn software_only_falls_back_with_notice() {
        let cands = vec![probe("lavapipe (Mesa)", BackendKind::Vulkan, DeviceKind::Cpu, true)];
        let sel = select_backend(&cands, None).unwrap();
        match sel {
            BackendSelection::SoftwareFallback(p, notice) => {
                assert!(p.is_software);
                assert!(notice.contains("软件渲染"));
                assert!(notice.contains("驱动"));
            }
            other => panic!("expected software fallback, got {other:?}"),
        }
    }

    #[test]
    fn gl_fallback_when_no_vulkan() {
        let cands = vec![probe("llvmpipe GL", BackendKind::Gl, DeviceKind::Cpu, true)];
        let sel = select_backend(&cands, None).unwrap();
        match sel {
            BackendSelection::SoftwareFallback(p, _) => assert_eq!(p.backend, BackendKind::Gl),
            other => panic!("expected software fallback, got {other:?}"),
        }
    }

    #[test]
    fn empty_candidates_returns_actionable_error() {
        let err = select_backend(&[], None).unwrap_err();
        assert!(err.contains("无法启动 GPU 渲染"));
        assert!(err.contains("mesa-vulkan-drivers"));
        assert!(err.contains("lavapipe"));
    }

    #[test]
    fn forced_backend_is_honored() {
        let cands = vec![
            probe("llvmpipe", BackendKind::Gl, DeviceKind::Cpu, true),
            probe("RTX 4070", BackendKind::Vulkan, DeviceKind::DiscreteGpu, false),
        ];
        let sel = select_backend(&cands, Some("gl")).unwrap();
        match sel {
            BackendSelection::SoftwareFallback(p, _) => assert_eq!(p.name, "llvmpipe"),
            other => panic!("expected forced gl, got {other:?}"),
        }
    }

    #[test]
    fn forced_backend_missing_reports_available() {
        let cands = vec![probe("RTX 4070", BackendKind::Vulkan, DeviceKind::DiscreteGpu, false)];
        let err = select_backend(&cands, Some("dx12")).unwrap_err();
        assert!(err.contains("强制后端 'dx12' 无可用适配器"));
        assert!(err.contains("vulkan"));
    }

    #[test]
    fn forced_backend_unknown_name_errors() {
        let cands = vec![probe("RTX 4070", BackendKind::Vulkan, DeviceKind::DiscreteGpu, false)];
        let err = select_backend(&cands, Some("wat")).unwrap_err();
        assert!(err.contains("未知后端 'wat'"));
    }

    #[test]
    fn no_adapter_message_includes_forced_hint() {
        let msg = no_adapter_message(Some("vulkan"));
        assert!(msg.contains("WGPU_BACKEND"));
    }

    #[test]
    fn probe_from_info_detects_lavapipe() {
        let p = probe_from_parts("lavapipe (LLVM 17)", wgpu::Backend::Vulkan, wgpu::DeviceType::Cpu);
        assert!(p.is_software);
        assert_eq!(p.backend, BackendKind::Vulkan);
        let hw = probe_from_parts("AMD Radeon 780M", wgpu::Backend::Vulkan, wgpu::DeviceType::IntegratedGpu);
        assert!(!hw.is_software);
        assert_eq!(hw.device_type, DeviceKind::IntegratedGpu);
    }
}
