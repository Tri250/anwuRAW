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

## 五、空实现/模拟实现/简化实现专项排查（100% 覆盖）

> 方法：特征扫描（TODO/FIXME/todo!/unimplemented!/mock/stub/placeholder/空函数体/空命令体/硬编码返回/永久禁用）+ 逐模块人工核实（前后端全清单）。

**结论：全清单核查未发现空实现、模拟实现或功能性简化实现；本轮新增修复 1 项可观测性微优化。**

### 5.1 特征扫描结果（全部核实为非缺陷）
- 前端：TODO/FIXME/mock/占位数据 0 命中；`disabled={true}` 硬编码 0 命中。
- 后端：`todo!()/unimplemented!()` 0 命中；无空命令体、无硬编码空返回（4 处 `Ok(Vec::new())` 均为文件不存在/空输入的合理处理：albums/presets/rename/LUT 缓存）。
- 后端 41 处 `placeholder` 命中全部属于 **Immich/iCloud 云占位文件体系**（未下载原片的占位符与占位缩略图），为设计功能。
- 2 处 FIXME 均为上游调优决策：`exif_processing.rs:1463`（TIFF 格式导出跳过元数据写入——上游 little_exif 库暂不支持 TIFF 写入，见 5.3）、`culling.rs:130`（分析缩放尺寸选择，算法参数而非功能缺失）。

### 5.2 前端 20 处空函数逐一裁决（全部合理）
| 位置 | 用途 | 裁决 |
|---|---|---|
| useCloudStore `routerPush/Replace: () => {}` | tauri-plugin-clerk 要求的 router 适配器，桌面 SPA 无客户端路由 | ✅ 桌面适配器标准用法 |
| useAppContextMenus 8 处 `onClick: () => {}` | 右键菜单「取消」项，语义即关闭菜单 | ✅ |
| SettingsPanel onConfirm 默认值 + router 透传 | 可选回调默认参数 | ✅ |
| Editor `handleWbPicked` | 白平衡拾取完成通知钩子；实际应用逻辑在 ImageCanvas 内部（setAdjustments 温度/色调） | ✅ |
| Editor syncWgpuRef 初始值 / BottomBar、Slider、CollapsibleSection 默认 props | ref 惰性初始化 / 可选回调默认参数 | ✅ |
| CullingView `onLoad={NOOP}` | img 加载事件占位，时序处理在别处 | ✅ |

### 5.3 重点深查记录
1. **`originalFolderDummy`（ExportPanel→Rust）**：前端占位协议值；后端按 `destination_type == "originalFolder"` 分支用源文件父目录输出并创建子目录（export_processing.rs:1831-1856），`output_folder_or_file` 在该模式下被忽略——链路闭环，非断链。
2. **参数化曲线（parametricCurve）**：Rust 仅消费 `curves` 点数组，但前端 parametric 编辑时同步**烘焙成点曲线**写入 `curves`（Curves.tsx:358-361），`parametricCurve/curveMode/pointCurves` 仅作 UI 模式记忆与复制粘贴清单——渲染闭环。
3. **调整参数四层接线（Adjustments 接口 ↔ payload ↔ Rust 消费 ↔ 渲染管线）**：逐字段核对无孤儿参数——全局 35+ 字段（exposure…vignette/grain/CA/sharpness+Threshold）、creative 三件套（glow/halation/flare）、四通道曲线、HSL、colorGrading/colorCalibration/toneMapper、LUT 六字段、AI 降噪四字段（ai_denoise.rs）、负片六字段（negative_conversion.rs）、lensBlur/relight/fog（独立模块 + 深度图/法线图生成命令已注册）、几何/变换（get_geometry_params_from_json）、lensfun（缩略图管线 lensMaker 解析）、白平衡（LMS 矩阵）、baselineExposure（并入 exposure）、蒙版/aiPatches（mask_generation 管线）。
4. **Clerk 云认证链路**：App.tsx 启动 initAuth → SettingsPanel 四态 UI（ready/unavailable/unsupported/loading）→ getToken → fetchUsage 配额（仅 cloud+登录+Pro）→ 云端 inpaint `bearer_auth(token)`（ai_connector.rs:138-174）→ Rust 仅桌面平台注册插件 + capabilities 域名放行——完整闭环。
5. **Immich 命令覆盖**：前端 ImmichInvokes 10 项 = 后端注册 10 项，一一对应。
6. **Relight/LensBlur/Fog 面板**：全部滑块经 Effects.tsx + ImageCanvas（画布拖放光源）写入 adjustments，后端 enabled+map 门控消费——接线完整。

### 5.4 本轮修复
18. **TetheringPanel 重影预览静默吞错**（[TetheringPanel.tsx:315](file:///workspace/src/components/panel/right/TetheringPanel.tsx#L315)）— `.catch(() => {})` 改为 `console.warn`，失败可排查（功能本身不卡死，URL 清理逻辑正确）。

### 5.5 已知上游限制（非代码缺陷，如实记录）
- **TIFF 导出不嵌入 EXIF/XMP 元数据**（exif_processing.rs:1463 上游 FIXME）：little_exif 库暂不支持向 TIFF 写入元数据。JPEG/PNG/WEBP 均正常写入。若需修复须引入 TIFF 重写方案（重 TIFF 结构），属上游功能开发范畴。
- **culling 对焦分析在 720px 缩略图上计算**（culling.rs:130）：上游权衡，非功能缺失。

## 六、功能性自检：缓存失效 + hooks 竞态 + store 逻辑（第四轮）

> 维度：① 后端 5 级缓存失效正确性（cache key 漏字段=调参无效）；② react-hooks 依赖数组/闭包竞态（仓库 eslint 未启用 react-hooks 规则，此类缺陷从未被检测）；③ store action 逻辑。

### 6.1 后端缓存失效核查（通过）
- `calculate_transform_hash`（cache_utils.rs:285）完整覆盖 orientation/rotation/flip、lensBlur 全参（含深度图）、relight 全参（含法线图）、fog 全参（含深度图）、crop、GEOMETRY_KEYS 18 项、aiPatches、AI 去噪（含 cache_epoch）、负片转换——无失效缺口。
- `DecodedImageCache` 指纹含文件 len/mtime + 5 项 RAW 解码设置（cache_utils.rs:498-523），联机拍摄同名文件复用与 RAW 设置变更均已防护。
- `DecodeFlights` 并发去重 Leader/Follower + Drop 唤醒（含 panic 路径）正确。

### 6.2 react-hooks 深度扫描与裁决（51 条告警逐一裁决）
启用 `eslint-plugin-react-hooks`（--no-save 临时安装）全量扫描 hooks/App/components，**修复 7 处真实缺陷，裁决 44 处为刻意设计**：

**修复（真实功能缺陷）：**
19. **ImageCanvas 三事件回调闭包过期**（[ImageCanvas.tsx:2686](file:///workspace/src/components/panel/editor/ImageCanvas.tsx#L2686)/2974/3207）——`handleMove`/第二回调/`handleUp` 缺 `uncroppedImageRenderSize`、`isAiSubjectActive`、`mapUvToScreen`、`t` 依赖：透视辅助线拖动、AI 主体蒙版点击定位可能使用陈旧尺寸/映射 → 已补齐。
20. **App renderAppPanel 持过期导航回调**（[App.tsx:792](file:///workspace/src/App.tsx#L792)）——TetheringPanel 的 `onImageSelect`/`onLibraryRefresh` props 未列入依赖，联机拍摄点击缩略图可能用旧选择器 → 已补。
21. **ExportPanel 预估不随目的地/子文件夹刷新**（[ExportPanel.tsx:569](file:///workspace/src/components/panel/right/ExportPanel.tsx#L569)）——`destination`/`subfolder` 缺失；水印宽高比探测 `isPanelReallyActive` 缺失（面板激活后不取尺寸）→ 已补。
22. **LibraryGrid 列表行高不随列宽刷新**（[LibraryGrid.tsx:495](file:///workspace/src/components/panel/library/LibraryGrid.tsx#L495)）——gridData useMemo 只依赖 `listColumnWidths.thumbnail`，实际还读 shutter/aperture/iso/focal/name/date/rating/color 与 `showExifCols`（行高计算 433-437 行）→ 调整列宽/开关 EXIF 列后行高滞留旧值，已补 9 项依赖。
23. **LibraryGrid 滚动位置恢复可能失效**（[LibraryGrid.tsx:570](file:///workspace/src/components/panel/library/LibraryGrid.tsx#L570)）——恢复 effect 依赖缺 `gridData`：首次进入文件夹时 gridData 晚于 effect 就绪则 savedTop 不应用 → 已补。
24. **右键菜单自动操作闭包过期**（[useAppContextMenus.ts:408](file:///workspace/src/hooks/useAppContextMenus.ts#L408)/932）——编辑器与缩略图右键菜单缺 `handleAutoLensCorrection`/`handleAutoStraighten(Paths)`/`handleEnableAdjustments` → 已补。
25. **FolderTree 每 render 重建派生对象**（[FolderTree.tsx:744](file:///workspace/src/components/panel/right/FolderTree.tsx#L744)/750）——`openSections`（`?? ['current']`）与 `folderTreeSort`（`|| {...}`）每 render 新引用，导致 filteredTrees/filteredPinnedTrees useMemo 与分区 effect 每 render 重算（大目录树性能浪费）→ 改为 useMemo 稳定引用。

**裁决为刻意设计（44 条，不修）：** store setter（zustand 稳定引用）/ref 依赖省略（useImageProcessing 核心调度带 eslint-disable 的 14 项精确列表）、版本号失效技巧（Filmstrip ratioMapVersion、Editor overlayTriggerHash 完整序列化蒙版参数并依赖 adjustments）、输入保护（AIPanel/MasksPanel prompt 仅在容器/蒙版切换时同步，防输入中被覆盖）、精确字段依赖（useImageLoader selectedImage?.path）、value 派生索引（LibraryHeader selectedIndex）、debounce 稳定实例（usePresets）、Slider 动画（displayValue 同步另有专门 effect）、初始化单次 effect（useAppInitialization/SettingsPanel）。

### 6.3 store 抽查（通过）
6 个 store 的 setter 均为 zustand 稳定引用；useUIStore/useLibraryStore/useProcessStore 的 action 在前几轮已审查（movePanel 窄化修复、任务徽标生命周期、缩略图批量写入）。

### 6.4 验证
- `npx tsc --noEmit`：**0 错误**
- `npm run build`：**成功**（2580 模块；期间发现并修复了 --no-save 临时安装导致的 `@babel/runtime` 传递依赖缺失，package.json/lock 未变动）
- `npm run i18n:runtime-check`：**通过**
- react-hooks 复扫：51 → 40 条，余量全部为已裁决的刻意设计

### 验证结果（历史）
- `npx tsc --noEmit`：**60+ 错误 → 0**（两轮修复后保持 0）
- `npm run build`（vite 生产构建）：**通过**（2580 模块）
- `npm run i18n:runtime-check`：**通过**（动态 key 全部存在于 en.json）
- ESLint：改动文件无新增告警（存量 `no-explicit-any` 为仓库既有风格，非本次引入）

---

## 七、调整模块（Adjustments）专项自检（第五轮 · 100% 覆盖）

范围：5 大分区 20 个子分区约 90 个参数（Basic/Curves/Color/Details/Effects + AdjustmentSection/AdjustmentSubSection + adjustments.ts + defaultAdjustments.json）。

### 7.1 全链路逐字段核对（通过）

- **全局路径**：`Adjustments` 接口 ↔ `prepareAdjustmentsPayload`（backendPayload.ts，effect map `__cached__:` 去重 + patchData 按需发送）↔ Rust `get_global_adjustments_from_json`。Rust 侧全部 `get_val(tool, key)` 的 tool 名与前端 `ADJUSTMENT_SECTION_TOOLS` id（basic/colorPresence/hue/presence/sharpening/noiseReduction/chromaticAberration/creative/vignette/grain/lut/curves/colorGrading/colorMixer/colorCalibration）一一对应；`is_tool_active` 的 `unwrap_or(true)` 语义与前端 `activeTools[tool] !== false` 一致。
- **独立模块路径**：AI 降噪（ai_denoise.rs：enabled/method/amount/detail + 哈希入 cache_utils）、负片转换（negative_conversion.rs PARAM_KEYS）、镜头模糊（lens_blur.rs 全 8 参数 + 深度图）、重打光（relight.rs lights 数组 + 法线图）、雾效（fog.rs 全 10 参数）全部有消费点，无死字段。
- **蒙版路径**：`get_mask_adjustments_from_json` 读取的 MaskAdjustments 字段与蒙版面板 isForMask 分支完全吻合（centré/CA/负片/空间效果按设计对蒙版隐藏）。
- **镜头模糊深度语义三方自洽**：UI DepthRangePicker 镜像映射（显示近/远方向 = `100 - 存储 blur band`）↔ 存储值 ↔ Rust `depth_to_signed_coc`（低 d=远景模糊、`max_depth+max_fade` 近景模糊、中间为清晰带），含两侧 fade 与重置默认值（20/100/20/20）全部往返一致。
- **默认值/重置**：defaultAdjustments.json 与所有 Slider `defaultValue`（双击重置）逐一比对一致；Basic 七滑块缺省 defaultValue=0 恰为正确默认；ToneMapperSwitch/BokehShapeSwitch/DepthRangePicker 标签点击重置逻辑正确。
- **复制粘贴/预设**：ADJUSTMENT_GROUPS 覆盖全部可复制字段（含 curves/pointCurves/parametricCurve/curveMode、colorCalibration、负片 6 字段）；`areSectionPropsEqual` 按 SECTION_KEY_OWNERS 分区精准 memo，无漏更新。
- **auto-adjust**：`CalculateAutoAdjustments` 结果经 `mergeActiveTools` 合并，不破坏工具开关状态。

### 7.2 修复（1 项）

26. **LUT 强度为 0 时 UI 显示错误**（Effects.tsx）：`lutIntensity={adjustments.lutIntensity || 100}` 在用户把强度拖到 0 时回退显示 100（实际已生效 0=关闭 LUT），改为 `?? 100`。同文件其余 `??` 回退值与 defaultAdjustments.json 一致。

### 7.3 裁决记录（非缺陷）

- Color.tsx `adjustments.vibrance || 0` 等 3 处：0 即默认值，回退无副作用。
- Curves.tsx `handleMove` effect 依赖 `[draggingPointIndex, draggingSplitKey, isParametricMode]`：拖拽期数据全部经 ref（localPointsRef/parametricCurvesRef/activeChannelRef）传递，闭包不读陈旧 state。
- `parametricCurve` 双写策略（前端烘焙进 `curves` 点数组）已验证闭环；模式切换 point↔parametric 经 `pointCurves` 暂存往返无丢失。
- `lensBlurAmount ?? 50`（json 默认 40）：normalizeLoadedAdjustments 保证字段恒存在，回退不可达，保持原样。

### 7.4 验证

- `npx tsc --noEmit`：**0 错误**
- `npm run build`：**成功**（沙箱重置导致 node_modules 丢失，已完整重装 394 包后构建通过）
- `npm run i18n:runtime-check`：**通过**（仅存量复数回退提示，非错误）

---

## 八、大师配方 / 胶片配方集成（本轮 · 移植自 RawLab）

来源：https://github.com/Tri250/koudaixiangce（RawLab，GPL-3.0-only）。本仓库 AGPL-3.0 与其兼容，署名见 `src-tauri/resources/licenses/RawLab-NOTICE.md`。

### 8.1 资源
- `public/master-recipes/*.png`：14 张 256×256 配方插图，文件名与配方 id 一一对应。
- `src/utils/masterRecipes.json`：14 条配方目录（与 RawLab `Shared/master-recipes.json` 逐字节等价）。
- `src-tauri/resources/film_luts/大师·*.cube`：14 个 33-grid LUT（由 RawLab 65-grid 降采样，头部标注 `Gamma: sRGB to sRGB`）。

### 8.2 前端
- `src/utils/masterRecipes.ts`：`recipeToAdjustments` 统一量纲换算——`exposure / 0.8`（滑块 ±5 ↔ ±4 EV）、`tint / 1.5`（相对单位 ↔ tint 计数）、HSL 八通道（红橙黄绿青蓝紫洋红 ↔ reds…magentas，±100 同量纲）；`resolveMasterLutPath` 按 `大师·<name>` 精确匹配并模糊回退。
- `src/components/modals/MasterRecipesModal.tsx`：双 Tab（大师配方 / 胶片配方）。大师 Tab 为 14 配方网格，点击应用 6 个控件 + 24 个 HSL + LUT；强度滑块 0–200% 同步缩放全部参数与 `lutIntensity`；再次点击同一配方回滚到应用前快照。胶片 Tab 复用 `LUTControl`。
- 入口：`PresetsPanel` 头部工具栏新增 `Sparkles` 按钮（`editor.masterRecipes.openTooltip`），弹窗挂载于面板内。

### 8.3 后端与色彩空间修正（含既有缺陷）
- `lut_processing.rs`：`LutEntry` / `LutPreviewRequest` 新增 `is_scene_referred`；新增 `detect_lut_is_scene_referred` 读取文件头 12 行，含 `Gamma: sRGB to sRGB` 判为 display-referred（tone mapping 之后应用），否则视为 log 编码（tone mapping 之前采样）。
- **修复既有缺陷**：原前端把所有内置 LUT 一律按 `isBuiltIn → lutIsSceneReferred=true` 处理，导致 `大师·*.cube` 这类 display-referred LUT 在 tone mapping 前被错误采样（偏色/对比异常）。现由文件头判定并经 `LutEntry`、`generate_lut_previews` 透传，`LUTControl` / `useEditorActions` 的第二参数由 `isBuiltIn` 改为 `isSceneReferred`。
- LUT 强度上限由 100 提升到 200（`MAX_LUT_INTENSITY`），与配方强度语义一致。

### 8.4 验证
- `npx tsc --noEmit`：**0 错误**
- `npm run build`：**成功**（2583 模块；`dist/master-recipes/` 含 14 张插图）
- `npm run i18n:runtime-check`：本轮新增 `editor.masterRecipes` 无告警；脚本仍报 198 条**存量**复数回退问题（ca/cs/es/fr/pl/pt/ru 的 `_few`/`_many` 解析回退 en），与本轮改动无关
- `cargo check`：**未执行成功**——`rust-toolchain.toml` 钉住 1.98，沙箱镜像最高 1.94.1 且 1.98 包 404（环境限制，见第九节）

---

## 九、遗留事项（不影响当前功能）

1. **Rust 工具链**：`rust-toolchain.toml` 钉住 `1.98`，沙箱镜像最高提供 1.94.1，`cargo check`（1.94.1 + `--ignore-rust-version`）已实测失败，失败点均为环境限制、与仓库代码无关：① 依赖 `sysinfo 0.39.6` 使用不稳定特性 `cfg_select!`，需 rustc ≥1.95；② `build.rs` 需从 HuggingFace 下载 `libonnxruntime.so`，沙箱网络不可达。GTK/webkit 系统库已安装。第八节已修改 `lut_processing.rs`（新增 `is_scene_referred` 字段与文件头判定），需在装有 1.98 且可访问 HuggingFace 的环境跑一次 `cargo check` 复核后端。
2. **主 JS 包 4.8MB**：vite 提示超 500kB，可考虑对 AI 面板/社区页/Immich 等做动态 import 分包。
3. **`hdr-error`/`focus-stack-error`**：前端监听器为冗余（后端以 promise rejection 报错），可择机统一为事件模型。
4. **`focus-stack-report`**：逐帧对齐质量报告事件暂无消费者，可在焦点堆栈结果弹窗中展示逐帧质量信息。
5. **`no-explicit-any`**：前端存在约 300 处存量 any，建议渐进式收紧（重点：IPC 返回值全部加泛型标注）。
