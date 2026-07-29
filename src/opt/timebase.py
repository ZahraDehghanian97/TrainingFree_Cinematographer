"""Helpers for mapping the timeline's seconds to optimizer sample indices."""

from __future__ import annotations

from copy import deepcopy
import math
from typing import Any


def calculate_inclusive_frame_count(
    duration_seconds: float,
    frames_per_second: float,
) -> int:
    """Return a sample count that includes both t=0 and the duration endpoint."""
    duration_seconds = float(duration_seconds)
    frames_per_second = float(frames_per_second)
    if not math.isfinite(duration_seconds) or duration_seconds <= 0:
        raise ValueError("total_duration must be a positive finite number")
    if not math.isfinite(frames_per_second) or frames_per_second <= 0:
        raise ValueError("fps must be a positive finite number")
    return max(2, int(round(duration_seconds * frames_per_second)) + 1)


def timestamp_to_frame_index(
    time_seconds: float,
    duration_seconds: float,
    frame_count: int,
) -> int:
    """Map a playback timestamp to the nearest inclusive trajectory sample."""
    timestamp = float(time_seconds)
    duration_seconds = float(duration_seconds)
    if not math.isfinite(timestamp):
        raise ValueError("time_seconds must be finite")
    if not math.isfinite(duration_seconds) or duration_seconds <= 0:
        raise ValueError("total_duration must be a positive finite number")
    if frame_count < 2:
        raise ValueError("total_frames must be at least 2")

    clamped_timestamp = min(max(timestamp, 0.0), duration_seconds)
    return int(round(clamped_timestamp * (frame_count - 1) / duration_seconds))


def convert_constraint_times_to_frame_indices(
    constraints: list[dict[str, Any]],
    duration_seconds: float,
    frame_count: int,
) -> list[dict[str, Any]]:
    """Copy constraints and translate only their time coordinates to indices."""
    converted_constraints = deepcopy(constraints)
    for constraint in converted_constraints:
        constraint_kind = constraint.get("kind")
        if constraint_kind == "point":
            constraint["t"] = timestamp_to_frame_index(
                constraint["t"],
                duration_seconds,
                frame_count,
            )
        elif constraint_kind == "interval":
            constraint["t0"] = timestamp_to_frame_index(
                constraint["t0"],
                duration_seconds,
                frame_count,
            )
            constraint["t1"] = timestamp_to_frame_index(
                constraint["t1"],
                duration_seconds,
                frame_count,
            )
        else:
            raise ValueError(f"Unknown constraint kind: {constraint_kind}")
    return converted_constraints
