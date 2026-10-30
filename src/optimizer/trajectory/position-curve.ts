import type { Vec3 } from "../../types/environment";
import type { CameraStateSample } from "../types";
import { crossesCut } from "../shared/time";

export interface PositionJet {
  position: Vec3;
  velocity: Vec3;
  acceleration: Vec3;
  jerk: Vec3;
}

export interface PositionSegment {
  startTime: number;
  endTime: number;
  controls: Vec3[];
  /** A hold immediately before a cut; the right knot belongs to the new shot. */
  hold: boolean;
}

const zero = (): Vec3 => [0, 0, 0];
const mix = (a: Vec3, b: Vec3, u: number): Vec3 => a.map((v, i) => v + u * (b[i]! - v)) as Vec3;

/** De Casteljau evaluation: the same polynomial is used for derivatives and bounds. */
export function evaluateBezier(controls: readonly Vec3[], u: number): Vec3 {
  let row = controls.map((value) => [...value] as Vec3);
  while (row.length > 1) row = row.slice(1).map((value, i) => mix(row[i]!, value, u));
  return row[0] ?? zero();
}

function derivativeControls(controls: readonly Vec3[], duration: number): Vec3[] {
  const degree = controls.length - 1;
  return controls.slice(1).map((value, i) => value.map((v, axis) =>
    degree * (v - controls[i]![axis]!) / duration) as Vec3);
}

export function samplePositionSegment(segment: PositionSegment, time: number): PositionJet {
  const h = segment.endTime - segment.startTime;
  const u = Math.max(0, Math.min(1, (time - segment.startTime) / h));
  const velocity = derivativeControls(segment.controls, h);
  const acceleration = derivativeControls(velocity, h);
  const jerk = derivativeControls(acceleration, h);
  return {
    position: evaluateBezier(segment.controls, u),
    velocity: evaluateBezier(velocity, u),
    acceleration: evaluateBezier(acceleration, u),
    jerk: evaluateBezier(jerk, u),
  };
}

/**
 * Quintic Hermite coefficients in Bernstein form, with physical endpoint jets.
 * Endpoint derivation and continuity assumptions: docs/mathematical-fixes.fa.md §1.
 */
export function quinticPositionControls(
  p: Vec3, q: Vec3, v: Vec3, w: Vec3, a: Vec3, b: Vec3, h: number,
): Vec3[] {
  return [
    [...p],
    p.map((x, i) => x + h * v[i]! / 5),
    p.map((x, i) => x + 2 * h * v[i]! / 5 + h * h * a[i]! / 20),
    q.map((x, i) => x - 2 * h * w[i]! / 5 + h * h * b[i]! / 20),
    q.map((x, i) => x - h * w[i]! / 5),
    [...q],
  ] as Vec3[];
}

/**
 * Interpolating C2 cubic jets from a tridiagonal spline solve. Endpoint
 * accelerations use the adjacent quadratic (zero for a two-knot line).
 * The resulting jets reproduce quadratic data on nonuniform timestamps.
 */
function splineJets(states: readonly CameraStateSample[], first: number, last: number) {
  const n = last - first + 1;
  const velocity = Array.from({ length: n }, zero);
  const acceleration = Array.from({ length: n }, zero);
  if (n < 2) return { velocity, acceleration };
  const h = Array.from({ length: n - 1 }, (_, i) => states[first + i + 1]!.time - states[first + i]!.time);
  for (let axis = 0; axis < 3; axis += 1) {
    const slopes = h.map((span, i) => (states[first + i + 1]!.position[axis]!
      - states[first + i]!.position[axis]!) / span);
    const diagonal = new Float64Array(n);
    const upper = new Float64Array(n);
    const lower = new Float64Array(n);
    const rhs = new Float64Array(n);
    diagonal[0] = diagonal[n - 1] = 1;
    if (n > 2) {
      rhs[0] = 2 * (slopes[1]! - slopes[0]!) / (h[0]! + h[1]!);
      rhs[n - 1] = 2 * (slopes[n - 2]! - slopes[n - 3]!) / (h[n - 2]! + h[n - 3]!);
    }
    for (let i = 1; i + 1 < n; i += 1) {
      lower[i] = h[i - 1]!;
      diagonal[i] = 2 * (h[i - 1]! + h[i]!);
      upper[i] = h[i]!;
      rhs[i] = 6 * (slopes[i]! - slopes[i - 1]!);
    }
    for (let i = 1; i < n; i += 1) {
      const factor = lower[i]! / diagonal[i - 1]!;
      diagonal[i] -= factor * upper[i - 1]!;
      rhs[i] -= factor * rhs[i - 1]!;
    }
    for (let i = n - 1; i >= 0; i -= 1) {
      rhs[i] = (rhs[i]! - upper[i]! * (rhs[i + 1] ?? 0)) / diagonal[i]!;
      acceleration[i]![axis] = rhs[i]!;
    }
    for (let i = 0; i + 1 < n; i += 1) {
      velocity[i]![axis] = slopes[i]! - h[i]! * (2 * rhs[i]! + rhs[i + 1]!) / 6;
    }
    velocity[n - 1]![axis] = slopes[n - 2]! + h[n - 2]! * (rhs[n - 2]! + 2 * rhs[n - 1]!) / 6;
  }
  return { velocity, acceleration };
}

export interface CameraPositionCurve {
  segments: PositionSegment[];
  sample(time: number): PositionJet;
  /** Exact polynomial restriction; must be contained in one knot interval. */
  restrict(start: number, end: number): PositionSegment;
}

export function createCameraPositionCurve(
  states: readonly CameraStateSample[], cutTimes: readonly number[],
): CameraPositionCurve {
  if (states.length === 0) throw new Error("A camera curve needs at least one state");
  for (let i = 0; i < states.length; i += 1) {
    if (!Number.isFinite(states[i]!.time) || (i > 0 && states[i]!.time <= states[i - 1]!.time)) {
      throw new Error("Camera curve timestamps must be finite and strictly increasing");
    }
  }
  const velocities = states.map(zero);
  const accelerations = states.map(zero);
  for (let first = 0; first < states.length;) {
    let last = first;
    while (last + 1 < states.length && !crossesCut(states[last]!.time, states[last + 1]!.time, cutTimes)) last += 1;
    const jets = splineJets(states, first, last);
    for (let i = first; i <= last; i += 1) {
      velocities[i] = jets.velocity[i - first]!;
      accelerations[i] = jets.acceleration[i - first]!;
    }
    // Meet the outgoing constant hold with zero first and second derivatives.
    if (last + 1 < states.length) {
      velocities[last] = zero();
      accelerations[last] = zero();
    }
    first = last + 1;
  }
  // Bound height by its adjacent knot values without clamping the sampled curve.
  // Scale both jets ONCE per knot, so adjacent quintics remain C2. The Bernstein
  // convex-hull property then bounds every point in each segment's Y interval.
  states.forEach((state, i) => {
    let factor = 1;
    for (const j of [i - 1, i + 1]) {
      if (j < 0 || j >= states.length) continue;
      if (crossesCut(Math.min(state.time, states[j]!.time), Math.max(state.time, states[j]!.time), cutTimes)) continue;
      const h = states[j]!.time - state.time;
      const lo = Math.min(state.position[1], states[j]!.position[1]) - state.position[1];
      const hi = Math.max(state.position[1], states[j]!.position[1]) - state.position[1];
      for (const offset of [h * velocities[i]![1] / 5,
        2 * h * velocities[i]![1] / 5 + h * h * accelerations[i]![1] / 20]) {
        if (offset > hi) factor = Math.min(factor, hi / offset);
        if (offset < lo) factor = Math.min(factor, lo / offset);
      }
    }
    velocities[i]![1] *= factor;
    accelerations[i]![1] *= factor;
    // Exported jets preserve the solved polynomial when replayed at another FPS.
    if (state.positionVelocity && state.positionAcceleration) {
      velocities[i] = [...state.positionVelocity];
      accelerations[i] = [...state.positionAcceleration];
    }
  });
  const segments: PositionSegment[] = states.slice(1).map((right, i) => {
    const left = states[i]!;
    const hold = crossesCut(left.time, right.time, cutTimes);
    return {
      startTime: left.time, endTime: right.time, hold,
      controls: hold ? Array.from({ length: 6 }, () => [...left.position] as Vec3)
        : quinticPositionControls(left.position, right.position, velocities[i]!, velocities[i + 1]!,
          accelerations[i]!, accelerations[i + 1]!, right.time - left.time),
    };
  });
  const segmentAt = (time: number): PositionSegment => {
    let lo = 0, hi = segments.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (segments[mid]!.endTime <= time) lo = mid + 1;
      else hi = mid;
    }
    return segments[lo]!;
  };
  return {
    segments,
    sample(time) {
      if (!Number.isFinite(time)) throw new Error("Camera sample time must be finite");
      const final = states.length - 1;
      if (states.length === 1 || time < states[0]!.time || time > states[final]!.time) {
        const i = time < states[0]!.time ? 0 : final;
        return { position: [...states[i]!.position], velocity: zero(), acceleration: zero(), jerk: zero() };
      }
      if (time === states[final]!.time && segments.at(-1)!.hold) {
        // A cut at the final knot begins a new singleton shot.
        return { position: [...states[final]!.position], velocity: zero(), acceleration: zero(), jerk: zero() };
      }
      return samplePositionSegment(segmentAt(time), time);
    },
    restrict(start, end) {
      if (!(end > start) || segments.length === 0) throw new Error("Invalid curve restriction interval");
      const segment = segmentAt((start + end) / 2);
      if (start < segment.startTime - 1e-9 || end > segment.endTime + 1e-9) {
        throw new Error("Curve restriction must not cross an optimization knot");
      }
      const a = samplePositionSegment(segment, start), b = samplePositionSegment(segment, end);
      return { startTime: start, endTime: end, hold: segment.hold,
        controls: quinticPositionControls(a.position, b.position, a.velocity, b.velocity,
          a.acceleration, b.acceleration, end - start) };
    },
  };
}

/**
 * Bernstein convex hull bounds deviation from the chord for the complete span.
 * Together with 1-Lipschitz signed distance: docs/mathematical-fixes.fa.md §3.
 */
export function positionChordDeviationBound(segment: PositionSegment): number {
  const degree = segment.controls.length - 1;
  const first = segment.controls[0]!, last = segment.controls[degree]!;
  return Math.max(...segment.controls.map((control, i) => {
    const chord = mix(first, last, i / degree);
    return Math.hypot(...control.map((value, axis) => value - chord[axis]!));
  }));
}

/** Five-point Gauss-Legendre: exact for squared quintic acceleration (degree 6). */
export const CURVE_QUADRATURE = [
  [-0.906179845938664, 0.236926885056189], [-0.538469310105683, 0.478628670499366],
  [0, 0.568888888888889], [0.538469310105683, 0.478628670499366],
  [0.906179845938664, 0.236926885056189],
] as const;
