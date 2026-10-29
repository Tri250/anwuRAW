# RawLab v0.9.0 对标调研与改善技术方案

> 调研对象：https://github.com/dancancer/RawLab/releases/tag/v0.9.0 （commit b118e21 / build 15，GPL-3.0-only）
> 调研日期：2026-10-29
> 对标项目：anwuRAW（Tri250/anwuRAW，Tauri v2 + React 19 + Rust，基于 RapidRAW 增强分叉，当前 v1.6.10）

---

## 1. 调研摘要

### 1.1 RawLab 是什么

RawLab 是一个跨品牌 RAW 显影 + 胶片质感编辑器，核心特征：

- **共享 C++17 处理核心**（`lutools/`），四端原生客户端：macOS（Swift/Metal）、Windows（.NET 8/D3D11）、Android（GLES 3.1）、iOS 18+；
- RAW 解码基于 **LibRaw（打补丁）**，GPU 负责降噪/效果/HSL，RAW 解码与编码保持 CPU；
- v0.9.0 主打：编辑器重组（6 调整组 + 组级修改标记/重置）、Lightroom 式复制粘贴 + 会话 undo/redo、用户预设、黑点/白点/vibrance、三分区分离调色、多点曲线、clarity/dehaze 双向、HSL 目标调整（取色拖动）、照片集合同步、处理版本 2（VNG demosaic）、桌面 AI 降噪（DualDn + Restormer）、桌面自动更新（Sparkle/Velopack）、MCP server。

### 1.2 与我方技术栈差异（决定借鉴方式）

| 维度     | RawLab                                    | anwuRAW                                                                           |
| -------- | ----------------------------------------- | --------------------------------------------------------------------------------- |
| 架构     | C++17 核心 + 4 原生客户端                 | Tauri v2：Rust 后端 + Web 前端                                                    |
| RAW 解码 | LibRaw（打补丁）                          | rawler（RapidRAW-DngLab fork，[Cargo.toml](/workspace/src-tauri/Cargo.toml#L32)） |
| GPU      | Metal/D3D11/GLES 手写 kernel              | wgpu 29 调整管线                                                                  |
| 更新     | Sparkle 2.10 / Velopack 自研集成          | **无（tauri.conf.json plugins 为空）**                                            |
| 自动化   | Agent CLI + JSON 能力发现 + MCP（5 工具） | headless 导出 CLI                                                                 |
| i18n     | 6 语言                                    | **15 语言 + i18n:check（领先）**                                                  |

结论：RawLab 的底层算法我方大多已具备或等价（见 §2 对比矩阵），**真正值得引入的是 6 个功能/工程差距点 + 1 套工程纪律**，均可在我方架构内低成本落地，无需照搬其 C++/原生实现。

---

## 2. 功能对比矩阵

### 2.1 已覆盖（无需建设）

| RawLab v0.9.0 特性                       | anwuRAW 现状                                                                                                                                 |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 黑点/白点、vibrance、clarity/dehaze 双向 | [adjustments.ts](/workspace/src/utils/adjustments.ts#L991-L1084) basic/color/details 组已含全部参数                                          |
| 多点 tone curve                          | `curves/pointCurves` + 参数化曲线（[adjustments.ts](/workspace/src/utils/adjustments.ts#L253-L298)），支持 luma/RGB 四通道                   |
| 阴影/中间调/高光分离调色                 | color 组 color grading 已有                                                                                                                  |
| 8 通道 HSL                               | HSL mixer 已有                                                                                                                               |
| 会话内 undo/redo                         | [useEditorStore.ts](/workspace/src/store/useEditorStore.ts#L160-L199)，50 步历史栈                                                           |
| 选择性复制粘贴 + 跨照片同步              | [CopyPasteSettingsModal.tsx](/workspace/src/components/modals/CopyPasteSettingsModal.tsx#L162-L179) 按 `ADJUSTMENT_GROUPS` 勾选 + `autoSync` |
| 并排/分割对比                            | `CompareView = 'off'                                                                                                                         | 'vertical' | 'horizontal' | 'sideBySide'` |
| 按住查看原图                             | `showOriginal`（[ImageCanvas.tsx](/workspace/src/components/panel/editor/ImageCanvas.tsx#L87)）                                              |
| 镜头校正（Lensfun 畸变/TCA/暗角）        | [lens_correction.rs](/workspace/src-tauri/src/lens_correction.rs#L288-L513) 同为 Lensfun 数据库插值                                          |
| 非 AI 快速降噪                           | [bm3d.rs](/workspace/src-tauri/src/bm3d.rs#L40-L84)（YCbCr 联合 BM3D）                                                                       |
| AI 降噪 + 结果缓存                       | [ai_denoise.rs](/workspace/src-tauri/src/ai_denoise.rs#L297-L362)（NIND via ort + 缓存）                                                     |
| grain / vignette / LUT 导入              | effects 组已有                                                                                                                               |
| 用户预设                                 | [usePresets.ts](/workspace/src/hooks/usePresets.ts#L66-L124) tool/style 两类 + 社区预设                                                      |
| 导出取消                                 | export_processing.rs 有 checkpoint 取消语义                                                                                                  |
| 多语言 + 翻译一致性                      | 15 语言 + `npm run i18n:check`                                                                                                               |
| 视口尺寸交互预览                         | preview_dim 缩放 + fast demosaic（`DemosaicAlgorithm::Speed`）+ 几何超采样                                                                   |

### 2.2 差距点（本方案范围）

| #   | 差距                                                        | 优先级             |
| --- | ----------------------------------------------------------- | ------------------ |
| G1  | 桌面自动更新完全缺失                                        | P0                 |
| G2  | HSL 目标调整（照片上取色拖动）                              | P0                 |
| G3  | 处理版本机制（管线升级静默改变历史编辑结果 + 缓存失效缺口） | P1                 |
| G4  | 预设/配方 0–200% 强度应用                                   | P1                 |
| G5  | 批量导出断点续传与失败重试                                  | P1                 |
| G6  | Agent/CLI 能力发现 + JSON 全参数编辑 + MCP server           | P2                 |
| G7  | RAW 兼容性跟进（Nikon HE/HE*、Sony ARW6、X3F、JPEG-XL DNG） | P1（低成本审计）   |
| G8  | DCP 相机色彩档案导入                                        | P2（高成本）       |
| G9  | 渲染型 DNG 导出                                             | P3（高成本，暂缓） |
| E1  | 工程纪律：契约文档 / 发布验收 / 评审留痕                    | P1（组织性）       |

---

## 3. 技术方案

### G1. 桌面自动更新（P0，低成本低风险）

**差距**：[tauri.conf.json](/workspace/src-tauri/tauri.conf.json) `plugins: []`，用户只能手动去 Releases 下载。RawLab 为此做了 Sparkle/Velopack + EdDSA 签名 + 备份恢复 + 161 条更新断言的重量级方案，暴露了"不做自动更新的维护成本"。

**方案**：直接采用 Tauri 官方更新栈，不重造 RawLab 的轮子：

1. 集成 `tauri-plugin-updater` + `tauri-plugin-process`：
   - 生成 EdDSA 密钥对（`tauri signer generate`），私钥入 GitHub Secrets（`TAURI_SIGNING_PRIVATE_KEY`），公钥写入 conf；
   - `tauri.conf.json` 开启 `plugins.updater`，endpoints 指向 `https://github.com/Tri250/anwuRAW/releases/latest/download/latest.json`；
   - release.yml 增加 `latest.json`（含各平台签名）上传——tauri-action 已生成，只需确认 `includeUpdaterJson: true` 与签名环境变量注入；
   - 前端设置页新增「检查更新」入口：`check()` → `downloadAndInstall()` → `relaunch()`；自动检查设为默认关闭（对齐 RawLab "默认关闭" 的保守策略）。
2. Windows 注意：updater 走 NSIS/MSI 安装器，与现有 13 平台构建矩阵兼容；Android 不适用（保持 Play/GitHub APK 手动升级）。

**改动范围**：`src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`、`src-tauri/capabilities/*.json`（updater 权限）、`src/components/modals/SettingsModal.tsx`（新设置项）、`.github/workflows/release.yml`（签名环境变量 + latest.json）、i18n 15 语言词条。

**风险**：签名私钥丢失将锁死更新链（需在仓库文档记录恢复流程）；Windows 未签名安装器可能触发 SmartScreen 提示（现状亦如此，不恶化）。

**验收**：本地 dry-run 签名通过；发布 v1.6.11 后从 v1.6.10 实测"检查→下载→校验→重启"全链路。

### G2. HSL 目标调整（取色拖动，P0，价值最高的 UX 补齐）

**差距**：RawLab 设计文档（`docs/design/editing-iteration/requirements.md:L117-L123`）定义了完整交互：取色器在照片上取样 → 按住拖动直接增减匹配 HSL 通道 → 显示受影响色域 → 从冻结起始值计算增量 → 松开生成一条历史项；面板折叠时目标模式保持激活，画布上有指示器与退出控件。我方 src 内无任何 eyedropper/targeted 实现（已 grep 确认）。

**方案**：

1. **色相匹配**：取样点 RGB → HSV 取 hue（复用 `wgpu` 侧或前端 canvas `getImageData`，取 5×5 均值抗噪），映射到 8 个 HSL 通道区间（红 0±15°、橙 15–45、黄 45–70、绿 70–150、青 150–200、蓝 200–260、紫 260–300、品红 300–345，边界按亮度/饱和度就近归属）。
2. **交互流**：进入目标模式后指针按下冻结 8 通道起始值 → 拖动 X/Y 分别驱动 hue 差与 saturation 差（或提供单轴模式）→ 松开写入 `adjustments.hsl` 并 `pushHistory`，Esc 取消恢复冻结值。模式激活期间面板折叠不退出，画布左下显示指示 chip（通道名 + 当前增量）。
3. **落点**：新增 `src/hooks/useTargetedAdjustment.ts`；[ImageCanvas.tsx](/workspace/src/components/panel/editor/ImageCanvas.tsx) 增加取样光标与指示 chip；[HslPanel（adjustments 组件）](/workspace/src/components/adjustments) 增加目标调整入口按钮；光标状态走 `useUIStore`。
4. i18n 15 语言 + 快捷键（如 `Ctrl+Alt+H`）入 `Invokes`/快捷键帮助。

**风险**：低。纯前端交互层，不触碰 Rust 渲染管线；拖动节流复用现有 Slider onDragStateChange 语义。

**验收**：取样红色区域拖动能同时驱动红通道 hue/sat；折叠面板后仍生效；undo 一步还原。

### G3. 处理版本机制（P1，稳定性收益最大）

**差距**：RawLab 用 `lutools/docs/processing-version.md` 的契约固化了"每条编辑记录绑定 processing version（v1=AHD 默认 demosaic，v2=VNG/C5），旧记录不隐式升级，版本切换缓存全部失效，移动端不静默替换算法"。我方现状：

- rawler 是 git fork 依赖，上游升级会**静默改变所有历史编辑的渲染结果**；
- [cache_utils.rs](/workspace/src-tauri/src/cache_utils.rs) 的缓存 key 只含 adjustments/path/尺寸，**不含管线版本号**——rawler 或 wgpu 管线升级后旧缓存与新代码语义不一致；
- demosaic 仅内部 fast 预览切换（[raw_processing.rs](/workspace/src-tauri/src/raw_processing.rs#L312-L314)），无用户可选质量档。

**方案**：

1. 定义 `PROCESSING_VERSION: u32`（当前 =1，随 breaking 管线变更递增）常量于 `raw_processing.rs`；
2. 缓存 key 混入：`calculate_full_job_hash` / `calculate_geometry_hash` / `calculate_transform_hash` 全部 `version.hash(hasher)`；持久化缓存目录名带 `v{N}`（如 `full_jobs/v1/`），升级后旧目录惰性清理；
3. 编辑记录（storage 的 adjustments JSON）可选写入 `processingVersion` 字段，缺省按 1 读取——为未来 v2（如换 demosaic 或色彩管线）留兼容位，**旧记录永不隐式升级**；
4. 设置页暴露 demosaic 质量选项（预览固定 Speed，导出可选 默认/高质量）——rawler `DemosaicAlgorithm` 枚举已含多档，改动集中在 `raw_processing.rs` 与导出参数透传。

**改动范围**：`src-tauri/src/raw_processing.rs`、`src-tauri/src/cache_utils.rs`、`src-tauri/src/export_processing.rs`（导出 hash）、设置 UI + i18n。

**风险**：低；主要是缓存 key 变更导致一次性全量重算（可接受）。

**验收**：升级前后同一 .sidecar 渲染逐字节一致；缓存目录带版本号；改版本号后缓存全 miss。

### G4. 预设/配方强度 0–200%（P1，低成本高感知）

**差距**：RawLab 的 recipe/LUT 支持 0–200% 强度（线性缩放控件值 + HSL + LUT 混合比例）；我方 [usePresets.ts](/workspace/src/hooks/usePresets.ts) 应用预设为全有/全无。

**方案**：

1. 应用预设时传入 `strength: number`（默认 100）；
2. 纯数值参数按 `value * strength/100` 缩放（曝光等乘法参数用原值 × 系数，白平衡温度等偏移量按差值缩放：`default + (value - default) * k`，k = strength/100）；
3. 含 LUT 的预设：k>1 时叠加 LUT 二次应用或提高 LUT 强度参数（effects.lut 已有强度位则直接复用）；
4. 含蒙版的预设：蒙版内 adjustments 同规则递归缩放；几何（裁剪/变换）不缩放；
5. UI：预设卡片 hover 显示强度 Slider（0–200），双向绑定。

**改动范围**：`src/utils/adjustments.ts`（新增 `applyStrength(adjustments, k)` 纯函数）、[usePresets.ts](/workspace/src/hooks/usePresets.ts)、[PresetsPanel.tsx](/workspace/src/components/panel/right/PresetsPanel.tsx)、i18n。

**风险**：低；缩放规则需覆盖枚举/布尔参数跳过策略（布尔不缩放）。

**验收**：同一预设 50%/100%/200% 三档结果单调递进；100% 与旧行为逐字节一致（回归保护）。

### G5. 批量导出断点续传与失败重试（P1）

**差距**：RawLab 支持 resumable batch export（checkpoint、取消、失败项重试）；我方 export_processing.rs 仅"取消时停在下一个 checkpoint"，无断点恢复与单失败项重试。

**方案**：

1. 导出清单落盘 journal（`{job_id, items: [{path, status, hash, out_path}], settings_frozen}`，JSON，写入应用数据目录）；每项完成后更新 status=done；
2. 新命令 `resume_export_job`：读取 journal，跳过 done 项继续；`retry_failed` 仅重跑 failed 项；导出设置以 journal 冻结为准（防中途改参数导致不一致）；
3. 前端导出弹窗：失败汇总列表 + 「重试失败项」「继续上次导出」按钮（启动时检测未完成 journal 提示恢复）；
4. 事件流复用现有 export progress 事件。

**改动范围**：`src-tauri/src/export_processing.rs`、`src-tauri/src/lib.rs`（2 个新命令 + 前端 `Invokes`/`Events` 注册）、导出模态框、i18n。

**风险**：中低；journal 写入需原子（tmp + rename），避免崩溃损坏。

**验收**：批量导出 100 张中途 kill 进程 → 重启恢复继续，已完成项不重复导出；单张失败重试不影响其余。

### G6. Agent/CLI 能力发现 + JSON 编辑 + MCP（P2，差异化）

**差距**：RawLab 暴露 5 个 MCP 工具（`capabilities / validate_recipe / image_info / render_preview / export_photo`，`tools/mcp/src/rawlab_mcp/server.py`），Agent CLI 与 GUI 共享参数语义与渲染核心；我方仅有 headless 导出（[lib.rs](/workspace/src-tauri/src/lib.rs#L2269)）。

**方案**：

1. CLI 扩展子命令：`anwuRAW capabilities`（输出 JSON：支持的调整参数 schema、掩码类型、导出格式）、`anwuRAW export --input x --adjustments adjustments.json --out y`（复用现有 headless 路径， adjustments JSON 与 GUI sidecar 完全同构——这就是"共享语义"）；
2. `validate` 子命令：前端 `ADJUSTMENT_SECTIONS` schema 导出一份 JSON（构建期生成，放入资源），Rust 侧据此校验入参并返回错误明细；
3. MCP：新增 `tools/mcp/`（Python FastMCP，~200 行），5 个工具直接包装上述 CLI 子命令（与 RawLab 同构），文档说明接入 Claude/Cursor 的配置片段；
4. 不引入常驻服务进程，保持"本地 CLI 包装"边界（对齐 RawLab "not a new server framework" 的克制原则）。

**改动范围**：`src-tauri/src/lib.rs`（CLI 解构重构，抽出 `run_cli()`）、构建脚本生成 schema、新目录 `tools/mcp/`、`docs/` 使用说明。

**风险**：低；注意 CLI 与 GUI 版本号同步（capabilities 输出带 version）。

**验收**：`capabilities` 输出能被 `validate` 消费；MCP 客户端完成"读参数 → 导出"闭环。

### G7. RAW 兼容性跟进（P1，低成本审计）

**差距**：RawLab 0.8.2 新增 Nikon HE/HE* NEF、Sony ARW6/Compressed RAW 2、Sigma X3F 输入、JPEG 压缩 DNG、JPEG XL DNG（Adobe DNG SDK 1.7.1）。我方 rawler 为 RapidRAW-DngLab git fork，支持矩阵未知且无测试样张。

**方案**：

1. **审计**：对照 rawler 上游 changelog 列出 HE/HE*、ARW6、X3F、JPEG-XL DNG 支持状态，形成 `docs/raw-format-support.md` 支持矩阵（含已验证机型）——先有契约文档，再谈升级；
2. 评估 fork rebase 上游新版本（demosaic/解码修复跟随），回归用 G3 的处理版本机制锁住旧编辑结果；
3. 建 `tests/samples/` 最小样张集（用户贡献 + 开放许可样张），CI 冒烟解码。

**改动范围**：文档 + `src-tauri/Cargo.toml`（可选升级）+ CI 冒烟 job。

**风险**：中（rawler 升级可能改渲染，需 G3 先行）；X3F 若 rawler 不支持则明确"不支持"写入矩阵，不承诺。

**验收**：支持矩阵文档发布；每格式至少 1 样张解码通过。

### G8. DCP 导入（P2，高成本，按需）

RawLab 支持导入 .dcp（TIFF 容器 + ProfileToneCurve/HueSatMap/OpcodeList，且有明确"子集契约 + 黑色渲染策略"）。我方基于 rawler，若要支持需自写 DCP 解析（无成熟 Rust crate）并接入 wb/色彩管线。**建议**：列入 backlog，待用户需求出现再启动；若启动，先写 `docs/dcp-import-contract.md` 定义子集边界（照搬 RawLab 的契约思路）。

### G9. 渲染型 DNG 导出（P3，暂缓）

float32 DNG 导出需 Adobe DNG SDK 或完整自写 writer，工程量大、用户面窄。我方已有 JPEG/PNG/TIFF 导出。**暂缓**，backlog 记录。

### E1. 工程纪律借鉴（P1，组织性，零代码成本）

RawLab 最值得学的是工程流程，建议固化三条：

1. **契约文档**：为关键行为写 contract（参照其 `color-contract.md`）——优先补两份：`docs/contracts/rendering-pipeline.md`（渲染顺序、缓存 key 构成、处理版本语义，即 G3 的落地物）与 `docs/contracts/adjustments-schema.md`（参数名、范围、默认值，兼作 G6 的 schema 源）；
2. **发布验收清单**：release 前固定 checklist（全平台资产数断言已有，补充：签名校验、updater 链路 dry-run、样张冒烟、i18n:check），写入 release.yml 或 docs；
3. **评审留痕**：重大变更（如 G3 管线版本）在 PR 中附验证证据清单（RawLab 用 provenance JSON 的思路，我方可简化为 PR 描述模板）。

---

## 4. 实施路线图建议

| 阶段   | 内容                                       | 依赖                        |
| ------ | ------------------------------------------ | --------------------------- |
| 第一批 | G1 自动更新、G4 预设强度、E1 契约文档起步  | 无                          |
| 第二批 | G3 处理版本 + 缓存契约、G2 HSL 目标调整    | G3 独立，G2 独立可并行      |
| 第三批 | G5 导出断点续传、G7 RAW 支持矩阵与样张冒烟 | G3（rawler 升级依赖版本锁） |
| 第四批 | G6 CLI/MCP；G8/G9 视需求评估               | G6 依赖 E1 schema 文档      |

每一项独立可发布，不阻塞常规版本节奏。

## 5. 明确不引入项

- **遥测统计**（RawLab 0.8.1 起默认开启 Alibaba RUM）：与我方当前产品定位不符，不做；
- **四端原生客户端路线**：Tauri 单栈已覆盖桌面 + Android，无需引入多客户端维护成本；
- **LibRaw 迁移**：rawler fork 运转良好且内存/许可更优，仅做版本跟进。

---

_调研底稿：RawLab 源码浅克隆于 /tmp/rawlab（commit 83f470c）；关键引用：release notes v0.7.0–v0.9.0、`lutools/docs/color-contract.md`、`lutools/docs/processing-version.md`、`docs/integration/editing-iteration/desktop-updates-plan.md`、`docs/design/editing-iteration/requirements.md`、`tools/mcp/src/rawlab_mcp/server.py`。_
