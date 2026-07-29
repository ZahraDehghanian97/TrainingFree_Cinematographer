import type {
  BoundsV1,
  Channel,
  CoordinateSystemV1,
  EntityTransformV1,
  EnvironmentV1,
  KeyframedChannel,
  Quat,
  SceneEntityV1,
  Vec3,
} from "../../src/types/environment";
import {
  clamp,
  normalizeQuat,
  sampleQuatKeyframes,
  sampleVec3Keyframes,
  type Vec3Interpolation,
} from "./interpolation";
import {
  DataValidationError,
  expectArray,
  expectFiniteNumber,
  expectInteger,
  expectLiteral,
  expectNonEmptyString,
  expectNonNegativeNumber,
  expectObject,
  expectOneOf,
  expectPositiveNumber,
  expectString,
  fail,
  parseJson,
  type JsonObject,
} from "./validation";

const VEC3_INTERPOLATIONS = ["step", "linear", "catmullRom"] as const;
const QUAT_INTERPOLATIONS = ["step", "slerp"] as const;
const PRESET_NAMES = [
  "soccerBall",
  "soccerGoal",
  "humanoid",
  "car",
  "door",
  "vase",
  "monitor",
  "genericObject",
] as const;
const PRIMITIVE_SHAPES = ["box", "sphere", "cylinder", "cone", "plane", "torus"] as const;

export const CANONICAL_COORDINATES_V1: CoordinateSystemV1 = {
  handedness: "right",
  upAxis: "+Y",
  cameraForwardAxis: "-Z",
  lengthUnit: "meter",
  rotationOrder: "quaternion-xyzw",
};

export interface FetchResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly statusText: string;
  text(): Promise<string>;
}

export type JsonFetcher = (url: string) => Promise<FetchResponseLike>;

export interface LoadEnvironmentOptions {
  fetcher?: JsonFetcher;
}

export interface SampledEntityTransformV1 {
  space: "world";
  position: Vec3;
  rotation: Quat;
  scale: Vec3;
}

export interface SampledSceneEntityV1 {
  entity: SceneEntityV1;
  transform: SampledEntityTransformV1;
}

export interface SampledEnvironmentV1 {
  timeSeconds: number;
  entities: SampledSceneEntityV1[];
}

export interface SampleEnvironmentOptions {
  /** Defaults to true, which is convenient for scrubbers at either endpoint. */
  clampToClock?: boolean;
}

function assertVec3(value: unknown, path: string): asserts value is Vec3 {
  const tuple = expectArray(value, path);
  if (tuple.length !== 3) {
    fail(path, `expected exactly 3 numbers, received ${tuple.length}`, "invalid-tuple-size");
  }
  tuple.forEach((component, index) => expectFiniteNumber(component, `${path}[${index}]`));
}

function assertQuat(value: unknown, path: string): asserts value is Quat {
  const tuple = expectArray(value, path);
  if (tuple.length !== 4) {
    fail(path, `expected exactly 4 numbers in x, y, z, w order, received ${tuple.length}`, "invalid-tuple-size");
  }
  tuple.forEach((component, index) => expectFiniteNumber(component, `${path}[${index}]`));
  const length = Math.hypot(...(tuple as number[]));
  if (length <= 1e-12) {
    fail(path, "quaternion must have non-zero length", "invalid-quaternion");
  }
}

/** Validates the one coordinate convention supported by schema v1. */
export function assertCoordinateSystemV1(
  value: unknown,
  path: string,
): asserts value is CoordinateSystemV1 {
  const coordinates = expectObject(value, path);
  expectLiteral(coordinates.handedness, "right", `${path}.handedness`);
  expectLiteral(coordinates.upAxis, "+Y", `${path}.upAxis`);
  expectLiteral(coordinates.cameraForwardAxis, "-Z", `${path}.cameraForwardAxis`);
  expectLiteral(coordinates.lengthUnit, "meter", `${path}.lengthUnit`);
  expectLiteral(coordinates.rotationOrder, "quaternion-xyzw", `${path}.rotationOrder`);
}

function assertStrictTimes(
  keyframes: readonly unknown[],
  path: string,
  durationSeconds: number,
): void {
  let previousTime = -Infinity;
  keyframes.forEach((candidate, index) => {
    const keyframePath = `${path}[${index}]`;
    const keyframe = expectObject(candidate, keyframePath);
    const time = expectNonNegativeNumber(keyframe.t, `${keyframePath}.t`);
    if (time > durationSeconds) {
      fail(
        `${keyframePath}.t`,
        `must be within the environment clock (0..${durationSeconds} seconds)`,
        "out-of-range",
      );
    }
    if (time <= previousTime) {
      fail(
        `${keyframePath}.t`,
        `times must be strictly increasing and unique; previous time is ${previousTime}`,
        "non-monotonic-time",
      );
    }
    previousTime = time;
  });
}

function assertVec3Channel(
  value: unknown,
  path: string,
  durationSeconds: number,
): asserts value is Channel<Vec3> {
  if (Array.isArray(value)) {
    assertVec3(value, path);
    return;
  }
  const channel = expectObject(value, path);
  expectOneOf(channel.interpolation, VEC3_INTERPOLATIONS, `${path}.interpolation`);
  if (channel.extrapolation !== undefined) {
    expectLiteral(channel.extrapolation, "hold", `${path}.extrapolation`);
  }
  const keyframes = expectArray(channel.keyframes, `${path}.keyframes`);
  if (keyframes.length === 0) {
    fail(`${path}.keyframes`, "must contain at least one keyframe", "empty-track");
  }
  assertStrictTimes(keyframes, `${path}.keyframes`, durationSeconds);
  keyframes.forEach((candidate, index) => {
    const keyframe = expectObject(candidate, `${path}.keyframes[${index}]`);
    assertVec3(keyframe.value, `${path}.keyframes[${index}].value`);
  });
}

function assertQuatChannel(
  value: unknown,
  path: string,
  durationSeconds: number,
): asserts value is Channel<Quat> {
  if (Array.isArray(value)) {
    assertQuat(value, path);
    return;
  }
  const channel = expectObject(value, path);
  expectOneOf(channel.interpolation, QUAT_INTERPOLATIONS, `${path}.interpolation`);
  if (channel.extrapolation !== undefined) {
    expectLiteral(channel.extrapolation, "hold", `${path}.extrapolation`);
  }
  const keyframes = expectArray(channel.keyframes, `${path}.keyframes`);
  if (keyframes.length === 0) {
    fail(`${path}.keyframes`, "must contain at least one keyframe", "empty-track");
  }
  assertStrictTimes(keyframes, `${path}.keyframes`, durationSeconds);
  keyframes.forEach((candidate, index) => {
    const keyframe = expectObject(candidate, `${path}.keyframes[${index}]`);
    assertQuat(keyframe.value, `${path}.keyframes[${index}].value`);
  });
}

function assertBounds(value: unknown, path: string): asserts value is BoundsV1 {
  const bounds = expectObject(value, path);
  if (bounds.type === "sphere") {
    assertVec3(bounds.center, `${path}.center`);
    expectPositiveNumber(bounds.radius, `${path}.radius`);
    return;
  }
  if (bounds.type === "box") {
    assertVec3(bounds.min, `${path}.min`);
    assertVec3(bounds.max, `${path}.max`);
    for (let axis = 0; axis < 3; axis += 1) {
      if (bounds.min[axis] > bounds.max[axis]) {
        fail(
          `${path}.min[${axis}]`,
          `must not exceed ${path}.max[${axis}]`,
          "invalid-bounds",
        );
      }
    }
    return;
  }
  fail(`${path}.type`, 'expected "sphere" or "box"', "invalid-enum");
}

function assertScalarParams(value: unknown, path: string): void {
  const params = expectObject(value, path);
  Object.entries(params).forEach(([key, item]) => {
    if (typeof item === "number") {
      expectFiniteNumber(item, `${path}.${key}`);
    } else if (typeof item !== "string" && typeof item !== "boolean") {
      fail(`${path}.${key}`, "expected a finite number, string, or boolean", "invalid-type");
    }
  });
}

function assertVisual(value: unknown, path: string): void {
  const visual = expectObject(value, path);
  if (visual.type === "preset") {
    expectOneOf(visual.name, PRESET_NAMES, `${path}.name`);
    if (visual.params !== undefined) {
      assertScalarParams(visual.params, `${path}.params`);
    }
    return;
  }
  if (visual.type === "primitive") {
    expectOneOf(visual.shape, PRIMITIVE_SHAPES, `${path}.shape`);
    const params = expectObject(visual.params, `${path}.params`);
    Object.entries(params).forEach(([key, item]) => {
      if (Array.isArray(item)) {
        assertVec3(item, `${path}.params.${key}`);
      } else {
        expectFiniteNumber(item, `${path}.params.${key}`);
      }
    });
    if (visual.color !== undefined) {
      expectNonEmptyString(visual.color, `${path}.color`);
    }
    return;
  }
  fail(`${path}.type`, 'expected "preset" or "primitive"', "invalid-enum");
}

function assertTransform(
  value: unknown,
  path: string,
  durationSeconds: number,
): asserts value is EntityTransformV1 {
  const transform = expectObject(value, path);
  expectLiteral(transform.space, "world", `${path}.space`);
  assertVec3Channel(transform.position, `${path}.position`, durationSeconds);
  if (transform.rotation !== undefined) {
    assertQuatChannel(transform.rotation, `${path}.rotation`, durationSeconds);
  }
  if (transform.scale !== undefined) {
    assertVec3Channel(transform.scale, `${path}.scale`, durationSeconds);
  }
}

function assertEntity(
  value: unknown,
  path: string,
  durationSeconds: number,
): asserts value is SceneEntityV1 {
  const entity = expectObject(value, path);
  expectNonEmptyString(entity.id, `${path}.id`);
  if (entity.label !== undefined) {
    expectNonEmptyString(entity.label, `${path}.label`);
  }
  assertTransform(entity.transform, `${path}.transform`, durationSeconds);
  assertVisual(entity.visual, `${path}.visual`);
  if (entity.bounds !== undefined) {
    assertBounds(entity.bounds, `${path}.bounds`);
  }
}

/** Throws DataValidationError at the precise JSON path on invalid input. */
export function assertEnvironmentV1(value: unknown): asserts value is EnvironmentV1 {
  const environment = expectObject(value, "$" as const);
  expectLiteral(environment.schemaVersion, "1.0", "$.schemaVersion");
  expectLiteral(environment.kind, "environment", "$.kind");
  expectNonEmptyString(environment.id, "$.id");
  expectNonEmptyString(environment.promptExampleId, "$.promptExampleId");
  expectString(environment.prompt, "$.prompt");

  const clock = expectObject(environment.clock, "$.clock");
  const durationSeconds = expectPositiveNumber(clock.durationSeconds, "$.clock.durationSeconds");
  expectLiteral(clock.timeDomain, "playback", "$.clock.timeDomain");
  if (clock.fpsHint !== undefined) {
    expectPositiveNumber(clock.fpsHint, "$.clock.fpsHint");
  }
  assertCoordinateSystemV1(environment.coordinates, "$.coordinates");

  if (environment.evaluation !== undefined) {
    const evaluation = expectObject(environment.evaluation, "$.evaluation");
    expectOneOf(
      evaluation.distanceMetric,
      ["boundsSurface", "anchorCenter"] as const,
      "$.evaluation.distanceMetric",
    );
    if (evaluation.epsilon !== undefined) {
      expectNonNegativeNumber(evaluation.epsilon, "$.evaluation.epsilon");
    }
  }

  if (environment.world !== undefined) {
    const world = expectObject(environment.world, "$.world");
    if (world.background !== undefined) {
      expectNonEmptyString(world.background, "$.world.background");
    }
    if (world.overviewCamera !== undefined) {
      const overviewCamera = expectObject(world.overviewCamera, "$.world.overviewCamera");
      assertVec3(overviewCamera.position, "$.world.overviewCamera.position");
      assertVec3(overviewCamera.target, "$.world.overviewCamera.target");
      if (
        overviewCamera.position.every(
          (component, index) => component === overviewCamera.target[index],
        )
      ) {
        fail(
          "$.world.overviewCamera",
          "position and target must not be identical",
          "invalid-camera-pose",
        );
      }
    }
    if (world.ground !== undefined) {
      const ground = expectObject(world.ground, "$.world.ground");
      expectFiniteNumber(ground.y, "$.world.ground.y");
      const size = expectArray(ground.size, "$.world.ground.size");
      if (size.length !== 2) {
        fail("$.world.ground.size", "expected exactly 2 numbers", "invalid-tuple-size");
      }
      size.forEach((component, index) =>
        expectPositiveNumber(component, `$.world.ground.size[${index}]`));
      if (ground.color !== undefined) {
        expectNonEmptyString(ground.color, "$.world.ground.color");
      }
    }
    if (world.grid !== undefined) {
      const grid = expectObject(world.grid, "$.world.grid");
      expectPositiveNumber(grid.size, "$.world.grid.size");
      const divisions = expectInteger(grid.divisions, "$.world.grid.divisions");
      if (divisions <= 0) {
        fail("$.world.grid.divisions", "must be greater than 0", "out-of-range");
      }
    }
  }

  const entities = expectArray(environment.entities, "$.entities");
  const entityIds = new Set<string>();
  entities.forEach((candidate, index) => {
    const path = `$.entities[${index}]`;
    assertEntity(candidate, path, durationSeconds);
    if (entityIds.has(candidate.id)) {
      fail(`${path}.id`, `duplicate entity id ${JSON.stringify(candidate.id)}`, "duplicate-id");
    }
    entityIds.add(candidate.id);
  });

  const targets = expectArray(environment.targets, "$.targets");
  const targetIds = new Set<string>();
  targets.forEach((candidate, index) => {
    const path = `$.targets[${index}]`;
    const target = expectObject(candidate, path);
    const id = expectNonEmptyString(target.id, `${path}.id`);
    const entityId = expectNonEmptyString(target.entityId, `${path}.entityId`);
    if (targetIds.has(id)) {
      fail(`${path}.id`, `duplicate target id ${JSON.stringify(id)}`, "duplicate-id");
    }
    if (!entityIds.has(entityId)) {
      fail(
        `${path}.entityId`,
        `references missing entity ${JSON.stringify(entityId)}`,
        "missing-reference",
      );
    }
    targetIds.add(id);
    if (target.label !== undefined) {
      expectNonEmptyString(target.label, `${path}.label`);
    }
    assertVec3(target.localAnchor, `${path}.localAnchor`);
    if (target.localBounds !== undefined) {
      assertBounds(target.localBounds, `${path}.localBounds`);
    }
  });
}

export function parseEnvironment(input: unknown): EnvironmentV1 {
  assertEnvironmentV1(input);
  return input;
}

export function parseEnvironmentJson(json: string): EnvironmentV1 {
  return parseEnvironment(parseJson(json, "Environment"));
}

export async function loadEnvironment(
  url: string,
  options: LoadEnvironmentOptions = {},
): Promise<EnvironmentV1> {
  const fetcher = options.fetcher ?? defaultFetcher;
  let response: FetchResponseLike;
  try {
    response = await fetcher(url);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not load environment ${JSON.stringify(url)}: ${detail}`);
  }
  if (!response.ok) {
    throw new Error(
      `Could not load environment ${JSON.stringify(url)}: HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`,
    );
  }
  return parseEnvironmentJson(await response.text());
}

async function defaultFetcher(url: string): Promise<FetchResponseLike> {
  if (typeof globalThis.fetch !== "function") {
    throw new Error("fetch is unavailable; pass LoadEnvironmentOptions.fetcher");
  }
  return globalThis.fetch(url);
}

function isKeyframedChannel<T>(value: Channel<T>): value is KeyframedChannel<T> {
  return !Array.isArray(value);
}

export function sampleVec3ChannelAt(channel: Channel<Vec3>, timeSeconds: number): Vec3 {
  if (!isKeyframedChannel(channel)) {
    return [...channel] as Vec3;
  }
  return sampleVec3Keyframes(
    channel.keyframes,
    timeSeconds,
    channel.interpolation as Vec3Interpolation,
  );
}

export function sampleQuatChannelAt(channel: Channel<Quat>, timeSeconds: number): Quat {
  if (!isKeyframedChannel(channel)) {
    return normalizeQuat(channel);
  }
  return sampleQuatKeyframes(
    channel.keyframes,
    timeSeconds,
    channel.interpolation as "step" | "slerp",
  );
}

export function sampleEntityTransformAt(
  transform: EntityTransformV1,
  timeSeconds: number,
): SampledEntityTransformV1 {
  if (!Number.isFinite(timeSeconds)) {
    throw new DataValidationError("timeSeconds", "expected a finite number", "invalid-number");
  }
  return {
    space: "world",
    position: sampleVec3ChannelAt(transform.position, timeSeconds),
    rotation: transform.rotation
      ? sampleQuatChannelAt(transform.rotation, timeSeconds)
      : [0, 0, 0, 1],
    scale: transform.scale ? sampleVec3ChannelAt(transform.scale, timeSeconds) : [1, 1, 1],
  };
}

/** Stable renderer-facing form; accepts either an entity or its transform. */
export function sampleEntityTransform(
  entityOrTransform: SceneEntityV1 | EntityTransformV1,
  timeSeconds: number,
): SampledEntityTransformV1 {
  const transform = "transform" in entityOrTransform
    ? entityOrTransform.transform
    : entityOrTransform;
  return sampleEntityTransformAt(transform, timeSeconds);
}

export function sampleEnvironmentAt(
  environment: EnvironmentV1,
  timeSeconds: number,
  options: SampleEnvironmentOptions = {},
): SampledEnvironmentV1 {
  if (!Number.isFinite(timeSeconds)) {
    throw new DataValidationError("timeSeconds", "expected a finite number", "invalid-number");
  }
  const duration = environment.clock.durationSeconds;
  const clampToClock = options.clampToClock ?? true;
  if (!clampToClock && (timeSeconds < 0 || timeSeconds > duration)) {
    throw new DataValidationError(
      "timeSeconds",
      `must be within 0..${duration}`,
      "out-of-range",
    );
  }
  const sampledTime = clampToClock ? clamp(timeSeconds, 0, duration) : timeSeconds;
  return {
    timeSeconds: sampledTime,
    entities: environment.entities.map((entity) => ({
      entity,
      transform: sampleEntityTransformAt(entity.transform, sampledTime),
    })),
  };
}

/** Convenience form for renderers that index transforms by entity id. */
export function sampleEnvironmentTransformsAt(
  environment: EnvironmentV1,
  timeSeconds: number,
  options: SampleEnvironmentOptions = {},
): Record<string, SampledEntityTransformV1> {
  return Object.fromEntries(
    sampleEnvironmentAt(environment, timeSeconds, options).entities.map(({ entity, transform }) => [
      entity.id,
      transform,
    ]),
  );
}

/** Stable public aliases used by the app integration layer. */
export const validateEnvironment = parseEnvironment;
export const fetchEnvironment = loadEnvironment;

export { DataValidationError } from "./validation";
