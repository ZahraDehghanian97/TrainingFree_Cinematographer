import { lookAtQuaternion, normalizeQuat } from "./math";
import type {
  CameraOptimizerInput,
  CameraStateSample,
  UserCameraKeyframe,
} from "../types";

export type LockedKeyframeChannel = "position" | "rotation" | "fov";

/** Returns hard keyframes authored at the requested playback time. */
export function hardKeyframesAtTime(
  keyframes: readonly UserCameraKeyframe[],
  time: number,
): UserCameraKeyframe[] {
  return keyframes.filter((keyframe) =>
    (keyframe.mode ?? "hard") === "hard" && Math.abs(keyframe.time - time) <= 1e-8,
  );
}

/** Applies position/FOV first so look-at uses the final keyframed position. */
export function applyHardKeyframesToState(
  state: CameraStateSample,
  keyframes: readonly UserCameraKeyframe[],
): void {
  for (const keyframe of keyframes) {
    if (keyframe.position) state.position = [...keyframe.position];
    if (keyframe.fovYDegrees !== undefined) state.fovYDegrees = keyframe.fovYDegrees;
  }
  for (const keyframe of keyframes) {
    if (keyframe.rotation) state.rotation = normalizeQuat(keyframe.rotation);
    if (keyframe.lookAt) {
      state.rotation = lookAtQuaternion(
        state.position,
        keyframe.lookAt,
        keyframe.up ?? [0, 1, 0],
      );
    }
  }
}

/** Returns the optimizer channels fixed by a set of hard keyframes. */
export function lockedKeyframeChannels(
  keyframes: readonly UserCameraKeyframe[],
): Set<LockedKeyframeChannel> {
  const result = new Set<LockedKeyframeChannel>();
  for (const keyframe of keyframes) {
    if (keyframe.position) result.add("position");
    if (keyframe.rotation || keyframe.lookAt) result.add("rotation");
    if (keyframe.fovYDegrees !== undefined) result.add("fov");
  }
  return result;
}

function nearestStateIndex(
  states: readonly CameraStateSample[],
  time: number,
): number {
  let bestIndex = 0;
  let bestDistance = Infinity;
  states.forEach((state, index) => {
    const distance = Math.abs(state.time - time);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  if (bestDistance > 1e-7) {
    throw new Error(`Hard keyframe time ${time} is missing from optimizer grid`);
  }
  return bestIndex;
}

/** Groups hard keyframes by their matching optimizer-state index. */
export function indexHardKeyframesByState(
  states: readonly CameraStateSample[],
  keyframes: readonly UserCameraKeyframe[],
): Map<number, UserCameraKeyframe[]> {
  const result = new Map<number, UserCameraKeyframe[]>();
  for (const keyframe of keyframes) {
    if ((keyframe.mode ?? "hard") !== "hard") continue;
    const index = nearestStateIndex(states, keyframe.time);
    const existing = result.get(index) ?? [];
    existing.push(keyframe);
    result.set(index, existing);
  }
  return result;
}

/** Adds cut-before keyframe times to a timeline without mutating the input. */
export function withKeyframeCuts(input: CameraOptimizerInput): CameraOptimizerInput {
  const keyframeCuts = (input.userKeyframes ?? [])
    .filter((keyframe) => keyframe.cutBefore)
    .map((keyframe) => keyframe.time);
  if (keyframeCuts.length === 0) return input;
  return {
    ...input,
    timeline: {
      ...input.timeline,
      cutTimes: [...new Set([...(input.timeline.cutTimes ?? []), ...keyframeCuts])]
        .sort((a, b) => a - b),
    },
  };
}
