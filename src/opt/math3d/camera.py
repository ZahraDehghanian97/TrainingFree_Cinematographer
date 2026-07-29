"""Differentiable camera-axis and world-to-image projection helpers."""

from __future__ import annotations

from typing import Tuple

import torch

try:
    from .torch_quaternions import (
        normalize_vectors,
        rotate_vectors_by_quaternion,
        stable_atan2,
    )
except ImportError:  # pragma: no cover - direct script/notebook import mode
    from math3d.torch_quaternions import (
        normalize_vectors,
        rotate_vectors_by_quaternion,
        stable_atan2,
    )


def camera_axes_from_quaternions(
    quaternions: torch.Tensor,
    forward_local=(0, 0, 1),
    right_local=(1, 0, 0),
    up_local=(0, 1, 0),
) -> Tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    device, dtype = quaternions.device, quaternions.dtype
    forward_vectors = rotate_vectors_by_quaternion(
        quaternions,
        torch.tensor(forward_local, device=device, dtype=dtype),
    )
    right_vectors = rotate_vectors_by_quaternion(
        quaternions,
        torch.tensor(right_local, device=device, dtype=dtype),
    )
    up_vectors = rotate_vectors_by_quaternion(
        quaternions,
        torch.tensor(up_local, device=device, dtype=dtype),
    )
    return (
        normalize_vectors(forward_vectors),
        normalize_vectors(right_vectors),
        normalize_vectors(up_vectors),
    )


def yaw_from_forward_vectors(forward_vectors: torch.Tensor) -> torch.Tensor:
    yaw, _ = stable_atan2(
        forward_vectors[..., 0],
        -forward_vectors[..., 2],
    )
    return yaw


def pitch_from_forward_vectors(forward_vectors: torch.Tensor) -> torch.Tensor:
    horizontal_length = torch.sqrt(
        forward_vectors[..., 0] ** 2 + forward_vectors[..., 2] ** 2 + 1e-8
    )
    return torch.atan2(forward_vectors[..., 1], horizontal_length)


def project_world_points_to_pixels(
    camera_positions: torch.Tensor,
    camera_quaternions: torch.Tensor,
    world_points: torch.Tensor,
    focal_length_x: float,
    focal_length_y: float,
    principal_point_x: float,
    principal_point_y: float,
    epsilon: float = 1e-6,
):
    forward_axes, right_axes, up_axes = camera_axes_from_quaternions(camera_quaternions)
    camera_to_world_points = world_points - camera_positions[:, None, :]

    camera_x = (camera_to_world_points * right_axes[:, None, :]).sum(dim=-1)
    camera_y = (camera_to_world_points * up_axes[:, None, :]).sum(dim=-1)
    camera_depth = (camera_to_world_points * forward_axes[:, None, :]).sum(dim=-1)

    pixel_x = focal_length_x * (camera_x / (camera_depth + epsilon)) + principal_point_x
    pixel_y = principal_point_y - focal_length_y * (camera_y / (camera_depth + epsilon))

    return pixel_x, pixel_y, camera_depth
