import type { Quat, Vec3 } from "../../types/environment";
import { createInitialCameraState } from "./base-pose";
import { advanceSeedState } from "./motion-step";
import { seedSparseCompositionTransitions } from "./orientation-transitions";
import { seedMotionTransitions } from "./motion-transitions";
import { seedMotionKey, type SeedChoices } from "./seed-defaults";
import {
  applyHardKeyframesToState,
  hardKeyframesAtTime,
} from "../shared/keyframes";
import { add3, length3, normalize3, normalizeQuat, rotateAroundAxis, scale3, sub3, wrapAngle } from "../shared/math";
import { createSpiralPacing } from "../shared/spiral-pacing";
import { samplePrimitiveSubject } from "../scene/primitive-context";
import { applyCompositionOrientation } from "./motion-step";
import type {
  CameraOptimizerInput,
  CameraStateSample,
  CompiledLossPlan,
} from "../types";

/** Seed authored spiral endpoints before evaluating coherent lens/pose choices. */
function seedConstantSpeedEndpoints(
  input: CameraOptimizerInput,
  plan: CompiledLossPlan,
  states: CameraStateSample[],
  choices: SeedChoices,
): void {
  const completed = new Set<string>();
  for (const schedule of plan.primitives) {
    if (schedule.type !== "radiusSchedule" || schedule.parameters.constantSpeed !== true) continue;
    const start = Number(schedule.parameters.motionStartTime ?? schedule.startTime);
    const end = Number(schedule.parameters.motionEndTime ?? schedule.endTime);
    const key = JSON.stringify([schedule.sourceActionId, start, end]);
    if (completed.has(key)) continue;
    completed.add(key);
    if ((input.timeline.cutTimes ?? []).some(cut => cut > start && cut <= end)
      || (input.userKeyframes ?? []).some(frame => (frame.mode ?? "hard") === "hard"
        && frame.time >= start && frame.time <= end
        && (frame.position || frame.rotation || frame.lookAt || frame.cutBefore))) continue;
    const arc = plan.primitives.find(primitive => primitive.type === "angularProgress"
      && primitive.parameters.mode === "orbit" && primitive.sourceActionId === schedule.sourceActionId
      && primitive.parameters.motionStartTime === start && primitive.parameters.motionEndTime === end);
    const sweep = arc?.parameters.fullTargetDelta ?? arc?.parameters.targetDelta;
    if (typeof sweep !== "number" || !plan.primitives.some(primitive =>
      ["screenScale", "subjectView", "subjectElevation"].includes(primitive.type)
      && primitive.parameters.pointTime === end)) continue;
    const first = states.find(state => Math.abs(state.time - start) < 1e-8);
    const last = states.find(state => Math.abs(state.time - end) < 1e-8);
    if (!first || !last) continue;
    const startTarget = samplePrimitiveSubject(input, schedule, start);
    const endTarget = samplePrimitiveSubject(input, schedule, end);
    if (!startTarget || !endTarget) continue;
    const endpoint = createInitialCameraState(input, plan, last.fovYDegrees, end,
      new Map(), { ...choices, fovYDegrees: last.fovYDegrees });
    const initialOffset = sub3(first.position, startTarget.center);
    const finalOffset = sub3(endpoint.position, endTarget.center);
    const turn = wrapAngle(Math.atan2(finalOffset[0], finalOffset[2])
      - sweep - Math.atan2(initialOffset[0], initialOffset[2]));
    let alignedStart = rotateAroundAxis(initialOffset, [0, 0, 0], [0, 1, 0], turn);
    const selectedAmount = choices.movementAmounts?.get(seedMotionKey(schedule));
    const radialDelta = typeof schedule.parameters.deltaRadius === "number" ? schedule.parameters.deltaRadius
      : selectedAmount === undefined ? undefined : selectedAmount * Number(schedule.parameters.sign ?? 1);
    if (radialDelta !== undefined) {
      const initialRadius = length3(finalOffset) - radialDelta;
      if (initialRadius <= 1e-4) continue;
      alignedStart = scale3(normalize3(alignedStart), initialRadius);
    }
    const spiral = createSpiralPacing(alignedStart, finalOffset, sweep);
    const baselines = new Map<string, Quat>();
    for (const state of states) {
      if (state.time < start - 1e-9 || state.time > end + 1e-9) continue;
      const target = samplePrimitiveSubject(input, schedule, state.time);
      if (!target) continue;
      state.position = add3(target.center, spiral.offset(spiral.phase((state.time - start) / (end - start))));
      applyCompositionOrientation(state, input, plan, baselines);
    }
  }
}

function startsNewShot(input: CameraOptimizerInput, time: number): boolean {
  return (input.timeline.cutTimes ?? []).some((cutTime) =>
    Math.abs(cutTime - time) <= 1e-8,
  ) || (input.userKeyframes ?? []).some((keyframe) =>
    keyframe.cutBefore && Math.abs(keyframe.time - time) <= 1e-8,
  );
}

function applyHardKeyframesAtTime(
  state: CameraStateSample,
  input: CameraOptimizerInput,
  shotOrientationBaselines?: Map<string, Quat>,
): void {
  const keyframes = hardKeyframesAtTime(input.userKeyframes ?? [], state.time);
  applyHardKeyframesToState(state, keyframes);
  if (keyframes.some((keyframe) => keyframe.rotation !== undefined || keyframe.lookAt !== undefined)) {
    // At a shot entrance, the next eased sample must start from the finalized
    // hard pose, not a procedural pose cached while creating the shot seed.
    shotOrientationBaselines?.clear();
  }
}

/** Builds a compound-aware seed close enough for numerical refinement. */
export function initializeCameraStates(
  input: CameraOptimizerInput,
  plan: CompiledLossPlan,
  times: readonly number[],
  initialFovYDegrees: number,
  minimumCameraY?: number,
  choices: SeedChoices = {},
): CameraStateSample[] {
  if (times.length === 0) {
    throw new Error("Cannot initialize an empty optimizer time grid");
  }

  const states: CameraStateSample[] = [];
  const pointOrientationBaselines = new Map<string, Quat>();
  const pointFovBaselines = new Map<string, number>();
  const first = createInitialCameraState(
    input,
    plan,
    initialFovYDegrees,
    times[0]!,
    pointOrientationBaselines,
    choices,
  );
  applyHardKeyframesAtTime(first, input, pointOrientationBaselines);
  clampToGroundClearance(first, input, minimumCameraY);
  states.push(first);

  const fixedAxes = new Map<string, Vec3>();
  const initialOrbitRadii = new Map<string, number>();
  for (let index = 1; index < times.length; index += 1) {
    const previous = states[index - 1]!;
    const time = times[index]!;
    if (startsNewShot(input, time)) {
      fixedAxes.clear();
      initialOrbitRadii.clear();
      pointOrientationBaselines.clear();
      pointFovBaselines.clear();
      const cutSeed = createInitialCameraState(
        input,
        plan,
        previous.fovYDegrees,
        time,
        pointOrientationBaselines,
        choices,
      );
      applyHardKeyframesAtTime(cutSeed, input, pointOrientationBaselines);
      clampToGroundClearance(cutSeed, input, minimumCameraY);
      states.push(cutSeed);
      continue;
    }

    const state = advanceSeedState(
      input,
      plan,
      previous,
      time,
      fixedAxes,
      initialOrbitRadii,
      pointOrientationBaselines,
      choices,
      pointFovBaselines,
    );
    applyHardKeyframesAtTime(state, input);
    clampToGroundClearance(state, input, minimumCameraY);
    state.rotation = normalizeQuat(state.rotation);
    states.push(state);
  }

  seedSparseCompositionTransitions(
    states,
    plan,
    input.userKeyframes ?? [],
    input.timeline.cutTimes ?? [],
  );
  seedMotionTransitions(states, plan.motionTransitions ?? [], input.userKeyframes ?? [], input.timeline.cutTimes ?? []);
  seedConstantSpeedEndpoints(input, plan, states, choices);
  for (const state of states) {
    applyHardKeyframesAtTime(state, input);
    clampToGroundClearance(state, input, minimumCameraY);
  }
  return states;
}

export function clampToGroundClearance(
  state: CameraStateSample,
  input: CameraOptimizerInput,
  minimumCameraY: number | undefined,
): void {
  if (minimumCameraY === undefined) return;
  const hasHardPosition = hardKeyframesAtTime(
    input.userKeyframes ?? [],
    state.time,
  ).some((keyframe) => keyframe.position !== undefined);
  if (!hasHardPosition) state.position[1] = Math.max(state.position[1], minimumCameraY);
}
