import type { Keyframe, SceneEntityV1, Vec3 } from "../types/environment";

/** Velocity in units per second, shared by the two segments meeting at a knot. */
function knotVelocity(keyframes: readonly Keyframe<Vec3>[], index: number, axis: number): number {
  if (index === 0 || index === keyframes.length - 1) return 0;

  const previous = keyframes[index - 1];
  const current = keyframes[index];
  const next = keyframes[index + 1];
  const beforeDuration = current.t - previous.t;
  const afterDuration = next.t - current.t;
  const beforeSlope = (current.value[axis] - previous.value[axis]) / beforeDuration;
  const afterSlope = (next.value[axis] - current.value[axis]) / afterDuration;

  // Rest at a hold or reversal instead of overshooting and walking backwards.
  if (beforeSlope === 0 || afterSlope === 0 || Math.sign(beforeSlope) !== Math.sign(afterSlope)) {
    return 0;
  }

  // Duration-weighted harmonic tangents preserve monotonicity even when an
  // author places a brief movement next to a much longer segment.
  const beforeWeight = 2 * afterDuration + beforeDuration;
  const afterWeight = afterDuration + 2 * beforeDuration;
  return (beforeWeight + afterWeight) / (beforeWeight / beforeSlope + afterWeight / afterSlope);
}

/**
 * Smooth automatic humanoid travel while preserving every authored waypoint,
 * its time, and held positions. Both renderers and environment queries use this
 * curve so the visible person and camera targets remain at the same position.
 * Other visuals, explicit motion styles and step channels use their own sampler.
 */
export function sampleLocomotionPosition(entity: SceneEntityV1, time: number): Vec3 | undefined {
  const visual = entity.visual;
  if (visual.type !== "preset" || visual.name !== "humanoid") return undefined;
  const motion = visual.params?.motion;
  if (motion === "idle" || motion === "dance" || motion === "float" || motion === "punch") return undefined;

  const position = entity.transform.position;
  if (
    Array.isArray(position)
    || (position.interpolation !== "linear" && position.interpolation !== "catmullRom")
    || position.keyframes.length < 2
  ) return undefined;

  const keyframes = position.keyframes;
  const lastIndex = keyframes.length - 1;
  if (time <= keyframes[0].t) return [...keyframes[0].value];
  if (time >= keyframes[lastIndex].t) return [...keyframes[lastIndex].value];

  let leftIndex = 0;
  let rightIndex = lastIndex;
  while (leftIndex + 1 < rightIndex) {
    const middle = (leftIndex + rightIndex) >>> 1;
    if (keyframes[middle].t <= time) leftIndex = middle;
    else rightIndex = middle;
  }
  const left = keyframes[leftIndex];
  const right = keyframes[rightIndex];
  if (time === left.t) return [...left.value];

  const duration = right.t - left.t;
  const alpha = (time - left.t) / duration;
  const alpha2 = alpha * alpha;
  const alpha3 = alpha2 * alpha;
  const fromWeight = 2 * alpha3 - 3 * alpha2 + 1;
  const toWeight = -2 * alpha3 + 3 * alpha2;
  const fromVelocityWeight = alpha3 - 2 * alpha2 + alpha;
  const toVelocityWeight = alpha3 - alpha2;
  return [0, 1, 2].map((axis) => {
    const from = left.value[axis];
    const to = right.value[axis];
    if (from === to) return from;
    const value = fromWeight * from + toWeight * to
      + duration * (
        fromVelocityWeight * knotVelocity(keyframes, leftIndex, axis)
        + toVelocityWeight * knotVelocity(keyframes, rightIndex, axis)
      );
    // The monotone tangents already bound the curve; clamp floating-point noise.
    return Math.max(Math.min(from, to), Math.min(Math.max(from, to), value));
  }) as Vec3;
}
