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
import { applyOpticalZoom, fovDegreesToLogFocal, interpolateFovLogFocal } from "../shared/lens";
import { motionTransitionScale } from "../shared/motion-transitions";
import { createCameraPositionCurve } from "../trajectory";
import { CURVE_QUADRATURE, positionChordDeviationBound, samplePositionSegment,
  type CameraPositionCurve } from "../trajectory/position-curve";
import { minimumAngularProgress, minimumTranslationProgress } from "../shared/movement-preferences";
import { temporalQuadratureWeights, fitRobustAmplitude } from "./residual-integration";
import { certifiedObstacleSweep } from "../scene/obstacle-enclosure";
import { sightClearanceResidual, subjectSightTargets } from "../scene/occlusion";
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
  time: number;
  /** Explicit integration measure for interval-valued residuals. */
  measure?: number;
  /** Independent residual families are integrated separately, never averaged together. */
  family?: string;
  tolerance?: number;
  supportStart?: number;
  supportEnd?: number;
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
  private readonly collisionSweepCache = new Map<string, CollisionSweep[]>();
  private readonly collisionBoundaries: number[];
  private readonly cutTimes: number[];
  private readonly collisionExemptions: Array<{ startTime: number; endTime: number; entityIds: string[] }>;
  private readonly primitiveIndices = new Map<string, number[]>();
  private readonly motionIndices = new Map<string, number[]>();
  private readonly warningSet = new Set<string>();
  private positionCurve?: CameraPositionCurve;

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
    if (Math.abs(leadAmount - followDelay) > 1e-12 || primitive.parameters.subjectTimeProfile === true) {
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

  private sampleWeight(primitive: PrimitiveLoss, time: number): number {
    const pointTime = primitive.parameters.pointTime ?? primitive.parameters.keyframeTime;
    if (typeof pointTime !== "number") return 1;
    const easing = primitive.parameters.easing;
    return pointEasingWeight(
      time,
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
      // Subdivision tightens conservative nonlinear enclosures. Safety does
      // not depend on this frequency: every piece encloses its full interval.
      const count = Math.min(48, Math.max(1, Math.ceil(12 * Math.max(to - from, sceneSpan))));
      for (let piece = 0; piece < count; piece += 1) {
        const startTime = from + (to - from) * piece / count;
        const endTime = from + (to - from) * (piece + 1) / count;
        const exempt = this.collisionExemptEntityIdsAtPlaybackTime((startTime + endTime) / 2);
        const sceneStart = playbackToSceneTime(startTime, this.input.timeline.timeWarp,
          this.input.environment.clock.durationSeconds);
        const sceneEnd = playbackToSceneTime(endTime, this.input.timeline.timeWarp,
          this.input.environment.clock.durationSeconds);
        // Exact left limits handle step teleports; the following piece (or
        // endpoint residual) checks their right-hand pose.
        const obstacles = this.input.environment.entities.flatMap((entity) => {
          if (!entity.bounds || exempt.has(entity.id)) return [];
          const sweep = certifiedObstacleSweep(this.input.environment, entity.id, sceneStart, sceneEnd,
            { endExclusive: sceneEnd > sceneStart });
          return sweep ? [{ startBox: sweep.startBox, endBox: sweep.endBox }] : [];
        });
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
      return JSON.stringify([subjectIds, lead - delay,
        primitive.parameters.subjectTimeProfile === true ? [
          primitive.parameters.subjectMotionStartTime ?? primitive.parameters.motionStartTime,
          primitive.parameters.subjectMotionEndTime ?? primitive.parameters.motionEndTime,
          primitive.parameters.subjectSpeedKeyframes ?? primitive.parameters.speedKeyframes] : null]);
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

  /** Integrate physical derivatives of the exact exported position polynomial. */
  private continuousPositionResiduals(
    primitive: PrimitiveLoss,
    states: readonly CameraStateSample[],
    derivative: "acceleration" | "jerk",
  ): WeightedResidual[] {
    const curve = this.positionCurve ?? createCameraPositionCurve(states, this.cutTimes);
    const activation = (time: number) => this.sampleWeight(primitive, time)
      * motionTransitionScale(primitive, time) ** 2;
    if (primitive.endTime - primitive.startTime <= 1e-9) {
      const time = primitive.startTime;
      return [{ value: length3(curve.sample(time)[derivative]), time,
        sampleWeight: activation(time), measure: 1 }];
    }
    return curve.segments.flatMap((segment) => {
      const start = Math.max(primitive.startTime, segment.startTime);
      const end = Math.min(primitive.endTime, segment.endTime);
      if (end <= start || segment.hold) return [];
      return CURVE_QUADRATURE.map(([node, weight]) => {
        const time = (start + end) / 2 + node * (end - start) / 2;
        return { value: length3(samplePositionSegment(segment, time)[derivative]), time,
          measure: weight * (end - start) / 2, sampleWeight: activation(time) };
      });
    });
  }

  private residuals(
    primitive: PrimitiveLoss,
    states: readonly CameraStateSample[],
  ): WeightedResidual[] {
    const indices = this.primitiveIndices.get(primitive.id) ?? [];
    if (indices.length === 0) return [];
    const weighted = (
      index: number,
      value: number,
      metadata: Partial<Omit<WeightedResidual, "value">> = {},
    ): WeightedResidual => {
      const time = metadata.time ?? this.times[index]!;
      return {
        value,
        time,
        // Activation is an objective weight, not a change to Huber's threshold.
        sampleWeight: this.sampleWeight(primitive, time) * motionTransitionScale(primitive, time) ** 2,
        ...metadata,
      };
    };
    const stepWeighted = (
      previousIndex: number, index: number, value: number,
      metadata: Partial<Omit<WeightedResidual, "value">> = {},
    ): WeightedResidual => weighted(index, value, {
      time: (this.times[previousIndex]! + this.times[index]!) / 2,
      measure: this.times[index]! - this.times[previousIndex]!,
      ...metadata,
    });
    const derivativeWeighted = (index: number, value: number, time = this.times[index]!): WeightedResidual => {
      const cuts = [...this.cutTimes, ...cutTimesFrom(primitive)];
      const supportStart = Math.max(primitive.startTime, ...cuts.filter((cut) => cut <= time));
      const supportEnd = Math.min(primitive.endTime, ...cuts.filter((cut) => cut > time));
      return weighted(index, value, { time, family: `derivative:${supportStart}:${supportEnd}`, supportStart, supportEnd });
    };
    const firstIndex = typeof primitive.parameters.referenceTime === "number"
      ? intervalIndices(this.times, primitive.parameters.referenceTime, primitive.parameters.referenceTime)[0]!
      : indices[0]!;
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
          result.push(stepWeighted(previousIndex, currentIndex, Math.max(0, -progressRate)));
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
        const axialTotal = dot3(this.relativeDisplacement(primitive, sourceFirst,
          sourceIndices[sourceIndices.length - 1]!, states), axis);
        const phaseAt = (index: number): number => {
          // Path geometry gamma(v) and time scaling v(t) are separate. Without
          // an authored profile, candidate axial progress determines v, so a
          // monotone retiming of the same curve does not change its shape.
          const progress = primitive.parameters.speedKeyframes !== undefined
            ? motionProgress((this.times[index]! - motionStart) / duration, primitive.parameters.speedKeyframes)
            : Math.abs(axialTotal) > 1e-9 ? clamp(dot3(this.relativeDisplacement(
              primitive, sourceFirst, index, states), axis) / axialTotal, 0, 1) : 0;
          return primitive.parameters.path === "spline"
            ? Math.sin(2 * Math.PI * progress) : Math.sin(Math.PI * progress);
        };
        const targetDistance = primitive.parameters.fullTargetDistance ?? primitive.parameters.targetDistance;
        const distance = typeof targetDistance === "number" ? targetDistance
          : Math.abs(this.translationProgress(primitive, sourceIndices, states));
        const minimumBend = Math.max(0, distance * 0.02);
        const fitFreeAmplitude = (): number => {
          // All overlap bands from one motion share ONE latent amplitude. Sum
          // their exact objective measures, including differing weights/fades;
          // fitting each band independently would change the path on a split.
          const geometryKey = (item: PrimitiveLoss): string => JSON.stringify([
            item.sourceType, item.sourceActionId,
            item.parameters.motionStartTime ?? item.startTime,
            item.parameters.motionEndTime ?? item.endTime,
            Object.keys(item.parameters).sort().filter((key) => key !== "motionTransitions"
              && !(key === "targetDistance" && typeof item.parameters.fullTargetDistance === "number"))
              .map((key) => [key, item.parameters[key]]),
          ]);
          const key = geometryKey(primitive);
          const bands = this.plan.primitives.filter((item) => item.type === "pathProfile"
            && item.weight > 0 && geometryKey(item) === key);
          const observations: Parameters<typeof fitRobustAmplitude>[0][number][] = [];
          const minimumBends: { amplitude: number; weight: number; tolerance: number }[] = [];
          for (const band of bands) {
            const bandIndices = this.primitiveIndices.get(band.id) ?? [];
            const bandTimes = bandIndices.map((index) => this.times[index]!);
            const measures = temporalQuadratureWeights(bandTimes, band.startTime, band.endTime);
            const bandDuration = band.normalizationDuration ?? (
              typeof band.parameters.motionStartTime === "number" && typeof band.parameters.motionEndTime === "number"
                ? band.parameters.motionEndTime - band.parameters.motionStartTime : band.endTime - band.startTime);
            const normalizer = bandDuration > 1e-9 ? bandDuration : 1;
            let minimumWeight = 0;
            bandIndices.forEach((index, localIndex) => {
              const displacement = this.relativeDisplacement(primitive, sourceFirst, index, states);
              const orthogonal = sub3(displacement, scale3(axis, dot3(displacement, axis)));
              const y = dot3(orthogonal, lateral);
              const weight = measures[localIndex]! * this.sampleWeight(band, this.times[index]!)
                * motionTransitionScale(band, this.times[index]!) ** 2 * band.weight / normalizer;
              observations.push({ phase: phaseAt(index), lateral: y,
                orthogonalSquared: dot3(orthogonal, orthogonal) - y * y,
                weight, tolerance: band.tolerance });
              minimumWeight += weight;
            });
            minimumBends.push({ amplitude: minimumBend, weight: minimumWeight, tolerance: band.tolerance });
          }
          return fitRobustAmplitude(observations, primitive.tolerance, minimumBends);
        };
        const amplitude = typeof primitive.parameters.curveIntensity === "number"
          ? distance * 0.25 * clamp(primitive.parameters.curveIntensity / 10, 0, 1)
          : fitFreeAmplitude();
        const residuals = indices.map((index) => {
          const phase = phaseAt(index);
          const displacement = this.relativeDisplacement(primitive, sourceFirst, index, states);
          const orthogonal = sub3(displacement, scale3(axis, dot3(displacement, axis)));
          return weighted(index, distance3(orthogonal, scale3(lateral, amplitude * phase)));
        });
        if (primitive.parameters.curveIntensity === undefined) {
          // Integrate the floor over the same support/activation as the shape,
          // rather than giving the whole interval its last sample's fade.
          residuals.push(...indices.map((index) => weighted(index,
            Math.max(0, minimumBend - Math.abs(amplitude)), { family: "minimumBend" })));
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
          return stepWeighted(previousIndex, index, (progress - target) / dt);
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
        return steps.slice(1).flatMap((step, index) => {
          const first = indices[index]!;
          const last = indices[index + 2]!;
          if (crossesCut(this.times[first]!, this.times[last]!, this.cutTimes)) return [];
          return [derivativeWeighted(indices[index + 1]!, 2 * (step.value - steps[index]!.value)
            / Math.max(1e-9, this.times[last]! - this.times[first]!))];
        });
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
        return angles.slice(1).map((angle, index) => stepWeighted(
          indices[index]!, indices[index + 1]!,
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
          return stepWeighted(
            indices[index]!, indices[index + 1]!,
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
            ? actualDelta - requestedDelta : Math.max(0, minimum - sign * actualDelta), { family: "endpoint" })];
          const duration = Math.max(1e-9, scheduleEndTime - scheduleStartTime);
          for (let localIndex = 1; localIndex < indices.length; localIndex += 1) {
            const index = indices[localIndex]!;
            const previousIndex = indices[localIndex - 1]!;
            const dt = Math.max(1e-6, this.times[index]! - this.times[previousIndex]!);
            residuals.push(stepWeighted(previousIndex, index,
              Math.max(0, -sign * (radiusAt(index) - radiusAt(previousIndex)) / dt),
              { family: "directionRate", tolerance: 0.12 }));
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
          const bounds = projectWorldBox(subject.box, state.position, state.rotation, state.fovYDegrees, this.options.aspectRatio, this.options.nearPlane);
          if (primitive.type === "subjectScaleFloor") {
            const minimum = typeof primitive.parameters.minimumCoverage === "number"
              ? primitive.parameters.minimumCoverage : DEFAULT_OPTIONS.minimumSubjectCoverage;
            const residual = weighted(index, Math.max(0, minimum - bounds.height));
            residual.sampleWeight *= preference;
            return [residual];
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
          const centerResidual = weighted(index, directionMiss, { family: "center" });
          const boundsResidual = weighted(index, overflow, { family: "bounds" });
          centerResidual.sampleWeight *= preference;
          boundsResidual.sampleWeight *= preference * cropPreference;
          return [centerResidual, boundsResidual];
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
        const region = primitive.parameters.targetRegion as { x: [number, number]; y: [number, number] } | undefined;
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
          const miss = region
            ? Math.hypot(projection.x - clamp(projection.x, region.x[0], region.x[1]),
              projection.y - clamp(projection.y, region.y[0], region.y[1]))
            : Math.hypot(projection.x - Number(target[0]), projection.y - Number(target[1]));
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
            this.options.nearPlane,
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
        const range = primitive.parameters.coverageRange as [number, number] | undefined;
        return indices.flatMap((index) => {
          const subject = this.subject(primitive, index);
          if (!subject) return [];
          const bounds = projectWorldBox(
            subject.box,
            states[index]!.position,
            states[index]!.rotation,
            states[index]!.fovYDegrees,
            this.options.aspectRatio,
            this.options.nearPlane,
          );
          return [weighted(index, range
            ? bounds.height - clamp(bounds.height, range[0], range[1])
            : bounds.height - targetCoverage)];
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
          // subject() already samples the authored reference clock. Applying
          // speedScale again would disagree with the fixed relative offset.
          result.push(stepWeighted(previousIndex, index, distance3(cameraVelocity, subjectVelocity)));
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
        const direction = primitive.parameters.direction === "in" ? "in" : "out";
        const expected = typeof primitive.parameters.targetFovYDegrees === "number"
          ? primitive.parameters.targetFovYDegrees
          : typeof factor === "number" ? applyOpticalZoom(start, factor, direction) : undefined;
        const startLog = fovDegreesToLogFocal(start);
        const endLog = fovDegreesToLogFocal(end);
        const expectedLog = expected === undefined ? undefined : fovDegreesToLogFocal(expected);
        // A supplied sub-unity ratio reverses the effective lens change. Its
        // numeric relationship takes precedence over the action's usual sign.
        const directionSign = direction === "in" ? 1 : -1;
        const sign = expectedLog === undefined ? directionSign : Math.sign(expectedLog - startLog) || directionSign;
        const minimum = this.input.options?.minimumZoomChangeDegrees ?? DEFAULT_OPTIONS.minimumZoomChangeDegrees;
        const minimumLog = Math.abs(fovDegreesToLogFocal(clamp(start - directionSign * minimum, 1e-4, 179.9999)) - startLog);
        const residuals = [weighted(lastIndex, expectedLog === undefined
          ? Math.max(0, minimumLog - sign * (endLog - startLog)) : endLog - expectedLog,
        { family: "endpoint" })];
        for (let localIndex = 1; localIndex < indices.length; localIndex += 1) {
          const index = indices[localIndex]!;
          const previousIndex = indices[localIndex - 1]!;
          const dt = Math.max(1e-6, this.times[index]! - this.times[previousIndex]!);
          residuals.push(stepWeighted(previousIndex, index, Math.max(0,
            -sign * (fovDegreesToLogFocal(states[index]!.fovYDegrees)
              - fovDegreesToLogFocal(states[previousIndex]!.fovYDegrees)) / dt,
          ), { family: "directionRate", tolerance: 0.02 }));
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
            ? applyOpticalZoom(start, factor, primitive.parameters.direction === "in" ? "in" : "out")
            : states[sourceLast]!.fovYDegrees;
        return indices.map((index) => {
          const normalizedTime = (this.times[index]! - this.times[sourceFirst]!)
            / Math.max(1e-9, this.times[sourceLast]! - this.times[sourceFirst]!);
          const expected = interpolateFovLogFocal(start, end,
            motionProgress(normalizedTime, primitive.parameters.speedKeyframes));
          return weighted(index, fovDegreesToLogFocal(states[index]!.fovYDegrees) - fovDegreesToLogFocal(expected));
        });
      }
      case "collisionClearance": {
        const requested = this.options.cameraRadius + this.options.collisionMargin;
        const curve = this.positionCurve ?? createCameraPositionCurve(states, this.cutTimes);
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
            const segment = curve.restrict(sweep.startTime, sweep.endTime);
            const start = segment.controls[0]!;
            const end = segment.controls[segment.controls.length - 1]!;
            // Bernstein convex hull + 1-Lipschitz signed distance. This bound
            // covers the complete quintic, including one-sided pre-cut holds.
            const curveBound = positionChordDeviationBound(segment);
            for (const obstacle of sweep.obstacles) {
              const minimum = minimumSignedDistanceToMovingAabb(
                start, end, obstacle.startBox, obstacle.endBox, requested + curveBound,
              );
              violation = Math.max(violation, requested + curveBound - minimum);
            }
          }
          result.push(stepWeighted(previousIndex, index, violation, { family: "swept" }));
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
          const targets = subjectIdsFromParameters(primitive.parameters).flatMap((subjectId) => {
            const subject = this.subject({ ...primitive, parameters: { ...primitive.parameters, subjectId } }, index);
            if (!subject) return [];
            const ownEntities = new Set(subject.entityIds);
            const obstacles = this.obstacles(index).filter((obstacle) => !ownEntities.has(obstacle.entityId));
            const clearance = typeof primitive.parameters.sightMargin === "number"
              ? primitive.parameters.sightMargin : 0.05;
            return [sightClearanceResidual(states[index]!.position,
              subjectSightTargets(subject.box, subject.center), obstacles.map((obstacle) => obstacle.box), clearance)];
          });
          if (targets.length === 0) return [];
          const residual = weighted(index, Math.sqrt(mean(targets.map((value) => value * value))));
          residual.sampleWeight *= preference;
          return [residual];
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
        if (primitive.parameters.referenceFrame !== "subjectRelative") {
          return this.continuousPositionResiduals(primitive, states, "acceleration");
        }
        const cutTimes = [...this.cutTimes, ...cutTimesFrom(primitive)];
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
          result.push(derivativeWeighted(bIndex, length3(scale3(sub3(v1, v0), 2 / (dt0 + dt1))),
            (this.times[aIndex]! + this.times[bIndex]! + this.times[cIndex]!) / 3));
        }
        return result;
      }
      case "angularAccelerationSmoothness": {
        const cutTimes = [...this.cutTimes, ...cutTimesFrom(primitive)];
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
          result.push(derivativeWeighted(
            bIndex,
            length3(scale3(sub3(w1, w0), 2 / (dt0 + dt1))),
          ));
        }
        return result;
      }
      case "jerkSmoothness": {
        if (primitive.parameters.referenceFrame !== "subjectRelative") {
          return this.continuousPositionResiduals(primitive, states, "jerk");
        }
        const cutTimes = [...this.cutTimes, ...cutTimesFrom(primitive)];
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
          result.push(derivativeWeighted(c, length3(scale3(sub3(a1, a0), 3 / (dt0 + dt1 + dt2))),
            (this.times[a]! + this.times[b]! + this.times[c]! + this.times[d]!) / 4));
        }
        return result;
      }
      case "pathLength": {
        const result: WeightedResidual[] = [];
        for (let localIndex = 1; localIndex < indices.length; localIndex += 1) {
          const previousIndex = indices[localIndex - 1]!;
          const index = indices[localIndex]!;
          if (crossesCut(this.times[previousIndex]!, this.times[index]!, this.cutTimes)) continue;
          const dt = Math.max(1e-6, this.times[index]! - this.times[previousIndex]!);
          result.push(stepWeighted(
            previousIndex, index,
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
    if (!this.finiteStates(states)) return { total: Infinity, breakdown: [] };
    this.positionCurve = createCameraPositionCurve(states, this.cutTimes);
    let total = 0;
    const breakdown: LossBreakdownEntry[] = [];
    for (const primitive of this.plan.primitives) {
      if (primitive.weight <= 0) continue;
      const rawResiduals = this.residuals(primitive, states);
      if (rawResiduals.some((residual) => !Number.isFinite(residual.value)
        || !Number.isFinite(residual.time) || !Number.isFinite(residual.sampleWeight)
        || (residual.measure !== undefined && !Number.isFinite(residual.measure)))) {
        return { total: Infinity, breakdown: [] };
      }
      const residuals = rawResiduals.filter((residual) => residual.sampleWeight > 0);
      if (residuals.length === 0) continue;
      const squared = primitive.sourceType === "userKeyframe"
        || primitive.channel === "safety"
        || primitive.type === "bboxInFrame"
        || ((primitive.type === "accelerationSmoothness" || primitive.type === "jerkSmoothness")
          && primitive.parameters.referenceFrame !== "subjectRelative");
      const families = new Map<string, WeightedResidual[]>();
      // Keep zero-activation samples in the quadrature: dropping them would
      // enlarge neighboring cells and partly undo an authored fade/suppression.
      for (const residual of rawResiduals) {
        const key = residual.family ?? "value";
        const family = families.get(key) ?? [];
        family.push(residual);
        families.set(key, family);
      }
      let integral = 0;
      for (const family of families.values()) {
        const quadrature = temporalQuadratureWeights(
          family.map((residual) => residual.time),
          family[0]!.supportStart ?? primitive.startTime, family[0]!.supportEnd ?? primitive.endTime,
        );
        integral += family.reduce((sum, residual, index) => {
          const normalized = residual.value / Math.max(1e-12, residual.tolerance ?? primitive.tolerance);
          const cost = primitive.type === "pathLength" ? Math.abs(normalized)
            : squared ? 0.5 * normalized * normalized : huber(normalized, 2);
          return sum + Math.max(0, residual.sampleWeight) * (residual.measure ?? quadrature[index]!) * cost;
        }, 0);
      }
      const motionStart = primitive.parameters.motionStartTime;
      const motionEnd = primitive.parameters.motionEndTime;
      const duration = primitive.normalizationDuration
        ?? (typeof motionStart === "number" && typeof motionEnd === "number" ? motionEnd - motionStart
          : primitive.endTime - primitive.startTime);
      // Arc length is an integral in meters. Other interval objectives are
      // averages over the ORIGINAL support; split bands retain one total budget.
      const normalizer = primitive.type === "pathLength" || duration <= 1e-9 ? 1 : duration;
      const weightedLoss = primitive.weight * integral / normalizer;
      if (!Number.isFinite(weightedLoss)) return { total: Infinity, breakdown: [] };
      total += weightedLoss;
      if (includeBreakdown) breakdown.push({ id: primitive.id, type: primitive.type, weightedLoss });
    }
    breakdown.sort((a, b) => b.weightedLoss - a.weightedLoss);
    return { total, breakdown };
  }

  /** Worst enabled collision/ground clearance violation, measured in meters. */
  public safetyViolation(states: readonly CameraStateSample[]): number {
    if (!this.finiteStates(states)) return Infinity;
    this.positionCurve = createCameraPositionCurve(states, this.cutTimes);
    let maximum = 0;
    for (const primitive of this.plan.primitives) {
      if (primitive.type !== "collisionClearance" && primitive.type !== "groundClearance") continue;
      if (primitive.weight <= 0) continue;
      for (const residual of this.residuals(primitive, states)) {
        if (!Number.isFinite(residual.value)) return Infinity;
        if (residual.sampleWeight > 0) maximum = Math.max(maximum, residual.value);
      }
    }
    return maximum;
  }

  private finiteStates(states: readonly CameraStateSample[]): boolean {
    return states.length === this.times.length && states.every((state, index) =>
      Number.isFinite(state.time) && Math.abs(state.time - this.times[index]!) <= 1e-8
      && state.position.length === 3 && state.position.every(Number.isFinite)
      && state.rotation.length === 4 && state.rotation.every(Number.isFinite)
      && Number.isFinite(Math.hypot(...state.rotation)) && Math.hypot(...state.rotation) > 1e-12
      && Number.isFinite(state.fovYDegrees) && state.fovYDegrees > 0 && state.fovYDegrees < 180,
    );
  }
}
