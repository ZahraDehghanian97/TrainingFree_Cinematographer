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


def convert_loss(loss):
    typ = LOSS_TYPE_MAP.get(loss["type"], loss["type"])

    out = {"type": typ}

    params = deepcopy(loss.get("parameters", {}))

    if "rotationAngle" in params:
        params["angleDeg"] = params.pop("rotationAngle")

    if "arcAngle" in params:
        params["angleDeg"] = params.pop("arcAngle")

    if "arcRadius" in params:
        params["radius"] = params.pop("arcRadius")

    if "view" not in params and "subjectView" in params:
        params["view"] = params.pop("subjectView")

    #
    # Temporary assumption:
    # Every subject-aware loss refers to subject C0.
    #
    if typ in SUBJECT_AWARE_LOSSES:
        params.setdefault("subjectId", DEFAULT_SUBJECT_ID)

    out.update(params)

    return out


def build_constraints_from_timeline(flattened):

    constraints = []

    #
    # Temporary default starting pose.
    #
    constraints.append({
        "kind": "point",
        "t": 0,
        "position": DEFAULT_CAMERA_POSITION,
        "quaternion": DEFAULT_CAMERA_QUATERNION,
        "losses": [],
    })

    for seg in flattened["timeline"]:

        if seg["kind"] == "interval":

            constraints.append({
                "kind": "interval",
                "t0": seg["startTime"],
                "t1": seg["endTime"],
                "losses": [
                    convert_loss(loss)
                    for loss in seg["lossFunctions"]
                ],
            })

        elif seg["kind"] == "point":

            constraints.append({
                "kind": "point",
                "t": seg["time"],

                #
                # Temporary default pose.
                # Later this will come from the DSL.
                #
                "position": DEFAULT_CAMERA_POSITION,
                "quaternion": DEFAULT_CAMERA_QUATERNION,

                "losses": [
                    convert_loss(loss)
                    for loss in seg["lossFunctions"]
                ],
            })

    return constraints