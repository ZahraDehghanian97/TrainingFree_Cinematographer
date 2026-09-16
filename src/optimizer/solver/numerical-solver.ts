import { clamp } from "../shared/math";
import type { CameraStateSample, UserCameraKeyframe } from "../types";
import type { ObjectiveEvaluator } from "./objective";
import { finiteCameraStates, StateCodec } from "./state-codec";

export interface NumericalSolveResult {
  states: CameraStateSample[];
  initialLoss: number;
  finalLoss: number;
  iterations: number;
  /** No stationarity certificate is computed by this derivative-free solver. */
  converged: boolean;
  terminationReason: "objectivePlateau" | "stalled" | "maxIterations" | "initialState";
}

interface NumericalSolveOptions {
  iterations: number;
  randomSeed: number;
  cutTimes?: readonly number[];
  minimumCameraY?: number;
  /** Physical reference length in meters, independent of temporal grid spacing. */
  sceneScale?: number;
  timeSmoothingSeconds?: number;
}

function xorshift32(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x100000000;
  };
}

function copyVector(vector: Float64Array): Float64Array {
  return new Float64Array(vector);
}

/**
 * Deterministic simultaneous-perturbation Adam with monotone backtracking.
 * The SPSA gradient uses four objective evaluations regardless of dimension;
 * the bounded coordinate fallback below requires up to four per variable.
 * Rotation steps are retracted onto SO(3), then their local chart is recentered.
 */
export function solveNumerically(
  initialStates: readonly CameraStateSample[],
  userKeyframes: readonly UserCameraKeyframe[],
  evaluator: Pick<ObjectiveEvaluator, "evaluate" | "safetyViolation">,
  options: NumericalSolveOptions,
): NumericalSolveResult {
  const cutTimes = [
    ...(options.cutTimes ?? []),
    ...userKeyframes.filter((keyframe) => keyframe.cutBefore).map((keyframe) => keyframe.time),
  ];
  const codec = new StateCodec(initialStates, userKeyframes, { ...options, cutTimes });
  let vector = codec.encode(initialStates);
  let states = codec.decode(vector);
  const finiteLoss = (candidate: readonly CameraStateSample[]): number => {
    if (!finiteCameraStates(candidate)) return Infinity;
    const loss = evaluator.evaluate(candidate, false).total;
    return Number.isFinite(loss) ? loss : Infinity;
  };
  const initialLoss = finiteLoss(states);
  const initialSafetyViolation = evaluator.safetyViolation(states);
  if (!Number.isFinite(initialLoss) || !Number.isFinite(initialSafetyViolation)) {
    throw new Error("Numerical solver requires a finite initial objective and safety violation");
  }
  vector = codec.rebase(states);
  let safetyLimit = Math.max(1e-6, initialSafetyViolation);
  const respectsSafety = (candidate: readonly CameraStateSample[]): boolean => {
    const violation = evaluator.safetyViolation(candidate);
    return Number.isFinite(violation) && violation <= safetyLimit;
  };
  if (options.iterations <= 0 || codec.references.length === 0) {
    return {
      states,
      initialLoss,
      finalLoss: initialLoss,
      iterations: 0,
      converged: false,
      terminationReason: "initialState",
    };
  }

  const random = xorshift32(options.randomSeed);
  const firstMoment = new Float64Array(vector.length);
  const secondMoment = new Float64Array(vector.length);
  let currentLoss = initialLoss;
  let bestLoss = initialLoss;
  let bestStates = states;
  let learningRate = 0.04;
  let rejectedIterations = 0;
  let smallImprovementIterations = 0;
  let completedIterations = 0;
  let momentUpdates = 0;
  let terminationReason: NumericalSolveResult["terminationReason"] = "maxIterations";
  const perturbationsPerIteration = 2;

  for (let iteration = 1; iteration <= options.iterations; iteration += 1) {
    completedIterations = iteration;
    const perturbationSize = 0.025 / Math.pow(iteration, 0.101);
    const gradient = new Float64Array(vector.length);
    let validPerturbations = 0;
    for (let sample = 0; sample < perturbationsPerIteration; sample += 1) {
      const delta = new Float64Array(vector.length);
      const plus = copyVector(vector);
      const minus = copyVector(vector);
      for (let dimension = 0; dimension < vector.length; dimension += 1) {
        delta[dimension] = random() < 0.5 ? -1 : 1;
        plus[dimension] += perturbationSize * delta[dimension]!;
        minus[dimension] -= perturbationSize * delta[dimension]!;
      }
      const plusLoss = finiteLoss(codec.decode(plus));
      const minusLoss = finiteLoss(codec.decode(minus));
      // Never feed NaN/Infinity into Adam's persistent moments. A nonfinite
      // two-sided probe is discarded rather than converted into a direction.
      if (!Number.isFinite(plusLoss) || !Number.isFinite(minusLoss)) continue;
      const scale = (plusLoss - minusLoss) / (2 * perturbationSize);
      if (!Number.isFinite(scale)) continue;
      validPerturbations += 1;
      for (let dimension = 0; dimension < gradient.length; dimension += 1) {
        gradient[dimension] += scale * delta[dimension]!;
      }
    }

    if (validPerturbations === 0 || !gradient.every(Number.isFinite)) {
      rejectedIterations += 1;
      smallImprovementIterations = 0;
      if (rejectedIterations >= 12) {
        terminationReason = "stalled";
        break;
      }
      continue;
    }
    for (let dimension = 0; dimension < gradient.length; dimension += 1) {
      gradient[dimension] /= validPerturbations;
    }
    const beta1 = 0.9;
    const beta2 = 0.999;
    momentUpdates += 1;
    let direction = new Float64Array(vector.length);
    let maximumDirection = 0;
    for (let dimension = 0; dimension < vector.length; dimension += 1) {
      const value = clamp(gradient[dimension]!, -1e4, 1e4);
      firstMoment[dimension] = beta1 * firstMoment[dimension]! + (1 - beta1) * value;
      secondMoment[dimension] = beta2 * secondMoment[dimension]! + (1 - beta2) * value * value;
      const correctedFirst = firstMoment[dimension]! / (1 - Math.pow(beta1, momentUpdates));
      const correctedSecond = secondMoment[dimension]! / (1 - Math.pow(beta2, momentUpdates));
      direction[dimension] = correctedFirst / (Math.sqrt(correctedSecond) + 1e-8);
      maximumDirection = Math.max(maximumDirection, Math.abs(direction[dimension]!));
    }
    if (!Number.isFinite(maximumDirection) || maximumDirection <= 1e-12) {
      rejectedIterations += 1;
      smallImprovementIterations = 0;
      if (rejectedIterations >= 12) {
        terminationReason = "stalled";
        break;
      }
      continue;
    }
    direction = new Float64Array(codec.smoothDirection(direction));
    maximumDirection = 0;
    for (const value of direction) maximumDirection = Math.max(maximumDirection, Math.abs(value));
    const directionScale = maximumDirection > 1 ? 1 / maximumDirection : 1;

    let accepted = false;
    let step = learningRate;
    for (let backtrack = 0; backtrack < 8; backtrack += 1) {
      const candidate = copyVector(vector);
      for (let dimension = 0; dimension < candidate.length; dimension += 1) {
        candidate[dimension] -= step * directionScale * direction[dimension]!;
      }
      const candidateStates = codec.decode(candidate);
      const candidateLoss = finiteLoss(candidateStates);
      if (Number.isFinite(candidateLoss) && candidateLoss < currentLoss - Math.max(1e-9, currentLoss * 1e-9)
        && respectsSafety(candidateStates)) {
        states = candidateStates;
        vector = codec.rebase(states);
        safetyLimit = Math.max(1e-6, evaluator.safetyViolation(candidateStates));
        const relativeImprovement = (currentLoss - candidateLoss) / Math.max(1, Math.abs(currentLoss));
        currentLoss = candidateLoss;
        accepted = true;
        learningRate = Math.min(0.08, step * 1.08);
        if (candidateLoss < bestLoss) {
          bestLoss = candidateLoss;
          bestStates = candidateStates;
        }
        rejectedIterations = 0;
        smallImprovementIterations = relativeImprovement < 1e-7
          ? smallImprovementIterations + 1
          : 0;
        break;
      }
      step *= 0.5;
    }
    if (!accepted) {
      learningRate = Math.max(1e-4, learningRate * 0.5);
      rejectedIterations += 1;
      smallImprovementIterations = 0;
    }
    if (smallImprovementIterations >= 12) {
      terminationReason = "objectivePlateau";
      break;
    }
    if (rejectedIterations >= 18) {
      terminationReason = "stalled";
      break;
    }
  }

  // SPSA can be too noisy when a long trajectory has many unrelated active
  // channels. If it could not find any descent direction, perform a bounded
  // deterministic coordinate sweep. This path is intentionally rare and
  // keeps the same monotone/best-state guarantee.
  if (bestLoss >= initialLoss - Math.max(1e-9, Math.abs(initialLoss) * 1e-10)) {
    let fallbackVector = codec.rebase(bestStates);
    let fallbackLoss = bestLoss;
    for (const coordinateStep of [0.025, 0.008]) {
      let acceptedInSweep = 0;
      for (let dimension = 0; dimension < fallbackVector.length; dimension += 1) {
        let dimensionBest = fallbackLoss;
        let dimensionStates: CameraStateSample[] | undefined;
        let dimensionSafety = safetyLimit;
        for (const sign of [-1, 1]) {
          const candidate = copyVector(fallbackVector);
          candidate[dimension] += sign * coordinateStep;
          const candidateStates = codec.decode(candidate);
          const candidateLoss = finiteLoss(candidateStates);
          if (
            Number.isFinite(candidateLoss)
            && candidateLoss < dimensionBest - Math.max(1e-9, Math.abs(dimensionBest) * 1e-10)
            && respectsSafety(candidateStates)
          ) {
            dimensionBest = candidateLoss;
            dimensionStates = candidateStates;
            dimensionSafety = Math.max(1e-6, evaluator.safetyViolation(candidateStates));
          }
        }
        if (dimensionStates) {
          fallbackVector = codec.rebase(dimensionStates);
          bestStates = dimensionStates;
          safetyLimit = dimensionSafety;
          fallbackLoss = dimensionBest;
          acceptedInSweep += 1;
        }
      }
      if (acceptedInSweep === 0) continue;
      bestLoss = fallbackLoss;
    }
  }

  states = bestStates;
  return {
    states,
    initialLoss,
    finalLoss: bestLoss,
    iterations: completedIterations,
    converged: false,
    terminationReason,
  };
}
