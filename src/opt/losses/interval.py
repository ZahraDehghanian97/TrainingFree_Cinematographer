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
from .robust import huber_loss as _huber_loss


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
    reference_frame: Optional[Dict[str, torch.Tensor]] = None,
    suppress_drift: bool = False,
) -> Dict[str, torch.Tensor]:
    """Translation-movement losses along a dolly/truck/pedestal axis.

    ``reference_frame``, when given, is a dict with ``forward``/``right``/
    ``up`` PER-FRAME unit vectors (each shape (T, 3), T = end_frame -
    start_frame + 1) that replaces the camera's OWN orientation as the
    source of the movement axis and the orth_drift orthogonal axes. The
    dispatcher supplies it for subject-anchored dolly moves and for the
    fixed world-up pedestal frame. Truck omits it and uses camera-local
    axes.

    ``suppress_drift``: set when this same interval also has an
    arcMovement loss active. orth_drift's premise ("don't leave the
    line/plane this move started on") directly contradicts an orbit, whose
    entire job is exactly the off-axis displacement drift would otherwise
    penalize — see the dispatcher call site for the co-occurrence check.

    Falls back to the previous per-frame camera-orientation-derived axes
    when reference_frame is omitted, e.g. for movements with no subject in
    scope.
    """
    device, dtype = camera_positions.device, camera_positions.dtype

    start_frame, end_frame = clamp_frame_interval(
        start_frame,
        end_frame,
        camera_positions.shape[0],
    )
    if end_frame <= start_frame:
        return {}

    initial_position = camera_positions[start_frame]

    if reference_frame is not None:
        # Per-frame, subject-tracked frame: same axis triple used for both
        # the movement axis and orth_drift's orthogonal pair. This is what
        # actually decouples "which way the camera translates" from "which
        # way framing points the camera" — the two were previously sharing
        # camera orientation as their only reference, which is what let
        # framing silently pull the "dolly axis" itself off-line. Already
        # shaped (T, 3) for this exact interval — no broadcasting needed.
        interval_forward_axes = reference_frame["forward"]
        interval_right_axes = reference_frame["right"]
        interval_up_axes = reference_frame["up"]
    else:
        # Per-frame local axes across the WHOLE interval, not a single
        # frozen snapshot from start_frame. This is the intended frame for
        # subjectless truck moves.
        interval_forward_axes, interval_right_axes, interval_up_axes = (
            camera_axes_from_quaternions(
                camera_quaternions[start_frame : end_frame + 1]
            )
        )

    axis_lookup = {
        "truck": interval_right_axes,
        "dolly": interval_forward_axes,
        "pedestal": interval_up_axes,
    }
    weight_lookup = {
        "truck": LOSS_WEIGHTS["truck_target"],
        "dolly": LOSS_WEIGHTS["dolly_target"],
        "pedestal": LOSS_WEIGHTS["pedestal_target"],
    }

    interval_movement_axes = axis_lookup[axis_name]  # (T, 3), T = end-start+1
    target_weight = weight_lookup[axis_name]

    position_steps = (
        camera_positions[start_frame + 1 : end_frame + 1]
        - camera_positions[start_frame:end_frame]
    )  # (T-1, 3)

    # Each step is measured against the movement axis at the frame the step
    # originates FROM — consecutive, frame-by-frame — mirroring how arc.py's
    # angle steps are computed between consecutive samples rather than
    # against one fixed global reference.
    step_axes = interval_movement_axes[:-1]
    step_progress = movement_sign * (position_steps * step_axes).sum(dim=-1)  # (T-1,)

    # total_progress is now literally the sum of the per-step progress
    # above, not a separate displacement-vs-single-fixed-axis computation —
    # so the per-step ("direction") and cumulative ("target"/"progress")
    # losses can never quietly disagree with each other even while the
    # movement axis itself changes across the interval.
    total_progress = step_progress.sum()

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

    # Per-frame displacement scale used to non-dimensionalize the raw-meter
    # residuals below before squaring — without this, stepPacing/orth_drift
    # (a few mm-to-cm per frame) are numerically swamped by frame-level
    # losses like framing/lookat and framing/ray, no matter how high their
    # LOSS_WEIGHTS entry is set, because weight alone can't fix a units
    # mismatch. Mirrors arc.py's arc_tol_ang/arc_tol_plane/arc_tol_radius
    # pattern. Reuses move_progress_tau by default since it's already a
    # small-per-frame-displacement scale in this module; override with
    # move_pacing_tol / orth_drift_tol / move_smooth_tol if pacing, drift,
    # and smoothness need independently tuned tolerances.
    base_tolerance = float(LOSS_WEIGHTS["move_progress_tau"])

    # Smoothness — consecutive step_progress values shouldn't jump around,
    # mirroring arc.py's arc_angle_smooth. Off by default (weight 0) unless
    # "move_step_smooth" is set in LOSS_WEIGHTS.
    smoothness_weight = float(LOSS_WEIGHTS.get("move_step_smooth", 0.0))
    if smoothness_weight > 0 and step_progress.numel() >= 2:
        smooth_tolerance = float(LOSS_WEIGHTS.get("move_smooth_tol", base_tolerance))
        step_deltas = (step_progress[1:] - step_progress[:-1]) / smooth_tolerance
        losses[f"{prefix}/stepSmooth"] = (
            smoothness_weight * _huber_loss(step_deltas, 1.0).mean()
        )

    # Pacing — each step's progress should equal a constant
    # target_distance / num_steps, i.e. constant velocity along the
    # movement axis.
    pacing_weight = float(LOSS_WEIGHTS.get("move_step_pacing", 0.0))
    if pacing_weight > 0 and target_distance is not None and step_progress.numel() > 0:
        step_count = step_progress.numel()
        pacing_tolerance = float(LOSS_WEIGHTS.get("move_pacing_tol", base_tolerance))

        per_step_targets = float(target_distance) / step_count

        pacing_residuals = (step_progress - per_step_targets) / pacing_tolerance
        losses[f"{prefix}/stepPacing"] = (
            pacing_weight * _huber_loss(pacing_residuals, 1.0).mean()
        )

    if LOSS_WEIGHTS["orth_drift"] > 0 and not suppress_drift:
        displacement = camera_positions[start_frame : end_frame + 1] - initial_position
        drift_tolerance = float(LOSS_WEIGHTS.get("orth_drift_tol", base_tolerance))

        # Orthogonal pair drawn from the reference frame's FIRST frame only
        # — deliberately, even though the reference frame itself now
        # tracks the subject per-frame above. orth_drift's job ("don't
        # drift sideways off the line the move started on") is only a
        # coherent concept relative to a FIXED reference; using the
        # per-frame-tracked axes for drift too would silently redefine it
        # into "no sideways component relative to wherever forward points
        # right now," which — for a subject-tracking reference — is a much
        # weaker constraint that stops meaning "stay on line" at all. This
        # is exactly why arcMovement co-occurrence suppresses this term
        # instead of trying to make it track too: there is no fixed
        # reference that's simultaneously "the line this dolly started on"
        # and "compatible with an orbit," so the two are mutually
        # exclusive rather than reconcilable by picking a different frame.
        start_forward_axis = interval_forward_axes[0]
        start_right_axis = interval_right_axes[0]
        start_up_axis = interval_up_axes[0]

        orthogonal_axes = {
            "truck": [start_forward_axis, start_up_axis],
            "dolly": [start_right_axis, start_up_axis],
            "pedestal": [start_forward_axis, start_right_axis],
        }

        drift_loss = torch.zeros((), device=device, dtype=dtype)

        for orthogonal_axis in orthogonal_axes[axis_name]:
            projected = scalar_projection(
                displacement,
                orthogonal_axis.unsqueeze(0),
            ).squeeze(-1)
            drift_loss += _huber_loss(projected / drift_tolerance, 1.0).mean()

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

    # New: smoothness on consecutive yaw/pitch steps, mirroring arc.py's
    # arc_angle_smooth. Off by default (weight 0) — set "rot_step_smooth"
    # in LOSS_WEIGHTS to enable. Unlike the translation fix above, this
    # function already used per-frame angles (yaw/pitch are derived from
    # each frame's own forward vector, not a frozen snapshot) — it wasn't
    # missing per-step evaluation, just the smoothness term itself.
    rotation_smoothness_weight = float(LOSS_WEIGHTS.get("rot_step_smooth", 0.0))
    if rotation_smoothness_weight > 0 and angle_steps.numel() >= 2:
        angle_step_deltas = angle_steps[1:] - angle_steps[:-1]
        losses[f"{movement_type}/stepSmooth"] = (
            rotation_smoothness_weight * (angle_step_deltas**2).mean()
        )

    return losses
