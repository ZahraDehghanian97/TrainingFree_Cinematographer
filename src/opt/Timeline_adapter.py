from copy import deepcopy
from scipy.spatial.transform import Rotation as R
import numpy as np
from typing import Any

try:
    from .subject_ids import canonical_subject_id
except ImportError:
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

    forward = target - pos
    norm = np.linalg.norm(forward)
    if norm < 1e-6:
        forward = np.array([0.0, 0.0, -1.0], dtype=np.float32)
    else:
        forward /= norm

    world_up = np.array([0.0, 1.0, 0.0], dtype=np.float32)
    right = np.cross(forward, world_up)
    if np.linalg.norm(right) < 1e-6:
        right = np.array([1.0, 0.0, 0.0], dtype=np.float32)
    else:
        right /= np.linalg.norm(right)

    cam_up = np.cross(right, forward)
    cam_up /= np.linalg.norm(cam_up)

    # Convert orientation frame [-Forward, Up, Right] into quaternion
    rot_matrix = np.column_stack([right, cam_up, -forward])
    quat_xyzw = R.from_matrix(rot_matrix).as_quat() # [x, y, z, w]
    
    # Convert to [w, x, y, z] to match DEFAULT_CAMERA_QUATERNION
    quat_wxyz = [float(quat_xyzw[3]), float(quat_xyzw[0]), float(quat_xyzw[1]), float(quat_xyzw[2])]

    return pos.tolist(), quat_wxyz


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
            optimizer_constraints.append(
                {
                    "kind": "point",
                    "t": timeline_segment["time"],
                    "position": initial_position,
                    "quaternion": initial_quaternion,
                    "losses": [
                        convert_timeline_loss_to_optimizer_loss(timeline_loss)
                        for timeline_loss in timeline_segment.get("lossFunctions", [])
                    ],
                }
            )

    return optimizer_constraints