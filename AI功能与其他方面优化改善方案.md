# 透影 Crystal v2.1.16 · Android 端 AI 与其他方面优化改善方案

### 基于 ZhaJinWenQianCake（wmc-ccb）仓库全量深度对照分析 · 2026-11-06

---

## 0. 分析范围与方法

- **参照仓库**：ZhaJinWenQianCake —— 本地 AI 人像修图应用（Python FastAPI 引擎 + ONNX/TFLite 推理 + WebView2，Windows 桌面）。全量 222 个文件已通读：`engine/` 62 个引擎模块、`server/app.py`、`tests/` 60+ 套验证脚本（11 套进 CI）、`training/` 自训练降噪、`tools/` 打包分发、8 篇工程文档（README/HANDOVER/CHANGELOG/ROADMAP/THIRD_PARTY/SECURITY/PRIVACY/CONTRIBUTING）。
- **本项目**：透影 Crystal v2.1.16 Android 端。核对的 AI 链路：[ai_processing.rs](file:///workspace/src-tauri/src/ai_processing.rs)（约 3400 行：模型下载/会话/推理/资源驻留）、[ai_denoise.rs](file:///workspace/src-tauri/src/ai_denoise.rs)、[scene_classify.rs](file:///workspace/src-tauri/src/scene_classify.rs)、[app_settings.rs](file:///workspace/src-tauri/src/app_settings.rs)（`ai_provider`）、[CrystalAiToolsPanel.tsx](file:///workspace/src/components/mobile/CrystalAiToolsPanel.tsx)（移动端 AI 工具面板）。
- 两个项目同为"全本地 AI 修图"。参照仓库的核心价值不在模型清单（我们更全），而在**质量测试方法论、诚实降级设计、失败实测沉淀的工程契约**——这些全部可移植到 Android 端。
- **Android 端特殊约束**（本方案的取舍基准）：无 GPU EP（CPU 推理）、内存/发热受限、APK 与模型分发体积敏感、弱网环境（模型下载 980MB 级）。

---

## 1. 家底对比

### 1.1 模型与推理资产对比

| 能力       | ZhaJinWenQianCake                                             | 透影 Crystal（Android）                                   | 结论                               |
| ---------- | ------------------------------------------------------------- | --------------------------------------------------------- | ---------------------------------- |
| 主体抠图   | MODNet 24.7MB                                                 | **BiRefNet lite + SAM vit_b + ESAM3（文本提示）**         | 我们显著更强                       |
| 语义分割   | selfie_multiclass **tflite** 16MB（MediaPipe 发布形态）       | selfie_multiclass **ONNX**（同源）                        | 同级；他们有移动端原生 tflite 形态 |
| AI 降噪    | 自训练 U-Net 2.4M 参数（DIV2K **合成噪声**，PSNR +4.0~5.5dB） | NIND UTNet（**真实噪声数据集**）                          | 我们底子更好                       |
| 消除/填充  | LaMa fp32 ONNX 208MB                                          | LaMa fp16 ONNX（同源）                                    | 同级，我们更小                     |
| 超分辨率   | RealESRGAN x4plus（tile 推理）                                | **无**                                                    | 他们多一项                         |
| CLIP       | 335MB 图像塔 ONNX（仅挑图查重）                               | clip_model.onnx + tokenizer（文本蒙版用）                 | 同源，**我们用法单一**             |
| 深度/法线  | 无                                                            | **Depth Anything V2 + MoGe-2**                            | 我们多两项                         |
| 场景识别   | 无（挑图用 CLIP 查重）                                        | 64px 统计启发式 4 类                                      | 我们有但弱                         |
| 生成式填充 | ComfyUI 外挂 SD1.5/SDXL                                       | 无                                                        | 他们多（可选组件）                 |
| GPU        | torch CUDA + ort，需手动注册 DLL                              | DirectML（Win）/ CoreML（mac）/ **Android 无 EP，纯 CPU** | 架构我们更干净，但 Android 缺 EP   |

### 1.2 Android 端现状盘点（已做对的部分，不要破坏）

1. **模型驻留与淘汰已存在**：`AiState` 用 `ResidencyPolicy::for_platform(cfg!(target_os = "android"))` + `idle_only(android)`（[ai_processing.rs:787-789](file:///workspace/src-tauri/src/ai_processing.rs#L787-L789)、[L1505-1507](file:///workspace/src-tauri/src/ai_processing.rs#L1505-L1507)），空闲即淘汰会话释放内存——这正是移动端的正确答案，参照仓库反而没有对应机制（他们 525MB 空载/峰值 2400MB 是桌面语境）。
2. **移动端 AI 面板已成熟**：`CrystalAiToolsPanel` 有一键增强（三档）/自动色调/AI 降噪/天空/主体/文本/景深 8 类能力，全部带 busy 蒙层、模型下载进度、`CancelAiTask` 取消出口、跨图守卫、图片就绪等待、toast 反馈闭环。
3. **下载链路健壮**：镜像回退（自定义镜像 → 官方 → hf-mirror）+ HTTP Range 断点续传 + SHA256 校验 + 进度事件（[ai_processing.rs:1199-1245](file:///workspace/src-tauri/src/ai_processing.rs#L1199-L1245)）。
4. **降噪已是真实噪声模型**：NIND UTNet + tile 推理 + 低频恢复（`restore_low_frequencies`）。

### 1.3 参照仓库对 Android 最有价值的四件事

1. **AI 质量回归测试体系**：掩膜外逐位不变（`verify_locality.py`，一次抓到 7 个静默缺陷）、参数单调性（`monotonic.py`）、tile 尺寸稳定性（实测平均差 0.00118）、固定噪声等级 PSNR 基线、41 功能族覆盖度报告。
2. **诚实降级与适用性判定**：背景纯度 <0.45 自动跳过并如实报告；绿色占比 <5% 判"不适用"；大面积删除不硬跑、返回 guidance 引导走更好路径；AI 能力没做好就公开宣布暂停而不冒充可用。
3. **失败实测沉淀的契约**：LaMa 输出量程自检（0-255 / [0,1] / [-1,1]，四轮调试才定位）；mask 预处理洞内像素清零；selfie_multiclass **单主体**模型在多人合影的误删保护；检测分辨率**非单调**（YuNet >1400px 反而失效 → 先降 900px 检测再映回）。
4. **可诊断性**：`/api/diagnose` 不只报 `is_available()`，而是真跑一次矩阵乘——他们因此抓到 GPU 静默回退 CPU（诊断信息一切正常，超清 9.2s→109s）；`out/error.log` + "复制诊断报告"闭环。

---

## 2. Android 端 AI 功能效果改善方案

### P0-1 场景分类升级：复用已有 CLIP 做零样本分类（性价比最高）

**现状**：[scene_classify.rs](file:///workspace/src-tauri/src/scene_classify.rs) 用 64px 缩略图统计启发式（天空蓝/植被绿/暖色/皮肤比例 + 亮度分位），4 类（风景/人像/夜景/美食），置信度门槛 0.75（`DISPLAY_CONFIDENCE_GATE`）。

**问题**：启发式有天花板——室内人像（无蓝天绿地信号）、暗调美食、夜景人像必然误判/漏判；置信度由手工权重合成（`best_score * 1.15 - second_score * 0.3`，L201），无概率语义。Android 相册照片场景更杂，皮肤启发式（R>95 等固定阈值）对暗色皮肤/逆光系统性偏低。

**方案**（`clip_model.onnx` + tokenizer 已内置，文本蒙版在用，**零新增下载**）：

1. 图像塔 embedding × 场景文本提示（每类 8~12 条 prompt ensemble 平均，如 "a portrait photo of a person" / "a landscape with mountains and sky" / "a night scene with city lights" / "a close-up photo of food"），softmax 温度缩放输出概率。
2. 文本 embedding 构建期预计算、随包分发一个小 prompt-embedding bin（已有先例：ESAM3 的 `efficientsam3_sky_prompt.bin` / `_face_prompt.bin`），运行时免 tokenizer/文本塔。
3. **降级链**：CLIP 会话不可用 → 完整回落到现有启发式（`scene_classify.rs` 全保留），符合"诚实实现"约定。
4. **批次分位数校准**（借他们挑图理念："阈值取这一批自身的分位数"）：相册多张同批时用批内分布校准 confidence，避免夜景批次整体被 0.75 门槛压掉。
5. 0.75 门槛保留，语义从手工分变 softmax 概率；i18n 文案不变。

**收益**：移动端 AI 推荐卡（`CrystalAiToolsPanel` 场景配方推荐）准确率显著提升；Android 上 CLIP 图像塔已下载过（文本蒙版用过），边际成本为零。

### P0-2 Android CPU 性能基线与分级策略（参照仓库"1000s+"教训）

**参照教训**（HANDOVER）：CPU 路径病理案例烧到 **1000s+** 只能 kill；CLIP `from_pretrained` 默认联网检查更新，无网阻塞 **300s**，首载 32s 在请求路径上 → 改 `local_files_only` + 预热 → **3.7s**。

**方案**：

1. **建立机型分级性能基线**：对旗舰/中端/低端三档真机实测各 AI 能力的首推耗时（CLIP/分割/降噪/LaMa/深度），形成表格，据此把 tile 尺寸、线程数（`ort` intra-op threads）按机型内存/核数分级——他们实测 4 线程并发初始化 OK，但移动端建议 1~2 线程（发热与热节流）。
2. **CLIP 零样本分类推理输入**：scene 分类只需图像塔一次前向，输入可降到 224px 级，控制在中端机 <300ms。
3. **所有模型加载走 `local_files_only` 等价路径**（我们的下载链路本就是本地文件提交，核对无联网探测）。
4. **预热与内存的平衡**：参照仓库的预热是为桌面；Android 有 residency 淘汰（1.2 节），预热策略改为"用后驻留 + 空闲淘汰"——首次使用后驻留一段时间，退后台或内存压力下淘汰，二次使用秒开。**不做启动期无条件预热**（移动端内存敏感）。

**落地记录（release v2.1.16，`ai_perf.rs` 新增 + `ai_processing.rs` 接线）**：

1. **机型分档**：`classify_tier(cores, ram_mb)` 纯函数——旗舰（≥6 核且 ≥7.5GB）/ 中端（≥4 核且 ≥3.5GB）/ 低端（其余）；核数取 `available_parallelism`，内存读 `/proc/meminfo` MemTotal，**探测失败按低端处理**（保守方向）。
2. **线程分级**：`build_session` 的 builder 链注入 `with_intra_threads`——Android 旗舰/中端 2 线程、低端 1 线程；**桌面端 None，保持 ORT 默认**（与分级前行为完全一致）。注：若 ORT 本体以 OpenMP 构建该设置不生效（ort 文档口径），Android 用官方预编译 `libonnxruntime.so`（build.rs 固定 v1.22.0 + sha256）。
3. **LaMa 像素预算分级**：`LAMA_PIXEL_BUDGET` 由常量改为 `ai_perf::lama_pixel_budget()`——Android 旗舰 768² / 中端 576² / 低端 448²（均为 32 倍数对齐张量），桌面恒 768²。LaMa 为全卷积 FFC 结构，动态尺寸无质量回退风险。
4. **降噪 tile 尺寸暂不分级（如实说明）**：`DENOISE_TILE cs=504` 各平台保持一致。UTNet 含 transformer 组件，输入尺寸变化对质量的影响未经真机回归验证，不做无依据的静默改动；待基线表采集后按机型验证通过再分级（参照仓库 tile=256/overlap=32 的参数可借用）。
5. **无联网探测 / 无启动预热核对通过**：模型加载链路全部是先查本地文件再按需下载（CLIP 另有免下载初始化 `get_or_init_clip_models_if_downloaded`），无 `from_pretrained` 式联网检查；全仓无启动期模型预热调用，驻留策略为"用后驻留 + 空闲淘汰"（model_residency.rs）。

**机型分级性能基线表（框架，待真机实测填充）**：

| 机型档位                      | 判定口径       | CLIP 224px 首推 | 分割首推 | 降噪 12MP 全图 | LaMa 512² 窗口 | 深度首推 | intra-op 线程 | LaMa 预算 |
| ----------------------------- | -------------- | --------------- | -------- | -------------- | -------------- | -------- | ------------- | --------- |
| 旗舰（如 8Gen2/8Gen3 + 12GB） | ≥6 核且 ≥7.5GB | _ms             | _ms      | _ms            | _ms            | _ms      | 2             | 768²      |
| 中端（如 778G/7Gen1 + 6~8GB） | ≥4 核且 ≥3.5GB | _ms             | _ms      | _ms            | _ms            | _ms      | 2             | 576²      |
| 低端（如 Helio G/4GB）        | 其余           | _ms             | _ms      | _ms            | _ms            | _ms      | 1             | 448²      |

填充方法：真机安装 release 包 → 设置 → 数据管理 → AI 诊断 → 跑一次**深度诊断**（deep=true 会逐模型输出 `sessionBuildMs` 会话构建耗时与 CLIP `probeInferenceMs` 224px 端到端探针耗时，报告同时记录 `deviceTier/cores/ram/intraOpThreads`）→ 复制诊断报告回填本表；全图降噪/LaMa/深度用秒表计时。判据：**中端机 CLIP <300ms**（方案 2 目标）、首推（会话构建 + 首次推理）无 10s 级病态值。若某档超限，先降该档 LaMa 预算/线程，仍超再评估降噪 tile 分级（需同步质量回归）。

### P0-3 AI 诊断与"复制诊断报告"（防静默回退，Android 尤其重要）

**现状**：`get_ai_model_inventory`（[ai_processing.rs:3387](file:///workspace/src-tauri/src/ai_processing.rs#L3387)）只报模型文件在位；Android 无 GPU EP（[L602-605](file:///workspace/src-tauri/src/ai_processing.rs#L602-L605) 返回 None），用户报障时"AI 慢"无法归因。

**方案**：

1. 新增 `diagnose_ai` 命令：一次性返回 版本 / 平台 / 每模型实际生效 EP / 模型清单+落点+首推耗时 / 下载校验状态；每模型跑一次 32×32 实测推理（把"假阳性"变可验证事实）。
2. 设置页展示 + "复制诊断报告"（版本、机型、EP、最近 5 条 AI 错误）——用户报障直接粘贴，对齐参照仓库闭环。
3. `ai_provider` UI 如实标注：Windows=DirectML、macOS=CoreML、Android=CPU（当前值高亮）。**不提供 Android 上不存在的选项。**

### P1-1 LaMa 契约加固（CPU 上收益更大）

对照 `engine/lama.py:173-263` 与 README 四轮调试记录：

1. **输出量程自检**：从输出自身检测量程（0-255 / [0,1] / [-1,1]）再归一化——把 0-255 输出当 [0,1] 裁剪会让 >1 的值全压成白色，"填补"结果 96.7% 纯白。核对我们在 `ai_processing.rs` 中 LaMa 输出的归一化假设。
2. **mask 预处理契约**：喂模型前洞内像素清零（`image * (1 - mask)`），否则输出平白区域。
3. **窗口化执行**：只跑覆盖 mask（dilate 扩展后）的窗口，`touched` 区域显式返回——大图上消除一角耗时可降一个量级；**CPU 推理下这是可用性级别的优化**（参照他们 CPU 病理 1000s+ 的教训）。我们的 tile 推理机制已具备，LaMa 路径核对是否窗口化。
4. **大面积诚实引导**：hole 占比超阈值返回 guidance 事件而非硬跑（他们实测校准：单路人 hole≈11% 可自动、多紧挨路人 ≈29% → 引导）。前端弹"建议缩小涂抹范围"，不产出垃圾结果——移动端屏幕小、涂抹面积天然受限，阈值需按移动端重新校准。

**落地记录（release v2.1.16，`ai_processing.rs` `run_lama_inpainting` + `useAiMasking.ts` + 15 语言）**：

1. **输出量程自检**：新增纯函数 `lama_output_scale(out_min, out_max)`——`max > 1.05` 判 0-255（合法 [0,1] 不可能超 1，fp16 留 5% 余量）、`min < -0.05` 判 [-1,1]、其余判 [0,1]；归一化由硬编码 `/255.0` 改为 `v * scale + offset`。旧假设（恒 0-255）被自检替代，换模型不再静默出纯白/纯黑。单测覆盖三种量程 + fp16 过冲 + 全黑边界。
2. **mask 洞内清零**：喂模型前 `img * (1 - mask)`；细节还原的 patch-match `source` 仍取原图像素（is_source 本就排除洞邻域，不受影响）。
3. **窗口化执行：核对通过**——现有实现本就按 mask 外扩（1.5× + 128px 下限）裁剪后只推理该窗口，未变。
4. **大面积诚实引导**：新增 `LAMA_MAX_HOLE_RATIO = 0.35`（洞区占推理窗口比例；参照仓库 11%/29% 校准取中偏上，桌面大图与移动端兼顾），超阈值返回 `lama_guidance:hole_ratio=..` 错误而非硬跑；前端 `handleGenerativeReplace` 识别该前缀，弹出本地化引导 toast（新增 i18n 键 `editor.ai.settings.maskTooLargeGuidance` ×15 语言）。移动端真机占比分布留待反馈校准阈值。

### P1-2 分割与蒙版质量（直接提升天空/主体/文本/景深四大移动端功能）

1. **guided filter 贴边后处理**（`engine/matting.py:138-190`）：alpha 与亮度引导滤波融合，发丝/肩部软边。BiRefNet 质量好但边缘可再收尾。
2. **多人合影强制保护区**：selfie_multiclass 是**单主体**模型——他们 8 人合影实测 3 个主角中 2 个被误删。修复：人脸框按解剖比例（头顶=脸上缘-0.42×脸高，头高=1.72×脸高）扩粗掩膜，与语义 subject 取**并集**构成"绝不处理区"，不依赖分割质量。
3. **分位数归一化**（`engine/semantic.py:77-123`）：各类置信掩膜用百分位自适应归一化，固定阈值在合成/真实图间失效。
4. **overlap 判定用 raw confidence**：归一化会把背景弱响应拉高，0.86 占比的人物被算成路人（他们实测）。
5. **检测分辨率陷阱**：检出率对输入尺寸**非单调**（YuNet 同一张 60px 小脸 900~1300px 稳定检出、>1400px 反而消失）。人脸/关键点管线固定 ~900px 长边检测后映回原尺度。移动端照片本就大，此坑必踩。

**落地记录（release v2.1.16）**：

1. **guided filter 贴边（已补齐最后缺口）**：ESAM3 天空/文本掩膜与 face body/skin 路径本就有引导/联合滤波精修；本次把 **BiRefNet 前景掩膜**接上同一机制——`run_birefnet_model` 尾部按 ESAM3 同几何（mask 降到 ≤1024 长边、`fast_color_guided_filter` 半径 16、eps 0.001、系数双线性上采样回原尺寸），成本量级与 ESAM3 精修相同。
2. **多人合影强制保护区（已落地天空路径）**：新增 `face_masking::head_zone_from_boxes`——按解剖比例（头顶=脸上缘-0.42×脸高、头高=1.72×脸高、头宽=1.3×脸宽）从人脸检测框生成多脸并集保护带，边缘按脸高 2% 柔化。天空替换（`generate_sky_mask`）在出掩膜后扣除该保护带：**人物与天空重叠时人物绝不处理**。ESAM3 特征已缓存，边际成本仅一次 decoder 查询；人脸 prompt 模型未下载时如实降级（不扣除 + warn，天空替换不依赖人脸模型）。单测：解剖比例边界、多脸并集、退化框。
3. **前景/主体路径的并集保护：经评估暂缓**（如实说明）：BiRefNet 路径要拿人脸框需先跑 ESAM3 编码器（重前向），为主旨 mask 增加 ~50% 耗时，而 general_lite 本身是显著物模型、单人主体风险低于 selfie 类模型；头区辅助函数已就绪，待真机数据证明必要时再接。
4. **分位数归一化（已落地）**：`percentile_mask_remap(values)` 取掩膜自身 p99 作满值刻度（O(n) select_nth），应用到 ESAM3 coarse mask 重映射——p99 > 0.3 时按 [0, p99] 自适应归一（弱置信对象不再被固定 0.3 下限压成近透明、<0.3 的软边缘不再被削平），无真实信号时维持原固定 [0.3,0.7] 行为。**判定始终用 RAW 置信度**（query 分数阈值不走归一化）——这正是第 4 条 overlap 病理的修复原则；我们的天空/文本/人脸管线没有"归一化置信度参与 overlap 仲裁"的代码路径（该病理为他们语义管线的特有结构），按原则落实为上述分离。
5. **检测分辨率陷阱（核对通过）**：我们的人脸检测是 ESAM3 编码器固定 `ESAM3_INPUT_SIZE=1008` 长边，天然落在他们实测稳定的 900~1300px 区间内，无 >1400px 输入；关键点/分割按每脸 256px 窗口化。无需改动。

### P1-3 AI 降噪精细化

1. **strength 语义化**：NIND UTNet 模型名中 684 对应训练噪声等级体系；核对模型是否带噪声等级条件输入，有则把 `aiDenoiseAmount` 映射到等级输入（而非仅输出混合比例）——参照 `engine/nndenoise.py:112-173`。现有 luma_keep/chroma_keep 双通道混合（`ai_denoise.rs:337-358`）保留为第二层控制。
2. **真实噪声回归基线**：高 ISO/暗场样张 PSNR/SSIM 基线（见 P0-2 测试体系）。我们是真实噪声模型，把"换模型不回退"钉住。
3. **低频恢复独立验证**：`restore_low_frequencies`（`ai_denoise.rs:363-412`）补"开关前后低频保真"+"tile 稳定性"专项测试。
4. **Android 性能档**：CPU 下评估 fp16 模型档位与 tile 尺寸按机型内存自适应（超低端自动降 tile）。参照仓库 tile=256/overlap=32 加权混合 + 推理锁防并发（`engine/superres.py:167-246`）的参数可直接借用。

**落地记录（release v2.1.16）**：

1. **strength 语义化（核对结果：模型无噪声等级输入）**：`run_ai_denoise` 对会话是单输入推理（`ort::inputs![t_input]`，`ai_processing.rs:1815`），nind_denoise_utnet_684.onnx 不带噪声等级条件输入——"684"只是训练配置命名，无法把 strength 映射到等级输入。strength 保持输出混合语义（`luma_keep = 1 - amount×(1-detail)`、`chroma_keep = 1 - amount`，detail 控制亮度细节保留），与方案"保留双通道混合为第二层控制"一致。
2. **真实噪声回归基线（待真机数据，方法论已定）**：PSNR/SSIM 基线需要真实高 ISO/暗场 clean/noisy 样张对，本环境无采集设备、也不应伪造基线数字。采集方法：固定场景（ISO 6400 暗光、ISO 200 日光）各拍 10 张，clean 参考用三脚架长曝光平均，跑 `aiDenoiseAmount` 0.25/0.5/0.75/1.0 四档，对输出与 clean 参考算 PSNR/SSIM 与色偏（ΔE），连同 P0-2 基线表一起回填文档。换模型（如 fp16 档）后重跑同一组对比即"换模型不回退"的回归判据。
3. **低频恢复独立验证（已落地单测）**：`ai_denoise.rs` 新增测试模块——1024×1024 合成低频渐变 + 丢失低频的平灰"denoised"，恢复后整体误差降 >75%、逐 64px 块均值误差降 >75%且残差 <0.05；小图（<2 块）原样返回不写 NaN。**注意**：恢复核半径 3 的盒式滤波要求块网格远大于核（≥16×16 块），1024px 以下图像上块均值场会被抹平——这是既有实现的尺寸约束，测试已用 1024² 钉住行为。
4. **tile 稳定性（已落地单测）**：`denoise_tiling_covers_every_pixel`——对 1/100/479/480/481/500/1000/4096/6000px 各边长验证每个像素都被至少一个 tile 有效区覆盖（无累积器权重 0 的输出黑洞）；混合权重为 (0,1] 的 smoothstep 对称斜坡、中心满权重、两端渐隐。
5. **Android 性能档（线程/预算分级已在 P0-2 落地；fp16 模型档待评估）**：fp16 档需要重新导出/量化模型并在真机对比质量-速度，本环境无 ONNX 量化工具链与设备，留待真机执行；tile 尺寸分级已在 P0-2 说明 UTNet 尺寸敏感性未验证前不改。

### P1-4 Android EP 与推理后端评估

- 现状：`gpu_execution_provider()` 在 Android 返回 None，纯 CPU。
- 评估 **XNNPACK EP**（ort 版本兼容性、内存占用、与 fp16 模型叠加效果）；NNAPI 委托兼容性差、稳定性风险高，不建议优先。
- 远期备选：selfie_multiclass 走 MediaPipe 原生 tflite（他们保持 MediaPipe 发布形态的启发）——但引入 JNI 依赖重，仅当 ONNX 路径性能不可接受时再评估。

**评估记录（release v2.1.16，静态评估；真机 A/B 待执行）**：

1. **兼容性（静态核对通过）**：ort 2.0.0-rc.10 在 `load-dynamic` 特性下提供 `XNNPACKExecutionProvider`（`execution_providers/xnnpack.rs:30` 的条件编译包含 load-dynamic），接入点唯一——`create_session` 的 `with_execution_providers` 链，注册代码与 DirectML/CoreML 同形；官方预编译 libonnxruntime.so（build.rs 固定 v1.22.0 + sha256）内置 XNNPACK EP，无需换库。
2. **与 P0-2 线程分级的交互（必须一起设计）**：ort 文档明确 XNNPACK 使用**独立线程池**，不受 `SetIntraOpNumThreads` 约束——若启用 XNNPACK，P0-2 的 Android 1~2 线程上限对该 EP 不生效，需按 XNNPACK 的线程参数另行设限，否则移动端发热/热节流风险回退。
3. **内存与 fp16 叠加（待真机测）**：XNNPACK 的图内量化/融合通常降内存，但也可能改变 fp16 模型的数值路径——必须真机 A/B（精度对比 + 峰值 RSS + 首推/稳态耗时）后才能默认开启。决策门槛：CLIP 224px 与分割首推在中端机不劣于现状 >15%，峰值内存不增。
4. **结论**：接入成本低但风险点（独立线程池、数值路径变化）明确，列为真机验证项而非本版默认改动。

### P1-5 模型分发体积（Android 特有）

- 参照仓库的教训：lite 包 5.2GB / full 6.5GB——**移动端不可接受**。我们的按需下载 + 断点续传 + 校验已是正确形态，需补：
  1. 下载体积总览页（哪些功能需要哪些模型、各多大），启用前明示；
  2. **Wi-Fi 限制开关**（移动数据下默认不自动下载 300MB+ 模型）；
  3. CLIP 351MB 级模型的场景分类复用（P0-1）恰好摊薄了这笔下载的成本——在方案文档中把这一点写进收益论证。

**落地记录（release v2.1.16）**：

1. **下载体积总览（已落地）**：`ModelManifest` 新增 `installed_bytes_total`（已安装模型磁盘占用合计，真实数据无估算），设置 → 数据管理 → AI 模型说明行现展示"已装 X/Y · 占用 Z"；模型列表逐行展示已安装体积与文件名/用途（displayName）。按需下载语义由既有 `modelsDesc` 文案明示（"首次使用 AI 功能时按需下载"）。
2. **CLIP 复用收益论证（如方案）**：P0-1 的零样本场景分类复用 CLIP 图像塔——同一笔 351MB 级下载同时服务 AI 标签与场景分类，摊薄单功能成本；且场景分类走免下载初始化（`get_or_init_clip_models_if_downloaded`），未下载时不触发、不阻塞、如实回落启发式。
3. **Wi-Fi 限制开关（经评估暂缓，如实说明）**：WebView 无法可靠区分 Wi-Fi 与蜂窝——`navigator.connection.effectiveType` 把 Wi-Fi 5G 与蜂窝 4G 都报 '4g'，`connection.type` 为非标准 Chromium-only API。可靠实现需要 Tauri 原生插件（Android `ConnectivityManager`）上报网络类型 + 后端下载前检查，属于新插件级改动。替代方案（下载前显式确认弹窗）会改变全部按需下载流的交互，需产品决策。故本版不内置不可靠的开关；两条路径已记录，待真机环境与产品决策后实施。
4. **下载体积精确值（如实说明）**：各模型下载字节数未写入 manifest（只有安装后实测 `installed_bytes`）——沙箱内 HF CDN 不返回 Content-Length/Content-Range，无法在此获取可靠数值，不写估算值误导用户；已安装体积的展示不受影响。

---

## 3. 其他方面改善方案（Android 视角）

### 3.1 测试与 CI

- 前端零单测：对 AI 参数逻辑补 vitest——`getAiDenoiseEnablePatch`（按 provider 生成启用补丁）、enhance 三档强度映射、`aiDenoiseAmount/Detail` 缺省值（自检修复过的 100% 缺省语义）。
- CI 失败上传产物（参照 `if: failure()` 上传 out/）；golden 测试失败上传对比图。
- AI 质量断言（P0-2 表格）进 `src-tauri/tests/`，CI 用小尺寸用例控耗时。

### 3.2 错误可诊断性与支持闭环

- Rust panic hook + 前端未捕获异常落盘（含命令名与堆栈，保留最近 N 条）。
- 关于页"复制诊断报告"（与 P0-3 合并实现）。

### 3.3 合规与文档

- 建 `THIRD_PARTY.md` 逐模型许可表：**模型许可独立于代码**。我们全部模型来自 CyberTimon/RapidRAW-Models，需逐个登记上游许可（mediapipe=Apache-2.0 安全；SAM/LaMa/DepthAnything/MoGe 各自许可需核对）。
- 参照 ROADMAP 教训：insightface 系模型仅限研究用途=商用障碍，他们要花整周期换模型。**选型时就查许可**，借本次盘点一遍。
- 补 PRIVACY（"照片不出本机"是卖点）。

### 3.4 性能工程（可直接抄的数字）

- **区域窗口化**：`build_regions` 2024→93ms、皮肤滤波 5302→870ms（脸只占 1.8% 像素）、关键点降采样推理 2412→300ms。我们的 landmarks/multiclass 管线同样窗口化 + 降采样推理。
- 缩略图 LRU、RAW 内嵌 JPEG 预览提取（632→13ms）——移动端相册滚动直接受益。
- **发热与热节流**：连续推理（批量 AI）监控温升，超阈值降线程/降 tile 并如实提示；他们 CPU 1000s+ 的教训说明"没有节流=死机"。

### 3.5 UX 诚实性（参照仓库最强方法论）

- **不适用就如实空态**：绿色占比 <5% 时 applicable=false，不硬猜。
- **guidance 引导而非静默失败**：联动 P1-1 LaMa guidance。
- **批次自适应阈值**：所有"自动"判定（曝光/模糊/场景）用批内分位数，不用固定常数。
- **版本单一来源 + 更新检查**：版本一处定义；检查走 Releases latest，不可达静默降级。

### 3.6 发布工程

- Android：APK/AAB 签名与 Play 发布链路核对；模型分发与版本更新解耦（模型 manifest 内容 hash 即版本，参照他们 CI 缓存 key 思路）。
- 桌面代码签名（参照实测路径）：Certum 开源开发者证书（约 €25-70/年，最对口）/ SignPath.io 开源免费计划 / Azure Trusted Signing（$9.99/月）。

---

## 4. Android 端落地路线图

| 优先级 | 事项                                                            | 主要涉及                            | 预期收益                        | 风险                               |
| ------ | --------------------------------------------------------------- | ----------------------------------- | ------------------------------- | ---------------------------------- |
| **P0** | CLIP 零样本场景分类（+批内分位数校准+启发式降级）               | scene_classify.rs、ai_processing.rs | AI 推荐准确率大升，零新增下载   | CLIP 会话内存；预热策略（见 P0-2） |
| **P0** | Android CPU 性能基线 + 机型分级（tile/线程数）                  | 推理链路                            | 中低端机可用性                  | 需真机实测矩阵                     |
| **P0** | AI 诊断命令 + 复制诊断报告 + EP 如实标注                        | ai_processing.rs、设置页            | 排障闭环；防静默 CPU 回退       | 低                                 |
| **P1** | LaMa 四项契约（量程自检/洞清零/窗口化/大面积 guidance）         | LaMa 调用链 + 前端                  | 消除效果+速度（CPU 关键）       | guidance 交互需 i18n               |
| **P1** | 分割质量包（guided filter 贴边/多人保护区/分位归一/900px 检测） | 分割与人脸链路                      | 天空/主体/文本/景深四大功能质量 | 计算量增加，需窗口化               |
| **P1** | 降噪 strength 语义化 + 真实噪声基线 + fp16 档                   | ai_denoise.rs、模型资产             | 高 ISO 效果可控可复核           | 条件输入需验证                     |
| **P1** | XNNPACK EP 评估                                                 | ort 集成                            | CPU 推理提速 2~4×（预期）       | 版本兼容需验证                     |
| **P1** | 分发体积治理（体积总览/Wi-Fi 限制/复用摊薄）                    | 下载链路 + UI                       | 转化率与流量友好                | 低                                 |
| **P2** | 超分 / AI 挑图 / 追色 / 热节流 / 生成式（桌面）                 | 新功能立项                          | 功能面扩展                      | 各自独立评估                       |

## 5. 不建议照抄的部分

- **torch 运行时**（4GB CUDA 库）：我们 ort 直跑 + WGSL 更轻，移动端更不可能引入。
- **ComfyUI 进程内强依赖**：如做生成式，保持"可选外挂 + 健康探测"。
- **无条件启动预热**：桌面策略，移动端内存敏感，用 residency 淘汰替代。
- **WebView2/Python 桌面架构**：Tauri 体积与启动优势明显。
- 参照仓库"对商业软件做静态分析提取功能规格"的来历表述有合规敏感性，学工程方法即可，文案与命名保持完全原创。

---

### 附：本次核对过的参照仓库关键实现（file:line）

- `engine/nndenoise.py:112-173` strength→噪声等级映射、tile/overlap/feather、设备自动选择
- `engine/superres.py:167-246` tile=256/overlap=32 加权混合、推理锁
- `engine/lama.py:173-263` 窗口化执行、touched 统计
- `engine/semantic.py:77-123` raw confidence + 分位数归一化；`:200-239` size 限制与掩膜回贴；`:33` tflite 模型保持 MediaPipe 发布形态
- `engine/matting.py:138-190` MODNet + guided filter 贴边
- `engine/match.py:202-282` 追色（亮度先匹配、色度按比例）
- `training/train_denoise.py:35-58` 固定噪声等级 PSNR 评估
- `HANDOVER.md` GPU 静默回退 / CPU 1000s+ 病理 / 525MB 空载-2400MB 峰值 / 32s→3.7s 预热
- `tools/models_manifest.json` 13 文件 sha256 清单；`.github/workflows/ci.yml` 11 套回归 + 模型 hash 缓存 + 失败产物
