# RapidRAW 功能模块全景清单与操作链路自检报告

> 生成日期：2026-10-27 ｜ 自检基线：`tsc --noEmit` 0 错误、`vite build` 成功、事件链全量交叉核对

RapidRAW 是基于 **Tauri 2 + React 19 + Rust** 的跨平台 Raw 照片编辑器（Windows / macOS / Linux / Android / iOS）。
前端负责 UI 与状态编排（Zustand），后端 Rust 负责图像解码/渲染管线/AI/文件系统，经 IPC（约 135 个注册命令）与事件（约 50 个）通信。

---

## 一、前端功能模块清单（src/）

### 1. 视图层（components/views/）
| 模块 | 职责 |
|---|---|
| EditorView | 编辑器视图骨架：画布、工具栏、胶片条、右面板编排 |
| LibraryView | 图库视图：网格/列表/筛选视图、头部工具栏、空状态 |

### 2. 编辑器面板（components/panel/）
| 模块 | 职责 |
|---|---|
| Editor.tsx | 编辑器主容器，WGPU 渲染状态同步（syncWgpu → update_wgpu_transform） |
| EditorToolbar / ToolbarMenu | 顶部工具切换、视图选项 |
| ImageCanvas | 画布显示：预览 URL 切换、原图对比、分离视图、交互补丁覆盖 |
| Waveform / ConnectedWaveform | 直方图/波形图/矢量示波器（后端 analytics 二进制通道） |
| BottomBar | 底栏：评分、旗标、缩放、复制/粘贴设置入口 |
| Filmstrip | 胶片条导航 |
| MainLibrary | 主图库容器 |
| SidePanelArea / PanelSwitcher | 可拖拽面板区域 + 面板标签布局系统（持久化 workspace） |
| CommunityPage | 社区预设浏览页 |
| SettingsPanel | 全局设置（主题、性能、AI、标签、数据管理、快捷键、语言） |

### 3. 右侧功能面板（components/panel/right/）
| 模块 | 职责 |
|---|---|
| ControlsPanel | 基础调整区（亮度/色彩/曲线/细节/效果分区容器） |
| CropPanel | 裁剪/旋转/透视/自动拉直 |
| MasksPanel | 蒙版系统：容器/子蒙版管理、笔刷、深度范围、AI 蒙版入口 |
| Masks.tsx | 蒙版类型枚举、图标映射、拖拽数据模型 |
| AIPanel | AI 补丁（生成式替换/克隆/修复/液化/修饰）、AI 任务队列状态 |
| MetadataPanel | EXIF 元数据查看与编辑、标签、旗标 |
| PresetsPanel | 用户预设、大师配方、LUT 列表 |
| ExportPanel | 导出设置（格式/尺寸/命名/水印/目标/Immich 上传） |
| FolderTree | 文件夹树 + 相册树（置顶、图标、搜索、拖拽） |
| TetheringPanel | 相机联机拍摄（libgphoto2） |
| AdjustmentSectionsSubMenu | 调整分区自定义子菜单 |
| FacePartsIllustration | AI 面部部位蒙版选择图 |

### 4. 调整参数组件（components/adjustments/）
Basic（曝光/白平衡/色调）、Color（混色器/校准/分级）、Curves（曲线）、Details（锐化/降噪/去雾）、Effects（颗粒/暗角/晕影/景深/重光）、AdjustmentSection / SubSection（分区容器与工具排布）。

### 5. 弹窗（components/modals/ via AppModals 统一挂载）
| 模块 | 职责 |
|---|---|
| PanoramaModal | 全景拼接（进度/结果/保存） |
| HdrModal | HDR 合并 |
| FocusStackModal | 焦点堆栈（含深度图预览） |
| CollageModal | 拼贴画布 |
| CullingModal | AI 辅助选片（相似分组/模糊检测） |
| CopyPasteSettingsModal | 复制粘贴设置范围配置 |
| ConfigurePresetModal | 预设命名/分组配置 |
| ImportSettingsModal / CreateFolderModal / Rename*Modal | 导入与文件重命名 |
| ConfirmModal | 通用确认框 |

### 6. 状态仓库（store/，Zustand）
| Store | 职责 |
|---|---|
| useEditorStore | 当前图像、adjustments、历史、蒙版交互状态、AI 进度、缓存交互 |
| useLibraryStore | 文件列表、文件夹树、相册树、多选、评分表、虚拟路径 |
| useUIStore | 视图切换、面板布局、弹窗状态、UI 可见性 |
| useSettingsStore | AppSettings 读写与持久化 |
| useProcessStore | 缩略图队列、导出/导入状态、AI 任务、任务中心 |
| useCloudStore | Clerk 登录态、云同步用量 |
| useTetheringStore | 联机拍摄会话状态 |

### 7. Hooks（hooks/，功能链路编排层）
| Hook | 职责 |
|---|---|
| useAppInitialization | 启动：load_settings → 工作区恢复 → 根目录加载 → 缩略图队列 |
| useAppNavigation | 图库↔编辑器导航、前进/后退历史、前端 LRU 预览缓存（globalImageCache） |
| useImageProcessing | 核心渲染链：adjustments 变更 → 防抖 → apply_adjustments → 预览 URL/WGPU |
| useImageLoader | load_image 加载与后端缓存判定 |
| useEditorActions | 复制/粘贴/重置调整、缩放指令 |
| useLibraryActions | 评分/旗标/颜色标签/置顶/相册项管理 |
| useFileOperations | 删除/新建/重命名/导入/粘贴/虚拟副本 |
| useProductivityActions | 全景/HDR/焦点堆栈/拼贴的触发与保存 |
| useKeyboardShortcuts | 可配置快捷键（keybinds） |
| useTauriListeners | 后端事件订阅中枢（约 45 个事件） |
| useThumbnails | 缩略图请求队列（可见窗口优先） |
| useAiMasking | AI 蒙版生成任务提交与结果合并 |
| useExportSettings | 导出参数派生与预估 |
| useExternalEditSession | 外部编辑器往返会话 |
| useAppContextMenus | 全部右键菜单构建 |
| useSortedLibrary / useImageRenderSize / useWaveformControls / usePresets / useCloudUsage / useOsPlatform / useCollapsibleHeight / useAndroidBackHandler | 排序、渲染尺寸、波形控制、预设、云用量、平台、折叠、安卓返回 |

### 8. Immich 集成（components/immich/）
immichApi（REST 封装）、ImmichSection/ImmichTimeline（服务器相册浏览）、ImmichExportOptions（导出上传）、ImmichSettings（服务器配置）、useImmichEvents（immich-download/sync/upload/library-changed/trash/edits-* 事件）、useImmichStore（连接状态）。后端支持双向同步、离线队列、编辑写回。

### 9. UI 基础件与工具（components/ui/、utils/）
Button/Slider/Switch/Input/Dropdown/ColorWheel/ColorField/LUTControl/DepthRangePicker/Resizer/GlobalTooltip/Text 等。
utils：adjustments（参数模型与默认值）、backendPayload（IPC 序列化）、cropUtils、maskUtils、imageGrouping（RAW+JPEG 分组）、ImageLRUCache（前端预览 LRU）、whiteBalance、imageFlags、themes、keyboardUtils、formatBytes、frontendLogBridge。

---

## 二、后端功能模块清单（src-tauri/src/）

### 1. 核心图像处理管线
| 模块 | 职责 |
|---|---|
| lib.rs | 命令注册、预览工作线程池、多级缓存（patched/working/warped/effects/full_transformed）、apply_adjustments / generate_uncropped_preview / generate_preview_for_path / merge_hdr / save_temp_file / frontend_ready 等 |
| image_processing.rs | 渲染主引擎：RAW/非 RAW 处理、几何变换、色调映射、sRGB 转换、GPU 上下文 |
| raw_processing.rs / formats.rs / apple_raw.rs | RAW 解码（Rawler）、格式支持表、Apple ProRAW |
| gpu_processing.rs | WGPU 显示管线（display/blur/flare/guided shader），wgpu-frame-ready 事件 |
| adjustment_utils.rs / as_shot.rs / baseline_exposure.rs / white_balance.rs | 空间变换、白平衡推导、曝光基线补偿 |
| cache_utils.rs / memory_budget.rs / ImageLRUCache | 会话缓存、内存预算控制 |
| effect_maps.rs / fog.rs / lens_blur.rs / relight.rs / highlight_reconstruction.rs | 特效图、雾效、镜头虚化、重光、高光重建 |

### 2. 几何与合成工具
auto_straighten、guided_perspective（引导透视）、panorama_stitching + panorama_utils（拼接/融合）、hdr_deghosting（对齐/去鬼影）、focus_stacking（对齐/深度图）、multi_exposure、negative_conversion（负片翻转）。

### 3. AI 子系统
| 模块 | 职责 |
|---|---|
| ai_connector.rs / ai_commands.rs | 本地 AI 连接器状态（10s 轮询 + 事件）、6 类 AI 蒙版（subject/foreground/sky/text/face/depth） |
| ai_processing.rs | 模型下载（ai-model-download-* 事件）、推理调度 |
| ai_denoise.rs | AI 降噪（ai-denoise-progress/ready/error 事件） |
| ai_jobs.rs | AI 任务队列（pending/running/failed、ai-jobs-status/pending/ai-job-result 事件） |
| inpainting.rs | 生成式替换、手动清理、液化、修饰补丁 |
| face_masking.rs / mask_generation.rs / bm3d.rs | 面部部位蒙版、蒙版位图渲染、BM3D 降噪 |
| tagging.rs + tagging_utils/ | AI 自动标签（后台索引，indexing-* 事件） |

### 4. 文件与图库管理
file_management.rs（列出/导入/移动/复制/重命名/删除/相册/虚拟副本/侧车元数据/缩略图生成队列/颜色标签/评分/旗标/LUT 导入导出/预设导入导出）、storage.rs（缓存用量统计与清理）、exif_processing.rs、preset_converter.rs（XMP/legacy 转换）、culling.rs（AI 选片分析）、launch_request.rs（单实例启动请求、外部编辑会话、open-with-file）、app_settings.rs、app_state.rs、window_customizer.rs、android_integration.rs。

### 5. 设备与云集成
camera_tethering.rs（libgphoto2 联机拍摄，7 个 tether_* 命令）、lens_correction.rs（lensfun 数据库：自动镜头校正）、immich/（client/commands/config/files/registry/resolve/secrets/sync/thumbnails/trash/uploads — 10 个 immich_* 命令 + 7 个 immich-* 事件）。

---

## 三、核心功能操作链路（自检确认）

| 链路 | 路径 | 状态 |
|---|---|---|
| 预览渲染 | adjustments 变更 → useImageProcessing 防抖 → `apply_adjustments` → 后端 5 级缓存管线 → 预览字节 / wgpu transform → ImageCanvas | ✅ |
| 缩放 HiFi | zoom → calculateTargetRes → 防抖重渲染 → release_original_preview | ✅ |
| 图库→编辑器 | handleImageSelect → 前端 LRU 命中?→ is_image_cached → load_image → load_metadata | ✅ |
| 缩略图 | useThumbnails → update_thumbnail_queue → 后端队列 → thumbnail-generated → rAF 批量刷入 store | ✅ |
| 导出 | ExportPanel → export_images → batch-export-progress → export-complete/error/cancelled | ✅ |
| 导入 | import_files → import-start/progress/complete → 刷新树与列表 | ✅ |
| AI 蒙版 | 面板 → generate_ai_*_mask / queue_ai_jobs → ai-job-result → 合并 subMask.parameters | ✅ |
| AI 去噪 | ai_denoise → progress/ready/error → adjustments 刷新 | ✅ |
| AI 标签 | start_background_indexing → indexing-started/progress/error/finished → 刷新列表 | ✅ |
| 全景/HDR/堆栈 | 触发 → progress/complete 事件 + promise catch 双兜底 → 保存 → 刷新 | ✅ |
| Immich 同步 | immich-sync/upload/library-changed/trash/edits-conflict → useImmichEvents → 刷新/提示 | ✅ |
| 相机联机 | tether_list/connect/capture/preview → TetheringPanel | ✅ |
| 分析订阅 | subscribe_analytics（Channel 二进制）→ 直方图/波形 | ✅ |
| 外部编辑 | external-edit-session 事件 → ExternalEditBar → finish → 覆盖保存 | ✅ |
| 启动 | frontend_ready → LaunchPayload（单实例/文件关联/外部编辑会话恢复） | ✅ |

**事件交叉核对结论**：后端约 50 个 emit 事件全部有前端消费者（本次修复 3 个缺口，见下）；
`hdr-error` / `focus-stack-error` 后端不发（由 promise rejection 兜底，监听器保留无害）；
`focus-stack-report` 为信息性逐帧对齐报告，暂无 UI 消费，保留作调试用途。

---

## 四、本次自检发现并修复的问题（14 项）

### A. 功能链路缺陷（真实行为修复）
1. **缩略图缓存目录建立失败被静默吞掉** — 后端发 `thumbnail-generation-error`，前端从未监听 → 已在 useTauriListeners 接通（console 记录）。
2. **AI 标签索引失败无任何反馈** — 后端发 `indexing-error`，前端未监听且任务徽标不清理 → 已接通：清理任务徽标 + toast 报错。
3. **全景拼接有图片无法匹配时无提示** — 后端发 `panorama-warning`，前端未监听 → 已接通 toast.warning。
4. **copyPasteSettings 兜底对象缺字段** — useAppInitialization 回退时缺 `knownAdjustments`/`autoSync`，与类型不符 → 已补全。

### B. 潜在运行时崩溃修复
5. **useAppNavigation 缓存判空缺口** — `isFrontendCached` 布尔无法收窄 `cached`，12 处解引用 + 缓存回写存在理论 undefined 风险 → 改为 `if (isFrontendCached && cached)`。
6. **useImageProcessing 补丁 URL 释放竞态** — setTimeout 回调里重新读取 `state.interactivePatch.url`，可能为 null → 捕获为局部常量（同时消除 2 处 TS 错误）。
7. **useEditorActions 粘贴设置崩溃风险** — `appSettings.copyPasteSettings` 为可选字段，直接解构 → 增加缺省回退。
8. **useUIStore movePanel/movePanelToIndex 闭包窄化缺陷** — forEach 内赋值 TS 无法追踪（`fromRegion` 被窄化为 null）→ 重写为 `find()`，逻辑等价且消除 2 处错误。

### C. 类型系统修复（使 `tsc --noEmit` 从 60+ 错误归零）
9. **createSubMask 缺返回类型** → 标注 `: SubMask`，修复 MasksPanel/AIPanel 共 10 处蒙版参数赋值错误。
10. **SUB_MASK_CONFIG 缺 Clone/Heal/Liquify/Retouch 键** → 补全 Record 完整性。
11. **蒙版图标映射索引 any** → `as Mask` 收窄（MasksPanel ×2、AIPanel ×2）。
12. **CullingModal 进度类型** — 用 store 真实形状 `{ current, total, stage? }` 替换不匹配的 `Progress`。
13. **framer-motion spring 变体** — `type: 'spring' as const`（SettingsPanel、TaggingSubMenu）。
14. **动态 i18n key / react-window / 图标组件类型** — 沿用仓库既有 `as ParseKeys` 惯例（8 个文件 11 处）；ALBUM_ICONS 改为 `ComponentType<{size?, className?}>`；相册树过滤加类型谓词；react-window `rowComponent` 兼容性转换（CullingView/LibraryGrid）；`invoke<any[]>` 标注（GetPinnedFolderTrees ×2）；`invoke<Record<string, any>>`（AI 蒙版 ×2）。

### 验证结果
- `npx tsc --noEmit`：**60+ 错误 → 0**
- `npm run build`（vite 生产构建）：**通过**（2580 模块）
- `npm run i18n:runtime-check`：**通过**（动态 key 全部存在于 en.json）
- ESLint：改动文件无新增告警（存量 `no-explicit-any` 为仓库既有风格，非本次引入）

---

## 五、遗留事项（不影响当前功能）

1. **Rust 工具链**：`rust-toolchain.toml` 钉住 `1.98`，沙箱镜像最高提供 1.94.1，`cargo check`（1.94.1 + `--ignore-rust-version`）已实测失败，失败点均为环境限制、与仓库代码无关：① 依赖 `sysinfo 0.39.6` 使用不稳定特性 `cfg_select!`，需 rustc ≥1.95；② `build.rs` 需从 HuggingFace 下载 `libonnxruntime.so`，沙箱网络不可达。GTK/webkit 系统库已安装。本次未修改任何 Rust 文件，建议在装有 1.98 且可访问 HuggingFace 的环境跑一次 `cargo check` 复核后端。
2. **主 JS 包 4.8MB**：vite 提示超 500kB，可考虑对 AI 面板/社区页/Immich 等做动态 import 分包。
3. **`hdr-error`/`focus-stack-error`**：前端监听器为冗余（后端以 promise rejection 报错），可择机统一为事件模型。
4. **`focus-stack-report`**：逐帧对齐质量报告事件暂无消费者，可在焦点堆栈结果弹窗中展示逐帧质量信息。
5. **`no-explicit-any`**：前端存在约 300 处存量 any，建议渐进式收紧（重点：IPC 返回值全部加泛型标注）。
