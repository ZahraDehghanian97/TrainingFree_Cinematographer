import type { Vec3 } from "../../types/environment";
import type { CameraTrajectoryV1 } from "../../types/trajectory";
import type { CameraOptimizerInput } from "../types";
import { add3, multiplyQuat, normalizeQuat, rotate3, scale3 } from "../shared/math";

interface ScalarJet { value: number; velocity: number; acceleration: number }

function product(a: ScalarJet, b: ScalarJet): ScalarJet {
  return { value: a.value * b.value, velocity: a.velocity * b.value + a.value * b.velocity,
    acceleration: a.acceleration * b.value + 2 * a.velocity * b.velocity + a.value * b.acceleration };
}

/** Quintic entrance/exit: zero offset, speed and acceleration at action edges. */
function fade(time: number, duration: number): ScalarJet {
  const u = Math.max(0, Math.min(1, time / duration));
  return {
    value: u ** 3 * (10 - 15 * u + 6 * u * u),
    velocity: (time > 0 && time < duration) ? 30 * u * u * (1 - u) ** 2 / duration : 0,
    acceleration: (time > 0 && time < duration) ? 60 * u * (1 - u) * (1 - 2 * u) / duration ** 2 : 0,
  };
}

function noise(time: number, phase: number): ScalarJet {
  const result = { value: 0, velocity: 0, acceleration: 0 };
  for (const [frequency, amplitude, shift] of [[1.7, 0.55, 0], [2.9, 0.3, 1.3], [4.1, 0.15, 2.7]]) {
    const omega = 2 * Math.PI * frequency!;
    const angle = omega * time + phase + shift!;
    result.value += amplitude! * Math.sin(angle);
    result.velocity += amplitude! * omega * Math.cos(angle);
    result.acceleration -= amplitude! * omega * omega * Math.sin(angle);
  }
  return result;
}

/**
 * Authored handheld is a procedural rig layer on the optimized dolly/track.
 * It uses playback time (the operator does not freeze with scene time), keeps
 * the optical lens fixed, and exports position derivatives for faithful replay.
 * It is subsequently checked by the same swept collision evaluator as any path.
 */
export function applyHandheldMotion(
  trajectory: CameraTrajectoryV1, input: CameraOptimizerInput, strength = 1,
): CameraTrajectoryV1 {
  const actions = new Map<string, { start: number; end: number }>();
  for (const segment of input.timeline.timeline) {
    if (segment.kind !== "interval") continue;
    for (const loss of segment.lossFunctions) {
      if (loss.parameters.handheld !== true) continue;
      const key = loss.sourceActionId ?? `${loss.type}:${segment.startTime}`;
      const previous = actions.get(key);
      actions.set(key, { start: Math.min(previous?.start ?? Infinity, segment.startTime),
        end: Math.max(previous?.end ?? -Infinity, segment.endTime) });
    }
  }
  if (actions.size === 0 || strength === 0) return trajectory;
  const samples = trajectory.samples.map(s => ({ ...s }));
  for (const { start, end } of actions.values()) {
    const reference = trajectory.samples.reduce((best, s) => Math.abs(s.t - start) < Math.abs(best.t - start) ? s : best);
    const rotation = reference.rotation!;
    const keys = (input.userKeyframes ?? []).filter(k => (k.mode ?? "hard") === "hard" && k.time >= start && k.time <= end);
    const move = !keys.some(k => k.position !== undefined);
    const turn = !keys.some(k => k.rotation !== undefined || k.lookAt !== undefined);
    // No longitudinal pumping: the hand tremor is across the rig's image plane.
    for (const sample of samples) {
      if (sample.t < start || sample.t > end) continue;
      const edge = Math.min(0.35, (end - start) / 3);
      const entrance = fade(sample.t - start, edge);
      const exit = fade(end - sample.t, edge);
      exit.velocity *= -1;
      const envelope = product(entrance, exit);
      const x = product(envelope, noise(sample.t - start, 0.4));
      const y = product(envelope, noise(sample.t - start, 2.1));
      if (move) {
        const offset = (field: keyof ScalarJet): Vec3 => rotate3([0.028 * strength * x[field], 0.02 * strength * y[field], 0], rotation);
        sample.position = add3(sample.position, offset("value"));
        sample.positionVelocity = add3(sample.positionVelocity ?? [0, 0, 0], offset("velocity"));
        sample.positionAcceleration = add3(sample.positionAcceleration ?? [0, 0, 0], offset("acceleration"));
      }
      if (turn) {
        const tangent: Vec3 = scale3([y.value * 0.012, x.value * 0.01,
          envelope.value * noise(sample.t - start, 3.8).value * 0.006], strength);
        const angle = Math.hypot(...tangent);
        const vector = scale3(tangent, angle < 1e-10 ? 0.5 : Math.sin(angle / 2) / angle);
        sample.rotation = normalizeQuat(multiplyQuat(sample.rotation!, [...vector, Math.cos(angle / 2)]));
      }
    }
  }
  return { ...trajectory, samples };
}
