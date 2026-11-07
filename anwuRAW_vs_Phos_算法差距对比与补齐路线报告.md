# anwuRAW（透影Crystal）× Phos 算法差距对比与补齐路线报告

> 调研方法：对 `Zenodeng/Phos`（Swift + Core Image，macOS 原生）与 `Tri250/anwuRAW`（RapidRAW 深度改造分支，Tauri + Rust/wgpu）双仓库源码级走读，结论均落到具体文件与函数。
> 报告日期：2026-11-07

---

## 1. 执行摘要

**总体结论：anwuRAW 的整体算法能力已领先 Phos 一个身位**（自研 WGSL 管线、BM3D/边缘感知降噪、AgX/ACES 色调映射、SAM 系 AI 蒙版、专业色彩管理）。剩余差距集中在 **4 个核心模块**，全部位于"苹果生态深度"与"AI 编辑严谨性"两个象限，另有 4 个低成本 parity 小项。

| 编号 | 差距模块 | 严重度 | 实施成本 | 性质 |
|---|---|---|---|---|
| G1 | Apple RAW 一等公民解码路径 | ★★★ | 低–中 | 架构调整 + 缓存治理 |
| G2 | 人像 disparity 原生深度接入散景 | ★★★ | 中 | 纯移植（Phos 方案可直接抄） |
| G3 | 本地 VLM 一键编辑计划（带护栏） | ★★★ | 中 | 移植护栏层 + 新增本地推理通路 |
| G4 | 自动影调保守求解器 | ★★ | 中 | 求解端重写，管线零改动 |
| G5 | 黑白通道混合 / 曲线后饱和回拉等 parity 项 | ★ | 低 | 小特性补齐 |

**明确不需要追的**：渲染管线架构、降噪、色调映射、AI 蒙版模型、色彩管理、示波器、润饰工具、合成工作流——anwuRAW 全部反超（详见 §5）。

---

## 2. 技术底座对照（差距的根源）

| 维度 | Phos | anwuRAW |
|---|---|---|
| RAW 解码 | `CIRAWFilter`（Apple 官方，主路径）| `rawler`（纯 Rust，主路径）+ Apple RAW 9 兜底 |
| 渲染核心 | CIFilter 串行链（系统滤镜组合，无自研 shader） | 自研 WGSL compute pipeline（主 shader 2220 行 + 5 特效 shader） |
| 色调映射 | 无 | AgX / ACES Filmic / PBR Neutral 三选一 |
| 工作域 | sRGB 显示域 ↔ 线性域切换 | 线性 sRGB + V-Log 场景参照域 |
| 导出色彩管理 | sRGB 为主，16bit TIFF | P3 / ProPhoto / Rec.2020 / sRGB + Bradford D65→D50 + ICC 生成嵌入 |
| AI 推理 | MLX-VLM 本地服务（127.0.0.1:8765） | ONNX Runtime（SAM/BiRefNet/ESAM3/LaMa/DepthAnything/NIND/CLIP）+ 云端 API |
| 平台 | macOS 26+ Apple Silicon | Win / macOS / Linux / Android |

**根源判断**：anwuRAW 的差距不是"算不过来"，而是**解码器选型**（跨平台库 vs 苹果原生）与**AI 产品化深度**（词库映射 vs VLM 计划）这两个选型副作用。

---

## 3. 四大核心差距详解与实现路径

### G1. Apple RAW 解码：从"兜底"升为"主路径"（★★★）

**差距现状**

- Phos：`CIRAWFilter(imageURL:)` 是唯一 RAW 入口（[Engine.swift L28-48](file:///tmp/Phos/Sources/Phos/Engine.swift#L28-L48)），享受 Apple 持续更新的机身调校、双 illuminant 矩阵、ProRAW 与最新机型开箱支持。
- anwuRAW：CIRAWFilter 路径（[apple_raw.rs](file:///tmp/anwuRAW/src-tauri/src/apple_raw.rs)）仅 `#[cfg(target_os = "macos")]` 编译，且只在 rawler 解码失败时 fallback；新机身首日支持、Apple 色彩科学（dual-illuminant、gamut 压缩的官方实现）全部拿不到。

**实现路径**

1. **解码器设置化**：`app_settings.rs` 增加 `raw_decoder: auto | apple | rawler`（macOS 有效，其他平台忽略），设置面板（`src/components/panel/settings`）暴露选项。
2. **解码分派改造**：`raw_processing.rs` 的 `develop_raw_image()` 按 setting 分派；`auto` 策略 = rawler 优先、失败或机型不识别时静默走 `develop_raw9`。
3. **管线指纹兼容**：解码器 ID 计入 [raw_processing.rs L24-L27](file:///tmp/anwuRAW/src-tauri/src/raw_processing.rs#L24-L27) 的 pipeline identity 哈希，避免缩略图/预览缓存脏读（该机制已存在，只需加字段）。
4. **域语义对齐**：CIRAWFilter 输出为渲染后图像，需确保 `is_raw_image` 标志（shader.wgsl 内区分线性/编码域的开关）与 rawler 路径语义一致，防止二次 sRGB 编码。
5. **验收标准**：同一 ARW/CR3 文件在两种解码器下直方图与白平衡基准一致；切换解码器后缓存自动失效；bench/compare-renders.sh 回归通过。

**风险**：Apple 路径输出的域与 rawler 不同，需要严格测试 NR/锐化等 RAW 域感知算法在非 RAW 标志下的表现。

---

### G2. 人像 disparity 原生深度接入散景（★★★）

**差距现状**

- Phos：Bokeh 深度源 = **文件内嵌人像 disparity 辅助数据**（双摄/LiDAR 实拍深度）或手绘深度蒙版（[Engine.swift L363-366](file:///tmp/Phos/Sources/Phos/Engine.swift#L363-L366)，`CIMaskedVariableBlur` 执行）。
- anwuRAW：lens_blur（[lens_blur.rs](file:///tmp/anwuRAW/src-tauri/src/lens_blur.rs)）只吃前端传入的 `lensBlurDepthMap`（Depth Anything V2 单目估计）。估计深度在发丝、玻璃、重复纹理处必然出错；全仓库无 `disparity` 读取（已 grep 验证，仅 fog.rs 内部变量重名）。

**实现路径**

1. **内嵌深度读取**（macOS）：用 ImageIO `CGImageSourceCopyAuxiliaryDataInfoAtIndex`（`kCGImageAuxiliaryDataInfoDisparity/AuxiliaryPortraitEffectsMatte`）提取 disparity 图，输出灰度 bitmap。建议新建 `depth_loader.rs`。
2. **深度源协议扩展**：`RenderRequest`/lensBlur adjustments 增加 `depth_source: embedded | ai | manual` 字段；内嵌深度与现有 AI 深度走同一 bitmap 通道（base64 → 纹理），前端深度提供方（生成 `lensBlurDepthMap` 的 hook）按优先级链取值：**内嵌 disparity > AI 估计 > 手绘**。
3. **缓存治理**：内嵌深度按图片 SHA-256 缓存（复用 AI 深度缓存目录与 `cache_utils.rs` 机制），零额外成本。
4. **验收标准**：Apple 人像 HEIC 的散景边缘（发丝级）明显优于 AI 估计版本；无内嵌深度的图自动降级 AI 估计；bench 回归无退化。

**说明**：此为**纯移植**工作，Phos 的深度来源优先级设计与 UI 文案可直接借鉴；执行侧复用现成的 lens_blur 采样内核（BokehTap），无需动 shader。

---

### G3. 本地 VLM 一键编辑计划 + 护栏层（★★★）

**差距现状**

- Phos：`LocalPhotoAI` 用本地 MLX-VLM 把自然语言转成 **PhotoAIPlan 结构化 JSON**（全局参数 + ≤4 个区域蒙版 + curves/hsl/grading），护栏完备（[LocalPhotoAI.swift](file:///tmp/Phos/Sources/Phos/LocalPhotoAI.swift)）：
  - 参数**键白名单**（`ParameterDescriptor.all` 过滤裁切/散景等危险键）
  - 每键**范围硬校验**，任一越界 → **整体拒绝**（不是截断）
  - summary ≤1000 字、响应 ≤40KB、蒙版 ≤4 个
  - 确定性前置：裁切百分比/旋转用**正则直接解析**，不信任模型（[PhotoAICapabilities.swift](file:///tmp/Phos/Sources/Phos/PhotoAICapabilities.swift)）
- anwuRAW：`style_suggest.rs`（[style_suggest.rs](file:///tmp/anwuRAW/src-tauri/src/style_suggest.rs)）为本地双语词库加权映射，命中失败即 `confidence=0` 回退云端 AI 一键增强；离线语义覆盖弱一档，且无计划级护栏。

**实现路径**

1. **定义 Plan Schema**：与现有 adjustments schema 同构（复用 `adjustment_utils.rs` 的键与范围表）+ `masks[] ≤ 4` + curves/hsl/grading 子对象；输出即为标准 patch（天然可撤销、可二次编辑）。
2. **护栏验证层**（新建 `plan_validator.rs`，纯移植 Phos 逻辑）：
   - 键白名单校验（未知键 → 拒绝）
   - 逐键范围校验（越界 → 整体拒绝）
   - 蒙版数上限、summary 长度、响应体积上限
   - 原则：**模型输出只能落在既有滑杆值域内，不能发明新参数**
3. **本地推理通路**：`ai_connector.rs` 增加 Ollama 兼容的 localhost provider（HTTP，超时与错误走 `ai_jobs.rs` 任务队列现有 UI）；推荐支持 MLX-VLM（macOS）与 Qwen-VL 类小模型（跨平台）两种后端。
4. **确定性前置层**：裁切百分比、旋转角度、"不裁切"等指令用正则解析直接生成 patch，模型只处理语义模糊部分（照抄 PhotoAI 的 explicit crop 思路）。
5. **降级链**：正则命中 → 直出；否则 VLM 计划；VLM 不可用 → 现有词库 `style_suggest`；全失败 → 云端（如已配置）。
6. **验收标准**：注入越界/未知键/超量蒙版的对抗样本全部被整体拒绝；断网状态下一句话调色可用率显著高于词库方案；所有计划产物可一键撤销。

**说明**：这是**投入产出比最高**的一项——anwuRAW 的 patch 基础设施、任务队列、模型治理（`model_registry.rs` SHA256 固定 + `model_residency.rs` 驻留策略）全部现成，唯一要写的是护栏层与本地 provider。

---

### G4. 自动影调保守求解器（★★）

**差距现状**

- Phos：`AutoTone` 两段式 `measure → solve`（[AutoTone.swift](file:///tmp/Phos/Sources/Phos/AutoTone.swift)），五个讲究的设计：
  1. 统计在 `Engine.geometry()` **裁剪之后**做（防止被裁掉的天空/暗角污染直方图）
  2. 长边 256 降采样 + sRGB 感知域百分位统计
  3. **每项参数硬上限**，夜景/雪景（低调/高调）主动收敛
  4. 用户设过白平衡则**不碰 WB**
  5. 大范围过曝 → 产出**亮度范围蒙版 + 局部负曝光**（`highlightMaskExposure`），而非全局拉曝光
- anwuRAW：auto-adjust 在前端（[useEditorActions.ts](file:///tmp/anwuRAW/src/hooks/useEditorActions.ts)），后端有 [scene_classify.rs](file:///tmp/anwuRAW/src-tauri/src/scene_classify.rs)（landscape/portrait/night/food 规则打分 + CLIP 概率）。方向对，但求解约束没有上述五条。

**实现路径**

1. **统计入口对齐 ROI**：统计前应用当前裁剪/几何变换（前端已有几何状态，传入统计函数即可）。
2. **求解器后置化**：建议把求解逻辑从前端下沉到新模块 `auto_tone.rs`（与 scene_classify 同层，便于用 32bit 像素统计与 rayon 并行），前端只传 EditParams + 场景概率。
3. **约束系统**：per-key 硬上限表 + 场景条件收敛（夜/雪/逆光分支，输入直接用 `classify_with_clip` 概率）+ 用户已调项跳过（对比当前 patch 与 neutral）。
4. **亮点输出**：过曝场景求解 `highlightLow` → 生成亮度范围蒙版 + 蒙版内负曝光 patch（蒙版复合管线现成，仅求解端产出）。
5. **验收标准**：用 `bench/`（replay.js + compare-renders.sh）构建 20–50 张校准集（含夜景/雪景/大光比），人工评审"改坏率"低于现有 auto-adjust；已设 WB 的图 WB 值零变化。

---

## 4. 次要 parity 项（低成本，顺手补齐）

| 项 | Phos 现状 | anwuRAW 现状 | 动作 |
|---|---|---|---|
| 黑白通道混合 | 独立 mono 模式，R/G/B 三通道权重混合（[Engine.swift L239-249](file:///tmp/Phos/Sources/Phos/Engine.swift#L239-L249)） | 无专用实现（shader 无 F_BW/通道混合，已验证），只能靠饱和度归零 | shader 加一个 3 权重 mono 分支 + 前端三滑杆，约半天 |
| 曲线后饱和回拉（Refine Sat） | 色调曲线改动后自动回拉饱和，防灰化 | 无对应项 | 在曲线应用后按亮度权重补偿饱和，1 个 uniform + 数行 shader |
| 校准矩阵防白点漂移 | 行归一化 3×3（白点不动，[Engine.swift L156-165](file:///tmp/Phos/Sources/Phos/Engine.swift#L156-L165)） | 有校准（`apply_color_calibration`），需核对是否行归一化 | 若未归一化，补一行归约 |
| 透明背景导出 | 前景抠图导出（VN matting） | BiRefNet + alpha 导出链路已有（[export_processing.rs L1772-1790](file:///tmp/anwuRAW/src-tauri/src/export_processing.rs#L1772-L1790)） | 仅需 UI 上把"抠图→透明 PNG"打通为一键动作 |

---

## 5. 明确不建议投入的方向（反向清单）

| Phos 的能力点 | 判定 | 理由 |
|---|---|---|
| Vision saliency 主体检测 | 不追 | SAM ViT-B / EfficientSAM3（含文本提示）/ BiRefNet 精度全面更高 |
| `CINoiseReduction` / 中值降噪 | 不追 | BM3D（非破坏性+磁盘缓存+瓦片融合）+ AI NIND + 边缘感知 tile 降噪三层方案反超 |
| `CIHighlightShadowAdjust` HDR | 不追 | anwuRAW 的 tonemapper（AgX/ACES/PBR）+ 高光保色重建在更高层级解决 |
| USM 清晰度/纹理 | 不追 | log 域 guided filter + 噪声门控 + 多尺度锐化反超 |
| 曲线烘焙 64³ LUT | 不追 | 是效率技巧而非能力；anwuRAW 逐像素计算无插值损失，且支持参数化曲线 |
| 蒙版 15 参数栈 | 不追 | anwuRAW 蒙版可调 ~28 项（含 NR/clarity/structure/glow/halation/flare/HSL×8），反超 |
| 矩阵近似 dehaze | 不追 | Phos 自己注释承认压出 27% 死黑；anwuRAW edge-aware 霾估计正确得多 |
| 303 内置 HALD 胶片 CLUT | 不必追 | 属内容生态非算法；anwuRAW 已有 Spektrafilm V-Log 场景参照模拟 + .cube/.3dl/图片 LUT 导入导出，可另行扩充内置库 |

---

## 6. 实施路线图

```
阶段一（纯移植/低风险，可并行）
  ├─ G3 护栏层 plan_validator.rs        ← 逻辑全部来自 LocalPhotoAI.swift，无推理依赖
  ├─ G4 约束系统（硬上限/场景收敛/WB跳过） ← 求解端纯函数，bench 可测
  └─ G5 黑白通道混合 + Refine Sat        ← 数行 shader
阶段二（基础设施接入）
  ├─ G3 本地 VLM provider（Ollama/MLX）+ 确定性正则前置
  ├─ G2 disparity 读取 depth_loader.rs + lens_blur 深度源优先级链
  └─ G1 解码器设置 + pipeline identity 扩展
阶段三（体验收口）
  ├─ G4 ROI 对齐统计 + 高光蒙版求解输出
  ├─ G1 auto 策略（新机型静默降级 Apple 路径）
  └─ G5 透明导出一键化
```

**依赖关系**：G3 护栏层不依赖推理通路（先落地即可让云端/词库输出也过护栏）；G2 只依赖 macOS API，与 G1 无耦合；G4 的场景收敛依赖现有 `classify_with_clip`，无新增模型。

**统一验收设施**：`bench/`（replay.js 重放 + compare-renders.sh 渲染对比）+ `src-tauri/src/testing/`（harness.rs + metrics.rs）——每项改动附带回放用例，防止"修一个坏一个"。

---

## 7. 风险与注意事项

1. **域语义一致性（G1 最大风险）**：Apple 解码输出 vs rawler 输出的编码域不同，`is_raw_image` 标志错误会导致降噪/锐化/曝光作用在错误域上。建议先用 bench 渲染对比建立两种解码器的基准图。
2. **护栏原则不可妥协（G3）**：模型输出越界必须整体拒绝而非截断（Phos 的实测经验），否则用户会失去对 AI 编辑的信任；同时保留 patch 预览确认步骤。
3. **缓存指纹全覆盖（G1/G2）**：pipeline identity、缩略图缓存、AI 深度缓存三处都要感知新输入，否则出现"切了解码器/换了深度源但画面没变"的静默失效（该项目自己的 B3 项文档也强调过防静默失效）。
4. **跨平台边界**：G1/G2 均 `#[cfg(target_os = "macos")]`，其余平台行为不变；设置项需在其他平台隐藏而非禁用。
5. **AGPL 合规**：移植 Phos（MIT）代码逻辑合法，但注意 Phos 的中文注释/文案建议重写而非直接复制大段文本。

---

## 附录 A：证据索引

| 结论 | 证据位置 |
|---|---|
| Phos RAW 解码用 CIRAWFilter | [Engine.swift L28-48](file:///tmp/Phos/Sources/Phos/Engine.swift#L28-L48) |
| Phos 管线顺序（13 步 CIFilter 链） | [Engine.swift L132-381](file:///tmp/Phos/Sources/Phos/Engine.swift#L132-L381) |
| Phos dehaze 为矩阵近似（自认压死黑） | [Engine.swift L179-197](file:///tmp/Phos/Sources/Phos/Engine.swift#L179-L197) |
| Phos 曲线 Fritsch–Carlson 插值 | [Models.swift L46-89](file:///tmp/Phos/Sources/Phos/Models.swift#L46-L89) |
| Phos LUT 域切换防灰片 | [Engine.swift L251-260](file:///tmp/Phos/Sources/Phos/Engine.swift#L251-L260) |
| Phos VLM 计划护栏（白名单/范围/≤4 蒙版/整体拒绝） | [LocalPhotoAI.swift](file:///tmp/Phos/Sources/Phos/LocalPhotoAI.swift) |
| Phos 确定性裁切正则 | [PhotoAICapabilities.swift](file:///tmp/Phos/Sources/Phos/PhotoAICapabilities.swift) |
| Phos AutoTone 保守求解（裁剪后统计/硬上限/高光蒙版） | [AutoTone.swift](file:///tmp/Phos/Sources/Phos/AutoTone.swift) |
| Phos disparity 散景 | [Engine.swift L363-366](file:///tmp/Phos/Sources/Phos/Engine.swift#L363-L366) |
| anwuRAW rawler 解码 + 管线指纹 | [raw_processing.rs L1-60, L24-27](file:///tmp/anwuRAW/src-tauri/src/raw_processing.rs#L1-L17) |
| anwuRAW Apple RAW 仅 macOS 兜底 | [apple_raw.rs](file:///tmp/anwuRAW/src-tauri/src/apple_raw.rs) |
| anwuRAW 主 shader 特征位/蒙版累积/曲线 | [shader.wgsl L1855-2015](file:///tmp/anwuRAW/src-tauri/src/shaders/shader.wgsl#L1855-L2015), [L455-494](file:///tmp/anwuRAW/src-tauri/src/shaders/shader.wgsl#L455-L494) |
| anwuRAW AgX/ACES/PBR tonemapper | [shader.wgsl L1553-1604, L2128-2132](file:///tmp/anwuRAW/src-tauri/src/shaders/shader.wgsl#L1553-L1604) |
| anwuRAW lens_blur 仅吃外部深度 | [lens_blur.rs](file:///tmp/anwuRAW/src-tauri/src/lens_blur.rs) |
| anwuRAW 词库调色 + 回退链 | [style_suggest.rs](file:///tmp/anwuRAW/src-tauri/src/style_suggest.rs) |
| anwuRAW AI 追色（Reinhard Lab） | [color_transfer.rs](file:///tmp/anwuRAW/src-tauri/src/color_transfer.rs) |
| anwuRAW 导出 ICC（P3/ProPhoto/Rec2020 + Bradford） | [color_profiles.rs L118-137, L339-389](file:///tmp/anwuRAW/src-tauri/src/color_profiles.rs#L118-L137) |
| anwuRAW 场景分类（规则 + CLIP） | [scene_classify.rs](file:///tmp/anwuRAW/src-tauri/src/scene_classify.rs) |
| anwuRAW 自动调整在前端 | [useEditorActions.ts](file:///tmp/anwuRAW/src/hooks/useEditorActions.ts) |
| anwuRAW alpha 导出链路 | [export_processing.rs L1772-1790](file:///tmp/anwuRAW/src-tauri/src/export_processing.rs#L1772-L1790) |
| anwuRAW 回归设施 | [bench/](file:///tmp/anwuRAW/bench), [testing/harness.rs](file:///tmp/anwuRAW/src-tauri/src/testing/harness.rs) |
