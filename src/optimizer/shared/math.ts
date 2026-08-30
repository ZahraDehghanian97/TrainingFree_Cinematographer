import type { Quat, Vec3 } from "../../types/environment";

export const EPSILON = 1e-9;

export function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

export function lerp(a: number, b: number, alpha: number): number {
  return a + (b - a) * alpha;
}

export function add3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

export function sub3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

export function scale3(value: Vec3, scale: number): Vec3 {
  return [value[0] * scale, value[1] * scale, value[2] * scale];
}

export function lerp3(a: Vec3, b: Vec3, alpha: number): Vec3 {
  return [lerp(a[0], b[0], alpha), lerp(a[1], b[1], alpha), lerp(a[2], b[2], alpha)];
}

export function dot3(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

export function cross3(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

export function length3(value: Vec3): number {
  return Math.hypot(value[0], value[1], value[2]);
}

export function distance3(a: Vec3, b: Vec3): number {
  return length3(sub3(a, b));
}

export function normalize3(value: Vec3, fallback: Vec3 = [0, 0, -1]): Vec3 {
  const length = length3(value);
  return length <= EPSILON ? [...fallback] as Vec3 : scale3(value, 1 / length);
}

export function projectOnPlane(value: Vec3, normal: Vec3): Vec3 {
  const unitNormal = normalize3(normal, [0, 1, 0]);
  return sub3(value, scale3(unitNormal, dot3(value, unitNormal)));
}

export function signedAngleAround(from: Vec3, to: Vec3, axis: Vec3): number {
  const unitAxis = normalize3(axis, [0, 1, 0]);
  const a = normalize3(projectOnPlane(from, unitAxis));
  const b = normalize3(projectOnPlane(to, unitAxis));
  return Math.atan2(dot3(unitAxis, cross3(a, b)), clamp(dot3(a, b), -1, 1));
}

export function wrapAngle(angle: number): number {
  let result = angle;
  while (result > Math.PI) result -= 2 * Math.PI;
  while (result < -Math.PI) result += 2 * Math.PI;
  return result;
}

export function unwrapAngles(values: number[]): number[] {
  if (values.length === 0) return [];
  const result = [values[0]!];
  for (let index = 1; index < values.length; index += 1) {
    result.push(result[index - 1]! + wrapAngle(values[index]! - values[index - 1]!));
  }
  return result;
}

export function normalizeQuat(value: Quat): Quat {
  const length = Math.hypot(value[0], value[1], value[2], value[3]);
  if (length <= EPSILON) return [0, 0, 0, 1];
  return [value[0] / length, value[1] / length, value[2] / length, value[3] / length];
}

export function conjugateQuat(value: Quat): Quat {
  const q = normalizeQuat(value);
  return [-q[0], -q[1], -q[2], q[3]];
}

export function multiplyQuat(aValue: Quat, bValue: Quat): Quat {
  const a = normalizeQuat(aValue);
  const b = normalizeQuat(bValue);
  return normalizeQuat([
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ]);
}

export function quatFromAxisAngle(axis: Vec3, angle: number): Quat {
  const unitAxis = normalize3(axis, [0, 1, 0]);
  const half = angle / 2;
  const sine = Math.sin(half);
  return normalizeQuat([unitAxis[0] * sine, unitAxis[1] * sine, unitAxis[2] * sine, Math.cos(half)]);
}

export function rotate3(value: Vec3, quaternion: Quat): Vec3 {
  const q = normalizeQuat(quaternion);
  const vectorQuat: Quat = [value[0], value[1], value[2], 0];
  const rotated = multiplyQuatRaw(multiplyQuatRaw(q, vectorQuat), conjugateQuat(q));
  return [rotated[0], rotated[1], rotated[2]];
}

function multiplyQuatRaw(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}

export function slerpQuat(fromValue: Quat, toValue: Quat, alpha: number): Quat {
  const from = normalizeQuat(fromValue);
  let to = normalizeQuat(toValue);
  let alignment = from[0] * to[0] + from[1] * to[1] + from[2] * to[2] + from[3] * to[3];
  if (alignment < 0) {
    alignment = -alignment;
    to = [-to[0], -to[1], -to[2], -to[3]];
  }
  alignment = clamp(alignment, -1, 1);
  if (alignment > 0.9995) {
    return normalizeQuat([
      lerp(from[0], to[0], alpha),
      lerp(from[1], to[1], alpha),
      lerp(from[2], to[2], alpha),
      lerp(from[3], to[3], alpha),
    ]);
  }
  const theta = Math.acos(alignment);
  const sine = Math.sin(theta);
  const a = Math.sin((1 - alpha) * theta) / sine;
  const b = Math.sin(alpha * theta) / sine;
  return normalizeQuat([
    from[0] * a + to[0] * b,
    from[1] * a + to[1] * b,
    from[2] * a + to[2] * b,
    from[3] * a + to[3] * b,
  ]);
}

export function quaternionAngle(aValue: Quat, bValue: Quat): number {
  const a = normalizeQuat(aValue);
  const b = normalizeQuat(bValue);
  const alignment = Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]);
  return 2 * Math.acos(clamp(alignment, -1, 1));
}

export function cameraForward(rotation: Quat): Vec3 {
  return normalize3(rotate3([0, 0, -1], rotation));
}

export function cameraRight(rotation: Quat): Vec3 {
  return normalize3(rotate3([1, 0, 0], rotation), [1, 0, 0]);
}

export function cameraUp(rotation: Quat): Vec3 {
  return normalize3(rotate3([0, 1, 0], rotation), [0, 1, 0]);
}

function quatFromRotationMatrix(
  m00: number, m01: number, m02: number,
  m10: number, m11: number, m12: number,
  m20: number, m21: number, m22: number,
): Quat {
  const trace = m00 + m11 + m22;
  if (trace > 0) {
    const scale = Math.sqrt(trace + 1) * 2;
    return normalizeQuat([(m21 - m12) / scale, (m02 - m20) / scale, (m10 - m01) / scale, scale / 4]);
  }
  if (m00 > m11 && m00 > m22) {
    const scale = Math.sqrt(1 + m00 - m11 - m22) * 2;
    return normalizeQuat([scale / 4, (m01 + m10) / scale, (m02 + m20) / scale, (m21 - m12) / scale]);
  }
  if (m11 > m22) {
    const scale = Math.sqrt(1 + m11 - m00 - m22) * 2;
    return normalizeQuat([(m01 + m10) / scale, scale / 4, (m12 + m21) / scale, (m02 - m20) / scale]);
  }
  const scale = Math.sqrt(1 + m22 - m00 - m11) * 2;
  return normalizeQuat([(m02 + m20) / scale, (m12 + m21) / scale, scale / 4, (m10 - m01) / scale]);
}

/** Builds a right-handed, -Z-forward camera orientation. */
export function lookAtQuaternion(position: Vec3, target: Vec3, upHint: Vec3 = [0, 1, 0]): Quat {
  const forward = normalize3(sub3(target, position));
  let right = cross3(forward, normalize3(upHint, [0, 1, 0]));
  if (length3(right) <= 1e-6) right = cross3(forward, [0, 0, 1]);
  right = normalize3(right, [1, 0, 0]);
  const up = normalize3(cross3(right, forward), [0, 1, 0]);
  const back = scale3(forward, -1);
  return quatFromRotationMatrix(
    right[0], up[0], back[0],
    right[1], up[1], back[1],
    right[2], up[2], back[2],
  );
}

export function yawFromQuaternion(rotation: Quat): number {
  const forward = cameraForward(rotation);
  return Math.atan2(-forward[0], -forward[2]);
}

export function pitchFromQuaternion(rotation: Quat): number {
  return Math.asin(clamp(cameraForward(rotation)[1], -1, 1));
}

export function rollFromQuaternion(rotation: Quat): number {
  const forward = cameraForward(rotation);
  const actualUp = cameraUp(rotation);
  const desiredRight = normalize3(cross3(forward, [0, 1, 0]), [1, 0, 0]);
  const desiredUp = normalize3(cross3(desiredRight, forward), [0, 1, 0]);
  return signedAngleAround(desiredUp, actualUp, forward);
}

export function applyCameraYawPitchRoll(
  base: Quat,
  yaw: number,
  pitch: number,
  roll: number,
): Quat {
  let result = multiplyQuat(quatFromAxisAngle([0, 1, 0], yaw), base);
  result = multiplyQuat(quatFromAxisAngle(cameraRight(result), pitch), result);
  result = multiplyQuat(quatFromAxisAngle(cameraForward(result), roll), result);
  return normalizeQuat(result);
}

export function rotateAroundAxis(point: Vec3, center: Vec3, axis: Vec3, angle: number): Vec3 {
  return add3(center, rotate3(sub3(point, center), quatFromAxisAngle(axis, angle)));
}

export function huber(normalizedResidual: number, delta = 1): number {
  const magnitude = Math.abs(normalizedResidual);
  return magnitude <= delta
    ? 0.5 * normalizedResidual * normalizedResidual
    : delta * (magnitude - 0.5 * delta);
}

export function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}
