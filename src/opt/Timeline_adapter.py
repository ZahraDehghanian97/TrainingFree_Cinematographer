from copy import deepcopy

DEFAULT_SUBJECT_ID = "C0"

DEFAULT_CAMERA_POSITION = [0.0, 10.0, 0.0]
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

    #
    # Temporary assumption:
    # Every subject-aware loss refers to subject C0.
    #
    if optimizer_loss_type in SUBJECT_AWARE_LOSSES:
        parameters.setdefault("subjectId", DEFAULT_SUBJECT_ID)

    optimizer_loss.update(parameters)

    return optimizer_loss


def build_optimizer_constraints_from_timeline(flattened_timeline):
    """Build optimizer constraints from the flattened timeline document."""
    optimizer_constraints = []

    #
    # Temporary default starting pose.
    #
    optimizer_constraints.append(
        {
            "kind": "point",
            "t": 0,
            "position": DEFAULT_CAMERA_POSITION,
            "quaternion": DEFAULT_CAMERA_QUATERNION,
            "losses": [],
        }
    )

    for timeline_segment in flattened_timeline["timeline"]:
        if timeline_segment["kind"] == "interval":
            optimizer_constraints.append(
                {
                    "kind": "interval",
                    "t0": timeline_segment["startTime"],
                    "t1": timeline_segment["endTime"],
                    "losses": [
                        convert_timeline_loss_to_optimizer_loss(timeline_loss)
                        for timeline_loss in timeline_segment["lossFunctions"]
                    ],
                }
            )

        elif timeline_segment["kind"] == "point":
            optimizer_constraints.append(
                {
                    "kind": "point",
                    "t": timeline_segment["time"],
                    #
                    # Temporary default pose.
                    # Later this will come from the DSL.
                    #
                    "position": DEFAULT_CAMERA_POSITION,
                    "quaternion": DEFAULT_CAMERA_QUATERNION,
                    "losses": [
                        convert_timeline_loss_to_optimizer_loss(timeline_loss)
                        for timeline_loss in timeline_segment["lossFunctions"]
                    ],
                }
            )

    return optimizer_constraints
