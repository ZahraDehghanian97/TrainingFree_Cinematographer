"""Arc-movement losses assembled from focused geometric helpers."""

from __future__ import annotations

from dataclasses import dataclass
import math
from typing import Dict, Optional

import torch
import torch.nn.functional as F

try:
    from ..math3d.camera import camera_axes_from_quaternions
except ImportError:  # pragma: no cover - top-level ``losses`` import mode
    from math3d.camera import camera_axes_from_quaternions

from .config import LOSS_WEIGHTS
from .interval import clamp_frame_interval


@dataclass(frozen=True)
class _ArcTrajectory:
    sampled_positions: torch.Tensor
    sampled_quaternions: torch.Tensor
    sampled_centers: torch.Tensor
    interval_positions: torch.Tensor
    interval_centers: torch.Tensor
    interval_subject_offsets: torch.Tensor


def _huber_loss(
    residuals: torch.Tensor,
    delta: float = 1.0,
) -> torch.Tensor:
    absolute_residuals = residuals.abs()
    quadratic_residuals = torch.minimum(
        absolute_residuals,
        torch.tensor(
            delta,
            device=residuals.device,
            dtype=residuals.dtype,
        ),
    )
    linear_residuals = absolute_residuals - quadratic_residuals
    return 0.5 * quadratic_residuals * quadratic_residuals + delta * linear_residuals


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


def _sample_indices(
    start_frame: int,
    end_frame: int,
    frame_count: int,
    maximum_sample_count: int,
    device: torch.device,
) -> torch.Tensor:
    interval_frame_count = end_frame - start_frame + 1
    if interval_frame_count <= maximum_sample_count:
        sampled_indices = torch.arange(
            start_frame,
            end_frame + 1,
            device=device,
        )
    else:
        sampled_index_values = torch.linspace(
            start_frame,
            end_frame,
            steps=maximum_sample_count,
            device=device,
        )
        sampled_indices = torch.unique(sampled_index_values.round().long())
        if sampled_indices[0].item() != start_frame:
            sampled_indices = torch.cat(
                [
                    torch.tensor(
                        [start_frame],
                        device=device,
                    ),
                    sampled_indices,
                ]
            )
        if sampled_indices[-1].item() != end_frame:
            sampled_indices = torch.cat(
                [
                    sampled_indices,
                    torch.tensor(
                        [end_frame],
                        device=device,
                    ),
                ]
            )
    return sampled_indices.clamp(0, frame_count - 1)


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
    maximum_sample_count: int,
) -> _ArcTrajectory:
    frame_count = camera_positions.shape[0]
    sampled_indices = _sample_indices(
        start_frame,
        end_frame,
        frame_count,
        maximum_sample_count,
        camera_positions.device,
    )
    sampled_positions = camera_positions[sampled_indices]
    sampled_centers = _subject_centers_at_indices(
        subject_centers,
        sampled_indices,
        sampled_positions.shape[0],
        camera_positions,
    )

    interval_indices = torch.arange(
        start_frame,
        end_frame + 1,
        device=camera_positions.device,
    )
    interval_positions = camera_positions[interval_indices]
    interval_centers = _subject_centers_at_indices(
        subject_centers,
        interval_indices,
        interval_positions.shape[0],
        camera_positions,
    )
    return _ArcTrajectory(
        sampled_positions=sampled_positions,
        sampled_quaternions=camera_quaternions[sampled_indices],
        sampled_centers=sampled_centers,
        interval_positions=interval_positions,
        interval_centers=interval_centers,
        interval_subject_offsets=interval_positions - interval_centers,
    )


def _fit_oriented_plane_normal(
    interval_subject_offsets: torch.Tensor,
    camera_positions: torch.Tensor,
) -> torch.Tensor:
    if interval_subject_offsets.shape[0] < 3:
        return torch.tensor(
            [0.0, 1.0, 0.0],
            device=camera_positions.device,
            dtype=camera_positions.dtype,
        )

    offset_covariance = (
        interval_subject_offsets.transpose(0, 1) @ interval_subject_offsets
    ) / max(1, interval_subject_offsets.shape[0])
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
        else:
            reference_normal = torch.tensor(
                [0.0, 1.0, 0.0],
                device=camera_positions.device,
                dtype=camera_positions.dtype,
            )
    else:
        reference_normal = torch.tensor(
            [0.0, 1.0, 0.0],
            device=camera_positions.device,
            dtype=camera_positions.dtype,
        )

    if (plane_normal * reference_normal).sum() < 0:
        plane_normal = -plane_normal
    if float(LOSS_WEIGHTS.get("arc_plane_detach_normal", 1.0)) > 0:
        plane_normal = plane_normal.detach()
    return plane_normal


def _add_plane_losses(
    losses: Dict[str, torch.Tensor],
    interval_subject_offsets: torch.Tensor,
    plane_normal: torch.Tensor,
    plane_tolerance: float,
    hold_y: bool,
) -> None:
    if not hold_y:
        return

    plane_fit_weight = float(
        LOSS_WEIGHTS.get(
            "arc_plane_fit",
            LOSS_WEIGHTS.get("arc_y_hold", 0.0),
        )
    )
    if plane_fit_weight > 0:
        plane_distances = (interval_subject_offsets * plane_normal[None, :]).sum(
            dim=-1
        )
        plane_residuals = plane_distances / plane_tolerance
        losses["arc/plane"] = (
            plane_fit_weight * _huber_loss(plane_residuals, 1.0).mean()
        )

    plane_step_weight = float(
        LOSS_WEIGHTS.get(
            "arc_plane_step",
            LOSS_WEIGHTS.get("arc_y_step", 0.0),
        )
    )
    if plane_step_weight > 0 and interval_subject_offsets.shape[0] >= 2:
        plane_distances = (interval_subject_offsets * plane_normal[None, :]).sum(
            dim=-1
        )
        plane_distance_steps = (
            plane_distances[1:] - plane_distances[:-1]
        ) / plane_tolerance
        losses["arc/plane_step"] = (
            plane_step_weight * _huber_loss(plane_distance_steps, 1.0).mean()
        )


def _add_radius_losses(
    losses: Dict[str, torch.Tensor],
    trajectory: _ArcTrajectory,
    plane_normal: torch.Tensor,
    radius: Optional[float],
    radius_tolerance: float,
) -> None:
    sampled_subject_offsets = (
        trajectory.sampled_positions - trajectory.sampled_centers
    )
    sampled_in_plane_offsets = _project_to_plane(
        sampled_subject_offsets,
        plane_normal,
    )
    sampled_radii = torch.sqrt(
        (sampled_in_plane_offsets * sampled_in_plane_offsets).sum(dim=-1) + 1e-8
    )

    if radius is None:
        initial_radius = sampled_radii[0].detach()
        radius_residuals = (sampled_radii - initial_radius) / radius_tolerance
        radius_loss = _huber_loss(radius_residuals, 1.0).mean()
        losses["arc/radius_const"] = LOSS_WEIGHTS["arc_radius_const"] * radius_loss

        radius_magnitude_weight = float(LOSS_WEIGHTS.get("arc_radius_mag", 0.0))
        if radius_magnitude_weight > 0:
            losses["arc/radius_mag"] = radius_magnitude_weight * (
                sampled_radii.mean() ** 2
            )
        auxiliary_reference_radius = initial_radius
    else:
        target_radius = torch.tensor(
            float(radius),
            device=trajectory.sampled_positions.device,
            dtype=trajectory.sampled_positions.dtype,
        )
        radius_residuals = (sampled_radii - target_radius) / radius_tolerance
        radius_loss = _huber_loss(radius_residuals, 1.0).mean()
        losses["arc/radius_target"] = LOSS_WEIGHTS["arc_radius_target"] * radius_loss
        auxiliary_reference_radius = target_radius

    inner_barrier_weight = float(LOSS_WEIGHTS.get("arc_inner_barrier", 0.0))
    if inner_barrier_weight > 0:
        interval_in_plane_offsets = _project_to_plane(
            trajectory.interval_subject_offsets,
            plane_normal,
        )
        interval_radii = torch.sqrt(
            (interval_in_plane_offsets * interval_in_plane_offsets).sum(dim=-1) + 1e-8
        )
        inner_radius_fraction = float(LOSS_WEIGHTS.get("arc_inner_frac", 0.85))
        radius_floor = inner_radius_fraction * auxiliary_reference_radius
        inner_radius_violation = (
            F.relu(radius_floor - interval_radii) / radius_tolerance
        )
        losses["arc/radius_inner_barrier"] = (
            inner_barrier_weight * _huber_loss(inner_radius_violation, 1.0).mean()
        )


def _add_uniform_angle_loss(
    losses: Dict[str, torch.Tensor],
    cumulative_angles: torch.Tensor,
    desired_cumulative_angles: torch.Tensor,
    angle_tolerance: float,
) -> None:
    uniform_angle_weight = float(LOSS_WEIGHTS.get("arc_angle_uniform", 0.0))
    if uniform_angle_weight > 0:
        angle_schedule_residuals = (
            cumulative_angles - desired_cumulative_angles
        ) / angle_tolerance
        losses["arc/angle_uniform"] = (
            uniform_angle_weight
            * _huber_loss(
                angle_schedule_residuals,
                1.0,
            ).mean()
        )


def _add_specified_progress_loss(
    losses: Dict[str, torch.Tensor],
    cumulative_angles: torch.Tensor,
    desired_cumulative_angles: torch.Tensor,
    movement_sign: float,
    angle_tolerance: float,
    camera_positions: torch.Tensor,
) -> None:
    specified_progress_weight = float(
        LOSS_WEIGHTS.get(
            "arc_angle_progress_spec",
            0.0,
        )
    )
    if specified_progress_weight > 0:
        progress_margin_degrees = float(
            LOSS_WEIGHTS.get(
                "arc_angle_progress_margin_deg",
                5.0,
            )
        )
        progress_margin = torch.tensor(
            math.radians(progress_margin_degrees),
            device=camera_positions.device,
            dtype=camera_positions.dtype,
        )

        signed_cumulative_angles = movement_sign * cumulative_angles
        signed_desired_angles = movement_sign * desired_cumulative_angles
        lag_residuals = (
            F.relu(
                (signed_desired_angles - progress_margin) - signed_cumulative_angles
            )
            / angle_tolerance
        )
        lead_residuals = (
            F.relu(
                signed_cumulative_angles - (signed_desired_angles + progress_margin)
            )
            / angle_tolerance
        )

        losses["arc/angle_progress_spec"] = specified_progress_weight * (
            _huber_loss(lag_residuals, 1.0).mean()
            + _huber_loss(lead_residuals, 1.0).mean()
        )


def _add_angle_step_cap_loss(
    losses: Dict[str, torch.Tensor],
    angle_steps: torch.Tensor,
    target_angle: float,
    angle_tolerance: float,
) -> None:
    angle_step_cap_weight = float(LOSS_WEIGHTS.get("arc_angle_step_cap", 0.0))
    if angle_step_cap_weight > 0:
        angle_step_count = angle_steps.numel()
        average_angle_step = abs(target_angle) / max(1, angle_step_count)
        angle_step_cap_multiplier = float(
            LOSS_WEIGHTS.get(
                "arc_angle_step_cap_mult",
                2.5,
            )
        )
        minimum_step_cap_degrees = float(
            LOSS_WEIGHTS.get(
                "arc_angle_step_cap_min_deg",
                6.0,
            )
        )
        minimum_step_cap = math.radians(minimum_step_cap_degrees)
        angle_step_cap = max(
            angle_step_cap_multiplier * average_angle_step,
            minimum_step_cap,
        )

        excess_angle_steps = (
            F.relu(angle_steps.abs() - angle_step_cap) / angle_tolerance
        )
        losses["arc/angle_step_cap"] = (
            angle_step_cap_weight * _huber_loss(excess_angle_steps, 1.0).mean()
        )


def _add_angle_schedule_losses(
    losses: Dict[str, torch.Tensor],
    angle_steps: torch.Tensor,
    target_angle: float,
    movement_sign: float,
    angle_tolerance: float,
    camera_positions: torch.Tensor,
) -> None:
    angle_step_count = angle_steps.numel()
    if angle_step_count < 2:
        return

    cumulative_angles = torch.cumsum(angle_steps, dim=0)
    progress_fractions = torch.arange(
        1,
        angle_step_count + 1,
        device=camera_positions.device,
        dtype=camera_positions.dtype,
    ) / float(angle_step_count)
    desired_cumulative_angles = (
        torch.tensor(
            target_angle,
            device=camera_positions.device,
            dtype=camera_positions.dtype,
        )
        * progress_fractions
    )
    _add_uniform_angle_loss(
        losses,
        cumulative_angles,
        desired_cumulative_angles,
        angle_tolerance,
    )
    _add_specified_progress_loss(
        losses,
        cumulative_angles,
        desired_cumulative_angles,
        movement_sign,
        angle_tolerance,
        camera_positions,
    )
    _add_angle_step_cap_loss(
        losses,
        angle_steps,
        target_angle,
        angle_tolerance,
    )


def _add_angle_losses(
    losses: Dict[str, torch.Tensor],
    interval_subject_offsets: torch.Tensor,
    plane_normal: torch.Tensor,
    angle_deg: float,
    angle_tolerance: float,
    camera_positions: torch.Tensor,
) -> None:
    projected_interval_offsets = _project_to_plane(
        interval_subject_offsets,
        plane_normal,
    )
    normalized_interval_offsets = _normalize_offsets(projected_interval_offsets)

    if normalized_interval_offsets.shape[0] < 2:
        return

    previous_offset_directions = normalized_interval_offsets[:-1]
    next_offset_directions = normalized_interval_offsets[1:]

    direction_cross_products = torch.cross(
        previous_offset_directions,
        next_offset_directions,
        dim=-1,
    )
    signed_angle_sines = (direction_cross_products * plane_normal[None, :]).sum(
        dim=-1
    )
    angle_cosines = torch.clamp(
        (previous_offset_directions * next_offset_directions).sum(dim=-1),
        -1.0,
        1.0,
    )
    angle_steps = torch.atan2(
        signed_angle_sines,
        angle_cosines,
    )
    total_angle = angle_steps.sum()

    target_angle = math.radians(float(angle_deg))
    movement_sign = 1.0 if target_angle >= 0 else -1.0
    backward_angle_steps = F.relu(-movement_sign * angle_steps) / angle_tolerance
    losses["arc/angle_dir"] = (
        LOSS_WEIGHTS["arc_angle_dir"]
        * _huber_loss(backward_angle_steps, 1.0).mean()
    )
    target_angle_residual = (total_angle - target_angle) / angle_tolerance
    losses["arc/angle_target"] = LOSS_WEIGHTS["arc_angle_target"] * _huber_loss(
        target_angle_residual, 1.0
    )

    _add_angle_schedule_losses(
        losses,
        angle_steps,
        target_angle,
        movement_sign,
        angle_tolerance,
        camera_positions,
    )


def _add_acceleration_loss(
    losses: Dict[str, torch.Tensor],
    sampled_positions: torch.Tensor,
    acceleration_tolerance: float,
) -> None:
    acceleration_weight = float(LOSS_WEIGHTS.get("arc_acc", 0.0))
    if acceleration_weight > 0 and sampled_positions.shape[0] >= 3:
        accelerations = (
            sampled_positions[2:]
            - 2.0 * sampled_positions[1:-1]
            + sampled_positions[:-2]
        )
        acceleration_magnitudes = torch.sqrt(
            (accelerations * accelerations).sum(dim=-1) + 1e-8
        )
        acceleration_residuals = acceleration_magnitudes / acceleration_tolerance
        losses["arc/acc"] = (
            acceleration_weight * _huber_loss(acceleration_residuals, 1.0).mean()
        )


def _add_look_at_loss(
    losses: Dict[str, torch.Tensor],
    trajectory: _ArcTrajectory,
) -> None:
    forward_vectors, _, _ = camera_axes_from_quaternions(
        trajectory.sampled_quaternions
    )
    desired_directions = _normalize_offsets(
        trajectory.sampled_centers - trajectory.sampled_positions
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
    hold_y: bool = True,
) -> Dict[str, torch.Tensor]:
    if angle_deg is None:
        raise ValueError(
            "arc_movement_losses: angle_deg must not be None in this version."
        )

    radius_tolerance = float(LOSS_WEIGHTS.get("arc_tol_radius", 1.0))
    plane_tolerance = float(LOSS_WEIGHTS.get("arc_tol_plane", 1.0))
    angle_tolerance = float(LOSS_WEIGHTS.get("arc_tol_ang", 1.0))
    acceleration_tolerance = float(LOSS_WEIGHTS.get("arc_tol_acc", 1.0))

    maximum_sample_count = int(LOSS_WEIGHTS.get("arc_samples", 128))
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
        maximum_sample_count,
    )
    interval_subject_offsets = trajectory.interval_subject_offsets
    plane_normal = _fit_oriented_plane_normal(
        interval_subject_offsets,
        camera_positions,
    )

    losses: Dict[str, torch.Tensor] = {}
    _add_plane_losses(
        losses,
        interval_subject_offsets,
        plane_normal,
        plane_tolerance,
        hold_y,
    )
    _add_radius_losses(
        losses,
        trajectory,
        plane_normal,
        radius,
        radius_tolerance,
    )
    _add_angle_losses(
        losses,
        interval_subject_offsets,
        plane_normal,
        angle_deg,
        angle_tolerance,
        camera_positions,
    )
    _add_acceleration_loss(
        losses,
        trajectory.sampled_positions,
        acceleration_tolerance,
    )
    _add_look_at_loss(losses, trajectory)
    return losses
