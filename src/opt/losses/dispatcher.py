"""Constraint dispatcher that assembles trajectory-loss reports."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

import torch

from .arc import arc_movement_losses
from .config import LOSS_WEIGHTS, TRANSLATION_MOVES
from .interval import (
    clamp_frame_interval,
    local_axis_translation_losses,
    mean_path_step_distance,
    pan_tilt_movement_losses,
    position_hold_loss,
    static_interval_losses,
)
from .subject import (
    follow_movement_losses,
    framing_alignment_losses,
    point_pose_anchor_losses,
    level_horizon_roll_loss,
    shot_size_distance_losses,
    subject_view_orientation_losses,
    track_movement_losses,
)

DEFAULT_SUBJECT_ID = "C0"

_TRANSLATION_LOSS_TYPES = (
    "truckLeftMovement",
    "truckRightMovement",
    "dollyInMovement",
    "dollyOutMovement",
    "pedestalUpMovement",
    "pedestalDownMovement",
)

_ROTATION_LOSS_TYPES = (
    "panLeftMovement",
    "panRightMovement",
    "tiltUpMovement",
    "tiltDownMovement",
)

_SUBJECT_COMPOSITION_LOSS_TYPES = (
    "framingPosition",
    "shotSize",
    "subjectView",
)


@dataclass
class LossReport:
    total: torch.Tensor
    terms: Dict[str, torch.Tensor]


@dataclass
class _TrajectoryLossContext:
    camera_positions: torch.Tensor
    camera_quaternions: torch.Tensor
    subject_centers: Optional[Dict[str, torch.Tensor]]
    image_height: int
    image_width: int
    subject_bboxes_world: Any
    focal_length_x: Optional[float]
    focal_length_y: Optional[float]
    principal_point_x: Optional[float]
    principal_point_y: Optional[float]
    loss_terms: Dict[str, torch.Tensor] = field(default_factory=dict)
    # Keyed by id(loss_spec): per-arc-constraint persisted state (currently
    # just the previous iteration's fitted plane normal, for sign
    # stability — see arc.arc_movement_losses). Normally passed in from
    # outside (owned by the long-lived training loop, e.g.
    # OptimizationTensors) so it actually persists across iterations;
    # _TrajectoryLossContext itself is rebuilt fresh every
    # compute_trajectory_loss() call and would NOT provide persistence on
    # its own if left at the default empty dict.
    arc_plane_states: Dict[int, Dict[str, torch.Tensor]] = field(default_factory=dict)

    @property
    def device(self) -> torch.device:
        return self.camera_positions.device

    @property
    def dtype(self) -> torch.dtype:
        return self.camera_positions.dtype

    @property
    def frame_count(self) -> int:
        return self.camera_positions.shape[0]

    def zero(self) -> torch.Tensor:
        return torch.zeros((), device=self.device, dtype=self.dtype)

    def accumulate_terms(self, new_terms: Dict[str, torch.Tensor]) -> None:
        for term_name, term_value in new_terms.items():
            if not torch.is_tensor(term_value):
                term_value = torch.tensor(
                    term_value,
                    device=self.device,
                    dtype=self.dtype,
                )
            self.loss_terms[term_name] = (
                self.loss_terms.get(
                    term_name,
                    self.zero(),
                )
                + term_value
            )

    def accumulate_term(self, term_name: str, term_value: torch.Tensor) -> None:
        self.loss_terms[term_name] = (
            self.loss_terms.get(
                term_name,
                self.zero(),
            )
            + term_value
        )


def _subject_id(
    constraint: Dict[str, Any],
    loss_spec: Dict[str, Any],
) -> str:
    """Resolve subject ID with default fallback to 'C0' for DSL inputs."""
    subject_id = loss_spec.get("subjectId") or constraint.get("subjectId")
    if subject_id:
        return str(subject_id)
    
    return DEFAULT_SUBJECT_ID  # Always returns "C0" instead of None

def _subject_anchored_reference_frame(
    camera_positions: torch.Tensor,
    subject_positions: torch.Tensor,
    start_frame: int,
    end_frame: int,
    track_per_frame: bool = False,
) -> Dict[str, torch.Tensor]:
    """Build a forward/right/up frame from subject geometry.

    Detached either way — a reference direction the camera moves ALONG,
    not something gradients should bend by moving the camera or subject.

    ``track_per_frame=False`` (default): anchored ONCE at start_frame and
    held fixed for the whole interval, mirroring arc.py's frame-0-anchored
    plane normal. This is the stable choice and should stay the default —
    for a plain translation move toward/around a subject, "which way is
    toward the subject" should read as one consistent target for the whole
    interval. Recomputing it every frame from the camera's OWN
    still-optimizing position turns it into a moving goalpost: before the
    trajectory has converged, the per-frame direction is itself derived
    from a currently-wobbly path, which showed up as a large regression in
    dollyMovement/stepPacing (and, via the shared control points, in
    framing/lookat and framing/ray too) the one time this was tried
    unconditionally on a plain dolly with no arc involved.

    ``track_per_frame=True``: recomputed at every frame instead. Only
    reach for this when the camera's relationship to the subject is
    DELIBERATELY changing throughout the interval — the one confirmed case
    is a same-interval arcMovement + dollyInMovement (a spiral), where the
    camera's angular position around the subject is intentionally moving,
    so a frame-0-anchored "forward" would only be correct for an instant.
    See the dispatcher call site for the arcMovement co-occurrence check
    that decides this.
    """
    device = camera_positions.device
    dtype = camera_positions.dtype
    world_up = torch.tensor([0.0, 1.0, 0.0], device=device, dtype=dtype)

    if track_per_frame:
        interval_positions = camera_positions[start_frame : end_frame + 1].detach()
        interval_subject_positions = subject_positions[
            start_frame : end_frame + 1
        ].detach()
    else:
        # Single start-frame snapshot, expanded to interval length below —
        # every frame in the interval shares this one fixed direction.
        interval_positions = camera_positions[start_frame : start_frame + 1].detach()
        interval_subject_positions = subject_positions[
            start_frame : start_frame + 1
        ].detach()

    look_direction = interval_subject_positions - interval_positions  # (t, 3)
    horizontal = (
        look_direction
        - (look_direction * world_up).sum(dim=-1, keepdim=True) * world_up
    )
    horizontal_norm = horizontal.norm(dim=-1, keepdim=True)
    fallback_forward = torch.tensor(
        [0.0, 0.0, 1.0], device=device, dtype=dtype
    ).expand_as(horizontal)
    forward = torch.where(
        horizontal_norm > 1e-6,
        horizontal / horizontal_norm.clamp_min(1e-6),
        fallback_forward,
    )

    right = torch.cross(forward, world_up.expand_as(forward), dim=-1)
    right = right / (right.norm(dim=-1, keepdim=True) + 1e-8)

    up = world_up.expand_as(forward)

    if not track_per_frame:
        interval_length = end_frame - start_frame + 1
        forward = forward.expand(interval_length, 3)
        right = right.expand(interval_length, 3)
        up = up.expand(interval_length, 3)

    return {"forward": forward, "right": right, "up": up}


def _add_translation_movement_loss(
    context: _TrajectoryLossContext,
    constraint: Dict[str, Any],
    loss_spec: Dict[str, Any],
    loss_type: str,
    start_frame: int,
    end_frame: int,
) -> None:
    axis_name, movement_sign = TRANSLATION_MOVES[loss_type]

    target_distance = loss_spec.get("distance")
    if target_distance is not None:
        target_distance = float(target_distance)

    if context.subject_centers is None:
        return
    subject_id = _subject_id(constraint, loss_spec)
    if subject_id is None:
        return

    interval_positions = context.camera_positions[start_frame : end_frame + 1]
    interval_quaternions = context.camera_quaternions[start_frame : end_frame + 1]
    interval_subject_positions = context.subject_centers[subject_id][
        start_frame : end_frame + 1
    ]

    framing_terms = framing_alignment_losses(camera_positions=interval_positions,
                                             camera_quaternions=interval_quaternions,
                                             subject_positions=interval_subject_positions)
    
    context.accumulate_terms(framing_terms) 
    
    context.accumulate_terms(
        level_horizon_roll_loss(interval_quaternions)
    )

    # A same-interval arcMovement means this translation is (deliberately)
    # orbiting rather than moving in a straight line — e.g. a spiral
    # (arc + dollyIn together). Two things follow from that, both gated on
    # the SAME check: (1) the reference frame needs to track the subject
    # per-frame rather than stay fixed, since the camera's angular position
    # is intentionally changing throughout; (2) orth_drift's premise —
    # "don't leave the plane/line this move started on" — directly
    # contradicts that, since an orbit's right/up displacement IS the arc
    # doing its job, not drift to be penalized. Without a co-occurring arc,
    # neither applies — see _subject_anchored_reference_frame's docstring
    # for why unconditional per-frame tracking regressed a plain dolly.
    constraint_loss_types = {
        other_loss_spec.get("type") for other_loss_spec in constraint.get("losses", [])
    }
    has_co_occurring_arc = "arcMovement" in constraint_loss_types

    reference_frame = _subject_anchored_reference_frame(
        context.camera_positions,
        context.subject_centers[subject_id],
        start_frame,
        end_frame,
        track_per_frame=has_co_occurring_arc,
    )

    context.accumulate_terms(
        local_axis_translation_losses(
            camera_positions=context.camera_positions,
            camera_quaternions=context.camera_quaternions,
            start_frame=start_frame,
            end_frame=end_frame,
            axis_name=axis_name,
            movement_sign=movement_sign,
            target_distance=target_distance,
            reference_frame=reference_frame,
            suppress_drift=has_co_occurring_arc,
        )
    )

    # trans_keep_rot ("hold the starting orientation") intentionally does
    # NOT apply here. This function only ever reaches this point when a
    # subject is in scope (see the early returns above) — meaning framing
    # has ALWAYS already been applied by this line, every time. keepRot and
    # framing were previously both pulling on orientation unconditionally
    # and independently for the whole duration of every translation move,
    # with nothing coordinating between "hold still" and "look at the
    # subject" — that's what showed up as a persistently large
    # dollyOutMovement/keepRot residual sitting alongside framing/lookat
    # and framing/ray in the loss breakdown. Framing owns orientation
    # whenever a subject is present; keepRot's actual job — don't let
    # orientation drift for no reason — only makes sense when nothing else
    # has a legitimate claim on it, i.e. a genuine no-subject translation
    # move. That path doesn't exist yet (subject_centers/subject_id is
    # required just to reach this function at all); trans_keep_rot stays
    # defined in LOSS_WEIGHTS for when one is added, but has no consumer
    # until then.


def _add_rotation_movement_loss(
    context: _TrajectoryLossContext,
    loss_spec: Dict[str, Any],
    loss_type: str,
    start_frame: int,
    end_frame: int,
) -> None:
    angle = loss_spec.get("angleDeg")
    if angle is not None:
        angle = float(angle)

    context.accumulate_terms(
        pan_tilt_movement_losses(
            camera_quaternions=context.camera_quaternions,
            start_frame=start_frame,
            end_frame=end_frame,
            movement_type=loss_type,
            angle_deg=angle,
        )
    )

    position_hold_weight = float(LOSS_WEIGHTS.get("rot_keep_trans", 0.0))
    if position_hold_weight > 0:
        context.accumulate_term(
            f"{loss_type}/keepTrans",
            position_hold_weight
            * position_hold_loss(
                context.camera_positions,
                start_frame,
                end_frame,
            ),
        )


def _add_arc_movement_loss(
    context: _TrajectoryLossContext,
    constraint: Dict[str, Any],
    loss_spec: Dict[str, Any],
    start_frame: int,
    end_frame: int,
) -> None:
    if context.subject_centers is None:
        return
    subject_id = _subject_id(constraint, loss_spec)
    if subject_id is None:
        return

    arc_centers = context.subject_centers[subject_id].detach()
    radius = loss_spec.get("radius", None)
    radius = None if radius is None else float(radius)
    angle = loss_spec.get("angleDeg", None)
    angle = None if angle is None else float(angle)
    arc_state = context.arc_plane_states.setdefault(id(loss_spec), {})
    context.accumulate_terms(
        arc_movement_losses(
            context.camera_positions,
            context.camera_quaternions,
            arc_centers,
            start_frame,
            end_frame,
            radius,
            angle,
            state=arc_state,
            hold_y=True
        )
    )


def _add_subject_composition_loss(
    context: _TrajectoryLossContext,
    constraint: Dict[str, Any],
    loss_spec: Dict[str, Any],
    loss_type: str,
    start_frame: int,
    end_frame: int,
) -> None:
    if context.subject_centers is None:
        return
    subject_id = _subject_id(constraint, loss_spec)
    if subject_id is None:
        return

    interval_positions = context.camera_positions[start_frame : end_frame + 1]
    interval_quaternions = context.camera_quaternions[start_frame : end_frame + 1]
    interval_subject_positions = context.subject_centers[subject_id][
        start_frame : end_frame + 1
    ]

    # 1. Subject composition loss for this interval
    context.accumulate_terms(
        _subject_composition_terms(
            loss_type,
            loss_spec,
            interval_positions,
            interval_quaternions,
            interval_subject_positions,
        )
    )

    # 2. Exactly ONE horizon roll loss term for this interval
    context.accumulate_terms(
        level_horizon_roll_loss(interval_quaternions)
    )

def _subject_composition_terms(
    loss_type: str,
    loss_spec: Dict[str, Any],
    camera_positions: torch.Tensor,
    camera_quaternions: torch.Tensor,
    subject_positions: torch.Tensor,
) -> Dict[str, torch.Tensor]:
    if loss_type == "framingPosition":
        return framing_alignment_losses(
            camera_positions,
            camera_quaternions,
            subject_positions,
        )
    if loss_type == "shotSize":
        shot_size = loss_spec.get(
            "shotSize",
            "mediumLongShot",
        )
        return shot_size_distance_losses(
            camera_positions,
            subject_positions,
            shot_size,
        )

    subject_view = loss_spec.get("view", "front")
    return subject_view_orientation_losses(
        camera_positions,
        camera_quaternions,
        subject_positions,
        subject_view,
    )


def _require_camera_intrinsics(
    context: _TrajectoryLossContext,
    movement_type: str,
) -> None:
    if any(
        value is None
        for value in (
            context.focal_length_x,
            context.focal_length_y,
            context.principal_point_x,
            context.principal_point_y,
        )
    ):
        raise ValueError(
            f"{movement_type} requires focal lengths and principal-point coordinates"
        )


def _add_follow_or_track_loss(
    context: _TrajectoryLossContext,
    constraint: Dict[str, Any],
    loss_spec: Dict[str, Any],
    loss_type: str,
    start_frame: int,
    end_frame: int,
) -> None:
    subject_id = loss_spec.get(
        "subjectId",
        constraint.get("subjectId"),
    )
    if (
        subject_id is None
        or context.subject_centers is None
        or context.subject_bboxes_world is None
    ):
        return

    _require_camera_intrinsics(context, loss_type)
    interval_subject_positions = context.subject_centers[subject_id][
        start_frame : end_frame + 1
    ]
    interval_bbox_corners = context.subject_bboxes_world[subject_id][
        start_frame : end_frame + 1
    ]
    movement_loss = (
        follow_movement_losses
        if loss_type == "followMovement"
        else track_movement_losses
    )
    context.accumulate_terms(
        movement_loss(
            context.camera_positions,
            context.camera_quaternions,
            start_frame,
            end_frame,
            interval_subject_positions,
            interval_bbox_corners,
            image_width=context.image_width,
            image_height=context.image_height,
            focal_length_x=context.focal_length_x,
            focal_length_y=context.focal_length_y,
            principal_point_x=context.principal_point_x,
            principal_point_y=context.principal_point_y,
            margin_pixels=loss_spec.get(
                "marginPx",
                20.0,
            ),
        )
    )


def _process_interval_loss(
    context: _TrajectoryLossContext,
    constraint: Dict[str, Any],
    loss_spec: Dict[str, Any],
    start_frame: int,
    end_frame: int,
) -> None:
    loss_type = loss_spec["type"]

    if loss_type in _TRANSLATION_LOSS_TYPES:
        _add_translation_movement_loss(
            context,
            constraint,
            loss_spec,
            loss_type,
            start_frame,
            end_frame,
        )
    elif loss_type in _ROTATION_LOSS_TYPES:
        _add_rotation_movement_loss(
            context,
            loss_spec,
            loss_type,
            start_frame,
            end_frame,
        )
    elif loss_type == "arcMovement":
        _add_arc_movement_loss(
            context,
            constraint,
            loss_spec,
            start_frame,
            end_frame,
        )
    elif loss_type in _SUBJECT_COMPOSITION_LOSS_TYPES:
        _add_subject_composition_loss(
            context,
            constraint,
            loss_spec,
            loss_type,
            start_frame,
            end_frame,
        )
    elif loss_type in ("static", "staticMovement"):
        context.accumulate_terms(
            static_interval_losses(
                context.camera_positions,
                context.camera_quaternions,
                start_frame,
                end_frame,
            )
        )
    elif loss_type in ("followMovement", "trackMovement"):
        _add_follow_or_track_loss(
            context,
            constraint,
            loss_spec,
            loss_type,
            start_frame,
            end_frame,
        )


def _process_interval_constraint(
    context: _TrajectoryLossContext,
    constraint: Dict[str, Any],
    constraint_losses: List[Dict[str, Any]],
) -> None:
    start_frame = int(constraint["t0"])
    end_frame = int(constraint["t1"])
    start_frame, end_frame = clamp_frame_interval(
        start_frame,
        end_frame,
        context.frame_count,
    )
    if end_frame <= start_frame:
        return

    if LOSS_WEIGHTS["min_path_interval"] > 0:
        context.accumulate_term(
            "minPath/interval",
            LOSS_WEIGHTS["min_path_interval"]
            * mean_path_step_distance(
                context.camera_positions,
                start_frame,
                end_frame,
            ),
        )

    for loss_spec in constraint_losses:
        _process_interval_loss(
            context,
            constraint,
            loss_spec,
            start_frame,
            end_frame,
        )


def _add_default_point_anchor(
    context: _TrajectoryLossContext,
    constraint: Dict[str, Any],
    frame_index: int,
) -> None:
    frame_index = constraint.get("t")
    target_position = constraint.get("position")
    target_rotation = constraint.get("quaternion")
    point_positions = context.camera_positions[frame_index : frame_index + 1]
    point_quaternions = context.camera_quaternions[frame_index : frame_index + 1]
    context.accumulate_terms(
        point_pose_anchor_losses(
            point_positions,
            point_quaternions,
            target_position,
            target_rotation,
        )
    )


def _process_point_constraint(
    context: _TrajectoryLossContext,
    constraint: Dict[str, Any],
    constraint_losses: List[Dict[str, Any]],
) -> None:
    frame_index = int(constraint["t"])
    if frame_index < 0 or frame_index >= context.frame_count:
        return

    if len(constraint_losses) == 0:
        _add_default_point_anchor(context, constraint, frame_index)

    for loss_spec in constraint_losses:
        loss_type = loss_spec["type"]
        if loss_type not in _SUBJECT_COMPOSITION_LOSS_TYPES:
            continue
        if context.subject_centers is None:
            continue
        subject_id = _subject_id(constraint, loss_spec)
        if subject_id is None:
            continue

        point_positions = context.camera_positions[frame_index : frame_index + 1]
        point_quaternions = context.camera_quaternions[frame_index : frame_index + 1]
        point_subject_positions = context.subject_centers[subject_id][
            frame_index : frame_index + 1
        ]
        context.accumulate_terms(
            _subject_composition_terms(
                loss_type,
                loss_spec,
                point_positions,
                point_quaternions,
                point_subject_positions,
            )
        )


def _process_constraint(
    context: _TrajectoryLossContext,
    constraint: Dict[str, Any],
) -> None:
    constraint_kind = constraint["kind"]
    constraint_losses = constraint.get("losses", [])

    if constraint_kind == "interval":
        _process_interval_constraint(context, constraint, constraint_losses)
    elif constraint_kind == "point":
        _process_point_constraint(context, constraint, constraint_losses)
    else:
        raise ValueError(f"Unknown constraint kind: {constraint_kind}")


def compute_trajectory_loss(
    camera_positions: torch.Tensor,
    camera_quaternions: torch.Tensor,
    constraints: List[Dict[str, Any]],
    subject_centers: Optional[Dict[str, torch.Tensor]] = None,
    image_height=1800,
    image_width=1800,
    subject_bboxes_world=None,
    focal_length_x: Optional[float] = None,
    focal_length_y: Optional[float] = None,
    principal_point_x: Optional[float] = None,
    principal_point_y: Optional[float] = None,
    arc_plane_states: Optional[Dict[int, Dict[str, torch.Tensor]]] = None,
) -> LossReport:
    """
    `arc_plane_states`, if provided, should be a dict the CALLER creates
    ONCE and passes back in on every call for the lifetime of one
    optimization run (e.g. stored on OptimizationTensors) — it's used to
    stabilize each arc constraint's fitted plane-normal sign across
    iterations (see arc.arc_movement_losses). Leave as None to opt out.
    """
    context = _TrajectoryLossContext(
        camera_positions=camera_positions,
        camera_quaternions=camera_quaternions,
        subject_centers=subject_centers,
        image_height=image_height,
        image_width=image_width,
        subject_bboxes_world=subject_bboxes_world,
        focal_length_x=focal_length_x,
        focal_length_y=focal_length_y,
        principal_point_x=principal_point_x,
        principal_point_y=principal_point_y,
        arc_plane_states=arc_plane_states if arc_plane_states is not None else {},
    )

    for constraint in constraints:
        _process_constraint(context, constraint)

    total_loss = context.zero()
    for term_value in context.loss_terms.values():
        total_loss = total_loss + term_value

    return LossReport(total=total_loss, terms=context.loss_terms)