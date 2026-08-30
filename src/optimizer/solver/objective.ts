import type { EnvironmentV1, Quat, Vec3 } from "../../types/environment";
import type { WorldAabbV1 } from "../../types/environment-query";
import { LossFunctionType } from "../../types/solver";
import {
  aabbCorners,
  projectWorldBox,
  projectWorldPoint,
} from "../scene/projection";
import {
  sampleObstacleBoxes,
  segmentIntersectsAabb,
  signedDistanceToAabb,
} from "../scene/spatial-geometry";
import {
  sampleSubjectAggregate,
  type SubjectAggregate,
} from "../scene/subjects";
import {
  add3,
  cameraForward,
  cameraRight,
  cameraUp,
  clamp,
  conjugateQuat,
  distance3,
  dot3,
  huber,
  length3,
  lerp3,
  lookAtQuaternion,
  mean,
  multiplyQuat,
  normalize3,
  pitchFromQuaternion,
  quaternionAngle,
  rollFromQuaternion,
  rotate3,
  scale3,
  signedAngleAround,
  sub3,
  unwrapAngles,
  wrapAngle,
  yawFromQuaternion,
} from "../shared/math";
import {
  asQuat,
  asVec3,
  subjectIdsFromParameters,
} from "../shared/parameter-values";
import {
  primitivePlaybackTime,
  samplePrimitiveSubject,
} from "../scene/primitive-context";
import {
  crossesCut,
  intervalIndices,
  playbackToSceneTime,
  pointEasingWeight,
} from "../shared/time";
import { motionProgress, motionProgressDelta } from "../shared/motion-profiles";
import type {
  CameraOptimizerInput,
  CameraStateSample,
  CompiledLossPlan,
  LossBreakdownEntry,
  PrimitiveLoss,
} from "../types";

interface WeightedResidual {
  value: number;
  sampleWeight: number;
}

interface ObjectiveOptions {
  aspectRatio: number;
  cameraRadius: number;
  collisionMargin: number;
  nearPlane: number;
}

interface ObjectiveResult {
  total: number;
  breakdown: LossBreakdownEntry[];
}

function cutTimesFrom(primitive: PrimitiveLoss): number[] {
  return Array.isArray(primitive.parameters.cutTimes)
    ? primitive.parameters.cutTimes.filter((value): value is number => typeof value === "number")
    : [];
}

/** Shortest-path world-space angular velocity from one camera pose to another. */
function quaternionAngularVelocity(from: Quat, to: Quat, dt: number): Vec3 {
  let delta = multiplyQuat(to, conjugateQuat(from));
  // q and -q encode the same pose. Choosing a non-negative scalar component
  // keeps the logarithm on the shortest arc and avoids sign-flip spikes.
  if (delta[3] < 0) delta = [-delta[0], -delta[1], -delta[2], -delta[3]];
  const sineHalfAngle = Math.hypot(delta[0], delta[1], delta[2]);
  if (sineHalfAngle <= 1e-9) return [0, 0, 0];
  const angle = 2 * Math.atan2(sineHalfAngle, clamp(delta[3], -1, 1));
  return scale3(
    [
      delta[0] / sineHalfAngle,
      delta[1] / sineHalfAngle,
      delta[2] / sineHalfAngle,
    ],
    angle / Math.max(1e-6, dt),
  );
}

export class ObjectiveEvaluator {
  private readonly subjectCache = new Map<string, SubjectAggregate | undefined>();
  private readonly obstacleCache = new Map<number, Array<{ entityId: string; box: WorldAabbV1 }>>();
  private readonly obstacleTimeCache = new Map<string, Array<{ entityId: string; box: WorldAabbV1 }>>();
  private readonly primitiveIndices = new Map<string, number[]>();
  private readonly warningSet = new Set<string>();

  public constructor(
    private readonly input: CameraOptimizerInput,
    private readonly plan: CompiledLossPlan,
    private readonly times: readonly number[],
    private readonly options: ObjectiveOptions,
  ) {
    for (const primitive of plan.primitives) {
      this.primitiveIndices.set(
        primitive.id,
        intervalIndices(times, primitive.startTime, primitive.endTime),
      );
      const subjectIds = subjectIdsFromParameters(primitive.parameters);
      if (
        subjectIds.length === 0
        && !(primitive.type === "planeHold" && primitive.parameters.plane === "cameraMovement")
        && [
          "lookAt", "screenPosition", "bboxInFrame", "screenScale", "distanceHold",
          "relativeOffsetHold", "bearingHold", "elevationHold", "velocityMatch",
          "subjectView", "subjectElevation", "radiusHold", "radiusSchedule",
          "planeHold", "nearPlaneClearance", "occlusion",
        ].includes(primitive.type)
      ) {
        this.warningSet.add(`${primitive.id}/${primitive.type}: no subject IDs; residual omitted`);
      }
      if (primitive.type === "subjectView" && subjectIds.length > 1) {
        const entityIds = [...new Set(subjectIds.map((subjectId) =>
          input.environment.targets.find((target) => target.id === subjectId)?.entityId
            ?? subjectId,
        ))];
        if (entityIds.length > 1) {
          this.warningSet.add(
            `${primitive.id}/subjectView spans multiple entities; the first entity rotation defines local view`,
          );
        }
      }
    }
    const unbounded = input.environment.entities.filter((entity) => entity.bounds === undefined);
    const needsGeometry = plan.primitives.some((primitive) =>
      primitive.type === "collisionClearance" || primitive.type === "occlusion",
    );
    if (needsGeometry && unbounded.length > 0) {
      this.warningSet.add(
        `Collision/occlusion geometry unavailable for ${unbounded.length} unbounded entities`,
      );
    }
    if (
      input.environment.world?.ground === undefined
      && plan.primitives.some((primitive) =>
        primitive.type === "groundClearance" || primitive.type === "heightAboveGround",
      )
    ) {
      this.warningSet.add("Ground losses were omitted because the environment has no ground model");
    }
  }

  public get warnings(): string[] {
    return [...this.warningSet];
  }

  private sceneTime(index: number): number {
    return playbackToSceneTime(
      this.times[index]!,
      this.input.timeline.timeWarp,
      this.input.environment.clock.durationSeconds,
    );
  }

  private subject(primitive: PrimitiveLoss, index: number): SubjectAggregate | undefined {
    const subjectIds = subjectIdsFromParameters(primitive.parameters);
    if (subjectIds.length === 0) return undefined;
    const leadAmount = typeof primitive.parameters.leadAmount === "number"
      ? primitive.parameters.leadAmount
      : 0;
    const followDelay = typeof primitive.parameters.followDelay === "number"
      ? primitive.parameters.followDelay
      : 0;
    if (Math.abs(leadAmount - followDelay) > 1e-12) {
      return this.subjectAtPlaybackTime(primitive, this.times[index]!);
    }
    const key = `${subjectIds.join("|")}@${index}`;
    if (!this.subjectCache.has(key)) {
      this.subjectCache.set(
        key,
        sampleSubjectAggregate(this.input.environment, subjectIds, this.sceneTime(index)),
      );
    }
    return this.subjectCache.get(key);
  }

  private subjectAtPlaybackTime(
    primitive: PrimitiveLoss,
    playbackTime: number,
  ): SubjectAggregate | undefined {
    const subjectIds = subjectIdsFromParameters(primitive.parameters);
    if (subjectIds.length === 0) return undefined;
    const effectivePlaybackTime = primitivePlaybackTime(primitive, playbackTime);
    const key = `${subjectIds.join("|")}@playback:${effectivePlaybackTime.toFixed(9)}`;
    if (!this.subjectCache.has(key)) {
      this.subjectCache.set(
        key,
        samplePrimitiveSubject(this.input, primitive, playbackTime),
      );
    }
    return this.subjectCache.get(key);
  }

  private obstacles(index: number): Array<{ entityId: string; box: WorldAabbV1 }> {
    if (!this.obstacleCache.has(index)) {
      this.obstacleCache.set(
        index,
        sampleObstacleBoxes(this.input.environment, this.sceneTime(index)),
      );
    }
    return this.obstacleCache.get(index)!;
  }

  private obstaclesAtPlaybackTime(
    playbackTime: number,
  ): Array<{ entityId: string; box: WorldAabbV1 }> {
    const key = playbackTime.toFixed(9);
    if (!this.obstacleTimeCache.has(key)) {
      this.obstacleTimeCache.set(
        key,
        sampleObstacleBoxes(
          this.input.environment,
          playbackToSceneTime(
            playbackTime,
            this.input.timeline.timeWarp,
            this.input.environment.clock.durationSeconds,
          ),
        ),
      );
    }
    return this.obstacleTimeCache.get(key)!;
  }

  private sampleWeight(primitive: PrimitiveLoss, index: number): number {
    const pointTime = primitive.parameters.pointTime ?? primitive.parameters.keyframeTime;
    if (typeof pointTime !== "number") return 1;
    const easing = primitive.parameters.easing;
    return pointEasingWeight(
      this.times[index]!,
      pointTime,
      easing && typeof easing === "object"
        ? easing as { inDuration?: number; outDuration?: number; curve?: string }
        : undefined,
    );
  }

  private axis(primitive: PrimitiveLoss, index: number, states: readonly CameraStateSample[]): Vec3 {
    const referenceTime = typeof primitive.parameters.referenceTime === "number"
      ? primitive.parameters.referenceTime
      : primitive.startTime;
    const firstIndex = this.times.reduce((best, time, candidateIndex) =>
      Math.abs(time - referenceTime) < Math.abs(this.times[best]! - referenceTime)
        ? candidateIndex
        : best,
    0);
    switch (primitive.parameters.axis) {
      case "worldUp": return [0, 1, 0];
      case "cameraRight": return cameraRight(states[firstIndex]!.rotation);
      case "cameraForward": return cameraForward(states[firstIndex]!.rotation);
      case "towardSubject": {
        const subject = this.subject(primitive, index);
        return subject
          ? normalize3(sub3(subject.center, states[index]!.position))
          : cameraForward(states[firstIndex]!.rotation);
      }
      default: return cameraForward(states[firstIndex]!.rotation);
    }
  }

  /** Camera displacement measured in a moving subject's frame when present. */
  private relativeStep(
    primitive: PrimitiveLoss,
    previousIndex: number,
    currentIndex: number,
    states: readonly CameraStateSample[],
  ): Vec3 {
    const cameraDelta = sub3(
      states[currentIndex]!.position,
      states[previousIndex]!.position,
    );
    const previousSubject = this.subject(primitive, previousIndex);
    const currentSubject = this.subject(primitive, currentIndex);
    return previousSubject && currentSubject
      ? sub3(cameraDelta, sub3(currentSubject.center, previousSubject.center))
      : cameraDelta;
  }

  /** Camera offset change measured from the same moving subject. */
  private relativeDisplacement(
    primitive: PrimitiveLoss,
    firstIndex: number,
    currentIndex: number,
    states: readonly CameraStateSample[],
  ): Vec3 {
    const cameraDelta = sub3(states[currentIndex]!.position, states[firstIndex]!.position);
    const firstSubject = this.subject(primitive, firstIndex);
    const currentSubject = this.subject(primitive, currentIndex);
    return firstSubject && currentSubject
      ? sub3(cameraDelta, sub3(currentSubject.center, firstSubject.center))
      : cameraDelta;
  }

  private motionPrimitiveForStep(
    previousIndex: number,
    currentIndex: number,
  ): PrimitiveLoss | undefined {
    const midpoint = (this.times[previousIndex]! + this.times[currentIndex]!) / 2;
    const active = this.plan.primitives.filter((primitive) =>
      primitive.startTime <= midpoint + 1e-9
      && primitive.endTime >= midpoint - 1e-9
      && subjectIdsFromParameters(primitive.parameters).length > 0,
    );
    return active.find((primitive) => primitive.type === "relativeOffsetHold")
      ?? active.find((primitive) =>
        primitive.type === "angularProgress" && primitive.parameters.mode === "orbit",
      )
      ?? active.find((primitive) => primitive.type === "totalProgressTarget")
      ?? active.find((primitive) => primitive.type === "velocityMatch");
  }

  private collisionExemptEntityIdsAt(index: number): Set<string> {
    const time = this.times[index]!;
    const result = new Set<string>();
    for (const primitive of this.plan.primitives) {
      const mountedStatic = primitive.type === "relativeOffsetHold"
        && primitive.sourceType === LossFunctionType.Static;
      const allowedIntersection = primitive.parameters.allowSubjectIntersection === true;
      if (
        (!mountedStatic && !allowedIntersection)
        || primitive.startTime > time + 1e-9
        || primitive.endTime < time - 1e-9
      ) continue;
      for (const entityId of this.subject(primitive, index)?.entityIds ?? []) {
        result.add(entityId);
      }
    }
    return result;
  }

  private collisionExemptEntityIdsAtPlaybackTime(time: number): Set<string> {
    const result = new Set<string>();
    for (const primitive of this.plan.primitives) {
      const mountedStatic = primitive.type === "relativeOffsetHold"
        && primitive.sourceType === LossFunctionType.Static;
      const allowedIntersection = primitive.parameters.allowSubjectIntersection === true;
      if (
        (!mountedStatic && !allowedIntersection)
        || primitive.startTime > time + 1e-9
        || primitive.endTime < time - 1e-9
      ) continue;
      for (const entityId of this.subjectAtPlaybackTime(primitive, time)?.entityIds ?? []) {
        result.add(entityId);
      }
    }
    return result;
  }

  /** Step used by global regularizers, excluding inherited subject translation. */
  private regularizedStep(
    previousIndex: number,
    currentIndex: number,
    states: readonly CameraStateSample[],
  ): Vec3 {
    const primitive = this.motionPrimitiveForStep(previousIndex, currentIndex);
    return primitive
      ? this.relativeStep(primitive, previousIndex, currentIndex, states)
      : sub3(states[currentIndex]!.position, states[previousIndex]!.position);
  }

  private angularSeries(
    primitive: PrimitiveLoss,
    indices: readonly number[],
    states: readonly CameraStateSample[],
  ): number[] {
    const mode = primitive.parameters.mode;
    if (mode === "yaw") return unwrapAngles(indices.map((index) => yawFromQuaternion(states[index]!.rotation)));
    if (mode === "pitch") return unwrapAngles(indices.map((index) => pitchFromQuaternion(states[index]!.rotation)));
    if (mode === "roll") return unwrapAngles(indices.map((index) => rollFromQuaternion(states[index]!.rotation)));
    if (mode === "orbit") {
      const cumulative = [0];
      for (let localIndex = 1; localIndex < indices.length; localIndex += 1) {
        const previousIndex = indices[localIndex - 1]!;
        const currentIndex = indices[localIndex]!;
        const previousSubject = this.subject(primitive, previousIndex);
        const currentSubject = this.subject(primitive, currentIndex);
        if (!previousSubject || !currentSubject) {
          cumulative.push(cumulative[localIndex - 1]!);
          continue;
        }
        const previousRadial = sub3(states[previousIndex]!.position, previousSubject.center);
        const currentRadial = sub3(states[currentIndex]!.position, currentSubject.center);
        const angle = signedAngleAround(previousRadial, currentRadial, [0, 1, 0]);
        cumulative.push(cumulative[localIndex - 1]! + angle);
      }
      return cumulative;
    }
    return indices.map(() => 0);
  }

  private residuals(
    primitive: PrimitiveLoss,
    states: readonly CameraStateSample[],
  ): WeightedResidual[] {
    const indices = this.primitiveIndices.get(primitive.id) ?? [];
    if (indices.length === 0) return [];
    const weighted = (index: number, value: number): WeightedResidual => ({
      value,
      sampleWeight: this.sampleWeight(primitive, index),
    });
    const firstIndex = indices[0]!;
    const lastIndex = indices[indices.length - 1]!;
    const first = states[firstIndex]!;
    const last = states[lastIndex]!;

    switch (primitive.type) {
      case "positionAnchor": {
        const target = asVec3(primitive.parameters.target);
        return target ? indices.map((index) => weighted(index, distance3(states[index]!.position, target))) : [];
      }
      case "rotationAnchor": {
        let target = asQuat(primitive.parameters.target);
        const lookAt = asVec3(primitive.parameters.lookAt);
        if (!target && lookAt) target = lookAtQuaternion(first.position, lookAt);
        return target ? indices.map((index) => weighted(index, quaternionAngle(states[index]!.rotation, target!))) : [];
      }
      case "fovAnchor": {
        const target = primitive.parameters.target;
        return typeof target === "number"
          ? indices.map((index) => weighted(index, states[index]!.fovYDegrees - target))
          : [];
      }
      case "positionHold":
        return indices.map((index) => weighted(index, distance3(states[index]!.position, first.position)));
      case "orientationHold":
        return indices.map((index) => weighted(index, quaternionAngle(states[index]!.rotation, first.rotation)));
      case "forwardHold": {
        const reference = cameraForward(first.rotation);
        return indices.map((index) => weighted(index, Math.acos(clamp(dot3(reference, cameraForward(states[index]!.rotation)), -1, 1))));
      }
      case "yawHold": {
        const reference = yawFromQuaternion(first.rotation);
        return indices.map((index) => weighted(
          index,
          wrapAngle(yawFromQuaternion(states[index]!.rotation) - reference),
        ));
      }
      case "pitchHold": {
        const reference = pitchFromQuaternion(first.rotation);
        return indices.map((index) => weighted(
          index,
          pitchFromQuaternion(states[index]!.rotation) - reference,
        ));
      }
      case "rollHold": {
        const reference = rollFromQuaternion(first.rotation);
        return indices.map((index) => weighted(
          index,
          wrapAngle(rollFromQuaternion(states[index]!.rotation) - reference),
        ));
      }
      case "fovHold":
        return indices.map((index) => weighted(index, states[index]!.fovYDegrees - first.fovYDegrees));
      case "axisProgress": {
        const sign = typeof primitive.parameters.sign === "number" ? primitive.parameters.sign : 1;
        const result: WeightedResidual[] = [];
        for (let localIndex = 1; localIndex < indices.length; localIndex += 1) {
          const previousIndex = indices[localIndex - 1]!;
          const currentIndex = indices[localIndex]!;
          const dt = Math.max(1e-6, this.times[currentIndex]! - this.times[previousIndex]!);
          const progressRate = sign * dot3(
            this.relativeStep(primitive, previousIndex, currentIndex, states),
            this.axis(primitive, previousIndex, states),
          ) / dt;
          result.push(weighted(currentIndex, Math.max(0, -progressRate)));
        }
        return result;
      }
      case "totalProgressTarget": {
        const sign = typeof primitive.parameters.sign === "number" ? primitive.parameters.sign : 1;
        const target = typeof primitive.parameters.targetDistance === "number" ? primitive.parameters.targetDistance : 0;
        let progress = 0;
        for (let localIndex = 1; localIndex < indices.length; localIndex += 1) {
          const previousIndex = indices[localIndex - 1]!;
          const currentIndex = indices[localIndex]!;
          progress += sign * dot3(
            this.relativeStep(primitive, previousIndex, currentIndex, states),
            this.axis(primitive, previousIndex, states),
          );
        }
        return [weighted(lastIndex, progress - target)];
      }
      case "orthogonalDrift": {
        const axis = this.axis(primitive, firstIndex, states);
        return indices.map((index) => {
          const displacement = this.relativeDisplacement(primitive, firstIndex, index, states);
          const orthogonal = sub3(displacement, scale3(axis, dot3(displacement, axis)));
          return weighted(index, length3(orthogonal));
        });
      }
      case "pathProfile": {
        const axis = this.axis(primitive, firstIndex, states);
        let lateral = cameraRight(first.rotation);
        if (Math.abs(dot3(axis, lateral)) > 0.9) lateral = cameraUp(first.rotation);
        lateral = normalize3(sub3(lateral, scale3(axis, dot3(lateral, axis))), [0, 1, 0]);
        const targetDistance = typeof primitive.parameters.targetDistance === "number"
          ? primitive.parameters.targetDistance
          : 1;
        const intensity = typeof primitive.parameters.curveIntensity === "number"
          ? clamp(primitive.parameters.curveIntensity / 10, 0, 1)
          : 0.5;
        const amplitude = targetDistance * 0.25 * intensity;
        const duration = Math.max(1e-9, primitive.endTime - primitive.startTime);
        return indices.map((index) => {
          const normalizedTime = (this.times[index]! - primitive.startTime) / duration;
          const progress = motionProgress(normalizedTime, primitive.parameters.speedKeyframes);
          const phase = primitive.parameters.path === "spline"
            ? Math.sin(2 * Math.PI * progress)
            : Math.sin(Math.PI * progress);
          const displacement = this.relativeDisplacement(primitive, firstIndex, index, states);
          const orthogonal = sub3(displacement, scale3(axis, dot3(displacement, axis)));
          return weighted(index, distance3(orthogonal, scale3(lateral, amplitude * phase)));
        });
      }
      case "stepPacing": {
        if (indices.length < 2) return [];
        const sign = typeof primitive.parameters.sign === "number" ? primitive.parameters.sign : 1;
        const targetDistance = typeof primitive.parameters.fullTargetDistance === "number"
          ? primitive.parameters.fullTargetDistance
          : typeof primitive.parameters.targetDistance === "number"
            ? primitive.parameters.targetDistance
          : 0;
        const motionStartTime = typeof primitive.parameters.motionStartTime === "number"
          ? primitive.parameters.motionStartTime
          : primitive.startTime;
        const motionEndTime = typeof primitive.parameters.motionEndTime === "number"
          ? primitive.parameters.motionEndTime
          : primitive.endTime;
        return indices.slice(1).map((index, localIndex) => {
          const previousIndex = indices[localIndex]!;
          const dt = Math.max(1e-6, this.times[index]! - this.times[previousIndex]!);
          const target = targetDistance * motionProgressDelta(
            this.times[previousIndex]!,
            this.times[index]!,
            motionStartTime,
            motionEndTime,
            primitive.parameters.speedKeyframes,
          );
          const progress = sign * dot3(
            this.relativeStep(primitive, previousIndex, index, states),
            this.axis(primitive, previousIndex, states),
          );
          return weighted(index, (progress - target) / dt);
        });
      }
      case "stepSmoothness": {
        if (indices.length < 3) return [];
        const steps = indices.slice(1).map((index, localIndex) => {
          const previousIndex = indices[localIndex]!;
          const dt = Math.max(1e-6, this.times[index]! - this.times[previousIndex]!);
          return {
            index,
            value: dot3(
              this.relativeStep(primitive, previousIndex, index, states),
              this.axis(primitive, previousIndex, states),
            ) / dt,
          };
        });
        return steps.slice(1).map((step, index) => weighted(
          step.index,
          step.value - steps[index]!.value,
        ));
      }
      case "angularProgress":
      case "rollProgress": {
        const series = this.angularSeries(
          primitive.type === "rollProgress"
            ? { ...primitive, parameters: { ...primitive.parameters, mode: "roll" } }
            : primitive,
          indices,
          states,
        );
        const target = typeof primitive.parameters.targetDelta === "number" ? primitive.parameters.targetDelta : 0;
        return [weighted(lastIndex, series[series.length - 1]! - series[0]! - target)];
      }
      case "angularDirection": {
        const angles = this.angularSeries(primitive, indices, states);
        const sign = typeof primitive.parameters.sign === "number" ? primitive.parameters.sign : 1;
        return angles.slice(1).map((angle, index) => weighted(
          indices[index + 1]!,
          Math.max(
            0,
            -sign * (angle - angles[index]!) / Math.max(
              1e-6,
              this.times[indices[index + 1]!]! - this.times[indices[index]!]!,
            ),
          ),
        ));
      }
      case "angularPacing": {
        const angles = this.angularSeries(primitive, indices, states);
        if (angles.length < 2) return [];
        const targetDelta = typeof primitive.parameters.targetDelta === "number" ? primitive.parameters.targetDelta : 0;
        const fullTargetDelta = typeof primitive.parameters.fullTargetDelta === "number"
          ? primitive.parameters.fullTargetDelta
          : undefined;
        const motionStartTime = typeof primitive.parameters.motionStartTime === "number"
          ? primitive.parameters.motionStartTime
          : primitive.startTime;
        const motionEndTime = typeof primitive.parameters.motionEndTime === "number"
          ? primitive.parameters.motionEndTime
          : primitive.endTime;
        return angles.slice(1).map((angle, index) => {
          const dt = Math.max(
            1e-6,
            this.times[indices[index + 1]!]! - this.times[indices[index]!]!,
          );
          return weighted(
            indices[index + 1]!,
            (angle - angles[index]! - (fullTargetDelta ?? targetDelta) * motionProgressDelta(
            this.times[indices[index]!]!,
            this.times[indices[index + 1]!]!,
            motionStartTime,
            motionEndTime,
            primitive.parameters.speedKeyframes,
            )) / dt,
          );
        });
      }
      case "planeHold": {
        if (primitive.parameters.plane === "cameraMovement") {
          const normal = cameraRight(first.rotation);
          return indices.map((index) => weighted(
            index,
            dot3(sub3(states[index]!.position, first.position), normal),
          ));
        }
        const subject = this.subject(primitive, firstIndex);
        if (!subject) return [];
        const initialRelativeY = first.position[1] - subject.center[1];
        return indices.map((index) => {
          const currentSubject = this.subject(primitive, index);
          return currentSubject
            ? weighted(index, states[index]!.position[1] - currentSubject.center[1] - initialRelativeY)
            : weighted(index, 0);
        });
      }
      case "radiusHold":
      case "radiusSchedule": {
        const scheduleStartTime = typeof primitive.parameters.motionStartTime === "number"
          ? primitive.parameters.motionStartTime
          : primitive.startTime;
        const scheduleEndTime = typeof primitive.parameters.motionEndTime === "number"
          ? primitive.parameters.motionEndTime
          : primitive.endTime;
        const scheduleStartIndex = this.times.reduce((best, time, index) =>
          Math.abs(time - scheduleStartTime) < Math.abs(this.times[best]! - scheduleStartTime)
            ? index
            : best,
        0);
        const scheduleStartState = states[scheduleStartIndex]!;
        const initialSubject = this.subject(primitive, scheduleStartIndex);
        if (!initialSubject) return [];
        const initialRadius = Math.hypot(
          scheduleStartState.position[0] - initialSubject.center[0],
          scheduleStartState.position[2] - initialSubject.center[2],
        );
        const requestedRadius = primitive.parameters.targetRadius;
        const endRadius = primitive.type === "radiusSchedule"
          ? Math.max(0.2, initialRadius + (typeof primitive.parameters.deltaRadius === "number" ? primitive.parameters.deltaRadius : 0))
          : typeof requestedRadius === "number" ? requestedRadius : initialRadius;
        const duration = Math.max(1e-9, scheduleEndTime - scheduleStartTime);
        return indices.map((index) => {
          const subject = this.subject(primitive, index);
          if (!subject) return weighted(index, 0);
          const alpha = motionProgress(
            clamp((this.times[index]! - scheduleStartTime) / duration, 0, 1),
            primitive.parameters.speedKeyframes,
          );
          const expected = initialRadius + (endRadius - initialRadius) * alpha;
          const radius = Math.hypot(
            states[index]!.position[0] - subject.center[0],
            states[index]!.position[2] - subject.center[2],
          );
          return weighted(index, radius - expected);
        });
      }
      case "lookAt": {
        return indices.flatMap((index) => {
          const subject = this.subject(primitive, index);
          if (!subject) return [];
          const desired = normalize3(sub3(subject.center, states[index]!.position));
          const angle = Math.acos(clamp(dot3(cameraForward(states[index]!.rotation), desired), -1, 1));
          return [weighted(index, angle)];
        });
      }
      case "screenPosition": {
        const target = Array.isArray(primitive.parameters.target)
          ? primitive.parameters.target as number[]
          : [0.5, 0.5];
        return indices.flatMap((index) => {
          const subject = this.subject(primitive, index);
          if (!subject) return [];
          const projection = projectWorldPoint(
            subject.center,
            states[index]!.position,
            states[index]!.rotation,
            states[index]!.fovYDegrees,
            this.options.aspectRatio,
          );
          const miss = Math.hypot(projection.x - Number(target[0]), projection.y - Number(target[1]));
          return [weighted(index, projection.visible ? miss : miss + 1)];
        });
      }
      case "bboxInFrame": {
        return indices.flatMap((index) => {
          const subject = this.subject(primitive, index);
          if (!subject) return [];
          const bounds = projectWorldBox(
            subject.box,
            states[index]!.position,
            states[index]!.rotation,
            states[index]!.fovYDegrees,
            this.options.aspectRatio,
          );
          return [weighted(index, Math.max(
            0,
            -bounds.minX,
            bounds.maxX - 1,
            -bounds.minY,
            bounds.maxY - 1,
            bounds.behindCamera ? 1 : 0,
          ))];
        });
      }
      case "screenScale": {
        const targetCoverage = typeof primitive.parameters.targetCoverage === "number"
          ? primitive.parameters.targetCoverage
          : 0.4;
        return indices.flatMap((index) => {
          const subject = this.subject(primitive, index);
          if (!subject) return [];
          const bounds = projectWorldBox(
            subject.box,
            states[index]!.position,
            states[index]!.rotation,
            states[index]!.fovYDegrees,
            this.options.aspectRatio,
          );
          return [weighted(index, bounds.height - targetCoverage)];
        });
      }
      case "distanceHold": {
        const initialSubject = this.subject(primitive, firstIndex);
        if (!initialSubject) return [];
        const requestedDistance = primitive.parameters.distance ?? primitive.parameters.targetDistance;
        const targetDistance = typeof requestedDistance === "number" && requestedDistance >= 0
          ? requestedDistance
          : distance3(first.position, initialSubject.center);
        return indices.flatMap((index) => {
          const subject = this.subject(primitive, index);
          return subject ? [weighted(index, distance3(states[index]!.position, subject.center) - targetDistance)] : [];
        });
      }
      case "relativeOffsetHold": {
        const initialSubject = this.subject(primitive, firstIndex);
        if (!initialSubject) return [];
        const initialOffset = sub3(first.position, initialSubject.center);
        return indices.flatMap((index) => {
          const subject = this.subject(primitive, index);
          return subject ? [weighted(index, distance3(sub3(states[index]!.position, subject.center), initialOffset))] : [];
        });
      }
      case "bearingHold":
      case "elevationHold": {
        const initialSubject = this.subject(primitive, firstIndex);
        if (!initialSubject) return [];
        const initialOffset = sub3(first.position, initialSubject.center);
        const requestedBearing = primitive.parameters.bearing ?? primitive.parameters.azimuth;
        const requestedElevation = primitive.parameters.elevation;
        const targetBearing = typeof requestedBearing === "number"
          ? requestedBearing * Math.PI / 180
          : Math.atan2(initialOffset[0], initialOffset[2]);
        const targetElevation = typeof requestedElevation === "number"
          ? requestedElevation * Math.PI / 180
          : Math.atan2(initialOffset[1], Math.hypot(initialOffset[0], initialOffset[2]));
        return indices.flatMap((index) => {
          const subject = this.subject(primitive, index);
          if (!subject) return [];
          const offset = sub3(states[index]!.position, subject.center);
          if (primitive.type === "bearingHold") {
            return [weighted(index, wrapAngle(Math.atan2(offset[0], offset[2]) - targetBearing))];
          }
          return [weighted(
            index,
            Math.atan2(offset[1], Math.hypot(offset[0], offset[2])) - targetElevation,
          )];
        });
      }
      case "velocityMatch": {
        const result: WeightedResidual[] = [];
        for (let localIndex = 1; localIndex < indices.length; localIndex += 1) {
          const previousIndex = indices[localIndex - 1]!;
          const index = indices[localIndex]!;
          const previousSubject = this.subject(primitive, previousIndex);
          const subject = this.subject(primitive, index);
          if (!previousSubject || !subject) continue;
          const dt = Math.max(1e-6, this.times[index]! - this.times[previousIndex]!);
          const cameraVelocity = scale3(sub3(states[index]!.position, states[previousIndex]!.position), 1 / dt);
          const subjectVelocity = scale3(sub3(subject.center, previousSubject.center), 1 / dt);
          const motionStartTime = typeof primitive.parameters.motionStartTime === "number"
            ? primitive.parameters.motionStartTime
            : primitive.startTime;
          const motionEndTime = typeof primitive.parameters.motionEndTime === "number"
            ? primitive.parameters.motionEndTime
            : primitive.endTime;
          const duration = Math.max(1e-9, motionEndTime - motionStartTime);
          const linearDelta = Math.max(
            1e-9,
            (this.times[index]! - this.times[previousIndex]!) / duration,
          );
          const speedScale = motionProgressDelta(
            this.times[previousIndex]!,
            this.times[index]!,
            motionStartTime,
            motionEndTime,
            primitive.parameters.speedKeyframes,
          ) / linearDelta;
          result.push(weighted(
            index,
            distance3(cameraVelocity, scale3(subjectVelocity, speedScale)),
          ));
        }
        return result;
      }
      case "subjectView": {
        const targetAzimuth = typeof primitive.parameters.targetAzimuth === "number"
          ? primitive.parameters.targetAzimuth
          : 0;
        return indices.flatMap((index) => {
          const subject = this.subject(primitive, index);
          if (!subject) return [];
          const worldOffset = normalize3(sub3(states[index]!.position, subject.center));
          const localOffset = rotate3(worldOffset, conjugateQuat(subject.rotation));
          const azimuth = Math.atan2(localOffset[0], localOffset[2]);
          return [weighted(index, wrapAngle(azimuth - targetAzimuth))];
        });
      }
      case "subjectElevation": {
        const targetElevation = typeof primitive.parameters.targetElevation === "number"
          ? primitive.parameters.targetElevation
          : 0;
        return indices.flatMap((index) => {
          const subject = this.subject(primitive, index);
          if (!subject) return [];
          const offset = sub3(states[index]!.position, subject.center);
          const elevation = Math.atan2(offset[1], Math.hypot(offset[0], offset[2]));
          return [weighted(index, elevation - targetElevation)];
        });
      }
      case "rollTarget":
      case "levelHorizon": {
        const target = primitive.type === "levelHorizon"
          ? 0
          : typeof primitive.parameters.targetRoll === "number" ? primitive.parameters.targetRoll : 0;
        return indices.map((index) => weighted(index, wrapAngle(rollFromQuaternion(states[index]!.rotation) - target)));
      }
      case "intrinsicsProgress": {
        // Fixed, compile-time target (see compiler.ts's fixed-point-anchoring
        // pass) — NOT derived from first.fovYDegrees, which is a live,
        // still-optimizing state value. Anchoring to a live value here was
        // self-referential (the target moved as the variable it was meant to
        // constrain moved) and could compound into runaway growth across a
        // zoom action split into multiple sub-bands. Falls back to the old
        // first-frame-relative computation only if targetFovYDegrees wasn't
        // supplied (e.g. a hand-built primitive bypassing the compiler).
        const factor = typeof primitive.parameters.factor === "number" ? primitive.parameters.factor : 1;
        const expected = typeof primitive.parameters.targetFovYDegrees === "number"
          ? primitive.parameters.targetFovYDegrees
          : primitive.parameters.direction === "in"
            ? first.fovYDegrees / factor
            : first.fovYDegrees * factor;
        return [weighted(lastIndex, last.fovYDegrees - expected)];
      }
      case "intrinsicsPacing": {
        if (indices.length < 2) return [];
        // Same fixed-target reasoning as intrinsicsProgress above.
        const factor = typeof primitive.parameters.factor === "number" ? primitive.parameters.factor : 1;
        const end = typeof primitive.parameters.targetFovYDegrees === "number"
          ? primitive.parameters.targetFovYDegrees
          : primitive.parameters.direction === "in"
            ? first.fovYDegrees / factor
            : first.fovYDegrees * factor;
        return indices.map((index, localIndex) => {
          const normalizedTime = (this.times[index]! - primitive.startTime)
            / Math.max(1e-9, primitive.endTime - primitive.startTime);
          const expected = first.fovYDegrees + (end - first.fovYDegrees)
            * motionProgress(normalizedTime, primitive.parameters.speedKeyframes);
          return weighted(index, states[index]!.fovYDegrees - expected);
        });
      }
      case "collisionClearance": {
        const requested = this.options.cameraRadius + this.options.collisionMargin;
        const result = indices.map((index) => {
          const exemptEntityIds = this.collisionExemptEntityIdsAt(index);
          const minimum = Math.min(
            ...this.obstacles(index)
              .filter((obstacle) => !exemptEntityIds.has(obstacle.entityId))
              .map((obstacle) => signedDistanceToAabb(states[index]!.position, obstacle.box)),
            Infinity,
          );
          return weighted(index, Math.max(0, requested - minimum));
        });
        for (let localIndex = 1; localIndex < indices.length; localIndex += 1) {
          const previousIndex = indices[localIndex - 1]!;
          const index = indices[localIndex]!;
          if (crossesCut(
            this.times[previousIndex]!,
            this.times[index]!,
            this.input.timeline.cutTimes ?? [],
          )) continue;
          const midpointTime = (this.times[previousIndex]! + this.times[index]!) / 2;
          const midpointPosition = lerp3(
            states[previousIndex]!.position,
            states[index]!.position,
            0.5,
          );
          const exemptEntityIds = this.collisionExemptEntityIdsAtPlaybackTime(midpointTime);
          const minimum = Math.min(
            ...this.obstaclesAtPlaybackTime(midpointTime)
              .filter((obstacle) => !exemptEntityIds.has(obstacle.entityId))
              .map((obstacle) => signedDistanceToAabb(midpointPosition, obstacle.box)),
            Infinity,
          );
          result.push(weighted(index, Math.max(0, requested - minimum)));
        }
        return result;
      }
      case "nearPlaneClearance": {
        const requested = typeof primitive.parameters.nearPlane === "number"
          ? Math.max(1e-4, primitive.parameters.nearPlane)
          : this.options.nearPlane;
        return indices.flatMap((index) => {
          const subject = this.subject(primitive, index);
          if (!subject) return [];
          const minimumDepth = Math.min(...aabbCorners(subject.box).map((corner) =>
            projectWorldPoint(
              corner,
              states[index]!.position,
              states[index]!.rotation,
              states[index]!.fovYDegrees,
              this.options.aspectRatio,
            ).depth,
          ));
          return [weighted(index, Math.max(0, requested - minimumDepth))];
        });
      }
      case "occlusion": {
        return indices.flatMap((index) => {
          const subject = this.subject(primitive, index);
          if (!subject) return [];
          const excluded = new Set(subject.entityIds);
          const blocked = this.obstacles(index).some((obstacle) =>
            !excluded.has(obstacle.entityId)
            && segmentIntersectsAabb(states[index]!.position, subject.center, obstacle.box),
          );
          return [weighted(index, blocked ? 1 : 0)];
        });
      }
      case "groundClearance": {
        const groundY = this.input.environment.world?.ground?.y;
        if (groundY === undefined) return [];
        const clearance = this.options.cameraRadius + this.options.collisionMargin;
        return indices.map((index) => weighted(
          index,
          Math.max(0, groundY + clearance - states[index]!.position[1]),
        ));
      }
      case "heightAboveGround": {
        const groundY = this.input.environment.world?.ground?.y;
        if (groundY === undefined) return [];
        const requested = primitive.parameters.heightAboveGround ?? primitive.parameters.height;
        const targetHeight = typeof requested === "number"
          ? requested
          : first.position[1] - groundY;
        return indices.map((index) => weighted(
          index,
          states[index]!.position[1] - groundY - targetHeight,
        ));
      }
      case "accelerationSmoothness": {
        const cutTimes = cutTimesFrom(primitive);
        const result: WeightedResidual[] = [];
        for (let localIndex = 1; localIndex + 1 < indices.length; localIndex += 1) {
          const aIndex = indices[localIndex - 1]!;
          const bIndex = indices[localIndex]!;
          const cIndex = indices[localIndex + 1]!;
          if (crossesCut(this.times[aIndex]!, this.times[cIndex]!, cutTimes)) continue;
          const dt0 = Math.max(1e-6, this.times[bIndex]! - this.times[aIndex]!);
          const dt1 = Math.max(1e-6, this.times[cIndex]! - this.times[bIndex]!);
          const v0 = scale3(this.regularizedStep(aIndex, bIndex, states), 1 / dt0);
          const v1 = scale3(this.regularizedStep(bIndex, cIndex, states), 1 / dt1);
          result.push(weighted(bIndex, length3(scale3(sub3(v1, v0), 2 / (dt0 + dt1)))));
        }
        return result;
      }
      case "angularAccelerationSmoothness": {
        const cutTimes = cutTimesFrom(primitive);
        const result: WeightedResidual[] = [];
        for (let localIndex = 1; localIndex + 1 < indices.length; localIndex += 1) {
          const aIndex = indices[localIndex - 1]!;
          const bIndex = indices[localIndex]!;
          const cIndex = indices[localIndex + 1]!;
          if (crossesCut(this.times[aIndex]!, this.times[cIndex]!, cutTimes)) continue;
          const dt0 = Math.max(1e-6, this.times[bIndex]! - this.times[aIndex]!);
          const dt1 = Math.max(1e-6, this.times[cIndex]! - this.times[bIndex]!);
          const w0 = quaternionAngularVelocity(
            states[aIndex]!.rotation,
            states[bIndex]!.rotation,
            dt0,
          );
          const w1 = quaternionAngularVelocity(
            states[bIndex]!.rotation,
            states[cIndex]!.rotation,
            dt1,
          );
          result.push(weighted(
            bIndex,
            length3(scale3(sub3(w1, w0), 2 / (dt0 + dt1))),
          ));
        }
        return result;
      }
      case "jerkSmoothness": {
        const cutTimes = cutTimesFrom(primitive);
        const accelerations: Array<{ index: number; value: Vec3 }> = [];
        for (let localIndex = 1; localIndex + 1 < indices.length; localIndex += 1) {
          const a = indices[localIndex - 1]!;
          const b = indices[localIndex]!;
          const c = indices[localIndex + 1]!;
          if (crossesCut(this.times[a]!, this.times[c]!, cutTimes)) continue;
          const dt0 = Math.max(1e-6, this.times[b]! - this.times[a]!);
          const dt1 = Math.max(1e-6, this.times[c]! - this.times[b]!);
          const v0 = scale3(this.regularizedStep(a, b, states), 1 / dt0);
          const v1 = scale3(this.regularizedStep(b, c, states), 1 / dt1);
          accelerations.push({ index: b, value: scale3(sub3(v1, v0), 2 / (dt0 + dt1)) });
        }
        return accelerations.slice(1).map((entry, index) => {
          const previous = accelerations[index]!;
          const dt = Math.max(1e-6, this.times[entry.index]! - this.times[previous.index]!);
          return weighted(entry.index, length3(scale3(sub3(entry.value, previous.value), 1 / dt)));
        });
      }
      case "pathLength": {
        const result: WeightedResidual[] = [];
        for (let localIndex = 1; localIndex < indices.length; localIndex += 1) {
          const previousIndex = indices[localIndex - 1]!;
          const index = indices[localIndex]!;
          if (crossesCut(this.times[previousIndex]!, this.times[index]!, this.input.timeline.cutTimes ?? [])) continue;
          const dt = Math.max(1e-6, this.times[index]! - this.times[previousIndex]!);
          result.push(weighted(
            index,
            length3(this.regularizedStep(previousIndex, index, states)) / dt,
          ));
        }
        return result;
      }
    }
    const exhaustive: never = primitive.type;
    throw new Error(`Unsupported primitive loss: ${String(exhaustive)}`);
  }

  public evaluate(states: readonly CameraStateSample[], includeBreakdown = true): ObjectiveResult {
    let total = 0;
    const breakdown: LossBreakdownEntry[] = [];
    for (const primitive of this.plan.primitives) {
      const residuals = this.residuals(primitive, states).filter((residual) =>
        residual.sampleWeight > 0 && Number.isFinite(residual.value),
      );
      const weightSum = residuals.reduce((sum, residual) => sum + residual.sampleWeight, 0);
      if (weightSum <= 0) continue;
      const squared = primitive.sourceType === "userKeyframe"
        || primitive.channel === "safety"
        || primitive.type === "bboxInFrame";
      const unweighted = residuals.reduce((sum, residual) => {
        const normalized = residual.value / Math.max(1e-12, primitive.tolerance);
        const cost = squared ? 0.5 * normalized * normalized : huber(normalized, 2);
        return sum + residual.sampleWeight * cost;
      }, 0) / weightSum;
      const weightedLoss = primitive.weight * unweighted;
      if (!Number.isFinite(weightedLoss)) {
        throw new Error(`Non-finite loss in primitive ${primitive.id}/${primitive.type}`);
      }
      total += weightedLoss;
      if (includeBreakdown) breakdown.push({ id: primitive.id, type: primitive.type, weightedLoss });
    }
    breakdown.sort((a, b) => b.weightedLoss - a.weightedLoss);
    return { total, breakdown };
  }
}
