import numpy as np
from scipy.interpolate import BSpline


def create_open_uniform_knot_vector(
    control_point_count: int,
    degree: int,
) -> np.ndarray:
    """Create a clamped, open-uniform B-spline knot vector."""
    knot_count = control_point_count + degree + 1
    internal_knot_count = knot_count - 2 * (degree + 1)
    if internal_knot_count < 0:
        raise ValueError("Need n_ctrl >= degree+1")

    if internal_knot_count == 0:
        internal_knots = np.array([])
    else:
        internal_knots = np.linspace(0, 1, internal_knot_count + 2)[1:-1]

    return np.concatenate(
        [
            np.zeros(degree + 1),
            internal_knots,
            np.ones(degree + 1),
        ]
    )


def build_bspline_basis_matrix(
    parameter_values: np.ndarray,
    knots: np.ndarray,
    degree: int,
    derivative_order: int = 0,
) -> np.ndarray:
    """Evaluate every B-spline basis function at each parameter value."""
    parameter_values = np.asarray(parameter_values)
    control_point_count = len(knots) - degree - 1
    basis_matrix = np.zeros(
        (len(parameter_values), control_point_count),
        dtype=float,
    )

    for control_point_index in range(control_point_count):
        coefficients = np.zeros(control_point_count)
        coefficients[control_point_index] = 1.0
        basis_spline = BSpline(
            knots,
            coefficients,
            degree,
            extrapolate=False,
        )
        if derivative_order > 0:
            basis_spline = basis_spline.derivative(derivative_order)
        basis_matrix[:, control_point_index] = basis_spline(parameter_values)

    return np.nan_to_num(basis_matrix, nan=0.0)


if __name__ == "__main__":
    # number of frames (time steps)
    frame_count = 80
    # time steps
    parameter_values = np.linspace(0.0, 1.0, frame_count)
    # degree of B spline
    degree = 3  # degree
    control_point_count = 12
    knots = create_open_uniform_knot_vector(control_point_count, degree)
    # Precompute basis matrices (position + derivatives for smoothness)
    position_basis = build_bspline_basis_matrix(
        parameter_values,
        knots,
        degree,
        derivative_order=0,
    )
    velocity_basis = build_bspline_basis_matrix(
        parameter_values,
        knots,
        degree,
        derivative_order=1,
    )
    acceleration_basis = build_bspline_basis_matrix(
        parameter_values,
        knots,
        degree,
        derivative_order=2,
    )
    # key frames
    keyframe_indices = np.array([0, 20, 40])
    keyframe_positions = np.array(
        [
            [0.0, 0.0, 0.0],
            [1.0, 0, 0.0],
            [2.0, 0, 0.0],
        ]
    )
    initial_control_points = np.zeros((control_point_count, 3))
    initial_control_points[:, 0] = np.linspace(
        keyframe_positions[0, 0],
        keyframe_positions[-1, 0],
        control_point_count,
    )
    initial_control_points[:, 1] = np.linspace(
        keyframe_positions[0, 1],
        keyframe_positions[-1, 1],
        control_point_count,
    )
    initial_control_points[:, 2] = np.linspace(
        keyframe_positions[0, 2],
        keyframe_positions[-1, 2],
        control_point_count,
    )
    flattened_control_points = initial_control_points.reshape(-1)
    velocity = velocity_basis @ flattened_control_points
    acceleration = acceleration_basis @ flattened_control_points
    trajectory = position_basis @ flattened_control_points
