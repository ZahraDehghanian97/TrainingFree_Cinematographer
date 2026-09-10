import type { CameraOptimizerInput, CameraStateSample, CompiledLossPlan } from "../types";
import type { ObjectiveEvaluator } from "../solver/objective";
import { DEFAULT_OPTIONS } from "../config/defaults";
import { initializeCameraStates } from "./index";
import { seedMotionKey, type SeedChoices } from "./seed-defaults";
import { minimumAngularProgress, minimumTranslationProgress } from "../shared/movement-preferences";
import { samplePrimitiveSubject } from "../scene/primitive-context";

/**
 * Explore coherent whole-shot choices before optimizing individual samples.
 * A local solver cannot move an entire arc to the other side of a wall through
 * small independent steps. These choices change only the seed, never the plan.
 */
export function selectSceneAwareSeed(
  input: CameraOptimizerInput,
  plan: CompiledLossPlan,
  times: readonly number[],
  initialFov: number,
  minimumCameraY: number | undefined,
  evaluator: ObjectiveEvaluator,
): CameraStateSample[] {
  const minimumDistance = input.options?.minimumMovementDistance
    ?? DEFAULT_OPTIONS.minimumMovementDistance;
  const baseline = initializeCameraStates(input, plan, times, initialFov, minimumCameraY);
  const movements = new Map<string, number[]>();
  for (const primitive of plan.primitives) {
    const p = primitive.parameters;
    const key = seedMotionKey(primitive);
    if (primitive.type === "angularProgress" || primitive.type === "rollProgress") {
      if (typeof (p.fullTargetDelta ?? p.targetDelta) === "number") continue;
      const minimumAngle = minimumAngularProgress(input, primitive);
      const angles = [...new Set([minimumAngle * 1.1,
        ...(p.mode === "orbit" ? [Math.PI / 4, Math.PI / 2, Math.PI * 3 / 4, Math.PI]
          : [Math.PI / 12, Math.PI / 6, Math.PI / 4]),
      ])].filter((angle) => angle >= minimumAngle);
      movements.set(key, typeof p.sign === "number" ? angles : [...angles, ...angles.map((angle) => -angle)]);
    } else if (primitive.type === "totalProgressTarget" || primitive.type === "radiusSchedule") {
      if (typeof (p.fullTargetDistance ?? p.targetDistance ?? p.deltaRadius) === "number") continue;
      const startTime = typeof p.motionStartTime === "number" ? p.motionStartTime : primitive.startTime;
      const state = baseline.reduce((nearest, candidate) => Math.abs(candidate.time - startTime)
        < Math.abs(nearest.time - startTime) ? candidate : nearest);
      const target = samplePrimitiveSubject(input, primitive, startTime);
      const minimum = primitive.type === "totalProgressTarget"
        ? minimumTranslationProgress(input, primitive, state.position, target?.center) : minimumDistance;
      movements.set(key, [...new Set([minimum * 1.1, minimum * 1.5, minimum * 2,
        0.5, 1, 2, 4, 8, 16])].filter((distance) => distance >= minimum));
    } else if (primitive.type === "intrinsicsProgress") {
      if (typeof (p.fullFactor ?? p.factor) === "number") continue;
      movements.set(key, [1.1, 1.25, 1.5]);
    }
  }

  let bestChoices: SeedChoices = {};
  let bestStates: CameraStateSample[] = [];
  let bestLoss = Infinity;
  let bestSafety = Infinity;
  const consider = (choices: SeedChoices): void => {
    const states = initializeCameraStates(input, plan, times, initialFov, minimumCameraY, choices);
    const safety = evaluator.safetyViolation(states);
    const loss = evaluator.evaluate(states, false).total;
    if (!Number.isFinite(loss) || !Number.isFinite(safety)) return;
    const safe = safety <= 1e-6;
    const bestSafe = bestSafety <= 1e-6;
    // Once a feasible path exists, composition cannot buy a wall intersection.
    // While infeasible, retain semantic cost so search does not choose a wildly
    // different shot merely to reduce an unavoidable hard-keyframe collision.
    if ((safe && !bestSafe) || (safe === bestSafe
      && loss + 1e5 * safety < bestLoss + 1e5 * bestSafety - 1e-9)) {
      bestChoices = choices;
      bestStates = states;
      bestLoss = loss;
      bestSafety = safety;
    }
  };
  consider({});
  const compactAmounts = new Map([...movements].map(([key, values]) => [key, values[0]!]));
  // Search both ordinary and compact motion, since a large arbitrary sweep
  // can block every starting bearing in a confined room.
  for (const movementAmounts of [undefined, compactAmounts]) {
    if (movementAmounts && movementAmounts.size === 0) continue;
    for (const fovYDegrees of [initialFov, 35, 70]) {
      for (let direction = 0; direction < 12; direction += 1) {
        consider({ azimuth: direction * Math.PI / 6, fovYDegrees, movementAmounts });
      }
    }
  }
  // Coordinate refinement retains the best combination after every proposal.
  for (let pass = 0; pass < 2; pass += 1) {
    for (const [key, amounts] of movements) {
      for (const amount of amounts) {
        const movementAmounts = new Map(bestChoices.movementAmounts);
        movementAmounts.set(key, amount);
        consider({ ...bestChoices, movementAmounts });
      }
    }
    for (const distanceScale of [0.4, 0.65, 1, 1.5, 2.5]) {
      for (let direction = 0; direction < 12; direction += 1) {
        consider({ ...bestChoices, distanceScale, azimuth: direction * Math.PI / 6 });
      }
    }
    for (const elevation of [0, 0.1, 0.3, 0.6]) consider({ ...bestChoices, elevation });
    for (const fovYDegrees of [25, 35, initialFov, 70, 90]) consider({ ...bestChoices, fovYDegrees });
  }
  return bestStates;
}
