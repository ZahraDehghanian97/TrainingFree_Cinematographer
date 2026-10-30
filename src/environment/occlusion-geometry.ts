import type { EntityOcclusionV1 } from "../types/environment";

/** Shared by file loading, the viewer, and direct optimizer calls. */
export function assertEntityOcclusion(value: unknown, field: string): asserts value is EntityOcclusionV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  const metadata = value as Record<string, unknown>;
  if (metadata.transparent !== undefined && typeof metadata.transparent !== "boolean") {
    throw new Error(`${field}.transparent must be a boolean`);
  }
  if (metadata.bounds === undefined) return;
  if (!Array.isArray(metadata.bounds) || metadata.bounds.length === 0) {
    throw new Error(`${field}.bounds must be a nonempty array; use transparent: true for transparent entities`);
  }
  if (metadata.transparent === true) {
    throw new Error(`${field} cannot combine transparent: true with opaque bounds`);
  }
  const tuple = (candidate: unknown, path: string): number[] => {
    if (!Array.isArray(candidate) || candidate.length !== 3
      || !candidate.every((component) => typeof component === "number" && Number.isFinite(component))) {
      throw new Error(`${path} must contain three finite numbers`);
    }
    return candidate;
  };
  metadata.bounds.forEach((candidate: unknown, index: number) => {
    const path = `${field}.bounds[${index}]`;
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`${path} must be a box or sphere`);
    }
    const bounds = candidate as Record<string, unknown>;
    if (bounds.type === "sphere") {
      tuple(bounds.center, `${path}.center`);
      if (typeof bounds.radius !== "number" || !Number.isFinite(bounds.radius) || bounds.radius <= 0) {
        throw new Error(`${path}.radius must be positive and finite`);
      }
    } else if (bounds.type === "box") {
      const minimum = tuple(bounds.min, `${path}.min`);
      const maximum = tuple(bounds.max, `${path}.max`);
      if (minimum.some((component, axis) => component > maximum[axis]!)) {
        throw new Error(`${path}.min must not exceed max`);
      }
    } else throw new Error(`${path}.type must be box or sphere`);
  });
}
