# Crystal 边界记录项实施计划

> 针对《透影 Crystal 改善方案》自检中标记为「边界记录（未实施）」的 7 项，逐项给出可执行实施计划。
> 编制日期：2026-11-02。基于 RapidRAW v2.1.2 仓库现状（含 Crystal 移动层已交付部分）。

---

## 0. 关键重新定性（编制前核实结论）

编制本计划前对仓库做了基建核实，**此前「边界记录」中有 2 项定性过保守，予以修正**：

| 原记录                                         | 核实结果                                                                                                                                                                                                                                                                                                                                                                                                               | 新定性                               |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| 「AI 蒙版基建缺失」（眼部/背景虚化/天空/主体） | 仓库已有完整基建：[ai_commands.rs](src-tauri/src/ai_commands.rs) 提供 `generate_ai_face_mask`（L703）/`generate_ai_depth_mask`（L820）/`generate_ai_sky_mask`（L596）/`generate_ai_subject_mask`（L881）等 7 个命令；[ai_processing.rs](src-tauri/src/ai_processing.rs) 有 ONNX 会话池 + SHA256 校验 + HuggingFace 模型按需下载（L95-101）；[model_residency.rs](src-tauri/src/model_residency.rs) 有模型驻留/淘汰管理 | **移动端接入**（P1/P2），工作量 M    |
| 「镜头虚化需新管线」                           | `adjustments.ts` L133-141 已有 `lensBlurEnabled/Amount/Diffusion/Shape/DepthMap/MinDepth/MaxDepth/MinFade/MaxFade` 全参数族，WGSL 管线支持深度图驱动虚化                                                                                                                                                                                                                                                               | 背景虚化 = 深度蒙版 + 既有参数（P1） |

真正受限的仅剩：场景分类模型资产（P3 需新模型）、LUT 基建（P4 需新建）、wgpu 显示层（P5 需平台专项）、真机环境（P7）。

依赖环境总览：

- Rust 侧全部改动需 **cargo 1.98 工具链**（rust-toolchain.toml 钉 1.98；沙箱不可用，需本机/CI 验证）
- ONNX 模型走 HuggingFace `CyberTimon/RapidRAW-Models` 按需下载，需网络

---

## P1 人像工具补全：眼部增强 + 背景虚化（优先级最高，工作量 M）

### 目标

补齐方案 §3.2 人像分类缺口：`眼部增强`、`背景虚化` 两工具格，操作链路「点击 → 蒙版生成 → 参数写入 → 预览实时生效」闭环。

### 现状依据

- 蒙版命令：`generate_ai_face_mask`（face/eyes/lips/hair 多类分割，mediapipe_selfie_multiclass.onnx）、`generate_ai_depth_mask`（单目深度）
- 虚化参数：`lensBlurDepthMap`（深度图作为虚化驱动）+ `lensBlurAmount`，管线已支持
- 桌面同源：`useAiMasking` hook 已封装「调命令 → 拿蒙版 → 写 adjustments」流程，移动端照搬数据流

### 实施步骤

1. `CrystalCategoryPanel` 人像分类增加两个 tile：
   - **眼部增强**：`invoke(generate_ai_face_mask)` → 取 eyes 通道蒙版 → 映射为局部调整（清晰度/曝光 +N 写入蒙版作用域），复用桌面眼睛增强的参数组合
   - **背景虚化**：`invoke(generate_ai_depth_mask)` → 深度图写 `lensBlurDepthMap` → `lensBlurEnabled: true` + `lensBlurAmount` 滑杆（0-100）
2. 首次触发时的模型下载 UX：复用桌面下载进度事件（若移动壳未监听则在 `useTauriListeners` 补 `model-download` 进度 toast），显示「AI 模型下载中 xx%」；失败 → toast 降级为手动滑杆，不阻塞编辑
3. busy 态沿用 `CrystalAiToolsPanel` 的 tile spinner + disabled 模式
4. i18n：`crystal.portrait.eyeEnhance` / `crystal.portrait.bgBlur` / `crystal.model.downloading` 等 5-6 键 × 15 语言

### 验收标准

- 有/无人脸图片分别验证：无人脸时 toast 提示并跳过（不崩溃）；有脸图眼部可见增强
- 背景虚化滑杆拖动预览实时刷新；导出图与预览一致（同一 adjustments 全分辨率出图，天然一致）
- 断网首次使用：下载失败降级提示，无崩溃

### 风险与回退

- mediapipe_selfie_multiclass 在低端机推理耗时（~1-3s）：已属后台 invoke + busy UI，可接受；必要时降低推理输入分辨率（`ai_processing` 会话侧已有缩放）
- 回退：两 tile 为纯增量，下线不影响既有面板

---

## P2 AI 工具面板扩展：天空识别 / 主体识别（工作量 S）

### 现状依据

`generate_ai_sky_mask`（L596）/ `generate_ai_subject_mask`（L881）/ `precompute_ai_subject_mask`（L933）全部现成；`AiMaskModel::Sky/Subject` 枚举就位。

### 实施步骤

1. `CrystalAiToolsPanel` tiles 4 格 → 6 格：新增「天空识别」（选中后天空区域高亮 + 局部调整入口）、「主体识别」（选中主体 → 后续局部工具作用域）
2. 与 P1 共用模型下载 UX 与 busy 态组件（抽 `useAiTileTask` 小 hook 于 crystalShared.tsx）
3. i18n 2 键 × 15 语言

### 验收标准

- 风光图点天空识别 → 预览叠加高亮蒙版（与桌面 CompareView 蒙版显示同源）；AI 格在识别期间 spinner、失败 toast 不阻塞

---

## P3 场景智能分类（W3 补课，工作量 M，需新模型资产）

### 目标

方案 §4.3「端侧轻量场景分类（风景/人像/夜/美食）→ 命中规则库 → 推荐标签」，§7 边界「置信度 ≥ 0.75 才展示」。

### 实施步骤

1. **模型资产**：mobileNetV3-small（int8, ~7MB）或 efficientnet-lite0 int8 导出 ONNX（ImageNet 1k → 映射 4 场景：风景/人像/夜景/美食，映射表入 `crystalShared.tsx`），上传到 RapidRAW-Models 仓库 + 登记 SHA256/URL 到 `ai_processing.rs`（沿用 FACE_SEGMENTER_URL 模式，L95-101 同款常量）
2. **Rust**：`ai_commands.rs` 新增 `classify_scene(path) -> Vec<{scene, confidence}>`（ort 会话 + 224×224 预处理，复用现有 preprocess 工具）
3. **前端**：`AiRecommendCard` 扩展——选中图片时后台调分类，conf ≥ 0.75 才把推荐理由标签从「EXIF 启发」升级为「场景识别」结果并高亮命中预设组；< 0.75 维持 EXIF 启发（诚实降级，方案 §七 防"假 AI"）
4. 失败/无模型：静默回落 EXIF 启发，零阻塞

### 验收标准

- 风光/人像/夜景/美食 各 20 张样张离线验证 top-1 ≥ 80%，置信度门槛生效
- 无网络+无模型缓存：推荐卡仍工作（EXIF 启发）

---

## P4 特效补全：LUT 基建（荧光/色彩氛围）（工作量 L，需新建基建）

### 现状依据

- 仓库**无** `.cube`/3D LUT 能力（grep 无 Lut3D）；但 `halationAmount`（镜头光晕）管线已支持——特效面板可直接补光晕滑杆 tile（S 级顺手项）
- 分割色调/色轮（color_grading wgsl L888）已支持 → 「色彩氛围」可用预设色轮参数包实现，无需 LUT

### 实施步骤

1. **S 级先行**：特效面板补 `halationAmount`（光晕）与 `vibrance` 氛围 tile —— 纯接入，0 后端改动
2. **L 级 LUT 正式版**：
   - Rust：`.cube` 文本解析器（LUT_3D_SIZE/表格）+ `apply_lut` CPU 路径（tetrahedral 插值）并入 `export_processing`；预览路径若走 GPU 需 wgsl 3D texture（或预览走 CPU 小图，可接受）
   - 前端：LUT picker（横滑卡同 FilterThumbStrip 样式）+ 内置 3-5 款授权兼容 LUT 资产 + `importCube` 文件导入
   - adjustments 增加 `lutId/lutStrength`
3. 「荧光」tile = 内置荧光风 LUT + 强度滑杆

### 验收标准

- .cube 解析单元测试（Rust，含错误格式容错）；LUT 强度 0/50/100 导出与预览一致；导入自定义 LUT 生效

### 风险

- wgsl 3D texture 绑定改动涉及主 shader（[shader.wgsl](src-tauri/src/shaders/shader.wgsl)），建议 CPU 预览先行、GPU 化单独评审
- LUT 资产版权：只用 CC0/自研

---

## P5 Android GPU：导出路径 wgpu 化（R1-3 修正版，工作量 M）

### 现状依据

- [platform_features.rs](src-tauri/src/platform_features.rs) `wgpu_rendering_decision` Linux/Android 硬编码 false——**显示层**（present-to-webview）未接通，翻默认值=白屏，维持禁用
- 但**导出/缩略图等无显示路径**是 offscreen 渲染 → readback → 编码，不存在 present 问题，可在 Android 启用 GPU compute

### 实施步骤

1. `wgpu_rendering_decision` 拆分为 `preview_decision`（维持现状）与 `offscreen_decision`（Android 上 hardware 适配器 + 非 software 即 true）
2. 导出调用点（`export_processing` 渲染入口）与缩略图 worker 改用 offscreen decision
3. 设置项暴露「导出 GPU 加速」开关（默认开，可回退 CPU），存 `app_settings`
4. 真机 A/B：4K 导出耗时 CPU vs GPU 对比达标（方案 §五：4K ≤ 3s）再默认开启

### 验收标准

- Android 真机导出像素级与 CPU 路径一致（同 adjustments 双路径 golden 比对）
- 软件渲染设备（probe.is_software）自动回落 CPU

---

## P6 构图全屏沉浸裁剪（工作量 M）

### 现状依据

移动构图=比例 chips + 透视/旋转滑杆，无自由裁剪沉浸态；[crystal.css](src/crystal.css) L59-61 已预留 `.cx-app.is-fullscreen-crop`（z-index 60，当前为死代码）。

### 实施步骤

1. `CrystalCategoryPanel` 构图分类加「自由裁剪」tile → 进入沉浸态：`is-fullscreen-crop` 挂 `.cx-app`，隐藏 catnav/bottombar/panel，预览区放大为全屏
2. 裁剪交互：复用 `react-image-crop`（触摸可用）+ 比例 chips 浮层 + 网格线 + 「取消/确认」双胶囊；写 `adjustments.crop`（与桌面同构）
3. Android 返回键：沉浸态按返回=退出裁剪（exit layer 顶层注册）
4. i18n 3 键 × 15 语言

### 验收标准

- 拖角裁剪/比例锁定/超界约束（复用 `cropUtils.isCropWithinBounds`）；确认后预览即裁剪；导出与预览一致

---

## P7 质量保障专项：真机矩阵 + W4-8 导出 golden（工作量 M，需环境）

### 前置环境（本机/CI，沙箱不具备）

- Rust 1.98 工具链 + Linux GTK 系统库（glib-2.0 等）+ Android NDK/SDK
- 真机：Android 12/13/14/15/16 各 ≥1 台；数据集：风光/人像/夜景各 200 张（方案 §五）

### 实施步骤

1. **Rust 单测（cargo 可用环境）**：`export_processing` 增加 golden 测试——固定样张 + 固定 adjustments + exif_frame/text_watermark 输出 hash 断言；`apply_lut` 解析测试
2. **补跑积压验证**：本轮签名绘制顺序修复（apply_text_watermark 前置）+ font_family 系统字体加载，`cargo check` + golden 通过后关闭该验证项
3. **真机矩阵脚本**：`tauri android build` 产物 + 手动回归清单（25 步：图库→编辑→七分类→导出全链路），记录 Crash-free ≥ 99.8% 门槛数据
4. **数据集回归**：200×3 张批量导出（脚本驱动）零崩溃、无 OOM（inSampleSize 链路验证）

### 验收标准

- CI 红/绿门禁：cargo test（golden）+ tsc + eslint + i18n:check 四绿
- 真机矩阵报告归档（机型×安卓版本×结果）

---

## 排期建议（按依赖与价值排序）

| 里程碑          | 内容                                               | 依赖                                            |
| --------------- | -------------------------------------------------- | ----------------------------------------------- |
| M-A（1-2 单位） | P2 天空/主体 tiles + P1 人像双工具（共用下载 UX）  | cargo 1.98 环境验证 Rust 无改动项可先做前端接入 |
| M-B（1 单位）   | P4-S 光晕/氛围 tile + P3 的 EXIF 启发规则扩展      | 无                                              |
| M-C（2-3 单位） | P3 场景分类模型（资产制作 + Rust 命令 + 前端升级） | 模型资产制作                                    |
| M-D（2 单位）   | P5 导出 GPU 化 + P6 沉浸裁剪                       | 真机                                            |
| M-E（1-2 单位） | P4-L LUT 基建 + P7 golden/真机矩阵收尾             | cargo 环境 + LUT 资产                           |

## 明确不做（维持边界）

- wgpu 显示层 present-to-webview（需 Tauri/wry 平台层专项，收益仅预览帧率，导出 GPU 化已覆盖主要价值）
- 自定义水印模板实体体系（收藏/默认标记已覆盖高频诉求）
