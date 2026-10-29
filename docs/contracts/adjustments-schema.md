# Adjustments 参数契约（Adjustments Schema Contract）

> 本文档是 adjustments JSON 的**参数契约**：参数名、类型、范围、默认值、校验语义。
> 参数全集以代码为单一来源（见第 1 节），本文不复制全表，只描述契约规则与工作流。

---

## 1. 单一来源（Single Source of Truth）

参数定义只有一个源头，任何派生物不允许手工编辑：

```
src/utils/adjustmentsSchema.ts          ← 参数单源：分区 / 范围 / 枚举 / 嵌套对象 spec / any 清单
        │  （无任何运行时依赖，可被前端与构建脚本同时引用）
        ├─ src/utils/adjustments.ts     ← re-export ADJUSTMENT_SECTIONS（前端分区 UI 使用）
        └─ tools/generate-adjustments-schema.mjs
                │  npm run schema:generate
                │  （esbuild bundle → CJS eval → 合并 defaultAdjustments.json 默认值）
                ▼
src-tauri/resources/adjustments-schema.json   ← 生成产物（入库、可 diff、可评审）
                │  Rust 侧 include_str! 内嵌进二进制
                ▼
CLI `anwuRAW capabilities` / `anwuRAW validate`   ← 对外暴露能力与校验（见 docs/agent-cli.md）
```

生成产物的顶层结构：

```jsonc
{
  "sections": { "basic": [...], "curves": [...], "color": [...], "details": [...], "effects": [...] },
  "maskTypes": [ /* 18 种蒙版类型 */ ],
  "exportFormats": ["jpeg", "png", "webp", "tiff"],
  "tiffBitDepths": [8, 16],
  "params": {
    "exposure":    { "type": "number", "min": -5, "max": 5, "step": 0.01, "default": 0 },
    "toneMapper":  { "type": "enum", "values": ["agx", "basic"], "default": "basic" },
    "hsl":         { "type": "object", "properties": { "reds": { "type": "object", "properties": { /* hue/saturation/luminance ±100 */ } } }, "default": { /* ... */ } },
    "activeTools": { "type": "any", "default": [] }
  }
}
```

当前规模：**119 个参数 / 5 个分区 / 18 种蒙版类型 / 4 种导出格式**。

---

## 2. 参数类型与校验语义

`validate` 子命令（`src-tauri/src/cli.rs`）按下列语义校验 adjustments JSON。
**这是对外契约**：第三方工具（MCP、脚本）依赖其稳定行为。

| 类型      | 校验规则                                                                                                                                           |
| --------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `number`  | 必须可解析为 f64；给出 `min`/`max` 时闭区间越界报错                                                                                                |
| `boolean` | 必须 JSON boolean                                                                                                                                  |
| `enum`    | 必须命中 `values` 闭集（例如 `toneMapper ∈ {agx, basic}`）                                                                                         |
| `string`  | 必须 JSON string                                                                                                                                   |
| `array`   | 必须 JSON array；`items` spec 递归校验每个元素，错误路径记 `param[i]`（如 `relightLights[0].temperature`）                                         |
| `object`  | 必须 JSON object；`properties` 中的已知键递归校验，**未知键报错**                                                                                  |
| `any`     | 只做存在性检查，不校验内部结构（用于 `activeTools`、`masks`、`curves`、`whiteBalance`、`lutData`、`crop`、`aiPatches` 等前端拥有内部结构的复合值） |

附加规则：

- **未知顶层参数**：`params` 白名单之外的键报 `unknown adjustment`。
- **JSON `null` 一律视为"使用默认值"**：任何参数传 `null` 都通过校验，语义等价于不传。
- **错误上限**：最多报告 100 条，超出后附加截断说明（`VALIDATE_ERROR_LIMIT`）。
- **退出码**：`0` = valid，`1` = invalid（输出 JSON 报告），`2` = 用法错误或 IO 错误。

---

## 3. 默认值与中性值契约

- 每个参数的 `default` 来自 `defaultAdjustments.json`（构建期合并进 schema）。
- **新增参数的默认值必须是中性值**（不影响既有编辑的渲染输出）——这是"新参数不触发
  PROCESSING_VERSION 递增"的前提（见 `docs/contracts/rendering-pipeline.md` §3.2）。
- 修改已有参数的默认值**不属于**中性变更：只影响未显式设置该参数的记录，需评估是否递增处理版本。

---

## 4. 修改参数的工作流（必须完整走完）

新增/修改/删除任何滑块参数时：

```bash
# 1. 改参数单源（或 defaultAdjustments.json 的默认值）
$EDITOR src/utils/adjustmentsSchema.ts

# 2. 重新生成 schema 产物
npm run schema:generate

# 3. 提交时必须包含生成的 JSON（它是 include_str! 的编译输入）
git add src-tauri/resources/adjustments-schema.json
```

- 忘记第 2 步的后果：Rust 二进制内嵌的是旧 schema，`validate`/`capabilities` 对外报告的
  参数集与前端实际不一致。
- `src/utils/adjustments.ts` 中若有范围相关的 UI 逻辑，直接 import `adjustmentsSchema.ts`，
  不要再手写一份范围常量。

---

## 5. 消费方一览

| 消费方                                 | 用途                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------ |
| 前端（React）                          | 分区 UI（ADJUSTMENT_SECTIONS）、滑块范围                                 |
| CLI `capabilities`                     | 对外暴露完整 schema + 命令清单（JSON）                                   |
| CLI `validate`                         | 第三方 recipe 校验（MCP validate_recipe 工具的后端）                     |
| MCP server（tools/mcp/server.py）      | agent 流程：capabilities → validate_recipe → render_preview/export_photo |
| `docs/contracts/rendering-pipeline.md` | 缓存 key 与版本纪律引用本契约                                            |
