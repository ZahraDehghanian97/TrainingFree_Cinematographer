"use strict";
/**
 * Typed models for the two JSON schemas this pipeline deals with:
 *
 * - Environment: the input scene description. All fields observed across the
 *   example environments (clock, coordinates, world, entities, targets,
 *   evaluation) are typed, including the static-vs-keyframe-animated
 *   transform variant and the box-vs-sphere bounds variant. `.passthrough()`
 *   is kept everywhere as a safety net for fields not yet seen.
 * - CameraTrajectory: the output schema. This one is strict (`.strict()`,
 *   no extra fields, every field explicitly required-or-nullable) because
 *   it doubles as the JSON Schema sent to OpenRouter's structured-output
 *   mode — the shape here IS the contract the LLM is constrained to.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CameraTrajectorySchema = exports.SampleSchema = exports.TrajectoryPlaybackSchema = exports.TrajectoryRateSegmentSchema = exports.OrientationSchema = exports.IntrinsicsSchema = exports.TrajectoryCoordinatesSchema = exports.TrajectoryClockSchema = exports.EnvironmentSchema = exports.TargetSchema = exports.EntitySchema = exports.BoundsSchema = exports.VisualSchema = exports.TransformSchema = exports.PositionOrCurveSchema = exports.KeyframeCurveSchema = exports.KeyframeSchema = exports.WorldSchema = exports.OverviewCameraSchema = exports.EvaluationSchema = exports.CoordinatesSchema = exports.ClockSchema = void 0;
exports.cameraTrajectoryResponseFormat = cameraTrajectoryResponseFormat;
var zod_1 = require("zod");
var zod_to_json_schema_1 = require("zod-to-json-schema");
// ---------------------------------------------------------------------------
// Environment (input) — permissive typing on nested scene content.
// ---------------------------------------------------------------------------
exports.ClockSchema = zod_1.z
    .object({
    durationSeconds: zod_1.z.number(),
    timeDomain: zod_1.z.string().optional(),
    fpsHint: zod_1.z.number().optional(),
})
    .passthrough();
exports.CoordinatesSchema = zod_1.z
    .object({
    handedness: zod_1.z.string(),
    upAxis: zod_1.z.string(),
    cameraForwardAxis: zod_1.z.string(),
    lengthUnit: zod_1.z.string(),
    rotationOrder: zod_1.z.string(),
})
    .passthrough();
exports.EvaluationSchema = zod_1.z
    .object({
    distanceMetric: zod_1.z.string().optional(),
    epsilon: zod_1.z.number().optional(),
})
    .passthrough();
exports.OverviewCameraSchema = zod_1.z
    .object({
    position: zod_1.z.array(zod_1.z.number()),
    target: zod_1.z.array(zod_1.z.number()),
})
    .passthrough();
exports.WorldSchema = zod_1.z
    .object({
    background: zod_1.z.string().optional(),
    overviewCamera: exports.OverviewCameraSchema.optional(),
    // ground/grid key sets aren't load-bearing for the pipeline's own logic
    // (they're rendering-only), so keep them as loose records rather than
    // fully modeling every key.
    ground: zod_1.z.record(zod_1.z.any()).optional(),
    grid: zod_1.z.record(zod_1.z.any()).optional(),
})
    .passthrough();
exports.KeyframeSchema = zod_1.z
    .object({
    t: zod_1.z.number(),
    value: zod_1.z.array(zod_1.z.number()),
})
    .passthrough();
exports.KeyframeCurveSchema = zod_1.z
    .object({
    interpolation: zod_1.z.string(),
    extrapolation: zod_1.z.string(),
    keyframes: zod_1.z.array(exports.KeyframeSchema),
})
    .passthrough();
// An entity's position/rotation is either a fixed value ([x,y,z] or
// [x,y,z,w]) or an animated curve with its own keyframes.
exports.PositionOrCurveSchema = zod_1.z.union([zod_1.z.array(zod_1.z.number()), exports.KeyframeCurveSchema]);
exports.TransformSchema = zod_1.z
    .object({
    space: zod_1.z.string(),
    position: exports.PositionOrCurveSchema,
    rotation: exports.PositionOrCurveSchema.optional(),
})
    .passthrough();
exports.VisualSchema = zod_1.z
    .object({
    type: zod_1.z.string(),
    name: zod_1.z.string().optional(), // for type === "preset"
    shape: zod_1.z.string().optional(), // for type === "primitive"
    params: zod_1.z.record(zod_1.z.any()).default({}),
    color: zod_1.z.string().optional(),
})
    .passthrough();
exports.BoundsSchema = zod_1.z
    .object({
    type: zod_1.z.string(),
    // box variant
    min: zod_1.z.array(zod_1.z.number()).optional(),
    max: zod_1.z.array(zod_1.z.number()).optional(),
    // sphere variant
    center: zod_1.z.array(zod_1.z.number()).optional(),
    radius: zod_1.z.number().optional(),
})
    .passthrough();
exports.EntitySchema = zod_1.z
    .object({
    id: zod_1.z.string(),
    label: zod_1.z.string().optional(),
    transform: exports.TransformSchema,
    visual: exports.VisualSchema.optional(),
    bounds: exports.BoundsSchema.optional(),
})
    .passthrough();
exports.TargetSchema = zod_1.z
    .object({
    id: zod_1.z.string(),
    entityId: zod_1.z.string(),
    label: zod_1.z.string().optional(),
    localAnchor: zod_1.z.array(zod_1.z.number()),
    localBounds: exports.BoundsSchema.optional(),
})
    .passthrough();
/**
 * Fully typed for every field observed across the example environments so
 * far (clock, coordinates, world, entities, targets, evaluation).
 * `.passthrough()` is kept at every level as a safety net for fields not
 * yet seen in an example, so a genuinely new/unexpected key doesn't break
 * parsing — it'll just ride along untyped rather than being rejected. The
 * full original JSON (not this schema's parsed output) is still what gets
 * sent to the LLM, so even an untyped/unexpected field always reaches the
 * prompt (see buildUserPrompt in prompt_builder.ts).
 */
exports.EnvironmentSchema = zod_1.z
    .object({
    schemaVersion: zod_1.z.string(),
    kind: zod_1.z.literal("environment"),
    id: zod_1.z.string(),
    promptExampleId: zod_1.z.string().optional(),
    prompt: zod_1.z.string(),
    clock: exports.ClockSchema,
    coordinates: exports.CoordinatesSchema,
    evaluation: exports.EvaluationSchema.optional(),
    world: exports.WorldSchema.optional(),
    entities: zod_1.z.array(exports.EntitySchema).default([]),
    targets: zod_1.z.array(exports.TargetSchema).default([]),
})
    .passthrough();
// ---------------------------------------------------------------------------
// CameraTrajectory (output) — strict typing, doubles as the structured-
// output JSON Schema sent to OpenRouter.
// ---------------------------------------------------------------------------
exports.TrajectoryClockSchema = zod_1.z
    .object({
    durationSeconds: zod_1.z.number(),
    timeUnit: zod_1.z.literal("second"),
})
    .strict();
exports.TrajectoryCoordinatesSchema = zod_1.z
    .object({
    handedness: zod_1.z.enum(["right", "left"]),
    upAxis: zod_1.z.string(),
    cameraForwardAxis: zod_1.z.string(),
    lengthUnit: zod_1.z.string(),
    rotationOrder: zod_1.z.string(),
})
    .strict();
exports.IntrinsicsSchema = zod_1.z
    .object({
    projection: zod_1.z.literal("perspective"),
    fovYDegrees: zod_1.z.number(),
    near: zod_1.z.number(),
    far: zod_1.z.number(),
})
    .strict();
/**
 * A 3-element float vector, deliberately WITHOUT an array-length constraint
 * in the JSON Schema: Anthropic's strict structured-output validator
 * rejects `minItems`/`maxItems` values other than 0 or 1 on arrays
 * ("For 'array' type, 'minItems' values other than 0 or 1 are not
 * supported"). zodToJsonSchema would otherwise emit minItems/maxItems from
 * `.length(3)`, so the length check is done via `.refine()` instead, which
 * zod-to-json-schema does NOT translate into a schema keyword — the
 * constraint is enforced only when we parse the model's response back into
 * this type, not advertised to the API.
 */
var vec3 = zod_1.z.array(zod_1.z.number()).refine(function (v) { return v.length === 3; }, {
    message: "must contain exactly 3 values",
});
exports.OrientationSchema = zod_1.z
    .object({
    mode: zod_1.z.literal("perSampleLookAt"),
    up: vec3,
})
    .strict();
exports.TrajectoryRateSegmentSchema = zod_1.z
    .object({
    startTime: zod_1.z.number(),
    endTime: zod_1.z.number(),
    rate: zod_1.z.number(),
    label: zod_1.z.string().nullable(),
})
    .strict();
/**
 * Optional time-treatment directive for the shot: a piecewise mapping of
 * how world/scene time progresses relative to playback time. rate=0 over a
 * segment means world time is frozen for that stretch of playback time
 * (the camera can still move through space; this is how "freeze time",
 * "stop motion", and "hold the frame" directions are encoded). rate=1 is
 * normal speed; other values speed up/slow down world time relative to
 * playback (slow motion, speed ramps). Only populated when the prompt
 * actually calls for such an effect — 1 for an ordinary shot with no
 * time manipulation.
 */
exports.TrajectoryPlaybackSchema = zod_1.z
    .object({
    rateSegments: zod_1.z.array(exports.TrajectoryRateSegmentSchema),
})
    .passthrough();
exports.SampleSchema = zod_1.z
    .object({
    t: zod_1.z.number(),
    position: vec3,
    lookAt: vec3,
    // Nullable-but-required (not a Python/TS optional-with-default): strict
    // JSON Schema mode requires every key to be present in "required", so
    // these must be explicitly settable to null rather than omitted.
    fovYDegrees: zod_1.z.number().nullable(),
    actionId: zod_1.z.string().nullable(),
})
    .strict();
exports.CameraTrajectorySchema = zod_1.z
    .object({
    schemaVersion: zod_1.z.string(),
    kind: zod_1.z.literal("cameraTrajectory"),
    environmentId: zod_1.z.string(),
    clock: exports.TrajectoryClockSchema,
    coordinates: exports.TrajectoryCoordinatesSchema,
    intrinsics: exports.IntrinsicsSchema,
    orientation: exports.OrientationSchema,
    // Nullable-but-required, same reasoning as Sample's optional fields above.
    playback: exports.TrajectoryPlaybackSchema.nullable(),
    samples: zod_1.z.array(exports.SampleSchema),
})
    .strict();
/**
 * Builds the OpenRouter `response_format` payload for structured output,
 * derived directly from CameraTrajectorySchema so the schema sent to the
 * API can never drift from the schema used to parse the response.
 * `$refStrategy: "none"` forces the schema to be fully inlined (no
 * `$ref`/`definitions`), which is the safest/most broadly compatible shape
 * across OpenRouter's different upstream providers.
 */
function cameraTrajectoryResponseFormat() {
    var schema = (0, zod_to_json_schema_1.zodToJsonSchema)(exports.CameraTrajectorySchema, { $refStrategy: "none" });
    return {
        type: "json_schema",
        json_schema: {
            name: "camera_trajectory",
            strict: true,
            schema: schema,
        },
    };
}
