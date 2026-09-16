import { clamp } from "./math";

/** Exact integrals of the authored, piecewise-polynomial speed profile. */
interface SpeedProfileKeyframe {
  normalizedTime: number;
  speedMultiplier: number;
  easing?: string;
}

interface SpeedSegment {
  start: number;
  end: number;
  from: number;
  to: number;
  easing?: string;
  prefixArea: number;
}

interface IntegratedProfile {
  signature: string;
  segments: SpeedSegment[];
  totalArea: number;
}

// Arrays are retained weakly. The signature also detects in-place author edits.
const profileCache = new WeakMap<object, IntegratedProfile>();

function parseKeyframes(value: unknown): SpeedProfileKeyframe[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error("speedKeyframes must be an array");
  return value.map((item, index) => {
    if (!item || typeof item !== "object") throw new Error(`Invalid speedKeyframes[${index}]`);
    const { normalizedTime, speedMultiplier, easing } = item as Record<string, unknown>;
    if (typeof normalizedTime !== "number" || !Number.isFinite(normalizedTime)
      || normalizedTime < 0 || normalizedTime > 1) {
      throw new Error(`speedKeyframes[${index}].normalizedTime must be within 0..1`);
    }
    if (typeof speedMultiplier !== "number" || !Number.isFinite(speedMultiplier) || speedMultiplier < 0) {
      throw new Error(`speedKeyframes[${index}].speedMultiplier must be finite and non-negative`);
    }
    if (index > 0 && normalizedTime <= value[index - 1].normalizedTime) {
      throw new Error("speedKeyframes must be strictly ordered by normalizedTime");
    }
    if (easing !== undefined && easing !== "linear" && easing !== "increase"
      && easing !== "decrease" && easing !== "static") {
      throw new Error(`Unknown speed keyframe easing: ${String(easing)}`);
    }
    return { normalizedTime, speedMultiplier, ...(easing === undefined ? {} : { easing }) };
  });
}

/** Integrate m(v)=a+(b-a)E(v) from 0 to alpha, including piecewise holds. */
function segmentArea(segment: SpeedSegment, alpha: number): number {
  const v = clamp(alpha, 0, 1);
  const integratedEasing = segment.easing === "static" ? 0
    : segment.easing === "increase" ? v * v * v / 3
      : segment.easing === "decrease" ? v * v - v * v * v / 3
        : v * v / 2;
  // This convex form avoids cancellation for profiles decelerating to zero.
  return (segment.end - segment.start) * (
    segment.from * (v - integratedEasing) + segment.to * integratedEasing
  );
}

function integratedProfile(rawKeyframes: unknown): IntegratedProfile | undefined {
  const keyframes = parseKeyframes(rawKeyframes);
  if (keyframes.length === 0) return undefined;
  const signature = JSON.stringify(keyframes);
  const cached = profileCache.get(rawKeyframes as object);
  if (cached?.signature === signature) return cached;

  // Only relative speed matters. Scaling before integration prevents overflow
  // and preserves tiny but positive profiles instead of treating them as zero.
  const peak = Math.max(...keyframes.map((keyframe) => keyframe.speedMultiplier));
  if (peak === 0) {
    throw new Error("speedKeyframes must have positive integrated speed; use a Static action for a hold");
  }
  const normalized = keyframes.map((keyframe) => ({
    ...keyframe,
    speedMultiplier: keyframe.speedMultiplier / peak,
  }));
  const segments: SpeedSegment[] = [];
  let totalArea = 0;
  const append = (start: number, end: number, from: number, to: number, easing?: string): void => {
    if (end <= start) return;
    const segment = { start, end, from, to, easing, prefixArea: totalArea };
    totalArea += segmentArea(segment, 1);
    segments.push(segment);
  };
  const first = normalized[0]!;
  append(0, first.normalizedTime, first.speedMultiplier, first.speedMultiplier);
  for (let index = 1; index < normalized.length; index += 1) {
    const left = normalized[index - 1]!;
    const right = normalized[index]!;
    append(left.normalizedTime, right.normalizedTime, left.speedMultiplier, right.speedMultiplier,
      right.easing ?? left.easing);
  }
  const last = normalized[normalized.length - 1]!;
  append(last.normalizedTime, 1, last.speedMultiplier, last.speedMultiplier);
  if (!(totalArea > 0)) {
    throw new Error("speedKeyframes must have positive integrated speed; isolated nonzero endpoints do not define motion");
  }
  const profile = { signature, segments, totalArea };
  profileCache.set(rawKeyframes as object, profile);
  return profile;
}

/** Validate direct compiler callers as well as schema-validated DSL callers. */
export function validateMotionProfile(rawKeyframes: unknown): void {
  integratedProfile(rawKeyframes);
}

/** Normalized cumulative integral; nonnegative speed always moves forward. */
export function motionProgress(normalizedTime: number, rawKeyframes: unknown): number {
  if (!Number.isFinite(normalizedTime)) throw new Error("Motion progress time must be finite");
  const profile = integratedProfile(rawKeyframes);
  const time = clamp(normalizedTime, 0, 1);
  if (!profile || time === 0 || time === 1) return time;
  let left = 0;
  let right = profile.segments.length - 1;
  while (left < right) {
    const middle = (left + right) >>> 1;
    if (profile.segments[middle]!.end < time) left = middle + 1;
    else right = middle;
  }
  const segment = profile.segments[left]!;
  const alpha = (time - segment.start) / (segment.end - segment.start);
  return clamp((segment.prefixArea + segmentArea(segment, alpha)) / profile.totalArea, 0, 1);
}

export function motionProgressDelta(
  startTime: number,
  endTime: number,
  intervalStart: number,
  intervalEnd: number,
  rawKeyframes: unknown,
): number {
  const duration = Math.max(1e-9, intervalEnd - intervalStart);
  const start = (startTime - intervalStart) / duration;
  const end = (endTime - intervalStart) / duration;
  return motionProgress(end, rawKeyframes) - motionProgress(start, rawKeyframes);
}
