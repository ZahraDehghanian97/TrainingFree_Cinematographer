"""Differentiable Torch quaternion, vector, and angle primitives."""

from __future__ import annotations

from typing import Tuple

import torch


def normalize_quaternion(
    quaternion: torch.Tensor,
    epsilon: float = 1e-8,
) -> torch.Tensor:
    return quaternion / (quaternion.norm(dim=-1, keepdim=True) + epsilon)


def conjugate_quaternion(quaternion: torch.Tensor) -> torch.Tensor:
    return torch.cat(
        [quaternion[..., :1], -quaternion[..., 1:]],
        dim=-1,
    )


def multiply_quaternions(
    left_quaternion: torch.Tensor,
    right_quaternion: torch.Tensor,
) -> torch.Tensor:
    left_w, left_x, left_y, left_z = left_quaternion.unbind(dim=-1)
    right_w, right_x, right_y, right_z = right_quaternion.unbind(dim=-1)
    product_w = (
        left_w * right_w - left_x * right_x - left_y * right_y - left_z * right_z
    )
    product_x = (
        left_w * right_x + left_x * right_w + left_y * right_z - left_z * right_y
    )
    product_y = (
        left_w * right_y - left_x * right_z + left_y * right_w + left_z * right_x
    )
    product_z = (
        left_w * right_z + left_x * right_y - left_y * right_x + left_z * right_w
    )
    return torch.stack(
        [product_w, product_x, product_y, product_z],
        dim=-1,
    )


def rotate_vectors_by_quaternion(
    quaternion: torch.Tensor,
    vectors: torch.Tensor,
) -> torch.Tensor:
    normalized_quaternion = normalize_quaternion(quaternion)
    vector_quaternion = torch.cat(
        [torch.zeros_like(vectors[..., :1]), vectors],
        dim=-1,
    )
    return multiply_quaternions(
        multiply_quaternions(normalized_quaternion, vector_quaternion),
        conjugate_quaternion(normalized_quaternion),
    )[..., 1:]


def stabilized_vector_norm(
    vectors: torch.Tensor,
    epsilon: float = 1e-8,
) -> torch.Tensor:
    return torch.sqrt((vectors * vectors).sum(dim=-1, keepdim=True) + epsilon)


def normalize_vectors(
    vectors: torch.Tensor,
    epsilon: float = 1e-8,
) -> torch.Tensor:
    return vectors / stabilized_vector_norm(vectors, epsilon)


def stable_atan2(
    y: torch.Tensor,
    x: torch.Tensor,
    eps: float = 1e-12,
) -> Tuple[torch.Tensor, torch.Tensor]:
    """Evaluate atan2 with finite gradients when both planar components are zero."""
    valid = (x.square() + y.square()) > eps
    safe_y = torch.where(valid, y, torch.zeros_like(y))
    safe_x = torch.where(valid, x, torch.ones_like(x))
    return torch.atan2(safe_y, safe_x), valid


def vector_dot_product(
    left_vectors: torch.Tensor,
    right_vectors: torch.Tensor,
) -> torch.Tensor:
    return (left_vectors * right_vectors).sum(dim=-1, keepdim=True)


def look_at_alignment_loss(
    forward_unit_vectors: torch.Tensor,
    target_direction_unit_vectors: torch.Tensor,
) -> torch.Tensor:
    """(1 - cos(theta)) between forward and the desired look direction.

    NOT squared-alignment (1 - cos^2) — that form is zero both when
    forward exactly matches target_direction AND when it points exactly
    AWAY from it, since cos(180 deg) = -1 squares to the same 1 as
    cos(0 deg). That let the optimizer treat "facing the subject" and
    "facing directly away from the subject" as equally loss-free, which is
    never the intent of a look-at loss. Matches arc.py's arc/lookat
    formulation ((1 - cos_theta) ** 2), which never had this ambiguity.
    """
    alignment = vector_dot_product(
        forward_unit_vectors,
        target_direction_unit_vectors,
    ).clamp(-1.0, 1.0)
    return (1.0 - alignment) ** 2


def scalar_projection(
    vectors: torch.Tensor,
    axis_unit_vectors: torch.Tensor,
) -> torch.Tensor:
    """Return v·axis for broadcastable vectors and unit axes."""
    return (vectors * axis_unit_vectors).sum(dim=-1, keepdim=True)


def unwrap_angles(angles: torch.Tensor) -> torch.Tensor:
    if angles.numel() <= 1:
        return angles

    angle_steps = angles[1:] - angles[:-1]
    wrapped_steps = torch.atan2(
        torch.sin(angle_steps),
        torch.cos(angle_steps),
    )
    return torch.cat(
        [
            angles[:1],
            angles[:1] + torch.cumsum(wrapped_steps, dim=0),
        ],
        dim=0,
    )