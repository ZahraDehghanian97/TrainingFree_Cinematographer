import type { EnvironmentV1, Quat, Vec3 } from "../../src/types/environment";
import type {
  CameraIntrinsicsV1,
  CameraOrientationV1,
  CameraPath4dPoint,
  CameraPath4dV1,
  CameraPlaybackV1,
  CameraSampleV1,
  CameraTrajectoryV1,
  PlaybackRateLabelV1,
} from "../../src/types/trajectory";
import {
  CANONICAL_COORDINATES_V1,
  assertCoordinateSystemV1,
  type FetchResponseLike,
  type JsonFetcher,
} from "./environment-loader";
import { clamp, lerp, lerpVec3, normalizeQuat, slerpQuat } from "./interpolation";
import {
  DataValidationError,
  expectArray,
  expectBoolean,
  expectFiniteNumber,
  expectLiteral,
  expectNonEmptyString,
  expectNonNegativeNumber,
  expectObject,
  expectOneOf,
  expectPositiveNumber,
  fail,
  parseJson,
  type JsonObject,
} from "./validation";

export type CompatibilityPolicy = "warn" | "error" | "ignore";

export type TrajectorySourceKind =
  | "cameraTrajectory"
  | "cameraPath4d"
  | "prototypeFrames";

export type TrajectoryDiagnosticCode =
  | "environment-id-mismatch"
  | "trajectory-start-gap"
  | "trajectory-end-gap"
  | "trajectory-before-environment"
  | "trajectory-after-environment";

export interface TrajectoryDiagnostic {
  severity: "warning";
  code: TrajectoryDiagnosticCode;
  message: string;
}

export interface ParseCameraTrajectoryOptions {
  /** The environment currently selected in the visualizer. */
  environment?: EnvironmentV1;
  /** Used by the prototype adapter when no full environment object is available. */
  environmentId?: string;
  /** Used by compact/prototype inputs when no full environment object is available. */
  durationSeconds?: number;
  /** Defaults to warn. */
  environmentIdMismatch?: CompatibilityPolicy;
  /** Defaults to warn. */
  timeCoverage?: CompatibilityPolicy;
  /** Prototype frames often contain both values. Quaternion is the default. */
  prototypeOrientationPreference?: "quaternion" | "lookAt";
  /** Defaults to perspective, 50 degrees, 0.1 near, and 1000 far. */
  intrinsics?: CameraIntrinsicsV1;
}

export interface ParsedCameraTrajectory {
  trajectory: CameraTrajectoryV1;
  /** Human-readable warnings kept simple for UI display. */
  warnings: string[];
  diagnostics: TrajectoryDiagnostic[];
  sourceKind: TrajectorySourceKind;
}

export interface SampleCameraTrajectoryOptions {
  /** Defaults to true. */
  clampToClock?: boolean;
}

export interface TrajectoryFileLike {
  text(): Promise<string>;
}

export class TrajectoryCompatibilityError extends Error {
  readonly diagnostics: TrajectoryDiagnostic[];

  constructor(diagnostics: TrajectoryDiagnostic[]) {
    super(diagnostics.map((diagnostic) => diagnostic.message).join("; "));
    this.name = "TrajectoryCompatibilityError";
    this.diagnostics = diagnostics;
  }
}

function asOptions(
  environmentOrOptions?: EnvironmentV1 | ParseCameraTrajectoryOptions,
): ParseCameraTrajectoryOptions {
  if (
    environmentOrOptions
    && "kind" in environmentOrOptions
    && environmentOrOptions.kind === "environment"
  ) {
    return { environment: environmentOrOptions as EnvironmentV1 };
  }
  return (environmentOrOptions as ParseCameraTrajectoryOptions | undefined) ?? {};
}

function assertVec3(value: unknown, path: string): asserts value is Vec3 {
  const tuple = expectArray(value, path);
  if (tuple.length !== 3) {
    fail(path, `expected exactly 3 numbers, received ${tuple.length}`, "invalid-tuple-size");
  }
  tuple.forEach((component, index) => expectFiniteNumber(component, `${path}[${index}]`));
}

function assertNonZeroVec3(value: unknown, path: string): asserts value is Vec3 {
  assertVec3(value, path);
  if (Math.hypot(value[0], value[1], value[2]) <= 1e-12) {
    fail(path, "must have non-zero length", "invalid-vector");
  }
}

function assertQuat(value: unknown, path: string): asserts value is Quat {
  const tuple = expectArray(value, path);
  if (tuple.length !== 4) {
    fail(path, `expected exactly 4 numbers in x, y, z, w order, received ${tuple.length}`, "invalid-tuple-size");
  }
  tuple.forEach((component, index) => expectFiniteNumber(component, `${path}[${index}]`));
  if (Math.hypot(...(tuple as number[])) <= 1e-12) {
    fail(path, "quaternion must have non-zero length", "invalid-quaternion");
  }
}

function assertFov(value: unknown, path: string): number {
  const fov = expectFiniteNumber(value, path);
  if (fov <= 0 || fov >= 180) {
    fail(path, "must be greater than 0 and less than 180 degrees", "out-of-range");
  }
  return fov;
}

function assertIntrinsics(
  value: unknown,
  path: string,
): asserts value is CameraIntrinsicsV1 {
  const intrinsics = expectObject(value, path);
  expectLiteral(intrinsics.projection, "perspective", `${path}.projection`);
  assertFov(intrinsics.fovYDegrees, `${path}.fovYDegrees`);
  const near = expectPositiveNumber(intrinsics.near, `${path}.near`);
  const far = expectPositiveNumber(intrinsics.far, `${path}.far`);
  if (far <= near) {
    fail(`${path}.far`, `must be greater than near (${near})`, "out-of-range");
  }
}

function defaultIntrinsics(options: ParseCameraTrajectoryOptions): CameraIntrinsicsV1 {
  if (options.intrinsics) {
    assertIntrinsics(options.intrinsics, "options.intrinsics");
    return { ...options.intrinsics };
  }
  return { projection: "perspective", fovYDegrees: 50, near: 0.1, far: 1000 };
}

function assertOrientation(
  value: unknown,
  path: string,
): asserts value is CameraOrientationV1 {
  const orientation = expectObject(value, path);
  const mode = expectOneOf(
    orientation.mode,
    [
      "quaternion",
      "perSampleLookAt",
      "lookAtTarget",
      "lookAtPoint",
      "pathTangent",
    ] as const,
    `${path}.mode`,
  );
  if (mode === "quaternion") {
    return;
  }
  assertNonZeroVec3(orientation.up, `${path}.up`);
  if (mode === "lookAtTarget") {
    expectNonEmptyString(orientation.targetId, `${path}.targetId`);
  } else if (mode === "lookAtPoint") {
    assertVec3(orientation.point, `${path}.point`);
  }
}

function assertStrictSampleTimes(samples: readonly JsonObject[], basePath: string): void {
  let previousTime = -Infinity;
  samples.forEach((sample, index) => {
    const time = expectNonNegativeNumber(sample.t, `${basePath}[${index}].t`);
    if (time <= previousTime) {
      fail(
        `${basePath}[${index}].t`,
        `times must be strictly increasing and unique; previous time is ${previousTime}`,
        "non-monotonic-time",
      );
    }
    previousTime = time;
  });
}

function assertCameraSample(
  value: unknown,
  path: string,
  durationSeconds: number,
): asserts value is CameraSampleV1 {
  const sample = expectObject(value, path);
  const time = expectNonNegativeNumber(sample.t, `${path}.t`);
  if (time > durationSeconds) {
    fail(
      `${path}.t`,
      `must be within the trajectory clock (0..${durationSeconds} seconds)`,
      "out-of-range",
    );
  }
  assertVec3(sample.position, `${path}.position`);
  if (sample.rotation !== undefined) {
    assertQuat(sample.rotation, `${path}.rotation`);
  }
  if (sample.lookAt !== undefined) {
    assertVec3(sample.lookAt, `${path}.lookAt`);
  }
  if (sample.fovYDegrees !== undefined) {
    assertFov(sample.fovYDegrees, `${path}.fovYDegrees`);
  }
  if (sample.cutBefore !== undefined) {
    expectBoolean(sample.cutBefore, `${path}.cutBefore`);
  }
  if (sample.actionId !== undefined) {
    expectNonEmptyString(sample.actionId, `${path}.actionId`);
  }
}

function assertOrientationSamples(
  trajectory: CameraTrajectoryV1,
  basePath: string,
): void {
  trajectory.samples.forEach((sample, index) => {
    const path = `${basePath}[${index}]`;
    if (trajectory.orientation.mode === "quaternion" && sample.rotation === undefined) {
      fail(
        `${path}.rotation`,
        'is required when orientation.mode is "quaternion"',
        "missing-value",
      );
    }
    if (trajectory.orientation.mode === "perSampleLookAt" && sample.lookAt === undefined) {
      fail(
        `${path}.lookAt`,
        'is required when orientation.mode is "perSampleLookAt"',
        "missing-value",
      );
    }
    const lookAt = trajectory.orientation.mode === "perSampleLookAt"
      ? sample.lookAt
      : trajectory.orientation.mode === "lookAtPoint"
        ? trajectory.orientation.point
        : undefined;
    if (
      lookAt
      && lookAt[0] === sample.position[0]
      && lookAt[1] === sample.position[1]
      && lookAt[2] === sample.position[2]
    ) {
      fail(path, "camera position and look-at point must differ", "invalid-orientation");
    }
  });
}

const PLAYBACK_RATE_LABELS = [
  "frozen",
  "verySlow",
  "slow",
  "normal",
  "fast",
  "veryFast",
] as const satisfies readonly PlaybackRateLabelV1[];

function assertPlayback(
  value: unknown,
  path: string,
  durationSeconds: number,
): asserts value is CameraPlaybackV1 {
  const playback = expectObject(value, path);
  const segments = expectArray(playback.rateSegments, `${path}.rateSegments`);
  if (segments.length === 0) {
    fail(`${path}.rateSegments`, "must contain at least one rate segment", "empty-track");
  }

  let previousEnd = 0;
  segments.forEach((value, index) => {
    const segmentPath = `${path}.rateSegments[${index}]`;
    const segment = expectObject(value, segmentPath);
    const startTime = expectNonNegativeNumber(segment.startTime, `${segmentPath}.startTime`);
    const endTime = expectPositiveNumber(segment.endTime, `${segmentPath}.endTime`);
    const rate = expectNonNegativeNumber(segment.rate, `${segmentPath}.rate`);
    if (endTime <= startTime) {
      fail(`${segmentPath}.endTime`, "must be greater than startTime", "out-of-range");
    }
    if (endTime > durationSeconds) {
      fail(
        `${segmentPath}.endTime`,
        `must be within the trajectory clock (0..${durationSeconds} seconds)`,
        "out-of-range",
      );
    }
    if (index > 0 && startTime < previousEnd) {
      fail(
        `${segmentPath}.startTime`,
        `rate segments must be ordered and non-overlapping; previous segment ends at ${previousEnd}`,
        "overlapping-segments",
      );
    }
    if (segment.label !== undefined) {
      expectOneOf(segment.label, PLAYBACK_RATE_LABELS, `${segmentPath}.label`);
    }
    if (segment.label === "frozen" && rate !== 0) {
      fail(`${segmentPath}.rate`, 'must be 0 when label is "frozen"', "invalid-rate-label");
    }
    previousEnd = endTime;
  });
}

/** Validates an already-canonical trajectory without adapting it. */
export function assertCameraTrajectoryV1(
  value: unknown,
): asserts value is CameraTrajectoryV1 {
  const trajectory = expectObject(value, "$" as const);
  expectLiteral(trajectory.schemaVersion, "1.0", "$.schemaVersion");
  expectLiteral(trajectory.kind, "cameraTrajectory", "$.kind");
  expectNonEmptyString(trajectory.environmentId, "$.environmentId");
  const clock = expectObject(trajectory.clock, "$.clock");
  const durationSeconds = expectPositiveNumber(clock.durationSeconds, "$.clock.durationSeconds");
  expectLiteral(clock.timeUnit, "second", "$.clock.timeUnit");
  assertCoordinateSystemV1(trajectory.coordinates, "$.coordinates");
  assertIntrinsics(trajectory.intrinsics, "$.intrinsics");
  assertOrientation(trajectory.orientation, "$.orientation");
  if (trajectory.playback !== undefined) {
    assertPlayback(trajectory.playback, "$.playback", durationSeconds);
  }

  const samples = expectArray(trajectory.samples, "$.samples");
  if (samples.length === 0) {
    fail("$.samples", "must contain at least one camera sample", "empty-track");
  }
  samples.forEach((sample, index) =>
    assertCameraSample(sample, `$.samples[${index}]`, durationSeconds));
  assertStrictSampleTimes(samples as JsonObject[], "$.samples");
  assertOrientationSamples(value as CameraTrajectoryV1, "$.samples");
}

function parseCanonical(value: unknown): CameraTrajectoryV1 {
  assertCameraTrajectoryV1(value);
  return value;
}

function assertPathPoint(
  value: unknown,
  path: string,
): asserts value is CameraPath4dPoint {
  const point = expectArray(value, path);
  if (point.length !== 4) {
    fail(
      path,
      `expected exactly 4 numbers using the declared [x, y, z, t] layout, received ${point.length}`,
      "invalid-tuple-size",
    );
  }
  point.forEach((component, index) => expectFiniteNumber(component, `${path}[${index}]`));
  expectNonNegativeNumber(point[3], `${path}[3]`);
}

function adapterDuration(
  lastSampleTime: number,
  options: ParseCameraTrajectoryOptions,
  declaredDuration?: number,
  declaredPath = "durationSeconds",
): number {
  const explicitDuration = declaredDuration ?? options.durationSeconds;
  const candidate = explicitDuration
    ?? options.environment?.clock.durationSeconds
    ?? lastSampleTime;
  if (!Number.isFinite(candidate) || candidate <= 0) {
    fail(
      declaredPath,
      "a positive duration is required when the last sample time is 0; select an environment or pass durationSeconds",
      "missing-value",
    );
  }
  if (explicitDuration !== undefined && explicitDuration < lastSampleTime) {
    fail(
      declaredPath,
      `declared duration ${candidate} ends before the last sample at ${lastSampleTime}`,
      "out-of-range",
    );
  }
  // A selected environment is a playback comparison target, not a declaration
  // that may truncate uploaded points. Preserve out-of-range points and let the
  // compatibility layer report them.
  return Math.max(candidate, lastSampleTime);
}

function parseCompact(
  value: unknown,
  options: ParseCameraTrajectoryOptions,
): CameraTrajectoryV1 {
  const path = expectObject(value, "$" as const);
  expectLiteral(path.schemaVersion, "1.0", "$.schemaVersion");
  expectLiteral(path.kind, "cameraPath4d", "$.kind");
  const environmentId = expectNonEmptyString(path.environmentId, "$.environmentId");

  const layout = expectArray(path.layout, "$.layout");
  const requiredLayout = ["x", "y", "z", "t"] as const;
  if (
    layout.length !== requiredLayout.length
    || requiredLayout.some((component, index) => layout[index] !== component)
  ) {
    fail(
      "$.layout",
      'must be exactly ["x", "y", "z", "t"]; tuple order is never guessed',
      "invalid-layout",
    );
  }
  assertOrientation(path.orientation, "$.orientation");
  if (path.orientation.mode === "quaternion" || path.orientation.mode === "perSampleLookAt") {
    fail(
      "$.orientation.mode",
      `${JSON.stringify(path.orientation.mode)} requires per-sample orientation values, which cameraPath4d does not contain`,
      "unsupported-orientation",
    );
  }

  const points = expectArray(path.points, "$.points");
  if (points.length === 0) {
    fail("$.points", "must contain at least one [x, y, z, t] point", "empty-track");
  }
  points.forEach((point, index) => assertPathPoint(point, `$.points[${index}]`));
  let previousTime = -Infinity;
  (points as CameraPath4dPoint[]).forEach((point, index) => {
    if (point[3] <= previousTime) {
      fail(
        `$.points[${index}][3]`,
        `times must be strictly increasing and unique; previous time is ${previousTime}`,
        "non-monotonic-time",
      );
    }
    previousTime = point[3];
  });

  const lastTime = (points.at(-1) as CameraPath4dPoint)[3];
  const durationSeconds = adapterDuration(
    lastTime,
    options,
    undefined,
    "options.durationSeconds",
  );
  if (path.playback !== undefined) {
    assertPlayback(path.playback, "$.playback", durationSeconds);
  }
  const trajectory: CameraTrajectoryV1 = {
    schemaVersion: "1.0",
    kind: "cameraTrajectory",
    environmentId,
    clock: { durationSeconds, timeUnit: "second" },
    coordinates: { ...CANONICAL_COORDINATES_V1 },
    intrinsics: defaultIntrinsics(options),
    orientation: path.orientation as CameraOrientationV1,
    ...(path.playback === undefined ? {} : { playback: path.playback as CameraPlaybackV1 }),
    samples: (points as CameraPath4dPoint[]).map(([x, y, z, t]) => ({
      t,
      position: [x, y, z],
    })),
  };
  assertCameraTrajectoryV1(trajectory);
  return trajectory;
}

function optionalAdapterDuration(root: JsonObject): {
  duration?: number;
  path: string;
} {
  if (root.durationSeconds !== undefined) {
    return {
      duration: expectPositiveNumber(root.durationSeconds, "$.durationSeconds"),
      path: "$.durationSeconds",
    };
  }
  if (root.metadata !== undefined) {
    const metadata = expectObject(root.metadata, "$.metadata");
    if (metadata.totalDuration !== undefined) {
      return {
        duration: expectPositiveNumber(metadata.totalDuration, "$.metadata.totalDuration"),
        path: "$.metadata.totalDuration",
      };
    }
  }
  return { path: "options.durationSeconds" };
}

interface ParsedPrototypeFrame {
  t: number;
  position: Vec3;
  rotation?: Quat;
  lookAt?: Vec3;
  fovYDegrees?: number;
  cutBefore?: boolean;
  actionId?: string;
}

function parsePrototypeFrame(value: unknown, index: number): ParsedPrototypeFrame {
  const path = `$.frames[${index}]`;
  const frame = expectObject(value, path);
  const t = expectNonNegativeNumber(frame.t, `${path}.t`);
  assertVec3(frame.position, `${path}.position`);
  if (frame.quaternion !== undefined) {
    assertQuat(frame.quaternion, `${path}.quaternion`);
  }
  if (frame.lookAt !== undefined) {
    assertVec3(frame.lookAt, `${path}.lookAt`);
  }
  const fovYDegrees = frame.fov === undefined ? undefined : assertFov(frame.fov, `${path}.fov`);
  const cutBefore = frame.cutBefore === undefined
    ? undefined
    : expectBoolean(frame.cutBefore, `${path}.cutBefore`);
  let actionId: string | undefined;
  if (frame.actionId !== undefined) {
    actionId = expectNonEmptyString(frame.actionId, `${path}.actionId`);
  } else if (frame.action !== undefined) {
    actionId = expectNonEmptyString(frame.action, `${path}.action`);
  }
  return {
    t,
    position: frame.position,
    rotation: frame.quaternion as Quat | undefined,
    lookAt: frame.lookAt as Vec3 | undefined,
    fovYDegrees,
    cutBefore,
    actionId,
  };
}

function prototypeOrientation(
  frames: ParsedPrototypeFrame[],
  options: ParseCameraTrajectoryOptions,
): CameraOrientationV1 {
  const allQuaternion = frames.every((frame) => frame.rotation !== undefined);
  const allLookAt = frames.every((frame) => frame.lookAt !== undefined);
  const anyQuaternion = frames.some((frame) => frame.rotation !== undefined);
  const anyLookAt = frames.some((frame) => frame.lookAt !== undefined);
  const preference = options.prototypeOrientationPreference ?? "quaternion";

  if (allQuaternion && (preference === "quaternion" || !allLookAt)) {
    return { mode: "quaternion" };
  }
  if (allLookAt) {
    return { mode: "perSampleLookAt", up: [0, 1, 0] };
  }
  if (allQuaternion) {
    return { mode: "quaternion" };
  }
  if (anyQuaternion || anyLookAt) {
    const field = anyQuaternion ? "quaternion" : "lookAt";
    const missingIndex = frames.findIndex((frame) =>
      field === "quaternion" ? frame.rotation === undefined : frame.lookAt === undefined);
    fail(
      `$.frames[${missingIndex}].${field}`,
      `must be present on every frame when used for orientation`,
      "missing-value",
    );
  }
  return { mode: "pathTangent", up: [0, 1, 0] };
}

function parsePrototype(
  value: unknown,
  options: ParseCameraTrajectoryOptions,
): CameraTrajectoryV1 {
  const root = expectObject(value, "$" as const);
  const rawFrames = expectArray(root.frames, "$.frames");
  if (rawFrames.length === 0) {
    fail("$.frames", "must contain at least one camera frame", "empty-track");
  }
  const frames = rawFrames.map(parsePrototypeFrame);
  assertStrictSampleTimes(frames as unknown as JsonObject[], "$.frames");

  const explicitEnvironmentId = root.environmentId === undefined
    ? undefined
    : expectNonEmptyString(root.environmentId, "$.environmentId");
  const environmentId = explicitEnvironmentId
    ?? options.environmentId
    ?? options.environment?.id;
  if (!environmentId) {
    fail(
      "$.environmentId",
      "prototype frames do not identify an environment; pass the selected EnvironmentV1 to parseCameraTrajectory",
      "missing-value",
    );
  }

  const declared = optionalAdapterDuration(root);
  const durationSeconds = adapterDuration(
    frames[frames.length - 1].t,
    options,
    declared.duration,
    declared.path,
  );
  const intrinsics = defaultIntrinsics(options);
  const firstFrameFov = frames.find((frame) => frame.fovYDegrees !== undefined)?.fovYDegrees;
  if (firstFrameFov !== undefined && options.intrinsics === undefined) {
    intrinsics.fovYDegrees = firstFrameFov;
  }
  if (root.playback !== undefined) {
    assertPlayback(root.playback, "$.playback", durationSeconds);
  }

  const trajectory: CameraTrajectoryV1 = {
    schemaVersion: "1.0",
    kind: "cameraTrajectory",
    environmentId,
    clock: { durationSeconds, timeUnit: "second" },
    coordinates: { ...CANONICAL_COORDINATES_V1 },
    intrinsics,
    orientation: prototypeOrientation(frames, options),
    ...(root.playback === undefined ? {} : { playback: root.playback as CameraPlaybackV1 }),
    samples: frames.map((frame) => ({
      t: frame.t,
      position: [...frame.position] as Vec3,
      ...(frame.rotation ? { rotation: [...frame.rotation] as Quat } : {}),
      ...(frame.lookAt ? { lookAt: [...frame.lookAt] as Vec3 } : {}),
      ...(frame.fovYDegrees === undefined ? {} : { fovYDegrees: frame.fovYDegrees }),
      ...(frame.cutBefore === undefined ? {} : { cutBefore: frame.cutBefore }),
      ...(frame.actionId === undefined ? {} : { actionId: frame.actionId }),
    })),
  };
  assertCameraTrajectoryV1(trajectory);
  return trajectory;
}

function diagnostic(
  code: TrajectoryDiagnosticCode,
  message: string,
): TrajectoryDiagnostic {
  return { severity: "warning", code, message };
}

/** Checks whether a canonical path can be played against an environment. */
export function trajectoryCompatibilityDiagnostics(
  trajectory: CameraTrajectoryV1,
  environment: EnvironmentV1 | undefined,
  options: Pick<
    ParseCameraTrajectoryOptions,
    "environmentIdMismatch" | "timeCoverage"
  > = {},
): TrajectoryDiagnostic[] {
  const diagnostics: TrajectoryDiagnostic[] = [];
  const mismatchPolicy = options.environmentIdMismatch ?? "warn";
  const coveragePolicy = options.timeCoverage ?? "warn";

  if (
    environment
    && trajectory.environmentId !== environment.id
    && mismatchPolicy !== "ignore"
  ) {
    diagnostics.push(diagnostic(
      "environment-id-mismatch",
      `Trajectory environmentId ${JSON.stringify(trajectory.environmentId)} does not match selected environment ${JSON.stringify(environment.id)}.`,
    ));
  }

  const durationSeconds = environment?.clock.durationSeconds
    ?? trajectory.clock.durationSeconds;
  const firstTime = trajectory.samples[0].t;
  const lastTime = trajectory.samples[trajectory.samples.length - 1].t;
  const tolerance = 1e-6;
  if (coveragePolicy !== "ignore") {
    if (firstTime < -tolerance) {
      diagnostics.push(diagnostic(
        "trajectory-before-environment",
        `Trajectory begins at ${firstTime}s, before playback starts at 0s.`,
      ));
    } else if (firstTime > tolerance) {
      diagnostics.push(diagnostic(
        "trajectory-start-gap",
        `Trajectory begins at ${firstTime}s, leaving playback 0..${firstTime}s uncovered (the first pose will be held).`,
      ));
    }
    if (lastTime < durationSeconds - tolerance) {
      diagnostics.push(diagnostic(
        "trajectory-end-gap",
        `Trajectory ends at ${lastTime}s before playback ends at ${durationSeconds}s (the last pose will be held).`,
      ));
    } else if (lastTime > durationSeconds + tolerance) {
      diagnostics.push(diagnostic(
        "trajectory-after-environment",
        `Trajectory ends at ${lastTime}s, beyond the selected environment duration of ${durationSeconds}s.`,
      ));
    }
  }

  const errors = diagnostics.filter((item) =>
    (item.code === "environment-id-mismatch" && mismatchPolicy === "error")
    || (item.code !== "environment-id-mismatch" && coveragePolicy === "error"));
  if (errors.length > 0) {
    throw new TrajectoryCompatibilityError(errors);
  }
  return diagnostics;
}

function assertTargetCompatibility(
  trajectory: CameraTrajectoryV1,
  environment: EnvironmentV1 | undefined,
): void {
  if (!environment || trajectory.orientation.mode !== "lookAtTarget") {
    return;
  }
  const targetId = trajectory.orientation.targetId;
  if (!environment.targets.some((target) => target.id === targetId)) {
    throw new DataValidationError(
      "$.orientation.targetId",
      `selected environment has no target ${JSON.stringify(targetId)}`,
      "missing-reference",
    );
  }
}

/**
 * Accepts canonical cameraTrajectory, compact cameraPath4d, or prototype frames
 * and always returns a validated canonical CameraTrajectoryV1.
 */
export function parseCameraTrajectory(
  value: unknown,
  environmentOrOptions?: EnvironmentV1 | ParseCameraTrajectoryOptions,
): ParsedCameraTrajectory {
  const options = asOptions(environmentOrOptions);
  const root = expectObject(value, "$" as const);
  let sourceKind: TrajectorySourceKind;
  let trajectory: CameraTrajectoryV1;
  if (root.kind === "cameraTrajectory") {
    sourceKind = "cameraTrajectory";
    trajectory = parseCanonical(value);
  } else if (root.kind === "cameraPath4d") {
    sourceKind = "cameraPath4d";
    trajectory = parseCompact(value as CameraPath4dV1, options);
  } else if (Array.isArray(root.frames)) {
    sourceKind = "prototypeFrames";
    trajectory = parsePrototype(value, options);
  } else {
    fail(
      "$.kind",
      'expected "cameraTrajectory", "cameraPath4d", or a prototype object containing frames[]',
      "invalid-document-kind",
    );
  }

  assertTargetCompatibility(trajectory, options.environment);
  const diagnostics = trajectoryCompatibilityDiagnostics(
    trajectory,
    options.environment,
    options,
  );
  return {
    trajectory,
    diagnostics,
    warnings: diagnostics.map((item) => item.message),
    sourceKind,
  };
}

export function parseCameraTrajectoryJson(
  json: string,
  environmentOrOptions?: EnvironmentV1 | ParseCameraTrajectoryOptions,
): ParsedCameraTrajectory {
  return parseCameraTrajectory(
    parseJson(json, "Camera trajectory"),
    environmentOrOptions,
  );
}

export async function loadCameraTrajectoryFile(
  file: TrajectoryFileLike,
  environmentOrOptions?: EnvironmentV1 | ParseCameraTrajectoryOptions,
): Promise<ParsedCameraTrajectory> {
  let json: string;
  try {
    json = await file.text();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not read camera trajectory file: ${detail}`);
  }
  return parseCameraTrajectoryJson(json, environmentOrOptions);
}

export async function fetchCameraTrajectory(
  url: string,
  environmentOrOptions?: EnvironmentV1 | ParseCameraTrajectoryOptions,
  fetcher: JsonFetcher = defaultFetcher,
): Promise<ParsedCameraTrajectory> {
  let response: FetchResponseLike;
  try {
    response = await fetcher(url);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not load camera trajectory ${JSON.stringify(url)}: ${detail}`);
  }
  if (!response.ok) {
    throw new Error(
      `Could not load camera trajectory ${JSON.stringify(url)}: HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`,
    );
  }
  return parseCameraTrajectoryJson(await response.text(), environmentOrOptions);
}

async function defaultFetcher(url: string): Promise<FetchResponseLike> {
  if (typeof globalThis.fetch !== "function") {
    throw new Error("fetch is unavailable; pass a JsonFetcher");
  }
  return globalThis.fetch(url);
}

interface SampleInterval {
  leftIndex: number;
  rightIndex: number;
  alpha: number;
}

function findSampleInterval(
  samples: readonly CameraSampleV1[],
  timeSeconds: number,
): SampleInterval {
  const lastIndex = samples.length - 1;
  if (timeSeconds <= samples[0].t) {
    return { leftIndex: 0, rightIndex: 0, alpha: 0 };
  }
  if (timeSeconds >= samples[lastIndex].t) {
    return { leftIndex: lastIndex, rightIndex: lastIndex, alpha: 0 };
  }
  let low = 0;
  let high = lastIndex;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (samples[middle].t <= timeSeconds) {
      low = middle;
    } else {
      high = middle;
    }
  }
  if (samples[low].t === timeSeconds) {
    return { leftIndex: low, rightIndex: low, alpha: 0 };
  }
  return {
    leftIndex: low,
    rightIndex: high,
    alpha: (timeSeconds - samples[low].t) / (samples[high].t - samples[low].t),
  };
}

function directionLookAt(
  trajectory: CameraTrajectoryV1,
  sampleIndex: number,
  position: Vec3,
): Vec3 {
  const samples = trajectory.samples;
  const sample = samples[sampleIndex];
  let other: CameraSampleV1 | undefined;
  if (sampleIndex + 1 < samples.length && !samples[sampleIndex + 1].cutBefore) {
    other = samples[sampleIndex + 1];
  } else if (sampleIndex > 0 && !sample.cutBefore) {
    other = samples[sampleIndex - 1];
  }
  if (!other) {
    return [position[0], position[1], position[2] - 1];
  }
  let direction: Vec3 = [
    other.position[0] - sample.position[0],
    other.position[1] - sample.position[1],
    other.position[2] - sample.position[2],
  ];
  if (other.t < sample.t) {
    direction = [-direction[0], -direction[1], -direction[2]];
  }
  const length = Math.hypot(direction[0], direction[1], direction[2]);
  if (length <= 1e-12) {
    return [position[0], position[1], position[2] - 1];
  }
  return [
    position[0] + direction[0] / length,
    position[1] + direction[1] / length,
    position[2] + direction[2] / length,
  ];
}

function cloneAtTime(
  trajectory: CameraTrajectoryV1,
  sampleIndex: number,
  timeSeconds: number,
): CameraSampleV1 {
  const sample = trajectory.samples[sampleIndex];
  const result: CameraSampleV1 = {
    t: timeSeconds,
    position: [...sample.position] as Vec3,
    fovYDegrees: sample.fovYDegrees ?? trajectory.intrinsics.fovYDegrees,
    ...(sample.actionId === undefined ? {} : { actionId: sample.actionId }),
    ...(timeSeconds === sample.t && sample.cutBefore !== undefined
      ? { cutBefore: sample.cutBefore }
      : {}),
  };
  if (trajectory.orientation.mode === "quaternion") {
    result.rotation = normalizeQuat(sample.rotation as Quat);
  } else if (trajectory.orientation.mode === "perSampleLookAt") {
    result.lookAt = [...(sample.lookAt as Vec3)] as Vec3;
  } else if (trajectory.orientation.mode === "lookAtPoint") {
    result.lookAt = [...trajectory.orientation.point] as Vec3;
  } else if (trajectory.orientation.mode === "pathTangent") {
    result.lookAt = directionLookAt(trajectory, sampleIndex, result.position);
  }
  return result;
}

export function sampleCameraTrajectoryAt(
  trajectory: CameraTrajectoryV1,
  timeSeconds: number,
  options: SampleCameraTrajectoryOptions = {},
): CameraSampleV1 {
  if (!Number.isFinite(timeSeconds)) {
    throw new DataValidationError("timeSeconds", "expected a finite number", "invalid-number");
  }
  if (trajectory.samples.length === 0) {
    throw new DataValidationError("$.samples", "cannot sample an empty trajectory", "empty-track");
  }
  const duration = trajectory.clock.durationSeconds;
  const clampToClock = options.clampToClock ?? true;
  if (!clampToClock && (timeSeconds < 0 || timeSeconds > duration)) {
    throw new DataValidationError(
      "timeSeconds",
      `must be within 0..${duration}`,
      "out-of-range",
    );
  }
  const sampledTime = clampToClock ? clamp(timeSeconds, 0, duration) : timeSeconds;
  const interval = findSampleInterval(trajectory.samples, sampledTime);
  if (interval.leftIndex === interval.rightIndex) {
    return cloneAtTime(trajectory, interval.leftIndex, sampledTime);
  }

  const left = trajectory.samples[interval.leftIndex];
  const right = trajectory.samples[interval.rightIndex];
  // A cut begins at the right sample. Holding the left pose prevents drawing or
  // inventing camera motion between the two path segments.
  if (right.cutBefore) {
    return cloneAtTime(trajectory, interval.leftIndex, sampledTime);
  }

  const result: CameraSampleV1 = {
    t: sampledTime,
    position: lerpVec3(left.position, right.position, interval.alpha),
    fovYDegrees: lerp(
      left.fovYDegrees ?? trajectory.intrinsics.fovYDegrees,
      right.fovYDegrees ?? trajectory.intrinsics.fovYDegrees,
      interval.alpha,
    ),
    ...(left.actionId === undefined ? {} : { actionId: left.actionId }),
  };
  if (trajectory.orientation.mode === "quaternion") {
    result.rotation = slerpQuat(
      left.rotation as Quat,
      right.rotation as Quat,
      interval.alpha,
    );
  } else if (trajectory.orientation.mode === "perSampleLookAt") {
    result.lookAt = lerpVec3(
      left.lookAt as Vec3,
      right.lookAt as Vec3,
      interval.alpha,
    );
  } else if (trajectory.orientation.mode === "lookAtPoint") {
    result.lookAt = [...trajectory.orientation.point] as Vec3;
  } else if (trajectory.orientation.mode === "pathTangent") {
    const direction: Vec3 = [
      right.position[0] - left.position[0],
      right.position[1] - left.position[1],
      right.position[2] - left.position[2],
    ];
    const length = Math.hypot(direction[0], direction[1], direction[2]);
    result.lookAt = length <= 1e-12
      ? directionLookAt(trajectory, interval.leftIndex, result.position)
      : [
          result.position[0] + direction[0] / length,
          result.position[1] + direction[1] / length,
          result.position[2] + direction[2] / length,
        ];
  }
  return result;
}

/** Stable renderer-facing alias. */
export const sampleCameraTrajectory = sampleCameraTrajectoryAt;

export interface PlaybackRateStateV1 {
  rate: number;
  label: PlaybackRateLabelV1 | "custom";
}

/** Returns the environment rate active at a camera playback time. */
export function playbackRateAt(
  trajectory: CameraTrajectoryV1,
  timeSeconds: number,
): PlaybackRateStateV1 {
  if (!Number.isFinite(timeSeconds)) {
    throw new DataValidationError("timeSeconds", "expected a finite number", "invalid-number");
  }
  const time = clamp(timeSeconds, 0, trajectory.clock.durationSeconds);
  const segment = trajectory.playback?.rateSegments.find(
    (candidate, index, segments) =>
      time >= candidate.startTime
      && (time < candidate.endTime || (index === segments.length - 1 && time === candidate.endTime)),
  );
  if (!segment) return { rate: 1, label: "normal" };
  return {
    rate: segment.rate,
    label: segment.label ?? (segment.rate === 1 ? "normal" : "custom"),
  };
}

/**
 * Maps camera playback time to the environment timeline by integrating scene
 * rates. Gaps between declared segments advance at the normal 1x rate.
 */
export function environmentTimeAtPlayback(
  trajectory: CameraTrajectoryV1,
  timeSeconds: number,
): number {
  if (!Number.isFinite(timeSeconds)) {
    throw new DataValidationError("timeSeconds", "expected a finite number", "invalid-number");
  }
  const targetTime = clamp(timeSeconds, 0, trajectory.clock.durationSeconds);
  const segments = trajectory.playback?.rateSegments ?? [];
  let playbackCursor = 0;
  let environmentTime = 0;

  for (const segment of segments) {
    if (targetTime <= segment.startTime) {
      return environmentTime + Math.max(0, targetTime - playbackCursor);
    }
    environmentTime += Math.max(0, segment.startTime - playbackCursor);
    if (targetTime <= segment.endTime) {
      return environmentTime + (targetTime - segment.startTime) * segment.rate;
    }
    environmentTime += (segment.endTime - segment.startTime) * segment.rate;
    playbackCursor = segment.endTime;
  }

  return environmentTime + Math.max(0, targetTime - playbackCursor);
}

/** Splits path geometry at every sample marked cutBefore. */
export function trajectorySegments(
  trajectory: CameraTrajectoryV1,
): CameraSampleV1[][] {
  const segments: CameraSampleV1[][] = [];
  let current: CameraSampleV1[] = [];
  trajectory.samples.forEach((sample) => {
    if (sample.cutBefore && current.length > 0) {
      segments.push(current);
      current = [];
    }
    current.push(sample);
  });
  if (current.length > 0) {
    segments.push(current);
  }
  return segments;
}

export { DataValidationError } from "./validation";
