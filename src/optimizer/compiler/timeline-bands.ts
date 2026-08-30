import type { TimelineSegment } from "../../types/solver";
import { finiteNumber } from "../shared/parameter-values";
import type { ActiveLossBand, ActiveLossSpan } from "./types";

function uniqueSorted(values: number[]): number[] {
  return [...new Set(values.map((value) => Number(value.toFixed(9))))].sort((a, b) => a - b);
}

export function buildActiveLossBands(
  timeline: readonly TimelineSegment[],
  durationSeconds: number,
): ActiveLossBand[] {
  const spans: ActiveLossSpan[] = timeline.flatMap((segment) => {
    if (segment.kind === "interval") {
      return segment.lossFunctions.map((loss) => ({
        startTime: segment.startTime,
        endTime: segment.endTime,
        sourceStartTime: segment.startTime,
        sourceEndTime: segment.endTime,
        weight: finiteNumber(segment.weight, 1),
        loss,
      }));
    }

    const startTime = Math.max(0, segment.time - finiteNumber(segment.easing?.inDuration, 0));
    const endTime = Math.min(
      durationSeconds,
      segment.time + finiteNumber(segment.easing?.outDuration, 0),
    );
    if (endTime - startTime <= 1e-9) return [];

    return segment.lossFunctions.map((loss) => ({
      startTime,
      endTime,
      sourceStartTime: segment.time,
      sourceEndTime: segment.time,
      weight: finiteNumber(segment.weight, 1),
      loss,
      pointTime: segment.time,
      ...(segment.easing ? { easing: segment.easing } : {}),
    }));
  });

  const boundaries = uniqueSorted([
    0,
    durationSeconds,
    ...spans.flatMap((span) => [span.startTime, span.endTime]),
  ].filter((time) => time >= 0 && time <= durationSeconds));

  const bands: ActiveLossBand[] = [];
  for (let index = 0; index + 1 < boundaries.length; index += 1) {
    const startTime = boundaries[index]!;
    const endTime = boundaries[index + 1]!;
    if (endTime - startTime <= 1e-9) continue;

    const active = spans.filter(
      (span) => span.startTime < endTime - 1e-9 && span.endTime > startTime + 1e-9,
    );
    if (active.length > 0) bands.push({ startTime, endTime, active });
  }

  return bands;
}
