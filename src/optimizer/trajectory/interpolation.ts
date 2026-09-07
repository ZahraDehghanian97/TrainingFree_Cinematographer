import type { Quat, Vec3 } from "../../types/environment";
import { conjugateQuat, multiplyQuat, normalizeQuat, scale3 } from "../shared/math";

/** Shortest-path body angular velocity, in radians per second. */
export function angularVelocity(from: Quat, to: Quat, span: number): Vec3 {
  if (span <= 1e-9) return [0, 0, 0];
  let delta = multiplyQuat(conjugateQuat(from), to);
  if (delta[3] < 0) delta = [-delta[0], -delta[1], -delta[2], -delta[3]];
  const sine = Math.hypot(delta[0], delta[1], delta[2]);
  if (sine <= 1e-12) return [0, 0, 0];
  return scale3(
    [delta[0], delta[1], delta[2]],
    2 * Math.atan2(sine, delta[3]) / (sine * span),
  );
}

export function cubicHermite(
  left: number,
  right: number,
  leftVelocity: number,
  rightVelocity: number,
  span: number,
  alpha: number,
): number {
  const alpha2 = alpha * alpha;
  const alpha3 = alpha2 * alpha;
  return (2 * alpha3 - 3 * alpha2 + 1) * left
    + (alpha3 - 2 * alpha2 + alpha) * span * leftVelocity
    + (-2 * alpha3 + 3 * alpha2) * right
    + (alpha3 - alpha2) * span * rightVelocity;
}

function rotationDerivative(rotation: Quat, velocity: Vec3): Quat {
  // q' = q * [omega / 2, 0]. Do not normalize this derivative.
  const [x, y, z, w] = rotation;
  const [vx, vy, vz] = scale3(velocity, 0.5);
  return [
    w * vx + y * vz - z * vy,
    w * vy + z * vx - x * vz,
    w * vz + x * vy - y * vx,
    -x * vx - y * vy - z * vz,
  ];
}

/**
 * Unit-quaternion Hermite interpolation with body angular velocities in rad/s.
 * Shared endpoint velocities remain shared after normalization, because each
 * quaternion derivative is tangent to the unit sphere. This also handles
 * unequal sample intervals without changing speed at their common knot.
 */
export function interpolateRotationWithVelocities(
  left: Quat,
  right: Quat,
  leftAngularVelocity: Vec3,
  rightAngularVelocity: Vec3,
  span: number,
  alpha: number,
): Quat {
  const from = normalizeQuat(left);
  let to = normalizeQuat(right);
  if (from.reduce((sum, value, index) => sum + value * to[index]!, 0) < 0) {
    to = [-to[0], -to[1], -to[2], -to[3]];
  }
  const fromDerivative = rotationDerivative(from, leftAngularVelocity);
  const toDerivative = rotationDerivative(to, rightAngularVelocity);
  return normalizeQuat(from.map((value, component) => cubicHermite(
    value,
    to[component]!,
    fromDerivative[component]!,
    toDerivative[component]!,
    span,
    alpha,
  )) as Quat);
}
