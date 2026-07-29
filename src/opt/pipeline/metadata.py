"""Validation and environment resolution for optimizer metadata."""

from __future__ import annotations

import math
import re
from typing import Any

from .io import ENVIRONMENT_DIR, load_json_object


DEFAULT_FPS = 30.0
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
LEGACY_OUTPUT_STEM = re.compile(r"^output_(\d+)$")


def get_metadata_value(
    timeline_wrapper: dict[str, Any],
    metadata_key: str,
) -> Any:
    """Read top-level metadata first, then the legacy metadata object."""
    if metadata_key in timeline_wrapper:
        return timeline_wrapper[metadata_key]
    metadata = timeline_wrapper.get("metadata")
    if isinstance(metadata, dict):
        return metadata.get(metadata_key)
    return None


def infer_example_id_from_wrapper(
    timeline_wrapper: dict[str, Any],
    input_stem: str,
) -> str | None:
    """Resolve an example id from metadata, environment data, or the filename."""
    example_id = get_metadata_value(timeline_wrapper, "exampleId")
    if example_id is not None:
        if not isinstance(example_id, str) or not SAFE_ID.fullmatch(example_id):
            raise ValueError("exampleId must be a filesystem-safe non-empty string")
        return example_id

    embedded_environment = timeline_wrapper.get("environment")
    if isinstance(embedded_environment, dict):
        prompt_example_id = embedded_environment.get("promptExampleId")
        if isinstance(prompt_example_id, str) and prompt_example_id:
            return prompt_example_id

    legacy_match = LEGACY_OUTPUT_STEM.fullmatch(input_stem)
    if legacy_match:
        return f"example-{int(legacy_match.group(1)):02d}"
    return None


def resolve_environment(
    timeline_wrapper: dict[str, Any],
    example_id: str | None,
) -> dict[str, Any] | None:
    """Resolve embedded or catalog environment metadata for a timeline."""
    embedded_environment = timeline_wrapper.get("environment")
    if isinstance(embedded_environment, dict):
        return embedded_environment

    if example_id is not None:
        environment_path = ENVIRONMENT_DIR / f"{example_id}.json"
        if environment_path.is_file():
            return load_json_object(
                environment_path,
                f"environment {environment_path}",
            )

    environment_id = get_metadata_value(timeline_wrapper, "environmentId")
    if isinstance(environment_id, str) and ENVIRONMENT_DIR.is_dir():
        for environment_path in sorted(ENVIRONMENT_DIR.glob("*.json")):
            if environment_path.name == "manifest.json":
                continue
            environment = load_json_object(
                environment_path,
                f"environment {environment_path}",
            )
            if environment.get("id") == environment_id:
                return environment
    return None


def _validate_timeline_and_duration(
    timeline_wrapper: dict[str, Any],
) -> tuple[dict[str, Any], float]:
    flattened_timeline = timeline_wrapper.get("timeline")
    if not isinstance(flattened_timeline, dict) or not isinstance(
        flattened_timeline.get("timeline"), list
    ):
        raise ValueError("timeline wrapper must contain timeline.timeline[]")

    raw_duration = timeline_wrapper.get("totalDuration")
    if isinstance(raw_duration, bool) or not isinstance(
        raw_duration,
        (int, float),
    ):
        raise ValueError("timeline wrapper totalDuration must be a number")
    duration_seconds = float(raw_duration)
    if not math.isfinite(duration_seconds) or duration_seconds <= 0:
        raise ValueError("timeline wrapper totalDuration must be positive and finite")
    return flattened_timeline, duration_seconds


def _resolve_environment_id(
    timeline_wrapper: dict[str, Any],
    environment: dict[str, Any] | None,
    duration_seconds: float,
) -> str:
    environment_id = get_metadata_value(timeline_wrapper, "environmentId")
    if environment_id is None and environment is not None:
        environment_id = environment.get("id")
    if not isinstance(environment_id, str) or not environment_id.strip():
        raise ValueError(
            "timeline wrapper must provide environmentId (or resolve to a matching "
            "web/public/environments/<exampleId>.json)"
        )
    if environment is None:
        return environment_id

    resolved_environment_id = environment.get("id")
    if resolved_environment_id != environment_id:
        raise ValueError(
            f"environmentId {environment_id!r} does not match environment "
            f"{resolved_environment_id!r}"
        )
    environment_duration = environment.get("clock", {}).get("durationSeconds")
    if (
        isinstance(environment_duration, (int, float))
        and not isinstance(environment_duration, bool)
        and not math.isclose(
            float(environment_duration),
            duration_seconds,
            abs_tol=1e-9,
        )
    ):
        raise ValueError(
            f"totalDuration {duration_seconds} does not match environment duration "
            f"{environment_duration}"
        )
    return environment_id


def _resolve_coordinates(
    timeline_wrapper: dict[str, Any],
    environment: dict[str, Any] | None,
) -> dict[str, Any] | None:
    coordinates = get_metadata_value(timeline_wrapper, "coordinates")
    if coordinates is None and environment is not None:
        coordinates = environment.get("coordinates")
    if coordinates is not None and not isinstance(coordinates, dict):
        raise ValueError("coordinates metadata must be an object")
    return coordinates


def _resolve_intrinsics(
    timeline_wrapper: dict[str, Any],
    environment: dict[str, Any] | None,
) -> dict[str, Any] | None:
    intrinsics = get_metadata_value(timeline_wrapper, "intrinsics")
    if intrinsics is None and environment is not None:
        environment_camera = environment.get("camera")
        if isinstance(environment_camera, dict):
            intrinsics = environment_camera.get("intrinsics")
        if intrinsics is None:
            intrinsics = environment.get("intrinsics")
    if intrinsics is not None and not isinstance(intrinsics, dict):
        raise ValueError("intrinsics metadata must be an object")
    return intrinsics


def _resolve_frames_per_second(
    timeline_wrapper: dict[str, Any],
    environment: dict[str, Any] | None,
    frames_per_second_override: float | None,
) -> float:
    raw_fps: Any = frames_per_second_override
    if raw_fps is None:
        raw_fps = get_metadata_value(timeline_wrapper, "fps")
    if raw_fps is None:
        raw_fps = get_metadata_value(timeline_wrapper, "fpsHint")
    if raw_fps is None and environment is not None:
        raw_fps = environment.get("clock", {}).get("fpsHint")
    if raw_fps is None:
        raw_fps = DEFAULT_FPS
    if isinstance(raw_fps, bool) or not isinstance(raw_fps, (int, float)):
        raise ValueError("fps must be a number")
    frames_per_second = float(raw_fps)
    if not math.isfinite(frames_per_second) or frames_per_second <= 0:
        raise ValueError("fps must be positive and finite")
    return frames_per_second


def resolve_optimizer_metadata(
    timeline_wrapper: dict[str, Any],
    input_stem: str,
    frames_per_second_override: float | None = None,
) -> dict[str, Any]:
    """Validate and resolve all metadata needed by the optimizer pipeline."""
    flattened_timeline, duration_seconds = _validate_timeline_and_duration(
        timeline_wrapper
    )
    example_id = infer_example_id_from_wrapper(timeline_wrapper, input_stem)
    environment = resolve_environment(timeline_wrapper, example_id)
    return {
        "exampleId": example_id,
        "environmentId": _resolve_environment_id(
            timeline_wrapper,
            environment,
            duration_seconds,
        ),
        "durationSeconds": duration_seconds,
        "timeline": flattened_timeline,
        "coordinates": _resolve_coordinates(timeline_wrapper, environment),
        "intrinsics": _resolve_intrinsics(timeline_wrapper, environment),
        "fps": _resolve_frames_per_second(
            timeline_wrapper,
            environment,
            frames_per_second_override,
        ),
    }
