# AlcedoStudio → anwuRAW（Android 端）融合技术规划方案

> **基线**：我方 anwuRAW v2.0.2（`tauri.conf.json` / `Cargo.toml`，git `0a35145`）；目标仓库 zidage/AlcedoStudio v0.3.3（git tag，2026）
> **分析方式**：双仓库全量代码级取证（AlcedoStudio 克隆快照 + 本仓库工作区），所有结论附 `文件:行号` 或仓库相对路径
> **2.x 融合主题**：**借力补位** —— 把 AlcedoStudio（C++20 原生、CUDA/OpenCL/Metal、桌面优先）中**架构思想可移植、算法可重写、数据资产许可友好**的部分，融合进我方 Tauri 2 + Rust + WGSL 技术栈的 Android 端，优先补齐"交互式 AI 蒙版、HDR 交付、专业输出变换、编辑历史"四大缺口
> **配套文档**：[functional-modules-audit.md](file:///workspace/functional-modules-audit.md)（v1.6.14 模块审计）、[image-pipeline-improvement-plan.md](file:///workspace/image-pipeline-improvement-plan.md)（v2.0 渲染管线方案，本方案与其 M0-M6 阶段衔接）

---

## 0. 执行摘要

### 0.1 两个仓库的关系判断

AlcedoStudio 与本项目**不是同源分叉，而是同一赛道的独立实现**：

| 维度      | AlcedoStudio v0.3.3                                                                                                      | anwuRAW v2.0.2（我方）                                                                                                                               |
| --------- | ------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 技术栈    | C++20 + Qt，CMake + vcpkg，Rust sidecar                                                                                  | Tauri 2 + Rust + React/TS，WebView UI                                                                                                                |
| GPU 后端  | 原生 CUDA（Windows）/ OpenCL（Windows）/ Metal（macOS），83 个 kernel 文件                                               | wgpu/WGSL 统一计算管线（桌面已启用，Android 显示路径未接通）                                                                                         |
| 色彩架构  | 场景参照（scene-referred 32-bit float）+ 节点图（Develop → ColorGrade* → DisplayTransform）+ ACES 2.0 / OpenDRT 输出变换 | 显示参照管线 + AgX 近似 / PBR Neutral（[shader.wgsl](file:///workspace/src-tauri/src/shaders/shader.wgsl)）                                          |
| AI 架构   | **进程分离**：Rust gRPC sidecar `puerh_mind`（CLIP 语义搜索、SAM 2.1 蒙版、远程提供商抽象）                              | **进程内**：ort 直连（[ai_processing.rs](file:///workspace/src-tauri/src/ai_processing.rs)），模型运行时下载 + SHA-256 校验                          |
| 目录/存储 | DuckDB 嵌入式目录 + 项目文件（单文件库）                                                                                 | 文件系统直读 + 分组/堆叠（[imageGrouping.ts](file:///workspace/src/utils/imageGrouping.ts)、[stacking.ts](file:///workspace/src/utils/stacking.ts)） |
| 移动端    | **不支持**（仅 Windows x64 + macOS Apple Silicon）                                                                       | **支持**：完整 Gradle 工程（`src-tauri/gen/android`），有已知限制（见 §2）                                                                           |
| 许可证    | GPL-3.0                                                                                                                  | AGPL-3.0                                                                                                                                             |

**结论**：不存在"直接搬运代码"的捷径；可融合的是三类资产——**① 许可友好的模型/数据资产，② 后端无关的架构设计，③ 可重写为 Rust/WGSL 的算法**。且 AlcedoStudio 不支持 Android，我方移动端反而是差异化的落点。

### 0.2 融合候选总览（决策矩阵）

| 级别       | 融合项                                                                                                | 类型                | 合规                    | Android 价值            | 依赖        |
| ---------- | ----------------------------------------------------------------------------------------------------- | ------------------- | ----------------------- | ----------------------- | ----------- |
| **P0-A1**  | SAM 2.1 点提示交互蒙版                                                                                | 模型资产 + 算法重写 | Apache-2.0 ✅           | ★★★ 触屏点选天然契合    | 无          |
| **P0-A2**  | UltraHDR（gain map）导出                                                                              | C++ 库 NDK 集成     | Apache-2.0 ✅           | ★★★ Android 14 原生显示 | 无          |
| **P0-A3**  | AI 模型包分发治理升级                                                                                 | 机制移植            | 自研 ✅                 | ★★★ Android 体积控制    | 无          |
| **P1-B1**  | ACES 2.0 / OpenDRT 输出变换（WGSL）                                                                   | 算法移植            | 需逐项核验              | ★★ 画质跃升             | v2.0-M0     |
| **P1-B2**  | CLIP 编码器驻留管理（residency）                                                                      | 架构移植            | GPL 思想借鉴 ✅         | ★★★ 移动端内存关键      | 无          |
| **P1-B3**  | 非线性版本历史树                                                                                      | 架构移植            | GPL 思想借鉴 ✅         | ★★ 移动端修图工作流     | 无          |
| **P1-B4**  | Lensfun 镜头数据库接入                                                                                | 数据资产            | LGPL-3 + CC-BY-SA-3.0 ⚠ | ★★ 提升校正覆盖         | 无          |
| **P1-B5**  | 远程 AI 提供商抽象 + 凭据保险库                                                                       | 架构移植            | GPL 思想借鉴 ✅         | ★★ 弱网/隐私合规        | 无          |
| **P2-C1**  | DAG 执行计划 + 内容寻址缓存蓝图                                                                       | 架构借鉴            | GPL 思想借鉴 ✅         | ★★★ 但依赖 wgpu 直通    | v2.0-R1-3/4 |
| **P2-C2**  | alcedo-cli 式 Agent 协作闭环                                                                          | 方向参考            | —                       | ★ 长期                  | B5          |
| **P2-C3**  | Nikon HEF（LibRaw fork 解码）                                                                         | C++ 库 NDK 集成     | LGPL-2.1/CDDL ✅        | ★ 移动端场景少          | —           |
| **不建议** | DuckDB 目录 / gRPC sidecar / CUDA-OpenCL-Metal kernel 直移 / OpenCV+CUTLASS / 113 胶片 LUT 抓取再分发 | —                   | —                       | —                       | 见 §6.5     |

### 0.3 投入产出判断

Android 端当前最大的三个缺口（AI 交互蒙版、HDR 交付、专业输出变换）恰好都能从 AlcedoStudio 找到**许可干净的资产与成熟的设计**，且都不触碰我方正在推进的 v2.0 渲染管线重构（M1-M4），可以并行立项。最高性价比的两项（SAM 2.1 蒙版、UltraHDR 导出）均为**新增能力**而非存量行为修改，风险面小、可独立回滚。

---

## 1. AlcedoStudio 全景分析（v0.3.3）

### 1.1 代码结构（子模块为空引用，仅列实际在库内容）

```
alcedo_studio/src/
├── edit/graph/          # 节点图模型：develop_node_model / color_grade_node_model /
│                        #   drt_node_model / pipeline_graph*（Develop/ColorGrade/DRT 节点）
├── edit/runtime/        # ★ 后端无关的执行层核心：
│    ├── graph_compiler.cpp / execution_plan.cpp / static_execution_plan_cache.cpp
│    ├── grade_lut.cpp / grade_schedule.cpp / lut_bake.cpp / runtime_invalidation.cpp
│    ├── result_content_key.cpp   # 内容寻址缓存键
│    └── cuda/ opencl/ metal/     # 三套后端 pass 实现（drt/grade/develop/display_to_ap1…）
├── cuda/nn/             # ★ DemosaicNet 神经 demosaic：conv2d/conv_transpose2d/nhwc/
│                        #   cutlass_conv2d/fused_post_output（GPU 推理图，非 ONNX）
├── ai/ nn/ decoders/ color/ image/ io/ renderer/ storage/ sleeve/ ui/ utils/
├── storage/store/edit_history/commit_graph_store.cpp   # ★ git-like 版本历史 DAG 存储
├── storage/store/ai/ai_store.cpp                        # AI/语义搜索文本存储
├── app/pipeline_document_history.cpp / pipeline_history_applier.cpp / search_query_*.cpp
├── ui/alcedo_cli/cli_commands.cpp                       # CLI 1:1 命令映射
└── third_party/          # 子模块：libraw(fork main_alcedo) / lensfun / libultrahdr(fork
                          #   alcedo-v1.4.0-dither) / opencv / cutlass / protobuf / grpc / metal-cpp
rust/puerh_mind/          # ★ Rust sidecar「alcedo_mind」：gRPC(tonic) 服务
├── server/    # ai_runtime / segmentation(SAM2) / semantic(CLIP) / image_analysis / model_manager / health
├── service/   # lazy_semantic_engine / encoder_residency / ort_runtime / model_adapters /
│              #   credential_vault / provider_config / coreml_clip / legacy_candle(CLIP 备用实现)
└── service/providers/  # openai_chat_compatible / volcengine_ark / anthropic_messages /
                        #   openrouter / openai_codex_oauth（远程图像分析驱动）
scripts/
├── ai_models/  # ai_mask_model_set_v1.json（模型包清单 schema）+ 打包/发布脚本 + NOTICE
└── luts/       # alcedo_lut_metadata.py（ALCEDO_LUT CUBE 元数据 schema-1 校验）+ 打包/发布脚本
docs/           # roadmap / refactor / merge_handoff / issues / doxygen / changelog
third_party_licenses/  # 38 个第三方许可文本（合规底账完整，见 §3.2）
```

### 1.2 五个值得吸收的设计

1. **DAG 执行计划与缓存解耦**：`edit/runtime/` 下 graph_compiler（节点图 → 执行计划）、execution_plan（后端无关调度）、result_content_key（内容寻址键）、static_execution_plan_cache（静态计划缓存）构成一个与 CUDA/OpenCL/Metal 完全解耦的调度层——同一张"节点图 → 计划 → 后端 pass"的架构，可直接映射到 wgpu/WGSL。
2. **版本历史即 DAG**：`commit_graph_store.cpp` 把每次编辑提交为图节点，支持从任意步骤分支变体、永久回退、跨图复制部分 Look——我方目前只有线性 undo + 虚拟副本（[imageGrouping.ts](file:///workspace/src/utils/imageGrouping.ts)），该模型是明确的升级方向。
3. **模型包治理**：`ai_mask_model_set_v1.json` 定义了 role/licenses(含 sha256)/按平台文件映射（Windows=onnx / macOS=mlmodelc）/NOTICE 自动归档，模型不进安装包、首次使用按需下载——正是我方 Android 端需要的体积治理模式。
4. **CLIP 驻留管理**：`lazy_semantic_engine` + `encoder_residency`（5s 周期检查空闲卸载，`main.rs` `ENCODER_IDLE_CHECK_INTERVAL`）+ 无模型时的 `UnavailableEmbeddingEngine` 降级——对内存预算紧张的 Android 是刚需设计。
5. **CLI/Agent 闭环**：每条 UI 动作 1:1 映射 CLI 命令，agent 走"preview → evaluate → adjust"循环操作实时窗口——远期差异化方向。

### 1.3 AI 资产溯源（来自 `ai_mask_model_set_v1_NOTICE.txt`，权威）

| 模型                         | 角色                          | 上游                                                                                 | 许可                                                            | 分发格式                               |
| ---------------------------- | ----------------------------- | ------------------------------------------------------------------------------------ | --------------------------------------------------------------- | -------------------------------------- |
| SAM 2.1 Hiera Tiny           | point_encoder / point_decoder | Meta facebookresearch/sam2，checkpoint `sam2.1_hiera_tiny.pt`（SHA-256 `7402e0d8…`） | **Apache-2.0**                                                  | ONNX fp32（Windows）/ Core ML（macOS） |
| S3OD（people/sky/head 分割） | people_sky_head               | 含 DINOv3 encoder                                                                    | MIT（S3OD）+ **DINOv3 自定义许可** + GPL-3.0（Alcedo 训练权重） | ONNX / Core ML                         |
| CLIP 语义搜索                | 文/图 embedding               | OpenAI CLIP 系                                                                       | MIT 系                                                          | ONNX / Core ML                         |

要点：Alcedo **只做格式转换不改权重**并在 NOTICE 中记录 checkpoint SHA-256——这一合规范式我方应完全复制。其模型包从 `static.aoraw.org` 服务器分发，**不在 git 内，不可直接抓取再分发**。

---

## 2. 我方 Android 端现状（v2.0.2 取证）

### 2.1 运行形态

- 完整 Gradle 工程：`src-tauri/gen/android`（包名 `io.github.CyberTimon.RapidRAW`，继承上游），MainActivity + Tauri Rust 插件构建链。
- Android 专用后端逻辑：[android_integration.rs](file:///workspace/src-tauri/src/android_integration.rs)（`initialize_android` L33-L81 初始化 ndk-context / rustls-platform-verifier；L113-L161 经 JNI 取 `ExternalMediaDirs` 建 `.lut_cache`）。
- 设置默认值按平台降档：[app_settings.rs](file:///workspace/src-tauri/src/app_settings.rs) L766-L784 —— Android 默认 `use_wgpu_renderer=false`、`thumbnail_worker_threads=2`、`image_cache_size=2`。
- 文件系统：库根目录走 Android 专用实现（[file_management.rs](file:///workspace/src-tauri/src/file_management.rs) L3415-L3419）；无保存对话框时导出写 `Downloads/RapidRaw`（L3600-L3604）。
- 前端返回键：[useAndroidBackHandler.ts](file:///workspace/src/hooks/useAndroidBackHandler.ts) L6-L113，模态层栈式 pop（v2.0 方案 E18 已列改进项）。

### 2.2 关键约束（融合方案的边界条件）

| 约束                                                                                                                                                   | 证据                                                                                                                                                                                                                                                                  | 对融合的影响                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| wgpu 预览在 Android 被禁用（GPU compute 可用、显示 surface 未接通）                                                                                    | [platform_features.rs](file:///workspace/src-tauri/src/platform_features.rs) L171-L258（`wgpu_rendering_decision` 对 Linux/Android 恒 false，注释明确"display-surface not wired up yet, R1-3 follow-up"）；[lib.rs](file:///workspace/src-tauri/src/lib.rs) L677-L681 | 任何"实时 GPU 新特效"类融合项都受 B2 断点制约；**模型推理类、导出类、架构类融合不受影响** |
| 预览走 CPU JPEG 编码 + IPC bytes                                                                                                                       | v2.0 方案 B2                                                                                                                                                                                                                                                          | 同上                                                                                      |
| 内存预算极紧（解码缓存 2 张、缩略图 2 线程）                                                                                                           | [app_settings.rs](file:///workspace/src-tauri/src/app_settings.rs) L766-L784                                                                                                                                                                                          | AI 模型必须"按需下载 + 用完卸载"（B2 项 residency 的直接动因）                            |
| AI 模型运行时下载 + SHA-256 校验，目录 `app_data_dir/models`                                                                                           | [ai_processing.rs](file:///workspace/src-tauri/src/ai_processing.rs) L100-L105（CLIP URL+SHA）、L1048-L1051（models_dir）                                                                                                                                             | 已具备模型分发地基，但为**单文件扁平清单**，需升级为 A3 的 model_set 体系                 |
| AI 无平台门控（`ai_commands.rs` 无 android cfg）                                                                                                       | 全文检索                                                                                                                                                                                                                                                              | AI 融合项天然覆盖 Android                                                                 |
| 蒙版能力：已有 SAM ViT-B（encoder + decoder，支持框提示 `generate_subject_mask`）与 EfficientSAM3（天空/文字/人脸提示），**缺的是多轮点选 + 负点交互** | [ai_commands.rs](file:///workspace/src-tauri/src/ai_commands.rs) L509-L545、[ai_processing.rs](file:///workspace/src-tauri/src/ai_processing.rs) L2203-L2260                                                                                                          | A1 收敛为**交互层补齐**（后端点提示已可用）                                               |
| 无 HDR 输出（导出 7 格式，全部 SDR）                                                                                                                   | v2.0 方案 §1.1 交付行                                                                                                                                                                                                                                                 | A2 为净新增能力                                                                           |
| 远程 AI 已有雏形（云端 inpaint 中间件）                                                                                                                | [ai_connector.rs](file:///workspace/src-tauri/src/ai_connector.rs) L1-L30                                                                                                                                                                                             | B5 是对其的架构化升级                                                                     |

---

## 3. 合规性分析（先于可行性）

### 3.1 顶层许可：GPL-3.0 → AGPL-3.0

- AlcedoStudio 整体 GPL-3.0；我方整体 AGPL-3.0（[LICENSE](file:///workspace/LICENSE)）。
- **GPLv3 §13 明确允许**："link or combine any covered work with a work licensed under version 3 of the GNU Affero General Public License into a single combined work"——GPL-3.0 代码可并入 AGPL-3.0 组合作品，GPL 部分保持 GPL 条款，组合作品其余部分按 AGPL-3.0 传递。**方向合法**（反向——把 AGPL 代码并入 GPL 项目——才不可行）。
- 合规义务（每项融合落地时执行）：
  1. 保留对方版权与许可声明（在 `NOTICE`/`THIRD_PARTY_NOTICE.txt` 登记来源仓库、版本、文件清单）；
  2. 对**逐字复制**的代码在文件头标注来源与修改说明（GPL §5(a)）；对**思想借鉴/重写**的代码无强制标注，但建议以注释记录设计出处（工程追溯价值）；
  3. 我方保持 AGPL-3.0 整体开源与源码可获得性（分发 App 包时提供对应源码或书面承诺）。

### 3.2 资产级许可矩阵（来自 `third_party_licenses/` 与模型 NOTICE）

| 资产                                     | 许可                                                  | 再分发结论                                                                                                                                                                            | 附加义务                                                                                                                                            |
| ---------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| SAM 2.1 权重（转换后）                   | Apache-2.0                                            | ✅ 可自行从 Meta checkpoint 转换并随模型包分发                                                                                                                                        | 附 Apache-2.0 文本 + NOTICE 记录源 checkpoint SHA-256                                                                                               |
| S3OD 权重                                | MIT + **DINOv3 License** + GPL-3.0（Alcedo 训练部分） | ⚠ **条件性**：DINOv3 为 Meta 自定义许可（限制用其输出训练竞争模型等条款）；且 Alcedo 训练权重为 GPL-3.0，直接取用将把该模型链路绑入 GPL（我方 AGPL 体系可容纳，但需接受该子件传递性） | 逐条核验 DINOv3 License 文本（`third_party_licenses/DINOv3-LICENSE.md`）后再决定；**默认绕开**：人像/天空分割我方已有自有模型，A1 只用 SAM 2.1 即可 |
| libultrahdr（含 Alcedo dither 分支改进） | Apache-2.0（上游）                                    | ✅ 可 NDK 集成                                                                                                                                                                        | 保留上游 NOTICE；若采纳 fork 的 dither 改动，该改动随 GPL-3.0 仓库整体授权——**用其思想在自有代码中重写更干净**（改动量小）                          |
| Lensfun 数据库                           | LGPL-3.0（代码）+ **CC-BY-SA-3.0（数据）**            | ✅ 可集成                                                                                                                                                                             | 数据文件附带署名与相同方式共享义务（`Lensfun-data-CC-BY-SA-3.0.txt`）                                                                               |
| LibRaw fork（Nikon HEF）                 | LGPL-2.1 / CDDL 双许可                                | ✅ 可集成                                                                                                                                                                             | 动态链接/独立进程可保持 LGPL 边界；静态链接需满足 LGPL 释放条款——Android 上建议以独立 `.so` 集成                                                    |
| RCD demosaic（参考实现源）               | GPL-3.0                                               | ✅（并入 AGPL 组合）                                                                                                                                                                  | 若重写我方 demosaic 可参考其算法；Rawler 已含 RCD，无需重复                                                                                         |
| ACES 相关（aces-core / aces-looks）      | 自带许可文本                                          | ✅ 按文本核验                                                                                                                                                                         | ACES 输出变换以官方数据（矩阵/LUT）+ 自写 WGSL 实现，附许可                                                                                         |
| OpenDRT                                  | **未出现在其 third_party 清单**                       | ⚠ 需核验上游许可（可能为自实现）                                                                                                                                                      | 融合前确认；不可确认则只做 ACES 2.0                                                                                                                 |
| 113 胶片 LUT 包                          | 不在 git 内（aoraw.org 分发）                         | ❌ **不抓取、不再分发**；LUT 数据版权归属不明且为商业分发渠道                                                                                                                         | 改为：支持用户侧导入 `.cube` + 兼容 `ALCEDO_LUT` 元数据注释规范（只读兼容，无版权风险）                                                             |
| darktable / RawTherapee 参考算法         | GPL 系                                                | ✅（并入 AGPL 组合）                                                                                                                                                                  | 重写或并入均需登记                                                                                                                                  |

### 3.3 合规红线（写入每项验收）

- 不得从 `static.aoraw.org` 拉取其商业分发的模型/LUT 包再分发；
- DINOv3 条款核验前，任何融合项不引入 S3OD 权重；
- 所有随包分发的第三方资产必须能从 `NOTICE` + `model_set.json` 双向追溯（来源 URL + SHA-256 + 许可文本）。

---

## 4. 分项融合方案（P0）

### A1. SAM 点提示交互蒙版（单点点选具备，多轮/负点待补）

**实测修正（2026-11-01）**：单点点选**已可用**，无需改代码——[ImageCanvas.tsx](file:///workspace/src/components/panel/editor/ImageCanvas.tsx#L3145-L3186) 在拖拽距离 <5px 时把 `endPoint` 置为 `startPoint`，而 [run_sam_decoder](file:///workspace/src-tauri/src/ai_processing.rs#L2297-L2317) 检测 `start==end` 即切换为单正点（label 1.0）提示。真正缺口只剩：多轮正点累加、负点减选、以及 `AiSubject` 之外的独立"点选蒙版"类型。

**为什么是它**：我方 AI 蒙版已具备 SAM ViT-B 框提示主体分割（`generate_subject_mask`，[ai_commands.rs](file:///workspace/src-tauri/src/ai_commands.rs) L507-L547）与 EfficientSAM3 的天空/文字/人脸提示，**但交互形态仍是一次性框选或单点**；`run_sam_decoder` 内部已支持 point/box 标签数组（[ai_processing.rs](file:///workspace/src-tauri/src/ai_processing.rs) L2297-L2317），缺的是把它做成触屏"点哪儿选哪儿 + 负点减选 + 多轮增量"的交互闭环。Alcedo 的 point_encoder/point_decoder 分层与交互设计可直接借鉴。

**来源证据**：`alcedo_studio/src/edit/runtime/ai_mask_coverage_work.cpp`（蒙版覆盖计算）、`rust/puerh_mind/src/server/segmentation.rs`（SAM2 服务）、`scripts/ai_models/ai_mask_model_set_v1.json`（role: point_encoder/point_decoder）、NOTICE（checkpoint 溯源与 SHA-256）。

**实现方案**（完全自研代码，仅资产与设计取自 Alcedo）：

1. **模型资产**：从 Meta `sam2.1_hiera_tiny.pt`（SHA-256 `7402e0d8…`，取自其 NOTICE——该溯源信息本身可复用）自行导出 ONNX fp32：image encoder（一次性/低频）、prompt encoder + mask decoder（轻量、高频）。执行 Alcedo 同款转换路线，权重不改。
2. **Rust 侧**：[ai_processing.rs](file:///workspace/src-tauri/src/ai_processing.rs) 增 `ModelAsset` 两项（`sam_image_encoder.onnx` / `sam_prompt_decoder.onnx`，URL+SHA-256），复用现有 models_dir 下载校验机制（L1048-L1051）；新增 `sam_mask_from_points` 命令：首点触发 image encoder → 多点/框持续送 prompt decoder → 返回 RLE bitmap。encoder 结果按图像内容键缓存（同图多轮点选零重复计算）。
3. **前端**：[Masks.tsx](file:///workspace/src/components/panel/right/Masks.tsx) 新增 "AI 点选" 蒙版类型；[ImageCanvas.tsx](file:///workspace/src/components/panel/editor/ImageCanvas.tsx) 触摸按下即采集点（正/负点长按切换），渲染 SAM overlay；与现有加减交组合逻辑（`sub_mask` 体系 L1323-L1335）无缝合并。
4. **Android 专项**：ort 执行提供者优先级 `NNAPI > CPU`（fp16 压缩评估，SAM tiny encoder 量化后 <40MB）；encoder 加载纳入 B2 residency（空闲卸载）；image encoder 输入分辨率 1024²，在中端机型上的推理耗时需达验收线（见下）。

**验收标准**：

- 功能：单点 <1.5s 出蒙版（中端 arm64 基准，如 Snapdragon 7 系）；追加正/负点 <300ms 增量更新；蒙版可加减交组合并进入既有渲染参数累加管线；
- 合规：`model_set.json` 登记 Apache-2.0 + 源 checkpoint SHA-256 + NOTICE；
- 性能：encoder 常驻内存 ≤150MB（fp16），空闲 60s 自动卸载；
- 回滚：蒙版类型按 feature flag 可关，sidecar JSON 不含新字段时向后兼容。

### A2. UltraHDR（JPEG gain map）导出

**为什么是它**：Android 14+ 系统相册/壁纸原生显示 UltraHDR（JPEG_R + gain map），而我方导出全部 SDR——移动端拍 HDR、修 HDR、发 HDR 的闭环缺最后一环。Alcedo 维护了带 dither 改进的 libultrahdr fork（`.gitmodules`：`alcedo_studio/src/third_party/libultrahdr`，分支 `alcedo-v1.4.0-dither`），并在 `edit/runtime/drt_post_schedule.cpp` 一带把 HDR 输出接入其管线。

**实现方案**：

1. **构建集成**：上游 libultrahdr（Apache-2.0）以 `cc` crate + NDK 交叉编译接入 `src-tauri`（该库本就是 Google 为 Android 设计，arm64 NDK 编译零障碍；Windows/macOS 桌面同样可编译，避免平台分叉）。
2. **gain map 生成**：我方 WGSL 管线输出 f16 中间结果（导出已走 `Rgba16Float` 读回，[gpu_processing.rs](file:///workspace/src-tauri/src/gpu_processing.rs) L2309）→ 新增 `gainmap_compute` 步骤：SDR 基底（当前 tone map 结果）+ HDR 目标（ISO 21496-1 gain map，多尺度 S 或单尺度可选）→ `ultrahdr_encode` 打包 JPEG_R。
3. **dither 思想自研重写**：Alcedo fork 的 dither 改进（减少 8-bit gain map banding）以 triangular-PDF dither 在 Rust 侧实现（与 v2.0 方案 R5-3 同源技术），**不直接拷贝 fork 代码**，保持资产链路干净。
4. **导出 UI**：[ExportImportProperties.tsx](file:///workspace/src/components/ui/ExportImportProperties.tsx) JPEG 格式新增 "UltraHDR (gain map)" 开关 + HDR 峰值亮度输入；Android 端默认开启预览缩略图 HDR 标记。
5. **衔接**：与 v2.0 方案 R5-1/R5-5（官方 DRT、f16 预览）共享 HDR 基础设施——先有"能产出 HDR 编码"，DRT 落地后自然升级为真 HDR 工作流。

**验收标准**：

- 功能：导出的 JPEG_R 在 Android 14+ 相册显示为 HDR（增益图生效）；SDR 设备回退显示基底 JPEG；文件兼容 ISO 21496-1 校验器；
- 性能：45MP 图 gain map 生成 + 编码增幅 ≤ 25% 导出耗时；文件体积增幅 ≤ 40%（gain map 1/4 分辨率）；
- 合规：Apache-2.0 上游 NOTICE 登记；
- 回滚：开关关闭即回到现状，无 sidecar/设置迁移。

### A3. AI 模型包分发治理升级（model_set 体系）

**为什么是它**：我方现为单文件扁平清单（一个 ModelAsset = filename/url/sha256，[ai_processing.rs](file:///workspace/src-tauri/src/ai_processing.rs) L215-L218）；随着 A1 引入双模型、未来引入更多 AI 能力，Android 端需要"按需下载哪个模型组、占多大、什么许可、哪个平台用哪个文件"的治理层。Alcedo 的 `ai_mask_model_set_v1.json` 提供了成熟 schema：`model_set_version / revision / roles / licenses(sha256 溯源) / 平台文件映射 / NOTICE 自动归档`。

**实现方案**：Rust 侧定义 `ModelSet { id, version, revision, models: Vec<ModelAsset { role, files: 平台映射, sha256, size }>, licenses, notice }`，serde 加载 + 下载器按 role 调度 + 设置页展示"AI 模型管理"（已装/大小/许可/删除）；**许可文本随包分发**写入 `app_data_dir/models/licenses/`；复用 A1 的 residency 注册接口。

**本轮已落地（2026-11-01，第一阶段）**：

- 新模块 [model_registry.rs](file:///workspace/src-tauri/src/model_registry.rs)：`ModelSpec`（role / filename / HTTPS URL / SHA-256 / license / license_url / installed_bytes）+ `build_manifest` 一致性校验（空 role、重复 role、重复文件名、非 64 位小写 hex、非 HTTPS、缺 license 全部转为 issue 而非静默通过）；
- `ai_processing::model_inventory()`（17 个模型条目，与下载常量同源）+ 命令 `get_ai_model_inventory`（`spawn_blocking` 查询磁盘大小）；
- 设置页"数据管理 → AI 模型"显示 `已装/总数`，`data-tooltip` 列出 integrity issues（如 **`clip_tokenizer.json` 上游未提供 pinned SHA-256**——本轮实测该文件确为 `sha256: None`，属上游缺口，已作为可见告警暴露而非掩盖）。

**尚未落地（第二阶段）**：真正的 `model_set` 版本化清单 / 多镜像轮询（现有 `download_and_verify_model` 已内置 HF → hf-mirror 重试）/ 断点续传 / 许可证文本随包分发。本轮已完成"清单 + 校验 + 可视化 + 按角色删除"。

**本轮追加（2026-11-01，第二阶段入口）**：

- 命令 `delete_ai_model(role)`：按角色解析文件名 → 先 `reset_ai_sessions` 释放驻留会话（否则活会话仍映射已删文件）→ 删文件；
- 设置页 AI 模型行展开已装模型列表（显示名 + 大小 + 删除按钮，悬停显示文件名），确认弹窗复用既有 `modelsMessage` 文案，不新增 i18n key。

**验收标准**：设置页可见每个模型组的许可与体积；断网重试、SHA 校验失败自动清理重下；旧扁平清单自动迁移；APK 体积零增长（模型全走下载）。

---

## 5. 分项融合方案（P1）

### B1. ACES 2.0 / OpenDRT 输出变换（WGSL 移植）

- **现状差距（已按实测修正）**：我方已有 **ACES filmic RRT/ODT 近似色调映射**（`tonemapper_mode` 档位 3，[shader.wgsl](file:///workspace/src-tauri/src/shaders/shader.wgsl) L1589-L1600、[image_processing.rs](file:///workspace/src-tauri/src/image_processing.rs) L2169），但**没有 ACES 2.0 官方输出变换（DAV/DAC 曲线 + AP1/AP0 矩阵）与 OpenDRT**。Alcedo 的 DRT 节点 + `cuda_display_to_ap1_pass` / `grade_lut` 提供参考实现。
- **方案**：取官方 ACES 2.0 输出变换数据（输入/输出色域矩阵 + RRT/ODT 曲线参数）与 OpenDRT 公开参数，**自写 WGSL**（数据驱动，非逐行翻译 CUDA）；作为 `tonemapper_mode` 新档位（v2.0 方案 R5-1 已预留扩展位 0/1/2/3，serde 未知值回退机制沿用）；preview 与 export 同源（M0 golden 集覆盖）。
- **依赖**：v2.0-M0 测试基座（24 色卡 ΔE2000 校准）；**前置核验**：OpenDRT 上游许可未明（§3.2），不可确认则仅做 ACES 2.0。
- **验收**：24 色卡 ΔE2000 均值 <1.5、最大 <3（与 v2.0 R5-1 同标）；旧 sidecar 加载不回归。

### B2. 模型驻留管理（residency）—— 已落地

- **来源**：`puerh_mind/src/service/encoder_residency.rs`（5s 巡检 + 空闲卸载）、`lazy_semantic_engine`（首次语义请求才加载）、`UnavailableEmbeddingEngine`（无模型优雅降级）。
- **已落地（2026-11-01）**：
  - 新模块 [model_residency.rs](file:///workspace/src-tauri/src/model_residency.rs)：`ResidencyPolicy`（Android 空闲 60s / 上限 3，桌面 600s / 6；上限取 3 是为了让 EfficientSAM3 的 encoder+decoder+text encoder 整链同时驻留，避免同一次推理内自我驱逐）+ `ResidencyTracker`（touch / pinned / idle 超时 / LRU 预算 / `due_for_eviction_reserving` 预留槽位）；时间注入式设计，驻留模块 9 个 + 清单模块 8 个单元测试（全部零 sleep）。
  - 接线 [ai_processing.rs](file:///workspace/src-tauri/src/ai_processing.rs) L340-L406：`AiModels::session()` 为唯一加载收口，**先驱逐后加锁**避免嵌套锁；BiRefNet fp16/fp32 共用槽位归一到 `birefnet` 单键；提示词嵌入（约 16KB）刻意不计入预算。
  - 触发点：每次取用模型前调用 `enforce_residency(keep)`，超时/超预算的会话槽被 `take()` 置空（持有 `Arc` 的在途推理不受影响，只是不再复用缓存）。`residency_snapshot()` 提供当前驻留集合，供内部诊断使用，本轮未暴露为 IPC 命令（避免新增无消费方的接口）。
- **状态级模型（CLIP / LaMa / Denoise / Normal）**：本轮已补齐——挂在 `AiState` 的四个重磅模型改用 `ResidencyPolicy::idle_only`（只按空闲时间卸载，不占会话预算，避免长批处理驱逐别的功能正在用的模型）；`cached_ai_state` 命中即 touch，加载前 enforce，GPU 失败 `release_sessions` 同时清空 tracker。
- **验收**：Android 端 AI 批处理 50 张后峰值内存回落到基线 +30MB 内；语义搜索首次查询冷启动 <3s、热 <300ms（需真机基准，本轮完成逻辑层验证）。

### B3. 非线性版本历史树（git-like 编辑 DAG）—— v1 已落地

- **来源**：`storage/store/edit_history/commit_graph_store.cpp`（DAG 存储）、`app/pipeline_document_history.cpp` / `pipeline_history_applier.cpp`（提交/应用/分支语义）、`docs/` 中 history 设计文档。
- **v1 方案（已交付）**：Rust 侧 [edit_history.rs](file:///workspace/src-tauri/src/edit_history.rs) 实现纯数据 DAG（`Revision{id,parentId,label,createdAt,adjustments}` + `head`），每张图一个 JSON 存于 `app_data_dir/edit_history/<sha256(路径)>.json`（temp+rename 原子写）；`save_edit_snapshot` 在当前 `head` 上提交、`checkout_edit_history` 整体替换参数并移动 head、`delete_edit_revision` 删除子树（根与含 head 的子树受保护）、`get_edit_history` 返回轻量摘要；`prune(30)` 淘汰最老非 head 修订并重挂子节点，保证线性快照链也能收敛。前端 [EditHistoryButton.tsx](file:///workspace/src/components/panel/editor/EditHistoryButton.tsx) 挂在顶栏 undo/redo 组：单击打开快照菜单、Snapshot 项保存当前参数、点击修订 checkout 后经 `applyRevision` 整体替换（保留线性 undo/redo）并走既有 `debouncedSave` 持久化 sidecar/缩略图；删除为两步内联确认（右键武装、再次点击执行，规避 WebView 原生 confirm 不可用），根与含 head 的子树不显示删除入口。
- **与最初设想的差异**：存储由“SQLite / 按 image_id 分目录”改为“每图单 JSON 文件”（避免迁移与额外依赖，写入原子、单测可注入时间）；虚拟副本升级为分支变体、跨图复制部分 Look 未纳入 v1。
- **边界**：不做跨图 DAG 合并、不做远端同步（Alcedo 也未做）。
- **验收（v1）**：任意修订可创建子分支并独立演化；分支切换走整对象替换（同图不走 diff，45MP 目标 <500ms 依赖现有渲染链路）；`edit_history` 11 项单测通过（提交/分支/检出/删除保护/prune/摘要/持久化/损坏文件）。
- **v2 待做**：虚拟副本 ↔ 分支变体打通、跨图复制部分 Look、参数 diff 存储与增量体积门禁。

### B4. Lensfun 镜头数据库接入 —— 已落地（无需再排期）

- **实测修正**：我方**已内嵌完整 Lensfun 数据库**（`include_dir!("$CARGO_MANIFEST_DIR/lensfun_db")`，[lens_correction.rs](file:///workspace/src-tauri/src/lens_correction.rs) L11，桌面走资源目录、Android 走内嵌路径），并已实现厂商/镜头枚举、`autodetect_lens`、`find_best_lens_match`、`resolve_lens_params`（L629-L878）。原计划"The gap = 未接入"的前提不成立。
- **剩余可选增量**：EXIF 镜头型号模糊匹配命中率调优、无机身/镜头信息时的手动兜底提示。

### B5. 远程 AI 提供商抽象 + 凭据保险库

- **来源**：`puerh_mind/src/service/providers/*`（openai_chat_compatible / volcengine_ark / anthropic_messages / openrouter / mock）、`credential_vault.rs`（TTL 凭据缓存 + zeroize）、`cancellation_registry`、`provider_config`（内置+用户自定义校验，强制 HTTPS、仅 localhost 例外——Cargo.toml 注释 L37-L41 明示安全基线）。
- **方案**：把我方 [ai_connector.rs](file:///workspace/src-tauri/src/ai_connector.rs) 的云端 inpaint 硬编码升级为 provider registry（trait `ImageAnalysisProvider` + 能力声明 + 取消/超时/重试），凭据存系统 keystore（Android Keystore 经 tauri 插件）+ 内存 zeroize；默认无凭据、显式开启并**明示数据出域**（移动端合规要点）。
- **验收**：断网/超时/取消路径有 UI 反馈；凭据不落明文盘；mock provider 覆盖单测。

---

## 6. P2 与明确不建议项

### 6.1 P2-C1：DAG 执行计划蓝图（依赖 wgpu 直通）

Alcedo 的 graph_compiler / execution_plan / result_content_key / static_execution_plan_cache 四件套，映射到 wgpu 的价值在 **Android GPU 预览接通之后**（v2.0 R1-3/R1-4）：节点化执行计划 + 内容寻址键能把我方"单 pass 全量重算"演进为"滑杆只重算后继节点 + ROI 局部求值"。现在只做**设计预研产出**（一次架构评审文档），不动代码。

### 6.2 P2-C2：Agent 协作闭环（alcedo-cli 模式）

"每条 UI 动作 1:1 命令 + preview→evaluate→adjust 循环"——我方 Tauri command 层天然接近该形态。依赖 B5 与任务中心改造（v2.0 E7），列为远期方向，不在本计划排期。

### 6.3 P2-C3：Nikon HEF 解码（LibRaw fork）

LGPL-2.1/CDDL 合规可行，但需 NDK 交叉编译 LibRaw fork 并与我方 Rawler 双解码器并存（格式路由、测试双份）；移动端 NEF-H 采集场景占比低。挂起，待用户需求信号（图库 NEF-H 导入失败率统计）再启动。

### 6.4 P2-C4：神经 demosaic（DemosaicNet）

Alcedo 的 X-Trans 神经 demosaic 是 CUDA 自研算子库（`cuda/nn/`：conv2d/conv_transpose2d/cutlass_conv2d），模型权重未随库分发（经 `scripts/ai_models` 管线发布）；WGSL 重写整组算子 + 权重再获取，工程量大且 X-Trans 在移动端占比极小。挂起；我方 demosaic 改进按 v2.0 R1-1（预览质量分档）推进即可。

### 6.5 明确不建议（含理由）

| 项                                             | 理由                                                                                                                       |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| DuckDB 图库目录                                | Android 上徒增 APK 体积与依赖；我方文件系统 + 内存索引 + justified 虚拟滚动已覆盖移动端量级（单库数千张）                  |
| gRPC sidecar 进程分离                          | Android 进程/内存模型不适合双进程常驻；其价值（隔离、跨语言）在我方单 Rust 后端下为零——**吸收其内部工程模式（B2/B5）即可** |
| CUDA/OpenCL/Metal kernel 直接移植              | 无对应后端；等价物是我方 WGSL 重写，已并入各算法项                                                                         |
| OpenCV / CUTLASS / protobuf / QuickQanava 依赖 | 体积/复杂度/许可负担不成比例                                                                                               |
| 抓取 113 胶片 LUT 包再分发                     | 许可归属不明 + 非开源分发渠道；改为 `.cube` 导入兼容（§3.2）                                                               |
| S3OD / DINOv3 权重                             | DINOv3 自定义许可未核验 + Alcedo 训练权重 GPL 传递（§3.2 默认绕开）                                                        |

---

## 7. Android 端适配专项策略（贯穿所有融合项）

1. **内存纪律**：所有新增模型走 A3 model_set + B2 residency；`image_cache_size=2` 的现状不因融合恶化；新增缓存全部带内容键 + 预算上限。
2. **算力分层**：AI 推理 EP 优先级 `NNAPI > XNNPACK CPU`；提供"标准/高质量"两档（高质量档 fp32，标准档 fp16/量化）；设置页显示设备实测推理耗时作为档位建议。
3. **存储路径**：模型 `app_data_dir/models`（已有）；LUT 沿用 `ExternalMediaDirs/.lut_cache`（[android_integration.rs](file:///workspace/src-tauri/src/android_integration.rs) L113-L161）；历史树 `app_data_dir/history`；导出仍写 `Downloads/RapidRaw`（[file_management.rs](file:///workspace/src-tauri/src/file_management.rs) L3600-L3604）。
4. **返回键与生命周期**：A1 点选蒙版、B3 分支视图等新交互全部登记进 [useAndroidBackHandler.ts](file:///workspace/src/hooks/useAndroidBackHandler.ts) 层栈（v2.0 E18 的注册式改造一并落地，避免新弹窗重蹈硬编码清单覆辙）。
5. **显示路径解耦**：本计划所有 P0/P1 项**不依赖** wgpu Android 直通；该断点由 v2.0 R1-3/R1-4 独立攻坚，C1（DAG 蓝图）在其后衔接。

---

## 8. 实施路线图

| 阶段                    | 内容                                                                                                       | 前置              | 交付物与验收门                                        |
| ----------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------- | ----------------------------------------------------- |
| **F0 合规底账**（先行） | 建立 `NOTICE`/`THIRD_PARTY_NOTICE.txt` 维护流程；核验 OpenDRT 与 DINOv3 条款；A3 model_set schema 设计定稿 | 无                | 合规清单入库；两项核验结论书面化（阻塞 B1/S3OD 决策） |
| **F1 净新增能力**       | A3 模型包体系 → A1 SAM 2.1 点选蒙版（桌面先行、Android 同版交付）→ A2 UltraHDR 导出                        | F0（A3 先行）     | 各项按 §4 验收标准；性能基准进 M0 bench 回放脚本      |
| **F2 画质与资源底座**   | B2 模型驻留管理 → B1 DRT 输出变换（ACES 2.0 为主）                                                         | F1（A3）、v2.0-M0 | 驻留内存验收 + 色卡 ΔE golden 入 CI                   |
| **F3 工作流深化**       | B3 版本历史树 → B4 Lensfun 接入 → B5 provider 抽象                                                         | F1                | §5 各项验收；迁移/回滚演练（旧 sidecar 兼容矩阵）     |
| **F4 架构演进衔接**     | C1 DAG 执行计划落地（与 v2.0 R1-3/R1-4 wgpu Android 直通合并立项）                                         | v2.0-M1           | 架构评审通过 + ROI 求值性能门禁                       |
| **持续**                | C2 Agent 闭环、C3 HEF、C4 神经 demosaic                                                                    | 信号触发          | 按触发条件重新评估                                    |

**阶段原则**（继承 v2.0 方案）：每项独立 PR、独立回滚；新增能力默认开关可控；观感变化项（B1）附 golden 前后对比；所有融合项在 Release 说明标注来源仓库与许可。

**本轮（2026-11-01）状态**：A3 第一阶段（清单+校验+UI）与 B2（驻留引擎+接线）已交付并通过编译/单测/链路验收；B4 经实测确认早已落地，无需排期；其余项见 §11.4。

---

## 9. 风险与缓解

| 风险                       | 影响                          | 缓解                                                                                                                |
| -------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| GPL 污染焦虑               | 团队对 GPL 代码引入有顾虑     | 以"思想借鉴 + 自研重写 + 资产许可核验"为默认路径；逐字复制仅限 Apache-2.0/LGPL 资产；§3 红线进 PR 检查单            |
| SAM 2.1 在低端机的推理耗时 | 蒙版体验劣化                  | tiny 模型 + fp16 + encoder 缓存；性能不达线的设备在设置页明示并降级为既有语义蒙版                                   |
| ort NNAPI EP 的设备碎片化  | 部分 EP 回退/崩溃             | EP 探测 + 白名单启用 NNAPI，异常自动回退 CPU（沿用 `probe_gpu_adapter` 模式）                                       |
| UltraHDR 兼容性            | 非 14 设备/第三方相册显示异常 | 标准化 ISO 21496-1 输出 + SDR 基底兜底；默认关闭、显式开启                                                          |
| DRT 改变出图观感           | 用户对照旧版差异              | 沿用 v2.0 R5-1 的 golden 校准 + 新旧对照 Release 说明，不做隐式切换                                                 |
| 模型下载体验（国内网络）   | HF 拉取慢/失败                | model_set 支持多镜像 URL 轮询 + 断点续传 + SHA 校验重下（A3 内置）                                                  |
| 与 v2.0 管线重构撞车       | 同文件冲突                    | 融合项落点集中在 ai_processing/export_processing/lut_processing/history 新文件；WGSL 改动仅 B1 一项且排期在 M0 之后 |

---

## 10. 交付标准定义（本方案自身的验收口径）

1. **可追溯**：每项融合有来源（仓库+路径）、落点（本仓库文件+行号级锚点）、许可（文本级）、验收（可执行标准）四要素；
2. **可执行**：P0/P1 各项拆到文件级落点，可直接转化为 PR 任务；每阶段有独立回滚路径；
3. **合规可审计**：`NOTICE` 与 `model_set.json` 双向追溯链（来源 URL + SHA-256 + 许可文本随包）；
4. **性能可度量**：全部验收线接入 M0 bench（帧时间 P95、内存峰值、导出耗时、ΔE golden），不允许"感觉变好"式结论；
5. **移动端完整性**：每项明确 Android 差异行为（内存/算力/存储/返回键/网络），禁止"桌面可用、移动端未验证"的合并。

---

## 11. 本轮实施与验收记录（2026-11-01）

### 11.1 变更清单（已落地）

| 文件                                                                                                     | 变更                                                                                                                                                                                                                                                                                                                       | 目的                                  |
| -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| [model_residency.rs](file:///workspace/src-tauri/src/model_residency.rs)                                 | 新增：`ResidencyPolicy`（含 `idle_only`）+ `ResidencyTracker` + 9 个单元测试                                                                                                                                                                                                                                               | B2 驻留策略引擎（时间注入、零 sleep） |
| [model_registry.rs](file:///workspace/src-tauri/src/model_registry.rs)                                   | 新增：`ModelSpec` / `ModelManifest` / `build_manifest` 校验 / `with_installed_sizes` / `verify_file` + 8 个单元测试                                                                                                                                                                                                        | A3 第一阶段：模型清单治理与完整性校验 |
| [ai_processing.rs](file:///workspace/src-tauri/src/ai_processing.rs)                                     | `AiModels` 增 `residency` / `residency_epoch`；`session()` 收口驱逐；`evict_slot` / `enforce_residency` / `residency_snapshot`；`model_inventory()`（17 条）+ 命令 `get_ai_model_inventory`；**`AiState` 增 `residency`（idle-only）并把 CLIP/LaMa/Denoise/Normal 四个 getter 接入 touch/enforce**；命令 `delete_ai_model` | B2 接线 + A3 数据源与按角色删除       |
| [lib.rs](file:///workspace/src-tauri/src/lib.rs)                                                         | 注册 `mod model_registry` / `mod model_residency`；handler 增 `get_ai_model_inventory`、`delete_ai_model`                                                                                                                                                                                                                  | 命令链路                              |
| [AppProperties.tsx](file:///workspace/src/components/ui/AppProperties.tsx)                               | `Invokes` 增 `GetAiModelInventory`、`DeleteAiModel`                                                                                                                                                                                                                                                                        | 前端调用契约                          |
| [DataManagementSettings.tsx](file:///workspace/src/components/panel/settings/DataManagementSettings.tsx) | 刷新时拉取清单，AI 模型行显示 `已装/总数`，`data-tooltip` 列 integrity issues；展开已装模型（名称/大小/删除），删除走既有确认弹窗                                                                                                                                                                                          | 可见治理 + 按角色删除                 |

### 11.2 验收结果（可复现）

| 验收项                 | 命令 / 方法                                                                                                                                               | 结果                                                                                                                                                |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| 后端编译               | `cargo +nightly check --lib --ignore-rust-version`（rustc 1.98.0-nightly；**沙箱 1.94.1 无法编译 `sysinfo 0.39.6`（需 `cfg_select`）**，项目本固定 1.98） | **Finished，0 error / 0 warning**                                                                                                                   |
| 新模块单元测试         | 独立 harness crate（`#[path]` 引入两个模块）`cargo test`                                                                                                  | **17 passed / 0 failed**                                                                                                                            |
| 前端类型               | `npm run typecheck`（`tsc --noEmit`）                                                                                                                     | 通过，无输出                                                                                                                                        |
| 前端静态检查           | `npx eslint` 改动文件                                                                                                                                     | **0 error**（10 条既有 `no-explicit-any`/未用变量 warning，非本轮引入）                                                                             |
| i18n 一致性            | `node src/i18n/check-runtime.mjs`                                                                                                                         | 15 locales / 1998 复数 / 29555 占位符全部通过（本轮未新增 key，复用既有文案）                                                                       |
| 操作链路（命令注册表） | 脚本解析 `Invokes` 枚举（124）+ 字面量 `invoke()`（22）= 前端 145 调用；后端 `generate_handler!` 162 命令                                                 | **前端→后端缺失 0**                                                                                                                                 |
| 后端命令无消费方       | 同上（17 条）                                                                                                                                             | 全部可解释：`immich_*` 经 `ImmichInvokes` 枚举、`delete_files_*` / `generate_*_patch` / `list_master_luts` 由三元表达式或动态拼接派发；**无死代码** |
| 模型清单一致性         | `build_manifest` 自检                                                                                                                                     | 17 条中仅 `clip_tokenizer.json` 报 issue（上游 `sha256: None`，非我方遗漏）                                                                         |

### 11.3 原方案前提修正（实测推翻）

| 原断言（§2.2 / §5）             | 实测结论                                                                                    | 证据                                                                                                                                                             | 处理                                                        |
| ------------------------------- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| "无点提示交互蒙版，A1 为净新增" | 后端 **SAM ViT-B 已支持框提示主体分割**；`run_sam_decoder` 已含 point/box 标签              | [ai_commands.rs](file:///workspace/src-tauri/src/ai_commands.rs) L509-L545、[ai_processing.rs](file:///workspace/src-tauri/src/ai_processing.rs) L2203-L2260     | A1 收敛为**前端交互层**（负点/多轮/触屏），不再新建模型链路 |
| "无 ACES"                       | 已有 **ACES filmic RRT/ODT 近似**（tonemapper 档位 3）；缺的是 ACES 2.0 官方 DRT 与 OpenDRT | [shader.wgsl](file:///workspace/src-tauri/src/shaders/shader.wgsl) L1589-L1600、[image_processing.rs](file:///workspace/src-tauri/src/image_processing.rs) L2169 | B1 改为"ACES 2.0 官方变换增量"，保留                        |
| "B4 Lensfun 未接入"             | **已内嵌完整 lensfun_db + autodetect_lens/find_best_lens_match**                            | [lens_correction.rs](file:///workspace/src-tauri/src/lens_correction.rs) L11、L830-L878                                                                          | B4 关闭，仅留匹配率调优                                     |
| "A3 需从零建体系"               | 单文件 `ModelAsset` 下载+校验已完备，缺的是**清单/许可/可视化**治理层                       | [ai_processing.rs](file:///workspace/src-tauri/src/ai_processing.rs) L1336-L1396                                                                                 | A3 拆为两阶段：本轮完成清单+校验+UI，下载器升级留二期       |

### 11.4 未落地项与真实原因

| 项                                                            | 状态      | 原因（可执行层面）                                                                                                                                                                                        |
| ------------------------------------------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A2 UltraHDR 导出                                              | 未开始    | 需 NDK 交叉编译 libultrahdr（Apache-2.0）+ gain map 生成步骤 + 导出 UI；本沙箱无 Android NDK 与外部模型/库网络（HF 直连被拒），无法完成端到端验证                                                         |
| A1 点选交互（多轮/负点）                                      | 部分完成  | 单点点选已具备（拖拽 <5px → `start==end` → SAM 单正点）；多轮正点累加、负点减选、独立"点选蒙版"类型尚未做，需前端手势状态机与后端多点 prompt 数组接口                                                     |
| B1 ACES 2.0 / OpenDRT                                         | 未开始    | 依赖 v2.0-M0 golden 基座与 OpenDRT 许可核验；且需 GPU/CPU 双路径同源验证                                                                                                                                  |
| B3 版本历史 DAG                                               | v1 已落地 | v1 为每图单 JSON + 4 个 IPC + 顶栏快照菜单（提交/检出/删除/prune）；剩余为虚拟副本升级分支变体、跨图复制 Look、diff 存储                                                                                  |
| B5 provider 抽象 + 凭据保险库                                 | 未开始    | 密钥库依赖**已在** [Cargo.toml](file:///workspace/src-tauri/Cargo.toml) L86-L142（android/apple/windows/zbus 四种 store），但无任何 Rust 代码接线；Android 侧需启动时注入 `ndk_context`，且只能在真机验证 |
| A3 第二阶段剩余（model_set 版本化 / 断点续传 / 许可文本随包） | 部分完成  | 清单+校验+UI+按角色删除已交付；版本化清单与断点续传会改变现有下载行为与目录结构，需要迁移与断网回归，留作独立 PR                                                                                          |

### 11.6 本轮（第二轮）追加交付

| 项                 | 内容                                                                                                                                                              | 验收                                                                                                                     |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| B2 状态模型驻留    | `ResidencyPolicy::idle_only` + `AiState.residency`；CLIP/LaMa/Denoise/Normal 四个 getter 命中即 touch、加载前 enforce、`release_sessions` 清空 tracker            | `idle_only_policy_never_evicts_for_budget` 单测通过；`cargo check` 0 warning                                             |
| A3 按角色删除      | `delete_ai_model(role)`（先释放会话再删文件）+ 设置页已装模型列表与删除按钮                                                                                       | 命令链路 0 缺失；i18n 校验通过；typecheck/lint 通过                                                                      |
| B3 版本历史 DAG v1 | `edit_history.rs`（DAG + 每图 JSON 原子持久化 + prune）+ 4 个 IPC（get/save/checkout/delete）+ `useEditorStore.applyRevision` + 顶栏 `EditHistoryButton` 快照菜单 | 11 项单测（提交/分支/检出/删除保护/prune/摘要/持久化/损坏）；前端→后端缺失 0；typecheck/lint 0 error；15 locale 校验通过 |

### 11.7 回滚方式

本轮为**净新增 + 内部收口**：删除 `model_residency.rs` / `model_registry.rs`、撤销 `lib.rs` 的 `mod` 与两行 handler、撤销前端两个 `Invokes` 枚举项与 `DataManagementSettings` 的清单/列表逻辑，即回到 v2.0.2 行为；B3 额外删除 `edit_history.rs`、撤销 `mod edit_history` 与 4 行 handler、4 个 `Invokes`、`applyRevision`、`EditHistoryButton` 及其在 `EditorToolbar` 的挂载（磁盘 `app_data_dir/edit_history` 可整目录删除）；无数据库/设置迁移，无 sidecar 字段变化。

---

## 附录 A：AlcedoStudio 证据索引（相对其仓库根，v0.3.3）

| 主题               | 位置                                                                                                                                                                       |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 节点图模型         | `alcedo_studio/src/edit/graph/{develop_node_model,color_grade_node_model,drt_node_model,pipeline_graph*}.cpp`                                                              |
| 后端无关执行层     | `alcedo_studio/src/edit/runtime/{graph_compiler,execution_plan,static_execution_plan_cache,result_content_key,grade_lut,grade_schedule,lut_bake,runtime_invalidation}.cpp` |
| 三后端 pass        | `alcedo_studio/src/edit/runtime/{cuda,opencl,metal}/`（83 个 kernel 文件，含 `cuda_display_to_ap1_pass.cu` 等）                                                            |
| 神经 demosaic 算子 | `alcedo_studio/src/cuda/nn/*.cu`                                                                                                                                           |
| 版本历史 DAG       | `alcedo_studio/src/storage/store/edit_history/commit_graph_store.cpp`、`alcedo_studio/src/app/pipeline_document_history.cpp`                                               |
| Rust AI sidecar    | `rust/puerh_mind/src/{server,service}/`（segmentation/semantic/encoder_residency/credential_vault/providers）                                                              |
| 模型包 schema      | `scripts/ai_models/ai_mask_model_set_v1.json` + `ai_mask_model_set_v1_NOTICE.txt`                                                                                          |
| LUT 元数据规范     | `scripts/luts/alcedo_lut_metadata.py`（ALCEDO_LUT schema-1）                                                                                                               |
| 第三方许可底账     | `third_party_licenses/`（38 项）、`NOTICE`、`THIRD_PARTY_NOTICE.txt`                                                                                                       |
| 子模块清单         | `.gitmodules`（libraw fork `main_alcedo` 分支、libultrahdr fork `alcedo-v1.4.0-dither` 分支、lensfun 等）                                                                  |

## 附录 B：我方仓库锚点索引

| 主题                     | 位置                                                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Android wgpu 决策        | [platform_features.rs](file:///workspace/src-tauri/src/platform_features.rs#L171-L258)、[lib.rs](file:///workspace/src-tauri/src/lib.rs#L677-L681)                       |
| Android 初始化与缓存路径 | [android_integration.rs](file:///workspace/src-tauri/src/android_integration.rs#L33-L81)、[#L113-L161](file:///workspace/src-tauri/src/android_integration.rs#L113-L161) |
| 移动端资源默认值         | [app_settings.rs](file:///workspace/src-tauri/src/app_settings.rs#L766-L784)                                                                                             |
| 模型下载与目录           | [ai_processing.rs](file:///workspace/src-tauri/src/ai_processing.rs#L100-L105)、[#L1048-L1051](file:///workspace/src-tauri/src/ai_processing.rs#L1048-L1051)             |
| 既有 AI 蒙版类型         | [mask_generation.rs](file:///workspace/src-tauri/src/mask_generation.rs#L876-L1015)                                                                                      |
| 云端 AI 现状             | [ai_connector.rs](file:///workspace/src-tauri/src/ai_connector.rs#L1-L30)                                                                                                |
| Android 导出落点         | [file_management.rs](file:///workspace/src-tauri/src/file_management.rs#L3600-L3604)                                                                                     |
| 返回键层栈               | [useAndroidBackHandler.ts](file:///workspace/src/hooks/useAndroidBackHandler.ts#L6-L113)                                                                                 |
