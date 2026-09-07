import type {
  BoundsV1,
  Channel,
  EnvironmentV1,
  Keyframe,
  Quat,
  SceneEntityV1,
  SceneTargetV1,
  Vec3,
} from "../types/environment";
import type {
  EnvironmentSubjectKind,
  SubjectBoxSampleV1,
  WorldAabbV1,
} from "../types/environment-query";

interface SampledTransform {
  position: Vec3;
  rotation: Quat;
  scale: Vec3;
}

interface ResolvedSubject {
  id: string;
  kind: EnvironmentSubjectKind;
  entity: SceneEntityV1;
  target?: SceneTargetV1;
  label?: string;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function lerp(a: number, b: number, alpha: number): number {
  return a + (b - a) * alpha;
}

function lerpVec3(a: Vec3, b: Vec3, alpha: number): Vec3 {
  return [
    lerp(a[0], b[0], alpha),
    lerp(a[1], b[1], alpha),
    lerp(a[2], b[2], alpha),
  ];
}

function normalizeQuat(value: Quat): Quat {
  const length = Math.hypot(value[0], value[1], value[2], value[3]);
  if (length <= Number.EPSILON) {
    throw new Error("Cannot normalize a zero-length quaternion");
  }
  return [
    value[0] / length,
    value[1] / length,
    value[2] / length,
    value[3] / length,
  ];
}

function slerpQuat(from: Quat, to: Quat, alpha: number): Quat {
  const a = normalizeQuat(from);
  let b = normalizeQuat(to);
  let dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];

  if (dot < 0) {
    dot = -dot;
    b = [-b[0], -b[1], -b[2], -b[3]];
  }

  dot = clamp(dot, -1, 1);
  if (dot > 0.9995) {
    return normalizeQuat([
      lerp(a[0], b[0], alpha),
      lerp(a[1], b[1], alpha),
      lerp(a[2], b[2], alpha),
      lerp(a[3], b[3], alpha),
    ]);
  }

  const theta = Math.acos(dot);
  const sinTheta = Math.sin(theta);
  const fromWeight = Math.sin((1 - alpha) * theta) / sinTheta;
  const toWeight = Math.sin(alpha * theta) / sinTheta;
  return normalizeQuat([
    a[0] * fromWeight + b[0] * toWeight,
    a[1] * fromWeight + b[1] * toWeight,
    a[2] * fromWeight + b[2] * toWeight,
    a[3] * fromWeight + b[3] * toWeight,
  ]);
}

function findKeyframeInterval<T>(
  keyframes: readonly Keyframe<T>[],
  timeSeconds: number,
): { leftIndex: number; rightIndex: number; alpha: number } {
  if (keyframes.length === 0) throw new Error("Cannot sample an empty keyframe channel");
  const lastIndex = keyframes.length - 1;

  if (timeSeconds <= keyframes[0]!.t) {
    return { leftIndex: 0, rightIndex: 0, alpha: 0 };
  }
  if (timeSeconds >= keyframes[lastIndex]!.t) {
    return { leftIndex: lastIndex, rightIndex: lastIndex, alpha: 0 };
  }

  let low = 0;
  let high = lastIndex;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (keyframes[middle]!.t <= timeSeconds) low = middle;
    else high = middle;
  }

  if (keyframes[low]!.t === timeSeconds) {
    return { leftIndex: low, rightIndex: low, alpha: 0 };
  }

  const span = keyframes[high]!.t - keyframes[low]!.t;
  return {
    leftIndex: low,
    rightIndex: high,
    alpha: (timeSeconds - keyframes[low]!.t) / span,
  };
}

function catmullRomComponent(
  p0: number,
  p1: number,
  p2: number,
  p3: number,
  alpha: number,
): number {
  const alpha2 = alpha * alpha;
  const alpha3 = alpha2 * alpha;
  return 0.5 * (
    2 * p1
    + (-p0 + p2) * alpha
    + (2 * p0 - 5 * p1 + 4 * p2 - p3) * alpha2
    + (-p0 + 3 * p1 - 3 * p2 + p3) * alpha3
  );
}

function sampleVec3Keyframes(
  keyframes: readonly Keyframe<Vec3>[],
  timeSeconds: number,
  interpolation: "step" | "linear" | "catmullRom" | "slerp",
): Vec3 {
  const interval = findKeyframeInterval(keyframes, timeSeconds);
  const left = keyframes[interval.leftIndex]!.value;
  if (interval.leftIndex === interval.rightIndex || interpolation === "step") {
    return [...left] as Vec3;
  }
  const right = keyframes[interval.rightIndex]!.value;
  if (interpolation === "linear") {
    return lerpVec3(left, right, interval.alpha);
  }
  if (interpolation === "slerp") {
    throw new Error("Vec3 channels cannot use slerp interpolation");
  }

  const p0 = keyframes[Math.max(0, interval.leftIndex - 1)]!.value;
  const p3 = keyframes[Math.min(keyframes.length - 1, interval.rightIndex + 1)]!.value;
  return [
    catmullRomComponent(p0[0], left[0], right[0], p3[0], interval.alpha),
    catmullRomComponent(p0[1], left[1], right[1], p3[1], interval.alpha),
    catmullRomComponent(p0[2], left[2], right[2], p3[2], interval.alpha),
  ];
}

function sampleQuatKeyframes(
  keyframes: readonly Keyframe<Quat>[],
  timeSeconds: number,
  interpolation: "step" | "linear" | "catmullRom" | "slerp",
): Quat {
  const interval = findKeyframeInterval(keyframes, timeSeconds);
  const left = keyframes[interval.leftIndex]!.value;
  if (interval.leftIndex === interval.rightIndex || interpolation === "step") {
    return normalizeQuat(left);
  }
  if (interpolation !== "slerp") {
    throw new Error("Quaternion channels must use step or slerp interpolation");
  }
  return slerpQuat(left, keyframes[interval.rightIndex]!.value, interval.alpha);
}

function isKeyframedChannel<T>(channel: Channel<T>): channel is Exclude<Channel<T>, T> {
  return channel !== null && !Array.isArray(channel) && typeof channel === "object" && "keyframes" in channel;
}

function sampleVec3Channel(channel: Channel<Vec3>, timeSeconds: number): Vec3 {
  if (!isKeyframedChannel(channel)) return [...channel] as Vec3;
  return sampleVec3Keyframes(channel.keyframes, timeSeconds, channel.interpolation);
}

function sampleQuatChannel(channel: Channel<Quat> | undefined, timeSeconds: number): Quat {
  if (channel === undefined) return [0, 0, 0, 1];
  if (!isKeyframedChannel(channel)) return normalizeQuat(channel);
  return sampleQuatKeyframes(channel.keyframes, timeSeconds, channel.interpolation);
}

function rotateVec3ByQuat(vector: Vec3, quaternion: Quat): Vec3 {
  const [x, y, z, w] = normalizeQuat(quaternion);
  const [vx, vy, vz] = vector;

  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);

  return [
    vx + w * tx + (y * tz - z * ty),
    vy + w * ty + (z * tx - x * tz),
    vz + w * tz + (x * ty - y * tx),
  ];
}

function transformLocalPoint(localPoint: Vec3, transform: SampledTransform): Vec3 {
  const scaled: Vec3 = [
    localPoint[0] * transform.scale[0],
    localPoint[1] * transform.scale[1],
    localPoint[2] * transform.scale[2],
  ];
  const rotated = rotateVec3ByQuat(scaled, transform.rotation);
  return [
    rotated[0] + transform.position[0],
    rotated[1] + transform.position[1],
    rotated[2] + transform.position[2],
  ];
}

function sampledEntityTransform(entity: SceneEntityV1, timeSeconds: number): SampledTransform {
  return {
    position: sampleVec3Channel(entity.transform.position, timeSeconds),
    rotation: sampleQuatChannel(entity.transform.rotation, timeSeconds),
    scale: entity.transform.scale
      ? sampleVec3Channel(entity.transform.scale, timeSeconds)
      : [1, 1, 1],
  };
}

function aabbFromPoints(points: Vec3[]): WorldAabbV1 {
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const point of points) {
    for (let axis = 0; axis < 3; axis += 1) {
      min[axis] = Math.min(min[axis]!, point[axis]!);
      max[axis] = Math.max(max[axis]!, point[axis]!);
    }
  }
  const center: Vec3 = [
    (min[0] + max[0]) / 2,
    (min[1] + max[1]) / 2,
    (min[2] + max[2]) / 2,
  ];
  const size: Vec3 = [
    max[0] - min[0],
    max[1] - min[1],
    max[2] - min[2],
  ];
  return { coordinateSpace: "world", min, max, center, size };
}

function worldAabbForBounds(bounds: BoundsV1, transform: SampledTransform): WorldAabbV1 {
  if (bounds.type === "sphere") {
    const center = transformLocalPoint(bounds.center, transform);
    const radiusAxes = ([
      [bounds.radius * transform.scale[0], 0, 0],
      [0, bounds.radius * transform.scale[1], 0],
      [0, 0, bounds.radius * transform.scale[2]],
    ] as Vec3[]).map((axis) => rotateVec3ByQuat(axis, transform.rotation));
    const extent: Vec3 = [0, 1, 2].map((worldAxis) => Math.hypot(
      radiusAxes[0]![worldAxis]!,
      radiusAxes[1]![worldAxis]!,
      radiusAxes[2]![worldAxis]!,
    )) as Vec3;
    const min: Vec3 = [
      center[0] - extent[0],
      center[1] - extent[1],
      center[2] - extent[2],
    ];
    const max: Vec3 = [
      center[0] + extent[0],
      center[1] + extent[1],
      center[2] + extent[2],
    ];
    return {
      coordinateSpace: "world",
      min,
      max,
      center,
      size: [extent[0] * 2, extent[1] * 2, extent[2] * 2],
    };
  }

  const corners: Vec3[] = [];
  for (const x of [bounds.min[0], bounds.max[0]]) {
    for (const y of [bounds.min[1], bounds.max[1]]) {
      for (const z of [bounds.min[2], bounds.max[2]]) {
        corners.push(transformLocalPoint([x, y, z], transform));
      }
    }
  }
  return aabbFromPoints(corners);
}

export function resolveEnvironmentSubject(env: EnvironmentV1, subjectId: string): ResolvedSubject {
  const target = env.targets.find((candidate) => candidate.id === subjectId);
  if (target) {
    const entity = env.entities.find((candidate) => candidate.id === target.entityId);
    if (!entity) {
      throw new Error(`Target ${JSON.stringify(subjectId)} references missing entity ${JSON.stringify(target.entityId)}`);
    }
    return {
      id: subjectId,
      kind: "target",
      entity,
      target,
      label: target.label ?? entity.label,
    };
  }

  const entity = env.entities.find((candidate) => candidate.id === subjectId);
  if (entity) {
    return {
      id: subjectId,
      kind: "entity",
      entity,
      label: entity.label,
    };
  }

  const available = [...env.targets.map((targetItem) => targetItem.id), ...env.entities.map((entityItem) => entityItem.id)];
  throw new Error(
    `Unknown environment subject ${JSON.stringify(subjectId)}. Available IDs: ${available.join(", ")}`,
  );
}

export function environmentSubjectKeyframeTimes(
  env: EnvironmentV1,
  subjectId: string,
): number[] {
  const { transform } = resolveEnvironmentSubject(env, subjectId).entity;
  const times: number[] = [];
  for (const channel of [transform.position, transform.rotation, transform.scale]) {
    if (channel !== undefined && isKeyframedChannel(channel)) {
      times.push(...channel.keyframes.map((keyframe) => keyframe.t));
    }
  }
  return [...new Set(times)].sort((a, b) => a - b);
}

export function sampleEnvironmentSubject(
  env: EnvironmentV1,
  subjectId: string,
  timeSeconds: number,
): SubjectBoxSampleV1 {
  const subject = resolveEnvironmentSubject(env, subjectId);
  const transform = sampledEntityTransform(subject.entity, timeSeconds);
  const center = subject.target
    ? transformLocalPoint(subject.target.localAnchor, transform)
    : transform.position;
  const localBounds = subject.target?.localBounds ?? subject.entity.bounds;
  const box = localBounds ? worldAabbForBounds(localBounds, transform) : null;

  return {
    subjectId,
    subjectKind: subject.kind,
    entityId: subject.entity.id,
    ...(subject.label ? { label: subject.label } : {}),
    center,
    box,
  };
}

export function distanceBetweenAabbs(a: WorldAabbV1, b: WorldAabbV1): number {
  let squared = 0;
  for (let axis = 0; axis < 3; axis += 1) {
    const separation = Math.max(
      a.min[axis]! - b.max[axis]!,
      b.min[axis]! - a.max[axis]!,
      0,
    );
    squared += separation * separation;
  }
  return Math.sqrt(squared);
}

export function distanceBetweenCenters(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}
