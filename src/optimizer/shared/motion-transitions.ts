import type { MotionTransition, PrimitiveLoss } from "../types";

// Aggregate progress promises and safety constraints retain their full weight.
const AGGREGATE_TYPES = new Set<PrimitiveLoss["type"]>([
  "totalProgressTarget", "angularProgress", "rollProgress", "intrinsicsProgress",
]);

/** Ease local action constraints near a handoff, leaving global regularity active. */
export function motionTransitionScale(primitive: PrimitiveLoss, time: number): number {
  if (primitive.channel === "safety" || primitive.sourceType === "global"
    || primitive.sourceType === "userKeyframe" || AGGREGATE_TYPES.has(primitive.type)) return 1;
  const windows = primitive.parameters.motionTransitions as MotionTransition[] | undefined;
  if (!windows) return 1;
  let weight = 1;
  for (const window of windows) {
    if (time < window.startTime || time > window.endTime) continue;
    const width = time < window.boundaryTime
      ? window.boundaryTime - window.startTime
      : window.endTime - window.boundaryTime;
    const alpha = Math.min(1, Math.abs(time - window.boundaryTime) / Math.max(1e-9, width));
    const eased = alpha * alpha * (3 - 2 * alpha);
    weight = Math.min(weight, 0.1 + 0.9 * eased);
  }
  // Scale residuals rather than normalized sample weights: normalization must
  // not cancel the relaxation, including for a one-sample residual.
  return Math.sqrt(weight);
}
