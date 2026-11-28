# anwuRAW v2.1.25（Android 端）vs RawLab v0.13.0 · 胶片 Look 与大师配方差异点

> 承接 [LUT 文件差异清单](file:///workspace/anwuRAW-v2.1.25-Android端与RawLab-v0.13.0-Android端·LUT文件差异清单.md)（文件层），本文聚焦**功能层**：胶片 look 选择/应用/导入/持久化，以及大师配方的应用模型、强度语义与移动端行为。证据来自双方 release tag 源码（anwuRAW `v2.1.25` = commit `9f461cb`；RawLab `v0.13.0` = commit `e82a3c9cf`）。

---

## 0. 结论先行

| 维度 | anwuRAW v2.1.25 Android | RawLab v0.13.0 Android | 差距判定 |
| --- | --- | --- | --- |
| Look 目录驱动 | 无 catalog，靠文件名前缀（RL·/大师·/富士·）+ 构建期 manifest | `bundled-looks.json`（catalog.json 随包改名），每张带 id/artworkName/色彩契约/许可/sha256 | RawLab 明显更工程化 |
| 胶片分组与检索 | 平铺字母序横滑条，无分组/搜索/最近使用 | FUJI / KODAK / OTHER 三组分隔 + ALL/FUJI/KODAK/OTHER 类别筛选 + 搜索框 + 最近使用（record/prune） | RawLab 明显更全 |
| 强度模型 | `lutIntensity` 0–200% 只混合 LUT；桌面配方强度同时缩放调整 patch；**移动端配方区只套 LUT 不套参数** | 单一 `strength` 0–200% 同时驱动 LUT 混合、全部配方调整量、WB tint、v4 细化字段（按 settingsVersion 门控） | 语义基本同构，但 **anwuRAW 移动端大师配方缺参数部分** |
| 渲染契约 | 头注释 sniff（`#Gamma:sRGB to sRGB`）二分显示/场景；场景一律 `linear→V-Log` | LUT 解析器枚举 `flog/flog2/flog2c` transfer + 6 种色彩空间 + display/scene 契约 + F-Gamut→sRGB 矩阵 + `ContractLUTEvaluator` | RawLab 正确且可扩展；anwuRAW 有 F-Log2 错配 |
| Look 导入 | CUBE/3DL/HALD(PNG/JPG/TIFF)，重名加 "(n)"，`remove_lut` 仅限用户目录 | CUBE(v0)/VLT(v1)/RLOOK(v1–2) + **DCP→RLOOK 编译**；UUID 托管库、原子事务、registry 版本化、坏条目隔离、中断恢复、跨进程文件锁、重命名/删除 | RawLab 明显更全 |
| 导入兼容协商 | 无（只做解析校验） | `LUTCompatibilityDialog`：输入/输出空间选择（srgb/rec709-g24/vlog-vgamut/slog3×2/linear）、display↔scene 校验、候选合同+假设说明、极值确认、参考图 mean/max 误差预览 | anwuRAW 无对应物 |
| 大师配方参数 | v4 全量支持（tone/atmosphere/grading/curve，含曲线位移缩放），桌面弹窗完整应用 | `applyRecipe` 一等编辑态（recipeID + strength + settingsVersion 2–4 兼容），WB 联动语义（uncalibrated_fallback=error） | 参数集等价，**编辑态模型不同** |
| 配方 LUT 表 | master_luts v2（= RawLab 65³ 精确子采样）+ film_luts 遗留 v1 双份 | MasterRecipes/ 65³ 原表，assets 物化到文件系统 | 表同源；anwu 有双份隐患 |
| 配方 i18n | 目录内嵌中文名/副标题/摘要，其他语言显示中文 | 名称/副标题走资源表（3 个汉字名 + 14 条副标题本地化），按语言切换 | RawLab 更完整 |
| HDR look | 无 | HDR Silver（6³ 扩展线性 −16…64）+ Master.json 配方 + HDR look 独立 strength | anwuRAW 空白 |

---

## 一、功能定位与信息架构

### 1.1 RawLab：胶片与配方是同一编辑器的两个并列工具

- `EditSettings`（`RawLabAndroid/.../settings/EditSettings.kt`）中 look 状态是编辑态一等字段：`film: String`（默认 neutral）、`strength: Float`（默认 1，0–2 钳制）、`recipeID: String?`、`masterRecipeSettingsVersion: Int (2..4)`。
- 编辑器工具面板里 **tool 0 = 胶片（look browser）、tool 15 = MasterRecipePicker**（`editor/ui/AdjustmentDock.kt` L466-469）：选配方走 `edits.applyRecipe(recipe)`；取消配方等价于 `selectFilm("neutral")`。**胶片与配方互斥且共享同一个强度滑杆**（tool 0/15 下方，`film != "neutral" || recipeID != null` 时可用）。
- 切换语义（`MasterRecipe.kt` L67-74）：选配方 → `film` 强制回 "neutral"，配方参数整体接管；从配方切回胶片 → 配方参数**物化为独立调整值**后再设置 film（`EditSettings.kt` L132-136），不会残留半套状态。

### 1.2 anwuRAW：三个入口、两套状态

- 桌面：`MasterRecipesModal`（`list_master_luts`）→ `activeRecipeId` + `intensity`，应用时先 `snapshotAdjustments()` 快照，取消时整体恢复；LUT 与参数 patch 同时写入。
- 移动端：`CrystalCategoryPanel` 胶片横滑条（`list_luts`，60 张全量含 大师· v1 遗留）+ 大师专区（`list_master_luts`，14 张 v2）；**两条区都只走 `handleLutSelect(path, isSceneReferred)` + `lutIntensity`，面板从未 import `recipeToAdjustments`**（grep 无引用）——即移动端"大师配方"实际上只是大师 LUT，曝光/HSL/色调曲线/分级轮全部不生效。
- 胶片 LUT 与大师配方是两个独立状态（`lutPath/lutIntensity/lutIsSceneReferred` vs `activeRecipeId`），可叠加也可各自清除，与 RawLab 的互斥模型不同。

---

## 二、胶片 Look 差异点

### 2.1 Look 清单与身份

| 项 | anwuRAW | RawLab |
| --- | --- | --- |
| 数据源 | 构建期把 `film_luts/`、`master_luts/` 文件名写成 manifest txt（`build.rs` L292-296），运行时目录枚举 + `include_str!` manifest | `catalog.json` → APK assets `bundled-looks.json`，`BundledLooks.load()` 逐条取 id/name/fileName/artworkName，启动时**断言 id 与 fileName 唯一且与内置 Film.all 不冲突**（`BundledLooks.kt` L14-16） |
| 身份 | `.cube` 绝对路径即身份（`lutPath` 存进 adjustments） | 内置按 **id**（"RawLab_look_portra_400_sRGB_v1" 等）进编辑态；Mac/Win 用 `builtin:<fileName>`；批量导出冻结 LUT 副本 |
| 分组 | 无（按名称小写排序平铺） | `FilmGrouping.kt`：FUJI（Film.all 有文件的 10 张）/ KODAK（`RawLab_look_*` + EKTAR Phuket）/ OTHER（托管导入），条带加分隔；`LookBrowserCategory.ALL/FUJI/KODAK/OTHER` 类别筛选 + 搜索（`normalizedLookName` NFD 归一）+ 最近使用 `recentLookIds`（record/prune） |
| 封面 | 运行时 CPU 渲染 swatch（`generate_lut_previews` / `render_lut_swatch`，lut_processing.rs L760+） | 内置 AI 生成概念图 PNG（`Artwork/*.png`，prompt 溯源在 `generated-*.json`）+ 托管导入用 `LUTCompatibilityPreview` 双图对比 |

### 2.2 强度与应用语义

- **anwuRAW**：`lutIntensity`（0–200，默认 100）→ shader `mix(final_rgb, lut_color, intensity)`（[shader.wgsl L2197-2200](file:///workspace/src-tauri/src/shaders/shader.wgsl#L2197-L2200)）；场景 LUT 先 `linear_to_vlog` 再采样（L2151-2154）。桌面配方强度=同一数值同时写 `lutIntensity` 和参数 patch（`MasterRecipesModal.tsx` L247-261：`...(prev.lutPath ? { lutIntensity: value } : {})`）。
- **RawLab**：`strength` 一个值三层缩放（`CanonicalEditRecipe.kt` L141-186）：
  1. LUT 混合：`look.strength = strength.coerceIn(0, 2)`；
  2. 调整量：`exposure*scale`、`contrast = 1+(c-1)*scale`、`saturation`、`highlights/shadows*scale`、HSL `scaled(recipeScale)`；
  3. WB 联动：`tint*strength` 折入白平衡（RAW + recipeID 时 `master_recipe.tint`，`uncalibrated_fallback: "error"`——未标定 fallback 直接报错而不是静默猜）。
  - v4 细化字段（black/white point、vibrance、clarity、dehaze）按 `masterRecipeSettingsVersion >= 4` 才参与缩放（`EditSettings.kt` L119-120），旧记录保持旧语义。
- 结论：**桌面端两侧强度语义基本同构（0–2 全量缩放）；差异在 anwuRAW 移动端没有参数层**，以及 RawLab 的 WB 联动与版本门控更严谨。

### 2.3 渲染契约（正确性核心差异）

| 项 | anwuRAW | RawLab |
| --- | --- | --- |
| 输入 transfer 识别 | 逐行扫头 12 行找 `#Gamma:sRGB to sRGB`（[lut_processing.rs L50-78](file:///workspace/src-tauri/src/lut_processing.rs#L50-L78)），命中→display；否则→scene | `lut_parser.cpp` L175-177：`flog/flog2/flog2c` 解析成 `LUTTransfer` 枚举；`photo_lut.h` L14-23 采样前 `encodePhotoLog(linear, FLog2)` 并做 `FujiFilm_FGamut → sRGB` 色彩矩阵转换 |
| F-Log2 LUT（富士· 12 张 + Phuket） | **喂 V-Log 编码**（`linear_to_vlog`，系数 0.241514/0.598206 为 Panasonic V-Log 公式）→ 中间调映射系统性偏移 | 按 F-Log2 cttf 正确编码输入，F-Gamut 正确转换 |
| 输出契约校验 | 无 | `lut_parser.cpp` L206：sRGB/Rec709-g24 输出必须 display-reference，否则拒收 |
| GPU/CPU | wgpu 四面体采样 + Rgba32Float 3D 纹理；v2.1.25 新增启动探测不兼容回退 CPU | CPU（OCIO 语义）/ GLES 双后端，Auto 失败回退 CPU、Force 必须真 GPU；`gles-lut.sh` 设备回归 |

### 2.4 导入与托管库

| 项 | anwuRAW（lut_processing.rs） | RawLab（LookLibrary.kt） |
| --- | --- | --- |
| 格式 | cube / 3dl / png / jpg / jpeg / tiff（HALD） | CUBE(version 0) / VLT(v1) / RLOOK(v1–2)；**DCP 直接编译成 RLOOK**（源 ≤128 MB、产物 ≤64 MB，`DcpCompiler` + `RLOOKDCP` magic 探测） |
| 校验 | 解析失败跳过（`parse_lut_file`：triplet 完整性、size 匹配） | `NativeProcessor.validateLook` 原生校验 + 扩展名↔实际格式一致性 + 版本白名单 + `colorState 7/8` 色彩契约拒收（`LUTColorContractException`） |
| 兼容协商 | 无 | `LUTCompatibility` 合同对象：6 种输入/输出空间、display↔scene 交叉校验（scene→display 拒绝）、`base_rendering`（rawlab-neutral-v1 / source-display）、极值二次确认、多候选合同（含 basis/assumptions 说明）、参考图逐像素对比（mean/max ×255 + 边界百分比，`LUTCompatibilityDialog.kt` L194-195） |
| 托管模型 | 用户 LUT 平铺在 `dataDir/luts/`，Android 另有 cache 目录；重名加 " (n)" 后缀 | UUID 命名 + `registry.properties`（版本 1）+ `.import-<uuid>.pending` 事务标记 + stage 文件 + `replaceFileAtomically`；跨进程 `.lock` 文件锁；**中断导入恢复**（`recoverInterruptedImports`）；**坏条目隔离**（P2-16：条目级损坏只降级该条、原文 key 保留可删，文件级损坏整库报错） |
| 管理 | `remove_lut`（内置目录与越界路径拒绝，Android 限制 luts/cache 目录）；无重命名 | `rename`（拒空名/控制字符）、`remove`（失败回滚注册表）、校验缓存（size+mtime 戳避免重复校验） |
| 物化 | Android 首启把 APK assets LUT 复制到 dataDir（空文件自愈，防写入中断） | 同样物化：`PhotoStorage.kt` L385-404 films/ 与 MasterRecipes/ 按需复制，供 native 按 path 读取 |
| 外观忠实度声明 | 无 | `appearanceUnverified` 标记（colorState 4/7/8），UI 可提示"可导入≠已验证原厂忠实度" |

### 2.5 批量与文档

- RawLab：批量任务**冻结 LUT 副本**（catalog 文档明示），编辑 JSON `look: {path, strength, sha256}` 带 sha256 身份（`CanonicalEditRecipe.kt` L333-337）；schema_version 18（free endpoint X）/17/7/5 分档，旧版本按版本号拒绝而不是误读。
- anwuRAW：sidecar 存 `lutPath`（绝对路径）+ `lutIntensity` + `lutIsSceneReferred`；v2.1.25 新增 sidecar schema_version 兼容保护 + stamp 缓存（release notes P2 项），但 look 无 id/sha256 身份，文件移动/重装后依赖路径不变。

---

## 三、大师配方差异点

### 3.1 目录与 LUT 表（两侧同源）

- 14 条配方 `id/name/lutFileName/参数` 与 RawLab `Shared/master-recipes.json` **逐字段一致**；全部 `settingsVersion: 4`，均带 `tone(blackPoint/whitePoint/vibrance) + atmosphere(clarity/dehaze) + grading(shadows/midtones/highlights 三轮) + curve`（滨田英明 curve 6 点）。
- LUT：anwuRAW master_luts v2 14 张 = RawLab `MasterRecipes/*.cube`（65³）的精确 33³ 偶数索引子采样（实测 max diff = 0，见 LUT 文件清单 §2.2）；头部自带 `#RawLabAssetKind:referenceStyle` 溯源。
- **遗留问题**：anwuRAW `film_luts/` 里还有 14 张同名 大师· v1 旧表（与 RawLab 无数值关系，实测与 hamada 65³ mean diff 0.24 / max 0.97），移动端胶片条未过滤 → 同名双份、入口不同效果不同。

### 3.2 应用模型

| 项 | anwuRAW | RawLab |
| --- | --- | --- |
| 参数覆盖 | `recipeToAdjustments(recipe, intensity)` 只产出配方拥有的控件（exposure/shadows/highlights/contrast/saturation/tint/HSL + v4 的 blacks/whites/vibrance/clarity/dehaze/pointCurves/colorGrading），**未拥有的滑杆保留原值**；应用前快照、取消时恢复 | `applyRecipe` 整体接管曝光/影调/饱和/tint/HSL（+v4 全量），`film` 强制回 neutral；配方↔胶片切换时把配方**物化为独立值**再转换，无双状态叠加 |
| 强度缩放 | patch 各字段 ×(strength/100)；曲线做位移缩放 `y' = x + s·(y−x)`（[masterRecipes.ts L159-169](file:///workspace/src/utils/masterRecipes.ts#L159-L169)）；`lutIntensity` 同值 | 同一 `strength` 缩放 LUT 混合 + 全部调整 + `tint*strength`→WB；曲线同语义；v4 字段按 `masterRecipeSettingsVersion` 门控（旧文档不缩放） |
| WB 语义 | tint 直接进 adjustments（`/TINT_RELATIVE_SCALE`），无 RAW as-shot 联动 | RAW + recipeID：`master_recipe{active, strength, custom_wb, temperature_kelvin, tint, uncalibrated_fallback:"error"}`——as-shot 温度 + tint×strength 重解析 WB（`EditSettings.kt` L313-318），未标定 fallback 显式报错 |
| LUT 解析 | 前端按 `大师·<本地化名>` 查找（`resolveMasterLutEntry`：先精确后模糊 name 包含），`load_and_parse_lut` 预验证后才写入渲染状态（防损坏 LUT 黑屏） | `PhotoStorage.lookPath`：recipeID → assets `MasterRecipes/<lutFileName>` 按需物化，文件名就是契约（无模糊匹配） |
| 移动端 | **只套 LUT + 强度**（CrystalCategoryPanel 大师专区，无 recipeToAdjustments） | 与桌面同一套 `applyRecipe`（Compose 单一代码路径），移动端=桌面 |
| 悬停/预览 | 桌面 hover preview（previewOverride 不落库）；移动端缩略图走 `generate_lut_previews` 合并生成 | 无 hover 概念；look browser 内即选即用 |
| 工具联动 | `enableRecipeTools()` 激活配方相关工具组 | 强度滑杆仅在 `film != "neutral" || recipeID != null` 可用；配方参数本身就在工具面板里直接可调 |

### 3.3 i18n 与命名

- RawLab：配方名/副标题按 id 查资源表（`MasterRecipe.kt` L81-104：3 个汉字名 + 14 条副标题本地化），六语言切换；表外名字原样显示拉丁名。
- anwuRAW：`master-recipes.json` 内嵌中文 `name/subtitle/summary`，非中文语言也显示中文；LUT 文件名同样中文（`大师·滨田英明.cube`），靠 `masterLutBaseName` 拼接匹配——**改名/换语言会导致 LUT 解析失败**（前端已用模糊匹配兜底，但根因是身份绑定在本地化字符串上）。

---

## 四、富士模拟的定位差异

- **RawLab**：10 张富士模拟是 `Film.all` 内置胶片（neutral + PROVIA/Velvia/ASTIA/CLASSIC CHROME/CLASSIC Neg./REALA ACE/PRO Neg. Std/ETERNA/ETERNA BB/ACROS），进 FUJI 分组；与 Sony→Fuji 流水线（sony2fuji，`lutools/include/sony2fuji`）同源一套契约——F-Log2 输入编码 + F-Gamut→sRGB 矩阵都在 core 层正确处理；Android 端还支持**导入**富士 F-Log/F-Log2/F-Log2C CUBE（声明匹配输入色域 + BT.709 输出即可）。REALA ACE 内置；FLog2-709/WDR 作为技术转换**不进**胶片栏。
- **anwuRAW**：12 张富士· 是普通胶片 LUT（与 RL· 平权混排），其中 F-Log2→Rec.709、WDR 也当创作 look 露出；REALA ACE 缺失；渲染端 F-Log2 编码错配（V-Log）+ 11 张轴序转置风险（见 LUT 文件清单 §2.3 与本文 §2.3）。

---

## 五、借鉴清单（按优先级）

**P0（正确性/功能缺口）**
1. **移动端大师配方补参数**：CrystalCategoryPanel 大师专区选中时调用 `recipeToAdjustments(recipe, intensity)`（桌面逻辑已在 [masterRecipes.ts](file:///workspace/src/utils/masterRecipes.ts#L120-L187) 现成），强度滑杆同时驱动 patch 与 `lutIntensity`——当前移动端只有 LUT 一半。
2. **F-Log2 输入编码**：为 scene-referred LUT 增加按 `#Gamma:` 头选择 cttf（V-Log/F-Log/F-Log2/F-Log2C），参考 RawLab `photo_lut.h` 的 `encodePhotoLog` + F-Gamut→sRGB 矩阵；顺带处理 11 张富士· 的轴序（先实机色卡验证）。
3. **清理 大师· v1/v2 双表**：film_luts 删除 v1 或 `list_luts` 过滤 `大师·` 前缀，统一走 master_luts v2。

**P1（体验对齐）**
4. **Look 目录与检索**：内置 look 建 id-based catalog（id/name/artwork/contract/license/sha256），胶片条按 FUJI/KODAK/OTHER 分组 + 类别筛选 + 搜索 + 最近使用（RawLab `FilmGrouping`/`browseLooks` 模式）。
5. **配方编辑态模型**：评估把 `activeRecipeId + 强度` 提升为编辑态一等字段（替代"快照+patch"），获得 RawLab 的"配方↔胶片互斥、物化转换、WB 联动（tint×strength 折入 as-shot）"语义；至少先补 RAW 场景的 tint×strength WB 联动。
6. **配方 i18n**：名称/副标题改资源表（id→本地化），LUT 解析身份与显示名解耦（用 lutFileName 或 id 直查，去掉"本地化名拼文件名"的模糊匹配）。

**P2（工程）**
7. **托管导入库**：UUID + 注册表 + 原子事务 + 坏条目隔离 + 重命名；`remove_lut` 已有目录防护，补 rename 即可低成本对齐。
8. **导入兼容协商**：至少做"声明输入空间（sRGB/Rec709-g24/V-Log/S-Log3/线性）+ display/scene 校验 + 极值确认"三件套；DCP→RLOOK 可暂缓。
9. **HDR look 起步**：以 RawLab HDR Silver（6³ 扩展线性 + Master.json 调整配方）为样例，为 v2.1.25 已有的 UltraHDR 导出链配一个内置 HDR look。

---

## 附：关键证据索引

**anwuRAW（workspace @ HEAD，与 tag v2.1.25 对应文件一致）**
- [lut_processing.rs](file:///workspace/src-tauri/src/lut_processing.rs) L50-78 transfer 嗅探 / L96-137 Android 物化 / L622-654 list_luts / L706-755 import+remove / L860+ load_and_parse
- [shader.wgsl](file:///workspace/src-tauri/src/shaders/shader.wgsl) L312 linear_to_vlog / L1674 四面体采样 / L2149-2200 scene/display 分路与强度混合
- [masterRecipes.ts](file:///workspace/src/utils/masterRecipes.ts) 目录接口 + recipeToAdjustments（v4 全量、曲线位移缩放、强度 0–200）
- [MasterRecipesModal.tsx](file:///workspace/src/components/modals/MasterRecipesModal.tsx) L101 list_master_luts / L210-219 应用 / L247-261 强度
- [CrystalCategoryPanel.tsx](file:///workspace/src/components/mobile/CrystalCategoryPanel.tsx) L2099-2145 双列表 / L2357 胶片条（未过滤大师· v1）

**RawLab v0.13.0（仓库相对路径）**
- `RawLabAndroid/app/src/main/java/com/rawlab/android/settings/EditSettings.kt`：film/strength/recipeID/masterRecipeSettingsVersion、recipeScale、WB 联动（L274-360）
- `.../looks/MasterRecipe.kt`：v3/v4 解析校验 + applyRecipe（L15-74）+ i18n 资源表（L81-104）
- `.../looks/BundledLooks.kt` / `FilmGrouping.kt`：catalog 加载断言、FUJI/KODAK/OTHER 分组
- `.../looks/LookLibrary.kt`：托管库全量实现（事务/锁/注册表/隔离/恢复/DCP）
- `.../looks/LUTCompatibility.kt` + `editor/ui/LUTCompatibilityDialog.kt`：合同协商与误差预览
- `.../engine/CanonicalEditRecipe.kt`：look/master_recipe 编辑 JSON（strength 0–2、schema 18/17/7/5）
- `.../photo/PhotoStorage.kt` L385-404：films/MasterRecipes 物化与 lookPath 解析
- `.../editor/ui/AdjustmentDock.kt`：tool 0 胶片 / tool 15 MasterRecipePicker / 统一强度滑杆（L341、L466-469、L494-497）
- `lutools/src/core/photo_lut.h` / `lut_parser.cpp` / `photo_pipeline_stages.cpp`：F-Log2 编码、F-Gamut 矩阵、ContractLUTEvaluator
