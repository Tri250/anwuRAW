# 透影 Crystal 优化改善方案
### 基于 ZhaJinWenQianCake（wmc-ccb）仓库全量对照分析 · 2026-11-06

---

## 0. 分析范围与方法

- **参照仓库**：ZhaJinWenQianCake —— 本地 AI 人像修图应用（Python FastAPI 引擎 + ONNX 推理 + WebView2，Windows 桌面）。共 222 个文件：`engine/` 63 个引擎模块、`server/app.py` 单体 API、`tests/` 60+ 套验证脚本（其中 11 套进 CI）、`training/` 自训练降噪模型、`tools/` 打包/模型分发、8 篇工程文档（README/HANDOVER/ROADMAP/THIRD_PARTY 等）。
- **本项目**：透影 Crystal v2.1.16（Tauri 2 + React TS + Rust + WGSL，桌面 + Android）。逐文件核对了 AI 链路：`src-tauri/src/ai_processing.rs`（约 3400 行，模型仓库/会话/推理）、`ai_denoise.rs`、`scene_classify.rs`、`app_settings.rs`（ai_provider）、前端 AI 面板（`CrystalAiToolsPanel.tsx` / `AIPanel.tsx`）。
- 两个项目同为"全本地 AI 修图"，功能面高度重叠，参照仓库的核心价值不在模型清单（我们更全），而在**质量测试方法论、诚实降级设计、以及大量失败实测沉淀出的工程契约**。

---

## 1. 家底对比：先说清楚现状

### 1.1 模型资产对比

| 能力 | ZhaJinWenQianCake | 透影 Crystal | 对比结论 |
|---|---|---|---|
| 人脸检测/关键点 | YuNet 232KB + 2d106det + faceparsing | mediapipe_face_landmarks.onnx | 基本同级 |
| 主体抠图 | MODNet（24.7MB） | **BiRefNet lite + SAM vit_b + ESAM3（文本提示）** | 我们显著更强 |
| 语义分割 | selfie_multiclass（tflite） | selfie_multiclass（ONNX，同源） | 同级 |
| AI 降噪 | 自训练 U-Net 2.4M 参数（DIV2K **合成噪声**，PSNR +4.0~5.5dB） | NIND UTNet（**真实噪声数据集** NIND） | 我们底子更好 |
| 消除/填充 | LaMa fp32 ONNX | LaMa fp16 ONNX（同源） | 同级 |
| 超分辨率 | RealESRGAN x4plus（tile 推理） | **无** | 参照仓库多一项 |
| CLIP | 335MB 图像塔 ONNX（挑图查重） | clip_model.onnx + tokenizer（文本蒙版用） | 同源，我们用法单一 |
| 深度/法线 | 无 | **Depth Anything V2 + MoGe-2**（深度蒙版） | 我们多两项 |
| 生成式填充 | ComfyUI 外挂 SD1.5/SDXL | 无 | 参照仓库多（可选组件） |
| GPU | torch CUDA + ort，需手动注册 DLL | DirectML（Win）/ CoreML（mac）/ **Android 无 EP** | 我们架构更干净，但 Android 缺 EP |

### 1.2 参照仓库真正值得学的四件事

1. **AI 质量回归测试体系** —— 掩膜外逐位不变（`verify_locality.py`）、参数单调性（`monotonic.py`）、tile 尺寸稳定性（实测平均差 0.00118）、固定噪声等级 PSNR 基线、41 功能族覆盖度报告。
2. **诚实降级与适用性判定** —— 背景纯度 <0.45 自动跳过并如实报告；绿色占比 <5% 判"不适用"；大面积删除不硬跑、返回 guidance 引导用户走更好的路径；AI 能力没做好就公开宣布暂停而不冒充可用。
3. **失败实测沉淀的契约** —— LaMa 输出量程自检（0-255 / [0,1] / [-1,1]，四轮调试才定位）；mask 预处理洞内像素清零；selfie_multiclass 单主体模型在多人合影中的误删保护；检测分辨率非单调（YuNet >1400px 反而失效 → 先降 900px 检测再映回）。
4. **可诊断性** —— `/api/diagnose` 不只报 `is_available()`，而是真跑一次矩阵乘（抓到 GPU 静默回退 CPU：诊断信息一切正常，实际 9.2s→109s）；`out/error.log` + 最近异常复制报告。

### 1.3 我们已经领先、需要保持的（不要被带偏）

- WGSL 计算着色管线 + ort 直跑（无需拖 4GB torch 运行时）。
- NIND 真实噪声降噪模型（参照仓库自己承认合成噪声训练是短板，其 ROADMAP 计划引入暗场真实噪声对——我们起步即真实噪声）。
- 文本蒙版（ESAM3 + prompt bin）、深度蒙版（DepthAnything）——参照仓库没有的能力。
- 模型下载链路：镜像回退（自定义镜像 → 官方 → hf-mirror）+ HTTP Range 断点续传 + SHA256 校验 + 进度事件（`ai_processing.rs:1199-1245`）。
- 双端覆盖（桌面 + Android）。

---

## 2. AI 功能效果改善方案

### P0-1 场景分类升级：复用已有 CLIP 做零样本分类（性价比最高）

**现状**：[scene_classify.rs](file:///workspace/src-tauri/src/scene_classify.rs) 用 64px 缩略图统计启发式（天空蓝/植被绿/暖色/皮肤比例 + 亮度分位），4 类（风景/人像/夜景/美食），置信度门槛 0.75（`DISPLAY_CONFIDENCE_GATE`，L13）。

**问题**：启发式有天花板——室内人像（无蓝天绿地信号）、暗调美食、夜景人像必然误判/漏判；置信度由手工权重合成（`best_score * 1.15 - second_score * 0.3`，L201），无概率语义。Android 端照片场景更杂，皮肤启发式（R>95 等固定阈值）对暗色皮肤/逆光系统性偏低。

**方案**：`clip_model.onnx` + tokenizer 已内置（文本蒙版已在使用），**零新增下载**即可做零样本分类：

1. 图像塔 embedding × 场景文本提示（每类 8~12 条 prompt ensemble 取平均，如 "a portrait photo of a person" / "a landscape with mountains and sky" / "a night scene with city lights" / "a close-up photo of food"），softmax 温度缩放输出概率。
2. 文本 embedding 建议构建期预计算并随包分发一个小的 prompt-embedding bin（我们已有先例：ESAM3 的 `efficientsam3_sky_prompt.bin` / `_face_prompt.bin` 模式），运行时免 tokenizer/文本塔。
3. **降级链**：CLIP 会话不可用 → 完整回落到现有启发式（`scene_classify.rs` 全保留），符合"诚实实现"约定。
4. **批次分位数校准**（借参照仓库挑图的理念："阈值取这一批自身的分位数"）：图库/相册多张同批时，用批内分布校准 confidence，避免夜景批次整体被压到门槛以下。
5. 0.75 展示门槛保留，语义从手工分变为 softmax 概率；i18n 文案不变。

**收益**：AI 推荐卡（移动端 CrystalAiToolsPanel 的场景配方推荐）准确率显著提升，且是唯一不需要用户下载任何新模型的大升级。

### P0-2 AI 质量回归测试体系（参照仓库最可移植的资产）

**现状**：`src-tauri/tests/` 已有 golden_render、consistency_determinism、metrics_tests、wgsl_validation——覆盖渲染管线，但没有 AI 专属断言；前端无任何单测。

**移植清单**（对应参照仓库 tests/）：

| 断言 | 做法 | 防住的缺陷 |
|---|---|---|
| **掩膜外逐位不变** | LaMa/蒙版/降噪 blend 全部断言 `m == 0` 区域逐位相等；注意羽化尾部 `0 < m ≤ 1e-6` 属于掩膜内（参照仓库实测踩过，`m <= 1e-6` 的写法会误报） | "只作用于 7% 画面的算子改动了其余 93% 像素"类静默缺陷（他们一次抓到 7 个） |
| **tile 稳定性** | 同一图换 tile 网格两次推理，max diff < 0.01（他们实测 0.00118） | 分块推理接缝 |
| **参数单调性** | aiDenoiseAmount/aiDenoiseDetail、各 strength 滑杆：输出噪点能量/效果强度随参数单调（monotonic.py 思路） | 滑杆"越调越乱" |
| **PSNR 基线** | 固定噪声等级 + 固定 crop（training/train_denoise.py:35-58 的做法），NIND 模型换版时锁定 +4~5.5dB 量级基线 | 模型升级造成静默回退 |
| **CI 模型缓存** | 模型目录按 manifest 内容 hash 做缓存 key（`models-${{ hashFiles('tools/models_manifest.json') }}`） | CI 重下几百 MB |

### P0-3 AI 诊断面板：防"静默回退"

**参照教训**（README"打包坑 2"）：GPU `is_available()` 为 True、设备名正确，但真正分配显存时 DLL 缺失 → 静默回退 CPU，超清 9.2s→109s，表面诊断全部正常。

**现状**：`get_ai_model_inventory`（`ai_processing.rs:3387`）只报模型文件在位；`ai_provider` 默认 `"cpu"`（`app_settings.rs:743`）；Android 无 GPU EP（`ai_processing.rs:602-605` 直接返回 None），但用户与开发者都无从感知各模型实际跑在哪个设备上。

**方案**：
1. 新增 `diagnose_ai` 命令：每个持久 session 记录实际生效的 EP；每模型跑一次 32×32 实测推理报耗时（把"假阳性"变成可验证事实）；一次性返回 版本 / 平台 / EP / 模型清单+落点+首推耗时 / 下载校验状态。
2. 设置页展示 + "复制诊断报告"按钮（版本、设备、EP、最近 5 条 AI 错误）——用户报障直接粘贴，对齐参照仓库"关于 → 复制诊断报告"的排障闭环。
3. `ai_provider` 的 UI 如实标注各平台可用值：Windows=DirectML、macOS=CoreML、Android=CPU（并标注当前值）。

### P1-1 LaMa 契约加固（消除/移除效果直接提升）

对照 `engine/lama.py` 与 README 的四轮调试记录：

1. **输出量程自检**：从输出自身检测量程（0-255 / [0,1] / [-1,1]）再归一化——把 0-255 输出当 [0,1] 裁剪会让所有 >1 的值压成白色，"填补"结果 96.7% 纯白。核对我们在 `ai_processing.rs` 中 LaMa 输出的归一化假设。
2. **mask 预处理契约**：喂给模型前洞内像素必须清零（`image * (1 - mask)`）——官方管线如此，带内容的洞会输出平白区域。
3. **窗口化执行**：只跑覆盖 mask（dilate 扩展后）的窗口，`touched` 区域显式返回（`engine/lama.py:173-263`）——大图上消除一角的耗时可降一个量级。
4. **大面积诚实引导**：hole 占比超阈值时返回 guidance 事件而不是硬跑（他们实测校准：单路人 hole≈11% 可自动、多紧挨路人 ≈29% → 引导转创成式）。前端弹"建议缩小涂抹范围/改用××"，不产出垃圾结果。

### P1-2 分割与蒙版质量

1. **guided filter 贴边后处理**（`engine/matting.py:138-190`）：alpha 掩膜与亮度引导滤波融合，发丝/肩部软边。BiRefNet 输出质量好但边缘仍可借亮度引导滤波收尾。
2. **多人合影强制保护区**：selfie_multiclass 是**单主体**模型——参照仓库 8 人合影实测 3 个主角中 2 个被当路人误删。修复方案：人脸框按解剖比例（头顶=脸上缘-0.42×脸高，头高=1.72×脸高）扩出粗掩膜，与语义 subject 取**并集**构成"绝不处理区"，不依赖分割质量。
3. **分位数归一化**（`engine/semantic.py:77-123`）：各类置信掩膜用百分位自适应归一化，固定阈值在合成/真实图间失效。
4. **overlap 判定用 raw confidence**：归一化会把背景弱响应拉高，0.86 占比的人物被算成路人（他们实测）；主体重叠判定必须用 raw 聚合。
5. **检测分辨率陷阱**：检出率对输入尺寸**非单调**（YuNet 同一张 60px 小脸 900~1300px 稳定检出、>1400px 反而消失）。人脸/关键点管线固定在 ~900px 长边检测后把框映回原尺度。

### P1-3 AI 降噪精细化

1. **strength 语义化**：NIND UTNet 模型名中的 684 对应训练噪声等级体系；核对模型是否带噪声等级条件输入，若有则把 `aiDenoiseAmount` 映射到等级输入（而非仅做输出混合比例）——参照仓库 `engine/nndenoise.py:112-173` 正是把 strength 映射回训练噪声等级。我们现有的 luma_keep/chroma_keep 双通道混合（`ai_denoise.rs:337-358`）保留为第二层控制。
2. **真实噪声回归基线**：用高 ISO/暗场样张建立 PSNR/SSIM 基线（见 P0-2）。我们是真实噪声模型，正可以把"换模型不回退"钉住。
3. **低频恢复独立验证**：`restore_low_frequencies`（`ai_denoise.rs:363-412`）的 64px 块均值 + 盒滤波补低频已实现——补"开关前后低频保真"与"tile 稳定性"两个专项测试。
4. **Android 性能档**：CPU 推理下评估 fp16/量化模型档位与 tile 尺寸按内存自适应（超低端设备自动降 tile）。

### P1-4 懒加载与预热

- 参照教训：CLIP `from_pretrained` 默认联网检查更新，无网阻塞 300s；首载 32s 在请求路径上 → 改 `local_files_only` + 启动预热 → 3.7s。
- 我们：首次启用 AI 功能时 session 初始化在调用路径上。加**空闲预热**：图片打开后后台预初始化常用模型（降噪/分割），UI 显示"AI 就绪"状态；下载与初始化区分开（下载已有进度事件，初始化也应可感知）。

### P2（探索/立项评估）

| 项 | 要点（参照仓库实测参数） |
|---|---|
| **P2-1 超分辨率** | RealESRGAN x4：tile=256、overlap=32 加权混合、推理锁防并发（`engine/superres.py:167-246`）；移动端可选更小的 x2/compact 档 |
| **P2-2 AI 挑图/智能分组** | CLIP embedding 查重 + 技术分组（模糊/欠曝/过曝/重复），阈值取**批内分位数**而非固定常数——固定阈值会把整批夜景标成欠曝。Android 相册场景收益大；我们已有 CLIP 资产 |
| **P2-3 参考图追色** | Reinhard/直方图联合匹配：亮度先匹配、色度按亮度比例缩放（Lab 独立重映射 L 会毁饱和度：实测 0.167→0.072，占损失 90%） |
| **P2-4 Android EP** | 当前 CPU EP；评估 XNNPACK EP、NNAPI 现状与 ort 版本兼容性；配合 P1-3 的 fp16 档 |
| **P2-5 桌面生成式填充（可选组件）** | 外挂 ComfyUI + 健康探测（`/api/health` 的 generative_fill 模式）；他们的诚实结论值得先读：SD1.5 inpaint 不够自然（生成区锐度 0.32），SDXL 更好（0.40）且保邻区完整；但**祛路人是内容延续任务，LaMa 才是对的工具**——SDXL 在窄人形掩膜里会"发明假人"。大区域重造才走生成式 |

---

## 3. 其他方面改善方案

### 3.1 测试与 CI
- 前端零单测：对 AI 参数逻辑补 vitest——`getAiDenoiseEnablePatch`（按 provider 生成启用补丁）、enhance 三档强度映射、`aiDenoiseAmount/Detail` 缺省值（自检修复过的 100% 缺省语义）。
- CI 失败时上传产物（参照仓库 `if: failure()` 上传 out/ 排障）；Rust golden 测试失败时上传对比图。

### 3.2 错误可诊断性与支持闭环
- Rust panic hook + 前端未捕获异常落盘 error.log（含命令名与堆栈，保留最近 N 条）。
- 关于页"复制诊断报告"（与 P0-3 合并实现）。

### 3.3 合规与文档
- 建 `THIRD_PARTY.md` 逐模型许可表：**模型许可独立于代码**。我们全部模型来自 CyberTimon/RapidRAW-Models，需逐个登记上游许可（mediapipe=Apache-2.0 安全；SAM/LaMa/DepthAnything/MoGe 各自许可需核对登记）。
- 参照仓库 ROADMAP 的教训：insightface 系模型仅限研究用途=商用障碍，他们现在要花一个周期换模型。**选型时就查许可**，我们现有清单正好借此机会盘点一遍。
- 补 SECURITY/PRIVACY（"照片不出本机"是卖点，隐私声明要跟上）。

### 3.4 性能工程（可直接抄的数字）
- **区域窗口化**：他们把人脸相关处理裁到脸周窗口——`build_regions` 2024→93ms、皮肤滤波 5302→870ms（脸只占 1.8% 像素）、关键点降采样推理 2412→300ms。我们的 landmarks/multiclass 管线同样做窗口化 + 降采样推理。
- 缩略图 LRU、RAW 内嵌 JPEG 预览提取（632→13ms）、`IMREAD_REDUCED_COLOR_8` 等价解码路径。

### 3.5 UX 诚实性（参照仓库最强的方法论）
- **不适用就如实空态**：绿色占比 <5% 时 applicable=false，不硬猜。
- **guidance 引导而非静默失败**：自动路径质量上限不足时明确告诉用户更好的路径（联动 P1-1 LaMa guidance）。
- **批次自适应阈值**：所有"自动"判定（曝光/模糊/场景）用批内分位数，不用固定常数。
- **版本单一来源 + 更新检查**：版本号一处定义；更新检查走 Releases latest 接口，不可达静默降级。

### 3.6 发布工程
- Windows 代码签名（参照仓库实测过的路径）：Certum 开源开发者证书（约 €25-70/年，最对口）/ SignPath.io 开源免费计划 / Azure Trusted Signing（$9.99/月）。无签名 SmartScreen 警告直接影响转化。
- 对照其打包三坑自查：模型路径 `sys.frozen` 分派（Tauri 对应 resource dir）、GPU DLL、诊断接口——我们 Tauri 架构基本免疫前两者，但资源目录与 EP 静默回退仍需 P0-3 钉住。

---

## 4. 落地路线图

| 优先级 | 事项 | 主要涉及 | 预期收益 | 风险 |
|---|---|---|---|---|
| **P0** | CLIP 零样本场景分类（+批次分位数校准+启发式降级） | scene_classify.rs、ai_processing.rs | AI 推荐准确率大升，零新增模型下载 | CLIP 会话内存占用；需预热策略 |
| **P0** | AI 质量回归断言（局部性/tile 稳定/单调/PSNR 基线） | src-tauri/tests/、CI | 钉住所有 AI 算子不静默退化 | 测试耗时需控（小尺寸用例） |
| **P0** | AI 诊断命令 + 诊断报告复制 | ai_processing.rs、SettingsPanel | 排障闭环；防静默 CPU 回退 | 低 |
| **P1** | LaMa 四项契约（量程自检/洞清零/窗口化/大面积 guidance） | LaMa 调用链 + 前端提示 | 消除效果+速度直接提升 | guidance 交互需 i18n |
| **P1** | 分割质量包（guided filter 贴边/多人保护区/分位归一/900px 检测） | 分割与人脸链路 | 发丝边缘+多人合影安全 | 计算量增加，需窗口化 |
| **P1** | 降噪 strength 语义化 + 真实噪声基线 + Android fp16 档 | ai_denoise.rs、模型资产 | 高 ISO 效果可控可复核 | 模型条件输入需验证 |
| **P1** | 空闲预热 + "AI 就绪"状态 | 会话初始化链路 | 首用延迟下降 | 生命周期管理 |
| **P2** | 超分 / AI 挑图 / 追色 / Android EP / 桌面生成式 | 新功能立项 | 功能面扩展 | 各自独立评估 |

## 5. 不建议照抄的部分

- **torch 运行时**（4GB CUDA 库）：我们 ort 直跑 + WGSL 已更轻。
- **ComfyUI 进程内强依赖**：如做生成式，保持"可选外挂 + 健康探测"模式。
- **WebView2/Python 桌面架构**：Tauri 体积与启动优势明显。
- 参照仓库"对商业软件做静态分析提取功能规格"的来历表述有合规敏感性，学习其工程方法即可，文案与命名保持完全原创。

---

### 附：本次核对过的参照仓库关键实现（file:line）

- `engine/nndenoise.py:112-173` strength→噪声等级映射、tile/overlap/feather、设备自动选择
- `engine/superres.py:167-246` tile=256/overlap=32 加权混合、推理锁
- `engine/lama.py:173-263` 窗口化执行、touched 统计
- `engine/semantic.py:77-123` raw confidence + 分位数归一化；`:200-239` size 限制与掩膜回贴
- `engine/matting.py:138-190` MODNet + guided filter 贴边
- `engine/match.py:202-282` 追色（亮度先匹配、色度按比例）
- `training/train_denoise.py:35-58` 固定噪声等级 PSNR 评估
- `tools/models_manifest.json` 13 文件 sha256 清单；`.github/workflows/ci.yml` 11 套回归 + 模型 hash 缓存 + 失败产物
