"""NumPy helpers for wxyz quaternions and look-at orientations."""

import numpy as np


def normalize_quaternion(quaternion, epsilon=1e-9):
    """Return a normalized wxyz quaternion as a NumPy array."""
    quaternion = np.asarray(quaternion, dtype=float)
    return quaternion / (np.linalg.norm(quaternion) + epsilon)


def multiply_quaternions(left_quaternion, right_quaternion):
    """Multiply two wxyz quaternions."""
    left_w, left_x, left_y, left_z = left_quaternion
    right_w, right_x, right_y, right_z = right_quaternion
    return np.array(
        [
            left_w * right_w - left_x * right_x - left_y * right_y - left_z * right_z,
            left_w * right_x + left_x * right_w + left_y * right_z - left_z * right_y,
            left_w * right_y - left_x * right_z + left_y * right_w + left_z * right_x,
            left_w * right_z + left_x * right_y - left_y * right_x + left_z * right_w,
        ],
        dtype=float,
    )


def quaternion_conjugate(quaternion):
    """Return the conjugate of a wxyz quaternion."""
    return np.array(
        [
            quaternion[0],
            -quaternion[1],
            -quaternion[2],
            -quaternion[3],
        ],
        dtype=float,
    )


def rotate_vector_by_quaternion(quaternion, vector):
    """Rotate a three-dimensional vector by a wxyz quaternion."""
    vector_quaternion = np.array(
        [
            0.0,
            vector[0],
            vector[1],
            vector[2],
        ]
    )
    return multiply_quaternions(
        multiply_quaternions(quaternion, vector_quaternion),
        quaternion_conjugate(quaternion),
    )[1:]


def quaternion_from_axis_angle(axis, angle_radians):
    """Build a wxyz quaternion from an axis and angle in radians."""
    normalized_axis = np.asarray(axis, dtype=float)
    normalized_axis = normalized_axis / (np.linalg.norm(normalized_axis) + 1e-9)
    sine_half_angle = np.sin(angle_radians / 2.0)
    return normalize_quaternion(
        np.array(
            [
                np.cos(angle_radians / 2.0),
                normalized_axis[0] * sine_half_angle,
                normalized_axis[1] * sine_half_angle,
                normalized_axis[2] * sine_half_angle,
            ]
        )
    )


def look_at_quaternion(
    camera_position,
    target_position,
    world_up=np.array([0, 1, 0], dtype=float),
):
    """Return the wxyz orientation that points +Z toward a target."""
    rotation_matrix = _look_at_rotation_matrix(
        camera_position,
        target_position,
        world_up,
    )
    if rotation_matrix is None:
        return np.array([1, 0, 0, 0], dtype=float)
    return normalize_quaternion(
        _quaternion_from_rotation_matrix(rotation_matrix)
    )


def _look_at_rotation_matrix(camera_position, target_position, world_up):
    forward_direction = np.asarray(
        target_position - camera_position,
        dtype=float,
    )
    forward_norm = np.linalg.norm(forward_direction)
    if forward_norm < 1e-9:
        return None
    forward_direction = forward_direction / forward_norm

    normalized_world_up = world_up / (np.linalg.norm(world_up) + 1e-9)
    right_direction = np.cross(normalized_world_up, forward_direction)
    right_norm = np.linalg.norm(right_direction)
    if right_norm < 1e-9:
        right_direction = np.array([1, 0, 0], dtype=float)
    else:
        right_direction = right_direction / right_norm
    corrected_up_direction = np.cross(
        forward_direction,
        right_direction,
    )
    return np.stack(
        [right_direction, corrected_up_direction, forward_direction],
        axis=1,
    )


def _quaternion_from_rotation_matrix(rotation_matrix):
    matrix_trace = np.trace(rotation_matrix)
    if matrix_trace > 0:
        return _positive_trace_quaternion(rotation_matrix, matrix_trace)
    if (
        rotation_matrix[0, 0] > rotation_matrix[1, 1]
        and rotation_matrix[0, 0] > rotation_matrix[2, 2]
    ):
        return _dominant_x_quaternion(rotation_matrix)
    if rotation_matrix[1, 1] > rotation_matrix[2, 2]:
        return _dominant_y_quaternion(rotation_matrix)
    return _dominant_z_quaternion(rotation_matrix)


def _positive_trace_quaternion(rotation_matrix, matrix_trace):
    quaternion_scale = np.sqrt(matrix_trace + 1.0) * 2
    return np.array(
        [
            0.25 * quaternion_scale,
            (rotation_matrix[2, 1] - rotation_matrix[1, 2]) / quaternion_scale,
            (rotation_matrix[0, 2] - rotation_matrix[2, 0]) / quaternion_scale,
            (rotation_matrix[1, 0] - rotation_matrix[0, 1]) / quaternion_scale,
        ],
        dtype=float,
    )


def _dominant_x_quaternion(rotation_matrix):
    quaternion_scale = (
        np.sqrt(
            1.0
            + rotation_matrix[0, 0]
            - rotation_matrix[1, 1]
            - rotation_matrix[2, 2]
        )
        * 2
    )
    return np.array(
        [
            (rotation_matrix[2, 1] - rotation_matrix[1, 2]) / quaternion_scale,
            0.25 * quaternion_scale,
            (rotation_matrix[0, 1] + rotation_matrix[1, 0]) / quaternion_scale,
            (rotation_matrix[0, 2] + rotation_matrix[2, 0]) / quaternion_scale,
        ],
        dtype=float,
    )


def _dominant_y_quaternion(rotation_matrix):
    quaternion_scale = (
        np.sqrt(
            1.0
            + rotation_matrix[1, 1]
            - rotation_matrix[0, 0]
            - rotation_matrix[2, 2]
        )
        * 2
    )
    return np.array(
        [
            (rotation_matrix[0, 2] - rotation_matrix[2, 0]) / quaternion_scale,
            (rotation_matrix[0, 1] + rotation_matrix[1, 0]) / quaternion_scale,
            0.25 * quaternion_scale,
            (rotation_matrix[1, 2] + rotation_matrix[2, 1]) / quaternion_scale,
        ],
        dtype=float,
    )


def _dominant_z_quaternion(rotation_matrix):
    quaternion_scale = (
        np.sqrt(
            1.0
            + rotation_matrix[2, 2]
            - rotation_matrix[0, 0]
            - rotation_matrix[1, 1]
        )
        * 2
    )
    return np.array(
        [
            (rotation_matrix[1, 0] - rotation_matrix[0, 1]) / quaternion_scale,
            (rotation_matrix[0, 2] + rotation_matrix[2, 0]) / quaternion_scale,
            (rotation_matrix[1, 2] + rotation_matrix[2, 1]) / quaternion_scale,
            0.25 * quaternion_scale,
        ],
        dtype=float,
    )


def spherical_linear_interpolate(
    start_quaternion,
    end_quaternion,
    interpolation_fraction,
):
    """Interpolate two wxyz quaternions along their shortest path."""
    start_quaternion = normalize_quaternion(start_quaternion)
    end_quaternion = normalize_quaternion(end_quaternion)
    quaternion_similarity = float(np.dot(start_quaternion, end_quaternion))
    if quaternion_similarity < 0.0:
        end_quaternion = -end_quaternion
        quaternion_similarity = -quaternion_similarity
    quaternion_similarity = np.clip(
        quaternion_similarity,
        -1.0,
        1.0,
    )
    if quaternion_similarity > 0.9995:
        return normalize_quaternion(
            (1 - interpolation_fraction) * start_quaternion
            + interpolation_fraction * end_quaternion
        )
    angular_distance = np.arccos(quaternion_similarity)
    sine_angular_distance = np.sin(angular_distance)
    return normalize_quaternion(
        np.sin((1 - interpolation_fraction) * angular_distance)
        / sine_angular_distance
        * start_quaternion
        + np.sin(interpolation_fraction * angular_distance)
        / sine_angular_distance
        * end_quaternion
    )
