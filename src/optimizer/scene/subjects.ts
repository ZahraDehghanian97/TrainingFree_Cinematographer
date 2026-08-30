import { sampleEnvironmentSubject } from "../../environment/sampler";
import type {
  Channel,
  EnvironmentV1,
  Keyframe,
  Quat,
  SceneEntityV1,
  Vec3,
} from "../../types/environment";
import type { WorldAabbV1 } from "../../types/environment-query";
import {
  clamp,
  mean,
  normalizeQuat,
  scale3,
} from "../shared/math";

export interface SubjectAggregate {
  subjectIds: string[];
  entityIds: string[];
  center: Vec3;
  box: WorldAabbV1;
  rotation: Quat;
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
