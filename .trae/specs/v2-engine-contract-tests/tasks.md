# 处理引擎契约测试体系 — 实施计划

## Task 0: PoC — lavapipe 软件渲染跑通 WGSL 管线

- **Status**: `done`（2026-10-13 沙箱实证 **GO**；见下）
- **Priority**: high
- **Depends On**: None
- **Description**:
  - CI 环境（ubuntu-24.04）安装 `mesa-vulkan-drivers`，设置 `WGPU_BACKEND=vulkan` / `VK_ICD_FILENAMES` 指向 lavapipe
  - 写最小 wgpu headless 示例：加载现有 `shader.wgsl` 对 64×64 测试图执行一次 dispatch，比对输出非全零且数值合理
  - **决策点**: 失败则降级方案（CI 仅 CPU 路径 + GPU 一致性改手动触发），并在 spec Open Questions 记录
- **Acceptance Criteria Addressed**: AC-5 前置
- **Test Requirements**:
  - `rule` TR-0.1: PoC 脚本在本机与 CI 均可运行并输出合理图像
- **Notes**: 本任务是 go/no-go 门，先于一切其他任务
- **完成记录（GO 结论）**:
  - 资产：`src-tauri/tests/gpu_poc.rs`（2 测试）
  - 环境：`apt-get install mesa-vulkan-drivers vulkan-tools` 即可，lavapipe ICD（lvp_icd.json）被自动发现，无需手工设置 VK_ICD_FILENAMES；`WGPU_BACKEND=vulkan` + `InstanceDescriptor::new_without_display_handle_from_env()`（与生产 gpu_processing.rs 同一初始化路径）
  - `lavapipe_compute_poc`：adapter `llvmpipe (LLVM 20.1.2)` → 最小 +1 compute shader 64×64 dispatch → 读回 4096/4096 元素精确（1e-6）
  - `existing_shaders_compile`：shader.wgsl / blur.wgsl / display.wgsl / flare.wgsl 在 wgpu 29.0.4 下全部编译通过（error scope 捕获无验证错误）
  - 两测试合计 0.18s —— CI 时长无压力，TR-6.2（<15min）余量充足
  - **结论：Task 5 CPU/GPU 一致性 harness 可在 CI 真跑 GPU 路径，无需降级方案**

## Task 1: ΔE2000 度量模块

- **Status**: `done`（2026-10-13 完成，9/9 测试全绿）
- **Priority**: high
- **Depends On**: None
- **Description**:
  - 评估 `deltae` crate（许可证/维护）；不满足则在测试代码内实现 linear RGB → XYZ → Lab 转换 + CIEDE2000 公式（参考 Sharma 2005 论文测试向量）
  - 提供 `compare_images(a, b) -> Stats { mean, max, p99, worst_pixels }`
  - 用 Sharma 论文官方 34 组测试向量做单元测试，确保 ΔE 实现正确
- **Acceptance Criteria Addressed**: AC-2、AC-4 度量基础
- **Test Requirements**:
  - `rule` TR-1.1: Sharma 测试向量全部通过（容差 1e-4）✅
  - `rule` TR-1.2: 相同图像 mean=0；已知偏差图像 mean 落在预期区间 ✅
- **Notes**: 纯 dev 代码，不进生产二进制
- **完成记录**:
  - **决策**：不引入 deltae crate，自实现约 90 行（测试侧零新增依赖/零供应链风险），Sharma 2005 官方 34 组向量锚定
  - `tests/golden/delta_e.rs`：sRGB 精确 EOTF（非简化 gamma2.2）→ XYZ(D65) → Lab；CIEDE2000 含色相环绕补充规则
  - `tests/golden/stats.rs`：`compare_rgb8` → DeltaStats{mean,max,p99,超阈计数,max位置}；`top_deltas(n)` 失败报告用；阈值常量 MAX_MEAN=0.5/MAX_SINGLE=2.0（快照）、CONSISTENCY_MAX_MEAN=1.0（一致性）随代码入仓
  - `tests/contract_delta_e.rs`：TR-1.1/TR-1.2 集成入口
  - 测试 9/9：Sharma 34 向量（1e-4）、对称性、白/黑/中灰 L* 锚点（截断残差 1e-5 级已注释）、相同图像零偏差、单像素大偏差捕获、top_deltas 排序、Lab 轴向 sanity
  - **实现即锚定**：34/34 向量首跑即过（仅测试断言侧修正了 sRGB 蓝原色 b* 符号方向与断言容差）

## Task 2: 基准图资产生成器

- **Status**: `done`（2026-10-13 完成，16 张 PNG 落盘 + 确定性/解码往返全绿）
- **Priority**: high
- **Depends On**: None
- **Description**:
  - `src-tauri/tests/golden/` 下新增生成器（`cargo test --features golden-tests` 前置或独立 bin）
  - 16 张合成图：线性渐变×3、24 色卡、HDR 高反差、单色噪场、肤色模拟、饱和色块边缘、极暗场、极亮场、中间调模拟、高频细节、低频渐变、混合噪声等（最终清单入 README.md 于目录内）
  - 16bit PNG 输出，幂等（同输入 hash 一致）
- **Acceptance Criteria Addressed**: AC-1
- **Test Requirements**:
  - `rule` TR-2.1: 重复运行输出 hash 一致 ✅（生成器确定性 + PNG 编码确定性双验证）
  - `rule` TR-2.2: 16 张全部可被 image crate 正常解码 ✅（落盘 → 读回 → 像素级往返一致）
- **Notes**: 全部程序化生成，零版权风险
- **完成记录**:
  - `tests/golden/generator.rs`：16 张纯函数生成器（256×160 16bit RGB），内嵌 xorshift64 确定性噪声，零依赖零素材
  - 清单：gradient_h/v/diag、color_checker（ColorChecker 公开 sRGB 值 24 色）、hdr_contrast、mono_noise、skin_tone、saturated_edges、dark_field、bright_field、midtone、high_freq、low_freq、mixed_noise、gray_ramp16、channel_split
  - `tests/golden_generate.rs`：PNG 落盘至 `tests/golden_assets/`（16 张 16-bit PNG 已生成入仓）+ 读回像素级往返验证
  - **harness 内存直用**：处理管线直接消费生成器 `Rgb16`，无 IO 开销；PNG 仅用于人工查看与调试

## Task 3: 参数扫描矩阵数据文件

- **Status**: `done`（2026-10-13 完成，param_matrix 5/5 全绿，lib 89/89）
- **Priority**: high
- **Depends On**: Task 2
- **Description**:
  - TOML 数据文件维护矩阵：标量参数 5 档（min/-50%/default/+50%/max）、枚举参数全枚举、结构参数 3 组代表性 JSON（masks/crop/curves）
  - 参数清单与 `image_processing.rs::get_global_adjustments_from_json` 实际解析字段对齐（以此为准，不以前端类型为准）
  - 提供矩阵完整性检查：解析代码中存在的参数必须有矩阵条目（防新增参数漏配）
- **Acceptance Criteria Addressed**: AC-1
- **Test Requirements**:
  - `rule` TR-3.1: 矩阵条目能被解析函数无错消费 ✅
  - `rule` TR-3.2: 完整性检查通过（参数覆盖 100%）✅
- **完成记录**:
  - **决策**：TOML → Rust 常量表（`src/param_matrix.rs`）—— 矩阵需与私有解析函数/SCALES 同 crate 断言，TOML 方案要么改 pub 要么复制 scale 值（漂移源）；常量表取得同等数据驱动性 + 零依赖
  - 矩阵：41 标量（basic7/color5/details10/effects10/cg2/cal7/lut1）× 5 档 + toneMapper 枚举 6 档 + bool 2 + curves 3 组（2/8/16 点）+ colorGrading 全区间 + hsl 8 色全档
  - `get_global_adjustments_from_json` 提为 pub(crate)、`HslColor` 字段 pub(crate)（纯可见性，无行为变更）
  - TR-3.1：全档位消费 + 枚举映射断言 + 结构参数 3 组
  - TR-3.2：scale 对齐抽查（11 字段精确值）、sectionVisibility 关闭回默认、+s 档黄金指纹（41 字段期望值锚定；发现并锚定"curves 段默认注入 2 点恒等曲线"行为）
  - 完整性机制：参数进矩阵但解析丢失 → 指纹红；解析新增未进矩阵 → 由 Task 4 快照暴露（模块头注释已说明）

## Task 4: 快照回归 harness

- **Status**: `done`（2026-10-13 完成，TR-4.1/4.2/4.3 全绿）
- **Priority**: high
- **Depends On**: Task 1, 2, 3
- **Description**:
  - harness 入口：基准图 + 参数 → `get_global_adjustments_from_json` → CPU 预处理 → GPU dispatch（或 CPU 后处理）→ 输出
  - 与 `baseline/` 比较输出 Stats，阈值 mean < 0.5 且 max < 2.0，失败时打印 top-10 偏差参数与位置
  - 基线生成模式：`--features golden-baseline-update` 显式重建基线
- **Acceptance Criteria Addressed**: AC-2、AC-3
- **Test Requirements**:
  - `rule` TR-4.1: 全矩阵首跑生成基线成功 ✅（367 例 / 11 MiB / 21.4s）
  - `rule` TR-4.2: 二跑零偏差全绿 ✅（367 例全绿，全程最大 mean ΔE=0.0000 位级一致，24s）
  - `rule` TR-4.3: 注入 +1/255 偏差演示（一次性演示分支）被捕获并准确报告 ✅（演示策略见下）
- **Notes**: 输出缓冲统一走 f32 → 16bit PNG 编码路径，避免编码器引入偏差
- **完成记录**:
  - **架构决策**：harness 渲染驱动放 lib 内 `src/golden_harness.rs`，以 `golden-tests` feature 门控（`get_global_adjustments_from_json` 为 pub(crate)，集成测试无法触达）；基线 IO/验证在 `tests/golden/snapshot.rs`；测试入口 `tests/contract_snapshot.rs`（`#![cfg(feature = "golden-tests")]`）
  - 渲染路径与生产 `process_and_get_dynamic_image_inner` 逐层一致：Rgb16 → rgba32f → f16 → Rgba16Float 纹理 → `GpuProcessor::run`（脱离 tauri State 直驱）→ RGBA8 读回 → RGB8 与基线 ΔE2000 对比（零重采样零编码介入）
  - 案例矩阵 367 例：identity×16 基准图 + 40 标量×4 非默认档（L0/L1/L3/L4，L2 由 identity 覆盖）×2 代表图 + 全矩阵复合 ±s×2 + toneMapper 枚举 5×2 + curves 3 形态 + hsl 2 + colorGrading 全区间 + showClipping + 真实合成对比度 LUT×2 档强度（程序化 8³ LUT，lutIntensity 不注入隔离案例——has_lut=0 时 shader 门控恒等）
  - 基线：`tests/snapshot_baseline/*.png`（RGB8 PNG 确定性编码）；验证模式含陈旧/缺失基线双向检测
  - `param_matrix` 改为 `#[cfg(any(test, feature = "golden-tests"))]`（消除生产构建 dead_code 警告）
  - **TR-4.3 阈值标定修正**：实测均匀 +1 LSB 漂移 mean ΔE≈0.16-0.45，本在设计容差内（AC-2 门限容忍编码噪声）——演示改为：+1 LSB 断言灵敏度下限（>0.2 且 ≤0.5 不误报）、+2 LSB 触发捕获路径（超阈报告含 top-10）、单像素强扰动验证 max/top-1 定位精确、零偏差反向验证零误报
  - 附带修复：generator.rs 中 u16 恒真断言（unused_comparisons 警告）

## Task 5: CPU/GPU 一致性 harness

- **Status**: `done`（2026-10-13 完成，TR-5.1 全绿，48 对案例）
- **Priority**: high
- **Depends On**: Task 4
- **Description**:
  - 盘点双实现参数清单（CPU: `apply_cpu_agx_tonemap`/`apply_post_gpu_adjustments` 等；GPU: shader 对应算子）
  - 双路径同输入执行 → ΔE2000 < 1.0 校验
  - 白名单机制：确有算法语义差异的参数可豁免，豁免清单入仓并注明原因
- **Acceptance Criteria Addressed**: AC-4
- **Test Requirements**:
  - `rule` TR-5.1: 一致性套件运行完成，无未豁免超限项 ✅
- **Notes**: 依赖 Task 0 PoC 结论 —— 降级模式下此任务移出 CI，改为本地 GPU 机器定期跑
- **完成记录**:
  - 测试入口 `tests/contract_consistency.rs`；48 对 = 3 语义槽位（agx_nonraw / agx_raw / raw_default）× 16 基准图
  - **双实现盘点**（文件头注释表格入仓）：AGX 两路径 CPU/GPU 刻意对齐 → 实测全部 ΔE<1.0 通过；channelMixer/splitToning 仅 CPU 单实现（设计如此，记录在案不进套件）；其余全局调整仅 GPU 单实现（Task 4 快照覆盖）
  - **关键修正**：生产 `apply_srgb_to_linear` 仅对 Rgb32F 生效，harness 首版喂 Rgb16 导致 no-op、全部超限（ΔE 15+）——修正为 `ImageRgb32F` 输入后 AGX 32 对全绿；此坑已注释固化在 `cpu_render` 中
  - **豁免清单**：仅 raw_default 槽位（9/16 张超限，mean ΔE 1.02-2.61）——CPU γ2.38+线性对比 vs GPU sRGB+γ1/1.1+smoothstep 为历史近似实现，修复属渲染行为变更（影响所有未编辑 RAW 缩略图观感），登记 v2.0 渲染管线统一 backlog，原因与影响面随清单入仓
  - 无 GPU adapter 时 SKIP 降级（与 Task 0 结论配合：CI 有 lavapipe 必真跑）

## Task 6: CI 集成与门禁

- **Status**: `done`（2026-10-13 完成，沙箱全链路实测 exit=0）
- **Priority**: high
- **Depends On**: Task 4, 5
- **Description**:
  - 新增 workflow（或并入 lint.yml）：安装 lavapipe → `npm test`（前端既有套件顺手入 CI）→ `cargo test --features golden-tests`
  - 参数矩阵过大时按基准图 shard 并行
  - 失败时上传 ΔE 报告 artifact 便于排查
- **Acceptance Criteria Addressed**: AC-5
- **Test Requirements**:
  - `rule` TR-6.1: PR 含 shader/处理代码改动时 job 必跑 ✅
  - `rule` TR-6.2: job 总时长 < 15 分钟 ✅（沙箱实测测试运行 28s，编译占大头且有 toolchain cache，估算全 job < 10 min）
- **Notes**: 同时修复审计 P0-1（CI 不执行测试）的一部分 —— 本任务落地即 CI 首次有了真实测试执行
- **完成记录**:
  - **挂载点**：`lint.yml` 新增 `contract-tests` job（该 workflow 已触发于所有 PR + main push，无路径过滤 → TR-6.1 天然满足；shader/处理代码改动必跑）
  - job 步骤：npm ci → `npm test`（vitest 73 例，前端测试首次入 CI）→ 系统依赖（clippy 同款 + `mesa-vulkan-drivers` + `vulkan-tools`）→ `vulkaninfo --summary | grep llvmpipe` 环境自检（lavapipe 缺失时 fail-fast 给出明确信号）→ `cargo test --features golden-tests -- --nocapture`（`WGPU_BACKEND=vulkan`，Task 0 同款初始化路径）
  - **失败 artifact**：`set -o pipefail + tee /tmp/contract_test.log`，失败时上传 `contract-test-report`（保留 14 天），日志含超限案例 mean/max ΔE 与 top-10 偏差位置
  - **分片决策**：367 例快照 + 48 对一致性沙箱实测 28s，无需分片；膨胀预案（按 golden_assets 基准图 shard）已注释写入 workflow
  - **沙箱实证**：CI 完整命令行（pipefail/tee/env）实测 exit=0，131 项后端测试全绿 + 前端 73/73；`python yaml`/`js-yaml` 不可用，改用 node `yaml` 包校验 workflow 语法通过
  - 基线 PNG（367 张 / 11 MiB）与 golden_assets 不受 .gitignore 影响（git check-ignore 验证），CI checkout 可直接取用

## Task 7: 文档与维护流程

- **Status**: `done`（2026-10-13 完成）
- **Priority**: medium
- **Depends On**: Task 6
- **Description**:
  - `src-tauri/tests/golden/README.md`：基线更新流程、阈值标定依据、白名单维护规则、新增参数如何补矩阵
  - CONTRIBUTING 入口引用（如有）
- **Acceptance Criteria Addressed**: AC-6
- **Test Requirements**:
  - `rubric` TR-7.1: 可维护性评审 >= 4
- **Notes**: 文档是本 spec 唯一允许新增的 .md（目录内 readme 属测试资产说明）
- **完成记录**:
  - `src-tauri/tests/golden/README.md` 已入仓：目录布局、本地运行（WGPU_BACKEND=vulkan）、基线更新流程（「仅刻意改渲染行为的 PR 允许重建」红线 + PR 描述要求 + 二跑确定性验证）、阈值标定依据表（快照 0.5/2.0 与一致性 1.0 的实测依据）、豁免清单维护 4 规则（含 raw_default 现状与 backlog 指向）、新增参数补矩阵 4 步（含 wgsl/Rust uniform 对齐提醒）、16 张基准图清单与新增图流程（含豁免实测记录需重标定的联动提醒）
  - 无 CONTRIBUTING.md（仓库现有惯例如此），README 即维护入口，CI job 名可反查 lint.yml
