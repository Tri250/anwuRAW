# anwuRAW MCP Server

FastMCP server that exposes the anwuRAW engine to MCP clients (Claude Desktop,
Cursor, Windsurf, ...) by wrapping the local `anwuRAW` CLI. No daemon, no extra
ports: every tool shells out to the installed binary (same boundary as
RawLab's `tools/mcp`).

## Tools

| Tool              | Wraps                        | Description                                                                                         |
| ----------------- | ---------------------------- | --------------------------------------------------------------------------------------------------- |
| `capabilities`    | `anwuRAW capabilities`       | Engine version, full adjustment schema (names, ranges, defaults, enums), mask types, export formats |
| `validate_recipe` | `anwuRAW validate`           | Validate an adjustments JSON object, returns error details                                          |
| `image_info`      | `anwuRAW image-info`         | Camera/lens/exposure metadata of an image file                                                      |
| `render_preview`  | `anwuRAW export --long-edge` | Small preview render (default 1024 px long edge, JPEG)                                              |
| `export_photo`    | `anwuRAW export`             | Full-quality export with an adjustments recipe                                                      |

Adjustments recipes are the exact same JSON objects stored in anwuRAW's GUI
sidecar files — one shared semantic between GUI and agents.

## Setup

1. Build or install the anwuRAW desktop app (the CLI subcommands are built into
   the same binary).
2. `pip install "mcp[cli]"`
3. Make sure the `anwuRAW` executable is on your `PATH`, or set
   `ANWURAW_BIN=/path/to/anwuRAW`.
4. Smoke-test the CLI directly:

   ```bash
   anwuRAW capabilities | head -20
   anwuRAW image-info photo.CR3
   ```

## Client configuration

### Claude Desktop / Claude Code (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "anwuraw": {
      "command": "python3",
      "args": ["/absolute/path/to/anwuRAW/tools/mcp/server.py"],
      "env": {
        "ANWURAW_BIN": "/absolute/path/to/anwuRAW"
      }
    }
  }
}
```

### Cursor (`~/.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "anwuraw": {
      "command": "python3",
      "args": ["/absolute/path/to/anwuRAW/tools/mcp/server.py"],
      "env": { "ANWURAW_BIN": "/absolute/path/to/anwuRAW" }
    }
  }
}
```

## Example agent flow

1. `capabilities` → discover `schema.params` (e.g. `exposure` range -5..5) and
   `schema.sections` groupings.
2. Build a recipe: `{"exposure": 0.4, "hsl": {"blues": {"hue": -20}}, "vibrance": 15}`.
3. `validate_recipe` → fix any reported `errors[]`.
4. `render_preview` → inspect the small JPEG.
5. `export_photo` → write the final file.

See `docs/agent-cli.md` for the full CLI reference.
