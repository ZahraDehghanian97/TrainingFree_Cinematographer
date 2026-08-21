import type { EnvironmentV1, Vec3 } from "../types/environment";
import type {
  EnvironmentDistanceMetric,
  EnvironmentQuery,
  EnvironmentQueryResult,
  SubjectBoxSampleV1,
} from "../types/environment-query";
import {
  distanceBetweenAabbs,
  distanceBetweenCenters,
  environmentSubjectKeyframeTimes,
  resolveEnvironmentSubject,
  sampleEnvironmentSubject,
} from "./sampler";

const ROOT_TIME_TOLERANCE_SECONDS = 1e-7;
const VALUE_TOLERANCE = 1e-7;

function assertFiniteNonNegative(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be a finite non-negative number`);
  }
}

function assertTime(env: EnvironmentV1, timeSeconds: number, field: string): void {
  assertFiniteNonNegative(timeSeconds, field);
  if (timeSeconds > env.clock.durationSeconds) {
    throw new Error(`${field}=${timeSeconds} is outside environment duration 0..${env.clock.durationSeconds}`);
  }
}

function assertSubjectIds(env: EnvironmentV1, ids: string[]): void {
  if (ids.length === 0) throw new Error("At least one subject ID is required");
  ids.forEach((id) => resolveEnvironmentSubject(env, id));
}

function uniqueSortedTimes(times: number[]): number[] {
  const sorted = [...times].sort((a, b) => a - b);
  const result: number[] = [];
  for (const time of sorted) {
    if (result.length === 0 || Math.abs(time - result[result.length - 1]!) > ROOT_TIME_TOLERANCE_SECONDS) {
      result.push(time);
    }
  }
  return result;
}

function rangeTimes(start: number, end: number, step: number): number[] {
  const times: number[] = [];
  const maxSamples = 100_000;
  let index = 0;
  while (true) {
    const time = start + index * step;
    if (time >= end - 1e-9) break;
    times.push(Number(time.toFixed(9)));
    index += 1;
    if (index > maxSamples) {
      throw new Error("Requested environment range would create more than 100000 samples");
    }
  }
  times.push(end);
  return times;
}

function sampleSubjects(env: EnvironmentV1, ids: string[], timeSeconds: number): SubjectBoxSampleV1[] {
  return ids.map((id) => sampleEnvironmentSubject(env, id, timeSeconds));
}

function distanceMetric(env: EnvironmentV1): EnvironmentDistanceMetric {
  return env.evaluation?.distanceMetric ?? "anchorCenter";
}

function subjectDistance(env: EnvironmentV1, subjectAId: string, subjectBId: string, timeSeconds: number): number {
  const a = sampleEnvironmentSubject(env, subjectAId, timeSeconds);
  const b = sampleEnvironmentSubject(env, subjectBId, timeSeconds);
  if (distanceMetric(env) === "boundsSurface") {
    if (!a.box || !b.box) {
      throw new Error(
        "boundsSurface distance requires bounds for both environment subjects",
      );
    }
    return distanceBetweenAabbs(a.box, b.box);
  }
  return distanceBetweenCenters(a.center, b.center);
}

function vectorDistance(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

function subjectSpeed(env: EnvironmentV1, subjectId: string, timeSeconds: number): number {
  const duration = env.clock.durationSeconds;
  const fps = Math.max(env.clock.fpsHint ?? 24, 24);
  const h = Math.min(1 / (fps * 4), Math.max(duration / 10_000, 1e-4));
  const left = Math.max(0, timeSeconds - h);
  const right = Math.min(duration, timeSeconds + h);
  if (right <= left) return 0;
  const p0 = sampleEnvironmentSubject(env, subjectId, left).center;
  const p1 = sampleEnvironmentSubject(env, subjectId, right).center;
  return vectorDistance(p0, p1) / (right - left);
}

function eventScanStep(env: EnvironmentV1): number {
  return 1 / Math.max(env.clock.fpsHint ?? 24, 60);
}

function eventSampleTimes(env: EnvironmentV1, subjectIds: string[]): number[] {
  const duration = env.clock.durationSeconds;
  const step = eventScanStep(env);
  const regularSampleCount = Math.ceil(duration / step);
  if (regularSampleCount > 100_000) {
    throw new Error("Environment event scan would create more than 100000 samples");
  }

  const times = [0, duration];
  for (let index = 1; index < regularSampleCount; index += 1) {
    times.push(Math.min(index * step, duration));
  }
  for (const subjectId of subjectIds) {
    times.push(...environmentSubjectKeyframeTimes(env, subjectId));
  }
  return uniqueSortedTimes(
    times.filter((time) => time >= 0 && time <= duration),
  );
}

function findLocalMinimum(
  valueFn: (timeSeconds: number) => number,
  leftTime: number,
  rightTime: number,
): number {
  const goldenRatio = (Math.sqrt(5) - 1) / 2;
  let left = leftTime;
  let right = rightTime;
  let leftProbe = right - goldenRatio * (right - left);
  let rightProbe = left + goldenRatio * (right - left);
  let leftValue = valueFn(leftProbe);
  let rightValue = valueFn(rightProbe);

  for (let index = 0; index < 60 && right - left > ROOT_TIME_TOLERANCE_SECONDS; index += 1) {
    if (leftValue <= rightValue) {
      right = rightProbe;
      rightProbe = leftProbe;
      rightValue = leftValue;
      leftProbe = right - goldenRatio * (right - left);
      leftValue = valueFn(leftProbe);
    } else {
      left = leftProbe;
      leftProbe = rightProbe;
      leftValue = rightValue;
      rightProbe = left + goldenRatio * (right - left);
      rightValue = valueFn(rightProbe);
    }
  }
  return leftValue <= rightValue ? leftProbe : rightProbe;
}

/** Add narrow/tangent threshold contacts that a sign-only scan would miss. */
function includeInteriorThresholdMinima(
  valueFn: (timeSeconds: number) => number,
  sampleTimes: number[],
): number[] {
  if (sampleTimes.length < 3) return sampleTimes;
  const values = sampleTimes.map(valueFn);
  const extraTimes: number[] = [];
  for (let index = 1; index < sampleTimes.length - 1; index += 1) {
    const previousValue = values[index - 1]!;
    const currentValue = values[index]!;
    const nextValue = values[index + 1]!;
    if (
      currentValue > VALUE_TOLERANCE
      && currentValue <= previousValue
      && currentValue <= nextValue
      && (currentValue < previousValue || currentValue < nextValue)
    ) {
      const minimumTime = findLocalMinimum(
        valueFn,
        sampleTimes[index - 1]!,
        sampleTimes[index + 1]!,
      );
      if (valueFn(minimumTime) <= VALUE_TOLERANCE) {
        extraTimes.push(minimumTime);
      }
    }
  }
  return uniqueSortedTimes([...sampleTimes, ...extraTimes]);
}

function bisectRoot(
  fn: (timeSeconds: number) => number,
  leftTime: number,
  rightTime: number,
): number {
  let left = leftTime;
  let right = rightTime;
  let leftValue = fn(left);

  for (let i = 0; i < 60 && right - left > ROOT_TIME_TOLERANCE_SECONDS; i += 1) {
    const middle = (left + right) / 2;
    const middleValue = fn(middle);
    if (Math.abs(middleValue) <= VALUE_TOLERANCE) return middle;
    if ((leftValue <= 0 && middleValue >= 0) || (leftValue >= 0 && middleValue <= 0)) {
      right = middle;
    } else {
      left = middle;
      leftValue = middleValue;
    }
  }
  return (left + right) / 2;
}

function findFirstThresholdEntry(
  valueFn: (timeSeconds: number) => number,
  sampleTimes: number[],
): number | null {
  const firstTime = sampleTimes[0];
  if (firstTime === undefined) return null;
  let previousTime = firstTime;
  const initialValue = valueFn(firstTime);
  if (initialValue <= VALUE_TOLERANCE) return firstTime;

  for (const currentTime of sampleTimes.slice(1)) {
    const currentValue = valueFn(currentTime);
    if (currentValue <= VALUE_TOLERANCE) {
      if (currentValue >= 0) return currentTime;
      return bisectRoot(valueFn, previousTime, currentTime);
    }
    previousTime = currentTime;
  }
  return null;
}

function findAllCrossings(
  valueFn: (timeSeconds: number) => number,
  sampleTimes: number[],
): number[] {
  const roots: number[] = [];
  const firstTime = sampleTimes[0];
  if (firstTime === undefined) return roots;
  let previousTime = firstTime;
  let previousValue = valueFn(firstTime);
  let insideZeroBand = Math.abs(previousValue) <= VALUE_TOLERANCE;
  if (insideZeroBand) roots.push(firstTime);

  for (const currentTime of sampleTimes.slice(1)) {
    const currentValue = valueFn(currentTime);
    const currentInZeroBand = Math.abs(currentValue) <= VALUE_TOLERANCE;

    if (currentInZeroBand) {
      // A flat interval at exactly the requested distance is one event, not one
      // event per scan sample. Record only the entry into the zero band.
      if (!insideZeroBand) roots.push(currentTime);
    } else if (!insideZeroBand
      && Math.abs(previousValue) > VALUE_TOLERANCE
      && Math.sign(previousValue) !== Math.sign(currentValue)) {
      roots.push(bisectRoot(valueFn, previousTime, currentTime));
    }

    previousTime = currentTime;
    previousValue = currentValue;
    insideZeroBand = currentInZeroBand;
  }
  return uniqueSortedTimes(roots);
}

export function executeEnvironmentQuery(
  env: EnvironmentV1,
  query: EnvironmentQuery,
): EnvironmentQueryResult {
  switch (query.type) {
    case "subjectBoxesAtTime": {
      assertSubjectIds(env, query.subjectIds);
      assertTime(env, query.timeSeconds, "timeSeconds");
      return {
        type: query.type,
        environmentId: env.id,
        timeSeconds: query.timeSeconds,
        subjects: sampleSubjects(env, query.subjectIds, query.timeSeconds),
      };
    }

    case "subjectBoxesInRange": {
      assertSubjectIds(env, query.subjectIds);
      assertTime(env, query.startTimeSeconds, "startTimeSeconds");
      assertTime(env, query.endTimeSeconds, "endTimeSeconds");
      if (query.endTimeSeconds < query.startTimeSeconds) {
        throw new Error("endTimeSeconds must be greater than or equal to startTimeSeconds");
      }
      const sampleEverySeconds = query.sampleEverySeconds ?? 1 / (env.clock.fpsHint ?? 24);
      if (!Number.isFinite(sampleEverySeconds) || sampleEverySeconds <= 0) {
        throw new Error("sampleEverySeconds must be a positive finite number");
      }
      const times = query.startTimeSeconds === query.endTimeSeconds
        ? [query.startTimeSeconds]
        : rangeTimes(query.startTimeSeconds, query.endTimeSeconds, sampleEverySeconds);
      return {
        type: query.type,
        environmentId: env.id,
        startTimeSeconds: query.startTimeSeconds,
        endTimeSeconds: query.endTimeSeconds,
        sampleEverySeconds,
        samples: times.map((timeSeconds) => ({
          timeSeconds,
          subjects: sampleSubjects(env, query.subjectIds, timeSeconds),
        })),
      };
    }

    case "firstWithinDistance": {
      resolveEnvironmentSubject(env, query.subjectAId);
      resolveEnvironmentSubject(env, query.subjectBId);
      assertFiniteNonNegative(query.distanceMeters, "distanceMeters");
      const fn = (timeSeconds: number) => subjectDistance(
        env,
        query.subjectAId,
        query.subjectBId,
        timeSeconds,
      ) - query.distanceMeters;
      const sampleTimes = includeInteriorThresholdMinima(
        fn,
        eventSampleTimes(env, [query.subjectAId, query.subjectBId]),
      );
      const timeSeconds = findFirstThresholdEntry(
        fn,
        sampleTimes,
      );
      return {
        type: query.type,
        environmentId: env.id,
        subjectAId: query.subjectAId,
        subjectBId: query.subjectBId,
        distanceMeters: query.distanceMeters,
        distanceMetric: distanceMetric(env),
        timeSeconds,
        distanceAtMatchMeters: timeSeconds === null
          ? null
          : subjectDistance(env, query.subjectAId, query.subjectBId, timeSeconds),
      };
    }

    case "firstSpeedReached": {
      resolveEnvironmentSubject(env, query.subjectId);
      assertFiniteNonNegative(query.speedMetersPerSecond, "speedMetersPerSecond");
      const fn = (timeSeconds: number) => query.speedMetersPerSecond
        - subjectSpeed(env, query.subjectId, timeSeconds);
      const sampleTimes = includeInteriorThresholdMinima(
        fn,
        eventSampleTimes(env, [query.subjectId]),
      );
      const timeSeconds = findFirstThresholdEntry(
        fn,
        sampleTimes,
      );
      return {
        type: query.type,
        environmentId: env.id,
        subjectId: query.subjectId,
        speedMetersPerSecond: query.speedMetersPerSecond,
        timeSeconds,
        speedAtMatchMetersPerSecond: timeSeconds === null
          ? null
          : subjectSpeed(env, query.subjectId, timeSeconds),
      };
    }

    case "distanceCrossingCount": {
      resolveEnvironmentSubject(env, query.subjectAId);
      resolveEnvironmentSubject(env, query.subjectBId);
      assertFiniteNonNegative(query.distanceMeters, "distanceMeters");
      const fn = (timeSeconds: number) => subjectDistance(
        env,
        query.subjectAId,
        query.subjectBId,
        timeSeconds,
      ) - query.distanceMeters;
      const sampleTimes = includeInteriorThresholdMinima(
        fn,
        eventSampleTimes(env, [query.subjectAId, query.subjectBId]),
      );
      const timesSeconds = findAllCrossings(
        fn,
        sampleTimes,
      );
      return {
        type: query.type,
        environmentId: env.id,
        subjectAId: query.subjectAId,
        subjectBId: query.subjectBId,
        distanceMeters: query.distanceMeters,
        distanceMetric: distanceMetric(env),
        count: timesSeconds.length,
        timesSeconds,
      };
    }

    case "unsupported":
      return {
        type: query.type,
        environmentId: env.id,
        reason: query.reason,
      };
  }
}
