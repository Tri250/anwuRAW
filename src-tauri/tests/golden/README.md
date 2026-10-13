# 处理引擎契约测试资产（golden tests）

处理引擎的图像行为契约：任何 shader / 处理代码改动若引起像素输出变化，本套件必须显式暴露，
禁止「顺手改了渲染没人知道」。CI 挂载于 `.github/workflows/lint.yml` 的 `contract-tests` job
（lavapipe 软件 Vulkan，无需 GPU 机器）。

## 目录布局

| 路径 | 内容 |
|---|---|
| `golden_assets/` | 16 张程序化基准图（16-bit PNG，仅用于人工查看；测试直接消费生成器内存数据） |
| `snapshot_baseline/` | 367 例快照基线（RGB8 PNG，~11 MiB，入仓） |
| `delta_e.rs` | CIEDE2000 + sRGB→Lab 转换（Sharma 2005 官方 34 向量锚定） |
| `stats.rs` | 图像对比统计与阈值常量 |
| `generator.rs` | 16 张基准图生成器（纯函数，确定性） |
| `snapshot.rs` | 基线 IO 与验证 |

测试入口（均在 `src-tauri/tests/`）：

- `contract_snapshot.rs` —— 快照回归（Task 4）：参数矩阵 × 基准图 → 输出与基线 ΔE 对比
- `contract_consistency.rs` —— CPU/GPU 一致性（Task 5）：双实现对同输入 ΔE < 1.0
- `gpu_poc.rs` / `contract_delta_e.rs` / `golden_generate.rs` —— 基础设施自检

渲染驱动在 `src/golden_harness.rs`（`golden-tests` feature 门控，不进生产二进制；
参数矩阵在 `src/param_matrix.rs`，同样门控）。

## 本地运行

```sh
cd src-tauri

# 全套（需 wgpu 适配器；无 GPU 时安装 mesa-vulkan-drivers）
WGPU_BACKEND=vulkan cargo test --features golden-tests
```

CI 无 lavapipe 时一致性测试 SKIP、快照测试会因 GPU 缺失失败 —— 这是预期信号，不要改代码绕过。

## 基线更新流程

**什么时候允许重建基线**：且仅当本次 PR 就是「刻意改变渲染行为」的 PR
（如调参、修复 shader 算子、新增参数）。意外红 + 直接重建基线 = 毁掉整个体系。

```sh
cd src-tauri
cargo test --features golden-baseline-update --test contract_snapshot
git add tests/snapshot_baseline
```

PR 描述必须列出：改动意图、受影响参数、抽查过的案例（对照渲染结果肉眼确认新基线正确）。
二跑 `cargo test --features golden-tests` 必须全绿（基线确定性验证）。

## 阈值标定依据

| 套件 | 阈值 | 依据 |
|---|---|---|
| 快照回归 | mean ΔE < 0.5 且 max < 2.0 | 均匀 +1 LSB 编码噪声实测 mean ΔE 0.16–0.45（落在容差内不误报）；+2 LSB 及以上必然捕获（TR-4.3 标定） |
| CPU/GPU 一致性 | mean ΔE < 1.0 | 人眼对同语义槽位观感差异的保守门限；AGX 双实现实测 < 0.5 |

阈值常量在 `tests/golden/stats.rs`。调整阈值 = 契约变更，需在 PR 中单独说明。

## 豁免清单（CPU/GPU 一致性）

位置：`tests/contract_consistency.rs` 的 `WHITELIST` 常量。

维护规则：

1. 仅允许「确有算法语义差异」的项入列，必须注明原因与生产影响面
2. 「实现错了懒得改」不是豁免理由 —— 登记 backlog 后再豁免，豁免条目必须带 backlog 指向
3. 每条豁免 CI 日志会打印实测 ΔE，数值漂移（变大）说明语义在变化，需复查
4. 当前豁免：`raw_default`（CPU γ2.38+线性对比 vs GPU sRGB+smoothstep，历史近似实现，
   影响未编辑 RAW 缩略图；v2.0 渲染管线统一 backlog）

## 新增参数如何补矩阵

1. 在 `src/param_matrix.rs` 加入标量档位（5 档）/ 枚举 / 结构参数条目
2. 跑 `cargo test --features golden-tests`：
   - 若参数在解析但矩阵缺失 → 快照回归可能暴露新路径未覆盖（矩阵完整性由黄金指纹 + 快照双保险）
   - 首跑若有新案例缺基线 → 按上文流程重建基线
3. 若新参数有 CPU 实现（缩略图路径）→ 同步在 `contract_consistency.rs` 增加一致性配对，
   无 CPU 对应物则在文件头盘点表中登记「仅单实现」
4. 新增 shader uniform 字段注意 `GlobalAdjustments` 对齐（wgsl struct 与 Rust repr(C) 同步改）

## 基准图清单（16 张，全部程序化生成，零版权）

`gradient_h` / `gradient_v` / `gradient_diag`（三向渐变）、`color_checker`（24 色 sRGB 公开值）、
`hdr_contrast`（高反差）、`mono_noise` / `mixed_noise`（确定性噪声场）、`skin_tone`（肤色模拟）、
`saturated_edges`（饱和色块边缘）、`dark_field` / `bright_field`（极暗/极亮场）、`midtone`、
`high_freq` / `low_freq`（高频细节/低频渐变）、`gray_ramp16`（灰阶）、`channel_split`（通道分离）。

新增基准图：在 `generator.rs` 写纯函数生成器 + 结构自检，16-bit `Rgb16` 输出；
随后重建一致性豁免清单的实测记录（raw_default 的 ΔE 区间会随图集变化）。
