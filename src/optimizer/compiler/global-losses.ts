import { DEFAULT_GLOBAL_LOSSES } from "../config/defaults";
import { subjectIdsFromParameters } from "../shared/parameter-values";
import type { CameraOptimizerInput, OptimizerWeights, PrimitiveLoss } from "../types";
import type { PrimitiveDescriptor } from "./types";

export interface WeightedPrimitiveDescriptor {
  descriptor: PrimitiveDescriptor;
  weight: number;
}

/** Builds the enabled whole-trajectory regularizers in their stable ID order. */
export function buildGlobalLossDescriptors(
  input: CameraOptimizerInput,
  weights: OptimizerWeights,
  primitives: readonly PrimitiveLoss[],
): WeightedPrimitiveDescriptor[] {
  const global = { ...DEFAULT_GLOBAL_LOSSES, ...input.options?.globalLosses };
  const cutTimes = input.timeline.cutTimes ?? [];
  const candidates: Array<[boolean, PrimitiveDescriptor, number]> = [
    [
      global.smoothness,
      {
        type: "accelerationSmoothness",
        channel: "regularity",
        role: "regularizer",
        parameters: { cutTimes },
      },
      weights.globalSmoothness,
    ],
    [
      global.angularSmoothness,
      {
        type: "angularAccelerationSmoothness",
        channel: "regularity",
        role: "regularizer",
        parameters: { cutTimes },
      },
      weights.globalAngularSmoothness,
    ],
    [
      global.jerk,
      {
        type: "jerkSmoothness",
        channel: "regularity",
        role: "regularizer",
        parameters: { cutTimes },
      },
      weights.globalJerk,
    ],
    [
      global.collision,
      { type: "collisionClearance", channel: "safety", role: "regularizer" },
      weights.globalCollision,
    ],
    [
      global.ground && input.environment.world?.ground !== undefined,
      { type: "groundClearance", channel: "safety", role: "regularizer" },
      weights.globalGround,
    ],
    [
      global.minPath,
      { type: "pathLength", channel: "regularity", role: "regularizer" },
      weights.globalMinPath,
    ],
  ];

  const allSubjectIds = [...new Set(primitives.flatMap(
    (primitive) => subjectIdsFromParameters(primitive.parameters),
  ))];
  if (global.occlusion && allSubjectIds.length > 0) {
    candidates.push([
      true,
      {
        type: "occlusion",
        channel: "safety",
        role: "regularizer",
        parameters: { subjectIds: allSubjectIds },
      },
      weights.globalOcclusion,
    ]);
  }

  return candidates.flatMap(([enabled, descriptor, weight]) =>
    enabled ? [{ descriptor, weight }] : []
  );
}
