import type { Quat, Vec3 } from "../../types/environment";
import {
  applyHardKeyframesToState,
  indexHardKeyframesByState,
  lockedKeyframeChannels,
} from "../shared/keyframes";
import { clamp, conjugateQuat, multiplyQuat, normalizeQuat } from "../shared/math";
import { fovDegreesToLogFocal, logFocalToFovDegrees } from "../shared/lens";
import type { CameraStateSample, UserCameraKeyframe } from "../types";
import { createSobolevFilter } from "./sobolev-filter";

type StateComponent = 0 | 1 | 2 | 3 | 4 | 5 | 6;

interface VariableReference {
  stateIndex: number;
  component: StateComponent;
}

interface CodecOptions {
  projectMotion?: (states: CameraStateSample[]) => void;
  minimumCameraY?: number;
  sceneScale?: number;
  cutTimes?: readonly number[];
  /** Physical smoothing duration, independent of sample density. */
  timeSmoothingSeconds?: number;
}

export function finiteCameraStates(states: readonly CameraStateSample[]): boolean {
  return states.every((state) => Number.isFinite(state.time)
    && state.position.every(Number.isFinite)
    && state.rotation.every(Number.isFinite)
    && Number.isFinite(Math.hypot(...state.rotation)) && Math.hypot(...state.rotation) > 1e-12
    && Number.isFinite(state.fovYDegrees) && state.fovYDegrees > 0 && state.fovYDegrees < 180);
}

/** Fallback physical length: knot bounding-box diagonal, never median step size. */
export function trajectoryReferenceLength(states: readonly CameraStateSample[]): number {
  const extents = [0, 1, 2].map((component) => {
    let minimum = Infinity;
    let maximum = -Infinity;
    for (const state of states) {
      minimum = Math.min(minimum, state.position[component]!);
      maximum = Math.max(maximum, state.position[component]!);
    }
    return maximum - minimum;
  });
  const diagonal = Math.hypot(...extents);
  return Number.isFinite(diagonal) && diagonal > 1e-6 ? diagonal : 1;
}

/** Rotation-vector logarithm, using the same deterministic branch for q and -q. */
function rotationVector(value: Quat): Vec3 {
  let quaternion = normalizeQuat(value);
  const firstNonzero = [quaternion[3], quaternion[0], quaternion[1], quaternion[2]]
    .find((component) => Math.abs(component) > 1e-15) ?? 1;
  if (firstNonzero < 0) quaternion = quaternion.map((component) => -component) as Quat;
  const sine = Math.hypot(quaternion[0], quaternion[1], quaternion[2]);
  const scale = sine < 1e-12 ? 2 : 2 * Math.atan2(sine, quaternion[3]) / sine;
  return [quaternion[0] * scale, quaternion[1] * scale, quaternion[2] * scale];
}

function rotationExponential(vector: Vec3): Quat {
  const angle = Math.hypot(...vector);
  const scale = angle < 1e-8 ? 0.5 - angle * angle / 48 : Math.sin(angle / 2) / angle;
  return [vector[0] * scale, vector[1] * scale, vector[2] * scale, Math.cos(angle / 2)];
}

/** Position / reference length, world rotation tangent (3 DOF), and log focal length. */
export class StateCodec {
  public readonly references: VariableReference[] = [];
  public readonly sceneScale: number;
  private readonly hardByState: Map<number, UserCameraKeyframe[]>;
  private rotationBases: Quat[];
  private readonly filters: Array<{
    dimensions: number[];
    apply: (values: Float64Array) => Float64Array;
  }> = [];

  public constructor(
    private readonly template: readonly CameraStateSample[],
    keyframes: readonly UserCameraKeyframe[],
    private readonly options: CodecOptions = {},
  ) {
    if (template.length === 0 || !finiteCameraStates(template)) {
      throw new Error("Numerical solver requires finite initial camera states");
    }
    this.sceneScale = options.sceneScale ?? trajectoryReferenceLength(template);
    if (!Number.isFinite(this.sceneScale) || this.sceneScale <= 0) {
      throw new Error("Scene reference length must be positive and finite");
    }
    this.rotationBases = template.map((state) => normalizeQuat(state.rotation));
    this.hardByState = indexHardKeyframesByState(template, keyframes);
    template.forEach((_state, stateIndex) => {
      const locked = lockedKeyframeChannels(this.hardByState.get(stateIndex) ?? []);
      const components: StateComponent[] = [
        ...(!locked.has("position") ? [0, 1, 2] as const : []),
        ...(!locked.has("rotation") ? [3, 4, 5] as const : []),
        ...(!locked.has("fov") ? [6] as const : []),
      ];
      for (const component of components) this.references.push({ stateIndex, component });
    });
    for (const component of [0, 1, 2, 3, 4, 5, 6] as const) {
      const dimensions = this.references.flatMap((reference, dimension) =>
        reference.component === component ? [dimension] : []);
      if (dimensions.length === 0) continue;
      this.filters.push({
        dimensions,
        apply: createSobolevFilter(
          template.map((state) => state.time),
          dimensions.map((dimension) => this.references[dimension]!.stateIndex),
          options.cutTimes ?? [],
          options.timeSmoothingSeconds ?? 0.25,
        ),
      });
    }
  }

  /** Recenter the SO(3) chart after an accepted step; its coordinates are world vectors. */
  public rebase(states: readonly CameraStateSample[]): Float64Array {
    this.rotationBases = states.map((state) => normalizeQuat(state.rotation));
    return this.encode(states);
  }

  public encode(states: readonly CameraStateSample[]): Float64Array {
    const rotations = states.map((state, index) =>
      rotationVector(multiplyQuat(state.rotation, conjugateQuat(this.rotationBases[index]!))));
    return Float64Array.from(this.references, ({ stateIndex, component }) => {
      const state = states[stateIndex]!;
      if (component < 3) return state.position[component as 0 | 1 | 2] / this.sceneScale;
      if (component < 6) return rotations[stateIndex]![component - 3]!;
      return fovDegreesToLogFocal(state.fovYDegrees);
    });
  }

  public decode(vector: Float64Array): CameraStateSample[] {
    if (vector.length !== this.references.length || !vector.every(Number.isFinite)) {
      throw new Error("Invalid numerical solver coordinate vector");
    }
    const states = this.template.map((state) => ({
      time: state.time,
      position: [...state.position] as Vec3,
      rotation: normalizeQuat(state.rotation),
      fovYDegrees: state.fovYDegrees,
    }));
    const rotations = states.map((): Vec3 => [0, 0, 0]);
    const minLogFocal = fovDegreesToLogFocal(120);
    const maxLogFocal = fovDegreesToLogFocal(8);
    this.references.forEach(({ stateIndex, component }, dimension) => {
      const state = states[stateIndex]!;
      const value = vector[dimension]!;
      if (component < 3) {
        state.position[component as 0 | 1 | 2] = value * this.sceneScale;
        if (component === 1 && this.options.minimumCameraY !== undefined) {
          state.position[1] = Math.max(state.position[1], this.options.minimumCameraY);
        }
      } else if (component < 6) {
        rotations[stateIndex]![component - 3] = value;
      } else {
        state.fovYDegrees = logFocalToFovDegrees(clamp(value, minLogFocal, maxLogFocal));
      }
    });
    states.forEach((state, index) => {
      state.rotation = multiplyQuat(rotationExponential(rotations[index]!), this.rotationBases[index]!);
    });
    this.options.projectMotion?.(states);
    for (const [stateIndex, keyframes] of this.hardByState) {
      applyHardKeyframesToState(states[stateIndex]!, keyframes);
    }
    for (let index = 1; index < states.length; index += 1) {
      if ((this.hardByState.get(index) ?? []).some(
        (keyframe) => keyframe.rotation !== undefined || keyframe.lookAt !== undefined,
      )) continue;
      const previous = states[index - 1]!.rotation;
      const current = states[index]!.rotation;
      if (previous.reduce((dot, value, component) => dot + value * current[component]!, 0) < 0) {
        states[index]!.rotation = current.map((value) => -value) as Quat;
      }
    }
    return states;
  }

  public smoothDirection(direction: Float64Array): Float64Array {
    const result = new Float64Array(direction);
    for (const filter of this.filters) {
      const filtered = filter.apply(Float64Array.from(filter.dimensions, (dimension) => direction[dimension]!));
      filter.dimensions.forEach((dimension, index) => { result[dimension] = filtered[index]!; });
    }
    return result;
  }
}
