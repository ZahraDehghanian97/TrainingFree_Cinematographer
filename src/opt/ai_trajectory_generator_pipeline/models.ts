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

import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

// ---------------------------------------------------------------------------
// Environment (input) — permissive typing on nested scene content.
// ---------------------------------------------------------------------------

export const ClockSchema = z
  .object({
    durationSeconds: z.number(),
    timeDomain: z.string().optional(),
    fpsHint: z.number().optional(),
  })
  .passthrough();

export const CoordinatesSchema = z
  .object({
    handedness: z.string(),
    upAxis: z.string(),
    cameraForwardAxis: z.string(),
    lengthUnit: z.string(),
    rotationOrder: z.string(),
  })
  .passthrough();

export const EvaluationSchema = z
  .object({
    distanceMetric: z.string().optional(),
    epsilon: z.number().optional(),
  })
  .passthrough();

export const OverviewCameraSchema = z
  .object({
    position: z.array(z.number()),
    target: z.array(z.number()),
  })
  .passthrough();

export const WorldSchema = z
  .object({
    background: z.string().optional(),
    overviewCamera: OverviewCameraSchema.optional(),
    // ground/grid key sets aren't load-bearing for the pipeline's own logic
    // (they're rendering-only), so keep them as loose records rather than
    // fully modeling every key.
    ground: z.record(z.any()).optional(),
    grid: z.record(z.any()).optional(),
  })
  .passthrough();

export const KeyframeSchema = z
  .object({
    t: z.number(),
    value: z.array(z.number()),
  })
  .passthrough();

export const KeyframeCurveSchema = z
  .object({
    interpolation: z.string(),
    extrapolation: z.string(),
    keyframes: z.array(KeyframeSchema),
  })
  .passthrough();

// An entity's position/rotation is either a fixed value ([x,y,z] or
// [x,y,z,w]) or an animated curve with its own keyframes.
export const PositionOrCurveSchema = z.union([z.array(z.number()), KeyframeCurveSchema]);

export const TransformSchema = z
  .object({
    space: z.string(),
    position: PositionOrCurveSchema,
    rotation: PositionOrCurveSchema.optional(),
  })
  .passthrough();

export const VisualSchema = z
  .object({
    type: z.string(),
    name: z.string().optional(), // for type === "preset"
    shape: z.string().optional(), // for type === "primitive"
    params: z.record(z.any()).default({}),
    color: z.string().optional(),
  })
  .passthrough();

export const BoundsSchema = z
  .object({
    type: z.string(),
    // box variant
    min: z.array(z.number()).optional(),
    max: z.array(z.number()).optional(),
    // sphere variant
    center: z.array(z.number()).optional(),
    radius: z.number().optional(),
  })
  .passthrough();

export const EntitySchema = z
  .object({
    id: z.string(),
    label: z.string().optional(),
    transform: TransformSchema,
    visual: VisualSchema.optional(),
    bounds: BoundsSchema.optional(),
  })
  .passthrough();

export const TargetSchema = z
  .object({
    id: z.string(),
    entityId: z.string(),
    label: z.string().optional(),
    localAnchor: z.array(z.number()),
    localBounds: BoundsSchema.optional(),
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
export const EnvironmentSchema = z
  .object({
    schemaVersion: z.string(),
    kind: z.literal("environment"),
    id: z.string(),
    promptExampleId: z.string().optional(),
    prompt: z.string(),
    clock: ClockSchema,
    coordinates: CoordinatesSchema,
    evaluation: EvaluationSchema.optional(),
    world: WorldSchema.optional(),
    entities: z.array(EntitySchema).default([]),
    targets: z.array(TargetSchema).default([]),
  })
  .passthrough();

export type Environment = z.infer<typeof EnvironmentSchema>;

// ---------------------------------------------------------------------------
// CameraTrajectory (output) — strict typing, doubles as the structured-
// output JSON Schema sent to OpenRouter.
// ---------------------------------------------------------------------------

export const TrajectoryClockSchema = z
  .object({
    durationSeconds: z.number(),
    timeUnit: z.literal("second"),
  })
  .strict();

export const TrajectoryCoordinatesSchema = z
  .object({
    handedness: z.enum(["right", "left"]),
    upAxis: z.string(),
    cameraForwardAxis: z.string(),
    lengthUnit: z.string(),
    rotationOrder: z.string(),
  })
  .strict();

export const IntrinsicsSchema = z
  .object({
    projection: z.literal("perspective"),
    fovYDegrees: z.number(),
    near: z.number(),
    far: z.number(),
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
const vec3 = z.array(z.number()).refine((v) => v.length === 3, {
  message: "must contain exactly 3 values",
});

export const OrientationSchema = z
  .object({
    mode: z.literal("perSampleLookAt"),
    up: vec3,
  })
  .strict();

export const TrajectoryRateSegmentSchema = z
  .object({
    startTime: z.number(),
    endTime: z.number(),
    rate: z.number(),
    label: z.string().nullable(),
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
export const TrajectoryPlaybackSchema = z
  .object({
    rateSegments: z.array(TrajectoryRateSegmentSchema),
  })
  .passthrough();

export const SampleSchema = z
  .object({
    t: z.number(),
    position: vec3,
    lookAt: vec3,
    // Nullable-but-required (not a Python/TS optional-with-default): strict
    // JSON Schema mode requires every key to be present in "required", so
    // these must be explicitly settable to null rather than omitted.
    fovYDegrees: z.number().nullable(),
    actionId: z.string().nullable(),
  })
  .strict();

export const CameraTrajectorySchema = z
  .object({
    schemaVersion: z.string(),
    kind: z.literal("cameraTrajectory"),
    environmentId: z.string(),
    clock: TrajectoryClockSchema,
    coordinates: TrajectoryCoordinatesSchema,
    intrinsics: IntrinsicsSchema,
    orientation: OrientationSchema,
    // Nullable-but-required, same reasoning as Sample's optional fields above.
    playback: TrajectoryPlaybackSchema.nullable(),
    samples: z.array(SampleSchema),
  })
  .strict();

export type CameraTrajectory = z.infer<typeof CameraTrajectorySchema>;

/**
 * Builds the OpenRouter `response_format` payload for structured output,
 * derived directly from CameraTrajectorySchema so the schema sent to the
 * API can never drift from the schema used to parse the response.
 * `$refStrategy: "none"` forces the schema to be fully inlined (no
 * `$ref`/`definitions`), which is the safest/most broadly compatible shape
 * across OpenRouter's different upstream providers.
 */
export function cameraTrajectoryResponseFormat(): Record<string, unknown> {
  const schema = zodToJsonSchema(CameraTrajectorySchema, { $refStrategy: "none" });
  return {
    type: "json_schema",
    json_schema: {
      name: "camera_trajectory",
      strict: true,
      schema,
    },
  };
}
