"""Pure-stdlib adapters from optimizer output to CameraTrajectoryV1."""

from __future__ import annotations

from typing import Any

try:
    from .pipeline.playback import (
        normalize_playback_segments as _normalize_playback_segments,
    )
    from .pipeline.trajectory import (
        build_trajectory_samples as _build_trajectory_samples,
        coerce_finite_number as _coerce_finite_number,
        normalize_trajectory_intrinsics as _normalize_trajectory_intrinsics,
        validate_trajectory_coordinates as _validate_trajectory_coordinates,
    )
except ImportError:
    from pipeline.playback import (
        normalize_playback_segments as _normalize_playback_segments,
    )
    from pipeline.trajectory import (
        build_trajectory_samples as _build_trajectory_samples,
        coerce_finite_number as _coerce_finite_number,
        normalize_trajectory_intrinsics as _normalize_trajectory_intrinsics,
        validate_trajectory_coordinates as _validate_trajectory_coordinates,
    )


def build_playback_metadata_from_timeline(
    flattened_timeline: dict[str, Any] | None,
    duration_seconds: float,
) -> dict[str, Any] | None:
    """Build viewer playback metadata from optional timeline time-warp data."""
    if not flattened_timeline:
        return None
    raw_segments = flattened_timeline.get("timeWarp") or []
    if not isinstance(raw_segments, list):
        raise ValueError("timeline.timeWarp must be an array")
    if not all(isinstance(segment, dict) for segment in raw_segments):
        raise ValueError("timeline.timeWarp entries must be objects")
    normalized_segments = _normalize_playback_segments(
        raw_segments,
        duration_seconds,
    )
    return {"rateSegments": normalized_segments} if normalized_segments else None


def build_camera_trajectory_document(
    optimizer_result: dict[str, Any],
    *,
    environment_id: str,
    duration_seconds: float,
    coordinates: dict[str, Any] | None = None,
    intrinsics: dict[str, Any] | None = None,
    flattened_timeline: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """Zip an optimizer result into a validated canonical camera trajectory."""
    if not isinstance(environment_id, str) or not environment_id.strip():
        raise ValueError("environmentId is required for viewer output")
    validated_duration = _coerce_finite_number(
        duration_seconds,
        "totalDuration",
    )
    if validated_duration <= 0:
        raise ValueError("totalDuration must be positive")

    samples = _build_trajectory_samples(
        optimizer_result,
        validated_duration,
    )
    trajectory_document = {
        "schemaVersion": "1.0",
        "kind": "cameraTrajectory",
        "environmentId": environment_id,
        "clock": {
            "durationSeconds": validated_duration,
            "timeUnit": "second",
        },
        "coordinates": _validate_trajectory_coordinates(coordinates),
        "intrinsics": _normalize_trajectory_intrinsics(intrinsics),
        "orientation": {"mode": "quaternion"},
        "samples": samples,
    }
    playback_metadata = build_playback_metadata_from_timeline(
        flattened_timeline,
        validated_duration,
    )
    if playback_metadata is not None:
        trajectory_document["playback"] = playback_metadata
    return trajectory_document
