# anwuRAW Agent CLI

anwuRAW 的桌面二进制同时是一个本地 CLI。以下子命令在应用启动前直接执行并退出
（不打开 GUI 窗口），供 Agent、脚本与 MCP 客户端使用。`export` 子命令复用与
GUI 完全相同的渲染管线与参数语义（adjustments JSON 与 GUI sidecar 同构）。

## 子命令

### `anwuRAW capabilities`

输出引擎能力描述（JSON，含版本号）：

```json
{
  "name": "anwuRAW",
  "version": "0.9.0",
  "commands": ["capabilities", "validate", "image-info", "export", "help", "version"],
  "schema": {
    "schemaVersion": 1,
    "sections": { "basic": ["brightness", "..."], "...": "..." },
    "params": {
      "exposure": { "type": "number", "min": -5, "max": 5, "step": 0.01, "default": 0 },
      "toneMapper": { "type": "enum", "values": ["agx", "basic"], "default": "basic" },
      "hsl": { "type": "object", "properties": { "reds": { "...": "..." } } }
    },
    "maskTypes": ["ai-subject", "brush", "radial", "..."],
    "subMaskModes": ["additive", "subtractive", "intersect"],
    "exportFormats": ["jpeg", "png", "webp", "tiff"],
    "tiffBitDepths": [8, 16]
  }
}
```

### `anwuRAW validate [--adjustments] FILE`

校验一个 adjustments JSON 文件（与 GUI sidecar 同构），输出：

```json
{
  "path": "recipe.json",
  "valid": false,
  "errors": [
    { "path": "exposure", "message": "value 9 is above the maximum 5" },
    { "path": "unknownKey", "message": "unknown adjustment 'unknownKey'" }
  ]
}
```

退出码：`0` 校验通过；`1` 校验失败（errors 非空）；`2` 用法/IO/解析错误。
校验规则：未知顶层键报错；`number` 按范围检查；`enum` 按闭集检查；嵌套对象
（`hsl`、`colorGrading`、`colorCalibration`、`parametricCurve`、`relightLights[]`）
递归校验；`type: "any"` 的复杂参数（`crop`、`masks`、`curves` 等）只检查存在性；
JSON `null` 一律视为"使用默认值"并通过。

### `anwuRAW image-info FILE`

输出图像元数据（JSON）：`make`/`model`/`camera`/`lensMake`/`lensModel`/`iso`/
`exposureTimeSeconds`/`fNumber`/`focalLengthMm`/`dateTimeOriginal`/`orientation`/
`fileSizeBytes`/`extension`。RAW 解析由 rawler 完成；无法解析时输出
`warning` 字段而不是失败。

### `anwuRAW export [SOURCE] [OPTIONS]`

Headless 导出（与 GUI 共享渲染管线，支持批量目录与断点续传 journal）：

| 选项                 | 说明                                                 |
| -------------------- | ---------------------------------------------------- |
| `SOURCE`             | 图像文件或目录（必填）                               |
| `--output PATH`      | 输出文件/目录（必填）                                |
| `--format FORMAT`    | `jpeg`（默认）/ `png` / `webp` / `tiff`              |
| `--quality N`        | 1–100（默认 90，JPEG/WebP）                          |
| `--tiff-bit-depth N` | 8 / 16（默认 16）                                    |
| `--long-edge N`      | 输出长边不超过 N 像素（MCP `render_preview` 的基础） |
| `--keep-metadata`    | 保留 EXIF                                            |
| `--adjustments FILE` | adjustments JSON（GUI sidecar 同构）                 |

### `anwuRAW --help` / `--version`

用法与版本信息（版本与 GUI 一致，来自同一个 Cargo crate）。

## 参数 schema 的构建期生成

schema 是单一事实来源，构建期生成、编译期内嵌：

1. 源数据：[src/utils/adjustmentsSchema.ts](../src/utils/adjustmentsSchema.ts)
   （sections / 参数范围 / 枚举 / 嵌套 spec / mask 类型 / 导出格式）+
   [src/utils/defaultAdjustments.json](../src/utils/defaultAdjustments.json)（默认值）；
2. 生成：`npm run schema:generate`（[tools/generate-adjustments-schema.mjs](../tools/generate-adjustments-schema.mjs)）→
   [src-tauri/resources/adjustments-schema.json](../src-tauri/resources/adjustments-schema.json)；
3. 内嵌：`src-tauri/src/cli.rs` 用 `include_str!` 打进二进制，`capabilities` 与
   `validate` 共用同一份 schema。

**修改调整参数后必须重新运行 `npm run schema:generate` 并提交更新后的 JSON**，
否则 `validate` 的范围/枚举与 GUI 行为漂移。参数语义契约见
[docs/contracts/adjustments-schema.md](contracts/adjustments-schema.md)。

## MCP Server

`tools/mcp/server.py`（Python FastMCP）把以上 CLI 包装为 5 个 MCP 工具
（`capabilities` / `validate_recipe` / `image_info` / `render_preview` /
`export_photo`），与 RawLab 的 MCP 面同构，不引入常驻服务进程。
安装与 Claude Desktop / Cursor 配置片段见
[tools/mcp/README.md](../tools/mcp/README.md)。
