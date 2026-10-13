# 处理引擎契约测试体系 — 实施计划

## Task 0: PoC — lavapipe 软件渲染跑通 WGSL 管线

- **Status**: `pending`
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

## Task 1: ΔE2000 度量模块

- **Status**: `pending`
- **Priority**: high
- **Depends On**: None
- **Description**:
  - 评估 `deltae` crate（许可证/维护）；不满足则在测试代码内实现 linear RGB → XYZ → Lab 转换 + CIEDE2000 公式（参考 Sharma 2005 论文测试向量）
  - 提供 `compare_images(a, b) -> Stats { mean, max, p99, worst_pixels }`
  - 用 Sharma 论文官方 34 组测试向量做单元测试，确保 ΔE 实现正确
- **Acceptance Criteria Addressed**: AC-2、AC-4 度量基础
- **Test Requirements**:
  - `rule` TR-1.1: Sharma 测试向量全部通过（容差 1e-4）
  - `rule` TR-1.2: 相同图像 mean=0；已知偏差图像 mean 落在预期区间
- **Notes**: 纯 dev 代码，不进生产二进制

## Task 2: 基准图资产生成器

- **Status**: `pending`
- **Priority**: high
- **Depends On**: None
- **Description**:
  - `src-tauri/tests/golden/` 下新增生成器（`cargo test --features golden-tests` 前置或独立 bin）
  - 16 张合成图：线性渐变×3、24 色卡、HDR 高反差、单色噪场、肤色模拟、饱和色块边缘、极暗场、极亮场、中间调模拟、高频细节、低频渐变、混合噪声等（最终清单入 README.md 于目录内）
  - 16bit PNG 输出，幂等（同输入 hash 一致）
- **Acceptance Criteria Addressed**: AC-1
- **Test Requirements**:
  - `rule` TR-2.1: 重复运行输出 hash 一致
  - `rule` TR-2.2: 16 张全部可被 image crate 正常解码
- **Notes**: 全部程序化生成，零版权风险

## Task 3: 参数扫描矩阵数据文件

- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 2
- **Description**:
  - TOML 数据文件维护矩阵：标量参数 5 档（min/-50%/default/+50%/max）、枚举参数全枚举、结构参数 3 组代表性 JSON（masks/crop/curves）
  - 参数清单与 `image_processing.rs::get_global_adjustments_from_json` 实际解析字段对齐（以此为准，不以前端类型为准）
  - 提供矩阵完整性检查：解析代码中存在的参数必须有矩阵条目（防新增参数漏配）
- **Acceptance Criteria Addressed**: AC-1
- **Test Requirements**:
  - `rule` TR-3.1: 矩阵条目能被解析函数无错消费
  - `rule` TR-3.2: 完整性检查通过（参数覆盖 100%）

## Task 4: 快照回归 harness

- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 1, 2, 3
- **Description**:
  - harness 入口：基准图 + 参数 → `get_global_adjustments_from_json` → CPU 预处理 → GPU dispatch（或 CPU 后处理）→ 输出
  - 与 `baseline/` 比较输出 Stats，阈值 mean < 0.5 且 max < 2.0，失败时打印 top-10 偏差参数与位置
  - 基线生成模式：`--features golden-baseline-update` 显式重建基线
- **Acceptance Criteria Addressed**: AC-2、AC-3
- **Test Requirements**:
  - `rule` TR-4.1: 全矩阵首跑生成基线成功
  - `rule` TR-4.2: 二跑零偏差全绿
  - `rule` TR-4.3: 注入 +1/255 偏差演示（一次性演示分支）被捕获并准确报告
- **Notes**: 输出缓冲统一走 f32 → 16bit PNG 编码路径，避免编码器引入偏差

## Task 5: CPU/GPU 一致性 harness

- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 4
- **Description**:
  - 盘点双实现参数清单（CPU: `apply_cpu_agx_tonemap`/`apply_post_gpu_adjustments` 等；GPU: shader 对应算子）
  - 双路径同输入执行 → ΔE2000 < 1.0 校验
  - 白名单机制：确有算法语义差异的参数可豁免，豁免清单入仓并注明原因
- **Acceptance Criteria Addressed**: AC-4
- **Test Requirements**:
  - `rule` TR-5.1: 一致性套件运行完成，无未豁免超限项
- **Notes**: 依赖 Task 0 PoC 结论 —— 降级模式下此任务移出 CI，改为本地 GPU 机器定期跑

## Task 6: CI 集成与门禁

- **Status**: `pending`
- **Priority**: high
- **Depends On**: Task 4, 5, 6
- **Description**:
  - 新增 workflow（或并入 lint.yml）：安装 lavapipe → `npm test`（前端既有套件顺手入 CI）→ `cargo test --features golden-tests`
  - 参数矩阵过大时按基准图 shard 并行
  - 失败时上传 ΔE 报告 artifact 便于排查
- **Acceptance Criteria Addressed**: AC-5
- **Test Requirements**:
  - `rule` TR-6.1: PR 含 shader/处理代码改动时 job 必跑
  - `rule` TR-6.2: job 总时长 < 15 分钟
- **Notes**: 同时修复审计 P0-1（CI 不执行测试）的一部分 —— 本任务落地即 CI 首次有了真实测试执行

## Task 7: 文档与维护流程

- **Status**: `pending`
- **Priority**: medium
- **Depends On**: Task 6
- **Description**:
  - `src-tauri/tests/golden/README.md`：基线更新流程、阈值标定依据、白名单维护规则、新增参数如何补矩阵
  - CONTRIBUTING 入口引用（如有）
- **Acceptance Criteria Addressed**: AC-6
- **Test Requirements**:
  - `rubric` TR-7.1: 可维护性评审 >= 4
- **Notes**: 文档是本 spec 唯一允许新增的 .md（目录内 readme 属测试资产说明）
