import type { Vec3 } from "../../types/environment";
import type { WorldAabbV1 } from "../../types/environment-query";
import { aabbCorners } from "./projection";
import { minimumSignedDistanceToMovingAabb, signedDistanceToAabb } from "./spatial-geometry";

/** Representative rays, not an estimate of projected visible pixel area. */
export function subjectSightTargets(box: WorldAabbV1, center: Vec3 = box.center): Vec3[] {
  return [center, ...aabbCorners(box)];
}

/**
 * RMS continuous clearance violation along sight segments. The caller excludes
 * each ray target's own entity. Exact segment minima prevent thin obstacles
 * disappearing between ray samples; box SDFs remain piecewise differentiable.
 * A target touching a support surface cannot meet a positive clearance buffer.
 * Limit that buffer to its nonnegative endpoint clearance for each obstacle.
 * Penetration remains penalized, including targets inside an opaque obstacle.
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
    const violation = Math.max(...obstacles.map((box) => {
      const attainableMargin = Math.min(margin, Math.max(0, signedDistanceToAabb(target, box)));
      const clearance = minimumSignedDistanceToMovingAabb(camera, target, box, box, attainableMargin);
      return Math.max(0, attainableMargin - clearance);
    }));
    squared += violation ** 2;
  }
  return Math.sqrt(squared / targets.length);
}
