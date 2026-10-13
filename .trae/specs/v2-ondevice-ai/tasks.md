# 端侧 AI 强化 — 实施计划

## Task 0: PoC — NNAPI/CoreML EP 可用性验证

- **Status**: `pending`
- **Priority**: high
- **Depends On**: None
- **Description**:
  - Android：开启 ort NNAPI EP 编译，对 SAM encoder/decoder、LaMa fp16 各跑一次真实推理，记录算子回退日志与耗时
  - macOS：CoreML EP 同样验证（含 Intel Mac 一次）
  - **决策点**: EP 覆盖不足的模型在 FR-3 中标记 `ep: [cpu]`，写明结论
- **Acceptance Criteria Addressed**: AC-4 前置
- **Test Requirements**:
  - `rule` TR-0.1: PoC 记录入仓（`docs` 不建，结论写入 spec Open Questions 勾选）
- **Notes**: go/no-go 门；失败不阻塞 FR-1/FR-2（CPU 路径独立成立）

## Task 1: 移除 Clerk 及云账号 UI

- **Status**: `done`（2026-10-13 完成；bundle gzip 626.51→583.36 kB，−6.9%）
- **Priority**: high
- **Depends On**: None
- **Description**:
  - `App.tsx`：移除 ClerkProvider 包装、`@clerk/react` import、硬编码 publishable key（L5/L83/L1063）
  - `SettingsPanel.tsx`：移除登录/登出区块（L27 import、L319 useClerk），替换"本地优先"说明文案
  - `AIPanel.tsx`：移除 useUser/useAuth（L65）及云服务相关 UI 占位
  - `useAiMasking.ts`：移除 useAuth 门控（L9），AI 蒙版无条件执行
  - `package.json`：删除 `@clerk/react`；`npm run build` + `typecheck` + 全量 grep 验证
  - 记录 bundle 体积前后对比（NFR-5）
- **Acceptance Criteria Addressed**: AC-1、AC-2
- **Test Requirements**:
  - `rule` TR-1.1: `grep -ri clerk src/ package.json` 零命中
  - `rule` TR-1.2: build/typecheck 通过
  - `rule` TR-1.3: 现有前端测试（tests/frontend/）全绿
- **Notes**: 纯删除性改动，风险最低，可先行独立合入

## Task 2: 模型 Manifest 数据结构

- **Status**: `pending`
- **Priority**: high
- **Depends On**: None
- **Description**:
  - Rust 侧 `ModelManifest` 结构 + 内置 `models.json`（现有 7 模型 + 变体字段：filename/size/sha256/precision/optional/recommended_ep）
  - ai_processing.rs 现有硬编码文件名常量（ENCODER_FILENAME 等）迁移为 manifest 查询，保留旧文件名兼容（已下载模型不重下）
  - sha256 校验接入现有下载链路（blake3/sha2 已在依赖）
- **Acceptance Criteria Addressed**: AC-3 前置
- **Test Requirements**:
  - `rule` TR-2.1: manifest 解析单测；旧模型文件名兼容映射测试
  - `rule` TR-2.2: sha256 校验对损坏文件报明确错误
- **Notes**: 为 A1 模型管理器（另行立项）预留数据结构，本任务只做数据层不做管理 UI

## Task 3: 模型量化工具链与 INT8 变体生产

- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 2
- **Description**:
  - `tools/` 新增量化脚本（onnxruntime quantization 静态量化），先做 SAM encoder（体积/耗时大头）
  - 产出 INT8 变体上传 HuggingFace 仓库，manifest 登记
  - 20 张标准测试图集（合成 + 已获授权样本）建立 IoU 对比基线：INT8 vs fp16
- **Acceptance Criteria Addressed**: AC-3
- **Test Requirements**:
  - `rule` TR-3.1: SAM 蒙版 IoU 下降 < 2%（NFR-2）
  - `rule` TR-3.2: 量化脚本可重复运行
- **Notes**: LaMa 量化视 SAM 结果决定（Open Question 2）

## Task 4: EP 执行委托层

- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 0, Task 2
- **Description**:
  - 新增 `AiAccelerationMode`（auto/performance/compatibility）+ 单一抽象层选择 EP：探测 NNAPI/CoreML 可用性 → 按 manifest 每模型 `recommended_ep` 约束 → 逐级回退 CPU
  - 全部 Session 创建收敛到该层（盘点 ai_processing/denoising/mask_generation/inpainting 中现有 session builder）
  - 设置项持久化（app_settings.rs）+ 设置页"AI 加速档位"下拉 + 当前生效 EP 显示
  - i18n 13 语言键位补齐
- **Acceptance Criteria Addressed**: AC-4
- **Test Requirements**:
  - `rule` TR-4.1: compatibility 档在所有平台恒为 CPU 成功
  - `rule` TR-4.2: auto 档在无 NNAPI/CoreML 设备正确回退
  - `rule` TR-4.3: 设置项重启后保持
- **Notes**: EP 选择失败必须回退而非 panic；错误信息入日志

## Task 5: 可选下载包与离线状态

- **Status**: `pending`
- **Priority**: medium
- **Depends On**: Task 2
- **Description**:
  - manifest `optional` 模型：首次使用时体积预估确认框；未下载 + 无网 → 明确离线文案 + 有网自动重试
  - 现有下载 UI 的状态可视化（已下载/下载中/失败/离线）
  - 飞行模式手动测试清单执行（桌面断网 + Android 飞行模式）
- **Acceptance Criteria Addressed**: AC-5
- **Test Requirements**:
  - `rule` TR-5.1: 离线测试清单全过
  - `rule` TR-5.2: 未下载模型离线时 UI 文案正确（i18n 全语言键位存在）
- **Notes**: 不做后台自动下载（用户明确触发）

## Task 6: 性能验证与收尾

- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 3, 4, 5
- **Description**:
  - 中端 Android 真机（骁龙 7 系档）AI 蒙版全流程计时：目标 < 2s（NFR-1）
  - 桌面三平台回归：AI 全功能 + 加速档位切换
  - 移除 Clerk 后体积对比报告入 spec Open Questions 结论
  - 代码质量自评（rubric AC-6）：EP 抽象单层、manifest 数据驱动
- **Acceptance Criteria Addressed**: AC-3、AC-6、NFR-1/2/5
- **Test Requirements**:
  - `rule` TR-6.1: 计时报告达标（3 次取中位数）
  - `rubric` TR-6.2: 架构评审 >= 4
- **Notes**: 性能数据同时为模块规划 M11-B3（性能档位）提供输入
