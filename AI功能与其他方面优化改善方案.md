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

| 能力 | ZhaJinWenQianCake | 透影 Crystal（Android） | 结论 |
|---|---|---|---|
| 主体抠图 | MODNet 24.7MB | **BiRefNet lite + SAM vit_b + ESAM3（文本提示）** | 我们显著更强 |
| 语义分割 | selfie_multiclass **tflite** 16MB（MediaPipe 发布形态） | selfie_multiclass **ONNX**（同源） | 同级；他们有移动端原生 tflite 形态 |
| AI 降噪 | 自训练 U-Net 2.4M 参数（DIV2K **合成噪声**，PSNR +4.0~5.5dB） | NIND UTNet（**真实噪声数据集**） | 我们底子更好 |
| 消除/填充 | LaMa fp32 ONNX 208MB | LaMa fp16 ONNX（同源） | 同级，我们更小 |
| 超分辨率 | RealESRGAN x4plus（tile 推理） | **无** | 他们多一项 |
| CLIP | 335MB 图像塔 ONNX（仅挑图查重） | clip_model.onnx + tokenizer（文本蒙版用） | 同源，**我们用法单一** |
| 深度/法线 | 无 | **Depth Anything V2 + MoGe-2** | 我们多两项 |
| 场景识别 | 无（挑图用 CLIP 查重） | 64px 统计启发式 4 类 | 我们有但弱 |
| 生成式填充 | ComfyUI 外挂 SD1.5/SDXL | 无 | 他们多（可选组件） |
| GPU | torch CUDA + ort，需手动注册 DLL | DirectML（Win）/ CoreML（mac）/ **Android 无 EP，纯 CPU** | 架构我们更干净，但 Android 缺 EP |

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

### P1-2 分割与蒙版质量（直接提升天空/主体/文本/景深四大移动端功能）

1. **guided filter 贴边后处理**（`engine/matting.py:138-190`）：alpha 与亮度引导滤波融合，发丝/肩部软边。BiRefNet 质量好但边缘可再收尾。
2. **多人合影强制保护区**：selfie_multiclass 是**单主体**模型——他们 8 人合影实测 3 个主角中 2 个被误删。修复：人脸框按解剖比例（头顶=脸上缘-0.42×脸高，头高=1.72×脸高）扩粗掩膜，与语义 subject 取**并集**构成"绝不处理区"，不依赖分割质量。
3. **分位数归一化**（`engine/semantic.py:77-123`）：各类置信掩膜用百分位自适应归一化，固定阈值在合成/真实图间失效。
4. **overlap 判定用 raw confidence**：归一化会把背景弱响应拉高，0.86 占比的人物被算成路人（他们实测）。
5. **检测分辨率陷阱**：检出率对输入尺寸**非单调**（YuNet 同一张 60px 小脸 900~1300px 稳定检出、>1400px 反而消失）。人脸/关键点管线固定 ~900px 长边检测后映回原尺度。移动端照片本就大，此坑必踩。

### P1-3 AI 降噪精细化

1. **strength 语义化**：NIND UTNet 模型名中 684 对应训练噪声等级体系；核对模型是否带噪声等级条件输入，有则把 `aiDenoiseAmount` 映射到等级输入（而非仅输出混合比例）——参照 `engine/nndenoise.py:112-173`。现有 luma_keep/chroma_keep 双通道混合（`ai_denoise.rs:337-358`）保留为第二层控制。
2. **真实噪声回归基线**：高 ISO/暗场样张 PSNR/SSIM 基线（见 P0-2 测试体系）。我们是真实噪声模型，把"换模型不回退"钉住。
3. **低频恢复独立验证**：`restore_low_frequencies`（`ai_denoise.rs:363-412`）补"开关前后低频保真"+"tile 稳定性"专项测试。
4. **Android 性能档**：CPU 下评估 fp16 模型档位与 tile 尺寸按机型内存自适应（超低端自动降 tile）。参照仓库 tile=256/overlap=32 加权混合 + 推理锁防并发（`engine/superres.py:167-246`）的参数可直接借用。

### P1-4 Android EP 与推理后端评估

- 现状：`gpu_execution_provider()` 在 Android 返回 None，纯 CPU。
- 评估 **XNNPACK EP**（ort 版本兼容性、内存占用、与 fp16 模型叠加效果）；NNAPI 委托兼容性差、稳定性风险高，不建议优先。
- 远期备选：selfie_multiclass 走 MediaPipe 原生 tflite（他们保持 MediaPipe 发布形态的启发）——但引入 JNI 依赖重，仅当 ONNX 路径性能不可接受时再评估。

### P1-5 模型分发体积（Android 特有）

- 参照仓库的教训：lite 包 5.2GB / full 6.5GB——**移动端不可接受**。我们的按需下载 + 断点续传 + 校验已是正确形态，需补：
  1. 下载体积总览页（哪些功能需要哪些模型、各多大），启用前明示；
  2. **Wi-Fi 限制开关**（移动数据下默认不自动下载 300MB+ 模型）；
  3. CLIP 351MB 级模型的场景分类复用（P0-1）恰好摊薄了这笔下载的成本——在方案文档中把这一点写进收益论证。

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

| 优先级 | 事项 | 主要涉及 | 预期收益 | 风险 |
|---|---|---|---|---|
| **P0** | CLIP 零样本场景分类（+批内分位数校准+启发式降级） | scene_classify.rs、ai_processing.rs | AI 推荐准确率大升，零新增下载 | CLIP 会话内存；预热策略（见 P0-2） |
| **P0** | Android CPU 性能基线 + 机型分级（tile/线程数） | 推理链路 | 中低端机可用性 | 需真机实测矩阵 |
| **P0** | AI 诊断命令 + 复制诊断报告 + EP 如实标注 | ai_processing.rs、设置页 | 排障闭环；防静默 CPU 回退 | 低 |
| **P1** | LaMa 四项契约（量程自检/洞清零/窗口化/大面积 guidance） | LaMa 调用链 + 前端 | 消除效果+速度（CPU 关键） | guidance 交互需 i18n |
| **P1** | 分割质量包（guided filter 贴边/多人保护区/分位归一/900px 检测） | 分割与人脸链路 | 天空/主体/文本/景深四大功能质量 | 计算量增加，需窗口化 |
| **P1** | 降噪 strength 语义化 + 真实噪声基线 + fp16 档 | ai_denoise.rs、模型资产 | 高 ISO 效果可控可复核 | 条件输入需验证 |
| **P1** | XNNPACK EP 评估 | ort 集成 | CPU 推理提速 2~4×（预期） | 版本兼容需验证 |
| **P1** | 分发体积治理（体积总览/Wi-Fi 限制/复用摊薄） | 下载链路 + UI | 转化率与流量友好 | 低 |
| **P2** | 超分 / AI 挑图 / 追色 / 热节流 / 生成式（桌面） | 新功能立项 | 功能面扩展 | 各自独立评估 |

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
