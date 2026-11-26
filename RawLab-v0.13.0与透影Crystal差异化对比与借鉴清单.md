# RawLab v0.13.0 与透影 Crystal（v2.1.23）差异化对比与借鉴清单

- **对比对象 A**：[dancancer/RawLab](https://github.com/dancancer/RawLab/releases/tag/v0.13.0) `v0.13.0`（build 25）——C++17 单核心 × macOS/Windows/iOS/Android 四原生客户端，GPL-3.0-only
- **对比对象 B**：透影 Crystal（RapidRAW 衍生）`v2.1.23`——Tauri(React) + Rust/wgpu，桌面五目标 + Android，AGPL-3.0
- **证据源**：RawLab v0.13.0 Release Notes / 仓库 README / v0.11–v0.13 累积特性；Crystal 侧以 [v2.1.23-七大功能域盘点报告](file:///workspace/v2.1.23-七大功能域盘点报告.md) 审计口径为准，辅以代码抽查
- **结论先行**：RawLab 的优势集中在 **HDR（gain-map 编辑）、相机无线工作流（Sony PTP/IP + SSH 隧道）、渲染架构纪律（四端四后端 parity + 视口引擎 + 事务化持久化）** 三条主线；Crystal 的优势集中在 **AI 蒙版/生成/空间特效、调色科学（四映射器/追色/软打样）、图库智能化** 三条主线。0.13 版本最值得"取"的是：**曲线自由端点 X、线性光小波降噪、局部照明影调、gain-map HDR、RLOOK 导入、原子导出事务、发布溯源（BUILD-PROVENANCE）**。

---

## 一、底盘与架构差异（决定哪些东西能借、怎么借）

| 维度 | RawLab v0.13 | Crystal v2.1.23 | 差异结论 |
| --- | --- | --- | --- |
| 核心形态 | 单一 C++17 处理核心，四客户端全部复用（SwiftUI/AppKit、WPF、Compose、iOS） | Rust 核心（Tauri IPC 160 命令）+ React 前端 + WGSL 着色器单源 | 各有道理；Crystal 架构更薄，RawLab 跨端一致性靠"一个核心"硬保证 |
| GPU 后端 | CPU / Metal / D3D11 / GLES 四后端 + 自动 CPU 回退 | wgpu（Vulkan/Metal/DX12/WebGPU）+ CPU 回退；**Linux/Android 展示层未接入 → CPU 预览** | RawLab 在移动端 GPU 覆盖上完胜——GLES 正是 Crystal 缺的那块 |
| 一致性保障 | 跨 4 客户端 24 个 spec 字段对齐 + 颜色渲染契约（color-contract） | 编译期 45264 字节布局断言 + 124 参数 CPU/GPU 一致性测试 + golden 回归 | Crystal 的自动化更强；RawLab 的"契约文档 + 字段对齐"值得补进 docs/contracts |
| 持久化 | `CanonicalEditState` 统一编辑态、`PinnedSourceFile`、`AtomicOutputTransaction`、schema 按需选版（SDR 18 / HDR 19）、**版本不符拒绝而非误读** | sidecar JSON + 84 设置字段；**版本门已借成**（[exif_processing.rs](file:///workspace/src-tauri/src/exif_processing.rs#L292) `probe_future_sidecar_version`，新版拒绝读取；注释即 "RawLab 0.13 borrow"）；`write_file_atomic` 原子写已覆盖导出/缓存/sidecar | 版本拒绝已对齐；剩余：PinnedSourceFile、按需选最低版本 |
| 自动化接口 | lutools CLI + `rawlab_mcp` MCP 服务器 + Agent 配方 + 公开 Edit JSON 契约，与 App 共用同一核心 | **已具备同构能力**：[cli.rs](file:///workspace/src-tauri/src/cli.rs)（capabilities / validate / image-info / export，内嵌 adjustments-schema.json）+ [tools/mcp](file:///workspace/tools/mcp/server.py) MCP 服务器（与 RawLab 5 工具同契约） | 已对齐；可继续扩展 MCP 工具面（如 headless 曲线/批量编辑） |
| 移动架构 | 3-way Android JNI 拆分、Apple `RawLabKit` 双轨 | Android 为主端（React 面板）+ Rust 复用 | Crystal 无 iOS；RawLab 无 Linux。平台哲学不同，不互借 |

---

## 二、v0.13.0 版本特有增量（本次 Release 的"新东西"）

| # | 0.13 新增 | 说明 | 对 Crystal 的意义 |
| --- | --- | --- | --- |
| 1 | **曲线自由端点 X** | 主曲线与 R/G/B 通道曲线端点可沿 X 内移（`x0`/`x_{n-1}`），端点范围外输入**平钳到端点 Y**；点曲线/参数曲线画布隔离；Windows 双击删除跨 `ReleaseMouseCapture` 保持 | 直接对位 Crystal 曲线系统（WGSL 16 点数组、端点固定 0/1），可整体移植思路 |
| 2 | Sony SSH Access Auth + α7M5 双卡槽导入 | SSH 隧道 + localhost 转发 + 连接 UI，覆盖 iOS/Android | Crystal 完全没有移动端相机无线链路 |
| 3 | 选择性诊断日志 + 云上传 | 会话录制、全前缀路径脱敏、ZIP 导出、阿里云 SLS 上传 | 借"本地脱敏诊断"部分；云上传与 Crystal 本地隐私定位冲突，不建议 |
| 4 | 桌面 HDR/Agent 热重载改进 | Windows `sync_photo_edit` 热重载、HDR 空域对齐、RGBA16 诊断 C API | 诊断 API 思路可用于 Crystal 的 CPU/GPU 漂移排查 |
| 5 | Android 检视叠加层打磨 | 检视 HUD 拖动不淡化、缓存环修复、检视胶囊 UX | Crystal 移动端有对比模式，交互细节可参考 |
| 6 | v0.13 架构深化（W-A~W-F） | ViewportRenderEngine 抽取、GPU/金字塔 C ABI、统一文档/持久化协调器、`PinnedSourceFile`/`AtomicOutputTransaction` 落库 | 架构级借鉴，见 §四 |

---

## 三、功能差异化对比清单

> ✅=双方齐平 / ⭐A 独有优势 / 🔵B 独有优势 / ⚠️=部分具备

| 功能域 | RawLab v0.13 | Crystal v2.1.23 | 结论与借鉴方向 |
| --- | --- | --- | --- |
| RAW 显影基础（曝光/WB/影调/曲线/HSL/分级/清晰度/去雾/锐化/暗角） | ✅ 全套；曝光 ±5 EV；processing version 3 重调过 highlights/shadows/contrast/vibrance/clarity/dehaze | ✅ 全套 + 124 参数一致性测试 | 齐平；Crystal 可参考其"处理版本化 + 旧编辑校验后升级"策略 |
| **蒙版与局部调整** | ❌ 无蒙版系统（仅选择性复制/粘贴/同步，且应用前可预览将变更的字段） | ⭐ 六类 AI 蒙版（SAM/BiRefNet/EfficientSAM3/Depth V2/MediaPipe）+ 人脸九区 + 画笔 | Crystal 大幅领先，无需借鉴 |
| **AI 生成/修复/液化** | ❌ 无 | ⭐ LaMa 本地 + ComfyUI 自托管 + 云；液化/克隆/修饰 | Crystal 独有 |
| **空间特效（Relight/Fog/景深/Glow/Halation/Flare）** | ❌ 无（有确定性颗粒） | ⭐ 深度/法线驱动全套 | Crystal 独有 |
| **HDR** | ⭐ gain-map HDR JPEG/HEIF + ProRAW 全四端 HDR 编辑；**HDR 与 SDR 编辑分离**；HDR looks、峰值限制；导出 gain-map JPEG / HEIF | ⚠️ 包围曝光合成 HDR（[hdr_deghosting.rs](file:///workspace/src-tauri/src/hdr_deghosting.rs) 对齐+去鬼影）；无 gain-map HDR | **最大功能差距**。RawLab 是"编辑手机/相机直出 HDR 文件"，Crystal 是"合成 HDR"——两条不同赛道，见 §六 P1 |
| 色调映射科学 | 仅全局重调参数 | ⭐ basic/AgX/PBR Neutral/ACES 四映射器 | Crystal 领先，保留 |
| 追色/参考图调色 | ❌ | ⭐ Lab 均值+分位曲线追色（ΔE 指标） | Crystal 独有 |
| 软打样 | ❌ | ⭐ 4 色域 × 4 渲染意图（WebGPU 平台受限） | Crystal 独有 |
| **相机连接** | ⭐ Android Wi-Fi PTP/IP 导入 + 实时取景遥拍（点击对焦/焦点框），iOS preview；0.13 加 SSH 隧道 + α7M5 双卡槽；增量导入断点续传 | ⚠️ 桌面 tethering（gphoto2 路线，mac/Linux 发布物） | 互补：Crystal 有桌面 USB、无移动 Wi-Fi。借 RawLab 的 Sony PTP/IP + SSH 隧道补移动端 |
| 图库/工作流 | collections、每图编辑记忆、铅笔标记缩略图、Edited/Unedited 过滤、**可续传批量导出（冻结设置/取消/重试）**、Open With/拖放/分享 | masonry 图库、批量重命名、Immich 集成、AI 选片/CLIP 标签、pick/reject；**可续传批量导出已具备**（[export_journal.rs](file:///workspace/src-tauri/src/export_journal.rs) G5：冻结设置 + pending/failed 续跑） | 基本对齐；剩余可借"铅笔标记缩略图"；Crystal 的 AI 图库智能化 RawLab 没有 |
| 预设/配方 | 内置 film looks + 14 master recipes，0–200% 强度；CUBE/**RLOOK** 导入；分类/搜索/最近 | 0–200% 强度；26 胶片 LUT + 14 大师配方；CUBE/.3dl/HALD 导入 | 齐平；**RLOOK（Sony 相机创意外观）导入是 Crystal 缺的增量** |
| 导出 | JPEG / 16-bit PNG / **渲染 DNG（嵌预览）**；临时文件+完成后替换；分阶段导出不损已有文件 | 多格式 + 超分 2×/4× + ICC + XMP 元数据 + DPI/边框；**原子输出已具备**（[export_processing.rs L1663](file:///workspace/src-tauri/src/export_processing.rs#L1663) 最终图像走 `write_file_atomic`） | 剩余可借 **DNG 导出**；Crystal 的超分/边框 RawLab 没有 |
| 平台覆盖 | macOS/Windows/iOS/Android 四原生 | Windows/macOS/Linux ×（tethering 变体）+ Android arm64 | 各补对方短板；iOS 非短期目标 |
| 语言 | 6 语 | 15 语 | Crystal 领先 |
| 诊断与隐私 | ⭐ 选择性诊断会话（脱敏）+ ZIP 导出 + 可选云上传；匿名 RUM 统计可关 | 无诊断会话机制 | 借本地部分（脱敏会话录制 + ZIP），不做云上传 |
| 许可/模型 | GPL-3.0；AI 降噪模型（DualDn/Restormer）**非商业许可**、无 CPU 回退 | AGPL-3.0；NIND 开源 + BM3D 兜底（AI-Free 模式） | Crystal 的"AI 可降级"设计更稳，不要学 RawLab 的硬依赖 |

---

## 四、图像算法差异化清单

| # | 算法点 | RawLab 实现 | Crystal 实现 | 差异与借鉴 |
| --- | --- | --- | --- | --- |
| 1 | RAW 解码 | LibRaw（Sony/Fuji/Canon/Nikon/Panasonic/Pentax）+ **自研 X3F 渲染**（Sigma DP1S/Merrill/Quattro）+ ProRAW + 手机 gain-map HDR | LibRaw 系 + Apple RAW（ProRAW）+ 常规格式 | 缺口：X3F（小众，P2）、gain-map HDR（P1） |
| 2 | **高光/阴影（局部照明）** | "Local-illumination highlights/shadows"——按局部亮度感知做分区影调，是全端核心卖点 | 全局软压缩 + 细节增益（WGSL），上游另有保色高光重建与中间尺度细节回注 | **最值得借的影调算法**：局部照明式 tone mapping 可复用 Crystal 已有的 5 级 mip 金字塔（glow 管线）做亮度引导，边缘感知权重防晕轮 |
| 3 | **降噪（经典）** | **线性光小波降噪**：亮度/色度/粗色度三通道独立控制 + 确定性颗粒 | BM3D（非破坏）+ ISO 联动 sigma 噪声模型 | 互补：小波 NR 无模型依赖、CPU/GPU 皆快、结果稳定——正好补 AI-Free 模式与移动端 CPU 路径的第三条路（BM3D 慢、NIND 要模型） |
| 4 | 降噪（AI） | DualDn/Restormer（CoreML/DirectML，授权模型包，**无 CPU 回退**，Intel mac 排除） | NIND（开源模型）+ AI-Free 自动落 BM3D | 保留 Crystal 设计：可降级优于硬依赖；不引入 RawLab 的授权模型 |
| 5 | **曲线** | 0.13 自由端点 X：`x0`/`x_{n-1}` 可内移，越界平钳到端点 Y；主曲线+RGB 通道；点/参数画布隔离；schema 18/19 按需版本化 | 点曲线（luma/R/G/B 各 16 点）+ 参数化曲线双模式；**自由端点已具备**：拖拽钳制允许端点内移（[Curves.tsx L382-387](file:///workspace/src/components/adjustments/Curves.tsx#L382-L387)），WGSL 端点平钳（[shader.wgsl L458-461](file:///workspace/src-tauri/src/shaders/shader.wgsl#L458-L461)）与 CPU 参考 `eval_curve`（[harness.rs L412-425](file:///workspace/src-tauri/src/testing/harness.rs#L412-L425)）逐行等价 | **基本已对齐（首版清单误判为"端点固定 0/1"，已修正）**。剩余交互细节：非精细模式 5px 吸附使端点在 0/255 附近偏"粘"；删除为右键菜单（RawLab 为双击删除） |
| 6 | HDR 处理 | gain-map 编辑 + HDR→SDR 统一编码 + HDR 峰值限制 + `rawlab_hdr` 处理版本 10 | 包围曝光合成（特征对齐 + 去鬼影 + 曝光融合） | 不同赛道：gain-map 编辑需解码器 + 分离编辑态 + HDR 导出编码三件套，工程量大，见 P1 |
| 7 | 去雾/清晰度 | processing v3 重调 | 边缘感知去雾（上游重写版）+ log 空间引导滤波局部调整 | 齐平偏 Crystal |
| 8 | 胶片颗粒 | 确定性 grain（跨帧稳定） | 颗粒（量/尺寸/粗糙度） | 齐平；"确定性"（种子化、缩放无关）值得核对 Crystal 实现是否跨分辨率稳定 |
| 9 | 镜头校正 | lensfun 系 + 暗角校正开关 | lensfun + 9 参数手动 | 齐平 |
| 10 | 白平衡 | 相机空间 WB | as-shot 推导 + 吸管 + 曝光基线补偿 + Kelvin 采样 | 齐平偏 Crystal |
| 11 | 负片/特殊 | sony2fuji CLI（配方转换工具链） | 负片翻拍（RGB 权重可调） | 各有侧重，不互借 |
| 12 | 双光源/色域压缩 | — | 双光源 RAW 色彩矩阵 + 色域压缩（上游 2026-10-24） | Crystal 领先 |

---

## 五、渲染算法与管线差异化清单

| # | 渲染点 | RawLab | Crystal | 差异与借鉴 |
| --- | --- | --- | --- | --- |
| 1 | 后端矩阵与回退 | CPU/Metal/GLES/D3D11 四后端，曲线等新特性**四端四后端同日齐发**（特性 parity 纪律） | wgpu 单源 WGSL + CPU 回退；Linux/Android 展示层缺失 → CPU 预览降档 | **借纪律不借代码**：为每个渲染特性建立"后端 × 平台 parity 清单"；中期用 wgpu 的 GL 后端补 Android GLES |
| 2 | 视口引擎 | `ViewportRenderEngine` 统一抽象 + 移动端 1:1 ROI 分块渐进缩放 + 检视叠加层 | gpu_processing + 5 级缓存管线 + 自适应画质 0.3–0.5 + 预览变换缓存 | 借"统一视口引擎 + ROI 分块渐进"思路优化 Crystal 移动端 1:1 缩放 |
| 3 | 位深/编码 | 核心 HDR→SDR 统一 `RGBA8/BGRA8` 编码；**RGBA16 诊断 C API**；ProRAW/显示预览 ABI | CPU/GPU 双路径 45264 字节布局断言；无 HDR 编码核心 | RGBA16 诊断出口可低成本加入 Crystal（导出中间缓冲做 CPU/GPU 漂移取证），与其一致性测试体系天然互补 |
| 4 | 编辑态与持久化 | `CanonicalEditState` 单一真相 + `PinnedSourceFile`（防编辑中文件被替换）+ `AtomicOutputTransaction`（导出原子化）+ Android/Windows 文档协调器统一 | sidecar + 设置持久化；**原子写已具备**（`write_file_atomic` 覆盖最终导出、journal、sidecar、缓存） | 剩余可借：PinnedSourceFile（源文件编辑锁）、编辑态单一结构体 |
| 5 | schema 版本纪律 | 写端选"满足特性的最低 schema"（18/19）；读端版本不符**拒绝而非误读** | **读端版本门已借成**（`probe_future_sidecar_version`，新版 sidecar 拒绝读取并告警，不做降级覆写） | 剩余：写端按需选最低版本（当前恒写当前版本） |
| 6 | 同步/热重载 | Windows `sync_photo_edit` 热重载；`gui_store` 统一锁 | Tauri 事件 55 发送/55 监听双向匹配 | 齐平 |
| 7 | 自动化出口 | CLI + MCP + Agent 配方共用同一核心与 Edit JSON 契约 | **已具备**：[cli.rs](file:///workspace/src-tauri/src/cli.rs) 四子命令 + 内嵌参数 schema + [tools/mcp](file:///workspace/tools/mcp/server.py)（RawLab 同契约 5 工具） | 已对齐；首版清单误判为"无 headless 出口"，已修正 |
| 8 | 发布溯源 | `BUILD-PROVENANCE.json` + `SHA256SUMS` + Hosted CI 限制记录 | 签名审计 + golden/performance 门禁，无 provenance 文件 | **本次已补**：release.yml 新增 `provenance` job（SHA256SUMS.txt + BUILD-PROVENANCE.json），verify 纳入门禁 |
| 9 | 更新体系 | Sparkle EdDSA + P-256 manifest + 最低版本门控 | Tauri updater + 签名 secrets 审计 | 齐平，不借 |

---

## 六、取长补短建议（按优先级）

### P0 —— 低成本高收益（2026-11-26 复核后修订）

> 复核结论：首版清单中 4 项其实**已在仓库中落地**（部分为先前会话按 RawLab 思路实施，代码注释留有 "RawLab 0.13 borrow" 痕迹），本次核实并修正，剩余 P0 仅 2 项。

| # | 事项 | 复核状态 | 说明 / Crystal 落点 |
| --- | --- | --- | --- |
| 1 | 曲线自由端点 X（拖拽内移 + 越界平钳） | ✅ **已存在（首版误判）** | 拖拽钳制 [Curves.tsx L382-387](file:///workspace/src/components/adjustments/Curves.tsx#L382-L387)、WGSL 平钳 [shader.wgsl L458-461](file:///workspace/src-tauri/src/shaders/shader.wgsl#L458-L461)、CPU [harness.rs L412-425](file:///workspace/src-tauri/src/testing/harness.rs#L412-L425) 三处齐备 |
| 2 | 原子导出事务 | ✅ **已存在** | [export_processing.rs L1663](file:///workspace/src-tauri/src/export_processing.rs#L1663) 最终图像走 `write_file_atomic`；journal/缓存/sidecar 亦然 |
| 3 | 读端 sidecar 版本拒绝 | ✅ **已存在** | [exif_processing.rs L292-319](file:///workspace/src-tauri/src/exif_processing.rs#L292-L319) `probe_future_sidecar_version`；剩余"写端按需选最低版本"为可选增强 |
| 4 | 发布溯源 BUILD-PROVENANCE.json + SHA256SUMS | ✅ **本次已实施** | [release.yml](file:///workspace/.github/workflows/release.yml) 新增 `provenance` job；[check-release-assets.sh](file:///workspace/.github/scripts/check-release-assets.sh) 门禁同步 |
| 5 | 源文件编辑锁（PinnedSourceFile 思路） | ⬜ 待办 | 防编辑中文件被外部替换/移动；打开文档流程加句柄持有或打开时快照校验 |

### P1 —— 战略级补强（1–2 个月）

| # | 事项 | 来源特性 | 说明 |
| --- | --- | --- | --- |
| 6 | **线性光小波降噪**（luma/chroma/coarse-chroma 三控） | §四-3 | AI-Free 模式与移动端 CPU 路径的最佳兜底：无模型、确定性、可 GPU 化；与 BM3D（精度）形成快/慢两档 |
| 7 | **局部照明高光/阴影**（local tone mapping） | §四-2 | 复用 glow 管线 5 级 mip 金字塔做亮度引导，输出为 highlights/shadows 的增强模式（保留全局版做回退） |
| 8 | **gain-map HDR 读取 + 编辑**（iPhone/安卓 HDR 照片直读 → HDR/SDR 分离编辑 → gain-map JPEG 导出） | §四-6 | 最大功能差距；建议分三步：先解码显示 → 再分离编辑态 → 最后 HDR 导出编码 |
| 9 | **RLOOK 导入**（Sony 相机创意外观文件） | §三 预设行 | 与现有 CUBE/.3dl/HALD 解析器同构，增量小；对 Sony 用户吸引力大 |
| 10 | **Android GLES 展示层**（wgpu GL 后端） | §五-1 | 解决 Crystal 最大的平台缺口（Android CPU 预览降档）；借 RawLab"移动端 GPU 必达"的纪律 |

### P2 —— 长线观察

| # | 事项 | 说明 |
| --- | --- | --- |
| 12 | Sony Wi-Fi PTP/IP 移动端导入 + 实时取景（含 SSH 隧道、α7M5 双卡槽、断点续传） | 大工程；与现有桌面 gphoto2 tethering 互补成"桌面 USB + 移动 Wi-Fi"完整链路 |
| 13 | 渲染 DNG 导出（嵌嵌入式预览） | 工作流通用性增强 |
| 14 | 诊断会话录制（前缀脱敏 + ZIP 导出；**不含云上传**） | 远程排障能力 |
| 15 | RGBA16 诊断出口 + 后端 parity 清单制度化 | 质量体系建设 |
| 16 | Sigma X3F 渲染 | 小众市场，视用户量决策 |

### Crystal 必须保留的差异化优势（RawLab 没有，是竞争壁垒）

1. **AI 蒙版六类 + 人脸九区精修**（RawLab 完全没有蒙版系统）
2. **生成式修复/液化/克隆**（LaMa/ComfyUI/云三通道）
3. **深度/法线驱动的空间特效**（3D Relight/雾/景深/Glow/Halation/Flare）
4. **四色调映射器（AgX/ACES/PBR Neutral/basic）+ 参考图追色 + 软打样** 的调色科学纵深
5. **AI 选片/CLIP 标签/Immich 集成** 的图库智能化
6. **AI-Free 模式 + 全算法可降级** 的离线可靠性（RawLab AI 降噪无 CPU 回退，反例）
7. 15 语本地化、包围曝光合成 HDR、超分导出

### 不建议引入（明确放弃项）

- **DualDn/Restormer 授权模型包**：非商业许可 + 硬 GPU 依赖，与 Crystal 的 AI-Free 设计冲突
- **诊断云上传（阿里云 SLS）与 RUM 统计**：与"本地、隐私"产品定位冲突，只借本地脱敏部分
- **Apple RawLabKit 双轨 / 四原生客户端路线**：与 Tauri 架构哲学冲突，成本不可承受
- **iOS 客户端**：非当前平台矩阵目标

### 许可注意事项

- 两个项目均为 copyleft：RawLab 为 GPL-3.0-only，Crystal 为 AGPL-3.0。**算法思想、参数设计、交互方案可自由借鉴**；若直接复制代码，GPLv3 代码并入 AGPLv3 项目在许可证方向上兼容（需保留原版权声明），但建议优先重写实现以保持代码风格与 WGSL/Rust 技术栈统一。
- RawLab 的 film looks 与 AI 模型权重有独立许可，**不可搬运资产**。

---

## 七、一句话总结

RawLab 0.13 是一个"**渲染纪律与工作流纵深**"型项目（四端一核、HDR、相机无线链路、事务化持久化），Crystal 是一个"**AI 能力与调色科学纵深**"型项目（蒙版/生成/特效/四映射器）。经 2026-11-26 代码级复核，两仓自动化底座（CLI/MCP/原子写/版本门/续传导出/曲线端点）**已实质对齐**；真正值得继续"取长"的是：**发布溯源（本次已补）、小波降噪、局部照明影调、RLOOK 导入、Android GLES、gain-map HDR**；同时守牢 AI 蒙版、生成修复、空间特效、可降级设计这四条 Crystal 独有的护城河。

---

## 八、实施记录（2026-11-26）

### 8.1 复核修正（首版清单误判 4 处）

| # | 首版判断 | 复核结论 | 证据 |
| --- | --- | --- | --- |
| 1 | Crystal 曲线端点固定 0/1，自由端点需完整移植 | **已具备**：拖拽钳制/WGSL 平钳/CPU 参考三处齐备 | [Curves.tsx](file:///workspace/src/components/adjustments/Curves.tsx#L382-L387)、[shader.wgsl](file:///workspace/src-tauri/src/shaders/shader.wgsl#L455-L461)、[harness.rs](file:///workspace/src-tauri/src/testing/harness.rs#L409-L425) |
| 2 | 导出直写，无原子事务 | **已具备** `write_file_atomic`（最终导出 + journal + sidecar + 缓存 13 处调用） | [export_processing.rs L1663](file:///workspace/src-tauri/src/export_processing.rs#L1663)、[file_management.rs L1392](file:///workspace/src-tauri/src/file_management.rs#L1392) |
| 3 | sidecar 无版本拒绝策略 | **已具备**，且注释明示 "RawLab 0.13 borrow" | [exif_processing.rs L292-319](file:///workspace/src-tauri/src/exif_processing.rs#L292-L319) |
| 4 | 无 headless 出口（CLI/MCP） | **已具备** CLI 四子命令 + MCP 服务器（与 RawLab 5 工具同契约） | [cli.rs](file:///workspace/src-tauri/src/cli.rs)、[tools/mcp/README.md](file:///workspace/tools/mcp/README.md) |

另核实：可续传批量导出（export_journal G5）、大师配方/LUT 集成（functional-modules-audit 第十三轮，含 RawLab GPL 归属文件）均为既有落地项。

### 8.2 本次新增实施：发布溯源（P0-4）

- [release.yml](file:///workspace/.github/workflows/release.yml)：新增 `provenance` job（needs: prepare + release），下载本 Release 全部资产 → 生成 `SHA256SUMS.txt`（sha256sum 标准格式）与 `BUILD-PROVENANCE.json`（tag/ref/commit/run/触发事件/UTC 时间戳/逐资产 sha256+size）→ 删除同名旧资产后回传 Release；`verify` 改为依赖 provenance 完成后执行。
- [check-release-assets.sh](file:///workspace/.github/scripts/check-release-assets.sh)：`required_patterns` 增加 `SHA256SUMS.txt` 与 `BUILD-PROVENANCE.json`，使 precheck/verify 门禁覆盖溯源资产；dispatch 重跑场景由 provenance job 先删旧再传，避免资产名冲突。
- 兼容性说明：仅对本次改动之后的新构建生效；旧 Release 走 dispatch 重跑时会自动补齐溯源资产。
