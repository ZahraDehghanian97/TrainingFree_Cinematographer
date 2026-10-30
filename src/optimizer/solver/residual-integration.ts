/**
 * Trapezoidal integration weights, with constant extension from the first/last
 * residual to its support boundary (needed for derivative stencils). Duplicate
 * times share their cell's measure; adding a knot cannot duplicate a penalty.
 */
export function temporalQuadratureWeights(
  times: readonly number[],
  start: number,
  end: number,
): number[] {
  if (times.length === 0) return [];
  if (end - start <= 1e-12) return times.map(() => 1 / times.length);
  const groups = new Map<number, number[]>();
  times.forEach((time, index) => {
    const t = Math.max(start, Math.min(end, time));
    const indices = groups.get(t) ?? [];
    indices.push(index);
    groups.set(t, indices);
  });
  const knots = [...groups.keys()].sort((a, b) => a - b);
  const weights = times.map(() => 0);
  knots.forEach((time, knot) => {
    const left = knot === 0 ? start : (knots[knot - 1]! + time) / 2;
    const right = knot + 1 === knots.length ? end : (time + knots[knot + 1]!) / 2;
    const indices = groups.get(time)!;
    for (const index of indices) weights[index] = Math.max(0, right - left) / indices.length;
  });
  return weights;
}

interface AmplitudeObservation {
  phase: number;
  lateral: number;
  orthogonalSquared: number;
  /** Includes temporal measure, activation, and relative primitive weight. */
  weight: number;
  tolerance?: number;
}

interface MinimumBendPenalty {
  amplitude: number;
  weight: number;
  tolerance?: number;
}

/**
 * Eliminate the shared curve amplitude from its COMPLETE objective:
 * sum_i w_i Huber(hypot(A*phase_i-y_i, b_i) / sigma_i)
 * + sum_j v_j Huber(max(0, minimum_j-|A|) / sigma_j).
 * The absolute-value floor is nonconvex across zero. Each sign branch A=+/-a,
 * a>=0 is convex, so solve both monotone derivatives and compare their costs.
 */
export function fitRobustAmplitude(
  observations: readonly AmplitudeObservation[],
  tolerance: number,
  minimumBends: readonly MinimumBendPenalty[] = [],
): number {
  const active = observations.filter((item) => item.weight > 0 && Math.abs(item.phase) > 1e-12);
  const floors = minimumBends.filter((item) => item.weight > 0 && item.amplitude > 0);
  const scale = (item: { tolerance?: number }): number => Math.max(1e-12, item.tolerance ?? tolerance);
  const cost = (amplitude: number): number => {
    const huber = (value: number): number => value <= 2 ? 0.5 * value * value : 2 * (value - 1);
    return active.reduce((sum, item) => sum + item.weight * huber(Math.hypot(
      amplitude * item.phase - item.lateral, Math.sqrt(Math.max(0, item.orthogonalSquared)),
    ) / scale(item)), 0) + floors.reduce((sum, item) => sum + item.weight * huber(
      Math.max(0, item.amplitude - Math.abs(amplitude)) / scale(item),
    ), 0);
  };
  const solveBranch = (sign: number): number => {
    const derivative = (magnitude: number): number => active.reduce((sum, item) => {
      const sigma = scale(item);
      const difference = sign * magnitude * item.phase - item.lateral;
      const norm = Math.hypot(difference, Math.sqrt(Math.max(0, item.orthogonalSquared)));
      return sum + item.weight * sign * item.phase * difference
        * (norm > 2 * sigma ? 2 * sigma / norm : 1) / (sigma * sigma);
    }, 0) - floors.reduce((sum, item) => {
      const sigma = scale(item);
      return sum + item.weight * Math.min(Math.max(0, item.amplitude - magnitude), 2 * sigma)
        / (sigma * sigma);
    }, 0);
    if (derivative(0) >= 0) return 0;
    // Beyond all projected data ratios and all floors every derivative is
    // nonnegative; this provides a finite analytical bracket on each branch.
    let lower = 0;
    let upper = Math.max(0, ...active.map((item) => sign * item.lateral / item.phase),
      ...floors.map((item) => item.amplitude));
    for (let iteration = 0; iteration < 70 && upper - lower > 1e-12 * Math.max(1, upper); iteration += 1) {
      const midpoint = (lower + upper) / 2;
      if (derivative(midpoint) >= 0) upper = midpoint;
      else lower = midpoint;
    }
    return sign * (lower + upper) / 2;
  };
  const positive = solveBranch(1);
  const negative = solveBranch(-1);
  // A deterministic positive tie-break retains the initialization convention.
  return cost(negative) < cost(positive) ? negative : positive;
}
