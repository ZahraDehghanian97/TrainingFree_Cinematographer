import { LossFunctionType } from "../../types/solver";
import { DEFAULT_OPTIONS } from "../config/defaults";
import { subjectIdsFromParameters } from "../shared/parameter-values";
import type { CameraOptimizerInput, OptimizerWeights, PrimitiveLoss } from "../types";
import { subjectEntityKey } from "./subjects";
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
  "startTime" | "endTime" | "parameters" | "sourceType" | "sourceActionId" | "weight"
>;

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

function targetOnlyIntents(input: CameraOptimizerInput): SubjectIntent[] {
  return input.timeline.timeline.flatMap((segment) => segment.lossFunctions.flatMap((loss) => {
    if (loss.type !== LossFunctionType.SubjectPresence) return [];
    const pointTime = segment.kind === "point" ? segment.time : undefined;
    const easing = segment.kind === "point" ? segment.easing : undefined;
    return [{
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
  const emitted = new Set<string>();
  for (const owner of [...authored, ...targetOnlyIntents(input)]) {
    if (!SUBJECT_INTENT.has(owner.sourceType) || owner.weight <= 0) continue;
    for (const subjectId of subjectIdsFromParameters(owner.parameters)) {
      const scope = windowFor(owner);
      const timing = {
        ...(owner.parameters.followDelay === undefined ? {} : { followDelay: owner.parameters.followDelay }),
        ...(owner.parameters.leadAmount === undefined ? {} : { leadAmount: owner.parameters.leadAmount }),
      };
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
        ...(scope.pointTime === undefined ? {} : { pointTime: scope.pointTime }),
        ...(scope.easing ? { easing: scope.easing } : {}),
        ...(owner.parameters.motionTransitions ? { motionTransitions: owner.parameters.motionTransitions } : {}),
      };
      const source = {
        startTime: owner.startTime,
        endTime: owner.endTime,
        sourceType: owner.sourceType,
        sourceActionId: owner.sourceActionId,
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
