import { LossFunctionType } from "../../types/solver";
import { DEFAULT_OPTIONS } from "../config/defaults";
import type { CameraOptimizerInput, MotionTransition } from "../types";
import { FOV_DRIVING_TYPES, ORIENTATION_DRIVING_TYPES, TRANSLATION_TYPES } from "./constants";

const TRANSITION_TYPES = new Set([
  ...TRANSLATION_TYPES, ...ORIENTATION_DRIVING_TYPES, ...FOV_DRIVING_TYPES,
  LossFunctionType.Static,
]);

/** Detect changes without extending action spans or altering motion budgets. */
export function buildMotionTransitions(input: CameraOptimizerInput): MotionTransition[] {
  const duration = input.options?.motionTransitionSeconds ?? DEFAULT_OPTIONS.motionTransitionSeconds;
  if (duration <= 0) return [];
  const spans = input.timeline.timeline.flatMap((segment) => segment.kind === "interval"
    ? segment.lossFunctions.filter((loss) => TRANSITION_TYPES.has(loss.type)).map((loss) => ({
        startTime: segment.startTime,
        endTime: segment.endTime,
        signature: JSON.stringify([
          loss.type, loss.parameters,
          loss.type.endsWith("Movement") && loss.type !== LossFunctionType.FollowMovement
            && loss.type !== LossFunctionType.TrackMovement
            ? segment.endTime - segment.startTime : undefined,
        ]),
      }))
    : []);
  const cuts = [
    ...(input.timeline.cutTimes ?? []),
    ...(input.userKeyframes ?? []).filter((keyframe) => keyframe.cutBefore).map((keyframe) => keyframe.time),
  ];
  const boundaries = [...new Set([
    0, input.environment.clock.durationSeconds,
    ...spans.flatMap((span) => [span.startTime, span.endTime]), ...cuts,
  ])].sort((a, b) => a - b);
  const result: MotionTransition[] = [];
  for (let index = 1; index + 1 < boundaries.length; index += 1) {
    const boundaryTime = boundaries[index]!;
    if (cuts.some((cut) => Math.abs(cut - boundaryTime) <= 1e-8)) continue;
    const left = spans.filter((span) => span.startTime < boundaryTime - 1e-9 && span.endTime >= boundaryTime - 1e-9);
    const right = spans.filter((span) => span.startTime <= boundaryTime + 1e-9 && span.endTime > boundaryTime + 1e-9);
    // A gap has no adjacent motion to transition to. Identical split actions
    // also need no transition (e.g. a band split by an unrelated constraint).
    if (left.length === 0 || right.length === 0) continue;
    const signature = (active: typeof spans): string => JSON.stringify([...new Set(active.map((span) => span.signature))].sort());
    if (signature(left) === signature(right)) continue;
    const halfWindow = Math.min(
      duration / 2,
      (boundaryTime - boundaries[index - 1]!) / 2,
      (boundaries[index + 1]! - boundaryTime) / 2,
    );
    if (halfWindow <= 1e-8) continue;
    result.push({ startTime: boundaryTime - halfWindow, boundaryTime, endTime: boundaryTime + halfWindow });
  }
  return result;
}
