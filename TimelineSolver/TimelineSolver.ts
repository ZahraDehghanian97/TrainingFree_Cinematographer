import { log } from "console";
import { Action, CameraConfig, CameraDirectionDSL, CameraMovementType, ConstraintConfig, InitCamera, IntervalConstraint, LossFunction, LossFunctionType, Movement, NormalizedTimeline, RelativeFPS, RelativeTimeReference, RelativeTimeTrigger, Section, SectionSolverOutput, SinglePointConstraint, SpeedKeyframe, TimelineSegment, TimelineSolverOutput, TriggerSpec } from "../CSL";
import { promptExamples } from "../CSL";
import * as util from "util";
import * as fs from 'fs';


interface TimedAction extends Action {
  startTime?: number;
  duration?: number;
  endTime?: number;
}

const BASE_SPEED: Record<CameraMovementType, number> = {
  // Some default speed values taken from Chat-GPT
  dollyIn: 1.0,
  dollyOut: 1.0,
  panLeft: 0.6,
  panRight: 0.6,
  tiltUp: 0.5,
  tiltDown: 0.5,
  truckLeft: 0.9,
  truckRight: 0.9,
  pedestalUp: 0.7,
  pedestalDown: 0.7,
  arcLeft: 0.4,
  arcRight: 0.4,
  zoomIn: 0.8,
  zoomOut: 0.8,
  static: Infinity,
  follow: 1.0,
  track: 1.0,
  orbit: 0.3,
  craneUp: 0.6,
  craneDown: 0.6,
  dutchLeft: 0.4,
  dutchRight: 0.4
};

const LOSS_MAP: Partial<Record<CameraMovementType, LossFunctionType>> = {
    // Probably must change act from CameraMovementType to string 
    [CameraMovementType.DollyIn]: LossFunctionType.DollyMovement,
    [CameraMovementType.DollyOut]: LossFunctionType.DollyMovement,
    [CameraMovementType.Follow]: LossFunctionType.FollowMovement, // Must be checked
    [CameraMovementType.ZoomIn]: LossFunctionType.DollyMovement, // Must be checked
    [CameraMovementType.ZoomOut]: LossFunctionType.DollyMovement, // Must be checked
    [CameraMovementType.PanLeft]: LossFunctionType.PanMovement,
    [CameraMovementType.PanRight]: LossFunctionType.PanMovement,
    [CameraMovementType.TiltUp]: LossFunctionType.TiltMovement,
    [CameraMovementType.TiltDown]: LossFunctionType.TiltMovement,
    [CameraMovementType.TruckLeft]: LossFunctionType.TruckMovement,
    [CameraMovementType.TruckRight]: LossFunctionType.TruckMovement,
    [CameraMovementType.PedestalUp]: LossFunctionType.PedestalMovement,
    [CameraMovementType.PedestalDown]: LossFunctionType.PedestalMovement,
    [CameraMovementType.ArcLeft]: LossFunctionType.ArcMovement,
    [CameraMovementType.ArcRight]: LossFunctionType.ArcMovement,
    [CameraMovementType.Orbit]: LossFunctionType.ArcMovement, // Must be checked
    [CameraMovementType.Track]: LossFunctionType.DollyMovement, // Must be checked
    [CameraMovementType.Static]: LossFunctionType.Static, // Must be checked
    
  };

  const FPS_WEIGHTS: Record<string, number> = {
  frozen: 5.0,
  verySlow: 3.0,
  slow: 2.0,
  normal: 1.0,
  fast: 0.5,
  veryFast: 0.2,
};


function indexActions(actions: Action[]): Map<string, Action> {
  const map = new Map<string, Action>();

  for (const action of actions) {
    if (map.has(action.id)) {
      throw new Error(`Duplicate action id: ${action.id}`);
    }
    map.set(action.id, action);
  }

  return map;
}

function tryResolveReferenceTime(
  action: TimedAction,
  reference: RelativeTimeReference
): number | undefined {

  switch (reference) {

    case RelativeTimeReference.Start:
      return action.startTime;

    case RelativeTimeReference.End:
      return action.endTime;

    case RelativeTimeReference.Middle:
      if (
        action.startTime !== undefined &&
        action.endTime !== undefined
      )
        return (action.startTime + action.endTime) / 2;

      return undefined;
  }
}

export function solveTimeline(input_dsl: CameraDirectionDSL): TimelineSolverOutput {

const sectionOutputs: SectionSolverOutput[] = [];
  let currentOffset = 0;
  const totalGlobalDuration = input_dsl.totalDuration;

  for (let i = 0; i < input_dsl.sections.length; i++) {
    const section = input_dsl.sections[i]!;
    
    // 1. Determine how much time this section gets from the remaining budget
    // Formula: Remaining Time / Remaining Sections
    const remainingSections = input_dsl.sections.length - i;
    const remainingBudget = totalGlobalDuration - currentOffset;
    const sectionDuration = remainingBudget / remainingSections;
    const sectionEnd = currentOffset + sectionDuration;

    // 2. Resolve actions specifically within this section's "slice"
    const resolvedActions = resolveActionTimings(
      [section], 
      sectionEnd, // The hard limit for these actions
      currentOffset
    );

    // 3. Build constraints
    const initKeyframes = [buildInitialKeyframe(section.initCamera, currentOffset)];
    const constraints = resolvedActions.flatMap(a => buildActionConstraints(a));

    sectionOutputs.push({ initKeyframes, constraints });

    // 4. Move the offset to where this section actually ended
    // (Or where it was supposed to end, to prevent drift)
    currentOffset = sectionEnd; 
  }

  return { sections: sectionOutputs };
}

function isInterval(
  c: SinglePointConstraint | IntervalConstraint
): c is IntervalConstraint {
  return c.type === "interval";
}

function isIndependentTrigger(t: TriggerSpec) {
  return "type" in t && (
    t.type === "absoluteTime" ||
    t.type === "distance" ||
    t.type === "velocity"
  );
}
function isRelativeTrigger(t: TriggerSpec): t is RelativeTimeTrigger {
  return "type" in t && t.type === "relativeTime";
}

function resolveIndependentTrigger(t: TriggerSpec): number {
  if (!("type" in t)) return 0;

  if (t.type === "absoluteTime") return t.time;
  
  if(t.type === "distance") return 5
    
  if(t.type === "velocity") return 3
  
  return 0;
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
function normalizeConstraints(
  constraints: (SinglePointConstraint | IntervalConstraint)[]
): TimelineSegment[] {

  const boundaries = new Set<number>();

  // Collect all time boundaries
  for (const c of constraints) {
    if (c.type === "interval") {
      boundaries.add(c.startTime);
      boundaries.add(c.endTime);
    } else {
      boundaries.add(c.time);
    }
  }

  const sorted = Array.from(boundaries).sort((a, b) => a - b);

  const timeline: TimelineSegment[] = [];

  // Build interval segments
  for (let i = 0; i < sorted.length - 1; i++) {
    const start = sorted[i]!;
    const end = sorted[i + 1]!;

    const activeLosses = constraints
    .filter(isInterval)
    .filter(iv => iv.startTime < end && iv.endTime > start)
    .map(iv => iv.lossFunction);

    //console.log("active losses:", activeLosses);
    
    if (activeLosses.length > 0) {
      timeline.push({
        kind: "interval",
        startTime: start,
        endTime: end,
        lossFunctions: activeLosses
      });
    }
  }

  // Insert point segments 
  for (const c of constraints) {
    if (c.type === "singlePoint") {
      timeline.push({
        kind: "point",
        time: c.time,
        lossFunctions: buildCameraConfigLosses(c.config)
      });
    }
  }

  // Final sort 
  timeline.sort((a, b) => {
    const ta = a.kind === "interval" ? a.startTime : a.time;
    const tb = b.kind === "interval" ? b.startTime : b.time;

    if (ta !== tb) return ta - tb;

    // If same time → point comes first
    if (a.kind === "point" && b.kind === "interval") return -1;
    if (a.kind === "interval" && b.kind === "point") return 1;

    return 0;
  });

  return timeline;
}


function normalizeTimeline(inputTimeLine: TimelineSolverOutput) : NormalizedTimeline{

  
  const allConstraints: (SinglePointConstraint | IntervalConstraint)[] = [];

  for (const section of inputTimeLine.sections) {

    allConstraints.push(...section.constraints);

    for (const keyframe of section.initKeyframes) {
      allConstraints.push(keyframe)
    }
  }

  const normalized = normalizeConstraints(allConstraints);

  return normalized;
  
}


// Helper: Find the longest sequential chain waiting after this action
function getSequentialDepth(actionId: string, allActions: Action[]): number {
  const children = allActions.filter(a => 
    isRelativeTrigger(a.trigger) && a.trigger.actionId === actionId
  );
  
  const sequentialChildren = children.filter(c => 
    (c.trigger as RelativeTimeTrigger).reference === RelativeTimeReference.End
  );

  if (sequentialChildren.length === 0) return 0;

  // Return 1 + the max depth of any sequential branch
  return 1 + Math.max(...sequentialChildren.map(c => getSequentialDepth(c.id, allActions)));
}

// The Recursive Resolver
function resolveBranch(
  current: TimedAction, 
  windowEnd: number, 
  state: Map<string, TimedAction>, 
  allActions: Action[]
) {
  // Find all actions depending on this one
  const deps = allActions.map(a => state.get(a.id)!).filter(a => 
    isRelativeTrigger(a.trigger) && a.trigger.actionId === current.id
  );

  if (current.duration === undefined) {
    const available = windowEnd - current.startTime!;
    const seqDepth = getSequentialDepth(current.id, allActions);
    
    // Allocate duration: Split available time by (1 + depth of sequential chain)
    // Formula: Duration = Available / (Sequential Steps + 1)
    current.duration = Math.max(0, available / (seqDepth + 1));
    current.endTime = current.startTime! + current.duration;
  }

  // Now resolve all children
  for (const dep of deps) {
    const trigger = dep.trigger as RelativeTimeTrigger;
    const anchor = tryResolveReferenceTime(current, trigger.reference);

    if (anchor !== undefined) {
      dep.startTime = anchor + trigger.offset;
      // Recurse: resolve this child's branch using the same window limit
      resolveBranch(dep, windowEnd, state, allActions);
    }
  }
}

function resolveActionTimings(
  sections: Section[],
  limitTime: number, // This is the section's end time (e.g., 12s)
  sectionOffset: number // This is the section's start time (e.g., 0s)
): TimedAction[] {
  
  const allActions: Action[] = sections.flatMap(s => s.actions);
  const state = new Map<string, TimedAction>();
  for (const a of allActions) state.set(a.id, { ...a });

  // PASS 1: Apply offset to absolute triggers
  for (const a of state.values()) {
    if (isIndependentTrigger(a.trigger)) {
      // Scale absolute time to fit within the section offset
      // If absolute time is 0, it starts at sectionOffset
      a.startTime = sectionOffset + resolveIndependentTrigger(a.trigger);
    }
  }

  //   PASS 2 — estimate durations if possible
  for (const a of state.values()) {
    if (a.startTime === undefined) continue;

    const section = sections.find(s =>
      s.actions.some(sa => sa.id === a.id)
    )!;

    const dur = estimateDuration(section.initCamera, a);
    if (dur !== undefined) {
      a.duration = dur;
      a.endTime = a.startTime + dur;
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
      if (!ref || ref.startTime === undefined) continue;

      const anchor = tryResolveReferenceTime(ref, a.trigger.reference);
      if (anchor === undefined) continue;

      a.startTime = anchor + a.trigger.offset;
      progress = true;
    }
  }

  // PASS 4 — Global Window Allocation

  // console.log("PASS 4 begins:");
  const ordered = Array.from(state.values()).sort((a, b) => 
    (a.startTime ?? Infinity) - (b.startTime ?? Infinity)
  );

  const roots = ordered.filter(a => a.startTime !== undefined && !isRelativeTrigger(a.trigger));

  for (let i = 0; i < roots.length; i++) {
    const currentRoot = roots[i]!;
    // The window for a root ends at the next root's start OR the section limit
    const nextRoot = roots.find(r => r.startTime! > currentRoot.startTime!);
    const windowEnd = nextRoot?.startTime ?? limitTime;

    resolveBranch(currentRoot, windowEnd, state, allActions);
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

function estimateDuration(initCamera:InitCamera, action: Action): number | undefined{
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

// This function extracts lossFunction's parameters from movementParameters 
function buildMovementLossParameters(
  action: TimedAction
): Record<string, unknown> {

  const p = action.movement.parameters ?? {};

  switch (action.movement.act) {

    case CameraMovementType.DollyIn:
    case CameraMovementType.DollyOut:
    case CameraMovementType.Follow:
      return { distance: p.distance ?? 2 };

    case CameraMovementType.PanLeft:
    case CameraMovementType.PanRight:
      return { rotationAngle: p.rotationAngle ?? 30 };

    case CameraMovementType.ArcLeft:
    case CameraMovementType.ArcRight:
    case CameraMovementType.Orbit:
      return {
        arcAngle: p.arcAngle ?? 45,
        arcRadius: p.arcRadius ?? 2
      };

    default:
      return {};
  }
}
function buildCameraConfigLosses(
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

function buildConstraintConfigConstraints(
  cfg: ConstraintConfig,
  action: TimedAction
): (SinglePointConstraint | IntervalConstraint)[] {

  const losses = buildCameraConfigLosses(cfg.config);

  if (cfg.allFrames) {
    return losses.map(loss => ({
      type: "interval",
      startTime: action.startTime!,
      endTime: action.endTime!,
      lossFunction: loss,
      weight: 1
    }));
  }

  return [{
    type: "singlePoint",
    time: action.endTime!,
    config: cfg.config,
    weight: 1
  }];
}

function buildConstraintConfigs(
  action: TimedAction
): (SinglePointConstraint | IntervalConstraint)[] {

  if (!action.constraints) return [];

  return action.constraints.flatMap(cfg =>
    buildConstraintConfigConstraints(cfg, action)
  );
}

function buildMovementConstraint(action: TimedAction): IntervalConstraint[] {
  const lossType = LOSS_MAP[action.movement.act];
  if (!lossType) return [];
  //console.log("loss type:", lossType);
  
  return [{
    type: "interval",
    startTime: action.startTime!,
    endTime: action.endTime!,
    lossFunction: {
      type: lossType,
      parameters: buildMovementLossParameters(action) 
    },
    weight: 1
  }];
}



function buildActionConstraints(
  action: TimedAction
): (SinglePointConstraint | IntervalConstraint)[] {
  return [
    // Other Constraint builders must be implemented 
    ...buildMovementConstraint(action),
    ...buildConstraintConfigs(action)
  ];
}


for (let i = 0; i < promptExamples.length; i++) { 
  console.log(`-------------------------------------------------------Example ${i + 1}-------------------------------------------------------`);
  console.log("Prompt:", promptExamples[i]!.prompt);
  
  const res = solveTimeline(promptExamples[i]!.csl);
  const finalRes = normalizeTimeline(res);

  if (!fs.existsSync('./outputs')) fs.mkdirSync('./outputs');

  // 1. Prepare the filename with the index
  const fileName = `./outputs/output_${i + 1}.json`;

  // 2. Convert the result to a JSON string

  const outputWrapper = {
    prompt: promptExamples[i]!.prompt,
    totalDuration: promptExamples[i]!.csl.totalDuration,
    timeline: finalRes
  };
  // 3. Write the file to disk
  try {
    fs.writeFileSync(fileName, JSON.stringify(outputWrapper, null, 2), 'utf8');
    console.log(`✅ Successfully saved to ${fileName}`);
  } catch (err) {
    console.error(`❌ Error writing ${fileName}:`, err);
  }
}