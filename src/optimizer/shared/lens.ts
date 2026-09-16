/** Log focal length for a unit sensor half-height: log(cot(verticalFov/2)). */
export function fovDegreesToLogFocal(fovDegrees: number): number {
  if (!Number.isFinite(fovDegrees) || fovDegrees <= 0 || fovDegrees >= 180) {
    throw new Error("Vertical field of view must be finite and strictly between 0 and 180 degrees");
  }
  return -Math.log(Math.tan(fovDegrees * Math.PI / 360));
}

export function logFocalToFovDegrees(logFocal: number): number {
  if (!Number.isFinite(logFocal)) throw new Error("Log focal length must be finite");
  return 2 * Math.atan(Math.exp(-logFocal)) * 180 / Math.PI;
}

/** An optical zoom factor multiplies focal length, not the angle in degrees. */
export function applyOpticalZoom(
  fovDegrees: number,
  factor: number,
  direction: "in" | "out",
  progress = 1,
): number {
  if (!Number.isFinite(factor) || factor <= 0) throw new Error("Optical zoom factor must be finite and positive");
  if (!Number.isFinite(progress)) throw new Error("Optical zoom progress must be finite");
  const delta = Math.log(factor) * progress * (direction === "in" ? 1 : -1);
  return logFocalToFovDegrees(fovDegreesToLogFocal(fovDegrees) + delta);
}

/** Geometric focal interpolation; sensor height cancels in the focal ratio. */
export function interpolateFovLogFocal(from: number, to: number, alpha: number): number {
  if (!Number.isFinite(alpha)) throw new Error("Lens interpolation progress must be finite");
  const start = fovDegreesToLogFocal(from);
  return logFocalToFovDegrees(start + alpha * (fovDegreesToLogFocal(to) - start));
}
