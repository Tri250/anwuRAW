# v2.0 全量执行登记册（P0/P1/P2 55 项）

- **来源**: docs/v2.0-submodule-upgrade-plan.md（四层规划体系的执行层）
- **状态约定**: `todo` → `doing` → `done`（附验证）；每项完成必须保持 `cargo test --features golden-tests`（131）与 `npm test`（73）全绿
- **波次规则**: P1 项不得早于其前置 P0 项验收启动（规划 F5 规则）

## W1 工程门禁硬化（A1-A5）

| ID | 项 | 状态 | 验证 |
|---|---|---|---|
| A1a | lint.yml 三处 continue-on-error 移除（format/i18n 即刻硬化） | done | workflow lint 全绿 |
| A1b | eslint 基线棘轮（存量 873 错误不许增长，新增即红） | done | scripts/eslint-ratchet.mjs 入 CI |
| A1c | Android 签名硬校验：release 路径缺 secrets 即失败，仅 artifact 构建允许 debug keystore | done | build.yml exit(1) 逻辑 |
| A2 | i18n:check 硬门禁（并入 A1a 同一步） | done | 13 语言 448 空串兜底 |
| A3 | 资产版本戳（lensfun_db/film_luts/ICC manifest + sha256 校验测试） | done | asset_manifest.json + 3 单测 |
| A4 | ORT 运行时版本固定 + sha256（并入 A3 manifest，SBOM 产出） | done | 同上 |
| A5 | formats.rs 扩展名注册表数据化 | done | 3 单元测试 |

## W2 数据层（B1-B4）

| ID | 项 | 状态 | 验证 |
|---|---|---|---|
| B1 | ImageMetadata v2 + .rrdata 迁移链（v1→v2 无损） | done | metadata_migration 4 读取点接入 |
| B2 | app_settings v2 版本化迁移 | done | 3 迁移单测 |
| B3 | SQLite 图库索引层（AR-4，rusqlite，可牺牲性设计） | done | library_index 3 单测 |
| B4 | tagging 改为索引查询消费 + 层级懒加载 | todo | 依赖 B3 |

## W3 引擎 AR-2（C1-C3）

| ID | 项 | 状态 | 验证 |
|---|---|---|---|
| C1 | 展示路径 CPU 算子退役（缩略图/命令路径 → GPU + lavapipe 兜底）；合成域输入预处理保留为唯一例外（重命名为 raw input prep，脱离"双实现"语义） | done | 缩略图 GPU 分支接管未编辑/无 metadata；CPU AGX 删除（-123 行）；apply_raw_input_prep 重命名 + 禁用文档 |
| C2 | 一致性 harness 改造：AGX 对退役（CPU 参照消失）、raw_default 转 input-prep 一致性单测 | done | contract_consistency.rs 删除；input_prep_contract_tests 6 项单测（锚点/钳制/单调/转换/确定性/公式） |
| C3 | 参数解析强类型 schema 化 + adjustment_utils 收编 + 默认值与 param_matrix 单源 | done | param_matrix 升级生产 schema；SCALES → LazyLock 注册表派生（零字面量）；default_of 全量接入；几何链已由 apply_all_transformations 收编（缩略图 scaled 变体注释保留） |

## W4 渲染会话（D1-D3）

| ID | 项 | 状态 | 验证 |
|---|---|---|---|
| D1 | RenderSession 优先级队列（主视图/缩略图/批量）+ 取消 | done | render_scheduler.rs 三级让路（主视图 mark_interactive 400ms 窗口/缩略图/批量 wait_slot）；取消 token 优先；6 项自动化断言；AppState/主视图/缩略图/导出四路接线 |
| D2 | 后端选择策略：vulkan→lavapipe→GL→明确报错；P3 补丁移除 | done | gpu_backends.rs 策略核（10 项单测：硬件优先/软件回退提示/GL 兜底/空列表可操作报错/强制后端校验）；gpu_processing 三阶段接入；P3 补丁（wgpu 降级钉版）按规划随色彩中枢 wave 移除 |
| D3 | channel_mixer/split_toning 收编为 Engine PostStage | done | render_case 收编 apply_post_gpu_adjustments（既有案例精确恒等）；poststage_cases 5 例（矩阵/单色/双向/门控恒等/复合）；快照矩阵 366→371 |

## W5 命令分域（E1-E3）

| ID | 项 | 状态 | 验证 |
|---|---|---|---|
| E1 | commands/ 8 域 façade 注册（engine/library/files/metadata/ai/export/compose/system） | done | 130 命令分域注册；跨模块命令函数 pub use + `__cmd__`/`__tauri_command_name` 宏按定义模块相对路径重导出；本文件命令宏由 #[tauri::command] 自动导出（E0252 根因：手动重导出与自动导出冲突） |
| E2 | file_management 四拆（library_scan/thumb_service/file_ops/metadata_repo） | done | 四子模块 pub mod；跨模块 helper pub(crate)；mask_generation/export_processing/thumb_service/inpainting/tagging 路径修正 |
| E3 | lib.rs 装配化 < 400 行 | done | 269 行（原 2546）：mod 声明 + 全局分配器 + run()（builder/setup/manage/invoke_handler/RunEvent）；遮蔽警告清理（私有 use 改完整路径） |

## W6 平台收敛（F1-F2）

| ID | 项 | 状态 | 验证 |
|---|---|---|---|
| F1 | platform/ 抽象层收编 android_integration（业务模块 cfg 清零，grep 审计） | todo | grep 审计脚本 |
| F2 | launch_request CLI 参数表测试化 | done | 3 单测锁定语义 |

## W7 AI 运行时（G1-G5）

| ID | 项 | 状态 | 验证 |
|---|---|---|---|
| G1 | model_manifest schema 版本化 + sha256 完整性 + 差异更新 | done | integrity.rs：SUPPORTED_MANIFEST_VERSION 对齐校验（embedded 加载即断言）；file_sha256 流式哈希 + verify_file；diff_local_models 三态扫描（Missing/Intact/Corrupted）；6 项单测（版本对齐/三态判定/标准向量/校验语义/空目录全 Missing/损坏检出） |
| G2 | ai_processing 收敛为 CapabilityAdapter 层 | done | CapabilityAdapter 注册表（7 能力→模型 id 单一数据源）+ ALL_CAPABILITIES；capability_model_ids 并集驱动 get_or_init_ai_models 下载列表；ensure_capability_models 惰性下载 + missing_models 预检；3 项接口单测（manifest 对齐/并集去重保序/get+missing 语义）。Session 全量惰性化登记为后续增强 |
| G3 | ai_acceleration EP 策略表数据化 + 运行时自动降档 | done | HardwareEp 枚举 + platform_ep_candidates 策略表（android=NNAPI/macos=CoreML/桌面空）替代 cfg 散落；build_session 硬件 commit 失败自动降档 CPU 重试 + LAST_DEGRADED 记录；should_retry_on_cpu 纯函数；2 项单测（候选表平台断言/降档决策） |
| G4 | ai_commands 拆分管理/能力；ai_connector 可选化（默认关闭） | done | ai_commands/ 目录化：capability（6 蒙版/深度命令+几何缓存哈希复用）/management（下载状态+显式下载）/connector（状态查询+连接测试），mod.rs 汇聚保外部路径不变；遗留 cloud 分支删除（inpainting 110 行 + process_cloud_inpainting/CloudInpaint*），token 死参数移除（前端两处调用均未传）；依赖图审计：ai_connector 收敛至 connector.rs + inpainting 自建服务器分支，settings 默认 None 即默认关闭 |
| G5 | inpainting/denoising 大图 tile 化 | done | denoising 既有 tile 化（TileParams/mirror/seamless）确认在位；lama 新增 tile 化：lama_tile_origins 覆盖纯函数 + run_lama_tile 单 tile 提取（≤768 走原路径恒等）+ lama_inpaint_tiled（768/64 重叠/32 羽化，mask×边缘窗加权融合，边缘 mask 回退 tile 原输出，替代整体下采样保原分辨率细节）；3 项纯函数单测 |

## W8 导出与合成（H1-H4）

| ID | 项 | 状态 | 验证 |
|---|---|---|---|
| H1 | ExportJob 队列（暂停/续跑/失败清单）+ 编码器注册表（格式×色深×ICC 校验） | done | export_queue.rs 纯状态机 11 单测（100 项中断续跑/失败清单/陈旧任务落账/暂停取消竞态）；export_encoders.rs 注册表 13 单测（格式×色深×ICC 校验/编码魔数/APP13 替换/色彩空间恒等）；4 新命令 pause_export/resume_export/retry_failed_exports/get_export_job_status；export_images_impl 接线（派发前暂停检查点+成败登记+落账）；export_with_icc_and_depth 注册表前置校验 fail fast；ExportBitDepth 死类型删除 |
| H2 | DNG/HDR 导出扩展点 + CLI 共用同一 Job | done | export_encoders.rs 扩展编码层（EXR 32-bit float RGB 归档 / DNG 显式未实现扩展点 / save_hdr 格式扩展 png-tiff-exr），编码器注册表累计 20 单测；CLI/GUI 共用 export_images_impl 队列与参数构造，编码确定性 byte 一致契约锁定 |
| H3 | ComposeJob 队列统一四合成模态 | done | compose_queue.rs 纯状态机 12 单测（阶段表驱动进度/取消检查点/重试计划/单活跃任务）；Hdr/Panorama/FocusStack 管线接入 ComposeJobHandle，MultiExposure 协议预留位；新增 cancel_compose_job/get_compose_job_status 命令 |
| H4 | hdr_deghosting/multi_exposure 共享对齐核；focus_stacking ROI 加速 | done | alignment_core.rs 共享对齐核（detect_frame_features/align_frame_to_reference 单实现），hdr_deghosting 改造为消费者删除约 160 行重复实现；focus_stacking ROI 加速（estimate_coarse_shift 缩图 SAD → alignment_rois 候选窗口 → 窗口内金字塔求解全幅坐标系 → 低质量窗口内 identity 重试仍失败回退全幅），roi_tests 5 单测（粗位移恢复/ROI 性质/与全幅对齐等价 t<1px/耗时基准 ROI ≤ 0.7× 全幅） |

## W9 前端（I1-I8）

| ID | 项 | 状态 | 验证 |
|---|---|---|---|
| I1 | useProcessStore 渲染状态机（单数据流，双入口清零） | done | composeRuns 状态机（panorama/hdr/focusStack/multiExposure 预留）：beginCompose 返回单调 epoch，trackComposeMessage/composeSettled epoch+phase 双重守卫（迟到事件丢弃、done/error 不可逆写、保存失败 done→error 有意覆盖）、resetCompose 关闭失效；动作入口（useProductivityActions）/事件入口（useTauriListeners 六监听器）/关闭路径（AppModals+useAndroidBackHandler）全部收敛；uiStore 三模态删除 isProcessing/progressMessage/error 字段；竞态测试 composeRuns.test.ts 8 例 |
| I2 | 7 个业务 hooks 下放 store（单文件 <150 行） | done | 7 hooks 全部 <150 行（9-102 行）：useImageProcessing→store/renderEngine、useAiMasking→services/aiMaskingService、useExportSettings→store/useExportStore、usePresets→store/usePresetStore、useFileOperations/useLibraryActions/useProductivityActions→services/*Service；依赖经 appServiceRegistry 注册（7 槽位 fail-fast），渲染链路仅存于 store；3 处 usePresets(adjustments) 调用方去参；服务行为测试 services.test.ts 12 例；tsc 0 错 / vitest 93 绿 / cargo 217 绿 / 棘轮 873→871 自动收紧 |
| I3 | 图库虚拟化 10 万张 + 索引数据源消费（依赖 B3） | done | 掉帧断言：100k 挂载/滚动节点有界(<200)+耗时预算内；索引语义与本地过滤 15 例对齐 |
| I4 | AIPanel 模型状态中心（装/下载/更新全程 UI） | todo | 组件测试 |
| I5 | ExportPanel 新参数 UI（ICC/色深/DNG/队列进度） | todo | 与 CLI 一致断言 |
| I6 | 蒙版树 UI（40 容器导航/命名）+ Waveform 点选取样载体 | todo | 组件测试 |
| I7 | UI 基元 a11y 全量（axe 零 critical）+ Slider 触控 | todo | axe 扫描 |
| I8 | JobProgress 统一组件（四合成模态共用） | todo | 依赖 H3 |

## W10-12 功能与设施（J1-J4 / K1-K3 / P2 池）

| ID | 项 | 状态 | 验证 |
|---|---|---|---|
| J1 | LutStore 服务化（缩略图缓存/搜索/版本化） | todo | 100 LUT 基准 |
| J2 | culling 键盘全流程 + A/B 对比 | todo | 快捷键演练 |
| J3 | metadata_repo 单一入口 + XMP sidecar 策略 + 批量编辑 | todo | Lightroom 往返种子 |
| J4 | 负片参数预设化 + 预设版本元数据 | todo | 往返一致 |
| K1 | session harness（import→edit→export 黄金用例 ≥10） | todo | cargo test |
| K2 | migration harness（.rrdata 种子 ≥1000 回放） | todo | 依赖 B1 |
| K3 | bench 4 场景 CI 性能报告 job | todo | artifact |
| P2 池 | BeforeAfter 分割线/放大镜、CompositionOverlays 自定义参考线、ControlsPanel 搜索、CropPanel 联动、四模态维护、CommunityPage 校验、ExternalEditBar 会话测试、launch_request、negative_conversion、multi_exposure 接队列、cache_utils 向导、i18n 抽样评审、formats（A5 已含）、诊断包 | todo | 逐项小验证 |

## 执行日志

- 2026-10-13: 登记册建立；W1 启动（format 现状：16 文件未格式化；eslint 存量 873 错误；i18n:check 待验证）。
- 2026-10-13: W1（A1-A5）、W2（B1-B3）、W6（F2）完成；双端全绿（cargo 107+契约、npm 73）。启动 W3 AR-2。
- 2026-10-13: W3（C1-C3）完成。AR-2 落地：CPU AGX 退役、缩略图展示路径全 GPU 化（未编辑 RAW 观感统一至 GPU mode0，白名单 backlog 执行）、apply_raw_input_prep 为唯一 CPU RAW 算子、参数 schema 单源（SCALES 由 param_matrix 派生）。测试 115 lib + 快照 10 + ΔE 11 + golden 10 + poc 2 全绿；npm 73 全绿。启动 W4。
- 2026-10-13: W4（D1-D3）完成。D1 RenderScheduler 三级优先级（400ms 交互窗口/20ms 轮询/取消优先，6 断言）+ 四路接线；D2 gpu_backends 策略核（vulkan 硬件→软件 lavapipe→GL→可操作报错，10 单测）+ gpu_processing 三阶段接入（软件回退转 compute-only 防表面 panic）；D3 PostStage 收编快照契约（render_case 接入 apply_post_gpu_adjustments，既有 366 例精确恒等，新增 5 例后 371 例基线重建）。cargo 131 lib + ΔE 11 + 快照 10 + golden 10 + poc 2 全绿；npm 73 全绿。启动 W5。
- 2026-10-13: W5（E1-E3）完成。E2 file_management 四拆为 library_scan/thumb_service/file_ops/metadata_repo（pub mod + pub(crate) helper + 六处跨模块路径修正）；E1 commands/ 八域 façade（130 命令注册，跨模块命令 pub use 函数 + __cmd__ 宏按定义模块相对路径重导出，本文件命令依赖 tauri 自动导出）；E3 lib.rs 2546→269 行装配化（mod/分配器/run()/invoke_handler/RunEvent），遮蔽警告清除。tauri 宏机制结论：#[tauri::command] 为 pub 命令自动生成模块内 `pub use __cmd__x`，绝对/根路径引用宏展开宏被编译器禁止，重导出必须走定义模块相对路径。cargo 131 lib + 快照 10 + golden 10 + poc 2 全绿；npm 73 全绿。启动 W7。
- 2026-10-13: W7（G1-G5）完成。G1 model_manifest/integrity.rs（版本对齐断言 + 流式 sha256 + 三态 diff 扫描，6 单测）；G2 CapabilityAdapter 注册表 7 能力单一数据源驱动下载列表 + 惰性预检 API（3 接口单测），Session 全量惰性化登记后续增强；G3 EP 策略表数据化 + commit 失败自动降档 CPU 重试 + 降档标记（2 单测）；G4 ai_commands 目录化三子模块 + 遗留 cloud 分支整体删除（端侧约束收口）+ ai_connector 依赖图审计默认关闭；G5 lama 大图 tile 化（768/64/32 覆盖+羽化融合替代整体下采样，3 纯函数单测），denoising 既有 tile 化确认在位。cargo 145 lib + ΔE 11 + 快照 10 + golden 10 + poc 2 全绿；npm 73 全绿。启动 W8。
- 2026-10-13: W8（H1-H4）完成。H1 ExportJob 纯状态机队列（11 单测：100 项中断续跑/失败清单/陈旧任务落账/暂停取消竞态）+ 编码器注册表（格式×色深×ICC 前置校验 fail fast）+ 4 队列命令；H2 扩展编码层（EXR 归档/DNG 扩展点/save_hdr 扩展，注册表累计 20 单测）+ CLI/GUI 共用队列 byte 一致；H3 ComposeJob 纯状态机（12 单测）统一四合成模态协议，Hdr/Panorama/FocusStack 接线（MultiExposure 预留），ComposeJobHandle 全 Arc 克隆零成本；H4 alignment_core 共享对齐核（hdr_deghosting 委托化删除约 160 行重复）+ focus_stacking ROI 加速（粗位移 SAD → 候选窗口 → 全幅坐标系窗口求解 → 两级回退），roi_tests 5 单测含 ≥30% 提速基准（ROI ≤ 0.7× 全幅实测通过）。cargo 196 lib + ΔE 11 + 快照 10 + golden 10 + poc 2 全绿；npm 73 全绿。启动 W9 前端。
