# anwuRAW v1.6.26 六模块用户交互体验测试执行报告

| 项目 | 内容 |
|---|---|
| 被测版本 | Release v1.6.26（基线 commit `b5fd08e baseline v1.6.26`） |
| 仓库 | `https://github.com/Tri250/anwuRAW` |
| 测试范围 | 调整、裁剪与变换、蒙版、图像修复、预设、导出 |
| 执行日期 | 2026-10-25 |
| 测试框架 | Vitest 2.1 + jsdom + @testing-library/react + user-event |
| 全量结果 | **821 / 821 通过，0 失败**（29 个测试文件） |
| UX 交互结果 | **58 / 58 通过，0 失败** |
| 类型检查 | `npx tsc --noEmit` 零错误 |
| 追溯结论 | 56 个可交互子功能组、71/71 模块×交互维度单元覆盖；7 个纯数据层组 N/A |

## 1. 结果总览

| 指标 | 数值 |
|---|---:|
| 测试文件 | 29 |
| 全量用例 | 821 |
| 既有功能用例 | 763 |
| 本轮新增 UX 交互用例 | 58 |
| 失败 / 跳过 | 0 / 0 |
| 未处理异常 | 0 |
| 用例通过率 | 100% |

### 1.1 UX 用例分布

| 层级 | 编号段 | 数量 | 说明 |
|---|---|---:|---|
| 公共交互原语 | `TC-UX-COM-001..018` | 18 | 折叠、下拉、滑块、开关、分隔条 |
| 调整 | `TC-UX-ADJ-001..004` | 4 | 工具栏、分区折叠、眼睛按钮、Android |
| 裁剪与变换 | `TC-UX-CROP-001..007` | 7 | 预设、方向/几何磁贴、自动裁剪、拉直、两个模态 |
| 蒙版 | `TC-UX-MASK-001..006` | 6 | 创建入口、工具栏、容器展开、显隐/模式、设置折叠、下载播报 |
| 图像修复 | `TC-UX-AI-001..006` | 6 | 创建入口、重置、容器展开、显隐/模式、生成式折叠、忙碌/下载 |
| 预设 | `TC-UX-PRESET-001..008` | 8 | 应用、强度隔离、收藏、筛选、头部、空态禁用、文件夹、加载 |
| 导出 | `TC-UX-EXP-001..009` | 9 | 格式/色彩/位深、高级选项、估算状态、质量滑块、命名、终态、忙碌 |
| **合计** | | **58** | 逐条见 `tests/ux-interaction-test-cases-v1.6.26.csv` |

## 2. 自检与修复闭环

本轮按“发现即修复 + 回归用例”处理，共修复 10 类交互缺陷：

| # | 缺陷 | 影响 | 修复 | 回归用例 |
|---|---|---|---|---|
| 1 | 折叠分区标题仅响应鼠标 | 键盘用户无法折叠/展开调整、蒙版、AI 设置分区 | 标题行增加 `role="button"`、`tabIndex`、`aria-expanded`、`aria-label`，Enter/Space 切换，阻止眼睛按钮冒泡 | `TC-UX-COM-001..004`、`TC-UX-ADJ-001`、`TC-UX-MASK-005`、`TC-UX-AI-005` |
| 2 | 下拉无方向键导航、选择后焦点丢失 | 键盘无法高效选择格式/色彩/通道/LUT | ArrowUp/Down 开合与循环、Home/End、禁用项跳过、Enter 选择、Esc 关闭、焦点归还触发按钮、键入搜索 | `TC-UX-COM-005..011` |
| 3 | 滑块 range 无可访问名称，数值编辑仅鼠标，禁用仍可聚焦 | 读屏无法识别滑块，键盘无法精确输入 | range 与数值输入增加名称；数值显示改为可编辑按钮，Enter/Space 进入、Enter 提交、ArrowUp/Down 步进；禁用时原生 disabled 且数值不可聚焦 | `TC-UX-COM-012..016`、`TC-UX-EXP-005` |
| 4 | 裁剪预设与方向/几何磁贴为 `div`，无键盘语义 | 预设、旋转、翻转、变换、镜头入口不可键盘触发 | 改为原生 `button`/`motion.button`，`type="button"`、`aria-pressed`、可访问名称 | `TC-UX-CROP-001..002` |
| 5 | 裁剪面板图标按钮名称依赖 `data-tooltip` | 读屏只读出“按钮” | 重置、叠加、方向切换、拉直、AI 拉直、旋转/翻转/变换/镜头全部补充 `aria-label`，拉直补充 `aria-pressed` | `TC-UX-CROP-003..005` |
| 6 | 变换/镜头校正模态无对话框语义 | 读屏无法感知模态边界与名称 | 内层容器增加 `role="dialog"`、`aria-modal="true"`、`aria-label` | `TC-UX-CROP-006..007` |
| 7 | 导出选择态、状态反馈对辅助技术不可见 | 无法得知当前格式/色彩/位深、估算与导出终态 | 格式/色彩/位深增加 `aria-pressed`；高级选项 `aria-expanded`/`aria-controls`；底部估算 `role="status"`；主按钮 `aria-busy`；成功/失败/取消隐藏 live region；文件名模板补充名称 | `TC-UX-EXP-001..009` |
| 8 | 预设项仅鼠标应用，文件夹仅鼠标展开，加载无播报 | 键盘无法应用预设/展开文件夹，读屏无加载反馈 | 预设项 `role="button"`、`tabIndex`、`aria-pressed`、Enter/Space 应用且滑块按键不误触；文件夹展开器键盘可达、`aria-expanded`；加载态 `role="status"` | `TC-UX-PRESET-001..008` |
| 9 | 蒙版/图像修复创建磁贴、容器展开器、下载与生成状态语义缺失 | 键盘无法创建/折叠，读屏无进度 | 创建磁贴 `role="button"`、`tabIndex`、Enter/Space、生成中 `aria-disabled`；容器展开器 `aria-expanded`；下载 `role="status"`；生成按钮 `aria-busy`；加载指示器名称 | `TC-UX-MASK-001..006`、`TC-UX-AI-001..006` |
| 10 | jsdom 无 `PointerEvent`，framer-motion 键盘按压抛未捕获异常 | 键盘交互用例出现偶发未处理错误 | 在 `tests/frontend/setup.ts` 注入最小 `PointerEvent` polyfill（继承 `MouseEvent`，补齐 `pointerId`/`pointerType`） | 全量 821 条稳定通过 |

### 2.1 修复文件

- `src/components/ui/CollapsibleSection.tsx`
- `src/components/ui/Dropdown.tsx`
- `src/components/ui/Slider.tsx`
- `src/components/panel/right/ControlsPanel.tsx`
- `src/components/panel/right/CropPanel.tsx`
- `src/components/panel/right/MasksPanel.tsx`
- `src/components/panel/right/AIPanel.tsx`
- `src/components/panel/right/PresetsPanel.tsx`
- `src/components/panel/right/ExportPanel.tsx`
- `src/components/modals/TransformModal.tsx`
- `src/components/modals/LensCorrectionModal.tsx`
- `src/i18n/locales/{zh-CN,en,zh-TW}.json`（展开/折叠、分析中、下载等交互文案）
- `tests/frontend/setup.ts`（PointerEvent polyfill）
- 六个模块对应测试文件 + 新增 `tests/frontend/interactionPrimitives.test.tsx`

## 3. 100% 交互追溯结论

| 模块 | 可交互子功能组 | 适用维度 | 已覆盖 | 模块 UX 用例 | 结论 |
|---|---:|---:|---:|---:|---|
| 调整 | 16 | 12 | 12 | 4 | 100% |
| 裁剪与变换 | 6 | 12 | 12 | 7 | 100% |
| 蒙版 | 7 | 12 | 12 | 6 | 100% |
| 图像修复 | 7 | 12 | 12 | 6 | 100% |
| 预设 | 9 | 12 | 12 | 8 | 100% |
| 导出 | 11 | 11 | 11 | 9 | 100% |
| **合计** | **56** | **71** | **71** | **58** | **100%** |

说明：

1. “适用维度”指该模块确实存在的交互面；导出无拖拽编排，因此为 11/11。
2. 7 个纯数据层子功能组（调整数据层、大师配方数据层、裁剪几何纯函数、`createSubMask`、AI 蒙版 Hook、`usePresets`、导出设置 Hook）不产生用户交互，已由 763 条功能用例覆盖，不计入交互分母。
3. 公共原语 18 条为六个模块共享，不计入模块专属用例数，但作为所有滑块/下拉/折叠/开关的底层交互证据。

## 4. 覆盖率辅助数据

覆盖率仅作辅助指标，交互追溯以计划文档第 4 节为准。

| 模块 | 行覆盖 | 函数覆盖 | 分支覆盖 |
|---|---:|---:|---:|
| 调整 | 97.04% (4552/4691) | 88.55% (201/227) | 84.33% (764/906) |
| 裁剪与变换 | 97.42% (2230/2289) | 95.37% (103/108) | 79.97% (499/624) |
| 蒙版 | 89.64% (2666/2974) | 88.48% (146/165) | 82.57% (663/803) |
| 图像修复 | 96.17% (1935/2012) | 87.70% (107/122) | 86.45% (555/642) |
| 预设 | 94.43% (2185/2314) | 86.90% (73/84) | 89.29% (642/719) |
| 导出 | 99.55% (1326/1332) | 100.00% (39/39) | 92.77% (295/318) |
| **六模块合计** | **95.40% (14894/15612)** | **89.80% (669/745)** | **85.19% (3418/4012)** |

与上一轮功能测试相比，新增 UX 语义与状态分支使总行数增加 205 行；行覆盖仍保持 95% 以上，导出函数覆盖保持 100%。

## 5. 复现命令

```bash
cd /data/anwuRAW

# 1. 类型检查
npx tsc --noEmit

# 2. 全量测试
npx vitest run

# 3. 仅交互原语
npx vitest run tests/frontend/interactionPrimitives.test.tsx

# 4. 覆盖率
npx vitest run --coverage --coverage.reporter=json-summary --coverage.reporter=text
```

执行时间参考：全量 821 条约 37s；覆盖率运行约 48s（Cloud Sandbox，单线程 jsdom）。

## 6. 风险与不覆盖项

1. **Canvas 像素命中**：曲线控制点、画笔绘制、蒙版羽化、水印位置只验证参数、DOM 属性与事件路径，不做像素截图对比。
2. **真实触屏与原生手势**：jsdom 不能复现惯性滚动、系统长按菜单、SAF 权限与真机触感反馈。
3. **动画中间态**：framer-motion 动画只等待终值，不验证缓动曲线与帧率。
4. **Tauri/Rust 后端**：不启动真实 RAW 解码、GPU 渲染、文件写入与导出管线。
5. **ESLint 历史债务**：仓库仍有大量 `no-explicit-any`；本轮新增事件处理使用显式类型，未做全仓重构。
6. **读屏实测**：语义通过 DOM 断言验证，未在 NVDA/VoiceOver/TalkBack 真机走查。

## 7. 交付物

| 文件 | 说明 |
|---|---|
| `tests/ux-interaction-test-plan-v1.6.26.md` | 交互维度、56 个子功能组矩阵、71/71 单元追溯 |
| `tests/ux-interaction-test-cases-v1.6.26.csv` | 58 条 UX 用例逐条编号、分组、状态、耗时 |
| `tests/ux-interaction-test-report-v1.6.26.md` | 本报告：执行结果、10 类缺陷修复、覆盖率、风险 |
| `tests/functional-test-plan-v1.6.26.md` | 既有 763 条功能追溯矩阵 |
| `tests/functional-test-cases-v1.6.26.csv` | 既有功能用例清单 |
| `tests/functional-test-report-v1.6.26.md` | 既有功能测试报告 |
| `tests/anwuRAW-v1.6.26-tests-and-fixes.zip` | 全部测试、文档、覆盖率配置与修复源码打包 |
