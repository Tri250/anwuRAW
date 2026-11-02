# 透影 Crystal 移动端改善方案（基于 RapidRAW 仓库落地版）

> 依据：《透影Crystal-APP实现交付方案》 + 三张设计稿（主编辑界面 / 界面优化设计规范 / 水印导出页）
> 基线仓库：RapidRAW v2.1.2（Tauri 2 + React 19 + Rust/wgpu，Windows/macOS/Linux/Android，已完成 22 轮功能自检）
> 本文档性质：对原交付方案的**修订与落地**——解决交付方案与仓库现状的根本性错位，给出可直接开工的完整改善方案。

---

## 0. 执行摘要（三个核心裁决）

| # | 裁决 | 理由 |
| --- | --- | --- |
| D1 | **放弃"Kotlin 2.0 + Jetpack Compose 全新 App"路线，改走 Tauri Android 壳 + 新建 Crystal 移动 UX 层 + 复用 Rust 图像管线** | 仓库已有完整且经 22 轮审计验证的能力：124 参数 GPU 管线（wgpu/WGSL）、50 步撤销栈（与原方案规格完全一致）、AI 全家桶（SAM 蒙版/LaMa 修复/AI 降噪/一键增强/超分）、水印导出（图片+文字水印、GPS 剥离、ICC）、完整 Android Gradle 工程与签名 APK。用 Kotlin 重写等于丢弃 100% 现有资产，重写 RAW 解码、GPU shader、AI 推理三条最难的链路 |
| D2 | **原方案中的 Design Tokens、信息架构、交互规格、验收标准全部保留；技术实现章节（4.x）整体作废重写** | 原方案的暗夜黑金视觉体系、三分区布局、七大分类矩阵、双强调色策略、水印导出页规格与三张设计稿一致，直接转译为 CSS 变量 + React 组件；Compose 代码骨架仅作语义参考 |
| D3 | **移动端不做桌面 UI 的缩放适配，而是新建独立的 Crystal 移动视图层**（复用 store/hooks/管线，UI 组件全新） | 现有 Android 端是桌面三栏布局的 compact 降级（底部面板呈现），与设计稿"照片预览更大 · 功能分区清晰 · 操作更高效"的三分区范式完全不同；两套 UI 共享同一数据层互不干扰 |

**工作流划分**：W1 移动壳与主题 → W2 编辑核心 → W3 AI 场景推荐 → W4 水印导出域 → W5 Android 性能与兼容 → W6 质量保障与交付。其中 W5 的「Android GPU 预览接通」是全局最高优先技术前置项（当前 Android 预览走 CPU 兜底，无法满足 60fps 实时预览要求）。

---

## 1. 交付方案与仓库现状的根本错位

### 1.1 三重错位

| 维度 | 交付方案假设 | 仓库现实（已取证） |
| --- | --- | --- |
| 技术栈 | Kotlin 2.0.21 + Jetpack Compose + Ktor 3.4.0 + NCNN/ONNX Runtime Mobile | Tauri 2 + React 19 + TypeScript + Tailwind 4 + Zustand（前端）；Rust + wgpu/WGSL + rawler + ort(ONNX) + mozjpeg + kamadak-exif（后端）。**ort 依赖已在**（Cargo.toml L21-45），AI 推理无需引入新栈 |
| 产品形态 | 移动端一键修图 APP（三分区、单图流、3 步成片） | 桌面专业 RAW 编辑器（图库-编辑器双视图、三栏布局、Right Panel 范式），Android 是 compact 降级适配（App.tsx compact/wide/full 三档，元数据/调整/蒙版在 compact 下以底部面板呈现） |
| 完成度 | 从零新建（M1-M5 六周计划） | v2.0.1 全清单 44 项闭环审计通过（2026-11-01），v2.1.2 已发布；Android 签名 APK、edge-to-edge、返回键闭环、触屏滑块/曲线/蒙版均已落地（README L174-180、审计 §15） |

### 1.2 路线裁决依据（证据链）

1. **撤销重做规格直接命中**：原方案要求"EditHistory 命令栈上限 50 步"——[useEditorStore.ts](file:///workspace/src/store/useEditorStore.ts#L199-L225) 的 `pushHistory` 已实现恰好 50 步上限的撤销/重做栈，含 AI patch 同步标记。
2. **参数体系超集覆盖**：原方案的调色参数（曝光/对比度/高光/阴影/色温/饱和度/色调）只是 [adjustments.ts](file:///workspace/src/utils/adjustments.ts#L46-L66) 中 124 参数 schema 的子集；特效（暗角/颗粒/光晕/荧光）对应 Effects 分区（含 bloom 5 级 mip 金字塔 + flare 质心驱动，[shader.wgsl](file:///workspace/src-tauri/src/shaders/shader.wgsl#L1744)）。
3. **AI 能力已有半壁江山**：一键增强（三档 subtle/standard/strong，[platform_features.rs](file:///workspace/src-tauri/src/platform_features.rs#L663)）、AI 降噪（NIND）、去雾、主体/天空/深度蒙版（SAM/EfficientSAM3/Depth Anything v2）、LaMa 修复、2×/4× 超分导出——原方案 M3 的"AI 工具"二级面板 8 项中 6 项已有真实实现。
4. **水印导出已有底座**：[export_processing.rs](file:///workspace/src-tauri/src/export_processing.rs#L147-L148) 已有 `watermark`（图片）+ `text_watermark`（文字，DejaVu Sans Bold 内嵌跨平台一致含 Android），EXIF 读取/保留/GPS 剥离完整；缺的是"EXIF 信息栏相框 + 6 款模板 + 独立导出域 UI"这一**产品化封装**。
5. **Android 工程成熟**：[src-tauri/gen/android](file:///workspace/src-tauri/gen/android) 完整 Gradle 工程 + release keystore；MainActivity.kt 已 `enableEdgeToEdge()` + insets 动态 padding（审计 §15.2）；返回键逐层闭环已验证。
6. **反证（Kotlin 路线成本）**：RAW 解码（rawler 对 800+ 机型）、WGSL 18+ kernel 管线、场景推荐所需的 ONNX 推理、ICC 色彩管理、EXIF 写回——每一项在 Kotlin 侧都需要 6 人周级重建，且无法继承已通过审计的正确性结论（如曲线 16 点 GPU 越界防护、uniform 45264 字节布局静态断言）。

### 1.3 原方案保留 / 作废清单

| 原方案章节 | 处置 |
| --- | --- |
| 一、产品定位与目标 | ✅ 保留（与 RapidRAW Android 端定位兼容） |
| 二、Design Tokens（2.1/2.2/2.3） | ✅ 保留，按 §4.3 转译为 CSS 变量 |
| 三、信息架构与交互规格 | ✅ 保留，作为移动视图层 UI 验收基线 |
| 4.1 技术选型（Kotlin/Compose/Ktor） | ❌ 作废，按 §4.1 替换 |
| 4.2 主题组件（Compose 代码骨架） | ⚠️ 语义保留，实现转译为 React/Tailwind（§4.4） |
| 4.3 功能实现要点 | ⚠️ 逐条重新映射（§2.1 矩阵） |
| 五、质量保障 | ✅ 保留指标，补充仓库既有门禁体系（§5/W6） |
| 六、里程碑 | ⚠️ 阶段重排为 W1-W6（§6），不再按周排期 |
| 七、风险与边界（Non-goals） | ✅ 保留，追加移动端特有边界 |

---

## 2. 仓库现状能力盘点（对照 Crystal 需求）

### 2.1 能力矩阵

| Crystal 需求域 | 仓库现状 | 关键文件锚点 | 缺口评级 |
| --- | --- | --- | --- |
| GPU 实时预览 | wgpu/WGSL 统一管线；f16 显示链；自适应交互画质 0.3-0.5 档；ROI 局部渲染 | [gpu_processing.rs](file:///workspace/src-tauri/src/gpu_processing.rs#L35-L41)、[useImageProcessing.ts](file:///workspace/src/hooks/useImageProcessing.ts#L62-L64) | 🟡 **Android 默认 `use_wgpu_renderer=false` 走 CPU 兜底**（[app_settings.rs](file:///workspace/src-tauri/src/app_settings.rs#L766-L784)）→ W5 |
| 调整参数（调色/滤镜/特效） | 124 参数 schema：Basic 8 字段、HSL 8 通道、3-way 色轮、参数化+点曲线、去雾、锐化、降噪（ISO 联动）、暗角/颗粒/bloom/flare/LUT/镜头模糊 | [adjustments.ts](file:///workspace/src/utils/adjustments.ts#L46-L115) | 🟢 数据层完备，缺移动 UI |
| 撤销/重做（50 步） | 已实现，含 AI patch 标记 | [useEditorStore.ts](file:///workspace/src/store/useEditorStore.ts#L199-L225) | 🟢 直接复用 |
| 构图（裁剪/旋转/透视/镜像/水平校正/比例） | CropPanel 全功能，含比例预设 | [CropPanel.tsx](file:///workspace/src/components/panel/right/CropPanel.tsx) | 🟡 需移动全屏沉浸容器 |
| 预设/LUT（滤镜缩略图条） | 预设体系含蒙版+裁剪；大师配方/胶片配方（RawLab 移植）；LUT f32 tetrahedral；Android LUT 资产物化已解决 | [lut_processing.rs](file:///workspace/src-tauri/src/lut_processing.rs#L96-L137)、[PresetsPanel.tsx](file:///workspace/src/components/panel/right/PresetsPanel.tsx) | 🟡 缺横滑缩略图条 UI（缩略图生成管线已有） |
| AI 一键推荐 | `ai_auto_enhance` 三档（直方图驱动）+ 超分 | [platform_features.rs](file:///workspace/src-tauri/src/platform_features.rs#L663) | 🔴 **无场景语义识别**（风景/人像/夜/美食分类 + 置信度）→ W3 |
| AI 工具网格（8 项） | 6/8 已有真实实现（AI增强/去雾/降噪/画面增强≈structure/主体识别/超分）；天空识别可用蒙版模型覆盖 | 审计 §22.1⑤ | 🟢 后端就绪，缺网格入口 UI |
| 人像分区（肤色/磨皮/轮廓/眼部/背景虚化） | 人脸分区精修（F-04）、人脸液化（F-05）、肤质、镜头模糊+主体蒙版=背景虚化 | 审计 §19 | 🟡 后端就绪，需按"人像分类"重组入口 |
| 水印 | 图片水印 + 文字水印（锚点/字号/透明度/颜色，内嵌字体） | [export_processing.rs](file:///workspace/src-tauri/src/export_processing.rs#L189-L219) | 🟡 缺 EXIF 信息栏相框、6 款模板、模板管理（收藏/默认） |
| EXIF（相机型号/焦距/光圈/快门/ISO） | kamadak-exif 完整读取；`exifNoiseIsoFrom` EXIF 自动联动刚落地；元数据面板 GPS/IPTC | [image_processing.rs](file:///workspace/src-tauri/src/image_processing.rs#L3034-L3038) | 🟢 读取就绪，缺信息栏渲染器 |
| 导出格式 | JPEG(mozjpeg)/PNG/TIFF/AVIF/JXL/WebP + ICC 宽色域 + 8-bit 抖动 | [export_processing.rs](file:///workspace/src-tauri/src/export_processing.rs#L131-L149) | 🟢 底层超集；移动 UI 仅暴露 JPEG/PNG |
| 对比（按住看原图） | CompareView 四模式 + 原图渲染路径（`useImageProcessing.ts` 原图态） | 审计 §22.2 | 🟡 需新增 press-and-hold 手势 |
| 重置（二次确认） | `INITIAL_ADJUSTMENTS` 重置逻辑 + ConfirmModal | [ControlsPanel.tsx](file:///workspace/src/components/panel/ControlsPanel.tsx#L132-L143) | 🟢 复用 |
| 相机型号副标题 | `load_metadata` 返回 ImageMetadata，exifByPath 缓存 | 审计 §20 | 🟢 复用 |
| 双强调色主题 | 3 主题（dark/light/grey）CSS 变量，单一 `--app-accent`（dark 下为白色） | [themes.ts](file:///workspace/src/utils/themes.ts#L10-L64) | 🔴 无 FlowAccent 双强调色机制 → W1 |
| 七大分类导航 | AdjustmentSection 折叠面板 + PanelSwitcher（桌面范式） | [PanelSwitcher.tsx](file:///workspace/src/components/panel/PanelSwitcher.tsx) | 🔴 移动范式需新建（§4.4） |
| 触屏/移动适配 | 触屏滑块/曲线/蒙版、html.android 类强显 hover 按钮、viewport 锁定、15 语言 | 审计 §15 | 🟢 基础就绪，新组件沿用规范 |
| 内存/大图防护 | memory_budget（超分已用）、ROI 渲染、缩略图 worker、LRU 缓存 | [platform_features.rs](file:///workspace/src-tauri/src/platform_features.rs#L811-L815) | 🟢 复用；移动端需下调预算档 |

### 2.2 与既有三份规划文档的协调（不重复施工声明）

| 既有文档 | 与本方案的关系 |
| --- | --- |
| [image-pipeline-improvement-plan.md](file:///workspace/image-pipeline-improvement-plan.md)（评审稿 v2） | **继续独立推进，本方案不重复**。其中 P0-3（ISO 噪声模型）已随 §22 落地。本方案 W4 给导出管线新增 EXIF 信息栏合成时，须遵守其 M0 golden harness 前置要求（水印合成纳入 golden 资产）。shader 主处理顺序不变（其 §9 附录） |
| [alcedo-integration-plan.md](file:///workspace/alcedo-integration-plan.md) | **W5 直接引用其结论**：R1-3/R1-4（Android wgpu 预览接通）是本方案最高优先前置；A1（SAM 多轮点选+负点）支撑移动端蒙版体验；A2（UltraHDR）可作为导出域 P1 增强；A3（模型分发 model_set 体系）被 W3 场景识别模型复用。P2-C1 DAG 依赖 GPU 直通，继续挂起 |
| [functional-modules-audit.md](file:///workspace/functional-modules-audit.md)（22 轮） | 遗留事项纳入 W6：① JS 主包 4.8MB 需分包（移动 WebView 加载敏感，**升级为 W1 任务**：Crystal 移动视图与桌面视图代码分割）；② `hdr-error/focus-stack-error` 事件统一、`focus-stack-report` 消费者、~300 处存量 any——不阻塞移动端，按原节奏 |

### 2.3 必须继承的工程红线（来自审计结论）

- 前端六门禁：`tsc --noEmit` / `eslint` / `prettier` / `i18n:check`（15 语言 0 空键）/ `lint:e9` / `vite build` —— 新增组件全部过门禁。
- 后端：`cargo check --all-targets` + `consistency_determinism` + `wgsl_validation`（124 参数 schema 一致性）。
- 新增 adjustments 键必须五层同步：adjustments.ts → 面板控件 → schema 再生成 → EXIF/持久化往返 → 15 语言 i18n（§22.1① 的 noiseIso 是标准样板）。
- 未知枚举 serde 回退默认（sidecar/预设兼容红线）。
- WYSIWYG：预览与导出必须同源（移动端水印/信息栏预览用 CSS 近似时，导出以 Rust 合成为准，需列 WYSIWYG 风险清单并做像素比对）。

---

## 3. 差距分析（逐设计稿逐项）

> 编号规则：G-x（Gap）。「改造点」均给出新建/复用路径。UI 现状锚点：[Editor.tsx](file:///workspace/src/components/panel/Editor.tsx#L158-L206)、[BottomBar.tsx](file:///workspace/src/components/panel/BottomBar.tsx)、[ImageCanvas.tsx](file:///workspace/src/components/panel/editor/ImageCanvas.tsx)。

### 3.1 图3 + 图2：主编辑界面

| # | 设计稿要求 | 现状 | 改造点 | 级别 |
| --- | --- | --- | --- | --- |
| G1 | 三分区布局：预览区 ~62% 屏高 + 七分类导航 + 196pt 定高二级面板 + 底部 6 键操作区 | 桌面三栏；Android compact 底部抽屉面板 | 新建 `CrystalMobileLayout`（W1）：预览区弹性占位，二级面板定高滚动，底栏 48-56pt | P0 |
| G2 | 顶栏：返回/撤销/重做 + 「专业修图」标题 + 相机型号副标题（OLYMPUS…）+ ⋯ + 金色保存胶囊 | EditorToolbar 桌面形态；EXIF 数据已有 | 移动顶栏组件读 exifByPath 渲染副标题；保存=跳转水印导出域 | P0 |
| G3 | 七大分类导航：预设(金)/人像(紫)/滤镜(金)/调色(蓝)/构图(绿)/AI工具(青)/特效(红)，各分类专属色 + 选中底条指示器 | PanelSwitcher 桌面图标切换 | 新建 `CatNavBar`：7 分类 × 专属 token 色（§4.3 cat/*），图标用 lucide-react（仓库已有） | P0 |
| G4 | 二级面板矩阵（7 分类 × 子标签/缩略图/工具格/滑杆） | AdjustmentSection/SubSection 折叠面板（内容可复用） | 新建 `CategoryPanel` 容器：按分类路由到 7 种面板形态，内部最大化复用现有调整控件（Slider/Switch/ColorWheel 均已触屏适配） | P0 |
| G5 | 预设分类：子标签（推荐/自然/胶片/电影/人像/夜景/航拍）+ AI 推荐卡 + 滤镜缩略图横滑（选中金描边）+ 强度滑杆 | 预设体系 + LUT + 缩略图 worker 已有 | 新建 `FilterThumbStrip`（LazyRow + LUT/预设实时缩略图）+ 强度滑杆映射 LUT 强度/预设混合度 | P0 |
| G6 | AI 智能推荐卡：场景标签（"风光摄影 · Sky · Outdoor · Land"）+ 应用按钮一键写入历史 | 仅 ai_auto_enhance（直方图，无场景语义） | 新建场景识别命令 + `AiRecommendCard`（W3 详述）；"应用"走 pushHistory → adjustments 合并（与 ai_auto_enhance 同路径） | P1 |
| G7 | 调色分类：参数滑杆 + 数值双标记（30–50 双端约束） | Slider 单值触屏版已有 | `ParamSlider`（金色皮肤 + 当前值/默认值双标记；双端 thumb 可选实现） | P1 |
| G8 | 构图：进入全屏沉浸态 | CropPanel 全功能但嵌在桌面面板 | 移动端全屏裁剪容器（复用 CropPanel 逻辑 + 全屏 overlay，退出走 Escape 链） | P1 |
| G9 | AI 工具分类：识别过程进度蒙层，失败不阻塞编辑 | AI 任务 TaskCapsule + 排队/错误反馈已有 | 移动端蒙层复用 TaskCapsule 状态；失败 toast 已有规范（§15 修复 54） | P2 |
| G10 | 底部 6 键：原图(长按)/撤销/重做(置灰#6F6F64)/对比(按住)/重置(二次确认)/保存(金) | BottomBar 桌面形态；历史状态在 store | 新建 `BottomActionBar`：长按/按住手势绑定现有原图渲染路径；重做置灰读 historyIndex；重置挂 ConfirmModal | P0 |
| G11 | 预览区左下「原图｜对比」浮层 | CompareView 逻辑已有 | 浮层组件绑定同一渲染切换 | P2 |

### 3.2 图1：水印与导出域

| # | 设计稿要求 | 现状 | 改造点 | 级别 |
| --- | --- | --- | --- | --- |
| G12 | 独立「水印/导出域」路由 + 双返回胶囊 + 相册换图入口 | 无此域；导出是右侧 ExportPanel | 新建导出域路由（移动端）；相册入口复用 ImagePicker | P0 |
| G13 | 实时预览徽章（青绿圆点 ●）+ 水印/信息栏实时叠加预览 | 水印仅导出时应用（WATERMARK_CACHE 导出路径） | 前端 CSS 叠加层（信息栏/相框/文字水印 DOM 渲染）+ 导出 Rust 合成；WYSIWYG 比对纳入验收 | P0 |
| G14 | EXIF 白色信息栏：`E-M10MarkIV │ CRYSTAL(红) │ 38mm f/5.6 1/200s ISO 200` | EXIF 读取完整；无此渲染 | 新建前端 `ExifInfoBar` + 后端 `exif_frame` 合成模块（基于现有 DejaVu 文字水印渲染器扩展：白底条 + 品牌红字 + 相框白边） | P0 |
| G15 | 「在成片中显示信息栏与相框」总开关（青绿 Switch） | Switch 组件已有 | 开关状态进 ExportSettings 扩展字段 `exifFrame: {enabled, style}` | P0 |
| G16 | 水印模板 6 款横滑卡（专业摄影/极简高级/电影胶片/风光大片/街拍随行/黑白经典），选中青绿 2px 描边 + mini 预览 | 水印参数可配置但无模板概念 | 模板 = WatermarkSettings/TextWatermarkSettings/ExifFrame 参数包（内置 6 组 JSON）；卡片 mini 预览用 CSS 渲染 | P0 |
| G17 | 收藏（星）/ 设为默认（青绿实心）/ 保存模板 三操作 | useExportSettings 已支持导出预设保存/应用 | 「设为默认」写 app_settings（已有水印默认值字段 L288-293）；收藏/自定义模板持久化复用导出预设存储结构 | P1 |
| G18 | 导出格式 JPEG｜PNG 分段控件（选中亮块 #3A3A34） | 导出格式超集已有 | `SegToggle` 移动组件仅暴露 JPEG/PNG，底层不变 | P0 |
| G19 | 字体（系统 ⇕ 可展开）+ 画质（高质量 100%） | 文字水印字体固定内嵌 DejaVu；画质=JPEG quality | 字体选择先暴露 系统/内置字体 两组（Rust 侧系统字体枚举为 P2）；画质档位映射 quality 60/80/100 | P1 |
| G20 | 编辑完成 → 保存 → 进入导出域 的流程闭环（双强调色切换点） | 无 | 路由切换时 FlowAccent 金→青（§4.2） | P0 |

### 3.3 主题系统

| # | 差距 | 改造点 |
| --- | --- | --- |
| G21 | 无暗夜黑金 token 体系（dark 主题是中性灰 + 白 accent） | 新增 Crystal 主题变量组 `--cx-*`（§4.3），仅移动视图消费；桌面三主题零改动 |
| G22 | 无 FlowAccent 流程级双强调色机制 | `data-flow="edit|export"` 属性驱动 `--cx-accent` 切换，移动视图组件统一消费 `var(--cx-accent)`，进导出域自动金→青，组件层零改动（原方案 2.3 的设计决策完整保留） |
| G23 | 无分类专属色 | cat/ren、cat/tone、cat/comp、cat/ai、cat/fx 五个 token 直接落 CSS 变量 |

---

## 4. 目标架构

### 4.1 分层架构

```
┌────────────────────────────────────────────────────────────┐
│  L4  Crystal 移动视图层（全部新建 src/components/mobile/）      │
│      CrystalMobileLayout / CatNavBar / CategoryPanel ×7      │
│      FilterThumbStrip / AiRecommendCard / ParamSlider        │
│      BottomActionBar / WatermarkExportPage / ExifInfoBar     │
│      WatermarkTemplateCard / SegToggle / PressAndHold        │
├────────────────────────────────────────────────────────────┤
│  L3  主题与路由（小改）                                        │
│      themes.ts 新增 --cx-* token 组 · data-flow FlowAccent    │
│      App.tsx 移动路由域（编辑域/导出域）+ Escape 链挂节点        │
├────────────────────────────────────────────────────────────┤
│  L2  状态与 hooks（零改动或微改，直接复用）                      │
│      useEditorStore(历史50步) · useImageProcessing(三渲染路径) │
│      useExportSettings(水印状态) · exifByPath 缓存             │
├────────────────────────────────────────────────────────────┤
│  L1  Rust 引擎（复用 + 2 个新增模块 + 1 个接通项）               │
│      复用：gpu_processing / shader.wgsl / lut_processing      │
│           export_processing / image_processing / platform    │
│      新增：scene_classify（ort 场景分类）                      │
│           exif_frame（EXIF 信息栏+相框合成，导出管线末段）       │
│      接通：Android use_wgpu_renderer=true（R1-3/R1-4）        │
└────────────────────────────────────────────────────────────┘
```

原则：**L2/L1 尽量零改动**（它们承载 22 轮审计的正确性结论）；所有产品差异集中在 L4 表达。

### 4.2 移动路由与 FlowAccent

```
App.tsx (isAndroid 且启用 crystal 壳)
 ├─ 编辑域 data-flow="edit"   → CrystalMobileLayout（G1-G11）
 │    └─ 顶栏保存/底栏保存 ──→ 导航至导出域
 └─ 导出域 data-flow="export" → WatermarkExportPage（G12-G20）
      ├─ 返回胶囊×2 → 编辑域 / 相册换图
      └─ 导出完成 → toast（复用 §15 修复 54 的反馈规范）+ 回编辑域
```

- FlowAccent 实现：根容器 `data-flow` 属性 + 两条 CSS 规则切换 `--cx-accent`；不需要 JS 状态广播。
- 新路由节点必须挂入现有 Escape/返回键逐层关闭链（审计 §15.2 闭环规范）：导出域 → 编辑域 → 图库。

### 4.3 Design Tokens 转译表（原方案 Compose → 本仓库 CSS）

落点：[themes.ts](file:///workspace/src/utils/themes.ts) 新增独立变量组（不污染桌面三主题），移动根容器挂 `crystal` 类启用。

| 原方案 Token | 色值 | CSS 变量 |
| --- | --- | --- |
| bg/page | #0B0B09 | `--cx-page` |
| bg/screen | #0E0E0C | `--cx-screen` |
| bg/card | #1B1B17 | `--cx-card` |
| bg/card-2 | #232320 | `--cx-card-active` |
| line/divider | #2E2E28 | `--cx-border` |
| accent/gold | #F5C842 | `--cx-accent-edit` |
| accent/gold-soft | rgba(245,200,66,.14) | `--cx-accent-edit-soft` |
| accent/teal | #2FD6BF | `--cx-accent-export` |
| txt/primary | #F2F2EC | `--cx-text-primary` |
| txt/secondary | #A6A698 | `--cx-text-secondary` |
| txt/tertiary | #6F6F64 | `--cx-text-tertiary` |
| cat/ren | #B39DFF | `--cx-cat-ren` |
| cat/tone | #6EC1FF | `--cx-cat-tone` |
| cat/comp | #7ED97E | `--cx-cat-comp` |
| cat/ai | #5FD4E8 | `--cx-cat-ai` |
| cat/fx | #FF6B5E | `--cx-cat-fx` |
| exif/bar | #F4F4F0（字 #1C1C18） | `--cx-exif-bar` / `--cx-exif-text` |
| exif/brand | #B4443C | `--cx-exif-brand` |

派生规则：`--cx-accent: var(--cx-accent-edit)`（默认），`[data-flow="export"] & → var(--cx-accent-export)`。

字体/字号/圆角/间距按原方案 2.2 执行（16/14/13/12/10.5 阶梯；大卡 18px / 中卡 14px / 缩略图 12px / 胶囊 999px；屏边距 14px）。中文字体栈：PingFang SC / HarmonyOS Sans SC / MiSans 兜底——Android WebView 走系统字体自动命中。

### 4.4 原方案组件清单 → React 落地映射

| 原方案组件 | 新建文件（src/components/mobile/） | 复用的现有资产 |
| --- | --- | --- |
| CatNavBar | CatNavBar.tsx | lucide-react 图标、分类 token 色 |
| FilterThumbStrip | FilterThumbStrip.tsx | 预设/LUT 缩略图 worker 管线、LazyRow 用 react-window 或 CSS scroll-snap |
| AiRecommendCard | AiRecommendCard.tsx | pushHistory + adjustments 合并路径（同 ai_auto_enhance 前端消费方式） |
| ParamSlider | ParamSlider.tsx | [ui/Slider.tsx](file:///workspace/src/components/ui/Slider.tsx)（触屏已适配）加金色轨道渐变皮肤 |
| ExifInfoBar | ExifInfoBar.tsx（预览）+ 后端 exif_frame.rs（导出） | kamadak-exif 数据、DejaVu 文字渲染器（export_processing.rs L429） |
| WatermarkTemplateCard | WatermarkTemplateCard.tsx | useExportSettings 预设应用 |
| SegToggle / TealSwitch | SegToggle.tsx / 复用 ui/Switch.tsx 换色 | Switch.tsx |
| BottomActionBar | BottomActionBar.tsx | historyIndex 状态、ConfirmModal、原图渲染路径、CompareView |
| —（新增） | PressAndHold.ts | 通用长按/按住手势 hook（原图长按、对比按住共用） |

新增 Rust 命令（lib.rs 注册，遵循现有命令模块模式）：

```
scene_classify(path) -> { scene, confidence, tags[] }     // W3
render_exif_frame(...)                                     // W4，或并入 export_images 参数
```

---

## 5. 工作流分解（W1-W6）

> 每项含目标/任务/验收。优先级：P0 > P1 > P2；P0 内部按 W 序号串行依赖，W3 可与 W2 并行。

### W1 移动壳与主题系统（对应原 M1）

**目标**：Crystal 三分区骨架 + 黑金主题 + FlowAccent 上线，桌面端零回归。

任务：
1. themes.ts 新增 `--cx-*` token 组（§4.3 全表），移动根容器 `crystal` 类启用。
2. `data-flow` FlowAccent 机制（CSS 属性选择器，零 JS）。
3. `CrystalMobileLayout`：预览区（复用 ImageCanvas 渲染路径）/ 七分类导航 / 196pt 定高二级面板 / 底部操作区；遵守 insets（MainActivity 已做 edge-to-edge，布局用 env(safe-area-inset-*)）。
4. `CatNavBar`（G3）+ 空态 `CategoryPanel` 容器（G4 骨架）。
5. `BottomActionBar`（G10）：撤销/重做接 historyIndex，重置挂 ConfirmModal，保存导航至导出域占位页。
6. 移动顶栏（G2）：相机型号副标题读 exifByPath。
7. **代码分割**：移动壳路由下动态 import 桌面组件（消化审计遗留「主 JS 包 4.8MB」）。
8. App.tsx 增加 Crystal 壳开关（设置项，默认 Android 开启），保证桌面/旧 Android UI 可回退。

验收：
- 三分区在 6.1"-7" 竖屏符合设计稿比例（预览区 ~62%）；横屏降级为左右分区。
- FlowAccent 金↔青切换无 JS 重渲（DevTools 验证仅 CSS 变量变化）。
- 桌面 `npm run build` + 六门禁全绿；桌面 UI 截图 diff 无变化。
- 返回键：导出域 → 编辑域 → 图库逐层返回成立。

### W2 编辑核心（对应原 M2）

**目标**：七大分类二级面板全可用，滑杆/缩略图/裁剪达到设计稿交互。

任务：
1. `FilterThumbStrip`（G5）：预设+LUT 缩略图横滑、选中 2px 金描边+标签变金、强度滑杆；子标签（推荐/自然/胶片/电影/人像/夜景/航拍）映射预设分组（master-recipes 数据已有分类）。
2. 调色面板（G7）：`ParamSlider` 双标记皮肤，曝光/对比度/高光/阴影/色温/饱和度/色调 七滑杆接现有 adjustments 键。
3. 构图全屏沉浸（G8）：全屏 overlay 复用 CropPanel（自由/旋转/透视/镜像/翻转/水平校正/比例/重置）。
4. 人像分类面板：肤色（HSL 橙红通道预设组合）/磨皮（降噪+structure 组合）/面部轮廓与眼部（F-04 人脸分区）/背景虚化（主体蒙版+镜头模糊）——均以「参数包 + 蒙版」形式封装为一键工具格，不新增 shader。
5. 特效面板（G9 上游）：光晕（bloom）/暗角/颗粒/荧光（LUT）/色彩氛围（色彩分级）工具格直连现有 Effects 键。
6. 对比与原图（G10/G11）：PressAndHold 手势绑定原图渲染路径与 CompareView。
7. 长按原图、重做置灰、重置二次确认全链路与桌面行为一致。

验收：
- 七分类 × 二级面板内容与设计稿矩阵（原方案 3.2 表）逐格核对通过。
- 滑杆拖动走自适应交互画质（0.3-0.5 档），松手精渲——与桌面手感一致。
- 所有调整进 50 步历史栈；撤销/重做/重置与设计稿状态规则一致。
- 滤镜缩略图点击 → 预览实时变化（LUT/预设应用 <100ms 交互档）。

### W3 AI 场景识别与智能推荐（对应原 M3，可与 W2 并行）

**目标**：端侧场景分类 + 推荐卡，置信度门槛遵守原方案边界（≥0.75 才展示）。

任务：
1. 场景分类模型：MobileNetV3-Small / EfficientNet-Lite0 量化 INT8（<10MB，符合原方案 30MB 模型包预算），走 **ort（仓库已有 ONNX runtime 依赖）**；模型分发复用 alcedo 方案 A3 的 model_set 体系（下载 + 校验 + Android assets 物化，模式同 [lut_processing.rs](file:///workspace/src-tauri/src/lut_processing.rs#L96-L137)）。
2. Rust 命令 `scene_classify`：输入缩略图（缩略图 worker 产物，避免全图解码），输出 `{scene: 风景|人像|夜景|美食|街拍|微距, confidence, tags[]}`；分类失败/模型缺失时静默降级（推荐卡不展示，不阻塞编辑——原方案"AI 失败不阻塞"边界）。
3. 推荐映射规则库：scene → 推荐预设/LUT + 参数包（如 风景→去雾+饱和+日落金 LUT；夜景→降噪+ISO 联动+曝光）；**推荐理由标签必须来自真实识别结果**（原方案红线："假 AI"禁令）。
4. `AiRecommendCard`（G6）：标签化理由 + 应用按钮；应用 = pushHistory + adjustments 合并（与 ai_auto_enhance 同一前端消费路径）。
5. AI 工具网格（8 格）接入现有后端：AI增强（ai_auto_enhance 三档）/去雾/降噪/画面增强/天空识别（蒙版模型）/主体识别（SAM）/超分（导出域）/更多。
6. 识别进度蒙层（G9）：复用 TaskCapsule 状态机。

验收：
- 风光/人像/夜景/美食各 50 张真实照片数据集：Top-1 准确率 ≥85%，推荐卡仅在 confidence ≥0.75 时出现。
- 模型缺失/推理失败：编辑流程零阻塞，无 crash。
- 模型包增量 ≤10MB。

### W4 水印导出域（对应原 M4）

**目标**：图1 逐项还原；导出域与编辑域双强调色闭环。

任务：
1. `WatermarkExportPage`（G12）：双返回胶囊 + 相册换图（ImagePicker）+ 预览区（含 ● 实时预览徽章 / 专业摄影徽章）。
2. `ExifInfoBar` 预览（G14/G13）：CSS 渲染白底信息栏（机型 | CRYSTAL 红字 | 焦距 光圈 快门 ISO）+ 相框；数据源 exifByPath；无 EXIF 时按原方案兜底显示拍摄时间。
3. 后端 `exif_frame` 合成模块（G14）：在 export_processing 管线末段（dither/clamp 之后、编码之前）合成信息栏与相框；字体渲染复用 DejaVu 基础设施；**纳入管线方案 M0 golden 资产**（不同 EXIF 内容 × 3 相框样式 × 2 长宽比 golden 用例）。
4. 总开关（G15）：`exifFrame.enabled` 进 ExportSettings（serde 未知值回退兼容）。
5. 水印模板体系（G16/G17）：6 款内置模板 JSON（专业摄影/极简高级/电影胶片/风光大片/街拍随行/黑白经典）= 水印参数包 + 信息栏样式；`WatermarkTemplateCard` 横滑 + 青绿描边 + mini 预览；收藏/设为默认/保存模板（设为默认写 app_settings 已有水印字段）。
6. `SegToggle`（G18）JPEG｜PNG + 画质三档（G19）+ 字体选择（系统/内置）。
7. 导出动作接 `export_images`（质量/元数据/GPS 剥离默认开——隐私合规沿用现有开关）；成功/失败 toast 反馈。
8. WYSIWYG 校准：CSS 预览 vs Rust 合成像素比对（3 档机型 × 2 模板抽样），偏差超标则以导出为准并修 CSS。

验收：
- 图1 逐项核对表（G12-G20）全部通过。
- 导出 4K JPEG ≤3s（中端真机，复用现有导出多线程）；信息栏 EXIF 数据与照片元数据 100% 一致（**禁止伪造数据**，无 EXIF 走兜底文案）。
- golden 合成测试全绿；GPS 剥离默认开启验证通过。

### W5 Android 性能与兼容（对应原 M5 前半 + alcedo R1-3/R1-4）

**目标**：满足原方案性能指标：冷启 ≤800ms、预览 ≥60fps、导出 4K ≤3s。

任务：
1. **接通 Android wgpu 预览**（全局最高优先）：按 alcedo 方案 R1-3/R1-4 执行——默认 `use_wgpu_renderer=true` + 能力探测失败回退 CPU（保留现默认值为回退路径）；Vulkan/ANGLE 兼容矩阵测试。
2. 内存预算下调档：image_cache_size / thumbnail_worker_threads 按设备内存分级（延续 app_settings 平台降档模式）。
3. 冷启优化：移动壳路由下桌面组件懒加载（W1 分包落地后复测）；模型/LUT 物化延后至首次使用。
4. edge-to-edge 与手势区：底部操作区 padding 接入手势区（MainActivity insets 已就绪，布局验证）；predictive back 预留（Escape 链已闭环，Android 16 预留验证）。
5. 大图防护：100MP 级走 ROI 渲染 + 缩略图 worker（已有），导出超分沿用 memory_budget + 8192 上限自动降档。

验收：
- 真机矩阵 Android 12/13/14/15/16 各 ≥1 台回归（沿用审计 §13 发布链路）。
- 中端机型（如 Snapdragon 7 系）预览滑杆交互 ≥60fps（GPU 路径）/ ≥30fps（CPU 回退路径且提示降级）。
- Crash-free ≥99.8%（原方案门槛）；100MP 样张零 OOM。

### W6 质量保障与交付（对应原 M5 后半 + 审计门禁）

任务：
1. 六门禁 + cargo 测试全绿作为合并门槛（§2.3 红线）。
2. 真实照片数据集回归：风光/人像/夜景各 200 张（原方案要求，禁占位假数据）——与 W3 准确率集合并。
3. UI 还原度验收：三张设计稿逐像素走查（token 表逐项对色）；交互规格走查（原方案第三章矩阵）。
4. i18n：新增文案 15 语言补齐（复用 §15 修复 55 的流程）。
5. 交付物：Release 签名 APK（gen/android keystore 链路）+ Design Tokens 代码（themes.ts --cx-* 组即交付物本身）+ 测试报告（挂入 functional-modules-audit.md 新轮次）+ 本方案 §3 差距核对表销项记录。

---

## 6. 里程碑与依赖

| 阶段 | 内容 | 依赖 | 交付 |
| --- | --- | --- | --- |
| W1 | 移动壳 + 主题 + FlowAccent + 分包 | 无（纯前端） | 三分区骨架可走查，桌面零回归 |
| W2 | 七分类二级面板 + 滑杆/缩略图/裁剪/对比 | W1 | 编辑域全功能，对应原型 s1 |
| W3 | 场景识别 + 推荐卡 + AI 工具网格 | W1（UI）、模型资产（A3 体系） | 推荐卡上线，准确率达标 |
| W4 | 水印导出域 + EXIF 信息栏 + 6 模板 | W1（域路由）、W2（保存入口） | 导出域闭环，对应原型 s2 |
| W5 | Android GPU 预览接通 + 性能档位 | W2/W4 功能冻结后集中调优 | 60fps 预览 + 冷启达标 |
| W6 | 真机矩阵 + 数据集回归 + 签名交付 | 全部 | Release APK + 测试报告 |

关键路径：**W5-1（GPU 预览）可提前至 W1 并行启动**——它阻塞性能验收但不阻塞功能开发；建议作为第一个技术 spike。

---

## 7. 风险与边界

| 风险 | 等级 | 缓解 |
| --- | --- | --- |
| Android 各厂商 WebView/wgpu 兼容差异（Vulkan 驱动碎片化） | 高 | 能力探测 + CPU 回退路径保留（现默认值即回退方案）；真机矩阵覆盖 |
| CSS 预览与 Rust 导出合成的 WYSIWYG 偏差（字体渲染/子像素） | 中 | golden 像素比对；偏差不可收敛时预览改用后端合成图 |
| 场景分类模型在端侧的准确率/功耗 | 中 | INT8 量化 + 缩略图输入 + 置信度门槛 0.75；失败静默降级 |
| 双 UI（桌面/移动）长期维护成本 | 中 | 严格分层（§4.1）：共享 L1/L2，产品差异只进 L4；移动壳设开关可回退 |
| JS 包体积影响 WebView 冷启 | 中 | W1 动态 import 分包（同时消化审计遗留项） |
| 模型/素材许可证 | 低 | 沿用 alcedo 方案 §3 合规矩阵与红线（模型 NOTICE 溯源） |

**Non-goals（沿用原方案并追加）**：不做社交/社区/账户；不新增 shader 算法（人像/特效分类全部由现有参数组合表达）；移动端导出 UI 仅暴露 JPEG/PNG（底层格式能力不裁剪）；不做桌面 UI 的移动化改造（旧 compact 布局保留为回退）。

---

## 8. 原方案 4.3 功能要点 → 本方案映射速查

| 原方案要点 | 本方案落点 |
| --- | --- |
| 预设 = LUT + 曲线 + 分割色调打包，点击入栈 | W2-1：预设/LUT 体系已有，入栈路径复用 pushHistory |
| AI 推荐必须来自真实识别 | W3-3：scene_classify 真实输出 + 置信度 ≥0.75 门槛 |
| RenderEffect/GPU 实时预览，导出才走全分辨率 | 已存在且更优：自适应交互画质 + ROI + 松手精渲（§2.1） |
| 对比按压式 | W2-6：PressAndHold 绑 CompareView/原图路径 |
| EXIF 从元数据真实读取，禁止伪造 | W4-2/3：exifByPath + kamadak-exif，兜底拍摄时间 |
| 撤销/重做 50 步上限 | 已完全一致（useEditorStore） |
| Android 15 edge-to-edge | 已落地（MainActivity.kt），W5-4 验证布局 |
| GPS 默认剥离 | 已存在导出开关，W4-7 设为默认开启 |
