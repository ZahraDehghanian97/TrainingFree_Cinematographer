import { crossesCut } from "../shared/time";
import type { CameraStateSample } from "../types";
import type { StateCodec } from "./state-codec";

export interface SearchDirection {
  values: Float64Array;
  radius: number;
  coarse?: boolean;
}

/** Visit widely separated physical times first, without assuming uniform FPS. */
function coarseToFine(dimensions: readonly number[], codec: StateCodec, times: readonly number[]): number[] {
  if (dimensions.length < 3) return [...dimensions];
  const ordered = [dimensions[0]!, dimensions[dimensions.length - 1]!];
  const remaining = new Map(dimensions.slice(1, -1).map((dimension) => {
    const time = times[codec.references[dimension]!.stateIndex]!;
    return [dimension, Math.min(...ordered.map((chosen) =>
      Math.abs(time - times[codec.references[chosen]!.stateIndex]!)))];
  }));
  while (remaining.size > 0) {
    let best = -1;
    let separation = -Infinity;
    for (const [dimension, distance] of remaining) {
      if (distance > separation) { best = dimension; separation = distance; }
    }
    ordered.push(best);
    remaining.delete(best);
    const chosenTime = times[codec.references[best]!.stateIndex]!;
    for (const [dimension, distance] of remaining) {
      remaining.set(dimension, Math.min(distance,
        Math.abs(times[codec.references[dimension]!.stateIndex]! - chosenTime)));
    }
  }
  return ordered;
}

/**
 * Shot modes followed by a complete, temporally preconditioned coordinate basis.
 * (M+s²K)^-1 M is invertible on free coordinates: smoothing
 * changes conditioning without discarding independent knot motions. Locks/cuts
 * already supply boundary conditions in StateCodec's filter. Use a single
 * pass: repeated filtering makes neighboring columns nearly parallel on dense
 * grids and prevents local jerk correction. Curvature-adapted line searches
 * provide the small steps needed for the remaining high-frequency stiffness.
 */
export function createSearchDirections(
  codec: StateCodec,
  states: readonly CameraStateSample[],
  cutTimes: readonly number[],
): SearchDirection[] {
  const times = states.map((state) => state.time);
  const shotByState = [0];
  for (let state = 1; state < states.length; state += 1) {
    shotByState[state] = shotByState[state - 1]!
      + (crossesCut(times[state - 1]!, times[state]!, cutTimes) ? 1 : 0);
  }
  const groups = new Map<string, number[]>();
  codec.references.forEach((reference, dimension) => {
    const key = `${shotByState[reference.stateIndex]}:${reference.component}`;
    const group = groups.get(key) ?? [];
    group.push(dimension);
    groups.set(key, group);
  });
  const directions: SearchDirection[] = [];
  const append = (values: Float64Array, radius: number, coarse = false): void => {
    const filtered = codec.smoothDirection(values);
    let maximum = 0;
    for (const value of filtered) maximum = Math.max(maximum, Math.abs(value));
    if (maximum === 0 || !Number.isFinite(maximum)) return;
    directions.push({ values: filtered.map((value) => value / maximum), radius, coarse });
  };
  for (const dimensions of groups.values()) {
    const firstTime = times[codec.references[dimensions[0]!]!.stateIndex]!;
    const lastTime = times[codec.references[dimensions[dimensions.length - 1]!]!.stateIndex]!;
    const constant = new Float64Array(codec.references.length);
    dimensions.forEach((dimension) => { constant[dimension] = 1; });
    append(constant, 0.01, true);
    if (lastTime > firstTime) {
      const ramp = new Float64Array(codec.references.length);
      dimensions.forEach((dimension) => {
        ramp[dimension] = 2 * (times[codec.references[dimension]!.stateIndex]! - firstTime)
          / (lastTime - firstTime) - 1;
      });
      append(ramp, 0.005, true);
    }
  }
  // Interleave channels so a short budget explores position, rotation and lens.
  const orderedGroups = [...groups.values()].map((dimensions) => coarseToFine(dimensions, codec, times));
  for (let rank = 0; rank < Math.max(...orderedGroups.map((group) => group.length)); rank += 1) {
    for (const group of orderedGroups) {
      const dimension = group[rank];
      if (dimension === undefined || group.length === 1) continue;
      const coordinate = new Float64Array(codec.references.length);
      coordinate[dimension] = 1;
      append(coordinate, 0.001);
    }
  }
  return directions;
}
