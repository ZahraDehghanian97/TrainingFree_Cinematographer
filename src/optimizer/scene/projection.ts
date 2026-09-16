import type { Quat, Vec3 } from "../../types/environment";
import type { WorldAabbV1 } from "../../types/environment-query";
import {
  add3,
  conjugateQuat,
  rotate3,
  scale3,
} from "../shared/math";

export interface ScreenProjection {
  x: number;
  y: number;
  depth: number;
  visible: boolean;
}

export interface ScreenBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  centerX: number;
  centerY: number;
  width: number;
  height: number;
  behindCamera: boolean;
}

/** Use the authored pinhole lens over its full supported angular domain. */
function projectionTangent(fovYDegrees: number, aspectRatio: number): number {
  if (!Number.isFinite(fovYDegrees) || fovYDegrees <= 0 || fovYDegrees >= 180) {
    throw new Error("Projection FOV must be finite and strictly between 0 and 180 degrees");
  }
  if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) {
    throw new Error("Projection aspect ratio must be finite and positive");
  }
  const tangent = Math.tan(fovYDegrees * Math.PI / 360);
  if (tangent === 0) throw new Error("Projection FOV is too small to represent numerically");
  return tangent;
}

export function aabbCorners(box: WorldAabbV1): Vec3[] {
  const result: Vec3[] = [];
  for (const x of [box.min[0], box.max[0]]) {
    for (const y of [box.min[1], box.max[1]]) {
      for (const z of [box.min[2], box.max[2]]) result.push([x, y, z]);
    }
  }
  return result;
}

export function projectWorldPoint(
  point: Vec3,
  cameraPosition: Vec3,
  cameraRotation: Quat,
  fovYDegrees: number,
  aspectRatio: number,
): ScreenProjection {
  const local = rotate3(add3(point, scale3(cameraPosition, -1)), conjugateQuat(cameraRotation));
  const depth = -local[2];
  const tangent = projectionTangent(fovYDegrees, aspectRatio);
  if (depth <= 1e-6) {
    return { x: 0.5, y: 0.5, depth, visible: false };
  }
  const normalizedX = local[0] / (depth * tangent * aspectRatio);
  const normalizedY = local[1] / (depth * tangent);
  return {
    x: 0.5 + normalizedX / 2,
    y: 0.5 - normalizedY / 2,
    depth,
    visible: true,
  };
}

export function projectWorldBox(
  box: WorldAabbV1,
  cameraPosition: Vec3,
  cameraRotation: Quat,
  fovYDegrees: number,
  aspectRatio: number,
  nearPlane = 1e-6,
): ScreenBounds {
  if (!Number.isFinite(nearPlane) || nearPlane <= 0) throw new Error("Projection near plane must be positive");
  const tangent = projectionTangent(fovYDegrees, aspectRatio);
  const corners = aabbCorners(box).map((corner) => rotate3(
    add3(corner, scale3(cameraPosition, -1)), conjugateQuat(cameraRotation),
  ));
  // The clipped polyhedron's vertices are retained corners and intersections
  // of its twelve edges with the near plane. Dropping rear corners alone
  // underestimates the projected extent when an edge crosses the camera plane.
  const clipped = corners.filter((corner) => -corner[2] >= nearPlane);
  for (let index = 0; index < corners.length; index += 1) {
    for (const bit of [1, 2, 4]) {
      const other = index ^ bit;
      if (other <= index) continue;
      const from = corners[index]!, to = corners[other]!;
      const fromDepth = -from[2], toDepth = -to[2];
      if ((fromDepth < nearPlane) === (toDepth < nearPlane)) continue;
      const alpha = (nearPlane - fromDepth) / (toDepth - fromDepth);
      clipped.push([
        from[0] + alpha * (to[0] - from[0]),
        from[1] + alpha * (to[1] - from[1]),
        -nearPlane,
      ]);
    }
  }
  const visiblePoints = clipped.map(([x, y, z]) => ({
    x: 0.5 + x / (-2 * z * tangent * aspectRatio),
    y: 0.5 - y / (-2 * z * tangent),
  }));
  if (visiblePoints.length === 0) {
    return {
      minX: 0.5,
      maxX: 0.5,
      minY: 0.5,
      maxY: 0.5,
      centerX: 0.5,
      centerY: 0.5,
      width: 0,
      height: 0,
      behindCamera: true,
    };
  }
  const minX = Math.min(...visiblePoints.map((point) => point.x));
  const maxX = Math.max(...visiblePoints.map((point) => point.x));
  const minY = Math.min(...visiblePoints.map((point) => point.y));
  const maxY = Math.max(...visiblePoints.map((point) => point.y));
  return {
    minX,
    maxX,
    minY,
    maxY,
    centerX: (minX + maxX) / 2,
    centerY: (minY + maxY) / 2,
    width: maxX - minX,
    height: maxY - minY,
    behindCamera: corners.some((corner) => -corner[2] < nearPlane),
  };
}
