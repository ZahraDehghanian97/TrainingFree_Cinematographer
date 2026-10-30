import type { Vec3 } from "../../types/environment";
import { DEFAULT_OPTIONS } from "../config/defaults";
import { projectWorldBox } from "../scene/projection";
import type { SubjectAggregate } from "../scene/subjects";
import { add3, length3, lookAtQuaternion, normalize3, scale3 } from "../shared/math";
import type { CameraOptimizerInput } from "../types";

/** A valid viewing direction cannot attain the requested positive coverage. */
export class FramingCoverageError extends Error {
  constructor(readonly requestedCoverage: number, readonly achievedCoverage: number) {
    super("Requested coverage could not be bracketed within the near-plane constraints");
    this.name = "FramingCoverageError";
  }
}

/** Solve the same projected box coverage used by the numerical objective. */
export function projectedDistanceForCoverage(
  input: CameraOptimizerInput,
  target: SubjectAggregate,
  direction: Vec3,
  fovYDegrees: number,
  targetCoverage: number,
  options: {
    allowNearPlaneLimited?: boolean;
    cameraOrigin?: Vec3;
    cameraPositionAtDistance?: (distance: number) => Vec3;
  } = {},
): number {
  const aspectRatio = input.options?.aspectRatio ?? DEFAULT_OPTIONS.aspectRatio;
  const nearPlane = input.options?.nearPlane ?? DEFAULT_OPTIONS.nearPlane;
  if (!Number.isFinite(targetCoverage) || targetCoverage <= 0) throw new Error("Target coverage must be positive");
  if (!Number.isFinite(fovYDegrees) || fovYDegrees <= 0 || fovYDegrees >= 180) throw new Error("Framing FOV must be between 0 and 180 degrees");
  if (!direction.every(Number.isFinite) || length3(direction) <= 1e-12) throw new Error("Framing direction must be nonzero and finite");
  const unitDirection = normalize3(direction);
  const projectionAt = (distance: number) => {
    const candidatePosition = options.cameraPositionAtDistance?.(distance)
      ?? add3(options.cameraOrigin ?? target.center, scale3(unitDirection, distance));
    return projectWorldBox(
      target.box, candidatePosition, lookAtQuaternion(candidatePosition, target.center),
      fovYDegrees, aspectRatio, nearPlane,
    );
  };
  const fits = (distance: number) => {
    const projected = projectionAt(distance);
    return !projected.behindCamera && projected.height <= targetCoverage;
  };
  const solution = (distance: number, limitedByNearPlane: boolean): number => {
    const projected = projectionAt(distance);
    const tolerance = 1e-7 * Math.max(1, targetCoverage);
    if (projected.behindCamera || !Number.isFinite(projected.height) || projected.height > targetCoverage + tolerance) {
      throw new Error("Framing solve failed its projection accuracy check");
    }
    if (projected.height < targetCoverage - tolerance) {
      if (!limitedByNearPlane) throw new Error("Framing solve exhausted numerical precision before attaining the target coverage");
      // Screen scale is a soft objective during seeding. A near-plane-limited
      // candidate remains useful with its honest nonzero scale residual; an
      // exact-coverage query (the default) still reports the unattainable target.
      if (options.allowNearPlaneLimited && projected.height > 0) return distance;
      throw new FramingCoverageError(targetCoverage, projected.height);
    }
    return distance;
  };
  // Find a valid bracket instead of silently returning the old 80-unit cap.
  let lowerDistance = nearPlane;
  if (fits(lowerDistance)) return solution(lowerDistance, true);
  let upperDistance = Math.max(1, length3(target.box.size), 2 * lowerDistance);
  let expansions = 0;
  while (!fits(upperDistance)) {
    lowerDistance = upperDistance;
    upperDistance *= 2;
    if (++expansions > 100 || !Number.isFinite(upperDistance)) {
      throw new Error("Unable to bracket the requested projected coverage");
    }
  }
  for (let iteration = 0; iteration < 80; iteration += 1) {
    const candidateDistance = (lowerDistance + upperDistance) / 2;
    if (candidateDistance === lowerDistance || candidateDistance === upperDistance) break;
    if (!fits(candidateDistance)) lowerDistance = candidateDistance;
    else upperDistance = candidateDistance;
    if (Math.abs(projectionAt(upperDistance).height - targetCoverage) <= 1e-9 * Math.max(1, targetCoverage)) break;
  }
  return solution(upperDistance, projectionAt(lowerDistance).behindCamera);
}
