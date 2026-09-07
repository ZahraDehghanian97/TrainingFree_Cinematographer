import type { Quat, Vec3 } from "../../types/environment";
import type { WorldAabbV1 } from "../../types/environment-query";
import {
  add3,
  clamp,
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
  const tangent = Math.tan(clamp(fovYDegrees, 1, 179) * Math.PI / 360);
  if (depth <= 1e-6 || tangent <= 1e-9) {
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
): ScreenBounds {
  const points = aabbCorners(box).map((corner) => projectWorldPoint(
    corner,
    cameraPosition,
    cameraRotation,
    fovYDegrees,
    aspectRatio,
  ));
  const visiblePoints = points.filter((point) => point.visible);
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
    behindCamera: visiblePoints.length !== points.length,
  };
}
