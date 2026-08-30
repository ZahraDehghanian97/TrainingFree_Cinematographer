import { RelativeFPS } from "../../types/enums";
import { LossFunctionType } from "../../types/solver";
import { distance3, quaternionAngle } from "../shared/math";
import type { CameraOptimizerInput, UserCameraKeyframe } from "../types";

function assertFiniteTuple(value: readonly number[], length: number, field: string): void {
  if (value.length !== length || !value.every(Number.isFinite)) {
    throw new Error(`${field} must contain ${length} finite numbers`);
  }
}

function hasChannel(keyframe: UserCameraKeyframe): boolean {
  return keyframe.position !== undefined
    || keyframe.rotation !== undefined
    || keyframe.lookAt !== undefined
    || keyframe.fovYDegrees !== undefined
    || keyframe.cutBefore === true;
}

export function validateOptimizerInput(input: CameraOptimizerInput): void {
  if (
    input.environment?.schemaVersion !== "1.0"
    || input.environment?.kind !== "environment"
    || !Array.isArray(input.environment.entities)
    || !Array.isArray(input.environment.targets)
    || input.environment.coordinates?.handedness !== "right"
    || input.environment.coordinates?.upAxis !== "+Y"
    || input.environment.coordinates?.cameraForwardAxis !== "-Z"
    || input.environment.coordinates?.lengthUnit !== "meter"
    || input.environment.coordinates?.rotationOrder !== "quaternion-xyzw"
  ) {
    throw new Error("environment must be a canonical EnvironmentV1 document");
  }
  const duration = input.environment?.clock?.durationSeconds;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error("environment.clock.durationSeconds must be positive and finite");
  }
  const allowedLosses = new Set<string>(Object.values(LossFunctionType));
  for (const [index, segment] of input.timeline.timeline.entries()) {
    const start = segment.kind === "interval" ? segment.startTime : segment.time;
    const end = segment.kind === "interval" ? segment.endTime : segment.time;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end > duration || end < start) {
      throw new Error(`timeline.timeline[${index}] lies outside 0..${duration} seconds`);
    }
    if (segment.kind === "interval" && end - start <= 1e-9) {
      throw new Error(`timeline.timeline[${index}] interval must have positive duration`);
    }
    if (segment.weight !== undefined && (!Number.isFinite(segment.weight) || segment.weight <= 0)) {
      throw new Error(`timeline.timeline[${index}].weight must be positive and finite`);
    }
    for (const loss of segment.lossFunctions) {
      if (!allowedLosses.has(loss.type)) {
        throw new Error(`Unsupported high-level loss: ${String(loss.type)}`);
      }
      if (loss.priority !== undefined && !Number.isFinite(loss.priority)) {
        throw new Error(`timeline.timeline[${index}] contains a non-finite priority`);
      }
    }
  }

  const allowedRates = new Set<string>(Object.values(RelativeFPS));
  for (const [index, segment] of input.timeline.timeWarp.entries()) {
    if (
      !Number.isFinite(segment.startTimePlayback)
      || !Number.isFinite(segment.endTimePlayback)
      || segment.startTimePlayback < 0
      || segment.endTimePlayback > duration
      || segment.endTimePlayback <= segment.startTimePlayback
      || !Number.isFinite(segment.rate)
      || segment.rate < 0
      || !allowedRates.has(segment.label)
    ) {
      throw new Error(`timeline.timeWarp[${index}] is invalid`);
    }
    const previous = input.timeline.timeWarp[index - 1];
    if (
      previous
      && (
        segment.startTimePlayback < previous.startTimePlayback
        || segment.startTimePlayback < previous.endTimePlayback - 1e-9
      )
    ) {
      throw new Error("timeline.timeWarp must be sorted and non-overlapping");
    }
  }
  for (const [index, cutTime] of (input.timeline.cutTimes ?? []).entries()) {
    if (!Number.isFinite(cutTime) || cutTime <= 0 || cutTime > duration) {
      throw new Error(`timeline.cutTimes[${index}] must lie inside (0, ${duration}]`);
    }
    const previous = input.timeline.cutTimes?.[index - 1];
    if (previous !== undefined && cutTime <= previous + 1e-9) {
      throw new Error("timeline.cutTimes must be strictly increasing");
    }
  }

  const options = input.options;
  const positiveOptions: Array<[string, number | undefined]> = [
    ["optimizationFps", options?.optimizationFps],
    ["outputFps", options?.outputFps],
    ["aspectRatio", options?.aspectRatio],
    ["cameraRadius", options?.cameraRadius],
    ["nearPlane", options?.nearPlane],
    ["farPlane", options?.farPlane],
  ];
  for (const [name, value] of positiveOptions) {
    if (value !== undefined && (!Number.isFinite(value) || value <= 0)) {
      throw new Error(`options.${name} must be positive and finite`);
    }
  }
  if (options?.collisionMargin !== undefined && (
    !Number.isFinite(options.collisionMargin) || options.collisionMargin < 0
  )) {
    throw new Error("options.collisionMargin must be non-negative and finite");
  }
  if (options?.initialFovYDegrees !== undefined && (
    !Number.isFinite(options.initialFovYDegrees)
    || options.initialFovYDegrees < 8
    || options.initialFovYDegrees > 120
  )) {
    throw new Error("options.initialFovYDegrees must be between 8 and 120");
  }
  if (options?.randomSeed !== undefined && !Number.isInteger(options.randomSeed)) {
    throw new Error("options.randomSeed must be an integer");
  }
  for (const [name, value] of Object.entries(options?.weights ?? {})) {
    if (!Number.isFinite(value) || value < 0) {
      throw new Error(`options.weights.${name} must be non-negative and finite`);
    }
  }

  const hardByTime = new Map<string, UserCameraKeyframe[]>();
  for (const [index, keyframe] of (input.userKeyframes ?? []).entries()) {
    if (!Number.isFinite(keyframe.time) || keyframe.time < 0 || keyframe.time > duration) {
      throw new Error(`userKeyframes[${index}].time must lie inside 0..${duration}`);
    }
    if (!hasChannel(keyframe)) {
      throw new Error(`userKeyframes[${index}] must constrain at least one channel or declare cutBefore`);
    }
    if (keyframe.mode !== undefined && keyframe.mode !== "hard" && keyframe.mode !== "soft") {
      throw new Error(`userKeyframes[${index}].mode must be hard or soft`);
    }
    if (keyframe.weight !== undefined && (!Number.isFinite(keyframe.weight) || keyframe.weight <= 0)) {
      throw new Error(`userKeyframes[${index}].weight must be positive and finite`);
    }
    if (keyframe.position) assertFiniteTuple(keyframe.position, 3, `userKeyframes[${index}].position`);
    if (keyframe.rotation) {
      assertFiniteTuple(keyframe.rotation, 4, `userKeyframes[${index}].rotation`);
      if (Math.hypot(...keyframe.rotation) <= 1e-12) {
        throw new Error(`userKeyframes[${index}].rotation cannot be zero-length`);
      }
    }
    if (keyframe.lookAt) assertFiniteTuple(keyframe.lookAt, 3, `userKeyframes[${index}].lookAt`);
    if (keyframe.up) assertFiniteTuple(keyframe.up, 3, `userKeyframes[${index}].up`);
    if (keyframe.up && Math.hypot(...keyframe.up) <= 1e-12) {
      throw new Error(`userKeyframes[${index}].up cannot be zero-length`);
    }
    if (keyframe.position && keyframe.lookAt && distance3(keyframe.position, keyframe.lookAt) <= 1e-10) {
      throw new Error(`userKeyframes[${index}].lookAt cannot equal its position`);
    }
    if (keyframe.up && !keyframe.lookAt) {
      throw new Error(`userKeyframes[${index}].up requires lookAt`);
    }
    if (keyframe.rotation && keyframe.lookAt) {
      throw new Error(`userKeyframes[${index}] cannot contain both rotation and lookAt`);
    }
    if (
      keyframe.fovYDegrees !== undefined
      && (!Number.isFinite(keyframe.fovYDegrees) || keyframe.fovYDegrees <= 0 || keyframe.fovYDegrees >= 180)
    ) {
      throw new Error(`userKeyframes[${index}].fovYDegrees must be between 0 and 180`);
    }
    if ((keyframe.mode ?? "hard") === "hard") {
      const key = keyframe.time.toFixed(9);
      const existing = hardByTime.get(key) ?? [];
      existing.push(keyframe);
      hardByTime.set(key, existing);
    }
  }

  for (const [time, keyframes] of hardByTime) {
    for (let left = 0; left < keyframes.length; left += 1) {
      for (let right = left + 1; right < keyframes.length; right += 1) {
        const a = keyframes[left]!;
        const b = keyframes[right]!;
        if (a.position && b.position && distance3(a.position, b.position) > 1e-8) {
          throw new Error(`Conflicting hard position keyframes at t=${time}`);
        }
        if (a.rotation && b.rotation && quaternionAngle(a.rotation, b.rotation) > 1e-8) {
          throw new Error(`Conflicting hard rotation keyframes at t=${time}`);
        }
        if (a.lookAt && b.lookAt && distance3(a.lookAt, b.lookAt) > 1e-8) {
          throw new Error(`Conflicting hard lookAt keyframes at t=${time}`);
        }
        if ((a.rotation && b.lookAt) || (a.lookAt && b.rotation)) {
          throw new Error(`Conflicting hard orientation keyframes at t=${time}`);
        }
        if (
          a.lookAt
          && b.lookAt
          && distance3(a.up ?? [0, 1, 0], b.up ?? [0, 1, 0]) > 1e-8
        ) {
          throw new Error(`Conflicting hard lookAt up vectors at t=${time}`);
        }
        if (
          a.fovYDegrees !== undefined
          && b.fovYDegrees !== undefined
          && Math.abs(a.fovYDegrees - b.fovYDegrees) > 1e-8
        ) {
          throw new Error(`Conflicting hard FOV keyframes at t=${time}`);
        }
      }
    }
    const position = keyframes.find((keyframe) => keyframe.position)?.position;
    const lookAt = keyframes.find((keyframe) => keyframe.lookAt)?.lookAt;
    if (position && lookAt && distance3(position, lookAt) <= 1e-10) {
      throw new Error(`Hard lookAt equals hard position at t=${time}`);
    }
  }
}
