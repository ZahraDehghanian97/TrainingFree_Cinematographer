import type { CoordinateSystemV1, Quat, Vec3 } from "../types/environment";
import type {
  CameraSampleV1,
  CameraTrajectoryV1,
  PlaybackRateLabelV1,
} from "../types/trajectory";
import { lerp3, lookAtQuaternion, normalizeQuat, slerpQuat } from "./math";
import type {
  CameraOptimizerInput,
  CameraStateSample,
  CompiledLossPlan,
  UserCameraKeyframe,
} from "./types";

export const CANONICAL_COORDINATES: CoordinateSystemV1 = {
  handedness: "right",
  upAxis: "+Y",
  cameraForwardAxis: "-Z",
  lengthUnit: "meter",
  rotationOrder: "quaternion-xyzw",
};

function bracket(states: readonly CameraStateSample[], time: number): [number, number, number] {
  if (time <= states[0]!.time) return [0, 0, 0];
  const last = states.length - 1;
  if (time >= states[last]!.time) return [last, last, 0];
  let low = 0;
  let high = last;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (states[middle]!.time <= time) low = middle;
    else high = middle;
  }
  const span = states[high]!.time - states[low]!.time;
  return [low, high, span <= 0 ? 0 : (time - states[low]!.time) / span];
}

function interpolateState(states: readonly CameraStateSample[], time: number): CameraStateSample {
  const [leftIndex, rightIndex, alpha] = bracket(states, time);
  const left = states[leftIndex]!;
  if (leftIndex === rightIndex) return {
    time,
    position: [...left.position],
    rotation: [...left.rotation],
    fovYDegrees: left.fovYDegrees,
  };
  const right = states[rightIndex]!;
  return {
    time,
    position: lerp3(left.position, right.position, alpha),
    rotation: slerpQuat(left.rotation, right.rotation, alpha),
    fovYDegrees: left.fovYDegrees + (right.fovYDegrees - left.fovYDegrees) * alpha,
  };
}

function hardKeyframesAt(
  keyframes: readonly UserCameraKeyframe[],
  time: number,
): UserCameraKeyframe[] {
  return keyframes.filter((keyframe) =>
    (keyframe.mode ?? "hard") === "hard" && Math.abs(keyframe.time - time) <= 1e-8,
  );
}

function applyHardOutput(sample: CameraStateSample, keyframes: readonly UserCameraKeyframe[]): void {
  const hard = hardKeyframesAt(keyframes, sample.time);
  for (const keyframe of hard) {
    if (keyframe.position) sample.position = [...keyframe.position];
    if (keyframe.fovYDegrees !== undefined) sample.fovYDegrees = keyframe.fovYDegrees;
  }
  for (const keyframe of hard) {
    if (keyframe.rotation) sample.rotation = normalizeQuat(keyframe.rotation);
    if (keyframe.lookAt) {
      sample.rotation = lookAtQuaternion(
        sample.position,
        keyframe.lookAt,
        keyframe.up ?? [0, 1, 0],
      );
    }
  }
}

function sourceActionAt(plan: CompiledLossPlan, time: number): string | undefined {
  return plan.primitives.find((primitive) =>
    primitive.sourceActionId
    && primitive.role === "primary"
    && primitive.startTime <= time + 1e-9
    && primitive.endTime >= time - 1e-9,
  )?.sourceActionId;
}

function hasTime(times: readonly number[], time: number): boolean {
  return times.some((candidate) => Math.abs(candidate - time) <= 1e-8);
}

export function buildCameraTrajectory(
  input: CameraOptimizerInput,
  plan: CompiledLossPlan,
  optimizedStates: readonly CameraStateSample[],
  outputTimes: readonly number[],
  nearPlane: number,
  farPlane: number,
): CameraTrajectoryV1 {
  const userKeyframes = input.userKeyframes ?? [];
  const cutTimes = [
    ...(input.timeline.cutTimes ?? []),
    ...userKeyframes.filter((keyframe) => keyframe.cutBefore).map((keyframe) => keyframe.time),
  ];
  const samples: CameraSampleV1[] = outputTimes.map((time) => {
    const state = interpolateState(optimizedStates, time);
    applyHardOutput(state, userKeyframes);
    const sample: CameraSampleV1 = {
      t: time,
      position: [...state.position] as Vec3,
      rotation: normalizeQuat(state.rotation) as Quat,
      fovYDegrees: state.fovYDegrees,
      ...(hasTime(cutTimes, time) && time > 0 ? { cutBefore: true } : {}),
    };
    const actionId = sourceActionAt(plan, time);
    if (actionId) sample.actionId = actionId;
    return sample;
  });
  for (let index = 1; index < samples.length; index += 1) {
    const hardOrientation = hardKeyframesAt(userKeyframes, samples[index]!.t).some(
      (keyframe) => keyframe.rotation !== undefined || keyframe.lookAt !== undefined,
    );
    if (hardOrientation) continue;
    const previous = samples[index - 1]!.rotation!;
    const current = samples[index]!.rotation!;
    const dot = previous[0] * current[0] + previous[1] * current[1]
      + previous[2] * current[2] + previous[3] * current[3];
    if (dot < 0) samples[index]!.rotation = [-current[0], -current[1], -current[2], -current[3]];
  }
  return {
    schemaVersion: "1.0",
    kind: "cameraTrajectory",
    environmentId: input.environment.id,
    clock: {
      durationSeconds: input.environment.clock.durationSeconds,
      timeUnit: "second",
    },
    coordinates: CANONICAL_COORDINATES,
    intrinsics: {
      projection: "perspective",
      fovYDegrees: samples[0]?.fovYDegrees ?? 50,
      near: nearPlane,
      far: farPlane,
    },
    orientation: { mode: "quaternion" },
    ...(input.timeline.timeWarp.length > 0 ? {
      playback: {
        rateSegments: input.timeline.timeWarp.map((segment) => ({
          startTime: segment.startTimePlayback,
          endTime: segment.endTimePlayback,
          rate: segment.rate,
          label: segment.label as PlaybackRateLabelV1,
        })),
      },
    } : {}),
    samples,
  };
}
