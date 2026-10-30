/**
 * Run the camera optimizer on a registered video scene for one shot.
 *
 * Inputs  (video/<scene>/shots/<shot>/):
 *   draft-csl.json   ResolvedCameraDirectionDSL with `$SUBJECT` / `$SUBJECT_DESCRIPTION` placeholders
 *                    (pass --draft <file> once to copy one in; see examples/video/*.draft-csl.json)
 *   keyframes.json   optional UserCameraKeyframe pins, written by `npm run video:pin`
 * Outputs (same folder, same names as examples/cinematic-suite/<example>/):
 *   binding.json     which entity the placeholders were bound to
 *   csl.json         the resolved CSL that was solved
 *   timeline.json    solver output
 *   trajectory.json  CameraTrajectoryV1 (environment frame, metres), trimmed to [--start, totalDuration]
 *   diagnostics.json optimizer diagnostics
 *   metadata.json    provenance (scene factor, hashes, options)
 *
 * Usage
 *   npm run video:optimize -- --scene the-pianist --shot orbit-25 --list
 *   npm run video:optimize -- --scene the-pianist --shot orbit-25 --subject subject_1 \
 *     [--draft examples/video/subject-orbit-25deg.draft-csl.json] [--iterations N] [--output-fps 16] [--start S]
 */
import * as fs from "node:fs";
import * as path from "node:path";

import { createHash } from "node:crypto";
import { DEFAULT_OPTIONS } from "../src/optimizer/config/defaults";
import { optimizeCameraTrajectory } from "../src/optimizer/index";
import type { UserCameraKeyframe } from "../src/optimizer/types";
import { flattenTimeline } from "../src/timeline/flattener";
import { solveTimeline } from "../src/timeline/solver";
import type { ResolvedCameraDirectionDSL } from "../src/types/dsl";
import type { EnvironmentV1 } from "../src/types/environment";
import { assertCameraTrajectoryV1 } from "../web/src/trajectory-loader";
import { EnvironmentRepository } from "../src/pipeline/environment-repository";
import { type SceneRegistry, scenePaths, shotPaths } from "./video-paths";

const KNOWN = new Set([
  "--scene", "--shot", "--draft", "--subject", "--iterations",
  "--optimization-fps", "--output-fps", "--start", "--list",
]);

function parseArgs(argv: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const [name, inline] = argv[index]!.split("=", 2);
    if (!KNOWN.has(name!)) throw new Error(`Unknown option: ${argv[index]}`);
    values.set(name!, name === "--list" ? "1" : inline ?? argv[++index] ?? "");
  }
  return values;
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const scene = args.get("--scene");
  const shotName = args.get("--shot");
  if (!scene) throw new Error("--scene is required");
  const sceneDir = scenePaths(scene);
  // Same loader (and validation) the rest of the repo uses, pointed at this scene's own catalogue.
  const environment: EnvironmentV1 = await new EnvironmentRepository(sceneDir.environmentDirectory).load(scene);
  const registry = JSON.parse(fs.readFileSync(sceneDir.sceneRegistry, "utf8")) as SceneRegistry;

  if (args.has("--list")) {
    for (const entity of environment.entities) console.log(`${entity.id}\t${entity.label ?? ""}`);
    return;
  }
  if (!shotName) throw new Error("--shot <shot-id> is required (it becomes video/<scene>/shots/<shot-id>/)");
  const shot = shotPaths(scene, shotName);
  fs.mkdirSync(shot.directory, { recursive: true });
  if (args.has("--draft")) fs.copyFileSync(path.resolve(args.get("--draft")!), shot.draftCsl);
  if (!fs.existsSync(shot.draftCsl)) throw new Error(`Missing ${shot.draftCsl}. Pass --draft <file> once to copy one in.`);

  const subject = args.get("--subject");
  let text = fs.readFileSync(shot.draftCsl, "utf8");
  if (text.includes("$SUBJECT")) {
    if (!subject) throw new Error("The CSL uses $SUBJECT; pass --subject <entity id> (see --list).");
    const entity = environment.entities.find((candidate) => candidate.id === subject);
    if (!entity) throw new Error(`Unknown subject '${subject}'. Use --list to see entity ids.`);
    text = text.split("$SUBJECT_DESCRIPTION").join(entity.label ?? subject).split("$SUBJECT").join(subject);
    writeJson(shot.binding, { schemaVersion: "1.0", bindings: { subject: { id: subject, description: entity.label ?? subject } } });
  }
  const csl = JSON.parse(text) as ResolvedCameraDirectionDSL;
  writeJson(shot.csl, csl);

  let userKeyframes: UserCameraKeyframe[] = [];
  let keyframesText: string | undefined;
  if (fs.existsSync(shot.keyframes)) {
    keyframesText = fs.readFileSync(shot.keyframes, "utf8");
    const document = JSON.parse(keyframesText) as
      UserCameraKeyframe[] | { environmentId?: string; keyframes: UserCameraKeyframe[] };
    userKeyframes = Array.isArray(document) ? document : document.keyframes;
  }

  const timeline = flattenTimeline(solveTimeline(csl, environment));
  const outputFps = args.has("--output-fps") ? Number(args.get("--output-fps")) : 16;
  const iterations = args.has("--iterations") ? Number(args.get("--iterations")) : DEFAULT_OPTIONS.iterations;
  const result = optimizeCameraTrajectory({
    environment,
    timeline,
    userKeyframes,
    options: {
      iterations,
      outputFps,
      ...(args.has("--optimization-fps") ? { optimizationFps: Number(args.get("--optimization-fps")) } : {}),
    },
  });
  // The optimizer solves over the whole environment clock; keep only the CSL window
  // (a video clip is only as long as the shot we ask TTM to generate).
  const trajectory = result.trajectory;
  const start = args.has("--start") ? Number(args.get("--start")) : 0;
  const keep = trajectory.samples.filter((sample) => sample.t >= start - 1e-9 && sample.t <= csl.totalDuration + 1e-9);
  if (keep.length < trajectory.samples.length) {
    trajectory.samples = keep;
    trajectory.clock = { ...trajectory.clock, durationSeconds: csl.totalDuration };
  }
  assertCameraTrajectoryV1(trajectory);

  writeJson(shot.trajectory, trajectory);
  writeJson(shot.timeline, timeline);
  writeJson(shot.diagnostics, { diagnostics: result.diagnostics, compiledPlan: result.compiledPlan });
  writeJson(shot.metadata, {
    schemaVersion: "1.0",
    kind: "videoShotMetadata",
    sceneId: scene,
    shotId: shotName,
    environmentId: environment.id,
    subject: subject ?? null,
    metersPerTrackerUnitApplied: registry.metersPerTrackerUnitApplied,
    sourceEnvironmentSha256: registry.sourceEnvironmentSha256,
    draftCslSha256: sha256(fs.readFileSync(shot.draftCsl, "utf8")),
    keyframesSha256: keyframesText === undefined ? null : sha256(keyframesText),
    options: { iterations, outputFps, windowStartSeconds: start, windowEndSeconds: csl.totalDuration },
    referenceType: "optimizer-output",
    measuredGroundTruth: false,
  });
  const d = result.diagnostics;
  
  console.log(`${scene}/${shotName}: loss ${d.initialLoss.toFixed(3)} -> ${d.finalLoss.toFixed(3)}, `
    + `${trajectory.samples.length} samples -> ${path.relative(process.cwd(), shot.trajectory)}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});