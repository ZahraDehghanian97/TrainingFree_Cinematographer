import { DEFAULT_OPTIONS } from "./defaults";
import type { CameraOptimizerInput, OptimizerOptions } from "../types";

export type ResolvedOptimizerOptions = Required<
  Omit<OptimizerOptions, "weights" | "globalLosses">
>;

/** Resolves runtime optimizer settings against environment-aware defaults. */
export function resolveOptimizerOptions(
  input: CameraOptimizerInput,
): ResolvedOptimizerOptions {
  return {
    optimizationFps: input.options?.optimizationFps ?? DEFAULT_OPTIONS.optimizationFps,
    outputFps: input.options?.outputFps
      ?? input.environment.clock.fpsHint
      ?? DEFAULT_OPTIONS.outputFps,
    iterations: input.options?.iterations ?? DEFAULT_OPTIONS.iterations,
    randomSeed: input.options?.randomSeed ?? DEFAULT_OPTIONS.randomSeed,
    initialFovYDegrees: input.options?.initialFovYDegrees
      ?? DEFAULT_OPTIONS.initialFovYDegrees,
    aspectRatio: input.options?.aspectRatio ?? DEFAULT_OPTIONS.aspectRatio,
    cameraRadius: input.options?.cameraRadius ?? DEFAULT_OPTIONS.cameraRadius,
    collisionMargin: input.options?.collisionMargin ?? DEFAULT_OPTIONS.collisionMargin,
    nearPlane: input.options?.nearPlane ?? DEFAULT_OPTIONS.nearPlane,
    farPlane: input.options?.farPlane ?? DEFAULT_OPTIONS.farPlane,
  };
}

/** Validates constraints that depend on fully resolved option values. */
export function validateResolvedOptimizerOptions(
  options: ResolvedOptimizerOptions,
): void {
  if (options.iterations < 0 || !Number.isInteger(options.iterations)) {
    throw new Error("options.iterations must be a non-negative integer");
  }
  if (!(options.nearPlane > 0 && options.farPlane > options.nearPlane)) {
    throw new Error("Optimizer intrinsics must satisfy 0 < nearPlane < farPlane");
  }
}
