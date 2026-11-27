# RawLab v0.13.0 与透影 Crystal · 功能 / 图像算法 / 渲染算法差异化对比与借鉴方案

- 对比对象：[RawLab v0.13.0](https://github.com/dancancer/RawLab/releases/tag/v0.13.0)（build 25，源码 tag `v0.13.0` / commit `e82a3c9cf`，GPL-3.0-only）
- 本地基线：透影 Crystal（RapidRAW 底座，HEAD = tag `v2.1.23`，Tauri 2 + Rust + React TS + wgpu）
- 资料截止：2026-11-27。RawLab 侧以官方文档为源（P0：发行说明、色彩契约、HDR 设计、Edit JSON、路线图、CHANGELOG）；Crystal 侧以代码取证 + [v2.1.23-七大功能域盘点报告](file:///workspace/v2.1.23-七大功能域盘点报告.md)（2026-11-16 复评）为源。
- 来源编号：`[RL-rel]`=[v0.13.0 发行说明](https://github.com/dancancer/RawLab/blob/development/docs/releases/v0.13/v0.13.0.md)｜`[RL-cc]`=[color-contract](https://github.com/dancancer/RawLab/blob/development/lutools/docs/color-contract.md)｜`[RL-ej]`=[edit-json](https://github.com/dancancer/RawLab/blob/development/lutools/docs/edit-json.md)｜`[RL-hdr]`=[HDR 设计](https://github.com/dancancer/RawLab/blob/development/docs/design/hdr-photos/camera-raw.md)｜`[RL-x3f]`=[X3F 渲染](https://github.com/dancancer/RawLab/blob/development/lutools/docs/x3f-rendering.md)｜`[RL-rm]`=[路线图](https://github.com/dancancer/RawLab/blob/development/docs/architecture/roadmap.md)｜`[RL-cl]`=[CHANGELOG](https://github.com/dancancer/RawLab/blob/development/CHANGELOG.md)｜`[RL-fs]`=[RAW 格式支持](https://github.com/dancancer/RawLab/blob/development/docs/reference/raw-format-support.md)｜`[RL-home]`=[README](https://github.com/dancancer/RawLab)｜`[CR]`=Crystal 代码/文档（file:/// 链接）

---

## 0. 结论先行

**一句话定性**：RawLab 是「**单一 C++17 核心换四端一致性**」的 RAW 显影器——长板在 RAW 显影科学（LibRaw 补丁管线 + 三曝光基准 + PCHIP 曲线）、HDR 显影体系（HDR/SDR 双编辑 + 增益图导出）、渲染一致性工程（四 GPU 后端对拍容差 + C ABI 布局夹具 + spec 字段登记表）与相机无线工作流（Sony Wi-Fi 导入 + SSH 隧道 + 联机拍摄）；透影 Crystal 是「**wgpu 全 GPU 管线换功能广度**」的 AI 修图器——长板在 AI 工具链（蒙版 ×6 + 人脸 9 区 + 消除/液化/超分/选片/标签）、特效体系（mip bloom/眩光/景深虚化/重光）、LUT 引擎（四面体 + scene/display 双域）与 HDR 括拍合并（对齐 + 去鬼影），且多出 Linux 平台与 15 语 i18n。

**取长补短总原则**：双方均为 GPL-3.0，代码级互借在许可上双向合法（RawLab 的 DualDn/Restormer AI 模型包除外——单独许可，只能借鉴部署形态不能搬模型）。两边几乎无正面冲突：RawLab 的长板集中在"底层科学与工程纪律"（正是 Crystal 图像管线改进计划里自述的短板区），Crystal 的长板集中在"功能广度与 AI"（RawLab 仅有一种 AI 能力且需付费模型包）。最值得借鉴的是四件事：①HDR 增益图显影体系、②渲染一致性对拍工程、③RAW 显影的版本化与拒绝降级机制、④原子输出与来源身份缓存等可靠性设计。

---

## 一、总体定位与技术架构对比

| 维度 | RawLab v0.13.0 | 透影 Crystal v2.1.23 | 差异判定 |
| --- | --- | --- | --- |
| 形态定位 | RAW 显影 + 胶片调色 + 无线相机工作流 | AI 修图 + 调色 + 特效 + 移动端优先 | 定位不同，功能交集在"调色编辑器" |
| 核心架构 | 单一 C++17 核心（lutools）+ C ABI，四客户端 + CLI/MCP/Agent 共用一核 [RL-rm][RL-cc] | Tauri 2 + Rust 主进程 + React TS 前端，wgpu 渲染 | 两者都是"单核多端"，RawLab 靠 C ABI 隔离、Crystal 靠 Tauri IPC |
| GPU 路线 | Metal / D3D11 / OpenGL ES 三后端 + Auto CPU 一致性回退、Force 须真实 GPU 成功 [RL-rm][RL-cc] | wgpu（WebGPU/Vulkan/Metal/DX12）+ CPU 预览回退路径 | Crystal 的 Linux/Android 展示层未接 WebGPU，实际回退 CPU [CR-盘点§D] |
| RAW 解码 | LibRaw 0.22.2（统一打补丁）[RL-cc][RL-fs] | `rawler`（纯 Rust）+ macOS Apple CIRAW 双路 [CR:raw_processing.rs](file:///workspace/src-tauri/src/raw_processing.rs#L292)、[apple_raw.rs](file:///workspace/src-tauri/src/apple_raw.rs) | 解码库不同 → 格式覆盖与显影默认观感均不同，见 §3.1 |
| 平台矩阵 | macOS（Silicon+Intel）/ Windows x64 / Android / iOS 四端，无 Linux [RL-home] | Windows x64/arm64、macOS arm64/intel、Ubuntu 22.04/24.04 x64/arm64、Android arm64 共 13 产物，无 iOS [CR-盘点§9] | Crystal 多 Linux + 联机拍摄构建；RawLab 多 iOS |
| AI 运行时 | 仅 AI 降噪：Apple Silicon Core ML / Windows DirectML+D3D12，无 CPU 神经回退，需单独许可的 DualDn/Restormer 模型包 [RL-rel] | ort 单栈 9+ 模型（SAM/BiRefNet/ESAM3/DepthAnything V2/MediaPipe/CLIP/NIND…），AI-Free 模式兜底 [CR-盘点§7] | Crystal AI 广度代差级领先；RawLab AI 深度部署（原生 ML 栈）领先 |
| 生态接口 | CLI（lutools）、桌面 Agent 配方、MCP server、Edit JSON 公开契约、RGBA16 诊断 C API [RL-rel][RL-ej] | 无 CLI/MCP；Tauri 命令 160 条全注册 | RawLab 自动化/脚本生态领先 |
| 许可 | GPL-3.0-only + 阿里云 RUM 链接例外；AI 模型包单独许可 [RL-home][RL-rel] | GPL-3.0（LICENSE） | 双向代码互借合法 |
| 无线相机 | Sony Wi-Fi 导入 + 联机拍摄（实时取景/手机快门/点按对焦，Android 正式/iOS 预览）+ SSH Access Auth 隧道 + α7M5 双卡槽 [RL-rel][RL-cl] | 桌面联机拍摄构建（camera_tethering.rs），移动端无线导入无 | RawLab 移动端相机工作流领先 |

---

## 二、功能差异化对比清单

图例：✅ 完整 —— ⚠️ 有但受限/降级 —— ❌ 无 —— 🔜 规划中

### 2.1 RAW 显影与输入支持

| 功能 | RawLab v0.13.0 | Crystal v2.1.23 | 判定 |
| --- | --- | --- | --- |
| RAW 格式覆盖 | LibRaw 全系：Sony/Fujifilm/Canon/Nikon/Panasonic/Pentax + Sigma X3F [RL-home][RL-fs] | rawler 覆盖主流厂商 + Apple CIRAW（ProRAW/DNG 原生解码）[CR:raw_processing.rs](file:///workspace/src-tauri/src/raw_processing.rs#L292)、[apple_raw.rs](file:///workspace/src-tauri/src/apple_raw.rs#L32) | 各有覆盖面优势：X3F 归 RawLab，Apple 原生解码归 Crystal |
| Sigma X3F | ✅ x3fuse-core Rust 桥（display-referred，Rayon 并行）[RL-x3f] | ❌ | RawLab 独有 |
| Apple ProRAW | ✅（HDR 单独流程）[RL-hdr] | ✅ 经 CIRAW 解码 | 平手，RawLab 深度更高 |
| 手机增益图 HDR JPEG/HEIF | ✅ 导入编辑 [RL-home] | ❌（HDR 输入仅 exr/hdr/jxl 容器）[CR:formats.rs](file:///workspace/src-tauri/src/formats.rs#L74-L75) | RawLab 独有 |
| 括拍 HDR 合并 | ❌ | ✅ 曝光帧对齐 + 去鬼影 + 合并 [CR:hdr_deghosting.rs](file:///workspace/src-tauri/src/hdr_deghosting.rs#L17-L22) | Crystal 独有 |
| 机内多次曝光识别 | ❌ | ✅ Canon CR2 maker-note 解析 [CR:multi_exposure.rs](file:///workspace/src-tauri/src/multi_exposure.rs#L1-L25) | Crystal 独有 |
| 128 MP+ 大图 | ✅ [RL-home] | ⚠️ 8192 上限自动降档（超分导出）[CR-盘点§7.6] | RawLab 更宽容 |

### 2.2 基础影调与色彩调整

| 功能 | RawLab | Crystal | 判定 |
| --- | --- | --- | --- |
| 曝光基准 | ✅ scene/preview/sensor 三基准（scene=+0.7EV+DNG BaselineExposure；preview=128² 中值匹配内嵌预览）[RL-cc][RL-ej] | ❌ 单一基准 | **RawLab 独有**，换机一致性关键 |
| 曝光范围 | ±5 EV（processing v3）[RL-cl] | 未披露上限 | — |
| 白平衡 | ✅ 相机白平衡/auto/色温 2000–50000K + tint ±150 [RL-cc] | ✅ as-shot 推导 + 吸管 + 曝光基线补偿 [CR-盘点§5.3] | Crystal 吸管交互更顺；RawLab 色温范围大 |
| 高光/阴影 | ✅ 引导滤波局部控光（processing v3 局部光照）[RL-rm][RL-cl] | ✅ 双分区 + WGSL 软压缩细节增益 [CR-盘点§5.1] | 同为"局部化高光阴影"，实现路线同构 |
| 黑白场/鲜艳度 | ✅ [RL-cc] | ✅ whites/blacks/vibrance | 平手 |
| HSL | ✅ 8 色域 + 画面取样探针 [RL-cc] | ✅ 8 通道混色器（取样探针未见） | RawLab 取样探针值得补 |
| 3-Way 分级 | ✅ 三区 + 全局色轮 + 融合度/平衡 [RL-cc] | ✅ 三区 + 全局 + balance/blending，前端与 WGSL 一一对应 [CR-盘点§5.5] | 平手 |
| 色彩校准 | ❌ 未披露 | ✅ colorCalibration 原色微调 [CR-盘点§5.6] | Crystal 独有 |
| 色调映射器 | ❌ 未提供用户可选映射器（HDR 内部用 sigmoid + 色度压缩）[RL-hdr] | ✅ basic/AgX/PBR Neutral/ACES 四种一键切换 [CR-盘点§5.2] | **Crystal 独有** |
| 曲线 | ✅ 主曲线 + R/G/B；PCHIP 单调样条；4 段参数曲线（3 个可调分割点）；v0.13 自由端点 X + 仅明度模式 [RL-cl][RL-rel] | ✅ luma/R/G/B 四曲线 ×16 控制点，三次 Hermite 插值 [CR:shader.wgsl](file:///workspace/src-tauri/src/shaders/shader.wgsl#L406-L424)；参数化曲线双模式 [CR-盘点§5.7] | 互有长短，算法差异见 §3.3 |
| 负片翻拍 | ❌ | ✅ RGB 权重可调 [CR-盘点§5.9] | Crystal 独有 |
| 去雾 | ✅ 双向（提/减）[RL-cc] | ✅ Details 分区双向 | 平手（airlight 差异见 §3.6） |
| 清晰度 | ✅ 双向 [RL-cc] | ✅ clarity/structure | 平手 |
| 降噪 | ✅ 线性小波降噪（亮度/色度/粗尺度色度分离控件）[RL-home] | ✅ BM3D 经典（CPU）+ WGSL 空域降噪 + NIND 神经 [CR-盘点§7.3] | 两条不同技术路线，见 §3.5 |
| AI 降噪 | ✅ DualDn/Restormer（Core ML/DirectML），Bayer 域执行 + FBDD 互斥 [RL-rel][RL-cl] | ✅ NIND UTNet（真实噪声数据）+ tile + 低频恢复 | RawLab 走"RAW 域+原生 ML"，Crystal 走"RGB 域+ort"，互不可直接搬 |
| 颗粒 | ✅ 确定性 grain [RL-cc] | ✅ 量/尺寸/粗糙度，频率随 scale 归一 [CR-盘点§8.8] | 平手 |
| 镜头校正 | ✅ Lensfun 离线库：畸变/TCA/自动边缘裁剪（profile 暗角未实现）[RL-cc] | ✅ Lensfun + 9 参数手动 [CR-盘点§6.7] | Crystal 手动兜底更全 |
| 几何 | ✅ 旋转/翻转/拉直 ±45°/裁剪/水平垂直 keystone [RL-cc] | ✅ + 透视 7 参数 + 引导透视（消失点求解）[CR-盘点§6.4-6.5] | Crystal 几何更全 |
| 高光重建 | ❌ 未披露独立模块 | ✅ highlight_reconstruction 启发式 [CR-盘点§8.10] | Crystal 独有（双方都承认极端过曝有限） |

### 2.3 LUT · 胶片 · 预设

| 功能 | RawLab | Crystal | 判定 |
| --- | --- | --- | --- |
| 内置胶片 Look | ✅ 54 套外观 + 大师配方（Master Recipe v4）[RL-rm][RL-cl] | ✅ 26 胶片 LUT + 14 大师配方（33³ LUT）[CR-盘点§2.5-2.6] | RawLab 数量更多且 Recipe 体系版本化 |
| 强度缩放 | ✅ 0–200% 平滑缩放 [RL-home] | ✅ 0–200% 强度重缩放 [CR-盘点§2.1] | 平手 |
| LUT 导入 | ✅ CUBE / RLOOK [RL-cc] | ✅ CUBE / 3dl / HALD [CR-盘点§2.7] | Crystal 格式更广 |
| LUT 插值与域识别 | 未披露插值方式 | ✅ 四面体插值 + Rgba32Float + scene/display 双域自动识别 [CR:shader.wgsl](file:///workspace/src-tauri/src/shaders/shader.wgsl#L2148-L2200)、[盘点§4.1] | Crystal 明显更工程化 |
| HDR Look | ✅ HDR CUBE look、HDR Silver [RL-cl] | ❌ | RawLab 独有 |
| 预设迁移 | ✅ rawlab-transfer-v1.json 调整转移 [RL-cl] | ✅ Adobe XMP → 预设（常用字段）[CR:preset_converter.rs](file:///workspace/src-tauri/src/preset_converter.rs#L94-L223) | Crystal 兼容 Adobe 生态更实用 |
| 社区预设 | ❌ | ✅ GitHub 清单 + GPU 批量预览墙（依赖在线）[CR-盘点§2.8] | Crystal 独有 |

### 2.4 效果与蒙版 / AI 工具

| 功能 | RawLab | Crystal | 判定 |
| --- | --- | --- | --- |
| AI 蒙版 | ❌ | ✅ 6 类（SAM/BiRefNet/ESAM3/DepthAnything/MediaPipe）+ sky 程序化兜底 [CR-盘点§7.1] | **Crystal 代差领先** |
| 人脸分区精修 | ❌ | ✅ 9 区蒙版 + 6 一键算子（磨皮/美白/亮眼/瘦脸/下颌线/统一肤色）[CR:face_masking.rs](file:///workspace/src-tauri/src/face_masking.rs#L92-L147)、[MasksPanel.tsx](file:///workspace/src/components/panel/right/MasksPanel.tsx#L1923-L2037) | Crystal 独有 |
| 生成式消除/填充 | ❌ | ✅ 本地 LaMa + ComfyUI 连接器 + 云 [CR-盘点§7.4] | Crystal 独有 |
| 液化/美型 | ❌ | ✅ [CR:inpainting.rs](file:///workspace/src-tauri/src/inpainting.rs#L748-L851) | Crystal 独有 |
| AI 超分 | ❌ | ✅ 2×/4×（Lanczos3 + 内存预算守护）[CR-盘点§7.6] | Crystal 独有（但非神经超分） |
| AI 选片/标签 | ❌ | ✅ culling.rs / CLIP tagging.rs | Crystal 独有 |
| 深度/法线图 | ❌ | ✅ Depth Anything V2 + MoGe-2 [CR-盘点§7.10] | Crystal 独有 |
| 辉光/晕影/眩光 | ❌ | ✅ 5 级 mip bloom + halation + 6 针星芒 flare [CR-盘点§8.1-8.3] | Crystal 独有 |
| 景深虚化/重光/雾效 | ❌ | ✅ 4 种 Bokeh + 法线 relight + 8 参数雾 | Crystal 独有 |
| 蒙版局部化特效 | ❌（蒙版体系未披露） | ✅ glow/halation/flare 均可挂蒙版 | Crystal 独有 |
| 软打样 | ❌ | ✅ 4 色域 + 4 渲染意图（WebGPU 平台）[CR:softProofing.ts](file:///workspace/src/utils/softProofing.ts#L48) | Crystal 独有 |
| 参考图追色 | ❌ | ✅ Lab 均值匹配 + 分位数曲线 + ΔE 指标 [CR:color_transfer.rs](file:///workspace/src-tauri/src/color_transfer.rs#L408-L574) | Crystal 独有 |
| 检视辅助（放大镜/覆盖层） | ✅ InspectionSuite 检查套件 + inspection HUD/覆盖层（v0.13 下沉核心）[RL-rel] | ✅ 剪裁警告/dither [CR:shader.wgsl 管线尾段] | RawLab 检视体系更系统化 |

### 2.5 HDR 体系（RawLab 最大的长板区）

| 功能 | RawLab | Crystal | 判定 |
| --- | --- | --- | --- |
| 增益图 HDR 编辑 | ✅ gain-map HDR JPEG/HEIF 编辑，HDR/SDR **双份独立编辑** [RL-home][RL-hdr] | ❌ | **RawLab 独有** |
| RAW HDR 显影 | ✅ 受支持相机 RAW 一次线性显影出 HDR 主图 + SDR 底图（sigmoid + 色度压缩至 [0,1]）[RL-hdr] | ⚠️ HDR 合并出 32F 帧，无 HDR 显影呈现体系 [CR:hdr_deghosting.rs](file:///workspace/src-tauri/src/hdr_deghosting.rs#L17-L22) | RawLab 体系化领先 |
| 参考白定义 | ✅ 场景值 0.25×2^(2+BaselineExposure)，0.1845 中灰 [RL-hdr] | ❌ | RawLab 色彩科学独有 |
| HDR 导出 | ✅ 增益图 JPEG / SDR 显式 / HDR HEIF（Apple 端）[RL-home] | ❌ | RawLab 独有 |
| HDR→SDR 编码 | ✅ v0.13 核心统一 RGBA8/BGRA8 编码 + ProRAW/display preview ABI [RL-rel] | ❌ | RawLab 独有 |
| HDR 显示 | ⚠️ macOS 15+ HDR 编辑 [RL-home] | 🔜 P1-9 计划（PQ/HLG + rgba16float surface 探测）[CR:image-pipeline-improvement-plan.md](file:///workspace/image-pipeline-improvement-plan.md#L141) | 双方都未完全交付，Crystal 有明确规划 |

### 2.6 工作流 · 导出 · 生态

| 功能 | RawLab | Crystal | 判定 |
| --- | --- | --- | --- |
| 无线导入/联机 | ✅ Sony Wi-Fi 增量导入（断点续传、防重复）+ 联机（实时取景/点按对焦/焦点区域）+ SSH 隧道 + 双卡槽 [RL-rel][RL-cl] | ⚠️ 桌面 tethering 构建；移动端无 | RawLab 移动端相机工作流领先 |
| 集合/批量导出 | ✅ 集合、可恢复批量导出（冻结设置/取消/重试）[RL-home] | ✅ 批量导出 + G5 可恢复导出日志（每任务一个原子 JSON）[CR:export_processing.rs](file:///workspace/src-tauri/src/export_processing.rs#L2201) | 平手，机制各有侧重 |
| 预览标记 | ✅ 铅笔标记 + 已编辑缩略图 + 1:1 视口 ROI 渐进缩放 [RL-cl] | ⚠️ 缩略图应用调整预览；ROI 渐进缩放未见 | RawLab 移动端交互领先 |
| 导出格式 | ✅ JPEG(1–100)/16-bit PNG/**渲染 DNG**/16-bit TIFF；sRGB APP2 ICC 嵌入；8-bit 抖动；缩放后输出锐化 [RL-ej][RL-cl] | ✅ JPEG/PNG/8·16-bit TIFF（宽色域 ICC 嵌入）[CR:export_processing.rs](file:///workspace/src-tauri/src/export_processing.rs#L1592-L1861)；❌ DNG | Crystal 宽色域 ICC 领先，DNG 是缺口 |
| 导出可靠性 | ✅ AtomicOutputTransaction 临时文件 + 完成才替换 [RL-rel] | ⚠️ 有可恢复日志；成品文件"临时+原子替换"未证实 | 见 §5.1-P2 |
| CLI/MCP/Agent | ✅ 同核 CLI、MCP server、Agent 配方、Edit JSON 契约 [RL-ej] | ❌ | RawLab 独有 |
| 诊断 | ✅ opt-in 诊断会话（路径脱敏 + ZIP + 阿里云 SLS）[RL-rel] | ✅ GPU 能力诊断（本地化 15 语）[CR-盘点§11⑤] | 互补 |
| 界面语言 | 6 语 [RL-home] | 15 语 [CR-盘点§9] | Crystal 领先 |
| 自动更新 | ✅ Sparkle EdDSA / P-256 签名清单 [RL-rel] | ✅ updater + 签名审计门禁 [CR-盘点§9] | 平手 |

---

## 三、图像算法差异化对比清单

> RawLab 侧为官方文档表述（P0 源）；Crystal 侧为代码取证。判定列给出"谁更优 + 可借鉴点"。

### 3.1 RAW 解码与显影管线

| 环节 | RawLab（LibRaw 0.22.2 打补丁）[RL-cc] | Crystal（rawler）[CR:raw_processing.rs](file:///workspace/src-tauri/src/raw_processing.rs) | 判定与借鉴 |
| --- | --- | --- | --- |
| 管线顺序 | 黑场减除 → 活动区裁剪 → **WB 先于 demosaic** → 高光色度混合（highlight=2）→ float 相机域 → sRGB 矩阵，**全程不全局 clamp** | rawler 默认流程 + CPU 线性输出 + 高光重建接线 [CR-盘点§2.1] | RawLab 的顺序纪律值得对照审计：WB 前置 + 不 clamp 是"显影观感跨版本稳定"的关键 |
| 高光处理 | 高光色度混合（非对立色重建，明确"不能恢复已丢失细节"）[RL-cc] | 启发式 highlight_reconstruction [CR-盘点§8.10] | RawLab 对能力边界的表述更诚实；Crystal 可吸收"色度混合"思路降低紫边/偏色 |
| 解码失败语义 | 解包错误一律 fatal [RL-cc] | 解码失败回退/提示 | 严格 fatal 防止静默坏图，可借鉴 |
| Apple 解码 | ProRAW 走自家 HDR 流程 | CIRAW 原生（含 RAW9 版本优选）[CR:apple_raw.rs](file:///workspace/src-tauri/src/apple_raw.rs#L56-L78) | Crystal 在 macOS 上的 Apple 原生解码是优势，保留 |

### 3.2 曝光与影调基准

| 项 | RawLab | Crystal | 判定与借鉴 |
| --- | --- | --- | --- |
| 曝光基准 | scene（+0.7EV + DNG BaselineExposure 一次）/ preview（128² 中值匹配内嵌预览）/ sensor（无基准）三选 [RL-cc][RL-ej] | 单基准 | **P0 级借鉴**：preview 基准可让"打开即所见"与机内 JPEG 观感对齐，scene 基准是 HDR 前置；对 Crystal 的"负片翻拍/追色"链路同样有用 |
| 曝光语义 | EV + 亮度倍率双表达，scene 基准下 ±5EV [RL-cl] | EV 滑杆 | 平手 |

### 3.3 曲线

| 项 | RawLab | Crystal | 判定与借鉴 |
| --- | --- | --- | --- |
| 插值算法 | **PCHIP 单调样条**（保证无过冲）[RL-cl] | 三次 Hermite（[shader.wgsl L406](file:///workspace/src-tauri/src/shaders/shader.wgsl#L406)） | RawLab 更稳：Hermite 切线未钳制时激进控制点会产生过冲/振铃；PCHIP 是工业标准解 |
| 端点控制 | v0.12 开放端点 Y；**v0.13 自由端点 X**（端点外输入平坦 clamp 到端点 Y）[RL-cl][RL-rel] | 端点固定 0/1 | **P0 级借鉴**：端点 Y 抬灰/压高光 + 端点 X 内移（黑场/白场曲线化）是 Lightroom 同款能力，Crystal 曲线系统缺这一层 |
| 通道模型 | 主曲线 + R/G/B + "仅明度"模式 [RL-cl] | luma + R/G/B 四曲线 | 平手（Crystal 的独立 luma 曲线是好设计） |
| 参数化曲线 | 4 段、3 个可调分割点 [RL-cl] | 双模式参数化（分割点可调性需核对） | RawLab 分割点自由度更高 |

### 3.4 降噪

| 项 | RawLab | Crystal | 判定与借鉴 |
| --- | --- | --- | --- |
| 传统降噪 | 线性小波降噪（亮度/色度/粗尺度色度三控件；尺度分离细节官方文档未深入披露）[RL-home][RL-ej] | WGSL 空域降噪（sigma 线性映射）+ BM3D CPU [CR-盘点§7.3]、[shader.wgsl L1245-L1365] | 小波"粗尺度色度分离"能把色斑与纹理分开控制，是 Crystal 空域降噪缺的维度——可借概念 |
| 噪声模型 | AI 在 Bayer 马赛克域执行、与 FBDD 互斥、近饱和值回退普通显影 [RL-cl] | ISO 联动 sigma 噪声模型（WGSL + EXIF 自动填充）[CR-盘点§5.10] | Crystal 的 ISO 驱动是优势；RawLab 的"Bayer 域推理 + 近饱和回退"是差异化思路 |
| AI 降噪部署 | Core ML（Apple Silicon）/ DirectML+D3D12；无 CPU 回退；0–100% 混合复用缓存线性残差、**零再推理** [RL-rel][RL-cl] | ort NIND（RGB 域）+ tile + 低频恢复 [CR-盘点§7.3] | "混合系数调滑杆不重跑模型"的缓存残差设计值得 Crystal 吸收（当前强度变化是否重推理需核对） |
| 模型许可 | DualDn/Restormer 模型包单独许可，缺失则功能不可用 [RL-rel] | NIND 开源数据底子 | Crystal 自主可控更稳 |

### 3.5 去雾与局部对比

| 项 | RawLab | Crystal | 判定与借鉴 |
| --- | --- | --- | --- |
| 去雾 | 双向去雾；GPU 化在路线图阶段二（v0.13 仍 CPU 参考实现）[RL-rm][RL-cl] | WGSL 局部 airlight 已规划（P0-4：1/16 降采样块统计 + 引导滤波细化；负向保留全局防色斑）[CR:image-pipeline-improvement-plan.md](file:///workspace/image-pipeline-improvement-plan.md#L104-L112) | Crystal 规划更细；RawLab 未披露 airlight 求解细节，无可抄内容 |
| 清晰度/局部对比 | 引导滤波族，双向 [RL-cc] | clarity/structure 线性增益，P0-2 计划软膝限幅 + 边缘保持 [CR:image-pipeline-improvement-plan.md](file:///workspace/image-pipeline-improvement-plan.md#L84-L89) | Crystal 的自纠偏方向正确；RawLab 未披露增益曲线细节 |

### 3.6 色调映射与 HDR 处理

| 项 | RawLab | Crystal | 判定与借鉴 |
| --- | --- | --- | --- |
| 映射器选择 | 未提供用户切换（HDR 内部 sigmoid + 色度压缩）[RL-hdr] | basic/AgX/PBR Neutral/ACES 四选 [CR-盘点§5.2] | **Crystal 独有优势**，保留 |
| HDR 显影 | 一次线性显影出 HDR 主图 + SDR 底图；参考白 = 0.25×2^(2+BaselineExposure)、0.1845 中灰；HDR/SDR 双编辑互不覆盖 [RL-hdr] | 括拍合并（对齐 + 去鬼影 + 融合）后无 HDR 呈现体系 | **P0 级借鉴**：RawLab 的"单次显影双底图 + 参考白科学定义"是 gain-map HDR 的正确底座，可嫁接 Crystal 现有 HDR 合并输出 |
| HDR Look/限幅 | HDR CUBE look、HDR Silver、HDR peak limit、SDR 底图独立控件 [RL-home] | ❌ | 同上，随 HDR 体系一起补 |

### 3.7 颗粒 · 镜头 · 几何

| 项 | RawLab | Crystal | 判定与借鉴 |
| --- | --- | --- | --- |
| 颗粒 | 确定性 grain（参数相同输出逐位一致）[RL-cc] | grain_frequency 随 scale 归一；P1-13 计划胶片标定多尺度 grain [CR:image-pipeline-improvement-plan.md](file:///workspace/image-pipeline-improvement-plan.md#L145) | Crystal 规划更深；"确定性"要求双方都有，纳入 golden 断言即可 |
| 镜头校正 | Lensfun 畸变/TCA/自动边缘裁剪，**profile 暗角未实现** [RL-cc] | Lensfun + 9 参数手动 + 暗角校正开关 [CR-盘点§6.7] | Crystal 更全 |
| 几何 | keystone 单方向 | 7 参数 + 引导透视消失点求解 [CR:guided_perspective.rs](file:///workspace/src-tauri/src/guided_perspective.rs#L373-L427) | Crystal 领先 |

---

## 四、渲染算法与管线差异化对比清单

### 4.1 架构与后端

| 维度 | RawLab | Crystal | 判定与借鉴 |
| --- | --- | --- | --- |
| 后端 | Metal / D3D11 / GLES 三原生后端 + **Auto CPU 一致性回退**（回退路径与 GPU 逐位对齐目标）/ Force 校验 [RL-rm][RL-cc] | wgpu 单抽象（Vulkan/Metal/DX12/GL）+ CPU 预览回退 [CR-盘点§D] | RawLab 的"CPU 回退也要一致"纪律更强；Crystal 的 wgpu 抽象省代码但 Linux/Android 展示层未接入，实际退化 CPU |
| 管线归属 | 全部算子在 C++ 核心，四端唯一真源；v0.13 抽出 ViewportRenderEngine + fast GPU/pyramid C ABI [RL-rel] | 主 compute pass 单 WGSL + 预处理 shader（blur/guided/flare/display）[CR-盘点§2.1] | 两种风格都成立；Crystal 若开 CLI/MCP（见 §5.1-P2）需要先把管线从 Tauri 进程解耦 |
| 金字塔 | ✅ fast GPU/pyramid C ABI（v0.13 提取）[RL-rel] | ⚠️ 5 级 mip 链仅用于 bloom；**无全图金字塔缩放/渐进渲染** | **P1 级借鉴**：RawLab 的视口金字塔是移动端 1:1 缩放流畅的底座（配合 ROI 渐进缩放）[RL-cl] |
| 分块 | 未披露分块策略 | TILE_SIZE=2048 / OVERLAP=128，absolute_coord 全图采样无缝 [CR-盘点§2.1] | Crystal 已解决分块正确性，保留 |

### 4.2 算子顺序与精度

| 维度 | RawLab | Crystal | 判定与借鉴 |
| --- | --- | --- | --- |
| 算子顺序 | 色彩契约统一（曲线/分级/LUT 顺序在契约中固化）[RL-cc] | 线性化→CA→降噪→锐化→去雾→曝光→光效→WB→tonal→分级→暗角→色调映射→scene LUT→曲线→display LUT→颗粒→裁剪警告→dither [CR:shader.wgsl](file:///workspace/src-tauri/src/shaders/shader.wgsl#L201-L208) | 两者场景/显示双域思想一致；Crystal 把色调映射放 LUT 前、RawLab 顺序由契约文本锁定——Crystal 可把该顺序升级为"契约文档+对拍夹具"（见 4.4） |
| 预览精度 | HDR→SDR 统一 RGBA8/BGRA8 编码；公开 RGBA16 诊断 C API [RL-rel] | 预览 rgba8unorm / 导出可选 rgba16float（关 dither）[CR:gpu_processing.rs](file:///workspace/src-tauri/src/gpu_processing.rs#L2355-L2368) | 平手；Crystal 的 16bit 导出路径已具备 |
| dither | 8-bit 输出抖动防断层 [RL-ej] | 导出 dither（高精度路径关闭） | 平手 |

### 4.3 一致性验证体系（RawLab 最值得学的工程纪律）

| 维度 | RawLab | Crystal | 判定与借鉴 |
| --- | --- | --- | --- |
| 跨后端对拍 | ✅ 四后端渲染**对拍容差**（Auto/Force 两级 GPU 策略 + CPU 一致性回退）[RL-rm][RL-cc] | ⚠️ golden_render + consistency_determinism（124 参数）+ wgsl_validation + performance_gate [CR-盘点§9]，但无"多 GPU 后端互拍"维度 | **P0 级借鉴**：Crystal 加一组 Vulkan/Metal/DX12/GL 同参数对拍用例（wgpu 下成本远低于 C++ 四栈），把"后端差异"变成回归门禁 |
| 编辑状态 | ✅ CanonicalEditState 统一编辑状态 + v0.13 对齐 24 个 v0.13 spec 字段到四端 + 传输/重置场景向量 + 版本登记表 [RL-rel][RL-rm] | ⚠️ 124 参数 schema 一致性测试 + 编译期 45264 字节布局断言 [CR-盘点§5.11] | Crystal 有布局断言，缺"字段规格登记表 + 场景向量"这种**文本规格**层——成本低收益高 |
| schema 版本化 | ✅ SDR schema 18 / HDR schema 19 / pv10；**写入方选最低所需版本；旧版本按版本号拒绝而非误读**；新参数默认值零算术旁路 [RL-rel][RL-cc] | ⚠️ 有 XMP 迁移与 sidecar 兼容测试；版本化拒绝机制未证实 | **P0 级借鉴**：v0.13 自由端点 X 就靠 schema 18/19 兜底——Crystal 引入新参数（如曲线端点）时同参数必配"最低 schema 版本 + 拒绝降级" |
| 处理版本 | ✅ processing version 1/2/3（v3 重调基础控件 + 曝光 ±5EV），升级前校验、保存后禁降级 [RL-cl] | ⚠️ 无处理版本概念 | 同上 |
| 来源身份 | ✅ PinnedSourceFile + file stamp 缓存（source_sha256）[RL-rel] | ⚠️ edit_history 按路径区分 | **P2 级借鉴**：文件被外部替换后缓存/sidecar 的失效策略 |
| 导出原子性 | ✅ AtomicOutputTransaction（staged writes，失败报 output_io_error）[RL-rel] | ⚠️ 可恢复导出日志有；成品文件临时+替换未证实 [CR:export_processing.rs](file:///workspace/src-tauri/src/export_processing.rs#L2201) | **P2 级借鉴** |
| 布局契约 | ✅ C ABI 布局夹具 + 四后端容差表 [RL-rel] | ✅ 编译期字节布局断言（45264B） | Crystal 已有等价物，平手 |

### 4.4 预览与交互

| 维度 | RawLab | Crystal | 判定与借鉴 |
| --- | --- | --- | --- |
| 视口 | 1:1 原生视口 ROI 分块 + 渐进缩放（iOS/Android）[RL-cl] | 自适应画质 0.3–0.5 动态档 [CR-盘点§0.C] | RawLab 移动端大图交互领先；Crystal 可借 ROI tiling |
| 检视套件 | InspectionSuite 几何/覆盖层下沉核心 + HUD 不淡出 + 缓存环修复 [RL-rel] | 剪裁警告、构图辅助线 ×7 | 各有侧重 |
| 画布隔离 | ✅ 点曲线与参数曲线画布隔离（v0.13）[RL-rel] | 双模式曲线 UI | 交互细节，按需借鉴 |

---

## 五、取长补短清单

### 5.1 Crystal → 向 RawLab 借（按优先级）

**P0-1 HDR 增益图显影体系（最大功能缺口）**

- 借什么：一次线性显影出 HDR 主图 + SDR 底图（sigmoid + 色度压缩至 [0,1]）、参考白 = 场景值 `0.25×2^(2+BaselineExposure)`、0.1845 中灰、HDR/SDR 双份独立编辑、增益图 JPEG 导出与 Apple HDR HEIF [RL-hdr][RL-home]。
- 为什么：Crystal 已有括拍合并（[hdr_deghosting.rs](file:///workspace/src-tauri/src/hdr_deghosting.rs)）与 EXR/HDR 输入（[formats.rs](file:///workspace/src-tauri/src/formats.rs#L74-L75)），缺"显影后 HDR 呈现 + 增益图导出"这最后一公里；手机 HDR 照片编辑是移动端修图的现实需求。
- 落点：新增 `hdr_pipeline.rs`（参考白/中灰定义与 HDR/SDR 双底图生成）+ [display.wgsl](file:///workspace/src-tauri/src/shaders/display.wgsl)（HDR→SDR 编码）+ 导出端 gain-map JPEG 写入。
- 验收：同一 RAW 的 HDR 主图与 SDR 底图在互拍容差内稳定；增益图导出在 Android 相册中正确呈现。

**P0-2 schema 版本化与"拒绝降级"机制**

- 借什么：写入方选最低所需 schema 版本；旧版本按版本号**拒绝而非误读**；新参数默认值零算术旁路 [RL-rel][RL-cc]。
- 为什么：Crystal 计划引入曲线自由端点、HDR 参数等新编辑字段时，旧版 App 读新版 sidecar 的行为必须可预期。
- 落点：sidecar 读写层（edit_history/save 链路）加 `schema_version` + 每参数"引入版本"表；前端对不兼容文件给出明确提示而非静默错图。
- 验收：新版参数写入的 sidecar 在旧版打开时被拒并提示，不产生错误渲染。

**P0-3 渲染跨后端对拍门禁**

- 借什么：四后端渲染对拍容差 + Auto CPU 一致性回退 + Force 须真实 GPU 成功 [RL-rm][RL-cc]。
- 为什么：Crystal 现有 golden 只锁"同一后端"的回归；Linux/Android 走 CPU 回退路径，桌面走 GPU——两者观感一致性目前无证明。wgpu 下加多后端对拍成本远低于 RawLab 的 C++ 四栈。
- 落点：测试侧新增 `backend_crosscheck`（同一 RenderRequest 在 GL/Vulkan/DX12/Metal + CPU 路径各渲一次，SSIM/ΔE 容差断言）。
- 验收：CI 在可用后端上跑对拍；容差超标即失败。

**P0-4 曝光三基准（scene/preview/sensor）**

- 借什么：preview 基准（128² 亮度中值匹配内嵌预览）与 scene 基准（+0.7EV + DNG BaselineExposure）[RL-cc][RL-ej]。
- 为什么："打开即接近机内 JPEG 观感"是体验级差异；scene 基准同时是 P0-1 HDR 的前置。
- 落点：[raw_processing.rs](file:///workspace/src-tauri/src/raw_processing.rs) 显影参数层加 `exposure_base` 枚举；DNG BaselineExposure 从 rawler 元数据读取。
- 验收：同一 RAW 在 preview 基准下首帧观感与机内 JPEG ΔE 改善；老用户默认行为不变（默认基准向后兼容）。

**P0-5 曲线自由端点 + PCHIP 单调样条**

- 借什么：端点 Y 开放（抬灰/压高光）+ 端点 X 内移 + 端点外平坦 clamp + PCHIP 单调插值 [RL-cl][RL-rel]。
- 为什么：Crystal 曲线为三次 Hermite（[shader.wgsl L406](file:///workspace/src-tauri/src/shaders/shader.wgsl#L406)），16 控制点下激进控制点有过冲风险；端点控制是行业标准缺口。
- 落点：[shader.wgsl](file:///workspace/src-tauri/src/shaders/shader.wgsl#L406-L424) 插值函数替换为 PCHIP（Fritsch–Carlson 切线钳制），端点逻辑 + UI 画布 + schema 版本（联动 P0-2）。
- 验收：极端 S 曲线/端点抬灰用例无过冲；双分辨率 golden 一致。

**P1-1 渲染 DNG 导出**：LibRaw/rawler 均可写线性 DNG；补"渲染 DNG + 内嵌预览"导出，便于二次协作 [RL-ej]。落点：[export_processing.rs](file:///workspace/src-tauri/src/export_processing.rs) 新增 DngWriter。

**P1-2 CLI / MCP server / Edit JSON 契约**：RawLab 用同一核心喂 CLI/MCP/Agent [RL-ej][RL-rel]。Crystal 管线在 Rust 主进程内，抽一个 `headless.rs`（无 Tauri 依赖的 render() 入口）即可低成本获得 CLI 与 MCP，反哺自动化测试。

**P1-3 AI 降噪的"缓存线性残差"混合**：0–100% 混合调滑杆零再推理 [RL-cl]。落点：[ai_denoise.rs](file:///workspace/src-tauri/src/ai_denoise.rs) 缓存模型输出，强度滑杆仅做残差混合。

**P1-4 小波降噪的粗尺度色度分离**：借"亮度/色度/粗尺度色度"三控件概念 [RL-home]，补 Crystal 空域降噪缺的色斑维度。落点：[shader.wgsl](file:///workspace/src-tauri/src/shaders/shader.wgsl#L1245-L1365) 加低频色度通道。

**P1-5 视口金字塔 + ROI 渐进缩放**：fast GPU/pyramid C ABI + 1:1 ROI tiling [RL-rel][RL-cl]，改善 Android 大图缩放流畅度（替代/补强现有 0.3–0.5 动态画质档）。

**P1-6 HSL 取样探针**：画面取样直读色相/饱和度 [RL-cc]，补 HSL 交互。落点：前端 Color 面板 + 取样命令。

**P2-1 AtomicOutputTransaction**：成品导出走"临时文件 + 完成才替换 + 失败报 output_io_error" [RL-rel]，与现有可恢复日志（[export_processing.rs L2201](file:///workspace/src-tauri/src/export_processing.rs#L2201)）叠加。

**P2-2 PinnedSourceFile 来源身份缓存**：file stamp + sha256 防止外部替换文件后缓存/sidecar 错配 [RL-rel]。

**P2-3 检视套件（InspectionSuite 概念）**：检查 HUD/覆盖层统一为一个可下沉模块 [RL-rel]，统一 Crystal 分散的剪裁警告/辅助线/软打样入口（顺带解决盘点 §4.3 的"滤镜画廊入口分散"）。

**P2-4 字段规格登记表**：把 124 参数升级为"spec 字段登记表 + 传输/重置场景向量"文本规格 [RL-rel][RL-rm]，让前后端/预设/追色共用一张真相表。

### 5.2 Crystal 应守住的相对优势（RawLab 无）

| 优势 | 证据 | 守法 |
| --- | --- | --- |
| AI 工具广度（蒙版 ×6/人脸 9 区/消除/液化/超分/选片/标签） | [CR-盘点§3/§7] | 任何架构调整不得破坏 ai_jobs 队列与 AI-Free 兜底 |
| 特效体系（mip bloom/halation/flare/bokeh/relight） | [CR-盘点§8] | P0-6 光效物理化继续走自定路线 |
| 色调映射器四选 + 软打样 | [CR-盘点§4.5/§5.2] | 引入 HDR 体系时保持映射器与 scene LUT 语义标注（借鉴 RawLab 色彩契约的做法） |
| LUT 四面体 + scene/display 双域 + HALD/3dl | [CR:shader.wgsl](file:///workspace/src-tauri/src/shaders/shader.wgsl#L2148-L2200) | 已是相对优势，继续 P1-10 加固 |
| 参考图追色 + 负片翻拍 | [CR:color_transfer.rs](file:///workspace/src-tauri/src/color_transfer.rs#L408-L574) | 追色 MKL 升级方案见既有借鉴文档 |
| HDR 括拍合并（对齐 + 去鬼影） | [CR:hdr_deghosting.rs](file:///workspace/src-tauri/src/hdr_deghosting.rs#L17-L22) | 与 P0-1 增益图体系合并成完整 HDR 链路 |
| 13 平台矩阵（含 Linux）+ 15 语 + 性能门禁 CI | [CR-盘点§9] | 保持 |
| Apple CIRAW 原生解码 | [CR:apple_raw.rs](file:///workspace/src-tauri/src/apple_raw.rs) | 保留 macOS 双解码路径 |

### 5.3 反向视角：RawLab 可向 Crystal 借的点（供上游参考）

- AI 蒙版/人脸分区/生成式消除的广度（RawLab 仅 AI 降噪且模型单独许可）。
- 色调映射器用户可选（basic/AgX/PBR Neutral/ACES）与软打样。
- LUT 的 scene/display 双域自动识别与四面体插值。
- ISO 联动噪声模型（RawLab 传统降噪未披露 ISO 先验）。
- 15 语 i18n 与 Linux 支持。

### 5.4 实施顺序建议（与现有改进计划的关系）

1. Crystal 现有 [image-pipeline-improvement-plan.md](file:///workspace/image-pipeline-improvement-plan.md) 的 P0（半径验证/软膝/噪声模型/局部去雾/映射器校准/光效物理化）**继续先行**——它们与本次借鉴项零冲突，且 golden 基线（M0）是 P0-2/P0-3 对拍工程的地基。
2. 本次新增借鉴按「P0-2 schema 版本化 → P0-5 曲线端点+PCHIP → P0-3 后端对拍 → P0-4 曝光基准 → P0-1 HDR 体系」排序：前两项小而确定，后两项依赖 RAW 元数据层，HDR 最后（体量最大、收益也最大）。
3. P1/P2 项挂在对应既有里程碑后，不单独开线。

---

## 六、许可与实施风险

1. **GPL-3.0 双向互借合法**：双方均为 GPL-3.0-only，概念借鉴无碍；直接移植代码也可行（保留版权声明）。但 RawLab 的 **DualDn/Restormer 模型包为单独许可，模型与配套代码不可搬用**，只能借鉴"Core ML/DirectML 原生栈 + 无 CPU 回退 + 缓存残差混合"的部署形态 [RL-rel]。
2. **X3F 桥参考价值有限**：x3fuse-core 是固定 commit 的 Rust 桥 [RL-x3f]，若 Crystal 要 X3F 支持可直接评估该 crate，但 Sigma 机型受众小，优先级低。
3. **schema 版本化迁移风险**：引入 schema 版本拒绝机制时，必须先全量盘点现有 sidecar 字段与默认值（Crystal 已有 124 参数一致性测试可复用），避免把存量用户文件误判为"不兼容"。
4. **HDR 体系体量**：P0-1 涉及显影层、shader、导出、UI 四层，建议按 RawLab 路线图式拆周交付（其 v0.13 即按 W-A~W-F 六周拆分）[RL-rel]。
5. **数据时效**：RawLab 侧结论基于 2026-11-27 官方文档；其路线图标注 GPU 化（清晰度/去雾）在阶段二 [RL-rm]，引用前请复核最新 release。

---

## 附：Crystal 侧关键证据索引

| 主题 | 位置 |
| --- | --- |
| 主 compute 管线顺序 | [shader.wgsl L201-208](file:///workspace/src-tauri/src/shaders/shader.wgsl#L201-L208) |
| LUT 四面体 + 双域 | [shader.wgsl L2148-2200](file:///workspace/src-tauri/src/shaders/shader.wgsl#L2148-L2200) |
| 曲线 Hermite 插值 | [shader.wgsl L406-424](file:///workspace/src-tauri/src/shaders/shader.wgsl#L406-L424) |
| GPU 架构/分块/精度 | [gpu_processing.rs L37-43](file:///workspace/src-tauri/src/gpu_processing.rs#L37-L43)、[L2355-2368](file:///workspace/src-tauri/src/gpu_processing.rs#L2355-L2368) |
| RAW 解码（rawler） | [raw_processing.rs](file:///workspace/src-tauri/src/raw_processing.rs#L292) |
| Apple 原生 RAW | [apple_raw.rs](file:///workspace/src-tauri/src/apple_raw.rs#L32-L78) |
| HDR 括拍合并 | [hdr_deghosting.rs](file:///workspace/src-tauri/src/hdr_deghosting.rs#L17-L22) |
| 导出（TIFF/ICC/日志） | [export_processing.rs L1592-1861](file:///workspace/src-tauri/src/export_processing.rs#L1592-L1861)、[L2201](file:///workspace/src-tauri/src/export_processing.rs#L2201) |
| 联机拍摄 | [camera_tethering.rs](file:///workspace/src-tauri/src/camera_tethering.rs) |
| 追色 | [color_transfer.rs L408-574](file:///workspace/src-tauri/src/color_transfer.rs#L408-L574) |
| 七大功能域完成度 | [v2.1.23-七大功能域盘点报告.md](file:///workspace/v2.1.23-七大功能域盘点报告.md) |
| 管线自述短板 | [image-pipeline-improvement-plan.md](file:///workspace/image-pipeline-improvement-plan.md) |
