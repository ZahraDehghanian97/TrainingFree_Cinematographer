import { LossFunctionType } from "../../types/solver";
import {
  asVec3,
  poseFromTransformMatrix,
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

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function motionParameters(context: CompileBandContext): Record<string, unknown> {
  return {
    referenceTime: context.sourceStartTime,
    motionStartTime: context.sourceStartTime,
    motionEndTime: context.sourceEndTime,
    ...(context.loss.parameters.speedKeyframes
      ? { speedKeyframes: context.loss.parameters.speedKeyframes }
      : {}),
  };
}

function movementFraction(context: CompileBandContext): number {
  const duration = context.sourceEndTime - context.sourceStartTime;
  if (duration <= 1e-9) return 1;
  return motionProgress(
    (context.endTime - context.sourceStartTime) / duration,
    context.loss.parameters.speedKeyframes,
  ) - motionProgress(
    (context.startTime - context.sourceStartTime) / duration,
    context.loss.parameters.speedKeyframes,
  );
}

function distanceParameters(context: CompileBandContext, value: unknown): Record<string, unknown> {
  const distance = optionalNumber(value);
  return {
    ...motionParameters(context),
    ...(distance === undefined ? {} : {
      targetDistance: Math.abs(distance) * movementFraction(context),
      fullTargetDistance: Math.abs(distance),
    }),
  };
}

function angleParameters(context: CompileBandContext, degrees: number | undefined): Record<string, unknown> {
  return {
    ...motionParameters(context),
    ...(degrees === undefined ? {} : {
      targetDelta: degrees * Math.PI / 180 * movementFraction(context),
      fullTargetDelta: degrees * Math.PI / 180,
    }),
  };
}

function translationRecipe(
  context: CompileBandContext,
  axis: "towardSubject" | "cameraRight" | "worldUp" | "cameraForward",
  sign: number,
  distance: unknown,
): PrimitiveDescriptor[] {
  const curveIntensity = optionalNumber(context.loss.parameters.curveIntensity);
  const path = context.loss.parameters.path
    ?? (curveIntensity === undefined ? undefined : curveIntensity > 0 ? "curved" : "linear");
  const shared = {
    axis,
    sign,
    ...distanceParameters(context, distance),
    ...(path === undefined ? {} : { path }),
    ...(context.loss.parameters.curveIntensity === undefined
      ? {}
      : { curveIntensity: context.loss.parameters.curveIntensity }),
    ...(context.loss.parameters.allowSubjectIntersection === true
      ? { allowSubjectIntersection: true }
      : {}),
    ...subjectParameters(context.loss.parameters),
  };
  const shapeDescriptors: PrimitiveDescriptor[] = path === "curved" || path === "spline"
    ? [{ type: "pathProfile", channel: "position", role: "stabilizer", parameters: shared }]
    : path === "linear" || path === "straight" ? [{
        type: "orthogonalDrift",
        channel: "position",
        role: "stabilizer",
        parameters: shared,
        // A straight move is a geometric promise. Give it enough authority to
        // resist the small per-sample cross-talk introduced by SPSA.
        weightScale: 4,
        tolerance: 0.02,
      }] : [];
  return [
    { type: "axisProgress", channel: "position", role: "primary", parameters: shared },
    { type: "totalProgressTarget", channel: "position", role: "primary", parameters: shared },
    ...shapeDescriptors,
    ...(context.loss.parameters.speedKeyframes ? [{
      type: "stepPacing", channel: "regularity", role: "stabilizer", parameters: shared, weightScale: 1.2,
    } as PrimitiveDescriptor] : []),
    { type: "stepSmoothness", channel: "regularity", role: "stabilizer", parameters: shared, weightScale: 1.2 },
    // These references are solved camera states, so their absolute lens and
    // roll values remain free while the rig stays steady during translation.
    { type: "fovHold", channel: "intrinsics", role: "stabilizer", weightScale: 2 },
    {
      type: "rollHold",
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
  const requested = optionalNumber(context.loss.parameters.rotationAngle);
  const shared = {
    mode,
    sign,
    ...angleParameters(context, requested === undefined ? undefined : sign * Math.abs(requested)),
  };
  return [
    { type: "angularProgress", channel: "rotation", role: "primary", parameters: shared },
    { type: "angularDirection", channel: "rotation", role: "primary", parameters: shared, weightScale: 0.7 },
    ...(context.loss.parameters.speedKeyframes ? [{
      type: "angularPacing", channel: "regularity", role: "stabilizer", parameters: shared, weightScale: 0.65,
    } as PrimitiveDescriptor] : []),
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
    // Subject identity is intent even when every camera property is omitted.
    // The centralized quality pass applies only its soft fallback preferences.
    case LossFunctionType.SubjectPresence:
      return [];
    case LossFunctionType.DollyInMovement:
      return translationRecipe(context, "cameraForward", 1, p.distance);
    case LossFunctionType.DollyOutMovement:
      return translationRecipe(context, "cameraForward", -1, p.distance);
    case LossFunctionType.TruckLeftMovement:
      return translationRecipe(context, "cameraRight", -1, p.distance);
    case LossFunctionType.TruckRightMovement:
      return translationRecipe(context, "cameraRight", 1, p.distance);
    case LossFunctionType.PedestalUpMovement:
      return translationRecipe(context, "worldUp", 1, p.distance);
    case LossFunctionType.PedestalDownMovement:
      return translationRecipe(context, "worldUp", -1, p.distance);
    case LossFunctionType.CraneUpMovement:
    case LossFunctionType.CraneDownMovement: {
      const sign = loss.type === LossFunctionType.CraneUpMovement ? 1 : -1;
      const vertical = {
        axis: "worldUp",
        sign,
        ...distanceParameters(context, p.heightChange),
        ...subjects,
      };
      const horizontal = {
        axis: "cameraForward",
        sign: 1,
        ...distanceParameters(context, p.horizontalDistance),
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
        ...(p.speedKeyframes ? [
          { type: "stepPacing", channel: "regularity", role: "stabilizer", parameters: vertical, weightScale: 0.6 },
          { type: "stepPacing", channel: "regularity", role: "stabilizer", parameters: horizontal, weightScale: 0.6 },
        ] as PrimitiveDescriptor[] : []),
        { type: "stepSmoothness", channel: "regularity", role: "stabilizer", parameters: vertical, weightScale: 0.45 },
        { type: "rollHold", channel: "rotation", role: "stabilizer" },
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
      const angle = optionalNumber(p.rotationAngle);
      const shared = {
        sign,
        ...angleParameters(context, angle === undefined ? undefined : sign * Math.abs(angle)),
      };
      return [
        { type: "rollProgress", channel: "rotation", role: "primary", parameters: shared },
        { type: "angularDirection", channel: "rotation", role: "primary", parameters: { mode: "roll", ...shared } },
        ...(p.speedKeyframes ? [{
          type: "angularPacing", channel: "regularity", role: "stabilizer", parameters: { mode: "roll", ...shared },
        } as PrimitiveDescriptor] : []),
        { type: "positionHold", channel: "position", role: "stabilizer" },
        { type: "forwardHold", channel: "rotation", role: "stabilizer" },
      ];
    }
    case LossFunctionType.ArcMovement: {
      const angle = optionalNumber(p.arcAngle);
      const radius = optionalNumber(p.arcRadius);
      const requestedSign = optionalNumber(p.sign);
      const sign = requestedSign === undefined
        ? angle === undefined || angle === 0 ? undefined : Math.sign(angle)
        : Math.sign(requestedSign);
      const shared = {
        ...angleParameters(context, angle),
        ...(sign === undefined ? {} : { sign }),
        ...subjects,
      };
      return [
        { type: "planeHold", channel: "position", role: "primary", parameters: { plane: "subjectHorizontal", ...subjects } },
        {
          type: "radiusHold",
          channel: "subjectRelative",
          role: "primary",
          parameters: {
            ...(radius === undefined ? {} : { targetRadius: radius }),
            ...motionParameters(context),
            ...subjects,
          },
        },
        { type: "angularProgress", channel: "subjectRelative", role: "primary", parameters: { mode: "orbit", ...shared } },
        { type: "angularDirection", channel: "subjectRelative", role: "primary", parameters: { mode: "orbit", ...shared } },
        ...(p.speedKeyframes ? [{
          type: "angularPacing", channel: "regularity", role: "stabilizer", parameters: { mode: "orbit", ...shared },
        } as PrimitiveDescriptor] : []),
        { type: "rollHold", channel: "rotation", role: "stabilizer" },
      ];
    }
    case LossFunctionType.ZoomIn:
    case LossFunctionType.ZoomOut: {
      const zoomIn = loss.type === LossFunctionType.ZoomIn;
      const factor = optionalNumber(p.zoomFactor);
      const shared = {
        ...motionParameters(context),
        ...(factor === undefined ? {} : {
          factor: Math.pow(factor, movementFraction(context)),
          fullFactor: factor,
        }),
        direction: zoomIn ? "in" : "out",
      };
      return [
        {
          type: "intrinsicsProgress",
          channel: "intrinsics",
          role: "primary",
          parameters: shared,
        },
        ...(p.speedKeyframes ? [{
          type: "intrinsicsPacing",
          channel: "regularity",
          role: "stabilizer",
          parameters: shared,
        } as PrimitiveDescriptor] : []),
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
        ...(p.followDelay === undefined ? {} : { followDelay: p.followDelay }),
        ...(p.leadAmount === undefined ? {} : { leadAmount: p.leadAmount }),
        ...motionParameters(context),
      };
      return [
        { type: "relativeOffsetHold", channel: "subjectRelative", role: "primary", parameters: follow },
        ...(optionalNumber(p.distance) === undefined ? [] : [{
          type: "distanceHold", channel: "subjectRelative", role: "primary", parameters: { ...follow, distance: p.distance },
        } as PrimitiveDescriptor]),
        { type: "velocityMatch", channel: "subjectRelative", role: "primary", parameters: follow },
        { type: "rollHold", channel: "rotation", role: "stabilizer" },
      ];
    }
    case LossFunctionType.TrackMovement: {
      const track = {
        ...subjects,
        ...(p.distance === undefined ? {} : { distance: p.distance }),
        ...(p.followDelay === undefined ? {} : { followDelay: p.followDelay }),
        ...(p.leadAmount === undefined ? {} : { leadAmount: p.leadAmount }),
        ...motionParameters(context),
      };
      return [
        { type: "distanceHold", channel: "subjectRelative", role: "primary", parameters: track },
        { type: "velocityMatch", channel: "subjectRelative", role: "stabilizer", parameters: track },
        { type: "rollHold", channel: "rotation", role: "stabilizer" },
      ];
    }
    case LossFunctionType.FramingPosition: {
      const target = typeof p.position === "string" ? FRAMING_TARGETS[p.position] : undefined;
      if (!target) return [];
      return [
        {
          type: "screenPosition",
          channel: "composition",
          role: "primary",
          parameters: { target, ...subjects },
          weightScale: 3,
        },
      ];
    }
    case LossFunctionType.FramingDutchAngle: {
      const requested = optionalNumber(p.scale);
      if (requested === undefined) return [];
      const scale = Math.max(0, Math.min(10, requested));
      return [{
        type: "rollTarget",
        channel: "rotation",
        role: "primary",
        parameters: { targetRoll: scale / 10 * Math.PI / 6, ...subjects },
      }];
    }
    case LossFunctionType.ShotSize: {
      const coverage = typeof p.shotSize === "string" ? SHOT_SIZE_COVERAGE[p.shotSize] : undefined;
      if (coverage === undefined) return [];
      return [
        {
          type: "screenScale",
          channel: "composition",
          role: "primary",
          parameters: { targetCoverage: coverage, ...subjects },
        },
      ];
    }
    case LossFunctionType.SubjectView: {
      const azimuth = typeof p.view === "string" ? SUBJECT_VIEW_AZIMUTH_DEGREES[p.view] : undefined;
      if (azimuth === undefined) return [];
      return [{
        type: "subjectView",
        channel: "subjectRelative",
        role: "primary",
        parameters: { targetAzimuth: azimuth * Math.PI / 180, ...subjects },
      }];
    }
    case LossFunctionType.CameraVerticalAngle: {
      const elevation = typeof p.angle === "string" ? VERTICAL_ANGLE_DEGREES[p.angle] : undefined;
      if (elevation === undefined) return [];
      return [
        {
          type: "subjectElevation",
          channel: "subjectRelative",
          role: "primary",
          parameters: { targetElevation: elevation * Math.PI / 180, ...subjects },
        },
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
      const pose = p.targetTransformMatrix === undefined
        ? p.targetPose as Record<string, unknown> | undefined
        : poseFromTransformMatrix(p.targetTransformMatrix);
      const hasCameraConfig = [
        "targetPose", "targetTransformMatrix", "targetIntrinsics", "lookAt",
      ].some((key) => Object.prototype.hasOwnProperty.call(p, key));
      if (!hasCameraConfig) return [{ type: "pathLength", channel: "regularity", role: "regularizer" }];
      const descriptors: PrimitiveDescriptor[] = [];
      if (pose?.position) descriptors.push({
        type: "positionAnchor",
        channel: "position",
        role: "primary",
        parameters: { target: pose.position },
      });
      if (pose?.rotation) descriptors.push({
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
