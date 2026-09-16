import { compileLossPlan } from "./compiler";
import { flattenTimeline } from "../timeline/flattener";
import {
  resolveOptimizerOptions,
  validateResolvedOptimizerOptions,
} from "./config/options";
import { validateOptimizerInput } from "./config/validation";
import { clampToGroundClearance } from "./initialization";
import { selectSceneAwareSeed } from "./initialization/search";
import { withKeyframeCuts } from "./shared/keyframes";
import { buildOptimizationTimes, buildOutputTimes } from "./shared/time";
import { solveNumerically } from "./solver/numerical-solver";
import { ObjectiveEvaluator } from "./solver/objective";
import { sceneReferenceScale } from "./scene/scene-scale";
import { buildCameraTrajectory } from "./trajectory";
import type {
  CameraOptimizerInput,
  CameraOptimizerResult,
  TimelineSolverCameraOptimizerInput,
} from "./types";

export * from "./compiler";
export * from "./types";
export { validateOptimizerInput } from "./config/validation";

/** Optimizes position, quaternion orientation, and FOV entirely in TypeScript. */
export function optimizeCameraTrajectory(input: CameraOptimizerInput): CameraOptimizerResult {
  const startedAt = Date.now();
  validateOptimizerInput(input);
  const options = resolveOptimizerOptions(input);
  validateResolvedOptimizerOptions(options);
  const effectiveInput = withKeyframeCuts({
    ...input,
    options: { ...input.options, ...options },
  });
  const plan = compileLossPlan(effectiveInput);
  const optimizationTimes = buildOptimizationTimes(
    effectiveInput.environment,
    effectiveInput.timeline,
    effectiveInput.userKeyframes ?? [],
    options.optimizationFps,
    plan.motionTransitions,
  );
  const minimumCameraY = effectiveInput.environment.world?.ground === undefined
    || effectiveInput.options?.globalLosses?.ground === false
    ? undefined
    : effectiveInput.environment.world.ground.y
      + options.cameraRadius
      + options.collisionMargin;
  const evaluator = new ObjectiveEvaluator(effectiveInput, plan, optimizationTimes, {
    aspectRatio: options.aspectRatio,
    cameraRadius: options.cameraRadius,
    collisionMargin: options.collisionMargin,
    nearPlane: options.nearPlane,
  });
  const initialStates = selectSceneAwareSeed(
    effectiveInput, plan, optimizationTimes, options.initialFovYDegrees, minimumCameraY, evaluator,
  );
  const solved = solveNumerically(
    initialStates,
    effectiveInput.userKeyframes ?? [],
    evaluator,
    {
      iterations: options.iterations,
      randomSeed: options.randomSeed,
      cutTimes: effectiveInput.timeline.cutTimes ?? [],
      minimumCameraY,
      sceneScale: sceneReferenceScale(effectiveInput.environment),
    },
  );
  solved.states.forEach((state) =>
    clampToGroundClearance(state, effectiveInput, minimumCameraY),
  );
  const finalEvaluation = evaluator.evaluate(solved.states, true);
  if (!Number.isFinite(finalEvaluation.total)) throw new Error("Optimizer produced a non-finite final objective");
  const mandatoryOutputTimes = [
    // Every polynomial boundary must survive export, even below optimization FPS.
    ...optimizationTimes,
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
    minimumCameraY,
  );
  const warnings = [...plan.warnings, ...evaluator.warnings];
  const outputStates = trajectory.samples.map((sample) => ({
    time: sample.t, position: sample.position, rotation: sample.rotation!,
    fovYDegrees: sample.fovYDegrees!,
    positionVelocity: sample.positionVelocity,
    positionAcceleration: sample.positionAcceleration,
  }));
  const outputEvaluator = new ObjectiveEvaluator(effectiveInput, plan, outputStates.map((state) => state.time), {
    aspectRatio: options.aspectRatio, cameraRadius: options.cameraRadius,
    collisionMargin: options.collisionMargin, nearPlane: options.nearPlane,
  });
  const maximumSafetyViolationMeters = Math.max(
    evaluator.safetyViolation(solved.states), outputEvaluator.safetyViolation(outputStates),
  );
  if (!Number.isFinite(maximumSafetyViolationMeters)) throw new Error("Optimizer produced non-finite output geometry");
  if (maximumSafetyViolationMeters > 1e-5) {
    warnings.push(`Camera clearance remains unsatisfied by up to ${maximumSafetyViolationMeters.toFixed(3)} m`);
  }
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
      maximumSafetyViolationMeters,
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
