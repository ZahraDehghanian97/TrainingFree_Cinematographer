import {
  CameraMovementType,
  RelativeTimeReference,
} from "../types/enums";
import {
  Action,
  ConstraintConfig,
  InitCamera,
  Movement,
  RelativeTimeTrigger,
  Section,
  SpeedKeyframe,
  TriggerSpec,
} from "../types/dsl";
import {
  Constraint,
  IntervalConstraint,
  SinglePointConstraint,
  SectionSolverOutput,
  TimelineSolverOutput,
  LossFunction,
  LossFunctionType,
} from "../types/solver";
import { CameraDirectionDSL } from "../types/dsl";
import {
  MOVEMENT_TO_LOSS,
  DEFAULT_DISTANCE_TRIGGER_OFFSET,
  DEFAULT_VELOCITY_TRIGGER_OFFSET,
  DEFAULT_DOLLY_DISTANCE,
  DEFAULT_ROTATION_ANGLE,
  DEFAULT_ARC_ANGLE,
  DEFAULT_ARC_RADIUS,
} from "./constants";
import { CameraConfig } from "../types/camera";

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

export function solveTimeline(dsl: CameraDirectionDSL): TimelineSolverOutput {
  const sections: SectionSolverOutput[] = [];
  let currentOffset = 0;

  for (let i = 0; i < dsl.sections.length; i++) {
    const section = dsl.sections[i]!;

    // 1. Determine how much time this section gets from the remaining budget
    // Formula: Remaining Time / Remaining Sections
    const remainingSections = dsl.sections.length - i;
    const sectionDuration = (dsl.totalDuration - currentOffset) / remainingSections;
    const sectionEnd = currentOffset + sectionDuration;

    // 2. Resolve actions specifically within this section's "slice"
    const resolvedActions = resolveActionTimings(
      [section],
      sectionEnd, // The hard limit for these actions
      currentOffset,
    );

    // 3. Build constraints
    sections.push({
      initKeyframes: [buildInitialKeyframe(section.initCamera, currentOffset)],
      constraints: resolvedActions.flatMap(buildActionConstraints),
    });

    // 4. Move the offset to where this section actually ended
    // (Or where it was supposed to end, to prevent drift)
    currentOffset = sectionEnd;
  }

  return { sections };
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

function resolveIndependentTriggerOffset(t: TriggerSpec): number {
  if (!("type" in t)) return 0;

  switch (t.type) {
    case "absoluteTime": return t.time;
    case "distance": return DEFAULT_DISTANCE_TRIGGER_OFFSET;
    case "velocity": return DEFAULT_VELOCITY_TRIGGER_OFFSET;
    default: return 0;
  }
}
/*
function resolveTriggerTime(
  trigger: TriggerSpec,
  actionsById: Map<string, Action>,
  getOrResolve: (id: string) => TimedAction
): number {

  if ("type" in trigger) {
    if (trigger.type === "absoluteTime") return trigger.time;

    if (trigger.type === "relativeTime") {
      const referencedAction = getOrResolve(trigger.actionId);
      const anchorTime = resolveReferenceTime(referencedAction, trigger.reference);
      return anchorTime + trigger.offset;
    }
    if(trigger.type === "distance") return 5

    if(trigger.type === "velocity") return 3

    return 0;
  }

  if ("operator" in trigger) {
    const times = trigger.triggers.map(t => resolveTriggerTime(t, actionsById, getOrResolve));
    return trigger.operator === "and" ? Math.max(...times) : Math.min(...times);
  }

  return 0;
}
*/

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
  state: Map<string, TimedAction>,
  allActions: Action[],
): void {
  if (current.duration === undefined) {
    const available = windowEnd - current.startTime!;
    const chainDepth = getSequentialChainDepth(current.id, allActions);
    current.duration = Math.max(0, available / (chainDepth + 1));
    current.endTime = current.startTime! + current.duration;
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
      resolveBranch(dep, windowEnd, state, allActions);
    }
  }
}

function resolveActionTimings(
  sections: Section[],
  sectionEnd: number, // This is the section's end time (e.g., 12s)
  sectionOffset: number, // This is the section's start time (e.g., 0s)
): TimedAction[] {

  const allActions: Action[] = sections.flatMap(s => s.actions);
  const state = new Map<string, TimedAction>();
  for (const a of allActions) {
    state.set(a.id, { ...a });
  }

  // PASS 1: Apply offset to absolute triggers
  for (const a of state.values()) {
    if (isIndependentTrigger(a.trigger)) {
      // Scale absolute time to fit within the section offset
      // If absolute time is 0, it starts at sectionOffset
      a.startTime = sectionOffset + resolveIndependentTriggerOffset(a.trigger);
    }
  }

  //   PASS 2 — estimate durations if possible
  for (const a of state.values()) {
    if (a.startTime === undefined) continue;
    if (a.movement.duration !== undefined) {
      a.duration = a.movement.duration;
      a.endTime = a.startTime + a.duration;
    }
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

  // console.log("PASS 4 begins:");
  const roots = Array.from(state.values())
    .filter(a => a.startTime !== undefined && !isRelativeTrigger(a.trigger))
    .sort((a, b) => a.startTime! - b.startTime!);

  for (let i = 0; i < roots.length; i++) {
    const root = roots[i]!;
    const nextRootStart = roots[i + 1]?.startTime;
    const windowEnd = nextRootStart ?? sectionEnd;
    resolveBranch(root, windowEnd, state, allActions);
  }

  return allActions.map(a => state.get(a.id)!);
}

function degreesToDistance(deg: number, radius = 1): number {
  // Degree to distance conversion using radian
  return (deg * Math.PI / 180) * radius;
}

function estimateDistance(m: Movement): number {
  const p = m.parameters ?? {};

  switch (m.act) {
    case CameraMovementType.PanLeft:
    case CameraMovementType.PanRight:
    case CameraMovementType.TiltUp:
    case CameraMovementType.TiltDown:
      return degreesToDistance(p.rotationAngle ?? 30);

    case CameraMovementType.DollyIn:
    case CameraMovementType.DollyOut:
    case CameraMovementType.TruckLeft:
    case CameraMovementType.TruckRight:
    case CameraMovementType.PedestalUp:
    case CameraMovementType.PedestalDown:
      return p.distance ?? 2;

    case CameraMovementType.ArcLeft:
    case CameraMovementType.ArcRight:
      return degreesToDistance(
        p.arcAngle ?? 45,
        p.arcRadius ?? 2
      );

    // Case: ZoomIn/out
    // Case: Crane

    default:
      return 1;
  }
}

function averageSpeedMultiplier(
  keyframes?: SpeedKeyframe[]
): number {
  if (!keyframes || keyframes.length === 0) return 1;

  let total = 0;
  let lastT = 0;

  const sorted = [...keyframes].sort(
    (a, b) => a.normalizedTime - b.normalizedTime
  );

  for (const kf of sorted) {
    const dt = kf.normalizedTime - lastT;
    total += dt * kf.speedMultiplier;
    lastT = kf.normalizedTime;
  }

  total += (1 - lastT) * sorted.at(-1)!.speedMultiplier;
  return total;
}

function estimateDuration(initCamera: InitCamera, action: Action): number | undefined {
  if (action.movement.duration !== undefined) return action.movement.duration;

  //else if(action.movement.parameters){
  // We have formula: (distance / (speed * speedMultiplier))
  // const distance = estimateDistance(action.movement);
  //const baseSpeed = BASE_SPEED[action.movement.act] ?? 1;
  //const speedMultiplier = averageSpeedMultiplier(action.movement.speedKeyframes);

  //return (distance / (baseSpeed * speedMultiplier));
  //}


  return undefined


}

// Building Constraints
function buildInitialKeyframe(init: InitCamera, time: number): SinglePointConstraint {
  return {
    type: "singlePoint",
    time: time,
    config: init.config,
    weight: 1
  };
}

function buildMovementLossParameters(
  action: TimedAction
): Record<string, unknown> {

  const p = action.movement.parameters ?? {};

  switch (action.movement.act) {

    case CameraMovementType.DollyIn:
    case CameraMovementType.DollyOut:
    case CameraMovementType.Follow:
      return { distance: p.distance ?? DEFAULT_DOLLY_DISTANCE };

    case CameraMovementType.PanLeft:
    case CameraMovementType.PanRight:
      return { rotationAngle: p.rotationAngle ?? DEFAULT_ROTATION_ANGLE };

    case CameraMovementType.ArcLeft:
    case CameraMovementType.ArcRight:
    case CameraMovementType.Orbit:
      return {
        arcAngle: p.arcAngle ?? DEFAULT_ARC_ANGLE,
        arcRadius: p.arcRadius ?? DEFAULT_ARC_RADIUS,
      };

    default:
      return {};
  }
}

export function buildCameraConfigLosses(
  config: CameraConfig
): LossFunction[] {

  const losses: LossFunction[] = [];

  if (config.type === "subjectAware") {

    if (config.shotSize)
      losses.push({
        type: LossFunctionType.ShotSize,
        parameters: { shotSize: config.shotSize }
      });

    if (config.subjectView)
      losses.push({
        type: LossFunctionType.SubjectView,
        parameters: { view: config.subjectView }
      });

    if (config.subjectFraming?.position)
      losses.push({
        type: LossFunctionType.FramingPosition,
        parameters: { position: config.subjectFraming.position }
      });
  }

  if (config.type === "nonSubjectAware") {

    losses.push({
      type: LossFunctionType.MinPath,
      parameters: { targetPose: config.extrinsics.pose }
    });

  }

  return losses;
}

function buildConstraintConfigEntries(
  cfg: ConstraintConfig,
  action: TimedAction,
): Constraint[] {

  const losses = buildCameraConfigLosses(cfg.config);

  if (cfg.allFrames) {
    return losses.map(loss => ({
      type: "interval",
      startTime: action.startTime!,
      endTime: action.endTime!,
      lossFunction: loss,
      weight: 1,
    }));
  }

  return [{
    type: "singlePoint",
    time: action.endTime!,
    config: cfg.config,
    weight: 1,
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
      parameters: buildMovementLossParameters(action)
    },
    weight: 1,
  }];
}



function buildActionConstraints(
  action: TimedAction
): (SinglePointConstraint | IntervalConstraint)[] {
  return [
    // Other Constraint builders must be implemented
    ...buildMovementConstraint(action),
    ...(action.constraints ?? []).flatMap(cfg => buildConstraintConfigEntries(cfg, action)),
  ];
}
