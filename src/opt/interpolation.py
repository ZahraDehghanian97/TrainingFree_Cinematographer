"""Differentiable interpolation helpers for camera trajectories."""

import torch

try:
    from .math3d.torch_quaternions import (
        normalize_quaternion,
        vector_dot_product,
    )
except ImportError:
    from math3d.torch_quaternions import (
        normalize_quaternion,
        vector_dot_product,
    )


def spherical_linear_interpolate_quaternions(
    start_quaternions: torch.Tensor,
    end_quaternions: torch.Tensor,
    interpolation_fractions: torch.Tensor,
    epsilon: float = 1e-8,
) -> torch.Tensor:
    """Interpolate quaternion pairs along their shortest spherical paths."""
    start_quaternions = normalize_quaternion(
        start_quaternions,
        epsilon,
    )
    end_quaternions = normalize_quaternion(
        end_quaternions,
        epsilon,
    )

    quaternion_similarity = vector_dot_product(
        start_quaternions,
        end_quaternions,
    )
    end_quaternions = torch.where(
        quaternion_similarity < 0,
        -end_quaternions,
        end_quaternions,
    )
    quaternion_similarity = quaternion_similarity.abs().clamp(-1.0, 1.0)

    nearly_identical = quaternion_similarity > 1.0 - 1e-6
    if nearly_identical.any():
        linear_interpolation = normalize_quaternion(
            (1 - interpolation_fractions) * start_quaternions
            + interpolation_fractions * end_quaternions,
            epsilon,
        )

    angular_distance = torch.acos(quaternion_similarity)
    sine_angular_distance = torch.sin(angular_distance).clamp_min(epsilon)
    start_weights = (
        torch.sin((1 - interpolation_fractions) * angular_distance)
        / sine_angular_distance
    )
    end_weights = (
        torch.sin(interpolation_fractions * angular_distance) / sine_angular_distance
    )
    spherical_interpolation = (
        start_weights * start_quaternions + end_weights * end_quaternions
    )
    spherical_interpolation = normalize_quaternion(
        spherical_interpolation,
        epsilon,
    )

    if nearly_identical.any():
        spherical_interpolation = torch.where(
            nearly_identical,
            linear_interpolation,
            spherical_interpolation,
        )
    return spherical_interpolation


def build_linear_interpolation_matrix(
    control_times: torch.Tensor,
    query_times: torch.Tensor,
) -> torch.Tensor:
    """Build weights that linearly interpolate control values at query times."""
    device = control_times.device
    dtype = control_times.dtype
    control_count = control_times.shape[0]
    query_count = query_times.shape[0]

    segment_indices = torch.searchsorted(control_times, query_times, right=True) - 1
    segment_indices = segment_indices.clamp(0, control_count - 2)

    segment_start_times = control_times[segment_indices]
    segment_end_times = control_times[segment_indices + 1]
    interpolation_fractions = (
        (query_times - segment_start_times)
        / (segment_end_times - segment_start_times + 1e-12)
    ).clamp(0.0, 1.0)

    interpolation_matrix = torch.zeros(
        (query_count, control_count),
        device=device,
        dtype=dtype,
    )
    query_indices = torch.arange(query_count, device=device)

    interpolation_matrix[query_indices, segment_indices] += (
        1.0 - interpolation_fractions
    )
    interpolation_matrix[query_indices, segment_indices + 1] += interpolation_fractions

    interpolation_matrix[0, :] = 0
    interpolation_matrix[0, 0] = 1
    interpolation_matrix[-1, :] = 0
    interpolation_matrix[-1, -1] = 1
    return interpolation_matrix


def interpolate_quaternions_piecewise(
    control_times: torch.Tensor,
    control_quaternions: torch.Tensor,
    query_times: torch.Tensor,
) -> torch.Tensor:
    """Piecewise-SLERP control quaternions at the requested times."""
    control_count = control_times.shape[0]

    segment_indices = torch.searchsorted(control_times, query_times, right=True) - 1
    segment_indices = segment_indices.clamp(0, control_count - 2)

    segment_start_times = control_times[segment_indices]
    segment_end_times = control_times[segment_indices + 1]
    interpolation_fractions = (
        (
            (query_times - segment_start_times)
            / (segment_end_times - segment_start_times + 1e-12)
        )
        .clamp(0.0, 1.0)
        .unsqueeze(-1)
    )

    segment_start_quaternions = control_quaternions[segment_indices]
    segment_end_quaternions = control_quaternions[segment_indices + 1]

    interpolated_quaternions = spherical_linear_interpolate_quaternions(
        segment_start_quaternions,
        segment_end_quaternions,
        interpolation_fractions,
    )

    interpolated_quaternions[0] = normalize_quaternion(control_quaternions[0])
    interpolated_quaternions[-1] = normalize_quaternion(control_quaternions[-1])
    return interpolated_quaternions
