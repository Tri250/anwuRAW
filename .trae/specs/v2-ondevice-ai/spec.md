# 端侧 AI 强化（M4-A2）— 产品需求文档

## Overview

- **Summary**: 在"不做商业、不做云服务、以端侧为主"的产品决策下，将 AI 能力的护城河落在端侧：(1) 彻底移除 Clerk 云账号依赖及其 UI 门控；(2) 建立 ONNX 模型量化分级（fp32/fp16/INT8）；(3) 打通硬件执行委托（Android NNAPI / macOS CoreML / 桌面直通）；(4) 大体积生成式模型改为可选下载包；(5) 全 AI 功能离线可用保障。

- **Purpose**: AI 全功能离线可用率 100%、中端 Android AI 蒙版 < 2s、安装包/模型体积分级达标 —— 端侧优先叙事的技术兑现。

- **Target Users**: 全平台用户；重点是无高性能 GPU、无外网稳定连接、拒绝云服务的隐私敏感用户。

## Goals

- 移除 `@clerk/react` 及全部云账号 UI/逻辑（App.tsx ClerkProvider、SettingsPanel 登录区、AIPanel/useAiMasking auth 门控），AI 功能无条件可用
- 模型 manifest 化：名称/变体/体积/sha256/精度档/设备要求，驱动下载与选择
- INT8 量化变体落地（优先 SAM encoder —— 体积/耗时大头），按设备档位自动选择
- ort ExecutionProvider 配置矩阵：Android NNAPI、macOS CoreML、桌面 CPU/直通，设置页"AI 加速档位"（自动/性能/兼容）
- 生成式增强大模型（如有）改为可选下载包 + 体积预估 UI
- 飞行模式全功能可用（首次模型下载除外），断网有明确状态提示

## Non-Goals

- 不引入任何云服务、账号体系、遥测（产品决策红线）
- 不训练/微调自有模型（只做量化与推理侧优化）
- 不做模型市场/插件机制（A1 模型管理器另行立项，本 spec 只做 manifest 数据结构基础）
- 不改变现有 AI 功能的算法语义（量化带来的精度变化由 AC 阈值约束）

## Background & Context

- 模型清单（已核实 `ai_processing.rs`）：SAM vit_b encoder/decoder（AI 蒙版）、u2net（前景）、skyseg（天空）、CLIP（自动标签）、NIND（降噪）、LaMa fp16（修复）、Depth Anything v2 vits（深度）
- 下载链路：hf-mirror.com → huggingface.co 降级（端点支持 auto/mirror/official/自定义 URL）
- 推理：`ort =2.0.0-rc.10`，features `ndarray,load-dynamic`（运行时动态加载 onnxruntime so）
- Clerk 使用面（已核实）：`App.tsx` L5/L83（ClerkProvider + 硬编码 dev publishable key）/L1063、`SettingsPanel.tsx` L27/L319（登录/登出 UI）、`AIPanel.tsx` L65（useUser/useAuth）、`useAiMasking.ts` L9（useAuth 门控）
- ort 2.0-rc.10 ExecutionProvider 能力：CPU 内置；NNAPI/CoreML/CUDA/DirectML 需对应 feature 与运行时 provider 可用性检查

## Functional Requirements

### FR-1: 移除 Clerk 云账号依赖
- 删除 `@clerk/react` 依赖与全部 import（App.tsx / SettingsPanel / AIPanel / useAiMasking）
- SettingsPanel 中云登录/订阅占位 UI 区块移除，替换为"本地优先"说明文案（i18n 13 语言键位补齐）
- `useAiMasking` 移除 auth 门控：AI 蒙版功能无条件可用
- App.tsx 移除 ClerkProvider 包装与硬编码 publishable key（同时消除密钥泄露面）

### FR-2: 模型 Manifest 与量化分级
- `models.json` manifest：每模型多变体（fp32/fp16/INT8），含 filename/size/sha256/source URL/精度档/推荐设备档位
- 量化产物：优先 SAM encoder（最大头）与 LaMa 生成 INT8 变体；量化脚本（onnxruntime quantization 工具链）入仓 `tools/`
- 推理侧按 manifest + 设备档位选择变体；已下载旧变体继续可用

### FR-3: 硬件执行委托
- ort Session builder 按 `AiAccelerationMode` 选择 EP：
  - `auto`（默认）：探测可用 EP，Android NNAPI → CoreML → CPU 逐级回退
  - `performance`：强制 NNAPI/CoreML（不可用时报错回退）
  - `compatibility`：强制 CPU（规避 NNAPI 算子缺失问题）
- Settings → Processing 增加"AI 加速档位"设置项，持久化到现有 app_settings
- 每次会话记录实际生效 EP（设置页显示"当前 AI 加速：NNAPI"）

### FR-4: 可选模型下载包
- 非默认必需的模型（如未来的生成式增强大模型）标记 `optional: true`，UI 显示体积预估 + 按需下载
- 默认必需模型清单收敛：AI 蒙版/天空/前景/深度为默认；降噪/修复按首次使用提示下载（现状保持，但状态可视化）

### FR-5: 离线可用保障
- 全 AI 功能在无网环境可用（模型已下载前提下）；未下载时给出明确离线状态文案与"有网后自动重试"提示
- 现有 hf-mirror → 官方降级链保持；下载重试与断点续传行为回归验证

## Non-Functional Requirements

- **NFR-1**: 中端 Android（骁龙 7 系档）SAM 蒙版生成 < 2s（INT8 + NNAPI 路径）
- **NFR-2**: 量化后精度损失：AI 蒙版 IoU 相对 fp16 下降 < 2%（标准测试图集 20 张）
- **NFR-3**: 安装包体积不增长（量化模型不打入安装包，仍走下载；manifest 内置）
- **NFR-4**: 零新增网络依赖：manifest 中 URL 仅指向现有 HuggingFace 仓库
- **NFR-5**: 移除 Clerk 后 bundle 体积减少（记录前后对比）

## Constraints

- **Technical**: ort =2.0.0-rc.10（pin 原因见 Cargo.toml 注释体系）；NNAPI EP 对算子覆盖有限，需逐模型验证
- **Business**: 无云、无账号、无遥测 —— 红线不可违反
- **Dependencies**: 量化工具链（onnxruntime quantization Python 工具）仅用于模型生产，不进应用依赖

## Assumptions

- HuggingFace 仓库（CyberTimon/RapidRAW-Models）可持续上传 INT8 变体
- ort rc.10 的 NNAPI/CoreML EP 经 feature 开启后在本项目模型上可用（PoC 验证，见 Task 0）
- 移除 Clerk 不影响其他功能（已核实 Clerk 仅在上述 4 个文件被引用）

## Acceptance Criteria

### AC-1: Clerk 彻底移除
- **Type**: `rule`
- **Given**: 代码库
- **When**: 全局搜索 clerk / @clerk
- **Then**: 零命中；`npm run build` 成功；Settings 无登录区块
- **Pass Condition**: package.json 无 @clerk/react；App.tsx 无 ClerkProvider；grep 零命中

### AC-2: AI 功能无条件可用
- **Type**: `rule`
- **Given**: 全新安装且未登录任何账号
- **When**: 使用 AI 蒙版/天空/深度/标签
- **Then**: 全部正常工作，无任何账号相关提示或门控
- **Pass Condition**: useAiMasking 无 auth 分支；AIPanel 无 useUser 调用

### AC-3: 量化分级生效
- **Type**: `rule`
- **Given**: manifest 含 SAM encoder INT8 变体
- **When**: 低档设备触发 AI 蒙版
- **Then**: 自动选择 INT8 变体下载并推理，蒙版质量达标
- **Pass Condition**: NFR-2 IoU 下降 < 2%（20 张测试图集）；NFR-1 耗时 < 2s

### AC-4: 硬件委托可配置
- **Type**: `rule`
- **Given**: 设置页 AI 加速档位
- **When**: 分别切换 auto/performance/compatibility
- **Then**: 实际 EP 按预期选择并在设置页正确显示；compatibility 恒为 CPU 可用
- **Pass Condition**: 三档切换后推理均成功；显示与实际一致

### AC-5: 离线可用
- **Type**: `rule`
- **Given**: 已下载所需模型的设备
- **When**: 开启飞行模式执行全部 AI 功能
- **Then**: 全部成功；未下载模型时显示离线状态文案而非网络错误堆栈
- **Pass Condition**: 手动飞行模式测试清单通过

### AC-6: 工程质量
- **Type**: `rubric`
- **Dimension**: EP 抽象与 manifest 设计一致性
- **Scale**: 1-5
- **Anchors**: 1 = EP 逻辑散落各处；5 = 单一抽象层 + 数据驱动 manifest
- **Pass Threshold**: >= 4

## Open Questions

- [ ] ort rc.10 NNAPI EP 对 SAM/LaMa 算子覆盖率？PoC 结论决定 Android 端默认档位
- [ ] INT8 量化对 LaMa 生成质量的退化可接受度？如超阈值则 LaMa 保持 fp16
- [ ] CoreML EP 在 Intel Mac 的兼容性？（macos-15-intel 构建仍在发布矩阵）
