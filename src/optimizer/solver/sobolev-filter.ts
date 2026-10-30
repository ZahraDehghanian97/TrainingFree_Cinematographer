import { crossesCut } from "../shared/time";

/**
 * Piecewise-linear, mass-lumped discretization of
 *   min_z 1/2 integral (z - g)^2 dt + s^2/2 integral (dz/dt)^2 dt.
 * Missing (locked) coordinates have z=0; cuts have no connecting edge.
 * The factorization of M + s^2 K is reused for every optimizer iteration.
 */
export function createSobolevFilter(
  times: readonly number[],
  freeStateIndices: readonly number[],
  cutTimes: readonly number[],
  smoothingSeconds: number,
): (values: Float64Array) => Float64Array {
  if (!Number.isFinite(smoothingSeconds) || smoothingSeconds < 0) {
    throw new Error("Temporal smoothing duration must be finite and nonnegative");
  }
  if (!times.every(Number.isFinite)) throw new Error("Optimizer sample times must be finite");
  for (let index = 1; index < times.length; index += 1) {
    if (!Number.isFinite(times[index]!) || times[index]! <= times[index - 1]!) {
      throw new Error("Optimizer sample times must be finite and strictly increasing");
    }
  }
  const dimensionByState = new Map(freeStateIndices.map((index, dimension) => [index, dimension]));
  const count = freeStateIndices.length;
  const mass = new Float64Array(count);
  const diagonal = new Float64Array(count);
  const upper = new Float64Array(count);
  const lower = new Float64Array(count);
  const strength = smoothingSeconds * smoothingSeconds;
  freeStateIndices.forEach((stateIndex, dimension) => {
    let stiffness = 0;
    for (const neighbor of [stateIndex - 1, stateIndex + 1]) {
      if (neighbor < 0 || neighbor >= times.length) continue;
      const left = Math.min(stateIndex, neighbor);
      const right = Math.max(stateIndex, neighbor);
      if (crossesCut(times[left]!, times[right]!, cutTimes)) continue;
      const span = times[right]! - times[left]!;
      mass[dimension] += span / 2;
      const coefficient = strength / span;
      stiffness += coefficient;
      const neighborDimension = dimensionByState.get(neighbor);
      if (neighborDimension === undefined) continue;
      if (neighbor < stateIndex) lower[dimension] = -coefficient;
      else upper[dimension] = -coefficient;
    }
    // An isolated state has no derivative energy and passes through unchanged.
    if (mass[dimension] === 0) mass[dimension] = 1;
    diagonal[dimension] = mass[dimension]! + stiffness;
  });
  for (let index = 1; index < count; index += 1) {
    lower[index] /= diagonal[index - 1]!;
    diagonal[index] -= lower[index]! * upper[index - 1]!;
  }
  return (values) => {
    if (values.length !== count) throw new Error("Temporal filter dimension mismatch");
    const result = Float64Array.from(values, (value, index) => mass[index]! * value);
    for (let index = 1; index < count; index += 1) {
      result[index] -= lower[index]! * result[index - 1]!;
    }
    for (let index = count - 1; index >= 0; index -= 1) {
      result[index] = (result[index]! - (upper[index]! * (result[index + 1] ?? 0))) / diagonal[index]!;
    }
    return result;
  };
}
