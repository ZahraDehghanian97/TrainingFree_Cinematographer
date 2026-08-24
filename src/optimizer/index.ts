import { compileLossPlan } from "./compiler";
import { flattenTimeline } from "../timeline/flattener";
import { DEFAULT_OPTIONS } from "./defaults";
import { initializeCameraStates } from "./initializer";
import { solveNumerically } from "./numerical-solver";
import { ObjectiveEvaluator } from "./objective";
import { buildOptimizationTimes, buildOutputTimes } from "./time";
import { buildCameraTrajectory } from "./trajectory";
import type {
  CameraOptimizerInput,
  CameraOptimizerResult,
  OptimizerOptions,
  TimelineSolverCameraOptimizerInput,
} from "./types";
import { validateOptimizerInput } from "./validation";

export * from "./compiler";
export * from "./types";
export * from "./validation";

function resolveOptions(input: CameraOptimizerInput): Required<Omit<OptimizerOptions, "weights" | "globalLosses">> {
  return {
    optimizationFps: input.options?.optimizationFps ?? DEFAULT_OPTIONS.optimizationFps,
    outputFps: input.options?.outputFps
      ?? input.environment.clock.fpsHint
      ?? DEFAULT_OPTIONS.outputFps,
    iterations: input.options?.iterations ?? DEFAULT_OPTIONS.iterations,
    randomSeed: input.options?.randomSeed ?? DEFAULT_OPTIONS.randomSeed,
    initialFovYDegrees: input.options?.initialFovYDegrees ?? DEFAULT_OPTIONS.initialFovYDegrees,
    aspectRatio: input.options?.aspectRatio ?? DEFAULT_OPTIONS.aspectRatio,
    cameraRadius: input.options?.cameraRadius ?? DEFAULT_OPTIONS.cameraRadius,
    collisionMargin: input.options?.collisionMargin ?? DEFAULT_OPTIONS.collisionMargin,
    nearPlane: input.options?.nearPlane ?? DEFAULT_OPTIONS.nearPlane,
    farPlane: input.options?.farPlane ?? DEFAULT_OPTIONS.farPlane,
  };
}

/** Optimizes position, quaternion orientation, and FOV entirely in TypeScript. */
export function optimizeCameraTrajectory(input: CameraOptimizerInput): CameraOptimizerResult {
  const startedAt = Date.now();
  validateOptimizerInput(input);
  const options = resolveOptions(input);
  if (options.iterations < 0 || !Number.isInteger(options.iterations)) {
    throw new Error("options.iterations must be a non-negative integer");
  }
  if (!(options.nearPlane > 0 && options.farPlane > options.nearPlane)) {
    throw new Error("Optimizer intrinsics must satisfy 0 < nearPlane < farPlane");
  }

  const keyframeCuts = (input.userKeyframes ?? [])
    .filter((keyframe) => keyframe.cutBefore)
    .map((keyframe) => keyframe.time);
  const effectiveInput: CameraOptimizerInput = keyframeCuts.length === 0
    ? input
    : {
        ...input,
        timeline: {
          ...input.timeline,
          cutTimes: [...new Set([...(input.timeline.cutTimes ?? []), ...keyframeCuts])].sort((a, b) => a - b),
        },
      };
  const plan = compileLossPlan(effectiveInput);
  const optimizationTimes = buildOptimizationTimes(
    effectiveInput.environment,
    effectiveInput.timeline,
    effectiveInput.userKeyframes ?? [],
    options.optimizationFps,
  );
  const initialStates = initializeCameraStates(
    effectiveInput,
    plan,
    optimizationTimes,
    options.initialFovYDegrees,
  );
  const evaluator = new ObjectiveEvaluator(effectiveInput, plan, optimizationTimes, {
    aspectRatio: options.aspectRatio,
    cameraRadius: options.cameraRadius,
    collisionMargin: options.collisionMargin,
    nearPlane: options.nearPlane,
  });
  const solved = solveNumerically(
    initialStates,
    effectiveInput.userKeyframes ?? [],
    evaluator,
    { iterations: options.iterations, randomSeed: options.randomSeed },
  );
  const finalEvaluation = evaluator.evaluate(solved.states, true);
  const mandatoryOutputTimes = [
    ...optimizationTimes.filter((time) => (effectiveInput.timeline.cutTimes ?? []).some(
      (cutTime) => Math.abs(cutTime - time) <= 1e-8,
    )),
    ...(effectiveInput.userKeyframes ?? []).map((keyframe) => keyframe.time),
  ];
  const outputTimes = buildOutputTimes(
    effectiveInput.environment.clock.durationSeconds,
    options.outputFps,
    mandatoryOutputTimes,
  );
  const trajectory = buildCameraTrajectory(
    effectiveInput,
    plan,
    solved.states,
    outputTimes,
    options.nearPlane,
    options.farPlane,
  );
  const warnings = [...plan.warnings, ...evaluator.warnings];
  const collisionLoss = finalEvaluation.breakdown
    .filter((entry) => entry.type === "collisionClearance")
    .reduce((sum, entry) => sum + entry.weightedLoss, 0);
  if (
    collisionLoss > 1e-8
    && (effectiveInput.userKeyframes ?? []).some((keyframe) =>
      (keyframe.mode ?? "hard") === "hard" && keyframe.position !== undefined,
    )
  ) {
    warnings.push("Safety loss remains non-zero; hard user keyframes were preserved exactly");
  }

  return {
    trajectory,
    compiledPlan: plan,
    diagnostics: {
      initialLoss: solved.initialLoss,
      finalLoss: finalEvaluation.total,
      iterations: solved.iterations,
      converged: solved.converged,
      terminationReason: solved.terminationReason,
      optimizationSampleCount: solved.states.length,
      outputSampleCount: trajectory.samples.length,
      primitiveCount: plan.primitives.length,
      conflicts: plan.conflicts,
      lossBreakdown: finalEvaluation.breakdown,
      elapsedMilliseconds: Date.now() - startedAt,
      warnings: [...new Set(warnings)],
    },
  };
}

/** Accepts the direct `solveTimeline()` result and flattens it internally. */
export function optimizeTimelineSolverOutput(
  input: TimelineSolverCameraOptimizerInput,
): CameraOptimizerResult {
  return optimizeCameraTrajectory({
    ...input,
    timeline: flattenTimeline(input.timeline),
  });
}
