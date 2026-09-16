import { DEFAULT_GLOBAL_LOSSES } from "../config/defaults";
import { subjectIdsFromParameters } from "../shared/parameter-values";
import type { CameraOptimizerInput, OptimizerWeights, PrimitiveLoss } from "../types";
import type { PrimitiveDescriptor } from "./types";
import { subjectTimingParameters } from "../scene/primitive-context";

export interface WeightedPrimitiveDescriptor {
  descriptor: PrimitiveDescriptor;
  weight: number;
  /** Omitted for whole-trajectory regularizers. */
  startTime?: number;
  endTime?: number;
  normalizationDuration?: number;
}

function subjectScope(primitive: PrimitiveLoss, subjectId: string) {
  const p = primitive.parameters;
  const pointTime = p.pointTime ?? p.keyframeTime;
  const parameters = {
    subjectId,
    ...(pointTime === undefined ? {} : { pointTime }),
    ...(p.easing === undefined ? {} : { easing: p.easing }),
    ...subjectTimingParameters(p),
  };
  return {
    parameters,
    key: JSON.stringify([
      subjectId, primitive.startTime, primitive.endTime, pointTime,
      p.easing, subjectTimingParameters(p),
    ]),
  };
}

/** Automatic occlusion follows each subject's authored scope, including point easing. */
function scopedOcclusionDescriptors(
  primitives: readonly PrimitiveLoss[],
  weight: number,
): WeightedPrimitiveDescriptor[] {
  const suppressionByScope = new Map<string, unknown>();
  for (const primitive of primitives) {
    if (primitive.type !== "subjectVisibility") continue;
    for (const subjectId of subjectIdsFromParameters(primitive.parameters)) {
      suppressionByScope.set(subjectScope(primitive, subjectId).key, primitive.parameters.suppressionWindows);
    }
  }
  const emitted = new Set<string>();
  const descriptors: WeightedPrimitiveDescriptor[] = [];
  for (const primitive of primitives) {
    if (primitive.sourceType === "global" || primitive.weight <= 0) continue;
    for (const subjectId of subjectIdsFromParameters(primitive.parameters)) {
      const { key, parameters } = subjectScope(primitive, subjectId);
      if (emitted.has(key)) continue;
      emitted.add(key);
      const suppressionWindows = suppressionByScope.get(key);
      descriptors.push({
        descriptor: {
          type: "occlusion",
          channel: "safety",
          role: "regularizer",
          parameters: {
            ...parameters,
            ...(suppressionWindows === undefined ? {} : { suppressionWindows }),
          },
        },
        startTime: primitive.startTime,
        endTime: primitive.endTime,
        normalizationDuration: primitive.normalizationDuration ?? primitive.endTime - primitive.startTime,
        weight,
      });
    }
  }
  return descriptors;
}

/** Builds global safety/regularity policy, with visibility scoped to active subjects. */
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

  const descriptors: WeightedPrimitiveDescriptor[] = candidates.flatMap(([enabled, descriptor, weight]) =>
    enabled ? [{ descriptor, weight }] : []
  );
  if (global.occlusion) descriptors.push(...scopedOcclusionDescriptors(primitives, weights.globalOcclusion));
  return descriptors;
}
