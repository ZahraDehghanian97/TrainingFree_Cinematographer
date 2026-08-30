import type { Quat, Vec3 } from "../../types/environment";
import { getPointConstraintWeight } from "../../timeline/easing";
import {
  add3,
  applyCameraYawPitchRoll,
  cameraForward,
  cameraRight,
  clamp,
  length3,
  lookAtQuaternion,
  multiplyQuat,
  normalize3,
  quatFromAxisAngle,
  rotateAroundAxis,
  scale3,
  sub3,
  pitchFromQuaternion,
  yawFromQuaternion,
} from "../shared/math";
import { motionProgress, motionProgressDelta } from "../shared/motion-profiles";
import {
  isPrimitiveActiveAt,
  samplePrimitiveSubject,
} from "../scene/primitive-context";
import { subjectIdsFromParameters } from "../shared/parameter-values";
import type {
  CameraOptimizerInput,
  CameraStateSample,
  CompiledLossPlan,
  PrimitiveLoss,
} from "../types";
import { projectWorldPoint } from "../scene/projection";

function subjectMotionPrimitive(
  active: readonly PrimitiveLoss[],
): PrimitiveLoss | undefined {
  const hasSubject = (primitive: PrimitiveLoss): boolean =>
    subjectIdsFromParameters(primitive.parameters).length > 0;
  return active.find((primitive) =>
    primitive.type === "relativeOffsetHold" && hasSubject(primitive),
  ) ?? active.find((primitive) =>
    primitive.type === "velocityMatch"
    && primitive.parameters.speedKeyframes !== undefined
    && hasSubject(primitive),
  ) ?? active.find((primitive) =>
    primitive.type === "angularProgress"
    && primitive.parameters.mode === "orbit"
    && hasSubject(primitive),
  ) ?? active.find((primitive) =>
    primitive.type === "totalProgressTarget" && hasSubject(primitive),
  ) ?? active.find((primitive) =>
    primitive.type === "velocityMatch" && hasSubject(primitive),
  );
}

function carrySubjectTranslation(
  state: CameraStateSample,
  input: CameraOptimizerInput,
  primitive: PrimitiveLoss,
  previousTime: number,
): void {
  const before = samplePrimitiveSubject(input, primitive, previousTime);
  const after = samplePrimitiveSubject(input, primitive, state.time);
  if (before && after) {
    if (primitive.type !== "velocityMatch") {
      state.position = add3(state.position, sub3(after.center, before.center));
      return;
    }
    const motionStartTime = typeof primitive.parameters.motionStartTime === "number"
      ? primitive.parameters.motionStartTime
      : primitive.startTime;
    const motionEndTime = typeof primitive.parameters.motionEndTime === "number"
      ? primitive.parameters.motionEndTime
      : primitive.endTime;
    const duration = Math.max(1e-9, motionEndTime - motionStartTime);
    const linearDelta = Math.max(1e-9, (state.time - previousTime) / duration);
    const profiledDelta = motionProgressDelta(
      previousTime,
      state.time,
      motionStartTime,
      motionEndTime,
      primitive.parameters.speedKeyframes,
    );
    state.position = add3(
      state.position,
      scale3(sub3(after.center, before.center), profiledDelta / linearDelta),
    );
  }
}

function applyOrbitSteps(
  state: CameraStateSample,
  previous: CameraStateSample,
  input: CameraOptimizerInput,
  active: readonly PrimitiveLoss[],
  initialOrbitRadii: Map<string, number>,
): void {
  for (const primitive of active.filter((item) =>
    item.type === "angularProgress" && item.parameters.mode === "orbit",
  )) {
    const targetDelta = typeof primitive.parameters.fullTargetDelta === "number"
      ? primitive.parameters.fullTargetDelta
      : typeof primitive.parameters.targetDelta === "number"
        ? primitive.parameters.targetDelta
      : 0;
    const motionStartTime = typeof primitive.parameters.motionStartTime === "number"
      ? primitive.parameters.motionStartTime
      : primitive.startTime;
    const motionEndTime = typeof primitive.parameters.motionEndTime === "number"
      ? primitive.parameters.motionEndTime
      : primitive.endTime;
    const target = samplePrimitiveSubject(input, primitive, state.time);
    if (!target) continue;
    const angleStep = targetDelta * motionProgressDelta(
      previous.time,
      state.time,
      motionStartTime,
      motionEndTime,
      primitive.parameters.speedKeyframes,
    );
    state.position = rotateAroundAxis(
      state.position,
      target.center,
      [0, 1, 0],
      angleStep,
    );

    const orbitSubjectKey = subjectIdsFromParameters(primitive.parameters).join("|");
    const radiusPrimitive = active.find((candidate) =>
      (candidate.type === "radiusHold" || candidate.type === "radiusSchedule")
      && subjectIdsFromParameters(candidate.parameters).join("|") === orbitSubjectKey,
    );
    if (!radiusPrimitive) continue;

    const previousTarget = samplePrimitiveSubject(input, radiusPrimitive, previous.time)
      ?? target;
    const radiusScheduleKey = typeof radiusPrimitive.parameters.scheduleKey === "string"
      ? radiusPrimitive.parameters.scheduleKey
      : `${radiusPrimitive.sourceActionId ?? radiusPrimitive.id}:${orbitSubjectKey}`;
    let initialRadius = initialOrbitRadii.get(radiusScheduleKey);
    if (initialRadius === undefined) {
      initialRadius = Math.hypot(
        previous.position[0] - previousTarget.center[0],
        previous.position[2] - previousTarget.center[2],
      );
      initialOrbitRadii.set(radiusScheduleKey, initialRadius);
    }

    const radial = sub3(state.position, target.center);
    const horizontal: Vec3 = [radial[0], 0, radial[2]];
    const requested = radiusPrimitive.parameters.targetRadius;
    const targetRadius = radiusPrimitive.type === "radiusSchedule"
      ? Math.max(
          0.2,
          initialRadius + (
            typeof radiusPrimitive.parameters.deltaRadius === "number"
              ? radiusPrimitive.parameters.deltaRadius
              : 0
          ),
        )
      : typeof requested === "number"
        ? requested
        : initialRadius;
    const radiusStartTime = typeof radiusPrimitive.parameters.motionStartTime === "number"
      ? radiusPrimitive.parameters.motionStartTime
      : radiusPrimitive.startTime;
    const radiusEndTime = typeof radiusPrimitive.parameters.motionEndTime === "number"
      ? radiusPrimitive.parameters.motionEndTime
      : radiusPrimitive.endTime;
    const duration = Math.max(1e-9, radiusEndTime - radiusStartTime);
    const progress = motionProgress(
      (state.time - radiusStartTime) / duration,
      radiusPrimitive.parameters.speedKeyframes,
    );
    const desiredRadius = initialRadius + (targetRadius - initialRadius) * progress;
    const direction = normalize3(horizontal, [0, 0, 1]);
    state.position = [
      target.center[0] + direction[0] * desiredRadius,
      state.position[1],
      target.center[2] + direction[2] * desiredRadius,
    ];
  }
}

function translationAxis(
  primitive: PrimitiveLoss,
  input: CameraOptimizerInput,
  previous: CameraStateSample,
  state: CameraStateSample,
  midpoint: number,
  fixedAxes: Map<string, Vec3>,
): Vec3 {
  switch (primitive.parameters.axis) {
    case "worldUp": return [0, 1, 0];
    case "towardSubject": {
      const target = samplePrimitiveSubject(input, primitive, midpoint);
      return target
        ? normalize3(sub3(target.center, state.position))
        : cameraForward(previous.rotation);
    }
    default: {
      const axisKey = `${primitive.sourceActionId ?? primitive.id}:${String(primitive.parameters.axis)}`;
      const cached = fixedAxes.get(axisKey);
      if (cached) return cached;
      const axis = primitive.parameters.axis === "cameraRight"
        ? cameraRight(previous.rotation)
        : cameraForward(previous.rotation);
      fixedAxes.set(axisKey, axis);
      return axis;
    }
  }
}

function applyPathShape(
  state: CameraStateSample,
  previous: CameraStateSample,
  primitive: PrimitiveLoss,
  axis: Vec3,
  distance: number,
): void {
  if (primitive.parameters.path !== "curved" && primitive.parameters.path !== "spline") {
    return;
  }

  let lateral = cameraRight(previous.rotation);
  const alignment = axis[0] * lateral[0] + axis[1] * lateral[1] + axis[2] * lateral[2];
  if (Math.abs(alignment) > 0.9) lateral = [0, 1, 0];
  const lateralAlignment = axis[0] * lateral[0]
    + axis[1] * lateral[1]
    + axis[2] * lateral[2];
  lateral = normalize3(
    sub3(lateral, scale3(axis, lateralAlignment)),
    [0, 1, 0],
  );
  const intensity = typeof primitive.parameters.curveIntensity === "number"
    ? clamp(primitive.parameters.curveIntensity / 10, 0, 1)
    : 0.5;
  const amplitude = distance * 0.25 * intensity;
  const motionStartTime = typeof primitive.parameters.motionStartTime === "number"
    ? primitive.parameters.motionStartTime
    : primitive.startTime;
  const motionEndTime = typeof primitive.parameters.motionEndTime === "number"
    ? primitive.parameters.motionEndTime
    : primitive.endTime;
  const duration = Math.max(1e-9, motionEndTime - motionStartTime);
  const previousProgress = motionProgress(
    (previous.time - motionStartTime) / duration,
    primitive.parameters.speedKeyframes,
  );
  const currentProgress = motionProgress(
    (state.time - motionStartTime) / duration,
    primitive.parameters.speedKeyframes,
  );
  const shape = (progress: number): number => primitive.parameters.path === "spline"
    ? Math.sin(2 * Math.PI * progress)
    : Math.sin(Math.PI * progress);
  state.position = add3(
    state.position,
    scale3(lateral, amplitude * (shape(currentProgress) - shape(previousProgress))),
  );
}

function applyTranslationSteps(
  state: CameraStateSample,
  previous: CameraStateSample,
  input: CameraOptimizerInput,
  active: readonly PrimitiveLoss[],
  midpoint: number,
  fixedAxes: Map<string, Vec3>,
): void {
  for (const primitive of active.filter((item) => item.type === "totalProgressTarget")) {
    const distance = typeof primitive.parameters.fullTargetDistance === "number"
      ? primitive.parameters.fullTargetDistance
      : typeof primitive.parameters.targetDistance === "number"
        ? primitive.parameters.targetDistance
      : 0;
    const sign = typeof primitive.parameters.sign === "number" ? primitive.parameters.sign : 1;
    const axis = translationAxis(
      primitive,
      input,
      previous,
      state,
      midpoint,
      fixedAxes,
    );
    const motionStartTime = typeof primitive.parameters.motionStartTime === "number"
      ? primitive.parameters.motionStartTime
      : primitive.startTime;
    const motionEndTime = typeof primitive.parameters.motionEndTime === "number"
      ? primitive.parameters.motionEndTime
      : primitive.endTime;
    const progressDelta = motionProgressDelta(
      previous.time,
      state.time,
      motionStartTime,
      motionEndTime,
      primitive.parameters.speedKeyframes,
    );
    state.position = add3(state.position, scale3(axis, sign * distance * progressDelta));
    applyPathShape(state, previous, primitive, axis, distance);
  }
}

function applyRotationSteps(
  state: CameraStateSample,
  previous: CameraStateSample,
  active: readonly PrimitiveLoss[],
): void {
  for (const primitive of active.filter((item) =>
    item.type === "angularProgress" && item.parameters.mode !== "orbit",
  )) {
    const delta = typeof primitive.parameters.targetDelta === "number"
      ? primitive.parameters.targetDelta * motionProgressDelta(
          previous.time,
          state.time,
          primitive.startTime,
          primitive.endTime,
          primitive.parameters.speedKeyframes,
        )
      : 0;
    state.rotation = primitive.parameters.mode === "pitch"
      ? applyCameraYawPitchRoll(state.rotation, 0, delta, 0)
      : applyCameraYawPitchRoll(state.rotation, delta, 0, 0);
  }

  for (const primitive of active.filter((item) => item.type === "rollProgress")) {
    const delta = typeof primitive.parameters.targetDelta === "number"
      ? primitive.parameters.targetDelta * motionProgressDelta(
          previous.time,
          state.time,
          primitive.startTime,
          primitive.endTime,
          primitive.parameters.speedKeyframes,
        )
      : 0;
    state.rotation = multiplyQuat(
      quatFromAxisAngle(cameraForward(state.rotation), delta),
      state.rotation,
    );
  }
}

function applyZoomStep(
  state: CameraStateSample,
  previous: CameraStateSample,
  active: readonly PrimitiveLoss[],
): void {
  const zoom = active.find((primitive) => primitive.type === "intrinsicsProgress");
  if (!zoom) return;
  const factor = typeof zoom.parameters.factor === "number" ? zoom.parameters.factor : 1;
  const stepFactor = Math.pow(factor, motionProgressDelta(
    previous.time,
    state.time,
    zoom.startTime,
    zoom.endTime,
    zoom.parameters.speedKeyframes,
  ));
  state.fovYDegrees = clamp(
    zoom.parameters.direction === "in"
      ? state.fovYDegrees / stepFactor
      : state.fovYDegrees * stepFactor,
    8,
    120,
  );
}

function levelOrientationForScreenTarget(
  state: CameraStateSample,
  target: Vec3,
  desired: readonly number[],
  aspectRatio: number,
): Quat {
  const centered = lookAtQuaternion(state.position, target);
  let yaw = yawFromQuaternion(centered);
  let pitch = pitchFromQuaternion(centered);
  const orientation = (candidateYaw: number, candidatePitch: number): Quat => {
    const cosine = Math.cos(candidatePitch);
    const forward: Vec3 = [
      -Math.sin(candidateYaw) * cosine,
      Math.sin(candidatePitch),
      -Math.cos(candidateYaw) * cosine,
    ];
    return lookAtQuaternion(state.position, add3(state.position, forward));
  };

  // Solve the two off-axis projection coordinates while rebuilding the
  // orientation through lookAtQuaternion each time. This preserves a level
  // world-up horizon, unlike composing a local off-axis quaternion at a
  // pitched camera.
  for (let iteration = 0; iteration < 7; iteration += 1) {
    const current = orientation(yaw, pitch);
    const projected = projectWorldPoint(
      target,
      state.position,
      current,
      state.fovYDegrees,
      aspectRatio,
    );
    const errorX = Number(desired[0]) - projected.x;
    const errorY = Number(desired[1]) - projected.y;
    if (Math.hypot(errorX, errorY) < 1e-7) return current;

    const step = 1e-4;
    const yawProjection = projectWorldPoint(
      target,
      state.position,
      orientation(yaw + step, pitch),
      state.fovYDegrees,
      aspectRatio,
    );
    const pitchProjection = projectWorldPoint(
      target,
      state.position,
      orientation(yaw, pitch + step),
      state.fovYDegrees,
      aspectRatio,
    );
    const xx = (yawProjection.x - projected.x) / step;
    const xy = (pitchProjection.x - projected.x) / step;
    const yx = (yawProjection.y - projected.y) / step;
    const yy = (pitchProjection.y - projected.y) / step;
    const determinant = xx * yy - xy * yx;
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-8) break;
    const yawDelta = (errorX * yy - xy * errorY) / determinant;
    const pitchDelta = (xx * errorY - errorX * yx) / determinant;
    yaw += clamp(yawDelta, -0.3, 0.3);
    pitch = clamp(pitch + clamp(pitchDelta, -0.3, 0.3), -Math.PI / 2 + 1e-3, Math.PI / 2 - 1e-3);
  }
  return orientation(yaw, pitch);
}

function applyCompositionOrientation(
  state: CameraStateSample,
  input: CameraOptimizerInput,
  plan: CompiledLossPlan,
): void {
  const active = plan.primitives
    .filter((primitive) => isPrimitiveActiveAt(primitive, state.time))
    .sort((a, b) => b.startTime - a.startTime || a.id.localeCompare(b.id));
  const composition = active.find((primitive) => primitive.type === "screenPosition")
    ?? active.find((primitive) => primitive.type === "lookAt")
    ?? active.find((primitive) => primitive.type === "screenScale");
  const hasExplicitRotation = active.some((primitive) =>
    (primitive.type === "angularProgress" && primitive.parameters.mode !== "orbit")
    || primitive.type === "rollProgress",
  );
  if (!composition || hasExplicitRotation) return;
  const target = samplePrimitiveSubject(input, composition, state.time);
  if (!target) return;

  const rawScreenTarget = composition.type === "screenPosition"
    && Array.isArray(composition.parameters.target)
    ? composition.parameters.target
    : undefined;
  if (
    rawScreenTarget === undefined
    || typeof rawScreenTarget[0] !== "number"
    || typeof rawScreenTarget[1] !== "number"
  ) {
    state.rotation = lookAtQuaternion(state.position, target.center);
    return;
  }

  const pointTime = composition.parameters.pointTime;
  const easing = composition.parameters.easing;
  const pointWeight = typeof pointTime === "number"
    ? getPointConstraintWeight(
        {
          time: pointTime,
          easing: easing && typeof easing === "object"
            ? easing as { inDuration?: number; outDuration?: number; curve?: "linear" | "easeIn" | "easeOut" | "easeInOut" }
            : undefined,
        },
        state.time,
      )
    : 1;
  const screenTarget = [
    0.5 + (rawScreenTarget[0] - 0.5) * pointWeight,
    0.5 + (rawScreenTarget[1] - 0.5) * pointWeight,
  ];

  const aspectRatio = input.options?.aspectRatio ?? 16 / 9;
  state.rotation = levelOrientationForScreenTarget(
    state,
    target.center,
    screenTarget,
    aspectRatio,
  );
}

/** Advances one seed sample while preserving the compound-move application order. */
export function advanceSeedState(
  input: CameraOptimizerInput,
  plan: CompiledLossPlan,
  previous: CameraStateSample,
  time: number,
  fixedAxes: Map<string, Vec3>,
  initialOrbitRadii: Map<string, number>,
): CameraStateSample {
  const midpoint = (time + previous.time) / 2;
  const active = plan.primitives.filter((primitive) =>
    primitive.endTime > primitive.startTime + 1e-9
    && isPrimitiveActiveAt(primitive, midpoint),
  );
  const state: CameraStateSample = {
    time,
    position: [...previous.position],
    rotation: [...previous.rotation],
    fovYDegrees: previous.fovYDegrees,
  };

  const inheritedMotion = subjectMotionPrimitive(active);
  if (inheritedMotion) {
    carrySubjectTranslation(state, input, inheritedMotion, previous.time);
  }
  applyTranslationSteps(state, previous, input, active, midpoint, fixedAxes);
  // Apply the orbit after any concurrent translation so a fused Arc + Dolly
  // ends on its radial schedule instead of leaving a one-frame radial offset.
  applyOrbitSteps(state, previous, input, active, initialOrbitRadii);
  applyRotationSteps(state, previous, active);
  applyZoomStep(state, previous, active);
  applyCompositionOrientation(state, input, plan);
  return state;
}
