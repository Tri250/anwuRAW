# 发布验收清单（Release Checklist）

> 发布正式版（tag → GitHub Release）前逐项打勾。带 ⚙ 的项已由 CI 自动化，
> 带 👤 的项需人工执行。本清单与 `.github/workflows/release.yml` / `build.yml` 对应。

---

## 0. 前置 secrets 配置（👤 一次性，缺失会导致静默降级）

| Secret                                                              | 用途                                                     | 缺失时的 CI 行为                                                                      |
| ------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `TAURI_SIGNING_PRIVATE_KEY`                                         | updater 产物 minisign/EdDSA 私钥（`build.yml` L291-292） | **warning + 删除 `tauri.conf.json` 的 `plugins.updater` 后构建** → 产物无自动更新能力 |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`                                | 私钥口令（当前密钥为空口令，配空字符串即可）             | 同上                                                                                  |
| `ANDROID_KEY_BASE64` / `ANDROID_KEY_ALIAS` / `ANDROID_KEY_PASSWORD` | Android APK 正式签名（`build.yml` L199-201）             | 回退到临时 debug keystore + warning → **不能上架正式渠道**                            |

- 当前 updater 私钥存放在本地 `/tmp/anwuRAW-updater.key`（EdDSA，348 字节，空口令）。
  **/tmp 会丢**：请立即将其导入 GitHub secrets 并在安全位置另存备份；公钥已内嵌于
  `tauri.conf.json`（`plugins.updater.pubkey`），丢失私钥 = 全体已发布客户端无法自动更新。
- 换新私钥的操作顺序：生成 → 更新 secrets → 更新 `tauri.conf.json` pubkey → 发一个带 updater
  产物的过渡版本，等用户升级到位后再作废旧钥。

## 1. 版本号与变更内容（👤）

- [ ] `src-tauri/tauri.conf.json` `version`、`src-tauri/Cargo.toml`、`package.json` 三处版本一致；
- [ ] 若本次改动触碰渲染语义：`PROCESSING_VERSION` 已按
      `docs/contracts/rendering-pipeline.md` §3.2 递增，并在 PR 附验证证据（§7 模板）；
- [ ] schema 产物新鲜度：改动过参数后跑过 `npm run schema:generate`，
      `src-tauri/resources/adjustments-schema.json` 已随本次提交更新；
- [ ] Release notes 覆盖用户可感知变更，注明破坏性变更（如有）。

## 2. 本地门禁（👤 全部通过）

```bash
npm run format:check   # 格式
npm run lint           # 0 error（warning 基线见 PR 模板）
npm run typecheck      # TS 无错
npm run i18n:check     # 15 语言键完整
npm run build          # 前端构建
npm run schema:generate && git diff --exit-code src-tauri/resources/adjustments-schema.json
                       # schema 产物无漂移（drift = 有人改了单源没重新生成）
```

## 3. 样张冒烟（👤，发布前必做）

对 `docs/raw-format-support.md` 已验证样张表中的每个格式：

```bash
# 能力自检（JSON 输出，退出码 0）
anwuRAW capabilities

# 元数据解码
anwuRAW image-info sample.arw

# 最小渲染冒烟（256px 长边导出）
anwuRAW export sample.arw --output /tmp/smoke.jpg --long-edge 256
```

- [ ] 每个支持格式至少一张样张 `image-info` 成功、`export` 成功；
- [ ] 新增/升级 rawler 后，对同一样张对比升级前后导出结果的缩略图（视觉无明显回归）；
      有回归 → 按 `rendering-pipeline.md` §3.2 处理。

## 4. 发布产物（⚙ CI 自动，人工确认）

`release.yml` 的 13 job 矩阵（Windows x64/arm64、macOS arm64/intel、macOS tethering ×2、
Ubuntu 22.04/24.04 ×64/arm64、Ubuntu tethering ×2、Android arm64）：

- ⚙ **precheck**：release 事件触发时统计已有资产，≥30 则跳过重建（防止 draft 重复构建）；
- ⚙ **verify**：矩阵全部成功后断言 **资产数 ≥ 30**，不足则 release 工作流红——
  这是"半成品 release 静默发布"的最终防线；
- [ ] 👤 发布后肉眼核对资产命名前缀（01/02/02_tethering/03/03_tethering/04）与 `latest.json`。

## 5. Updater 链路 dry-run（👤 首次及签名相关变更时必做）

1. Release 页确认存在 `latest.json` 且内含各平台 updater 产物（`.sig` 签名文件齐全）；
2. 签名验证（本地模拟）：

   ```bash
   # 用 tauri CLI 校验产物签名对得上内嵌公钥
   npx @tauri-apps/cli signer verify -p "$(jq -r .pubkey src-tauri/tauri.conf.json | base64 -d >/dev/null; echo)" \
     <path-to-updater-artifact> <path-to-.sig>
   # 实操建议：直接在一个旧版本客户端点"检查更新"，确认能下载并提示安装
   ```

3. 端到端：上一个正式版本的客户端 → 检查更新 → 下载 → 安装成功 → 版本号变为新版本；
4. `endpoints` 指向 `https://github.com/Tri250/anwuRAW/releases/latest/download/latest.json`
   （`tauri.conf.json` L37-39）——确认 latest.json 确实是 assets 里的最新一份。

## 6. 发布后观察（👤）

- [ ] verify job 绿灯（30/30 资产）；
- [ ] 从旧版本客户端触发一次真实更新（若本次含 updater 变更）；
- [ ] 新版本 issue 观察 48h，RAW 解码崩溃第一时间对照样张表定位格式。

## 7. 评审留痕：PR 验证证据清单模板

重大变更（渲染语义 / 处理版本递增 / rawler 升级 / 签名变更）的 PR 描述中附加本节。
参照 RawLab 的 provenance 思路，简化为可复现证据：

```markdown
## 验证证据（Provenance）

### 变更定性

- [ ] 本次改动影响既有编辑的渲染输出？ 是/否
- [ ] 若是：PROCESSING_VERSION 已从 v__ 递增到 v__（文件：raw_processing.rs）

### 门禁

| 检查                                                         | 结果                                   |
| ------------------------------------------------------------ | -------------------------------------- |
| npm run format:check / lint / typecheck / build / i18n:check | ✅ 全绿                                |
| npm run schema:generate 产物 diff                            | 无漂移 / 已更新                        |
| cargo check / test（CI）                                     | ✅（本地沙箱无法跑 Rust 时由 CI 补证） |

### 渲染回归对比（如适用）

| 样张       | 升级前导出     | 升级后导出     | 结论            |
| ---------- | -------------- | -------------- | --------------- |
| sample.arw | v__ 产物缩略图 | 本次产物缩略图 | 一致 / 差异说明 |

### 缓存行为（如适用）

- [ ] 旧缓存目录（`*_v<旧版本>`）在首次新版本渲染后被自动清理
- [ ] 旧版本编辑记录（sidecar 缺 `processingVersion`）打开后渲染不变
```
