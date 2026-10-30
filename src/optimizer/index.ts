import { compileLossPlan } from "./compiler";
import { flattenTimeline } from "../timeline/flattener";
import {
  resolveOptimizerOptions,
  validateResolvedOptimizerOptions,
} from "./config/options";
import { validateOptimizerInput } from "./config/validation";
import { selectSceneAwareSeed } from "./initialization/search";
import { withKeyframeCuts } from "./shared/keyframes";
import { buildOptimizationTimes, buildOutputTimes } from "./shared/time";
import { solveNumerically } from "./solver/numerical-solver";
import { ObjectiveEvaluator } from "./solver/objective";
import { sceneReferenceScale } from "./scene/scene-scale";
import { createMotionManifold } from "./solver/motion-manifold";
import { applyHandheldMotion } from "./trajectory/handheld";
import { buildCameraTrajectory } from "./trajectory";
import type {
  CameraOptimizerInput,
  CameraOptimizerResult,
  TimelineSolverCameraOptimizerInput,
} from "./types";

export * from "./compiler";
export * from "./types";
export { validateOptimizerInput } from "./config/validation";

function improvementPercent(before: number | null, after: number): number | null {
  if (before === null || !Number.isFinite(before) || Math.abs(before) < 1e-12) return null;
  return (before - after) / Math.abs(before) * 100;
}

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
  const projectMotion = createMotionManifold(effectiveInput, plan, optimizationTimes);
  const selectedSeed = selectSceneAwareSeed(
    effectiveInput, plan, optimizationTimes, options.initialFovYDegrees, minimumCameraY, evaluator,
    projectMotion,
  );
  const solved = solveNumerically(
    selectedSeed.states,
    effectiveInput.userKeyframes ?? [],
    evaluator,
    {
      iterations: options.iterations,
      randomSeed: options.randomSeed,
      cutTimes: effectiveInput.timeline.cutTimes ?? [],
      minimumCameraY,
      sceneScale: sceneReferenceScale(effectiveInput.environment),
      projectMotion,
    },
  );
  // Export the accepted rig itself. A late pointwise ground clamp changes its
  // motion contracts, derivatives and objective after the search has ended.
  // Conflicting constraints remain visible in the swept safety diagnostics.
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
  let trajectory = buildCameraTrajectory(
    effectiveInput,
    plan,
    solved.states,
    outputTimes,
    options.nearPlane,
    options.farPlane,
    minimumCameraY,
  );
  const warnings = [...plan.warnings, ...evaluator.warnings];
  const toOutputStates = (document: typeof trajectory) => document.samples.map((sample) => ({
    time: sample.t, position: sample.position, rotation: sample.rotation!,
    fovYDegrees: sample.fovYDegrees!,
    positionVelocity: sample.positionVelocity,
    positionAcceleration: sample.positionAcceleration,
  }));
  const outputStates = toOutputStates(trajectory);
  const outputEvaluator = new ObjectiveEvaluator(effectiveInput, plan, outputStates.map((state) => state.time), {
    aspectRatio: options.aspectRatio, cameraRadius: options.cameraRadius,
    collisionMargin: options.collisionMargin, nearPlane: options.nearPlane,
  });
  const baseSafety = outputEvaluator.safetyViolation(outputStates);
  const baseTrajectory = trajectory;
  let handheldStrength = 1;
  let shaken = applyHandheldMotion(baseTrajectory, effectiveInput, handheldStrength);
  if (shaken !== baseTrajectory) {
    while (handheldStrength > 1 / 256
      && outputEvaluator.safetyViolation(toOutputStates(shaken)) > Math.max(1e-6, baseSafety)) {
      handheldStrength /= 2;
      shaken = applyHandheldMotion(baseTrajectory, effectiveInput, handheldStrength);
    }
    if (outputEvaluator.safetyViolation(toOutputStates(shaken)) <= Math.max(1e-6, baseSafety)) trajectory = shaken;
    else handheldStrength = 0;
    warnings.push(`Authored handheld rig applied at ${Math.round(handheldStrength * 100)}% strength; loss describes the optimized base rig`);
  }
  const maximumSafetyViolationMeters = Math.max(
    evaluator.safetyViolation(solved.states), outputEvaluator.safetyViolation(toOutputStates(trajectory)),
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
      baselineLoss: selectedSeed.baselineLoss,
      initialLoss: solved.initialLoss,
      finalLoss: finalEvaluation.total,
      seedCandidateCount: selectedSeed.evaluatedCandidateCount,
      seedImprovementPercent: improvementPercent(selectedSeed.baselineLoss, solved.initialLoss),
      refinementImprovementPercent: improvementPercent(solved.initialLoss, finalEvaluation.total),
      totalImprovementPercent: improvementPercent(selectedSeed.baselineLoss, finalEvaluation.total),
      objectiveEvaluations: solved.objectiveEvaluations,
      acceptedSteps: solved.acceptedSteps,
      searchSweeps: solved.searchSweeps,
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
