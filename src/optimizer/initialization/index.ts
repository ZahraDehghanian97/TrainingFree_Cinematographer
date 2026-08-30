import type { Vec3 } from "../../types/environment";
import { createInitialCameraState } from "./base-pose";
import { advanceSeedState } from "./motion-step";
import { seedSparseCompositionTransitions } from "./orientation-transitions";
import {
  applyHardKeyframesToState,
  hardKeyframesAtTime,
} from "../shared/keyframes";
import { normalizeQuat } from "../shared/math";
import type {
  CameraOptimizerInput,
  CameraStateSample,
  CompiledLossPlan,
} from "../types";

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
): void {
  applyHardKeyframesToState(
    state,
    hardKeyframesAtTime(input.userKeyframes ?? [], state.time),
  );
}

/** Builds a compound-aware seed close enough for numerical refinement. */
export function initializeCameraStates(
  input: CameraOptimizerInput,
  plan: CompiledLossPlan,
  times: readonly number[],
  initialFovYDegrees: number,
  minimumCameraY?: number,
): CameraStateSample[] {
  if (times.length === 0) {
    throw new Error("Cannot initialize an empty optimizer time grid");
  }

  const states: CameraStateSample[] = [];
  const first = createInitialCameraState(
    input,
    plan,
    initialFovYDegrees,
    times[0]!,
  );
  applyHardKeyframesAtTime(first, input);
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
      const cutSeed = createInitialCameraState(
        input,
        plan,
        previous.fovYDegrees,
        time,
      );
      applyHardKeyframesAtTime(cutSeed, input);
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
