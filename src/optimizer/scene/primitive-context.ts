import {
  sampleSubjectAggregate,
  type SubjectAggregate,
} from "./subjects";
import { subjectIdsFromParameters } from "../shared/parameter-values";
import { playbackToSceneTime } from "../shared/time";
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

/** Applies lead/follow timing in playback space before the scene time warp. */
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
  return Math.max(0, playbackTime + leadAmount - followDelay);
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
