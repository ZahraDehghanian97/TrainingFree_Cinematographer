import { DEFAULT_OPTIONS } from "./defaults";
import type { CameraOptimizerInput, OptimizerOptions } from "../types";

export type ResolvedOptimizerOptions = Required<
  Omit<OptimizerOptions, "weights" | "globalLosses">
>;

/** The trajectory has one lens aspect ratio; explicit runtime settings take priority. */
function resolveAspectRatio(input: CameraOptimizerInput): number {
  const ratios = input.timeline.timeline.flatMap((segment) =>
    segment.lossFunctions.flatMap((loss) => {
      const intrinsics = loss.parameters.targetIntrinsics as Record<string, unknown> | undefined;
      const value = intrinsics?.aspectRatio;
      if (value === undefined) return [];
      if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        throw new Error("DSL intrinsics.aspectRatio must be positive and finite");
      }
      return [value];
    }),
  );
  if (input.options?.aspectRatio !== undefined) return input.options.aspectRatio;
  if (ratios.some((ratio) => Math.abs(ratio - ratios[0]!) > 1e-9)) {
    throw new Error(
      "A trajectory requires one intrinsics.aspectRatio; conflicting DSL ratios need an explicit options.aspectRatio override",
    );
  }
  return ratios[0] ?? DEFAULT_OPTIONS.aspectRatio;
}

/** Resolves runtime optimizer settings against environment-aware defaults. */
export function resolveOptimizerOptions(
  input: CameraOptimizerInput,
): ResolvedOptimizerOptions {
  return {
    motionTransitionSeconds: input.options?.motionTransitionSeconds ?? DEFAULT_OPTIONS.motionTransitionSeconds,
    optimizationFps: input.options?.optimizationFps ?? DEFAULT_OPTIONS.optimizationFps,
    outputFps: input.options?.outputFps
      ?? input.environment.clock.fpsHint
      ?? DEFAULT_OPTIONS.outputFps,
    iterations: input.options?.iterations ?? DEFAULT_OPTIONS.iterations,
    randomSeed: input.options?.randomSeed ?? DEFAULT_OPTIONS.randomSeed,
    initialFovYDegrees: input.options?.initialFovYDegrees
      ?? DEFAULT_OPTIONS.initialFovYDegrees,
    aspectRatio: resolveAspectRatio(input),
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
