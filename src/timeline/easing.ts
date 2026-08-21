import type { PointConstraintEasing, PointConstraintEasingCurve } from "../types/dsl";
import type { SinglePointConstraint } from "../types/solver";

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function applyPointConstraintEasingCurve(
  progress: number,
  curve: PointConstraintEasingCurve = "easeInOut",
): number {
  const t = clamp01(progress);
  switch (curve) {
    case "linear":
      return t;
    case "easeIn":
      return t * t;
    case "easeOut":
      return 1 - (1 - t) * (1 - t);
    case "easeInOut":
      return t < 0.5
        ? 2 * t * t
        : 1 - ((-2 * t + 2) ** 2) / 2;
  }
}

export function validatePointConstraintEasing(easing: PointConstraintEasing | undefined): void {
  if (!easing) return;
  for (const [field, value] of [
    ["inDuration", easing.inDuration],
    ["outDuration", easing.outDuration],
  ] as const) {
    if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
      throw new Error(`Point constraint easing ${field} must be a finite non-negative number`);
    }
  }
}

/**
 * Returns the temporal multiplier for a point constraint at `timeSeconds`.
 * Without easing it preserves the original exact-point behavior.
 */
export function getPointConstraintWeight(
  constraint: Pick<SinglePointConstraint, "time" | "weight" | "easing">,
  timeSeconds: number,
): number {
  const baseWeight = constraint.weight ?? 1;
  const easing = constraint.easing;
  if (!easing) {
    return Math.abs(timeSeconds - constraint.time) <= 1e-9 ? baseWeight : 0;
  }
  validatePointConstraintEasing(easing);

  const inDuration = easing.inDuration ?? 0;
  const outDuration = easing.outDuration ?? 0;
  const curve = easing.curve ?? "easeInOut";

  if (timeSeconds < constraint.time) {
    if (inDuration <= 0 || timeSeconds < constraint.time - inDuration) return 0;
    const progress = (timeSeconds - (constraint.time - inDuration)) / inDuration;
    return baseWeight * applyPointConstraintEasingCurve(progress, curve);
  }

  if (timeSeconds > constraint.time) {
    if (outDuration <= 0 || timeSeconds > constraint.time + outDuration) return 0;
    const progress = (timeSeconds - constraint.time) / outDuration;
    return baseWeight * (1 - applyPointConstraintEasingCurve(progress, curve));
  }

  return baseWeight;
}
