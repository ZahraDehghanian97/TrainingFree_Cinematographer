"""Subject-aware framing, visibility, follow, track, and pose losses."""

from __future__ import annotations

import math
from typing import Dict, List, Optional

import torch
import torch.nn.functional as F

try:
    from ..math3d.camera import (
        camera_axes_from_quaternions,
        project_world_points_to_pixels,
        yaw_from_forward_vectors,
    )
    from ..math3d.torch_quaternions import (
        look_at_alignment_loss,
        normalize_quaternion,
        normalize_vectors,
        stabilized_vector_norm,
        stable_atan2,
        unwrap_angles,
    )
except ImportError:  # pragma: no cover - top-level ``losses`` import mode
    from math3d.camera import (
        camera_axes_from_quaternions,
        project_world_points_to_pixels,
        yaw_from_forward_vectors,
    )
    from math3d.torch_quaternions import (
        look_at_alignment_loss,
        normalize_quaternion,
        normalize_vectors,
        stabilized_vector_norm,
        stable_atan2,
        unwrap_angles,
    )

from .config import (
    LOSS_WEIGHTS,
    SHOT_DISTANCE_BY_SIZE,
    VIEW_AZIMUTH_DEGREES,
)
from .interval import (
    clamp_frame_interval,
    position_hold_loss,
)


def subject_bbox_visibility_losses(
    camera_positions: torch.Tensor,
    camera_quaternions: torch.Tensor,
    world_bbox_corners: torch.Tensor,
    image_width: int,
    image_height: int,
    focal_length_x: float,
    focal_length_y: float,
    principal_point_x: float,
    principal_point_y: float,
    margin_pixels: float = 20.0,
    near_depth: float = 1e-3,
) -> Dict[str, torch.Tensor]:
    device, dtype = camera_positions.device, camera_positions.dtype
    if (
        camera_positions.numel() == 0
        or camera_quaternions.numel() == 0
        or world_bbox_corners.numel() == 0
    ):
        zero = torch.zeros((), device=device, dtype=dtype)
        return {
            "inFrame/left": zero,
            "inFrame/right": zero,
            "inFrame/top": zero,
            "inFrame/bottom": zero,
            "inFrame/depth": zero,
        }

    pixel_x, pixel_y, camera_depth = project_world_points_to_pixels(
        camera_positions,
        camera_quaternions,
        world_bbox_corners,
        focal_length_x,
        focal_length_y,
        principal_point_x,
        principal_point_y,
    )

    minimum_pixel_x = pixel_x.min(dim=1).values
    maximum_pixel_x = pixel_x.max(dim=1).values
    minimum_pixel_y = pixel_y.min(dim=1).values
    maximum_pixel_y = pixel_y.max(dim=1).values
    left_boundary_loss = (F.relu(margin_pixels - minimum_pixel_x) ** 2).mean()
    right_boundary_loss = (
        F.relu(maximum_pixel_x - (float(image_width) - margin_pixels)) ** 2
    ).mean()
    top_boundary_loss = (F.relu(margin_pixels - minimum_pixel_y) ** 2).mean()
    bottom_boundary_loss = (
        F.relu(maximum_pixel_y - (float(image_height) - margin_pixels)) ** 2
    ).mean()
    depth_loss = (F.relu(float(near_depth) - camera_depth) ** 2).mean()

    return {
        "inFrame/left": (LOSS_WEIGHTS.get("inframe_left", 1.0) * left_boundary_loss),
        "inFrame/right": (LOSS_WEIGHTS.get("inframe_right", 1.0) * right_boundary_loss),
        "inFrame/top": (LOSS_WEIGHTS.get("inframe_top", 1.0) * top_boundary_loss),
        "inFrame/bottom": (
            LOSS_WEIGHTS.get("inframe_bottom", 1.0) * bottom_boundary_loss
        ),
        "inFrame/depth": (LOSS_WEIGHTS.get("inframe_depth", 1.0) * depth_loss),
    }


def follow_movement_losses(
    camera_positions: torch.Tensor,
    camera_quaternions: torch.Tensor,
    start_frame: int,
    end_frame: int,
    subject_positions: torch.Tensor,
    world_bbox_corners: torch.Tensor,
    image_width: int,
    image_height: int,
    focal_length_x: float,
    focal_length_y: float,
    principal_point_x: float,
    principal_point_y: float,
    margin_pixels: float = 20.0,
) -> Dict[str, torch.Tensor]:
    frame_count = camera_positions.shape[0]
    start_frame, end_frame = clamp_frame_interval(
        start_frame,
        end_frame,
        frame_count,
    )
    if end_frame <= start_frame:
        return {}

    interval_positions = camera_positions[start_frame : end_frame + 1]
    interval_quaternions = camera_quaternions[start_frame : end_frame + 1]

    losses: Dict[str, torch.Tensor] = {}

    keep_position_loss = position_hold_loss(
        camera_positions,
        start_frame,
        end_frame,
    )
    losses["follow/keepTrans"] = (
        LOSS_WEIGHTS.get("follow_keep_trans", 1.0) * keep_position_loss
    )

    losses.update(
        subject_bbox_visibility_losses(
            interval_positions,
            interval_quaternions,
            world_bbox_corners,
            image_width,
            image_height,
            focal_length_x,
            focal_length_y,
            principal_point_x,
            principal_point_y,
            margin_pixels=margin_pixels,
        )
    )

    framing_losses = framing_alignment_losses(
        interval_positions,
        interval_quaternions,
        subject_positions,
    )
    if "framing/lookat" in framing_losses:
        losses["follow/lookat"] = LOSS_WEIGHTS.get("follow_lookat", 1.0) * (
            framing_losses["framing/lookat"]
            / max(LOSS_WEIGHTS.get("lookat", 1.0), 1e-8)
        )

    return losses


def subject_distance_hold_loss(
    camera_positions: torch.Tensor,
    subject_positions: torch.Tensor,
) -> torch.Tensor:
    if camera_positions.numel() == 0 or subject_positions.numel() == 0:
        return torch.zeros(
            (),
            device=camera_positions.device,
            dtype=camera_positions.dtype,
        )

    subject_distances = stabilized_vector_norm(
        camera_positions - subject_positions
    ).squeeze(-1)
    initial_distance = subject_distances[0].detach()
    return ((subject_distances - initial_distance) ** 2).mean()


def track_movement_losses(
    camera_positions: torch.Tensor,
    camera_quaternions: torch.Tensor,
    start_frame: int,
    end_frame: int,
    subject_positions: torch.Tensor,
    world_bbox_corners: torch.Tensor,
    image_width: int,
    image_height: int,
    focal_length_x: float,
    focal_length_y: float,
    principal_point_x: float,
    principal_point_y: float,
    margin_pixels: float = 20.0,
) -> Dict[str, torch.Tensor]:
    frame_count = camera_positions.shape[0]
    start_frame, end_frame = clamp_frame_interval(
        start_frame,
        end_frame,
        frame_count,
    )
    if end_frame <= start_frame:
        return {}

    interval_positions = camera_positions[start_frame : end_frame + 1]
    interval_quaternions = camera_quaternions[start_frame : end_frame + 1]

    losses: Dict[str, torch.Tensor] = {}

    keep_distance_loss = subject_distance_hold_loss(
        interval_positions,
        subject_positions,
    )
    losses["track/keepDistance"] = (
        LOSS_WEIGHTS.get("track_keep_distance", 1.0) * keep_distance_loss
    )
    losses.update(
        subject_bbox_visibility_losses(
            interval_positions,
            interval_quaternions,
            world_bbox_corners,
            image_width,
            image_height,
            focal_length_x,
            focal_length_y,
            principal_point_x,
            principal_point_y,
            margin_pixels=margin_pixels,
        )
    )
    framing_losses = framing_alignment_losses(
        interval_positions,
        interval_quaternions,
        subject_positions,
    )
    if "framing/lookat" in framing_losses:
        losses["track/lookat"] = LOSS_WEIGHTS.get("track_lookat", 1.0) * (
            framing_losses["framing/lookat"]
            / max(LOSS_WEIGHTS.get("lookat", 1.0), 1e-8)
        )

    return losses


def shot_size_distance_losses(
    camera_positions: torch.Tensor,
    subject_positions: torch.Tensor,
    shot_size: str,
) -> Dict[str, torch.Tensor]:
    if camera_positions.numel() == 0 or subject_positions.numel() == 0:
        zero = torch.zeros(
            (),
            device=camera_positions.device,
            dtype=camera_positions.dtype,
        )
        return {"shotSize/dist": zero}
    target_distance = SHOT_DISTANCE_BY_SIZE.get(
        shot_size,
        SHOT_DISTANCE_BY_SIZE["mediumLongShot"],
    )
    subject_distances = stabilized_vector_norm(
        subject_positions - camera_positions
    ).squeeze(-1)
    distance_loss = ((subject_distances - target_distance) ** 2).mean()
    return {"shotSize/dist": (LOSS_WEIGHTS["shot_distance"] * distance_loss)}


def subject_view_azimuth_losses(
    camera_positions: torch.Tensor,
    subject_positions: torch.Tensor,
    view: str,
) -> Dict[str, torch.Tensor]:
    if camera_positions.numel() == 0 or subject_positions.numel() == 0:
        zero = torch.zeros(
            (),
            device=camera_positions.device,
            dtype=camera_positions.dtype,
        )
        return {"subjectView/azimuth": zero}
    target_azimuth = math.radians(VIEW_AZIMUTH_DEGREES.get(view, 0.0))
    subject_to_camera = camera_positions - subject_positions
    camera_azimuths, valid_azimuths = stable_atan2(
        subject_to_camera[:, 0],
        -subject_to_camera[:, 2],
    )
    azimuth_errors = torch.atan2(
        torch.sin(camera_azimuths - target_azimuth),
        torch.cos(camera_azimuths - target_azimuth),
    )
    valid_weights = valid_azimuths.to(dtype=camera_positions.dtype)
    azimuth_loss = (
        azimuth_errors.square() * valid_weights
    ).sum() / valid_weights.sum().clamp_min(1.0)
    return {"subjectView/azimuth": (LOSS_WEIGHTS["subject_view"] * azimuth_loss)}


def subject_view_orientation_losses(
    camera_positions: torch.Tensor,
    camera_quaternions: torch.Tensor,
    subject_positions: torch.Tensor,
    view: str,
) -> Dict[str, torch.Tensor]:
    losses = subject_view_azimuth_losses(
        camera_positions,
        subject_positions,
        view,
    )
    forward_vectors, _, _ = camera_axes_from_quaternions(camera_quaternions)
    yaw_angles = unwrap_angles(yaw_from_forward_vectors(forward_vectors))
    target_azimuth = math.radians(VIEW_AZIMUTH_DEGREES[view])
    yaw_errors = torch.atan2(
        torch.sin(yaw_angles - target_azimuth),
        torch.cos(yaw_angles - target_azimuth),
    )
    losses["subjectView/orientYaw"] = (
        LOSS_WEIGHTS["subject_view_orient"] * (yaw_errors**2).mean()
    )
    return losses


def framing_alignment_losses(
    camera_positions: torch.Tensor,
    camera_quaternions: torch.Tensor,
    subject_positions: torch.Tensor,
) -> Dict[str, torch.Tensor]:
    if (
        camera_positions.numel() == 0
        or camera_quaternions.numel() == 0
        or subject_positions.numel() == 0
    ):
        zero = torch.zeros(
            (),
            device=camera_positions.device,
            dtype=camera_positions.dtype,
        )
        return {"framing/lookat": zero, "framing/ray": zero}
    forward_vectors, _, _ = camera_axes_from_quaternions(camera_quaternions)
    camera_to_subject = subject_positions - camera_positions
    subject_directions = normalize_vectors(camera_to_subject)
    look_at_loss = look_at_alignment_loss(
        forward_vectors,
        subject_directions,
    ).mean()
    along_ray = (camera_to_subject * forward_vectors).sum(
        dim=-1,
        keepdim=True,
    ) * forward_vectors
    perpendicular_offset = camera_to_subject - along_ray
    ray_loss = perpendicular_offset.pow(2).sum(dim=-1).mean()
    return {
        "framing/lookat": LOSS_WEIGHTS["lookat"] * look_at_loss,
        "framing/ray": LOSS_WEIGHTS["framing_ray"] * ray_loss,
    }


def point_pose_anchor_losses(
    camera_positions: torch.Tensor,
    camera_quaternions: torch.Tensor,
    target_position: Optional[List[float]],
    target_rotation: Optional[List[float]],
) -> Dict[str, torch.Tensor]:
    device, dtype = camera_positions.device, camera_positions.dtype
    losses: Dict[str, torch.Tensor] = {}
    if target_position is not None:
        target_position_tensor = torch.tensor(
            target_position,
            device=device,
            dtype=dtype,
        )
        position_loss = (
            ((camera_positions - target_position_tensor) ** 2).sum(dim=-1).mean()
        )
        losses["point/position"] = (
            LOSS_WEIGHTS.get("point_position", 1000.0) * position_loss
        )
    if target_rotation is not None:
        target_quaternion = torch.tensor(
            target_rotation,
            device=device,
            dtype=dtype,
        )
        target_quaternion = normalize_quaternion(target_quaternion.unsqueeze(0))
        normalized_quaternions = normalize_quaternion(camera_quaternions)
        quaternion_alignments = (
            (normalized_quaternions * target_quaternion)
            .sum(dim=-1)
            .abs()
            .clamp(0.0, 1.0)
        )
        rotation_loss = (1.0 - quaternion_alignments**2).mean()

        losses["point/rotation"] = (
            LOSS_WEIGHTS.get("point_rotation", 1000.0) * rotation_loss
        )

    return losses
