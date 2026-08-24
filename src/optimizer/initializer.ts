import type { Quat, Vec3 } from "../types/environment";
import {
  projectWorldBox,
  sampleSubjectAggregate,
  subjectIdsFromParameters,
} from "./environment";
import { DEFAULT_OPTIONS } from "./defaults";
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
  normalizeQuat,
  quatFromAxisAngle,
  rotateAroundAxis,
  scale3,
  slerpQuat,
  sub3,
} from "./math";
import { crossesCut, playbackToSceneTime } from "./time";
import { motionProgress, motionProgressDelta } from "./profiles";
import type {
  CameraOptimizerInput,
  CameraStateSample,
  CompiledLossPlan,
  PrimitiveLoss,
  UserCameraKeyframe,
} from "./types";

function activeAt(primitive: PrimitiveLoss, time: number): boolean {
  return primitive.startTime <= time + 1e-9 && primitive.endTime >= time - 1e-9;
}

function targetFor(
  input: CameraOptimizerInput,
  primitive: PrimitiveLoss,
  playbackTime: number,
) {
  const ids = subjectIdsFromParameters(primitive.parameters);
  if (ids.length === 0) return undefined;
  const leadAmount = typeof primitive.parameters.leadAmount === "number"
    ? primitive.parameters.leadAmount
    : 0;
  const followDelay = typeof primitive.parameters.followDelay === "number"
    ? Math.max(0, primitive.parameters.followDelay)
    : 0;
  const sceneTime = playbackToSceneTime(
    Math.max(0, playbackTime + leadAmount - followDelay),
    input.timeline.timeWarp,
    input.environment.clock.durationSeconds,
  );
  return sampleSubjectAggregate(input.environment, ids, sceneTime);
}

function firstTarget(
  input: CameraOptimizerInput,
  plan: CompiledLossPlan,
  playbackTime: number,
) {
  for (const primitive of plan.primitives) {
    const target = targetFor(input, primitive, playbackTime);
    if (target) return target;
  }
  const fallbackId = input.environment.targets[0]?.id ?? input.environment.entities[0]?.id;
  if (!fallbackId) return undefined;
  const sceneTime = playbackToSceneTime(
    playbackTime,
    input.timeline.timeWarp,
    input.environment.clock.durationSeconds,
  );
  return sampleSubjectAggregate(input.environment, [fallbackId], sceneTime);
}

function findPrimitive(
  primitives: readonly PrimitiveLoss[],
  type: PrimitiveLoss["type"],
  predicate: (primitive: PrimitiveLoss) => boolean = () => true,
): PrimitiveLoss | undefined {
  return primitives.find((primitive) => primitive.type === type && predicate(primitive));
}

function asVec3(value: unknown): Vec3 | undefined {
  if (Array.isArray(value) && value.length === 3 && value.every(Number.isFinite)) {
    return [Number(value[0]), Number(value[1]), Number(value[2])];
  }
  if (value && typeof value === "object") {
    const candidate = value as Record<string, unknown>;
    if ([candidate.x, candidate.y, candidate.z].every(
      (item) => typeof item === "number" && Number.isFinite(item),
    )) {
      return [candidate.x as number, candidate.y as number, candidate.z as number];
    }
  }
  return undefined;
}

function asQuat(value: unknown): Quat | undefined {
  if (Array.isArray(value) && value.length === 4 && value.every(Number.isFinite)) {
    return normalizeQuat([Number(value[0]), Number(value[1]), Number(value[2]), Number(value[3])]);
  }
  if (!value || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if ([candidate.x, candidate.y, candidate.z, candidate.w].every(
    (item) => typeof item === "number" && Number.isFinite(item),
  )) {
    return normalizeQuat([
      candidate.x as number,
      candidate.y as number,
      candidate.z as number,
      candidate.w as number,
    ]);
  }
  if ([candidate.pitch, candidate.yaw, candidate.roll].every(
    (item) => typeof item === "number" && Number.isFinite(item),
  )) {
    const pitch = (candidate.pitch as number) * Math.PI / 180;
    const yaw = (candidate.yaw as number) * Math.PI / 180;
    const roll = (candidate.roll as number) * Math.PI / 180;
    const cy = Math.cos(yaw / 2);
    const sy = Math.sin(yaw / 2);
    const cp = Math.cos(pitch / 2);
    const sp = Math.sin(pitch / 2);
    const cr = Math.cos(roll / 2);
    const sr = Math.sin(roll / 2);
    return normalizeQuat([
      sp * cy * cr + cp * sy * sr,
      cp * sy * cr - sp * cy * sr,
      cp * cy * sr - sp * sy * cr,
      cp * cy * cr + sp * sy * sr,
    ]);
  }
  return undefined;
}

function initialCameraState(
  input: CameraOptimizerInput,
  plan: CompiledLossPlan,
  initialFovYDegrees: number,
  playbackTime = 0,
): CameraStateSample {
  const target = firstTarget(input, plan, playbackTime);
  const overview = input.environment.world?.overviewCamera;
  let position: Vec3 = overview
    ? [...overview.position]
    : target
      ? add3(target.center, [0, Math.max(1, target.box.size[1] * 0.25), 5])
      : [0, 2, 5];
  let fovYDegrees = initialFovYDegrees;

  const pointPrimitives = plan.primitives.filter((primitive) =>
    primitive.startTime <= playbackTime + 1e-9 && primitive.endTime >= playbackTime - 1e-9,
  );
  const viewPrimitive = findPrimitive(pointPrimitives, "subjectView");
  const elevationPrimitive = findPrimitive(pointPrimitives, "subjectElevation");
  const scalePrimitive = findPrimitive(pointPrimitives, "screenScale");
  const semanticTarget = viewPrimitive
    ? targetFor(input, viewPrimitive, playbackTime)
    : elevationPrimitive
      ? targetFor(input, elevationPrimitive, playbackTime)
      : scalePrimitive
        ? targetFor(input, scalePrimitive, playbackTime)
        : target;
  if (semanticTarget) {
    const targetCoverage = typeof scalePrimitive?.parameters.targetCoverage === "number"
      ? scalePrimitive.parameters.targetCoverage
      : 0.35;
    const targetHeight = Math.max(0.2, semanticTarget.box.size[1]);
    let distance = clamp(
      targetHeight / Math.max(0.05, 2 * targetCoverage * Math.tan(fovYDegrees * Math.PI / 360)),
      0.55,
      80,
    );
    const azimuth = typeof viewPrimitive?.parameters.targetAzimuth === "number"
      ? viewPrimitive.parameters.targetAzimuth
      : 0;
    const elevation = typeof elevationPrimitive?.parameters.targetElevation === "number"
      ? elevationPrimitive.parameters.targetElevation
      : 0.1;
    const horizontalDistance = distance * Math.cos(elevation);
    const localDirection: Vec3 = [
      Math.sin(azimuth) * horizontalDistance,
      Math.sin(elevation) * distance,
      Math.cos(azimuth) * horizontalDistance,
    ];
    let worldDirection = add3(
      scale3(cameraRight(semanticTarget.rotation), localDirection[0]),
      add3(
        scale3([0, 1, 0], localDirection[1]),
        scale3(scale3(cameraForward(semanticTarget.rotation), -1), localDirection[2]),
      ),
    );
    if (scalePrimitive && semanticTarget.box.size[1] > 1e-6) {
      // The analytic height estimate treats the target as a flat plane. Real
      // AABBs have depth, so their near corners can make a close-up much
      // tighter than requested. Refine the seed against the same projection
      // model used by the objective before numerical optimization begins.
      const direction = normalize3(worldDirection, [0, 0, 1]);
      const aspectRatio = input.options?.aspectRatio ?? DEFAULT_OPTIONS.aspectRatio;
      let lowerDistance = 0.05;
      let upperDistance = 80;
      for (let iteration = 0; iteration < 36; iteration += 1) {
        const candidateDistance = (lowerDistance + upperDistance) / 2;
        const candidatePosition = add3(
          semanticTarget.center,
          scale3(direction, candidateDistance),
        );
        const projected = projectWorldBox(
          semanticTarget.box,
          candidatePosition,
          lookAtQuaternion(candidatePosition, semanticTarget.center),
          fovYDegrees,
          aspectRatio,
        );
        if (projected.behindCamera || projected.height > targetCoverage) {
          lowerDistance = candidateDistance;
        } else {
          upperDistance = candidateDistance;
        }
      }
      distance = (lowerDistance + upperDistance) / 2;
      worldDirection = scale3(direction, distance);
    }
    position = add3(semanticTarget.center, worldDirection);
  }
  const radiusPrimitive = findPrimitive(pointPrimitives, "radiusHold");
  const requestedRadius = radiusPrimitive?.parameters.targetRadius;
  const radiusTarget = radiusPrimitive
    ? targetFor(input, radiusPrimitive, playbackTime)
    : undefined;
  if (radiusTarget && typeof requestedRadius === "number") {
    const relative = sub3(position, radiusTarget.center);
    const horizontalDirection = normalize3([relative[0], 0, relative[2]], [0, 0, 1]);
    position = [
      radiusTarget.center[0] + horizontalDirection[0] * requestedRadius,
      position[1],
      radiusTarget.center[2] + horizontalDirection[2] * requestedRadius,
    ];

    // A requested orbit radius owns camera position. Let the lens satisfy the
    // shot-size request instead of seeding two incompatible constraints.
    if (semanticTarget && scalePrimitive) {
      const targetCoverage = typeof scalePrimitive.parameters.targetCoverage === "number"
        ? scalePrimitive.parameters.targetCoverage
        : 0.35;
      const targetHeight = Math.max(0.2, semanticTarget.box.size[1]);
      const distance = Math.max(0.05, length3(sub3(position, semanticTarget.center)));
      fovYDegrees = clamp(
        2 * Math.atan(targetHeight / Math.max(0.05, 2 * targetCoverage * distance)) * 180 / Math.PI,
        8,
        120,
      );
    }
  }
  const positionAnchor = findPrimitive(pointPrimitives, "positionAnchor");
  const anchoredPosition = asVec3(positionAnchor?.parameters.target);
  if (anchoredPosition) position = anchoredPosition;

  const lookTarget = semanticTarget?.center ?? overview?.target ?? add3(position, [0, 0, -1]);
  let rotation = lookAtQuaternion(position, lookTarget);
  const rotationAnchor = findPrimitive(pointPrimitives, "rotationAnchor");
  const anchoredRotation = asQuat(rotationAnchor?.parameters.target);
  const anchoredLookAt = asVec3(rotationAnchor?.parameters.lookAt);
  if (anchoredRotation) rotation = anchoredRotation;
  else if (anchoredLookAt) rotation = lookAtQuaternion(position, anchoredLookAt);

  const fovAnchor = findPrimitive(pointPrimitives, "fovAnchor");
  const anchoredFov = fovAnchor?.parameters.target;
  return {
    time: playbackTime,
    position,
    rotation,
    fovYDegrees: typeof anchoredFov === "number" ? anchoredFov : fovYDegrees,
  };
}

function applyHardChannels(sample: CameraStateSample, keyframe: UserCameraKeyframe): void {
  if ((keyframe.mode ?? "hard") !== "hard") return;
  if (keyframe.position) sample.position = [...keyframe.position];
  if (keyframe.rotation) sample.rotation = normalizeQuat(keyframe.rotation);
  if (keyframe.lookAt) sample.rotation = lookAtQuaternion(sample.position, keyframe.lookAt, keyframe.up ?? [0, 1, 0]);
  if (keyframe.fovYDegrees !== undefined) sample.fovYDegrees = keyframe.fovYDegrees;
}

function exactKeyframeAt(
  keyframes: readonly UserCameraKeyframe[],
  time: number,
): UserCameraKeyframe[] {
  return keyframes.filter((keyframe) => Math.abs(keyframe.time - time) <= 1e-8);
}

function seedSparseCompositionTransitions(
  states: CameraStateSample[],
  plan: CompiledLossPlan,
  keyframes: readonly UserCameraKeyframe[],
  cutTimes: readonly number[],
): void {
  const anchorTypes = new Set<PrimitiveLoss["type"]>([
    "lookAt",
    "screenPosition",
    "screenScale",
    "rotationAnchor",
  ]);
  const anchorTimes = [...new Set([
    states[0]!.time,
    states[states.length - 1]!.time,
    ...plan.primitives
      .filter((primitive) =>
        Math.abs(primitive.endTime - primitive.startTime) <= 1e-9
        && anchorTypes.has(primitive.type),
      )
      .map((primitive) => primitive.startTime),
    ...keyframes
      .filter((keyframe) => keyframe.rotation !== undefined || keyframe.lookAt !== undefined)
      .map((keyframe) => keyframe.time),
  ])].sort((a, b) => a - b);

  const ownsIntermediateOrientation = (primitive: PrimitiveLoss): boolean =>
    primitive.endTime - primitive.startTime > 1e-9
    && (
      primitive.type === "orientationHold"
      || primitive.type === "forwardHold"
      || primitive.type === "yawHold"
      || primitive.type === "pitchHold"
      || primitive.type === "rollHold"
      || primitive.type === "angularProgress"
      || primitive.type === "rollProgress"
      || primitive.type === "rollTarget"
      || primitive.type === "lookAt"
      || primitive.type === "screenPosition"
      || primitive.type === "screenScale"
      || primitive.type === "rotationAnchor"
    );

  for (let anchorIndex = 1; anchorIndex < anchorTimes.length; anchorIndex += 1) {
    const startTime = anchorTimes[anchorIndex - 1]!;
    const endTime = anchorTimes[anchorIndex]!;
    if (endTime - startTime <= 1e-9 || crossesCut(startTime, endTime, cutTimes)) continue;
    if (plan.primitives.some((primitive) =>
      ownsIntermediateOrientation(primitive)
      && primitive.startTime < endTime - 1e-9
      && primitive.endTime > startTime + 1e-9,
    )) continue;

    const startIndex = states.findIndex((state) => Math.abs(state.time - startTime) <= 1e-8);
    const endIndex = states.findIndex((state) => Math.abs(state.time - endTime) <= 1e-8);
    if (startIndex < 0 || endIndex <= startIndex) continue;
    const startRotation = states[startIndex]!.rotation;
    const endRotation = states[endIndex]!.rotation;
    for (let index = startIndex + 1; index < endIndex; index += 1) {
      const alpha = (states[index]!.time - startTime) / (endTime - startTime);
      states[index]!.rotation = slerpQuat(startRotation, endRotation, alpha);
    }
  }
}

/** Builds a compound-aware seed close enough for the numerical refinement stage. */
export function initializeCameraStates(
  input: CameraOptimizerInput,
  plan: CompiledLossPlan,
  times: readonly number[],
  initialFovYDegrees: number,
): CameraStateSample[] {
  if (times.length === 0) throw new Error("Cannot initialize an empty optimizer time grid");
  const userKeyframes = input.userKeyframes ?? [];
  const states: CameraStateSample[] = [];
  const first = initialCameraState(input, plan, initialFovYDegrees, times[0]!);
  for (const keyframe of exactKeyframeAt(userKeyframes, first.time)) applyHardChannels(first, keyframe);
  states.push(first);

  const fixedAxes = new Map<string, Vec3>();
  for (let index = 1; index < times.length; index += 1) {
    const previous = states[index - 1]!;
    const time = times[index]!;
    const midpoint = (time + previous.time) / 2;
    const active = plan.primitives.filter((primitive) =>
      primitive.endTime > primitive.startTime + 1e-9 && activeAt(primitive, midpoint),
    );
    const state: CameraStateSample = {
      time,
      position: [...previous.position],
      rotation: [...previous.rotation],
      fovYDegrees: previous.fovYDegrees,
    };

    const isCut = (input.timeline.cutTimes ?? []).some((cutTime) => Math.abs(cutTime - time) <= 1e-8)
      || userKeyframes.some((keyframe) => keyframe.cutBefore && Math.abs(keyframe.time - time) <= 1e-8);
    if (isCut) {
      const cutSeed = initialCameraState(input, plan, previous.fovYDegrees, time);
      for (const keyframe of exactKeyframeAt(userKeyframes, time)) applyHardChannels(cutSeed, keyframe);
      states.push(cutSeed);
      continue;
    }

    // Subject-anchored moves are expressed in the target's translating frame.
    // Carry that frame once before applying the requested camera-relative step.
    // A single camera cannot inherit two independent translations; conflict
    // compilation already resolves compatible compound moves to one subject.
    const subjectMotionPrimitive = active.find((primitive) =>
      primitive.type === "relativeOffsetHold"
      && subjectIdsFromParameters(primitive.parameters).length > 0,
    ) ?? active.find((primitive) =>
      primitive.type === "angularProgress"
      && primitive.parameters.mode === "orbit"
      && subjectIdsFromParameters(primitive.parameters).length > 0,
    ) ?? active.find((primitive) =>
      primitive.type === "totalProgressTarget"
      && subjectIdsFromParameters(primitive.parameters).length > 0,
    ) ?? active.find((primitive) =>
      primitive.type === "velocityMatch"
      && subjectIdsFromParameters(primitive.parameters).length > 0,
    );
    if (subjectMotionPrimitive) {
      const before = targetFor(input, subjectMotionPrimitive, previous.time);
      const after = targetFor(input, subjectMotionPrimitive, time);
      if (before && after) state.position = add3(state.position, sub3(after.center, before.center));
    }

    // Orbit is applied first; translations then create spirals/helices naturally.
    for (const primitive of active.filter((item) =>
      item.type === "angularProgress" && item.parameters.mode === "orbit",
    )) {
      const targetDelta = typeof primitive.parameters.targetDelta === "number"
        ? primitive.parameters.targetDelta
        : 0;
      const target = targetFor(input, primitive, time);
      if (!target) continue;
      const angleStep = targetDelta * motionProgressDelta(
        previous.time,
        time,
        primitive.startTime,
        primitive.endTime,
        primitive.parameters.speedKeyframes,
      );
      state.position = rotateAroundAxis(state.position, target.center, [0, 1, 0], angleStep);

      const radiusPrimitive = active.find((candidate) =>
        candidate.type === "radiusHold"
        && subjectIdsFromParameters(candidate.parameters).join("|")
          === subjectIdsFromParameters(primitive.parameters).join("|"),
      );
      if (radiusPrimitive) {
        const radial = sub3(state.position, target.center);
        const horizontal: Vec3 = [radial[0], 0, radial[2]];
        const requested = radiusPrimitive.parameters.targetRadius;
        // radiusHold is a constant orbit constraint, not a radius animation.
        // Carrying the previous shot's radius into an arc produces a spiral
        // whenever that shot ends farther from the subject (Example 16's
        // truck-to-arc transition is the clearest case).
        const desiredRadius = typeof requested === "number" ? requested : length3(horizontal);
        const direction = normalize3(horizontal, [0, 0, 1]);
        state.position = [
          target.center[0] + direction[0] * desiredRadius,
          state.position[1],
          target.center[2] + direction[2] * desiredRadius,
        ];
      }
    }

    for (const primitive of active.filter((item) => item.type === "totalProgressTarget")) {
      const duration = Math.max(1e-9, primitive.endTime - primitive.startTime);
      const distance = typeof primitive.parameters.targetDistance === "number"
        ? primitive.parameters.targetDistance
        : 0;
      const sign = typeof primitive.parameters.sign === "number" ? primitive.parameters.sign : 1;
      const axisName = primitive.parameters.axis;
      let axis: Vec3;
      if (axisName === "worldUp") axis = [0, 1, 0];
      else if (axisName === "towardSubject") {
        const target = targetFor(input, primitive, midpoint);
        axis = target ? normalize3(sub3(target.center, state.position)) : cameraForward(previous.rotation);
      } else {
        const cached = fixedAxes.get(primitive.id);
        if (cached) axis = cached;
        else {
          axis = axisName === "cameraRight" ? cameraRight(previous.rotation) : cameraForward(previous.rotation);
          fixedAxes.set(primitive.id, axis);
        }
      }
      const progressDelta = motionProgressDelta(
        previous.time,
        time,
        primitive.startTime,
        primitive.endTime,
        primitive.parameters.speedKeyframes,
      );
      state.position = add3(state.position, scale3(axis, sign * distance * progressDelta));
      if (primitive.parameters.path === "curved" || primitive.parameters.path === "spline") {
        let lateral = cameraRight(previous.rotation);
        if (Math.abs(axis[0] * lateral[0] + axis[1] * lateral[1] + axis[2] * lateral[2]) > 0.9) {
          lateral = [0, 1, 0];
        }
        lateral = normalize3(sub3(lateral, scale3(axis, axis[0] * lateral[0] + axis[1] * lateral[1] + axis[2] * lateral[2])), [0, 1, 0]);
        const intensity = typeof primitive.parameters.curveIntensity === "number"
          ? clamp(primitive.parameters.curveIntensity / 10, 0, 1)
          : 0.5;
        const amplitude = distance * 0.25 * intensity;
        const previousProgress = motionProgress(
          (previous.time - primitive.startTime) / duration,
          primitive.parameters.speedKeyframes,
        );
        const currentProgress = motionProgress(
          (time - primitive.startTime) / duration,
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
    }

    for (const primitive of active.filter((item) => item.type === "angularProgress" && item.parameters.mode !== "orbit")) {
      const duration = Math.max(1e-9, primitive.endTime - primitive.startTime);
      const delta = typeof primitive.parameters.targetDelta === "number"
        ? primitive.parameters.targetDelta * motionProgressDelta(
            previous.time,
            time,
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
      const duration = Math.max(1e-9, primitive.endTime - primitive.startTime);
      const delta = typeof primitive.parameters.targetDelta === "number"
        ? primitive.parameters.targetDelta * motionProgressDelta(
            previous.time,
            time,
            primitive.startTime,
            primitive.endTime,
            primitive.parameters.speedKeyframes,
          )
        : 0;
      state.rotation = multiplyQuat(quatFromAxisAngle(cameraForward(state.rotation), delta), state.rotation);
    }

    const zoom = active.find((primitive) => primitive.type === "intrinsicsProgress");
    if (zoom) {
      const duration = Math.max(1e-9, zoom.endTime - zoom.startTime);
      const factor = typeof zoom.parameters.factor === "number" ? zoom.parameters.factor : 1;
      const stepFactor = Math.pow(factor, motionProgressDelta(
        previous.time,
        time,
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

    // Composition owns the seed orientation unless an explicit rotational move is active.
    const activeAtCurrentTime = plan.primitives
      .filter((primitive) => activeAt(primitive, time))
      .sort((a, b) => b.startTime - a.startTime || a.id.localeCompare(b.id));
    const composition = activeAtCurrentTime.find((primitive) =>
      primitive.type === "lookAt"
      || primitive.type === "screenPosition"
      || primitive.type === "screenScale",
    );
    const hasExplicitRotation = activeAtCurrentTime.some((primitive) =>
      (primitive.type === "angularProgress" && primitive.parameters.mode !== "orbit")
      || primitive.type === "rollProgress",
    );
    if (composition && !hasExplicitRotation) {
      const target = targetFor(input, composition, time);
      if (target) state.rotation = lookAtQuaternion(state.position, target.center);
    }

    for (const keyframe of exactKeyframeAt(userKeyframes, time)) applyHardChannels(state, keyframe);
    state.rotation = normalizeQuat(state.rotation);
    states.push(state);
  }
  seedSparseCompositionTransitions(
    states,
    plan,
    userKeyframes,
    input.timeline.cutTimes ?? [],
  );
  return states;
}
