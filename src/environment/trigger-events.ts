import type { CameraTargetDescriptor } from "../types/camera";
import type { EventTrigger } from "../types/dsl";
import type { EnvironmentV1, Vec3 } from "../types/environment";
import { ComparisonOperator } from "../types/enums";
import {
  distanceBetweenAabbs,
  distanceBetweenCenters,
  environmentSubjectKeyframeTimes,
  resolveEnvironmentSubject,
  sampleEnvironmentSubject,
} from "./sampler";
import { createEnvironmentSubjectVelocitySampler, subjectVelocitySampleRadius } from "./subject-velocity";

const DEFAULT_VALUE_TOLERANCE = 1e-7;
const MAX_SCAN_INTERVALS = 100_000;

interface EventPredicate {
  valueAt: (timeSeconds: number) => number;
  matches: (value: number) => boolean;
  threshold: number;
  subjectIds: string[];
}

function resolvedTargetId(target: CameraTargetDescriptor): string {
  if (typeof target.id === "string") return target.id;
  throw new Error("Environment event triggers require resolved subject IDs");
}

function assertFinite(value: number, name: string, nonNegative = false): void {
  if (!Number.isFinite(value) || (nonNegative && value < 0)) {
    throw new Error(`${name} must be a finite ${nonNegative ? "non-negative " : ""}number`);
  }
}

/**
 * Values within epsilon of the threshold compare equal. Inclusive comparisons
 * include that band; strict comparisons and notEqual exclude it. Epsilon is in
 * meters for distance and meters/second for velocity, and defaults to 1e-7.
 */
function comparisonPredicate(
  operator: ComparisonOperator,
  threshold: number,
  epsilon: number,
): (value: number) => boolean {
  switch (operator) {
    case ComparisonOperator.LessThan: return (value) => value < threshold - epsilon;
    case ComparisonOperator.LessThanOrEqual: return (value) => value <= threshold + epsilon;
    case ComparisonOperator.Equal: return (value) => Math.abs(value - threshold) <= epsilon;
    case ComparisonOperator.GreaterThanOrEqual: return (value) => value >= threshold - epsilon;
    case ComparisonOperator.GreaterThan: return (value) => value > threshold + epsilon;
    case ComparisonOperator.NotEqual: return (value) => Math.abs(value - threshold) > epsilon;
    default: throw new Error(`Unsupported environment event comparator ${String(operator)}`);
  }
}

function createEventPredicate(trigger: EventTrigger, environment: EnvironmentV1): EventPredicate {
  const epsilon = environment.evaluation?.epsilon ?? DEFAULT_VALUE_TOLERANCE;
  assertFinite(epsilon, "Environment evaluation epsilon", true);
  assertFinite(environment.clock.durationSeconds, "Environment duration", true);

  let valueAt: EventPredicate["valueAt"];
  let threshold: number;
  let subjectIds: string[];
  if (trigger.type === "distance") {
    threshold = trigger.distance;
    assertFinite(threshold, "Distance threshold", true);
    const firstId = resolvedTargetId(trigger.object1);
    const secondId = resolvedTargetId(trigger.object2);
    subjectIds = [firstId, secondId];
    valueAt = (timeSeconds) => {
      const first = sampleEnvironmentSubject(environment, firstId, timeSeconds);
      const second = sampleEnvironmentSubject(environment, secondId, timeSeconds);
      if (environment.evaluation?.distanceMetric === "boundsSurface") {
        if (!first.box || !second.box) {
          throw new Error("boundsSurface distance requires bounds for both environment subjects");
        }
        return distanceBetweenAabbs(first.box, second.box);
      }
      return distanceBetweenCenters(first.center, second.center);
    };
  } else {
    threshold = trigger.speed;
    assertFinite(threshold, "Velocity threshold", trigger.direction === undefined);
    const subjectId = resolvedTargetId(trigger.subject);
    subjectIds = [subjectId];
    const sampleVelocity = createEnvironmentSubjectVelocitySampler(environment, subjectId);
    let direction: Vec3 | undefined;
    if (trigger.direction !== undefined) {
      const { x, y, z } = trigger.direction;
      const length = Math.hypot(x, y, z);
      if (!Number.isFinite(length) || length === 0) {
        throw new Error("Velocity direction must be a finite non-zero world-space vector");
      }
      direction = [x / length, y / length, z / length];
    }
    valueAt = (timeSeconds) => {
      const sampled = sampleVelocity(timeSeconds);
      // A position step has no finite instantaneous speed. NaN makes every
      // comparator, including notEqual, false; a teleport is not a speed event.
      if (sampled.kind === "positionJump") return NaN;
      const velocity = sampled.velocity;
      // A direction selects the signed projection onto a normalized world axis,
      // so movement opposite that axis has a negative velocity.
      return direction
        ? velocity[0] * direction[0] + velocity[1] * direction[1] + velocity[2] * direction[2]
        : Math.hypot(...velocity);
    };
  }
  subjectIds.forEach((id) => resolveEnvironmentSubject(environment, id));
  return { valueAt, threshold, subjectIds, matches: comparisonPredicate(trigger.operator, threshold, epsilon) };
}

function eventSampleTimes(
  trigger: EventTrigger,
  environment: EnvironmentV1,
  subjectIds: string[],
): number[] {
  const duration = environment.clock.durationSeconds;
  const rate = Math.max(environment.clock.fpsHint ?? 24, 60);
  assertFinite(rate, "Environment event sample rate", true);
  const sampleCount = Math.ceil(duration * rate);
  if (sampleCount > MAX_SCAN_INTERVALS) {
    throw new Error("Environment event scan would create more than 100000 samples");
  }
  const times = [0, duration];
  for (let index = 1; index < sampleCount; index += 1) times.push(index / rate);
  for (const subjectId of subjectIds) {
    for (const time of environmentSubjectKeyframeTimes(environment, subjectId)) {
      times.push(time);
      if (trigger.type === "velocity") {
        // Probe both sides of derivative corners and of the finite-difference
        // window retained for unsupported animated-anchor/locomotion geometry.
        const radius = subjectVelocitySampleRadius(environment);
        times.push(time - radius, time + radius);
      }
    }
  }
  return [...new Set(times.filter((time) => time >= 0 && time <= duration))].sort((a, b) => a - b);
}

/** Locate a continuous extremum, including contacts between adjacent frames. */
function findExtremum(
  valueAt: EventPredicate["valueAt"],
  leftTime: number,
  rightTime: number,
  sign: 1 | -1,
): number {
  const ratio = (Math.sqrt(5) - 1) / 2;
  let left = leftTime;
  let right = rightTime;
  let leftProbe = right - ratio * (right - left);
  let rightProbe = left + ratio * (right - left);
  let leftValue = sign * valueAt(leftProbe);
  let rightValue = sign * valueAt(rightProbe);
  for (let iteration = 0; iteration < 80; iteration += 1) {
    if (leftProbe === rightProbe || leftProbe === left || rightProbe === right) break;
    if (leftValue <= rightValue) {
      right = rightProbe;
      rightProbe = leftProbe;
      rightValue = leftValue;
      leftProbe = right - ratio * (right - left);
      leftValue = sign * valueAt(leftProbe);
    } else {
      left = leftProbe;
      leftProbe = rightProbe;
      leftValue = rightValue;
      rightProbe = left + ratio * (right - left);
      rightValue = sign * valueAt(rightProbe);
    }
  }
  return leftValue <= rightValue ? leftProbe : rightProbe;
}

/** Return a matching point, never an unchecked threshold boundary. */
function firstMatchInBracket(predicate: EventPredicate, leftTime: number, rightTime: number): number {
  let left = leftTime;
  let right = rightTime;
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const middle = (left + right) / 2;
    if (middle === left || middle === right) break;
    if (predicate.matches(predicate.valueAt(middle))) right = middle;
    else left = middle;
  }
  return right;
}

function equalityMatchInBracket(
  predicate: EventPredicate,
  leftTime: number,
  rightTime: number,
  leftValue: number,
): number | null {
  let left = leftTime;
  let right = rightTime;
  const startsBelow = leftValue < predicate.threshold;
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const middle = (left + right) / 2;
    if (middle === left || middle === right) break;
    const value = predicate.valueAt(middle);
    if (predicate.matches(value)) return firstMatchInBracket(predicate, leftTime, middle);
    if ((value < predicate.threshold) === startsBelow) left = middle;
    else right = middle;
  }
  // A step can jump across equality without ever matching it.
  return null;
}

/** Evaluate a DSL event at environment scene time (before playback retiming). */
export function eventTriggerMatchesAtSceneTime(
  trigger: EventTrigger,
  environment: EnvironmentV1,
  timeSeconds: number,
): boolean {
  assertFinite(timeSeconds, "Event sample time", true);
  if (timeSeconds > environment.clock.durationSeconds) {
    throw new Error("Event sample time is outside the environment duration");
  }
  const predicate = createEventPredicate(trigger, environment);
  return predicate.matches(predicate.valueAt(timeSeconds));
}

/**
 * Find the first matching scene time. Scan intervals include animation knots;
 * interior minima and maxima are refined so narrow and tangent contacts do not
 * require a matching frame sample. A strict result always satisfies its actual
 * predicate instead of advancing an inclusive result by an arbitrary frame.
 */
export function resolveEventSceneTime(trigger: EventTrigger, environment: EnvironmentV1): number | null {
  const predicate = createEventPredicate(trigger, environment);
  const times = eventSampleTimes(trigger, environment, predicate.subjectIds);
  let previousTime = times[0]!;
  let previousValue = predicate.valueAt(previousTime);
  if (predicate.matches(previousValue)) return previousTime;

  for (const currentTime of times.slice(1)) {
    const currentValue = predicate.valueAt(currentTime);
    // Both extrema matter: distance can dip below a threshold and return, while
    // speed can rise above one and return within a single scan interval. Split
    // each interval further because one short Catmull-Rom span can contain both
    // a maximum and a minimum, with an earlier crossing before the deepest dip.
    const candidates: number[] = [];
    for (let subdivision = 0; subdivision < 4; subdivision += 1) {
      const left = previousTime + (currentTime - previousTime) * subdivision / 4;
      const right = subdivision === 3
        ? currentTime
        : previousTime + (currentTime - previousTime) * (subdivision + 1) / 4;
      candidates.push(
        findExtremum(predicate.valueAt, left, right, 1),
        findExtremum(predicate.valueAt, left, right, -1),
        right,
      );
    }
    const probes = [...new Set(candidates)].sort((a, b) => a - b);
    let leftTime = previousTime;
    let leftValue = previousValue;
    for (const rightTime of probes) {
      const rightValue = rightTime === currentTime ? currentValue : predicate.valueAt(rightTime);
      if (predicate.matches(rightValue)) return firstMatchInBracket(predicate, leftTime, rightTime);
      if (trigger.operator === ComparisonOperator.Equal
        && (leftValue < predicate.threshold) !== (rightValue < predicate.threshold)) {
        const match = equalityMatchInBracket(predicate, leftTime, rightTime, leftValue);
        if (match !== null) return match;
      }
      leftTime = rightTime;
      leftValue = rightValue;
    }
    previousTime = currentTime;
    previousValue = currentValue;
  }
  return null;
}
