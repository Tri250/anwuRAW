# LUT 文件差异对比报告

**对比对象**
- 本项目：透影 Crystal（RapidRAW）**Release v2.1.25** Android 端
  `04_RapidRAW_v2.1.25_android_arm64-v8a.apk` → `assets/resources/{film_luts, master_luts, master_recipes}`
- 对比源：[dancancer/RawLab v0.13.0](https://github.com/dancancer/RawLab/releases/tag/v0.13.0) Android 端
  `RawLab-Android-0.13.0.apk`（163MB）→ `assets/{films, MasterRecipes, BundledLooks/HDR}`

**方法**：逐个解析 `.cube`（兼容 3 值/行与紧凑多值/行两种序列化），按晶格数值精确配对（Δmean / Δmax / 变化点百分比），并用「偶数抽样对齐 + 红先行(r-fastest)/蓝先行(b-fastest)双向对齐测试」判定降采样方式与存储序。

---

## 1. 总量对比

| 指标 | RawLab v0.13.0 | Crystal v2.1.25 |
|---|---|---|
| `.cube` 总数 | **54**（films 39 + MasterRecipes 14 + HDR 1） | **74**（film_luts 60 + master_luts 14） |
| 网格密度 | 13³×23、33³×2、**65³×28**、6³×1 | 13³×23、25³×6、**33³×45**、65³×0 |
| LUT 总体积 | **210.85 MB** | **49.49 MB**（≈23%，省 161MB） |
| 目录组织 | `films/` + `MasterRecipes/` + `BundledLooks/HDR/` | `film_luts/`（含汉化名）+ `master_luts/` + `master-recipes.json` |

---

## 2. 内容级映射与保真度（核心结论）

水晶端除 6 个 spektrafilm 外，**全部与 RawLab 同源，且数值零损失**：

| 类别 | 数量 | RawLab 原件 | Crystal 打包件 | 数值差异 |
|---|---|---|---|---|
| RL 胶片外观 | 23 | `RawLab_look_*` 13³ | `RL·*.cube` 13³ | **Δ=0**（逐位一致；仅头注释空行/`LUT_3D_SIZE` 位置等文本序列化差异，故 md5 不同） |
| RL 相机复刻 | 5 | lumix/pentax 原生 33³；gr2 vivid/hibw/contax 65³ | `RL·相机·*` 33³ | **Δ=0**（65³ 三件为偶数下抽样，逐位精确；内嵌 RawLab 溯源 JSON：sourceSha256/adaptation/resampled） |
| 大师配方 LUT | 14 | `MasterRecipes/*.cube` 65³ | `master_luts/大师·*.cube` 33³ | **Δ=0**（65→33 偶数下抽样，头注释 `even-index exact subsample`） |
| 大师配方副本 | 14 | 同上 | `film_luts/大师·*.cube` 33³ | 同数据，但**存储序异常**（见 §3） |
| 富士 F-Log2 转换 | 9 | `FLog2_to_*_65grid` 65³ | `富士·*（F-Log2）` 33³ | **Δ=0**（偶数下抽样），但**存储序异常**（见 §3） |
| 富士·EKTAR 100 Phuket 强 | 1 | `EKTAR_100_Phuket_v2_Strong_FLog2_FGamut_65` 65³ | `富士·EKTAR 100 Phuket 强` 33³ | **Δ=0**，存储序正常 |
| spektrafilm | 6 | **无**（非来自 RawLab） | `K-*`×5、`F-Pro 400H`，25³ | 第三方 [spektrafilm](https://github.com/andreavolpato/spektrafilm) v0.3.4，V-Log 输入→sRGB，CC BY-SA 4.0（已附 `SPEKTRAFILM_LICENSE.txt`） |
| 富士·WDR 宽容度 | 1 | **无**（APK 内无对应） | 33³ | 水晶独有，疑与 §3 同管线 |
| 富士·F-Log2 转 Rec.709 | 1 | **无**（APK 内无对应） | 33³ | 水晶独有中性转换，疑与 §3 同管线 |

### 2.1 RL 胶片 23 款逐位一致映射表

| Crystal (13³) | ← RawLab (13³) |
|---|---|
| RL·Portra 400 | RawLab_look_portra_400_sRGB_v1 |
| RL·Portra 160 | RawLab_look_portra_160_sRGB_v1 |
| RL·Portra 800 | RawLab_look_portra_800_sRGB_v1 |
| RL·Ektar 100 | RawLab_look_ektar_100_sRGB_v1 |
| RL·Kodachrome 25 | RawLab_look_kodachrome_25_sRGB_v1 |
| RL·Kodachrome 64 | RawLab_look_kodachrome_64_sRGB_v1 |
| RL·Kodachrome 200 | RawLab_look_kodachrome_200_sRGB_v1 |
| RL·T-Max 100 | RawLab_look_tmax_100_sRGB_v1 |
| RL·T-Max 400 | RawLab_look_tmax_400_sRGB_v1 |
| RL·T-Max 3200 | RawLab_look_tmax_3200_sRGB_v1 |
| RL·Tri-X 400 | RawLab_look_trix_400_sRGB_v1 |
| RL·BW 400CN | RawLab_look_bw_400_cn_sRGB_v1 |
| RL·HIE 红外黑白 | RawLab_look_hie_sRGB_v1 |
| RL·E100 GX | RawLab_look_e100_gx_sRGB_v1 |
| RL·Ektachrome 100 VS | RawLab_look_ektachrome_100_vs_sRGB_v1 |
| RL·Elite Chrome 200 | RawLab_look_elite_chrome_200_sRGB_v1 |
| RL·Elite Chrome 400 | RawLab_look_elite_chrome_400_sRGB_v1 |
| RL·Elite Color 200 | RawLab_look_elite_color_200_sRGB_v1 |
| RL·Elite Color 400 | RawLab_look_elite_color_400_sRGB_v1 |
| RL·Elite ExtraColor 100 | RawLab_look_elite_extracolor_100_sRGB_v1 |
| RL·Elite 100 XPro | RawLab_look_elite_100_xpro_sRGB_v1 |
| RL·影院拷贝 2383 | RawLab_look_2383_sRGB_v1 |
| RL·影院拷贝 2393 | RawLab_look_2393_sRGB_v1 |

---

## 3. ⚠️ 关键发现：23+2 个内置 LUT 存储序错误（水晶独有问题）

`.cube` 标准规定数据行 **红通道变化最快（r-fastest）**。本项目渲染链（`parse_cube` 顺序读 → 3D 纹理顺序上传 → WGSL `sample_lut_tetrahedral` 以 coord=(r,g,b) 采样）严格按标准实现，**没有任何轴交换补偿**。

经双向对齐测试证实，以下打包文件的晶格按 **b-fastest（蓝通道最快）** 存储：

- `film_luts/大师·*.cube` ×14（副本）：对齐测试 b-fastest Δ=0.0000 / r-fastest Δ≈0.21
- `film_luts/富士·{PROVIA 标准、ASTIA 柔和、经典正片、经典负片、ETERNA 影院、ETERNA 漂白旁路、ACROS 黑白、Velvia 鲜艳、PRO Neg 标准}` ×9：b-fastest Δ=0.0000 / r-fastest Δ≈0.20–0.38（Δmax 最高 1.0）
- `富士·WDR 宽容度`、`富士·F-Log2 转 Rec.709` ×2：APK 内无 RawLab 对应无法直配，但头注释与 9 款同管线（`# Downsampled to 33 grid (trilinear)`），红通道高光探针同为 ~0.04-0.06（正常应为高值），**高度疑似同病**
- 例外：`富士·EKTAR 100 Phuket 强` 为正常 r-fastest（同一打包流程输出不一致）

**影响**：这 25 个文件在 LUT 面板选中应用时，晶格三轴转置 → 偏色（中性灰轴不受影响，因此不明显；彩色高光/阴影区偏差最高可达满量程）。`master_luts/` 的 14 个大师 LUT（特效面板「大师配方」实际使用的那份）**不受影响**；受影响的是 `film_luts/` 里同名副本与 11 个富士转换。

**建议**：转置重写这 23+2 个文件后随下个版本重新打包；或打包脚本改为按标准序写出并加 r-fastest 自检。

---

## 4. 水晶缺失 / 水晶独有清单

**水晶缺失（RawLab 有、v2.1.25 未收录）**
| RawLab 原件 | 说明 |
|---|---|
| `FLog2_to_REALA-ACE_65grid_V.1.00.cube` | 富士转换第 10 款，唯一漏收 |
| `BundledLooks/HDR/HDR Silver.cube`（6³，2KB） | HDR 预览外观，未收录 |

**水晶独有（RawLab v0.13.0 无）**
| 文件 | 来源 |
|---|---|
| `K-Vision 250D/500T Cinematic`、`K-Gold 200`、`K-Ektar 100`、`K-Portra 400`、`F-Pro 400H`（25³×6） | spektrafilm v0.3.4 第三方包 |
| `富士·WDR 宽容度`、`富士·F-Log2 转 Rec.709` | RawLab APK 未带的富士转换 |
| `master_recipes/master-recipes.json` | 大师配方参数化元数据（contrast/exposure/HSL 等 deltas），供一键配方 |
| `licenses/RawLab-NOTICE.md`、`RawLab-GPL-3.0.txt`、`SPEKTRAFILM_LICENSE.txt` | 许可合规文件 |

---

## 5. 其他差异

1. **网格策略**：RawLab 用 65³ 保精度（单文件 7.2–9.7MB ASCII），水晶全部降到 33³/25³/13³（大师/富士为逐位精确的偶数下抽样，非重算），体积 210.85MB → 49.49MB。偶数抽样在中性色表现与 65³ 三线性插值高度一致，视觉损失可忽略。
2. **头元数据**：RL 系列完整保留 RawLab 溯源头（`#RawLab:{source, sourceSha256, adaptation, redistribution:unconfirmed}`）；富士系列保留 `#FUJIFILM Corporation` 原注释并加 `# Downsampled to 33 grid` 行——注意该注释写的是 trilinear，实际是偶数抽样，描述不准确。
3. **命名**：RL 系列汉化改名（如 `RawLab_look_2383_sRGB_v1` → `RL·影院拷贝 2383`）；大师系列英文名保留。
4. **面板重复**：14 个大师 LUT 同时存在 `master_luts/`（正确序）与 `film_luts/`（异常序）两份，LUT 滤镜面板与大师配方面板会重复出现同名项——建议只保留 `master_luts/` 一份，顺带消除 §3 的副本风险。
5. **许可**：RawLab `Bundled-Looks.md` 记录 28 个第三方 LUT 为 redistribution unconfirmed（仓库所有者授权随 v0.8.0+ 发布）；水晶已随包附 `RawLab-NOTICE.md` + GPL-3.0 文本，合规状态与上游一致。

---

## 6. 结论

- **内容层面**：v2.1.25 的 28 个 RL·LUT（胶片 23 + 相机 5）与 RawLab v0.13.0 **数值逐位一致**；14 个大师 LUT 与 10 个富士转换（含 EKTAR Phuket）为 RawLab 65³ 的**逐位精确降采样**，无损。
- **工程层面**：存在 1 个实际影响渲染的正确性缺陷（25 个文件 b-fastest 存储序）、1 个独有文件疑似同病、1 个上游转换漏收（REALA-ACE）、1 个 HDR 外观未收录，以及大师 LUT 双份冗余。
- **体积层面**：全量降采样策略将 210.85MB 压至 49.49MB（-77%），是 APK 体积优势的主要来源。
