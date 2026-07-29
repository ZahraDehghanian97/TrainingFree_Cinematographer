"""Initialize camera control points from point and interval constraints."""

import numpy as np

try:
    from .solver.control_points import ControlPointAccumulator as _ControlPointAccumulator
    from .solver.motion_initialization import (
        generate_interval_motion_control_points as _generate_interval_motion_control_points,
        select_motion_loss_specs as _select_motion_loss_specs,
    )
    from .math3d.numpy_quaternions import look_at_quaternion
except ImportError:
    from solver.control_points import ControlPointAccumulator as _ControlPointAccumulator
    from solver.motion_initialization import (
        generate_interval_motion_control_points as _generate_interval_motion_control_points,
        select_motion_loss_specs as _select_motion_loss_specs,
    )
    from math3d.numpy_quaternions import look_at_quaternion


SHOT_HEIGHT_FRACTIONS = {
    "extremeCloseUp": 0.80,
    "closeUp": 0.60,
    "mediumCloseUp": 0.45,
    "mediumShot": 0.35,
    "mediumLongShot": 0.25,
    "fullShot": 0.18,
    "longShot": 0.12,
    "veryLongShot": 0.08,
    "extremeLongShot": 0.05,
}
VIEW_YAW_DEGREES = {
    "front": 0.0,
    "threeQuarterFrontLeft": 45.0,
    "threeQuarterFrontRight": -45.0,
    "left": 90.0,
    "right": -90.0,
    "threeQuarterBackLeft": 135.0,
    "threeQuarterBackRight": -135.0,
    "back": 180.0,
}

_POINT_UPSERT_COUNT = 3


def bounding_box_center(bounding_box):
    """Return the pixel center of an x1/y1/x2/y2 bounding box."""
    return np.array(
        [
            (bounding_box["x1"] + bounding_box["x2"]) / 2.0,
            (bounding_box["y1"] + bounding_box["y2"]) / 2.0,
        ],
        dtype=float,
    )


def bounding_box_height_fraction(bounding_box, image_height):
    """Return bounding-box height as a fraction of image height."""
    return float((bounding_box["y2"] - bounding_box["y1"]) / max(image_height, 1.0))


def estimate_camera_distance_for_shot_size(
    bounding_box,
    shot_size,
    image_height,
    base_distance=4.0,
):
    """Estimate camera distance from the observed and desired shot sizes."""
    target_height_fraction = SHOT_HEIGHT_FRACTIONS.get(shot_size, 0.25)
    observed_height_fraction = bounding_box_height_fraction(
        bounding_box,
        image_height,
    )
    observed_height_fraction = max(observed_height_fraction, 1e-3)
    distance_scale = observed_height_fraction / target_height_fraction
    return base_distance * distance_scale


def estimate_subject_world_center(subject_track, frame_index):
    """Read a subject's 3D center, falling back to its 2D box center."""
    frame_data = subject_track[frame_index]
    if "center3d" in frame_data:
        return np.array(frame_data["center3d"], dtype=float)

    pixel_center = bounding_box_center(frame_data["bbox"])
    return np.array(
        [
            pixel_center[0],
            0.0,
            pixel_center[1],
        ],
        dtype=float,
    )


def _point_subject_id(constraint, loss_specs):
    subject_id = constraint.get("subjectId", None)
    if subject_id is not None:
        return subject_id
    return next(
        (
            loss_spec.get("subjectId")
            for loss_spec in loss_specs
            if loss_spec.get("subjectId") is not None
        ),
        None,
    )


def _upsert_explicit_point(constraint, accumulator):
    camera_position = np.array(
        constraint["position"],
        float,
    )
    camera_quaternion = np.array(
        constraint["quaternion"],
        float,
    )
    accumulator.upsert_repeated(
        constraint["t"],
        camera_position,
        camera_quaternion,
        repeat_count=_POINT_UPSERT_COUNT,
        override_existing=True,
    )


def _read_subject_point_losses(loss_specs, control_time, accumulator):
    shot_size = None
    subject_view = "front"

    for loss_spec in loss_specs:
        if loss_spec["type"] == "NonSubjectAware":
            loss_position = np.array(loss_spec["p"])
            loss_quaternion = np.array(loss_spec["q"])
            accumulator.upsert_repeated(
                control_time,
                loss_position,
                loss_quaternion,
                repeat_count=_POINT_UPSERT_COUNT,
                override_existing=True,
            )

        if loss_spec["type"] == "shotSize":
            shot_size = loss_spec.get("shotSize")
        if loss_spec["type"] == "subjectView":
            subject_view = loss_spec.get("view", subject_view)

    return shot_size, subject_view


def _subject_camera_pose(
    subject_track,
    frame_index,
    subject_center,
    shot_size,
    subject_view,
    image_height,
):
    subject_bounding_box = subject_track[frame_index]["bbox"]
    camera_distance = estimate_camera_distance_for_shot_size(
        subject_bounding_box,
        shot_size or "mediumLongShot",
        image_height,
    )
    view_yaw_radians = np.deg2rad(VIEW_YAW_DEGREES.get(subject_view, 0.0))
    camera_offset = np.array(
        [
            np.sin(view_yaw_radians) * camera_distance,
            0.0,
            -np.cos(view_yaw_radians) * camera_distance,
        ],
        float,
    )
    camera_position = subject_center + camera_offset
    return (
        camera_position,
        look_at_quaternion(
            camera_position,
            subject_center,
        ),
    )


def _handle_subject_point(
    constraint,
    loss_specs,
    subject_id,
    subject_tracks,
    image_height,
    accumulator,
):
    control_time = constraint["t"]
    frame_index = accumulator.time_to_frame_index(control_time)
    subject_track = subject_tracks[subject_id]
    subject_center = estimate_subject_world_center(
        subject_track,
        frame_index,
    )
    shot_size, subject_view = _read_subject_point_losses(
        loss_specs,
        control_time,
        accumulator,
    )
    camera_position, camera_quaternion = _subject_camera_pose(
        subject_track,
        frame_index,
        subject_center,
        shot_size,
        subject_view,
        image_height,
    )
    accumulator.upsert_repeated(
        control_time,
        camera_position,
        camera_quaternion,
        repeat_count=_POINT_UPSERT_COUNT,
    )


def _handle_point_constraint(
    constraint,
    loss_specs,
    subject_tracks,
    image_height,
    accumulator,
):
    subject_id = _point_subject_id(constraint, loss_specs)
    if subject_id is None:
        _upsert_explicit_point(constraint, accumulator)
        return
    _handle_subject_point(
        constraint,
        loss_specs,
        subject_id,
        subject_tracks,
        image_height,
        accumulator,
    )


def _resolve_interval_start(start_time, accumulator):
    start_control_point = accumulator.latest_control_point_at_or_before(start_time)
    if start_control_point is not None:
        return start_control_point

    start_control_point = {
        "t": accumulator.as_control_time(start_time),
        "p": np.array([0, 0, 0], float),
        "q": np.array([1, 0, 0, 0], float),
    }
    accumulator.upsert_control_point(
        start_time,
        start_control_point["p"],
        start_control_point["q"],
    )
    return start_control_point


def _initialize_stationary_interval(
    constraint,
    start_control_point,
    default_sample_count,
    accumulator,
):
    sample_count = constraint.get(
        "k",
        default_sample_count,
    )
    sample_times = np.linspace(
        accumulator.as_control_time(constraint["t0"]),
        accumulator.as_control_time(constraint["t1"]),
        sample_count,
    )
    for sample_time in sample_times:
        accumulator.upsert_control_point(
            sample_time,
            start_control_point["p"],
            start_control_point["q"],
        )


def _upsert_generated_control_points(generated_control_points, accumulator):
    for generated_control_point in generated_control_points:
        accumulator.upsert_control_point(
            generated_control_point["t"],
            generated_control_point["p"],
            generated_control_point["q"],
        )


def _handle_interval_constraint(
    constraint,
    loss_specs,
    subject_centers,
    default_sample_count,
    default_radius,
    default_move_distance,
    accumulator,
):
    start_control_point = _resolve_interval_start(
        constraint["t0"],
        accumulator,
    )
    motion_loss_specs = _select_motion_loss_specs(loss_specs)
    if not motion_loss_specs:
        _initialize_stationary_interval(
            constraint,
            start_control_point,
            default_sample_count,
            accumulator,
        )
        return

    generated_control_points = _generate_interval_motion_control_points(
        constraint,
        motion_loss_specs,
        start_control_point,
        subject_centers,
        default_sample_count,
        default_radius,
        default_move_distance,
        accumulator.as_control_time,
        accumulator.time_to_frame_index,
    )
    _upsert_generated_control_points(
        generated_control_points,
        accumulator,
    )


def initialize_camera_control_points(
    constraints,
    subject_tracks,
    image_width,
    image_height,
    subject_centers=None,
    default_sample_count=4,
    default_radius=4.0,
    default_move_distance=1.0,
    time_mode="frame",
    total_frame_count=None,
    total_duration=None,
):
    """Construct initial camera control points from timeline constraints."""
    accumulator = _ControlPointAccumulator(
        time_mode=time_mode,
        total_frame_count=total_frame_count,
        total_duration=total_duration,
    )

    for constraint in constraints:
        constraint_kind = constraint["kind"]
        loss_specs = constraint.get("losses", [])
        if constraint_kind == "point":
            _handle_point_constraint(
                constraint,
                loss_specs,
                subject_tracks,
                image_height,
                accumulator,
            )
        elif constraint_kind == "interval":
            _handle_interval_constraint(
                constraint,
                loss_specs,
                subject_centers,
                default_sample_count,
                default_radius,
                default_move_distance,
                accumulator,
            )
        else:
            raise ValueError(f"Unknown constraint kind: {constraint_kind}")

    return accumulator.sorted_control_points()
