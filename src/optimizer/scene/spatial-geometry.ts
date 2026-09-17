import { sampleEnvironmentEntityTransform, sampleEnvironmentSubject, worldAabbForBounds } from "../../environment/sampler";
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

/**
 * Minimum signed distance along a segment while the box faces move linearly.
 * Solves each face/edge region analytically, so a thin wall cannot fall between
 * camera samples. An optional search radius cheaply rejects distant boxes.
 */
export function minimumSignedDistanceToMovingAabb(
  start: Vec3,
  end: Vec3,
  startBox: WorldAabbV1,
  endBox: WorldAabbV1 = startBox,
  searchRadius = Infinity,
): number {
  const intercepts: number[] = [];
  const slopes: number[] = [];
  let lower = 0;
  let upper = 1;
  for (let axis = 0; axis < 3; axis += 1) {
    const cameraStep = end[axis]! - start[axis]!;
    intercepts.push(startBox.min[axis]! - start[axis]!, start[axis]! - startBox.max[axis]!);
    slopes.push(
      endBox.min[axis]! - startBox.min[axis]! - cameraStep,
      cameraStep - (endBox.max[axis]! - startBox.max[axis]!),
    );
  }
  // Intersection with the swept, inflated slabs is only a broad phase: the
  // distance below still uses Euclidean distance around edges and corners.
  for (let face = 0; face < 6; face += 1) {
    const slope = slopes[face]!;
    const intercept = intercepts[face]!;
    if (Math.abs(slope) <= 1e-12) {
      if (intercept > searchRadius) return searchRadius;
    } else {
      const crossing = (searchRadius - intercept) / slope;
      if (slope > 0) upper = Math.min(upper, crossing);
      else lower = Math.max(lower, crossing);
      if (lower > upper) return searchRadius;
    }
  }
  const distanceAt = (alpha: number): number => {
    let squared = 0;
    let nearestFace = -Infinity;
    for (let axis = 0; axis < 3; axis += 1) {
      const face = 2 * axis;
      const distance = Math.max(
        intercepts[face]! + slopes[face]! * alpha,
        intercepts[face + 1]! + slopes[face + 1]! * alpha,
      );
      squared += Math.max(0, distance) ** 2;
      nearestFace = Math.max(nearestFace, distance);
    }
    return squared > 0 ? Math.sqrt(squared) : nearestFace;
  };
  let minimum = Math.min(distanceAt(lower), distanceAt(upper));
  const boundaries = [lower, upper];
  for (let face = 0; face < 6; face += 1) {
    if (Math.abs(slopes[face]!) <= 1e-12) continue;
    const crossing = -intercepts[face]! / slopes[face]!;
    if (crossing > lower && crossing < upper) boundaries.push(crossing);
  }
  boundaries.sort((a, b) => a - b);
  for (let index = 1; index < boundaries.length; index += 1) {
    const from = boundaries[index - 1]!;
    const to = boundaries[index]!;
    const midpoint = (from + to) / 2;
    let quadratic = 0;
    let linear = 0;
    for (let face = 0; face < 6; face += 1) {
      if (intercepts[face]! + slopes[face]! * midpoint <= 0) continue;
      quadratic += slopes[face]! ** 2;
      linear += intercepts[face]! * slopes[face]!;
    }
    minimum = Math.min(minimum, distanceAt(from), distanceAt(to));
    if (quadratic > 0) {
      minimum = Math.min(minimum, distanceAt(Math.max(from, Math.min(to, -linear / quadratic))));
    } else if (distanceAt(midpoint) <= 0) {
      // Inside, signed distance is the maximum of the six affine face
      // distances. Its minimum is at an endpoint or where two faces tie.
      for (let first = 0; first < 6; first += 1) {
        for (let second = first + 1; second < 6; second += 1) {
          const denominator = slopes[first]! - slopes[second]!;
          if (Math.abs(denominator) <= 1e-12) continue;
          const crossing = (intercepts[second]! - intercepts[first]!) / denominator;
          if (crossing > from && crossing < to) minimum = Math.min(minimum, distanceAt(crossing));
        }
      }
    }
  }
  return minimum;
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

/** Sight proxies may omit glass/open space; collision continues using entity.bounds. */
export function sampleOcclusionBoxes(
  environment: EnvironmentV1,
  time: number,
): Array<{ entityId: string; box: WorldAabbV1 }> {
  return environment.entities.flatMap((entity) => {
    if (entity.occlusion?.transparent === true) return [];
    const bounds = entity.occlusion?.bounds ?? (entity.bounds ? [entity.bounds] : []);
    if (bounds.length === 0) return [];
    const transform = sampleEnvironmentEntityTransform(entity, time);
    return bounds.map((piece) => ({ entityId: entity.id, box: worldAabbForBounds(piece, transform) }));
  });
}
