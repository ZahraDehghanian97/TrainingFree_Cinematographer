import type { EnvironmentV1 } from "../../types/environment";
import { LossFunctionType, type FlattenedTimeline, type TimeWarpSegment } from "../../types/solver";
import { getPointConstraintWeight } from "../../timeline/easing";
import type { MotionTransition, UserCameraKeyframe } from "../types";
import { clamp } from "./math";
import { SEED_ORBIT_DEGREES } from "../initialization/seed-defaults";

const MAX_ARC_STEP_DEGREES = 15;

function sortedUnique(values: number[], epsilon = 1e-9): number[] {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  const result: number[] = [];
  for (const value of sorted) {
    if (result.length === 0 || Math.abs(result[result.length - 1]! - value) > epsilon) {
      result.push(value);
    }
  }
  return result;
}

function activeRate(segments: readonly TimeWarpSegment[], time: number): number {
  const active = segments.filter((segment) =>
    segment.startTimePlayback <= time && time < segment.endTimePlayback,
  );
  return active.length === 0 ? 1 : active[active.length - 1]!.rate;
}

/** Integrates scene rate over the camera playback clock. */
export function playbackToSceneTime(
  playbackTime: number,
  segments: readonly TimeWarpSegment[],
  sceneDuration: number,
): number {
  const endTime = Math.max(0, playbackTime);
  const boundaries = sortedUnique([
    0,
    endTime,
    ...segments.flatMap((segment) => [segment.startTimePlayback, segment.endTimePlayback]),
  ].filter((time) => time >= 0 && time <= endTime));
  let sceneTime = 0;
  for (let index = 0; index + 1 < boundaries.length; index += 1) {
    const start = boundaries[index]!;
    const end = boundaries[index + 1]!;
    sceneTime += (end - start) * activeRate(segments, (start + end) / 2);
  }
  return clamp(sceneTime, 0, sceneDuration);
}

export function buildOptimizationTimes(
  environment: EnvironmentV1,
  timeline: FlattenedTimeline,
  userKeyframes: readonly UserCameraKeyframe[],
  samplesPerSecond: number,
  motionTransitions: readonly MotionTransition[] = [],
): number[] {
  const duration = environment.clock.durationSeconds;
  if (!Number.isFinite(samplesPerSecond) || samplesPerSecond <= 0) {
    throw new Error("options.optimizationFps must be a positive finite number");
  }
  const uniformCount = Math.max(1, Math.ceil(duration * samplesPerSecond));
  const values = Array.from({ length: uniformCount + 1 }, (_, index) =>
    index === uniformCount ? duration : index / samplesPerSecond,
  );
  for (const segment of timeline.timeline) {
    if (segment.kind === "interval") {
      values.push(segment.startTime, segment.endTime);
      for (const loss of segment.lossFunctions) {
        if (loss.type !== LossFunctionType.ArcMovement) continue;
        // An unconstrained orbit still needs a grid fine enough for its seed.
        const angle = loss.parameters.arcAngle ?? SEED_ORBIT_DEGREES;
        if (typeof angle !== "number" || !Number.isFinite(angle)) continue;
        const baseSampleCount = Math.max(
          1,
          // A constant-speed spiral accelerates its bearing as its radius
          // shrinks. Its final spline derivatives need a denser source grid
          // to preserve physical speed through the endpoint.
          Math.ceil((segment.endTime - segment.startTime) * samplesPerSecond
            * (loss.parameters.constantSpeed === true ? 4 : 1)),
        );
        const subdivisions = Math.max(
          1,
          Math.ceil(Math.abs(angle) / baseSampleCount / MAX_ARC_STEP_DEGREES),
        );
        const arcSampleCount = baseSampleCount * subdivisions;
        for (let index = 1; index < arcSampleCount; index += 1) {
          values.push(
            segment.startTime
              + (segment.endTime - segment.startTime) * index / arcSampleCount,
          );
        }
        if (loss.parameters.constantSpeed === true) {
          // Close-up endpoints can have a much smaller radius than the rest
          // of the spiral. Refine the one-sided endpoint jets independently
          // of its otherwise sufficient interior angular sampling.
          for (let offset = 1; offset <= 8; offset++) {
            const delta = Math.min((segment.endTime - segment.startTime) / 2, offset / 60);
            values.push(segment.startTime + delta, segment.endTime - delta);
          }
        }
      }
    } else {
      values.push(segment.time);
      if (segment.easing?.inDuration) values.push(segment.time - segment.easing.inDuration);
      if (segment.easing?.outDuration) values.push(segment.time + segment.easing.outDuration);
    }
  }
  values.push(...(timeline.cutTimes ?? []));
  values.push(...userKeyframes.map((keyframe) => keyframe.time));
  // Relative rigs inherit the carrier's endpoint derivatives. Resolve those
  // derivatives locally when the moving subject's path is curved, rather
  // than extrapolating a coarse cubic across the last third of a second.
  const followsSubject = timeline.timeline.some(segment => segment.lossFunctions.some(loss =>
    loss.type === LossFunctionType.FollowMovement || loss.type === LossFunctionType.TrackMovement));
  if (followsSubject) for (let offset = 1; offset <= 8; offset++) {
    values.push(offset / 60, duration - offset / 60);
  }
  // A rate change can instantaneously change the subject's playback velocity.
  // Resolve its short C2 camera handoff locally; a coarse subject-reference
  // spline otherwise creates a visible following error after slow motion.
  for (const boundary of new Set(timeline.timeWarp.flatMap(segment =>
    [segment.startTimePlayback, segment.endTimePlayback]))) {
    if (boundary <= 0 || boundary >= duration) continue;
    const before = activeRate(timeline.timeWarp, boundary - 1e-7);
    const after = activeRate(timeline.timeWarp, boundary + 1e-7);
    if (Math.abs(before - after) < 1e-9) continue;
    for (let offset = -8; offset <= 8; offset++) values.push(boundary + offset / 60);
  }
  for (const window of motionTransitions) {
    // Even short actions need enough samples to represent a smooth handoff.
    for (let index = 0; index <= 8; index += 1) {
      values.push(window.startTime + (window.endTime - window.startTime) * index / 8);
    }
  }
  return sortedUnique(values
    .map((time) => clamp(time, 0, duration))
    .filter((time) => time >= 0 && time <= duration));
}

/** Required polynomial/keyframe times win over nearby optional sampling times. */
export function preserveMandatoryTimes(values: readonly number[], mandatoryTimes: readonly number[]): number[] {
  const required = sortedUnique([...mandatoryTimes]);
  return sortedUnique([...required, ...values.filter((time) =>
    !required.some((knot) => Math.abs(knot - time) <= 1e-9))]);
}

export function buildOutputTimes(
  durationSeconds: number,
  outputFps: number,
  mandatoryTimes: readonly number[],
): number[] {
  if (!Number.isFinite(outputFps) || outputFps <= 0) {
    throw new Error("options.outputFps must be a positive finite number");
  }
  const count = Math.max(1, Math.ceil(durationSeconds * outputFps));
  const uniform = Array.from({ length: count + 1 }, (_, index) =>
    index === count ? durationSeconds : index / outputFps,
  );
  return preserveMandatoryTimes(uniform, mandatoryTimes.map((time) => clamp(time, 0, durationSeconds)));
}

export function intervalIndices(times: readonly number[], startTime: number, endTime: number): number[] {
  const point = Math.abs(endTime - startTime) <= 1e-9;
  if (point) {
    let nearest = 0;
    let nearestDistance = Infinity;
    times.forEach((time, index) => {
      const distance = Math.abs(time - startTime);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearest = index;
      }
    });
    return [nearest];
  }
  return times.map((time, index) => ({ time, index })).filter(
    ({ time }) => time >= startTime - 1e-9 && time <= endTime + 1e-9,
  ).map(({ index }) => index);
}

export function crossesCut(startTime: number, endTime: number, cutTimes: readonly number[]): boolean {
  return cutTimes.some((cutTime) => cutTime > startTime + 1e-9 && cutTime <= endTime + 1e-9);
}

export function pointEasingWeight(
  time: number,
  pointTime: number,
  easing: { inDuration?: number; outDuration?: number; curve?: string } | undefined,
): number {
  const curve = easing?.curve;
  if (curve !== undefined && curve !== "linear" && curve !== "easeIn"
    && curve !== "easeOut" && curve !== "easeInOut") {
    throw new Error(`Unknown point easing curve: ${String(curve)}`);
  }
  // Use the authored timeline curve for both seed poses and objective weights,
  // including the complementary fade after the point constraint.
  return getPointConstraintWeight({
    time: pointTime,
    easing: easing ? { ...easing, curve } : undefined,
  }, time);
}
