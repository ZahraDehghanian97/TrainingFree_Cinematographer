import { sampleEnvironmentSubject } from "../environment/sampler";
import type {
  Channel,
  EnvironmentV1,
  Keyframe,
  Quat,
  SceneEntityV1,
  Vec3,
} from "../types/environment";
import type { WorldAabbV1 } from "../types/environment-query";
import {
  add3,
  clamp,
  conjugateQuat,
  mean,
  normalizeQuat,
  rotate3,
  scale3,
} from "./math";

export interface SubjectAggregate {
  subjectIds: string[];
  entityIds: string[];
  center: Vec3;
  box: WorldAabbV1;
  rotation: Quat;
}

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

function isKeyframed<T>(channel: Channel<T>): channel is Exclude<Channel<T>, T> {
  return channel !== null && !Array.isArray(channel) && typeof channel === "object" && "keyframes" in channel;
}

function intervalFor<T>(keyframes: readonly Keyframe<T>[], time: number): [number, number, number] {
  if (time <= keyframes[0]!.t) return [0, 0, 0];
  const last = keyframes.length - 1;
  if (time >= keyframes[last]!.t) return [last, last, 0];
  let low = 0;
  let high = last;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (keyframes[middle]!.t <= time) low = middle;
    else high = middle;
  }
  const span = keyframes[high]!.t - keyframes[low]!.t;
  return [low, high, span <= 0 ? 0 : (time - keyframes[low]!.t) / span];
}

function sampleQuaternionChannel(channel: Channel<Quat> | undefined, time: number): Quat {
  if (channel === undefined) return [0, 0, 0, 1];
  if (!isKeyframed(channel)) return normalizeQuat(channel);
  const [leftIndex, rightIndex, alpha] = intervalFor(channel.keyframes, time);
  const left = normalizeQuat(channel.keyframes[leftIndex]!.value);
  if (leftIndex === rightIndex || channel.interpolation === "step") return left;
  let right = normalizeQuat(channel.keyframes[rightIndex]!.value);
  let dot = left[0] * right[0] + left[1] * right[1] + left[2] * right[2] + left[3] * right[3];
  if (dot < 0) {
    dot = -dot;
    right = [-right[0], -right[1], -right[2], -right[3]];
  }
  dot = clamp(dot, -1, 1);
  if (dot > 0.9995) {
    return normalizeQuat([
      left[0] + (right[0] - left[0]) * alpha,
      left[1] + (right[1] - left[1]) * alpha,
      left[2] + (right[2] - left[2]) * alpha,
      left[3] + (right[3] - left[3]) * alpha,
    ]);
  }
  const theta = Math.acos(dot);
  const sine = Math.sin(theta);
  const a = Math.sin((1 - alpha) * theta) / sine;
  const b = Math.sin(alpha * theta) / sine;
  return normalizeQuat([
    left[0] * a + right[0] * b,
    left[1] * a + right[1] * b,
    left[2] * a + right[2] * b,
    left[3] * a + right[3] * b,
  ]);
}

export function sampleEntityRotation(entity: SceneEntityV1, time: number): Quat {
  return sampleQuaternionChannel(entity.transform.rotation, time);
}

function fallbackBox(center: Vec3): WorldAabbV1 {
  const half: Vec3 = [0.1, 0.1, 0.1];
  return {
    coordinateSpace: "world",
    min: [center[0] - half[0], center[1] - half[1], center[2] - half[2]],
    max: [center[0] + half[0], center[1] + half[1], center[2] + half[2]],
    center: [...center] as Vec3,
    size: scale3(half, 2),
  };
}

export function subjectIdsFromParameters(parameters: Record<string, unknown>): string[] {
  if (typeof parameters.subjectId === "string" && parameters.subjectId.trim()) {
    return [parameters.subjectId.trim()];
  }
  if (Array.isArray(parameters.subjectIds)) {
    return [...new Set(parameters.subjectIds.filter(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    ).map((value) => value.trim()))];
  }
  return [];
}

export function sampleSubjectAggregate(
  environment: EnvironmentV1,
  subjectIds: readonly string[],
  time: number,
): SubjectAggregate | undefined {
  if (subjectIds.length === 0) return undefined;
  const samples = subjectIds.map((subjectId) => sampleEnvironmentSubject(environment, subjectId, time));
  const boxes = samples.map((sample) => sample.box ?? fallbackBox(sample.center));
  const min: Vec3 = [
    Math.min(...boxes.map((box) => box.min[0])),
    Math.min(...boxes.map((box) => box.min[1])),
    Math.min(...boxes.map((box) => box.min[2])),
  ];
  const max: Vec3 = [
    Math.max(...boxes.map((box) => box.max[0])),
    Math.max(...boxes.map((box) => box.max[1])),
    Math.max(...boxes.map((box) => box.max[2])),
  ];
  const center: Vec3 = [
    mean(samples.map((sample) => sample.center[0])),
    mean(samples.map((sample) => sample.center[1])),
    mean(samples.map((sample) => sample.center[2])),
  ];
  const entityIds = [...new Set(samples.map((sample) => sample.entityId))];
  const primaryEntity = environment.entities.find((entity) => entity.id === entityIds[0]);
  return {
    subjectIds: [...subjectIds],
    entityIds,
    center,
    box: {
      coordinateSpace: "world",
      min,
      max,
      center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
      size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
    },
    rotation: primaryEntity ? sampleEntityRotation(primaryEntity, time) : [0, 0, 0, 1],
  };
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

