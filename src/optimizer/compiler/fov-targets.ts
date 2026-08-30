import type { PrimitiveLoss } from "../types";

/**
 * Bakes zoom targets into each sub-band so optimization cannot turn the
 * current FOV into a self-referential, moving target.
 */
export function resolveFixedFovTargets(
  primitives: PrimitiveLoss[],
  initialFovYDegrees: number,
): void {
  let runningFovYDegrees = initialFovYDegrees;
  const resolvedTargetByBand = new Map<string, number>();

  // Primitive insertion is chronological here. The final plan sort happens
  // after this pass so every zoom band can advance the same running target.
  for (const primitive of primitives) {
    if (primitive.type !== "intrinsicsProgress" && primitive.type !== "intrinsicsPacing") {
      continue;
    }

    const bandKey = `${primitive.startTime}:${primitive.endTime}:${primitive.sourceActionId ?? ""}`;
    let targetFovYDegrees = resolvedTargetByBand.get(bandKey);
    if (targetFovYDegrees === undefined) {
      const factor = typeof primitive.parameters.factor === "number"
        ? primitive.parameters.factor
        : 1;
      runningFovYDegrees = primitive.parameters.direction === "in"
        ? runningFovYDegrees / factor
        : runningFovYDegrees * factor;
      targetFovYDegrees = runningFovYDegrees;
      resolvedTargetByBand.set(bandKey, targetFovYDegrees);
    }

    primitive.parameters = { ...primitive.parameters, targetFovYDegrees };
  }
}
