"""Generate initial camera poses for interval movement constraints."""

import numpy as np

try:
    from ..math3d.numpy_quaternions import (
        look_at_quaternion,
        multiply_quaternions,
        quaternion_from_axis_angle,
        rotate_vector_by_quaternion,
    )
except ImportError:
    from math3d.numpy_quaternions import (
        look_at_quaternion,
        multiply_quaternions,
        quaternion_from_axis_angle,
        rotate_vector_by_quaternion,
    )


TRANSLATION_MOVES = {
    "truckLeftMovement": ("right", -1),
    "truckRightMovement": ("right", +1),
    "dollyInMovement": ("forward", +1),
    "dollyOutMovement": ("forward", -1),
    "pedestalUpMovement": ("up", +1),
    "pedestalDownMovement": ("up", -1),
}

ROTATION_MOVES = {
    "panLeftMovement": ("yaw", +1),
    "panRightMovement": ("yaw", -1),
    "tiltUpMovement": ("pitch", +1),
    "tiltDownMovement": ("pitch", -1),
}

SUPPORTED_MOTION_TYPES = {
    "arcMovement",
    *TRANSLATION_MOVES,
    *ROTATION_MOVES,
}


def select_motion_loss_specs(loss_specs):
    """Keep supported movement losses in their original sequence."""
    return [
        loss_spec
        for loss_spec in loss_specs
        if loss_spec["type"] in SUPPORTED_MOTION_TYPES
    ]


def initial_motion_control_points(start_time, start_control_point, as_control_time):
    """Seed an interval movement sequence from its resolved start pose."""
    return [
        {
            "t": as_control_time(start_time),
            "p": start_control_point["p"].copy(),
            "q": start_control_point["q"].copy(),
        }
    ]


def generate_arc_movement(
    loss_spec,
    start_time,
    end_time,
    start_control_point,
    subject_centers,
    default_radius,
    as_control_time,
    time_to_frame_index,
):
    """Sample an orbit around a subject center."""
    subject_id = loss_spec["subjectId"]
    radius = float(loss_spec.get("radius", default_radius))
    angle_degrees = float(loss_spec.get("angleDeg", 90.0))
    angle_radians = np.deg2rad(angle_degrees)
    quarter_turn_count = max(
        1,
        int(np.ceil(abs(angle_degrees) / 90.0)),
    )
    samples_per_quarter_turn = 3
    arc_sample_count = quarter_turn_count * samples_per_quarter_turn + 1
    sample_times = np.linspace(
        as_control_time(start_time),
        as_control_time(end_time),
        arc_sample_count,
    )
    midpoint_time = (
        as_control_time(start_time) + as_control_time(end_time)
    ) / 2.0
    midpoint_frame_index = time_to_frame_index(midpoint_time)

    if subject_centers is not None and subject_id in subject_centers:
        subject_center = np.asarray(
            subject_centers[subject_id][midpoint_frame_index],
            dtype=float,
        )
    else:
        subject_center = np.zeros(3, dtype=float)

    start_position = start_control_point["p"]
    initial_offset = start_position - subject_center
    initial_planar_offset = np.array(
        [
            initial_offset[0],
            initial_offset[1],
        ],
        float,
    )
    if np.linalg.norm(initial_planar_offset) < 1e-6:
        start_angle = 0.0
    else:
        start_angle = np.arctan2(
            initial_planar_offset[1],
            initial_planar_offset[0],
        )

    generated_control_points = []
    for sample_index, sample_time in enumerate(sample_times):
        interpolation_fraction = sample_index / (len(sample_times) - 1)
        current_angle = start_angle + interpolation_fraction * angle_radians
        constant_z = start_position[2]

        camera_position = np.array(
            [
                subject_center[0] + np.cos(current_angle) * radius,
                subject_center[1] + np.sin(current_angle) * radius,
                constant_z,
            ],
            dtype=float,
        )
        camera_quaternion = look_at_quaternion(
            camera_position,
            subject_center,
        )
        generated_control_points.append(
            {
                "t": sample_time,
                "p": camera_position,
                "q": camera_quaternion,
            }
        )
    return generated_control_points


def generate_translation_movement(
    movement_type,
    loss_spec,
    constraint,
    start_time,
    end_time,
    start_control_point,
    default_sample_count,
    default_move_distance,
    as_control_time,
):
    """Sample a local-axis camera translation."""
    movement_distance = float(
        loss_spec.get(
            "distance",
            default_move_distance,
        )
    )
    sample_count = constraint.get(
        "k",
        default_sample_count,
    )
    sample_times = np.linspace(
        as_control_time(start_time),
        as_control_time(end_time),
        sample_count,
    )

    start_quaternion = start_control_point["q"]
    start_position = start_control_point["p"]
    translation_axis = _translation_axis(start_quaternion, movement_type)
    _, direction_sign = TRANSLATION_MOVES[movement_type]

    generated_control_points = []
    for sample_index, sample_time in enumerate(sample_times):
        interpolation_fraction = sample_index / (len(sample_times) - 1)
        generated_control_points.append(
            {
                "t": sample_time,
                "p": (
                    start_position
                    + direction_sign
                    * interpolation_fraction
                    * movement_distance
                    * translation_axis
                ),
                "q": start_quaternion,
            }
        )
    return generated_control_points


def _translation_axis(start_quaternion, movement_type):
    right_axis = rotate_vector_by_quaternion(
        start_quaternion,
        np.array([1, 0, 0], float),
    )
    up_axis = rotate_vector_by_quaternion(
        start_quaternion,
        np.array([0, 1, 0], float),
    )
    forward_axis = rotate_vector_by_quaternion(
        start_quaternion,
        np.array([0, 0, 1], float),
    )
    axis_name, _ = TRANSLATION_MOVES[movement_type]
    return {
        "right": right_axis,
        "up": up_axis,
        "forward": forward_axis,
    }[axis_name]


def generate_rotation_movement(
    movement_type,
    loss_spec,
    constraint,
    start_time,
    end_time,
    start_control_point,
    default_sample_count,
    as_control_time,
):
    """Sample a yaw or pitch around the camera's local axis."""
    rotation_angle = np.deg2rad(float(loss_spec.get("angleDeg", 30.0)))
    sample_count = constraint.get(
        "k",
        default_sample_count,
    )
    sample_times = np.linspace(
        as_control_time(start_time),
        as_control_time(end_time),
        sample_count,
    )

    start_position = start_control_point["p"]
    start_quaternion = start_control_point["q"]
    world_rotation_axis, direction_sign = _rotation_axis(
        start_quaternion,
        movement_type,
    )

    generated_control_points = []
    for sample_index, sample_time in enumerate(sample_times):
        interpolation_fraction = sample_index / (len(sample_times) - 1)
        incremental_rotation = quaternion_from_axis_angle(
            world_rotation_axis,
            direction_sign * interpolation_fraction * rotation_angle,
        )
        generated_control_points.append(
            {
                "t": sample_time,
                "p": start_position,
                "q": multiply_quaternions(
                    incremental_rotation,
                    start_quaternion,
                ),
            }
        )
    return generated_control_points


def _rotation_axis(start_quaternion, movement_type):
    rotation_axis_type, direction_sign = ROTATION_MOVES[movement_type]
    if rotation_axis_type == "yaw":
        local_rotation_axis = np.array(
            [0, 1, 0],
            float,
        )
    else:
        local_rotation_axis = np.array(
            [1, 0, 0],
            float,
        )
    return (
        rotate_vector_by_quaternion(
            start_quaternion,
            local_rotation_axis,
        ),
        direction_sign,
    )


def generate_interval_motion_control_points(
    constraint,
    motion_loss_specs,
    start_control_point,
    subject_centers,
    default_sample_count,
    default_radius,
    default_move_distance,
    as_control_time,
    time_to_frame_index,
):
    """Generate all movement segments for one interval in loss order."""
    start_time = constraint["t0"]
    end_time = constraint["t1"]
    generated_control_points = initial_motion_control_points(
        start_time,
        start_control_point,
        as_control_time,
    )

    for loss_spec in motion_loss_specs:
        movement_type = loss_spec["type"]
        movement_start = generated_control_points[-1]
        if movement_type == "arcMovement":
            movement_control_points = generate_arc_movement(
                loss_spec,
                start_time,
                end_time,
                movement_start,
                subject_centers,
                default_radius,
                as_control_time,
                time_to_frame_index,
            )
        elif movement_type in TRANSLATION_MOVES:
            movement_control_points = generate_translation_movement(
                movement_type,
                loss_spec,
                constraint,
                start_time,
                end_time,
                movement_start,
                default_sample_count,
                default_move_distance,
                as_control_time,
            )
        else:
            movement_control_points = generate_rotation_movement(
                movement_type,
                loss_spec,
                constraint,
                start_time,
                end_time,
                movement_start,
                default_sample_count,
                as_control_time,
            )
        generated_control_points.extend(movement_control_points)

    return generated_control_points
