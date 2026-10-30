import type { SceneEntityV1, Vec3 } from "../../src/types/environment";

/** Pure view-only decision; use the sampled world position for animated entities.
 * Authoring metadata cannot make collision geometry disappear. */
export function visibleInArchitectureOverview(
  entity: SceneEntityV1,
  cameraPosition: Vec3,
  worldPosition: Vec3,
  cutaway: boolean,
  director: boolean,
): boolean {
  if (director || !cutaway) return true;
  const layout = entity.layout;
  if (layout?.cutaway === "roof") return false;
  if (layout?.cutaway !== "wall" || !layout.outwardNormal) return true;
  const facing = layout.outwardNormal.reduce((sum, n, i) => sum + n * (cameraPosition[i] - worldPosition[i]), 0);
  return facing <= 0.1;
}
