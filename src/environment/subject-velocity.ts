import type { EnvironmentV1, Quat, Vec3 } from "../types/environment";
import { differentiateCubicVec3 } from "./cubic-channel";
import { sampleLocomotionPosition } from "./locomotion-path";
import { resolveEnvironmentSubject, sampleEnvironmentSubject } from "./sampler";

export interface AnalyticSubjectVelocity {
  velocity: Vec3;
  /** A teleport has no finite velocity at its jump time. */
  positionJump: boolean;
}

export type SubjectVelocitySample =
  | { kind: "analytic" | "finiteDifference"; /** World-space meters per second. */ velocity: Vec3 }
  | { kind: "positionJump" };

export function subjectVelocitySampleRadius(environment: EnvironmentV1): number {
  const fps = Math.max(environment.clock.fpsHint ?? 24, 24);
  return Math.min(1 / (fps * 4), Math.max(environment.clock.durationSeconds / 10_000, 1e-4));
}

interface CenterJump {
  time: number;
  /** Exact one-sided center limits, with all continuous channels evaluated at time. */
  before: Vec3;
  after: Vec3;
}

/**
 * Step changes in any transform channel can teleport a nonzero local anchor.
 * Compare sampled center limits, not individual channel values: rotation of an
 * origin-centered subject, quaternion sign changes, and compensating transform
 * steps need not move its center at all. Sampling a copied pre-step transform
 * also preserves the renderer's automatic humanoid position override.
 */
function subjectCenterJumps(environment: EnvironmentV1, subjectId: string): CenterJump[] {
  const { entity } = resolveEnvironmentSubject(environment, subjectId);
  const names = ["position", "rotation", "scale"] as const;
  const candidateTimes = [...new Set(names.flatMap((name) => {
    const channel = entity.transform[name];
    return channel !== undefined && !Array.isArray(channel) && channel.interpolation === "step"
      ? channel.keyframes.slice(1).map((key) => key.t) : [];
  }))].filter((time) => time >= 0 && time <= environment.clock.durationSeconds).sort((a, b) => a - b);
  return candidateTimes.flatMap((time) => {
    const transform = { ...entity.transform };
    for (const name of names) {
      const channel = entity.transform[name];
      if (channel === undefined || Array.isArray(channel) || channel.interpolation !== "step") continue;
      const knot = channel.keyframes.findIndex((key) => key.t === time);
      if (knot <= 0) continue;
      const before = channel.keyframes[knot - 1]!.value;
      if (name === "rotation") transform.rotation = before as Quat;
      else transform[name] = before as Vec3;
    }
    const beforeEnvironment = { ...environment,
      entities: environment.entities.map((candidate) => candidate === entity ? { ...entity, transform } : candidate),
    };
    const before = sampleEnvironmentSubject(beforeEnvironment, subjectId, time).center;
    const after = sampleEnvironmentSubject(environment, subjectId, time).center;
    return before.some((value, axis) => value !== after[axis]) ? [{ time, before, after }] : [];
  });
}

function sampleVelocityWithinContinuousSpan(
  environment: EnvironmentV1, subjectId: string, time: number, jumps: readonly CenterJump[],
): SubjectVelocitySample {
  // Check center discontinuities BEFORE deciding whether the derivative can be
  // analytic: unsupported rotating/scaling anchors can still have exact jumps.
  if (jumps.some((jump) => jump.time === time)) return { kind: "positionJump" };
  const analytic = analyticSubjectVelocity(environment, subjectId, time);
  if (analytic) return analytic.positionJump
    ? { kind: "positionJump" } : { kind: "analytic", velocity: analytic.velocity };
  const radius = subjectVelocitySampleRadius(environment);
  const previousJump = jumps.filter((jump) => jump.time < time).at(-1);
  const nextJump = jumps.find((jump) => jump.time > time);
  // Numerical estimates only see one continuous piece. The left limit at the
  // upcoming jump is evaluated explicitly, without an arbitrary time epsilon.
  const left = Math.max(0, time - radius, previousJump?.time ?? -Infinity);
  const right = Math.min(environment.clock.durationSeconds, time + radius, nextJump?.time ?? Infinity);
  if (right <= left) return { kind: "finiteDifference", velocity: [0, 0, 0] };
  const from = previousJump?.time === left ? previousJump.after
    : sampleEnvironmentSubject(environment, subjectId, left).center;
  const to = nextJump?.time === right ? nextJump.before
    : sampleEnvironmentSubject(environment, subjectId, right).center;
  return { kind: "finiteDifference", velocity: from.map((value, axis) =>
    (to[axis]! - value) / (right - left)) as Vec3 };
}

/**
 * Resolve step boundaries once for a synchronous event scan. Recreate after
 * editing an environment; there is deliberately no global mutable-scene cache.
 */
export function createEnvironmentSubjectVelocitySampler(
  environment: EnvironmentV1, subjectId: string,
): (time: number) => SubjectVelocitySample {
  const jumps = subjectCenterJumps(environment, subjectId);
  return (time) => sampleVelocityWithinContinuousSpan(environment, subjectId, time, jumps);
}

/** Shared speed/velocity semantics for individual environment samples. */
export function sampleEnvironmentSubjectVelocity(
  environment: EnvironmentV1, subjectId: string, time: number,
): SubjectVelocitySample {
  return createEnvironmentSubjectVelocitySampler(environment, subjectId)(time);
}

/**
 * Exact derivative when the sampled center is a polynomial translation plus a
 * constant offset. Undefined means unsupported geometry, requiring the existing
 * numerical estimate (animated nonzero anchors or automatic humanoid travel).
 * Interior linear corners use the right-hand derivative; track endpoints use
 * the inward derivative and held extrapolation outside the track has speed 0.
 * Step tracks have velocity 0 between jumps; positionJump excludes an undefined
 * instantaneous teleport speed from velocity predicates.
 */
export function analyticSubjectVelocity(
  environment: EnvironmentV1, subjectId: string, time: number,
): AnalyticSubjectVelocity | undefined {
  const subject = resolveEnvironmentSubject(environment, subjectId);
  const { entity } = subject;
  const bounds = entity.bounds;
  const offset: Vec3 = subject.semanticAnchor?.localAnchor ?? (bounds?.type === "sphere" ? bounds.center
    : bounds?.type === "box" ? bounds.min.map((value, axis) => (value + bounds.max[axis]!) / 2) as Vec3
      : [0, 0, 0]);
  if (offset.some((value) => value !== 0)
    && [entity.transform.rotation, entity.transform.scale].some((channel) =>
      channel !== undefined && !Array.isArray(channel))) return undefined;
  // This visible path uses different, monotone Hermite tangents. Keep the
  // established finite-difference behavior until its derivative is supported.
  if (sampleLocomotionPosition(entity, time) !== undefined) return undefined;

  const channel = entity.transform.position;
  const stationary = (): AnalyticSubjectVelocity => ({ velocity: [0, 0, 0], positionJump: false });
  if (Array.isArray(channel)) return stationary();
  if (channel.interpolation === "slerp") return undefined;
  const keys = channel.keyframes;
  if (keys.length === 0) throw new Error("Cannot differentiate an empty position channel");
  const lastIndex = keys.length - 1;
  if (keys.length === 1 || time < keys[0]!.t || time > keys[lastIndex]!.t) return stationary();
  let left = 0, right = lastIndex;
  while (left + 1 < right) {
    const middle = (left + right) >>> 1;
    if (keys[middle]!.t <= time) left = middle;
    else right = middle;
  }
  if (channel.interpolation === "step") {
    const knot = time === keys[right]!.t ? right : time === keys[left]!.t ? left : -1;
    const positionJump = knot > 0
      && keys[knot]!.value.some((value, axis) => value !== keys[knot - 1]!.value[axis]);
    return { velocity: [0, 0, 0], positionJump };
  }
  const span = keys[right]!.t - keys[left]!.t;
  const velocity = channel.interpolation === "linear"
    ? keys[left]!.value.map((value, axis) => (keys[right]!.value[axis]! - value) / span) as Vec3
    : differentiateCubicVec3(keys, left, right, (time - keys[left]!.t) / span);
  return { velocity, positionJump: false };
}
