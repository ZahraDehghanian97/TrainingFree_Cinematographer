"""Differentiable spherical quadrangle interpolation for quaternions."""

import torch

try:
    from .math3d.torch_quaternions import (
        conjugate_quaternion,
        multiply_quaternions,
        normalize_quaternion,
    )
except ImportError:
    from math3d.torch_quaternions import (
        conjugate_quaternion,
        multiply_quaternions,
        normalize_quaternion,
    )


def invert_unit_quaternions(quaternions: torch.Tensor) -> torch.Tensor:
    """Invert quaternions after normalizing them to unit length."""
    return conjugate_quaternion(normalize_quaternion(quaternions))


def unit_quaternion_logarithm(
    quaternions: torch.Tensor,
    epsilon: float = 1e-8,
) -> torch.Tensor:
    """Map unit quaternions to their three-dimensional logarithms."""
    normalized_quaternions = normalize_quaternion(quaternions)
    scalar_components = normalized_quaternions[..., 0].clamp(-1.0, 1.0)
    vector_components = normalized_quaternions[..., 1:]
    vector_norms = torch.linalg.norm(
        vector_components,
        dim=-1,
        keepdim=True,
    ).clamp_min(epsilon)
    half_angles = torch.atan2(
        vector_norms,
        scalar_components.unsqueeze(-1),
    )
    return vector_components * (half_angles / vector_norms)


def quaternion_exponential(
    logarithm_vectors: torch.Tensor,
    epsilon: float = 1e-8,
) -> torch.Tensor:
    """Map three-dimensional logarithm vectors to unit quaternions."""
    half_angles = torch.linalg.norm(
        logarithm_vectors,
        dim=-1,
        keepdim=True,
    ).clamp_min(epsilon)
    rotation_axes = logarithm_vectors / half_angles
    scalar_components = torch.cos(half_angles)
    vector_components = rotation_axes * torch.sin(half_angles)
    return torch.cat(
        [scalar_components, vector_components],
        dim=-1,
    )


def spherical_linear_interpolate(
    start_quaternions: torch.Tensor,
    end_quaternions: torch.Tensor,
    interpolation_fractions: torch.Tensor,
    epsilon: float = 1e-8,
) -> torch.Tensor:
    """Interpolate quaternion pairs along their shortest spherical paths."""
    start_quaternions = normalize_quaternion(start_quaternions)
    end_quaternions = normalize_quaternion(end_quaternions)

    if interpolation_fractions.dim() == start_quaternions.dim() - 1:
        interpolation_fractions = interpolation_fractions.unsqueeze(-1)

    quaternion_similarity = (start_quaternions * end_quaternions).sum(
        dim=-1, keepdim=True
    )
    end_quaternions = torch.where(
        quaternion_similarity < 0,
        -end_quaternions,
        end_quaternions,
    )
    quaternion_similarity = (
        (start_quaternions * end_quaternions).sum(dim=-1, keepdim=True).clamp(-1.0, 1.0)
    )

    nearly_identical = quaternion_similarity > (1.0 - 1e-6)
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
    linear_interpolation = normalize_quaternion(
        (1 - interpolation_fractions) * start_quaternions
        + interpolation_fractions * end_quaternions
    )

    return torch.where(
        nearly_identical,
        linear_interpolation,
        spherical_interpolation,
    )


def compute_squad_tangents(
    previous_quaternions: torch.Tensor,
    current_quaternions: torch.Tensor,
    next_quaternions: torch.Tensor,
) -> torch.Tensor:
    """Compute Shoemake tangent quaternions for SQUAD interpolation."""
    inverse_current_quaternions = invert_unit_quaternions(current_quaternions)
    logarithm_to_next = unit_quaternion_logarithm(
        multiply_quaternions(
            inverse_current_quaternions,
            next_quaternions,
        )
    )
    logarithm_to_previous = unit_quaternion_logarithm(
        multiply_quaternions(
            inverse_current_quaternions,
            previous_quaternions,
        )
    )
    tangent_logarithm = -0.25 * (logarithm_to_next + logarithm_to_previous)
    return multiply_quaternions(
        current_quaternions,
        quaternion_exponential(tangent_logarithm),
    )


def spherical_quadrangle_interpolate(
    start_quaternions: torch.Tensor,
    end_quaternions: torch.Tensor,
    start_tangents: torch.Tensor,
    end_tangents: torch.Tensor,
    interpolation_fractions: torch.Tensor,
) -> torch.Tensor:
    """Blend endpoint and tangent SLERPs using the SQUAD curve."""
    endpoint_interpolation = spherical_linear_interpolate(
        start_quaternions,
        end_quaternions,
        interpolation_fractions,
    )
    tangent_interpolation = spherical_linear_interpolate(
        start_tangents,
        end_tangents,
        interpolation_fractions,
    )
    tangent_blend_fractions = (
        2 * interpolation_fractions * (1 - interpolation_fractions)
    )
    return spherical_linear_interpolate(
        endpoint_interpolation,
        tangent_interpolation,
        tangent_blend_fractions,
    )


def sample_squad_quaternions(
    control_times: torch.Tensor,
    control_quaternions: torch.Tensor,
    query_times: torch.Tensor,
) -> torch.Tensor:
    """Sample a differentiable SQUAD curve at the requested times."""
    device = control_quaternions.device
    control_times = control_times.to(device)
    query_times = query_times.to(device)

    control_quaternions = normalize_quaternion(control_quaternions)
    control_count = control_quaternions.shape[0]

    tangent_quaternions = torch.zeros_like(control_quaternions)
    tangent_quaternions[0] = control_quaternions[0]
    tangent_quaternions[-1] = control_quaternions[-1]
    if control_count > 2:
        tangent_quaternions[1:-1] = compute_squad_tangents(
            control_quaternions[:-2],
            control_quaternions[1:-1],
            control_quaternions[2:],
        )

    segment_indices = torch.searchsorted(control_times, query_times, right=True) - 1
    segment_indices = segment_indices.clamp(0, control_count - 2)

    segment_start_times = control_times[segment_indices]
    segment_end_times = control_times[segment_indices + 1]
    interpolation_fractions = (
        (query_times - segment_start_times)
        / (segment_end_times - segment_start_times + 1e-8)
    ).clamp(0.0, 1.0)

    segment_start_quaternions = control_quaternions[segment_indices]
    segment_end_quaternions = control_quaternions[segment_indices + 1]
    segment_start_tangents = tangent_quaternions[segment_indices]
    segment_end_tangents = tangent_quaternions[segment_indices + 1]

    return normalize_quaternion(
        spherical_quadrangle_interpolate(
            segment_start_quaternions,
            segment_end_quaternions,
            segment_start_tangents,
            segment_end_tangents,
            interpolation_fractions,
        )
    )
