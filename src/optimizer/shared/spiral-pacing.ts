import type { Vec3 } from "../../types/environment";
import { clamp } from "./math";

/** A spherical spiral with linear radius/elevation and an arc-length clock. */
export function createSpiralPacing(start: Vec3, end: Vec3, sweep: number) {
  const r0 = Math.hypot(...start), r1 = Math.hypot(...end);
  const elevation0 = Math.atan2(start[1], Math.hypot(start[0], start[2]));
  const elevation1 = Math.atan2(end[1], Math.hypot(end[0], end[2]));
  const bearing = Math.atan2(start[0], start[2]);
  const dr = r1 - r0, de = elevation1 - elevation0;
  const speed = (u: number) => Math.hypot(dr, (r0 + dr * u) * de,
    (r0 + dr * u) * Math.cos(elevation0 + de * u) * sweep);
  const count = 256;
  const length = new Float64Array(count + 1);
  for (let i = 1; i <= count; i++) {
    // Simpson quadrature keeps the path clock stable even for tight spirals.
    length[i] = length[i - 1]! + (speed((i - 1) / count) + 4 * speed((i - 0.5) / count) + speed(i / count)) / (6 * count);
  }
  const phase = (progress: number): number => {
    const u = clamp(progress, 0, 1);
    if (u === 0 || u === 1 || length[count]! < 1e-10) return u;
    const target = u * length[count]!;
    let lo = 0, hi = count;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >>> 1;
      if (length[mid]! < target) lo = mid; else hi = mid;
    }
    return (lo + (target - length[lo]!) / Math.max(1e-12, length[hi]! - length[lo]!)) / count;
  };
  const offset = (u: number): Vec3 => {
    if (u === 0) return [...start];
    const r = r0 + dr * u, elevation = elevation0 + de * u;
    const angle = bearing + sweep * u;
    return [r * Math.cos(elevation) * Math.sin(angle), r * Math.sin(elevation), r * Math.cos(elevation) * Math.cos(angle)];
  };
  return { phase, offset };
}
