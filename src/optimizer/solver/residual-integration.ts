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

/** Weighted radial-Huber fit y_i ~ amplitude * phase_i; scalar convex problem. */
export function fitRobustAmplitude(
  observations: readonly { phase: number; lateral: number; orthogonalSquared: number; weight: number }[],
  tolerance: number,
): number {
  const active = observations.filter((item) => item.weight > 0 && Math.abs(item.phase) > 1e-12);
  if (active.length === 0) return 0;
  // The derivative has the sign of a weighted sum of A*phase-y; the optimum
  // lies within the ratios y/phase even for radial residuals and Huber tails.
  let lower = Math.min(...active.map((item) => item.lateral / item.phase));
  let upper = Math.max(...active.map((item) => item.lateral / item.phase));
  const delta = 2 * tolerance;
  for (let iteration = 0; iteration < 60 && upper - lower > 1e-10; iteration += 1) {
    const amplitude = (lower + upper) / 2;
    const derivative = active.reduce((sum, item) => {
      const difference = amplitude * item.phase - item.lateral;
      const norm = Math.sqrt(difference * difference + Math.max(0, item.orthogonalSquared));
      return sum + item.weight * item.phase * difference * (norm > delta ? delta / norm : 1);
    }, 0);
    if (derivative > 0) upper = amplitude;
    else lower = amplitude;
  }
  return (lower + upper) / 2;
}
