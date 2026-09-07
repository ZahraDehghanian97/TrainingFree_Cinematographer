import {
  CameraMovementType,
  ConstraintType,
} from "../types/enums";
import type {
  ConstraintConfig,
  GeneralConstraintConfig,
  ActionConstraintConfig,
  InitCamera,
} from "../types/dsl";
import {
  LossFunctionType,
  type Constraint,
  type IntervalConstraint,
  type SinglePointConstraint,
  type SectionSolverOutput,
  type TimelineSolverOutput,
  type LossFunction,
  type TimeWarpSegment,
} from "../types/solver";
import type { CameraDirectionDSL } from "../types/dsl";
import {
  MOVEMENT_TO_LOSS,
  DEFAULT_DOLLY_DISTANCE,
  DEFAULT_ROTATION_ANGLE,
  DEFAULT_ARC_ANGLE,
  DEFAULT_ARC_RADIUS,
  SCENE_PLAYBACK_RATE,
} from "./constants";
import type { CameraConfig, Target } from "../types/camera";
import { validatePointConstraintEasing } from "./easing";
import { assertResolvedCameraDirection } from "../grounding/validation";
import { resolveActionTimings, type TimedAction } from "./timing";
import type { EnvironmentV1 } from "../types/environment";

export function solveTimeline(
  dsl: CameraDirectionDSL,
  environment?: EnvironmentV1,
): TimelineSolverOutput {
  assertResolvedCameraDirection(dsl);
  const sections: SectionSolverOutput[] = [];
  const totalDuration: number = dsl.totalDuration

  const allResolvedActions = resolveActionTimings(
    dsl.sections,
    totalDuration,
    environment,
  );

  let resolvedActions : TimedAction[] = []
  for (let i = 0; i < dsl.sections.length; i++) {
    const section = dsl.sections[i]!;

    resolvedActions = allResolvedActions.filter(a =>
    section.actions.some(sa => sa.id === a.id)
    );

    const initCameraStartTime =
    resolvedActions.length > 0
    ? Math.min(...resolvedActions.map(a => a.startTime!))
    : 0;

    // 3. Build constraints
    const initKeyframes: SinglePointConstraint[] = [
    buildInitialKeyframe(
    section.initCamera,
    initCameraStartTime
      ),
    ];


    sections.push({
      initKeyframes: initKeyframes,
      constraints: resolvedActions.flatMap(buildActionConstraints),
    });


  }
  
  const timeWarp: TimeWarpSegment[] = [];

  for (const action of allResolvedActions) {
    const label = action.movement.relativeFPS;
    if (
      label === undefined
      || action.startTime === undefined
      || action.endTime === undefined
      || !hasActionInterval(action)
    ) {
      continue;
    }

    timeWarp.push({
      startTimePlayback: action.startTime,
      endTimePlayback: action.endTime,
      rate: SCENE_PLAYBACK_RATE[label],
      label,
    });
  }

  timeWarp.sort((a, b) =>
    a.startTimePlayback - b.startTimePlayback
    || a.endTimePlayback - b.endTimePlayback
  );

  return { sections, timeWarp };
}

// Building Constraints
function hasActionInterval(action: TimedAction): boolean {
  return action.endTime! - action.startTime! > 1e-9;
}

function buildInitialKeyframe(init: InitCamera, time: number): SinglePointConstraint {
  return {
    type: "singlePoint",
    time: time,
    config: init.config,
    targets: init.targets,
    weight: 1
  };
}

function buildMovementLossParameters(
  action: TimedAction
): Record<string, unknown> {

  const p = action.movement.parameters ?? {};
  const targetParameters = buildTargetParameters(action.movement.targets);
  const generalParameters = {
    ...(action.movement.speedKeyframes ? { speedKeyframes: action.movement.speedKeyframes } : {}),
    ...(p.path ? { path: p.path } : {}),
    ...(p.curveIntensity === undefined ? {} : { curveIntensity: p.curveIntensity }),
    ...(p.allowSubjectIntersection === true ? { allowSubjectIntersection: true } : {}),
  };

  switch (action.movement.act) {

    case CameraMovementType.DollyIn:
    case CameraMovementType.DollyOut:
      return {
        distance: p.distance ?? DEFAULT_DOLLY_DISTANCE,
        ...targetParameters,
        ...generalParameters,
      };

    case CameraMovementType.TruckLeft:
    case CameraMovementType.TruckRight:
    case CameraMovementType.PedestalUp:
    case CameraMovementType.PedestalDown:
      return {
        ...(p.distance === undefined ? {} : { distance: p.distance }),
        ...generalParameters,
      };

    case CameraMovementType.Follow:
      return {
        distance: p.distance ?? DEFAULT_DOLLY_DISTANCE,
        ...targetParameters,
        ...(p.followDelay === undefined ? {} : { followDelay: p.followDelay }),
        ...(p.leadAmount === undefined ? {} : { leadAmount: p.leadAmount }),
        ...generalParameters,
      };

    case CameraMovementType.Track:
      return {
        ...targetParameters,
        ...(p.followDelay === undefined ? {} : { followDelay: p.followDelay }),
        ...(p.leadAmount === undefined ? {} : { leadAmount: p.leadAmount }),
        ...generalParameters,
      };

    case CameraMovementType.PanLeft:
    case CameraMovementType.PanRight:
    case CameraMovementType.TiltUp:
    case CameraMovementType.TiltDown:
    case CameraMovementType.DutchLeft:
    case CameraMovementType.DutchRight:
      return { rotationAngle: p.rotationAngle ?? DEFAULT_ROTATION_ANGLE, ...generalParameters };

    case CameraMovementType.ZoomIn:
    case CameraMovementType.ZoomOut:
      return { zoomFactor: p.zoomFactor ?? 1.5, ...generalParameters };

    case CameraMovementType.CraneUp:
    case CameraMovementType.CraneDown:
      return {
        heightChange: p.heightChange ?? p.distance ?? 2,
        horizontalDistance: p.horizontalDistance ?? 1,
        ...targetParameters,
        ...generalParameters,
      };

    case CameraMovementType.ArcLeft:
    case CameraMovementType.ArcRight:
    case CameraMovementType.Orbit: {
      const requestedArcAngle = p.arcAngle
        ?? (action.movement.act === CameraMovementType.Orbit ? 360 : DEFAULT_ARC_ANGLE);
      const arcAngleMagnitude = Math.abs(requestedArcAngle);
      return {
        arcAngle: action.movement.act === CameraMovementType.ArcRight
          ? arcAngleMagnitude
          : action.movement.act === CameraMovementType.ArcLeft
            ? -arcAngleMagnitude
            : requestedArcAngle,
        ...(p.arcRadius !== undefined
          ? { arcRadius: p.arcRadius }
          : action.movement.act === CameraMovementType.Orbit
            ? { arcRadius: DEFAULT_ARC_RADIUS }
            : {}),
        ...targetParameters,
        ...generalParameters,
      };
    }

    case CameraMovementType.Static:
      return targetParameters;

    default:
      return {};
  }
}

function buildTargetParameters(
  targets: Target[] = [],
): Record<string, unknown> {
  const targetIds = [...new Set(targets.map((target, index) => {
    const id = (target as Partial<Target>).id;
    if (typeof id !== "string" || !id.trim()) {
      throw new Error(
        `Unbound target at index ${index}; bind semantic CSL references before solving`,
      );
    }
    return id.trim();
  }))];
  return targetIds.length > 1
    ? { subjectIds: targetIds }
    : targetIds.length === 1
      ? { subjectId: targetIds[0] }
      : {};
}

export function buildCameraConfigLosses(
  config: CameraConfig,
  targets: Target[] = [],
): LossFunction[] {

  const losses: LossFunction[] = [];
  const targetParameters = buildTargetParameters(targets);

  if (config.type === "subjectAware") {

    if (config.shotSize)
      losses.push({
        type: LossFunctionType.ShotSize,
        parameters: { shotSize: config.shotSize, ...targetParameters }
      });

    if (config.subjectView)
      losses.push({
        type: LossFunctionType.SubjectView,
        parameters: { view: config.subjectView, ...targetParameters }
      });

    if (config.cameraAngle)
      losses.push({
        type: LossFunctionType.CameraVerticalAngle,
        parameters: { angle: config.cameraAngle, ...targetParameters }
      });

    if (config.subjectFraming?.position)
      losses.push({
        type: LossFunctionType.FramingPosition,
        parameters: { position: config.subjectFraming.position, ...targetParameters }
      });

    if (config.subjectFraming?.dutchAngleScale !== undefined)
      losses.push({
        type: LossFunctionType.FramingDutchAngle,
        parameters: {
          scale: config.subjectFraming.dutchAngleScale,
          ...targetParameters,
        }
      });

  }

  if (config.type === "nonSubjectAware") {

    losses.push({
      type: LossFunctionType.MinPath,
      parameters: {
        targetPose: config.extrinsics.pose,
        ...(config.extrinsics.transformMatrix
          ? { targetTransformMatrix: config.extrinsics.transformMatrix }
          : {}),
        ...(config.intrinsics ? { targetIntrinsics: config.intrinsics } : {}),
        ...(config.lookAt ? { lookAt: config.lookAt } : {}),
      }
    });

  }

  return losses;
}

function buildConstraintConfigEntries(
  cfg: ConstraintConfig,
  action: TimedAction,
): Constraint[] {

  const losses = buildCameraConfigLosses(cfg.config, cfg.targets).map((loss) => ({
    ...loss,
    sourceActionId: action.id,
    ...(action.priority === undefined ? {} : { priority: action.priority }),
  }));

  if (cfg.allFrames && cfg.easing) {
    throw new Error("Point constraint easing can only be used when allFrames is false");
  }
  if (cfg.allFrames && hasActionInterval(action)) {
    return losses.map(loss => ({
      type: "interval",
      startTime: action.startTime!,
      endTime: action.endTime!,
      lossFunction: loss,
      weight: 1,
    }));
  }

  validatePointConstraintEasing(cfg.easing);
  return [{
    type: "singlePoint",
    time: action.endTime!,
    config: cfg.config,
    ...(cfg.targets ? { targets: cfg.targets } : {}),
    weight: 1,
    ...(cfg.easing ? { easing: cfg.easing } : {}),
  }];
}

const GENERAL_CONSTRAINT_TO_LOSS: Record<ConstraintType, LossFunctionType> = {
  [ConstraintType.NoShake]: LossFunctionType.NoShake,
  [ConstraintType.KeepInFrame]: LossFunctionType.KeepInFrame,
  [ConstraintType.MaintainDistance]: LossFunctionType.MaintainDistance,
  [ConstraintType.MaintainAngle]: LossFunctionType.MaintainAngle,
  [ConstraintType.AvoidOcclusion]: LossFunctionType.AvoidOcclusion,
  [ConstraintType.GroundLevel]: LossFunctionType.GroundLevel,
};

function isGeneralConstraint(
  constraint: ActionConstraintConfig,
): constraint is GeneralConstraintConfig {
  return "kind" in constraint && constraint.kind === "general";
}

function buildGeneralConstraintEntries(
  cfg: GeneralConstraintConfig,
  action: TimedAction,
): Constraint[] {
  const lossType = GENERAL_CONSTRAINT_TO_LOSS[cfg.constraint];
  if (lossType === undefined) {
    throw new Error(`Unsupported general constraint: ${String(cfg.constraint)}`);
  }
  if (cfg.weight !== undefined && (!Number.isFinite(cfg.weight) || cfg.weight <= 0)) {
    throw new Error("General constraint weight must be positive and finite");
  }
  const loss: LossFunction = {
    type: lossType,
    parameters: {
      ...(cfg.parameters ?? {}),
      ...buildTargetParameters(cfg.targets),
    },
    sourceActionId: action.id,
    ...(action.priority === undefined ? {} : { priority: action.priority }),
  };
  const weight = cfg.weight ?? 1;
  if (cfg.allFrames && cfg.easing) throw new Error("Point constraint easing requires allFrames=false");
  if (cfg.allFrames && hasActionInterval(action)) {
    return [{
      type: "interval",
      startTime: action.startTime!,
      endTime: action.endTime!,
      lossFunction: loss,
      weight,
    }];
  }
  validatePointConstraintEasing(cfg.easing);
  return [{
    type: "lossPoint",
    time: action.endTime!,
    lossFunctions: [loss],
    weight,
    ...(cfg.easing ? { easing: cfg.easing } : {}),
  }];
}

function buildMovementConstraint(action: TimedAction): IntervalConstraint[] {
  // A clipped event at the playback endpoint has no time in which to move.
  // Its authored constraints still apply at that point.
  if (!hasActionInterval(action)) return [];
  const lossType = MOVEMENT_TO_LOSS[action.movement.act];
  if (!lossType) return [];

  return [{
    type: "interval",
    startTime: action.startTime!,
    endTime: action.endTime!,
    lossFunction: {
      type: lossType,
      parameters: buildMovementLossParameters(action),
      sourceActionId: action.id,
      ...(action.priority === undefined ? {} : { priority: action.priority }),
    },
    weight: 1,
  }];
}



function buildActionConstraints(
  action: TimedAction
): Constraint[] {
  return [
    ...buildMovementConstraint(action),
    ...(action.constraints ?? []).flatMap((cfg) =>
      isGeneralConstraint(cfg)
        ? buildGeneralConstraintEntries(cfg, action)
        : buildConstraintConfigEntries(cfg, action),
    ),
  ];
}
