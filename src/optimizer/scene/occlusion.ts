import type { Vec3 } from "../../types/environment";
import type { WorldAabbV1 } from "../../types/environment-query";
import { aabbCorners } from "./projection";
import { minimumSignedDistanceToMovingAabb } from "./spatial-geometry";

/** Representative rays, not an estimate of projected visible pixel area. */
export function subjectSightTargets(box: WorldAabbV1, center: Vec3 = box.center): Vec3[] {
  return [center, ...aabbCorners(box)];
}

/**
 * RMS continuous clearance violation along sight segments. The caller excludes
 * each ray target's own entity. Exact segment minima prevent thin obstacles
 * disappearing between ray samples; box SDFs remain piecewise differentiable.
 */
export function sightClearanceResidual(
  camera: Vec3,
  targets: readonly Vec3[],
  obstacles: readonly WorldAabbV1[],
  margin: number,
): number {
  if (!Number.isFinite(margin) || margin < 0) throw new Error("Sight clearance margin must be nonnegative");
  if (targets.length === 0 || obstacles.length === 0) return 0;
  let squared = 0;
  for (const target of targets) {
    const clearance = Math.min(...obstacles.map((box) =>
      minimumSignedDistanceToMovingAabb(camera, target, box, box, margin),
    ));
    squared += Math.max(0, margin - clearance) ** 2;
  }
  return Math.sqrt(squared / targets.length);
}
