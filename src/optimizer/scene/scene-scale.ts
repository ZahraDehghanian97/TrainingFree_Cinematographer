import type { EnvironmentV1, Vec3 } from "../../types/environment";
import { certifiedObstacleSweep } from "./obstacle-enclosure";

/**
 * Spatial conditioning scale, independent of the camera path and sampling FPS.
 * The diagonal encloses every bounded entity throughout the scene animation,
 * including cubic extrema and rotations. It scales with a change of scene
 * length units; it is not an estimate of metric calibration or measurement noise.
 */
export function sceneReferenceScale(environment: EnvironmentV1): number {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const entity of environment.entities) {
    if (entity.bounds === undefined) continue;
    const sweep = certifiedObstacleSweep(environment, entity.id, 0, environment.clock.durationSeconds);
    for (const box of [sweep.startBox, sweep.endBox]) {
      for (let axis = 0; axis < 3; axis += 1) {
        min[axis] = Math.min(min[axis]!, box.min[axis]!);
        max[axis] = Math.max(max[axis]!, box.max[axis]!);
      }
    }
  }
  const diagonal = Math.hypot(...min.map((value, axis) => max[axis]! - value));
  if (Number.isFinite(diagonal) && diagonal > 0) return diagonal;
  const groundSize = environment.world?.ground?.size;
  if (groundSize?.every((value) => Number.isFinite(value) && value > 0)) {
    return Math.hypot(...groundSize);
  }
  return 5;
}
