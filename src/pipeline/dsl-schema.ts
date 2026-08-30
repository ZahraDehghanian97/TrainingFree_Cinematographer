import { z } from "zod";

import type {
  CameraConfig,
  EulerAngles,
  Quaternion,
  SubjectReference,
  TransformMatrix4x4,
  Vector3,
} from "../types/camera";
import type {
  ActionConstraintConfig,
  Movement,
  TriggerSpec,
} from "../types/dsl";
import {
  CameraMovementType,
  CameraVerticalAngle,
  ComparisonOperator,
  ConstraintType,
  RelativeFPS,
  RelativeTimeReference,
  type Scale,
  ShotSize,
  SpeedFunction,
  SubjectInFramePosition,
  SubjectView,
} from "../types/enums";

const finiteNumberSchema = z.number().finite();
const nonNegativeNumberSchema = finiteNumberSchema.nonnegative();
const positiveNumberSchema = finiteNumberSchema.positive();
const nonEmptyStringSchema = z.string().trim().min(1);
const scaleSchema = finiteNumberSchema.int().min(0).max(10) as z.ZodType<Scale>;

const vector3Schema: z.ZodType<Vector3> = z.strictObject({
  x: finiteNumberSchema,
  y: finiteNumberSchema,
  z: finiteNumberSchema,
});

const quaternionSchema: z.ZodType<Quaternion> = z.strictObject({
  x: finiteNumberSchema,
  y: finiteNumberSchema,
  z: finiteNumberSchema,
  w: finiteNumberSchema,
});

const eulerAnglesSchema: z.ZodType<EulerAngles> = z.strictObject({
  pitch: finiteNumberSchema,
  yaw: finiteNumberSchema,
  roll: finiteNumberSchema,
});

const matrixRowSchema = z.tuple([
  finiteNumberSchema,
  finiteNumberSchema,
  finiteNumberSchema,
  finiteNumberSchema,
]);

const transformMatrixSchema: z.ZodType<TransformMatrix4x4> = z.tuple([
  matrixRowSchema,
  matrixRowSchema,
  matrixRowSchema,
  matrixRowSchema,
]);

const subjectCardinalitySchema = z.strictObject({
  min: z.number().int().min(1),
  max: z.number().int().min(1).optional(),
}).superRefine((cardinality, context) => {
  if (cardinality.max !== undefined && cardinality.max < cardinality.min) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["max"],
      message: "cardinality.max must be greater than or equal to cardinality.min",
    });
  }
});

const subjectReferenceSchema: z.ZodType<SubjectReference> = z.strictObject({
  ref: nonEmptyStringSchema,
  description: nonEmptyStringSchema,
  cardinality: subjectCardinalitySchema.optional(),
});

const cameraPoseSchema = z.strictObject({
  position: vector3Schema,
  rotation: z.union([quaternionSchema, eulerAnglesSchema]),
});

const cameraExtrinsicsSchema = z.strictObject({
  pose: cameraPoseSchema,
  transformMatrix: transformMatrixSchema.optional(),
});

const cameraIntrinsicsSchema = z.strictObject({
  focalLength: positiveNumberSchema.optional(),
  fov: positiveNumberSchema.lt(180).optional(),
  aspectRatio: positiveNumberSchema.optional(),
  sensorSize: z.strictObject({
    width: positiveNumberSchema,
    height: positiveNumberSchema,
  }).optional(),
});

const subjectFramingSchema = z.strictObject({
  position: z.nativeEnum(SubjectInFramePosition).optional(),
  dutchAngleScale: scaleSchema.optional(),
});

const subjectAwareCameraConfigSchema = z.strictObject({
  type: z.literal("subjectAware"),
  cameraAngle: z.nativeEnum(CameraVerticalAngle).optional(),
  shotSize: z.nativeEnum(ShotSize).optional(),
  subjectView: z.nativeEnum(SubjectView).optional(),
  subjectFraming: subjectFramingSchema.optional(),
});

const nonSubjectAwareCameraConfigSchema = z.strictObject({
  type: z.literal("nonSubjectAware"),
  extrinsics: cameraExtrinsicsSchema,
  intrinsics: cameraIntrinsicsSchema.optional(),
  lookAt: z.union([
    vector3Schema,
    z.array(subjectReferenceSchema),
  ]).optional(),
});

const cameraConfigSchema: z.ZodType<CameraConfig<SubjectReference>> =
  z.discriminatedUnion("type", [
    subjectAwareCameraConfigSchema,
    nonSubjectAwareCameraConfigSchema,
  ]);

const absoluteTimeTriggerSchema = z.strictObject({
  type: z.literal("absoluteTime"),
  time: nonNegativeNumberSchema,
});

const relativeTimeTriggerSchema = z.strictObject({
  type: z.literal("relativeTime"),
  actionId: nonEmptyStringSchema,
  reference: z.nativeEnum(RelativeTimeReference),
  offset: finiteNumberSchema,
});

const distanceTriggerSchema = z.strictObject({
  type: z.literal("distance"),
  object1: subjectReferenceSchema,
  object2: subjectReferenceSchema,
  operator: z.union([
    z.literal(ComparisonOperator.LessThan),
    z.literal(ComparisonOperator.LessThanOrEqual),
  ]),
  distance: nonNegativeNumberSchema,
});

const velocityTriggerSchema = z.strictObject({
  type: z.literal("velocity"),
  subject: subjectReferenceSchema,
  operator: z.union([
    z.literal(ComparisonOperator.GreaterThan),
    z.literal(ComparisonOperator.GreaterThanOrEqual),
  ]),
  speed: nonNegativeNumberSchema,
});

const leafTriggerSchema = z.union([
  absoluteTimeTriggerSchema,
  relativeTimeTriggerSchema,
  distanceTriggerSchema,
  velocityTriggerSchema,
]);

/**
 * Compound triggers are deliberately unrolled instead of recursively defined.
 * Three compound levels cover practical nested AND/OR expressions while keeping
 * the generated JSON Schema finite and predictable for structured-output models.
 */
export const MAX_COMPOUND_TRIGGER_DEPTH = 3;
const MAX_COMPOUND_TRIGGER_CHILDREN = 8;

let boundedTriggerSpecSchema: z.ZodTypeAny = leafTriggerSchema;
for (let depth = 0; depth < MAX_COMPOUND_TRIGGER_DEPTH; depth += 1) {
  const childSchema = boundedTriggerSpecSchema;
  const compoundTriggerSchema = z.strictObject({
    operator: z.enum(["and", "or"]),
    triggers: z.array(childSchema).min(1).max(MAX_COMPOUND_TRIGGER_CHILDREN),
  });
  boundedTriggerSpecSchema = z.union([
    leafTriggerSchema,
    compoundTriggerSchema,
  ]);
}

const triggerSpecSchema = boundedTriggerSpecSchema as z.ZodType<
  TriggerSpec<SubjectReference>
>;

const speedKeyframeSchema = z.strictObject({
  normalizedTime: finiteNumberSchema.min(0).max(1),
  speedMultiplier: nonNegativeNumberSchema,
  easing: z.nativeEnum(SpeedFunction).optional(),
});

const movementParametersSchema = z.strictObject({
  arcAngle: finiteNumberSchema.optional(),
  arcRadius: positiveNumberSchema.optional(),
  rotationAngle: finiteNumberSchema.optional(),
  distance: nonNegativeNumberSchema.optional(),
  heightChange: nonNegativeNumberSchema.optional(),
  horizontalDistance: nonNegativeNumberSchema.optional(),
  zoomFactor: positiveNumberSchema.optional(),
  followDelay: nonNegativeNumberSchema.optional(),
  leadAmount: nonNegativeNumberSchema.optional(),
  allowSubjectIntersection: z.boolean().optional(),
  path: z.enum(["linear", "curved", "spline"]).optional(),
  curveIntensity: scaleSchema.optional(),
});

const movementSchema: z.ZodType<Movement<SubjectReference>> = z.strictObject({
  act: z.nativeEnum(CameraMovementType),
  targets: z.array(subjectReferenceSchema).optional(),
  duration: positiveNumberSchema.optional(),
  speedKeyframes: z.array(speedKeyframeSchema).min(1).optional(),
  relativeFPS: z.nativeEnum(RelativeFPS).optional(),
  parameters: movementParametersSchema.optional(),
});

const pointConstraintEasingSchema = z.strictObject({
  inDuration: nonNegativeNumberSchema.optional(),
  outDuration: nonNegativeNumberSchema.optional(),
  curve: z.enum(["linear", "easeIn", "easeOut", "easeInOut"]).optional(),
});

const cameraConstraintSchema = z.strictObject({
  targets: z.array(subjectReferenceSchema).optional(),
  config: cameraConfigSchema,
  allFrames: z.boolean(),
  easing: pointConstraintEasingSchema.optional(),
});

// General loss parameters are intentionally JSON-only. The one nested container
// level covers current optimizer parameters without admitting functions, symbols,
// non-finite numbers, or an unbounded recursive schema into model output.
const jsonParameterScalarSchema = z.union([
  z.string(),
  finiteNumberSchema,
  z.boolean(),
  z.null(),
]);
const jsonParameterValueSchema = z.union([
  jsonParameterScalarSchema,
  z.array(jsonParameterScalarSchema),
  z.record(jsonParameterScalarSchema),
]);

const generalConstraintSchema = z.strictObject({
  kind: z.literal("general"),
  constraint: z.nativeEnum(ConstraintType),
  targets: z.array(subjectReferenceSchema).optional(),
  parameters: z.record(jsonParameterValueSchema).optional(),
  allFrames: z.boolean(),
  weight: positiveNumberSchema.optional(),
  easing: pointConstraintEasingSchema.optional(),
});

const actionConstraintSchema: z.ZodType<
  ActionConstraintConfig<SubjectReference>
> = z.union([
  cameraConstraintSchema,
  generalConstraintSchema,
]);

const actionSchema = z.strictObject({
  id: nonEmptyStringSchema,
  name: nonEmptyStringSchema.optional(),
  trigger: triggerSpecSchema,
  movement: movementSchema,
  priority: finiteNumberSchema.optional(),
  constraints: z.array(actionConstraintSchema).optional(),
});

const sectionSchema = z.strictObject({
  initCamera: z.strictObject({
    targets: z.array(subjectReferenceSchema),
    config: cameraConfigSchema,
  }),
  actions: z.array(actionSchema),
});

/** Strict structural contract for semantic, pre-grounding camera direction. */
export const cameraDirectionDraftSchema: z.ZodType<unknown> =
  z.strictObject({
    sections: z.array(sectionSchema).min(1),
    totalDuration: positiveNumberSchema,
  });

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}


function normalizeModelCameraConfig(value: unknown): unknown {
  if (
    !isRecord(value)
    || value.type !== "subjectAware"
    || !hasOwn(value, "cameraVerticalAngle")
    || hasOwn(value, "cameraAngle")
  ) {
    return value;
  }

  const { cameraVerticalAngle, ...rest } = value;
  return { ...rest, cameraAngle: cameraVerticalAngle };
}

function normalizeModelCameraContainer(value: unknown): unknown {
  if (!isRecord(value) || !hasOwn(value, "config")) return value;
  const config = normalizeModelCameraConfig(value.config);
  return config === value.config ? value : { ...value, config };
}

function normalizeModelAction(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.constraints)) return value;
  const constraints = value.constraints.map(normalizeModelCameraContainer);
  return { ...value, constraints };
}

function normalizeModelSection(value: unknown): unknown {
  if (!isRecord(value)) return value;
  return {
    ...value,
    ...(hasOwn(value, "initCamera")
      ? { initCamera: normalizeModelCameraContainer(value.initCamera) }
      : {}),
    ...(Array.isArray(value.actions)
      ? { actions: value.actions.map(normalizeModelAction) }
      : {}),
  };
}

function normalizeDirectorModelOutput(value: unknown): unknown {
  if (!isRecord(value) || !Array.isArray(value.sections)) return value;
  return { ...value, sections: value.sections.map(normalizeModelSection) };
}

/**
 * Structured-output schema for the director model. Its generated JSON Schema
 * is still the canonical contract, while preprocessing tolerates the common
 * `cameraVerticalAngle` alias before strict parsing.
 */
export const cameraDirectionDraftModelOutputSchema = z.preprocess(
  normalizeDirectorModelOutput,
  cameraDirectionDraftSchema,
);
