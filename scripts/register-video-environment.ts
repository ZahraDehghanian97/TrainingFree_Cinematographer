/**
 * Register an environment reconstructed from real video (the notebook's
 * `scene.environment.json`) so the camera optimizer can use it.
 *
 * Why this script exists
 * ----------------------
 * 1. The optimizer refuses relative-scale scenes (validateOptimizerInput throws
 *    for `metricScale.status === "relative"`), because collision/clearance/framing
 *    distances are in metres. A video reconstruction has an arbitrary scale, so we
 *    multiply every length by one factor (`--meters-per-unit`) and mark the scene
 *    as calibrated with one metre per coordinate unit.
 * 2. `EnvironmentRepository` only loads environments listed in a manifest.json. The
 *    shared web/public/environments catalogue is reserved for stadium and factory (the
 *    audit asserts exactly those two), so each video scene gets its own small catalogue
 *    in video/<scene>/environment/.
 * 3. The factor is stored in video/<scene>/scene.json for later steps (pinning the start
 *    camera, converting the camera path for TTM).
 *
 * Usage (from the repo root; layout described in scripts/video-paths.ts)
 *   # first time: copy the notebook outputs into video/<scene>/source/ and list the entities
 *   npm run video:register -- --scene the-pianist \
 *     --environment path/scene.environment.json --tracking path/scene.tracking.json
 *   # then calibrate
 *   npm run video:register -- --scene the-pianist --meters-per-unit 15.2
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { EnvironmentRepository } from "../src/pipeline/environment-repository";
import { scenePaths, type SceneRegistry } from "./video-paths";
import type {
  BoundsV1,
  Channel,
  EnvironmentV1,
  KeyframedChannel,
  Quat,
  Vec3,
} from "../src/types/environment";

interface Args {
  scene: string;
  importEnvironment?: string;
  importTracking?: string;
  metersPerUnit?: number;
}

function parseArgs(argv: readonly string[]): Args {
  const known = new Set(["--scene", "--environment", "--tracking", "--meters-per-unit"]);
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const [name, inline] = argv[index]!.split("=", 2);
    if (!known.has(name!)) throw new Error(`Unknown option: ${argv[index]}`);
    values.set(name!, inline ?? argv[++index] ?? "");
  }
  const scene = values.get("--scene");
  if (!scene) throw new Error("--scene <scene-id> is required (it becomes video/<scene-id>/)");
  let metersPerUnit: number | undefined;
  if (values.has("--meters-per-unit")) {
    metersPerUnit = Number(values.get("--meters-per-unit"));
    if (!Number.isFinite(metersPerUnit) || metersPerUnit <= 0) {
      throw new Error("--meters-per-unit must be a positive finite number");
    }
  }
  const resolve = (name: string): string | undefined =>
    values.has(name) ? path.resolve(process.cwd(), values.get(name)!) : undefined;
  return { scene, importEnvironment: resolve("--environment"), importTracking: resolve("--tracking"), metersPerUnit };
}

const scaleVec = (value: Vec3, factor: number): Vec3 =>
  [value[0] * factor, value[1] * factor, value[2] * factor];

function scaleChannel(channel: Channel<Vec3>, factor: number): Channel<Vec3> {
  if (Array.isArray(channel)) return scaleVec(channel as Vec3, factor);
  const keyframed = channel as KeyframedChannel<Vec3>;
  return {
    ...keyframed,
    keyframes: keyframed.keyframes.map((keyframe) => ({ ...keyframe, value: scaleVec(keyframe.value, factor) })),
  };
}

function scaleBounds(bounds: BoundsV1, factor: number): BoundsV1 {
  if (bounds.type === "sphere") {
    return { ...bounds, center: scaleVec(bounds.center, factor), radius: bounds.radius * factor };
  }
  return { ...bounds, min: scaleVec(bounds.min, factor), max: scaleVec(bounds.max, factor) };
}

/** Returns a deep copy of the environment with every length multiplied by `factor`. */
function scaleEnvironment(source: EnvironmentV1, factor: number): EnvironmentV1 {
  const environment = JSON.parse(JSON.stringify(source)) as EnvironmentV1;
  // Local-space data (bounds, anchors) is multiplied by transform.scale at sampling time
  // (src/environment/sampler.ts). Entities that carry a scale, like all video entities, get
  // their size from that scale, so scaling it is enough; scaling their local bounds as well
  // would apply the factor twice. Only entities WITHOUT a scale need their local data scaled.
  const hasScale = new Map<string, boolean>();
  for (const entity of environment.entities) {
    hasScale.set(entity.id, entity.transform.scale !== undefined);
    entity.transform.position = scaleChannel(entity.transform.position, factor);
    if (entity.transform.scale !== undefined) {
      entity.transform.scale = scaleChannel(entity.transform.scale, factor);
    } else if (entity.bounds !== undefined) {
      entity.bounds = scaleBounds(entity.bounds, factor);
    }
    if (entity.occlusion?.bounds !== undefined) {
      throw new Error(`Entity ${entity.id} has occlusion bounds; scaling them is not supported by this script.`);
    }
  }
  for (const anchor of environment.semanticAnchors ?? []) {
    if (hasScale.get(anchor.entityId) === true) continue;
    anchor.localAnchor = scaleVec(anchor.localAnchor, factor);
    if (anchor.localBounds !== undefined) anchor.localBounds = scaleBounds(anchor.localBounds, factor);
  }
  const world = environment.world;
  if (world?.ground !== undefined) {
    world.ground.y *= factor;
    world.ground.size = [world.ground.size[0] * factor, world.ground.size[1] * factor];
  }
  if (world?.grid !== undefined) world.grid.size *= factor;
  if (world?.overviewCamera !== undefined) {
    world.overviewCamera = {
      position: scaleVec(world.overviewCamera.position, factor),
      target: scaleVec(world.overviewCamera.target, factor),
    };
  }
  return environment;
}

function keyframesOf<T>(channel: Channel<T>): { t: number; value: T }[] {
  return Array.isArray(channel) ? [{ t: 0, value: channel as T }] : (channel as KeyframedChannel<T>).keyframes;
}

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function summarize(environment: EnvironmentV1, factor: number): void {
  console.log(`Environment ${environment.id}: ${environment.clock.durationSeconds}s, ${environment.entities.length} entities`);
  console.log("entity id | label | born (s) | median size x,y,z (m at this factor) | mean speed (m/s)");
  for (const entity of environment.entities) {
    const positions = keyframesOf(entity.transform.position);
    const sizes = keyframesOf(entity.transform.scale ?? [1, 1, 1] as Vec3)
      .map((keyframe) => keyframe.value)
      .filter((size) => size.some((component) => component > 0));
    const born = keyframesOf(entity.transform.scale ?? [1, 1, 1] as Vec3)
      .find((keyframe) => keyframe.value.some((component) => component > 0))?.t ?? 0;
    let distance = 0;
    for (let index = 1; index < positions.length; index += 1) {
      const a = positions[index - 1]!.value;
      const b = positions[index]!.value;
      distance += Math.hypot(b[0] - a[0], b[2] - a[2]);
    }
    const span = positions.length > 1 ? positions[positions.length - 1]!.t - positions[0]!.t : 0;
    const box = entity.bounds?.type === "box" ? entity.bounds : undefined;
    const boundsSize = box ? [0, 1, 2].map((axis) => box.max[axis]! - box.min[axis]!) : undefined;
    const size = sizes.length > 0
      ? [0, 1, 2].map((axis) => median(sizes.map((value) => value[axis]!)) * factor)
      : (boundsSize ?? [NaN, NaN, NaN]).map((value) => value * factor);
    console.log(`${entity.id} | ${entity.label ?? ""} | ${born.toFixed(2)} | `
      + `${size.map((value) => value.toFixed(3)).join(", ")} | ${span > 0 ? (distance * factor / span).toFixed(3) : "n/a"}`);
  }
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const paths = scenePaths(args.scene);
  fs.mkdirSync(paths.sourceDirectory, { recursive: true });
  // Importing copies the raw notebook outputs next to the scene; the originals are never modified.
  if (args.importEnvironment) fs.copyFileSync(args.importEnvironment, paths.sourceEnvironment);
  if (args.importTracking) fs.copyFileSync(args.importTracking, paths.sourceTracking);
  if (!fs.existsSync(paths.sourceEnvironment)) {
    throw new Error(`Missing ${paths.sourceEnvironment}. Pass --environment <scene.environment.json> once to import it.`);
  }

  const raw = fs.readFileSync(paths.sourceEnvironment, "utf8");
  const source = JSON.parse(raw) as EnvironmentV1;
  if (source.kind !== "environment" || source.schemaVersion !== "1.0") {
    throw new Error("Input is not an EnvironmentV1 document (kind/schemaVersion mismatch).");
  }
  const relative = source.coordinates.metricScale?.status === "relative"
    || /^RELATIVE-SCALE\b/i.test(source.prompt);

  if (args.metersPerUnit === undefined) {
    summarize(source, 1);
    if (relative) {
      console.log("\nThis environment has RELATIVE scale. Choose a factor and rerun with --meters-per-unit.");
      console.log("Example: if the walking person's box height above shows 0.115 units and the person is ~1.75 m,"
        + " use --meters-per-unit 15.2 (= 1.75 / 0.115).");
      process.exitCode = 2;
    }
    return;
  }
  if (!relative) {
    throw new Error("Environment is already calibrated; --meters-per-unit would double-scale it. Omit the flag.");
  }

  const factor = args.metersPerUnit;
  const scaled = scaleEnvironment(source, factor);
  scaled.id = args.scene;
  scaled.promptExampleId = args.scene;
  scaled.prompt = `Object-centric 4D environment reconstructed from video, scaled by ${factor} m per tracker unit`;
  scaled.coordinates = { ...scaled.coordinates, metricScale: { status: "calibrated", metersPerUnit: 1 } };

  fs.mkdirSync(paths.environmentDirectory, { recursive: true });
  fs.writeFileSync(
    path.join(paths.environmentDirectory, `${args.scene}.json`), `${JSON.stringify(scaled, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(paths.environmentDirectory, "manifest.json"), `${JSON.stringify({
    schemaVersion: "1.0",
    kind: "environmentManifest",
    environments: [{
      id: args.scene,
      promptExampleId: args.scene,
      title: `Video · ${args.scene}`,
      prompt: scaled.prompt,
      durationSeconds: scaled.clock.durationSeconds,
      url: `/environments/${args.scene}.json`,
      optimizedTrajectoryUrl: `/trajectories/optimized/${args.scene}-camera.json`,
      optimizedTrajectoryStale: true,
    }],
  }, null, 2)}\n`, "utf8");

  // Validate with the repository's own loader (document shape, bounds, motion data).
  const loaded = await new EnvironmentRepository(paths.environmentDirectory).load(args.scene);

  const registry: SceneRegistry = {
    schemaVersion: "1.0",
    kind: "videoScene",
    sceneId: args.scene,
    sourceEnvironmentId: source.id,
    sourceEnvironmentSha256: createHash("sha256").update(raw).digest("hex"),
    metersPerTrackerUnitApplied: factor,
  };
  fs.writeFileSync(paths.sceneRegistry, `${JSON.stringify(registry, null, 2)}\n`, "utf8");
  summarize(loaded, 1);
  console.log(`\nRegistered ${args.scene} (x${factor}) in ${path.relative(process.cwd(), paths.base)}; validated by EnvironmentRepository.`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});

// Keep the Quat import used for type documentation of rotation channels (unchanged by scaling).
export type _RotationChannelUnchanged = Channel<Quat>;
