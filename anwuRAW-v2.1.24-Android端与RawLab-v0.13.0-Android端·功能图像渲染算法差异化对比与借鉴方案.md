# anwuRAW（透影 Crystal）Android 端 vs RawLab v0.13.0 · 功能 / 图像算法 / 渲染算法差异化对比与借鉴方案

- 本地侧：**anwuRAW v2.1.24**（GitHub 最新 release，2026-11-16，commit `fa42fb9`；本仓 HEAD=v2.1.23 + 质量专项收敛。v2.1.24 官方声明"无渲染语义变更、PROCESSING_VERSION 未动"——见 [release notes](https://github.com/Tri250/anwuRAW/releases/tag/v2.1.24)，故算法/渲染基线沿用 [v2.1.23 七大功能域盘点报告](file:///workspace/v2.1.23-七大功能域盘点报告.md)）
- 对比对象：**[RawLab v0.13.0](https://github.com/dancancer/RawLab/releases/tag/v0.13.0)** Android 端（build 25，commit `e82a3c9cf`，Android 8.0+，arm64-v8a + x86_64 双 ABI，GPL-3.0-only）
- 资料截止：2026-11-27。RawLab 侧为官方文档（P0）；Crystal 侧为代码取证 + 三份专项文档：[v2.1.13 Android 审计](file:///workspace/v2.1.13-android-crystal-audit.md)（19 缺陷修复）、[crystal-mobile-improvement-plan.md](file:///workspace/crystal-mobile-improvement-plan.md)（W1-W6 规划）、[七大功能域盘点](file:///workspace/v2.1.23-七大功能域盘点报告.md)。
- 来源编号：`[RL-rel]`=[v0.13.0 发行说明](https://github.com/dancancer/RawLab/blob/development/docs/releases/v0.13/v0.13.0.md)｜`[RL-cc]`=[color-contract](https://github.com/dancancer/RawLab/blob/development/lutools/docs/color-contract.md)｜`[RL-hdr]`=[HDR 设计](https://github.com/dancancer/RawLab/blob/development/docs/design/hdr-photos/camera-raw.md)｜`[RL-cl]`=[CHANGELOG](https://github.com/dancancer/RawLab/blob/development/CHANGELOG.md)｜`[RL-home]`=[README](https://github.com/dancancer/RawLab)｜`[AW-rel]`=[anwuRAW v2.1.24 release](https://github.com/Tri250/anwuRAW/releases/tag/v2.1.24)｜`[CR]`=本仓代码/文档（file:/// 链接）

---

## 0. 结论先行

**一句话定性**：这是两种 Android 技术路线的正面对比。RawLab Android =「**C++17 核心 + JNI + OpenGL ES 真 GPU 渲染 + 原生 Compose UI**」，长板在渲染性能（GLES 后端 + 1:1 ROI 金字塔渐进缩放）、相机无线工作流（Sony Wi-Fi 增量导入 + 联机拍摄 + SSH 隧道 + 双卡槽，Android 正式支持）与 HDR 增益图编辑；**但 Android 端 AI 能力为零**（AI 降噪仅 Apple Silicon Core ML / Windows DirectML，无 CPU 神经推理回退 [RL-home][RL-rel]）。anwuRAW Android =「**Tauri WebView 壳 + Rust 管线 + CPU 兜底渲染**」，长板在 AI 工具链（SAM/ESAM3 蒙版、人脸 9 区、NIND 降噪、场景识别、追色——全部在 Android 纯 CPU EP 上真实可用 [CR:审计§1.5/1.2]）、LUT/特效/人像广度与 15 语 i18n；**短板是 Android 预览默认走 CPU 兜底（`use_wgpu_renderer=false`），60fps 实时预览目标未达 [CR:app_settings.rs L766-784]、[CR:mobile-plan W5]**。

**互补关系几乎完美对称**：RawLab 有的（GPU 渲染、相机无线、HDR、DNG 导出、双 ABI）正是 anwuRAW Android 的缺口清单（W5 最高优先项、规划中 P1）；anwuRAW 有的（AI 全家桶、追色、人像精修、特效）恰是 RawLab Android 完全没有的。双方均 GPL-3.0，代码级互借合法（RawLab AI 模型包除外——单独许可，且本就无 Android 神经推理可借）。

**最值得做的四件事**：① Android GPU 预览接通（已有 W5-1 规划，RawLab 的 GLES 路线证明移动端真 GPU 渲染可行且是 60fps 的前提）；② 1:1 视口 ROI 分块 + 金字塔渐进缩放；③ PTP/IP 相机无线导入与联机拍摄（RawLab 证明纯用户态 Wi-Fi PTP 在 Android 可行，不依赖 USB/gphoto2）；④ HDR 增益图编辑与导出体系。

---

## 一、Android 端形态与架构对比

| 维度 | RawLab v0.13.0 Android | anwuRAW v2.1.24 Android | 差异判定 |
| --- | --- | --- | --- |
| UI 技术 | 原生 Jetpack Compose [RL-home] | Tauri 2 WebView + React 19 移动视图层（Crystal 移动壳，编辑域/导出域双流程）[CR:CrystalMobileApp.tsx L194-198]、[CR:mobile-plan D1] | RawLab 启动/交互开销更低；anwuRAW 复用桌面生态但 JS 主包 4.8MB 需分包（W1 任务）[CR:mobile-plan §2.2] |
| 核心接入 | C++17 核心 → JNI **三路拆分**（v0.13）[RL-rel] | Rust 管线直接编译进 APK（无桥接层），Tauri IPC 通信 | anwuRAW 链路更短；RawLab ABI 边界更严格 |
| GPU 后端 | **OpenGL ES**（三后端之一）+ Auto CPU 一致性回退 [RL-cc][RL-rm] | wgpu（Vulkan/GLES）**展示层未接入**，默认 CPU 兜底 [CR:app_settings.rs L766-784]、[CR:盘点§D] | **核心差距**：RawLab Android 出厂即真 GPU；anwuRAW 预览 CPU 路径（自适应画质 0.3–0.5 缓解）[CR:盘点§5] |
| ABI | arm64-v8a + x86_64 双 ABI [RL-rel] | 仅 arm64-v8a [CR:盘点§D]、[AW-rel] | x86_ 利于模拟器/Chromebook，优先级低 |
| 最低版本 | Android 8.0+ [RL-home] | 未在盘点中披露（Tauri 2 默认 minSdk 24 ≈ Android 7） | — |
| AI 运行时 | **无**（AI 降噪仅 macOS Core ML / Windows DirectML，Android 无神经推理）[RL-rel][RL-home] | ort 2.0-rc.10（load-dynamic），Android 纯 CPU EP：SAM/BiRefNet/ESAM3/DepthAnything V2/MediaPipe/CLIP/NIND 全部可用 [CR:Cargo.toml L44]、[CR:审计§1.2/1.5] | **anwuRAW 代差级独有优势** |
| 无线相机 | Sony Wi-Fi 导入 + 联机拍摄（Android 正式）+ SSH Access Auth + α7M5 双卡槽 [RL-rel] | ❌（gphoto2 联机仅 macOS/Linux 构建，[CR:Cargo.toml L98-99]；Android 无任何 PTP/Wi-Fi 相机能力） | **RawLab 独有** |
| 更新分发 | APK 手动分发（无应用商店） | APK/AAB + 桌面端 latest.json 自动更新（Android 无 updater 插件，[CR:Cargo.toml L95-96]） | 平手 |
| 诊断 | opt-in 诊断会话（路径脱敏 + ZIP + 阿里云 SLS 上传）[RL-rel] | GPU 能力降级诊断（15 语本地化）[CR:盘点§11⑤] | RawLab 端到端诊断链路更完整 |
| 界面语言 | 6 语 [RL-home] | 15 语 [CR:盘点§9] | anwuRAW 领先 |

---

## 二、功能差异化对比清单（Android 端视角）

图例：✅ Android 可用 —— ⚠️ 受限/降级 —— ❌ 无

### 2.1 编辑功能面

| 功能 | RawLab Android | anwuRAW Android | 判定 |
| --- | --- | --- | --- |
| 基础影调（曝光/对比/高光阴影/黑白场/鲜艳度） | ✅ [RL-cc] | ✅ TonePanel 光/色分区 [CR:审计§1.3] | 平手 |
| 白平衡 | ✅ 相机 WB/auto/色温 2000–50000K [RL-cc] | ✅ as-shot + 吸管 [CR:盘点§5.3] | 平手 |
| HSL | ✅ 8 色域 + 取样探针 [RL-cc] | ✅ 8 通道 [CR:审计§1.3] | 探针缺失（借，见 §5-P1） |
| 3-Way 分级 + 色彩校准 | ✅ 三区+全局 [RL-cc] | ✅ 三区+全局+校准 [CR:审计§1.3]、[CR:盘点§5.5] | anwuRAW 多校准 |
| 曲线 | ✅ 主+RGB PCHIP + 参数化 4 段可调分割点 + v0.13 自由端点 X [RL-cl][RL-rel] | ✅ 点曲线+参数化（与桌面同构）[CR:审计§1.3/6.3] | 算法差异见 §3.3 |
| LUT/胶片 | ✅ 54 look + CUBE/RLOOK 导入 [RL-cc] | ✅ 26 胶片 LUT + 14 大师配方 + CUBE/3dl/HALD 导入（content:// 双侧支持 + 外存缓存）[CR:审计§1.6]、[CR:android_integration.rs L114-162] | anwuRAW 格式更广、物化链路完整 |
| 参考图追色 | ❌ | ✅ ComputeColorMatch（Lab 均值+分位数曲线+ΔE toast）[CR:审计§1.3] | anwuRAW 独有 |
| 负片翻拍 | ❌ | ⚠️ 后端有（negative_conversion.rs），移动端入口未见 | 潜在独有 |
| 软打样 | ❌ | ❌（CSS 滤镜方案仅 WebGPU 桌面）[CR:盘点§4.5] | 双缺 |
| 构图 | ✅ 裁剪/旋转 ±45°/拉直/翻转/keystone [RL-cc] | ✅ 比例 chip/旋转/拉直/自动镜头校正/裁剪手势（边界钳制+比例锁+三分网格）[CR:审计§1.4/6.4] | anwuRAW 无透视 UI（桌面有）；RawLab 有 keystone |
| 引导透视 | ❌ | ❌（桌面独有 guided_perspective） | 双缺 |

### 2.2 AI 工具面（anwuRAW 单边优势区）

| 功能 | RawLab Android | anwuRAW Android | 判定 |
| --- | --- | --- | --- |
| AI 降噪 | ❌（无 Android 神经推理）[RL-home] | ✅ NIND 神经 + ai-free 回落 BM3D [CR:审计§1.5] | **anwuRAW 独有** |
| AI 蒙版（主体/天空/文本提示词/景深） | ❌ | ✅ 一键生成 + 容器强度 + 取消语义闭环 + 跨图守卫 [CR:审计§1.5/6.5] | **anwuRAW 独有** |
| 人像分区精修 | ❌ | ✅ 9 区人脸蒙版 + 磨皮/美齿/亮眼/瘦脸/下颌线/统一肤色 + 背景虚化（深度图复用）[CR:审计§1.2/6.2] | **anwuRAW 独有** |
| AI 一键增强/自动色调 | ❌ | ✅ 三档直方图增强 + 自动色调 [CR:审计§1.5] | anwuRAW 独有 |
| 场景识别推荐 | ❌ | ✅ scene_classify → 大师配方推荐卡（isReady 门控防跨图误挂）[CR:审计§6.1] | anwuRAW 独有 |
| 生成式消除/液化 | ❌ | ⚠️ 液化可用（GenerateFaceLiquifyPatch）；生成替换依赖云端/局域网 connector [CR:盘点§3.4] | anwuRAW 独有（云端部分受限） |
| AI 超分导出 | ❌ | ✅ 2×/4× Lanczos3 + 内存预算 + 8192 降档（无取消/进度，[CR:盘点§7.6]） | anwuRAW 独有 |

### 2.3 HDR 体系

| 功能 | RawLab Android | anwuRAW Android | 判定 |
| --- | --- | --- | --- |
| 增益图 HDR 编辑 | ✅ 手机 gain-map HDR 导入编辑，HDR/SDR 双份编辑 [RL-home][RL-hdr] | ❌ | **RawLab 独有** |
| HDR Look/限幅 | ✅ HDR CUBE look、HDR Silver、peak limit [RL-cl] | ❌ | RawLab 独有 |
| HDR 导出 | ✅ 增益图 JPEG（Android）；HDR HEIF 仅 Apple [RL-home] | ❌ | RawLab 独有 |
| 括拍 HDR 合并 | ❌ | ⚠️ 后端有（hdr_deghosting 对齐+去鬼影），移动端入口未见 | anwuRAW 潜在独有 |
| EXR/HDR/JXL 输入 | 未披露 | ✅ [CR:formats.rs L74-75] | anwuRAW 容器更广 |

### 2.4 工作流与导出

| 功能 | RawLab Android | anwuRAW Android | 判定 |
| --- | --- | --- | --- |
| 相机无线导入 | ✅ Sony Wi-Fi 增量导入（断点续传/防重复/JPEG resize）[RL-cl] | ❌ | **RawLab 独有** |
| 联机拍摄 | ✅ 实时取景/手机快门/点按对焦/焦点区域/SSH 隧道/双卡槽 [RL-rel][RL-cl] | ❌ | **RawLab 独有** |
| 批量导出 | ✅ 可恢复批量导出（冻结设置/取消/重试）[RL-home] | ✅ 批量 + 取消导出（v2.1.13 补）+ MediaStore 落盘 + batch-export-progress 事件 [CR:审计§三] | 平手；anwuRAW 落盘走系统相册更贴移动习惯 |
| 导出格式 | ✅ JPEG / 16-bit PNG / **渲染 DNG** [RL-ej] | ✅ JPEG/PNG UI（AVIF/JXL/WebP/TIFF/ICC 宽色域底层已具备但移动 UI 未暴露）[CR:mobile-plan §2.1] | anwuRAW 底层超集、UI 收窄；DNG 双缺（桌面也缺） |
| 导出可靠性 | ✅ AtomicOutputTransaction 临时文件+原子替换 [RL-rel] | ⚠️ 可恢复导出日志有；成品"临时+替换"未证实 [CR:export_processing.rs L2201] | RawLab 领先 |
| 水印/签名/EXIF 栏 | 未披露 | ✅ 图片水印+文字水印（内置字体）+ 相框 + EXIF 信息栏（WYSIWYG 实测）[CR:审计§三] | anwuRAW 独有 |
| 大图缩放 | ✅ 1:1 视口 ROI 渐进缩放（移动端）[RL-cl] | ⚠️ ROI 渲染有（桌面管线）；移动端渐进缩放未见 | RawLab 交互领先 |
| 检视辅助 | ✅ Inspection 覆盖层 + HUD 不淡出（v0.13 专项修复）[RL-rel] | ⚠️ 剪裁警告/dither 在管线尾段；移动端检视套件未成体系 | RawLab 更系统 |
| 预设/编辑状态迁移 | ✅ rawlab-transfer-v1.json [RL-cl] | ✅ XMP 导入（preset_converter）+ 预设导入导出 [CR:盘点§2.4] | anwuRAW 兼容 Adobe 生态更实用 |

---

## 三、图像算法差异化对比清单（Android 端执行路径）

> 判定基于"该算法在 Android 上实际以什么路径执行"。anwuRAW 的 Android 预览走 CPU 兜底，导出走完整管线（CPU/GPU 均可），故以下按"预览路径 / 导出路径"分别标注。

### 3.1 RAW 解码

| 项 | RawLab Android | anwuRAW Android | 判定与借鉴 |
| --- | --- | --- | --- |
| 解码库 | LibRaw 0.22.2（C++ 核心，JNI 传入字节）[RL-cc] | rawler（纯 Rust）[CR:raw_processing.rs L292]；Apple CIRAW 仅 macOS（Android 无）[CR:Cargo.toml L101-120] | 平手；rawler 对 800+ 机型 [CR:mobile-plan §1.2] |
| 显影顺序纪律 | 黑场减除→活动区裁剪→**WB 先于 demosaic**→高光色度混合（highlight=2）→float→sRGB 矩阵，不全局 clamp，解包错误 fatal [RL-cc] | rawler 默认流程 + 高光重建接线 [CR:盘点§2.1] | RawLab 顺序纪律可对照审计（借概念，见 §5-P2） |
| 曝光基准 | scene/preview/sensor 三基准（preview=128² 中值匹配内嵌预览）[RL-cc][RL-ej] | 单一基准 | **P0 借鉴**："打开即所见"在移动端价值更高 |

### 3.2 影调与色彩算法

| 项 | RawLab Android | anwuRAW Android | 判定与借鉴 |
| --- | --- | --- | --- |
| 高光/阴影 | 引导滤波局部控光（processing v3）[RL-rm] | 双分区 + WGSL 软压缩；Android CPU 路径同参实现（consistency 测试保障）[CR:盘点§5.1/§E] | 同构 |
| 曲线插值 | **PCHIP 单调样条**（无过冲）+ 自由端点 X [RL-cl][RL-rel] | 三次 Hermite ×16 点（[shader.wgsl L406](file:///workspace/src-tauri/src/shaders/shader.wgsl#L406)）；CPU 路径同构 | RawLab 更稳；端点 X 内移（黑场/白场曲线化）是功能缺口 |
| 色调映射 | 无用户可选（HDR 内 sigmoid+色度压缩）[RL-hdr] | basic/AgX/PBR Neutral/ACES 四选（CPU/GPU 双实现）[CR:盘点§5.2] | anwuRAW 独有优势 |
| 降噪 | 线性小波（亮度/色度/粗尺度色度分离）[RL-home]；**Android 无 AI 降噪** | WGSL 空域（ISO 联动 sigma）+ BM3D（ai-free 回落）+ NIND 神经（CPU EP 真实可用）[CR:审计§1.5]、[CR:盘点§5.10] | anwuRAW Android 反超：有 AI 且有 ISO 先验；小波粗尺度色度分离概念可借 |
| 去雾/清晰度 | 双向；GPU 化在路线图阶段二（v0.13 CPU 参考实现）[RL-rm] | 双向；airlight 单点全局（P0-4 计划局部化）[CR:image-pipeline-improvement-plan.md](file:///workspace/image-pipeline-improvement-plan.md#L104-L112) | 互有规划，RawLab 未披露细节 |
| 颗粒 | 确定性 grain [RL-cc] | 频率随 scale 归一 [CR:盘点§8.8] | 平手 |
| 镜头校正 | Lensfun 畸变/TCA/自动边缘裁剪 [RL-cc] | Lensfun + 9 参数手动 [CR:盘点§6.7] | anwuRAW 手动兜底更全 |

### 3.3 HDR 处理算法

| 项 | RawLab Android | anwuRAW Android | 判定与借鉴 |
| --- | --- | --- | --- |
| 显影模型 | 一次线性显影出 HDR 主图 + SDR 底图（sigmoid + 色度压缩至 [0,1]）；参考白 = `0.25×2^(2+BaselineExposure)`，0.1845 中灰 [RL-hdr] | 括拍合并（特征对齐 + 非极大值抑制去鬼影 + 融合，3200px 上限）[CR:hdr_deghosting.rs L17-22] | 两条互补路线：RawLab 是"单文件 HDR 显影"，anwuRAW 是"多帧合成"。增益图体系可嫁接合并输出（§5-P1） |
| HDR→SDR 编码 | v0.13 核心统一 RGBA8/BGRA8 [RL-rel] | 无 | 随 HDR 体系一起补 |

### 3.4 AI 算法（RawLab Android 无此项对比）

| 项 | RawLab Android | anwuRAW Android | 判定 |
| --- | --- | --- | --- |
| 推理栈 | — | ort CPU EP，9+ 模型按需下载（三镜像回退）、ResidencyTracker 驻留淘汰 [CR:盘点§0/§7] | anwuRAW 独有 |
| 深度/法线 | — | Depth Anything V2 + MoGe-2（镜头模糊/雾化/重打光底座，跨图守卫）[CR:审计§1.6] | anwuRAW 独有 |
| CLIP 场景 | — | 4 类零样本 + 启发式降级（切图 isReady 门控）[CR:审计§6.1] | anwuRAW 独有 |

---

## 四、渲染算法与管线差异化对比清单（Android）

### 4.1 渲染路径

| 维度 | RawLab Android | anwuRAW Android | 判定与借鉴 |
| --- | --- | --- | --- |
| GPU 执行 | GLES compute/fragment 三后端之一，出厂即用 [RL-cc][RL-rm] | wgpu 已具备 Vulkan/GLES 后端能力，但 Android 展示层未接：**默认 `use_wgpu_renderer=false` → CPU 兜底** [CR:app_settings.rs L766-784]、[CR:mobile-plan W5] | **P0 差距**。W5-1 已规划（默认 true + 能力探测回退 + Vulkan/ANGLE 兼容矩阵）[CR:mobile-plan W5] |
| CPU 回退语义 | Auto 回退以"与 GPU 逐位一致"为目标（一致性回退，非降级）[RL-rm][RL-cc] | CPU/GPU 双路径 + 124 参数一致性测试 + 编译期 45264B 布局断言 [CR:盘点§5.11] | **anwuRAW 纪律不落后**：有测试兜底；差距在 GPU 路径"可用性"而非"一致性" |
| 分块 | 未披露 | TILE 2048/OVERLAP 128，全图采样无缝 [CR:盘点§2.1] | anwuRAW 已解 |
| 金字塔/ROI | ✅ fast GPU/pyramid C ABI + 1:1 ROI 渐进缩放 [RL-rel][RL-cl] | ⚠️ ROI 局部渲染有（管线级）；金字塔渐进缩放未见 [CR:mobile-plan §2.1] | **P0 借鉴**（见 §5） |
| 输出精度 | HDR→SDR 统一 RGBA8/BGRA8 [RL-rel] | 预览 rgba8unorm / 导出 rgba16float（关 dither）[CR:gpu_processing.rs L2355-2368] | 平手 |
| 性能指标 | 未公开数值；实际体验"原生 Compose + GLES" | 目标冷启 ≤800ms / 预览 ≥60fps / 4K 导出 ≤3s [CR:mobile-plan W5]（GPU 接通前 CPU 路径预期 ≥30fps） | RawLab 架构天然占优；anwuRAW 需靠 W5 追平 |

### 4.2 渲染工程纪律

| 维度 | RawLab Android | anwuRAW Android | 判定与借鉴 |
| --- | --- | --- | --- |
| 跨后端对拍 | ✅ 四后端容差对拍 + Auto/Force 两级策略 [RL-rm] | ⚠️ golden + consistency（CPU/GPU）有；无多 GPU 后端互拍 [CR:盘点§9] | P0 借鉴（wgpu 下成本低） |
| schema 版本化 | ✅ SDR 18 / HDR 19 / pv10；旧版拒绝降级 [RL-rel] | ⚠️ XMP 迁移 + sidecar 兼容测试；版本化拒绝未证实 | P0 借鉴 |
| 来源身份 | ✅ PinnedSourceFile + file stamp [RL-rel] | ⚠️ 按路径 | P2 借鉴 |
| 导出原子性 | ✅ AtomicOutputTransaction [RL-rel] | ⚠️ 日志有、原子替换未证实 | P2 借鉴 |
| 检视套件 | ✅ InspectionSuite 下沉核心（v0.13）[RL-rel] | ⚠️ 分散 | P2 借鉴 |
| 移动专项质量 | 真机矩阵覆盖（BUILD-PROVENANCE.json 记录）[RL-rel] | Android 真机回归 8 项清单固化（v2.1.24 新增）+ 宿主可跑导入链路回归锚点；**真机实测仍待人工执行** [AW-rel]、[CR:盘点§9] | 方向一致，anwuRAW 待落地实测 |

---

## 五、取长补短清单（anwuRAW Android → 向 RawLab v0.13.0 Android 借）

### P0-1 Android GPU 预览接通（补最大短板，最高优先）

- 借什么：RawLab 证明 **OpenGL ES 单后端即可承载完整移动渲染管线** [RL-cc][RL-rm]，无需等 Vulkan 全覆盖。
- 落点：按既有 [crystal-mobile-improvement-plan.md W5-1](file:///workspace/crystal-mobile-improvement-plan.md#L327-L343) 执行——`use_wgpu_renderer` 默认 true + 能力探测失败回退 CPU + Vulkan/ANGLE 兼容矩阵；wgpu 的 GLES 后端覆盖低版本设备（与 RawLab 的 GLES 路线同构）。
- 验收：中端机（Snapdragon 7 系）滑杆交互 ≥60fps（GPU）/ ≥30fps 且提示降级（CPU）。

### P0-2 1:1 视口 ROI 分块 + 金字塔渐进缩放

- 借什么：RawLab 的 fast GPU/pyramid C ABI + 移动端 1:1 ROI tiling 渐进缩放 [RL-rel][RL-cl]。
- 为什么：anwuRAW 有 ROI 渲染（管线级）但缺"缩放过程金字塔渐进出图"，大图捏合缩放时 CPU 路径会卡顿。
- 落点：`gpu_processing.rs` 增加 mip 链低清快照通道（bloom 的 5 级 mip 链基建可复用）+ 前端 `CrystalPreview` 缩放手势期间先呈金字塔层、静止后渲 ROI 全精度。

### P0-3 PTP/IP 相机无线导入与联机拍摄

- 借什么：RawLab 在 Android 上纯用户态实现 Sony Wi-Fi 增量导入（断点续传、防重复、JPEG resize）与联机拍摄（实时取景/点按对焦/焦点区域），v0.13 再加 SSH Access Auth 隧道与 α7M5 双卡槽 [RL-rel][RL-cl]。
- 为什么：这是 anwuRAW Android 完全空白的域；桌面 gphoto2 路线（[Cargo.toml L98-99](file:///workspace/src-tauri/src/camera_tethering.rs)）无法移植到 Android，而 PTP/IP 是纯 TCP 用户态协议，Rust 可实现且 RawLab 已验证"PTP/IP 边界收拢 + live-view 测试 + 焦点状态管理"的工程拆分 [RL-rel]。
- 落点：新模块 `ptp_ip.rs`（Rust：PTP 会话/对象列举/增量拉取）+ Android 前端导入页；联机（live view/快门）二期。
- 验收：α7C II 级机型增量导入不重不漏、断连可续（对齐 RawLab 0.11 验证口径 [RL-home]）。

### P0-4 HDR 增益图编辑与导出体系

- 借什么：gain-map HDR 导入编辑、HDR/SDR 双份独立编辑、HDR look/peak limit、增益图 JPEG 导出 [RL-hdr][RL-home]；参考白科学定义 `0.25×2^(2+BaselineExposure)`、0.1845 中灰。
- 为什么：Android 相册 HDR 照片占比持续上升；anwuRAW 已有括拍合并（[hdr_deghosting.rs](file:///workspace/src-tauri/src/hdr_deghosting.rs)）与 UltraHDR 规划（alcedo A2 [CR:mobile-plan §2.2]），缺"显影-呈现-导出"体系。移动端优先级天然高于桌面。
- 落点：`hdr_pipeline.rs`（双底图生成）+ [display.wgsl](file:///workspace/src-tauri/src/shaders/display.wgsl)（HDR→SDR RGBA8 编码）+ 导出端 gain-map JPEG。

### P1-1 导出格式 UI 补齐与渲染 DNG

- anwuRAW 底层已有 AVIF/JXL/WebP/TIFF/宽色域 ICC [CR:mobile-plan §2.1]，移动导出 UI 仅暴露 JPEG/PNG——先放开 UI；渲染 DNG 导出（RawLab 全端具备 [RL-ej]）在导出层新增 DngWriter。

### P1-2 原子导出替换（AtomicOutputTransaction）

- 成品写盘走"临时文件 + 完成才替换 + 失败报 output_io_error" [RL-rel]，与现有可恢复日志（[export_processing.rs L2201](file:///workspace/src-tauri/src/export_processing.rs#L2201)）叠加，杜绝半截文件进相册。

### P1-3 HSL 取样探针

- 画面取样直读色相/饱和度 [RL-cc]，移动端"点哪调哪"体验价值高于桌面。落点：TonePanel + 取样 IPC。

### P1-4 双 ABI（x86_64）

- RawLab 双 ABI [RL-rel]；anwuRAW 仅 arm64-v8a [AW-rel]。x86_64 覆盖模拟器与 Chromebook，CI 增加一个 target 即可，优先级随需求。

### P2-1 RAW 显影顺序审计（WB 前置 / 不全局 clamp / fatal 语义）

- 对照 [RL-cc] 的 LibRaw 补丁纪律审计 rawler 路径 [CR:raw_processing.rs]；"打开即所见"联动 preview 曝光基准（128² 中值匹配内嵌预览）[RL-cc][RL-ej]。

### P2-2 诊断日志闭环

- opt-in 会话录制 + 前缀路径脱敏 + ZIP 导出（+ 可选云上传）[RL-rel]；anwuRAW 现有 GPU 降级诊断可升级为端到端会话诊断，配合"Android 真机回归 8 项"收集现场证据。

### P2-3 检视套件（InspectionSuite 概念）

- 检查 HUD/覆盖层统一模块化 [RL-rel]，收敛 anwuRAW 分散的剪裁警告/辅助线/对比入口，顺带解决滤镜画廊入口分散（[盘点§4.3](file:///workspace/v2.1.23-七大功能域盘点报告.md)）。

### P2-4 来源身份缓存 + schema 版本化拒绝

- PinnedSourceFile/file stamp [RL-rel]；sidecar `schema_version` + 旧版拒绝降级（见桌面版对比报告 P0-2，Android 与桌面同源收益）。

### 实施顺序建议

1. **W5-1（GPU 接通）先行**——既是本清单 P0-1，也是既有移动规划的全局最高优先前置 [CR:mobile-plan §0]；P0-2 金字塔依赖 GPU 路径，随后跟进。
2. P0-3 PTP/IP 独立成线（纯新增模块，零渲染耦合），可与 W5 并行；P0-4 HDR 体系体量最大，按 RawLab 式周拆分交付。
3. P1/P2 挂既有里程碑后，不单独开线；全部新增参数走"五层同步 + 未知枚举回退默认"红线 [CR:mobile-plan §2.3]。

---

## 六、反向视角与许可

**anwuRAW Android 应守住的相对优势（RawLab Android 全部没有）**：AI 蒙版四类 + 文本提示词、人脸 9 区精修 + 液化、NIND 神经降噪 + BM3D 兜底、CLIP 场景推荐、参考图追色、LUT 四面体 + scene/display 双域、水印/EXIF 栏导出域、15 语 i18n、系统相册 MediaStore 落盘、AI-Free 模式。这些是移动端修图的高频刚需，RawLab v0.13.0 Android 未覆盖——反向说明 anwuRAW 的"AI 广度"路线在 Android 端是差异化壁垒，任何 GPU 架构调整（W5）不得破坏 AI 链路（ai_jobs 队列、驻留淘汰、三镜像下载）。

**许可与风险**：
1. 双方 GPL-3.0-only——PTP/IP 协议实现、金字塔/ROI、HDR 编码等可参考 RawLab 公开文档与 GPL 源码（保留版权声明）；其 **DualDn/Restormer 模型包单独许可且无 Android 形态，不可搬用**（anwuRAW 也不需要——NIND 路线已在 Android CPU EP 跑通）。
2. RawLab Android 侧细节部分来自官方文档表述（P0 源），未取源码逐行验证；引入前请以 `v0.13.0` tag 源码复核（其小波降噪尺度分离细节官方未深入披露，已标 `[文档未披露]`）。
3. anwuRAW 侧"v2.1.24 无渲染语义变更"以 release notes 为准 [AW-rel]；若 v2.1.24 之后有新 tag，算法基线需复评。
4. 数据时效：2026-11-27；双方任一发布新 release 后本清单需刷新。

---

## 附：anwuRAW Android 端关键证据索引

| 主题 | 位置 |
| --- | --- |
| Android 默认 CPU 兜底 | [app_settings.rs L766-784](file:///workspace/src-tauri/src/app_settings.rs#L766-L784)（引自 mobile-plan §2.1） |
| Android 初始化/content:// /LUT 缓存 | [android_integration.rs L33-213](file:///workspace/src-tauri/src/android_integration.rs#L33-L213) |
| 移动壳（编辑域/导出域/50 步撤销） | [CrystalMobileApp.tsx L194-198](file:///workspace/src/components/mobile/CrystalMobileApp.tsx#L194-L198) |
| 七面板功能面 + 19 缺陷修复 | [v2.1.13-android-crystal-audit.md](file:///workspace/v2.1.13-android-crystal-audit.md) |
| 移动端 W1-W6 规划（GPU 接通/60fps） | [crystal-mobile-improvement-plan.md W5](file:///workspace/crystal-mobile-improvement-plan.md#L327-L343) |
| 联机仅 macOS/Linux（gphoto2） | [Cargo.toml L95-99](file:///workspace/src-tauri/Cargo.toml#L95-L99) |
| AI 推理栈（ort CPU EP） | [Cargo.toml L44](file:///workspace/src-tauri/Cargo.toml#L44) |
| HDR 括拍合并 | [hdr_deghosting.rs L17-22](file:///workspace/src-tauri/src/hdr_deghosting.rs#L17-L22) |
| 导出日志/MediaStore | [export_processing.rs L2201](file:///workspace/src-tauri/src/export_processing.rs#L2201)、[审计§三](file:///workspace/v2.1.13-android-crystal-audit.md) |
| 七大功能域完成度 | [v2.1.23-七大功能域盘点报告.md](file:///workspace/v2.1.23-七大功能域盘点报告.md) |
