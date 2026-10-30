import type { Quat, Vec3 } from "../../types/environment";
import { cross3, dot3, normalizeQuat, quatFromRotationMatrix } from "./math";

/** Decodes an authored row-major rigid camera-to-world transform. */
export function poseFromTransformMatrix(value: unknown): { position: Vec3; rotation: Quat } {
  if (!Array.isArray(value) || value.length !== 4 || !value.every((row) =>
    Array.isArray(row) && row.length === 4 && row.every((item) =>
      typeof item === "number" && Number.isFinite(item),
    ),
  )) {
    throw new Error("extrinsics.transformMatrix must be a 4x4 matrix of finite numbers");
  }
  const rows = value as number[][];
  const tolerance = 1e-5;
  if (rows[3]!.some((item, index) => Math.abs(item - (index === 3 ? 1 : 0)) > tolerance)) {
    throw new Error("extrinsics.transformMatrix must be affine with last row [0, 0, 0, 1]");
  }
  const columns = [0, 1, 2].map((column) =>
    [rows[0]![column]!, rows[1]![column]!, rows[2]![column]!] as Vec3,
  );
  if (columns.some((column, index) =>
    Math.abs(dot3(column, column) - 1) > tolerance
    || columns.slice(index + 1).some((other) => Math.abs(dot3(column, other)) > tolerance),
  ) || Math.abs(dot3(cross3(columns[0]!, columns[1]!), columns[2]!) - 1) > tolerance) {
    throw new Error("extrinsics.transformMatrix must contain a rigid rotation without scale, shear, or reflection");
  }
  return {
    position: [rows[0]![3]!, rows[1]![3]!, rows[2]![3]!],
    rotation: quatFromRotationMatrix(
      rows[0]![0]!, rows[0]![1]!, rows[0]![2]!,
      rows[1]![0]!, rows[1]![1]!, rows[1]![2]!,
      rows[2]![0]!, rows[2]![1]!, rows[2]![2]!,
    ),
  };
}

export function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function subjectIdsFromParameters(
  parameters: Record<string, unknown>,
): string[] {
  if (typeof parameters.subjectId === "string" && parameters.subjectId.trim()) {
    return [parameters.subjectId.trim()];
  }
  if (Array.isArray(parameters.subjectIds)) {
    return [...new Set(parameters.subjectIds.filter(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    ).map((value) => value.trim()))];
  }
  return [];
}

export function asVec3(value: unknown): Vec3 | undefined {
  if (Array.isArray(value) && value.length === 3 && value.every(Number.isFinite)) {
    return [Number(value[0]), Number(value[1]), Number(value[2])];
  }
  if (value && typeof value === "object") {
    const candidate = value as Record<string, unknown>;
    if ([candidate.x, candidate.y, candidate.z].every(
      (item) => typeof item === "number" && Number.isFinite(item),
    )) {
      return [candidate.x as number, candidate.y as number, candidate.z as number];
    }
  }
  return undefined;
}

function quaternionFromEulerDegrees(value: Record<string, unknown>): Quat | undefined {
  if (![value.pitch, value.yaw, value.roll].every(
    (item) => typeof item === "number" && Number.isFinite(item),
  )) {
    return undefined;
  }
  const pitch = (value.pitch as number) * Math.PI / 180;
  const yaw = (value.yaw as number) * Math.PI / 180;
  const roll = (value.roll as number) * Math.PI / 180;
  const cy = Math.cos(yaw / 2);
  const sy = Math.sin(yaw / 2);
  const cp = Math.cos(pitch / 2);
  const sp = Math.sin(pitch / 2);
  const cr = Math.cos(roll / 2);
  const sr = Math.sin(roll / 2);
  return normalizeQuat([
    sp * cy * cr + cp * sy * sr,
    cp * sy * cr - sp * cy * sr,
    cp * cy * sr - sp * sy * cr,
    cp * cy * cr + sp * sy * sr,
  ]);
}

export function asQuat(value: unknown): Quat | undefined {
  if (Array.isArray(value) && value.length === 4 && value.every(Number.isFinite)) {
    return normalizeQuat([
      Number(value[0]),
      Number(value[1]),
      Number(value[2]),
      Number(value[3]),
    ]);
  }
  if (value && typeof value === "object") {
    const candidate = value as Record<string, unknown>;
    if ([candidate.x, candidate.y, candidate.z, candidate.w].every(
      (item) => typeof item === "number" && Number.isFinite(item),
    )) {
      return normalizeQuat([
        candidate.x as number,
        candidate.y as number,
        candidate.z as number,
        candidate.w as number,
      ]);
    }
    return quaternionFromEulerDegrees(candidate);
  }
  return undefined;
}
