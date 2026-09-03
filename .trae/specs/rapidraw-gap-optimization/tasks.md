# RapidRAW Android 差距模块优化 — 实施计划

## Task 1: 新增后端 — 通道混合器 CPU 实现

- **Status**: `pending`

- **Priority**: high

- **Depends On**: None

- **Description**:

  - 在 `image_processing.rs` 新增 `ChannelMixerSettings` 结构体（9 个 f32 权重）

  - 在 `GlobalAdjustments` 末尾插入 channel\_mixer 字段 + 4 个 padding

  - 新增 `apply_channel_mixer_cpu` 函数（并行处理 f32 RGB buffer）

  - 新增 tauri command `apply_channel_mixer` 接收图片 + mixer settings → 返回 base64 结果

  - 在 `get_global_adjustments_from_json` 中解析 JSON 的 `channelMixer` 字段

  - 处理 channel mixer 为 identity（全零除对角线 100%）时跳过，保证零开销

- **Acceptance Criteria Addressed**: AC-1

- **Test Requirements**:

  - `rule` TR-1.1: `cargo check` 无编译错误（只 check 不构建）

  - `rule` TR-1.2: 后端命令能返回有效 JPEG base64 结果（非空）

  - `rubric` TR-1.3: 性能；4K 图通道混合 < 200ms；阈值 >= 4；通过简单计时脚本验证

- **Notes**: 不改 WGSL shader；走 CPU 管线（参考 dehaze/glow 的做法）

## Task 2: 新增后端 — 分离色调 CPU 实现

- **Status**: `pending`

- **Priority**: high

- **Depends On**: None

- **Description**:

  - 新增 `SplitToningSettings` 结构体（shadows\_hue/sat, highlights\_hue/sat, balance, enabled）

  - 在 `GlobalAdjustments` 末尾插入 split\_toning 字段 + padding

  - 新增 `apply_split_toning_cpu` 函数：计算亮度 → 平衡阈值分配 → 高光/阴影着色 + 高斯过渡

  - 新增 tauri command `apply_split_toning`

  - `get_global_adjustments_from_json` 解析 `splitToning` 字段

- **Acceptance Criteria Addressed**: AC-2

- **Test Requirements**:

  - `rule` TR-2.1: `cargo check` 无编译错误

  - `rule` TR-2.2: 后端命令能返回有效结果

- **Notes**: 着色在 OKLAB 或 HSV 空间做，避免 RGB 直接混合的色偏

## Task 3: 新增后端 — AI 自动拉直（霍夫变换）

- **Status**: `pending`

- **Priority**: high

- **Depends On**: None

- **Description**:

  - 在 image\_processing.rs 中新增 `detect_horizon_hough` 函数

  - 实现：下采样（<= 800px）→ Sobel 边缘检测 → 概率霍夫变换 → 最长水平线角度

  - 返回弧度值（带符号），前端直接填入 rotation

  - 新增 tauri command `detect_straighten_angle`

- **Acceptance Criteria Addressed**: AC-3

- **Test Requirements**:

  - `rule` TR-3.1: `cargo check` 无编译错误

  - `rule` TR-3.2: 输入一张地平线倾斜 5° 的图，返回值在 ±2° 范围内

  - `rubric` TR-3.3: 准确率；5 张测试图检测平均误差 < 2°；阈值 >= 4

- **Notes**: 不需要 OpenCV；自己实现简化版概率霍夫变换

## Task 4: 新增后端 — 颜色范围蒙版生成

- **Status**: `pending`

- **Priority**: high

- **Depends On**: None

- **Description**:

  - 在 `mask_generation.rs` 新增 `color_range_mask` sub\_masks 类型处理

  - 新增 `generate_color_range_mask` 函数：RGB→HSV→范围选择→高斯模糊羽化

  - 参数：可选颜色列表 \[{hue, tolerance}] + saturation 范围 + 亮度范围 + 羽化强度

  - 与现有 `generate_mask_bitmap` 集成，作为 MaskDefinition 的一种 sub\_mask 类型

  - 支持 `invert` 参数

- **Acceptance Criteria Addressed**: AC-4

- **Test Requirements**:

  - `rule` TR-4.1: `cargo check` 无编译错误

  - `rule` TR-4.2: 生成的蒙版位图为灰色 8bit、非全黑非全白

- **Notes**: 复用现有 mask bitmap 管道

## Task 5: 新增后端 — 亮度范围蒙版生成

- **Status**: `pending`

- **Priority**: high

- **Depends On**: None

- **Description**:

  - 在 `mask_generation.rs` 新增 `luminance_range_mask` sub\_masks 类型处理

  - 新增 `generate_luminance_range_mask` 函数：计算亮度 → 阈值区间 → 高斯羽化

  - 参数：min\_luminance, max\_luminance, feather, invert

  - 与现有蒙版管线集成

- **Acceptance Criteria Addressed**: AC-5

- **Test Requirements**:

  - `rule` TR-5.1: `cargo check` 无编译错误

  - `rule` TR-5.2: 生成蒙版有效

## Task 6: 新增后端 — IPTC 元数据读写

- **Status**: `pending`

- **Priority**: medium

- **Depends On**: None

- **Description**:

  - 检查 little\_exif 0.6.23 的 IPTC API；若不支持则手动实现 APP13 marker 读写

  - APP13 marker = FFE4, header = "Photoshop 3.0\0" + ResourceBlocks（IPTC-NAA section 1:0x0404 或 2:0x0000）

  - 新增 tauri commands: `read_iptc_metadata`, `write_iptc_metadata`

  - 提取常见字段：Headline(2:105), Caption(2:120), Keywords(2:25), Creator(2:80), City(2:90), Country(2:101), Copyright(2:116)

- **Acceptance Criteria Addressed**: AC-6

- **Test Requirements**:

  - `rule` TR-6.1: `cargo check` 无编译错误

  - `rule` TR-6.2: 写入后再读取的字段一致（回环测试）

- **Notes**: TIFF/HEIC 可能不直接支持 APP13；先聚焦 JPEG

## Task 7: 新增后端 — 批量元数据编辑

- **Status**: `pending`

- **Priority**: medium

- **Depends On**: Task 6

- **Description**:

  - 新增 tauri command `batch_update_metadata`

  - 参数：图片路径数组 + metadata patch 对象 + merge\_mode（merge/overwrite）

  - 逐个处理，返回 {success: N, failed: N, errors: \[...]}

  - 复用 exif\_processing.rs 的写入函数

- **Acceptance Criteria Addressed**: AC-7

- **Test Requirements**:

  - `rule` TR-7.1: `cargo check` 无编译错误

  - `rule` TR-7.2: 批量处理 5 张图片全部成功

## Task 8: 新增后端 — 导出 ICC + 色深

- **Status**: `pending`

- **Priority**: medium

- **Depends On**: None

- **Description**:

  - 标准 sRGB ICC profile 硬编码到 Rust 常量（公开可用 ICC v2 profile 原始字节）

  - Adobe RGB profile 同样内置（或提供 sRGB 作为默认）

  - export\_processing.rs 中新增 `embed_icc_profile` 函数

  - 新增参数：icc\_profile: "srgb" | "adobergb" | "displayp3" | "keep"

  - 新增参数：bit\_depth: 8 | 16；TIFF 自动 16bit；JPEG 强制 8bit（扩展 JPEG 不支持 16bit）

  - tauri command `export_image` 扩展参数

- **Acceptance Criteria Addressed**: AC-8, AC-9

- **Test Requirements**:

  - `rule` TR-8.1: `cargo check` 无编译错误

  - `rule` TR-8.2: 导出 JPEG 包含 ICC 段

  - `rule` TR-8.3: 导出 TIFF 色深正确

## Task 9: 新增前端 — 通道混合器 + 分离色调 UI

- **Status**: `pending`

- **Priority**: high

- **Depends On**: Task 1, Task 2

- **Description**:

  - `adjustments.ts` 新增 ChannelMixer 接口（9 个 number 字段）和 SplitToning 接口

  - INITIAL\_ADJUSTMENTS 扩展默认值

  - 新建 `src/components/adjustments/ChannelMixer.tsx` — 3 行 R/G/B 输出 × 3 列 R/G/B 输入滑块

  - 新建 `src/components/adjustments/SplitToning.tsx` — 高光色轮 + 阴影色轮 + 平衡滑块

  - 修改 `ControlsPanel.tsx` / `Color.tsx` 把新面板加入 Tab 切换

  - i18n 新增文案（zh-CN, en 至少两种）

- **Acceptance Criteria Addressed**: AC-1, AC-2

- **Test Requirements**:

  - `rule` TR-9.1: TypeScript 编译通过（tsc --noEmit 无错误）

  - `rule` TR-9.2: 组件在 ControlsPanel 中可渲染，交互正常

## Task 10: 新增前端 — AI 拉直按钮 + 颜色/亮度蒙版 UI

- **Status**: `pending`

- **Priority**: high

- **Depends On**: Task 3, Task 4, Task 5

- **Description**:

  - CropPanel.tsx 新增"AI 拉直"按钮（调用 `detect_straighten_angle` command）

  - MasksPanel/Masks.tsx 新增 `ColorRange` 和 `LuminanceRange` mask 类型

  - 新建对应 UI：吸管工具、色轮/直方图预览、容差滑块

  - SubMask 类型扩展

- **Acceptance Criteria Addressed**: AC-3, AC-4, AC-5

- **Test Requirements**:

  - `rule` TR-10.1: TypeScript 编译通过

  - `rule` TR-10.2: AI 拉直按钮点击后 rotation 自动更新

## Task 11: 新增前端 — IPTC + 批量元数据 + 导出选项 UI

- **Status**: `pending`

- **Priority**: medium

- **Depends On**: Task 6, Task 7, Task 8

- **Description**:

  - MetadataPanel.tsx 新增 IPTC Tab（Headline, Caption, Keywords, Creator, City, Country, Copyright 字段）

  - 增加"应用到全部选中"按钮 + 进度反馈

  - ExportPanel.tsx 新增 ICC 下拉 + 色深下拉

- **Acceptance Criteria Addressed**: AC-6, AC-7, AC-8, AC-9

- **Test Requirements**:

  - `rule` TR-11.1: TypeScript 编译通过

  - `rule` TR-11.2: 导出选项正确传递到后端

## Task 12: 注册所有新 tauri commands 到 lib.rs

- **Status**: `pending`

- **Priority**: high

- **Depends On**: Task 1-8

- **Description**:

  - 修改 lib.rs 中的 invoke\_handler，注册所有新增 commands

  - 新增模块声明（mod channel\_mixer; mod split\_toning; mod color\_range\_mask; ... 如需要）

- **Acceptance Criteria Addressed**: AC-1\~AC-9

- **Test Requirements**:

  - `rule` TR-12.1: 所有 command 注册后 `cargo check` 通过

## Task 13: 端到端集成验证

- **Status**: `pending`

- **Priority**: high

- **Depends On**: Task 9-12

- **Description**:

  - 对每个 AC 做端到端手动测试（或写简单单元测试）

  - 验证 JSON schema 兼容（preset 包含新字段时旧版本不崩溃）

  - 确认 `cargo check` + `npx tsc --noEmit` 双通过

- **Acceptance Criteria Addressed**: AC-1\~AC-10

- **Test Requirements**:

  - `rule` TR-13.1: cargo check 通过

  - `rule` TR-13.2: TypeScript 编译通过

  - `rule` TR-13.3: 所有 AC 至少有一条验证证据

- **Notes**: 环境可能无法构建完整 Android APK，用 cargo check + tsc 做最低门槛

## Task 14: 性能与代码质量审计

- **Status**: `pending`

- **Priority**: low

- **Depends On**: Task 13

- **Description**:

  - 检查无 panic!()、unwrap() 滥用

  - 检查 parallelism（rayon par\_\*）

  - 检查错误处理（Result\<T, String>）

  - 确认无硬编码魔法数字

- **Acceptance Criteria Addressed**: AC-10

- **Test Requirements**:

  - `rule` TR-14.1: 新代码中无 unwrap() / expect()（除 .ok() 转换）

  - `rubric` TR-14.2: 代码一致性；scale 1-5；阈值 >= 4

