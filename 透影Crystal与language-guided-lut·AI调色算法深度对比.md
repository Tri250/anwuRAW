# 透影 Crystal（release v2.1.17 · Android 端 AI调色）与 language-guided-lut 算法深度对比

> 对比基准：透影 Crystal `2.1.17`（`src-tauri/Cargo.toml` / `tauri.conf.json` 一致）Android 端「调色 → 色彩匹配（AI 追色）」功能
> 参照对象：[Leipengpeng/language-guided-lut](https://github.com/Leipengpeng/language-guided-lut) v2.8.0（语言引导 3D LUT 调色系统）
> 分析方法：逐行通读双方核心算法源码，按「管线架构 → 数学模型 → 空间/统计量 → 输出形态 → 质量保障 → 工程链路」六层展开

---

## 0. 双方定位一句话

| | 透影 Crystal v2.1.17（AI 追色） | language-guided-lut v2.8.0 |
| --- | --- | --- |
| 一句话 | **样片统计 → 反解为管线既有滑杆参数补丁**，与渲染管线强耦合，可编辑、可撤销、可复位 | **语言/参考图 → 全局 RGB 变换 → 导出独立 3D LUT 文件**，与编辑器解耦，可移植到任何支持 .cube 的软件 |
| 产品形态 | 照片编辑器内置功能（实时预览、无损参数） | Codex Skill + Python CLI（离线拟合、文件交付） |

**代码锚点**

- 本项目前端（Android 移动层）：[CrystalCategoryPanel.tsx#L211-L292](file:///workspace/src/components/mobile/CrystalCategoryPanel.tsx#L211-L292) `handleColorMatch`
- 本项目后端算法：[color_transfer.rs](file:///workspace/src-tauri/src/color_transfer.rs)（`compute_color_match` → `compute_color_transfer`，共 729 行）
- 参照仓库核心：`skills/color-match-lut/scripts/color_match_lut.py`（参考图追色）、`text_style_lut.py`（文本引导）、`references/algorithms.md`（算法文档）、`benchmark_backends/reference_match_backend.py`（reference-match 后端）

---

## 1. 管线架构对比

### 1.1 Crystal：三阶段参数反解管线（color_transfer.rs）

```
样片/客片 各缩略至 384px（ANALYSIS_DIM, L227）
  → 线性 sRGB 统计（全局均值 + S/M/H 分区均值 + 亮度直方图）
  → 阶段1 全局 tint 拟合（L419-425：v = μ_sample − μ_target → fit_tint 360° 色相网格搜索最小二乘）
  → 阶段2 分区残余 tint 拟合（L433-450：逐分区残差 - 全局已覆盖部分）
  → 阶段3 模拟 tint 后编码域 → 逐通道 7 分位数曲线拟合（L452-480, fit_curves_quantile）
  → 输出 JSON 补丁 { colorGrading{global,shadows,midtones,highlights}, curves{red,green,blue} }（L520-564）
  → 前端浅合并进 adjustments + activeTools 激活 + 50 步撤销栈（CrystalCategoryPanel L256-282）
```

关键性质：**输出不是像素，是参数**。拟合时精确模拟 shader.wgsl 的执行语义（`apply_color_grading` 分区强度 `[0.1, 0.6, 0.8]` / `[0.5, 0.8, 1.0]`，tint 值 ÷500，HSV 色轮纯色），保证补丁落到 GPU 管线后与拟合时的预测一致（L8-L11、L21-L22 注释明确声明了这组对应关系）。

### 1.2 language-guided-lut：统计融合 + MKL 传输 + LUT 烘焙管线

```
路径A（语言引导）: 文本提示 + 小图(1080px) → 外部图像编辑模型生成 styled.png 参考图
路径B（参考追色）: 直接两张照片
  → ICC 归一化 sRGB + EXIF 转正，拟合视图长边 1024
  → 确定性步长采样 ~8 万像素（collect_stats, L151-161）
  → Oklab 空间计算 Gaussian 统计 (μ, C + 1e-6·I)（gaussian_stats, L143-148）
  → [多图时] 五种融合方法：pooled / mean-cov / bures(W2 重心) / robust-bures / pairwise（L214-230）
  → MKL 线性最优传输：A = C_s^(-1/2)(C_s^(1/2) C_t C_s^(1/2))^(1/2) C_s^(-1/2)，b = μ_t − A·μ_s（transport, L233-240）
  → 对 65³ RGB 网格逐点求值 → 导出 .cube（grid/write_cube, L294-309）
  → 从磁盘重载 LUT，三线性插值套回原尺寸照片（apply_cube, L343-348）
```

另有 `--method auto` 路由（text_style_lut.py）：近中性黑白图 → MKL/Oklab 等RGB输出通道；彩色参考 → 可选 ColorFM-L 学习后端；`reference_match_backend.py` 则是上游 reference-match 项目的兼容后端（Rec.709 gamma 2.4 域，「Oklab 亮度单调 + 分区色度直方图匹配」，L125）。

### 1.3 架构差异的本质

| | Crystal | language-guided-lut |
| --- | --- | --- |
| 变换承载物 | 管线参数（滑杆+曲线） | 独立函数表（65³ LUT） |
| 与渲染关系 | 拟合即模拟，参数即渲染 | 拟合后烘焙，应用是插值近似 |
| 可移植性 | 仅本项目（参数 schema 专有） | 任意支持 .cube 的软件 |
| 可编辑性 | 用户可直接微调每个滑杆/曲线点 | 只能整体调强度/重拟合 |
| 空间自适应 | **有**（S/M/H 三区） | **无**（全局 LUT，README 明示「不识别天空、人脸或衣服」） |

---

## 2. 数学模型核心差异（最深一层）

### 2.1 颜色空间：线性 sRGB vs Oklab

- **Crystal**：统计与 tint 拟合全部在**线性 sRGB** 域（`to_linear`，L68-74），曲线拟合在**编码 sRGB** 域（0..255，L292-294）。选线性域的原因是要与 GPU 管线的 tint 执行域对齐（shader 在线性域加性 tint，L9）。
- **参照**：全程 **Oklab**（`to_oklab`/`from_oklab`，L112-129）。Oklab 是感知均匀空间，其欧氏统计量更接近人眼对色彩分布的感受，协方差匹配在 Oklab 中对色度/亮度的耦合更合理。

**影响**：同一组图片，线性 RGB 的均值差会被高光通道的高数值主导（R 通道均值受亮部支配）；Oklab 的 L 轴与亮度感知对齐，a/b 轴与色度感知对齐。**参照仓库的统计表达更符合感知；Crystal 选择线性域是「管线对齐」优先的正确工程折衷**——因为它必须把结果反解为 shader 里定义好的滑杆语义。

### 2.2 统计量：1 阶矩 + 边缘分位数 vs 1+2 阶矩联合匹配

这是双方最根本的算法分野：

**Crystal（均值 + 分位数）**

- 匹配目标 1：全局线性均值差 `v = μ_s − μ_t`（L419-423）——**只匹配 1 阶矩**
- 匹配目标 2：逐通道 7 分位数曲线 `[0.02, 0.15, 0.35, 0.5, 0.65, 0.85, 0.98]`（L299）——这是**逐通道边缘分布**的匹配（直方图匹配的稀疏控制点版本），能捕捉逐通道非线性（如「高光压蓝」），但**不捕捉通道间相关性**（如「饱和时偏青」这类跨通道交互）
- 分区残余：S/M/H 三区各自匹配分区均值差减去全局已覆盖部分（L438-442），提供亮度轴上的分布匹配

**language-guided-lut（MKL 最优传输）**

- 匹配目标：均值 + **全 3×3 协方差**。`f(x) = A·x + b` 是两个高斯分布之间 2-Wasserstein 距离的闭式最优传输映射（Pitié & Kokaram 2007 线性颜色迁移），把源分布的**色彩相关结构**整体搬运到目标
- 严格校验：每个 MKL 分量断言 `A·C_s·Aᵀ ≈ C_t` 相对误差 < 1e-5，失败显式报错（L237-239）；特征分解对负指数幂只加相对下限，明确禁止对嵌套协方差正平方根做固定 1e-6 截断（L138-139，algorithms.md L63）——避免人为放大色度

**结论**：
- 数学完备性上 **MKL > Crystal**：MKL 匹配联合分布的 2 阶矩（12 自由度仿射），Crystal 的 tint 只匹配均值投影（每区 3 自由度，且受色轮参数化约束），曲线补充逐通道边缘分布（每通道 7 点单调）。对于「风格整体色偏 + 对比结构」类样片，MKL 的色彩交互还原能力更强。
- 但 Crystal 的**分区机制是参照仓库不具备的维度**：MKL 是纯全局映射（README 明确承认 LUT「不会识别天空、人脸」），而 Crystal 能表达「暗部偏青、高光偏暖」这类**亮度分区风格**——参照仓库要表达同样效果只能靠外部生成模型在参考图里做出来，再被全局 LUT 近似（这正是其报告里记录 RMSE 局限的原因）。

### 2.3 变换模型：参数化反解 vs 自由仿射

**Crystal `fit_tint`（L160-208）**——把期望偏移向量 `v` 投影到管线可表达的参数曲面：

- 固定 hue ∈ 0..360 网格逐一度搜索，每个 hue 下对正交色度分量 `u = v − mean(v)` 做最小二乘求饱和度 `s = ⟨u, d_c⟩/⟨d_c, d_c⟩`
- **只接受 s > 0**（L192-194，因 shader 仅 saturation>0 时叠加 tint），并钳制到 shader 域 ±0.2
- 纯亮度偏移（u_norm→0）时退化为纯 luminance 滑杆（L165-171）
- 这是**受限参数化**：表达域 = 3 个色轮方向 × 3 个分区，信息必然有损，残余交给曲线阶段弥补

**参照 `transport`（L233-240）**——自由 3×3 仿射矩阵，无参数化约束，配合 `mapping()`（L280-285）的 `tone_strength`（L 轴）/ `color_strength`（a/b 轴）/ 全局 `strength ∈ [0,1]` 三级强度缩放（对 `f(x) − x` 分轴缩放）。

**影响**：Crystal 的反解精度受限于滑杆语义（这正是「可编辑」的代价）；参照的仿射映射精度更高但结果不可拆解为用户可理解的参数。两条路线是同一权衡（表达力 ⇄ 可控性）的两个端点。

### 2.4 曲线 vs LUT 的近似能力

- Crystal 曲线：7 控制点/通道，端点线性外推锚定 0/255（L321-333），x 严格递增 + y 单调不减整理（L340-349），恒等检测（所有点 |y−x|<1.5 则不输出，L352-354）。渲染端 monotone cubic 插值，**对单调映射可近乎精确复原**（L294 注释）。
- 参照 LUT：65³ = 274,625 个格点，三线性插值。LUT 是完整 3D 映射（可表达通道交叉），但**是采样近似**——README 明示「LUT 是采样近似，不是对整个连续色域数学上无损」；其报告会记录 LUT 回灌与 PNG 套用的一致性误差（RMSE/P95）。

有趣的对照：**双方都做了「拟合结果 → 实际渲染」的一致性自洽**——Crystal 通过拟合阶段完整模拟 shader 语义实现零近似差；参照通过 LUT 回灌测量实现误差量化。方向相反：一个前向保证，一个后向测量。

---

## 3. 多图与强度能力对比

| 能力 | Crystal | language-guided-lut |
| --- | --- | --- |
| 样片数量 | 单样片 → 单客片 | 支持多内容图 × 多风格图 |
| 多图融合 | 无 | pooled（混合分布）/ mean-cov（统计平均）/ **bures（W2 高斯重心，Álvarez-Esteban 固定点算法，收敛阈值 1e-9/残差 1e-7/256 轮）**/ robust-bures（W2 medoid + MAD 软裁剪降权，`median + 2.5×1.4826×MAD`）/ pairwise（映射平均）/ anchor |
| 强度控制 | 无前置强度——但输出是滑杆参数，用户可事后无损微调（等效于事后强度） | `strength/tone_strength/color_strength ∈ [0,1]` 前置数学缩放；reference-match 后端默认 `match_strength=90` |
| 保护机制 | 端点外推钳制、单调整理、恒等检测、sat>0 约束（均为拟合稳定性保护） | `protect_skin / protect_saturation / protect_contrast`（reference-match 后端 L60-66）+ CLIP 语义守卫（`clip_semantic_guard.py`，验证参考图与原图语义一致才允许拟合） |

**值得注意**：Crystal 没有「肤色保护/语义守卫」，但它的风险模型不同——追色结果以滑杆参数呈现，用户在 UI 上立刻可见且可撤销（50 步撤销栈 + 基准态快照），属于「人在回路」纠错；参照仓库的 LUT 一旦导出就被当作成品文件交付，所以需要 CLIP 语义守卫这类前置自动防线。**防护设计跟随交付形态，双方各自自洽。**

---

## 4. 质量度量与验证对比

| | Crystal | language-guided-lut |
| --- | --- | --- |
| 感知指标 | ΔE76 均值前后对比（1/4 像素抽样，L507-517）+ 卡方亮度直方图距离（32 bin，L393-406）→ toast 显示「ΔE 降低 N%」 | 协方差传输相对误差（1e-5 断言）、barycenter 收敛残差、LUT 回灌 RMSE/P95 |
| 回归测试 | 3 个单测：恒等输入→空补丁；合成样片 ΔE 降 ≥60%；输出值域在滑杆量程内（L684-728） | 参照仓库方法论：像素级 locality（掩膜外逐位不变）+ 参数单调性测试（本项目《AI算法与AI能力改善提升分析》A1 项已识别此差距并计划移植） |
| 报告 | 仅 metrics JSON 返回前端 | 逐任务 run report：图像哈希、路由选择、LUT-到-PNG 校验、全局 LUT 局限性声明 |
| 失败语义 | 空 patch 不写入、toast 报错；barycenter 类比——无（无迭代拟合） | barycenter 不收敛**显式 ArithmeticError，不静默降级**（L188） |

---

## 5. Android 端工程链路差异

| 环节 | Crystal（Android） | language-guided-lut |
| --- | --- | --- |
| 图像读取 | `content://` URI → ContentResolver 读字节 → `load_base_image_from_bytes`（L612-619，专设 Android 分支）；iCloud 占位文件预检（L609-611） | 本地文件 + ICC 归一化 + EXIF 转正 |
| 分析分辨率 | 384px 缩略图（`thumbnail`） | 1024 长边拟合视图 + 8 万步长采样（严格 <16 万） |
| 计算位置 | Tauri 后端 `spawn_blocking`（Rust，同进程） | Python/NumPy CLI（独立进程） |
| 依赖 | 无外部模型、纯 Rust（离线可用、隐私安全） | 文本路径**依赖外部图像编辑生成模型**（云端/宿主）；本地仅拟合与应用 |
| 渲染执行 | 既有 GPU 管线（WGSL `apply_color_grading` + monotone cubic 曲线）实时预览 | 从磁盘重载 .cube，CPU/编辑器三线性插值 |
| 交付物 | adjustments 补丁（进撤销栈） | .cube 文件 + proxy 图 + run report |

**采样规模对比的含义**：Crystal 用 384px（≈147k 像素上限）全量像素统计，无抽样；参照用 1024 长边下 8 万步长采样。两者统计精度都足够（均值/协方差在数万样本下已稳定），Crystal 全量统计在大图上反而更稳，且 384px 的缩略开销更低——**移动端资源约束下的合理选择**。

---

## 6. 总评：差异矩阵与互鉴建议

### 6.1 差异矩阵（按重要度排序）

| # | 维度 | Crystal v2.1.17 | language-guided-lut | 评价 |
| --- | --- | --- | --- | --- |
| 1 | 统计量 | 1 阶矩（均值）+ 逐通道分位数边缘分布 | 1+2 阶矩（均值+全协方差，W2 最优传输） | **参照更强**：跨通道色彩交互还原；Crystal 靠曲线弥补部分差距 |
| 2 | 空间自适应 | S/M/H 三分区（亮度轴） | 无（纯全局） | **Crystal 独有**：分区风格表达是参照仓库结构性缺失 |
| 3 | 颜色空间 | 线性 sRGB（统计）+ 编码 sRGB（曲线） | Oklab 全程 | 参照感知更合理；Crystal 为管线对齐的正确折衷 |
| 4 | 输出形态 | 可编辑参数补丁（无损、可撤销、可微调） | 65³ .cube 文件（可移植、不可拆解） | 定位不同：编辑器内体验 vs 跨软件交付 |
| 5 | 文本引导 | 无 | 语言/语音 → 生成模型 → 参考图（核心卖点） | 参照独有；但依赖外部生成模型，Android 端离线不可复制 |
| 6 | 多图融合 | 无 | 5 种方法（bures W2 重心为默认） | 参照独有：「同一摄影师风格系列」场景 |
| 7 | 强度/保护 | 事后滑杆微调（人在回路） | 前置 tone/color/全局 strength + 肤色/饱和/对比保护 + CLIP 语义守卫 | 两种纠错哲学，各自自洽 |
| 8 | 数值严谨性 | 拟合即模拟 shader（前向自洽）；3 单测 | 协方差不变量断言、显式失败、回灌 RMSE、逐任务报告 | **参照更严谨**（与本项目 A1 审计结论一致） |
| 9 | 移动适配 | content:// 链路、384px 低开销、spawn_blocking、离线 | 桌面 CLI 定位，无移动考虑 | **Crystal 独有**的端侧工程完备性 |

### 6.2 可落地的互鉴建议（按性价比排序）

1. **追色结果一键导出 .cube（低成本，纯增量）**：本项目已有 LUT 基础设施（[lut_processing.rs](file:///workspace/src-tauri/src/lut_processing.rs) 的 `convert_image_to_cube_lut`/`parse_lut_file`），可将追色补丁在 65³ 网格上前向模拟（复用 `compute_color_transfer` 阶段 3 的模拟逻辑）烘焙导出 .cube——补齐参照仓库的「可移植交付」能力，成本最低、收益直接。
2. **协方差对角近似反解（中成本，质量提升主项）**：不必引入完整 MKL——可在现有曲线上叠加「饱和度-亮度交叉」项：用样片/客片的 (luma, chroma) 联合统计拟合 chroma 随 luma 的增益曲线（对角协方差传输的反解形态），即可覆盖 MKL 最有感知价值的主对角分量，仍保持滑杆可编辑语义。
3. **tone/color 分轴强度（低成本）**：借鉴 `mapping()` 的 L 轴/a,b 轴分缩放，在追色 UI 提供「亮度迁移/彩色迁移」两个独立强度——比单一全局强度更符合影调/色调分离的后期习惯。
4. **多样片融合（中成本，影楼场景）**：同风格多样片时，对各图 Gaussian 统计做 W2 重心（Rust 侧 3×3 特征分解 + 固定点迭代约 60 行）后再走现有拟合链，可显著降低单张样片偏差——这是参照仓库「影楼批量追色」核心场景的对应能力。
5. **协方差不变量断言 + 追色回归测试扩充（低成本）**：把参照仓库「拟合结果前向模拟 = 断言目标统计」的自检模式移植进 Rust 单测（本项目 A1 项已规划像素级 locality 测试，追色链路可一并覆盖）。
6. **不建议落地**：文本引导路线依赖外部图像编辑生成模型（隐私/成本/延迟），与本项目「全离线端侧」定位冲突；reference-match 后端的 Rec.709 gamma 2.4 域转换对本项目（直接管线反解）无收益。

### 6.3 结论

两者是**同一问题（未配对颜色迁移）在不同产品约束下的两个最优解**：

- language-guided-lut 把重心放在**数学完备性**（MKL 2 阶矩最优传输、多图 W2 融合、严格数值校验）与**交付可移植性**（.cube）上，其代价是全局映射无空间自适应、文本路径依赖外部生成模型、结果不可编辑。
- Crystal v2.1.17 Android 端 AI 追色把重心放在**管线融合度**（反解为可编辑滑杆/曲线、拟合即模拟保证 GPU 复现、撤销栈闭环）与**端侧可用性**（离线、低开销、ContentResolver 链路）上，其代价是统计量停留在 1 阶矩 + 边缘分位数，跨通道色彩交互的表达力弱于 MKL。

若以「算法上限」论，参照仓库的统计模型领先；若以「产品闭环完整度与端侧工程」论，Crystal 的实现更完整。最具性价比的追赶路径不是照搬 MKL，而是 6.2 节的 1/2/4 项：**在保持「可编辑参数补丁」这一核心优势的前提下，补上协方差对角分量、多样片融合与 .cube 导出**。

---

## 附：关键源码索引

**透影 Crystal v2.1.17**

| 内容 | 位置 |
| --- | --- |
| Android 端追色入口与补丁合并 | [CrystalCategoryPanel.tsx#L211-L292](file:///workspace/src/components/mobile/CrystalCategoryPanel.tsx#L211-L292) |
| 追色命令（Android content:// 读取） | [color_transfer.rs#L605-L640](file:///workspace/src-tauri/src/color_transfer.rs#L605-L640) |
| 三阶段核心算法 | [color_transfer.rs#L408-L574](file:///workspace/src-tauri/src/color_transfer.rs#L408-L574) |
| tint 参数反解（360° 网格搜索） | [color_transfer.rs#L160-L208](file:///workspace/src-tauri/src/color_transfer.rs#L160-L208) |
| 分位数曲线拟合 | [color_transfer.rs#L295-L358](file:///workspace/src-tauri/src/color_transfer.rs#L295-L358) |
| 分区掩膜（shader 对齐） | [color_transfer.rs#L144-L155](file:///workspace/src-tauri/src/color_transfer.rs#L144-L155) |
| LUT 基础设施 | [lut_processing.rs#L480-L604](file:///workspace/src-tauri/src/lut_processing.rs#L480-L604) |

**language-guided-lut v2.8.0（/tmp/language-guided-lut）**

| 内容 | 位置 |
| --- | --- |
| MKL 传输与不变量校验 | `scripts/color_match_lut.py` L233-240 |
| 五种多图融合（bures W2 重心） | `scripts/color_match_lut.py` L164-230 |
| Oklab 转换与高斯统计 | `scripts/color_match_lut.py` L112-161 |
| 分轴强度映射 | `scripts/color_match_lut.py` L280-285 |
| 65³ LUT 网格/导出/三线性应用 | `scripts/color_match_lut.py` L294-348 |
| 算法总文档 | `references/algorithms.md` |
| 文本引导路由（auto） | `scripts/text_style_lut.py` L252-323 |
| reference-match 后端（肤色/强度保护） | `benchmark_backends/reference_match_backend.py` L58-145 |
