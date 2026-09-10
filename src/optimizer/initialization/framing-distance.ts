import type { Vec3 } from "../../types/environment";
import { DEFAULT_OPTIONS } from "../config/defaults";
import { projectWorldBox } from "../scene/projection";
import type { SubjectAggregate } from "../scene/subjects";
import { add3, lookAtQuaternion, scale3 } from "../shared/math";
import type { CameraOptimizerInput } from "../types";

/** Solve the same projected box coverage used by the numerical objective. */
export function projectedDistanceForCoverage(
  input: CameraOptimizerInput,
  target: SubjectAggregate,
  direction: Vec3,
  fovYDegrees: number,
  targetCoverage: number,
): number {
  const aspectRatio = input.options?.aspectRatio ?? DEFAULT_OPTIONS.aspectRatio;
  let lowerDistance = 0.05;
  let upperDistance = 80;
  for (let iteration = 0; iteration < 36; iteration += 1) {
    const candidateDistance = (lowerDistance + upperDistance) / 2;
    const candidatePosition = add3(target.center, scale3(direction, candidateDistance));
    const projected = projectWorldBox(
      target.box, candidatePosition, lookAtQuaternion(candidatePosition, target.center),
      fovYDegrees, aspectRatio,
    );
    if (projected.behindCamera || projected.height > targetCoverage) lowerDistance = candidateDistance;
    else upperDistance = candidateDistance;
  }
  return (lowerDistance + upperDistance) / 2;
}
