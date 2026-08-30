import { sampleEnvironmentSubject } from "../../environment/sampler";
import type { EnvironmentV1, Vec3 } from "../../types/environment";
import type { WorldAabbV1 } from "../../types/environment-query";
import { add3, scale3 } from "../shared/math";

/** Positive outside the box; negative inside by distance to the nearest face. */
export function signedDistanceToAabb(point: Vec3, box: WorldAabbV1): number {
  const outside: Vec3 = [
    Math.max(box.min[0] - point[0], 0, point[0] - box.max[0]),
    Math.max(box.min[1] - point[1], 0, point[1] - box.max[1]),
    Math.max(box.min[2] - point[2], 0, point[2] - box.max[2]),
  ];
  const outsideDistance = Math.hypot(outside[0], outside[1], outside[2]);
  if (outsideDistance > 0) return outsideDistance;
  return -Math.min(
    point[0] - box.min[0], box.max[0] - point[0],
    point[1] - box.min[1], box.max[1] - point[1],
    point[2] - box.min[2], box.max[2] - point[2],
  );
}

export function segmentIntersectsAabb(start: Vec3, end: Vec3, box: WorldAabbV1): boolean {
  let minimum = 0;
  let maximum = 1;
  const direction = add3(end, scale3(start, -1));
  for (let axis = 0; axis < 3; axis += 1) {
    if (Math.abs(direction[axis]) < 1e-10) {
      if (start[axis] < box.min[axis] || start[axis] > box.max[axis]) return false;
      continue;
    }
    const inverse = 1 / direction[axis];
    let near = (box.min[axis] - start[axis]) * inverse;
    let far = (box.max[axis] - start[axis]) * inverse;
    if (near > far) [near, far] = [far, near];
    minimum = Math.max(minimum, near);
    maximum = Math.min(maximum, far);
    if (minimum > maximum) return false;
  }
  return maximum >= 0 && minimum <= 1;
}

export function sampleObstacleBoxes(
  environment: EnvironmentV1,
  time: number,
  excludedEntityIds: ReadonlySet<string> = new Set(),
): Array<{ entityId: string; box: WorldAabbV1 }> {
  const result: Array<{ entityId: string; box: WorldAabbV1 }> = [];
  for (const entity of environment.entities) {
    if (excludedEntityIds.has(entity.id) || entity.bounds === undefined) continue;
    const sample = sampleEnvironmentSubject(environment, entity.id, time);
    if (sample.box) result.push({ entityId: entity.id, box: sample.box });
  }
  return result;
}
