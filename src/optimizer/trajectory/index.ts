import type { CoordinateSystemV1, Quat, Vec3 } from "../../types/environment";
import type {
  CameraSampleV1,
  CameraTrajectoryV1,
  PlaybackRateLabelV1,
} from "../../types/trajectory";
import {
  applyHardKeyframesToState,
  hardKeyframesAtTime,
} from "../shared/keyframes";
import {
  normalizeQuat,
  scale3,
  sub3,
  slerpQuat,
} from "../shared/math";
import { crossesCut } from "../shared/time";
import type {
  CameraOptimizerInput,
  CameraStateSample,
  CompiledLossPlan,
} from "../types";

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

function positionTangent(
  states: readonly CameraStateSample[],
  index: number,
  cutTimes: readonly number[],
): Vec3 {
  const current = states[index]!;
  const previous = index > 0 ? states[index - 1] : undefined;
  const next = index + 1 < states.length ? states[index + 1] : undefined;
  const canUsePrevious = previous !== undefined
    && !crossesCut(previous.time, current.time, cutTimes);
  const canUseNext = next !== undefined
    && !crossesCut(current.time, next.time, cutTimes);
  if (canUsePrevious && canUseNext) {
    return scale3(
      sub3(next.position, previous.position),
      1 / Math.max(1e-9, next.time - previous.time),
    );
  }
  if (canUseNext) {
    return scale3(
      sub3(next.position, current.position),
      1 / Math.max(1e-9, next.time - current.time),
    );
  }
  if (canUsePrevious) {
    return scale3(
      sub3(current.position, previous.position),
      1 / Math.max(1e-9, current.time - previous.time),
    );
  }
  return [0, 0, 0];
}

function cubicPosition(
  left: Vec3,
  right: Vec3,
  leftTangent: Vec3,
  rightTangent: Vec3,
  span: number,
  alpha: number,
): Vec3 {
  const chord = sub3(right, left);
  const chordLength = Math.hypot(...chord);
  const maximumTangentLength = chordLength <= 1e-9 || span <= 1e-9
    ? 0
    : 2 * chordLength / span;
  const boundedTangent = (tangent: Vec3): Vec3 => {
    const length = Math.hypot(...tangent);
    return length > maximumTangentLength
      ? scale3(tangent, maximumTangentLength / length)
      : tangent;
  };
  const boundedLeftTangent = boundedTangent(leftTangent);
  const boundedRightTangent = boundedTangent(rightTangent);
  // Fritsch-Carlson-style limiting on world Y prevents a cubic segment whose
  // endpoints are safe from dipping below either endpoint between samples.
  const verticalSlope = span <= 1e-9 ? 0 : (right[1] - left[1]) / span;
  if (Math.abs(verticalSlope) <= 1e-12) {
    boundedLeftTangent[1] = 0;
    boundedRightTangent[1] = 0;
  } else {
    if (boundedLeftTangent[1] * verticalSlope <= 0) boundedLeftTangent[1] = 0;
    if (boundedRightTangent[1] * verticalSlope <= 0) boundedRightTangent[1] = 0;
    const leftRatio = boundedLeftTangent[1] / verticalSlope;
    const rightRatio = boundedRightTangent[1] / verticalSlope;
    const ratioLength = Math.hypot(leftRatio, rightRatio);
    if (ratioLength > 3) {
      const ratioScale = 3 / ratioLength;
      boundedLeftTangent[1] = ratioScale * leftRatio * verticalSlope;
      boundedRightTangent[1] = ratioScale * rightRatio * verticalSlope;
    }
  }
  const alpha2 = alpha * alpha;
  const alpha3 = alpha2 * alpha;
  const h00 = 2 * alpha3 - 3 * alpha2 + 1;
  const h10 = alpha3 - 2 * alpha2 + alpha;
  const h01 = -2 * alpha3 + 3 * alpha2;
  const h11 = alpha3 - alpha2;
  return [0, 1, 2].map((component) =>
    h00 * left[component]!
    + h10 * span * boundedLeftTangent[component]!
    + h01 * right[component]!
    + h11 * span * boundedRightTangent[component]!,
  ) as Vec3;
}

function interpolateState(
  states: readonly CameraStateSample[],
  time: number,
  cutTimes: readonly number[],
): CameraStateSample {
  const [leftIndex, rightIndex, alpha] = bracket(states, time);
  const left = states[leftIndex]!;
  if (leftIndex === rightIndex) return {
    time,
    position: [...left.position],
    rotation: [...left.rotation],
    fovYDegrees: left.fovYDegrees,
  };
  const right = states[rightIndex]!;
  if (crossesCut(left.time, right.time, cutTimes)) {
    return {
      time,
      position: [...left.position],
      rotation: [...left.rotation],
      fovYDegrees: left.fovYDegrees,
    };
  }
  const span = right.time - left.time;
  return {
    time,
    position: cubicPosition(
      left.position,
      right.position,
      positionTangent(states, leftIndex, cutTimes),
      positionTangent(states, rightIndex, cutTimes),
      span,
      alpha,
    ),
    rotation: slerpQuat(left.rotation, right.rotation, alpha),
    fovYDegrees: left.fovYDegrees + (right.fovYDegrees - left.fovYDegrees) * alpha,
  };
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
  minimumCameraY?: number,
): CameraTrajectoryV1 {
  const userKeyframes = input.userKeyframes ?? [];
  const cutTimes = [
    ...(input.timeline.cutTimes ?? []),
    ...userKeyframes.filter((keyframe) => keyframe.cutBefore).map((keyframe) => keyframe.time),
  ];
  const samples: CameraSampleV1[] = outputTimes.map((time) => {
    const state = interpolateState(optimizedStates, time, cutTimes);
    applyHardKeyframesToState(state, hardKeyframesAtTime(userKeyframes, state.time));
    const hasHardPosition = hardKeyframesAtTime(userKeyframes, state.time).some(
      (keyframe) => keyframe.position !== undefined,
    );
    if (minimumCameraY !== undefined && !hasHardPosition) {
      state.position[1] = Math.max(state.position[1], minimumCameraY);
    }
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
    const hardOrientation = hardKeyframesAtTime(userKeyframes, samples[index]!.t).some(
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
