import type { Quat, Vec3 } from "../../types/environment";
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
  slerpQuat,
  sub3,
  pitchFromQuaternion,
  yawFromQuaternion,
} from "../shared/math";
import { motionProgress, motionProgressDelta } from "../shared/motion-profiles";
import { applyOpticalZoom, interpolateFovLogFocal } from "../shared/lens";
import { pointEasingWeight } from "../shared/time";
import {
  isPrimitiveActiveAt,
  samplePrimitiveSubject,
  subjectTimingParameters,
} from "../scene/primitive-context";
import { asQuat, asVec3, subjectIdsFromParameters } from "../shared/parameter-values";
import type {
  CameraOptimizerInput,
  CameraStateSample,
  CompiledLossPlan,
  PrimitiveLoss,
} from "../types";
import { projectWorldBox, projectWorldPoint } from "../scene/projection";
import { DEFAULT_OPTIONS } from "../config/defaults";
import { projectedDistanceForCoverage } from "./framing-distance";
import {
  SEED_ORBIT_DEGREES,
  SEED_ROLL_RADIANS,
  SEED_ROTATION_RADIANS,
  SEED_TRANSLATION_METERS,
  SEED_ZOOM_FACTOR,
  seedMotionKey,
  type SeedChoices,
} from "./seed-defaults";

function sourceMotionClock(primitive: PrimitiveLoss): [number, number] {
  return [
    typeof primitive.parameters.motionStartTime === "number"
      ? primitive.parameters.motionStartTime : primitive.startTime,
    typeof primitive.parameters.motionEndTime === "number"
      ? primitive.parameters.motionEndTime : primitive.endTime,
  ];
}

function seededAngularDelta(primitive: PrimitiveLoss, fallback: number): number {
  const authored = primitive.parameters.fullTargetDelta ?? primitive.parameters.targetDelta;
  return typeof authored === "number"
    ? authored
    : fallback * (typeof primitive.parameters.sign === "number" ? primitive.parameters.sign : 1);
}

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
    // samplePrimitiveSubject already applies any authored reference pacing.
    state.position = add3(state.position, sub3(after.center, before.center));
  }
}

function applyOrbitSteps(
  state: CameraStateSample,
  previous: CameraStateSample,
  input: CameraOptimizerInput,
  plan: CompiledLossPlan,
  active: readonly PrimitiveLoss[],
  initialOrbitRadii: Map<string, number>,
  choices: SeedChoices,
): void {
  for (const primitive of active.filter((item) =>
    item.type === "angularProgress" && item.parameters.mode === "orbit",
  )) {
    const targetDelta = seededAngularDelta(primitive,
      choices.movementAmounts?.get(seedMotionKey(primitive)) ?? SEED_ORBIT_DEGREES * Math.PI / 180);
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
      && (Array.isArray(candidate.parameters.orbitSubjectIds)
        ? candidate.parameters.orbitSubjectIds.join("|")
        : subjectIdsFromParameters(candidate.parameters).join("|")) === orbitSubjectKey,
    );
    if (!radiusPrimitive) continue;

    const radiusTarget = samplePrimitiveSubject(input, radiusPrimitive, state.time) ?? target;
    const previousTarget = samplePrimitiveSubject(input, radiusPrimitive, previous.time)
      ?? radiusTarget;
    const spatialRadius = radiusPrimitive.parameters.radiusMetric === "distance";
    const radiusScheduleKey = typeof radiusPrimitive.parameters.scheduleKey === "string"
      ? radiusPrimitive.parameters.scheduleKey
      : `${radiusPrimitive.sourceActionId ?? radiusPrimitive.id}:${orbitSubjectKey}`;
    const [radiusStartTime, radiusEndTime] = sourceMotionClock(radiusPrimitive);
    const duration = Math.max(1e-9, radiusEndTime - radiusStartTime);
    const radiusProgress = (time: number): number => motionProgress(
      (time - radiusStartTime) / duration,
      radiusPrimitive.parameters.speedKeyframes,
    );
    let deltaRadius = typeof radiusPrimitive.parameters.deltaRadius === "number"
      ? radiusPrimitive.parameters.deltaRadius
      : (choices.movementAmounts?.get(seedMotionKey(radiusPrimitive)) ?? SEED_TRANSLATION_METERS) * (
          typeof radiusPrimitive.parameters.sign === "number" ? radiusPrimitive.parameters.sign : 1
        );
    const endpointAmountKey = `${radiusScheduleKey}:endpointAmount`;
    if (radiusPrimitive.type === "radiusSchedule"
      && typeof radiusPrimitive.parameters.deltaRadius !== "number"
      && !choices.movementAmounts?.has(seedMotionKey(radiusPrimitive))) {
      const cachedAmount = initialOrbitRadii.get(endpointAmountKey);
      if (cachedAmount !== undefined) deltaRadius = cachedAmount;
      else {
        const radiusSubjects = subjectIdsFromParameters(radiusPrimitive.parameters).join("|");
        const endpointScale = plan.primitives.find((candidate) => candidate.type === "screenScale"
          && Math.abs(Number(candidate.parameters.pointTime) - radiusEndTime) <= 1e-8
          && subjectIdsFromParameters(candidate.parameters).join("|") === radiusSubjects);
        const endpointTarget = endpointScale && samplePrimitiveSubject(input, endpointScale, radiusEndTime);
        if (endpointTarget && typeof endpointScale?.parameters.targetCoverage === "number") {
          const offset = sub3(previous.position, previousTarget.center);
          const endpointDirection = normalize3(rotateAroundAxis(offset, [0, 0, 0], [0, 1, 0], targetDelta));
          const endpointRadius = projectedDistanceForCoverage(input, endpointTarget,
            endpointDirection, state.fovYDegrees, endpointScale.parameters.targetCoverage,
            { allowNearPlaneLimited: true });
          const proposed = endpointRadius - length3(offset);
          if (proposed * deltaRadius > 0) deltaRadius = proposed;
        }
        initialOrbitRadii.set(endpointAmountKey, deltaRadius);
      }
    }
    let initialRadius = initialOrbitRadii.get(radiusScheduleKey);
    if (initialRadius === undefined) {
      initialRadius = Math.hypot(
        previous.position[0] - previousTarget.center[0],
        spatialRadius ? previous.position[1] - previousTarget.center[1] : 0,
        previous.position[2] - previousTarget.center[2],
      );
      if (radiusPrimitive.type === "radiusSchedule") {
        // A cut or partial overlap can begin after the source movement starts.
        // Recover that clock's baseline without jumping away from the cut pose.
        initialRadius -= deltaRadius * radiusProgress(previous.time);
      }
      initialOrbitRadii.set(radiusScheduleKey, initialRadius);
    }

    const radial = sub3(state.position, radiusTarget.center);
    const radiusDirection: Vec3 = [radial[0], spatialRadius ? radial[1] : 0, radial[2]];
    const requested = radiusPrimitive.parameters.targetRadius;
    const targetRadius = typeof requested === "number" ? requested : initialRadius;
    const progress = radiusProgress(state.time);
    const desiredRadius = radiusPrimitive.type === "radiusSchedule"
      ? Math.max(0.2, initialRadius + deltaRadius * progress)
      : initialRadius + (targetRadius - initialRadius) * progress;
    const direction = normalize3(radiusDirection, [0, 0, 1]);
    state.position = [
      radiusTarget.center[0] + direction[0] * desiredRadius,
      spatialRadius ? radiusTarget.center[1] + direction[1] * desiredRadius : state.position[1],
      radiusTarget.center[2] + direction[2] * desiredRadius,
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
  // Legacy `spline` denotes a sinusoidal S-bend; it remains load-compatible.
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
  choices: SeedChoices,
): void {
  for (const primitive of active.filter((item) => item.type === "totalProgressTarget")) {
    const distance = typeof primitive.parameters.fullTargetDistance === "number"
      ? primitive.parameters.fullTargetDistance
      : typeof primitive.parameters.targetDistance === "number"
        ? primitive.parameters.targetDistance
      : choices.movementAmounts?.get(seedMotionKey(primitive)) ?? SEED_TRANSLATION_METERS;
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
  choices: SeedChoices,
): void {
  for (const primitive of active.filter((item) =>
    item.type === "angularProgress" && item.parameters.mode !== "orbit",
  )) {
    const [startTime, endTime] = sourceMotionClock(primitive);
    const delta = seededAngularDelta(primitive,
      choices.movementAmounts?.get(seedMotionKey(primitive)) ?? SEED_ROTATION_RADIANS) * motionProgressDelta(
      previous.time,
      state.time,
      startTime,
      endTime,
      primitive.parameters.speedKeyframes,
    );
    state.rotation = primitive.parameters.mode === "pitch"
      ? applyCameraYawPitchRoll(state.rotation, 0, delta, 0)
      : applyCameraYawPitchRoll(state.rotation, delta, 0, 0);
  }

  for (const primitive of active.filter((item) => item.type === "rollProgress")) {
    const [startTime, endTime] = sourceMotionClock(primitive);
    const delta = seededAngularDelta(primitive,
      choices.movementAmounts?.get(seedMotionKey(primitive)) ?? SEED_ROLL_RADIANS) * motionProgressDelta(
      previous.time,
      state.time,
      startTime,
      endTime,
      primitive.parameters.speedKeyframes,
    );
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
  choices: SeedChoices,
): void {
  const zoom = active.find((primitive) => primitive.type === "intrinsicsProgress");
  if (!zoom) return;
  const authoredFactor = zoom.parameters.fullFactor ?? zoom.parameters.factor;
  const factor = typeof authoredFactor === "number" ? authoredFactor
    : choices.movementAmounts?.get(seedMotionKey(zoom)) ?? SEED_ZOOM_FACTOR;
  const [startTime, endTime] = sourceMotionClock(zoom);
  const progressDelta = motionProgressDelta(
    previous.time,
    state.time,
    startTime,
    endTime,
    zoom.parameters.speedKeyframes,
  );
  state.fovYDegrees = clamp(
    applyOpticalZoom(state.fovYDegrees, factor,
      zoom.parameters.direction === "in" ? "in" : "out", progressDelta),
    8,
    120,
  );
}

function applyCompositionLens(
  state: CameraStateSample,
  input: CameraOptimizerInput,
  plan: CompiledLossPlan,
  pointBaselines: Map<string, number>,
): void {
  const active = plan.primitives.filter((primitive) => isPrimitiveActiveAt(primitive, state.time));
  if (active.some((primitive) => primitive.type === "intrinsicsProgress"
    || primitive.type === "fovAnchor" || primitive.type === "fovHold")) return;
  const composition = active.find((primitive) => primitive.type === "screenScale"
    && typeof primitive.parameters.targetCoverage === "number");
  if (!composition) return;
  const target = samplePrimitiveSubject(input, composition, state.time);
  if (!target) return;
  const bounds = projectWorldBox(target.box, state.position, state.rotation,
    state.fovYDegrees, input.options?.aspectRatio ?? DEFAULT_OPTIONS.aspectRatio,
    input.options?.nearPlane ?? DEFAULT_OPTIONS.nearPlane);
  if (bounds.behindCamera || bounds.height <= 0) return;
  const targetFov = clamp(2 * Math.atan(Math.tan(state.fovYDegrees * Math.PI / 360)
    * bounds.height / Number(composition.parameters.targetCoverage)) * 180 / Math.PI, 8, 120);
  const window = pointOrientationWindow(composition);
  if (window === undefined) { state.fovYDegrees = targetFov; return; }
  if (!pointBaselines.has(window)) pointBaselines.set(window, state.fovYDegrees);
  const baseline = pointBaselines.get(window)!;
  const weight = pointEasingWeight(state.time, Number(composition.parameters.pointTime),
    composition.parameters.easing as { inDuration?: number; outDuration?: number; curve?: string });
  state.fovYDegrees = interpolateFovLogFocal(baseline, targetFov, weight);
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

function compositionOrientationTarget(
  state: CameraStateSample,
  input: CameraOptimizerInput,
  active: readonly PrimitiveLoss[],
): { primitive: PrimitiveLoss; rotation: Quat } | undefined {
  const rotationAnchor = active.find((primitive) => primitive.type === "rotationAnchor");
  const anchoredRotation = asQuat(rotationAnchor?.parameters.target);
  const anchoredLookAt = asVec3(rotationAnchor?.parameters.lookAt);
  if (anchoredRotation || anchoredLookAt) {
    return {
      primitive: rotationAnchor!,
      rotation: anchoredRotation ?? lookAtQuaternion(state.position, anchoredLookAt!),
    };
  }
  const compositionActive = active.filter((primitive) => {
    if (primitive.type !== "subjectVisibility" && primitive.type !== "subjectScaleFloor") return true;
    if (primitive.weight <= 0) return false;
    const windows = primitive.parameters.suppressionWindows;
    return !Array.isArray(windows) || !windows.some((window: {
      startTime: number; endTime: number; pointTime?: number;
      easing?: Parameters<typeof pointEasingWeight>[2];
    }) => state.time >= window.startTime - 1e-9 && state.time <= window.endTime + 1e-9
      && (window.pointTime === undefined ? 1 : pointEasingWeight(state.time, window.pointTime, window.easing)) >= 1 - 1e-9);
  });
  const composition = compositionActive.find((primitive) => primitive.type === "screenPosition")
    ?? compositionActive.find((primitive) => primitive.type === "lookAt")
    ?? compositionActive.find((primitive) => primitive.type === "screenScale")
    ?? compositionActive.find((primitive) => primitive.type === "subjectVisibility")
    ?? compositionActive.find((primitive) => primitive.type === "subjectScaleFloor");
  const hasExplicitRotation = active.some((primitive) =>
    (primitive.type === "angularProgress" && primitive.parameters.mode !== "orbit")
    || primitive.type === "rollProgress",
  );
  if (!composition || hasExplicitRotation) return;
  const isFallback = composition.type === "subjectVisibility" || composition.type === "subjectScaleFloor";
  if (isFallback && active.some((primitive) =>
    primitive.type === "orientationHold" || primitive.type === "forwardHold"
    || primitive.type === "yawHold" || primitive.type === "pitchHold",
  )) return;
  let subjectComposition = composition;
  if (isFallback) {
    // Subject-quality preferences are emitted per subject. Seed their shared
    // composition as a group instead of aiming only at the first emitted ID.
    // Different point/easing windows or subject clocks retain their own owner.
    const scope = (primitive: PrimitiveLoss): string => JSON.stringify([
      primitive.startTime, primitive.endTime,
      primitive.parameters.pointTime ?? primitive.parameters.keyframeTime,
      primitive.parameters.easing,
      subjectTimingParameters(primitive.parameters),
    ]);
    const compositionScope = scope(composition);
    const subjectIds = [...new Set(compositionActive.filter((primitive) =>
      primitive.weight > 0
      && (primitive.type === "subjectVisibility" || primitive.type === "subjectScaleFloor")
      && scope(primitive) === compositionScope,
    ).flatMap((primitive) => subjectIdsFromParameters(primitive.parameters)))];
    subjectComposition = {
      ...composition,
      parameters: { ...composition.parameters, subjectId: undefined, subjectIds },
    };
  }
  const target = samplePrimitiveSubject(input, subjectComposition, state.time);
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
    return { primitive: composition, rotation: lookAtQuaternion(state.position, target.center) };
  }

  const aspectRatio = input.options?.aspectRatio ?? 16 / 9;
  return {
    primitive: composition,
    rotation: levelOrientationForScreenTarget(state, target.center, rawScreenTarget, aspectRatio),
  };
}

function pointOrientationWindow(primitive: PrimitiveLoss): string | undefined {
  const { pointTime, easing } = primitive.parameters;
  if (typeof pointTime !== "number" || !easing || typeof easing !== "object") return undefined;
  // One point may emit several primitives and be split across multiple bands.
  return JSON.stringify([pointTime, easing]);
}

function resolveCompositionOrientation(
  state: CameraStateSample,
  input: CameraOptimizerInput,
  active: readonly PrimitiveLoss[],
  pointBaselines: Map<string, Quat>,
): Quat {
  const target = compositionOrientationTarget(state, input, active);
  if (!target) return state.rotation;
  const window = pointOrientationWindow(target.primitive);
  if (window === undefined) return target.rotation;

  // Recompute the underlying composition at the current position/scene time.
  // With no underlying owner, retain the window-entry pose: repeatedly easing
  // from the previous blended sample would make the result depend on FPS.
  if (!pointBaselines.has(window)) pointBaselines.set(window, [...state.rotation]);
  const baseline = resolveCompositionOrientation(
    { ...state, rotation: pointBaselines.get(window)! },
    input,
    active.filter((primitive) => pointOrientationWindow(primitive) !== window),
    pointBaselines,
  );
  const weight = pointEasingWeight(
    state.time,
    target.primitive.parameters.pointTime as number,
    target.primitive.parameters.easing as Parameters<typeof pointEasingWeight>[2],
  );
  return slerpQuat(baseline, target.rotation, weight);
}

export function applyCompositionOrientation(
  state: CameraStateSample,
  input: CameraOptimizerInput,
  plan: CompiledLossPlan,
  pointBaselines: Map<string, Quat> = new Map(),
): void {
  const active = plan.primitives
    .filter((primitive) => isPrimitiveActiveAt(primitive, state.time))
    .sort((a, b) => b.startTime - a.startTime || a.id.localeCompare(b.id));
  state.rotation = resolveCompositionOrientation(state, input, active, pointBaselines);
}

/** Advances one seed sample while preserving the compound-move application order. */
export function advanceSeedState(
  input: CameraOptimizerInput,
  plan: CompiledLossPlan,
  previous: CameraStateSample,
  time: number,
  fixedAxes: Map<string, Vec3>,
  initialOrbitRadii: Map<string, number>,
  pointOrientationBaselines: Map<string, Quat> = new Map(),
  choices: SeedChoices = {},
  pointFovBaselines: Map<string, number> = new Map(),
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

  const inheritedMotion = subjectMotionPrimitive(active)
    // A tracking seed keeps the existing framing useful during an unauthored
    // gap. Only visibility/scale inequalities constrain the solved result.
    ?? active.find((primitive) => primitive.type === "subjectVisibility" && primitive.parameters.gapSubject);
  if (inheritedMotion) {
    carrySubjectTranslation(state, input, inheritedMotion, previous.time);
  }
  applyTranslationSteps(state, previous, input, active, midpoint, fixedAxes, choices);
  // Apply the orbit after any concurrent translation so a fused Arc + Dolly
  // ends on its radial schedule instead of leaving a one-frame radial offset.
  applyOrbitSteps(state, previous, input, plan, active, initialOrbitRadii, choices);
  applyRotationSteps(state, previous, active, choices);
  applyZoomStep(state, previous, active, choices);
  applyCompositionOrientation(state, input, plan, pointOrientationBaselines);
  applyCompositionLens(state, input, plan, pointFovBaselines);
  return state;
}
