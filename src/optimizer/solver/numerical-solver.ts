import { clamp } from "../shared/math";
import type { CameraStateSample, UserCameraKeyframe } from "../types";
import type { ObjectiveEvaluator } from "./objective";
import { createSearchDirections, type SearchDirection } from "./search-directions";
import { finiteCameraStates, StateCodec } from "./state-codec";

export interface NumericalSolveResult {
  states: CameraStateSample[];
  initialLoss: number;
  finalLoss: number;
  /** Number of one-dimensional searches, including displacement searches. */
  iterations: number;
  objectiveEvaluations: number;
  acceptedSteps: number;
  searchSweeps: number;
  /** A derivative-free search does not provide a stationarity certificate. */
  converged: boolean;
  terminationReason: "objectivePlateau" | "stalled" | "maxIterations" | "initialState";
}

interface NumericalSolveOptions {
  projectMotion?: (states: CameraStateSample[]) => void;
  iterations: number;
  randomSeed: number;
  cutTimes?: readonly number[];
  minimumCameraY?: number;
  /** Physical reference length in meters, independent of temporal grid spacing. */
  sceneScale?: number;
  timeSmoothingSeconds?: number;
}

/**
 * Monotone derivative-free search in coherent temporal directions.
 * Random independent knot perturbations can create enormous artificial jerk.
 * Shot-wide modes and an invertibly smoothed coordinate basis avoid that noise.
 * Symmetric probes fit a safeguarded one-dimensional quadratic, adapting each
 * channel's step to its curvature. Only actual finite, safe descent is accepted.
 * A complete sweep, including fine directions, precedes any plateau decision.
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
  let objectiveEvaluations = 0;
  const finiteLoss = (candidate: readonly CameraStateSample[]): number => {
    objectiveEvaluations += 1;
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
  let currentLoss = initialLoss;
  let iterations = 0;
  let acceptedSteps = 0;
  let searchSweeps = 0;
  let terminationReason: NumericalSolveResult["terminationReason"] = "initialState";
  const result = (): NumericalSolveResult => ({
    states, initialLoss, finalLoss: currentLoss, iterations, objectiveEvaluations,
    acceptedSteps, searchSweeps, converged: false, terminationReason,
  });
  if (options.iterations <= 0 || codec.references.length === 0) return result();
  // This objective is a sum of nonnegative energies. Numerical zero already
  // meets its lower bound; calling it a stalled search would be misleading.
  if (initialLoss >= 0 && initialLoss <= 1e-12) {
    terminationReason = "objectivePlateau";
    return result();
  }

  const directions = createSearchDirections(codec, initialStates, cutTimes);
  const coarseDirections = directions.filter((direction) => direction.coarse);
  const minimumRadius = 1e-8;
  const maximumRadius = 0.25;
  let sweepDisplacement = new Float64Array(vector.length);

  const search = (direction: SearchDirection): void => {
    iterations += 1;
    const origin = vector;
    const originLoss = currentLoss;
    const sufficientDecrease = Math.max(1e-10, Math.abs(originLoss) * 1e-10);
    let bestLoss = originLoss;
    let bestStates: CameraStateSample[] | undefined;
    let bestSafety = safetyLimit;
    let bestStep = 0;
    const evaluated = new Map<number, number>();
    let unsafeDescentStep: number | undefined;
    const probe = (step: number): number => {
      const cached = evaluated.get(step);
      if (cached !== undefined) return cached;
      if (!Number.isFinite(step) || step === 0) return originLoss;
      const candidate = Float64Array.from(origin, (value, dimension) =>
        value + step * direction.values[dimension]!);
      const candidateStates = codec.decode(candidate);
      const loss = finiteLoss(candidateStates);
      evaluated.set(step, loss);
      if (loss < bestLoss - sufficientDecrease) {
        const safety = evaluator.safetyViolation(candidateStates);
        if (Number.isFinite(safety) && safety <= safetyLimit) {
          bestLoss = loss;
          bestStates = candidateStates;
          bestSafety = Math.max(1e-6, safety);
          bestStep = step;
        } else if (unsafeDescentStep === undefined || Math.abs(step) < Math.abs(unsafeDescentStep)) {
          unsafeDescentStep = step;
        }
      }
      return loss;
    };

    let radius = clamp(direction.radius, minimumRadius, maximumRadius);
    // A smaller-scale retry handles nonfinite probes and visibility/clipping
    // boundaries. Its scale is retained for subsequent sweeps.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const plus = probe(radius);
      const minus = probe(-radius);
      if (Number.isFinite(plus) && Number.isFinite(minus)) {
        const curvature = plus + minus - 2 * originLoss;
        const slope = plus - minus;
        if (curvature > Math.max(1e-14, Math.abs(originLoss) * 1e-14)) {
          const interpolated = clamp(-0.5 * radius * slope / curvature, -4 * radius, 4 * radius);
          if (Math.abs(interpolated) > 1e-12) probe(interpolated);
        }
        // A flat direction or a resolved quadratic minimum need not repeat
        // the same unproductive probes immediately. Retry at a smaller scale
        // on the next pass, after other channels may have changed the minimum.
        if (!bestStates && unsafeDescentStep === undefined
          && ((Math.abs(plus - originLoss) <= sufficientDecrease
              && Math.abs(minus - originLoss) <= sufficientDecrease)
            || (curvature > 0 && slope * slope / (8 * curvature) <= sufficientDecrease))) {
          radius *= 0.2;
          break;
        }
      }
      if (bestStates) break;
      radius *= 0.2;
    }

    if (bestStates && Math.abs(bestStep) >= radius * 0.9) {
      // Coherent motion can travel farther than its initial probe. Expansion
      // avoids inching along a broad, gently sloped valley.
      for (let expansion = 0; expansion < 2; expansion += 1) {
        const previousBest = bestLoss;
        probe(clamp(bestStep * 2, -maximumRadius, maximumRadius));
        if (bestLoss >= previousBest - sufficientDecrease) break;
      }
    } else if (!bestStates && unsafeDescentStep !== undefined) {
      let step = unsafeDescentStep;
      for (let backtrack = 0; backtrack < 6 && !bestStates; backtrack += 1) {
        step *= 0.25;
        probe(step);
      }
    }

    if (bestStates) {
      states = bestStates;
      currentLoss = bestLoss;
      safetyLimit = bestSafety;
      vector = codec.rebase(states);
      acceptedSteps += 1;
      for (let dimension = 0; dimension < sweepDisplacement.length; dimension += 1) {
        sweepDisplacement[dimension] += bestStep * direction.values[dimension]!;
      }
      direction.radius = clamp(Math.abs(bestStep) * 1.5, minimumRadius, maximumRadius);
    } else {
      direction.radius = Math.max(minimumRadius, radius);
    }
  };

  terminationReason = "maxIterations";
  let quietSweeps = 0;
  const searchDisplacement = (): void => {
    let displacementSize = 0;
    for (const value of sweepDisplacement) displacementSize = Math.max(displacementSize, Math.abs(value));
    if (displacementSize > 1e-10 && iterations < options.iterations) {
      // Accumulated world tangents only propose a direction: validate the
      // actual SO(3) retraction with the same objective and safety checks.
      search({
        values: sweepDisplacement.map((value) => value / displacementSize),
        radius: Math.min(maximumRadius, displacementSize),
      });
    }
    sweepDisplacement = new Float64Array(vector.length);
  };
  while (iterations < options.iterations) {
    searchSweeps += 1;
    const sweepLoss = currentLoss;
    const sweepAccepted = acceptedSteps;
    sweepDisplacement = new Float64Array(vector.length);
    let complete = true;
    let localSearches = 0;
    for (const direction of directions) {
      if (iterations >= options.iterations) { complete = false; break; }
      search(direction);
      if (!direction.coarse) localSearches += 1;
      if (localSearches >= 64) {
        searchDisplacement();
        // Long shots should revisit broad, coupled motion before exhausting
        // hundreds of fine coordinates. All fine coordinates are still covered
        // before the sweep can contribute to a plateau decision.
        for (const coarse of coarseDirections) {
          if (iterations >= options.iterations) break;
          coarse.radius = Math.max(coarse.radius, 1e-4);
          search(coarse);
        }
        localSearches = 0;
      }
    }
    if (!complete) break;
    searchDisplacement();
    const improvement = (sweepLoss - currentLoss) / Math.max(1, Math.abs(sweepLoss));
    quietSweeps = improvement < 1e-6 ? quietSweeps + 1 : 0;
    if (quietSweeps >= 3) {
      terminationReason = acceptedSteps === sweepAccepted ? "stalled" : "objectivePlateau";
      break;
    }
  }
  return result();
}
