import { readFile } from "node:fs/promises";
import * as path from "node:path";
import type { EnvironmentV1 } from "../types/environment";

interface EnvironmentManifestEntry {
  id: string;
  url: string;
}

interface EnvironmentManifest {
  schemaVersion: "1.0";
  kind: "environmentManifest";
  environments: EnvironmentManifestEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNonEmptyString(value: unknown, pathName: string): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${pathName} must be a non-empty string.`);
  }
}

function assertFiniteTuple(value: unknown, length: number, pathName: string): void {
  if (
    !Array.isArray(value)
    || value.length !== length
    || !value.every((component) => typeof component === "number" && Number.isFinite(component))
  ) {
    throw new Error(`${pathName} must contain ${length} finite numbers.`);
  }
}

function assertChannel(
  value: unknown,
  tupleLength: 3 | 4,
  durationSeconds: number,
  pathName: string,
): void {
  if (Array.isArray(value)) {
    assertFiniteTuple(value, tupleLength, pathName);
    return;
  }
  if (!isRecord(value) || !Array.isArray(value.keyframes) || value.keyframes.length === 0) {
    throw new Error(`${pathName} must be a constant tuple or a non-empty keyframed channel.`);
  }
  const allowed = tupleLength === 4
    ? new Set(["step", "slerp"])
    : new Set(["step", "linear", "catmullRom"]);
  if (!allowed.has(String(value.interpolation))) {
    throw new Error(`${pathName}.interpolation is unsupported.`);
  }
  if (value.extrapolation !== undefined && value.extrapolation !== "hold") {
    throw new Error(`${pathName}.extrapolation must be hold.`);
  }
  let previousTime = -Infinity;
  value.keyframes.forEach((keyframe, index) => {
    if (!isRecord(keyframe)) throw new Error(`${pathName}.keyframes[${index}] is invalid.`);
    const time = keyframe.t;
    if (
      typeof time !== "number"
      || !Number.isFinite(time)
      || time < 0
      || time > durationSeconds
      || time <= previousTime
    ) {
      throw new Error(`${pathName}.keyframes[${index}].t must increase inside the scene clock.`);
    }
    previousTime = time;
    assertFiniteTuple(keyframe.value, tupleLength, `${pathName}.keyframes[${index}].value`);
  });
}

function assertBounds(value: unknown, pathName: string): void {
  if (!isRecord(value)) throw new Error(`${pathName} must be an object.`);
  if (value.type === "sphere") {
    assertFiniteTuple(value.center, 3, `${pathName}.center`);
    if (typeof value.radius !== "number" || !Number.isFinite(value.radius) || value.radius <= 0) {
      throw new Error(`${pathName}.radius must be positive and finite.`);
    }
    return;
  }
  if (value.type === "box") {
    assertFiniteTuple(value.min, 3, `${pathName}.min`);
    assertFiniteTuple(value.max, 3, `${pathName}.max`);
    const minimum = value.min as number[];
    const maximum = value.max as number[];
    if (minimum.some((component, axis) => component > maximum[axis]!)) {
      throw new Error(`${pathName}.min must not exceed max.`);
    }
    return;
  }
  throw new Error(`${pathName}.type must be sphere or box.`);
}

function assertManifest(value: unknown): asserts value is EnvironmentManifest {
  if (!isRecord(value) || value.schemaVersion !== "1.0" || value.kind !== "environmentManifest") {
    throw new Error("Environment manifest has an unsupported shape.");
  }
  if (!Array.isArray(value.environments) || value.environments.length === 0) {
    throw new Error("Environment manifest must contain at least one entry.");
  }
  const ids = new Set<string>();
  for (const entry of value.environments) {
    if (
      !isRecord(entry)
      || typeof entry.id !== "string"
      || !entry.id.trim()
      || typeof entry.url !== "string"
      || !entry.url.trim()
    ) {
      throw new Error("Environment manifest contains an invalid entry.");
    }
    if (ids.has(entry.id)) throw new Error(`Duplicate environment ID ${JSON.stringify(entry.id)}`);
    ids.add(entry.id);
  }
}

function assertTrustedEnvironment(
  value: unknown,
  expectedId: string,
): asserts value is EnvironmentV1 {
  if (
    !isRecord(value)
    || value.schemaVersion !== "1.0"
    || value.kind !== "environment"
    || value.id !== expectedId
    || typeof value.promptExampleId !== "string"
    || typeof value.prompt !== "string"
    || !isRecord(value.clock)
    || typeof value.clock.durationSeconds !== "number"
    || !Number.isFinite(value.clock.durationSeconds)
    || value.clock.durationSeconds <= 0
    || value.clock.timeDomain !== "playback"
    || !isRecord(value.coordinates)
    || value.coordinates.handedness !== "right"
    || value.coordinates.upAxis !== "+Y"
    || value.coordinates.cameraForwardAxis !== "-Z"
    || value.coordinates.lengthUnit !== "meter"
    || value.coordinates.rotationOrder !== "quaternion-xyzw"
    || !Array.isArray(value.entities)
    || !Array.isArray(value.targets)
  ) {
    throw new Error(`Environment ${JSON.stringify(expectedId)} has an invalid document shape.`);
  }

  const durationSeconds = value.clock.durationSeconds;
  if (
    value.clock.fpsHint !== undefined
    && (typeof value.clock.fpsHint !== "number"
      || !Number.isFinite(value.clock.fpsHint)
      || value.clock.fpsHint <= 0)
  ) {
    throw new Error(`Environment ${JSON.stringify(expectedId)} has an invalid fpsHint.`);
  }

  const entityIds = new Set<string>();
  value.entities.forEach((candidate, index) => {
    const entityPath = `entities[${index}]`;
    if (!isRecord(candidate)) throw new Error(`${entityPath} must be an object.`);
    assertNonEmptyString(candidate.id, `${entityPath}.id`);
    if (entityIds.has(candidate.id)) throw new Error(`Duplicate entity ID ${JSON.stringify(candidate.id)}.`);
    entityIds.add(candidate.id);
    if (!isRecord(candidate.transform) || candidate.transform.space !== "world") {
      throw new Error(`${entityPath}.transform must be world-space.`);
    }
    assertChannel(candidate.transform.position, 3, durationSeconds, `${entityPath}.transform.position`);
    if (candidate.transform.rotation !== undefined) {
      assertChannel(candidate.transform.rotation, 4, durationSeconds, `${entityPath}.transform.rotation`);
    }
    if (candidate.transform.scale !== undefined) {
      assertChannel(candidate.transform.scale, 3, durationSeconds, `${entityPath}.transform.scale`);
    }
    if (!isRecord(candidate.visual) || (candidate.visual.type !== "preset" && candidate.visual.type !== "primitive")) {
      throw new Error(`${entityPath}.visual has an unsupported shape.`);
    }
    if (candidate.bounds !== undefined) assertBounds(candidate.bounds, `${entityPath}.bounds`);
  });

  const targetIds = new Set<string>();
  value.targets.forEach((candidate, index) => {
    const targetPath = `targets[${index}]`;
    if (!isRecord(candidate)) throw new Error(`${targetPath} must be an object.`);
    assertNonEmptyString(candidate.id, `${targetPath}.id`);
    assertNonEmptyString(candidate.entityId, `${targetPath}.entityId`);
    if (targetIds.has(candidate.id)) throw new Error(`Duplicate target ID ${JSON.stringify(candidate.id)}.`);
    if (!entityIds.has(candidate.entityId)) {
      throw new Error(`${targetPath}.entityId references missing entity ${JSON.stringify(candidate.entityId)}.`);
    }
    targetIds.add(candidate.id);
    assertFiniteTuple(candidate.localAnchor, 3, `${targetPath}.localAnchor`);
    if (candidate.localBounds !== undefined) assertBounds(candidate.localBounds, `${targetPath}.localBounds`);
  });
}

/** Loads only environment files explicitly allowlisted by the checked-in manifest. */
export class EnvironmentRepository {
  private manifestPromise?: Promise<EnvironmentManifest>;

  constructor(readonly directory: string) {}

  private async manifest(): Promise<EnvironmentManifest> {
    if (!this.manifestPromise) {
      this.manifestPromise = readFile(path.join(this.directory, "manifest.json"), "utf8")
        .then((text) => JSON.parse(text) as unknown)
        .then((value) => {
          assertManifest(value);
          return value;
        });
    }
    return this.manifestPromise;
  }

  async load(environmentId: string): Promise<EnvironmentV1> {
    const manifest = await this.manifest();
    const entry = manifest.environments.find((candidate) => candidate.id === environmentId);
    if (!entry) throw new Error(`Unknown environment ${JSON.stringify(environmentId)}.`);

    const filename = path.basename(new URL(entry.url, "http://camera.local").pathname);
    if (!filename.endsWith(".json") || filename === "manifest.json") {
      throw new Error(`Environment manifest URL for ${JSON.stringify(environmentId)} is invalid.`);
    }
    const filePath = path.resolve(this.directory, filename);
    if (path.dirname(filePath) !== path.resolve(this.directory)) {
      throw new Error(`Environment path for ${JSON.stringify(environmentId)} escapes the catalog.`);
    }

    let value: unknown;
    try {
      value = JSON.parse(await readFile(filePath, "utf8")) as unknown;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not load environment ${JSON.stringify(environmentId)}: ${detail}`);
    }
    assertTrustedEnvironment(value, environmentId);
    return value;
  }
}
