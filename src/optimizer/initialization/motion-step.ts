import type { Vec3 } from "../../types/environment";
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

function subjectMotionPrimitive(
  active: readonly PrimitiveLoss[],
): PrimitiveLoss | undefined {
  const hasSubject = (primitive: PrimitiveLoss): boolean =>
    subjectIdsFromParameters(primitive.parameters).length > 0;
  return active.find((primitive) =>
    primitive.type === "relativeOffsetHold" && hasSubject(primitive),
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
    state.position = add3(state.position, sub3(after.center, before.center));
  }
}

function applyOrbitSteps(
  state: CameraStateSample,
  previous: CameraStateSample,
  input: CameraOptimizerInput,
  active: readonly PrimitiveLoss[],
): void {
  for (const primitive of active.filter((item) =>
    item.type === "angularProgress" && item.parameters.mode === "orbit",
  )) {
    const targetDelta = typeof primitive.parameters.targetDelta === "number"
      ? primitive.parameters.targetDelta
      : 0;
    const target = samplePrimitiveSubject(input, primitive, state.time);
    if (!target) continue;
    const angleStep = targetDelta * motionProgressDelta(
      previous.time,
      state.time,
      primitive.startTime,
      primitive.endTime,
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
      candidate.type === "radiusHold"
      && subjectIdsFromParameters(candidate.parameters).join("|") === orbitSubjectKey,
    );
    if (!radiusPrimitive) continue;

    const radial = sub3(state.position, target.center);
    const horizontal: Vec3 = [radial[0], 0, radial[2]];
    const requested = radiusPrimitive.parameters.targetRadius;
    // radiusHold is a constant orbit constraint, not a radius animation.
    const desiredRadius = typeof requested === "number" ? requested : length3(horizontal);
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
      const cached = fixedAxes.get(primitive.id);
      if (cached) return cached;
      const axis = primitive.parameters.axis === "cameraRight"
        ? cameraRight(previous.rotation)
        : cameraForward(previous.rotation);
      fixedAxes.set(primitive.id, axis);
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
  const duration = Math.max(1e-9, primitive.endTime - primitive.startTime);
  const previousProgress = motionProgress(
    (previous.time - primitive.startTime) / duration,
    primitive.parameters.speedKeyframes,
  );
  const currentProgress = motionProgress(
    (state.time - primitive.startTime) / duration,
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
    const distance = typeof primitive.parameters.targetDistance === "number"
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
    const progressDelta = motionProgressDelta(
      previous.time,
      state.time,
      primitive.startTime,
      primitive.endTime,
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

function applyCompositionOrientation(
  state: CameraStateSample,
  input: CameraOptimizerInput,
  plan: CompiledLossPlan,
): void {
  const active = plan.primitives
    .filter((primitive) => isPrimitiveActiveAt(primitive, state.time))
    .sort((a, b) => b.startTime - a.startTime || a.id.localeCompare(b.id));
  const composition = active.find((primitive) =>
    primitive.type === "lookAt"
    || primitive.type === "screenPosition"
    || primitive.type === "screenScale",
  );
  const hasExplicitRotation = active.some((primitive) =>
    (primitive.type === "angularProgress" && primitive.parameters.mode !== "orbit")
    || primitive.type === "rollProgress",
  );
  if (!composition || hasExplicitRotation) return;
  const target = samplePrimitiveSubject(input, composition, state.time);
  if (target) state.rotation = lookAtQuaternion(state.position, target.center);
}

/** Advances one seed sample while preserving the compound-move application order. */
export function advanceSeedState(
  input: CameraOptimizerInput,
  plan: CompiledLossPlan,
  previous: CameraStateSample,
  time: number,
  fixedAxes: Map<string, Vec3>,
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
  applyOrbitSteps(state, previous, input, active);
  applyTranslationSteps(state, previous, input, active, midpoint, fixedAxes);
  applyRotationSteps(state, previous, active);
  applyZoomStep(state, previous, active);
  applyCompositionOrientation(state, input, plan);
  return state;
}
