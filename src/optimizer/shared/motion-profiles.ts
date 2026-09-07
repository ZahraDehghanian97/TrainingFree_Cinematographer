import { clamp } from "./math";

/** Helpers for integrating authored speed profiles into normalized motion. */

interface SpeedProfileKeyframe {
  normalizedTime: number;
  speedMultiplier: number;
  easing?: string;
}

function parseKeyframes(value: unknown): SpeedProfileKeyframe[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is SpeedProfileKeyframe => {
    if (!item || typeof item !== "object") return false;
    const candidate = item as Record<string, unknown>;
    return typeof candidate.normalizedTime === "number"
      && Number.isFinite(candidate.normalizedTime)
      && typeof candidate.speedMultiplier === "number"
      && Number.isFinite(candidate.speedMultiplier)
      && candidate.speedMultiplier >= 0;
  }).map((item) => ({
    normalizedTime: clamp(item.normalizedTime, 0, 1),
    speedMultiplier: item.speedMultiplier,
    ...(typeof item.easing === "string" ? { easing: item.easing } : {}),
  })).sort((a, b) => a.normalizedTime - b.normalizedTime);
}

function eased(alpha: number, easing: string | undefined): number {
  if (easing === "increase") return alpha * alpha;
  if (easing === "decrease") return 1 - (1 - alpha) * (1 - alpha);
  if (easing === "static") return 0;
  return alpha;
}

function multiplierAt(normalizedTime: number, keyframes: readonly SpeedProfileKeyframe[]): number {
  if (keyframes.length === 0) return 1;
  if (normalizedTime <= keyframes[0]!.normalizedTime) return keyframes[0]!.speedMultiplier;
  if (normalizedTime >= keyframes[keyframes.length - 1]!.normalizedTime) {
    return keyframes[keyframes.length - 1]!.speedMultiplier;
  }
  for (let index = 0; index + 1 < keyframes.length; index += 1) {
    const left = keyframes[index]!;
    const right = keyframes[index + 1]!;
    if (normalizedTime < left.normalizedTime || normalizedTime > right.normalizedTime) continue;
    const span = Math.max(1e-9, right.normalizedTime - left.normalizedTime);
    const alpha = eased((normalizedTime - left.normalizedTime) / span, right.easing ?? left.easing);
    return left.speedMultiplier + (right.speedMultiplier - left.speedMultiplier) * alpha;
  }
  return 1;
}

function integratedSpeed(
  end: number,
  keyframes: readonly SpeedProfileKeyframe[],
  steps = 96,
): number {
  const clampedEnd = clamp(end, 0, 1);
  if (clampedEnd <= 0) return 0;
  let integral = 0;
  let previousTime = 0;
  let previousValue = multiplierAt(0, keyframes);
  const count = Math.max(2, Math.ceil(steps * clampedEnd));
  for (let index = 1; index <= count; index += 1) {
    const time = clampedEnd * index / count;
    const value = multiplierAt(time, keyframes);
    integral += (time - previousTime) * (previousValue + value) / 2;
    previousTime = time;
    previousValue = value;
  }
  return integral;
}

/** Cumulative normalized motion progress, normalized to finish at exactly one. */
export function motionProgress(normalizedTime: number, rawKeyframes: unknown): number {
  const keyframes = parseKeyframes(rawKeyframes);
  if (keyframes.length === 0) return clamp(normalizedTime, 0, 1);
  const total = integratedSpeed(1, keyframes);
  return total <= 1e-9
    ? clamp(normalizedTime, 0, 1)
    : clamp(integratedSpeed(normalizedTime, keyframes) / total, 0, 1);
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
