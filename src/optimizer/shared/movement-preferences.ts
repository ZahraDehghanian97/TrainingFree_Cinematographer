import { LossFunctionType } from "../../types/solver";
import type { Vec3 } from "../../types/environment";
import { DEFAULT_OPTIONS } from "../config/defaults";
import { distance3 } from "./math";
import type { CameraOptimizerInput, PrimitiveLoss } from "../types";

/** Perceptual floors for free amounts; explicit authored amounts bypass these. */
export function minimumTranslationProgress(
  input: CameraOptimizerInput,
  primitive: PrimitiveLoss,
  cameraPosition: Vec3,
  subjectCenter?: Vec3,
): number {
  const absolute = input.options?.minimumMovementDistance ?? DEFAULT_OPTIONS.minimumMovementDistance;
  const isDolly = primitive.sourceType === LossFunctionType.DollyInMovement
    || primitive.sourceType === LossFunctionType.DollyOutMovement;
  // A few centimeters are imperceptible when filming a distant or large
  // subject. Dolly amount should change the subject's apparent scale too.
  return isDolly && subjectCenter
    ? Math.max(absolute, distance3(cameraPosition, subjectCenter)
      * (input.options?.minimumDollyDistanceRatio ?? DEFAULT_OPTIONS.minimumDollyDistanceRatio))
    : absolute;
}

export function minimumAngularProgress(input: CameraOptimizerInput, primitive: PrimitiveLoss): number {
  const degrees = primitive.parameters.mode === "orbit"
    ? input.options?.minimumOrbitAngleDegrees ?? DEFAULT_OPTIONS.minimumOrbitAngleDegrees
    : input.options?.minimumMovementAngleDegrees ?? DEFAULT_OPTIONS.minimumMovementAngleDegrees;
  return degrees * Math.PI / 180;
}
