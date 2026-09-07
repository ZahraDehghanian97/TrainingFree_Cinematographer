import { slerpQuat } from "../shared/math";
import { crossesCut } from "../shared/time";
import type {
  CameraStateSample,
  CompiledLossPlan,
  PrimitiveLoss,
  UserCameraKeyframe,
} from "../types";

const COMPOSITION_ANCHOR_TYPES = new Set<PrimitiveLoss["type"]>([
  "lookAt",
  "screenPosition",
  "screenScale",
  "rotationAnchor",
]);

function ownsIntermediateOrientation(primitive: PrimitiveLoss): boolean {
  return primitive.endTime - primitive.startTime > 1e-9
    && (
      primitive.type === "orientationHold"
      || primitive.type === "forwardHold"
      || primitive.type === "yawHold"
      || primitive.type === "pitchHold"
      || primitive.type === "rollHold"
      || primitive.type === "angularProgress"
      || primitive.type === "rollProgress"
      || primitive.type === "rollTarget"
      || primitive.type === "lookAt"
      || primitive.type === "screenPosition"
      || primitive.type === "screenScale"
      || primitive.type === "rotationAnchor"
    );
}

/** Interpolates isolated composition anchors when no interval owns orientation. */
export function seedSparseCompositionTransitions(
  states: CameraStateSample[],
  plan: CompiledLossPlan,
  keyframes: readonly UserCameraKeyframe[],
  cutTimes: readonly number[],
): void {
  const anchorTimes = [...new Set([
    states[0]!.time,
    states[states.length - 1]!.time,
    ...plan.primitives
      .filter((primitive) =>
        Math.abs(primitive.endTime - primitive.startTime) <= 1e-9
        && COMPOSITION_ANCHOR_TYPES.has(primitive.type),
      )
      .map((primitive) => primitive.startTime),
    ...keyframes
      .filter((keyframe) => keyframe.rotation !== undefined || keyframe.lookAt !== undefined)
      .map((keyframe) => keyframe.time),
  ])].sort((a, b) => a - b);

  for (let anchorIndex = 1; anchorIndex < anchorTimes.length; anchorIndex += 1) {
    const startTime = anchorTimes[anchorIndex - 1]!;
    const endTime = anchorTimes[anchorIndex]!;
    if (endTime - startTime <= 1e-9 || crossesCut(startTime, endTime, cutTimes)) {
      continue;
    }
    const intervalOwnsOrientation = plan.primitives.some((primitive) =>
      ownsIntermediateOrientation(primitive)
      && primitive.startTime < endTime - 1e-9
      && primitive.endTime > startTime + 1e-9,
    );
    if (intervalOwnsOrientation) continue;

    const startIndex = states.findIndex((state) =>
      Math.abs(state.time - startTime) <= 1e-8,
    );
    const endIndex = states.findIndex((state) =>
      Math.abs(state.time - endTime) <= 1e-8,
    );
    if (startIndex < 0 || endIndex <= startIndex) continue;

    const startRotation = states[startIndex]!.rotation;
    const endRotation = states[endIndex]!.rotation;
    for (let index = startIndex + 1; index < endIndex; index += 1) {
      const alpha = (states[index]!.time - startTime) / (endTime - startTime);
      states[index]!.rotation = slerpQuat(startRotation, endRotation, alpha);
    }
  }
}
