import type { EnvironmentV1 } from "../types/environment";
import type { FlattenedTimeline, TimeWarpSegment } from "../types/solver";
import type { UserCameraKeyframe } from "./types";
import { clamp } from "./math";

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
    if (segment.kind === "interval") values.push(segment.startTime, segment.endTime);
    else {
      values.push(segment.time);
      if (segment.easing?.inDuration) values.push(segment.time - segment.easing.inDuration);
      if (segment.easing?.outDuration) values.push(segment.time + segment.easing.outDuration);
    }
  }
  values.push(...(timeline.cutTimes ?? []));
  values.push(...userKeyframes.map((keyframe) => keyframe.time));
  return sortedUnique(values
    .map((time) => clamp(time, 0, duration))
    .filter((time) => time >= 0 && time <= duration));
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
  return sortedUnique([...uniform, ...mandatoryTimes].map((time) => clamp(time, 0, durationSeconds)));
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
  if (!easing) return Math.abs(time - pointTime) <= 1e-7 ? 1 : 0;
  let alpha: number;
  if (time <= pointTime) {
    const duration = Math.max(1e-9, easing.inDuration ?? 0);
    alpha = duration <= 1e-9 ? (Math.abs(time - pointTime) <= 1e-7 ? 1 : 0) : 1 - (pointTime - time) / duration;
  } else {
    const duration = Math.max(1e-9, easing.outDuration ?? 0);
    alpha = duration <= 1e-9 ? 0 : 1 - (time - pointTime) / duration;
  }
  alpha = clamp(alpha, 0, 1);
  switch (easing.curve ?? "easeInOut") {
    case "linear": return alpha;
    case "easeIn": return alpha * alpha;
    case "easeOut": return 1 - (1 - alpha) * (1 - alpha);
    case "easeInOut": return alpha * alpha * (3 - 2 * alpha);
    default: throw new Error(`Unknown point easing curve: ${String(easing.curve)}`);
  }
}

