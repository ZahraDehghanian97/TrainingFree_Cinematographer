"""Movement and hold losses for camera-only trajectory intervals."""

from __future__ import annotations

import math
from typing import Dict, Optional, Tuple

import torch
import torch.nn.functional as F

try:
    from ..math3d.camera import (
        camera_axes_from_quaternions,
        pitch_from_forward_vectors,
        yaw_from_forward_vectors,
    )
    from ..math3d.torch_quaternions import (
        normalize_quaternion,
        scalar_projection,
        unwrap_angles,
    )
except ImportError:  # pragma: no cover - top-level ``losses`` import mode
    from math3d.camera import (
        camera_axes_from_quaternions,
        pitch_from_forward_vectors,
        yaw_from_forward_vectors,
    )
    from math3d.torch_quaternions import (
        normalize_quaternion,
        scalar_projection,
        unwrap_angles,
    )

from .config import LOSS_WEIGHTS


def clamp_frame_interval(
    start_frame: int,
    end_frame: int,
    frame_count: int,
) -> Tuple[int, int]:
    start_frame = max(0, int(start_frame))
    end_frame = min(frame_count - 1, int(end_frame))
    return start_frame, end_frame


def mean_path_step_distance(
    camera_positions: torch.Tensor,
    start_frame: int,
    end_frame: int,
) -> torch.Tensor:
    frame_count = camera_positions.shape[0]
    start_frame, end_frame = clamp_frame_interval(
        start_frame,
        end_frame,
        frame_count,
    )
    if end_frame <= start_frame:
        return torch.zeros(
            (),
            device=camera_positions.device,
            dtype=camera_positions.dtype,
        )
    position_steps = (
        camera_positions[start_frame + 1 : end_frame + 1]
        - camera_positions[start_frame:end_frame]
    )
    return torch.sqrt((position_steps * position_steps).sum(dim=-1) + 1e-8).mean()


def rotation_hold_loss(
    camera_quaternions: torch.Tensor,
    start_frame: int,
    end_frame: int,
) -> torch.Tensor:
    initial_quaternion = camera_quaternions[start_frame : start_frame + 1]
    interval_quaternions = camera_quaternions[start_frame : end_frame + 1]
    alignments = (interval_quaternions * initial_quaternion).sum(dim=-1).abs()
    return (1.0 - alignments**2).mean()


def position_hold_loss(
    camera_positions: torch.Tensor,
    start_frame: int,
    end_frame: int,
) -> torch.Tensor:
    initial_position = camera_positions[start_frame]
    position_offsets = camera_positions[start_frame : end_frame + 1] - initial_position
    return position_offsets.pow(2).sum(dim=-1).mean()


def local_axis_translation_losses(
    camera_positions: torch.Tensor,
    camera_quaternions: torch.Tensor,
    start_frame: int,
    end_frame: int,
    axis_name: str,
    movement_sign: float,
    target_distance: Optional[float] = None,
) -> Dict[str, torch.Tensor]:
    device, dtype = camera_positions.device, camera_positions.dtype

    start_frame, end_frame = clamp_frame_interval(
        start_frame,
        end_frame,
        camera_positions.shape[0],
    )
    if end_frame <= start_frame:
        return {}

    initial_position = camera_positions[start_frame]

    forward_axis, right_axis, up_axis = (
        axis_vectors[0]
        for axis_vectors in camera_axes_from_quaternions(
            camera_quaternions[start_frame : start_frame + 1]
        )
    )

    axis_lookup = {
        "truck": right_axis,
        "dolly": forward_axis,
        "pedestal": up_axis,
    }

    weight_lookup = {
        "truck": LOSS_WEIGHTS["truck_target"],
        "dolly": LOSS_WEIGHTS["dolly_target"],
        "pedestal": LOSS_WEIGHTS["pedestal_target"],
    }

    movement_axis = axis_lookup[axis_name]
    target_weight = weight_lookup[axis_name]

    position_steps = (
        camera_positions[start_frame + 1 : end_frame + 1]
        - camera_positions[start_frame:end_frame]
    )

    step_progress = movement_sign * (position_steps * movement_axis).sum(dim=-1)

    total_progress = (
        movement_sign
        * ((camera_positions[end_frame] - initial_position) * movement_axis).sum()
    )

    losses: Dict[str, torch.Tensor] = {}
    prefix = f"{axis_name}Movement"

    if target_distance is None:
        losses[f"{prefix}/direction"] = (
            LOSS_WEIGHTS["move_dir"] * (F.relu(-step_progress) ** 2).mean()
        )

        losses[f"{prefix}/progress"] = LOSS_WEIGHTS["move_progress"] * (
            F.relu(float(LOSS_WEIGHTS["move_progress_tau"]) - total_progress) ** 2
        )

    else:
        losses[f"{prefix}/target"] = (
            target_weight * (total_progress - float(target_distance)) ** 2
        )

        losses[f"{prefix}/direction"] = (
            LOSS_WEIGHTS["move_dir"] * (F.relu(-step_progress) ** 2).mean()
        )

    if LOSS_WEIGHTS["orth_drift"] > 0:
        displacement = camera_positions[start_frame : end_frame + 1] - initial_position

        orthogonal_axes = {
            "truck": [forward_axis, up_axis],
            "dolly": [right_axis, up_axis],
            "pedestal": [forward_axis, right_axis],
        }

        drift_loss = torch.zeros((), device=device, dtype=dtype)

        for orthogonal_axis in orthogonal_axes[axis_name]:
            drift_loss += (
                scalar_projection(
                    displacement,
                    orthogonal_axis.unsqueeze(0),
                )
                .squeeze(-1)
                .pow(2)
                .mean()
            )

        losses[f"{prefix}/drift"] = LOSS_WEIGHTS["orth_drift"] * drift_loss
    return losses


def static_interval_losses(
    camera_positions: torch.Tensor,
    camera_quaternions: torch.Tensor,
    start_frame: int,
    end_frame: int,
) -> Dict[str, torch.Tensor]:
    frame_count = camera_positions.shape[0]
    start_frame, end_frame = clamp_frame_interval(
        start_frame,
        end_frame,
        frame_count,
    )
    if end_frame <= start_frame:
        return {}

    losses: Dict[str, torch.Tensor] = {}
    interval_positions = camera_positions[start_frame : end_frame + 1]
    initial_position = interval_positions[:1]
    position_anchor_loss = (
        (interval_positions - initial_position).pow(2).sum(dim=-1)
    ).mean()
    position_steps = interval_positions[1:] - interval_positions[:-1]
    if position_steps.numel() > 0:
        position_step_loss = (position_steps.pow(2).sum(dim=-1)).mean()
    else:
        position_step_loss = torch.zeros(
            (),
            device=camera_positions.device,
            dtype=camera_positions.dtype,
        )

    losses["static/trans_anchor"] = (
        LOSS_WEIGHTS.get("static_trans_anchor", 0.0) * position_anchor_loss
    )
    losses["static/trans_step"] = (
        LOSS_WEIGHTS.get("static_trans_step", 0.0) * position_step_loss
    )

    interval_quaternions = normalize_quaternion(
        camera_quaternions[start_frame : end_frame + 1]
    )
    initial_quaternion = interval_quaternions[:1]

    anchor_alignments = (
        (interval_quaternions * initial_quaternion).sum(dim=-1).abs().clamp(0.0, 1.0)
    )
    rotation_anchor_loss = (1.0 - anchor_alignments**2).mean()

    if interval_quaternions.shape[0] >= 2:
        step_alignments = (
            (interval_quaternions[1:] * interval_quaternions[:-1])
            .sum(dim=-1)
            .abs()
            .clamp(0.0, 1.0)
        )
        rotation_step_loss = (1.0 - step_alignments**2).mean()
    else:
        rotation_step_loss = torch.zeros(
            (),
            device=camera_quaternions.device,
            dtype=camera_quaternions.dtype,
        )

    losses["static/rot_anchor"] = (
        LOSS_WEIGHTS.get("static_rot_anchor", 0.0) * rotation_anchor_loss
    )
    losses["static/rot_step"] = (
        LOSS_WEIGHTS.get("static_rot_step", 0.0) * rotation_step_loss
    )

    return losses


def pan_tilt_movement_losses(
    camera_quaternions: torch.Tensor,
    start_frame: int,
    end_frame: int,
    movement_type: str,
    angle_deg: Optional[float] = None,
) -> Dict[str, torch.Tensor]:
    frame_count = camera_quaternions.shape[0]
    start_frame, end_frame = clamp_frame_interval(
        start_frame,
        end_frame,
        frame_count,
    )

    if end_frame <= start_frame:
        return {}

    forward_vectors, _, _ = camera_axes_from_quaternions(
        camera_quaternions[start_frame : end_frame + 1]
    )

    yaw_angles = unwrap_angles(yaw_from_forward_vectors(forward_vectors))
    pitch_angles = unwrap_angles(pitch_from_forward_vectors(forward_vectors))

    movement_configs = {
        "panLeftMovement": {
            "angles": yaw_angles,
            "sign": 1.0,
            "weight": LOSS_WEIGHTS["pan_target"],
        },
        "panRightMovement": {
            "angles": yaw_angles,
            "sign": -1.0,
            "weight": LOSS_WEIGHTS["pan_target"],
        },
        "tiltUpMovement": {
            "angles": pitch_angles,
            "sign": 1.0,
            "weight": LOSS_WEIGHTS["tilt_target"],
        },
        "tiltDownMovement": {
            "angles": pitch_angles,
            "sign": -1.0,
            "weight": LOSS_WEIGHTS["tilt_target"],
        },
    }

    if movement_type not in movement_configs:
        raise ValueError(f"Unknown movement type: {movement_type}")

    movement_config = movement_configs[movement_type]

    movement_angles = movement_config["angles"]
    movement_sign = movement_config["sign"]
    target_weight = movement_config["weight"]

    angle_steps = movement_angles[1:] - movement_angles[:-1]
    total_angle = movement_sign * (movement_angles[-1] - movement_angles[0])

    losses: Dict[str, torch.Tensor] = {}

    if angle_deg is None:
        losses[f"{movement_type}/dir"] = (
            LOSS_WEIGHTS["rot_dir"] * (F.relu(-movement_sign * angle_steps) ** 2).mean()
        )

        minimum_progress = math.radians(float(LOSS_WEIGHTS["rot_progress_tau_deg"]))

        losses[f"{movement_type}/progress"] = LOSS_WEIGHTS["rot_progress"] * (
            F.relu(minimum_progress - total_angle) ** 2
        )

    else:
        target_angle = math.radians(float(angle_deg))

        losses[f"{movement_type}/target_end"] = target_weight * (
            (total_angle - target_angle) ** 2
        )

        losses[f"{movement_type}/monotonic"] = (
            LOSS_WEIGHTS["rot_dir"] * (F.relu(-movement_sign * angle_steps) ** 2).mean()
        )

    return losses
