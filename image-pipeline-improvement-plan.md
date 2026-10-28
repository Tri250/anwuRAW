# 图像管线算法提升方案（评审稿 v2）

> 基线：v1.6.8（commit `fa546fa`）。本文只做方案设计，不含代码改动；所有结论均基于当前仓库静态取证，行号以基线提交为准。
> **v2 修订**：经专家级代码复核，v1 的 S1（"滤波半径固定像素"）被证伪并重写；验收/测试方法、阶段依赖、若干技术细节同步修正。见 §10 修订记录。

## 0. 专家评审结论摘要

1. **S1 证伪**：v1 认为 `run_blur` 的 1.0/3.5/8.0/40.0 是"固定像素半径、未乘 scale"。实际 [gpu_processing.rs:2552](file:///workspace/src-tauri/src/gpu_processing.rs#L2552) 内部执行 `radius = base_radius * scale`，且 `scale = min(w,h)/1080`（[gpu_processing.rs:2355](file:///workspace/src-tauri/src/gpu_processing.rs#L2355)）；GF/去雾半径（[gpu_processing.rs:1750-1751](file:///workspace/src-tauri/src/gpu_processing.rs#L1750-L1751)）、降噪与颗粒（[shader.wgsl:1761-1764](file:///workspace/src-tauri/src/shaders/shader.wgsl#L1761-L1764)、[shader.wgsl:2070](file:///workspace/src-tauri/src/shaders/shader.wgsl#L2070)）均已按同一约定归一化。**半径体系的 WYSIWYG 基础已存在**，P0-1 从"补缩放"改写为"验证 + 度量治理"。
2. **分块模糊无缝**：blur 快路径从全图纹理采样（`full_dims` clamp，[blur.wgsl:97](file:///workspace/src-tauri/src/shaders/blur.wgsl#L97)），逐 tile 输出结果与整图计算逐像素一致，v1 担心的 TILE_OVERLAP=128 接缝不成立。
3. **M0 前置**：在动任何算法之前必须先建 golden 回归基线（原 P2-18 提前），否则 P0 各项的"前后对比"无从证明。
4. **负向加雾不能用局部 airlight**：物理上雾色应全图一致，逐块 airlight 做"加雾"会产生色斑；正向去雾用局部、负向加雾保留全局。
5. **P2-17 表述修正**：GPU compute 在同一 queue 上串行执行，"worker 线程与渲染帧重叠"只对 CPU 侧准备（蒙版位图、LUT/EXIF 上传）有效；GPU 侧收益应来自减少冗余 pass 而非并行。

## 1. 目标与范围

### 1.1 目标

1. **一致性**：用 golden 测试**证明并保持**同参数下预览与导出在同尺寸观感一致（WYSIWYG 可量化），而非假设。
2. **算法水准**：降噪、局部对比、去雾、色调映射、光效达到同类主流修图 APP 的画质水平，并具备可验证的指标。
3. **可维护性**：建立逐阶段回归测试与性能基准，避免后续调参互相踩踏。

### 1.2 范围

- GPU 计算管线：`src-tauri/src/gpu_processing.rs`、`src-tauri/src/shaders/{shader,blur,guided,flare,display}.wgsl`。
- 预处理纹理：guided-filter 系数/结构层、haze/airlight、四级模糊、flare 贴图、蒙版数组、LUT。
- 导出链：`src-tauri/src/export_processing.rs`。
- RAW 解码与高光重建的接口边界：`src-tauri/src/raw_processing.rs`、`src-tauri/src/image_processing.rs`。

### 1.3 非目标

- UI/交互改版；相机支持扩展；AI 模型替换（仅允许把现有 AI 降噪/BM3D 接入管线作为可选项）。

## 2. 现状基线

### 2.1 管线结构

| 环节                | 实现位置                                   | 说明                                                                                                                                                                                                                                              |
| ------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RAW 解码 / 高光重建 | `raw_processing.rs`                        | CPU 侧生成线性图像，`highlight_reconstruction` 已接线                                                                                                                                                                                             |
| 预处理纹理          | `guided.wgsl` / `blur.wgsl` / `flare.wgsl` | GF 系数与结构层、haze/airlight、4 级模糊、flare 光照贴图                                                                                                                                                                                          |
| 主 compute pass     | `shader.wgsl`                              | 线性化 → CA → 蒙版参数累加 → 降噪 → 锐化/局部对比 → 去雾 → 曝光 → glow/halation/flare → 白平衡 → centré → tonal → 色彩校准/HSL/分级 → 暗角 → 色调映射 → scene LUT → brightness → 曲线 → 蒙版曲线 → display LUT → 颗粒 → 剪裁警告 → dither → clamp |
| 分块                | `gpu_processing.rs`                        | `TILE_SIZE = 2048`、`TILE_OVERLAP = 128`，`absolute_coord = id.xy + tile_offset` 采样全图纹理；blur 快路径同样从全图采样，逐 tile 结果与整图一致（无缝）                                                                                          |
| 输出                | `gpu_processing.rs`                        | 预览 `rgba8unorm`；读回导出可选 `rgba16float`（`high_precision_shader_source()`，关闭 dither）                                                                                                                                                    |

### 2.2 已核实的完整性

- `GlobalAdjustments` 63 字段、`MaskAdjustments` 38 字段在 WGSL 中全部被消费（`centré` 按 `repr(C)` 布局对应 WGSL `centre`）。
- 145 项后端命令均有真实前端入口；58 项快捷键与 handler 一一对应。
- 导出与预览共用 `process_and_get_dynamic_image_with_precision` 同一管线。
- **半径归一化已实现且约定统一为 `min(w,h)/1080`**：
  - 四级模糊：`radius = base_radius * scale`，`scale = min(w,h)/1080`（[gpu_processing.rs:2552](file:///workspace/src-tauri/src/gpu_processing.rs#L2552)、[2355](file:///workspace/src-tauri/src/gpu_processing.rs#L2355)）；
  - GF / 去雾引导滤波：`base_radius * low_short / 1080 / div`（[gpu_processing.rs:1750-1751](file:///workspace/src-tauri/src/gpu_processing.rs#L1750-L1751)）；
  - 降噪与颗粒：shader 内 `scale = min_dim/1080`（[shader.wgsl:1761-1764](file:///workspace/src-tauri/src/shaders/shader.wgsl#L1761-L1764)、[2070](file:///workspace/src-tauri/src/shaders/shader.wgsl#L2070)）。
- blur 快路径正确性核对：`v_cache` 采用 chunked 窗口（`(k−chunk)*8+lx`，上限 512 覆盖 `64+2r` 窗口分段），radius > 512 时回退逐 tap `exp`（[blur.wgsl:25](file:///workspace/src-tauri/src/shaders/blur.wgsl#L25) `MAX_TABLE_RADIUS`），**无越界隐患**；`DIRECT_BLUR_MAX_RADIUS = 8` 仅覆盖极小半径（[gpu_processing.rs:677](file:///workspace/src-tauri/src/gpu_processing.rs#L677)）。

### 2.3 已定位的结构性短板（v2 修正后，含证据）

| 编号 | 问题                                                                                                                                  | 证据                                                                                                                                                                                   |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1   | **半径体系"已归一化但未验证"**：无 golden 测试证明预览↔导出一致；极端宽高比（全景 10:1）下 `min(w,h)` 度量使长边相对强度偏差可达 5 倍 | [gpu_processing.rs:2355](file:///workspace/src-tauri/src/gpu_processing.rs#L2355)；20000×2000 全景 scale=1.85 而长边放大 10×                                                           |
| S2   | **airlight 为单点全局值**（2×1 纹理）                                                                                                 | [gpu_processing.rs:1777](file:///workspace/src-tauri/src/gpu_processing.rs#L1777)、[shader.wgsl:1064](file:///workspace/src-tauri/src/shaders/shader.wgsl#L1064)                       |
| S3   | **光效经验近似**：glow 用单级 40·s 高斯（非 mip bloom）、halation 用 8·s 高斯                                                         | [gpu_processing.rs:2672-2677](file:///workspace/src-tauri/src/gpu_processing.rs#L2672-L2677)、[shader.wgsl:1937-1948](file:///workspace/src-tauri/src/shaders/shader.wgsl#L1937-L1948) |
| S4   | **降噪无噪声模型**：sigma 由滑杆线性映射，未用 ISO/传感器参数（尺度归一化已具备）                                                     | [shader.wgsl:1245-1365](file:///workspace/src-tauri/src/shaders/shader.wgsl#L1245-L1365)，`GlobalAdjustments` 无 ISO 字段                                                              |
| S5   | **色调映射仅两种**：AgX 近似 + Basic                                                                                                  | `tonemapper_mode` 仅 `== 1` 分支（[shader.wgsl:2027](file:///workspace/src-tauri/src/shaders/shader.wgsl#L2027)）                                                                      |
| S6   | **预览输出 8bit**，只有 CPU 读回才走 16bit                                                                                            | `RenderOutputPrecision` 分支（[gpu_processing.rs:2358-2368](file:///workspace/src-tauri/src/gpu_processing.rs#L2358-L2368)）                                                           |
| S7   | **无回归测试与性能基准**                                                                                                              | 仓库无 golden image / 基准脚本                                                                                                                                                         |

## 3. P0：正确性与一致性（优先实施）

### P0-1 半径体系验证与度量治理（WYSIWYG）

- **现状**：半径已按 `min(w,h)/1080` 归一化（§2.2），v1 的"补缩放"方案作废。
- **方案**：
  1. **验证**：M0 golden 集中加"同参数双分辨率"用例（1920 预览 vs 6000px 导出，Rust 内同一 Lanczos 重采样到同尺寸后比对），量化并发布基线报告。
  2. **度量治理**：把 `min(w,h)/1080` 定为唯一约定，抽成单一常量/函数（CPU 侧一处、WGSL 侧一处），消除 `low_short/1080/div`、`REFERENCE_DIMENSION` 等分散写法。
  3. **已知限制文档化**：极端宽高比（全景）下长边相对强度偏差为 min-dim 度量的固有特性；不改为面积度量（会改变所有现有出图观感），在全景拼接结果上如需补偿，由拼接输出端单独评估。
  4. **导出性能**：大半径（structure 40·s，45MP 时 radius≈150）为 O(radius/像素) 双 pass；金字塔降采样模糊作为 P2 性能项（见 P2-16b），**不属于正确性修复**。
- **涉及文件**：`gpu_processing.rs`（度量收敛）、`shader.wgsl`（`REFERENCE_DIMENSION` 统一）。
- **验收**：双分辨率 golden 用例 SSIM ≥ 0.995、高频能量比偏差 ≤ ±5%（先测后定，若基线不达标再进radius 类修复）；全景宽高比偏差写入用户文档。
- **风险**：极低——本项以测量为主，不改算法。

### P0-2 局部对比的光晕抑制升级

- **问题**：clarity/structure 线性增益在强推时高反差边缘产生过冲与"浮雕感"。
- **方案**：
  - 基底层改为双边引导滤波（空间 σ 与值域 σ 分离），或在现有 GF 上加入边缘保持的二次细化。
  - 细节增益采用**分段软膝**而非全局 tanh：`|d| ≤ a` 保持线性（不改变常规力度下的手感），`|d| > a` 进入 `a + G·tanh((|d|−a)/G)` 软限幅；负向（柔和）单独限幅。全局 tanh 会在常规力度就改变响应曲线，属 v1 细节修正。
  - 暗部按噪声水平自适应降增益（复用 P0-3 的 sigma 估计）。
- **涉及文件**：`shader.wgsl`（`apply_sharpen`、clarity/structure 段）、`guided.wgsl`。
- **验收**：高反差阶跃边缘过冲率 ≤ 2%，边缘两侧 3px 内无可见亮/暗边；中等力度下与旧版输出 SSIM ≥ 0.98（保证手感连续）。

### P0-3 降噪噪声模型（ISO 驱动）

- **问题**：sigma 由滑杆线性映射，在 ISO 100 与 ISO 6400 上同一滑杆力度不匹配；色度噪声在 RGB 空间处理，易串色。
- **方案**：
  - 由 EXIF ISO（`kamadak-exif` 已在依赖中，`ImageMetadata.exif` 通道可取）估计 shot/read noise：`σ²(I) = k(ISO)·I + σ_read²`。参数放入 `RenderRequest` 新增的元数据结构，**不进 `GlobalAdjustments`**（避免 sidecar/预设 JSON 兼容性抖动）。
  - 保持现有 sqrt 方差稳定变换与 scale 归一化；亮度/色度权重由噪声模型推导，替代固定值。
  - 色度去噪改在去相关空间（线性 RGB → LMS/ opponent 轴），限制色度扩散半径。
  - "细节保留"档：局部方差门控保留纹理。
  - 现有 CPU 侧 BM3D（`bm3d.rs`）与 AI 降噪作为高画质可选路径接入导出链（非目标允许范围），与 GPU 路径做 A/B 指标。
- **涉及文件**：`shader.wgsl`（`apply_noise_reduction`）、`gpu_processing.rs`（`RenderRequest` 扩展）、`image_processing.rs`（EXIF ISO 提取）。
- **验收**：合成 Poisson-Gaussian 噪声（ISO 3200 等效）下 PSNR 提升 ≥ 6 dB；细节区域 MTF50 衰减 < 10%。

### P0-4 局部空气光去雾

- **问题**：全局单点 airlight 在天空占比较大或逆光场景会导致整体偏色/天空发灰。
- **方案**：
  - **正向去雾**：airlight 由 1/16 降采样块统计（每块取最亮 0.1% 像素均值）生成低频图，引导滤波细化（ε = 1e-3）上采样；透射率沿用现有 `HZ_OMEGA`/floor/knee 与 `HZ_BRIGHT_*` 保护。
  - **负向加雾保留全局 airlight**：雾色物理上全图一致，逐块 airlight 加雾会产生色斑；负向路径继续用 2×1 纹理的全局值（或可加一个用户可调雾色，后续再说）。
  - 局部 airlight 不可靠时（块内梯度极低）回退全局值，避免平坦天空出现块状。
- **涉及文件**：`gpu_processing.rs`（airlight 纹理从 2×1 扩为低频图，绑定布局同步）、`shader.wgsl:1061-1100`。
- **验收**：天空区域与参考色卡 ΔE2000 下降 ≥ 30%；负向加雾无色斑、无块状。

### P0-5 色调映射保真与扩展

- **问题**：AgX 为近似实现，缺少参考校准；没有中性编码与 ACES 选项。
- **方案**：
  - 以官方 AgX 参考曲线 + 色域矩阵做 golden 校准（256 级灰阶 + 色卡），偏差控制到 ΔE2000 < 1.5。
  - 新增 `ACES Filmic`（采用 Hill 拟合版 RRT+ODT，含 3×3 输入/输出矩阵，避免 Narkowicz 单曲线版的色相偏移）与 `Pure sRGB（仅编码）`；`tonemapper_mode` 扩展 0/1/2/3。
  - **兼容性**：`tonemapper_mode` 为 u32 直传，WGSL 侧对未知值回退分支（`select`/默认 0），旧 sidecar/预设无需迁移。
  - **与 LUT 的交互**：scene LUT 作者以 AgX 为前提，切换色调映射会使 scene LUT 语义漂移——在文档与 UI 描述中标注，不改 LUT 逻辑。
- **涉及文件**：`shader.wgsl:1440-1510`、`image_processing.rs`、`SettingsPanel.tsx`。
- **验收**：24 色卡 ΔE2000 均值 < 1.5、最大 < 3；灰阶 14 档无反转、无硬拐点；旧配置加载不回归。

### P0-6 光效物理化

- **问题**：glow 为单级大半径高斯（无 mip bloom）、halation 为经验鬼影，跨分辨率稳定性一般。
- **方案**：
  - **Bloom**：阈值化高光（感知域 0.85 起）→ 5 级 mip 降采样 + 高斯升采样合成，能量按 `1/2^n` 衰减；mip 链为全图资源，天然无分块问题。glow 不再复用 structure 40·s 模糊，但 structure 模糊本身仍是 clarity/texture 的资源，需同步解耦命名与门控。
  - **Halation**：半径按图像宽度百分比（0.1%–0.2%，35mm 乳剂散射经验值），红色通道扩散强于绿/蓝——用**红色加权单次模糊**近似（避免 3 通道各跑一遍 blur 的成本），强度随高光溢出量调制。
  - **Flare**：保留光照贴图，参数化镜头模型（光圈叶片数、鬼影位置比例、色散量），生成成本不变。
- **涉及文件**：`shader.wgsl:1937-1963`、`flare.wgsl`、`gpu_processing.rs`（mip 链资源与绑定）。
- **验收**：同一参数在 1920 与 6000 宽度下，光效覆盖面积（相对宽度计）偏差 ≤ 10%；无分块接缝；1080p 预览帧时间增幅 ≤ 20%。

## 4. P1：能力增强

| 编号  | 项目                  | 要点                                                                                                                                                             | 验收                                         |
| ----- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| P1-7  | 导出重采样 + 输出锐化 | 目标尺寸 Lanczos3（`image`/`imageproc` 已具备）；输出锐化半径按输出像素归一化，复用现有 `min(w,h)/1080` 度量                                                     | 缩小导出后高频保留优于当前，无摩尔纹         |
| P1-8  | 高位深与色彩管理      | 32-bit float TIFF（`tiff 0.11` 已在依赖中，需验证 IEEEFP 写出）、EXR 引入 `exr` crate；ICC 用 `lcms2` 绑定或手写矩阵 profile；导出色彩空间 sRGB/AdobeRGB/Rec2020 | 导出色卡 ΔE < 2；元数据完整                  |
| P1-9  | HDR 显示              | surface 格式探测 rgba16float（不支持则回退 8bit）；PQ/HLG 编码放 display.wgsl + SDR 模拟；移动端优先级最低                                                       | HDR 屏渐变无 banding；SDR 模拟与普通预览一致 |
| P1-10 | LUT 增强              | HALD CLUT 解析；场景/显示参考域自动识别加固；65³ 高精度路径                                                                                                      | 大师/胶片 LUT 均正确；无黑帧回归             |
| P1-11 | 感知均匀空间          | 曲线与 HSL/色相在 OKLab/IPT 空间插值；注意管线中曲线位于色调映射之后（display-referred），插值空间切换需独立 golden 校准                                         | 亮度调整不引起色相漂移（ΔHue < 1°）          |
| P1-12 | 蒙版增强              | 亮度/色相范围蒙版需要**输入图亮度/色相预通道纹理**（新增预处理资源，在蒙版累加阶段采样）；羽化半径、交/差集组合、AI 主体蒙版联动                                 | 范围蒙版边缘过渡平滑，无硬切                 |
| P1-13 | 颗粒标定              | 胶片扫描样本标定的多尺度 grain、暗部加权、色度颗粒（现有 `grain_frequency` 已随 scale 归一化，在此基础上扩展）                                                   | 与真实胶片颗粒频谱匹配（PSD 偏差 < 3dB）     |
| P1-14 | 色差/暗角模型         | CA 改多阶径向多项式（现实现为径向分数偏移，本身分辨率无关）；暗角支持非对称与离轴                                                                                | 边缘色边校正后 ΔE < 2                        |

## 5. P2：架构与性能

| 编号   | 项目         | 设计要点                                                                                                                                                      |
| ------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P2-15  | Render Graph | 渐进式：先把 blur/flare 的源缓存统一为通用 aux-texture 缓存（键 = stage + 参数 hash + 源 id），再考虑 Stage DAG 与脏区重算；必须以 M0 golden 就绪为前提       |
| P2-16  | 精度与内存   | 中间纹理统一 rgba16f；bloom mip 常驻；内存上限 2.5× 图像字节数                                                                                                |
| P2-16b | 金字塔模糊   | 大半径 blur（structure/glow）在 1/4 分辨率上计算后双线性升采样，导出耗时从 O(radius·pixel) 降为 O(radius·pixel/16)；属性能项，不改观感（误差 < 1/255 需验证） |
| P2-17  | 预计算异步化 | GPU pass 在同一 queue 上串行，收益来自 CPU 侧准备（蒙版位图、LUT/EXIF、缩略图）与 GPU 重叠；Android 分块 2048→1024 需真机验证显存                             |
| P2-18  | 回归与基准   | CPU f64 参考实现逐 stage + golden image + 性能基准纳入 CI；**已提前为 M0 实施**                                                                               |

## 6. 验收指标与测试方法

### 6.1 指标定义

- **色彩**：24 色卡 ΔE2000（均值/最大）。
- **一致性**：预览 vs 导出**在 Rust harness 内用同一重采样器**（Lanczos3）缩放到同尺寸后比 SSIM 与高频能量比——禁止用浏览器/系统缩放做参照（会引入重采样差异污染结论）。
- **光晕**：阶跃边缘过冲率 =（过冲峰值 − 平台值）/（阶跃幅度）。
- **降噪**：合成噪声 PSNR / SSIM；细节 MTF50。
- **渐变**：灰阶渐变 8bit PSNR ≥ 45 dB（含 dither）。
- **性能**：1080p 预览帧时间 P95 ≤ 16 ms；45MP 导出 ≤ 20 s（RTX 3060 基准）；内存峰值 ≤ 2.5× 原图字节。

### 6.2 测试方法

1. **CPU 参考实现**：把关键 stage（降噪、锐化、去雾、色调映射）移植为 f64 CPU 版本，逐像素对比 GPU 输出（容差 1e-3），放入 `cargo test`。
2. **Golden image**：色卡、14 级灰阶、高反差边缘、天空/逆光、人像、ISO 噪声合成 6 组，固定参数快照；另加边界用例：1×N、20000×2000 全景、单 tile vs 多 tile 同图。CI 用 Mesa lavapipe/llvmpipe 跑 256×256 离屏渲染；**软渲染 fp 舍入与真机有差**，门禁用容差区间（如 ΔE < 0.5 ± 0.1）而非严格相等。
3. **性能基准**：wgpu timestamp query 记录各 stage 耗时；每次合并生成对比表存档。
4. **真机抽检**：Android arm64 与 macOS Apple Silicon 各跑一次 golden 集，确认 fp16 与纹理上限差异。

## 7. 实施阶段与依赖

| 阶段 | 内容                        | 依赖                       | 交付                                                          |
| ---- | --------------------------- | -------------------------- | ------------------------------------------------------------- |
| M0   | P2-18 golden 回归 harness   | 无                         | CPU 参考实现 + 6 组 golden + CI 门禁 + 双分辨率一致性基线报告 |
| M1   | P0-1（验证/度量治理）+ P0-2 | M0（用基线证明现状与改动） | 一致性报告 + 光晕抑制                                         |
| M2   | P0-3 + P0-4                 | M0；需要 EXIF ISO 传入     | 噪声模型与局部空气光                                          |
| M3   | P0-5 + P0-6                 | M0 golden 资产             | 色调映射校准与光效物理化                                      |
| M4   | P1-7/8/9                    | M1 度量治理                | 导出与 HDR 显示链路                                           |
| M5   | P1-10 ~ P1-14               | 独立，可并行               | 单项功能增强                                                  |
| M6   | P2-15/16/16b/17             | M0–M3 完成                 | Render Graph、金字塔模糊、异步预计算                          |

建议每个阶段单独 PR；M0 与后续阶段不改同一段代码，便于独立回滚。P2-15 是结构性重构，必须建立在 golden 测试就绪之后。

## 8. 风险与回滚

- **观感变化**：P0-2/P0-5 会改变现有出图（属修正），需在 Release 说明与设置中提供"旧版强度"对照截图；不做隐式开关。
- **性能回退**：bloom mip 链与双边引导增加开销，设性能预算门禁（P95 超 10% 即阻断合并）；导出大半径模糊的开销由 P2-16b 解决，M0 起记录导出耗时基线。
- **兼容性**：`tonemapper_mode` 等新增枚举必须在 WGSL 与 serde 两侧对未知值回退默认，保证旧 sidecar/预设/JSON 无迁移成本。
- **CI 确定性**：lavapipe/llvmpipe 的 fp 舍入与真机不同，golden 门禁用容差区间；色卡类指标允许 ±0.1 ΔE 抖动。
- **GPU 能力差异**：storage texture、rgba16float surface、fp16 支持需能力探测 + 回退路径（尤其 Android/iOS）。
- **回滚策略**：所有改动按阶段独立 PR；P0-1 v2 以测量为主，无需专门回退开关；P0-2/P0-5 若观感争议可按阶段整体 revert。

## 9. 附录：主 shader 处理顺序

```
线性化 → CA 校正 → 蒙版参数累加 → 降噪 → 锐化 / local contrast（GF）
→ 去雾 → 曝光 → glow / halation / flare → 白平衡（LMS）→ centré
→ tonal（contrast / highlights / shadows / whites / blacks）
→ 色彩校准 / HSL / 色相 / 饱和度 / 色彩分级 → 暗角 → 色调映射（AgX / Basic）
→ scene-referred LUT → brightness → 曲线 → 蒙版曲线 → display-referred LUT
→ 颗粒 → 剪裁警告 → dither → clamp 输出
```

该顺序符合 scene-referred 线性工作流，本方案不改变顺序，只替换各阶段内部算法与半径体系。

## 10. 修订记录

| 版本 | 修订内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| v2   | ① S1 证伪重写：模糊/GF/降噪/颗粒半径均已按 `min(w,h)/1080` 归一化（§0.1、§2.2），P0-1 从"补缩放"改为"验证 + 度量治理"；② 确认 blur 分块快路径从全图采样、无接缝与越界；③ M0（golden harness）前置为第一阶段；④ P0-2 全局 tanh 改分段软膝；⑤ P0-3 参数入 `RenderRequest`、色度去相关空间、BM3D/AI 可选路径；⑥ P0-4 负向加雾保留全局 airlight；⑦ P0-5 补 ACES Hill 拟合、未知枚举回退、scene LUT 交互说明；⑧ P2-17 表述修正（GPU 串行）；⑨ 新增 P2-16b 金字塔模糊；⑩ §6.1 一致性测试方法固定为 Rust 内同重采样器比对；⑪ 风险补 CI 确定性/GPU 能力探测/枚举兼容 |
| v1   | 初稿                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
