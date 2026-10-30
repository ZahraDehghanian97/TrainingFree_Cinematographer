import type { Vec3 } from "../../types/environment";
import { samplePrimitiveSubject } from "../scene/primitive-context";
import { add3, cameraForward, cameraRight, dot3, normalize3, scale3, sub3, signedAngleAround } from "../shared/math";
import { motionProgress } from "../shared/motion-profiles";
import { createSpiralPacing } from "../shared/spiral-pacing";
import { applyOpticalZoom, interpolateFovLogFocal } from "../shared/lens";
import { asQuat } from "../shared/parameter-values";
import { applyHardKeyframesToState, hardKeyframesAtTime } from "../shared/keyframes";
import { createCameraPositionCurve } from "../trajectory/position-curve";
import type { CameraOptimizerInput, CameraStateSample, CompiledLossPlan, PrimitiveLoss } from "../types";

const ORDER: Partial<Record<PrimitiveLoss["type"], number>> = {
  orientationHold: -1,
  orthogonalDrift: 0, stepPacing: 1, angularPacing: 2,
  radiusHold: 3, radiusSchedule: 3, distanceHold: 3, planeHold: 4,
  relativeOffsetHold: 5, positionHold: 5, fovHold: 6, intrinsicsPacing: 7,
};

/**
 * Optimize a rig's free origin, radius, sweep and lens without independent
 * knot drift changing its movement class. Only surviving compiled contracts
 * participate: compound-motion conflict resolution has already released the
 * incompatible holds. Composition and collision remain evaluated on the
 * resulting path, so this is a parameterization, never an export-time repair.
 */
export function createMotionManifold(
  input: CameraOptimizerInput, plan: CompiledLossPlan, times: readonly number[],
): (states: CameraStateSample[]) => void {
  const cuts = [...new Set([
    ...(input.timeline.cutTimes ?? []),
    ...(input.userKeyframes ?? []).filter(key => key.cutBefore).map(key => key.time),
  ])].sort((a, b) => a - b);
  const shotStarts = [times[0]!, ...cuts.filter(cut => cut > times[0]! + 1e-9
    && cut <= times[times.length - 1]! + 1e-9)];
  const nearest = (time: number): number => times.reduce((best, value, index) =>
    Math.abs(value - time) < Math.abs(times[best]! - time) ? index : best, 0);
  const entries = plan.primitives.filter(p => p.weight > 0 && ORDER[p.type] !== undefined
    && (p.type !== "orientationHold" || p.role === "primary")
    && p.endTime > p.startTime && p.parameters.pointTime === undefined)
    .flatMap(p => shotStarts.flatMap((shotStart, shotIndex) => {
      const shotEnd = shotStarts[shotIndex + 1];
      if (p.endTime <= shotStart + 1e-9 || (shotEnd !== undefined && p.startTime >= shotEnd - 1e-9)) return [];
      const indices = times.flatMap((time, i) => time >= Math.max(p.startTime, shotStart) - 1e-9
        && time <= p.endTime + 1e-9 && (shotEnd === undefined || time < shotEnd - 1e-9) ? [i] : []);
      if (indices.length === 0) return [];
      const start = Number(p.parameters.motionStartTime ?? p.parameters.referenceTime ?? p.startTime);
      const end = Number(p.parameters.motionEndTime ?? p.endTime);
      const reference = nearest(Math.max(shotStart, Number(p.parameters.referenceTime ?? start)));
      // A hard pose at the reference is the rig's origin. A later hard pose
      // can contradict that rig, so retain soft losses for this shot instead.
      const lens = p.type === "fovHold" || p.type === "intrinsicsPacing";
      const orientation = p.type === "orientationHold";
      const fixedReferenceRadius = (p.type === "radiusHold" && typeof p.parameters.targetRadius === "number")
        || (p.type === "distanceHold" && typeof (p.parameters.distance ?? p.parameters.targetDistance) === "number");
      if ((input.userKeyframes ?? []).some(key => (key.mode ?? "hard") === "hard"
        && key.time >= times[reference]! - 1e-9 && key.time <= p.endTime + 1e-9
        && (shotEnd === undefined || key.time < shotEnd - 1e-9)
        && (lens ? key.fovYDegrees !== undefined : orientation
          ? key.rotation !== undefined || key.lookAt !== undefined : key.position !== undefined)
        && (key.time > times[reference]! + 1e-9 || fixedReferenceRadius))) return [];
      const first = nearest(Math.max(start, shotStart));
      const last = times.reduce((best, time, i) => time >= times[first]! - 1e-9 && time <= end + 1e-9
        && (shotEnd === undefined || time < shotEnd - 1e-9) ? i : best, first);
      const centers = times.map(time => samplePrimitiveSubject(input, p, time)?.center);
      // A tripod/mounted hold starting at an explicit numeric camera pose
      // inherits that authored direction. Allowing its free origin to rotate
      // would also rotate the axis of a subsequent camera-forward dolly.
      const referenceRotation = p.type === "orientationHold"
        && !hardKeyframesAtTime(input.userKeyframes ?? [], times[reference]!)
          .some(key => key.rotation !== undefined || key.lookAt !== undefined)
        ? asQuat(plan.primitives.find(anchor => anchor.type === "rotationAnchor"
          && anchor.weight > 0 && !anchor.parameters.easing
          && Math.abs(Number(anchor.parameters.pointTime) - times[reference]!) < 1e-9)?.parameters.target)
        : undefined;
      const referenceFov = p.type === "fovHold"
        && !hardKeyframesAtTime(input.userKeyframes ?? [], times[reference]!)
          .some(key => key.fovYDegrees !== undefined)
        ? plan.primitives.find(anchor => anchor.type === "fovAnchor"
          && anchor.weight > 0 && !anchor.parameters.easing
          && Math.abs(Number(anchor.parameters.pointTime) - times[reference]!) < 1e-9)?.parameters.target
        : undefined;
      return [{ p, start, end, reference, first, last, indices, centers, shotStart, referenceRotation, referenceFov }];
    })).sort((a, b) => a.shotStart - b.shotStart || a.p.startTime - b.p.startTime || ORDER[a.p.type]! - ORDER[b.p.type]!);

  const referenceCurves = new Map<string, ReturnType<typeof createCameraPositionCurve>>();
  const rigidEntries = entries.filter(({ p }) => p.type === "orthogonalDrift"
    || p.type === "relativeOffsetHold" || p.type === "positionHold").map(entry => {
    const key = JSON.stringify(entry.centers);
    let curve = referenceCurves.get(key);
    if (!curve) {
      curve = createCameraPositionCurve(times.map((time, i) => ({ time,
        position: entry.centers[i] ?? [0, 0, 0], rotation: [0, 0, 0, 1], fovYDegrees: 50,
      })), cuts);
      referenceCurves.set(key, curve);
    }
    return { ...entry, referenceJets: entry.indices.map(i => curve!.sample(times[i]!)) };
  });

  return states => {
    // Locked origins must drive the whole rig on the first decode as well;
    // applying keys only afterward would leave its other knots on a stale
    // template direction or lens until a second projection.
    for (const state of states) applyHardKeyframesToState(state, hardKeyframesAtTime(input.userKeyframes ?? [], state.time));
    for (const { p, start, end, reference, first, last, indices, centers, referenceRotation, referenceFov } of entries) {
      const params = p.parameters;
      const origin = states[reference]!;
      const center = centers[reference];
      const initialOffset = center ? sub3(origin.position, center) : origin.position;
      const startOffset = centers[first] ? sub3(states[first]!.position, centers[first]!) : states[first]!.position;
      const endOffset = centers[last] ? sub3(states[last]!.position, centers[last]!) : states[last]!.position;
      const sourceProgress = (i: number) => motionProgress((times[i]! - start) / Math.max(1e-9, end - start), params.speedKeyframes);
      const initialProgress = sourceProgress(first);
      const remainingProgress = Math.max(1e-9, sourceProgress(last) - initialProgress);
      // A cut resets the rig pose, but the action keeps its original pacing
      // clock and remaining authored displacement instead of jumping back to
      // the pre-cut origin on the very next frame.
      const progress = (i: number) => sourceProgress(i) - initialProgress;
      const freeSweep = p.type === "angularPacing" && params.mode === "orbit"
        && typeof (params.fullTargetDelta ?? params.targetDelta) !== "number"
        ? times.slice(first + 1, last + 1).reduce((sum, _time, local) => {
          const i = first + local + 1;
          return centers[i - 1] && centers[i] ? sum + signedAngleAround(
            sub3(states[i - 1]!.position, centers[i - 1]!),
            sub3(states[i]!.position, centers[i]!), [0, 1, 0]) : sum;
        }, 0) / remainingProgress : undefined;
      const axis = params.axis === "worldUp" ? [0, 1, 0] as Vec3
        : params.axis === "cameraRight" ? cameraRight(origin.rotation)
          : params.axis === "towardSubject" && center ? normalize3(sub3(center, origin.position))
            : cameraForward(origin.rotation);
      const startFov = states[first]!.fovYDegrees;
      const factor = params.fullFactor ?? params.factor;
      const endFov = typeof factor === "number" ? applyOpticalZoom(startFov, factor, params.direction === "in" ? "in" : "out")
        : states[last]!.fovYDegrees;
      if (p.type === "intrinsicsPacing" && typeof factor === "number") {
        const finalFov = applyOpticalZoom(startFov, factor,
          params.direction === "in" ? "in" : "out", remainingProgress);
        // The numerical codec bounds free lenses to 8–120 degrees. A factor
        // that does not fit the current starting lens remains a soft target;
        // retraction must not undo those bounds after the codec applies them.
        if (Math.min(startFov, finalFov) < 8 - 1e-9 || Math.max(startFov, finalFov) > 120 + 1e-9) {
          const maximumLogRatio = Math.log(Math.tan(Math.PI / 3) / Math.tan(Math.PI / 45));
          if (Math.abs(Math.log(factor)) * remainingProgress > maximumLogRatio + 1e-9) {
            const warning = `Optical zoom on ${times[first]}-${times[last]}s exceeds the 8–120 degree lens range; its factor remains a soft target`;
            if (!plan.warnings.includes(warning)) plan.warnings.push(warning);
          }
          continue;
        }
      }
      const arc = params.constantSpeed === true && p.type === "radiusSchedule"
        ? plan.primitives.find(candidate => candidate.type === "angularPacing"
          && candidate.sourceActionId === p.sourceActionId
          && candidate.parameters.motionStartTime === params.motionStartTime
          && candidate.parameters.motionEndTime === params.motionEndTime) : undefined;
      const sweep = arc?.parameters.fullTargetDelta ?? arc?.parameters.targetDelta;
      const spiralEnd = typeof params.deltaRadius === "number"
        ? scale3(normalize3(endOffset), Math.max(1e-4, Math.hypot(...startOffset) + params.deltaRadius * remainingProgress))
        : endOffset;
      const spiral = typeof sweep === "number" ? createSpiralPacing(startOffset, spiralEnd, sweep * remainingProgress) : undefined;
      for (const i of indices) {
        const state = states[i]!;
        const subject = centers[i];
        let offset = subject ? sub3(state.position, subject) : state.position;
        switch (p.type) {
          case "orientationHold":
            state.rotation = [...(referenceRotation ?? origin.rotation)];
            continue;
          case "orthogonalDrift": {
            const displacement = sub3(offset, initialOffset);
            offset = add3(initialOffset, scale3(axis, dot3(displacement, axis)));
            break;
          }
          case "stepPacing": {
            // A supplied speed profile owns only its axial progress, leaving
            // concurrently authored lateral movement available to other rigs.
            if (params.speedKeyframes === undefined) continue;
            const distance = params.fullTargetDistance ?? params.targetDistance;
            const total = typeof distance === "number" ? Number(params.sign ?? 1) * distance
              : dot3(sub3(endOffset, startOffset), axis) / remainingProgress;
            const displacement = sub3(offset, startOffset);
            offset = add3(offset, scale3(axis, total * progress(i) - dot3(displacement, axis)));
            break;
          }
          case "angularPacing": {
            if (params.mode !== "orbit" || params.speedKeyframes === undefined || !subject) continue;
            const delta = params.fullTargetDelta ?? params.targetDelta ?? freeSweep;
            if (typeof delta !== "number") continue;
            const angle = Math.atan2(startOffset[0], startOffset[2]) + delta * progress(i);
            const radius = Math.hypot(offset[0], offset[2]);
            offset = [radius * Math.sin(angle), offset[1], radius * Math.cos(angle)];
            break;
          }
          case "radiusHold": {
            if (!subject) continue;
            const radius = typeof params.targetRadius === "number" ? params.targetRadius : Math.hypot(startOffset[0], startOffset[2]);
            const radial = normalize3([offset[0], 0, offset[2]], normalize3([startOffset[0], 0, startOffset[2]], [0, 0, 1]));
            offset = [radial[0] * radius, offset[1], radial[2] * radius];
            break;
          }
          case "radiusSchedule": {
            if (!subject || params.speedKeyframes === undefined) continue;
            if (spiral) {
              offset = spiral.offset(spiral.phase((times[i]! - times[first]!) / Math.max(1e-9, times[last]! - times[first]!)));
              break;
            }
            const radius = (v: Vec3) => params.radiusMetric === "distance" ? Math.hypot(...v) : Math.hypot(v[0], v[2]);
            const initial = radius(startOffset);
            const delta = typeof params.deltaRadius === "number" ? params.deltaRadius
              : (radius(endOffset) - initial) / remainingProgress;
            const target = Math.max(1e-4, initial + delta * progress(i));
            if (params.radiusMetric === "distance") offset = scale3(normalize3(offset, normalize3(startOffset)), target);
            else {
              const radial = normalize3([offset[0], 0, offset[2]], [0, 0, 1]);
              offset = [radial[0] * target, offset[1], radial[2] * target];
            }
            break;
          }
          case "distanceHold": {
            if (!subject) continue;
            const requested = params.distance ?? params.targetDistance;
            const radius = typeof requested === "number" ? requested : Math.hypot(...initialOffset);
            offset = scale3(normalize3(offset, normalize3(initialOffset)), radius);
            break;
          }
          case "planeHold":
            if (!subject || params.plane === "cameraMovement") continue;
            offset = [offset[0], initialOffset[1], offset[2]];
            break;
          case "relativeOffsetHold":
            if (!subject) continue;
            offset = [...initialOffset];
            break;
          case "positionHold":
            state.position = [...origin.position];
            continue;
          case "fovHold":
            state.fovYDegrees = typeof referenceFov === "number" && referenceFov >= 8 && referenceFov <= 120
              ? referenceFov : origin.fovYDegrees;
            continue;
          case "intrinsicsPacing":
            if (params.speedKeyframes !== undefined) state.fovYDegrees = interpolateFovLogFocal(startFov, endFov,
              typeof factor === "number" ? progress(i) : progress(i) / remainingProgress);
            continue;
          default: continue;
        }
        state.position = subject ? add3(subject, offset) : [...offset];
      }
    }
    for (const state of states) applyHardKeyframesToState(state, hardKeyframesAtTime(input.userKeyframes ?? [], state.time));
    // A shared unconstrained spline can ring sideways for several frames after
    // an arc ends, even when every following knot lies on the exact same line.
    // Constrain its jets as well as its positions. Both neighboring segments
    // use these same jets, retaining C2 while preventing that tail wobble.
    for (const state of states) {
      delete state.positionVelocity;
      delete state.positionAcceleration;
    }
    if (rigidEntries.length > 0) {
      const base = createCameraPositionCurve(states, cuts);
      for (const { p, reference, centers, indices, referenceJets } of rigidEntries) {
        const origin = states[reference]!;
        const center = centers[reference];
        const axis = p.parameters.axis === "worldUp" ? [0, 1, 0] as Vec3
          : p.parameters.axis === "cameraRight" ? cameraRight(origin.rotation)
            : p.parameters.axis === "towardSubject" && center ? normalize3(sub3(center, origin.position))
              : cameraForward(origin.rotation);
        indices.forEach((i, local) => {
          const camera = base.sample(times[i]!), subject = referenceJets[local]!;
          const derivative = (channel: "velocity" | "acceleration"): Vec3 => {
            if (p.type === "positionHold") return [0, 0, 0];
            if (p.type === "relativeOffsetHold") return [...subject[channel]];
            return add3(subject[channel], scale3(axis, dot3(sub3(camera[channel], subject[channel]), axis)));
          };
          states[i]!.positionVelocity = derivative("velocity");
          states[i]!.positionAcceleration = derivative("acceleration");
        });
      }
    }
  };
}
