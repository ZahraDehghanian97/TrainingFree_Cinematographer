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
  dot3,
  normalizeQuat,
  scale3,
  sub3,
} from "../shared/math";
import { crossesCut } from "../shared/time";
import type {
  CameraOptimizerInput,
  CameraStateSample,
  CompiledLossPlan,
} from "../types";
import {
  angularVelocity,
  cubicHermite,
  interpolateRotationWithVelocities,
} from "./interpolation";
import { DEFAULT_OPTIONS } from "../config/defaults";

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

function tangentNeighbors(
  states: readonly CameraStateSample[],
  index: number,
  cutTimes: readonly number[],
) {
  const current = states[index]!;
  const previous = index > 0 ? states[index - 1] : undefined;
  const next = index + 1 < states.length ? states[index + 1] : undefined;
  const canUsePrevious = previous !== undefined
    && !crossesCut(previous.time, current.time, cutTimes);
  const canUseNext = next !== undefined
    && !crossesCut(current.time, next.time, cutTimes);
  return {
    current,
    previous: canUsePrevious ? previous : undefined,
    next: canUseNext ? next : undefined,
  };
}

/** PCHIP slopes keep zoom and height within their neighboring sample values. */
function monotoneTangent(
  previousSlope: number | undefined,
  nextSlope: number | undefined,
  previousSpan: number,
  nextSpan: number,
): number {
  if (previousSlope === undefined) return nextSlope ?? 0;
  if (nextSlope === undefined) return previousSlope;
  if (previousSlope * nextSlope <= 0) return 0;
  const previousWeight = 2 * nextSpan + previousSpan;
  const nextWeight = nextSpan + 2 * previousSpan;
  return (previousWeight + nextWeight)
    / (previousWeight / previousSlope + nextWeight / nextSlope);
}

function limitTangent(tangent: Vec3, previous?: Vec3, next?: Vec3): Vec3 {
  const maximumLength = 2 * Math.min(
    previous ? Math.hypot(...previous) : Infinity,
    next ? Math.hypot(...next) : Infinity,
  );
  const length = Math.hypot(...tangent);
  return length > maximumLength ? scale3(tangent, maximumLength / length) : tangent;
}

function sampleTangent(
  states: readonly CameraStateSample[],
  index: number,
  cutTimes: readonly number[],
): { position: Vec3; angularVelocity: Vec3; fov: number } {
  const { current, previous, next } = tangentNeighbors(states, index, cutTimes);
  // The interval immediately before a cut holds its last pre-cut sample.
  if (!next && index + 1 < states.length) {
    return { position: [0, 0, 0], angularVelocity: [0, 0, 0], fov: 0 };
  }
  const previousSpan = previous ? Math.max(1e-9, current.time - previous.time) : 0;
  const nextSpan = next ? Math.max(1e-9, next.time - current.time) : 0;
  const previousPosition = previous
    ? scale3(sub3(current.position, previous.position), 1 / previousSpan) : undefined;
  const nextPosition = next
    ? scale3(sub3(next.position, current.position), 1 / nextSpan) : undefined;
  const previousRotation = previous
    ? angularVelocity(previous.rotation, current.rotation, previousSpan) : undefined;
  const nextRotation = next
    ? angularVelocity(current.rotation, next.rotation, nextSpan) : undefined;
  const average = (incoming?: Vec3, outgoing?: Vec3): Vec3 => {
    if (!incoming) return outgoing ? [...outgoing] : [0, 0, 0];
    if (!outgoing) return [...incoming];
    return incoming.map((value, component) =>
      (nextSpan * value + previousSpan * outgoing[component]!) / (previousSpan + nextSpan),
    ) as Vec3;
  };
  const position = average(previousPosition, nextPosition);
  position[1] = monotoneTangent(
    previousPosition?.[1], nextPosition?.[1], previousSpan, nextSpan,
  );
  let rotation = average(previousRotation, nextRotation);
  // Stop at reversals that would otherwise start a segment rotating away from
  // its endpoint. Limit once per knot so both adjacent segments share a rate.
  if ((previousRotation && dot3(rotation, previousRotation) < 0)
    || (nextRotation && dot3(rotation, nextRotation) < 0)) rotation = [0, 0, 0];
  return {
    position: limitTangent(position, previousPosition, nextPosition),
    angularVelocity: limitTangent(rotation, previousRotation, nextRotation),
    fov: monotoneTangent(
      previous ? (current.fovYDegrees - previous.fovYDegrees) / previousSpan : undefined,
      next ? (next.fovYDegrees - current.fovYDegrees) / nextSpan : undefined,
      previousSpan,
      nextSpan,
    ),
  };
}

function interpolateState(
  states: readonly CameraStateSample[],
  time: number,
  cutTimes: readonly number[],
  tangents: readonly ReturnType<typeof sampleTangent>[],
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
  const leftTangent = tangents[leftIndex]!;
  const rightTangent = tangents[rightIndex]!;
  return {
    time,
    position: left.position.map((value, component) => cubicHermite(
      value,
      right.position[component]!,
      leftTangent.position[component]!,
      rightTangent.position[component]!,
      span,
      alpha,
    )) as Vec3,
    rotation: interpolateRotationWithVelocities(
      left.rotation,
      right.rotation,
      leftTangent.angularVelocity,
      rightTangent.angularVelocity,
      span,
      alpha,
    ),
    fovYDegrees: cubicHermite(
      left.fovYDegrees, right.fovYDegrees, leftTangent.fov, rightTangent.fov, span, alpha,
    ),
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
  const tangents = optimizedStates.map((_, index) => sampleTangent(optimizedStates, index, cutTimes));
  const samples: CameraSampleV1[] = outputTimes.map((time) => {
    const state = interpolateState(optimizedStates, time, cutTimes, tangents);
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
      aspectRatio: input.options?.aspectRatio ?? DEFAULT_OPTIONS.aspectRatio,
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
