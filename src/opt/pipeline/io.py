"""Filesystem operations for optimizer pipeline inputs and outputs."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any


PROJECT_ROOT = Path(__file__).resolve().parents[3]
DEBUG_OUTPUT_DIR = PROJECT_ROOT / "shared" / "optimized"
VIEWER_OUTPUT_DIR = PROJECT_ROOT / "web" / "public" / "trajectories" / "optimized"
ENVIRONMENT_DIR = PROJECT_ROOT / "web" / "public" / "environments"


def load_json_object(path: Path, description: str) -> dict[str, Any]:
    """Load a JSON object and attach useful context to decoding errors."""
    try:
        with path.open("r", encoding="utf-8") as file:
            document = json.load(file)
    except json.JSONDecodeError as error:
        raise ValueError(f"{description} is not valid JSON: {error}") from error
    if not isinstance(document, dict):
        raise ValueError(f"{description} must contain a JSON object")
    return document


def resolve_output_paths(
    timeline_path: Path,
    example_id: str | None,
    *,
    debug_output: Path | None = None,
    trajectory_output: Path | None = None,
) -> tuple[Path, Path, Path | None]:
    """Resolve raw, archive, and optional viewer output destinations."""
    debug_path = (
        debug_output.resolve()
        if debug_output is not None
        else DEBUG_OUTPUT_DIR / f"{timeline_path.stem}_optimized.json"
    )
    archive_path = DEBUG_OUTPUT_DIR / f"{timeline_path.stem}_camera.json"
    if trajectory_output is not None:
        viewer_path = trajectory_output.resolve()
    elif example_id is not None:
        viewer_path = VIEWER_OUTPUT_DIR / f"{example_id}-camera.json"
    else:
        viewer_path = None
    return debug_path, archive_path, viewer_path


def write_json_atomically(path: Path, document: dict[str, Any]) -> None:
    """Write a JSON document through a sibling temporary file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = path.with_name(f".{path.name}.tmp")
    try:
        with temporary_path.open("w", encoding="utf-8") as file:
            json.dump(
                document,
                file,
                ensure_ascii=False,
                indent=2,
                allow_nan=False,
            )
            file.write("\n")
        temporary_path.replace(path)
    except BaseException:
        temporary_path.unlink(missing_ok=True)
        raise
