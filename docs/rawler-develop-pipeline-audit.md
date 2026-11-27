# rawler 显影顺序审计（v2.1.24 / P2-1）

> 审计对象：[raw_processing.rs](../src-tauri/src/raw_processing.rs) 中 `develop_internal` 的实际执行顺序。
> 目的：显影管线改动（rawler 升级、去马赛克/色彩管线调整）时有一份可对照的顺序记录，
> 任何影响输出的改动都必须 bump `PROCESSING_VERSION`（`stamp_processing_version`，
> 参与所有渲染缓存键）。文档与代码不一致视为 bug。

## 1. 显影顺序（develop_internal 实际顺序）

| # | 步骤 | 说明 / 代码锚点 |
|---|------|----------------|
| 1 | 取消检查 | `check_cancel()`（加载取消令牌） |
| 2 | `RawSource` + decoder | `rawler::get_decoder(&source)` |
| 3 | `decoder.raw_image()` | 原始解码：CFA/线性数据 + `crop_area` / `active_area` |
| 4 | 方向元数据 | `metadata_orientation`（EXIF Orientation → `Orientation`） |
| 5 | 线性格式判定 | `is_linear_raw_format`（LinearRaw/线性 DNG 等跳过 Demosaic） |
| 6 | linear_mode 分支 | `gamma`(ungamma+calib) / `skip_calib` / `gamma_skip_calib` / 默认 linear(仅 calib) |
| 7 | 白黑级记录 | 记录原 white/black level；whitelevel 全部改写为 `u32::MAX`（后续重标定） |
| 8 | RawDevelop 步骤裁剪 | 剔除 `SRgb`、`Calibrate`（应用侧自行做 sRGB/校准）；线性格式再剔除 `Demosaic`；fast_demosaic 时 `demosaic_algorithm = Speed` |
| 9 | WB 系数 | `neutralize_wb_if_multiexposure`（多曝光合成时中性化） |
| 10 | `CameraToSrgb` 构造 | `(apply_calibration \|\| !is_linear_format)` 时构造（DNG 色彩矩阵路径） |
| 11 | `cfa_white_balance` | 非 linear 且有校准时计算 CFA 级 WB；存在则剔除 `CropDefault` 步骤 |
| 12 | `develop_intermediate` | rawler 主显影（CropDefault/Demosaic/WB/线性化，按 retained steps） |
| 13 | 相机→sRGB | `cfa_balance.is_none()` 且有 `camera_to_srgb` 时 `camera_to_srgb.apply` |
| 14 | 重标定 | `rescale_factor = (u32::MAX - black) / (white - black)`，线性值重标定 |
| 15 | 高光余量 | fast 路径 clamp 8.0（8× headroom，预览高光决策与导出 1000× 恢复一致）；完整路径 clamp 1000.0 |
| 16 | 逐像素处理 | Monochrome / ThreeColor(cfa) / ThreeColor(camera_to_srgb) 三分支：重标定 + （线性格式且 apply_ungamma 时 `srgb_to_linear`）+ clamp |
| 17 | crop | `default_crop(crop_area, active_area, raw_dim, dim)` → `Region` |
| 18 | 返回 | `apply_orientation(developed, orientation)`（`develop_raw_image` 中执行） |

## 2. 与内嵌预览的关系

- `extract_embedded_preview`（同文件）走 `decoder.full_image` + EXIF orientation，
  返回已定向的相机内嵌预览（JPEG）。
- P2-1 新增 `get_preview_exposure_baseline` 命令：显影结果与内嵌预览各降采样
  128²、取 Rec709 luma 中值，`suggested_ev = log2(embedded_median / raw_median)`
  （±3 EV 限幅）。该命令是纯读操作，**不**写缓存、**不**改 `PROCESSING_VERSION`，
  前端可将 `suggested_ev` 作为"对齐相机 JPEG 曝光"的一键参考值。
- 相机内嵌预览的曝光由厂商固件决定，仅作观感锚点，不作为显影正确性判据。

## 3. 审计注意点（历史发现）

1. **SRgb 步骤被剔除**：显影输出保持线性；sRGB 编码由应用侧
   `apply_linear_to_srgb` 完成（导出/预览各自处理），不要在 rawler 层重复。
2. **whitelevel 重写为 u32::MAX** 后由 `rescale_factor` 重新标定——若 rawler
   未来变更 whitelevel 语义（如 14→16 bit 左移），此处重标定需同步。
3. **fast_demosaic 的 8× headroom** 与完整路径的 1000× clamp 不同，两档预览的
   高光裁切判断不会逐位一致（R1-1 设计如此，导出以完整路径为准）。
4. **线性格式跳过 Demosaic/校准**：LinearRaw/线性 DNG 数据假定为已线性化的
   scene RGB；`apply_ungamma` 分支仅用于 `linear_mode ∈ {gamma, gamma_skip_calib}`。
5. rawler 升级时的回归判据：同一 RAW 的 128² luma 中值差 < 0.5/255（可用
   P2-1 的 `median_u8` / `downsample_luma_128` 辅助函数做基准测试）。

## 4. 相关单测

- `raw_processing::tests::median_u8_basic`
- `raw_processing::tests::suggested_ev_anchors`
- `raw_processing::tests::downsample_luma_128_shape_and_value`
