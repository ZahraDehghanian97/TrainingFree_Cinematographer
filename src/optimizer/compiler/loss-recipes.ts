import { LossFunctionType } from "../../types/solver";
import {
  asVec3,
  finiteNumber,
  subjectIdsFromParameters,
} from "../shared/parameter-values";
import {
  FRAMING_TARGETS,
  SHOT_SIZE_COVERAGE,
  SUBJECT_VIEW_AZIMUTH_DEGREES,
  VERTICAL_ANGLE_DEGREES,
} from "./constants";
import { subjectParameters } from "./subjects";
import type { CompileBandContext, PrimitiveDescriptor } from "./types";
import { motionProgress } from "../shared/motion-profiles";

function movementFraction(context: CompileBandContext): number {
  const sourceDuration = context.sourceEndTime - context.sourceStartTime;
  return sourceDuration <= 1e-9 ? 1 : (context.endTime - context.startTime) / sourceDuration;
}

function translationRecipe(
  context: CompileBandContext,
  axis: "towardSubject" | "cameraRight" | "worldUp" | "cameraForward",
  sign: number,
  distance: number,
): PrimitiveDescriptor[] {
  const sourceDuration = Math.max(1e-9, context.sourceEndTime - context.sourceStartTime);
  const sourceStart = (context.startTime - context.sourceStartTime) / sourceDuration;
  const sourceEnd = (context.endTime - context.sourceStartTime) / sourceDuration;
  const fullTargetDistance = Math.abs(distance);
  const targetDistance = fullTargetDistance * (
    motionProgress(sourceEnd, context.loss.parameters.speedKeyframes)
    - motionProgress(sourceStart, context.loss.parameters.speedKeyframes)
  );
  const shared = {
    axis,
    sign,
    targetDistance,
    fullTargetDistance,
    referenceTime: context.sourceStartTime,
    motionStartTime: context.sourceStartTime,
    motionEndTime: context.sourceEndTime,
    ...(context.loss.parameters.speedKeyframes ? { speedKeyframes: context.loss.parameters.speedKeyframes } : {}),
    ...(context.loss.parameters.path ? { path: context.loss.parameters.path } : {}),
    ...(context.loss.parameters.curveIntensity === undefined
      ? {}
      : { curveIntensity: context.loss.parameters.curveIntensity }),
    ...(context.loss.parameters.allowSubjectIntersection === true
      ? { allowSubjectIntersection: true }
      : {}),
    ...subjectParameters(context.loss.parameters),
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

export function descriptorsForLoss(context: CompileBandContext): PrimitiveDescriptor[] {
  const { loss } = context;
  const p = loss.parameters;
  const subjects = subjectParameters(p);
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
      const sourceDuration = Math.max(1e-9, context.sourceEndTime - context.sourceStartTime);
      const sourceStart = (context.startTime - context.sourceStartTime) / sourceDuration;
      const sourceEnd = (context.endTime - context.sourceStartTime) / sourceDuration;
      const fullAngle = finiteNumber(p.arcAngle, 45) * Math.PI / 180;
      const angle = fullAngle * (
        motionProgress(sourceEnd, p.speedKeyframes)
        - motionProgress(sourceStart, p.speedKeyframes)
      );
      const radius = finiteNumber(p.arcRadius, Number.NaN);
      const shared = {
        targetDelta: angle,
        fullTargetDelta: fullAngle,
        motionStartTime: context.sourceStartTime,
        motionEndTime: context.sourceEndTime,
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
          parameters: {
            targetRadius: Number.isFinite(radius) ? radius : "initial",
            motionStartTime: context.sourceStartTime,
            motionEndTime: context.sourceEndTime,
            ...(p.speedKeyframes ? { speedKeyframes: p.speedKeyframes } : {}),
            ...subjects,
          },
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
        motionStartTime: context.sourceStartTime,
        motionEndTime: context.sourceEndTime,
        ...(p.speedKeyframes ? { speedKeyframes: p.speedKeyframes } : {}),
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
        {
          type: "screenPosition",
          channel: "composition",
          role: "primary",
          parameters: { target, ...subjects },
          weightScale: 3,
        },
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
      const lookAt = asVec3(p.lookAt);
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
