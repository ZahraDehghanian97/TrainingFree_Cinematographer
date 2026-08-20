"""Arc-movement losses with flexible plane orientation and height support."""

from __future__ import annotations

from dataclasses import dataclass
import math
from typing import Dict, Optional

import torch
import torch.nn.functional as F

try:
    from ..math3d.camera import camera_axes_from_quaternions
except ImportError:  # pragma: no cover
    from math3d.camera import camera_axes_from_quaternions

from .config import LOSS_WEIGHTS
from .interval import clamp_frame_interval
from .robust import huber_loss as _huber_loss


@dataclass(frozen=True)
class _ArcTrajectory:
    interval_positions: torch.Tensor
    interval_quaternions: torch.Tensor
    interval_centers: torch.Tensor
    interval_subject_offsets: torch.Tensor


def _normalize_offsets(
    offsets: torch.Tensor,
    epsilon: float = 1e-8,
) -> torch.Tensor:
    return offsets / torch.sqrt(
        (offsets * offsets).sum(dim=-1, keepdim=True) + epsilon
    )


def _project_to_plane(
    vectors: torch.Tensor,
    plane_normal: torch.Tensor,
) -> torch.Tensor:
    normal_components = (vectors * plane_normal[None, :]).sum(dim=-1, keepdim=True)
    return vectors - normal_components * plane_normal[None, :]


def _subject_centers_at_indices(
    subject_centers: torch.Tensor,
    indices: torch.Tensor,
    position_count: int,
    camera_positions: torch.Tensor,
) -> torch.Tensor:
    if subject_centers.ndim == 1:
        return subject_centers.to(
            device=camera_positions.device,
            dtype=camera_positions.dtype,
        )[None, :].expand(position_count, 3)
    return subject_centers[indices].to(
        device=camera_positions.device,
        dtype=camera_positions.dtype,
    )


def _build_arc_trajectory(
    camera_positions: torch.Tensor,
    camera_quaternions: torch.Tensor,
    subject_centers: torch.Tensor,
    start_frame: int,
    end_frame: int,
) -> _ArcTrajectory:
    interval_indices = torch.arange(
        start_frame,
        end_frame + 1,
        device=camera_positions.device,
    )
    interval_positions = camera_positions[interval_indices]
    interval_quaternions = camera_quaternions[interval_indices]
    interval_centers = _subject_centers_at_indices(
        subject_centers,
        interval_indices,
        interval_positions.shape[0],
        camera_positions,
    )
    return _ArcTrajectory(
        interval_positions=interval_positions,
        interval_quaternions=interval_quaternions,
        interval_centers=interval_centers,
        interval_subject_offsets=interval_positions - interval_centers,
    )


def _fit_oriented_plane_normal(
    interval_subject_offsets: torch.Tensor,
    camera_positions: torch.Tensor,
    previous_plane_normal: Optional[torch.Tensor] = None,
) -> torch.Tensor:
    """Fits the plane normal via SVD/PCA centered on the detached initial offset.
    Anchoring to frame 0 (detached) prevents shift-invariance/altitude drift
    while letting PCA determine plane orientation.
    """
    if interval_subject_offsets.shape[0] < 3:
        fallback_normal = torch.tensor(
            [0.0, 1.0, 0.0],
            device=camera_positions.device,
            dtype=camera_positions.dtype,
        )
        if previous_plane_normal is not None:
            previous = previous_plane_normal.to(
                device=fallback_normal.device, dtype=fallback_normal.dtype
            )
            if (fallback_normal * previous).sum() < 0:
                fallback_normal = -fallback_normal
        return fallback_normal

    # Center relative to frame 0 (detached) instead of dynamic interval mean
    anchor_offset_0 = interval_subject_offsets[0:1].detach()
    centered_offsets = interval_subject_offsets - anchor_offset_0

    offset_covariance = (
        centered_offsets.transpose(0, 1) @ centered_offsets
    ) / max(1, centered_offsets.shape[0])
    offset_covariance = offset_covariance + 1e-8 * torch.eye(
        3,
        device=camera_positions.device,
        dtype=camera_positions.dtype,
    )
    _eigenvalues, eigenvectors = torch.linalg.eigh(offset_covariance)
    plane_normal = eigenvectors[:, 0]
    plane_normal = plane_normal / (
        torch.sqrt((plane_normal * plane_normal).sum()) + 1e-8
    )

    reference_normal: Optional[torch.Tensor] = None
    if interval_subject_offsets.shape[0] >= 2:
        summed_cross_products = torch.cross(
            interval_subject_offsets[:-1],
            interval_subject_offsets[1:],
            dim=-1,
        ).sum(dim=0)
        summed_cross_norm = torch.sqrt(
            (summed_cross_products * summed_cross_products).sum() + 1e-8
        )
        if summed_cross_norm > 1e-6:
            reference_normal = summed_cross_products / summed_cross_norm

    if previous_plane_normal is not None:
        previous = previous_plane_normal.to(
            device=plane_normal.device, dtype=plane_normal.dtype
        )
        if (plane_normal * previous).sum() < 0:
            plane_normal = -plane_normal
    else:
        if reference_normal is None:
            reference_normal = torch.tensor(
                [0.0, 1.0, 0.0],
                device=camera_positions.device,
                dtype=camera_positions.dtype,
            )
        if (plane_normal * reference_normal).sum() < 0:
            plane_normal = -plane_normal
    
    # Force plane normal to always face 'upward' (+Y direction)
    global_up = torch.tensor([0.0, 1.0, 0.0], device=plane_normal.device, dtype=plane_normal.dtype)
    if (plane_normal * global_up).sum() < 0:
        plane_normal = -plane_normal#
        
    plane_normal = plane_normal.detach()
    return plane_normal


def _add_plane_fit_loss(
    losses: Dict[str, torch.Tensor],
    interval_subject_offsets: torch.Tensor,
    plane_normal: torch.Tensor,
    plane_tolerance: float,
    hold_y: bool = False,
) -> None:
    plane_fit_weight = float(
        LOSS_WEIGHTS.get(
            "arc_plane_fit",
            LOSS_WEIGHTS.get("arc_y_hold", 0.0),
        )
    )
    if plane_fit_weight <= 0:
        return

    # Anchor target elevation/offsets to frame 0 (detached) to break shift invariance
    anchor_offset_0 = interval_subject_offsets[0:1].detach()

    if hold_y:
        # Penalize vertical movement relative to the initial frame's elevation
        anchor_y_0 = anchor_offset_0[0, 1]
        y_deviations = interval_subject_offsets[:, 1] - anchor_y_0
        losses["arc/plane"] = (
            plane_fit_weight * _huber_loss(y_deviations / plane_tolerance, 1.0).mean()
        )
    else:
        # Measure out-of-plane distances relative to frame 0's offset
        centered_offsets = interval_subject_offsets - anchor_offset_0
        plane_distances = (centered_offsets * plane_normal[None, :]).sum(dim=-1)
        plane_residuals = plane_distances / plane_tolerance
        losses["arc/plane"] = (
            plane_fit_weight * _huber_loss(plane_residuals, 1.0).mean()
        )


def _compute_signed_angle_steps(
    interval_subject_offsets: torch.Tensor,
    plane_normal: torch.Tensor,
) -> torch.Tensor:
    projected_offsets = _project_to_plane(interval_subject_offsets, plane_normal)
    normalized_offsets = _normalize_offsets(projected_offsets)

    previous_directions = normalized_offsets[:-1]
    next_directions = normalized_offsets[1:]
    cross_products = torch.cross(previous_directions, next_directions, dim=-1)
    signed_sines = (cross_products * plane_normal[None, :]).sum(dim=-1)
    cosines = torch.clamp(
        (previous_directions * next_directions).sum(dim=-1), -1.0, 1.0
    )
    return torch.atan2(signed_sines, cosines)


def _add_angle_smoothness_loss(
    losses: Dict[str, torch.Tensor],
    angle_steps: torch.Tensor,
    angle_tolerance: float,
) -> None:
    weight = float(LOSS_WEIGHTS.get("arc_angle_smooth", 0.0))
    if weight <= 0 or angle_steps.numel() < 2:
        return
    step_deltas = (angle_steps[1:] - angle_steps[:-1]) / angle_tolerance
    losses["arc/angle_smooth"] = weight * _huber_loss(step_deltas, 1.0).mean()


def _add_angle_pacing_loss(
    losses: Dict[str, torch.Tensor],
    angle_steps: torch.Tensor,
    target_angle: float,
    angle_tolerance: float,
) -> None:
    step_count = angle_steps.numel()
    if step_count == 0:
        return
    weight = float(
        LOSS_WEIGHTS.get(
            "arc_angle_step_target",
            LOSS_WEIGHTS.get("arc_angle_uniform", 0.0),
        )
    )
    if weight <= 0:
        return
    per_step_target = target_angle / step_count
    residuals = (angle_steps - per_step_target) / angle_tolerance
    losses["arc/angle_pacing"] = weight * _huber_loss(residuals, 1.0).mean()


def _add_angle_losses(
    losses: Dict[str, torch.Tensor],
    interval_subject_offsets: torch.Tensor,
    plane_normal: torch.Tensor,
    angle_deg: float,
    angle_tolerance: float,
) -> None:
    angle_steps = _compute_signed_angle_steps(interval_subject_offsets, plane_normal)

    total_angle = angle_steps.sum()
    target_angle = math.radians(float(angle_deg))
    movement_sign = 1.0 if target_angle >= 0 else -1.0

    backward_angle_steps = F.relu(-movement_sign * angle_steps) / angle_tolerance
    losses["arc/angle_dir"] = (
        LOSS_WEIGHTS["arc_angle_dir"] * _huber_loss(backward_angle_steps, 1.0).mean()
    )

    target_angle_residual = (total_angle - target_angle) / angle_tolerance
    losses["arc/angle_target"] = LOSS_WEIGHTS["arc_angle_target"] * _huber_loss(
        target_angle_residual, 1.0
    )

    _add_angle_smoothness_loss(losses, angle_steps, angle_tolerance)
    _add_angle_pacing_loss(losses, angle_steps, target_angle, angle_tolerance)


def _add_radius_regularizer(
    losses: Dict[str, torch.Tensor],
    interval_subject_offsets: torch.Tensor,
    plane_normal: torch.Tensor,
    radius: Optional[float],
    radius_tolerance: float,
) -> None:
    weight = float(LOSS_WEIGHTS.get("arc_radius_reg", 0.0))
    if weight <= 0:
        return
    in_plane_offsets = _project_to_plane(interval_subject_offsets, plane_normal)
    radii = torch.sqrt((in_plane_offsets * in_plane_offsets).sum(dim=-1) + 1e-8)
    if radius is None:
        target_radius = radii[0].detach()
    else:
        target_radius = torch.tensor(
            float(radius), device=radii.device, dtype=radii.dtype
        )
    residuals = (radii - target_radius) / radius_tolerance
    losses["arc/radius_reg"] = weight * _huber_loss(residuals, 1.0).mean()


def _add_look_at_loss(
    losses: Dict[str, torch.Tensor],
    trajectory: _ArcTrajectory,
) -> None:
    forward_vectors, _, _ = camera_axes_from_quaternions(
        trajectory.interval_quaternions
    )
    desired_directions = _normalize_offsets(
        trajectory.interval_centers - trajectory.interval_positions
    )
    look_at_cosines = torch.clamp(
        (forward_vectors * desired_directions).sum(dim=-1),
        -1.0,
        1.0,
    )
    losses["arc/lookat"] = (
        LOSS_WEIGHTS["arc_lookat"] * ((1.0 - look_at_cosines) ** 2).mean()
    )


def arc_movement_losses(
    camera_positions: torch.Tensor,
    camera_quaternions: torch.Tensor,
    subject_centers: torch.Tensor,
    start_frame: int,
    end_frame: int,
    radius: Optional[float],
    angle_deg: Optional[float],
    hold_y: bool = False,
    state: Optional[Dict[str, torch.Tensor]] = None,
) -> Dict[str, torch.Tensor]:
    if angle_deg is None:
        raise ValueError(
            "arc_movement_losses: angle_deg must not be None in this version."
        )

    radius_tolerance = float(LOSS_WEIGHTS.get("arc_tol_radius", 0.1))
    plane_tolerance = float(LOSS_WEIGHTS.get("arc_tol_plane", 0.1))
    angle_tolerance = float(LOSS_WEIGHTS.get("arc_tol_ang", 0.05))

    frame_count = camera_positions.shape[0]
    start_frame, end_frame = clamp_frame_interval(
        start_frame,
        end_frame,
        frame_count,
    )
    if end_frame <= start_frame:
        return {}

    trajectory = _build_arc_trajectory(
        camera_positions,
        camera_quaternions,
        subject_centers,
        start_frame,
        end_frame,
    )
    interval_subject_offsets = trajectory.interval_subject_offsets

    previous_plane_normal = state.get("plane_normal") if state is not None else None
    plane_normal = _fit_oriented_plane_normal(
        interval_subject_offsets,
        camera_positions,
        previous_plane_normal=previous_plane_normal,
    )
    if state is not None:
        state["plane_normal"] = plane_normal.detach()

    losses: Dict[str, torch.Tensor] = {}
    _add_plane_fit_loss(
        losses,
        interval_subject_offsets,
        plane_normal,
        plane_tolerance,
        hold_y=hold_y,
    )
    _add_angle_losses(
        losses,
        interval_subject_offsets,
        plane_normal,
        angle_deg,
        angle_tolerance,
    )
    _add_radius_regularizer(
        losses,
        interval_subject_offsets,
        plane_normal,
        radius,
        radius_tolerance,
    )
    _add_look_at_loss(losses, trajectory)
    return losses