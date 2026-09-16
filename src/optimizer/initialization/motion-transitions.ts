import type { Quat, Vec3 } from "../../types/environment";
import type { CameraStateSample, MotionTransition, UserCameraKeyframe } from "../types";
import { angularVelocity, cubicHermite, interpolateRotationWithVelocities } from "../trajectory/interpolation";
import { crossesCut } from "../shared/time";
import { fovDegreesToLogFocal, logFocalToFovDegrees } from "../shared/lens";

/** Bridge the two motions before optimization, matching their incoming/outgoing velocities. */
export function seedMotionTransitions(
  states: CameraStateSample[],
  windows: readonly MotionTransition[],
  keyframes: readonly UserCameraKeyframe[],
  cutTimes: readonly number[],
): void {
  const original = states.map((state) => ({ ...state, position: [...state.position] as Vec3, rotation: [...state.rotation] as Quat }));
  for (const window of windows) {
    if (crossesCut(window.startTime, window.endTime, cutTimes)) continue;
    const leftIndex = original.findIndex((state) => Math.abs(state.time - window.startTime) <= 1e-8);
    const rightIndex = original.findIndex((state) => Math.abs(state.time - window.endTime) <= 1e-8);
    const middleIndex = original.findIndex((state) => Math.abs(state.time - window.boundaryTime) <= 1e-8);
    if (leftIndex < 0 || middleIndex <= leftIndex || middleIndex >= rightIndex) continue;
    const left = original[leftIndex]!;
    const right = original[rightIndex]!;
    const span = right.time - left.time;
    const before = leftIndex > 0 && !crossesCut(original[leftIndex - 1]!.time, left.time, cutTimes)
      ? original[leftIndex - 1]! : left;
    const after = rightIndex + 1 < original.length && !crossesCut(right.time, original[rightIndex + 1]!.time, cutTimes)
      ? original[rightIndex + 1]! : right;
    const leftDt = Math.max(1e-9, left.time - before.time);
    const rightDt = Math.max(1e-9, after.time - right.time);
    const leftVelocity = left.position.map((value, index) => (value - before.position[index]!) / leftDt);
    const rightVelocity = right.position.map((value, index) => (after.position[index]! - value) / rightDt);
    const leftAngular = angularVelocity(before.rotation, left.rotation, leftDt);
    const rightAngular = angularVelocity(right.rotation, after.rotation, rightDt);
    const hard = keyframes.filter((keyframe) => (keyframe.mode ?? "hard") === "hard"
      && keyframe.time > left.time + 1e-8 && keyframe.time < right.time - 1e-8);
    const positionLocked = hard.some((keyframe) => keyframe.position !== undefined);
    const rotationLocked = hard.some((keyframe) => keyframe.rotation !== undefined || keyframe.lookAt !== undefined);
    const fovLocked = hard.some((keyframe) => keyframe.fovYDegrees !== undefined);
    // Preserve a zoom reversal's authored extremum instead of bridging straight
    // across equal FOV endpoints and erasing the zoom at the handoff.
    const middle = original[middleIndex]!;
    const fovKnots = [left, middle, right];
    // Work in log focal length, so magnification composes consistently with
    // the zoom objective, seed steps, and final trajectory interpolation.
    const focalAt = (state: CameraStateSample): number => fovDegreesToLogFocal(state.fovYDegrees);
    const fovSlopes = [
      (focalAt(middle) - focalAt(left)) / (middle.time - left.time),
      (focalAt(right) - focalAt(middle)) / (right.time - middle.time),
    ];
    const fovRates = [
      (focalAt(left) - focalAt(before)) / leftDt,
      fovSlopes[0]! * fovSlopes[1]! <= 0 ? 0 : 2 / (1 / fovSlopes[0]! + 1 / fovSlopes[1]!),
      (focalAt(after) - focalAt(right)) / rightDt,
    ];
    for (let segment = 0; segment < 2; segment += 1) {
      const slope = fovSlopes[segment]!;
      for (const knot of [segment, segment + 1]) {
        if (fovRates[knot]! * slope <= 0) fovRates[knot] = 0;
      }
      if (Math.abs(slope) <= 1e-12) continue;
      const norm = Math.hypot(fovRates[segment]! / slope, fovRates[segment + 1]! / slope);
      if (norm > 3) { fovRates[segment]! *= 3 / norm; fovRates[segment + 1]! *= 3 / norm; }
    }
    for (let index = leftIndex + 1; index < rightIndex; index += 1) {
      const state = states[index]!;
      const alpha = (state.time - left.time) / span;
      if (!positionLocked) state.position = left.position.map((value, component) => cubicHermite(
        value, right.position[component]!, leftVelocity[component]!, rightVelocity[component]!, span, alpha,
      )) as Vec3;
      if (!rotationLocked) state.rotation = interpolateRotationWithVelocities(
        left.rotation, right.rotation, leftAngular, rightAngular, span, alpha,
      );
      if (!fovLocked) {
        const segment = state.time <= middle.time ? 0 : 1;
        const a = fovKnots[segment]!, b = fovKnots[segment + 1]!;
        state.fovYDegrees = state.time === middle.time ? middle.fovYDegrees
          : logFocalToFovDegrees(cubicHermite(focalAt(a), focalAt(b), fovRates[segment]!, fovRates[segment + 1]!,
            b.time - a.time, (state.time - a.time) / (b.time - a.time)));
      }
    }
  }
}
