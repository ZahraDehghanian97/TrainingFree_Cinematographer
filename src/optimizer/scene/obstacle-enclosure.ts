import {
  sampleEnvironmentEntityTransform,
  worldAabbForBounds,
} from "../../environment/sampler";
import { sampleLocomotionPosition } from "../../environment/locomotion-path";
import type { Channel, EnvironmentV1, Quat, SceneEntityV1, Vec3 } from "../../types/environment";
import type { WorldAabbV1 } from "../../types/environment-query";
import { conjugateQuat, multiplyQuat, rotate3 } from "../shared/math";

export interface CertifiedObstacleSweep {
  startBox: WorldAabbV1;
  endBox: WorldAabbV1;
  /** An enclosure is stationary and contains every actual box in the interval. */
  model: "affine" | "enclosure";
}

function keyframed<T>(channel: Channel<T> | undefined): channel is Exclude<Channel<T>, T> {
  return channel !== undefined && !Array.isArray(channel) && typeof channel === "object" && channel !== null && "keyframes" in channel;
}

function makeBox(min: Vec3, max: Vec3): WorldAabbV1 {
  return {
    coordinateSpace: "world", min, max,
    center: min.map((value, axis) => (value + max[axis]!) / 2) as Vec3,
    size: min.map((value, axis) => max[axis]! - value) as Vec3,
  };
}

/** Exact polynomial extrema from four interpolation values, plus roundoff pad. */
function cubicRange(values: readonly number[]): [number, number] {
  const [p0, p1, p2, p3] = values as [number, number, number, number];
  const b1 = (-5 * p0 + 18 * p1 - 9 * p2 + 2 * p3) / 6;
  const b2 = (2 * p0 - 9 * p1 + 18 * p2 - 5 * p3) / 6;
  const a = -p0 + 3 * b1 - 3 * b2 + p3;
  const b = 3 * (p0 - 2 * b1 + b2);
  const c = 3 * (b1 - p0);
  const candidates = [...values];
  const at = (u: number) => {
    if (u > 0 && u < 1) candidates.push(((a * u + b) * u + c) * u + p0);
  };
  if (a === 0) {
    if (b !== 0) at(-c / (2 * b));
  } else {
    const discriminant = 4 * b * b - 12 * a * c;
    if (discriminant >= 0) {
      const q = -b - (b < 0 ? -1 : 1) * Math.sqrt(discriminant) / 2;
      at(q / (3 * a));
      if (q !== 0) at(c / q);
    }
  }
  const padding = 256 * Number.EPSILON * Math.max(1, ...values.map(Math.abs), Math.abs(b1), Math.abs(b2));
  return [Math.min(...candidates) - padding, Math.max(...candidates) + padding];
}

function sameRotation(a: Quat, b: Quat): boolean {
  return a.every((value, axis) => value === b[axis]) || a.every((value, axis) => value === -b[axis]!);
}

function rotationAngle(a: Quat, b: Quat): number {
  const delta = multiplyQuat(b, conjugateQuat(a));
  return 2 * Math.atan2(Math.hypot(delta[0], delta[1], delta[2]), Math.abs(delta[3]));
}

function enclosePiece(entity: SceneEntityV1, from: number, to: number): WorldAabbV1 {
  const samples = [0, 1 / 3, 2 / 3, 1].map((alpha) => sampleEnvironmentEntityTransform(
    entity, alpha === 1 ? to : from + (to - from) * alpha, alpha === 1 ? "left" : "right",
  ));
  // Every supported translation/scale channel is at most cubic between its
  // knots (including the shared humanoid Hermite path). Thus four values here
  // reconstruct the polynomial; these are not heuristic temporal samples.
  const positionRanges = [0, 1, 2].map((axis) => cubicRange(samples.map((sample) => sample.position[axis]!)));
  const scaleRanges = [0, 1, 2].map((axis) => cubicRange(samples.map((sample) => sample.scale[axis]!)));
  const bounds = entity.bounds!;
  const localMin = bounds.type === "box" ? bounds.min : bounds.center.map((value) => value - bounds.radius) as Vec3;
  const localMax = bounds.type === "box" ? bounds.max : bounds.center.map((value) => value + bounds.radius) as Vec3;
  const scaledRanges = [0, 1, 2].map((axis) => {
    const values = [localMin[axis]!, localMax[axis]!].flatMap((value) => scaleRanges[axis]!.map((scale) => value * scale));
    return [Math.min(...values), Math.max(...values)] as [number, number];
  });
  const maxScales = scaleRanges.map(([low, high]) => Math.max(Math.abs(low!), Math.abs(high!)));
  const radius = bounds.type === "box"
    ? Math.hypot(...scaledRanges.map(([low, high]) => Math.max(Math.abs(low), Math.abs(high))))
    : Math.hypot(...bounds.center.map((value, axis) => value * maxScales[axis]!)) + bounds.radius * Math.max(...maxScales);
  const rotation = samples[0]!.rotation;
  // On a single rotation interval SLERP and normalized LERP traverse the same
  // shortest great-circle arc monotonically. A point of radius r moves at most
  // 2r sin(theta/2) from the reference rotation anywhere on that arc.
  const angle = sameRotation(rotation, samples[3]!.rotation) ? 0 : rotationAngle(rotation, samples[3]!.rotation);
  const deviation = 2 * radius * Math.sin(Math.min(Math.PI, angle) / 2);
  const columns = ([ [1, 0, 0], [0, 1, 0], [0, 0, 1] ] as Vec3[]).map((axis) => rotate3(axis, rotation));
  const min: Vec3 = [0, 0, 0], max: Vec3 = [0, 0, 0];
  for (let axis = 0; axis < 3; axis += 1) {
    let low = 0, high = 0;
    for (let localAxis = 0; localAxis < 3; localAxis += 1) {
      const products = scaledRanges[localAxis]!.map((value) => value * columns[localAxis]![axis]!);
      low += Math.min(...products); high += Math.max(...products);
    }
    const padding = 256 * Number.EPSILON * Math.max(1, radius, Math.abs(low), Math.abs(high));
    min[axis] = positionRanges[axis]![0]! + Math.max(-radius, low - deviation) - padding;
    max[axis] = positionRanges[axis]![1]! + Math.min(radius, high + deviation) + padding;
  }
  return makeBox(min, max);
}

/**
 * A certified model for an entire scene-time interval. Affine motion keeps its
 * exact moving boxes; nonlinear motion uses an interval enclosure. The proof
 * uses polynomial extrema and rotation bounds, never a sampling-rate claim.
 * With endExclusive, a step at the endpoint uses its exact left-hand limit;
 * the caller must check the right-hand pose in its next sweep or knot.
 */
export function certifiedObstacleSweep(
  environment: EnvironmentV1,
  entityId: string,
  startSceneTime: number,
  endSceneTime: number,
  options: { endExclusive?: boolean } = {},
): CertifiedObstacleSweep {
  if (!Number.isFinite(startSceneTime) || !Number.isFinite(endSceneTime) || endSceneTime < startSceneTime) {
    throw new Error("Obstacle enclosure requires an ordered finite time interval");
  }
  const entity = environment.entities.find((candidate) => candidate.id === entityId);
  if (!entity?.bounds) throw new Error(`Obstacle ${entityId} has no bounds`);
  const channels = [entity.transform.position, entity.transform.rotation, entity.transform.scale];
  const knots = [...new Set(channels.flatMap((channel) => keyframed(channel)
    ? channel.keyframes.map((keyframe) => keyframe.t) : []))];
  const boundaries = [startSceneTime, ...knots.filter((time) => time > startSceneTime && time < endSceneTime).sort((a, b) => a - b), endSceneTime];
  const start = sampleEnvironmentEntityTransform(entity, startSceneTime);
  const end = sampleEnvironmentEntityTransform(entity, endSceneTime, options.endExclusive ? "left" : "right");
  const startBox = worldAabbForBounds(entity.bounds, start);
  const endBox = worldAabbForBounds(entity.bounds, end);
  if (startSceneTime === endSceneTime) return { startBox, endBox: startBox, model: "affine" };
  const position = entity.transform.position;
  const midpoint = (startSceneTime + endSceneTime) / 2;
  const positionIsAffine = !keyframed(position) || position.interpolation !== "catmullRom"
    || midpoint < position.keyframes[0]!.t || midpoint > position.keyframes.at(-1)!.t;
  const containsStepJump = channels.some((channel) => keyframed(channel) && channel.interpolation === "step"
    && channel.keyframes.some((keyframe) => keyframe.t > startSceneTime
      && (options.endExclusive ? keyframe.t < endSceneTime : keyframe.t <= endSceneTime)));
  const rotationIsConstant = !keyframed(entity.transform.rotation)
    || entity.transform.rotation.interpolation === "step"
    || sameRotation(start.rotation, end.rotation);
  const scale = entity.transform.scale;
  const scaleIsConstant = !keyframed(scale) || scale.interpolation === "step"
    || midpoint < scale.keyframes[0]!.t || midpoint > scale.keyframes.at(-1)!.t
    || (scale.interpolation === "linear" && start.scale.every((value, axis) => value === end.scale[axis]));
  if (boundaries.length === 2 && !containsStepJump && positionIsAffine && rotationIsConstant && scaleIsConstant
    && sampleLocomotionPosition(entity, midpoint) === undefined) {
    return { startBox, endBox, model: "affine" };
  }
  const boxes = [startBox, endBox];
  for (let index = 1; index < boundaries.length; index += 1) {
    boxes.push(enclosePiece(entity, boundaries[index - 1]!, boundaries[index]!));
  }
  const enclosure = makeBox(
    [0, 1, 2].map((axis) => Math.min(...boxes.map((box) => box.min[axis]!))) as Vec3,
    [0, 1, 2].map((axis) => Math.max(...boxes.map((box) => box.max[axis]!))) as Vec3,
  );
  return { startBox: enclosure, endBox: enclosure, model: "enclosure" };
}
