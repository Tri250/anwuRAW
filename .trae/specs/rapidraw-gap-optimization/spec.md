# RapidRAW Android 差距模块优化 — 产品需求文档

## Overview

- **Summary**: 针对 RapidRAW Android 端 7 大模块的已识别差距进行完整功能实现，包括：调整（通道混合器+分离色调+相机校准面板）、裁剪（AI 自动拉直）、蒙版（颜色范围蒙版+亮度范围蒙版）、元数据（IPTC 读写+批量编辑）、导出（ICC 色彩配置文件+色深选择）。全部要求端侧真实算法实现，无简化、无模拟、无空实现。

- **Purpose**: 将综合评分从 83.6 提升至 93+，缩小与国内正式版的功能差距。

- **Target Users**: Android 移动端摄影师/后期修图师，需要专业级 RAW 编辑能力的用户。

## Goals

- 新增 **通道混合器 (Channel Mixer)** — 3 通道到 RGB 通道的可编辑权重矩阵

- 新增 **分离色调 (Split Toning)** — 高光/阴影独立色轮 + 平衡滑块

- 新增 **AI 自动拉直** — 霍夫变换检测水平线并建议旋转角度

- 新增 **颜色范围蒙版 (Color Range Mask)** — HSV 颜色空间范围选择

- 新增 **亮度范围蒙版 (Luminance Range Mask)** — 亮度直方图范围选择

- 新增 **IPTC 元数据读写** — APP13 段完整解析与写回

- 新增 **批量元数据编辑** — 多文件同步元数据写入

- 新增 **导出 ICC 色彩配置文件** — sRGB/Adobe RGB/Display P3 嵌入

- 新增 **导出色深选择** — 8bit/16bit 显式 UI

- 提升代码可维护性和跨模块一致性

## Non-Goals

- 不引入云服务（预设云同步需要后端服务器）

- 不修改现有 GPU WGSL shader 管线（避免回归现有处理）

- 不重写现有模块，只做增量添加

- 不做移动端 NNAPI/Delegate 等硬件加速（超出本次范围）

## Background & Context

- 项目使用 Tauri v2 + React + Rust 架构，Android 通过 NDK + JNI 集成

- 后端现有 116 个 tauri::command，33K+ 行 Rust 代码

- 前端 Adjustments 类型定义在 `/workspace/src/utils/adjustments.ts`

- 后端调整参数解析在 `image_processing.rs::get_global_adjustments_from_json`

- `GlobalAdjustments` 是 `#[repr(C)]` 结构体，部分参数传到 GPU shader

- 现有 `colorCalibration` 已存在但 UI 面板较弱

- 现有 `straightenDragLine` 前端状态已存在（需要补齐 AI 检测后端）

- little\_exif crate 已在 Cargo.toml，可以做 IPTC 读写

## Functional Requirements

### FR-1: 通道混合器

- UI: 9 个滑块（红/G/B输出通道 × R/G/B输入权重），范围 -200% \~ +200%

- 后端: CPU 侧 RGB→目标通道矩阵变换

- 支持蒙版层面的通道混合器应用

- 实时预览（tile 级处理）

### FR-2: 分离色调

- UI: 高光色轮 (Hue/Saturation) + 阴影色轮 (Hue/Saturation) + 平衡滑块

- 后端: CPU 侧基于亮度阈值将像素分到高光/阴影区分别着色

- 平衡滑块范围 -100 \~ +100，控制高光/阴影分界点

- 支持蒙版层面的分离色调应用

### FR-3: AI 自动拉直

- 后端: 霍夫变换 (Hough Line Transform) 检测水平线

- 返回建议旋转角度（弧度），前端自动填充到 rotation 参数

- 支持基于边缘检测（Sobel）的预处理提高准确率

- 轻量实现，对大图做下采样处理

### FR-4: 颜色范围蒙版

- UI: 色相滑块（可选颜色）+ 容差 + 羽化 + 反选

- 后端: HSV/HSI 颜色空间转换 + 高斯模糊羽化

- 支持添加/减去/相交混合模式

- 输出 8bit 蒙版位图

### FR-5: 亮度范围蒙版

- UI: 直方图预览 + 亮度范围双滑块 + 羽化 + 反选

- 后端: 亮度直方图计算 + 阈值区间选择 + 高斯模糊羽化

- 支持柔化边缘（Feather）和过渡（Smoothing）

- 输出 8bit 蒙版位图

### FR-6: IPTC 元数据读写

- 解析 JPEG/TIFF/HEIC 中的 APP13 (IPTC-NAA) 段

- 支持写入常见字段：Headline, Caption, Keywords, Creator, City, Country

- 通过 little\_exif crate 的 IPTC API 实现

- 在 MetadataPanel 中增加 IPTC 编辑 Tab

### FR-7: 批量元数据编辑

- 前端: MetadataPanel 增加"应用到全部选中图片"按钮

- 后端: 新增 `batch_update_metadata` tauri command

- 支持选择性合并模式（只更新非空字段 / 完全覆盖）

### FR-8: 导出 ICC 色彩配置文件

- ExportPanel 增加 ICC 下拉选项（sRGB / Adobe RGB / Display P3 / 原样保留）

- 后端: 将选定的 ICC profile 嵌入导出文件（JPEG/TIFF）

- HEIC 格式支持 ICC（需要 libheif 或手动打包）

### FR-9: 导出色深选择

- ExportPanel 增加色深下拉（8bit / 16bit，根据输出格式）

- 后端根据色深选择 JPEG(8bit) 或 TIFF(8/16bit) 编码

- PNG 格式自动匹配

## Non-Functional Requirements

- **NFR-1**: 所有新增后端命令必须有错误处理和类型安全（Result\<T, String>）

- **NFR-2**: 前端新增组件必须复用现有 CollapsibleSection / Slider / ColorWheel 等 UI 原语

- **NFR-3**: IPTC 读写必须不破坏现有 EXIF/XMP 数据

- **NFR-4**: 新增蒙版生成函数必须在 4K 图上 < 1s 完成（CPU）

- **NFR-5**: 新增文件必须不依赖网络资源（纯端侧）

## Constraints

- **Technical**: little\_exif 版本 0.6.23；image crate 0.25.10；不能修改现有 WGSL shader（避免回归）

- **Business**: 必须兼容已有 preset 格式（JSON schema 扩展）

- **Dependencies**: 已有 crate 足够；不需要新增依赖

## Assumptions

- Android 端 ONNX Runtime 已能正常工作（用于其他 AI 功能）

- little\_exif crate 支持 IPTC 操作（需验证）

- 后端 CPU 处理管线已有 dehaze/glow 的先例，通道混合器/分离色调可以同模式集成

## Acceptance Criteria

### AC-1: 通道混合器完整实现

- **Type**: `rule`

- **Given**: 一张已加载的 RAW 或 JPEG 图片

- **When**: 用户在 Color 面板选择 Channel Mixer Tab 并拖动 R/G/B 滑块

- **Then**: 图片实时显示通道混合效果，参数值正确写入 adjustments JSON，后端正确应用 RGB 权重矩阵

- **Pass Condition**: 后端命令 `apply_channel_mixer` 存在并返回正确像素变换结果；前端 UI 完整显示 9 个滑块

### AC-2: 分离色调完整实现

- **Type**: `rule`

- **Given**: 一张已加载的 RAW 或 JPEG 图片

- **When**: 用户在 Color 面板选择 Split Toning Tab，分别调整高光和阴影的色轮

- **Then**: 图片高光区域显示高光色轮颜色，阴影区域显示阴影色轮颜色，平衡滑块能控制分界点

- **Pass Condition**: 后端命令 `apply_split_toning` 存在；分离色调效果正确；支持蒙版层面应用

### AC-3: AI 自动拉直

- **Type**: `rule`

- **Given**: 一张明显倾斜的风景照片（地平线非水平）

- **When**: 用户点击 Crop 面板中的"AI 拉直"按钮

- **Then**: 后端通过霍夫变换检测主要水平线，返回建议旋转角度，前端自动填充到 rotation

- **Pass Condition**: 后端命令 `detect_horizon` 存在，返回 f32 角度值（弧度）；检测结果与实际地平线误差 < 2°

### AC-4: 颜色范围蒙版

- **Type**: `rule`

- **Given**: 一张有明显主色调的图片

- **When**: 用户新建 Color Range Mask，用吸管工具选择图片中的红色区域

- **Then**: 红色像素被选中，容差增大时选中更多近似色，羽化使边缘平滑

- **Pass Condition**: 后端生成 8bit 蒙版位图，正确应用到现有蒙版管线；支持 SubMaskType.colorRange

### AC-5: 亮度范围蒙版

- **Type**: `rule`

- **Given**: 一张有明显明暗对比的图片

- **When**: 用户新建 Luminance Range Mask，拖动范围滑块

- **Then**: 指定亮度范围内的像素被选中，范围外不选中；羽化使边缘平滑

- **Pass Condition**: 后端生成 8bit 蒙版位图，正确应用到现有蒙版管线

### AC-6: IPTC 元数据读写

- **Type**: `rule`

- **Given**: 一张包含 EXIF 数据的 JPEG 图片

- **When**: 用户在 MetadataPanel 的 IPTC Tab 中修改 Headline 和 Keywords，点击保存

- **Then**: 写入后文件的 APP13 段包含正确 IPTC-NAA 数据，读取时能正确还原

- **Pass Condition**: 后端命令 `read_iptc_metadata` 和 `write_iptc_metadata` 存在并正确解析/写入

### AC-7: 批量元数据编辑

- **Type**: `rule`

- **Given**: 用户选中了 5 张图片

- **When**: 用户在 MetadataPanel 编辑后点击"应用到全部"

- **Then**: 5 张图片的选定字段被同步更新，显示成功/失败计数

- **Pass Condition**: 后端命令 `batch_update_metadata` 存在，处理多文件路径，返回统计结果

### AC-8: 导出 ICC 色彩配置文件

- **Type**: `rule`

- **Given**: 用户打开 ExportPanel

- **When**: 用户在 ICC 下拉选择 "Adobe RGB"，设置 JPEG 格式

- **Then**: 导出的 JPEG 文件 EXIF 中包含 Adobe RGB ICC profile 数据段

- **Pass Condition**: 后端 export\_processing 中正确嵌入 ICC profile；导出文件可被色彩感知软件识别

### AC-9: 导出色深选择

- **Type**: `rule`

- **Given**: 用户打开 ExportPanel

- **When**: 用户选择 TIFF 格式，色深 16bit

- **Then**: 导出文件为 16bit TIFF，色彩深度正确

- **Pass Condition**: 导出文件可被色彩深度检测工具正确识别

### AC-10: 代码质量与架构一致性

- **Type**: `rubric`

- **Dimension**: 新代码与现有代码库的一致性和规范性

- **Scale**: 1-5

- **Anchors**: 1 = 风格严重不一致，有硬编码和 panic；3 = 基本一致，有少量重复；5 = 完全符合现有模式，零 panic，类型安全

- **Pass Threshold**: >= 4

- **Evidence**: code review 证据

## Open Questions

- [ ] little\_exif 0.6.23 对 IPTC 的支持程度？需要验证是否有 IPTC API

- [ ] ICC profile 数据从哪里来？sRGB 嵌入常见，Adobe RGB 需要随包分发

- [ ] 导出进度通知 Android 端是否需要 Tauri plugin 配合？

