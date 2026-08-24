import type { Quat } from "../types/environment";
import { clamp, lookAtQuaternion, normalizeQuat } from "./math";
import { ObjectiveEvaluator } from "./objective";
import type {
  CameraStateSample,
  UserCameraKeyframe,
} from "./types";

type StateComponent = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;

interface VariableReference {
  stateIndex: number;
  component: StateComponent;
}

export interface NumericalSolveResult {
  states: CameraStateSample[];
  initialLoss: number;
  finalLoss: number;
  iterations: number;
  converged: boolean;
  terminationReason: "converged" | "stalled" | "maxIterations" | "initialState";
}

interface NumericalSolveOptions {
  iterations: number;
  randomSeed: number;
}

function nearestStateIndex(states: readonly CameraStateSample[], time: number): number {
  let bestIndex = 0;
  let bestDistance = Infinity;
  states.forEach((state, index) => {
    const distance = Math.abs(state.time - time);
    if (distance < bestDistance) {
      bestDistance = distance;
      bestIndex = index;
    }
  });
  if (bestDistance > 1e-7) throw new Error(`Hard keyframe time ${time} is missing from optimizer grid`);
  return bestIndex;
}

function hardKeyframesAt(
  states: readonly CameraStateSample[],
  keyframes: readonly UserCameraKeyframe[],
): Map<number, UserCameraKeyframe[]> {
  const result = new Map<number, UserCameraKeyframe[]>();
  for (const keyframe of keyframes) {
    if ((keyframe.mode ?? "hard") !== "hard") continue;
    const index = nearestStateIndex(states, keyframe.time);
    const existing = result.get(index) ?? [];
    existing.push(keyframe);
    result.set(index, existing);
  }
  return result;
}

function lockedChannels(keyframes: readonly UserCameraKeyframe[]): Set<"position" | "rotation" | "fov"> {
  const result = new Set<"position" | "rotation" | "fov">();
  for (const keyframe of keyframes) {
    if (keyframe.position) result.add("position");
    if (keyframe.rotation || keyframe.lookAt) result.add("rotation");
    if (keyframe.fovYDegrees !== undefined) result.add("fov");
  }
  return result;
}

function applyHardKeyframes(
  states: CameraStateSample[],
  hardByState: ReadonlyMap<number, readonly UserCameraKeyframe[]>,
): void {
  for (const [stateIndex, keyframes] of hardByState) {
    const state = states[stateIndex]!;
    for (const keyframe of keyframes) {
      if (keyframe.position) state.position = [...keyframe.position];
      if (keyframe.fovYDegrees !== undefined) state.fovYDegrees = keyframe.fovYDegrees;
    }
    for (const keyframe of keyframes) {
      if (keyframe.rotation) state.rotation = normalizeQuat(keyframe.rotation);
      if (keyframe.lookAt) {
        state.rotation = lookAtQuaternion(
          state.position,
          keyframe.lookAt,
          keyframe.up ?? [0, 1, 0],
        );
      }
    }
  }
}

function estimateSceneScale(states: readonly CameraStateSample[]): number {
  const stepDistances = states.slice(1).map((state, index) => Math.hypot(
    state.position[0] - states[index]!.position[0],
    state.position[1] - states[index]!.position[1],
    state.position[2] - states[index]!.position[2],
  )).filter((value) => value > 1e-6).sort((a, b) => a - b);
  if (stepDistances.length === 0) return 5;
  return clamp(stepDistances[Math.floor(stepDistances.length / 2)]! * 8, 0.5, 50);
}

class StateCodec {
  public readonly references: VariableReference[] = [];
  private readonly sceneScale: number;
  private readonly hardByState: Map<number, UserCameraKeyframe[]>;

  public constructor(
    private readonly template: readonly CameraStateSample[],
    keyframes: readonly UserCameraKeyframe[],
  ) {
    this.sceneScale = estimateSceneScale(template);
    this.hardByState = hardKeyframesAt(template, keyframes);
    template.forEach((_state, stateIndex) => {
      const locked = lockedChannels(this.hardByState.get(stateIndex) ?? []);
      if (!locked.has("position")) {
        this.references.push(
          { stateIndex, component: 0 },
          { stateIndex, component: 1 },
          { stateIndex, component: 2 },
        );
      }
      if (!locked.has("rotation")) {
        this.references.push(
          { stateIndex, component: 3 },
          { stateIndex, component: 4 },
          { stateIndex, component: 5 },
          { stateIndex, component: 6 },
        );
      }
      if (!locked.has("fov")) this.references.push({ stateIndex, component: 7 });
    });
  }

  private encodeValue(state: CameraStateSample, component: StateComponent): number {
    switch (component) {
      case 0: return state.position[0] / this.sceneScale;
      case 1: return state.position[1] / this.sceneScale;
      case 2: return state.position[2] / this.sceneScale;
      case 3: return state.rotation[0];
      case 4: return state.rotation[1];
      case 5: return state.rotation[2];
      case 6: return state.rotation[3];
      case 7: return state.fovYDegrees / 45;
    }
  }

  private decodeValue(state: CameraStateSample, component: StateComponent, value: number): void {
    switch (component) {
      case 0: state.position[0] = value * this.sceneScale; break;
      case 1: state.position[1] = value * this.sceneScale; break;
      case 2: state.position[2] = value * this.sceneScale; break;
      case 3: state.rotation[0] = value; break;
      case 4: state.rotation[1] = value; break;
      case 5: state.rotation[2] = value; break;
      case 6: state.rotation[3] = value; break;
      case 7: state.fovYDegrees = clamp(value * 45, 8, 120); break;
    }
  }

  public encode(states: readonly CameraStateSample[]): Float64Array {
    return Float64Array.from(this.references.map((reference) =>
      this.encodeValue(states[reference.stateIndex]!, reference.component),
    ));
  }

  public decode(vector: Float64Array): CameraStateSample[] {
    const states = this.template.map((state) => ({
      time: state.time,
      position: [...state.position] as [number, number, number],
      rotation: [...state.rotation] as Quat,
      fovYDegrees: state.fovYDegrees,
    }));
    this.references.forEach((reference, index) => {
      this.decodeValue(states[reference.stateIndex]!, reference.component, vector[index]!);
    });
    for (const state of states) state.rotation = normalizeQuat(state.rotation);
    applyHardKeyframes(states, this.hardByState);
    for (let index = 1; index < states.length; index += 1) {
      const hardOrientation = (this.hardByState.get(index) ?? []).some(
        (keyframe) => keyframe.rotation !== undefined || keyframe.lookAt !== undefined,
      );
      if (hardOrientation) continue;
      const previous = states[index - 1]!.rotation;
      const current = states[index]!.rotation;
      const dot = previous[0] * current[0] + previous[1] * current[1]
        + previous[2] * current[2] + previous[3] * current[3];
      if (dot < 0) states[index]!.rotation = [-current[0], -current[1], -current[2], -current[3]];
    }
    return states;
  }
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
 * It is dependency-free and keeps objective evaluation count independent of
 * the number of trajectory variables.
 */
export function solveNumerically(
  initialStates: readonly CameraStateSample[],
  userKeyframes: readonly UserCameraKeyframe[],
  evaluator: ObjectiveEvaluator,
  options: NumericalSolveOptions,
): NumericalSolveResult {
  const codec = new StateCodec(initialStates, userKeyframes);
  let vector = codec.encode(initialStates);
  let states = codec.decode(vector);
  const initialLoss = evaluator.evaluate(states, false).total;
  if (options.iterations <= 0 || codec.references.length === 0) {
    return {
      states,
      initialLoss,
      finalLoss: initialLoss,
      iterations: 0,
      converged: codec.references.length === 0,
      terminationReason: "initialState",
    };
  }

  const random = xorshift32(options.randomSeed);
  const firstMoment = new Float64Array(vector.length);
  const secondMoment = new Float64Array(vector.length);
  let currentLoss = initialLoss;
  let bestLoss = initialLoss;
  let bestVector = copyVector(vector);
  let learningRate = 0.04;
  let stallIterations = 0;
  let completedIterations = 0;
  const perturbationsPerIteration = 2;

  for (let iteration = 1; iteration <= options.iterations; iteration += 1) {
    completedIterations = iteration;
    const perturbationSize = 0.025 / Math.pow(iteration, 0.101);
    const gradient = new Float64Array(vector.length);
    for (let sample = 0; sample < perturbationsPerIteration; sample += 1) {
      const delta = new Float64Array(vector.length);
      const plus = copyVector(vector);
      const minus = copyVector(vector);
      for (let dimension = 0; dimension < vector.length; dimension += 1) {
        delta[dimension] = random() < 0.5 ? -1 : 1;
        plus[dimension] += perturbationSize * delta[dimension]!;
        minus[dimension] -= perturbationSize * delta[dimension]!;
      }
      const plusLoss = evaluator.evaluate(codec.decode(plus), false).total;
      const minusLoss = evaluator.evaluate(codec.decode(minus), false).total;
      const scale = (plusLoss - minusLoss) / (2 * perturbationSize * perturbationsPerIteration);
      for (let dimension = 0; dimension < gradient.length; dimension += 1) {
        gradient[dimension] += scale * delta[dimension]!;
      }
    }

    const beta1 = 0.9;
    const beta2 = 0.999;
    const direction = new Float64Array(vector.length);
    let maximumDirection = 0;
    for (let dimension = 0; dimension < vector.length; dimension += 1) {
      const value = clamp(gradient[dimension]!, -1e4, 1e4);
      firstMoment[dimension] = beta1 * firstMoment[dimension]! + (1 - beta1) * value;
      secondMoment[dimension] = beta2 * secondMoment[dimension]! + (1 - beta2) * value * value;
      const correctedFirst = firstMoment[dimension]! / (1 - Math.pow(beta1, iteration));
      const correctedSecond = secondMoment[dimension]! / (1 - Math.pow(beta2, iteration));
      direction[dimension] = correctedFirst / (Math.sqrt(correctedSecond) + 1e-8);
      maximumDirection = Math.max(maximumDirection, Math.abs(direction[dimension]!));
    }
    if (!Number.isFinite(maximumDirection) || maximumDirection <= 1e-12) {
      stallIterations += 1;
      if (stallIterations >= 12) break;
      continue;
    }
    const directionScale = maximumDirection > 1 ? 1 / maximumDirection : 1;

    let accepted = false;
    let step = learningRate;
    for (let backtrack = 0; backtrack < 8; backtrack += 1) {
      const candidate = copyVector(vector);
      for (let dimension = 0; dimension < candidate.length; dimension += 1) {
        candidate[dimension] -= step * directionScale * direction[dimension]!;
      }
      const candidateStates = codec.decode(candidate);
      const candidateLoss = evaluator.evaluate(candidateStates, false).total;
      if (Number.isFinite(candidateLoss) && candidateLoss < currentLoss - Math.max(1e-9, currentLoss * 1e-9)) {
        vector = candidate;
        states = candidateStates;
        const relativeImprovement = (currentLoss - candidateLoss) / Math.max(1, Math.abs(currentLoss));
        currentLoss = candidateLoss;
        accepted = true;
        learningRate = Math.min(0.08, step * 1.08);
        if (candidateLoss < bestLoss) {
          bestLoss = candidateLoss;
          bestVector = copyVector(candidate);
        }
        stallIterations = relativeImprovement < 1e-7 ? stallIterations + 1 : 0;
        break;
      }
      step *= 0.5;
    }
    if (!accepted) {
      learningRate = Math.max(1e-4, learningRate * 0.5);
      stallIterations += 1;
    }
    if (stallIterations >= 18) break;
  }

  // SPSA can be too noisy when a long trajectory has many unrelated active
  // channels. If it could not find any descent direction, perform a bounded
  // deterministic coordinate sweep. This path is intentionally rare and
  // keeps the same monotone/best-state guarantee.
  if (bestLoss >= initialLoss - Math.max(1e-9, Math.abs(initialLoss) * 1e-10)) {
    let fallbackVector = copyVector(bestVector);
    let fallbackLoss = bestLoss;
    for (const coordinateStep of [0.025, 0.008]) {
      let acceptedInSweep = 0;
      for (let dimension = 0; dimension < fallbackVector.length; dimension += 1) {
        let dimensionBest = fallbackLoss;
        let dimensionVector: Float64Array | undefined;
        for (const sign of [-1, 1]) {
          const candidate = copyVector(fallbackVector);
          candidate[dimension] += sign * coordinateStep;
          const candidateLoss = evaluator.evaluate(codec.decode(candidate), false).total;
          if (
            Number.isFinite(candidateLoss)
            && candidateLoss < dimensionBest - Math.max(1e-9, Math.abs(dimensionBest) * 1e-10)
          ) {
            dimensionBest = candidateLoss;
            dimensionVector = candidate;
          }
        }
        if (dimensionVector) {
          fallbackVector = dimensionVector;
          fallbackLoss = dimensionBest;
          acceptedInSweep += 1;
        }
      }
      if (acceptedInSweep === 0) continue;
      bestVector = copyVector(fallbackVector);
      bestLoss = fallbackLoss;
    }
  }

  states = codec.decode(bestVector);
  const converged = stallIterations >= 18 && bestLoss < initialLoss;
  return {
    states,
    initialLoss,
    finalLoss: bestLoss,
    iterations: completedIterations,
    converged,
    terminationReason: completedIterations >= options.iterations
      ? "maxIterations"
      : converged ? "converged" : "stalled",
  };
}
