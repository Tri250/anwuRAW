#!/usr/bin/env python3
"""anwuRAW MCP server (G6).

FastMCP server that exposes anwuRAW's engine to MCP clients (Claude Desktop,
Cursor, ...) by wrapping the local `anwuRAW` CLI subcommands. No daemon is
started: every tool shells out to the installed binary and returns JSON.

Tools (same contract as RawLab's 5 tools):
  - capabilities     engine version, adjustment schema, masks, export formats
  - validate_recipe  validate an adjustments JSON against the engine schema
  - image_info       metadata of a RAW/JPEG/TIFF file
  - render_preview   render a small preview (headless export with --long-edge)
  - export_photo     full-quality headless export

Requirements: Python 3.10+, `pip install "mcp[cli]"` (or `fastmcp`).
The CLI binary is resolved via $ANWURAW_BIN, then from $PATH (anwuRAW[.exe]).
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from typing import Any

from mcp.server.fastmcp import FastMCP

mcp = FastMCP("anwuRAW")


def _resolve_cli() -> str:
    """Locate the anwuRAW executable: $ANWURAW_BIN first, then $PATH."""
    override = os.environ.get("ANWURAW_BIN")
    if override:
        if not os.path.exists(override):
            raise FileNotFoundError(f"ANWURAW_BIN points to a missing file: {override}")
        return override
    for name in ("anwuRAW", "anwuRAW.exe", "anwuraw"):
        found = shutil.which(name)
        if found:
            return found
    raise FileNotFoundError(
        "anwuRAW binary not found. Set ANWURAW_BIN to the executable path "
        "or add it to your PATH."
    )


def _run_cli(args: list[str], timeout: float = 300.0) -> dict[str, Any]:
    """Run the CLI and parse its stdout as JSON.

    The CLI prints exactly one JSON document for the tools we use here.
    """
    cmd = [_resolve_cli(), *args]
    completed = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
    stdout = completed.stdout.strip()
    if completed.returncode not in (0, 1):  # 1 = validate reported invalid recipe
        raise RuntimeError(
            f"anwuRAW CLI failed (exit {completed.returncode}): "
            f"{completed.stderr.strip() or stdout or 'no output'}"
        )
    try:
        return json.loads(stdout)
    except json.JSONDecodeError as exc:
        raise RuntimeError(
            f"Could not parse CLI output as JSON: {stdout[:500]}..."
        ) from exc


@mcp.tool()
def capabilities() -> dict[str, Any]:
    """Engine capabilities: version, all adjustment parameters (with ranges,
    defaults and enums), mask types and supported export formats.

    Use this first to discover what the engine can do, then build an
    adjustments recipe (a JSON object of parameter names to values) and check
    it with `validate_recipe` before exporting."""
    return _run_cli(["capabilities"])


@mcp.tool()
def validate_recipe(adjustments: dict[str, Any]) -> dict[str, Any]:
    """Validate an adjustments recipe (JSON object) against the engine schema.

    Returns {"valid": bool, "errors": [{"path", "message"}]}. Recipes use the
    exact same parameter names as anwuRAW's GUI sidecar files."""
    with tempfile.NamedTemporaryFile(
        "w", suffix=".json", delete=False, encoding="utf-8"
    ) as handle:
        json.dump(adjustments, handle)
        recipe_path = handle.name
    try:
        return _run_cli(["validate", "--adjustments", recipe_path])
    finally:
        os.unlink(recipe_path)


@mcp.tool()
def image_info(path: str) -> dict[str, Any]:
    """Metadata of an image file (RAW, JPEG, TIFF, ...): camera, lens, ISO,
    exposure, focal length, orientation, file size."""
    return _run_cli(["image-info", path], timeout=60.0)


def _export(
    path: str,
    output: str,
    adjustments: dict[str, Any] | None,
    image_format: str | None,
    quality: int | None,
    long_edge: int | None,
) -> dict[str, Any]:
    args = ["export", path, "--output", output]
    if adjustments is not None:
        recipe = validate_recipe(adjustments)
        if not recipe.get("valid"):
            return {"success": False, "validation": recipe}
        with tempfile.NamedTemporaryFile(
            "w", suffix=".json", delete=False, encoding="utf-8"
        ) as handle:
            json.dump(adjustments, handle)
            recipe_path = handle.name
        args += ["--adjustments", recipe_path]
    else:
        recipe_path = None
    if image_format:
        args += ["--format", image_format]
    if quality is not None:
        args += ["--quality", str(quality)]
    if long_edge is not None:
        args += ["--long-edge", str(long_edge)]
    try:
        # `export` streams human-readable progress lines, not JSON.
        completed = subprocess.run(
            [_resolve_cli(), *args],
            capture_output=True,
            text=True,
            timeout=900.0,
            check=False,
        )
    finally:
        if recipe_path:
            os.unlink(recipe_path)
    log = (completed.stdout + completed.stderr).strip()
    if completed.returncode != 0:
        raise RuntimeError(
            f"anwuRAW export failed (exit {completed.returncode}): {log or 'no output'}"
        )
    return {"success": True, "outputPath": output, "log": log}


@mcp.tool()
def render_preview(
    path: str,
    adjustments: dict[str, Any] | None = None,
    long_edge: int = 1024,
    output: str | None = None,
) -> dict[str, Any]:
    """Render a small preview of an image with optional adjustments applied.

    `path` is the source image, `adjustments` an optional recipe (see
    `capabilities`), `long_edge` the maximum output size in pixels and
    `output` the JPEG path to write (defaults to a temp file)."""
    target = output or os.path.join(
        tempfile.gettempdir(), "anwuraw-mcp-preview.jpg"
    )
    result = _export(path, target, adjustments, "jpeg", 90, long_edge)
    if result.get("success", True):
        result["previewPath"] = target
    return result


@mcp.tool()
def export_photo(
    path: str,
    output: str,
    adjustments: dict[str, Any] | None = None,
    image_format: str = "jpeg",
    quality: int = 90,
) -> dict[str, Any]:
    """Export an image at full quality with optional adjustments applied.

    `output` is the target file (or folder for batch input folders);
    `image_format` one of jpeg/png/webp/tiff; `quality` 1-100 (JPEG/WebP)."""
    return _export(path, output, adjustments, image_format, quality, None)


def main() -> None:
    mcp.run()


if __name__ == "__main__":
    main()
