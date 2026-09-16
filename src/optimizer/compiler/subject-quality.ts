import { LossFunctionType } from "../../types/solver";
import { DEFAULT_OPTIONS } from "../config/defaults";
import { subjectIdsFromParameters } from "../shared/parameter-values";
import type { CameraOptimizerInput, OptimizerWeights, PrimitiveLoss } from "../types";
import { subjectEntityKey } from "./subjects";
import { subjectTimingParameters } from "../scene/primitive-context";
import type { AddPrimitive } from "./types";

const SUBJECT_INTENT = new Set<PrimitiveLoss["sourceType"]>([
  LossFunctionType.DollyInMovement, LossFunctionType.DollyOutMovement,
  LossFunctionType.ArcMovement, LossFunctionType.FollowMovement,
  LossFunctionType.TrackMovement, LossFunctionType.CraneUpMovement,
  LossFunctionType.CraneDownMovement, LossFunctionType.Static,
  LossFunctionType.ShotSize, LossFunctionType.FramingPosition,
  LossFunctionType.SubjectView, LossFunctionType.CameraVerticalAngle,
  LossFunctionType.KeepInFrame, LossFunctionType.FramingDutchAngle,
  LossFunctionType.SubjectPresence,
]);

type SubjectIntent = Pick<PrimitiveLoss,
  "startTime" | "endTime" | "parameters" | "sourceType" | "sourceActionId" | "weight" | "normalizationDuration"
> & { shotStartTime?: number };

/** Serializable time scope of authored composition that takes precedence over a fallback. */
export interface CompositionWindow {
  startTime: number;
  endTime: number;
  pointTime?: number;
  easing?: { inDuration?: number; outDuration?: number; curve?: string };
}

function windowFor(primitive: Pick<PrimitiveLoss, "parameters" | "startTime" | "endTime">): CompositionWindow {
  const pointTime = primitive.parameters.pointTime ?? primitive.parameters.keyframeTime;
  return {
    startTime: primitive.startTime,
    endTime: primitive.endTime,
    ...(typeof pointTime === "number" ? { pointTime } : {}),
    ...(primitive.parameters.easing ? { easing: primitive.parameters.easing as CompositionWindow["easing"] } : {}),
  };
}

function timelineSubjectIntents(input: CameraOptimizerInput): SubjectIntent[] {
  return input.timeline.timeline.flatMap((segment) => segment.lossFunctions.flatMap((loss) => {
    if (!SUBJECT_INTENT.has(loss.type)) return [];
    const pointTime = segment.kind === "point" ? segment.time : undefined;
    const easing = segment.kind === "point" ? segment.easing : undefined;
    return [{
      shotStartTime: segment.shotStartTime,
      startTime: segment.kind === "interval" ? segment.startTime : Math.max(0, segment.time - (easing?.inDuration ?? 0)),
      endTime: segment.kind === "interval" ? segment.endTime
        : Math.min(input.environment.clock.durationSeconds, segment.time + (easing?.outDuration ?? 0)),
      parameters: {
        ...loss.parameters,
        ...(pointTime === undefined ? {} : { pointTime }),
        ...(easing ? { easing } : {}),
      },
      sourceType: loss.type,
      sourceActionId: loss.sourceActionId,
      weight: segment.weight ?? 1,
    }];
  }));
}

/** Carry the shot's subject through unauthored gaps without extending its movement. */
function gapSubjectIntents(input: CameraOptimizerInput, intents: readonly SubjectIntent[]): SubjectIntent[] {
  const duration = input.environment.clock.durationSeconds;
  const cuts = [...new Set([0, ...(input.timeline.cutTimes ?? []),
    ...(input.userKeyframes ?? []).filter((keyframe) => keyframe.cutBefore).map((keyframe) => keyframe.time), duration])]
    .filter((time) => time >= 0 && time <= duration).sort((a, b) => a - b);
  const authoredShotStarts = [...new Set(input.timeline.timeline.flatMap((segment) =>
    segment.shotStartTime === undefined ? [] : [segment.shotStartTime],
  ))].sort((a, b) => a - b);
  const authoredWindows = input.timeline.timeline.filter((segment) =>
    (segment.weight ?? 1) > 0 && segment.lossFunctions.some((loss) =>
      ![LossFunctionType.Collision, LossFunctionType.Smoothness,
        LossFunctionType.NoShake, LossFunctionType.GroundLevel].includes(loss.type),
    ),
  ).map((segment) => {
    const shotStart = segment.shotStartTime ?? 0;
    const shotEnd = segment.shotStartTime === undefined ? duration
      : authoredShotStarts.find((time) => time > shotStart) ?? duration;
    return {
      startTime: Math.max(shotStart, segment.kind === "interval"
        ? segment.startTime : segment.time - (segment.easing?.inDuration ?? 0)),
      endTime: Math.min(shotEnd, segment.kind === "interval"
        ? segment.endTime : segment.time + (segment.easing?.outDuration ?? 0)),
    };
  });
  const subjects = intents.filter((intent) => intent.weight > 0
    && SUBJECT_INTENT.has(intent.sourceType) && subjectIdsFromParameters(intent.parameters).length > 0);
  const gaps: SubjectIntent[] = [];
  for (let shot = 1; shot < cuts.length; shot += 1) {
    const shotStart = cuts[shot - 1]!;
    const shotEnd = cuts[shot]!;
    const authoredShotBoundary = authoredShotStarts.includes(shotStart);
    const shotSubjects = subjects.filter((intent) => (intent.shotStartTime === undefined || intent.shotStartTime < shotEnd)
      && (intent.shotStartTime === undefined
      || intent.shotStartTime >= shotStart
      // A user cut can subdivide a DSL shot, but its earlier endpoint cannot
      // introduce a subject into the newly cut shot.
      || (!authoredShotBoundary && (intent.startTime > shotStart
        || (intent.startTime < shotStart && intent.endTime > shotStart))))
      && (intent.startTime < shotEnd
      || (shotEnd === duration && intent.startTime === duration))
      && (intent.endTime > shotStart || intent.startTime === shotStart));
    if (shotSubjects.length === 0) continue;
    const boundaries = [...new Set([shotStart, shotEnd, ...authoredWindows.flatMap((window) =>
      [window.startTime, window.endTime].filter((time) => time > shotStart && time < shotEnd),
    )])].sort((a, b) => a - b);
    for (let index = 1; index < boundaries.length; index += 1) {
      const startTime = boundaries[index - 1]!;
      const endTime = boundaries[index]!;
      const midpoint = (startTime + endTime) / 2;
      if (authoredWindows.some((window) => window.startTime <= midpoint && window.endTime >= midpoint)) continue;
      const previous = shotSubjects.filter((intent) => intent.endTime <= startTime + 1e-9);
      const contextTime = previous.length > 0
        ? Math.max(...previous.map((intent) => intent.endTime))
        : Math.min(...shotSubjects.map((intent) => intent.startTime));
      const owners = previous.length > 0
        ? previous.filter((intent) => Math.abs(intent.endTime - contextTime) < 1e-9)
        : shotSubjects.filter((intent) => Math.abs(intent.startTime - contextTime) < 1e-9);
      const subjectIds = [...new Set(owners.flatMap((intent) => subjectIdsFromParameters(intent.parameters)))];
      gaps.push({
        startTime, endTime, parameters: { subjectIds, gapSubject: true },
        sourceType: LossFunctionType.SubjectPresence, weight: 1,
      });
    }
  }
  return gaps;
}

/**
 * Inequality preferences, never a guessed center, shot size, radius, or pose.
 * Scope per subject and time, including exact points and eased point windows.
 */
export function addSubjectQualityLosses(
  input: CameraOptimizerInput,
  primitives: readonly PrimitiveLoss[],
  weights: OptimizerWeights,
  add: AddPrimitive,
): void {
  const authored = [...primitives];
  const timelineIntents = timelineSubjectIntents(input);
  const intents = [...authored, ...timelineIntents.filter((intent) => intent.sourceType === LossFunctionType.SubjectPresence)];
  const emitted = new Set<string>();
  for (const owner of [...intents, ...gapSubjectIntents(input, timelineIntents)]) {
    if (!SUBJECT_INTENT.has(owner.sourceType) || owner.weight <= 0) continue;
    for (const subjectId of subjectIdsFromParameters(owner.parameters)) {
      const scope = windowFor(owner);
      const timing = subjectTimingParameters(owner.parameters);
      const key = JSON.stringify([subjectId, scope, timing]);
      if (emitted.has(key)) continue;
      emitted.add(key);
      const entity = subjectEntityKey(input, [subjectId]);
      const overlaps = (other: PrimitiveLoss): boolean => other.weight > 0
        && other.startTime <= owner.endTime + 1e-9
        && other.endTime >= owner.startTime - 1e-9;
      const sameSubject = (other: PrimitiveLoss): boolean => subjectIdsFromParameters(other.parameters)
        .some((id) => subjectEntityKey(input, [id]) === entity);
      const sizeWindows = authored.filter((other) =>
        other.type === "screenScale" && overlaps(other) && sameSubject(other),
      ).map(windowFor);
      const orientationWindows = authored.filter((other) => overlaps(other) && (
        other.type === "rotationAnchor"
        || (other.type === "lookAt" && other.sourceType === LossFunctionType.MinPath)
      )).map(windowFor);
      const parameters = {
        subjectId,
        ...timing,
        ...(owner.parameters.gapSubject ? { gapSubject: true } : {}),
        ...(scope.pointTime === undefined ? {} : { pointTime: scope.pointTime }),
        ...(scope.easing ? { easing: scope.easing } : {}),
        ...(owner.parameters.motionTransitions ? { motionTransitions: owner.parameters.motionTransitions } : {}),
      };
      const source = {
        startTime: owner.startTime,
        endTime: owner.endTime,
        sourceType: owner.sourceType,
        sourceActionId: owner.sourceActionId,
        normalizationDuration: owner.normalizationDuration ?? owner.endTime - owner.startTime,
      };
      add({
        type: "subjectVisibility",
        channel: "composition",
        role: "stabilizer",
        parameters: { ...parameters, cropWindows: sizeWindows, suppressionWindows: orientationWindows },
      }, { ...source, explicitWeight: weights.subjectVisibility });
      add({
        type: "subjectScaleFloor",
        channel: "composition",
        role: "stabilizer",
        parameters: {
          ...parameters,
          minimumCoverage: input.options?.minimumSubjectCoverage ?? DEFAULT_OPTIONS.minimumSubjectCoverage,
          suppressionWindows: [...sizeWindows, ...orientationWindows],
        },
      }, { ...source, explicitWeight: weights.subjectScaleFloor });
    }
  }
}
