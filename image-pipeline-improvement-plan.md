# 图像管线算法提升方案（评审稿）

> 基线：v1.6.8（commit `fa546fa`）。本文只做方案设计，不含代码改动；所有结论均基于当前仓库静态取证，行号以基线提交为准。

## 1. 目标与范围

### 1.1 目标

1. **一致性**：同一组参数下，预览与导出在相同尺寸下观感一致（WYSIWYG 可量化）。
2. **算法水准**：降噪、局部对比、去雾、色调映射、光效达到同类主流修图 APP 的画质水平，并具备可验证的指标。
3. **可维护性**：建立逐阶段回归测试与性能基准，避免后续调参互相踩踏。

### 1.2 范围

- GPU 计算管线：`src-tauri/src/gpu_processing.rs`、`src-tauri/src/shaders/{shader,blur,guided,flare,display}.wgsl`。
- 预处理纹理：guided-filter 系数/结构层、haze/airlight、四级模糊、flare 贴图、蒙版数组、LUT。
- 导出链：`src-tauri/src/export_processing.rs`。
- RAW 解码与高光重建的接口边界：`src-tauri/src/raw_processing.rs`、`src-tauri/src/image_processing.rs`。

### 1.3 非目标

- UI/交互改版；相机支持扩展；AI 模型替换（仅允许把现有 AI 降噪接入管线作为可选项）。

## 2. 现状基线

### 2.1 管线结构

| 环节                | 实现位置                                   | 说明                                                                                                                                                                                                                                              |
| ------------------- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| RAW 解码 / 高光重建 | `raw_processing.rs`                        | CPU 侧生成线性图像，`highlight_reconstruction` 已接线                                                                                                                                                                                             |
| 预处理纹理          | `guided.wgsl` / `blur.wgsl` / `flare.wgsl` | GF 系数与结构层、haze/airlight、4 级模糊、flare 光照贴图                                                                                                                                                                                          |
| 主 compute pass     | `shader.wgsl`                              | 线性化 → CA → 蒙版参数累加 → 降噪 → 锐化/局部对比 → 去雾 → 曝光 → glow/halation/flare → 白平衡 → centré → tonal → 色彩校准/HSL/分级 → 暗角 → 色调映射 → scene LUT → brightness → 曲线 → 蒙版曲线 → display LUT → 颗粒 → 剪裁警告 → dither → clamp |
| 分块                | `gpu_processing.rs`                        | `TILE_SIZE = 2048`、`TILE_OVERLAP = 128`，`absolute_coord = id.xy + tile_offset` 采样全图纹理                                                                                                                                                     |
| 输出                | `gpu_processing.rs`                        | 预览 `rgba8unorm`；读回导出可选 `rgba16float`（`high_precision_shader_source()`，关闭 dither）                                                                                                                                                    |

### 2.2 已核实的完整性

- `GlobalAdjustments` 63 字段、`MaskAdjustments` 38 字段在 WGSL 中全部被消费（`centré` 按 `repr(C)` 布局对应 WGSL `centre`）。
- 145 项后端命令均有真实前端入口；58 项快捷键与 handler 一一对应。
- 导出与预览共用 `process_and_get_dynamic_image_with_precision` 同一管线。
- 噪点与颗粒已按 `scale = min(w,h)/1080` 归一化。

### 2.3 已定位的结构性短板（含证据）

| 编号 | 问题                                                                            | 证据                                                                                         |
| ---- | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| S1   | **滤波半径固定像素**，预览与导出相对强度不一致                                  | `run_blur` 的 sigma 为 1.0 / 3.5 / 8.0 / 40.0（`gpu_processing.rs:2672-2677`），未乘 `scale` |
| S2   | **airlight 为单点全局值**                                                       | `textureLoad(airlight_texture, (0,0))`（`shader.wgsl:1064`）                                 |
| S3   | **光效经验近似**：halation 复用 8px clarity blur、glow 复用 40px structure blur | `shader.wgsl:1937-1948`                                                                      |
| S4   | **降噪无噪声模型**：sigma 由滑杆线性映射，未用 ISO/传感器参数                   | `shader.wgsl:1278`，`GlobalAdjustments` 无 ISO 字段                                          |
| S5   | **色调映射仅两种**：AgX 近似 + Basic                                            | `tonemapper_mode` 仅 `== 1` 分支（`shader.wgsl:2027`）                                       |
| S6   | **预览输出 8bit**，只有 CPU 读回才走 16bit                                      | `gpu_processing.rs` 的 `RenderOutputPrecision` 分支                                          |
| S7   | **无回归测试与性能基准**                                                        | 仓库无 golden image / 基准脚本                                                               |

## 3. P0：正确性与一致性（优先实施）

### P0-1 分辨率自适应滤波（WYSIWYG 一致性）

- **问题**：预览按 `editor_preview_resolution`（桌面默认 1920）渲染，导出按原图；固定像素半径使 6000px 导出时锐化/清晰度/辉光/光晕的相对半径只有预览的 1/3 左右。
- **方案**：
  - 定义 `render_scale = clamp(sqrt(width*height) / sqrt(1920*1080), 0.6, 4.0)`（长边归一化亦可，取面积基准与现有 `scale` 一致）。
  - 所有模糊半径乘以 `render_scale`，并设上下限避免极端值：锐化 1.0×s ∈ [0.6, 4]，tonal 3.5×s ∈ [2, 12]，clarity 8×s ∈ [4, 28]，structure 40×s ∈ [16, 120]。
  - `blur_sources` 缓存键加入 `render_scale`；`sharpness_threshold`、`grain_size` 统一为归一化量。
  - 蒙版参数无需额外处理：着色器按绝对坐标采样预计算纹理，半径统一后自动一致。
- **涉及文件**：`gpu_processing.rs`（`run_blur` 调用与缓存）、`blur.wgsl`（若 sigma 以 uniform 传入）。
- **验收**：预览与导出在同尺寸重采样后 SSIM ≥ 0.995，锐化能量比（高频能量）偏差 ≤ ±5%；高反差边缘过冲 ≤ 2%。
- **风险**：现有用户的高像素导出锐度会变强（属修正）；需在 Release 说明标注。

### P0-2 局部对比的光晕抑制升级

- **问题**：clarity/structure 共用单一 GF 基底与线性增益，强推时高反差边缘产生过冲与"浮雕感"。
- **方案**：
  - 基底层改为双边引导滤波（空间 σ 与值域 σ 分离），或在现有 GF 上加入边缘保持的二次细化。
  - 细节增益在 log2 域做软限幅：`gain = G * tanh(detail / G)`，避免高频过冲；负向（柔和）单独限幅。
  - 暗部按噪声水平自适应降增益（复用 P0-3 的 sigma 估计）。
- **涉及文件**：`shader.wgsl`（`apply_sharpen`、clarity/structure 段）、`guided.wgsl`。
- **验收**：高反差阶跃边缘的过冲率（overshoot ratio）≤ 2%，边缘两侧 3px 内无可见亮/暗边。

### P0-3 降噪噪声模型（ISO 驱动）

- **问题**：固定 sigma 参数，在 ISO 100 与 ISO 6400 上同一滑杆的力度不匹配；色度噪声在 RGB 空间处理，易串色。
- **方案**：
  - 由 EXIF ISO + 传感器像素尺寸估计 shot noise 系数与 read noise 底：`σ²(I) = k(ISO)·I + σ_read²`，随图像作为 uniform 传入（新增内部字段，不进 UI）。
  - 保持现有 sqrt 方差稳定变换；亮度与色度权重由噪声模型推导，替代固定 0.002/0.06。
  - 色度去噪改在 YCbCr 或去相关空间，限制色度扩散半径，避免色彩渗漏。
  - 增加"细节保留"档（当前强度滑杆的中间档），用局部方差门控保留纹理。
- **涉及文件**：`shader.wgsl`（`apply_noise_reduction`）、`image_processing.rs`（从 EXIF 取 ISO 传入）。
- **验收**：合成 Poisson-Gaussian 噪声（ISO 3200 等效）下 PSNR 提升 ≥ 6 dB；细节区域 MTF50 衰减 < 10%。

### P0-4 局部空气光去雾

- **问题**：全局单点 airlight 在天空占比较大或逆光场景会导致整体偏色/天空发灰。
- **方案**：
  - airlight 由 1/16 降采样块统计（每块取最亮 0.1% 像素均值）生成低频图，再用引导滤波细化（ε = 1e-3）上采样。
  - 透射率沿用现有 `HZ_OMEGA` / floor / knee 逻辑；天空与高光保护沿用 `HZ_BRIGHT_*`、`HZ_TOLERANCE`。
  - 负值加雾路径同步使用局部 airlight，保持"无雾→加雾"对称。
- **涉及文件**：`gpu_processing.rs`（airlight 纹理生成）、`shader.wgsl:1061-1100`。
- **验收**：天空区域与参考色卡的 ΔE2000 下降 ≥ 30%；无雾图加负值时的雾气分布自然（无块状）。

### P0-5 色调映射保真与扩展

- **问题**：AgX 为近似实现，缺少参考校准；没有中性编码与 ACES 选项。
- **方案**：
  - 以官方 AgX 参考曲线 + 色域矩阵做 golden 校准（256 级灰阶 + 色卡），把偏差控制到 ΔE2000 < 1.5。
  - 新增 `ACES Filmic` 与 `Pure sRGB（仅编码）` 两个模式，UI 选项与后端枚举同步扩展（`tonemapper_mode` 取值 0/1/2/3）。
  - 为 HDR 显示预留 PQ/HLG 输出分支（与 P1-9 配合）。
- **涉及文件**：`shader.wgsl:1440-1510`、`image_processing.rs` 的 `tonemapper_mode`、`SettingsPanel.tsx` 选项。
- **验收**：24 色卡 ΔE2000 均值 < 1.5、最大 < 3；灰阶 14 档无反转、无硬拐点。

### P0-6 光效物理化

- **问题**：halation/glow 复用固定半径模糊，flare 为经验鬼影，跨分辨率不稳定。
- **方案**：
  - **Bloom**：阈值化高光（感知域 0.85 起）→ 5 级 mip 降采样 + 高斯升采样合成，能量按 `1/2^n` 衰减；替代 40px structure blur 复用。mip 链为全图资源，不受分块影响。
  - **Halation**：半径改为相对图像宽度（0.1%–0.2%，按 35mm 胶片乳剂散射经验值），红色通道扩散半径大于绿/蓝（波长相关），强度随高光溢出量调制。
  - **Flare**：光照贴图保留，增加镜头参数（光圈叶片数、鬼影位置比例、色散量）；生成成本不变的参数化版本。
- **涉及文件**：`shader.wgsl:1937-1963`、`flare.wgsl`、`gpu_processing.rs`（mip 链资源与绑定）。
- **验收**：同一参数在 1920 与 6000 宽度下，光效覆盖面积（以相对宽度计）偏差 ≤ 10%；无分块接缝。

## 4. P1：能力增强

| 编号  | 项目                  | 要点                                                                         | 验收                                         |
| ----- | --------------------- | ---------------------------------------------------------------------------- | -------------------------------------------- |
| P1-7  | 导出重采样 + 输出锐化 | 目标尺寸 Lanczos3；输出锐化半径按输出像素归一化；与 P0-1 共用 `render_scale` | 缩小导出后高频保留优于当前，无摩尔纹         |
| P1-8  | 高位深与色彩管理      | 32-bit float TIFF/EXR；ICC 嵌入；导出色彩空间 sRGB/AdobeRGB/Rec2020          | 导出色卡 ΔE < 2；元数据完整                  |
| P1-9  | HDR 显示              | 预览 surface 改 rgba16f/10bit；PQ/HLG 输出 + SDR 模拟                        | HDR 屏渐变无 banding；SDR 模拟与普通预览一致 |
| P1-10 | LUT 增强              | HALD CLUT 解析；场景/显示参考域自动识别加固；65³ 高精度路径                  | 大师/胶片 LUT 均正确；无黑帧回归             |
| P1-11 | 感知均匀空间          | 曲线与 HSL/色相在 OKLab/IPT 空间插值                                         | 亮度调整不引起色相漂移（ΔHue < 1°）          |
| P1-12 | 蒙版增强              | 亮度/色相范围蒙版、羽化半径、交/差集组合、AI 主体蒙版联动                    | 范围蒙版边缘过渡平滑，无硬切                 |
| P1-13 | 颗粒标定              | 胶片扫描样本标定的多尺度 grain、暗部加权、色度颗粒                           | 与真实胶片颗粒频谱匹配（PSD 偏差 < 3dB）     |
| P1-14 | 色差/暗角模型         | CA 改多阶径向多项式；暗角支持非对称与离轴                                    | 边缘色边校正后 ΔE < 2                        |

## 5. P2：架构与性能

| 编号  | 项目         | 设计要点                                                                                                                                               |
| ----- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| P2-15 | Render Graph | Stage 描述 `{id, inputs, outputs, param_hash, feature_mask}`；参数变化只重算脏 stage；瞬态纹理池按生命周期复用；当前 blur/flare 的源缓存扩展为通用机制 |
| P2-16 | 精度与内存   | 中间纹理统一 rgba16f；bloom mip 常驻；内存上限 2.5× 图像字节数                                                                                         |
| P2-17 | 预计算异步化 | GF/haze/blur/flare 在 worker 线程与渲染帧重叠；Android 分块从 2048 下调（建议 1024）以适配移动 GPU                                                     |
| P2-18 | 回归与基准   | CPU f64 参考实现逐 stage + golden image + 性能基准纳入 CI                                                                                              |

## 6. 验收指标与测试方法

### 6.1 指标定义

- **色彩**：24 色卡 ΔE2000（均值/最大）。
- **一致性**：预览 vs 导出（缩放到同尺寸）SSIM、锐化高频能量比。
- **光晕**：阶跃边缘过冲率 =（过冲峰值 − 平台值）/（阶跃幅度）。
- **降噪**：合成噪声 PSNR / SSIM；细节 MTF50。
- **渐变**：灰阶渐变 8bit PSNR ≥ 45 dB（含 dither）。
- **性能**：1080p 预览帧时间 P95 ≤ 16 ms；45MP 导出 ≤ 20 s（RTX 3060 基准）；内存峰值 ≤ 2.5× 原图字节。

### 6.2 测试方法

1. **CPU 参考实现**：把关键 stage（降噪、锐化、去雾、色调映射）移植为 f64 CPU 版本，逐像素对比 GPU 输出（容差 1e-3），放入 `cargo test`。
2. **Golden image**：色卡、14 级灰阶、高反差边缘、天空/逆光、人像、ISO 噪声合成 6 组，固定参数快照；在 CI 用 Mesa llvmpipe（wgpu Vulkan 软件后端）跑 256×256 离屏渲染，ΔE/SSIM 门禁。
3. **性能基准**：开启 wgpu timestamp query，记录各 stage 耗时；每次合并生成对比表存档。
4. **真机抽检**：Android arm64 与 macOS Apple Silicon 各跑一次 golden 集，确认 fp16 与纹理上限差异。

## 7. 实施阶段与依赖

| 阶段 | 内容          | 依赖                 | 交付                                              |
| ---- | ------------- | -------------------- | ------------------------------------------------- |
| M1   | P0-1 + P0-2   | 无                   | 修正预览/导出一致性与边缘过冲，改面最小、先立口碑 |
| M2   | P0-3 + P0-4   | 需要 EXIF ISO 传入   | 降噪噪声模型与局部空气光                          |
| M3   | P0-5 + P0-6   | 需要 golden 资产     | 色调映射校准与光效物理化                          |
| M4   | P1-7/8/9      | M1 的 `render_scale` | 导出与 HDR 显示链路                               |
| M5   | P1-10 ~ P1-14 | 独立，可并行         | 单项功能增强                                      |
| M6   | P2-15 ~ P2-18 | 需在 M1–M3 后重构    | Render Graph、异步预计算、CI 基准                 |

建议每个阶段单独 PR；M1 与 M2/M3 不改同一段代码，便于独立回滚。P2-15 是结构性重构，必须建立在 golden 测试（P2-18 的一部分）就绪之后。

## 8. 风险与回滚

- **观感变化**：P0-1/P0-5 会改变现有出图（属修正），需在 Release 说明与设置中提供"旧版强度"对照截图；不做隐式开关。
- **性能回退**：bloom mip 链与双边引导增加开销，设性能预算门禁（P95 超 10% 即阻断合并）。
- **Android 兼容**：最大纹理尺寸、fp16 支持、2048 分块显存占用需真机验证；必要时 P2-17 先落地。
- **Shader 变体膨胀**：新增特性位会拉长首次编译，考虑按需预编译常用组合。
- **回滚策略**：所有改动按阶段独立 PR；P0-1 若出现观感争议可把 `render_scale` 固定为 1.0 快速回退，不影响其它阶段。

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
