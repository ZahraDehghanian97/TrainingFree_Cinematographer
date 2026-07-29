"""Pure-stdlib adapters from optimizer output to CameraTrajectoryV1."""

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

PLAYBACK_RATE_LABELS = {
    "frozen",
    "verySlow",
    "slow",
    "normal",
    "fast",
    "veryFast",
}


def _finite_number(value: Any, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a number")
    number = float(value)
    if not math.isfinite(number):
        raise ValueError(f"{name} must be finite")
    return number


def _validate_coordinates(value: dict[str, Any] | None) -> dict[str, Any]:
    coordinates = dict(value or CANONICAL_COORDINATES)
    if coordinates != CANONICAL_COORDINATES:
        raise ValueError(
            "CameraTrajectoryV1 only supports right-handed, +Y-up, -Z-forward, "
            "meter, quaternion-xyzw coordinates"
        )
    return coordinates


def _validate_intrinsics(value: dict[str, Any] | None) -> dict[str, Any]:
    intrinsics = dict(DEFAULT_INTRINSICS)
    if value is not None:
        intrinsics.update(value)
    if intrinsics.get("projection") != "perspective":
        raise ValueError("intrinsics.projection must be 'perspective'")

    fov = _finite_number(intrinsics.get("fovYDegrees"), "intrinsics.fovYDegrees")
    near = _finite_number(intrinsics.get("near"), "intrinsics.near")
    far = _finite_number(intrinsics.get("far"), "intrinsics.far")
    if not 0 < fov < 180:
        raise ValueError("intrinsics.fovYDegrees must be between 0 and 180")
    if near <= 0 or far <= near:
        raise ValueError("intrinsics must satisfy 0 < near < far")
    return {
        "projection": "perspective",
        "fovYDegrees": fov,
        "near": near,
        "far": far,
    }


def optimizer_quaternion_to_viewer(quaternion_wxyz: Iterable[Any]) -> list[float]:
    """Convert optimizer wxyz/+Z-forward orientation to viewer xyzw/-Z-forward."""
    values = list(quaternion_wxyz)
    if len(values) != 4:
        raise ValueError("optimizer quaternion must contain four wxyz components")
    w, x, y, z = (
        _finite_number(component, f"quaternion[{index}]")
        for index, component in enumerate(values)
    )
    norm = math.sqrt(w * w + x * x + y * y + z * z)
    if norm <= 1e-12:
        raise ValueError("optimizer quaternion must have non-zero length")

    # q_viewer = q_optimizer * rotationY(pi). The product in wxyz is
    # (-y, -z, w, x), then reordered to the viewer's xyzw representation.
    return [-z / norm, w / norm, x / norm, -y / norm]


def _normalized_playback_segments(
    raw_segments: Iterable[dict[str, Any]],
    duration_seconds: float,
) -> list[dict[str, Any]]:
    """Produce ordered, non-overlapping rate bands from solver time-warp data."""
    parsed: list[dict[str, Any]] = []
    seen: set[tuple[float, float, float, str | None]] = set()

    for index, segment in enumerate(raw_segments):
        start = _finite_number(
            segment.get("startTimePlayback"),
            f"timeWarp[{index}].startTimePlayback",
        )
        end = _finite_number(
            segment.get("endTimePlayback"),
            f"timeWarp[{index}].endTimePlayback",
        )
        rate = _finite_number(segment.get("rate"), f"timeWarp[{index}].rate")
        label = segment.get("label")
        if label is not None and label not in PLAYBACK_RATE_LABELS:
            raise ValueError(f"timeWarp[{index}].label is not a supported rate label")
        if start < 0 or end <= start or end > duration_seconds:
            raise ValueError(
                f"timeWarp[{index}] must fit inside 0..{duration_seconds} seconds"
            )
        if rate < 0:
            raise ValueError(f"timeWarp[{index}].rate must be non-negative")
        if label == "frozen" and rate != 0:
            raise ValueError(f"timeWarp[{index}] labeled frozen must have rate 0")

        key = (start, end, rate, label)
        if key in seen:
            continue
        seen.add(key)
        parsed.append(
            {
                "start": start,
                "end": end,
                "rate": rate,
                "label": label,
                "sourceIndex": index,
            }
        )

    if not parsed:
        return []

    boundaries = sorted(
        {value for segment in parsed for value in (segment["start"], segment["end"])}
    )
    partitioned: list[dict[str, Any]] = []
    for start, end in zip(boundaries, boundaries[1:]):
        active = [
            segment
            for segment in parsed
            if segment["start"] <= start and segment["end"] >= end
        ]
        if not active:
            continue

        # Legacy solver files contain normal-speed bands on top of an explicit
        # slow/fast band. Prefer the explicit non-normal rate, with later source
        # entries winning any remaining ambiguity.
        non_normal = [segment for segment in active if segment["rate"] != 1.0]
        chosen = max(non_normal or active, key=lambda segment: segment["sourceIndex"])
        output = {
            "startTime": start,
            "endTime": end,
            "rate": chosen["rate"],
        }
        if chosen["label"] is not None:
            output["label"] = chosen["label"]

        if (
            partitioned
            and partitioned[-1]["endTime"] == start
            and partitioned[-1]["rate"] == output["rate"]
            and partitioned[-1].get("label") == output.get("label")
        ):
            partitioned[-1]["endTime"] = end
        else:
            partitioned.append(output)
    return partitioned


def playback_from_timeline(
    flattened_timeline: dict[str, Any] | None,
    duration_seconds: float,
) -> dict[str, Any] | None:
    if not flattened_timeline:
        return None
    raw_segments = flattened_timeline.get("timeWarp") or []
    if not isinstance(raw_segments, list):
        raise ValueError("timeline.timeWarp must be an array")
    if not all(isinstance(segment, dict) for segment in raw_segments):
        raise ValueError("timeline.timeWarp entries must be objects")
    segments = _normalized_playback_segments(raw_segments, duration_seconds)
    return {"rateSegments": segments} if segments else None


def build_camera_trajectory(
    result: dict[str, Any],
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
    duration = _finite_number(duration_seconds, "totalDuration")
    if duration <= 0:
        raise ValueError("totalDuration must be positive")

    times = result.get("t_query")
    positions = result.get("P")
    quaternions = result.get("Q")
    if not all(isinstance(values, list) for values in (times, positions, quaternions)):
        raise ValueError("optimizer result must contain list-valued t_query, P, and Q")
    if not times or len(times) != len(positions) or len(times) != len(quaternions):
        raise ValueError("optimizer t_query, P, and Q must be non-empty and equal length")

    samples: list[dict[str, Any]] = []
    previous_time = -math.inf
    tolerance = max(1e-9, duration * 1e-9)
    for index, (raw_time, raw_position, raw_quaternion) in enumerate(
        zip(times, positions, quaternions)
    ):
        timestamp = _finite_number(raw_time, f"t_query[{index}]")
        if abs(timestamp) <= tolerance:
            timestamp = 0.0
        if abs(timestamp - duration) <= tolerance:
            timestamp = duration
        if timestamp < 0 or timestamp > duration:
            raise ValueError(f"t_query[{index}] lies outside 0..{duration} seconds")
        if timestamp <= previous_time:
            raise ValueError("optimizer timestamps must be strictly increasing")

        if not isinstance(raw_position, (list, tuple)) or len(raw_position) != 3:
            raise ValueError(f"P[{index}] must contain three position components")
        position = [
            _finite_number(component, f"P[{index}][{component_index}]")
            for component_index, component in enumerate(raw_position)
        ]
        samples.append(
            {
                "t": timestamp,
                "position": position,
                "rotation": optimizer_quaternion_to_viewer(raw_quaternion),
            }
        )
        previous_time = timestamp

    trajectory = {
        "schemaVersion": "1.0",
        "kind": "cameraTrajectory",
        "environmentId": environment_id,
        "clock": {
            "durationSeconds": duration,
            "timeUnit": "second",
        },
        "coordinates": _validate_coordinates(coordinates),
        "intrinsics": _validate_intrinsics(intrinsics),
        "orientation": {"mode": "quaternion"},
        "samples": samples,
    }
    playback = playback_from_timeline(flattened_timeline, duration)
    if playback is not None:
        trajectory["playback"] = playback
    return trajectory
