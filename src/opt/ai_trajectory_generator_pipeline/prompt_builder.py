import json

# One worked example (env -> trajectory) used as a few-shot anchor so the
# model reliably matches the exact output schema and conventions.

_EXAMPLE_ENV = {
    "schemaVersion": "1.0",
    "kind": "environment",
    "id": "example-01-football",
    "promptExampleId": "example-01",
    "prompt": "توپ رو دنبال کن و وقتی توپ نزدیک به دروازه شد، pedestal کن و از زاویه بالا توپ رو دنبال کن",
    "clock": {"durationSeconds": 10, "timeDomain": "playback", "fpsHint": 24},
    "coordinates": {
        "handedness": "right",
        "upAxis": "+Y",
        "cameraForwardAxis": "-Z",
        "lengthUnit": "meter",
        "rotationOrder": "quaternion-xyzw",
    },
    "evaluation": {"distanceMetric": "boundsSurface", "epsilon": 0.001},
    "world": {
        "background": "#09131b",
        "overviewCamera": {"position": [12, 8, 14], "target": [0, 0.8, -1]},
        "ground": {"y": 0, "size": [22, 32], "color": "#173b2a"},
        "grid": {"size": 22, "divisions": 22},
    },
    "entities": [
        {
            "id": "ball-entity",
            "label": "Football",
            "transform": {
                "space": "world",
                "position": {
                    "interpolation": "catmullRom",
                    "extrapolation": "hold",
                    "keyframes": [
                        {"t": 0, "value": [1.5, 0.35, 8]},
                        {"t": 2, "value": [1.9, 0.51, 5.1]},
                        {"t": 4, "value": [1.45, 0.4, 2.2]},
                        {"t": 6, "value": [0.85, 0.53, -0.8]},
                        {"t": 7.5, "value": [0.35, 0.42, -3.7]},
                        {"t": 10, "value": [0, 0.35, -8.3]},
                    ],
                },
                "rotation": {
                    "interpolation": "slerp",
                    "extrapolation": "hold",
                    "keyframes": [
                        {"t": 0, "value": [0, 0, 0, 1]},
                        {"t": 5, "value": [0.7071, 0, 0, 0.7071]},
                        {"t": 10, "value": [0, 0, 0, -1]},
                    ],
                },
            },
            "visual": {"type": "preset", "name": "soccerBall", "params": {"radius": 0.35}},
            "bounds": {"type": "sphere", "center": [0, 0, 0], "radius": 0.35},
        },
        {
            "id": "goal-entity",
            "label": "Goal",
            "transform": {"space": "world", "position": [0, 0, -8]},
            "visual": {"type": "preset", "name": "soccerGoal", "params": {"width": 6, "height": 2.5, "depth": 1.2}},
            "bounds": {"type": "box", "min": [-3, 0, -1.2], "max": [3, 2.5, 0.05]},
        },
    ],
    "targets": [
        {
            "id": "ball",
            "entityId": "ball-entity",
            "label": "The ball",
            "localAnchor": [0, 0, 0],
            "localBounds": {"type": "sphere", "center": [0, 0, 0], "radius": 0.35},
        },
        {
            "id": "goal",
            "entityId": "goal-entity",
            "label": "The goal",
            "localAnchor": [0, 1.25, 0],
            "localBounds": {"type": "box", "min": [-3, 0, -1.2], "max": [3, 2.5, 0.05]},
        },
    ],
}

_EXAMPLE_OUTPUT = {
    "schemaVersion": "1.0",
    "kind": "cameraTrajectory",
    "environmentId": "example-01-football",
    "clock": {"durationSeconds": 10, "timeUnit": "second"},
    "coordinates": {
        "handedness": "right",
        "upAxis": "+Y",
        "cameraForwardAxis": "-Z",
        "lengthUnit": "meter",
        "rotationOrder": "quaternion-xyzw",
    },
    "intrinsics": {"projection": "perspective", "fovYDegrees": 40, "near": 0.1, "far": 250},
    "orientation": {"mode": "perSampleLookAt", "up": [0, 1, 0]},
    "playback": None,
    "samples": [
        {"t": 0, "position": [5, 2.4, 13], "lookAt": [1.5, 0.35, 8], "fovYDegrees": 40, "actionId": "follow_ball"},
        {"t": 2, "position": [5.4, 2.5, 10.1], "lookAt": [1.9, 0.51, 5.1], "actionId": "follow_ball"},
        {"t": 4, "position": [4.95, 2.4, 7.2], "lookAt": [1.45, 0.4, 2.2], "actionId": "follow_ball"},
        {"t": 6, "position": [4.35, 2.5, 4.2], "lookAt": [0.85, 0.53, -0.8], "actionId": "follow_ball"},
        {"t": 6.5, "position": [4.12, 2.55, 3.25], "lookAt": [0.67, 0.51, -1.711], "actionId": "follow_ball"},
        {"t": 6.75, "position": [4, 3.25, 2.55], "lookAt": [0.584, 0.487, -2.15], "fovYDegrees": 41, "actionId": "pedestal_up"},
        {"t": 7.25, "position": [3.35, 5.25, 0.25], "lookAt": [0.423, 0.439, -3.119], "fovYDegrees": 42, "actionId": "pedestal_up"},
        {"t": 7.8, "position": [2.82, 6.25, -1.25], "lookAt": [0.299, 0.409, -4.202], "fovYDegrees": 42, "actionId": "follow_high_angle"},
        {"t": 9, "position": [2.65, 6.25, -3.35], "lookAt": [0.108, 0.371, -6.71], "fovYDegrees": 42, "actionId": "follow_high_angle"},
        {"t": 10, "position": [2.5, 6.2, -5.3], "lookAt": [0, 0.35, -8.3], "fovYDegrees": 42, "actionId": "follow_high_angle"},
    ],
}

# Second worked example: demonstrates the "playback" field, used when the
# prompt calls for a time-treatment effect (freeze / stop-motion / slow-mo).
# Here the subject is static and the whole shot is frozen (rate 0 for the
# full duration) while the camera itself still moves in discrete steps
# around it — a frozen-world stop-motion orbit.

_EXAMPLE_ENV_2 = {
    "schemaVersion": "1.0",
    "kind": "environment",
    "id": "example-02-face-orbit",
    "promptExampleId": "example-02",
    "prompt": "از زوم روی صورت مرد شروع کن، یک stop motion بزن و ۳ دور کامل دور صورت آن بچرخ",
    "clock": {"durationSeconds": 15, "timeDomain": "playback", "fpsHint": 12},
    "coordinates": {
        "handedness": "right",
        "upAxis": "+Y",
        "cameraForwardAxis": "-Z",
        "lengthUnit": "meter",
        "rotationOrder": "quaternion-xyzw",
    },
    "evaluation": {"distanceMetric": "anchorCenter"},
    "world": {
        "background": "#11101a",
        "overviewCamera": {"position": [5.5, 4, 6.5], "target": [0, 1, 0]},
        "ground": {"y": 0, "size": [14, 14], "color": "#171925"},
        "grid": {"size": 14, "divisions": 14},
    },
    "entities": [
        {
            "id": "man-entity",
            "label": "Frozen man",
            "transform": {"space": "world", "position": [0, 0, 0]},
            "visual": {"type": "preset", "name": "humanoid", "params": {"color": "#d7b596", "shirtColor": "#304b6f"}},
            "bounds": {"type": "box", "min": [-0.45, 0, -0.3], "max": [0.45, 1.85, 0.3]},
        },
        {
            "id": "studio-column-left",
            "label": "Left studio marker",
            "transform": {"space": "world", "position": [-3.2, 1.2, -1.5]},
            "visual": {"type": "primitive", "shape": "box", "params": {"size": [0.25, 2.4, 0.25]}, "color": "#34e0c2"},
        },
        {
            "id": "studio-column-right",
            "label": "Right studio marker",
            "transform": {"space": "world", "position": [3.2, 1.2, 1.5]},
            "visual": {"type": "primitive", "shape": "box", "params": {"size": [0.25, 2.4, 0.25]}, "color": "#ff9e3d"},
        },
    ],
    "targets": [
        {
            "id": "man_face",
            "entityId": "man-entity",
            "label": "The man's face",
            "localAnchor": [0, 1.65, 0.12],
            "localBounds": {"type": "sphere", "center": [0, 1.65, 0.12], "radius": 0.18},
        }
    ],
}

_EXAMPLE_OUTPUT_2 = {
    "schemaVersion": "1.0",
    "kind": "cameraTrajectory",
    "environmentId": "example-02-face-orbit",
    "clock": {"durationSeconds": 15, "timeUnit": "second"},
    "coordinates": {
        "handedness": "right",
        "upAxis": "+Y",
        "cameraForwardAxis": "-Z",
        "lengthUnit": "meter",
        "rotationOrder": "quaternion-xyzw",
    },
    "intrinsics": {"projection": "perspective", "fovYDegrees": 26, "near": 0.03, "far": 80},
    "orientation": {"mode": "perSampleLookAt", "up": [0, 1, 0]},
    "playback": {"rateSegments": [{"startTime": 0, "endTime": 15, "rate": 0, "label": "frozen"}]},
    "samples": [
        {"t": 0, "position": [0, 1.65, 1.07], "lookAt": [0, 1.65, 0.12], "fovYDegrees": 26, "actionId": "orbit_stop_motion"},
        {"t": 0.833333, "position": [0.822724, 1.65, 0.595], "lookAt": [0, 1.65, 0.12], "actionId": "orbit_stop_motion"},
        {"t": 1.666667, "position": [0.822724, 1.65, -0.355], "lookAt": [0, 1.65, 0.12], "actionId": "orbit_stop_motion"},
        {"t": 2.5, "position": [0, 1.65, -0.83], "lookAt": [0, 1.65, 0.12], "actionId": "orbit_stop_motion"},
        {"t": 3.333333, "position": [-0.822724, 1.65, -0.355], "lookAt": [0, 1.65, 0.12], "actionId": "orbit_stop_motion"},
        {"t": 4.166667, "position": [-0.822724, 1.65, 0.595], "lookAt": [0, 1.65, 0.12], "actionId": "orbit_stop_motion"},
        {"t": 5, "position": [0, 1.65, 1.07], "lookAt": [0, 1.65, 0.12], "actionId": "orbit_stop_motion"},
        {"t": 5.833333, "position": [0.822724, 1.65, 0.595], "lookAt": [0, 1.65, 0.12], "actionId": "orbit_stop_motion"},
        {"t": 6.666667, "position": [0.822724, 1.65, -0.355], "lookAt": [0, 1.65, 0.12], "actionId": "orbit_stop_motion"},
        {"t": 7.5, "position": [0, 1.65, -0.83], "lookAt": [0, 1.65, 0.12], "actionId": "orbit_stop_motion"},
        {"t": 8.333333, "position": [-0.822724, 1.65, -0.355], "lookAt": [0, 1.65, 0.12], "actionId": "orbit_stop_motion"},
        {"t": 9.166667, "position": [-0.822724, 1.65, 0.595], "lookAt": [0, 1.65, 0.12], "actionId": "orbit_stop_motion"},
        {"t": 10, "position": [0, 1.65, 1.07], "lookAt": [0, 1.65, 0.12], "actionId": "orbit_stop_motion"},
        {"t": 10.833333, "position": [0.822724, 1.65, 0.595], "lookAt": [0, 1.65, 0.12], "actionId": "orbit_stop_motion"},
        {"t": 11.666667, "position": [0.822724, 1.65, -0.355], "lookAt": [0, 1.65, 0.12], "actionId": "orbit_stop_motion"},
        {"t": 12.5, "position": [0, 1.65, -0.83], "lookAt": [0, 1.65, 0.12], "actionId": "orbit_stop_motion"},
        {"t": 13.333333, "position": [-0.822724, 1.65, -0.355], "lookAt": [0, 1.65, 0.12], "actionId": "orbit_stop_motion"},
        {"t": 14.166667, "position": [-0.822724, 1.65, 0.595], "lookAt": [0, 1.65, 0.12], "actionId": "orbit_stop_motion"},
        {"t": 15, "position": [0, 1.65, 1.07], "lookAt": [0, 1.65, 0.12], "actionId": "orbit_stop_motion"},
    ],
}


SYSTEM_PROMPT = f"""You are a virtual cinematographer. Given a 3D scene description
("environment") and a natural-language camera direction ("prompt", may be in Persian
or English), you produce a camera trajectory as JSON.

OUTPUT RULES (strict):
- Output ONLY a single JSON object. No prose, no markdown code fences, no commentary
  before or after it.
- The output MUST follow the "cameraTrajectory" schema shown in the example below:
  schemaVersion, kind, environmentId, clock, coordinates, intrinsics, orientation, samples.
- "coordinates" in your output MUST exactly match "coordinates" from the input environment
  (same handedness, upAxis, cameraForwardAxis, lengthUnit, rotationOrder).
- "clock.durationSeconds" MUST match the input environment's clock.durationSeconds.
- "environmentId" MUST equal the input environment's "id" field.
- "samples" is a time-ordered list covering t=0 through t=durationSeconds. Use as many
  samples as needed to represent the requested camera behavior clearly — add extra
  samples around moments where the camera's motion or framing changes (e.g. a cut,
  a pedestal, a whip pan, a speed change), similar to how the example adds dense
  samples around t=6.5-7.8 for the pedestal move.
- Each sample has: "t" (seconds, float), "position" ([x,y,z] world space), "lookAt"
  ([x,y,z] world space point the camera aims at), optionally "fovYDegrees" (only include
  when it changes from the previous sample), and "actionId" (a short snake_case label
  for the camera action/shot type happening at that moment, e.g. "follow_ball",
  "pedestal_up", "dolly_in", "static_wide", "arc_left"). Reuse the same actionId across
  consecutive samples that belong to the same continuous camera action.
- Ground every position/lookAt choice in the actual entity keyframes and target bounds
  given in the environment — do not invent geometry that isn't implied by the scene.
  Use "targets" (with their localAnchor/localBounds resolved against the entity's
  transform) as the primary things the camera frames or follows, and use "entities"
  keyframes to know where things are at a given time t (interpolate between keyframes
  as needed for intermediate t values).
- Respect the environment's coordinate conventions (up axis, handedness, forward axis)
  when choosing camera offsets and framing distances.
- If the prompt describes a compound/conditional behavior (e.g. "do X, and when Y
  happens, do Z"), reflect that as a clear shift in actionId and camera behavior at
  the appropriate point in the timeline, inferred from the entities' keyframe data
  (e.g. "when the ball gets near the goal" -> look at the ball's position keyframes
  and find when it is spatially close to the goal entity).

- The output has an optional "playback" field (see the second example below):
  a piecewise time-treatment directive expressing how world/scene time
  progresses relative to your samples' "t" (playback time), via
  "rateSegments": [{{"startTime", "endTime", "rate", "label"}}, ...] with
  startTime/endTime in playback seconds. rate == 0 means world time is
  frozen for that playback interval — entities hold their position for that
  whole stretch, though your camera can still move through space (this is
  how "freeze time", "stop motion", and "hold the frame" directions are
  expressed, per the second example). rate == 1 is normal speed; other
  values speed up/slow down world time relative to playback (slow motion,
  speed ramps). "playback" is a required key in the output JSON, but set it
  to 1 whenever the prompt doesn't call for any time-manipulation effect
  (the normal/default case, per the first example) — only populate
  rateSegments when the prompt actually asks for a freeze/stop-motion/
  slow-motion/speed-change effect.

EXAMPLE 1 — ENVIRONMENT INPUT (ordinary shot, no time manipulation):
{json.dumps(_EXAMPLE_ENV, ensure_ascii=False)}

EXAMPLE 1 — CAMERA TRAJECTORY OUTPUT (this is exactly the format and level of detail expected; note "playback" is null here):
{json.dumps(_EXAMPLE_OUTPUT, ensure_ascii=False)}

EXAMPLE 2 — ENVIRONMENT INPUT (prompt asks for a stop-motion freeze):
{json.dumps(_EXAMPLE_ENV_2, ensure_ascii=False)}

EXAMPLE 2 — CAMERA TRAJECTORY OUTPUT (note "playback.rateSegments" with rate 0 for the full duration — world is frozen, but the camera still steps around the subject across the samples):
{json.dumps(_EXAMPLE_OUTPUT_2, ensure_ascii=False)}
"""


def build_user_prompt(environment: dict) -> str:
    """
    Builds the user-turn message for a single environment. The environment's
    own "prompt" field (if present) is treated as the camera direction; it is
    also called out explicitly so the model can't miss it inside the larger
    JSON blob.
    """
    prompt_text = environment.get("prompt", "")
    return (
        "ENVIRONMENT:\n"
        f"{json.dumps(environment, ensure_ascii=False)}\n\n"
        "CAMERA DIRECTION (natural language prompt to satisfy):\n"
        f"{prompt_text}\n\n"
        "Produce the cameraTrajectory JSON for this environment and prompt now."
    )
