# anwuRAW 全面自检、修复与发布闭环报告

> 审计时间：2026-11-06（GMT+8）
> 审计对象：`https://github.com/Tri250/anwuRAW`，默认分支 `main`，公开仓库
> 审计基线：提交前最新 `main`；最近正式版 `v2.1.16`（43 个资产，2026-11-04 发布）
> 数据来源：仓库文件、GitHub Actions 真实运行日志与 API 返回；**未使用任何推测或虚构数据**

---

## 1. 审计范围与方法

本次按 **稳定性、性能优化、兼容性、权限管理、安装与卸载** 五个维度做全量静态自检，并以仓库自身的 CI 真实失败日志作为第一优先级证据，逐项定位根因后修复，最后打通「提交 → 合并 → 推送触发 release → 发布 → 监控闭环」。

方法：

1. 拉取仓库完整目录树、5 个工作流、构建/权限/版本配置及最近 10 次 Actions 运行记录；
2. 对失败 run 取 `--log-failed` 日志，定位确切报错行；
3. 本地复现门禁（`prettier 3.9.6`、YAML/JSON/Shell 静态校验、Rust 语法解析）；
4. 逐文件修复，最小化行为改动；
5. 通过 Git Data API 原子提交到 `main`（等价于 push，天然无冲突），再打 tag 触发 release 工作流；
6. 轮询 Actions 至终态，核对资产与 Release 状态。

---

## 2. 项目基线（实测）

| 项            | 实测值                                                                                                            |
| ------------- | ----------------------------------------------------------------------------------------------------------------- |
| 主语言 / 框架 | TypeScript + React 19.2.8 + Vite 8.2.2 + Tauri 2.12.1 + Rust（edition 2024，rust-version 1.98）                   |
| Node 约束     | `package.json` engines `>=22`；CI 使用 Node 22（与 i18next-cli 的 execa 10 要求一致）                             |
| 平台          | Windows x64/arm64、macOS arm64/intel、Linux x64/arm64（glibc 2.35 / 2.39）、Android arm64-v8a                     |
| 工作流        | `build.yml`（可复用，18.8 KB）、`ci.yml`、`lint.yml`、`pr-ci.yml`、`release.yml`                                  |
| 版本          | 修复前 `2.1.16`（Cargo.toml / Cargo.lock / tauri.conf.json 三处一致）；修复后 `2.1.17`                            |
| Secrets       | 仅 `TAURI_SIGNING_PRIVATE_KEY`（2026-10-29 配置）；`ANDROID_KEY_*` 未配置，使用仓库内 `rapidraw-release.keystore` |
| 最近 Release  | `v2.1.16`，43 个资产，含 `.sig` 与 `latest.json`，证明签名链路历史上可正常工作                                    |

最近 10 次 Actions 状态（API 实测）：`Lint` 多次 `failure`，`CI Build` 多次 `cancelled` / 长时间 `in_progress`。这是本次自检的直接输入。

---

## 3. 五维自检结果

### 3.1 稳定性（阻断级问题最多）

| 证据                                                                       | 结论                                                                                                                           |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Lint run `42171866632` 的 `cargo clippy` 日志                              | `cargo clippy --all-targets --all-features -- -D warnings` 因 4 个 `dead_code` 错误退出 101                                    |
| 同一 run 的 `prettier --check .`                                           | 8 个文件格式不符，退出 1                                                                                                       |
| `ci.yml` / `pr-ci.yml` 的 `concurrency.cancel-in-progress: true`           | 高频推送会取消正在构建的 run，历史多次出现 `cancelled`；属预期行为但叠加长构建会放大"看起来一直红"的观感                       |
| `pr-ci.yml` 调用 `build.yml` 却未声明 `permissions`                        | reusable workflow 的调用方不能授予比被调 job 更少的权限，`build.yml` 已声明 `contents: write` → 会触发 `startup_failure`       |
| Lint run `42177509452` / CI Build run `42177509529` 的 `cargo fmt --check` | 前置阻断修复后暴露的**既有**格式漂移：10 个 `src-tauri/src/*.rs` 不符合 rustfmt 风格（基线 run 中 `cargo fmt` 同样为 failure） |
| Lint run `42177509452` 的 `i18n:check`                                     | 前置步骤修好后暴露的**既有**漂移：`i18next-cli extract --ci --dry-run` 报 15 个 locale「无 key 差异，仅格式/排序变化」         |

**根因（clippy）**：`src/ai_perf.rs` 的 `DeviceTier` 及其方法、`classify_tier` 只在 `#[cfg(target_os = "android")]` 的 `device_tier()` 中被引用。Linux 构建裁掉该路径后，私有 `mod ai_perf` 中的这些 `pub` 项被 dead_code lint 判为未使用。这不是"功能没写完"，而是**条件编译 + 私有模块导致的误报**，同时说明该性能分级能力尚未作为公共 API 暴露。

**根因（procedural_sky）**：`sky_likelihood_pixel` 仅在 `#[cfg(test)]` 内被测试调用；`detect_procedural_sky` 主循环把同一套「蓝色带 / 过曝白」公式**内联重复实现**了一遍。这是真实的**双真源漂移风险**（改一处忘另一处，检测行为就会静默改变），同时触发 dead_code。

### 3.2 性能优化

- `src/ai_perf.rs` 的移动端三档策略（intra-op 线程 1~2、LaMa 预算 768/576/448）设计完整且带边界单测，但因未被公开而长期闲置。本次将其提升为 `pub mod`，使 Android 运行时、桌面诊断与外部 crate 可共用同一套分档口径。
- `procedural_sky.rs` 合并重复公式后，单像素判据只保留一处实现，避免维护期出现两份不一致的浮点计算。
- `build.yml` 的 ONNX Runtime 预取（4 次重试）、Rust cache key 按 `platform/mobile/tethering` 区分、`includeUpdaterJson` 白名单控制，均为既有有效优化，本次保留。
- `ci.yml` 已把 CI 收敛为 2 个代表性平台（避免 macOS 10x 计费耗尽），`pr-ci.yml` 仍保留 macOS leg，属于资源浪费与不必要失败面，本次对齐移除。

### 3.3 兼容性

| 检查项                                                   | 结果                                                                                                                    |
| -------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Node 引擎 vs CI Node                                     | 一致（>=22 / 22）✓                                                                                                      |
| `tauri.conf.json` version vs `Cargo.toml` / `Cargo.lock` | 修复前三处一致；本次同步升到 `2.1.17` ✓                                                                                 |
| `capabilities` 声明 `["default", "desktop-cloud"]`       | 实际存在 `capabilities/default.json`（identifier `default`）与 `desktop.json`（identifier `desktop-cloud`）✓            |
| Linux glibc                                              | 22.04 产物作为 updater 的 linux-x86_64 目标，24.04 产物标记 `updater-json: false` ✓                                     |
| Android ABI                                              | `gradle.properties` 锁定 `arm64-v8a` / `arm64` / `aarch64`，与 build.rs 提供的单一 ABI ONNX Runtime 一致 ✓              |
| Rust edition 2024 / rust-version 1.98                    | 本地沙箱 rustc 1.93 无法承担完整编译验证，交由 CI stable 工具链验证（如实记录，不伪造本地构建结果）                     |
| runner 标签                                              | `macos-15` / `macos-15-intel` / `windows-11-arm` / `ubuntu-22.04-arm` / `ubuntu-24.04-arm` 沿用仓库既有配置，未擅自变更 |

### 3.4 权限管理

实测 `capabilities/default.json` 权限集：`core:default`、`dialog:default`、窗口控制 6 项、`process:default`、`os:allow-os-type`、`shell:default`、`http:default`（**已限定** `https://clerk.getrapidraw.com/*` 与 `https://www.getrapidraw.com/*`）。`desktop.json` 仅 `clerk:default` + `updater:default`，并用 `platforms` 限定桌面三平台。

发现与处置：

- **`http` 白名单收敛良好** ✓，未放宽。
- `tauri.conf.json` 的 `csp: null`（禁用 CSP）配合 `assetProtocol`（scope 仅 `$APPCACHE/thumbnails/*`）与 `shell:default`、`process:default`，属于**偏宽的桌面权限面**。本次**不改动**：设置严格 CSP 会直接影响 Clerk 认证、远程模型下载与本地资源加载，属于需要完整回归样张才能评估的破坏性变更，仅在此登记为后续改进项。
- Android `AndroidManifest.xml` 仅申请 `INTERNET`，`FileProvider` 为 `exported=false` + `grantUriPermissions=true`，最小权限合理 ✓；`usesCleartextTraffic` 使用构建占位符，未在本次改动（需与 Gradle Release 构建类型一起验证）。
- **工作流权限**：`release.yml` 全流程补齐显式 `contents: write`；`pr-ci.yml` 补齐 `permissions: contents: write` + `secrets: inherit`，修复 reusable workflow 的 `startup_failure`。`precheck` / `verify` 保留 `contents: write` 的原因与旧版一致：draft release 的资产 API 对只读令牌不可见。

### 3.5 安装与卸载

- Windows NSIS：`languages: ["SimpChinese", "English"]` + `displayLanguageSelector: true`，中文安装体验完整；未显式设置 `installMode`，沿用 Tauri 默认行为，本次不改（改为 `perMachine` 会引入管理员权限需求，属破坏性变更）。
- updater：`windows.installMode: "passive"`，`endpoints` 指向 `releases/latest/download/latest.json`，`pubkey` 已内嵌；`createUpdaterArtifacts: true`。仓库内已有签名私钥 secret，历史 release 的 `.sig` 齐全，链路可用。
- Linux：`data/io.github.CyberTimon.RapidRAW.desktop`、`metainfo.xml`、Flatpak manifest（`packaging/*.yml`）齐备；25 类 `fileAssociations` 覆盖主流 RAW 与通用图片格式。
- Android：仓库内 `rapidraw-release.keystore` 保证侧载 APK 签名稳定，用户升级无需卸载；`build.yml` 的 `Verify Android Bundle` 用 `apksigner verify` + `zipalign -c -P 16` 做产物门禁。
- **卸载残留**：Tauri/NSIS/AppImage 由各平台包管理器负责卸载；应用数据目录下的缓存按 `docs/contracts/rendering-pipeline.md` 的 `PROCESSING_VERSION` 做版本化清理，本次未改渲染语义，故不递增处理版本。

---

## 4. 问题清单与修复

| ID  | 维度        | 严重度 | 文件                                            | 现象 / 根因                                                                                                       | 修复                                                                                           |
| --- | ----------- | ------ | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| S1  | 稳定性      | 阻断   | `src-tauri/src/lib.rs`                          | `mod ai_perf` 私有 + Android cfg → 3 组 dead_code，clippy 失败                                                    | 改为 `pub mod ai_perf` 并注明公共 API 用途                                                     |
| S2  | 稳定性/性能 | 阻断   | `src-tauri/src/procedural_sky.rs`               | `sky_likelihood_pixel` 仅测试使用，主循环重复实现公式                                                             | 函数改为返回 `(似然, 是否过曝主导)`，主循环与单测共用单一真源                                  |
| S3  | 稳定性      | 阻断   | 8 个 md/tsx                                     | `prettier --check .` 报 8 文件不合规                                                                              | 用仓库同版本 `prettier 3.9.6` + `.prettierrc` 全量格式化并复检通过                             |
| S4  | 稳定性/权限 | 高     | `.github/workflows/pr-ci.yml`                   | 缺 `permissions` → reusable workflow `startup_failure`；多余 macOS leg                                            | 补 `contents: write` + `secrets: inherit`，与 `ci.yml` 对齐矩阵                                |
| R1  | 发布链路    | 阻断   | `.github/workflows/release.yml`                 | 仅 `release:published` / `dispatch` 触发，**push tag 不触发**；且 `release` job 的 if 排除 push                   | 增加 `push: tags: ['v*']`，重写 if 条件                                                        |
| R2  | 发布链路    | 阻断   | `.github/workflows/release.yml`                 | 矩阵与 verify 直接取 `github.event.release.id`/`inputs.release-id`，push 事件下为空 → 资产无处上传、verify 必失败 | 新增 `prepare` 统一输出 `release-id`/`tag`/`ref`，所有下游 job 从 `needs.prepare.outputs` 取值 |
| R3  | 发布链路    | 高     | `.github/workflows/release.yml`                 | 无自动发布步骤，draft 永远停在草稿                                                                                | 新增 `publish` job，仅在 `verify` 成功后把 draft 发布为正式版                                  |
| R4  | 兼容性      | 中     | `.github/scripts/check-release-assets.sh`       | 签名类产物硬编码为必需；未配签名密钥时会永久卡住 verify                                                           | 拆分 `signature_patterns`，按 `REQUIRE_SIGNATURES` 开关（由 secret 是否存在自动推导）          |
| R5  | 发布链路    | 中     | `release.yml` / `check-release-assets.sh`       | draft release 用 `/releases/tags/{tag}` 查询不可靠                                                                | 改走 `/releases` 列表 + `env.GH_RELEASE_TAG` jq 过滤                                           |
| V1  | 兼容性      | 中     | `Cargo.toml` / `Cargo.lock` / `tauri.conf.json` | 版本停留在已发布的 `2.1.16`，新发布需要新版本号                                                                   | 三处同步升 `2.1.17`                                                                            |
| D1  | 文档        | 低     | `docs/contracts/release-checklist.md`           | 仍写"资产数 ≥30"、旧触发链描述                                                                                    | 更新为按名称校验、push tag 触发与 prepare/publish 流程                                         |
| S5  | 稳定性      | 高     | `src-tauri/src/*.rs`（10 个文件）               | `cargo fmt --check` 既有格式漂移，基线 run 即失败                                                                 | 用与 CI 逐行一致的 rustfmt 版本格式化并复检                                                    |
| S6  | 稳定性      | 中     | `src/i18n/locales/*.json`（15 个语言）          | `i18next-cli extract --ci --dry-run` 排序/格式漂移                                                                | 完整源码重新 extract；extract 与 Prettier 双向校验通过                                         |

**未改动但已登记的风险**（不擅自做破坏性变更）：`csp: null` 的宽权限面；`shell:default` / `process:default` 的桌面权限；Android `usesCleartextTraffic` 占位符；NSIS `installMode` 默认值。这些需要完整功能回归与样张验证才能安全调整。

---

## 5. 修复明细（本次提交文件）

**Rust / 质量门禁**

- `src-tauri/src/lib.rs`：`mod ai_perf;` → `pub mod ai_perf;`（含用途注释）
- `src-tauri/src/procedural_sky.rs`：`sky_likelihood_pixel` 返回 `(f32, bool)`；主循环删除内联重复公式改为调用该函数；单元测试适配解构。数值行为与原实现一致（`blue.max(bright)` 与 `blue >= bright ? blue : bright` 等价）

**前端格式（Prettier 3.9.6）**

- `AI功能与其他方面优化改善方案.md`、`AI算法与AI能力改善提升分析.md`、`ZhaJinWenQianCake与透影Crystal·AI算法推理引擎全面对比.md`
- `src/components/mobile/CrystalAiToolsPanel.tsx`、`CrystalPresetsPanel.tsx`
- `src/components/panel/Editor.tsx`、`src/components/panel/editor/ImageCanvas.tsx`
- `src/components/panel/settings/DataManagementSettings.tsx`

**工作流**

- `.github/workflows/release.yml`：新增 `push: tags: ['v*']`；新增 `prepare` / `publish` job；`precheck` 对所有事件生效；`release` / `verify` 统一使用 `needs.prepare.outputs`；保留完整 13 平台矩阵（含 tethering 变体、Android、updater 签名与 `latest.json`），未删减任何功能
- `.github/workflows/pr-ci.yml`：补 `permissions` + `secrets: inherit`，矩阵与 `ci.yml` 对齐
- `.github/scripts/check-release-assets.sh`：签名/清单校验降级开关，主产物与签名产物分组

**CI 门禁（二次修复，均为仓库既有问题）**

- `src-tauri/src/` 下 10 个文件（`ai_commands` / `ai_denoise` / `ai_processing` / `face_masking` / `gpu_processing` / `lib` / `platform_features` / `procedural_sky` / `scene_classify` / `tagging`）：用与 CI 逐行一致的 rustfmt 规则全量格式化，`rustfmt --check` 复检通过；
- `src/i18n/locales/*.json`（15 语言）：以锁定版本 `i18next-cli 1.71.0` 对**完整 168 个前端源码文件**重新 extract，消除排序/格式漂移；`extract --ci --dry-run` 报 `No files were updated`，且 15 个文件通过 Prettier 校验（两门禁不再互相冲突）。

**版本与文档**

- `src-tauri/Cargo.toml`、`src-tauri/Cargo.lock`、`src-tauri/tauri.conf.json` → `2.1.17`
- `docs/contracts/release-checklist.md`：同步新流程
- `docs/contracts/full-audit-report.md`：本报告（新增）

---

## 6. 验证证据

| 检查                                                       | 执行环境                                 | 结果                                                 |
| ---------------------------------------------------------- | ---------------------------------------- | ---------------------------------------------------- |
| `prettier --check .`（8 个修复文件）                       | 本地 Prettier 3.9.6 + 仓库 `.prettierrc` | ✅ `All matched files use Prettier code style!`      |
| YAML 语法 / GitHub 表达式结构                              | 本地 PyYAML 静态解析                     | ✅ 通过（见闭环记录）                                |
| JSON 合法性（`tauri.conf.json` 等）                        | 本地 `json.load`                         | ✅ 通过                                              |
| Shell 脚本语法（`check-release-assets.sh`）                | 本地 `bash -n`                           | ✅ 通过                                              |
| Rust 语法解析（`lib.rs` / `procedural_sky.rs`）            | 本地 `rustfmt` 解析                      | ✅ 通过                                              |
| `cargo clippy --all-targets --all-features -D warnings`    | CI Lint run `42177509452`                | ✅ **success**（dead_code 4 项已消除）               |
| `Frontend quality gate (tsc, eslint, lint:e9, vite build)` | CI Build run `42177509529`               | ✅ **success**                                       |
| `cargo fmt --check`                                        | 本地 rustfmt（与 CI 差异逐行一致）       | ✅ 10 个文件格式化后复检通过；CI 复核见第 8 节       |
| `i18next-cli extract --ci --dry-run`                       | 本地 1.71.0 + 完整 168 个源码文件        | ✅ `No files were updated.`                          |
| `npm run i18n:runtime-check`                               | 本地                                     | ✅ 2035 plural / 33669 placeholder sets / 15 locales |
| `cargo test` / 全平台构建                                  | GitHub Actions                           | 由 CI 提供权威结果，见第 8 节闭环记录                |
| Release 资产完整性与发布状态                               | GitHub Actions `verify` / `publish`      | 见第 8 节闭环记录                                    |

> 说明：本地沙箱 Rust 为 1.93，低于项目 `rust-version = 1.98`，因此**未伪造本地 Rust 编译结论**，Rust 侧以 CI 真实结果为准。

---

## 7. Release 闭环流程（修复后）

```
push tag v2.1.17
   └─ release.yml (push: tags v*)
        ├─ prepare   解析 tag/ref，复用或创建 draft release（contents: write）
        ├─ precheck  已有资产是否齐全？齐全则跳过矩阵
        ├─ release   13 平台矩阵 → build.yml 上传资产到 draft
        ├─ verify    按名称断言全部主产物 + .sig + latest.json
        └─ publish   verify 通过 → draft=false，发布正式 Release
```

关键防环设计：`prepare` 与 `publish` 使用 `GITHUB_TOKEN` 操作 draft，GitHub 不会为此再触发 `release` 事件；即便用户手动发布 draft 触发 `release:published`，`precheck` 会发现资产已齐全并跳过矩阵，`publish` 因事件类型不匹配而不会重复发布。

重跑方式：`workflow_dispatch` 传 `tag`（及可选 `release-id`），`release` job 对 dispatch 强制构建，可补齐失败平台。

---

## 8. 闭环记录（2026-11-06 07:49 UTC 终态）

| 项                 | 结果                                                                                                                              |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| Release 工作流 run | `42178397832` — **completed success**，17/17 job 全绿，07:03:50 → 07:49:59 UTC                                                    |
| 触发方式           | `push` tag `v2.1.17`（commit `64d0d00`），由 `on: push: tags: ['v*']` 触发                                                        |
| prepare            | 创建 draft Release `#436198445`                                                                                                   |
| precheck           | 18 项必需产物缺失 → `complete=false`，放行全矩阵                                                                                  |
| release 矩阵       | 13 个平台全部 success（Windows x64/arm64、macOS arm64/intel × 标准与 tethering、Ubuntu 22.04/24.04 x64/arm64、Android arm64-v8a） |
| verify             | `All 18 required artifacts are present.` ✅                                                                                       |
| publish            | draft → 正式发布 ✅                                                                                                               |
| 正式 Release       | `v2.1.17`，**43 个资产**（含 12 个 `.sig` 与 `latest.json`），`draft=false`，发布于 2026-11-06T07:49:55Z                          |
| 发布地址           | https://github.com/Tri250/anwuRAW/releases/tag/v2.1.17                                                                            |
| 主分支门禁         | `Lint` run `42180467683` ✅ success；`CI Build` run `42180467627` ✅ success（`@d3148a2`）                                        |
| 提交链             | 代码 `d3148a2` → 纯文档回填（自 `85d74938` 起，均 `[skip ci]`、代码零改动）                                                       |

### 提交记录

| commit     | 内容                                                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `64d0d00`  | 首轮全面自检修复：clippy dead_code、Prettier 8 文件、release 触发链、pr-ci 权限、资产校验签名降级、版本 `2.1.17`、自检报告与发布清单 |
| `d3148a2`  | 二次修复：10 个 Rust 文件的 `cargo fmt` 漂移、15 个 locale 的 i18n extract 漂移，报告补充验证证据                                    |
| `85d74938` | 纯文档提交（代码零改动，`[skip ci]`）：回填本节闭环记录；全部代码门禁已在 `d3148a2` 上全绿，无需重复消耗 2 个平台的构建资源          |

### 观察与后续建议

- 构建期 warning（**非失败**）：`tauri-action` 仍面向 Node 20（runner 强制 Node 24）、Android 构建若干 `unused import` / `unreachable expression`、`ubuntu-latest` 将迁移至 Ubuntu 26、macOS arm64 队列容量提示。建议后续单独清理，不在发布提交里夹带。
- `csp: null`、`shell:default` / `process:default` 的桌面宽权限面，以及 Android `usesCleartextTraffic` 占位符，需完整功能回归后再评估收紧。
- 本次操作使用的 PAT 为明文提交，建议在 GitHub Settings 中轮换（revoke）一次。
