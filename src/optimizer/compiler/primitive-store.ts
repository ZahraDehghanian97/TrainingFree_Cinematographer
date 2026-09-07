import { PRIMITIVE_TOLERANCES } from "../config/defaults";
import type { OptimizerWeights, PrimitiveLoss, PrimitiveRole } from "../types";
import type { AddPrimitive } from "./types";

interface PrimitiveStore {
  primitives: PrimitiveLoss[];
  add: AddPrimitive;
}

function roleWeight(role: PrimitiveRole, weights: OptimizerWeights): number {
  if (role === "primary") return weights.semanticPrimary;
  if (role === "stabilizer") return weights.semanticStabilizer;
  return weights.globalMinPath;
}

/** Owns primitive materialization and stable, monotonically increasing IDs. */
export function createPrimitiveStore(weights: OptimizerWeights): PrimitiveStore {
  const primitives: PrimitiveLoss[] = [];
  let nextId = 1;

  const add: AddPrimitive = (
    descriptor,
    {
      startTime,
      endTime,
      sourceType,
      sourceWeight = 1,
      sourceActionId,
      explicitWeight,
    },
  ) => {
    const primitive: PrimitiveLoss = {
      id: `p${nextId++}`,
      type: descriptor.type,
      startTime,
      endTime,
      weight: explicitWeight
        ?? roleWeight(descriptor.role, weights) * sourceWeight * (descriptor.weightScale ?? 1),
      tolerance: descriptor.tolerance ?? PRIMITIVE_TOLERANCES[descriptor.type],
      channel: descriptor.channel,
      role: descriptor.role,
      sourceType,
      ...(sourceActionId ? { sourceActionId } : {}),
      parameters: descriptor.parameters ?? {},
    };
    primitives.push(primitive);
    return primitive;
  };

  return { primitives, add };
}
