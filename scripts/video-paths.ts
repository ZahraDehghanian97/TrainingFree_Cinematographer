/**
 * Single source of truth for where video-derived data lives. Keeping it out of
 * web/public/environments matters: scripts/audit-environments.ts asserts that
 * directory holds exactly stadium.json, factory.json and manifest.json, and
 * scripts/generate-two-environments.py deletes anything else in it.
 *
 *   video/<scene>/
 *     source/scene.environment.json   raw notebook output (relative scale), untouched
 *     source/scene.tracking.json      notebook sidecar (camera path, intrinsics, tracks)
 *     environment/manifest.json       per-scene allowlist read by EnvironmentRepository
 *     environment/<scene>.json        calibrated copy in metres (generated)
 *     scene.json                      registry: metres-per-unit, source hashes
 *     shots/<shot>/                   one folder per generated shot, same file names as
 *                                     examples/cinematic-suite/<example>/
 */
import * as path from "node:path";

export const VIDEO_ROOT = "video";

export function validateName(name: string | undefined, option: string): string {
  if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new Error(`${option} must be letters, digits, '.', '_' or '-' (it becomes a folder name)`);
  }
  return name;
}

export function scenePaths(scene: string, root: string = process.cwd()) {
  const base = path.resolve(root, VIDEO_ROOT, validateName(scene, "--scene"));
  return {
    base,
    sourceDirectory: path.join(base, "source"),
    sourceEnvironment: path.join(base, "source", "scene.environment.json"),
    sourceTracking: path.join(base, "source", "scene.tracking.json"),
    environmentDirectory: path.join(base, "environment"),
    sceneRegistry: path.join(base, "scene.json"),
    shotsDirectory: path.join(base, "shots"),
  };
}

export function shotPaths(scene: string, shot: string, root: string = process.cwd()) {
  const directory = path.join(scenePaths(scene, root).shotsDirectory, validateName(shot, "--shot"));
  return {
    directory,
    draftCsl: path.join(directory, "draft-csl.json"),
    binding: path.join(directory, "binding.json"),
    csl: path.join(directory, "csl.json"),
    keyframes: path.join(directory, "keyframes.json"),
    trajectory: path.join(directory, "trajectory.json"),
    timeline: path.join(directory, "timeline.json"),
    diagnostics: path.join(directory, "diagnostics.json"),
    metadata: path.join(directory, "metadata.json"),
  };
}

export interface SceneRegistry {
  schemaVersion: "1.0";
  kind: "videoScene";
  sceneId: string;
  sourceEnvironmentId: string;
  sourceEnvironmentSha256: string;
  /** Environment lengths (metres) = notebook/tracker lengths * this factor. */
  metersPerTrackerUnitApplied: number;
}
