# ZhaJinWenQianCake vs 透影 Crystal · AI 算法 / 推理 / AI 引擎三层全面对比

> 基于 https://github.com/wmc-ccb/ZhaJinWenQianCake 全量 222 文件通读（engine/ 62 模块、server/app.py 4667 行、training/、tools/、tests/ 60+ 套、8 篇工程文档），对照透影 Crystal v2.1.16（Tauri 2 + Rust）AI 链路逐项比对 · 2026-11-06

---

## 0. 两项目定位与总体架构

| 维度 | ZhaJinWenQianCake（参照） | 透影 Crystal（本项目） |
|---|---|---|
| 形态 | Windows 桌面「像素蛋糕」复刻，Python 单体服务 | 跨平台（主战 Android）修图 App |
| 技术栈 | Python 3 + FastAPI（app.py 4667 行）+ WebView2 | Tauri 2 + Rust + React TS |
| AI 运行时 | **onnxruntime + PyTorch 双栈混用**（onnx / pt / tflite / safetensors 四种模型格式并存） | **纯 Rust ort 单栈**（onnx + 预计算 prompt bin） |
| GPU 路线 | CUDA（手动注册 torch/lib 的 cuDNN/cuBLAS DLL），无卡则 CPU | 桌面 DirectML / CoreML；Android 纯 CPU |
| 模型资产 | 13 个（GitHub Release 分发 980MB，瘦发行版） | 9+ 个（按需下载，三镜像回退） |
| 内存画像 | 空载 525MB、峰值 2400MB；ComfyUI 常驻 ~8GB（15 分钟空闲自动停） | ResidencyTracker 空闲淘汰，移动端内存优先 |
| 进程边界 | AI 全部在 Python 服务进程内 + 生成式外挂 ComfyUI 子进程 | AI 全部在 Rust 主进程内，无外挂 |

**一句话定性**：参照仓库是「桌面算力换功能广度」——13 个模型、生成式外挂、五官级编辑，但内存与 EP 治理粗糙（CUDA DLL 手动注册、会话永不释放）；透影是「移动约束换工程深度」——模型清单更聚焦但推理架构（EP 路由、驻留淘汰、机型分档、诊断）明显更干净。两边在**质量测试方法论**上的差距是参照仓库最大的领先点。

---

## 1. 算法层对比（逐能力）

### 1.1 总览表

| 能力 | ZhaJinWenQianCake | 透影 Crystal | 胜方 |
|---|---|---|---|
| 主体抠图 | MODNet 24.7MB（soft alpha）+ **双模型 max 融合** + 引导滤波 | BiRefNet-lite + SAM vit_b + ESAM3（文本/点提示）+ 引导滤波 | 透影（交互能力代差） |
| 语义分割 | selfie_multiclass **tflite**（MediaPipe 原生形态 16MB）+ 分位数归一化 | 同源 ONNX + 分位数 remap | 平手（他们有移动端原生形态） |
| AI 降噪 | **自训练** 2.4M U-Net（合成噪声）+ strength 双语义 + FlatFieldLoss | NIND UTNet（**真实噪声数据集**）+ 低频恢复 | 透影（数据底子）；方法论互有胜负 |
| 消除/填充 | LaMa fp32 208MB，fixed-512 native-res 多窗口 | LaMa fp16，mask 外扩单窗口 + 机型像素预算 | 架构同源；他们窗口策略更保纹理 |
| 超分辨率 | RealESRGAN x4 RRDBNet **源码重建** + valid-center tile | 无 | **参照独有** |
| CLIP | 仅图像塔 ViT-B/32 335MB（挑图/去重） | 图像塔 + tokenizer：文本蒙版 + 场景零样本 + 挑图 | 透影（用法广度） |
| 人脸链路 | YuNet 5 点 + **106 dense** + SegFormer-B2 五官解析 338MB + 解剖比例几何 | ESAM3 face prompt + 头区解剖比例保护 | 参照（五官级编辑我们没有） |
| 天空替换 | **纯程序化**（分割∩颜色 + 地平线衰减 + 分形云，零推理成本） | ESAM3 sky prompt + 头区保护带 + 引导滤波 | 各有路线：他们零成本，我们掩膜质量高 |
| 生成式填充 | ComfyUI 外挂 SD1.5 inpaint + ControlNet，FLUX.1 Fill 11GB 可选 | 无 | **参照独有** |
| 姿态/手部 | MediaPipe pose/hand landmarker（rigfix/手脚修复） | 无 | **参照独有** |
| 深度/法线 | 无 | Depth Anything V2 + MoGe-2 | **透影独有** |
| 场景识别 | 无（挑图不分类） | CLIP 零样本 4 类 + 启发式降级 | 透影独有 |

### 1.2 主体抠图：hybrid 融合策略是参照仓库的亮点

参照 [matting.py](file:///tmp/ZhaJinWenQianCake/engine/matting.py) 的默认路径不是单模型，而是**三源互补**（`subject_alpha`，mode=hybrid）：

1. **MODNet** 出 soft alpha（发丝逐根跟随），但它按「人像抠图」训练——眼镜、耳环、项链、手持道具常被判为背景**静默删掉**；
2. **selfie_multiclass subject**（非背景类并集）补回配饰——MODNet 删掉的对戒在语义模型里是 accessories 类；
3. 两者取**逐像素 max**，再统一过 guided filter（亮度引导，radius=4、eps=1e-4）把软边吸附到真实亮度边缘。

输入预处理同样有三处工程细节：长边 768 + 32 倍数对齐（encoder-decoder skip 拼接要求）、**reflect pad 而非边缘复制**（避免背景色渗入蒙版边缘）、返回值带 `source` 字段如实标注实际用了哪条路径。

透影对应：BiRefNet-lite（显著物）+ SAM vit_b（点交互）+ ESAM3（文本/天空/人脸 prompt），尾部接 `fast_color_guided_filter`（半径 16、eps 0.001、系数双线性上采样）——引导滤波收边两边同构。**差距**：我们没有「双模型 max 融合」的组合策略（单模型失效时无互补兜底）；**领先**：ESAM3 文本提示抠图是参照仓库完全不具备的交互形态。

### 1.3 语义分割：分位数归一化与小区域羽化禁忌

参照 [semantic.py](file:///tmp/ZhaJinWenQianCake/engine/semantic.py) 的 `Regions` 类是一套**跨图置信度校准**方法论：

- 掩膜**按模型原样保存**，绝不默认可信——同一模型在真实照片上皮肤类置信度 ~0.95，在风格化图上全局 ~0.02；固定阈值 0.35 会把 0.043 置信度的人脸判成零面积（实测案例），**静默关掉整个皮肤处理**且无任何报错；
- 对策：`pct_norm` 按自身分布归一（p55→0、p92→1），**并集类先合并再归一**（`_union_norm`）——逐类单独归一会让弱置信类与强置信类同等响度；
- `overlap` 判定用 raw confidence 而非归一化后的值（归一化会把背景弱响应拉高，0.86 占比的人物被算成路人）；
- **小区域禁羽化**：覆盖率 <2% 的掩膜（眼/唇/鼻）跳过高斯——全图尺度 sigma=1 的高斯把 lips 从 0.0035 稀释到 0.001（[automask.py](file:///tmp/ZhaJinWenQianCake/engine/automask.py) 注释实测值）。

透影对应：天空路径已有 `percentile_mask_remap`（p99 满值刻度），理念同源。**可对齐检查项**：我们的小区域掩膜（ESAM3 文本命中区）是否有同样的「羽化稀释」风险；overlap 判定是否全部用了 raw 值。

### 1.4 AI 降噪：自训练路线 vs 真实数据路线

参照 [nndenoise.py](file:///tmp/ZhaJinWenQianCake/engine/nndenoise.py) + [training/](file:///tmp/ZhaJinWenQianCake/training) 是一条完整的**自训练闭环**（训练脚本在仓库内）：

- 模型：2.4M 参数 residual U-Net，**预测噪声而非直接出图**（head 零初始化 = 初始恒等映射），GroupNorm + LeakyReLU；
- 噪声合成：read σ∈[0,0.03] 高斯 + shot 噪声（σ=k√signal 异方差）+ **色度噪声 ×1.6**（真实传感器拜耳采样色度强于亮度）；
- 损失：`FlatFieldLoss` = L1 + 梯度差惩罚（权重 0.08）——纯 L1 会留低频斑块，梯度项保平坦区真的平；
- 推理：**strength 双语义**——既选网络假设的噪声水平（read_sigma=0.03k、shot_k=0.05k 线性映射训练域），又做与原图的混合系数，滑杆连续可导、0 是严格 no-op；
- tile：512/overlap 64，**raised-cosine 窗口**混合（比线性 ramp 无缝），16 倍数对齐 reflect pad。

透影对应：NIND UTNet（真实噪声数据集）+ tile（cs=504）+ 权重混合 + `restore_low_frequencies` 低频恢复——数据底子和低频恢复是我们强。**可借鉴**：① strength→训练噪声水平映射的语义（我们的强度滑杆目前只做混合，无噪声水平先验）；② FlatFieldLoss 思想对应我们的低频恢复，方向一致但他们在训练侧解决（更根本）；③ raised-cosine 窗口形状（我们当前混合权重可对比测试）。

### 1.5 LaMa 消除：两边同构，窗口策略哲学不同

参照 [lama.py](file:///tmp/ZhaJinWenQianCake/engine/lama.py) 的完整契约（透影 P1-1 已吸收量程自检/洞内清零/窗口化/诚实引导四条）：

- **fixed-512 导出 + native-res 窗口**：窗口按原图分辨率取 512（pad 到位），**绝不 resize**——「把 700px 帧拉伸进 512×512 会扭曲模型要延续的纹理颗粒尺度，结果是错误颗粒度的合理填充」（原文注释）；大消除区多窗口平铺；
- 洞内清零 `img*(1-mask)`（官方管线契约，违反则输出平白区，实测洞内 mean 0.84）；
- 输出量程从输出自身检测（>1.5→/255、<-0.05→[-1,1] 归一），四轮调试沉淀；
- mask 先椭圆膨胀（防物体边缘 1px 残影轮廓）+ 羽化合成；
- **只跑覆盖 mask 的窗口** + `touched` 区域显式返回（供调用方做精确 locality 断言）；
- 收尾裁剪只作用于 touched 区——「解码帧可能带 1.0 出头的值，全帧 clip 会在窗外每个像素移动 1 ULP」，防逐位泄漏。

透影对应：fp16 模型、mask 外扩窗口（1.5× + 128px 下限）后**缩放到机型预算**（旗舰 768²/中端 576²/低端 448²，32 倍数对齐）、`lama_output_scale` 量程自检、`LAMA_MAX_HOLE_RATIO=0.35` 引导。**实质差异**：我们缩放窗口省算力（移动端正确取舍），但按参照仓库的实测逻辑，缩放改变了纹理尺度——LaMa 在小分辨率上延续的纹理映回原图会有颗粒感偏移。这是**移动端算力 vs 纹理保真的已知取舍**，报告中如实记录，可留作未来「native-res 窗口 + 小预算」的 A/B 项。

### 1.6 超分辨率：参照仓库工程最扎实的一项（透影空白）

[superres.py](file:///tmp/ZhaJinWenQianCake/engine/superres.py) 三点值得整段记录：

1. **源码重建 RRDBNet**（23 个 RRDB、BSD-3 架构公开）而非 import basicsr——basicsr 依赖树巨大且被新 torch 打破过；`load_state_dict` 的键名严格对齐官方 checkpoint（`conv_up1/conv_up2`）；
2. **valid-center tile**：tile 256 / overlap 32，**只写每块的有效中心、边缘直接丢弃**而非混合——RRDBNet 感受野宽，边缘是从有限上下文算出来的，「混合整块等于把好坏区域平均，产生淡淡的纹理网格」；overlap=32 是实测不出网格的最小值；ramp 宽度按**输出像素**（overlap×4）计算；
3. **推理锁全程串行**：torch forward 不保证线程安全，upscale 已任务化并发——GPU 本该排队，CPU 串行只是慢不是错。

透影无超分。**若补齐**：RealESRGAN 可导出 ONNX 走 ort（他们的 torch 依赖在移动端不可复制），tile 策略可直接套 valid-center 方案；x4plus 67MB（fp32 pth）导出 fp16 ONNX 约 34MB，Android 可承受。

### 1.7 CLIP：他们只用图像塔挑图，我们一塔三用

参照 [cliponnx.py](file:///tmp/ZhaJinWenQianCake/engine/cliponnx.py)：动机是打包——transformers+torch 4.2GB 只为一个图像塔不值得；ONNX 版 335MB 与 transformers 输出契约完全一致（L2 归一化后点积即余弦相似）。预处理严格 CLIP 标准（短边缩放→中心裁 224→ImageNet 型 CLIP 均值方差），批 8。用途单一：挑图（连拍里按互相相似度分组 + 去重阈值 0.965 + 清晰度/曝光辅助分）。线程：intra_op = cpu/2（全仓唯一显式设线程处）。

透影对应：clip_model.onnx + tokenizer，用于 ① ESAM3/文本蒙版链路、② 场景零样本分类（v2.1.16 新增，prompt embedding 预计算免文本塔）、③ tagging 挑图。**用法广度透影赢**；**挑图侧可借鉴**：他们对连拍批次的打分是**批内相对比较**（查重阈值、相似度分组），天然免疫单图绝对分波动——与我们 P0-1 的「批内分位数校准」同源，挑图路径可检查是否已用批内相对分。

### 1.8 人脸链路：参照仓库深两个数量级

参照的人脸栈是四层（[face.py](file:///tmp/ZhaJinWenQianCake/engine/face.py)、[faceparse.py](file:///tmp/ZhaJinWenQianCake/engine/faceparse.py)、[landmarks.py](file:///tmp/ZhaJinWenQianCake/engine/landmarks.py)、[automask.py](file:///tmp/ZhaJinWenQianCake/engine/automask.py)）：

1. **YuNet** 232KB ONNX（5 点）——cv2.FaceDetectorYN，非线程安全（见 §2.6 惨案）；
2. **106 dense landmarks**（2d106det 5MB，face-alignment 同源）——鼻翼/眉弓/下颌轮廓从「外推」变「实测」；
3. **SegFormer-B2 faceparse** 338MB safetensors，19 类→6 组五官（眉/眼/唇/口腔/鼻/面肤）——注意这是**全仓唯一 transformers 加载**的模型（其余全 ONNX/tflite）；关键工程细节：SegFormer 在 512 人脸裁剪上训练，**直接跑全图五官类全部塌缩到 0**（实测 eyes 0.0001、brows/mouth/nose 0.0），必须先检脸→外扩 1.35× 裁剪→解析→贴回全图；
4. **解剖几何推导**：眼盒由眼距定尺寸（ew=0.42×eye_dist）、唇带由嘴角连线+眼距定高、protect（眼/眉/鼻/唇硬保护）+ soft_shade（眼窝/鼻侧/颏沟**软抑制**——这些区域本来就该暗，瑕疵检测会把宽梯度当斑点，硬排除会留环，软抑制权重 0.92/0.75/0.70 让真斑点仍可检出）+ plateau 门（全权重平台+1.42 边缘锥形，普通径向衰减在 0.7 半径处已 <0.4 会静默压掉额头/下颌瑕疵）。

透影对应：ESAM3 face prompt（预计算 embedding bin）+ `head_zone_from_boxes` 头区解剖比例保护（头顶 -0.42×脸高、头高 1.72×）。**差距**：我们没有 106 点、没有五官解析、没有 soft_shade 软抑制概念——五官级编辑（嘴唇增色、眼睛提亮）在移动端做不了。**领先**：ESAM3 特征一次编码多 prompt 复用，五官掩膜不需要第二个 338MB 模型——若未来要五官编辑，ESAM3 face prompt + 解剖比例是比 SegFormer 更省的路线。

### 1.9 天空替换：零推理成本路线 vs 生成掩膜路线

参照 [sky.py](file:///tmp/ZhaJinWenQianCake/engine/sky.py) 完全不用神经网络生成内容：

- 判据 = **分割 ∩ 颜色似然**（蓝天色相 190–250° 或过曝低饱和）——只用颜色会在白衣服上误判，所以先用 selfie_multiclass background 类排除人物/前景；
- **地平线衰减**：逐行平均似然从上往下找峰值 45% 行，以下清零——玻璃幕墙/水面的蓝天反光不该被替换；
- 上部强先验（越靠上越可能）+ 形态学开运算去碎斑 + 羽化；
- 新天空 = 竖直渐变（γ=1.6 模拟大气散射，地平线更亮）+ 太阳光晕（距离衰减 ^2.2）+ 分形值噪声云；**亮度匹配**：原图天空上下分段中位数→增益 clamp[0.55,1.8]，避免合成感；
- 9 个预设全部程序化，推理成本为零。

透影对应：ESAM3 sky prompt decoder 出掩膜 + 头区保护带 + 引导滤波，新天空同样有亮度/色彩适配。**评价**：两条路线各成立——他们的方案在**模型未下载、低端机、批量处理**场景完胜（零成本、确定性）；我们的掩膜在**复杂天际线**（树梢、电线、建筑轮廓）上质量更高。可作为透影的「无模型降级路线」储备。

### 1.10 生成式填充与姿态手部（参照独有，移动端评估）

- **ComfyUI 外挂**（[genfill.py](file:///tmp/ZhaJinWenQianCake/engine/genfill.py)、[comfy_mgr.py](file:///tmp/ZhaJinWenQianCake/engine/comfy_mgr.py)）：SD1.5 inpaint + ControlNet inpaint fp16 常驻外挂进程，FLUX.1 Fill 11GB 为可选高质量档（T5 有 fp8 替代）。进程内生命周期管理：按需 subprocess 拉起 python_embeded、就绪探测与 genfill.available() 同判据（面板状态与功能可用性「说同一句话」）、**15 分钟空闲自动停止还回 8GB**、只 terminate 自己拉起的进程。三个 ComfyUI schema 坑（LoadImage 必须先 POST 到 /upload/image、ControlNet image 要 IMAGE 非 MASK、noise_mask=True 必传）全部注释在案。合成回贴只在 mask 区羽化贴回，未触碰像素逐位不变。
- **姿态/手部**：MediaPipe pose_landmarker_lite + hand_landmarker（.task），用于形体液化修复（rigfix）、手脚修复（handfoot）——把 106 点/33 点骨架当「结构先验」约束液化变形，避免背景撕裂。

**移动端评估**：生成式填充在 Android 纯 CPU 上不可行（SD1.5 一次若干十秒），除非未来接 NPU 授权方案；姿态/手部 landmarker 有官方 Android tflite 形态，**可移植性高**，若透影未来做形体液化可直接考虑。

---

## 2. 推理层对比

### 2.1 运行时与模型格式

| 维度 | ZhaJinWenQianCake | 透影 Crystal |
|---|---|---|
| 推理库 | onnxruntime（GPU/CPU）+ torch（降噪/超分）+ MediaPipe（分割/姿态）+ transformers（faceparse） | ort crate（全部） |
| 模型格式 | onnx、pt、tflite、safetensors、task 五种 | onnx + 自有 prompt bin |
| 依赖体积 | torch CUDA 库 4.0GB（「用户没 N 卡就是白下载」——HANDOVER 自评）；ONNX 化 CLIP 省下 transformers+torch 4.2GB | 无 torch，ort 原生链接 libonnxruntime.so（v1.22.0 + sha256 钉版） |
| 版本治理 | requirements.txt 浮动 | build.rs 钉版本 + 校验和 |

**结论**：透影的「单栈单格式」在打包体积、版本钉定、启动时间（无 torch 导入 2-4s）上全面占优；参照仓库自己是受害者——他们把 CLIP 从 torch 迁到 ONNX 正是为了甩掉 4.2GB，但降噪/超分仍锁死在 torch（.pt 无法被 ort 直接加载），是**下一个该 ONNX 化的候选**。

### 2.2 EP（执行提供者）路由

| 维度 | ZhaJinWenQianCake | 透影 Crystal |
|---|---|---|
| GPU EP | CUDA（ort-gpu） + torch cuda | DirectML（Win）/ CoreML（mac）；Android 无 EP |
| GPU 可用性保障 | **手动注册 torch/lib DLL**（cuDNN 9/CUDA 12.8 随 torch 分发），app.py import 前兜底注册 | 无需：系统级 DirectML/CoreML |
| 失败行为 | provider 初始化失败**静默回退 CPU**——打包版曾 cublasLt64_12.dll 加载失败被 torch 吞掉，超清 9s→**109s** 而诊断信息一切正常 | GPU 失败**显式日志 + 永久回落 CPU**（`GPU inference failed, using the CPU ... from now on`），诊断端点报实际生效 EP |
| 真伪验证 | /api/diagnose **真跑 512×512 fp16 matmul ×10 + 显存查询**——「is_available() 为 true 但初始化失败是打包环境最常见的假阳性」 | diagnose_ai：逐模型 32×32 实测推理 + sessionBuildMs + CLIP 224px 探针 + 机型档位 |

两边都被「静默回退」咬过、都用「真跑一次」破解——这是共同的工程结论，透影的版本多了**每模型粒度**和机型分档信息。

### 2.3 精度与输入尺寸策略

| 项 | ZhaJinWenQianCake | 透影 Crystal |
|---|---|---|
| 模型精度 | fp32 为主（LaMa fp32 208MB、CLIP fp32）；仅 GPU 超分 `net.half()` | LaMa fp16、多数模型轻量版 |
| 输入对齐 | MODNet 32 倍数 reflect pad；降噪 16 倍数 reflect pad；LaMa 8 倍数 reflect pad——**pad 不 resize** 是统一哲学 | 降噪 tile cs=504；LaMa 窗口缩放至机型预算（resize，纹理尺度有损取舍） |
| 固定 vs 动态 | LaMa 导出固定 512（多窗口平铺）；MODNet/降噪动态尺寸 | 均动态尺寸 |
| tile 混合 | 降噪 raised-cosine 窗口全混合；超分 **valid-center 只写中心丢弃边缘**（两套策略按网络感受野特性分用） | 降噪 margin 权重混合 |

值得注意：参照仓库对**同一类问题（tile 边缘伪影）用了两种相反策略**——降噪网络感受野窄、tile 边界误差小，混合即可；RRDBNet 23 个稠密块感受野宽、边缘质量差，必须丢弃。策略跟着网络特性走，不是万能公式。

### 2.4 线程与机型分档

- 参照：全仓仅 CLIP 显式设 `intra_op_num_threads = cpu_count/2`，其余全部 ORT 默认；实测 4 线程并发初始化 OK。无机型概念（桌面单机）。
- 透影：ai_perf 机型分档（旗舰/中端 2 线程、低端 1 线程、桌面默认零改动）+ LaMa 像素预算分档（768²/576²/448²）。**透影领先**——参照仓库的 CPU 病理案例（1000s+ 只能 kill）在移动端会更致命，分档是必要防线。

### 2.5 会话生命周期与内存

- 参照：每模块全局单例 + `threading.Lock` 双重检查，**会话一旦建立永不释放**（桌面语境的合理选择，但空载 525MB、峰值 2400MB）；ComfyUI（8GB）靠看护线程 15 分钟空闲停止回收；startup 后台线程预热 CLIP（懒加载首调 300s 超时事故 → HF_HUB_OFFLINE=1 + 预热 → 3.7s）。
- 透影：`ResidencyTracker`（`idle_only(android)` / `for_platform`）——用后驻留 + 空闲淘汰，移动端内存正确答案；无启动预热（内存取舍）；CLIP 免下载初始化（`get_or_init_clip_models_if_downloaded`）对齐「不联网探测」。

### 2.6 并发安全（参照仓库两起真实事故）

1. **cv2.FaceDetectorYN 非线程安全**：服务端线程池并发处理时，两线程同时进 setInputSize/detect 触发原生断言，偶发把进程拖进死循环（GIL 被原生代码占住，全端点无响应，**CPU 烧到 1000s+ 只能 kill**）——对策：类级全局 `_detect_lock`。
2. **torch forward 不保证线程安全**：upscale 任务化后两个并发 job 同时 forward 同一网络——对策：推理全程 `_INFERENCE_LOCK` 串行。
3. ORT 的 `session.run` 本身线程安全（多处注释确认），所以他们的锁粒度是「初始化 + 特定非安全库」，不是全部推理。

透影：Rust 侧 `Mutex<Session>` 天然串行 + 取消令牌（CancelAiTask），无此类事故面。**透影架构性领先**，但参照仓库「把线程安全边界注释在代码案发现场」的习惯值得保持。

### 2.7 模型下载与分发

| 维度 | ZhaJinWenQianCake | 透影 Crystal |
|---|---|---|
| 源 | GitHub Release 单源（models-v1）+ 域名白名单（github.com 等 4 域，防清单篡改 SSRF）+ 路径穿越防护 | 自定义镜像 → 官方 → hf-mirror 三级回退 |
| 校验 | 逐文件 size + sha256 | sha256 |
| 断点 | HTTP Range 续传（.part 追加） | 同 |
| 重试 | 12 次 × 递增退避（3s×n）——「到 GitHub 的链路实测会连续超时几次，预算太紧 980MB 轻易整体失败」 | 有回退链兜底 |
| 进度 | 逐 MB 刷新共享状态——「大文件等整文件完成才更新，进度条卡 0% 好几分钟像死机」 | 进度事件 |
| 状态机 | idle/running/done/error + 单任务互斥 | 任务化 |

两边等价且各有优点：他们**安全加固更细**（SSRF/穿越防护），我们**网络鲁棒性更强**（多镜像）。透影可补的细节：模型文件 size 预校验（下载前 Content-Length 对账）与下载域名白名单。

---

## 3. AI 引擎架构层对比

### 3.1 端点/任务化与队列

参照仓库把长任务全部**任务化**（job id + 轮询 + 取消）：`/api/upscale` 返回 job_id → `/api/upscale/job/{id}` 轮询 → `/cancel`；模型更新同构；ComfyUI 看护线程独立。透影：ai_jobs + CancelAiTask + 前端 busy 蒙层/跨图守卫。**同构，透影事件推送（Tauri event）比轮询体验好**。

### 3.2 诚实降级与适用性判定（参照仓库的核心竞争力）

散布全仓的「如实说做不到」模式：

| 场景 | 处理 | 出处 |
|---|---|---|
| 背景清理纯度 <0.45 | 线性 guard 降到 0，返回 `skipped: 背景不纯（purity=x.xx），跳过破坏性清理` | [bgclean.py](file:///tmp/ZhaJinWenQianCake/engine/bgclean.py) L350-358 |
| 抠图模型半缺 | alpha_hybrid 返回 `source` 字段（none/modnet/semantic/modnet+semantic），UI 如实显示用了什么 | matting.py |
| 语义模型推理失败 | automask 返回 `unavailable: {semantic: 模型不可用或无结果}` 字典而非 500（暴力测试抓到过直接抛异常给前端） | automask.py |
| 降噪无 checkpoint | `available()` 为 false，调用方降级到边缘感知滤波，「挑图仍可用，只是不懂内容相似」 | nndenoise/cliponnx |
| 生成式未安装 | comfy_mgr 返回 `not_installed` 状态，UI 指引点名缺哪个文件 | comfy_mgr.py |
| LaMa 大面积 | （透影已吸收为 LAMA_MAX_HOLE_RATIO 引导） | — |

透影对应：lama_guidance、天空保护带 warn 降级、诊断端点、AI 能力 UI 如实标注平台 EP。**已对齐**；可再对齐的是「降级原因结构化返回前端」的完备度（他们的 `unavailable`/`skipped`/`source` 是字段级契约，不是仅日志）。

### 3.3 可诊断性闭环

参照：`/api/diagnose`（torch/ort 版本、providers、8 个模型在位、**真跑 GPU matmul + 显存**、进程 RSS 读 Windows API 兜底 psutil）+ `/api/errors`（out/error.log 解析，2MB 轮转砍前半、堆栈截断 8000 字符防图片二进制灌爆日志）+ 「复制诊断报告」前端闭环 + `/api/health`/`/api/version`/`/api/network`。

透影：diagnose_ai（平台/EP/逐模型在位+sessionBuildMs+CLIP 探针/机型档/最近错误）+ 复制报告。**粒度透影更细**（每模型 vs 全局），**日志沉淀他们更厚**（error.log 轮转与截断策略值得对齐检查我们的日志路径是否防灌爆）。

### 3.4 质量测试体系（参照仓库最大领先点）

- `tests/verify_locality.py`：**掩膜外逐位不变**断言——一次抓出 7 个静默缺陷（全帧 clip 移 1 ULP、羽化越界等）；配套 `verify_local.py` 把「有效掩膜区」精确返回给测试用（touched 语义）；
- `tests/monotonic.py`：参数单调性回归（强度增大效果必须单调）；
- tile 稳定性实测（平均差 0.00118）、固定噪声等级 PSNR 基线、`coverage_report.py` 41 功能族覆盖度；
- 60+ 验证脚本，11 套进 CI（.github/workflows/ci.yml）。

透影：cargo 单测 79 个（含 LaMa 量程、头区保护、ai_perf 纯函数等逻辑级断言），但**缺「整图像素级 locality」与「参数单调性」两类回归形态**——这两类恰恰是抓「静默质量退化」的网，建议后续补齐（像素级断言在 Rust 侧可对已知输入跑掩膜操作后 assert 窗外像素逐位相等，成本可控）。

### 3.5 其他架构细节对照

| 项 | ZhaJinWenQianCake | 透影 Crystal |
|---|---|---|
| 会话/缓存 | 编辑会话 LRU 8 条；渲染缓存 32 条×~300KB（滑杆回拖瞬时响应） | 图片就绪等待 + 跨图守卫 |
| 错误兜底 | 全局 exception handler → error.log 落盘 + 500 | Rust Result + 事件 |
| 访问安全 | 隧道强制口令、cf-connecting-ip 伪造检测、回环免密 | 本地单用户，无此面 |
| 更新器 | 内置 updater（check/download/cancel/apply + job 轮询） | 应用市场/手动 |

---

## 4. 双向结论

### 4.1 参照仓库领先透影的（含可移植性评估）

| # | 项 | Android 可移植性 |
|---|---|---|
| 1 | **质量回归测试体系**（locality 逐位不变 / 单调性 / PSNR 基线） | **高**——纯方法论，建议优先补 |
| 2 | **超分辨率 RealESRGAN** + valid-center tile | 高——ONNX 化 + fp16 约 34MB，CPU 可跑小图 |
| 3 | 五官解析（SegFormer）+ 106 关键点 + soft_shade 软抑制 | 中——模型大；可先借 soft_shade/plateau 几何思想进头区保护 |
| 4 | 程序化天空（零推理成本、确定性） | 高——可作为「模型未下载」降级路线 |
| 5 | 生成式填充外挂（SD/FLUX + 15min 空闲看护） | 低（纯 CPU 不可行）；桌面版可评估 |
| 6 | 姿态/手部 landmarker（rigfix 结构先验） | 高——有官方 Android tflite |
| 7 | LaMa native-res 窗口（不 resize 保纹理尺度） | 中——与算力预算冲突，可 A/B |
| 8 | 下载安全（域名白名单/路径穿越防护/size 预校验） | 高——纯代码加固 |
| 9 | tflite 原生形态（selfie_multiclass 发布形态） | 中——ort 也可加载 tflite，或评估 MediaPipe Android |

### 4.2 透影领先参照仓库的

| # | 项 | 说明 |
|---|---|---|
| 1 | 交互式/文本抠图（SAM + ESAM3） | 参照只有自动抠图 |
| 2 | 推理单栈（纯 ort/Rust） | 无 torch 4GB、启动快、版本钉定 |
| 3 | EP 路由与失败可观测 | DirectML/CoreML 系统级；失败显式回落 + 诊断可见 |
| 4 | 会话驻留淘汰（ResidencyTracker） | 参照会话永不释放（空载 525MB） |
| 5 | 机型分档推理（线程/预算） | 参照无机型概念，CPU 病理 1000s+ 只能 kill |
| 6 | 深度/法线（Depth Anything V2 + MoGe-2） | 参照无 |
| 7 | 场景零样本分类 + 启发式降级 | 参照挑图不分类 |
| 8 | fp16 模型分发 | LaMa 208MB→~104MB |
| 9 | 每模型粒度诊断（sessionBuildMs/探针/机型档） | 参照 diagnose 是全局级 |

### 4.3 共同结论（两边独立得出、互相印证的工程规律）

1. **「真跑一次」是对抗环境假阳性的唯一手段**——两边都被「报可用实际不可用」咬过（他们 GPU matmul、我们 32×32 探针）；
2. **量程/契约自检优于硬编码假设**——LaMa 输出量程、mask 洞内清零、接口签名读取（`sess.get_inputs()` 而非假设）；
3. **诚实降级是功能可用性的一部分**——结构化字段（source/skipped/unavailable）而非异常或静默；
4. **线程安全边界要注释在案发现场**——FaceDetector 1000s+ 事故、torch forward 锁；
5. **下载必须 Range+校验+宽退避**，进度逐块刷新；
6. **pad 不 resize**（纹理尺度保护）是图像类模型输入的统一哲学（透影 LaMa 预算缩放是已知取舍例外）。

---

## 附：参照仓库关键实测数据索引（供后续查证）

| 事实 | 数值 | 出处 |
|---|---|---|
| 打包版 GPU 静默回退 | 超清 109s vs 源码 9s | HANDOVER 坑 2 |
| CPU 病理 | FaceDetector 竞争死循环 1000s+ | face.py / HANDOVER |
| CLIP 懒加载事故 | 首调 300s 超时 → 预热 3.7s | app.py `_warm_models` |
| 启动/内存 | 46.4s 可用；空载 525MB；峰值 2400MB | HANDOVER |
| LaMa 量程事故 | 0-255 当 [0,1] 裁剪 → 洞内 96.7% 纯白 | lama.py L160-169 |
| 洞内未清零 | mask 内 mean 0.84 平白输出 | lama.py L130-135 |
| 单主体分割误删 | 8 人合影主角头部被填背景 | passersby.py |
| 检测分辨率非单调 | 60px 脸 900–1300px 稳定检出，>1400px 消失 | passersby.py L57-66 |
| 分割置信度漂移 | 真实图 0.95 vs 风格化 0.02；固定 0.35 阈值致零面积 | semantic.py Regions |
| 小区域羽化稀释 | lips 0.0035→0.001 | automask.py L180-190 |
| 超分 tile 最小 overlap | 32px（再小出网格） | superres.py |
| 降噪 tile 稳定性 | 平均差 0.00118 | tests |
| ComfyUI 内存 | 常驻 ~8GB，15min 空闲回收 | comfy_mgr.py |
