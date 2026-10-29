# RAW 格式支持矩阵

> 状态契约文档（G7）。本文档描述 anwuRAW 当前**实际**的 RAW 输入支持状态，
> 所有"未验证"标注均表示缺少样张测试，不构成支持承诺。先有契约，再谈升级。

## 1. 解码器基线

| 项           | 值                                                                                                              |
| ------------ | --------------------------------------------------------------------------------------------------------------- |
| 解码库       | rawler（[dnglab/dnglab](https://github.com/dnglab/dnglab) 项目的子 crate）                                      |
| 引用方式     | git fork `CyberTimon/RapidRAW-DngLab`（[Cargo.toml](../src-tauri/Cargo.toml) 未钉 tag）                         |
| 当前锁定版本 | rawler `0.7.1`（crate 自报版本），锁定的 git rev `9dbcc565`（2026-10-24，随上游 main）                          |
| 上游机型矩阵 | [SUPPORTED_CAMERAS.md](https://github.com/dnglab/dnglab/blob/main/SUPPORTED_CAMERAS.md)（数百机型，本文不复制） |
| 扩展名白名单 | [src-tauri/src/formats.rs](../src-tauri/src/formats.rs) `RAW_EXTENSIONS`（下表）                                |

与 Adobe DNG SDK 路线（RawLab 0.8.2）不同，rawler 是纯 Rust 实现，解压/去马赛克
覆盖面与 Adobe SDK 不一一对应；下表逐项给出差距结论。

## 2. RawLab 0.8.2 新增格式对照（本仓库差距审计）

| 格式                                                  | RawLab 0.8.2                   | anwuRAW（rawler fork @ 9dbcc565）                                                                                                  | 结论                                           |
| ----------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| Nikon HE / HE\* NEF（Z8/Z9 High Efficiency 压缩变体） | ✅ 支持                        | Z8/Z9 机型本身 ✅（上游矩阵 12/14bit）；**HE/HE\* 压缩变体未经样张验证**，上游 changelog 无明确声明                                | ⚠️ 需样张验证后才可承诺                        |
| Sony ARW6（A7V 等，"Compressed RAW 2"）               | ✅ 支持                        | ❌ **不支持**。上游 v0.8.0 明确标注 A7V 支持为 "without arw6 support"                                                              | ❌ 明确不支持，写入矩阵不承诺；关注上游后续 PR |
| Sigma X3F（Foveon）                                   | ✅ 支持（Adobe DNG SDK 1.7.1） | ⚠️ 上游存在 `rawler/src/decoders/x3f.rs`（fork 同步包含），但覆盖的机型/传感代次（早期 Foveon vs Quattro/fp 系列）未经验证，无样张 | ⚠️ 部分/未验证，不承诺新机型                   |
| JPEG 压缩 DNG（lossless JPEG tile）                   | ✅ 支持                        | ⚠️ DNG/TIFF 解压路径 v0.7.1 已重构（含 deflate），JPEG 压缩变体理论可用，未样张验证                                                | ⚠️ 未验证                                      |
| JPEG XL 压缩 DNG（Adobe DNG SDK 1.7.1）               | ✅ 支持                        | ✅ 上游 v0.7.1 明确新增 "decoding JPEG-XL compressed DNGs"（PR #562，jxl-oxide 0.12.x）                                            | ✅ 支持（建议样张冒烟固化）                    |

## 3. 容器/扩展名矩阵（当前白名单）

以下为 [formats.rs](../src-tauri/src/formats.rs) 的导入白名单；"解码状态"为
rawler fork 对该家族的总体状态，具体机型以上游 SUPPORTED_CAMERAS.md 为准。

| 扩展名                | 家族                      | 解码状态                                                   |
| --------------------- | ------------------------- | ---------------------------------------------------------- |
| dng                   | Adobe DNG（含各厂商直出） | ✅ 含 JPEG-XL 压缩；JPEG 压缩变体未验证                    |
| nef / nrw             | Nikon                     | ✅；HE/HE\* 变体未验证                                     |
| arw / srf / sr2       | Sony                      | ✅；ARW6 不支持                                            |
| cr2 / crw / cr3       | Canon                     | ✅（CR3 含 CRM 预览选择修复）                              |
| raf                   | Fujifilm                  | ✅（含 X-Trans；上游 v0.8.0 增加简单双线性 demosaic 备选） |
| rw2                   | Panasonic                 | ✅（v4/v6 解压器）                                         |
| orf                   | Olympus                   | ✅                                                         |
| pef / ptx             | Pentax                    | ✅                                                         |
| x3f                   | Sigma Foveon              | ⚠️ 部分/未验证                                             |
| 3fr / fff             | Hasselblad                | ✅                                                         |
| iiq / mos             | Phase One / Leaf / Imacon | ✅                                                         |
| erf                   | Epson                     | ✅                                                         |
| mrw                   | Minolta                   | ✅                                                         |
| kdc / k25 / dcs / dcr | Kodak                     | ✅（RADC 解压）                                            |
| srw                   | Samsung                   | ✅                                                         |
| rwl                   | Leica                     | ✅                                                         |
| ari                   | ARRI                      | ✅                                                         |
| bay                   | Casio                     | ⚠️ 旧格式，低优先                                          |
| pro                   | Apple ProRAW              | ✅（DNG 容器）                                             |
| raw                   | Contax / Panasonic        | ✅（按解析器自动识别）                                     |

非 RAW 位图（jpg/png/webp/tiff/gif/bmp/exr/hdr/jxl 等）走 `image` crate 路径，
不属于本矩阵范围（见 `NON_RAW_EXTENSIONS`）。

## 4. 已验证样张（每格式 ≥1 张的验收要求）

**当前为空** —— 这是本仓库的支持矩阵与 RawLab 的最大差距之一。样张登记表：

| 格式 / 特性 | 机型 | 文件名（tests/samples/） | 许可 | 解码结果 | 验证日期 |
| ----------- | ---- | ------------------------ | ---- | -------- | -------- |
| （待贡献）  |      |                          |      |          |          |

样张来源要求：用户贡献（需书面许可）或开放许可样张（raw.pixls.us、
dnglab 官方 testdata）。**严禁**把未获许可的样张入库。

## 5. CI 冒烟解码（规划）

`tests/samples/` 落地后，在 CI 增加冒烟 job：

1. 对每个样张运行一次解码（复用 `anwuRAW image-info` + 最小尺寸 headless
   export `--long-edge 256`）；
2. 断言退出码 0 且输出文件存在；
3. 失败即红灯 —— 保证"矩阵中标 ✅ 的项持续可用"。

在样张集建立前，CI 不做 RAW 解码断言（避免假绿/假红）。

## 6. fork 升级策略（跟随上游）

1. **前置**：升级前必须已落地 G3 `PROCESSING_VERSION`（✅ 已落地）—— 解码器
   行为变化会使旧缓存/旧导出结果不同，管线版本 bump 让旧编辑结果明确失效而不是
   静默漂移；
2. rebase fork 到上游 main 或改 pin 具体 tag；
3. 跑第 5 节冒烟 job（样张集）+ 抽查截图对比；
4. bump `PROCESSING_VERSION` 并在 PR 中附验证证据清单（见
   [docs/contracts/release-checklist.md](contracts/release-checklist.md)）。

## 7. 结论与承诺边界

- 明确**不支持**：Sony ARW6（跟随上游，等上游实现后随升级获得）；
- 支持**但未经样张验证**：Nikon HE/HE\*、Sigma X3F、JPEG 压缩 DNG —— 在样张
  登记表补齐之前，对外宣传口径一律以"部分支持"表述；
- 支持：JPEG-XL DNG、以及第 3 节中标 ✅ 的家族（以机型矩阵为准）。
