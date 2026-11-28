# anwuRAW v2.1.25（Android 端）vs RawLab v0.13.0 · LUT 文件差异清单

> 对比对象
> - **anwuRAW v2.1.25**（tag `v2.1.25`，commit `9f461cb`，2026-11-27 发布；Android 安装包 `04_RapidRAW_v2.1.25_android_arm64-v8a.apk`，91.4 MB）
> - **RawLab v0.13.0**（tag `v0.13.0`，commit `e82a3c9cf`，build 25，2026-11-25 发布；`RawLab-Android-0.13.0.apk`，155 MB；源码包 + assets-v1 资源包 `rawlab-luts-v1.tar.gz`）
>
> 对比方法：分别下载两个 GitHub tag 的源码包与 RawLab 的 assets-v1 LUT 资源包，对全部 `.cube` 文件做 ①sha256 全量哈希比对 ②表头/网格/Domain 解析 ③数值逐点比对（含 65³→33³ 偶数索引子采样、轴序置换还原）。下文所有"数值一致/精确"结论均来自逐点实测。

---

## 0. 结论先行

| 维度 | anwuRAW v2.1.25 | RawLab v0.13.0 |
| --- | --- | --- |
| LUT 文件总数（APK 实际搭载） | **74 个 .cube**（film_luts 60 + master_luts 14），49.5 MB | **54 个 .cube**（films 39 + MasterRecipes 14 + HDR 1），约 228.7 MB 原始体积（APK 内压缩） |
| 源码仓库是否含 LUT 二进制 | ✅ 直接提交在 `src-tauri/resources/` | ❌ 仅 5 个（HDR Silver + 4 个测试夹具），正式 LUT 走 assets-v1 独立资源包（76.5 MB tar.gz，sha256 校验） |
| 打包/发现方式 | 构建期生成文件名 manifest（[build.rs L292](file:///workspace/src-tauri/build.rs#L292)），Android 首次启动把 APK assets 物化到应用数据目录 | `catalog.json`（随包重命名为 `bundled-looks.json`）驱动，按 look ID 注册编辑态；gradle `prepareExternalLuts` 任务先校验/拉取资源包 |
| RawLab 29 张目录 look 覆盖率 | **29/29 全覆盖且数值精确**（28 张 RL· + 1 张富士·Phuket） | — |
| RawLab 14 张大师配方覆盖率 | 14/14（master_luts 为 RawLab 65³ 表的精确 33³ 偶数索引子采样；`master-recipes.json` 与 RawLab 逐字节同内容） | — |
| RawLab 12 张 F-Log2 胶片模拟 | 11/12（缺 REALA-ACE），但 **11 张存储轴序与 RawLab 相反（B 优先 vs R 优先）** | — |
| 双方独有 | spektrafilm 6 张（V-Log 输入，25³，CC BY-SA 4.0）+ 富士·WDR / F-Log2→Rec.709（RawLab Android 端刻意排除） | HDR Silver（6³、扩展线性域 −16…64）、REALA-ACE、X100VI 官方 4 张 |
| 版内风险点 | ① 11 张富士·轴序与渲染引擎假设（R 优先）相反，疑似转置渲染；② 所有 scene-referred LUT 统一喂 V-Log 曲线，F-Log2 LUT 输入编码错配；③ `大师·` 同名双份（film_luts v1 表 ≠ master_luts v2 表） | 28 张第三方改编 look 的再分发许可状态仍为 **UNCONFIRMED**（`REDISTRIBUTION_BLOCKED.md` 风险记录保留） |

**一句话总结**：anwuRAW v2.1.25 的内置 LUT 库实质上是 **RawLab v0.13.0 目录 look（29）+ 大师配方（14）的"降网格重打包版"**，再叠加 RapidRAW 上游继承的富士模拟（11，轴序异常）与 spektrafilm（6）；双方数值同源但无一文件字节级相同（anwu 全部经过再序列化/降采样）；anwuRAW 相比 RawLab 少了 HDR Silver 与 REALA-ACE，多出 spektrafilm 与 2 张 RawLab Android 不内置的技术型 LUT。

---

## 1. 总量与形态对比

### 1.1 anwuRAW v2.1.25（tag 实测）

| 目录 | .cube 数 | 体积 | 内容构成 |
| --- | --- | --- | --- |
| `src-tauri/resources/film_luts/` | 60 | 36.6 MB | RL· 28 + 富士· 12 + 大师· 14（v1 旧表）+ spektrafilm（K-/F-）6 + `SPEKTRAFILM_LICENSE.txt` |
| `src-tauri/resources/master_luts/` | 14 | 13.0 MB | 大师· 14（v2 新表，RawLab 派生） |
| 合计 | **74** | **49.5 MB** | 全部 33³（富士/大师/RL·相机）、13³（RL·胶片）、25³（spektrafilm） |

### 1.2 RawLab v0.13.0（tag + assets-v1 实测）

| 位置 | .cube 数 | 单文件体积 / 网格 | 说明 |
| --- | --- | --- | --- |
| 源码包 `Shared/BundledLooks/HDR/HDR Silver.cube` | 1 | 6³，扩展线性 sRGB（−16…64） | RawLab 原创 HDR 黑白 look，含配套 `HDR Silver Master.json` 调整配方 |
| 源码包 `lutools/tests/fixtures/` 等 | 4 | 测试夹具 | identity / golden-flog2 / golden-srgb / hdr-look-linear，不随 App 分发 |
| assets-v1 `Shared/BundledLooks/` | **29** | 23×13³（≈132 KB）+ 2×33³（≈1.2 MB）+ 3×65³（8.5–10 MB）+ 1×65³ EKTAR Phuket（9.9 MB） | 即 catalog.json 的 29 张目录 look；包内 29 个文件 sha256 与 catalog.json 记录**全部一致** |
| assets-v1 `RawLabMac/Resources/MasterRecipes/` | **14** | 全部 7,415,113 B（65³） | 与 `Shared/master-recipes.json` 配对 |
| assets-v1 `lutools/flog-2-new/` | **12** | 全部 ≈7.4 MB（65³） | 富士官方 FLog2_to_* 表（`#FUJIFILM Corporation` 头，GFX ETERNA 55 标注，V.1.00） |
| assets-v1 `lutools/F-Log2/` | **4** | ≈970 KB（33³） | X100VI 官方表（ETERNA / ETERNA-BB / FLog2 / WDR），不进 Android APK |
| **Android APK 实际搭载** | **54** | films 39（10 张 flog-2-new 剔除 `*FLog2-709*`、`*WDR*` + 29 张 BundledLooks）+ MasterRecipes 14 + HDR Silver 1 | 见 `RawLabAndroid/app/build.gradle.kts` 的 `prepareAssets`；资源缺失时 `prepareExternalLuts` 直接构建失败 |

### 1.3 分发形态差异

- **anwuRAW**：LUT 二进制直接进 git 仓库并打进 APK；Android 无法枚举 APK assets，故构建期用 [lut_processing.rs L96-137](file:///workspace/src-tauri/src/lut_processing.rs#L96-L137) 生成的 `film_luts_manifest.txt` / `master_luts_manifest.txt` 在首启时逐文件物化到 `dataDir/resources/<dir>`，并对空文件自愈（防写入中断导致解析失败）。
- **RawLab**：LUT 二进制与源码解耦，走 [assets-v1 预发布包](https://github.com/dancancer/RawLab/releases/tag/assets-v1)（76,473,077 B，sha256 `57d43edb…9f336d5`，实测下载后哈希一致）；CI 以 `Shared/assets-manifest.json` 内容哈希做缓存键；APK 内 assets 按 `films/`、`MasterRecipes/`、`BundledLooks/HDR/`、`licenses/Bundled-Looks.md`（即 NOTICE.md）组织。

---

## 2. 逐文件映射差异清单

> 数值关系图例：**＝** 数值逐点完全一致（max abs diff = 0.000000）；「65→33 偶采」指沿 R/G/B 每维取偶数索引（0,2,…,64）的精确子采样；「轴序转置」指同一张表按 R 优先读取得到的是原表的 R/B 轴置换版本。

### 2.1 RL· 28 张 ← RawLab 目录 look（28/29 全覆盖，数值全部精确）

**A 组：G'MIC Kodak 系 23 张（13³，直接重序列化，数值逐点一致）**

| anwuRAW 文件（film_luts，13³，≈130–134 KB） | RawLab 原文件（13³，≈132.7 KB） | 关系 |
| --- | --- | --- |
| RL·BW 400CN.cube | RawLab_look_bw_400_cn_sRGB_v1.cube | ＝ |
| RL·E100 GX.cube | RawLab_look_e100_gx_sRGB_v1.cube | ＝ |
| RL·Ektachrome 100 VS.cube | RawLab_look_ektachrome_100_vs_sRGB_v1.cube | ＝ |
| RL·Ektar 100.cube | RawLab_look_ektar_100_sRGB_v1.cube | ＝ |
| RL·Elite 100 XPro.cube | RawLab_look_elite_100_xpro_sRGB_v1.cube | ＝ |
| RL·Elite Chrome 200.cube | RawLab_look_elite_chrome_200_sRGB_v1.cube | ＝ |
| RL·Elite Chrome 400.cube | RawLab_look_elite_chrome_400_sRGB_v1.cube | ＝ |
| RL·Elite Color 200.cube | RawLab_look_elite_color_200_sRGB_v1.cube | ＝ |
| RL·Elite Color 400.cube | RawLab_look_elite_color_400_sRGB_v1.cube | ＝ |
| RL·Elite ExtraColor 100.cube | RawLab_look_elite_extracolor_100_sRGB_v1.cube | ＝ |
| RL·HIE 红外黑白.cube | RawLab_look_hie_sRGB_v1.cube | ＝ |
| RL·Kodachrome 200.cube | RawLab_look_kodachrome_200_sRGB_v1.cube | ＝ |
| RL·Kodachrome 25.cube | RawLab_look_kodachrome_25_sRGB_v1.cube | ＝ |
| RL·Kodachrome 64.cube | RawLab_look_kodachrome_64_sRGB_v1.cube | ＝ |
| RL·Portra 160.cube | RawLab_look_portra_160_sRGB_v1.cube | ＝ |
| RL·Portra 400.cube | RawLab_look_portra_400_sRGB_v1.cube | ＝ |
| RL·Portra 800.cube | RawLab_look_portra_800_sRGB_v1.cube | ＝ |
| RL·T-Max 100.cube | RawLab_look_tmax_100_sRGB_v1.cube | ＝ |
| RL·T-Max 3200.cube | RawLab_look_tmax_3200_sRGB_v1.cube | ＝ |
| RL·T-Max 400.cube | RawLab_look_tmax_400_sRGB_v1.cube | ＝ |
| RL·Tri-X 400.cube | RawLab_look_trix_400_sRGB_v1.cube | ＝ |
| RL·影院拷贝 2383.cube | RawLab_look_2383_sRGB_v1.cube | ＝ |
| RL·影院拷贝 2393.cube | RawLab_look_2393_sRGB_v1.cube | ＝ |

两侧均声明 `#Gamma:sRGB to sRGB`、`#Gamut:ITU-R BT.709 to ITU-R BT.709`、DOMAIN 0–1。差异仅在头部排版（anwuRAW 合并了 `# LUT size` / `# Data domain` 注释行），保留了 `# Created by: G'MIC (https://gmic.eu)` 与 `TITLE "kodak_*"`。

**B 组：相机系 5 张（anwuRAW 统一压到 33³；其中 3 张 RawLab 原表为 65³）**

| anwuRAW 文件（33³） | RawLab 原文件 | 原网格 / 体积 | 数值关系 |
| --- | --- | --- | --- |
| RL·相机·Contax ND.cube（1,301,349 B） | RawLab_camera_contax_nd_std_sRGB_v1.cube | 65³ / 9,958,966 B | ＝（65→33 偶采） |
| RL·相机·Lumix S1R 鲜艳.cube（1,215,272 B） | RawLab_camera_lumix_s1r_vivid_sRGB_v1.cube | 33³ / 1,215,227 B | ＝（同网格，仅头部改写） |
| RL·相机·Pentax K5 反转片.cube（1,219,658 B） | RawLab_camera_pentax_k5_reversal_sRGB_v1.cube | 33³ / 1,219,613 B | ＝ |
| RL·相机·Ricoh GR2 高对比黑白.cube（1,113,068 B） | RawLab_camera_ricoh_gr2_hibw_sRGB_v1.cube | 65³ / 8,550,575 B | ＝（65→33 偶采） |
| RL·相机·Ricoh GR2 鲜艳.cube（1,194,052 B） | RawLab_camera_ricoh_gr2_vivid_sRGB_v1.cube | 65³ / 9,250,523 B | ＝（65→33 偶采） |

B 组头部统一为 `TITLE "RawLab adapted display look"`。注意：RawLab 侧 v0.8.0 审计文档写"5 张相机表均为 33³"，但 v0.13.0 资源包中 Contax ND / GR2 双张已升级为 65³（RawLab 通过 OCIO 重采样，`adaptation-report.json` 记录 max 误差 ≈0.0025、mean ≈4.8e-5）。

**C 组：EKTAR Phuket（第 29 张目录 look）**

| anwuRAW 文件 | RawLab 原文件 | 数值关系 |
| --- | --- | --- |
| 富士·EKTAR 100 Phuket 强（F-Log2）.cube（1,294,170 B，33³） | EKTAR_100_Phuket_v2_Strong_FLog2_FGamut_65.cube（9,886,892 B，65³，GPL-3.0-only） | ＝（65→33 偶采，R 优先标准序） |

该文件头仍写 `TITLE "EKTAR 100 Phuket v2 Strong - FLog2 FGamut to sRGB"`，但文件名与 RawLab v0.13.0 已把显示名改为 "EKTAR 100 RawLab edition"——anwuRAW 沿用了改名前的旧标题。

### 2.2 大师配方 14 张：同名双表（v1 ≠ v2），v2 与 RawLab 精确同源

| anwuRAW 显示名 | film_luts（v1，970,505 B，"trilinear"） | master_luts（v2，970,616 B） | RawLab MasterRecipes（7,415,113 B，65³） |
| --- | --- | --- | --- |
| 大师·Billy Dinh | 与 RawLab 差异大（mean 0.24 级） | ＝ billy_dinh_cinema.cube（65→33 偶采） | billy_dinh_cinema.cube |
| 大师·CineStill 800T | 同上 | ＝ cinestill_800t.cube | cinestill_800t.cube |
| 大师·Daniel Casson | 同上 | ＝ daniel_casson_autumn.cube | daniel_casson_autumn.cube |
| 大师·Ivan Ivanchenko | 同上 | ＝ ivan_ivanchenko_twilight.cube | ivan_ivanchenko_twilight.cube |
| 大师·Iwona | 同上 | ＝ iwona_fairy_tale.cube | iwona_fairy_tale.cube |
| 大师·Jungraphy | 同上 | ＝ jungraphy_neon.cube | jungraphy_neon.cube |
| 大师·Luiz Clas | 同上 | ＝ luizclas_portrait.cube | luizclas_portrait.cube |
| 大师·Samalive | 同上 | ＝ samalive_vintage.cube | samalive_vintage.cube |
| 大师·Wilson Lee | 同上 | ＝ wilson_lee_golden.cube | wilson_lee_golden.cube |
| 大师·rkrkrk | 同上 | ＝ rkrkrk_cyberpunk.cube | rkrkrk_cyberpunk.cube |
| 大师·withluke | 同上 | ＝ withluke_epic.cube | withluke_epic.cube |
| 大师·保井崇志 | 同上 | ＝ takashi_yasui_zen.cube | takashi_yasui_zen.cube |
| 大师·滨田英明 | 同上（实测 max diff 0.97） | ＝ hamada_daylight_pro_v2.cube | hamada_daylight_pro_v2.cube |
| 大师·酒井贵弘 | 同上 | ＝ takahiro_sakai_blue.cube | takahiro_sakai_blue.cube |

要点：

1. **14/14 张 v2 全部验证为 RawLab MasterRecipes 的精确偶数索引子采样**（实测 max abs diff = 0.000000）；v2 头部自带溯源：`#RawLabAssetKind:referenceStyle`、`# RawLab reference-assisted refinement v2; authored prior + CanonCGT pseudo supervision`、`# Downsampled 65->33 lattice (even-index exact subsample) for RapidRAW bundling`。
2. **film_luts 里的 14 张同名 v1 表与 RawLab 无数值关系**（属 RapidRAW 上游旧表），与 master_luts v2 表同名不同内容。
3. `master_recipes.json`（14 条配方的曝光/HSL/色调编辑参数）与 RawLab `Shared/master-recipes.json` **逐字段完全一致（14/14 无差异）**；[masterRecipes.ts L6](file:///workspace/src/utils/masterRecipes.ts#L6) 注释亦写明 "Master recipe catalog ported from RawLab (GPL-3.0-only)"。
4. **运行时入口分裂**：桌面大师弹窗与移动端"大师"专区走 `list_master_luts`（v2 表）；而移动端胶片 LUT 横滑区由 `list_luts` 返回**未过滤**的全量 film_luts（[CrystalCategoryPanel.tsx L2357](file:///workspace/src/components/mobile/CrystalCategoryPanel.tsx#L2357)），14 张 v1 大师·同样出现 → 同名 look 在移动端出现两份、选不同入口套的是**不同的表**。

### 2.3 富士· 12 张：11 张与 RawLab 同源但轴序相反，1 张独立派生；缺 REALA-ACE

| anwuRAW 文件（33³，≈970.5 KB） | RawLab flog-2-new（65³，≈7.4 MB） | 数值关系 |
| --- | --- | --- |
| 富士·ACROS 黑白（F-Log2）.cube | FLog2_to_ACROS_65grid_V.1.00.cube | ＝（65→33 偶采，**轴序转置**） |
| 富士·ASTIA 柔和（F-Log2）.cube | FLog2_to_ASTIA_65grid_V.1.00.cube | ＝（同上） |
| 富士·ETERNA 影院（F-Log2）.cube | FLog2_to_ETERNA_65grid_V.1.00.cube | ＝（同上） |
| 富士·ETERNA 漂白旁路（F-Log2）.cube | FLog2_to_ETERNA-BB_65grid_V.1.00.cube | ＝（同上） |
| 富士·F-Log2 转 Rec.709（F-Log2）.cube | FLog2_to_FLog2-709_65grid_V.1.00.cube | ＝（同上；**RawLab Android 不内置此张**） |
| 富士·PRO Neg 标准（F-Log2）.cube | FLog2_to_PRO-Neg.Std_65grid_V.1.00.cube | ＝（同上） |
| 富士·PROVIA 标准（F-Log2）.cube | FLog2_to_PROVIA_65grid_V.1.00.cube | ＝（同上） |
| 富士·Velvia 鲜艳（F-Log2）.cube | FLog2_to_Velvia_65grid_V.1.00.cube | ＝（同上） |
| 富士·WDR 宽容度（F-Log2）.cube | FLog2_to_WDR_65grid_V.1.00.cube | ＝（同上；**RawLab Android 不内置此张**） |
| 富士·经典正片（F-Log2）.cube | FLog2_to_CLASSIC-CHROME_65grid_V.1.00.cube | ＝（同上） |
| 富士·经典负片（F-Log2）.cube | FLog2_to_CLASSIC-Neg._65grid_V.1.00.cube | ＝（同上） |
| （无） | **FLog2_to_REALA-ACE_65grid_V.1.00.cube** | **anwuRAW 缺失**（RawLab Android 内置） |

要点：

1. 头部溯源：anwuRAW 侧写 `# Downsampled to 33 grid (trilinear) for size optimization` + `#model:GFX ETERNA 55` + `#Version:1.00`；RawLab 侧多一行 `#FUJIFILM Corporation`。**"trilinear" 注释与实测不符**——实测是精确偶数索引子采样（非插值）。
2. **轴序转置（风险项）**：11 张富士·表按 .cube 标准（R 最快）读取时得到的是 RawLab 原表 **R/B 晶格轴互换**的版本（只有先把原表按 `index = r·65²+g·65+b` 寻址做偶采才能逐点复现，11/11 max diff = 0）。而渲染端 [shader.wgsl](file:///workspace/src-tauri/src/shaders/shader.wgsl) 以 `texture(x=r, y=g, z=b)` 标准序采样、[gpu_processing.rs L2557-2581](file:///workspace/src-tauri/src/gpu_processing.rs#L2557-L2581) 顺序上传 Rgba32Float 3D 纹理，**无任何轴序补偿**；同一批里 RL·、大师·、富士·Phuket 又全是标准 R 优先。对角线（灰阶）转置不变、饱和彩色 R↔B 互换——建议实机渲染高饱和色卡验证这 11 张是否处于转置态。RawLab 侧（R 优先）与其官方 X100VI 表（同样 R 优先）一致。
3. **X100VI 官方 4 张**（`X100VI_FLog2_FGamut_to_*_33grid`，ETERNA/ETERNA-BB/FLog2/WDR）不进 anwuRAW；它们与 flog-2-new 是富士不同批次官方表（实测同模拟 mean diff ≈0.051），RawLab 也未把它们打进 Android APK（仅随资源包分发）。
4. RawLab Android 的 films 目录**刻意排除** `FLog2-709` 与 `WDR`（技术型转换而非创作 look，见 build.gradle.kts `exclude`），anwuRAW 则把 `富士·F-Log2 转 Rec.709`、`富士·WDR 宽容度` 当普通胶片 LUT 一并放进胶片列表。

### 2.4 spektrafilm 6 张（anwuRAW 独有）

| anwuRAW 文件 | 网格 / 输入 | 溯源 |
| --- | --- | --- |
| F-Pro 400H.cube | 25³ / Panasonic V-Log → sRGB | spektrafilm v0.3.4（andreavolpato/spektrafilm），CC BY-SA 4.0 |
| K-Ektar 100.cube | 25³ / V-Log → sRGB | 同上（ektar100_ultraendura） |
| K-Gold 200.cube | 25³ / V-Log → sRGB | 同上（gold200_supraendura） |
| K-Portra 400.cube | 25³ / V-Log → sRGB | 同上（portra400_portraendura） |
| K-Vision 250D Cinematic.cube | 25³ / V-Log → sRGB | 同上（vision3250d_2383） |
| K-Vision 500T Cinematic.cube | 25³ / V-Log → sRGB | 同上（vision3500t_2383） |

RawLab v0.13.0 不含任何 spektrafilm 资产。anwuRAW 在 film_luts 内附了 `SPEKTRAFILM_LICENSE.txt`（作者明确以 CC BY-SA 4.0 授权 LUT 形式的衍生品）——**这是本库中唯一"再分发许可已确认"的外部来源**。这 6 张声明 V-Log 输入，与渲染引擎的 `linear_to_vlog` 场景路径天然匹配。

### 2.5 RawLab 独有（anwuRAW 缺失）

| RawLab 资产 | 形态 | 说明 |
| --- | --- | --- |
| HDR Silver.cube + HDR Silver Master.json | 6³，输入域 −16…64 扩展线性 sRGB，参考白 =1；线性混合权重 R 5/16、G 10/16、B 1/16 | RawLab 原创 HDR 黑白 look，与 HDR 管线（增益图导出）配套；anwuRAW 无任何 HDR look LUT |
| FLog2_to_REALA-ACE_65grid | 65³ | 富士第 12 张官方模拟，anwuRAW 未收录 |
| X100VI_FLog2_FGamut_to_{ETERNA,ETERNA-BB,FLog2,WDR}_33grid | 33³ | X100VI 相机固件版官方表 |
| identity.cube / golden-*-look / hdr-look-linear | 测试夹具 | lutools 校验用，不分发 |

### 2.6 覆盖率汇总

| RawLab v0.13.0 资产族 | 张数 | anwuRAW v2.1.25 覆盖 | 数值关系 |
| --- | --- | --- | --- |
| BundledLooks 目录 look | 29 | 29/29（28 RL· + 富士·Phuket） | 全部精确（重序列化 / 65→33 偶采） |
| MasterRecipes | 14 | 14/14（master_luts v2） | 全部精确（65→33 偶采） |
| flog-2-new 富士官方 | 12 | 11/12（缺 REALA-ACE） | 精确但轴序转置 |
| X100VI 官方 | 4 | 0/4 | — |
| HDR Silver | 1 | 0/1 | — |
| **anwuRAW 独有** | spektrafilm 6；大师·v1 14（同名旧表）；富士·WDR/709 两张技术表 RawLab Android 未内置 | | |

---

## 3. 运行时与管线差异（文件之外的关键差异）

1. **显示/场景引用的判定**：anwuRAW 以头部注释 `#Gamma:sRGB to sRGB` 探测（[lut_processing.rs L50-78](file:///workspace/src-tauri/src/lut_processing.rs#L50-L78)）——RL· 28 张、大师 28 张（v1+v2）、富士·Phuket 之外的场景 LUT 走 tone mapping 之后；其余默认 scene-referred 走 `linear → linear_to_vlog → LUT`（[shader.wgsl L2149-2155](file:///workspace/src-tauri/src/shaders/shader.wgsl#L2149-L2155)）。**该 V-Log 编码是写死的**：富士· 11 张 F-Log2 表（含 Phuket）会被喂入 V-Log 曲线而非 F-Log2，输入编码错配（F-Log2 与 V-Log 曲线不同），这是比轴序更确定的错配项。RawLab 侧按 catalog 声明的 color contract 逐 look 处理，且 Sony→Fuji 流水线有 golden 夹具回归。
2. **采样方式**：anwuRAW GPU 用四面体插值（tetrahedral）、Rgba32Float 3D 纹理、Nearest 采样器 + 手动四面体权重、`mix(base, lutColor, intensity)` 强度混合；RawLab CPU 走 OCIO 语义、GLES 走自有 LUT 通路并有 `gles-lut` 设备回归脚本。
3. **元数据载体**：anwuRAW 的 look 无目录/清单文件，全靠文件名（含 `RL·`、`大师·`、`富士·` 前缀）与 manifest；RawLab 以 catalog.json 承载 id/artwork/license/source/sha256/色彩契约，Android 端按 ID 注册编辑态、批量任务冻结 LUT 副本。
4. **体积/加载**：anwuRAW 74 张全部随 APK 内置（arm64 APK 91.4 MB）；RawLab APK 155 MB（约 228.7 MB 原始表压缩后），另有 76.5 MB 独立资源包供源码构建。anwuRAW 的 33³/13³ 降网格使 74 张只占 49.5 MB，是 APK 体积优势的主要来源；代价是网格精度（13³ 的 23 张 G'MIC 系是 RawLab 原生 13³，无精度损失；65³→33³ 的 19 张损失了半档晶格密度）。

---

## 4. 许可与合规差异

| 项 | RawLab v0.13.0 | anwuRAW v2.1.25 |
| --- | --- | --- |
| 28 张第三方改编 look（G'MIC 23 + 相机 5） | catalog license 字段逐张标 `UNCONFIRMED - redistribution permission not verified`；`NOTICE.md` + `REDISTRIBUTION_BLOCKED.md` 永久风险记录随 APK 分发（`licenses/Bundled-Looks.md`）；来源：YahiaAngelo/Film-Luts 快照 `af957b6…`（G'MIC/ Pat David / Juan Melara 署名链）、u/Aggressive-Win-6351 相机分享（部分署名 ROGER WANG） | 同批内容改名 `RL·*` 内置；`resources/licenses/RawLab-NOTICE.md` + `RawLab-GPL-3.0.txt` 已随包携带（GPL 项目层面的署名已做），但 **上游 UNCONFIRMED 状态并不会因二次分发而消除**——原始作者授权缺口相同 |
| EKTAR 100 Phuket | GPL-3.0-only（项目自有） | 同源同许可（RawLab-GPL-3.0.txt 覆盖） |
| 富士官方 F-Log2 表 | 无再分发声明（`#FUJIFILM Corporation` 头保留）；v0.13.0 docs 仅声明"保留原契约" | 同样无富士授权记录 |
| spektrafilm | 不含 | CC BY-SA 4.0，授权文件随包（合规最完整的一族） |
| 大师配方 14 张 | `Shared/master-recipes.json` + MasterRecipes 随主项目许可 | 明示 "ported from RawLab (GPL-3.0-only)" 并带许可证文本 |
| AI 生成封面 | `Artwork/generated-*.json` 记录 prompt 溯源 | 未随包（anwuRAW 用自有缩略图生成） |

---

## 5. v2.1.24 → v2.1.25 的 LUT 库变化（对照 [v2.1.24 对比文档](file:///workspace/anwuRAW-v2.1.24-Android端与RawLab-v0.13.0-Android端·功能图像渲染算法差异化对比与借鉴方案.md)）

- v2.1.24：**26 胶片 LUT + 14 大师配方**（≈ 富士· 12 + 大师· 14，大师仍在 film_luts 单目录）。
- v2.1.25：**60 胶片 + 14 大师 = 74**。净增：
  - **+28 张 RL·**（对应 RawLab v0.13.0 全部 28 张改编 look，即本清单 §2.1）；
  - **+6 张 spektrafilm**（§2.4）；
  - **master_luts 独立目录 + 14 张 v2 重制表**（§2.2，v1 旧表仍留在 film_luts 未清理）；
  - 新增 [lut_processing.rs](file:///workspace/src-tauri/src/lut_processing.rs) 的 `list_master_luts` 命令与移动端大师专区自检修复逻辑。
- 注：远端 tag 仅存 `v2.1.15` / `v2.1.25`，v2.1.24 快照不可直接比对；以上以 v2.1.24 文档记载 + 两版资源目录结构推断。

---

## 6. 建议清单

**P0（正确性验证）**
1. **富士· 11 张轴序验证**：实机对高饱和色卡（纯 R/G/B）应用 `富士·PROVIA 标准` 等，对比 RawLab Android 同名 look 输出；若确认转置，构建期对这 11 张做一次 `index 交换` 重写（或统一改为 R 优先重导出），并顺手把头部 "trilinear" 注释改为 "even-index subsample"。
2. **F-Log2 输入编码修正**：`lut_is_scene_referred` 目前只有 V-Log 一种场景编码；至少为 F-Log/F-Log2 表增加按头部 `#Gamma:F-Log2 to *` 选择对应 cttf（可参照 RawLab `lutools/docs/color-contract.md`），否则 12 张富士·的中间调映射整体偏移。

**P1（补齐与对齐）**
3. 收录 `FLog2_to_REALA-ACE_65grid`（65→33 偶采即可，与现有 11 张同规格）。
4. 清理 film_luts 中 14 张 大师· v1 旧表（或从 `list_luts` 过滤 `大师·` 前缀），消除移动端同名双表；桌面/移动统一走 master_luts v2。
5. 评估 HDR Silver 派生（6³ 扩展线性 + Master.json 配方）作为 anwuRAW UltraHDR 导出链路的内置 HDR look 起点——v2.1.25 已有 UltraHDR 导出，缺的正是这样一个 demo look。

**P2（工程）**
6. 引入 catalog 式清单（id/sha256/license/input/output 每张一条），Android 物化后按 sha256 校验完整性；RL· 族沿用 RawLab 的 `UNCONFIRMED` 标注与 NOTICE，避免上游风险记录丢失。
7. 头部注释统一：anwuRAW 侧 `TITLE` 仍写 "EKTAR 100 Phuket v2 Strong"，RawLab 已更名 "EKTAR 100 RawLab edition"，建议同步显示名与 catalog 溯源字段。

---

## 附：校验数据索引

- RawLab assets-v1 包 sha256：`57d43edb6cc08febf8930b1c63d2ac0e21ec7b7c04939c3d036d1126b44d5299`（与 `Shared/assets-manifest.json` 一致）；包内 29 张 BundledLooks sha256 与 `catalog.json` 全部一致。
- 数值比对样本：RL·Portra 400（13³ 直接，max=0）；Contax ND / GR2 双张 / Phuket / 14 张大师（65→33 偶采，max=0）；富士· 11 张（转置+偶采，max=0）；大师·滨田英明 v1 vs RawLab（mean 0.240 / max 0.971，确认非同源）。
- 体积：anwuRAW 74 张 49.5 MB（film_luts 36.6 + master_luts 13.0）；RawLab 包 59 张 228.7 MB；APK：anwu arm64 91.4 MB vs RawLab 155 MB。
- 关键源码：[lut_processing.rs](file:///workspace/src-tauri/src/lut_processing.rs)（探测/物化/列表）、[gpu_processing.rs](file:///workspace/src-tauri/src/gpu_processing.rs#L2545-L2590)（3D 纹理上传）、[shader.wgsl](file:///workspace/src-tauri/src/shaders/shader.wgsl#L1674-L2155)（四面体采样与 scene/display 分路）、[masterRecipes.ts](file:///workspace/src/utils/masterRecipes.ts)（配方→调整量、RawLab 溯源注释）、[CrystalCategoryPanel.tsx](file:///workspace/src/components/mobile/CrystalCategoryPanel.tsx#L2099-L2145)（移动端双列表）、[MasterRecipesModal.tsx](file:///workspace/src/components/modals/MasterRecipesModal.tsx#L101)（桌面 list_master_luts）。
