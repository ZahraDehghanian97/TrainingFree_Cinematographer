"""Control-point storage and time conversion for solver initialization."""

import numpy as np

try:
    from ..math3d.numpy_quaternions import (
        normalize_quaternion,
        spherical_linear_interpolate,
    )
    from ..timebase import timestamp_to_frame_index
except ImportError:
    from math3d.numpy_quaternions import (
        normalize_quaternion,
        spherical_linear_interpolate,
    )
    from timebase import timestamp_to_frame_index


def merge_control_points(
    existing_control_point,
    new_control_point,
    mode="blend",
    new_weight=0.7,
):
    """Merge control points at the same time by override or pose blending."""
    if existing_control_point is None:
        return new_control_point
    if mode == "override":
        return new_control_point

    blended_position = (1 - new_weight) * existing_control_point[
        "p"
    ] + new_weight * new_control_point["p"]
    blended_quaternion = spherical_linear_interpolate(
        existing_control_point["q"],
        new_control_point["q"],
        new_weight,
    )
    merged_control_point = dict(existing_control_point)
    merged_control_point["p"] = blended_position
    merged_control_point["q"] = blended_quaternion
    return merged_control_point


class ControlPointAccumulator:
    """Collect, merge, and order initialized camera control points."""

    def __init__(
        self,
        time_mode="frame",
        total_frame_count=None,
        total_duration=None,
    ):
        self.time_mode = time_mode
        self.total_frame_count = total_frame_count
        self.total_duration = total_duration
        self._control_points_by_time = {}

    @staticmethod
    def as_control_time(time_value):
        """Convert a constraint time to the control-point key type."""
        return float(time_value)

    def time_to_frame_index(self, time_value):
        """Map a constraint time to a clamped subject-track frame index."""
        if self.total_frame_count is None:
            raise ValueError(
                "total_frames is required for subject-aware initialization"
            )
        if self.time_mode == "frame":
            frame_index = int(round(float(time_value)))
        elif self.time_mode == "seconds":
            if self.total_duration is None:
                raise ValueError("total_duration is required when time_mode='seconds'")
            frame_index = timestamp_to_frame_index(
                time_value,
                self.total_duration,
                self.total_frame_count,
            )
        elif self.time_mode == "normalized":
            frame_index = int(
                round(float(time_value) * (self.total_frame_count - 1))
            )
        else:
            raise ValueError(f"Unknown time_mode: {self.time_mode}")
        return min(max(frame_index, 0), self.total_frame_count - 1)

    def upsert_control_point(
        self,
        time_value,
        position,
        quaternion,
        override_existing=False,
    ):
        """Insert or blend one control point at its converted time."""
        control_time = self.as_control_time(time_value)
        new_control_point = {
            "t": control_time,
            "p": np.asarray(position, float),
            "q": np.array(normalize_quaternion(quaternion)),
        }
        merge_mode = "override" if override_existing else "blend"
        self._control_points_by_time[control_time] = merge_control_points(
            self._control_points_by_time.get(control_time),
            new_control_point,
            mode=merge_mode,
        )

    def upsert_repeated(
        self,
        time_value,
        position,
        quaternion,
        repeat_count,
        override_existing=False,
    ):
        """Repeat an upsert without collapsing its blend-weighting effects."""
        for _ in range(repeat_count):
            self.upsert_control_point(
                time_value,
                position,
                quaternion,
                override_existing=override_existing,
            )

    def latest_control_point_at_or_before(self, time_value):
        """Return the latest accumulated point at or before a time."""
        control_time = self.as_control_time(time_value)
        earlier_times = [
            existing_time
            for existing_time in self._control_points_by_time
            if existing_time <= control_time
        ]
        if not earlier_times:
            return None
        return self._control_points_by_time[max(earlier_times)]

    def sorted_control_points(self):
        """Return accumulated points in ascending time order."""
        return [
            self._control_points_by_time[control_time]
            for control_time in sorted(self._control_points_by_time)
        ]
