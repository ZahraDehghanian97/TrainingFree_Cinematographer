import { environmentSubjectKeyframeTimes } from "../../environment/sampler";
import type { Quat, Vec3 } from "../../types/environment";
import type { WorldAabbV1 } from "../../types/environment-query";
import { LossFunctionType } from "../../types/solver";
import { DEFAULT_OPTIONS } from "../config/defaults";
import type { CompositionWindow } from "../compiler/subject-quality";
import {
  aabbCorners,
  projectWorldBox,
  projectWorldPoint,
} from "../scene/projection";
import {
  minimumSignedDistanceToMovingAabb,
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
import { motionTransitionScale } from "../shared/motion-transitions";
import { createCameraPositionSampler } from "../trajectory";
import { minimumAngularProgress, minimumTranslationProgress } from "../shared/movement-preferences";
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

interface CollisionSweep {
  startTime: number;
  endTime: number;
  obstacles: Array<{ startBox: WorldAabbV1; endBox: WorldAabbV1 }>;
}

/** Map scene animation knots through the same piecewise clock as the renderer. */
function collisionBoundaryTimes(input: CameraOptimizerInput, plan: CompiledLossPlan): number[] {
  const duration = input.environment.clock.durationSeconds;
  const playbackBoundaries = [...new Set([
    0, duration,
    ...input.timeline.timeWarp.flatMap((segment) => [segment.startTimePlayback, segment.endTimePlayback]),
  ].filter((time) => time >= 0 && time <= duration))].sort((a, b) => a - b);
  const sceneKnots = [...new Set([
    duration,
    ...input.environment.entities.filter((entity) => entity.bounds !== undefined)
      .flatMap((entity) => environmentSubjectKeyframeTimes(input.environment, entity.id)),
  ])];
  const boundaries = [
    ...playbackBoundaries,
    ...(input.timeline.cutTimes ?? []),
    ...(input.userKeyframes ?? []).filter((keyframe) => keyframe.cutBefore).map((keyframe) => keyframe.time),
    ...plan.primitives.flatMap((primitive) => [primitive.startTime, primitive.endTime]),
  ];
  for (let index = 1; index < playbackBoundaries.length; index += 1) {
    const start = playbackBoundaries[index - 1]!;
    const end = playbackBoundaries[index]!;
    const active = input.timeline.timeWarp.filter((segment) =>
      segment.startTimePlayback <= (start + end) / 2 && segment.endTimePlayback > (start + end) / 2,
    );
    const rate = active.at(-1)?.rate ?? 1;
    if (rate <= 0) continue;
    const sceneStart = playbackToSceneTime(start, input.timeline.timeWarp, duration);
    for (const sceneTime of sceneKnots) {
      const time = start + (sceneTime - sceneStart) / rate;
      if (time > start && time < end) boundaries.push(time);
    }
  }
  return [...new Set(boundaries)].sort((a, b) => a - b);
}

function cutTimesFrom(primitive: PrimitiveLoss): number[] {
  return Array.isArray(primitive.parameters.cutTimes)
    ? primitive.parameters.cutTimes.filter((value): value is number => typeof value === "number")
    : [];
}

function compositionWindowWeight(value: unknown, time: number): number {
  if (!Array.isArray(value)) return 0;
  return value.reduce((weight: number, window: CompositionWindow) => {
    if (time < window.startTime - 1e-7 || time > window.endTime + 1e-7) return weight;
    return Math.max(weight, window.pointTime === undefined
      ? 1 : pointEasingWeight(time, window.pointTime, window.easing));
  }, 0);
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
  private readonly collisionSweepCache = new Map<string, CollisionSweep[]>();
  private readonly collisionBoundaries: number[];
  private readonly cutTimes: number[];
  private readonly collisionExemptions: Array<{ startTime: number; endTime: number; entityIds: string[] }>;
  private readonly primitiveIndices = new Map<string, number[]>();
  private readonly motionIndices = new Map<string, number[]>();
  private readonly warningSet = new Set<string>();

  public constructor(
    private readonly input: CameraOptimizerInput,
    private readonly plan: CompiledLossPlan,
    private readonly times: readonly number[],
    private readonly options: ObjectiveOptions,
  ) {
    const cutTimes = [
      ...(input.timeline.cutTimes ?? []),
      ...(input.userKeyframes ?? []).filter((keyframe) => keyframe.cutBefore)
        .map((keyframe) => keyframe.time),
    ];
    this.cutTimes = cutTimes;
    this.collisionBoundaries = collisionBoundaryTimes(input, plan);
    this.collisionExemptions = plan.primitives.filter((primitive) =>
      (primitive.type === "relativeOffsetHold" && primitive.sourceType === LossFunctionType.Static)
      || primitive.parameters.allowSubjectIntersection === true,
    ).map((primitive) => ({
      startTime: primitive.startTime,
      endTime: primitive.endTime,
      entityIds: subjectIdsFromParameters(primitive.parameters).map((subjectId) =>
        input.environment.semanticAnchors.find((anchor) => anchor.id === subjectId)?.entityId ?? subjectId,
      ),
    }));
    const scopedIndices = (primitive: PrimitiveLoss, startTime: number, endTime: number): number[] => {
      const indices = intervalIndices(times, startTime, endTime);
      const pointTime = primitive.parameters.pointTime ?? primitive.parameters.keyframeTime;
      // A cut sample stores the incoming shot's pose. The outgoing interval
      // must not use it for either local residuals or source-wide progress.
      // Point constraints, including eased points, still own their exact time.
      if (
        endTime - startTime <= 1e-9
        || primitive.type === "collisionClearance"
        || primitive.type === "groundClearance"
        || typeof pointTime === "number"
        || !cutTimes.some((cutTime) => Math.abs(cutTime - endTime) <= 1e-8)
      ) return indices;
      return indices.filter((index) => times[index]! < endTime - 1e-8);
    };
    for (const primitive of plan.primitives) {
      this.primitiveIndices.set(
        primitive.id,
        scopedIndices(primitive, primitive.startTime, primitive.endTime),
      );
      this.motionIndices.set(primitive.id, scopedIndices(
        primitive,
        typeof primitive.parameters.motionStartTime === "number"
          ? primitive.parameters.motionStartTime : primitive.startTime,
        typeof primitive.parameters.motionEndTime === "number"
          ? primitive.parameters.motionEndTime : primitive.endTime,
      ));
      const subjectIds = subjectIdsFromParameters(primitive.parameters);
      if (
        subjectIds.length === 0
        && !(primitive.type === "planeHold" && primitive.parameters.plane === "cameraMovement")
        && [
          "lookAt", "screenPosition", "bboxInFrame", "screenScale", "distanceHold",
          "subjectVisibility", "subjectScaleFloor",
          "relativeOffsetHold", "bearingHold", "elevationHold", "velocityMatch",
          "subjectView", "subjectElevation", "radiusHold", "radiusSchedule",
          "planeHold", "nearPlaneClearance", "occlusion",
        ].includes(primitive.type)
      ) {
        this.warningSet.add(`${primitive.id}/${primitive.type}: no subject IDs; residual omitted`);
      }
      if (primitive.type === "subjectView" && subjectIds.length > 1) {
        const entityIds = [...new Set(subjectIds.map((subjectId) =>
          input.environment.semanticAnchors.find((anchor) => anchor.id === subjectId)?.entityId
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
    return this.collisionExemptEntityIdsAtPlaybackTime(this.times[index]!);
  }

  private collisionExemptEntityIdsAtPlaybackTime(time: number): Set<string> {
    const result = new Set<string>();
    for (const exemption of this.collisionExemptions) {
      if (exemption.startTime > time + 1e-9 || exemption.endTime < time - 1e-9) continue;
      for (const entityId of exemption.entityIds) result.add(entityId);
    }
    return result;
  }

  private collisionSweeps(previousIndex: number, index: number): CollisionSweep[] {
    const key = `${previousIndex}:${index}`;
    const cached = this.collisionSweepCache.get(key);
    if (cached) return cached;
    const start = this.times[previousIndex]!;
    const end = this.times[index]!;
    const boundaries = [start, ...this.collisionBoundaries.filter((time) => time > start && time < end), end];
    const sweeps: CollisionSweep[] = [];
    for (let boundaryIndex = 1; boundaryIndex < boundaries.length; boundaryIndex += 1) {
      const from = boundaries[boundaryIndex - 1]!;
      const to = boundaries[boundaryIndex]!;
      const sceneSpan = playbackToSceneTime(to, this.input.timeline.timeWarp, this.input.environment.clock.durationSeconds)
        - playbackToSceneTime(from, this.input.timeline.timeWarp, this.input.environment.clock.durationSeconds);
      // Exact sweeps cover arbitrarily thin walls and linear obstacle motion.
      // A bounded temporal grid also follows rotating/Catmull-Rom obstacles.
      const count = Math.min(48, Math.max(1, Math.ceil(12 * Math.max(to - from, sceneSpan))));
      for (let piece = 0; piece < count; piece += 1) {
        const startTime = from + (to - from) * piece / count;
        const endTime = from + (to - from) * (piece + 1) / count;
        const exempt = this.collisionExemptEntityIdsAtPlaybackTime((startTime + endTime) / 2);
        const startBoxes = this.obstaclesAtPlaybackTime(startTime);
        // Step animation teleports at a knot; never sweep through the gap.
        // The right-hand position is checked by the following piece or knot.
        const endBoxes = this.obstaclesAtPlaybackTime(endTime - Math.min(1e-8, (endTime - startTime) * 1e-7));
        const obstacles = startBoxes.flatMap((obstacle, obstacleIndex) => exempt.has(obstacle.entityId)
          ? [] : [{ startBox: obstacle.box, endBox: endBoxes[obstacleIndex]!.box }]);
        sweeps.push({ startTime, endTime, obstacles });
      }
    }
    this.collisionSweepCache.set(key, sweeps);
    return sweeps;
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

  /** Keep every displacement in a derivative stencil in one physical frame. */
  private regularizedSteps(
    indices: readonly number[],
    states: readonly CameraStateSample[],
  ): Vec3[] {
    const references = indices.slice(1).map((index, localIndex) =>
      this.motionPrimitiveForStep(indices[localIndex]!, index),
    );
    const reference = references[0];
    const referenceKey = (primitive: PrimitiveLoss): string => {
      const subjectIds = subjectIdsFromParameters(primitive.parameters).sort();
      const lead = typeof primitive.parameters.leadAmount === "number"
        ? primitive.parameters.leadAmount : 0;
      const delay = typeof primitive.parameters.followDelay === "number"
        ? Math.max(0, primitive.parameters.followDelay) : 0;
      return JSON.stringify([subjectIds, lead - delay]);
    };
    const commonReference = reference
      && references.every((candidate) => candidate
        && referenceKey(candidate) === referenceKey(reference))
      && indices.every((index) => this.subject(reference, index) !== undefined)
      ? reference : undefined;
    // Switching subjects (or entering/leaving a follow) must not subtract a
    // different subject velocity from each side of an acceleration or jerk.
    return indices.slice(1).map((index, localIndex) => commonReference
      ? this.relativeStep(commonReference, indices[localIndex]!, index, states)
      : sub3(states[index]!.position, states[indices[localIndex]!]!.position),
    );
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

  private translationProgress(
    primitive: PrimitiveLoss,
    indices: readonly number[],
    states: readonly CameraStateSample[],
  ): number {
    const sign = typeof primitive.parameters.sign === "number" ? primitive.parameters.sign : 1;
    return indices.slice(1).reduce((progress, index, localIndex) => progress + sign * dot3(
      this.relativeStep(primitive, indices[localIndex]!, index, states),
      this.axis(primitive, indices[localIndex]!, states),
    ), 0);
  }

  private residuals(
    primitive: PrimitiveLoss,
    states: readonly CameraStateSample[],
  ): WeightedResidual[] {
    const indices = this.primitiveIndices.get(primitive.id) ?? [];
    if (indices.length === 0) return [];
    const weighted = (index: number, value: number): WeightedResidual => ({
      value: value * motionTransitionScale(primitive, this.times[index]!),
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
        const target = asQuat(primitive.parameters.target);
        const lookAt = asVec3(primitive.parameters.lookAt);
        return target || lookAt ? indices.map((index) => weighted(index, quaternionAngle(
          states[index]!.rotation,
          target ?? lookAtQuaternion(states[index]!.position, lookAt!),
        ))) : [];
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
        const target = primitive.parameters.fullTargetDistance ?? primitive.parameters.targetDistance;
        const sourceIndices = this.motionIndices.get(primitive.id)!;
        const progress = this.translationProgress(primitive, sourceIndices, states);
        const sourceFirst = sourceIndices[0]!;
        const minimum = minimumTranslationProgress(this.input, primitive,
          states[sourceFirst]!.position, this.subject(primitive, sourceFirst)?.center);
        return [weighted(lastIndex, typeof target === "number"
          ? progress - target : Math.max(0, minimum - progress))];
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
        const sourceIndices = this.motionIndices.get(primitive.id)!;
        const sourceFirst = sourceIndices[0]!;
        const axis = this.axis(primitive, firstIndex, states);
        let lateral = cameraRight(states[sourceFirst]!.rotation);
        if (Math.abs(dot3(axis, lateral)) > 0.9) lateral = cameraUp(states[sourceFirst]!.rotation);
        lateral = normalize3(sub3(lateral, scale3(axis, dot3(lateral, axis))), [0, 1, 0]);
        const motionStart = this.times[sourceFirst]!;
        const duration = Math.max(1e-9, this.times[sourceIndices[sourceIndices.length - 1]!]! - motionStart);
        const phaseAt = (index: number): number => {
          const progress = motionProgress((this.times[index]! - motionStart) / duration, primitive.parameters.speedKeyframes);
          return primitive.parameters.path === "spline"
            ? Math.sin(2 * Math.PI * progress) : Math.sin(Math.PI * progress);
        };
        const targetDistance = primitive.parameters.fullTargetDistance ?? primitive.parameters.targetDistance;
        const distance = typeof targetDistance === "number" ? targetDistance
          : Math.abs(this.translationProgress(primitive, sourceIndices, states));
        // Fit the free curve amplitude to the candidate itself. Only an authored
        // intensity imposes a numeric bend; the seed's 0.5 never becomes intent.
        const denominator = sourceIndices.reduce((sum, index) => sum + phaseAt(index) ** 2, 0);
        const fittedAmplitude = sourceIndices.reduce((sum, index) => sum + phaseAt(index) * dot3(
          this.relativeDisplacement(primitive, sourceFirst, index, states), lateral,
        ), 0) / Math.max(1e-9, denominator);
        const amplitude = typeof primitive.parameters.curveIntensity === "number"
          ? distance * 0.25 * clamp(primitive.parameters.curveIntensity / 10, 0, 1)
          : fittedAmplitude;
        const residuals = indices.map((index) => {
          const phase = phaseAt(index);
          const displacement = this.relativeDisplacement(primitive, sourceFirst, index, states);
          const orthogonal = sub3(displacement, scale3(axis, dot3(displacement, axis)));
          return weighted(index, distance3(orthogonal, scale3(lateral, amplitude * phase)));
        });
        if (primitive.parameters.curveIntensity === undefined) {
          residuals.push(weighted(lastIndex, Math.max(0, distance * 0.02 - Math.abs(amplitude))));
        }
        return residuals;
      }
      case "stepPacing": {
        if (indices.length < 2) return [];
        const sign = typeof primitive.parameters.sign === "number" ? primitive.parameters.sign : 1;
        const targetDistance = typeof primitive.parameters.fullTargetDistance === "number"
          ? primitive.parameters.fullTargetDistance
          : typeof primitive.parameters.targetDistance === "number"
            ? primitive.parameters.targetDistance
          : this.translationProgress(primitive, this.motionIndices.get(primitive.id)!, states);
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
        const sourceIndices = this.motionIndices.get(primitive.id)!;
        const series = this.angularSeries(
          primitive.type === "rollProgress"
            ? { ...primitive, parameters: { ...primitive.parameters, mode: "roll" } }
            : primitive,
          sourceIndices,
          states,
        );
        const target = primitive.parameters.fullTargetDelta ?? primitive.parameters.targetDelta;
        const delta = series[series.length - 1]! - series[0]!;
        const sign = primitive.parameters.sign;
        const progress = typeof sign === "number" ? sign * delta : Math.abs(delta);
        const minimum = minimumAngularProgress(this.input, primitive);
        return [weighted(lastIndex, typeof target === "number" ? delta - target : Math.max(0, minimum - progress))];
      }
      case "angularDirection": {
        const angles = this.angularSeries(primitive, indices, states);
        const sourceAngles = this.angularSeries(primitive, this.motionIndices.get(primitive.id)!, states);
        const sign = typeof primitive.parameters.sign === "number" ? primitive.parameters.sign
          : Math.sign(sourceAngles[sourceAngles.length - 1]! - sourceAngles[0]!) || 1;
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
        const sourceAngles = this.angularSeries(primitive, this.motionIndices.get(primitive.id)!, states);
        const targetDelta = typeof primitive.parameters.targetDelta === "number" ? primitive.parameters.targetDelta
          : sourceAngles[sourceAngles.length - 1]! - sourceAngles[0]!;
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
          primitive.parameters.radiusMetric === "distance"
            ? scheduleStartState.position[1] - initialSubject.center[1] : 0,
          scheduleStartState.position[2] - initialSubject.center[2],
        );
        const requestedRadius = primitive.parameters.targetRadius;
        if (primitive.type === "radiusSchedule") {
          const sourceIndices = this.motionIndices.get(primitive.id)!;
          const radiusAt = (index: number): number => {
            const subject = this.subject(primitive, index);
            return subject ? Math.hypot(
              states[index]!.position[0] - subject.center[0],
              primitive.parameters.radiusMetric === "distance"
                ? states[index]!.position[1] - subject.center[1] : 0,
              states[index]!.position[2] - subject.center[2],
            ) : initialRadius;
          };
          const finalRadius = radiusAt(sourceIndices[sourceIndices.length - 1]!);
          const requestedDelta = primitive.parameters.deltaRadius;
          const actualDelta = finalRadius - initialRadius;
          const sign = typeof primitive.parameters.sign === "number" ? primitive.parameters.sign : Math.sign(actualDelta) || 1;
          const minimum = this.input.options?.minimumMovementDistance ?? DEFAULT_OPTIONS.minimumMovementDistance;
          const residuals = [weighted(lastIndex, typeof requestedDelta === "number"
            ? actualDelta - requestedDelta : Math.max(0, minimum - sign * actualDelta))];
          const duration = Math.max(1e-9, scheduleEndTime - scheduleStartTime);
          for (let localIndex = 1; localIndex < indices.length; localIndex += 1) {
            const index = indices[localIndex]!;
            const previousIndex = indices[localIndex - 1]!;
            const dt = Math.max(1e-6, this.times[index]! - this.times[previousIndex]!);
            residuals.push(weighted(index, Math.max(0, -sign * (radiusAt(index) - radiusAt(previousIndex)) / dt)));
            if (primitive.parameters.speedKeyframes !== undefined) {
              const progress = motionProgress((this.times[index]! - scheduleStartTime) / duration, primitive.parameters.speedKeyframes);
              const delta = typeof requestedDelta === "number" ? requestedDelta : actualDelta;
              residuals.push(weighted(index, radiusAt(index) - initialRadius - delta * progress));
            }
          }
          return residuals;
        }
        const targetRadius = typeof requestedRadius === "number" ? requestedRadius : initialRadius;
        return indices.map((index) => {
          const subject = this.subject(primitive, index);
          if (!subject) return weighted(index, 0);
          const radius = Math.hypot(
            states[index]!.position[0] - subject.center[0],
            states[index]!.position[2] - subject.center[2],
          );
          return weighted(index, radius - targetRadius);
        });
      }
      case "subjectVisibility":
      case "subjectScaleFloor": {
        return indices.flatMap((index) => {
          const subject = this.subject(primitive, index);
          if (!subject) return [];
          const state = states[index]!;
          const time = this.times[index]!;
          const preference = 1 - compositionWindowWeight(primitive.parameters.suppressionWindows, time);
          if (preference <= 0) return [];
          const bounds = projectWorldBox(subject.box, state.position, state.rotation, state.fovYDegrees, this.options.aspectRatio);
          if (primitive.type === "subjectScaleFloor") {
            const minimum = typeof primitive.parameters.minimumCoverage === "number"
              ? primitive.parameters.minimumCoverage : DEFAULT_OPTIONS.minimumSubjectCoverage;
            return [weighted(index, preference * Math.max(0, minimum - bounds.height))];
          }
          // Frustum inequalities have a flat zero region inside the frame. Angular
          // coordinates also provide recovery when projection is behind the camera.
          const relative = sub3(subject.center, state.position);
          const local = rotate3(relative, conjugateQuat(state.rotation));
          const depth = -local[2];
          const halfY = state.fovYDegrees * Math.PI / 360;
          const halfX = Math.atan(Math.tan(halfY) * this.options.aspectRatio);
          const directionMiss = Math.max(
            0,
            (Math.abs(Math.atan2(local[0], depth)) - halfX) / Math.PI,
            (Math.abs(Math.atan2(local[1], depth)) - halfY) / Math.PI,
            (this.options.nearPlane - depth) / Math.max(this.options.nearPlane, length3(relative)),
          );
          const cropPreference = 1 - compositionWindowWeight(primitive.parameters.cropWindows, time);
          const forward = cameraForward(state.rotation);
          const minimumDepth = Math.min(...aabbCorners(subject.box).map((corner) =>
            dot3(sub3(corner, state.position), forward),
          ));
          const nearMiss = Math.max(0, this.options.nearPlane - minimumDepth)
            / Math.max(this.options.nearPlane, length3(subject.box.size));
          const overflow = bounds.behindCamera ? nearMiss : Math.max(0,
            -bounds.minX, bounds.maxX - 1, -bounds.minY, bounds.maxY - 1,
          );
          return [weighted(index, preference * Math.max(directionMiss, cropPreference * overflow))];
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
        const sourceIndices = this.motionIndices.get(primitive.id)!;
        const start = states[sourceIndices[0]!]!.fovYDegrees;
        const end = states[sourceIndices[sourceIndices.length - 1]!]!.fovYDegrees;
        const factor = primitive.parameters.fullFactor ?? primitive.parameters.factor;
        const direction = primitive.parameters.direction === "in" ? -1 : 1;
        const expected = typeof primitive.parameters.targetFovYDegrees === "number"
          ? primitive.parameters.targetFovYDegrees
          : typeof factor === "number" ? start * Math.pow(factor, direction) : undefined;
        // A supplied sub-unity ratio reverses the effective lens change. Its
        // numeric relationship takes precedence over the action's usual sign.
        const sign = expected === undefined ? direction : Math.sign(expected - start) || direction;
        const minimum = this.input.options?.minimumZoomChangeDegrees ?? DEFAULT_OPTIONS.minimumZoomChangeDegrees;
        const residuals = [weighted(lastIndex, expected === undefined
          ? Math.max(0, minimum - sign * (end - start)) : end - expected)];
        for (let localIndex = 1; localIndex < indices.length; localIndex += 1) {
          const index = indices[localIndex]!;
          const previousIndex = indices[localIndex - 1]!;
          const dt = Math.max(1e-6, this.times[index]! - this.times[previousIndex]!);
          residuals.push(weighted(index, Math.max(0,
            -sign * (states[index]!.fovYDegrees - states[previousIndex]!.fovYDegrees) / dt,
          )));
        }
        return residuals;
      }
      case "intrinsicsPacing": {
        if (indices.length < 2) return [];
        const sourceIndices = this.motionIndices.get(primitive.id)!;
        const sourceFirst = sourceIndices[0]!;
        const sourceLast = sourceIndices[sourceIndices.length - 1]!;
        const start = states[sourceFirst]!.fovYDegrees;
        const factor = primitive.parameters.fullFactor ?? primitive.parameters.factor;
        const end = typeof primitive.parameters.targetFovYDegrees === "number"
          ? primitive.parameters.targetFovYDegrees
          : typeof factor === "number"
            ? start * Math.pow(factor, primitive.parameters.direction === "in" ? -1 : 1)
            : states[sourceLast]!.fovYDegrees;
        return indices.map((index) => {
          const normalizedTime = (this.times[index]! - this.times[sourceFirst]!)
            / Math.max(1e-9, this.times[sourceLast]! - this.times[sourceFirst]!);
          const expected = start * Math.pow(end / start,
            motionProgress(normalizedTime, primitive.parameters.speedKeyframes));
          return weighted(index, states[index]!.fovYDegrees - expected);
        });
      }
      case "collisionClearance": {
        const requested = this.options.cameraRadius + this.options.collisionMargin;
        const positionAt = createCameraPositionSampler(states, this.cutTimes);
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
          let violation = 0;
          for (const sweep of this.collisionSweeps(previousIndex, index)) {
            if (sweep.obstacles.length === 0) continue;
            const span = sweep.endTime - sweep.startTime;
            const start = positionAt(sweep.startTime);
            const endsAtCut = crossesCut(sweep.startTime, sweep.endTime, this.cutTimes);
            const end = positionAt(endsAtCut ? sweep.endTime - Math.min(1e-8, span * 1e-7) : sweep.endTime);
            const firstDeviation = sub3(positionAt(sweep.startTime + span / 3), lerp3(start, end, 1 / 3));
            const secondDeviation = sub3(positionAt(sweep.startTime + 2 * span / 3), lerp3(start, end, 2 / 3));
            // The cubic's deviation from its chord is bounded by 3/4 of the
            // largest Bezier control deviation. Including that bound prevents
            // a curved output path from cutting into a wall its chords miss.
            const curveBound = 0.75 * Math.max(
              length3(sub3(scale3(firstDeviation, 3), scale3(secondDeviation, 1.5))),
              length3(sub3(scale3(secondDeviation, 3), scale3(firstDeviation, 1.5))),
            );
            for (const obstacle of sweep.obstacles) {
              const minimum = minimumSignedDistanceToMovingAabb(
                start, end, obstacle.startBox, obstacle.endBox, requested + curveBound,
              );
              violation = Math.max(violation, requested + curveBound - minimum);
            }
          }
          result.push(weighted(index, violation));
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
          const preference = 1 - compositionWindowWeight(primitive.parameters.suppressionWindows, this.times[index]!);
          if (preference <= 0) return [];
          const subject = this.subject(primitive, index);
          if (!subject) return [];
          const excluded = new Set(subject.entityIds);
          const blocked = this.obstacles(index).some((obstacle) =>
            !excluded.has(obstacle.entityId)
            && segmentIntersectsAabb(states[index]!.position, subject.center, obstacle.box),
          );
          return [weighted(index, blocked ? preference : 0)];
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
        const cutTimes = [...(this.input.timeline.cutTimes ?? []), ...cutTimesFrom(primitive)];
        const result: WeightedResidual[] = [];
        for (let localIndex = 1; localIndex + 1 < indices.length; localIndex += 1) {
          const aIndex = indices[localIndex - 1]!;
          const bIndex = indices[localIndex]!;
          const cIndex = indices[localIndex + 1]!;
          if (crossesCut(this.times[aIndex]!, this.times[cIndex]!, cutTimes)) continue;
          const dt0 = Math.max(1e-6, this.times[bIndex]! - this.times[aIndex]!);
          const dt1 = Math.max(1e-6, this.times[cIndex]! - this.times[bIndex]!);
          const steps = this.regularizedSteps([aIndex, bIndex, cIndex], states);
          const v0 = scale3(steps[0]!, 1 / dt0);
          const v1 = scale3(steps[1]!, 1 / dt1);
          result.push(weighted(bIndex, length3(scale3(sub3(v1, v0), 2 / (dt0 + dt1)))));
        }
        return result;
      }
      case "angularAccelerationSmoothness": {
        const cutTimes = [...(this.input.timeline.cutTimes ?? []), ...cutTimesFrom(primitive)];
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
        const cutTimes = [...(this.input.timeline.cutTimes ?? []), ...cutTimesFrom(primitive)];
        const result: WeightedResidual[] = [];
        for (let localIndex = 0; localIndex + 3 < indices.length; localIndex += 1) {
          const a = indices[localIndex]!;
          const b = indices[localIndex + 1]!;
          const c = indices[localIndex + 2]!;
          const d = indices[localIndex + 3]!;
          // Work on consecutive stencils: filtering accelerations first could
          // pair the final acceleration of one shot with the next shot's first.
          if (crossesCut(this.times[a]!, this.times[d]!, cutTimes)) continue;
          const dt0 = Math.max(1e-6, this.times[b]! - this.times[a]!);
          const dt1 = Math.max(1e-6, this.times[c]! - this.times[b]!);
          const dt2 = Math.max(1e-6, this.times[d]! - this.times[c]!);
          const steps = this.regularizedSteps([a, b, c, d], states);
          const v0 = scale3(steps[0]!, 1 / dt0);
          const v1 = scale3(steps[1]!, 1 / dt1);
          const v2 = scale3(steps[2]!, 1 / dt2);
          const a0 = scale3(sub3(v1, v0), 2 / (dt0 + dt1));
          const a1 = scale3(sub3(v2, v1), 2 / (dt1 + dt2));
          result.push(weighted(c, length3(scale3(sub3(a1, a0), 1 / dt1))));
        }
        return result;
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

  /** Worst enabled collision/ground clearance violation, measured in meters. */
  public safetyViolation(states: readonly CameraStateSample[]): number {
    let maximum = 0;
    for (const primitive of this.plan.primitives) {
      if (primitive.type !== "collisionClearance" && primitive.type !== "groundClearance") continue;
      if (primitive.weight <= 0) continue;
      for (const residual of this.residuals(primitive, states)) {
        if (residual.sampleWeight > 0) maximum = Math.max(maximum, residual.value);
      }
    }
    return maximum;
  }
}
