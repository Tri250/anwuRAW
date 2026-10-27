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

## 三、核心功能操作链路（深度自检 · 16 条）

> 第二轮深度自检方法：对每条链路做代码级端到端追踪 —— 前端触发点 → invoke 命令名/参数签名 → 后端 handler → emit 事件与 serde 载荷字段 → 前端监听解构 → store 回写 → UI 复位。
> 全量交叉核对结论：**前端 109 个 `Invokes` 枚举 + 33 处字符串直调命令，全部与 `generate_handler!` 注册表及 Rust 签名匹配（0 断链）**；后端约 50 个 emit 事件的前端解构字段与 serde 序列化逐一比对（含 `rename_all = "camelCase"` 结构），除已修复项外全部一致。

| # | 链路 | 端到端路径（已逐点核实） | 闭环结论 |
|---|---|---|---|
| 1 | 启动初始化 | `frontend_ready` → `LaunchPayload{openWithFile, editSession}`（`rename_all="camelCase"` 已核实）→ useAppInitialization 恢复工作区/根目录/过滤 → `open-with-file`/`external-edit-session` 事件双通道兜底 → useProcessStore | ✅ |
| 2 | 导入 | `import_files({sourcePaths, destinationFolder, settings})` → `import-start{total}` → `import-progress{current,total,path}` → `import-complete`/`import-error` → 刷新文件夹树+当前目录列表 → 进度 UI 5s 复位 | ✅ |
| 3 | 缩略图 | useThumbnails 防抖队列（去重/上限500/机械盘反向排序）→ `update_thumbnail_queue` → `thumbnail-progress{current,total}`、`thumbnail-generated{path,thumbnailPath,previewPath,rating,is_edited}`（immich 同构）→ rAF 批量写 store → `thumbnail-generation-complete/error` 收尾 | ✅ |
| 4 | 评级筛选 | `set_rating/flag/color_label_for_paths` → 侧车写入 → `image-metadata-loaded{path,rating,flag,is_edited,tags,needs_ai}` → 缓冲批写 imageRatings/imageList → FilterCriteria 重算刷新 | ✅ |
| 5 | 文件操作 | 删除（含关联/虚拟副本判定）→ 编辑器内删当前图：下一张→上一张→回图库；图库删：清 selection；重命名/移动后刷新树+列表+当前编辑图重定向 | ✅ |
| 6 | 图库→编辑器 | `is_image_cached` → 前端 LRU（isFrontendCached && cached 已修复）→ `load_image` → `load_metadata` → editor store → 返回图库时 LRU 回写 + blob URL 保护/回收 | ✅ |
| 7 | 预览渲染 | adjustments → 50ms 防抖 → `apply_adjustments`（5 级缓存管线）→ jobId 竞态防护 + `selectedImagePathRef` 归属判定 → finalPreviewUrl/interactivePatch；裁剪视图走 `generate_uncropped_preview` invoke 返回值（throttle 30ms + jobId 防护） | ✅（本轮删除该链路遗留的死事件监听，见修复 15） |
| 8 | 缩放 HiFi | calculateTargetRes（DPR/原始尺寸封顶/256 对齐）→ `requestHiFiZoom` 防抖 → 只升不降（targetRes > currentRes 才渲染）→ 对比模式退出时 `release_original_preview` + originalPreview 释放 | ✅ |
| 9 | 蒙版编辑 | MasksPanel 容器/子蒙版 → `adjustments.masks` → backendPayload 序列化（patchesSentToBackend 去重）→ mask_generation 位图 → 补丁回传；删除蒙版清理 activeId + 取消 AI 任务 | ✅ |
| 10 | AI 蒙版 | 直接路径：`generate_ai_{subject,foreground,sky,text,face}_mask` 参数逐一比对签名 ✅；`generate_ai_depth_mask`（minDepth/maxDepth/minFade/maxFade/feather）✅；队列路径：`queue_ai_jobs` → `ai-jobs-status{failed}` / `ai-jobs-pending{added,removed,resolved}` / `ai-job-result{path,subMasks,maps,noResults}` → 合并 subMask.parameters；错误路径 toast + finally 注销任务 | ✅（本轮修复排队入口无 catch，见修复 16） |
| 11 | AI 去噪 | `ai-denoise-progress{path,progress}` / `ai-denoise-ready(path)` / `ai-denoise-error{path,error}` 字段逐一比对 ✅ → 进度表增删 + 当前图 adjustments 刷新；错误时 `aiDenoiseEnabled=false` 防止反复失败 | ✅ |
| 12 | AI 标签 | `start_background_indexing` → `indexing-started/progress{current,total}` → 任务徽标（startJob/updateJob）→ `indexing-finished` 置 Success + 刷新列表；`indexing-error` 清徽标 + toast；`indexing-cancelled` 清徽标 | ✅ |
| 13 | 合成工具 | `stitch_panorama`/`merge_hdr`/`stitch_focus_stack` → `*-progress`/`*-complete{base64[,depthMap]}`/`*-error`/`panorama-warning`（载荷字段逐一比对 ✅）→ promise catch 双兜底 → 保存命令 → 刷新列表 → 模态复位 | ✅ |
| 14 | 导出 | `export_images` 8 参数逐一比对 ✅ → `batch-export-progress{current,total,path}` → `export-complete/error/cancelled/cancelling` → setExportState 5s 自动复位 + 任务中心 syncStatusJob；取消链路 handleCancel→`cancel_export`→失败回滚 Exporting | ✅ |
| 15 | Immich 同步 | `immich-download{path,state,error}` / `immich-sync` / `immich-upload` / `immich-library-changed`(1.5s 防抖刷新) / `immich-trash{error}` / `immich-edits-fetched{path,rating}` / `immich-edits-conflict{path,fileName}` 全部字段比对 ✅；关窗前 flushImmichEdits 确认框 | ✅ |
| 16 | 相机联机 | `tether_list/get_settings/connect/set_setting/capture/get_preview/autofocus` 7 命令全注册 ✅（无事件，invoke 轮询模型）；相机拔出由轮询+调用失败双检测 → handleDisconnect 复位 UI + toast | ✅ |
| 附属 | 外部编辑 | `external-edit-session{source,output,format,jpegQuality}`（camelCase 已核实）→ ExternalEditBar → finish → 单张 export → Success 后 exit(0)，Error/Cancelled 复位 isFinishing | ✅ |
| 附属 | 分析订阅 | `subscribe_analytics`（Channel 二进制）→ 序列号防乱序 + path 归属判定 → histogram/waveform 写 store | ✅ |

**本轮深度自检额外结论（有证据、经评估不构成缺陷）**：
- `hdr-progress` 监听强制 `isOpen: true`：合并任务仍在后台运行时把结果带回给用户属合理恢复行为，与 panorama 的守卫语义一致。
- `hdr-error`/`focus-stack-error` 前端监听器冗余（后端以 promise rejection 报错）：防御性保留，无害。
- `focus-stack-report`：逐帧对齐质量调试信息，保留。
- 事件中枢 useEffect 清理（`listeners.forEach(unlisten)`、rAF/计时器取消、缓冲区清空）逐项核实无泄漏。

---

## 四、自检发现并修复的问题

### 第一轮（14 项）

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

### 第二轮 · 16 链路深度自检（3 项）
15. **`preview-update-uncropped` 死事件监听（链路 7）** — useTauriListeners 订阅了该事件并把 payload 直接当 URL 写入 store，但 Rust 全仓库无任何 emit（裁剪预览实际走 `generate_uncropped_preview` invoke 返回值模型）。监听器与现有数据流矛盾、属旧事件模型遗留 → 已删除并留注释说明真实数据流。
16. **AI 任务排队入口无错误反馈（链路 10）** — LibraryHeader「Process images」按钮 `invoke(queue_ai_jobs)`（后端 `async fn -> Result<(), String>`）无 catch，排队失败时产生 unhandled rejection、用户点击无任何反应 → 已补 `.catch` + toast.error。
17. **AI 连接器状态轮询无 catch（附属加固）** — App.tsx 启动即调 + 每 10s 轮询 `check_ai_connector_status`，invoke 失败（如 WebView 重载竞态）时产生未处理 rejection → 两处调用均已补 `.catch(console.error)`。

### 验证结果
- `npx tsc --noEmit`：**60+ 错误 → 0**（两轮修复后保持 0）
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
