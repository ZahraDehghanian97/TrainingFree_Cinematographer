/**
 * Build a keyframes file that pins the optimizer's camera to the REAL camera of
 * the source video, so the generated shot starts exactly where the film's camera was.
 *
 * Why: TTM keeps the first frame of the video. If the optimizer's path starts anywhere
 * else (different place, different lens), frame 0 of the motion signal would not match
 * that first frame and the clip would jump.
 *
 * What it reads (scene.tracking.json, `cameraTrajectory.samples`):
 *   - position / rotation: already in the ENVIRONMENT frame (+Y up, -Z forward, quaternion xyzw);
 *     the camera trajectory is stored gravity-aligned, so no matrix conversion is needed
 *     (checked: cameraToWorld equals the quaternion's rotation matrix).
 *   - intrinsics: pinhole in "inference pixels"; vertical FOV = 2*atan((height/2)/fy).
 *
 * What it writes (UserCameraKeyframe[]): exactly ONE keyframe,
 *   - t = --start: hard position + rotation + fovY (the pose lock).
 * Nothing else is pinned. Keyframes are the optimizer's mechanism for connecting a shot to an
 * existing frame; the lens during the shot is a shot-design decision and belongs in the DSL
 * (see examples/video/subject-orbit-25deg.draft-csl.json: a nonSubjectAware `intrinsics.fov` constraint).
 *
 * Positions are multiplied by the factor stored by register-video-environment.ts
 * (shared/video/<id>.registry.json), so they match the metre-scaled environment.
 *
 * Usage (reads video/<scene>/source/scene.tracking.json and video/<scene>/scene.json,
 * writes video/<scene>/shots/<shot>/keyframes.json)
 *   npm run video:pin -- --scene the-pianist --shot orbit-25 --start 0
 *
 * The printed fovY is what you put into the DSL lens constraint (intrinsics.fov).
 */
import * as fs from "node:fs";
import * as path from "node:path";

import type { UserCameraKeyframe } from "../src/optimizer/types";
import { type SceneRegistry, scenePaths, shotPaths } from "./video-paths";

interface TrackingSample {
  t: number;
  position: [number, number, number];
  rotation: [number, number, number, number];
  intrinsics: { fx: number; fy: number; cx: number; cy: number; imageSize: [number, number] };
}

function parseArgs(argv: readonly string[]): Map<string, string> {
  const known = new Set(["--scene", "--shot", "--start"]);
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const [name, inline] = argv[index]!.split("=", 2);
    if (name === "--end" || name === "--fov-step") {
      throw new Error(`${name} was removed: only the first frame is pinned now; hold the lens in the DSL instead.`);
    }
    if (!known.has(name!)) throw new Error(`Unknown option: ${argv[index]}`);
    values.set(name!, inline ?? argv[++index] ?? "");
  }
  return values;
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const scene = args.get("--scene");
  const shotName = args.get("--shot");
  if (!scene || !shotName) throw new Error("--scene and --shot are required");
  const sceneDir = scenePaths(scene);
  const shot = shotPaths(scene, shotName);
  const start = Number(args.get("--start") ?? 0);

  const registry = JSON.parse(fs.readFileSync(sceneDir.sceneRegistry, "utf8")) as SceneRegistry;
  const factor = registry.metersPerTrackerUnitApplied;

  const tracking = JSON.parse(fs.readFileSync(sceneDir.sourceTracking, "utf8")) as
    { cameraTrajectory: { samples: TrackingSample[] } };
  const samples = tracking.cameraTrajectory.samples;
  const source = samples.reduce((best, sample) =>
    Math.abs(sample.t - start) < Math.abs(best.t - start) ? sample : best);
  const { fy, imageSize } = source.intrinsics;
  const fovYDegrees = (2 * Math.atan(imageSize[1] / 2 / fy) * 180) / Math.PI;

  const keyframes: UserCameraKeyframe[] = [{
    id: "source-camera-start",
    time: start,
    position: source.position.map((value) => value * factor) as [number, number, number],
    rotation: source.rotation,
    fovYDegrees,
  }];

  fs.mkdirSync(shot.directory, { recursive: true });
  fs.writeFileSync(shot.keyframes, `${JSON.stringify({ environmentId: scene, keyframes }, null, 2)}\n`, "utf8");
  console.log(`Pinned source camera at t=${source.t.toFixed(3)} s (requested ${start}): `
    + `position ${keyframes[0]!.position!.map((v) => v.toFixed(2)).join(", ")} m, fovY ${fovYDegrees.toFixed(2)} deg `
    + `-> ${path.relative(process.cwd(), shot.keyframes)}\n`
    + `Put this lens in the DSL: {"config":{"type":"nonSubjectAware","intrinsics":{"fov":${fovYDegrees.toFixed(2)}}},"allFrames":true}`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
