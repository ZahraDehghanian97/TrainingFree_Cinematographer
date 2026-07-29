"""Helpers for mapping the timeline's seconds to optimizer sample indices."""

from __future__ import annotations

from copy import deepcopy
import math
from typing import Any


def frame_count_for_duration(total_duration: float, fps: float) -> int:
    """Return a sample count that includes both t=0 and the duration endpoint."""
    duration = float(total_duration)
    sample_rate = float(fps)
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("total_duration must be a positive finite number")
    if not math.isfinite(sample_rate) or sample_rate <= 0:
        raise ValueError("fps must be a positive finite number")
    return max(2, int(round(duration * sample_rate)) + 1)


def seconds_to_frame_index(
    time_seconds: float,
    total_duration: float,
    total_frames: int,
) -> int:
    """Map a playback timestamp to the nearest inclusive trajectory sample."""
    timestamp = float(time_seconds)
    duration = float(total_duration)
    if not math.isfinite(timestamp):
        raise ValueError("time_seconds must be finite")
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("total_duration must be a positive finite number")
    if total_frames < 2:
        raise ValueError("total_frames must be at least 2")

    clamped = min(max(timestamp, 0.0), duration)
    return int(round(clamped * (total_frames - 1) / duration))


def constraints_seconds_to_frames(
    constraints: list[dict[str, Any]],
    total_duration: float,
    total_frames: int,
) -> list[dict[str, Any]]:
    """Copy constraints and translate only their time coordinates to indices."""
    converted = deepcopy(constraints)
    for constraint in converted:
        kind = constraint.get("kind")
        if kind == "point":
            constraint["t"] = seconds_to_frame_index(
                constraint["t"],
                total_duration,
                total_frames,
            )
        elif kind == "interval":
            constraint["t0"] = seconds_to_frame_index(
                constraint["t0"],
                total_duration,
                total_frames,
            )
            constraint["t1"] = seconds_to_frame_index(
                constraint["t1"],
                total_duration,
                total_frames,
            )
        else:
            raise ValueError(f"Unknown constraint kind: {kind}")
    return converted
