"""Execution and publication helpers for the optimizer pipeline."""

from __future__ import annotations

from pathlib import Path
from typing import Any


def build_placeholder_subject_data(torch_module, frame_count: int):
    """Build the temporary subject channel used until tracking is connected."""
    subject_centers = {
        "C0": torch_module.zeros(
            (frame_count, 3),
            dtype=torch_module.float64,
        )
    }
    subject_tracks = {
        "C0": [
            {
                "bbox": {
                    "x1": 800,
                    "y1": 800,
                    "x2": 1000,
                    "y2": 1000,
                },
                "center3d": [0.0, 0.0, 0.0],
            }
            for _ in range(frame_count)
        ]
    }
    return subject_centers, subject_tracks


def build_optimizer_options(
    optimizer_constraints: list[dict[str, Any]],
    pipeline_metadata: dict[str, Any],
    subject_centers,
    subject_tracks,
    max_iterations: int | None,
) -> dict[str, Any]:
    """Translate pipeline metadata into optimizer keyword arguments."""
    optimize_options: dict[str, Any] = {
        "constraints": optimizer_constraints,
        "duration_seconds": pipeline_metadata["durationSeconds"],
        "frames_per_second": pipeline_metadata["fps"],
        "subject_centers": subject_centers,
        "subject_tracks": subject_tracks,
    }
    if max_iterations is not None:
        optimize_options["max_iterations"] = max_iterations
    return optimize_options


def publish_trajectory_documents(
    *,
    timeline_path: Path,
    pipeline_metadata: dict[str, Any],
    debug_document: dict[str, Any],
    trajectory_document: dict[str, Any],
    resolve_paths,
    write_json,
    debug_output: Path | None,
    trajectory_output: Path | None,
) -> dict[str, Path | None]:
    """Resolve destinations and publish debug, archive, and viewer documents."""
    debug_path, archive_path, viewer_path = resolve_paths(
        timeline_path,
        pipeline_metadata["exampleId"],
        debug_output=debug_output,
        trajectory_output=trajectory_output,
    )
    write_json(debug_path, debug_document)
    write_json(archive_path, trajectory_document)
    if viewer_path is not None and viewer_path.resolve() != archive_path.resolve():
        write_json(viewer_path, trajectory_document)
    return {
        "debug": debug_path,
        "archive": archive_path,
        "viewer": viewer_path,
    }
