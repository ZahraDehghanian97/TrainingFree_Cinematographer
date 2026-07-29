import type { Keyframe, Quat, Vec3 } from "../../src/types/environment";

export type Vec3Interpolation = "step" | "linear" | "catmullRom";

export interface KeyframeInterval {
  leftIndex: number;
  rightIndex: number;
  alpha: number;
}

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function lerp(a: number, b: number, alpha: number): number {
  return a + (b - a) * alpha;
}

export function lerpVec3(a: Vec3, b: Vec3, alpha: number): Vec3 {
  return [
    lerp(a[0], b[0], alpha),
    lerp(a[1], b[1], alpha),
    lerp(a[2], b[2], alpha),
  ];
}

export function normalizeQuat(value: Quat): Quat {
  const length = Math.hypot(value[0], value[1], value[2], value[3]);
  if (length <= Number.EPSILON) {
    throw new Error("Cannot normalize a zero-length quaternion");
  }
  return [
    value[0] / length,
    value[1] / length,
    value[2] / length,
    value[3] / length,
  ];
}

/** Quaternion spherical interpolation in x, y, z, w order. */
export function slerpQuat(from: Quat, to: Quat, alpha: number): Quat {
  const a = normalizeQuat(from);
  let b = normalizeQuat(to);
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];

  // q and -q encode the same rotation. Negating selects the shorter arc.
  if (dot < 0) {
    dot = -dot;
    b = [-b[0], -b[1], -b[2], -b[3]];
  }

  dot = clamp(dot, -1, 1);
  if (dot > 0.9995) {
    return normalizeQuat([
      lerp(a[0], b[0], alpha),
      lerp(a[1], b[1], alpha),
      lerp(a[2], b[2], alpha),
      lerp(a[3], b[3], alpha),
    ]);
  }

  const theta = Math.acos(dot);
  const sinTheta = Math.sin(theta);
  const fromWeight = Math.sin((1 - alpha) * theta) / sinTheta;
  const toWeight = Math.sin(alpha * theta) / sinTheta;
  return normalizeQuat([
    a[0] * fromWeight + b[0] * toWeight,
    a[1] * fromWeight + b[1] * toWeight,
    a[2] * fromWeight + b[2] * toWeight,
    a[3] * fromWeight + b[3] * toWeight,
  ]);
}

/** Finds the samples bracketing time, holding the endpoints outside the track. */
export function findKeyframeInterval<T>(
  keyframes: readonly Keyframe<T>[],
  timeSeconds: number,
): KeyframeInterval {
  if (keyframes.length === 0) {
    throw new Error("Cannot sample an empty keyframe sequence");
  }
  const lastIndex = keyframes.length - 1;
  if (timeSeconds <= keyframes[0].t) {
    return { leftIndex: 0, rightIndex: 0, alpha: 0 };
  }
  if (timeSeconds >= keyframes[lastIndex].t) {
    return { leftIndex: lastIndex, rightIndex: lastIndex, alpha: 0 };
  }

  let low = 0;
  let high = lastIndex;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (keyframes[middle].t <= timeSeconds) {
      low = middle;
    } else {
      high = middle;
    }
  }

  if (keyframes[low].t === timeSeconds) {
    return { leftIndex: low, rightIndex: low, alpha: 0 };
  }
  const span = keyframes[high].t - keyframes[low].t;
  return {
    leftIndex: low,
    rightIndex: high,
    alpha: (timeSeconds - keyframes[low].t) / span,
  };
}

function catmullRomComponent(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  alpha: number,
): number {
  const alpha2 = alpha * alpha;
  const alpha3 = alpha2 * alpha;
  return 0.5 * (
    2 * p1
    + (-p0 + p2) * alpha
    + (2 * p0 - 5 * p1 + 4 * p2 - p3) * alpha2
    + (-p0 + 3 * p1 - 3 * p2 + p3) * alpha3
  );
}

export function sampleVec3Keyframes(
  keyframes: readonly Keyframe<Vec3>[],
  timeSeconds: number,
  interpolation: Vec3Interpolation,
): Vec3 {
  const interval = findKeyframeInterval(keyframes, timeSeconds);
  const left = keyframes[interval.leftIndex].value;
  if (interval.leftIndex === interval.rightIndex || interpolation === "step") {
    return [...left] as Vec3;
  }
  const right = keyframes[interval.rightIndex].value;
  if (interpolation === "linear") {
    return lerpVec3(left, right, interval.alpha);
  }

  const p0 = keyframes[Math.max(0, interval.leftIndex - 1)].value;
  const p3 = keyframes[Math.min(keyframes.length - 1, interval.rightIndex + 1)].value;
  return [
    catmullRomComponent(p0[0], left[0], right[0], p3[0], interval.alpha),
    catmullRomComponent(p0[1], left[1], right[1], p3[1], interval.alpha),
    catmullRomComponent(p0[2], left[2], right[2], p3[2], interval.alpha),
  ];
}

export function sampleQuatKeyframes(
  keyframes: readonly Keyframe<Quat>[],
  timeSeconds: number,
  interpolation: "step" | "slerp",
): Quat {
  const interval = findKeyframeInterval(keyframes, timeSeconds);
  const left = keyframes[interval.leftIndex].value;
  if (interval.leftIndex === interval.rightIndex || interpolation === "step") {
    return normalizeQuat(left);
  }
  return slerpQuat(left, keyframes[interval.rightIndex].value, interval.alpha);
}

