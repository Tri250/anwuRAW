# 处理引擎契约测试体系（M1-E1）— 产品需求文档

## Overview

- **Summary**: 为 70+ 调整参数建立"JSON → GlobalAdjustments 解析 → CPU/GPU 应用"全链路黄金样本回归体系。合成基准图 × 参数扫描矩阵，以 ΔE2000 为度量做两层验证：(a) 快照回归防漂移；(b) CPU 与 GPU 双实现对齐（ΔE2000 < 1.0）。全部接入 CI 并阻断合并。

- **Purpose**: 这是 2.0 所有处理类改动（色彩管理、缓存升级、tone mapper 调整）的安全网 —— 在引擎变更前建立，避免任何重构返工。

- **Target Users**: 维护者与贡献者（开发期质量基建，不影响终端用户可见功能）。

## Goals

- 合成基准图资产库（无版权风险）：渐变、24 色卡、高动态范围、噪声、肤色、饱和色边缘等 16 张
- 参数扫描矩阵：每个调整参数 × 5 档典型值 × 基准图子集
- 快照回归 harness：管线输出 vs 已批准基线，ΔE2000 均值/最大值双阈值
- CPU/GPU 一致性 harness：对双实现参数（如 AgX tonemap）做 ΔE2000 < 1.0 校验
- CI 阻断：软件 Vulkan（lavapipe）跑 GPU 路径，单次 < 15 分钟

## Non-Goals

- 不修改任何生产代码（image_processing.rs / gpu_processing.rs / WGSL 只读）
- 不做性能基准（那是 E3，另行立项）
- 不做 RAW 解码器本身的正确性验证（rawler 上游职责）
- 不追求像素级 bit-exact（ΔE 感知阈值即可）

## Background & Context

- 管线实况（已核实）：
  - GPU 主管线：`src-tauri/src/shaders/shader.wgsl`（含 dehaze L1007、glow L1536、halation、tonemapper 等）
  - CPU 预/后处理：`image_processing.rs::apply_post_gpu_adjustments`（L3490，通道混合器 + 分离色调）、`apply_cpu_agx_tonemap`（L1877）、raw preprocessing（L1132）
  - 参数解析入口：`image_processing.rs::get_global_adjustments_from_json`
  - `GlobalAdjustments` 为 `#[repr(C)]` 结构体（含 padding），参数面约 70+ 字段（`src/utils/adjustments.ts` 对应）
- 测试基建现状：74 个 Rust 测试但 CI 不执行；无图像输出正确性测试，全部为逻辑单测
- wgpu 29 支持 headless 创建 device；GitHub runner 无 GPU，需 lavapipe 软件适配器

## Functional Requirements

### FR-1: 基准图资产生成器
- `src-tauri/tests/golden/fixtures/` 合成 PNG 生成脚本（纯 Rust，cargo test 前置生成或 bin 工具）
- 16 张：线性渐变（R/G/B/灰）、24 色卡合成、HDR 高反差、单色噪场、肤色模拟、饱和色块边缘、极暗/极亮场、中间调人像模拟等
- 全部 16bit PNG 存储，测试时按需转 f32

### FR-2: 参数扫描矩阵
- 每个标量参数 5 档：min / -50% / default / +50% / max；枚举参数全枚举
- 结构参数（masks/crop/curves）取 3 组代表性 JSON 样本
- 矩阵清单以 TOML/JSON 数据文件维护，非硬编码

### FR-3: 快照回归 harness
- 输入：基准图 + 参数组合 → 完整管线（解析 → CPU/GPU 应用）→ 输出 PNG
- 对比：与 `baseline/` 目录已批准基线比较，报告 ΔE2000 mean/max/p99
- 阈值：mean < 0.5 且 max < 2.0；超限测试失败并列出偏差 top-10 参数
- 基线更新流程：`cargo test --features golden-baseline-update` 显式生成，人工审核后提交

### FR-4: CPU/GPU 一致性 harness
- 对双实现参数（tonemapper agx、通道混合器、分离色调等，以代码盘点为准）在 CPU 路径与 GPU 路径分别执行
- ΔE2000 < 1.0（与规划验收一致）；参数敏感项允许白名单豁免并记录原因

### FR-5: CI 接入
- 新增 workflow job：安装 `mesa-vulkan-drivers`（lavapipe）→ `WGPU_BACKEND=gl/vulkan` 软件路径 → 运行契约测试套件
- 阻断合并；总时长 < 15 分钟（参数矩阵可 shard）

## Non-Functional Requirements

- **NFR-1**: 不引入重依赖；ΔE2000 计算优先选用轻量 crate（如 `deltae`），否则在测试代码内自实现（Lab 转换 + CIEDE2000 公式）
- **NFR-2**: 基线文件体积可控（PNG 压缩 + 必要时 8bit 存储基线），仓库增量 < 50MB
- **NFR-3**: 契约测试独立 feature flag（`golden-tests`），默认 `cargo test` 不跑，CI 显式开启，避免拖慢日常开发

## Constraints

- **Technical**: wgpu 29 headless；lavapipe 对 WGSL 特性覆盖需验证（假设：本项目 shader 无 lavapipe 不支持的特性）
- **Business**: 不阻塞 1.6.15 hotfix train；生产代码零改动
- **Dependencies**: 允许新增 dev-dependencies（deltae 或等价物、toml 解析已有）

## Assumptions

- lavapipe 能正确执行本项目全部 WGSL（需 PoC 验证，见 Task 0）
- 合成图足以暴露管线回归（真实 RAW 照片不在仓库内，避免版权/体积）
- GPU 路径在 CI 软件渲染下数值结果与真机一致（浮点精度差异由 ΔE 阈值吸收）

## Acceptance Criteria

### AC-1: 资产与矩阵就绪
- **Type**: `rule`
- **Given**: 仓库 tests 目录
- **When**: 运行资产生成器
- **Then**: 16 张基准图 + 参数矩阵文件生成，清单与 FR-2 规则一致
- **Pass Condition**: 生成器可重复运行且输出幂等（hash 一致）

### AC-2: 快照回归全绿
- **Type**: `rule`
- **Given**: 已批准基线
- **When**: 全矩阵运行快照 harness
- **Then**: 全部通过（mean < 0.5 且 max < 2.0）
- **Pass Condition**: 报告输出 top-10 偏差参数且均在阈值内

### AC-3: 注入式回归被捕获
- **Type**: `rule`
- **Given**: 临时给某 CPU 后处理函数注入 +1/255 偏差（测试分支演示）
- **When**: 运行 harness
- **Then**: 对应参数测试失败并准确报告偏差量级
- **Pass Condition**: 演示录屏/日志留档

### AC-4: CPU/GPU 一致性
- **Type**: `rule`
- **Given**: 双实现参数清单
- **When**: 一致性 harness 运行
- **Then**: ΔE2000 < 1.0（白名单豁免项除外，需附理由）
- **Pass Condition**: 无白名单项时全绿；有白名单项时清单入仓

### AC-5: CI 阻断生效
- **Type**: `rule`
- **Given**: PR 修改 shader.wgsl
- **When**: CI 运行
- **Then**: 契约测试 job 执行并在回归时失败
- **Pass Condition**: job 时长 < 15 分钟

### AC-6: 工程质量
- **Type**: `rubric`
- **Dimension**: 测试代码可维护性
- **Scale**: 1-5
- **Anchors**: 1 = 硬编码路径/魔法数字泛滥；5 = 数据驱动、报告清晰、文档完备
- **Pass Threshold**: >= 4

## Open Questions

- [ ] lavapipe PoC：wgpu 29 + lavapipe 是否可跑完整 shader 管线？失败则降级为"CI 只跑 CPU 路径 + 手动触发 GPU job"（需在 Task 0 决断）
- [ ] `deltae` crate 许可证与维护状态？不满足则测试内自实现 CIEDE2000
- [ ] 基线 8bit 存储是否会掩盖 1/255 级回归？需在阈值标定时验证
