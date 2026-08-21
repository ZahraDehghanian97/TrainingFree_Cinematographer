from copy import deepcopy
import numpy as np
from typing import Any

try:
    from .math3d.numpy_quaternions import look_at_quaternion
    from .subject_ids import canonical_subject_id
except ImportError:
    from math3d.numpy_quaternions import look_at_quaternion
    from subject_ids import canonical_subject_id

DEFAULT_SUBJECT_ID = "C0"

DEFAULT_CAMERA_POSITION = [0.0, 5.0, 0.0]
DEFAULT_CAMERA_QUATERNION = [1.0, 0.0, 0.0, 0.0]


LOSS_TYPE_MAP = {
    # Translation
    "dollyInMovement": "dollyInMovement",
    "dollyOutMovement": "dollyOutMovement",
    "truckLeftMovement": "truckLeftMovement",
    "truckRightMovement": "truckRightMovement",
    "pedestalUpMovement": "pedestalUpMovement",
    "pedestalDownMovement": "pedestalDownMovement",
    # Rotation
    "panLeftMovement": "panLeftMovement",
    "panRightMovement": "panRightMovement",
    "tiltUpMovement": "tiltUpMovement",
    "tiltDownMovement": "tiltDownMovement",
    "dutchLeftMovement": "dutchLeftMovement",
    "dutchRightMovement": "dutchRightMovement",
    "zoomInMovement": "zoomInMovement",
    "zoomOutMovement": "zoomOutMovement",
    "arcMovement": "arcMovement",
    "followMovement": "followMovement",
    "trackMovement": "trackMovement",
    "static": "static",
    "Static": "static",
    # Framing
    "shotSize": "shotSize",
    "framingPosition": "framingPosition",
    "subjectView": "subjectView",
}


SUBJECT_AWARE_LOSSES = {
    "arcMovement",
    "followMovement",
    "trackMovement",
    "shotSize",
    "framingPosition",
    "subjectView",
}


def convert_timeline_loss_to_optimizer_loss(timeline_loss):
    """Translate one timeline loss definition into optimizer parameters."""
    source_loss_type = timeline_loss["type"]
    optimizer_loss_type = LOSS_TYPE_MAP.get(
        source_loss_type,
        source_loss_type,
    )

    optimizer_loss = {"type": optimizer_loss_type}

    parameters = deepcopy(timeline_loss.get("parameters", {}))

    if "rotationAngle" in parameters:
        parameters["angleDeg"] = parameters.pop("rotationAngle")

    if "arcAngle" in parameters:
        parameters["angleDeg"] = parameters.pop("arcAngle")

    if "arcRadius" in parameters:
        parameters["radius"] = parameters.pop("arcRadius")

    if "view" not in parameters and "subjectView" in parameters:
        parameters["view"] = parameters.pop("subjectView")

    # A loss can reference multiple targets at once — e.g. "frame the vase
    # AND the monitor" — by listing them under "subjectIds" instead of the
    # usual single "subjectId". Every loss function and dispatcher lookup
    # downstream still only ever sees ONE subjectId string; the list is
    # collapsed here into the same compound-key format
    # pipeline/execution.py knows how to recognize and synthesize a union
    # entry for. If both "subjectId" and "subjectIds" are present,
    # "subjectIds" wins — it's the more specific instruction.
    if "subjectIds" in parameters:
        parameters["subjectId"] = canonical_subject_id(parameters.pop("subjectIds"))

    #
    # Temporary assumption:
    # Every subject-aware loss refers to subject C0.
    #
    if optimizer_loss_type in SUBJECT_AWARE_LOSSES:
        parameters.setdefault("subjectId", DEFAULT_SUBJECT_ID)

    optimizer_loss.update(parameters)

    return optimizer_loss


def extract_overview_camera(env_json: dict | None) -> tuple[list[float] | None, list[float] | None]:
    """Extract initial camera position and orientation quaternion from environment JSON."""
    if not env_json:
        return None, None

    overview = env_json.get("world", {}).get("overviewCamera", {})
    if not overview or "position" not in overview or "target" not in overview:
        return None, None

    pos = np.array(overview["position"], dtype=np.float32)
    target = np.array(overview["target"], dtype=np.float32)

    # Optimizer rotations are wxyz quaternions whose local +Z axis is forward.
    quat_wxyz = look_at_quaternion(pos, target)

    return pos.tolist(), quat_wxyz.tolist()


def build_optimizer_constraints_from_timeline(
    flattened_timeline: dict[str, Any],
    environment_json: dict[str, Any] | None = None,
) -> list[dict[str, Any]]:
    """Build optimizer constraints from the flattened timeline and optional environment specs."""
    optimizer_constraints = []

    # Try extracting initial camera pose from env overview; fall back to default
    env_pos, env_quat = extract_overview_camera(environment_json)
    initial_position = env_pos if env_pos is not None else DEFAULT_CAMERA_POSITION
    initial_quaternion = env_quat if env_quat is not None else DEFAULT_CAMERA_QUATERNION

    # Point constraint at t=0
    optimizer_constraints.append(
        {
            "kind": "point",
            "t": 0,
            "position": initial_position,
            "quaternion": initial_quaternion,
            "losses": [],
        }
    )

    for timeline_segment in flattened_timeline.get("timeline", []):
        kind = timeline_segment.get("kind")
        
        if kind == "interval":
            optimizer_constraints.append(
                {
                    "kind": "interval",
                    "t0": timeline_segment["startTime"],
                    "t1": timeline_segment["endTime"],
                    "losses": [
                        convert_timeline_loss_to_optimizer_loss(timeline_loss)
                        for timeline_loss in timeline_segment.get("lossFunctions", [])
                    ],
                }
            )

        elif kind == "point":
            point_constraint = {
                "kind": "point",
                "t": timeline_segment["time"],
                "position": initial_position,
                "quaternion": initial_quaternion,
                "losses": [
                    convert_timeline_loss_to_optimizer_loss(timeline_loss)
                    for timeline_loss in timeline_segment.get("lossFunctions", [])
                ],
            }
            if "weight" in timeline_segment:
                point_constraint["weight"] = timeline_segment["weight"]
            if "easing" in timeline_segment:
                point_constraint["easing"] = deepcopy(timeline_segment["easing"])
            optimizer_constraints.append(point_constraint)

    return optimizer_constraints
