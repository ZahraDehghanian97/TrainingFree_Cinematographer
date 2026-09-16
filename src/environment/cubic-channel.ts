import type { Keyframe, Vec3 } from "../types/environment";

/** A single physical velocity per knot, including nonuniform keyframe times. */
function knotVelocity(keyframes: readonly Keyframe<Vec3>[], index: number, axis: number): number {
  const current = keyframes[index]!;
  const before = keyframes[Math.max(0, index - 1)]!;
  const after = keyframes[Math.min(keyframes.length - 1, index + 1)]!;
  if (index === 0) return (after.value[axis]! - current.value[axis]!) / (after.t - current.t);
  if (index === keyframes.length - 1) return (current.value[axis]! - before.value[axis]!) / (current.t - before.t);
  const h0 = current.t - before.t, h1 = after.t - current.t;
  const v0 = (current.value[axis]! - before.value[axis]!) / h0;
  const v1 = (after.value[axis]! - current.value[axis]!) / h1;
  return (h1 * v0 + h0 * v1) / (h0 + h1);
}

/** Time-aware Catmull–Rom expressed as cubic Hermite; shared with rendering. */
export function interpolateCubicVec3(
  keyframes: readonly Keyframe<Vec3>[], leftIndex: number, rightIndex: number, alpha: number,
): Vec3 {
  const left = keyframes[leftIndex]!, right = keyframes[rightIndex]!;
  if (leftIndex === rightIndex) return [...left.value];
  const span = right.t - left.t;
  const u2 = alpha * alpha, u3 = u2 * alpha;
  return [0, 1, 2].map((axis) =>
    (2 * u3 - 3 * u2 + 1) * left.value[axis]!
    + (u3 - 2 * u2 + alpha) * span * knotVelocity(keyframes, leftIndex, axis)
    + (-2 * u3 + 3 * u2) * right.value[axis]!
    + (u3 - u2) * span * knotVelocity(keyframes, rightIndex, axis),
  ) as Vec3;
}
