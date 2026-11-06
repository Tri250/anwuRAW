//! P0-2（release v2.1.16）：Android CPU 推理性能分级。
//!
//! 背景（参照 ZhaJinWenQianCake 的"CPU 1000s+"病理教训）：ORT 默认按全部
//! 物理核分配 intra-op 线程，移动端大核/小核混布下线程在簇间反复迁移，
//! 加上 sync 开销，单次前向反而变慢且明显发热、触发热节流。这里按机型
//! 内存/核数分三档，把 intra-op 线程数与 LaMa 推理像素预算收敛到安全值；
//! 桌面端一律返回 None/桌面默认值，行为与分级前完全一致。
//!
//! 机型分档纯函数 `classify_tier` 不碰平台 API，可在宿主机上测试。

/// 机型档位（仅 Android 使用；桌面端不参与分级）。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum DeviceTier {
    /// 旗舰：大内存 + 多核，允许 2 线程。
    Flagship,
    /// 中端：4 线程档位的主流机型，允许 2 线程。
    Mid,
    /// 低端：内存/核数受限，单线程 + 最小推理预算。
    Low,
}

impl DeviceTier {
    pub fn label(self) -> &'static str {
        match self {
            DeviceTier::Flagship => "flagship",
            DeviceTier::Mid => "mid",
            DeviceTier::Low => "low",
        }
    }

    /// Android 上的 intra-op 线程上限（方案口径：移动端 1~2 线程）。
    pub fn intra_op_threads(self) -> usize {
        match self {
            DeviceTier::Flagship | DeviceTier::Mid => 2,
            DeviceTier::Low => 1,
        }
    }

    /// LaMa 推理像素预算的边长（LaMa 为全卷积 FFC 结构，动态尺寸无质量
    /// 回退风险；预算越低峰值内存越小，但上采样回原图的糊度越高）。
    pub fn lama_pixel_budget(self) -> f32 {
        match self {
            DeviceTier::Flagship => 768.0,
            DeviceTier::Mid => 576.0,
            DeviceTier::Low => 448.0,
        }
    }
}

/// 纯分档函数：输入可用核数与总内存（MB），输出机型档位。
///
/// 阈值口径（对齐 2023-2026 主流 Android 机型分布）：
/// - 旗舰：>= 6 核且 >= 7.5GB 内存（8G/12G/16G 旗舰机型）；
/// - 中端：>= 4 核且 >= 3.5GB 内存（4G/6G/8G 中端机型）；
/// - 低端：其余（3GB 及以下或双核/四核入门机）。
pub fn classify_tier(cores: usize, total_ram_mb: u64) -> DeviceTier {
    if cores >= 6 && total_ram_mb >= 7_500 {
        DeviceTier::Flagship
    } else if cores >= 4 && total_ram_mb >= 3_500 {
        DeviceTier::Mid
    } else {
        DeviceTier::Low
    }
}

/// 读取 `/proc/meminfo` 的 MemTotal（KB -> MB）。Android 与桌面 Linux 均可用；
/// 读取失败返回 0（诊断报告里 0 = 未知）。Android 分档时 0 会落到低端档
/// （保守方向：线程最少、预算最小）。
fn total_memory_mb() -> u64 {
    let content = match std::fs::read_to_string("/proc/meminfo") {
        Ok(content) => content,
        Err(_) => return 0,
    };
    for line in content.lines() {
        if let Some(rest) = line.strip_prefix("MemTotal:") {
            let kb: u64 = rest
                .split_whitespace()
                .next()
                .and_then(|value| value.parse().ok())
                .unwrap_or(0);
            return kb / 1024;
        }
    }
    0
}

/// 诊断报告用：进程可见核数（宿主机上同样可报）。
pub fn detected_cores() -> usize {
    available_cores()
}

/// 诊断报告用：总内存 MB（0 = 当前平台探测不到）。
pub fn detected_ram_mb() -> u64 {
    total_memory_mb()
}

fn available_cores() -> usize {
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1)
}

/// 当前机型档位（Android）；桌面端恒为旗舰档但不会被查询——
/// 桌面端只经过 `mobile_intra_threads()`/`lama_pixel_budget()`，二者在
/// 非 Android 平台直接返回 None/桌面默认值。
#[cfg(target_os = "android")]
pub fn device_tier() -> DeviceTier {
    classify_tier(available_cores(), total_memory_mb())
}

/// Android 的 intra-op 线程上限；桌面端 None = 保持 ORT 默认（吃满物理核，
/// 与分级前行为一致，桌面无移动端的热节流约束）。
pub fn mobile_intra_threads() -> Option<usize> {
    #[cfg(target_os = "android")]
    {
        Some(device_tier().intra_op_threads())
    }
    #[cfg(not(target_os = "android"))]
    {
        None
    }
}

/// LaMa 推理像素预算（平方后即最大像素数）。桌面端维持历史值 768×768。
pub fn lama_pixel_budget() -> f32 {
    #[cfg(target_os = "android")]
    {
        device_tier().lama_pixel_budget()
    }
    #[cfg(not(target_os = "android"))]
    {
        768.0
    }
}

/// 诊断报告用：机型档位标签。桌面端报 "desktop"（不参与移动端分级）。
pub fn tier_label() -> &'static str {
    #[cfg(target_os = "android")]
    {
        device_tier().label()
    }
    #[cfg(not(target_os = "android"))]
    {
        "desktop"
    }
}

/// 诊断报告用：当前 intra-op 线程上限（None = ORT 默认）。
pub fn intra_op_threads_label() -> String {
    match mobile_intra_threads() {
        Some(threads) => threads.to_string(),
        None => "default".to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_tier_boundaries() {
        // 旗舰：多核 + 大内存
        assert_eq!(classify_tier(8, 12_288), DeviceTier::Flagship);
        assert_eq!(classify_tier(6, 8_192), DeviceTier::Flagship);
        assert_eq!(classify_tier(8, 7_500), DeviceTier::Flagship);
        // 中端：核够但内存不到旗舰线 / 内存够但核数少
        assert_eq!(classify_tier(8, 4_096), DeviceTier::Mid);
        assert_eq!(classify_tier(4, 6_144), DeviceTier::Mid);
        assert_eq!(classify_tier(4, 3_500), DeviceTier::Mid);
        // 低端：入门机
        assert_eq!(classify_tier(4, 3_072), DeviceTier::Low);
        assert_eq!(classify_tier(2, 2_048), DeviceTier::Low);
        // 内存探测失败（0 MB）必须落到低端（线程最少、预算最小）
        assert_eq!(classify_tier(8, 0), DeviceTier::Low);
    }

    #[test]
    fn tier_policies_are_within_mobile_guidance() {
        for tier in [DeviceTier::Flagship, DeviceTier::Mid, DeviceTier::Low] {
            // 方案口径：移动端 intra-op 线程 1~2
            assert!((1..=2).contains(&tier.intra_op_threads()));
            // LaMa 预算必须是 32 的倍数（张量对齐要求）且不超过桌面值
            let budget = tier.lama_pixel_budget();
            assert!(budget <= 768.0 && budget % 32.0 == 0.0);
        }
        // 低端必须比旗舰更保守
        assert!(DeviceTier::Low.intra_op_threads() <= DeviceTier::Flagship.intra_op_threads());
        assert!(DeviceTier::Low.lama_pixel_budget() < DeviceTier::Flagship.lama_pixel_budget());
    }

    #[test]
    fn desktop_keeps_ort_defaults() {
        // 桌面（测试宿主是 linux）不限制线程、不改 LaMa 预算
        if !cfg!(target_os = "android") {
            assert_eq!(mobile_intra_threads(), None);
            assert_eq!(lama_pixel_budget(), 768.0);
            assert_eq!(tier_label(), "desktop");
            assert_eq!(intra_op_threads_label(), "default");
        }
    }
}
