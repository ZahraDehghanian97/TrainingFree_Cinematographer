"""Validation and conversion for canonical camera trajectory documents."""

from __future__ import annotations

import math
from typing import Any, Iterable


CANONICAL_COORDINATES = {
    "handedness": "right",
    "upAxis": "+Y",
    "cameraForwardAxis": "-Z",
    "lengthUnit": "meter",
    "rotationOrder": "quaternion-xyzw",
}

DEFAULT_INTRINSICS = {
    "projection": "perspective",
    "fovYDegrees": 50.0,
    "near": 0.1,
    "far": 1000.0,
}


def coerce_finite_number(value: Any, field_name: str) -> float:
    """Return a finite float or raise a field-specific validation error."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{field_name} must be a number")
    number = float(value)
    if not math.isfinite(number):
        raise ValueError(f"{field_name} must be finite")
    return number


def validate_trajectory_coordinates(
    coordinate_metadata: dict[str, Any] | None,
) -> dict[str, Any]:
    """Validate that coordinate metadata matches CameraTrajectoryV1."""
    coordinates = dict(coordinate_metadata or CANONICAL_COORDINATES)
    if coordinates != CANONICAL_COORDINATES:
        raise ValueError(
            "CameraTrajectoryV1 only supports right-handed, +Y-up, -Z-forward, "
            "meter, quaternion-xyzw coordinates"
        )
    return coordinates


def normalize_trajectory_intrinsics(
    intrinsic_metadata: dict[str, Any] | None,
) -> dict[str, Any]:
    """Merge and validate perspective-camera intrinsic metadata."""
    normalized_intrinsics = dict(DEFAULT_INTRINSICS)
    if intrinsic_metadata is not None:
        normalized_intrinsics.update(intrinsic_metadata)
    if normalized_intrinsics.get("projection") != "perspective":
        raise ValueError("intrinsics.projection must be 'perspective'")

    field_of_view_degrees = coerce_finite_number(
        normalized_intrinsics.get("fovYDegrees"),
        "intrinsics.fovYDegrees",
    )
    near_clip_distance = coerce_finite_number(
        normalized_intrinsics.get("near"),
        "intrinsics.near",
    )
    far_clip_distance = coerce_finite_number(
        normalized_intrinsics.get("far"),
        "intrinsics.far",
    )
    if not 0 < field_of_view_degrees < 180:
        raise ValueError("intrinsics.fovYDegrees must be between 0 and 180")
    if near_clip_distance <= 0 or far_clip_distance <= near_clip_distance:
        raise ValueError("intrinsics must satisfy 0 < near < far")
    return {
        "projection": "perspective",
        "fovYDegrees": field_of_view_degrees,
        "near": near_clip_distance,
        "far": far_clip_distance,
    }


def convert_optimizer_quaternion_to_viewer(
    quaternion_wxyz: Iterable[Any],
) -> list[float]:
    """Convert optimizer wxyz/+Z-forward orientation to viewer xyzw/-Z-forward."""
    quaternion_components = list(quaternion_wxyz)
    if len(quaternion_components) != 4:
        raise ValueError("optimizer quaternion must contain four wxyz components")
    w, x, y, z = (
        coerce_finite_number(component, f"quaternion[{component_index}]")
        for component_index, component in enumerate(quaternion_components)
    )
    quaternion_norm = math.sqrt(w * w + x * x + y * y + z * z)
    if quaternion_norm <= 1e-12:
        raise ValueError("optimizer quaternion must have non-zero length")

    # q_viewer = q_optimizer * rotationY(pi). The product in wxyz is
    # (-y, -z, w, x), then reordered to the viewer's xyzw representation.
    return [
        -z / quaternion_norm,
        w / quaternion_norm,
        x / quaternion_norm,
        -y / quaternion_norm,
    ]


def _validate_optimizer_sample_arrays(
    optimizer_result: dict[str, Any],
) -> tuple[list[Any], list[Any], list[Any]]:
    sample_times = optimizer_result.get("t_query")
    camera_positions = optimizer_result.get("P")
    camera_quaternions = optimizer_result.get("Q")
    if not all(
        isinstance(values, list)
        for values in (
            sample_times,
            camera_positions,
            camera_quaternions,
        )
    ):
        raise ValueError("optimizer result must contain list-valued t_query, P, and Q")
    if (
        not sample_times
        or len(sample_times) != len(camera_positions)
        or len(sample_times) != len(camera_quaternions)
    ):
        raise ValueError(
            "optimizer t_query, P, and Q must be non-empty and equal length"
        )
    return sample_times, camera_positions, camera_quaternions


def _normalize_sample_time(
    raw_time: Any,
    index: int,
    duration_seconds: float,
    previous_time: float,
) -> float:
    timestamp = coerce_finite_number(raw_time, f"t_query[{index}]")
    time_tolerance = max(1e-9, duration_seconds * 1e-9)
    if abs(timestamp) <= time_tolerance:
        timestamp = 0.0
    if abs(timestamp - duration_seconds) <= time_tolerance:
        timestamp = duration_seconds
    if timestamp < 0 or timestamp > duration_seconds:
        raise ValueError(
            f"t_query[{index}] lies outside 0..{duration_seconds} seconds"
        )
    if timestamp <= previous_time:
        raise ValueError("optimizer timestamps must be strictly increasing")
    return timestamp


def _normalize_position(raw_position: Any, index: int) -> list[float]:
    if not isinstance(raw_position, (list, tuple)) or len(raw_position) != 3:
        raise ValueError(f"P[{index}] must contain three position components")
    return [
        coerce_finite_number(
            component,
            f"P[{index}][{component_index}]",
        )
        for component_index, component in enumerate(raw_position)
    ]


def build_trajectory_samples(
    optimizer_result: dict[str, Any],
    duration_seconds: float,
) -> list[dict[str, Any]]:
    """Validate optimizer arrays and convert them to trajectory samples."""
    sample_times, camera_positions, camera_quaternions = (
        _validate_optimizer_sample_arrays(optimizer_result)
    )
    samples: list[dict[str, Any]] = []
    previous_time = -math.inf
    for index, (raw_time, raw_position, raw_quaternion) in enumerate(
        zip(sample_times, camera_positions, camera_quaternions)
    ):
        timestamp = _normalize_sample_time(
            raw_time,
            index,
            duration_seconds,
            previous_time,
        )
        samples.append(
            {
                "t": timestamp,
                "position": _normalize_position(raw_position, index),
                "rotation": convert_optimizer_quaternion_to_viewer(raw_quaternion),
            }
        )
        previous_time = timestamp
    return samples
