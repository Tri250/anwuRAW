# RapidRAW / anwuRAW — v1.6.14 正式版交付要求审计报告

- **审计对象**: release `1.6.14`（workspace 快照，单 commit `d009f2a`，无本地 tag）
- **审计角色**: 资深产品经理（发布管理视角）
- **审计方法**: 以"正式版（GA）交付基线"为标尺，逐项核对版本管理、构建发布工程、质量门禁、安全合规、文档、法务、数据兼容 7 大域。所有结论均基于仓库内证据（配置文件、CI 定义、打包清单、测试资产）。
- **审计日期**: 2026-10-13

---

## 1. 总体结论

> **有条件放行（Conditional Go）**：产品功能与多平台构建矩阵已达正式版水准，但 **分发信任链（签名/校验和）、质量门禁（CI 不执行任何测试）、平台资产一致性（RapidRAW vs anwuRAW 分裂）** 三条硬性红线未达标。**6 项 P0 修复完成前，不建议以"正式版/Stable"名义发布**；可先以 RC 名义灰度。

### 发布就绪度评分卡

| # | 维度 | 评分 | 关键依据 |
|---|------|:----:|----------|
| 1 | 版本与元数据一致性 | **C** | 三处版本号 1.6.14 一致 ✓；但 metainfo 停在 v1.6.2、品牌 RapidRAW/anwuRAW 分裂 |
| 2 | 构建与 CI 矩阵 | **B+** | 10 平台发布矩阵 + PR 双架构矩阵完整；tauri-action 钉死 dev 分支 commit |
| 3 | 签名与分发安全 | **D** | 桌面端零签名/公证；Android 可静默降级 debug 签名；无校验和产物 |
| 4 | 测试与质量门禁 | **D** | **CI 不执行任何测试**；lint 三项检查全部 `continue-on-error` |
| 5 | 安全合规 | **C-** | CSP=null；构建期网络下载 ONNX Runtime |
| 6 | 文档与本地化 | **B** | README 完善、13 语言 + i18n CI 检查 ✓；无 CHANGELOG、更新日志过期 |
| 7 | 法务与数据兼容 | **B-** | AGPL + 第三方许可目录 ✓；.rrdata 无 schema 版本化，历史上有迁移事故 |
| — | **综合** | **2.4 / 5** | 功能 Ready，工程交付链 Not Ready |

---

## 2. P0 — 正式版交付阻塞项（必须修复）

### P0-1 CI 流水线不执行任何测试
- **证据**: [build.yml](file:///workspace/.github/workflows/build.yml) 全文无 `cargo test` / `npm test` 步骤；[lint.yml](file:///workspace/.github/workflows/lint.yml) 仅 fmt/clippy/前端静态检查；[ci.yml](file:///workspace/.github/workflows/ci.yml) 只触发构建。
- **现状**: 仓库实际存在 74 个 Rust 测试（集中在新模块 `color_range_mask` / `luminance_range_mask` / `iptc_processing` / `mask_generation`）+ 4 个前端测试文件，**全部处于"写了但 CI 永不运行"状态**。
- **影响**: 正式版最基本的"每个 commit 均被测试验证"承诺无法兑现；回归只能靠用户发现。
- **修复**: lint.yml 增加 `cargo test --all-features` 与 `npm test` job（必过、去掉 continue-on-error）；build.yml 构建前插入快速测试步骤。

### P0-2 前端质量门禁整体失效
- **证据**: [lint.yml](file:///workspace/.github/workflows/lint.yml#L26) `format:check`、[L30](file:///workspace/.github/workflows/lint.yml#L30) `eslint`、[L34](file:///workspace/.github/workflows/lint.yml#L34) `i18n:check` 三项全部 `continue-on-error: true`。
- **影响**: 格式漂移、lint 报错、翻译键缺失都不会拦截合并 —— 门禁形同虚设。
- **修复**: 移除三处 `continue-on-error`（先做一次全量修复清零存量告警，再开启阻断）。

### P0-3 Android 发布签名可静默降级为 debug keystore
- **证据**: [build.yml](file:///workspace/.github/workflows/build.yml#L119-L141) —— 当 `ANDROID_KEY_*` secrets 未配置时，脚本生成**临时 debug keystore 并继续签名发布**，仅输出警告日志。
- **影响**: debug 签名的 APK 若流入 Release 页，用户将无法升级到后续正式签名包（签名不一致），也无法上架 Google Play。
- **修复**: release 路径下 secrets 缺失应 `exit 1` 硬失败；降级逻辑仅保留在 PR/CI 构建路径。

### P0-4 品牌分裂导致 Linux 渠道资产损坏（RapidRAW vs anwuRAW）
- **证据链**:
  - [tauri.conf.json](file:///workspace/src-tauri/tauri.conf.json#L4-L5) `productName`/`mainBinaryName` = **anwuRAW**；
  - [RapidRAW.desktop](file:///workspace/data/io.github.CyberTimon.RapidRAW.desktop) `Exec=RapidRAW`；
  - [RapidRAW.yml](file:///workspace/packaging/io.github.CyberTimon.RapidRAW.yml#L67) `install ... target/release/RapidRAW` —— 新命名下该路径产物为 `anwuRAW`，**Flatpak 构建将直接失败**；且 [L26](file:///workspace/packaging/io.github.CyberTimon.RapidRAW.yml#L26) 源码 tag 钉死在 **v1.3.13**、[L78](file:///workspace/packaging/io.github.CyberTimon.RapidRAW.yml#L78) 拷贝的 `src-tauri/workflows` 目录在仓库中不存在（第二处构建失败点）；
  - Android 侧 [build.yml](file:///workspace/.github/workflows/build.yml#L198) 又用 `app_name="anwuRAW"`。
- **影响**: .deb/AppImage 桌面入口、Flatpak 全渠道不一致甚至不可构建；用户侧出现两个"名字"。
- **修复**: 一揽子收敛决策（建议 2.0 前统一为 anwuRAW）：desktop `Exec`/`Icon`、flatpak `command` 与二进制路径、metainfo `name`、README 同步更名；flatpak 清单更新 tag 与产物路径，删除不存在的 `workflows` 拷贝步骤。

### P0-5 发布资产无校验和与签名
- **证据**: [release.yml](file:///workspace/.github/workflows/release.yml) 无 SHA256SUMS 生成步骤；仓库未引入 `tauri-plugin-updater`（`package.json` 依赖表中无 updater），update notifier 只做"提示有新版"。
- **影响**: 用户无法校验下载完整性；分发链路被投毒（镜像/CDN 劫持）时无第二道防线；为 2.0 自动更新埋下前置缺失。
- **修复**: release 流水线追加全资产 `SHA256SUMS.txt` 生成并上传；接入 tauri-plugin-updater 时同步引入 minisign 签名密钥体系。

### P0-6 WebView CSP 为 null
- **证据**: [tauri.conf.json](file:///workspace/src-tauri/tauri.conf.json#L27) `"csp": null`。
- **影响**: Tauri 官方明确要求生产构建设置 CSP；null 意味着 XSS 后果上限为 IPC 全权限面（当前 capability 含 `fs:default` / `shell:default`，见 [default.json](file:///workspace/src-tauri/capabilities/default.json)）。
- **修复**: 以 `default-src 'self'` + asset protocol 白名单起步，在 CI 加一条"CSP 非空"断言防回退。

---

## 3. P1 — 高风险项（正式版发布窗口内解决）

| # | 发现 | 证据 | 建议 |
|---|------|------|------|
| P1-1 | Flathub metainfo 停在 **v1.6.2**，落后 12 个版本，release notes 断档 | [metainfo.xml](file:///workspace/data/io.github.CyberTimon.RapidRAW.metainfo.xml#L41) | 将 release notes 写入纳入发版 checklist，可脚本化从 README 节选生成 |
| P1-2 | 无自动更新通道（仅站内通知） | package.json 依赖表 | 接入 `tauri-plugin-updater` + 签名 latest.json（与 P0-5 同一套密钥） |
| P1-3 | Windows 无 Authenticode、macOS 无 codesign/notarization 配置 | build.yml 全文无相关 secrets | 正式版最低要求：macOS 公证（否则 Gatekeeper 拦截）、Windows 至少 OV 证书 |
| P1-4 | tauri-action 钉死 dev 分支 commit，[FIXME](file:///workspace/.github/workflows/build.yml#L166-L168) 自认未回退 | build.yml L168 | 回退到官方 release 大版本 tag，dev 特性另行评估 |
| P1-5 | 构建期从 hf-mirror→HuggingFace 降级链下载 ONNX Runtime（网络+供应链依赖进构建） | [build.yml](file:///workspace/.github/workflows/build.yml#L183-L186) 注释 | 改为 vendor 或 GitHub Release 固定资产 + sha256 校验 |
| P1-6 | `.rrdata` sidecar 无 schema 版本号与迁移框架；历史上 v1.4.0 曾发生预设丢失事故 | metainfo v1.4.0 节"Action Required" | 2.0 强制 schema_version + 迁移链（见升级规划 T2） |
| P1-7 | 版本号在 package.json / tauri.conf.json / Cargo.toml 三处手工同步 | 三文件均已对齐 1.6.14（当前一致 ✓） | 增加 `release:bump` 脚本一次改三处 + CI 一致性断言 |
| P1-8 | rawler 为 git 依赖（fork 仓库），无 tag 固定 | [Cargo.toml](file:///workspace/src-tauri/Cargo.toml#L32) | fork 仓库打 tag 并在依赖声明中固定 `rev` |

---

## 4. P2 — 改进项（纳入 2.0 跟踪）

1. **无 CHANGELOG.md**：变更散落 README"Recent Changes"（最后一条 2026-08-27，已过期）；建议 Keep a Changelog 规范 + 发版自动生成。
2. **ONNX Runtime 依赖为 RC 版**（`ort =2.0.0-rc.10`，[Cargo.toml](file:///workspace/src-tauri/Cargo.toml#L37)）：跟踪上游 stable。
3. **webkit2gtk =2.0.2 精确 pin**：已有兼容性理由，需在 2.0 重新评估解锁。
4. **无 SBOM**：flatpak 的 `cargo-sources.json`/`node-sources.json` 已是半成品 SBOM，可复用生成 SPDX。
5. **无崩溃上报/遥测**：正式版可接受，2.0 需要崩溃率指标支撑质量承诺。
6. **README Recent Changes 与 metainfo 三处记录变更**（README、metainfo、GitHub Release），建议收敛为单一来源。

---

## 5. 亮点（保持并固化）

- **构建矩阵行业领先**: Win/macOS(ARM+Intel)/Linux(22.04+24.04)/Android arm64 × 标准/tethering 变体，PR 矩阵额外覆盖 Win-ARM 与 Linux-ARM（[pr-ci.yml](file:///workspace/.github/workflows/pr-ci.yml)）。
- **Rust 侧纪律严格**: `cargo fmt --check` + `clippy --all-targets --all-features -- -D warnings`（[lint.yml](file:///workspace/.github/workflows/lint.yml#L48-L77)）。
- **i18n 工程化**: 13 语言、`i18n:check` CI 化、runtime 校验脚本（[check-runtime.mjs](file:///workspace/src/i18n/check-runtime.mjs)）。
- **权限最小化**: Tauri capability 白名单克制、Android `usesCleartextTraffic=false`。
- **依赖决策留痕**: wgpu 降级（P3 色偏）、magetypes pin（NEON SIMD 编译失败）均有高质量注释（[Cargo.toml](file:///workspace/src-tauri/Cargo.toml#L27)）——这是可审计的工程实践。
- **发布流水线细节扎实**: release-id 数字 id 提取 + retry（[release.yml](file:///workspace/.github/workflows/release.yml#L81-L111)）。

---

## 6. Go / No-Go 检查单（正式版放行门槛）

| 门槛项 | 状态 |
|--------|:----:|
| 三处版本号一致且与 tag 匹配 | ✅ |
| CI 强制执行 cargo test + vitest | ❌ |
| lint/i18n 门禁阻断 | ❌ |
| Android release 签名 secrets 硬校验 | ❌ |
| 桌面端签名/公证（macOS 必须） | ❌ |
| 全平台资产二进制名/入口一致 | ❌ |
| SHA256SUMS 随 Release 发布 | ❌ |
| 生产 CSP 配置 | ❌ |
| Flathub metainfo 与当前版本同步 | ❌ |
| README / 官网与发布物品牌一致 | ❌ |
| clippy -D warnings / fmt | ✅ |
| i18n 13 语言完整 | ✅ |

**结论**: 12 项门槛 4 项通过。完成 P0-1~P0-6 后可复评，预期 8/12，剩余项（macOS 公证、metainfo、品牌、updater）在 1.6.15 补齐后达标。
