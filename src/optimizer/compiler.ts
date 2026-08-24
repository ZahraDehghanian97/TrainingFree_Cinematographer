import { LossFunctionType, type LossFunction, type TimelineSegment } from "../types/solver";
import {
  DEFAULT_GLOBAL_LOSSES,
  DEFAULT_OPTIMIZER_WEIGHTS,
  PRIMITIVE_TOLERANCES,
} from "./defaults";
import { subjectIdsFromParameters } from "./environment";
import type {
  CameraOptimizerInput,
  CompiledLossPlan,
  ConflictResolution,
  LossChannel,
  OptimizerWeights,
  PrimitiveLoss,
  PrimitiveLossType,
  PrimitiveRole,
  UserCameraKeyframe,
} from "./types";

interface CompileBandContext {
  startTime: number;
  endTime: number;
  sourceStartTime: number;
  sourceEndTime: number;
  sourceWeight: number;
  loss: LossFunction;
}

interface ActiveLossSpan {
  startTime: number;
  endTime: number;
  sourceStartTime: number;
  sourceEndTime: number;
  weight: number;
  loss: LossFunction;
  pointTime?: number;
  easing?: Extract<TimelineSegment, { kind: "point" }>["easing"];
}

interface PrimitiveDescriptor {
  type: PrimitiveLossType;
  channel: LossChannel;
  role: PrimitiveRole;
  parameters?: Record<string, unknown>;
  weightScale?: number;
  tolerance?: number;
}

const TRANSLATION_TYPES = new Set<LossFunctionType>([
  LossFunctionType.DollyInMovement,
  LossFunctionType.DollyOutMovement,
  LossFunctionType.TruckLeftMovement,
  LossFunctionType.TruckRightMovement,
  LossFunctionType.PedestalUpMovement,
  LossFunctionType.PedestalDownMovement,
  LossFunctionType.ArcMovement,
  LossFunctionType.FollowMovement,
  LossFunctionType.TrackMovement,
  LossFunctionType.CraneUpMovement,
  LossFunctionType.CraneDownMovement,
]);

const ROTATION_TYPES = new Set<LossFunctionType>([
  LossFunctionType.PanLeftMovement,
  LossFunctionType.PanRightMovement,
  LossFunctionType.TiltUpMovement,
  LossFunctionType.TiltDownMovement,
  LossFunctionType.DutchLeftMovement,
  LossFunctionType.DutchRightMovement,
]);

const ORIENTATION_DRIVING_TYPES = new Set<LossFunctionType>([
  ...ROTATION_TYPES,
  LossFunctionType.ArcMovement,
  LossFunctionType.FollowMovement,
  LossFunctionType.TrackMovement,
  LossFunctionType.FramingPosition,
  LossFunctionType.FramingDutchAngle,
  LossFunctionType.ShotSize,
  LossFunctionType.SubjectView,
  LossFunctionType.CameraVerticalAngle,
  LossFunctionType.KeepInFrame,
]);

const FOV_DRIVING_TYPES = new Set<LossFunctionType>([
  LossFunctionType.ZoomIn,
  LossFunctionType.ZoomOut,
  LossFunctionType.ShotSize,
  LossFunctionType.KeepInFrame,
]);

const FRAMING_TARGETS: Record<string, [number, number]> = {
  topLeft: [0.25, 0.25],
  top: [0.5, 0.25],
  topRight: [0.75, 0.25],
  left: [0.25, 0.5],
  center: [0.5, 0.5],
  right: [0.75, 0.5],
  bottomLeft: [0.25, 0.75],
  bottom: [0.5, 0.75],
  bottomRight: [0.75, 0.75],
};

const SHOT_SIZE_COVERAGE: Record<string, number> = {
  extremeCloseUp: 0.9,
  closeUp: 0.7,
  mediumCloseUp: 0.56,
  mediumShot: 0.43,
  mediumLongShot: 0.34,
  fullShot: 0.27,
  longShot: 0.19,
  veryLongShot: 0.12,
  extremeLongShot: 0.07,
};

const SUBJECT_VIEW_AZIMUTH_DEGREES: Record<string, number> = {
  front: 0,
  threeQuarterFrontRight: 45,
  right: 90,
  threeQuarterBackRight: 135,
  back: 180,
  threeQuarterBackLeft: -135,
  left: -90,
  threeQuarterFrontLeft: -45,
};

const VERTICAL_ANGLE_DEGREES: Record<string, number> = {
  wormsEye: -35,
  low: -18,
  eye: 0,
  high: 20,
  overhead: 42,
  birdsEye: 58,
  topDown: 88,
};

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asCompilerVec3(value: unknown): [number, number, number] | undefined {
  if (Array.isArray(value) && value.length === 3 && value.every(Number.isFinite)) {
    return [Number(value[0]), Number(value[1]), Number(value[2])];
  }
  if (value && typeof value === "object") {
    const candidate = value as Record<string, unknown>;
    if ([candidate.x, candidate.y, candidate.z].every(
      (item) => typeof item === "number" && Number.isFinite(item),
    )) {
      return [candidate.x as number, candidate.y as number, candidate.z as number];
    }
  }
  return undefined;
}

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values.map((value) => Number(value.toFixed(9))))].sort((a, b) => a - b);
}

function activeIntervalSegments(
  timeline: readonly TimelineSegment[],
  durationSeconds: number,
): Array<{ startTime: number; endTime: number; active: ActiveLossSpan[] }> {
  const spans: ActiveLossSpan[] = timeline.flatMap((segment) => {
    if (segment.kind === "interval") {
      return segment.lossFunctions.map((loss) => ({
        startTime: segment.startTime,
        endTime: segment.endTime,
        sourceStartTime: segment.startTime,
        sourceEndTime: segment.endTime,
        weight: finiteNumber(segment.weight, 1),
        loss,
      }));
    }
    const startTime = Math.max(0, segment.time - finiteNumber(segment.easing?.inDuration, 0));
    const endTime = Math.min(
      durationSeconds,
      segment.time + finiteNumber(segment.easing?.outDuration, 0),
    );
    if (endTime - startTime <= 1e-9) return [];
    return segment.lossFunctions.map((loss) => ({
      startTime,
      endTime,
      sourceStartTime: segment.time,
      sourceEndTime: segment.time,
      weight: finiteNumber(segment.weight, 1),
      loss,
      pointTime: segment.time,
      ...(segment.easing ? { easing: segment.easing } : {}),
    }));
  });
  const boundaries = uniqueSorted([
    0,
    durationSeconds,
    ...spans.flatMap((span) => [span.startTime, span.endTime]),
  ].filter((time) => time >= 0 && time <= durationSeconds));
  const result: Array<{
    startTime: number;
    endTime: number;
    active: ActiveLossSpan[];
  }> = [];
  for (let index = 0; index + 1 < boundaries.length; index += 1) {
    const startTime = boundaries[index]!;
    const endTime = boundaries[index + 1]!;
    if (endTime - startTime <= 1e-9) continue;
    const active = spans.filter(
      (span) => span.startTime < endTime - 1e-9 && span.endTime > startTime + 1e-9,
    );
    if (active.length > 0) result.push({ startTime, endTime, active });
  }
  return result;
}

function movementFraction(context: CompileBandContext): number {
  const sourceDuration = context.sourceEndTime - context.sourceStartTime;
  return sourceDuration <= 1e-9 ? 1 : (context.endTime - context.startTime) / sourceDuration;
}

function withSubjects(parameters: Record<string, unknown>): Record<string, unknown> {
  const subjectIds = subjectIdsFromParameters(parameters);
  return subjectIds.length > 0 ? { subjectIds } : {};
}

function subjectEntityKey(
  input: CameraOptimizerInput,
  subjectIds: readonly string[],
): string {
  return [...new Set(subjectIds.map((subjectId) =>
    input.environment.targets.find((target) => target.id === subjectId)?.entityId ?? subjectId,
  ))].sort().join("|");
}

function translationRecipe(
  context: CompileBandContext,
  axis: "towardSubject" | "cameraRight" | "worldUp" | "cameraForward",
  sign: number,
  distance: number,
): PrimitiveDescriptor[] {
  const targetDistance = Math.abs(distance) * movementFraction(context);
  const shared = {
    axis,
    sign,
    targetDistance,
    referenceTime: context.startTime,
    ...(context.loss.parameters.speedKeyframes ? { speedKeyframes: context.loss.parameters.speedKeyframes } : {}),
    ...(context.loss.parameters.path ? { path: context.loss.parameters.path } : {}),
    ...(context.loss.parameters.curveIntensity === undefined
      ? {}
      : { curveIntensity: context.loss.parameters.curveIntensity }),
    ...(context.loss.parameters.allowSubjectIntersection === true
      ? { allowSubjectIntersection: true }
      : {}),
    ...withSubjects(context.loss.parameters),
  };
  const path = context.loss.parameters.path;
  const shapeDescriptor: PrimitiveDescriptor = path === "curved" || path === "spline"
    ? { type: "pathProfile", channel: "position", role: "stabilizer", parameters: shared }
    : {
        type: "orthogonalDrift",
        channel: "position",
        role: "stabilizer",
        parameters: shared,
        // A straight move is a geometric promise. Give it enough authority to
        // resist the small per-sample cross-talk introduced by SPSA.
        weightScale: 4,
        tolerance: 0.02,
      };
  return [
    { type: "axisProgress", channel: "position", role: "primary", parameters: shared },
    { type: "totalProgressTarget", channel: "position", role: "primary", parameters: shared },
    shapeDescriptor,
    { type: "stepPacing", channel: "regularity", role: "stabilizer", parameters: shared, weightScale: 1.2 },
    { type: "stepSmoothness", channel: "regularity", role: "stabilizer", parameters: shared, weightScale: 1.2 },
    // Physical camera translation does not implicitly change the lens or roll
    // the rig. Explicit zoom/dutch actions remove these stabilizers below.
    { type: "fovHold", channel: "intrinsics", role: "stabilizer", weightScale: 2 },
    {
      type: "levelHorizon",
      channel: "rotation",
      role: "stabilizer",
      weightScale: 24,
      tolerance: Math.PI / 180,
    },
  ];
}

function rotationRecipe(
  context: CompileBandContext,
  mode: "yaw" | "pitch",
  sign: number,
): PrimitiveDescriptor[] {
  const requested = Math.abs(finiteNumber(context.loss.parameters.rotationAngle, 30));
  const targetDelta = sign * requested * Math.PI / 180 * movementFraction(context);
  const shared = {
    mode,
    targetDelta,
    sign,
    ...(context.loss.parameters.speedKeyframes ? { speedKeyframes: context.loss.parameters.speedKeyframes } : {}),
  };
  return [
    { type: "angularProgress", channel: "rotation", role: "primary", parameters: shared },
    { type: "angularDirection", channel: "rotation", role: "primary", parameters: shared, weightScale: 0.7 },
    { type: "angularPacing", channel: "regularity", role: "stabilizer", parameters: shared, weightScale: 0.65 },
    mode === "yaw"
      ? { type: "pitchHold", channel: "rotation", role: "stabilizer" }
      : { type: "yawHold", channel: "rotation", role: "stabilizer" },
    { type: "rollHold", channel: "rotation", role: "stabilizer" },
    { type: "positionHold", channel: "position", role: "stabilizer" },
  ];
}

function recipeFor(context: CompileBandContext): PrimitiveDescriptor[] {
  const { loss } = context;
  const p = loss.parameters;
  const subjects = withSubjects(p);
  switch (loss.type) {
    case LossFunctionType.DollyInMovement:
      return translationRecipe(context, "cameraForward", 1, finiteNumber(p.distance, 2));
    case LossFunctionType.DollyOutMovement:
      return translationRecipe(context, "cameraForward", -1, finiteNumber(p.distance, 2));
    case LossFunctionType.TruckLeftMovement:
      return translationRecipe(context, "cameraRight", -1, finiteNumber(p.distance, 2));
    case LossFunctionType.TruckRightMovement:
      return translationRecipe(context, "cameraRight", 1, finiteNumber(p.distance, 2));
    case LossFunctionType.PedestalUpMovement:
      return translationRecipe(context, "worldUp", 1, finiteNumber(p.distance, 2));
    case LossFunctionType.PedestalDownMovement:
      return translationRecipe(context, "worldUp", -1, finiteNumber(p.distance, 2));
    case LossFunctionType.CraneUpMovement:
    case LossFunctionType.CraneDownMovement: {
      const sign = loss.type === LossFunctionType.CraneUpMovement ? 1 : -1;
      const verticalDistance = Math.abs(finiteNumber(p.heightChange, 2)) * movementFraction(context);
      const horizontalDistance = Math.abs(finiteNumber(p.horizontalDistance, 1)) * movementFraction(context);
      const vertical = {
        axis: "worldUp",
        sign,
        targetDistance: verticalDistance,
        ...(p.speedKeyframes ? { speedKeyframes: p.speedKeyframes } : {}),
        ...subjects,
      };
      const horizontal = {
        axis: "cameraForward",
        sign: 1,
        targetDistance: horizontalDistance,
        ...(p.speedKeyframes ? { speedKeyframes: p.speedKeyframes } : {}),
        ...subjects,
      };
      return [
        { type: "axisProgress", channel: "position", role: "primary", parameters: vertical },
        { type: "totalProgressTarget", channel: "position", role: "primary", parameters: vertical },
        { type: "axisProgress", channel: "position", role: "primary", parameters: horizontal },
        { type: "totalProgressTarget", channel: "position", role: "primary", parameters: horizontal },
        {
          type: "planeHold",
          channel: "position",
          role: "stabilizer",
          parameters: { plane: "cameraMovement", ...subjects },
        },
        { type: "stepPacing", channel: "regularity", role: "stabilizer", parameters: vertical, weightScale: 0.6 },
        { type: "stepPacing", channel: "regularity", role: "stabilizer", parameters: horizontal, weightScale: 0.6 },
        { type: "stepSmoothness", channel: "regularity", role: "stabilizer", parameters: vertical, weightScale: 0.45 },
      ];
    }
    case LossFunctionType.PanLeftMovement:
      return rotationRecipe(context, "yaw", 1);
    case LossFunctionType.PanRightMovement:
      return rotationRecipe(context, "yaw", -1);
    case LossFunctionType.TiltUpMovement:
      return rotationRecipe(context, "pitch", 1);
    case LossFunctionType.TiltDownMovement:
      return rotationRecipe(context, "pitch", -1);
    case LossFunctionType.DutchLeftMovement:
    case LossFunctionType.DutchRightMovement: {
      const sign = loss.type === LossFunctionType.DutchLeftMovement ? -1 : 1;
      const targetDelta = sign * Math.abs(finiteNumber(p.rotationAngle, 20)) * Math.PI / 180
        * movementFraction(context);
      return [
        { type: "rollProgress", channel: "rotation", role: "primary", parameters: { sign, targetDelta } },
        { type: "angularPacing", channel: "regularity", role: "stabilizer", parameters: { mode: "roll", sign, targetDelta } },
        { type: "positionHold", channel: "position", role: "stabilizer" },
        { type: "forwardHold", channel: "rotation", role: "stabilizer" },
      ];
    }
    case LossFunctionType.ArcMovement: {
      const angle = finiteNumber(p.arcAngle, 45) * Math.PI / 180 * movementFraction(context);
      const radius = finiteNumber(p.arcRadius, Number.NaN);
      const shared = {
        targetDelta: angle,
        sign: Math.sign(angle) || 1,
        ...(p.speedKeyframes ? { speedKeyframes: p.speedKeyframes } : {}),
        ...subjects,
      };
      return [
        { type: "planeHold", channel: "position", role: "primary", parameters: { plane: "subjectHorizontal", ...subjects } },
        {
          type: "radiusHold",
          channel: "subjectRelative",
          role: "primary",
          parameters: { targetRadius: Number.isFinite(radius) ? radius : "initial", ...subjects },
        },
        { type: "angularProgress", channel: "subjectRelative", role: "primary", parameters: { mode: "orbit", ...shared } },
        { type: "angularDirection", channel: "subjectRelative", role: "primary", parameters: { mode: "orbit", ...shared } },
        { type: "angularPacing", channel: "regularity", role: "stabilizer", parameters: { mode: "orbit", ...shared } },
        { type: "lookAt", channel: "composition", role: "primary", parameters: subjects },
        { type: "levelHorizon", channel: "rotation", role: "stabilizer" },
      ];
    }
    case LossFunctionType.ZoomIn:
    case LossFunctionType.ZoomOut: {
      const zoomIn = loss.type === LossFunctionType.ZoomIn;
      const factor = Math.max(1.01, finiteNumber(p.zoomFactor, 1.5));
      const intervalFactor = Math.pow(factor, movementFraction(context));
      return [
        {
          type: "intrinsicsProgress",
          channel: "intrinsics",
          role: "primary",
          parameters: {
            factor: intervalFactor,
            direction: zoomIn ? "in" : "out",
            ...(p.speedKeyframes ? { speedKeyframes: p.speedKeyframes } : {}),
          },
        },
        {
          type: "intrinsicsPacing",
          channel: "regularity",
          role: "stabilizer",
          parameters: {
            factor: intervalFactor,
            direction: zoomIn ? "in" : "out",
            ...(p.speedKeyframes ? { speedKeyframes: p.speedKeyframes } : {}),
          },
        },
        { type: "positionHold", channel: "position", role: "stabilizer" },
        { type: "orientationHold", channel: "rotation", role: "stabilizer" },
      ];
    }
    case LossFunctionType.Static: {
      const mountedStatic = subjectIdsFromParameters(subjects).length > 0;
      return [
        mountedStatic
          ? {
              type: "relativeOffsetHold",
              channel: "subjectRelative",
              role: "primary",
              parameters: subjects,
              tolerance: 0.04,
              weightScale: 4,
            }
          : { type: "positionHold", channel: "position", role: "primary" },
        {
          type: "orientationHold",
          channel: "rotation",
          role: "primary",
          ...(mountedStatic ? { weightScale: 4 } : {}),
        },
        {
          type: "fovHold",
          channel: "intrinsics",
          role: "primary",
          ...(mountedStatic ? { weightScale: 2 } : {}),
        },
      ];
    }
    case LossFunctionType.FollowMovement: {
      const follow = {
        ...subjects,
        followDelay: finiteNumber(p.followDelay, 0),
        leadAmount: finiteNumber(p.leadAmount, 0),
      };
      return [
        { type: "relativeOffsetHold", channel: "subjectRelative", role: "primary", parameters: follow },
        { type: "velocityMatch", channel: "subjectRelative", role: "primary", parameters: follow },
        { type: "lookAt", channel: "composition", role: "stabilizer", parameters: follow },
        { type: "bboxInFrame", channel: "composition", role: "stabilizer", parameters: follow },
        { type: "levelHorizon", channel: "rotation", role: "stabilizer" },
      ];
    }
    case LossFunctionType.TrackMovement: {
      const track = {
        ...subjects,
        followDelay: finiteNumber(p.followDelay, 0),
        leadAmount: finiteNumber(p.leadAmount, 0),
      };
      return [
        { type: "distanceHold", channel: "subjectRelative", role: "primary", parameters: track },
        { type: "velocityMatch", channel: "subjectRelative", role: "stabilizer", parameters: track },
        { type: "screenPosition", channel: "composition", role: "primary", parameters: { target: [0.5, 0.5], ...track } },
        { type: "bboxInFrame", channel: "composition", role: "stabilizer", parameters: track },
        { type: "levelHorizon", channel: "rotation", role: "stabilizer" },
      ];
    }
    case LossFunctionType.FramingPosition: {
      const positionName = typeof p.position === "string" ? p.position : "center";
      const target = FRAMING_TARGETS[positionName] ?? FRAMING_TARGETS.center!;
      return [
        { type: "screenPosition", channel: "composition", role: "primary", parameters: { target, ...subjects } },
        { type: "bboxInFrame", channel: "composition", role: "stabilizer", parameters: subjects },
      ];
    }
    case LossFunctionType.FramingDutchAngle: {
      const scale = Math.max(0, Math.min(10, finiteNumber(p.scale, 0)));
      return [{
        type: "rollTarget",
        channel: "rotation",
        role: "primary",
        parameters: { targetRoll: scale / 10 * Math.PI / 6 },
      }];
    }
    case LossFunctionType.ShotSize: {
      const shotSize = typeof p.shotSize === "string" ? p.shotSize : "mediumShot";
      return [
        {
          type: "screenScale",
          channel: "composition",
          role: "primary",
          parameters: { targetCoverage: SHOT_SIZE_COVERAGE[shotSize] ?? SHOT_SIZE_COVERAGE.mediumShot, ...subjects },
        },
        { type: "bboxInFrame", channel: "composition", role: "stabilizer", parameters: subjects },
      ];
    }
    case LossFunctionType.SubjectView: {
      const view = typeof p.view === "string" ? p.view : "front";
      return [{
        type: "subjectView",
        channel: "subjectRelative",
        role: "primary",
        parameters: { targetAzimuth: (SUBJECT_VIEW_AZIMUTH_DEGREES[view] ?? 0) * Math.PI / 180, ...subjects },
      }, {
        type: "lookAt",
        channel: "composition",
        role: "stabilizer",
        parameters: subjects,
      }, {
        type: "levelHorizon",
        channel: "rotation",
        role: "stabilizer",
      }];
    }
    case LossFunctionType.CameraVerticalAngle: {
      const angle = typeof p.angle === "string" ? p.angle : "eye";
      return [
        {
          type: "subjectElevation",
          channel: "subjectRelative",
          role: "primary",
          parameters: { targetElevation: (VERTICAL_ANGLE_DEGREES[angle] ?? 0) * Math.PI / 180, ...subjects },
        },
        { type: "lookAt", channel: "composition", role: "stabilizer", parameters: subjects },
        { type: "levelHorizon", channel: "rotation", role: "stabilizer" },
      ];
    }
    case LossFunctionType.KeepInFrame:
      return [
        { type: "bboxInFrame", channel: "composition", role: "primary", parameters: subjects },
        { type: "nearPlaneClearance", channel: "safety", role: "primary", parameters: subjects },
      ];
    case LossFunctionType.MaintainDistance:
      return [{ type: "distanceHold", channel: "subjectRelative", role: "primary", parameters: { ...p, ...subjects } }];
    case LossFunctionType.MaintainAngle:
      return [
        { type: "bearingHold", channel: "subjectRelative", role: "primary", parameters: { ...p, ...subjects } },
        { type: "elevationHold", channel: "subjectRelative", role: "primary", parameters: { ...p, ...subjects } },
      ];
    case LossFunctionType.AvoidOcclusion:
      return [{ type: "occlusion", channel: "safety", role: "primary", parameters: subjects }];
    case LossFunctionType.GroundLevel:
      return [
        { type: "heightAboveGround", channel: "position", role: "primary", parameters: p },
        { type: "groundClearance", channel: "safety", role: "primary", parameters: p },
      ];
    case LossFunctionType.NoShake:
      return [
        { type: "accelerationSmoothness", channel: "regularity", role: "primary" },
        { type: "angularAccelerationSmoothness", channel: "regularity", role: "primary" },
        { type: "jerkSmoothness", channel: "regularity", role: "stabilizer" },
      ];
    case LossFunctionType.Collision:
      return [{ type: "collisionClearance", channel: "safety", role: "primary", parameters: p }];
    case LossFunctionType.Smoothness:
      return [
        { type: "accelerationSmoothness", channel: "regularity", role: "primary" },
        { type: "angularAccelerationSmoothness", channel: "regularity", role: "primary" },
        { type: "jerkSmoothness", channel: "regularity", role: "stabilizer" },
      ];
    case LossFunctionType.MinPath: {
      const pose = p.targetPose as Record<string, unknown> | undefined;
      if (!pose) return [{ type: "pathLength", channel: "regularity", role: "regularizer" }];
      const descriptors: PrimitiveDescriptor[] = [];
      if (pose.position) descriptors.push({
        type: "positionAnchor",
        channel: "position",
        role: "primary",
        parameters: { target: pose.position },
      });
      if (pose.rotation) descriptors.push({
        type: "rotationAnchor",
        channel: "rotation",
        role: "primary",
        parameters: { target: pose.rotation },
      });
      const intrinsics = p.targetIntrinsics as Record<string, unknown> | undefined;
      let targetFov = intrinsics?.fov ?? intrinsics?.fovYDegrees;
      if (typeof targetFov !== "number" && typeof intrinsics?.focalLength === "number") {
        const sensor = intrinsics.sensorSize as Record<string, unknown> | undefined;
        const sensorHeight = typeof sensor?.height === "number" ? sensor.height : 24;
        targetFov = 2 * Math.atan(sensorHeight / (2 * intrinsics.focalLength)) * 180 / Math.PI;
      }
      if (typeof targetFov === "number") descriptors.push({
        type: "fovAnchor",
        channel: "intrinsics",
        role: "primary",
        parameters: { target: targetFov },
      });
      const lookAt = asCompilerVec3(p.lookAt);
      if (lookAt) descriptors.push({
        type: "rotationAnchor",
        channel: "rotation",
        role: "primary",
        parameters: { lookAt },
      });
      if (Array.isArray(p.lookAt)) {
        const subjectIds = p.lookAt.flatMap((target) => {
          if (!target || typeof target !== "object") return [];
          const id = (target as Record<string, unknown>).id;
          return typeof id === "string" && id.trim() ? [id.trim()] : [];
        });
        if (subjectIds.length > 0) descriptors.push({
          type: "lookAt",
          channel: "composition",
          role: "primary",
          parameters: { subjectIds: [...new Set(subjectIds)] },
        });
      }
      return descriptors;
    }
  }
  const exhaustive: never = loss.type;
  throw new Error(`Unsupported high-level loss: ${String(exhaustive)}`);
}

function roleWeight(role: PrimitiveRole, weights: OptimizerWeights): number {
  if (role === "primary") return weights.semanticPrimary;
  if (role === "stabilizer") return weights.semanticStabilizer;
  return weights.globalMinPath;
}

function compileUserKeyframeDescriptors(keyframe: UserCameraKeyframe): PrimitiveDescriptor[] {
  const shared = { hard: (keyframe.mode ?? "hard") === "hard", keyframeTime: keyframe.time };
  const descriptors: PrimitiveDescriptor[] = [];
  if (keyframe.position) descriptors.push({
    type: "positionAnchor",
    channel: "position",
    role: "primary",
    parameters: { ...shared, target: keyframe.position },
  });
  if (keyframe.rotation) descriptors.push({
    type: "rotationAnchor",
    channel: "rotation",
    role: "primary",
    parameters: { ...shared, target: keyframe.rotation },
  });
  if (keyframe.lookAt) descriptors.push({
    type: "rotationAnchor",
    channel: "rotation",
    role: "primary",
    parameters: { ...shared, lookAt: keyframe.lookAt },
  });
  if (keyframe.fovYDegrees !== undefined) descriptors.push({
    type: "fovAnchor",
    channel: "intrinsics",
    role: "primary",
    parameters: { ...shared, target: keyframe.fovYDegrees },
  });
  return descriptors;
}

export function compileLossPlan(input: CameraOptimizerInput): CompiledLossPlan {
  const durationSeconds = input.environment.clock.durationSeconds;
  const weights: OptimizerWeights = { ...DEFAULT_OPTIMIZER_WEIGHTS, ...input.options?.weights };
  const primitives: PrimitiveLoss[] = [];
  const conflicts: ConflictResolution[] = [];
  const warnings: string[] = [];
  let nextId = 1;

  const add = (
    descriptor: PrimitiveDescriptor,
    startTime: number,
    endTime: number,
    sourceType: PrimitiveLoss["sourceType"],
    sourceWeight = 1,
    sourceActionId?: string,
    explicitWeight?: number,
  ): PrimitiveLoss => {
    const primitive: PrimitiveLoss = {
      id: `p${nextId++}`,
      type: descriptor.type,
      startTime,
      endTime,
      weight: explicitWeight ?? roleWeight(descriptor.role, weights) * sourceWeight * (descriptor.weightScale ?? 1),
      tolerance: descriptor.tolerance ?? PRIMITIVE_TOLERANCES[descriptor.type],
      channel: descriptor.channel,
      role: descriptor.role,
      sourceType,
      ...(sourceActionId ? { sourceActionId } : {}),
      parameters: descriptor.parameters ?? {},
    };
    primitives.push(primitive);
    return primitive;
  };

  for (const band of activeIntervalSegments(input.timeline.timeline, durationSeconds)) {
    const bandStartIndex = primitives.length;
    const highLevelTypes: LossFunctionType[] = [];
    for (const span of band.active) {
      const { loss } = span;
      highLevelTypes.push(loss.type);
      const priorityScale = 1 + Math.max(0, finiteNumber(loss.priority, 0)) * 0.1;
      const context: CompileBandContext = {
        startTime: band.startTime,
        endTime: band.endTime,
        sourceStartTime: span.sourceStartTime,
        sourceEndTime: span.sourceEndTime,
        sourceWeight: span.weight * priorityScale,
        loss,
      };
      for (const descriptor of recipeFor(context)) {
        add(
          span.pointTime === undefined
            ? descriptor
            : {
                ...descriptor,
                parameters: {
                  ...(descriptor.parameters ?? {}),
                  pointTime: span.pointTime,
                  ...(span.easing ? { easing: span.easing } : {}),
                },
              },
          band.startTime,
          band.endTime,
          loss.type,
          context.sourceWeight,
          loss.sourceActionId,
        );
      }
    }

    const bandPrimitives = (): PrimitiveLoss[] => primitives.slice(bandStartIndex);
    const removeWhere = (predicate: (primitive: PrimitiveLoss) => boolean): string[] => {
      const removed = bandPrimitives().filter(predicate).map((primitive) => primitive.id);
      for (let index = primitives.length - 1; index >= bandStartIndex; index -= 1) {
        if (removed.includes(primitives[index]!.id)) primitives.splice(index, 1);
      }
      return removed;
    };

    const hasArc = highLevelTypes.includes(LossFunctionType.ArcMovement);
    const hasDollyIn = highLevelTypes.includes(LossFunctionType.DollyInMovement);
    const hasDollyOut = highLevelTypes.includes(LossFunctionType.DollyOutMovement);
    if (hasArc && (hasDollyIn || hasDollyOut)) {
      const dollySpan = band.active.find((span) =>
        span.loss.type === LossFunctionType.DollyInMovement
        || span.loss.type === LossFunctionType.DollyOutMovement,
      )!;
      const arcSpan = band.active.find((span) => span.loss.type === LossFunctionType.ArcMovement)!;
      const dollyLoss = dollySpan.loss;
      const arcLoss = arcSpan.loss;
      const arcSubjects = subjectIdsFromParameters(arcLoss.parameters);
      const dollySubjects = subjectIdsFromParameters(dollyLoss.parameters);
      const sameSubject = arcSubjects.length > 0
        && subjectEntityKey(input, arcSubjects) === subjectEntityKey(input, dollySubjects);
      if (sameSubject) {
        const sharedEntityKey = subjectEntityKey(input, arcSubjects);
        const removed = removeWhere((primitive) =>
          subjectEntityKey(input, subjectIdsFromParameters(primitive.parameters)) === sharedEntityKey
          && (
            (primitive.type === "radiusHold" && primitive.sourceType === LossFunctionType.ArcMovement)
            || (
              primitive.type === "orthogonalDrift"
              && (
                primitive.sourceType === LossFunctionType.DollyInMovement
                || primitive.sourceType === LossFunctionType.DollyOutMovement
              )
            )
          ),
        );
        const fraction = (band.endTime - band.startTime)
          / Math.max(1e-9, dollySpan.sourceEndTime - dollySpan.sourceStartTime);
        const distance = Math.abs(finiteNumber(dollyLoss.parameters.distance, 2)) * fraction;
        const added = add({
          type: "radiusSchedule",
          channel: "subjectRelative",
          role: "primary",
          parameters: {
            deltaRadius: dollyLoss.type === LossFunctionType.DollyInMovement ? -distance : distance,
            subjectIds: arcSubjects,
          },
        }, band.startTime, band.endTime, LossFunctionType.ArcMovement, 1, arcLoss.sourceActionId);
        conflicts.push({
          interval: [band.startTime, band.endTime],
          rule: "arc+dolly=>spiral",
          removedPrimitiveIds: removed,
          addedPrimitiveIds: [added.id],
        });
      } else {
        warnings.push(
          `Arc and Dolly on ${band.startTime}-${band.endTime}s target different subjects; spiral fusion was skipped`,
        );
      }
    }

    const hasPedestal = highLevelTypes.includes(LossFunctionType.PedestalUpMovement)
      || highLevelTypes.includes(LossFunctionType.PedestalDownMovement)
      || highLevelTypes.includes(LossFunctionType.CraneUpMovement)
      || highLevelTypes.includes(LossFunctionType.CraneDownMovement);
    if (hasArc && hasPedestal) {
      const removed = removeWhere((primitive) => primitive.type === "planeHold");
      if (removed.length > 0) conflicts.push({
        interval: [band.startTime, band.endTime],
        rule: "arc+pedestal=>helical-crane",
        removedPrimitiveIds: removed,
        addedPrimitiveIds: [],
      });
    }

    const hasFollow = highLevelTypes.includes(LossFunctionType.FollowMovement);
    if (hasFollow && (hasDollyIn || hasDollyOut)) {
      const followSpan = band.active.find((span) => span.loss.type === LossFunctionType.FollowMovement)!;
      const dollySpan = band.active.find((span) =>
        span.loss.type === LossFunctionType.DollyInMovement
        || span.loss.type === LossFunctionType.DollyOutMovement,
      )!;
      const followKey = subjectEntityKey(
        input,
        subjectIdsFromParameters(followSpan.loss.parameters),
      );
      const dollyKey = subjectEntityKey(
        input,
        subjectIdsFromParameters(dollySpan.loss.parameters),
      );
      if (followKey && followKey === dollyKey) {
        const removed = removeWhere((primitive) =>
          primitive.type === "relativeOffsetHold"
          && primitive.sourceType === LossFunctionType.FollowMovement,
        );
        if (removed.length > 0) conflicts.push({
          interval: [band.startTime, band.endTime],
          rule: "follow+dolly=>radial-follow",
          removedPrimitiveIds: removed,
          addedPrimitiveIds: [],
        });
      } else {
        warnings.push(
          `Follow and Dolly on ${band.startTime}-${band.endTime}s target different subjects; radial fusion was skipped`,
        );
      }
    }

    if (highLevelTypes.some((type) => TRANSLATION_TYPES.has(type))) {
      const removed = removeWhere((primitive) =>
        (
          primitive.type === "positionHold"
          || (
            primitive.type === "relativeOffsetHold"
            && primitive.sourceType === LossFunctionType.Static
          )
        )
        && (primitive.role === "stabilizer" || primitive.sourceType === LossFunctionType.Static),
      );
      if (removed.length > 0) conflicts.push({
        interval: [band.startTime, band.endTime],
        rule: "translation-removes-position-hold",
        removedPrimitiveIds: removed,
        addedPrimitiveIds: [],
      });
    }
    if (highLevelTypes.some((type) => ORIENTATION_DRIVING_TYPES.has(type))) {
      const hasPanOrTilt = highLevelTypes.some((type) => [
        LossFunctionType.PanLeftMovement,
        LossFunctionType.PanRightMovement,
        LossFunctionType.TiltUpMovement,
        LossFunctionType.TiltDownMovement,
      ].includes(type));
      const removed = removeWhere((primitive) =>
        (
          primitive.type === "orientationHold"
          || (hasPanOrTilt && primitive.type === "forwardHold")
        )
        && (primitive.role === "stabilizer" || primitive.sourceType === LossFunctionType.Static),
      );
      if (removed.length > 0) conflicts.push({
        interval: [band.startTime, band.endTime],
        rule: "rotation-removes-orientation-hold",
        removedPrimitiveIds: removed,
        addedPrimitiveIds: [],
      });
    }
    if (highLevelTypes.some((type) => FOV_DRIVING_TYPES.has(type))) {
      const removed = removeWhere((primitive) =>
        primitive.type === "fovHold"
        && (primitive.role === "stabilizer" || primitive.sourceType === LossFunctionType.Static),
      );
      if (removed.length > 0) conflicts.push({
        interval: [band.startTime, band.endTime],
        rule: highLevelTypes.includes(LossFunctionType.ZoomIn)
          || highLevelTypes.includes(LossFunctionType.ZoomOut)
          ? "zoom-removes-fov-hold"
          : "framing-removes-fov-hold",
        removedPrimitiveIds: removed,
        addedPrimitiveIds: [],
      });
    }
    if (
      highLevelTypes.includes(LossFunctionType.DutchLeftMovement)
      || highLevelTypes.includes(LossFunctionType.DutchRightMovement)
      || highLevelTypes.includes(LossFunctionType.FramingDutchAngle)
    ) {
      const removed = removeWhere((primitive) => primitive.type === "levelHorizon");
      if (removed.length > 0) conflicts.push({
        interval: [band.startTime, band.endTime],
        rule: "dutch-removes-level-horizon",
        removedPrimitiveIds: removed,
        addedPrimitiveIds: [],
      });
    }
    const offCenterFraming = bandPrimitives().filter((primitive) =>
      primitive.type === "screenPosition"
      && Array.isArray(primitive.parameters.target)
      && (primitive.parameters.target[0] !== 0.5 || primitive.parameters.target[1] !== 0.5),
    );
    if (offCenterFraming.length > 0) {
      const framingSubjects = new Set(offCenterFraming.map((primitive) =>
        subjectEntityKey(input, subjectIdsFromParameters(primitive.parameters)),
      ));
      const removed = removeWhere((primitive) =>
        primitive.type === "lookAt"
        && primitive.role === "stabilizer"
        && framingSubjects.has(
          subjectEntityKey(input, subjectIdsFromParameters(primitive.parameters)),
        ),
      );
      if (removed.length > 0) conflicts.push({
        interval: [band.startTime, band.endTime],
        rule: "screen-position-dominates-look-at",
        removedPrimitiveIds: removed,
        addedPrimitiveIds: [],
      });
    }

    const targetSignatures = new Map<string, Set<string>>();
    for (const primitive of bandPrimitives()) {
      if (!["screenScale", "screenPosition", "subjectView", "subjectElevation", "rollTarget"].includes(primitive.type)) {
        continue;
      }
      const subjectIds = subjectIdsFromParameters(primitive.parameters).join("|");
      const key = `${primitive.type}:${subjectIds}`;
      const target = primitive.parameters.target
        ?? primitive.parameters.targetCoverage
        ?? primitive.parameters.targetAzimuth
        ?? primitive.parameters.targetElevation
        ?? primitive.parameters.targetRoll;
      const signatures = targetSignatures.get(key) ?? new Set<string>();
      signatures.add(JSON.stringify(target));
      targetSignatures.set(key, signatures);
    }
    for (const [key, signatures] of targetSignatures) {
      if (signatures.size > 1) {
        warnings.push(
          `Conflicting ${key} targets on ${band.startTime}-${band.endTime}s retained as a weighted compromise`,
        );
      }
    }
  }

  for (const segment of input.timeline.timeline) {
    if (segment.kind !== "point") continue;
    const inDuration = finiteNumber(segment.easing?.inDuration, 0);
    const outDuration = finiteNumber(segment.easing?.outDuration, 0);
    const startTime = Math.max(0, segment.time - inDuration);
    const endTime = Math.min(durationSeconds, segment.time + outDuration);
    if (endTime - startTime > 1e-9) continue;
    for (const loss of segment.lossFunctions) {
      const priorityScale = 1 + Math.max(0, finiteNumber(loss.priority, 0)) * 0.1;
      const context: CompileBandContext = {
        startTime,
        endTime,
        sourceStartTime: segment.time,
        sourceEndTime: segment.time,
        sourceWeight: finiteNumber(segment.weight, 1) * priorityScale,
        loss,
      };
      for (const descriptor of recipeFor(context)) {
        add({
          ...descriptor,
          parameters: {
            ...(descriptor.parameters ?? {}),
            pointTime: segment.time,
            ...(segment.easing ? { easing: segment.easing } : {}),
          },
        }, startTime, endTime, loss.type, context.sourceWeight, loss.sourceActionId);
      }
    }

  }

  for (const keyframe of input.userKeyframes ?? []) {
    const mode = keyframe.mode ?? "hard";
    const explicitWeight = mode === "hard"
      ? weights.userSoftKeyframe * 4
      : weights.userSoftKeyframe * finiteNumber(keyframe.weight, 1);
    for (const descriptor of compileUserKeyframeDescriptors(keyframe)) {
      add(descriptor, keyframe.time, keyframe.time, "userKeyframe", 1, undefined, explicitWeight);
    }
  }

  const global = { ...DEFAULT_GLOBAL_LOSSES, ...input.options?.globalLosses };
  const globalDescriptors: Array<[boolean, PrimitiveDescriptor, number]> = [
    [global.smoothness, { type: "accelerationSmoothness", channel: "regularity", role: "regularizer", parameters: { cutTimes: input.timeline.cutTimes ?? [] } }, weights.globalSmoothness],
    [global.angularSmoothness, { type: "angularAccelerationSmoothness", channel: "regularity", role: "regularizer", parameters: { cutTimes: input.timeline.cutTimes ?? [] } }, weights.globalAngularSmoothness],
    [global.jerk, { type: "jerkSmoothness", channel: "regularity", role: "regularizer", parameters: { cutTimes: input.timeline.cutTimes ?? [] } }, weights.globalJerk],
    [global.collision, { type: "collisionClearance", channel: "safety", role: "regularizer" }, weights.globalCollision],
    [global.ground && input.environment.world?.ground !== undefined, { type: "groundClearance", channel: "safety", role: "regularizer" }, weights.globalGround],
    [global.minPath, { type: "pathLength", channel: "regularity", role: "regularizer" }, weights.globalMinPath],
  ];
  const allSubjectIds = [...new Set(primitives.flatMap((primitive) => subjectIdsFromParameters(primitive.parameters)))];
  if (global.occlusion && allSubjectIds.length > 0) globalDescriptors.push([
    true,
    { type: "occlusion", channel: "safety", role: "regularizer", parameters: { subjectIds: allSubjectIds } },
    weights.globalOcclusion,
  ]);
  for (const [enabled, descriptor, weight] of globalDescriptors) {
    if (enabled) add(descriptor, 0, durationSeconds, "global", 1, undefined, weight);
  }

  primitives.sort((a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id));
  return { durationSeconds, primitives, conflicts, warnings: [...new Set(warnings)] };
}
