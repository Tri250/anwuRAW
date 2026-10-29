# 渲染管线契约（Rendering Pipeline Contract）

> 本文档描述 anwuRAW 的像素处理管线：处理顺序、缓存 key 构成、处理版本语义。
> 这是行为的**契约**：任何改变下列已渲染输出的改动都必须遵循"版本递增"纪律（见第 3 节）。
> 代码引用以当前仓库为准；若行号漂移，以符号名为准。

---

## 1. 管线阶段与顺序

从 RAW 文件到最终像素，处理顺序固定如下。**顺序即契约**：调整参数的语义依赖它前后的阶段，
乱序会导致同一份 adjustments 在不同版本渲染出不同结果。

```
RAW 文件 (RawSource)
  │
  ├─ 1. 解码 Decode            rawler（fork：CyberTimon/RapidRAW-DngLab，版本锁 Cargo.lock）
  │      线性 RAW（LinearRaw photometric）跳过 demosaic
  │
  ├─ 2. 去马赛克 Demosaic      两档：Quality（默认）/ Speed（fast_demosaic=true）
  │                             见第 4 节
  ├─ 3. 白平衡 White Balance   wb_coeffs（多曝光帧做 neutralize_wb_if_multiexposure）
  ├─ 4. 相机→sRGB 色彩管线     as-shot 矩阵（回退 D65 主矩阵）+ 色域压缩（GamutCompression）
  ├─ 5. 曝光/线性化            黑位重标定（black level rescale）
  │
  ├─ 6. AI 补丁层 Patch        aiPatches（生成式修补/清除），产出 patched 基图
  │                             缓存 key：calculate_patch_hash（不含 PROCESSING_VERSION，
  │                             因为 patch 数据本身带 cache_epoch）
  │
  ├─ 7. 几何变换 Geometry      apply_geometry_warp：裁剪/旋转/透视/镜头畸变/TCA/暗角
  │                             （GEOMETRY_KEYS 全集见 cache_utils.rs）
  │                             缓存 key：calculate_geometry_hash
  │
  ├─ 8. 效果层 Effects         镜头模糊（lensBlur）/ 重打光（relight）/ 雾（fog）
  │                             依赖深度图/法线图的 AI 效果在此叠加
  │                             缓存 key：calculate_effects_hash
  │
  ├─ 9. 调整层 Adjustments     basic/HSL/curves/color grading/细节/effects（前端逐参数）
  │
  └─ 10. 导出编码 Export       JPEG/PNG/WebP/TIFF(8/16bit)，ResizeMode（LongEdge 等）
```

预览与导出共用同一管线；差异仅在 demosaic 档位（预览可降档，导出恒为质量档）与输出尺寸/编码。

---

## 2. 缓存 key 构成（cache_utils.rs）

所有缓存 key 都是 `DefaultHasher`（SipHash）对结构化输入的顺序哈希。**字段顺序与取值方式属于契约**：
改动任何一行的 hash 输入都会使既有缓存整体失效——这是安全的（结果重算），但必须配合第 3 节的版本纪律。

| Hash 函数                       | 输入构成                                                                                                                                                               | 是否混入 PROCESSING_VERSION  | 用途                                                                       |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | -------------------------------------------------------------------------- |
| `calculate_patch_hash`          | aiPatches（id/visible/mask 长度/subMasks/invert）+ aiDenoise（启用/参数/cache_epoch）+ negativeConversion 参数 + 是否用生成式蒙版（若用：orientation + GEOMETRY_KEYS） | 否                           | AI patch 生成缓存                                                          |
| `calculate_geometry_hash`       | patch hash + GEOMETRY_KEYS（transform*/lens*/guidedPerspective 等）                                                                                                    | **是**                       | 几何变换缓存、蒙版生成 key（mask_generation.rs）、预览 warp key 的组成部分 |
| `calculate_effects_hash`        | lensBlur/relight/fog 启用位与参数（含 fog 的 orientation）                                                                                                             | 否（经 patched_warped 传递） | 效果层缓存                                                                 |
| `calculate_patched_warped_hash` | geometry hash + effects hash                                                                                                                                           | **是**（传递自 geometry）    | patched+warped 复合基图                                                    |
| `calculate_transform_hash`      | orientationSteps/rotation/flipH/flipV + lensBlur 概要                                                                                                                  | **是**                       | 导出 resize 前的变换缓存                                                   |
| `calculate_full_job_hash`       | **文件路径字符串** + adjustments 全量 JSON 序列化                                                                                                                      | **是**                       | 解码结果唯一性、导出 job 唯一性（lib.rs / export_processing.rs 多处）      |

预览管线的运行时缓存 key（lib.rs，非持久化）：

```
warped_key  = hash(loaded_image.path, calculate_geometry_hash, working.dimensions, (target_w, target_h))
full_warped = hash(loaded_image.path, calculate_geometry_hash)
```

持久化 AI 缓存目录名带版本前缀（`versioned_cache_dir`，cache_utils.rs L405）：

```
<cache_root>/ai_maps_v{PROCESSING_VERSION}      （effect_maps.rs）
<cache_root>/ai_denoise_v{PROCESSING_VERSION}   （ai_denoise.rs）
```

升版本时 `versioned_cache_dir` 会后台清理同名前缀的旧目录，旧缓存不会无限堆积。

---

## 3. 处理版本语义（PROCESSING_VERSION）

定义于 `src-tauri/src/raw_processing.rs`：

```rust
pub const PROCESSING_VERSION: u32 = 1;
```

### 3.1 语义（注释原文为契约）

- **何时递增**：任何会*静默改变既有编辑渲染输出*的变化——rawler 升级、demosaic 默认档变化、
  tone/color 管线变化等。
- **混入范围**：该值进入全部持久化渲染缓存 key（geometry / transform / full_job，见第 2 节表）
  以及缓存目录名。
- **Sidecar 记录**：编辑记录保存时盖戳（`stamp_processing_version`，file_management.rs 三处调用：
  保存副本、保存编辑、XMP/元数据写回），字段为 `processingVersion`。
- **缺失字段 = 版本 1，且永不隐式升级**：
  `processing_version_from_json` 对缺失 `processingVersion` 的旧记录返回 1。
  旧记录继续按它创建时的管线语义渲染，不会因为升级而静默改变外观。
  （当前 v1 与"缺失"等价——第一条带戳记录与首批记录同代。）

### 3.2 递增操作规程

当下列任一情况发生时，`PROCESSING_VERSION` 必须 +1，并在 PR 中附验证证据（见
`docs/contracts/release-checklist.md` 第 7 节模板）：

1. **rawler fork 升级**（即使上游声称输出不变，也要实测对比样张后决定；拿不准就升）；
2. demosaic 默认档位、白平衡推导、色彩矩阵/色域压缩算法变化；
3. 缓存 key 输入构成变化（字段增删）——防止新 key 撞上旧缓存；
4. 任何改动"同一份 adjustments JSON 在旧代码与新代码下输出不一致"的行为修复。

不升版本的情形：纯性能优化（输出 bit-exact 相同）、新增参数（旧记录不含该参数，
默认值渲染不变——需确认默认值确实中性）、纯 UI 变更。

---

## 4. 去马赛克档位契约

rawler 的 `DemosaicAlgorithm` 提供 **Quality / Speed 两档**（这是上游 API 的全部可选项）：

| 场景             | 档位                            | 触发方式                                                                                             |
| ---------------- | ------------------------------- | ---------------------------------------------------------------------------------------------------- |
| 导出             | **恒为 Quality**                | `develop_raw_image(..., fast_demosaic=false, ...)`                                                   |
| 预览默认         | Speed（超像素快速档，浏览流畅） | `fast_demosaic=true`（raw_processing.rs：`developer.demosaic_algorithm = DemosaicAlgorithm::Speed`） |
| 预览（用户可选） | Quality（预览更锐利，浏览更慢） | 设置项 `app_settings.preview_demosaic_quality = "quality"`；`None`/`"speed"` 为快速档                |

线性 RAW（LinearRaw photometric）直接跳过 demosaic 步骤（`steps.retain(|&s| s != ProcessingStep::Demosaic)`）。

> **G3 方案偏差说明**：改进方案原文设想"demosaic 质量多档可选项"。上游 rawler 仅暴露
> Quality/Speed 两档，无法提供更细的中间档位；因此实现将**用户可选档位放在预览侧**
> （`preview_demosaic_quality` 设置），导出侧恒用质量档以保证成品画质。这是在
> 上游 API 约束下的等价落地，行为语义（导出画质不受预览档位影响）与方案意图一致。

---

## 5. 不变量（Invariant）汇总

1. 同一 `(文件内容, adjustments, PROCESSING_VERSION)` 三元组在任意两次渲染中产出 bit 相同的解码基图
   （AI 补丁/蒙版等含随机性的阶段由 cache_epoch 与确定性 seed 控制）。
2. 缺失 `processingVersion` 的编辑记录永不隐式升级。
3. 导出输出只由 adjustments 决定，不受预览 demosaic 档位影响。
4. 缓存失效永远朝着"重算正确结果"方向失败——key 撞车是唯一不允许的事故，
   因此 key 输入变化必须伴随版本递增。
