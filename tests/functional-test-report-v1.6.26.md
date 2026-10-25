# anwuRAW v1.6.26 六模块功能测试执行报告

| 项目 | 结果 |
|---|---|
| 被测版本 | v1.6.26，基线 commit `b5fd08e` |
| 执行日期 | 2026-10-25 |
| 测试范围 | 调整、裁剪与变换、蒙版、图像修复、预设、导出 |
| 执行环境 | Linux x64；Node.js v22.23.2；npm 10.9.8；Vitest 2.1.9；jsdom；React 19 |
| 执行结果 | **28 个测试文件 / 763 条用例全部通过，0 失败、0 跳过** |
| 功能追溯 | 六模块 **721** 条，公共回归 **42** 条；763 条编号连续、无重复、无缺口 |
| 类型检查 | `tsc --noEmit` 通过 |
| 缺陷闭环 | 发现并修复 **8** 个产品缺陷，均有回归用例保护 |
| 结论 | 计划中识别的全部子功能均有自动化用例覆盖，无未关闭的阻断性缺陷 |

## 1. 执行结果

执行命令：

```bash
cd /data/anwuRAW
npx vitest run --coverage \
  --coverage.reporter=json-summary \
  --coverage.reporter=text \
  --reporter=json \
  --outputFile=/tmp/final-vitest-results.json
```

结果：Vitest JSON 报告 `numTotalTests=763`、`numPassedTests=763`、`numFailedTests=0`，151 个测试套件全部通过；并行墙钟耗时约 61.1 秒。

| 模块 | 测试套件 | 用例数 | 通过 | 失败 | 行覆盖 | 函数覆盖 | 分支覆盖 |
|---|---|---:|---:|---:|---:|---:|---:|
| 调整 | 7 | 178 | 178 | 0 | 97.03% (4548/4687) | 88.55% (201/227) | 84.33% (764/906) |
| 裁剪与变换 | 2 | 73 | 73 | 0 | 97.38% (2190/2249) | 95.37% (103/108) | 79.94% (498/623) |
| 蒙版 | 5 | 146 | 146 | 0 | 89.36% (2619/2931) | 87.73% (143/163) | 82.93% (646/779) |
| 图像修复 | 1 | 105 | 105 | 0 | 96.18% (1890/1965) | 87.50% (105/120) | 86.18% (530/615) |
| 预设 | 3 | 146 | 146 | 0 | 94.32% (2143/2272) | 86.59% (71/82) | 89.94% (635/706) |
| 导出 | 3 | 73 | 73 | 0 | 99.54% (1297/1303) | 100.00% (39/39) | 92.48% (283/306) |
| **六模块合计** | **21** | **721** | **721** | **0** | **95.32% (14687/15407)** | **89.58% (662/739)** | **85.28% (3356/3935)** |
| 公共回归 | 7 | 42 | 42 | 0 | 不纳入模块统计 | — | — |
| **总计** | **28** | **763** | **763** | **0** | — | — | — |

> 覆盖率统计范围由 `vitest.config.mts` 固定为六模块生产文件，包含 `TransformModal`、`LensCorrectionModal`、`ConfigurePresetModal`、`ExportPresetsList`、`ImagePicker` 等关联组件。覆盖率是辅助指标，功能完成度以第 2 节的逐项追溯为准。

## 2. 100% 子功能追溯

逐条用例见 `tests/functional-test-cases-v1.6.26.csv`，共 763 行，编号规则与范围如下：

| 模块 | TC 范围 | 数量 | 连续/唯一 |
|---|---|---:|---|
| 调整 | TC-ADJ-001 .. TC-ADJ-178 | 178 | 是 |
| 裁剪与变换 | TC-CROP-001 .. TC-CROP-073 | 73 | 是 |
| 蒙版 | TC-MASK-001 .. TC-MASK-146 | 146 | 是 |
| 图像修复 | TC-REPAIR-001 .. TC-REPAIR-105 | 105 | 是 |
| 预设 | TC-PRESET-001 .. TC-PRESET-146 | 146 | 是 |
| 导出 | TC-EXP-001 .. TC-EXP-073 | 73 | 是 |
| 公共回归 | TC-REG-001 .. TC-REG-042 | 42 | 是 |

CSV 校验结果：763 条记录、763 个唯一编号、0 重复、各模块编号无缺口、状态全部为 `passed`。

子功能与测试套件、Describe 分组的完整映射见 `tests/functional-test-plan-v1.6.26.md` 第 4、5 节。判定口径为“每个已识别子功能至少 1 条自动化用例，并覆盖交互、平台差异与错误路径”，而非单纯追求行覆盖率 100%。

### 2.1 覆盖率缺口说明

整体行覆盖 95.32%，未覆盖行主要位于以下防御/异步分支：

| 文件 | 行覆盖 | 缺口性质 |
|---|---:|---|
| `MasksPanel.tsx` | 86.63% | 极端异常清理、部分异步态回退 |
| `PresetsPanel.tsx` | 92.47% | 拖拽异常退出、预览加载边界 |
| `useAiMasking.ts` | 90.62% | 异步失败与切图竞态清理 |
| `Curves.tsx` | 93.20% | 画布事件防御分支 |
| `Color.tsx` | 95.98% | 部分条件组合 |

这些缺口均未对应“完全无用例”的子功能；主路径、关键错误路径和平台分支均已覆盖。`ExportPanel` 行覆盖 99.57%、函数覆盖 100%，为六模块最高。

## 3. 缺陷修复闭环

本轮通过测试发现并修复 8 个产品缺陷，全部附带回归用例：

| 编号 | 模块 | 缺陷与影响 | 修复 | 回归用例 |
|---|---|---|---|---|
| F-01 | 预设 | 文件夹拖到另一个文件夹时静默无反应，无法同级重排 | 在拖拽结束分支显式识别 `Folder → Folder` 并调用 `reorderItems`（`PresetsPanel.tsx`） | TC-PRESET-072 |
| F-02 | 图像修复 | Esc 处理器被包成 `() => handler`，按键时只返回函数而不执行，重命名/选择无法逐级取消 | 直接把 `handler` 注册到 `setCustomEscapeHandler`（`AIPanel.tsx`） | TC-REPAIR-092 |
| F-03 | 蒙版 | 与 F-02 相同，蒙版重命名与选择状态无法用 Esc 级联取消 | 直接注册 `handler`（`MasksPanel.tsx`） | TC-MASK-062 |
| F-04 | 导出 | 应用预设或上次设置后 `dpi` 已更新，但受控输入框仍显示旧值 300 | 增加 `useEffect(() => setDpiInput(String(dpi)), [dpi])`（`ExportPanel.tsx`） | TC-EXP-031、TC-EXP-033 |
| F-05 | 导出 | 修改 DPI、色彩空间或位深后大小估算不刷新 | 补齐估算 effect 依赖 `dpi/colorSpace/bitDepth`（`ExportPanel.tsx`） | TC-EXP-027 |
| F-06 | 导出 | 图库导出浮层在右侧面板未激活时被提前 return，尺寸与大小估算不执行 | 允许 `isLibraryContext` 绕过 `isPanelReallyActive` 限制（`ExportPanel.tsx`） | TC-EXP-016、TC-EXP-017、TC-EXP-030 |
| F-07 | 调整 | `recipeToAdjustmentValues` 直接复用模块级 `hsl` 对象，应用配方后修改状态会污染配方常量 | 逐通道深拷贝 HSL（`masterRecipes.ts`） | TC-ADJ-132 |
| F-08 | 调整 | 非法 `lensCorrectionMode`（如任意字符串）被原样透传 | 严格归一化为 `auto` 或 `manual`（`adjustments.ts`） | TC-ADJ-112 |

修复后全量回归 763/763 通过，未发现由修复引入的回归。

## 4. 代码与测试资产变更

### 4.1 生产代码

| 文件 | 变更性质 |
|---|---|
| `src/components/panel/right/PresetsPanel.tsx` | 修复文件夹同级拖拽重排 |
| `src/components/panel/right/AIPanel.tsx` | 修复 Esc 处理器注册 |
| `src/components/panel/right/MasksPanel.tsx` | 修复 Esc 处理器注册 |
| `src/components/panel/right/ExportPanel.tsx` | 修复 DPI 回填、估算依赖、图库浮层；补充类型与防御性返回 |
| `src/utils/masterRecipes.ts` | 修复 HSL 浅拷贝污染 |
| `src/utils/adjustments.ts` | 修复非法镜头模式透传 |
| `src/components/panel/right/ControlsPanel.tsx` | 类型化 setter/事件/选项，清理 10 个 `no-explicit-any`，无行为变更 |
| `src/store/useUIStore.ts` | 导出 `CollapsibleSectionsState` 类型供面板复用 |

### 4.2 测试与基础设施

| 文件/目录 | 说明 |
|---|---|
| `tests/frontend/*.test.ts(x)` | 新增 16 个模块测试文件；既有 12 个测试文件共同构成 28 个套件 |
| `tests/frontend/setup.ts` | 补齐 Tauri invoke/dialog/os/path/event/window/app、Clerk、toast、ResizeObserver 隔离；默认平台 linux；每个用例重置 Mock |
| `vitest.config.mts` | 将六模块及关联组件纳入覆盖率统计 |
| `tests/functional-test-cases-v1.6.26.csv` | 763 条逐条用例清单与执行状态 |
| `tests/functional-test-plan-v1.6.26.md` | 测试策略与 100% 追溯矩阵 |
| `tests/functional-test-report-v1.6.26.md` | 本报告 |

## 5. 质量门禁

| 检查项 | 结果 | 说明 |
|---|---|---|
| 全量自动化测试 | 通过 | 28 文件 / 763 用例 / 0 失败 / 0 跳过 |
| TypeScript | 通过 | `npx tsc --noEmit` 退出码 0 |
| 用例编号完整性 | 通过 | 763 唯一编号，各模块范围连续无缺口 |
| 测试稳定性 | 通过 | 预设面板拖拽用例曾受 AnimatePresence 退出动画影响，已加 `waitFor` 收敛并连续多次通过 |
| ESLint | 部分通过 | 全仓 1084 problems（1017 errors / 67 warnings），均为既有风格债务；本轮全仓 error 数未增加（1018 → 1017），`ControlsPanel` 清理 10 个 any；新增核心 UI 测试 0 error、12 个 i18next 字面量 warning |

新增测试中的 Mock 仍使用部分显式 `any`（如 Tauri 回调替身），属于测试代码类型债务，不影响运行结果，已列入后续优化项，本轮未做大规模测试类型重构。

## 6. 复现步骤

```bash
cd /data/anwuRAW
npm install
npx vitest run
npx tsc --noEmit
npx vitest run --coverage \
  --coverage.reporter=json-summary \
  --coverage.reporter=text
```

单独回归本轮缺陷：

```bash
npx vitest run \
  tests/frontend/presetsPanelUi.test.tsx \
  tests/frontend/aiPanel.test.tsx \
  tests/frontend/masksPanelUi.test.tsx \
  tests/frontend/exportPanelUi.test.tsx \
  tests/frontend/masterRecipes.test.ts \
  tests/frontend/adjustments.test.ts
```

## 7. 残余风险与不覆盖项

1. **Rust/Tauri 后端真实行为**：测试验证前端命令名、参数与返回处理契约，不启动真实 Rust 后端；RAW 解码、GPU 渲染、真实文件写入需后端集成或端到端测试补充。
2. **原生对话框与真实 Android 设备**：保存/打开对话框、系统返回键、触屏长按通过 Mock 与事件模拟验证；真机权限、SAF 路径与厂商差异仍需设备测试。
3. **像素级视觉回归**：曲线、波形、直方图、水印预览验证 DOM 属性、路径和参数，未做截图像素对比。
4. **极端防御分支**：`MasksPanel`、`useAiMasking`、`Curves` 等仍有异常清理分支未覆盖，但对应子功能主路径与关键错误路径均已覆盖。
5. **仓库既有 lint 债务**：全仓 1017 个 error 主要为历史 `no-explicit-any`，本轮避免扩大改动面，未做全仓类型重构。
6. **测试环境差异**：jsdom 对 PointerEvent、Canvas、布局尺寸的模拟有限，相关用例使用事件替身与固定尺寸；真实浏览器布局仍需 E2E 验证。
