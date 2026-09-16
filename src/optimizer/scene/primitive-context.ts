import {
  sampleSubjectAggregate,
  type SubjectAggregate,
} from "./subjects";
import { subjectIdsFromParameters } from "../shared/parameter-values";
import { playbackToSceneTime } from "../shared/time";
import { motionProgress } from "../shared/motion-profiles";
import type {
  CameraOptimizerInput,
  PrimitiveLoss,
} from "../types";

const PRIMITIVE_TIME_EPSILON = 1e-9;

/** Returns whether a primitive owns the supplied playback time. */
export function isPrimitiveActiveAt(
  primitive: PrimitiveLoss,
  playbackTime: number,
): boolean {
  return primitive.startTime <= playbackTime + PRIMITIVE_TIME_EPSILON
    && primitive.endTime >= playbackTime - PRIMITIVE_TIME_EPSILON;
}

/** Finds the first primitive of a type, retaining compiled-plan priority. */
export function findPrimitive(
  primitives: readonly PrimitiveLoss[],
  type: PrimitiveLoss["type"],
  predicate: (primitive: PrimitiveLoss) => boolean = () => true,
): PrimitiveLoss | undefined {
  return primitives.find((primitive) => primitive.type === type && predicate(primitive));
}

/** Share a reference clock across movement, composition, and visibility terms. */
export function subjectTimingParameters(parameters: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of ["followDelay", "leadAmount", "subjectTimeProfile", "subjectMotionStartTime",
    "subjectMotionEndTime", "subjectSpeedKeyframes"] as const) {
    if (parameters[key] !== undefined) result[key] = parameters[key];
  }
  if (parameters.subjectTimeProfile === true) {
    result.subjectMotionStartTime ??= parameters.motionStartTime;
    result.subjectMotionEndTime ??= parameters.motionEndTime;
    result.subjectSpeedKeyframes ??= parameters.speedKeyframes;
  }
  return result;
}

/**
 * Follow/Track pacing reparameterizes the subject reference trajectory. Position
 * and velocity then use the same reference, with no extra velocity multiplier.
 * Lead/delay is applied afterwards, in playback time before the scene warp.
 */
export function primitivePlaybackTime(
  primitive: PrimitiveLoss,
  playbackTime: number,
): number {
  const leadAmount = typeof primitive.parameters.leadAmount === "number"
    ? primitive.parameters.leadAmount
    : 0;
  const followDelay = typeof primitive.parameters.followDelay === "number"
    ? Math.max(0, primitive.parameters.followDelay)
    : 0;
  let referenceTime = playbackTime;
  if (primitive.parameters.subjectTimeProfile === true) {
    const start = Number(primitive.parameters.subjectMotionStartTime
      ?? primitive.parameters.motionStartTime ?? primitive.startTime);
    const end = Number(primitive.parameters.subjectMotionEndTime
      ?? primitive.parameters.motionEndTime ?? primitive.endTime);
    // Preserve the ordinary clock outside the authored movement. This also
    // keeps reference time continuous at both endpoints of a positive profile.
    if (end > start && playbackTime >= start && playbackTime <= end) {
      referenceTime = start + (end - start) * motionProgress(
        (playbackTime - start) / (end - start),
        primitive.parameters.subjectSpeedKeyframes ?? primitive.parameters.speedKeyframes,
      );
    }
  }
  return Math.max(0, referenceTime + leadAmount - followDelay);
}

/** Converts a primitive's effective playback time into sampled scene time. */
export function primitiveSceneTime(
  input: CameraOptimizerInput,
  primitive: PrimitiveLoss,
  playbackTime: number,
): number {
  return playbackToSceneTime(
    primitivePlaybackTime(primitive, playbackTime),
    input.timeline.timeWarp,
    input.environment.clock.durationSeconds,
  );
}

/** Samples the subject named by a primitive using the primitive's timing policy. */
export function samplePrimitiveSubject(
  input: CameraOptimizerInput,
  primitive: PrimitiveLoss,
  playbackTime: number,
): SubjectAggregate | undefined {
  const subjectIds = subjectIdsFromParameters(primitive.parameters);
  if (subjectIds.length === 0) return undefined;
  return sampleSubjectAggregate(
    input.environment,
    subjectIds,
    primitiveSceneTime(input, primitive, playbackTime),
  );
}
