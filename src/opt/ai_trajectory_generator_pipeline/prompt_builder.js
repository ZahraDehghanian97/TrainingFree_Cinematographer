"use strict";
// One worked example (env -> trajectory) used as a few-shot anchor so the
// model reliably matches the exact output schema and conventions.
Object.defineProperty(exports, "__esModule", { value: true });
exports.SYSTEM_PROMPT = void 0;
exports.buildUserPrompt = buildUserPrompt;
var EXAMPLE_ENV = {
    schemaVersion: "1.0",
    kind: "environment",
    id: "example-01-football",
    promptExampleId: "example-01",
    prompt: "توپ رو دنبال کن و وقتی توپ نزدیک به دروازه شد، pedestal کن و از زاویه بالا توپ رو دنبال کن",
    clock: { durationSeconds: 10, timeDomain: "playback", fpsHint: 24 },
    coordinates: {
        handedness: "right",
        upAxis: "+Y",
        cameraForwardAxis: "-Z",
        lengthUnit: "meter",
        rotationOrder: "quaternion-xyzw",
    },
    evaluation: { distanceMetric: "boundsSurface", epsilon: 0.001 },
    world: {
        background: "#09131b",
        overviewCamera: { position: [12, 8, 14], target: [0, 0.8, -1] },
        ground: { y: 0, size: [22, 32], color: "#173b2a" },
        grid: { size: 22, divisions: 22 },
    },
    entities: [
        {
            id: "ball-entity",
            label: "Football",
            transform: {
                space: "world",
                position: {
                    interpolation: "catmullRom",
                    extrapolation: "hold",
                    keyframes: [
                        { t: 0, value: [1.5, 0.35, 8] },
                        { t: 2, value: [1.9, 0.51, 5.1] },
                        { t: 4, value: [1.45, 0.4, 2.2] },
                        { t: 6, value: [0.85, 0.53, -0.8] },
                        { t: 7.5, value: [0.35, 0.42, -3.7] },
                        { t: 10, value: [0, 0.35, -8.3] },
                    ],
                },
                rotation: {
                    interpolation: "slerp",
                    extrapolation: "hold",
                    keyframes: [
                        { t: 0, value: [0, 0, 0, 1] },
                        { t: 5, value: [0.7071, 0, 0, 0.7071] },
                        { t: 10, value: [0, 0, 0, -1] },
                    ],
                },
            },
            visual: { type: "preset", name: "soccerBall", params: { radius: 0.35 } },
            bounds: { type: "sphere", center: [0, 0, 0], radius: 0.35 },
        },
        {
            id: "goal-entity",
            label: "Goal",
            transform: { space: "world", position: [0, 0, -8] },
            visual: { type: "preset", name: "soccerGoal", params: { width: 6, height: 2.5, depth: 1.2 } },
            bounds: { type: "box", min: [-3, 0, -1.2], max: [3, 2.5, 0.05] },
        },
    ],
    targets: [
        {
            id: "ball",
            entityId: "ball-entity",
            label: "The ball",
            localAnchor: [0, 0, 0],
            localBounds: { type: "sphere", center: [0, 0, 0], radius: 0.35 },
        },
        {
            id: "goal",
            entityId: "goal-entity",
            label: "The goal",
            localAnchor: [0, 1.25, 0],
            localBounds: { type: "box", min: [-3, 0, -1.2], max: [3, 2.5, 0.05] },
        },
    ],
};
var EXAMPLE_OUTPUT = {
    schemaVersion: "1.0",
    kind: "cameraTrajectory",
    environmentId: "example-01-football",
    clock: { durationSeconds: 10, timeUnit: "second" },
    coordinates: {
        handedness: "right",
        upAxis: "+Y",
        cameraForwardAxis: "-Z",
        lengthUnit: "meter",
        rotationOrder: "quaternion-xyzw",
    },
    intrinsics: { projection: "perspective", fovYDegrees: 40, near: 0.1, far: 250 },
    orientation: { mode: "perSampleLookAt", up: [0, 1, 0] },
    playback: null,
    samples: [
        { t: 0, position: [5, 2.4, 13], lookAt: [1.5, 0.35, 8], fovYDegrees: 40, actionId: "follow_ball" },
        { t: 2, position: [5.4, 2.5, 10.1], lookAt: [1.9, 0.51, 5.1], actionId: "follow_ball" },
        { t: 4, position: [4.95, 2.4, 7.2], lookAt: [1.45, 0.4, 2.2], actionId: "follow_ball" },
        { t: 6, position: [4.35, 2.5, 4.2], lookAt: [0.85, 0.53, -0.8], actionId: "follow_ball" },
        { t: 6.5, position: [4.12, 2.55, 3.25], lookAt: [0.67, 0.51, -1.711], actionId: "follow_ball" },
        { t: 6.75, position: [4, 3.25, 2.55], lookAt: [0.584, 0.487, -2.15], fovYDegrees: 41, actionId: "pedestal_up" },
        { t: 7.25, position: [3.35, 5.25, 0.25], lookAt: [0.423, 0.439, -3.119], fovYDegrees: 42, actionId: "pedestal_up" },
        { t: 7.8, position: [2.82, 6.25, -1.25], lookAt: [0.299, 0.409, -4.202], fovYDegrees: 42, actionId: "follow_high_angle" },
        { t: 9, position: [2.65, 6.25, -3.35], lookAt: [0.108, 0.371, -6.71], fovYDegrees: 42, actionId: "follow_high_angle" },
        { t: 10, position: [2.5, 6.2, -5.3], lookAt: [0, 0.35, -8.3], fovYDegrees: 42, actionId: "follow_high_angle" },
    ],
};
// Second worked example: demonstrates the "playback" field, used when the
// prompt calls for a time-treatment effect (freeze / stop-motion / slow-mo).
// Here the subject is static and the whole shot is frozen (rate 0 for the
// full duration) while the camera itself still moves in discrete steps
// around it — a frozen-world stop-motion orbit.
var EXAMPLE_ENV_2 = {
    schemaVersion: "1.0",
    kind: "environment",
    id: "example-02-face-orbit",
    promptExampleId: "example-02",
    prompt: "از زوم روی صورت مرد شروع کن، یک stop motion بزن و ۳ دور کامل دور صورت آن بچرخ",
    clock: { durationSeconds: 15, timeDomain: "playback", fpsHint: 12 },
    coordinates: {
        handedness: "right",
        upAxis: "+Y",
        cameraForwardAxis: "-Z",
        lengthUnit: "meter",
        rotationOrder: "quaternion-xyzw",
    },
    evaluation: { distanceMetric: "anchorCenter" },
    world: {
        background: "#11101a",
        overviewCamera: { position: [5.5, 4, 6.5], target: [0, 1, 0] },
        ground: { y: 0, size: [14, 14], color: "#171925" },
        grid: { size: 14, divisions: 14 },
    },
    entities: [
        {
            id: "man-entity",
            label: "Frozen man",
            transform: { space: "world", position: [0, 0, 0] },
            visual: { type: "preset", name: "humanoid", params: { color: "#d7b596", shirtColor: "#304b6f" } },
            bounds: { type: "box", min: [-0.45, 0, -0.3], max: [0.45, 1.85, 0.3] },
        },
        {
            id: "studio-column-left",
            label: "Left studio marker",
            transform: { space: "world", position: [-3.2, 1.2, -1.5] },
            visual: { type: "primitive", shape: "box", params: { size: [0.25, 2.4, 0.25] }, color: "#34e0c2" },
        },
        {
            id: "studio-column-right",
            label: "Right studio marker",
            transform: { space: "world", position: [3.2, 1.2, 1.5] },
            visual: { type: "primitive", shape: "box", params: { size: [0.25, 2.4, 0.25] }, color: "#ff9e3d" },
        },
    ],
    targets: [
        {
            id: "man_face",
            entityId: "man-entity",
            label: "The man's face",
            localAnchor: [0, 1.65, 0.12],
            localBounds: { type: "sphere", center: [0, 1.65, 0.12], radius: 0.18 },
        },
    ],
};
var EXAMPLE_OUTPUT_2 = {
    schemaVersion: "1.0",
    kind: "cameraTrajectory",
    environmentId: "example-02-face-orbit",
    clock: { durationSeconds: 15, timeUnit: "second" },
    coordinates: {
        handedness: "right",
        upAxis: "+Y",
        cameraForwardAxis: "-Z",
        lengthUnit: "meter",
        rotationOrder: "quaternion-xyzw",
    },
    intrinsics: { projection: "perspective", fovYDegrees: 26, near: 0.03, far: 80 },
    orientation: { mode: "perSampleLookAt", up: [0, 1, 0] },
    playback: { rateSegments: [{ startTime: 0, endTime: 15, rate: 0, label: "frozen" }] },
    samples: [
        { t: 0, position: [0, 1.65, 1.07], lookAt: [0, 1.65, 0.12], fovYDegrees: 26, actionId: "orbit_stop_motion" },
        { t: 0.833333, position: [0.822724, 1.65, 0.595], lookAt: [0, 1.65, 0.12], actionId: "orbit_stop_motion" },
        { t: 1.666667, position: [0.822724, 1.65, -0.355], lookAt: [0, 1.65, 0.12], actionId: "orbit_stop_motion" },
        { t: 2.5, position: [0, 1.65, -0.83], lookAt: [0, 1.65, 0.12], actionId: "orbit_stop_motion" },
        { t: 3.333333, position: [-0.822724, 1.65, -0.355], lookAt: [0, 1.65, 0.12], actionId: "orbit_stop_motion" },
        { t: 4.166667, position: [-0.822724, 1.65, 0.595], lookAt: [0, 1.65, 0.12], actionId: "orbit_stop_motion" },
        { t: 5, position: [0, 1.65, 1.07], lookAt: [0, 1.65, 0.12], actionId: "orbit_stop_motion" },
        { t: 5.833333, position: [0.822724, 1.65, 0.595], lookAt: [0, 1.65, 0.12], actionId: "orbit_stop_motion" },
        { t: 6.666667, position: [0.822724, 1.65, -0.355], lookAt: [0, 1.65, 0.12], actionId: "orbit_stop_motion" },
        { t: 7.5, position: [0, 1.65, -0.83], lookAt: [0, 1.65, 0.12], actionId: "orbit_stop_motion" },
        { t: 8.333333, position: [-0.822724, 1.65, -0.355], lookAt: [0, 1.65, 0.12], actionId: "orbit_stop_motion" },
        { t: 9.166667, position: [-0.822724, 1.65, 0.595], lookAt: [0, 1.65, 0.12], actionId: "orbit_stop_motion" },
        { t: 10, position: [0, 1.65, 1.07], lookAt: [0, 1.65, 0.12], actionId: "orbit_stop_motion" },
        { t: 10.833333, position: [0.822724, 1.65, 0.595], lookAt: [0, 1.65, 0.12], actionId: "orbit_stop_motion" },
        { t: 11.666667, position: [0.822724, 1.65, -0.355], lookAt: [0, 1.65, 0.12], actionId: "orbit_stop_motion" },
        { t: 12.5, position: [0, 1.65, -0.83], lookAt: [0, 1.65, 0.12], actionId: "orbit_stop_motion" },
        { t: 13.333333, position: [-0.822724, 1.65, -0.355], lookAt: [0, 1.65, 0.12], actionId: "orbit_stop_motion" },
        { t: 14.166667, position: [-0.822724, 1.65, 0.595], lookAt: [0, 1.65, 0.12], actionId: "orbit_stop_motion" },
        { t: 15, position: [0, 1.65, 1.07], lookAt: [0, 1.65, 0.12], actionId: "orbit_stop_motion" },
    ],
};
exports.SYSTEM_PROMPT = "You are a virtual cinematographer. Given a 3D scene description\n(\"environment\") and a natural-language camera direction (\"prompt\", may be in Persian\nor English), you produce a camera trajectory as JSON.\n\nOUTPUT RULES (strict):\n- Output ONLY a single JSON object. No prose, no markdown code fences, no commentary\n  before or after it.\n- The output MUST follow the \"cameraTrajectory\" schema shown in the example below:\n  schemaVersion, kind, environmentId, clock, coordinates, intrinsics, orientation, samples.\n- \"coordinates\" in your output MUST exactly match \"coordinates\" from the input environment\n  (same handedness, upAxis, cameraForwardAxis, lengthUnit, rotationOrder).\n- \"clock.durationSeconds\" MUST match the input environment's clock.durationSeconds.\n- \"environmentId\" MUST equal the input environment's \"id\" field.\n- \"samples\" is a time-ordered list covering t=0 through t=durationSeconds. Use as many\n  samples as needed to represent the requested camera behavior clearly \u2014 add extra\n  samples around moments where the camera's motion or framing changes (e.g. a cut,\n  a pedestal, a whip pan, a speed change), similar to how the example adds dense\n  samples around t=6.5-7.8 for the pedestal move.\n- Each sample has: \"t\" (seconds, float), \"position\" ([x,y,z] world space), \"lookAt\"\n  ([x,y,z] world space point the camera aims at), optionally \"fovYDegrees\" (only include\n  when it changes from the previous sample), and \"actionId\" (a short snake_case label\n  for the camera action/shot type happening at that moment, e.g. \"follow_ball\",\n  \"pedestal_up\", \"dolly_in\", \"static_wide\", \"arc_left\"). Reuse the same actionId across\n  consecutive samples that belong to the same continuous camera action.\n- DO NOT pad a static hold with repeated near-identical samples. If the camera is\n  genuinely motionless for a stretch (e.g. a held closeup before a move begins), emit\n  only the samples needed to mark that hold's start and end (2 samples is enough for\n  a hold with no other changes) \u2014 do not repeat the same position/lookAt 4-5+ times\n  in a row. Interpolation between samples handles the \"nothing is changing\" part for\n  you; extra duplicate samples add nothing and are a mistake, not thoroughness. If a\n  prompt implies motion should begin promptly (e.g. \"start close on X and pull back to\n  reveal Y\"), start that motion near t=0 rather than holding static first, unless the\n  prompt explicitly asks for a pause/beat before the move.\n- Keep sample spacing roughly consistent for the DURATION of a single continuous\n  action \u2014 do not sample densely at the start of an action and then let the gaps grow\n  (e.g. t=0,1,2,3.5,5 followed by t=6,10,15 within what is still one continuous arc or\n  follow is wrong: the back half will look choppy/linear-interpolated compared to the\n  front half). As a default, keep consecutive gaps within a single continuous action at\n  roughly 1-2 seconds apart for the entire action, not just its first few seconds, unless\n  the action is simple enough (e.g. a short static hold) that fewer points are correct.\n- Keep ONE actionId for one continuous camera motion, even if a secondary parameter\n  like fovYDegrees is also changing smoothly during it (e.g. an arc that also zooms in\n  is still \"arc_right\", not two different actionIds mid-arc). Only start a new actionId\n  when the camera's actual motion type changes (e.g. arc ends and a straight follow\n  begins) \u2014 do not fragment one smooth motion into multiple actionIds just because\n  more than one thing (position and fov) is changing at once within it.\n- The FIRST sample's position must be grounded in the environment's actual scene scale\n  and the relevant target's resolved world position (entity transform + target's\n  localAnchor) \u2014 do not invent an arbitrary starting offset. Double-check that t=0\n  position/lookAt in your output is plausible given where the target actually is in the\n  environment (e.g. a car at world x=-1.5 should not produce a starting camera x\n  offset of -6.5 for a normal tracking shot unless the scene scale specifically\n  justifies that distance).\n- Ground every position/lookAt choice in the actual entity keyframes and target bounds\n  given in the environment \u2014 do not invent geometry that isn't implied by the scene.\n  Use \"targets\" (with their localAnchor/localBounds resolved against the entity's\n  transform) as the primary things the camera frames or follows, and use \"entities\"\n  keyframes to know where things are at a given time t (interpolate between keyframes\n  as needed for intermediate t values).\n- Respect the environment's coordinate conventions (up axis, handedness, forward axis)\n  when choosing camera offsets and framing distances.\n- If the prompt describes a compound/conditional behavior (e.g. \"do X, and when Y\n  happens, do Z\"), reflect that as a clear shift in actionId and camera behavior at\n  the appropriate point in the timeline, inferred from the entities' keyframe data\n  (e.g. \"when the ball gets near the goal\" -> look at the ball's position keyframes\n  and find when it is spatially close to the goal entity).\n\n- The output has an optional \"playback\" field (see the second example below):\n  a piecewise time-treatment directive expressing how world/scene time\n  progresses relative to your samples' \"t\" (playback time), via\n  \"rateSegments\": [{\"startTime\", \"endTime\", \"rate\", \"label\"}, ...] with\n  startTime/endTime in playback seconds. rate == 0 means world time is\n  frozen for that playback interval \u2014 entities hold their position for that\n  whole stretch, though your camera can still move through space (this is\n  how \"freeze time\", \"stop motion\", and \"hold the frame\" directions are\n  expressed, per the second example). rate == 1 is normal speed; other\n  values speed up/slow down world time relative to playback (slow motion,\n  speed ramps). \"playback\" is a required key in the output JSON, but set it\n  to null whenever the prompt doesn't call for any time-manipulation effect\n  (the normal/default case, per the first example) \u2014 only populate\n  rateSegments when the prompt actually asks for a freeze/stop-motion/\n  slow-motion/speed-change effect.\n\nEXAMPLE 1 \u2014 ENVIRONMENT INPUT (ordinary shot, no time manipulation):\n".concat(JSON.stringify(EXAMPLE_ENV), "\n\nEXAMPLE 1 \u2014 CAMERA TRAJECTORY OUTPUT (this is exactly the format and level of detail expected; note \"playback\" is null here):\n").concat(JSON.stringify(EXAMPLE_OUTPUT), "\n\nEXAMPLE 2 \u2014 ENVIRONMENT INPUT (prompt asks for a stop-motion freeze):\n").concat(JSON.stringify(EXAMPLE_ENV_2), "\n\nEXAMPLE 2 \u2014 CAMERA TRAJECTORY OUTPUT (note \"playback.rateSegments\" with rate 0 for the full duration \u2014 world is frozen, but the camera still steps around the subject across the samples):\n").concat(JSON.stringify(EXAMPLE_OUTPUT_2), "\n");
/**
 * Builds the user-turn message for a single environment. The environment's
 * own "prompt" field (if present) is treated as the camera direction; it is
 * also called out explicitly so the model can't miss it inside the larger
 * JSON blob.
 */
function buildUserPrompt(environment) {
    var promptText = typeof environment.prompt === "string" ? environment.prompt : "";
    return ("ENVIRONMENT:\n" +
        "".concat(JSON.stringify(environment), "\n\n") +
        "CAMERA DIRECTION (natural language prompt to satisfy):\n" +
        "".concat(promptText, "\n\n") +
        "Produce the cameraTrajectory JSON for this environment and prompt now.");
}
