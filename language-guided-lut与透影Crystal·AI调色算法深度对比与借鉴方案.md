# language-guided-lut 与透影Crystal（release v2.1.17 Android）AI 调色算法深度对比与借鉴方案

- 对比对象：[Leipengpeng/language-guided-lut](https://github.com/Leipengpeng/language-guided-lut)（v2.8.0，Codex Skill：color-match-lut）
- 本地基线：透影Crystal / RapidRAW `release v2.1.17` Android 端 AI 调色（`ai_auto_enhance` / `calculate_auto_adjustments` / `compute_color_match` / `scene_classify`）
- 结论先行：本地调色引擎是**一阶矩匹配 + 滑杆参数化**，目标仓库是**二阶矩（协方差）传输 + LUT 烘焙**。最值得借鉴的是 MKL/Oklab 协方差传输、强度分解（tone/color）、多图聚合与拟合校验体系；本地独有的非破坏性参数输出、CLIP 场景通道、四面体插值 LUT 链应保留。

---

## 一、两侧 AI 调色能力全景

### 1.1 本地（v2.1.17 Android）

AI 调色共四条链路，全部输出**非破坏性调整参数**（可撤销、可继续编辑）：

| 链路 | 入口 | 核心算法 | 输出 |
|---|---|---|---|
| AI 一键增强 | `AiAutoEnhance` → [platform_features.rs](file:///workspace/src-tauri/src/platform_features.rs#L697-L833) `run_ai_auto_enhance` | 直方图统计自动分析 + CLIP 场景偏置 | exposure/contrast/highlights/shadows/vibrance/structure/sharpness 等 12 参数 |
| 自动色调 | `CalculateAutoAdjustments` → [image_processing.rs](file:///workspace/src-tauri/src/image_processing.rs#L4205-L4465) `perform_auto_analysis` | 1024px 降采样亮度直方图 + p1/p50/p99 分位 + 饱和度均值 + 中心/边缘亮度差 | 同上（无场景偏置） |
| AI 追色 | `ComputeColorMatch` → [color_transfer.rs](file:///workspace/src-tauri/src/color_transfer.rs#L408-L574) `compute_color_transfer` | CIE Lab 均值匹配（全局 tint + 三分区 tint 反解为 colorGrading 滑杆）+ 逐通道分位数匹配曲线 | colorGrading + curves 补丁 + ΔE/卡方度量 |
| 场景配方推荐 | `scene_classify` → [scene_classify.rs](file:///workspace/src-tauri/src/scene_classify.rs) | CLIP 零样本 4 类 × 8 prompt ensemble（softmax 类内平均、批内分位数校准、门槛 0.75）；启发式降级（天空蓝/植被绿/暖色/皮肤比例） | 场景标签 → 大师配方推荐 |

**AI 一键增强的完整数据流**（`run_ai_auto_enhance`）：

1. 原图 1024px 降采样 → 应用基线曝光 → 256 bin 亮度直方图、饱和度均值、中心(25%~75%区域)/边缘亮度均值；
2. 由分位数推导参数：曝光 `(128 - p50) × 0.125`（高光裁剪时钳制 ≤0）、对比度 `(220/range - 1) × 10`、阴影提升、高光压低、自然饱和、去朦胧、清晰度、暗角补偿；
3. 强度三档 `k = 0.6 / 1.0 / 1.4`（曝光额外 ×0.8），结构/锐度默认追加 `12k / 10k`；
4. CLIP 场景偏置：portrait 纹理 ×0.7、night 曝光与纹理 ×0.85、landscape 自然饱和 `+15k`、food 自然饱和 `+10k` 且纹理 ×0.9；
5. CLIP 未下载时降级统计启发式（仍带场景感知，证据更弱）。

**AI 追色的完整数据流**（`compute_color_transfer`）：

1. 样片与客片各缩略至 384px → sRGB 解码到线性域 → CIE Lab；
2. 阶段 1：全局线性均值差 `v = μ_s - μ_t`，拟合为 `sat·s·d(hue) + sat_l·lum·[1,1,1]`（360 格色相最小二乘，s ≥ 0，shader 域 ±0.2）；
3. 阶段 2：三分区（shadow/mid/highlight，smoothstep 权重）残余均值差，按分区 tint 强度（`ZONE_SAT_STRENGTHS=[0.1,0.6,0.8]`）反解；
4. 阶段 3：模拟 tint 后编码域，逐通道 7 分位数匹配构造单调曲线控制点（0/255 端点外推 + 单调整理 + 恒等检测）；
5. 度量：ΔE76 before/after（1/4 抽样）、亮度直方图卡方距离。

**LUT 渲染链**：wgsl 3D LUT **四面体插值**（[shader.wgsl](file:///workspace/src-tauri/src/shaders/shader.wgsl#L1674-L1740) `sample_lut_tetrahedral`），scene-referred/display-referred 检测（`Gamma: sRGB to sRGB` 注释），内置大师 LUT（滨田英明等，注释显示经"参考辅助精修 + prior + CanonCGT 伪监督"生成，33³）。

### 1.2 目标仓库（language-guided-lut v2.8.0）

三段式管线（纯本地拟合，仅参考图生成依赖外部图像编辑器）：

1. **语言 → 参考图**：`text_style_lut.py prepare` 将用户原话 + 固定 guardrails 组成提示词（[text_style_lut.py](file:///tmp/language-guided-lut/skills/color-match-lut/scripts/text_style_lut.py#L35-L58)），交 image_gen 对 1080px 压缩小图生成调色参考；guardrails 强制"同一输入 RGB 在任意位置输出一致、禁蒙版/禁局部染色/禁左右分色/禁重打光/保留肤色与曝光可信"；
2. **统计拟合**：`color_match_lut.py` 在 **Oklab** 空间计算每图高斯统计 `(μ, C)`（长边 1024、确定性步长采样 ~8 万点、协方差加 `1e-6·I` 正则），求解 **MKL 线性传输**（Pitié & Kokaram 2007）：

   ```
   A = C_s^(-1/2) (C_s^(1/2) C_t C_s^(1/2))^(1/2) C_s^(-1/2),  b = μ_t - A μ_s
   ```

   协方差不变式校验 `A C_s Aᵀ ≈ C_t`（相对误差阈值 1e-5）；
3. **导出与应用**：65³ `.cube`（编码 sRGB 全域），三线性插值套回原分辨率；**从磁盘重载 LUT 后再渲染**，2048 抽样像素复核保存 PNG 与 LUT 一致；记录解析-vs-LUT 的 RMSE/p95（8bit）与色域裁切比例。

多图聚合六法（`color_match_lut.py` `METHODS`）：`pooled`（混合分布统计）、`mean-cov`（统计量算术平均）、`bures`（高斯 Wasserstein 重心，Álvarez-Esteban 2016 固定点，≤256 次迭代、残差 <1e-7）、`robust-bures`（W2 medoid + MAD 软截断降权）、`pairwise`（全组合映射按 `w_i·v_j` 平均）、`anchor`（单图基线）。

强度三分解：`strength × tone_strength(L) × color_strength(a/b)`，作用于映射增量 `f(x)-x`，转回 sRGB 后裁切。

其他能力：黑白参考路由（`monochrome.py`：通道差 spread 均值 ≤2 且 >4 的像素占比 ≤1% → 中性灰保亮度输出）；六后端对照（MKL/Oklab、Reinhard/Lab、histogram_lab、ColorFM-L、ModFlows B6、D-LUT、Reference Match）；全链路 sha256 溯源、原子写、固定随机种子。

---

## 二、算法差异深度对比

### 2.1 逐维度对照

| 维度 | 本地 v2.1.17 | language-guided-lut | 差距判定 |
|---|---|---|---|
| 颜色空间 | CIE Lab（追色）/ 亮度直方图 + HSV（场景） | Oklab（感知均匀，解析闭式） | Oklab 对青-黄轴预测更准，Lab 的 a/b 在蓝区非线性畸变更明显 |
| 传输阶数 | **一阶矩**（均值匹配，Reinhard 2001） | **二阶矩**（MKL：均值 + 协方差） | 核心差距：协方差传输可表达"对比度结构 + 色通道相关性"（如日系青透 = a/b 分布整体旋转收缩），均值差 + tint 无法表达 |
| 通道相关性 | 无（各通道独立均值差） | 有（3×3 矩阵整体作用，保持 R/G/B 联合分布形状） | 核心差距 |
| 空间结构 | 三分区 tint（smoothstep 手工权重）+ 逐通道曲线 | 全局高斯（无分区概念） | 本地分区化对"阴影偏青、高光暖"类需求是优势，应保留并与 MKL 结合 |
| 强度控制 | 全局 k（增强）/ 滑杆天然可调 | 强度 × 色调(L) × 色彩(a/b) 分解 | 可借鉴：让"只调氛围不改明暗"成为一阶能力 |
| 语言输入 | **无**（CLIP 仅做 4 类场景分类，不解析调色语言） | 提示词工程 + guardrails → AI 参考图 | 最大功能缺口：本地没有"一句话调色"入口 |
| 场景感知 | CLIP 4 类 + 偏置（portrait/night/landscape/food） | 无显式场景；仅黑白/彩色路由 | 本地优势，保持 |
| 肤色/局部保护 | 场景偏置粗粒度（portrait 纹理收敛） | guardrails 语义级约束参考图生成 | 可借鉴提示词层，本地可转化"分区强度上限" |
| 输出载体 | 非破坏性参数补丁（colorGrading + curves，可撤销/可微调） | 烘焙 3D LUT（跨图一致、可复用、不可再编辑） | 本地优势（可编辑性）；LUT 优势（一致性）二者可融合 |
| 多图融合 | 无（单参考图） | 6 种聚合（bures 默认） | 可借鉴：大师配方自动精修、样张组学习 |
| 验证体系 | ΔE before/after + 卡方（拟合质量） | 哈希溯源、重载校验、解析-vs-LUT RMSE/p95、PNG 2048 像素复核、协方差不变式 | 可借鉴：给现有追色补不变式与一致性校验 |
| LUT 插值 | **四面体插值**（wgsl，GPU 实时） | 三线性插值（CPU） | 本地优势，无需改 |

### 2.2 关键算法差异的本质

1. **一阶 vs 二阶传输（最核心）**
   Reinhard/本地方案对每个通道只做 `x' = σ_t/σ_s·(x-μ_s)+μ_t` 的简化（且本地连逐通道缩放都没做，只做了均值差 → tint/曲线反解），丢失的是**分布形状**：一张低反差灰雾客片追一张高反差胶片样片时，均值匹配只能整体平移，反差结构完全丢失，只能靠分位数曲线事后补救（曲线是事后全局单调修正，无法表达色相旋转）。MKL 的 `A` 矩阵包含通道间相关性（协方差非对角项），一步完成"缩放 + 旋转 + 平移"，这是"调色感"的来源。

2. **分区 vs 全局的信息损失方向**
   本地三分区 tint 是"手工先验的空间结构"，对语言描述中的"阴影偏青"极其友好（可直接落 slider）；MKL 全局传输没有分区概念，全靠语言→参考图中的全局映射承载分区语义。两者不是替代关系：**MKL 提供精确的全局二阶传输，分区结构由本地的 zone 机制补充**——建议在 Oklab 中对每个 zone 分别求 MKL（zone 内高斯统计 → zone 内传输矩阵），既保留分区语义又获得二阶精度。

3. **反解目标不同导致的可编辑性差异**
   本地把任何传输都反解为 12+ 个语义滑杆（`colorGrading.hue/saturation/luminance` + `curves` 控制点），有信息损失但获得完全可编辑性；目标仓库把传输烘焙进 65³ LUT，无损但不可编辑。本地管线中 `fit_tint` 的 360 格色相网格 + 最小二乘已经是很好的反解框架，**升级为 MKL 后只需替换"期望偏移量"的来源，反解框架原样复用**。

4. **验证哲学**
   目标仓库把"数值正确性"当作交付门槛（协方差不变式、重载一致性、保存像素复核）；本地只有 ΔE/卡方两个拟合质量指标，没有"补丁应用后与拟合目标一致"的校验。借鉴成本低、收益直接。

---

## 三、可借鉴补充项（按优先级）

### P0-1 追色引擎升级：Reinhard 均值匹配 → MKL/Oklab 协方差传输

**位置**：[color_transfer.rs](file:///workspace/src-tauri/src/color_transfer.rs#L408-L574) `compute_color_transfer`

**改法**（保持现有管线结构，只替换偏移量来源）：

1. 新增 Oklab 转换（本地已有 sRGB→Lab 矩阵，Oklab 两组 3×3 常数直接抄目标仓库 `to_oklab/from_oklab`）；
2. 对 (样片, 客片) 各算 `(μ, C)`（C 加 `1e-6·I` 正则，特征分解用 `ndarray` 或手写 3×3 Jacobi——无需新依赖）；
3. 求解 `A, b`，做协方差不变式校验（相对误差 >1e-5 时报错降级旧路径）；
4. **分区化**：按现有 `zone_masks` 把像素分入 shadow/mid/highlight，每个 zone 内分别求 MKL → 得到 3 个 `(A_z, b_z)`；这与现有"阶段 2 分区残余"结构天然对齐；
5. 期望偏移量从"均值差"改为"**MKL 仿射增量在缩略图像素上的平均/分区平均**"，后续 `fit_tint` + `fit_curves_quantile` 反解框架不动；
6. 强度参数化：追加 `tone/color` 双强度（L 轴与 a/b 轴分别缩放 `f(x)-x`），映射到现有滑杆即"明暗类参数 vs 色彩类参数"分组。

**验收**：沿用现有测试（`test_synthetic_match_reduces_delta_e`：ΔE 下降 ≥60%）+ 新增协方差保持率指标 `trace(A·C_s·Aᵀ)/trace(C_t) ≈ 1`。

### P0-2 强度分解（tone / color 双强度）

本地增强三档 k 是全局线性缩放，`exposure × 0.8` 是唯一的手工不对称。借鉴 `strength/tone_strength/color_strength` 三分解：在 `run_ai_auto_enhance` 与 `compute_color_transfer` 中把参数分为明暗组（exposure/contrast/highlights/shadows/whites/blacks）与色彩组（vibrance/tint/curves），分别施加强度系数。前端 AI 面板可加"明暗/色彩"双强度滑杆（复用 `CxSliderRow`）。

### P0-3 语言引导调色入口（一句话调色）——最大功能缺口

本地已有 CLIP 模型与 prompt ensemble 机制（`scene_classify` 32 条提示一次前向），扩展成本低：

- **方案 A（纯本地，零成本，建议先做）**：把"调色语言"当作零样本分类输入。新增风格 prompt 集（如 `清透日系/电影感/复古胶片/黑白/森系/赛博` 每类 6-8 条中英提示，走同一 `clip_scene_probabilities` 框架），softmax 概率 × 预置参数配方（如"阴影偏青"= shadows tint hue≈190 + 负 luminance），概率作为强度权重。完全复用现有 CLIP 会话与批校准机制，无网络依赖。
- **方案 B（云链路，对齐目标仓库两段式）**：走现有 `aiProvider` 云通道：`prepare`（原图缩 1080px JPEG + guardrails 提示词）→ 云返回调色参考小图 → `finish`（参考图 vs 上传图本地拟合，P0-1 的 MKL 引擎）→ 反解为非破坏性参数。guardrails 直接借鉴目标仓库 `GRADE_GUARDRAILS`（中译即可）：同色同输出、禁蒙版/局部/左右分色/重打光、保留肤色与曝光可信。小图上传 + 本地拟合的架构与本地隐私姿态一致（原图不出端）。
- 风险控制：参考图质量校验（宽高比偏差 >2% 拒绝，借鉴目标仓库 `aspect_error` 检查）；AI 失败不阻塞编辑（沿用现有静默降级模式）。

### P1-1 拟合校验体系

在 `compute_color_transfer` 返回值中补：MKL 协方差不变式误差、分区传输覆盖率、曲线单调性标记；参照目标仓库做法对"补丁重放一致性"做缩略图回归（用现有 `apply_curve_map` 模拟即可）。

### P1-2 多图聚合用于大师配方精修

本地已有 `master-recipes.json` + 4 个大师 LUT（手工/伪监督生成）。借鉴 `bures`/`pooled` 聚合：对同一摄影师多张样张分别算 Oklab 高斯统计 → bures 重心 → 得到"该摄影师稳定风格"的传输目标 → 反解为配方参数或精修 LUT。这为"大师配方"提供数据驱动的校准回路，替代纯手工调参。`robust-bures` 的 medoid+MAD 降权可直接排除偏离样张。

### P1-3 黑白参考路由

目标仓库 `classify_reference` 仅 ~10 行（通道 spread 统计），可低成本移植：追色时检测样片是否近中性（mean_spread ≤2 且 >4 占比 ≤1%），是则走"保亮度中性输出"路径（LUT 侧可直接输出中性灰立方体；参数侧走 contrast/curves 而跳过 tint），避免黑白样片把客片染上伪彩色。

### P2 学习型后端（暂不建议）

ColorFM-L / D-LUT / ModFlows 需要 PyTorch 级运行时。本地推理设施是 ONNX Runtime（ort）+ 模型下载管理，若未来要做，优先评估 ColorFM-L 转 ONNX 的轻量路径；当前统计方案（MKL）在无训练数据、无新增模型体积的前提下已能覆盖主要收益。

---

## 四、保留不动的本地优势

1. **非破坏性参数输出**：追色/增强结果全部是可撤销、可二次编辑的调整补丁，与目标仓库的烘焙 LUT 相比更契合修图工作流；
2. **CLIP 场景通道 + 批内校准**：目标仓库完全没有场景感知；
3. **四面体插值 LUT 实时链**：优于目标仓库的三线性 CPU 插值；
4. **ΔE/卡方度量与 honesty 降级链**（aiSource 如实上报）与目标仓库的"可诊断性契约"理念一致，继续坚持。

---

## 五、落地路线建议

| 阶段 | 内容 | 依赖 |
|---|---|---|
| 1 | P0-1 MKL/Oklab 分区传输替换 `compute_color_transfer` 偏移量来源 + 不变式校验 + 测试 | 无新增依赖（ndarray 已有） |
| 2 | P0-3 方案 A：CLIP 风格零样本 + 参数配方（一句话调色本地版） | 无（复用现有 CLIP） |
| 3 | P0-2 明暗/色彩双强度（追色 + 增强 + 前端双滑杆） | 阶段 1 |
| 4 | P1-1/P1-3 校验体系 + 黑白路由 | 阶段 1 |
| 5 | P0-3 方案 B 云参考图链路（可选）+ P1-2 大师配方 bures 精修 | aiProvider 云通道 |

---

## 六、落地记录（v2.1.17，已实施）

| 阶段 | 内容 | 落点 |
|---|---|---|
| 1 | Oklab + MKL 分区协方差传输：`to_oklab/from_oklab`、3×3 对称特征分解（Jacobi）、`psd_power`、`mkl_transport`（A,b + 不变式校验 ≤1e-5）、逐像素分区加权增量、强度三分解（strength/tone/color）、协方差/均值不可用时降级一阶矩 | [color_transfer.rs](file:///workspace/src-tauri/src/color_transfer.rs)（新增数学层 ~260 行 + 重写 `compute_color_transfer` 阶段 0-3） |
| 4 | 黑白参考路由（通道 spread 统计，跳过 tint 仅走曲线）+ MKL 诊断度量（mklUsed / mklInvariantError / monochromeReference） | 同文件 `classify_monochrome` 与 metrics |
| 3 | AI 一键增强明暗/色彩双强度：`ai_auto_enhance(toneStrength, colorStrength)`，色彩组 = vibrance/saturation/temperature/tint，其余归明暗组 | [platform_features.rs](file:///workspace/src-tauri/src/platform_features.rs) `run_ai_auto_enhance` + [CrystalAiToolsPanel.tsx](file:///workspace/src/components/mobile/CrystalAiToolsPanel.tsx) 双滑杆 |
| 2 | 一句话调色（方案 A 本地实现）：8 风格 × 双语词库（加权命中 + 置信度换算）+ 非破坏性参数配方（colorGrading + curves + 基础滑杆）；未命中不猜测 | 新增 [style_suggest.rs](file:///workspace/src-tauri/src/style_suggest.rs)（含命令 `ai_style_suggest`）+ 移动端输入 UI |

**实现说明与偏差**：
- 方案 A 原设计为 CLIP 零样本风格识别，实施时发现项目 CLIP 为图文联合 ONNX 导出（forward 必须同时喂图），无纯文本编码通路，text→text 比对不可行；故改为确定性双语词库映射（零依赖、瞬时、可测试），CLIP 场景通道保持不变。云端参考图链路（方案 B）仍按原计划作为后续项。
- 追色强度参数通过 `compute_color_match(strength/toneStrength/colorStrength)` 暴露，移动端调用向后兼容（默认 1.0）。
- 数学层独立验证：Oklab 往返 <1e-6、特征分解重建 <1e-10、MKL 不变式误差 2.8e-11、协方差映射最大相对误差 5.3e-9、强度分解冻结语义正确、退化输入拒绝。

**测试暴露并修复的真 bug**：`classify_monochrome` 的 spread 阈值（2/4/12）为 0..255 域，而生产路径传入 0..1 归一化像素，会导致所有彩色照片被误判为黑白、跳过 tint 拟合；已在函数内统一换算至 0..255 域（`test_monochrome_classification` 回归覆盖）。

**验证状态**：`cargo test --lib` 104/104 通过（color_transfer 10 + style_suggest 5 + 其余 89 无回归）；`tsc --noEmit` 无错误；`cargo check --lib` 零警告。移动端 UI：AI 工具面板新增「一句话调色」磁贴与输入行、明暗/色彩双强度滑杆，词条走 i18n（zh-CN/en 双语）。

**未实施（后续项）**：方案 B 云参考图链路、大师配方 bures 聚合精修（P1-2）、ColorFM-L 学习型后端（P2，不建议）。
