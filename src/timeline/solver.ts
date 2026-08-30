import {
  CameraMovementType,
  ComparisonOperator,
  ConstraintType,
  RelativeTimeReference,
} from "../types/enums";
import type {
  Action,
  ConstraintConfig,
  GeneralConstraintConfig,
  ActionConstraintConfig,
  InitCamera,
  RelativeTimeTrigger,
  Section,
  TriggerSpec,
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
import type { CameraConfig, CameraTargetDescriptor, Target } from "../types/camera";
import { validatePointConstraintEasing } from "./easing";
import { assertResolvedCameraDirection } from "../grounding/validation";
import { executeEnvironmentQuery } from "../environment/executor";
import type { EnvironmentV1 } from "../types/environment";

interface TimedAction extends Action {
  startTime?: number;
  duration?: number;
  endTime?: number;
}

function resolveAnchorTime(
  action: TimedAction,
  reference: RelativeTimeReference,
): number | undefined {
  switch (reference) {
    case RelativeTimeReference.Start:
      return action.startTime;
    case RelativeTimeReference.End:
      return action.endTime;
    case RelativeTimeReference.Middle:
      return (action.startTime !== undefined && action.endTime !== undefined)
        ? (action.startTime + action.endTime) / 2
        : undefined;
  }
}

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

function isIndependentTrigger(t: TriggerSpec): boolean {
  return "type" in t && (
    t.type === "absoluteTime" ||
    t.type === "distance" ||
    t.type === "velocity"
  );
}

function isRelativeTrigger(t: TriggerSpec): t is RelativeTimeTrigger {
  return "type" in t && t.type === "relativeTime";
}

function isEnvironmentEventTrigger(t: TriggerSpec): boolean {
  return "type" in t && (t.type === "distance" || t.type === "velocity");
}

function assignExplicitDuration(
  action: TimedAction,
  timelineEnd: number,
  fitToTimeline: boolean,
): boolean {
  if (action.startTime === undefined || action.movement.duration === undefined) {
    return false;
  }

  // The director cannot know when a scene event will occur. Once an event-
  // derived start is resolved, treat its requested duration as a maximum so
  // the action remains causal without extending beyond the playback clock.
  action.duration = fitToTimeline
    ? Math.min(action.movement.duration, Math.max(0, timelineEnd - action.startTime))
    : action.movement.duration;
  action.endTime = action.startTime + action.duration;
  return true;
}

function resolvedTargetId(target: CameraTargetDescriptor): string {
  if ("id" in target && typeof target.id === "string") return target.id;
  throw new Error("Environment event triggers require resolved target IDs");
}

function resolveEnvironmentEventSceneTime(
  action: Action,
  environment: EnvironmentV1,
): number {
  const t = action.trigger;
  if (!("type" in t)) return 0;

  switch (t.type) {
    case "distance": {
      if (
        t.operator !== ComparisonOperator.LessThan
        && t.operator !== ComparisonOperator.LessThanOrEqual
      ) {
        throw new Error(
          `Action ${JSON.stringify(action.id)} uses unsupported distance comparator ${t.operator}`,
        );
      }
      const result = executeEnvironmentQuery(environment, {
        type: "firstWithinDistance",
        subjectAId: resolvedTargetId(t.object1),
        subjectBId: resolvedTargetId(t.object2),
        distanceMeters: t.distance,
      });
      if (result.type !== "firstWithinDistance" || result.timeSeconds === null) {
        throw new Error(
          `Action ${JSON.stringify(action.id)}: distance trigger was never reached for `
          + `${resolvedTargetId(t.object1)} and `
          + `${resolvedTargetId(t.object2)} within 0..${environment.clock.durationSeconds}s`,
        );
      }
      return result.timeSeconds;
    }
    case "velocity": {
      if (
        t.operator !== ComparisonOperator.GreaterThan
        && t.operator !== ComparisonOperator.GreaterThanOrEqual
      ) {
        throw new Error(
          `Action ${JSON.stringify(action.id)} uses unsupported velocity comparator ${t.operator}`,
        );
      }
      if (t.direction !== undefined) {
        throw new Error(
          `Action ${JSON.stringify(action.id)} uses a directional velocity trigger, which is not supported`,
        );
      }
      const result = executeEnvironmentQuery(environment, {
        type: "firstSpeedReached",
        subjectId: resolvedTargetId(t.subject),
        speedMetersPerSecond: t.speed,
      });
      if (result.type !== "firstSpeedReached" || result.timeSeconds === null) {
        throw new Error(
          `Action ${JSON.stringify(action.id)}: velocity trigger was never reached for `
          + `${resolvedTargetId(t.subject)} within `
          + `0..${environment.clock.durationSeconds}s`,
        );
      }
      return result.timeSeconds;
    }
    default:
      throw new Error(`Action ${JSON.stringify(action.id)} is not an environment event`);
  }
}

// Helper: Find the longest sequential chain waiting after this action
function getSequentialChainDepth(actionId: string, allActions: Action[]): number {
  const sequentialChildren = allActions.filter(a =>
    isRelativeTrigger(a.trigger)
    && a.trigger.actionId === actionId
    && a.trigger.reference === RelativeTimeReference.End,
  );

  if (sequentialChildren.length === 0) return 0;

  // Return 1 + the max depth of any sequential branch
  return 1 + Math.max(...sequentialChildren.map(c => getSequentialChainDepth(c.id, allActions)));
}

// The Recursive Resolver
function resolveBranch(
  current: TimedAction,
  windowEnd: number,
  timelineEnd: number,
  fitExplicitDurationsToTimeline: boolean,
  state: Map<string, TimedAction>,
  allActions: Action[],
): void {
  if (current.duration === undefined) {
    if (!assignExplicitDuration(
      current,
      timelineEnd,
      fitExplicitDurationsToTimeline,
    )) {
      const available = windowEnd - current.startTime!;
      const chainDepth = getSequentialChainDepth(current.id, allActions);
      current.duration = Math.max(0, available / (chainDepth + 1));
      current.endTime = current.startTime! + current.duration;
    }
  }

  // Resolve every dependent action
  const dependents = allActions
    .map(a => state.get(a.id)!)
    .filter(a => isRelativeTrigger(a.trigger) && (a.trigger as RelativeTimeTrigger).actionId === current.id);

  // Now resolve all children
  for (const dep of dependents) {
    const trigger = dep.trigger as RelativeTimeTrigger;
    const anchor = resolveAnchorTime(current, trigger.reference);

    if (anchor !== undefined) {
      dep.startTime = anchor + trigger.offset;
      // Recurse: resolve this child's branch using the same window limit
      resolveBranch(
        dep,
        windowEnd,
        timelineEnd,
        fitExplicitDurationsToTimeline,
        state,
        allActions,
      );
    }
  }
}

function provisionalTimeWarp(
  allActions: Action[],
  independentStartTimes: ReadonlyMap<string, number>,
  playbackEnd: number,
  timelineEnd: number,
): TimeWarpSegment[] {
  const state = new Map<string, TimedAction>();
  for (const action of allActions) state.set(action.id, { ...action });

  const roots: TimedAction[] = [];
  for (const [actionId, startTime] of independentStartTimes) {
    if (startTime > playbackEnd + 1e-9) continue;
    const action = state.get(actionId);
    if (action === undefined) continue;
    action.startTime = startTime;
    roots.push(action);
  }
  roots.sort((a, b) => a.startTime! - b.startTime!);

  const groups: Array<{ startTime: number; actions: TimedAction[] }> = [];
  for (const root of roots) {
    const last = groups.at(-1);
    if (last && Math.abs(last.startTime - root.startTime!) < 1e-6) {
      last.actions.push(root);
    } else {
      groups.push({ startTime: root.startTime!, actions: [root] });
    }
  }

  for (let index = 0; index < groups.length; index += 1) {
    const group = groups[index]!;
    const windowEnd = groups[index + 1]?.startTime ?? playbackEnd;
    for (const root of group.actions) {
      resolveBranch(
        root,
        windowEnd,
        timelineEnd,
        isEnvironmentEventTrigger(root.trigger),
        state,
        allActions,
      );
    }
  }

  return [...state.values()]
    .filter((action) =>
      action.movement.relativeFPS !== undefined
      && action.startTime !== undefined
      && action.endTime !== undefined,
    )
    .map((action) => ({
      startTimePlayback: action.startTime!,
      endTimePlayback: action.endTime!,
      rate: SCENE_PLAYBACK_RATE[action.movement.relativeFPS!],
      label: action.movement.relativeFPS!,
    }))
    .sort((a, b) =>
      a.startTimePlayback - b.startTimePlayback
      || a.endTimePlayback - b.endTimePlayback,
    );
}

function sceneTimeAtPlayback(
  playbackTime: number,
  segments: readonly TimeWarpSegment[],
): number {
  const boundaries = [
    0,
    playbackTime,
    ...segments.flatMap((segment) => [
      segment.startTimePlayback,
      segment.endTimePlayback,
    ]),
  ]
    .filter((time) => time >= 0 && time <= playbackTime)
    .sort((a, b) => a - b)
    .filter((time, index, values) =>
      index === 0 || Math.abs(time - values[index - 1]!) > 1e-9,
    );

  let sceneTime = 0;
  for (let index = 0; index + 1 < boundaries.length; index += 1) {
    const start = boundaries[index]!;
    const end = boundaries[index + 1]!;
    const midpoint = (start + end) / 2;
    const active = segments.filter((segment) =>
      segment.startTimePlayback <= midpoint && midpoint < segment.endTimePlayback,
    );
    const rate = active.at(-1)?.rate ?? 1;
    sceneTime += (end - start) * rate;
  }
  return sceneTime;
}

function resolveIndependentTriggerOffsets(
  allActions: Action[],
  totalDuration: number,
  environment?: EnvironmentV1,
): Map<string, number> {
  const offsets = new Map<string, number>();
  const events: Array<{ action: Action; sceneTime: number }> = [];

  for (const action of allActions) {
    const trigger = action.trigger;
    if (!("type" in trigger)) continue;
    if (trigger.type === "absoluteTime") {
      offsets.set(action.id, trigger.time);
    } else if (trigger.type === "distance" || trigger.type === "velocity") {
      if (environment === undefined) {
        throw new Error(
          `Action ${JSON.stringify(action.id)} has an environment event trigger; pass the environment to solveTimeline()`,
        );
      }
      events.push({
        action,
        sceneTime: resolveEnvironmentEventSceneTime(action, environment),
      });
    }
  }

  events.sort((a, b) => a.sceneTime - b.sceneTime);
  for (let eventIndex = 0; eventIndex < events.length;) {
    const groupSceneTime = events[eventIndex]!.sceneTime;
    const group: typeof events = [];
    while (
      eventIndex < events.length
      && Math.abs(events[eventIndex]!.sceneTime - groupSceneTime) < 1e-7
    ) {
      group.push(events[eventIndex]!);
      eventIndex += 1;
    }

    const sceneTimeForCandidate = (playbackTime: number): number => sceneTimeAtPlayback(
      playbackTime,
      provisionalTimeWarp(allActions, offsets, playbackTime, totalDuration),
    );
    const availableSceneTime = sceneTimeForCandidate(totalDuration);
    if (availableSceneTime + 1e-7 < groupSceneTime) {
      throw new Error(
        `Environment event at scene time ${groupSceneTime.toFixed(6)}s is not reachable `
        + `within the ${totalDuration}s playback timeline`,
      );
    }

    let left = 0;
    let right = totalDuration;
    for (let iteration = 0; iteration < 70 && right - left > 1e-8; iteration += 1) {
      const middle = (left + right) / 2;
      if (sceneTimeForCandidate(middle) >= groupSceneTime) right = middle;
      else left = middle;
    }
    const fps = Math.max(1, environment?.clock.fpsHint ?? 24);
    // Quantize causally: an event action may start on the first frame after
    // the continuous threshold crossing, never on a frame where it is false.
    const continuousPlaybackTime = (left + right) / 2;
    const strictThreshold = group.some(({ action }) => {
      const trigger = action.trigger;
      return "type" in trigger && (
        (trigger.type === "distance" && trigger.operator === ComparisonOperator.LessThan)
        || (trigger.type === "velocity" && trigger.operator === ComparisonOperator.GreaterThan)
      );
    });
    const snappedPlaybackTime = Math.min(
      totalDuration,
      Math.max(
        0,
        Math.ceil((continuousPlaybackTime + (strictThreshold ? 1e-9 : -1e-9)) * fps) / fps,
      ),
    );
    for (const event of group) offsets.set(event.action.id, snappedPlaybackTime);
  }

  return offsets;
}

function resolveActionTimings(
  sections: Section[],
  totalDuration: number,
  environment?: EnvironmentV1,
): TimedAction[] {

  const allActions: Action[] = sections.flatMap(s => s.actions);
  const independentTriggerOffsets = resolveIndependentTriggerOffsets(
    allActions,
    totalDuration,
    environment,
  );
  const state = new Map<string, TimedAction>();
  for (const a of allActions) {
    state.set(a.id, { ...a });
  }

  // PASS 1: Apply absolute playback times and environment-event playback times.
  for (const a of state.values()) {
    if (isIndependentTrigger(a.trigger)) {
      a.startTime = independentTriggerOffsets.get(a.id);
    }
  }

  //   PASS 2 — estimate durations if possible
  for (const a of state.values()) {
    if (a.startTime === undefined) continue;
    assignExplicitDuration(
      a,
      totalDuration,
      isEnvironmentEventTrigger(a.trigger),
    );
  }

  //  PASS 3 — resolve relative startTimes

  let progress = true;

  while (progress) {
    progress = false;

    for (const a of state.values()) {

      if (a.startTime !== undefined) continue;
      if (!isRelativeTrigger(a.trigger)) continue;

      const ref = state.get(a.trigger.actionId);
      if (!ref) continue;

      const anchor = resolveAnchorTime(ref, a.trigger.reference);
      if (anchor === undefined) continue;

      a.startTime = anchor + a.trigger.offset;
      progress = true;
    }
  }

  // PASS 4 — Global Window Allocation

  const roots = Array.from(state.values())
    .filter(a => a.startTime !== undefined && !isRelativeTrigger(a.trigger))
    .sort((a, b) => a.startTime! - b.startTime!);
 
  interface RootGroup {
  startTime: number;
  actions: TimedAction[];
  }

  const groups: RootGroup[] = [];

  for (const root of roots) {

    const last = groups.at(-1);

    if (
      last &&
      Math.abs(last.startTime - root.startTime!) < 1e-6
    ) {
      last.actions.push(root);
    } else {
      groups.push({
        startTime: root.startTime!,
        actions: [root]
      });
    }
  }

  for (let i = 0; i < groups.length; i++) {

    const group = groups[i]!;

    const nextGroupStart =
      groups[i + 1]?.startTime;

    const windowEnd =
      nextGroupStart ?? totalDuration;

    for (const root of group.actions) {
      resolveBranch(
        root,
        windowEnd,
        totalDuration,
        isEnvironmentEventTrigger(root.trigger),
        state,
        allActions
      );
    }
  }

  const unresolved = [...state.values()].filter((action) =>
    action.startTime === undefined
    || action.endTime === undefined
    || !Number.isFinite(action.startTime)
    || !Number.isFinite(action.endTime),
  );
  if (unresolved.length > 0) {
    throw new Error(
      `Could not resolve timing for action(s): ${unresolved.map((action) => action.id).join(", ")}`,
    );
  }
  const outsideTimeline = [...state.values()].filter((action) =>
    action.startTime! < 0
    || action.endTime! < action.startTime!
    || action.endTime! > totalDuration + 1e-9,
  );
  if (outsideTimeline.length > 0) {
    throw new Error(
      `Action timing lies outside 0..${totalDuration}s: ${outsideTimeline.map((action) => action.id).join(", ")}`,
    );
  }

  return allActions.map(a => state.get(a.id)!);
}

// Building Constraints
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

  if (cfg.allFrames) {
    if (cfg.easing) {
      throw new Error("Point constraint easing can only be used when allFrames is false");
    }
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
  if (cfg.allFrames) {
    if (cfg.easing) throw new Error("Point constraint easing requires allFrames=false");
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
