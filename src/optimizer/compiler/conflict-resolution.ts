import { LossFunctionType } from "../../types/solver";
import {
  finiteNumber,
  subjectIdsFromParameters,
} from "../shared/parameter-values";
import type {
  CameraOptimizerInput,
  ConflictResolution,
  OptimizerWeights,
  PrimitiveLoss,
} from "../types";
import {
  FOV_DRIVING_TYPES,
  ORIENTATION_DRIVING_TYPES,
  TRANSLATION_TYPES,
  YAW_PITCH_TARGETING_TYPES,
} from "./constants";
import { subjectEntityKey } from "./subjects";
import type { ActiveLossBand, AddPrimitive } from "./types";

interface BandConflictOptions {
  input: CameraOptimizerInput;
  band: ActiveLossBand;
  highLevelTypes: LossFunctionType[];
  weights: OptimizerWeights;
  primitives: PrimitiveLoss[];
  bandStartIndex: number;
  add: AddPrimitive;
}

interface BandConflictResult {
  conflicts: ConflictResolution[];
  warnings: string[];
}

/** Applies compound-shot and channel-ownership rules in their semantic order. */
export function resolveBandConflicts({
  input,
  band,
  highLevelTypes,
  weights,
  primitives,
  bandStartIndex,
  add,
}: BandConflictOptions): BandConflictResult {
  const conflicts: ConflictResolution[] = [];
  const warnings: string[] = [];

  const bandPrimitives = (): PrimitiveLoss[] => primitives.slice(bandStartIndex);
  const removeWhere = (predicate: (primitive: PrimitiveLoss) => boolean): string[] => {
    const removed = bandPrimitives().filter(predicate).map((primitive) => primitive.id);
    for (let index = primitives.length - 1; index >= bandStartIndex; index -= 1) {
      if (removed.includes(primitives[index]!.id)) primitives.splice(index, 1);
    }
    return removed;
  };

  // Compound movement fusion.
  const hasArc = highLevelTypes.includes(LossFunctionType.ArcMovement);
  const hasDollyIn = highLevelTypes.includes(LossFunctionType.DollyInMovement);
  const hasDollyOut = highLevelTypes.includes(LossFunctionType.DollyOutMovement);
  if (hasArc && (hasDollyIn || hasDollyOut)) {
    const dollySpan = band.active.find((span) =>
      span.loss.type === LossFunctionType.DollyInMovement
      || span.loss.type === LossFunctionType.DollyOutMovement,
    )!;
    const arcSpan = band.active.find((span) => span.loss.type === LossFunctionType.ArcMovement)!;
    const dollyLoss = dollySpan.loss;
    const arcLoss = arcSpan.loss;
    const arcSubjects = subjectIdsFromParameters(arcLoss.parameters);
    const dollySubjects = subjectIdsFromParameters(dollyLoss.parameters);
    const sameSubject = arcSubjects.length > 0
      && subjectEntityKey(input, arcSubjects) === subjectEntityKey(input, dollySubjects);
    if (sameSubject) {
      const sharedEntityKey = subjectEntityKey(input, arcSubjects);
      const removed = removeWhere((primitive) =>
        subjectEntityKey(input, subjectIdsFromParameters(primitive.parameters)) === sharedEntityKey
        && (
          (primitive.type === "radiusHold" && primitive.sourceType === LossFunctionType.ArcMovement)
          || (
            primitive.type === "orthogonalDrift"
            && (
              primitive.sourceType === LossFunctionType.DollyInMovement
              || primitive.sourceType === LossFunctionType.DollyOutMovement
            )
          )
        ),
      );
      const distance = Math.abs(finiteNumber(dollyLoss.parameters.distance, 2));
      const added = add(
        {
          type: "radiusSchedule",
          channel: "subjectRelative",
          role: "primary",
          parameters: {
            deltaRadius: dollyLoss.type === LossFunctionType.DollyInMovement ? -distance : distance,
            motionStartTime: dollySpan.sourceStartTime,
            motionEndTime: dollySpan.sourceEndTime,
            scheduleKey: `${arcLoss.sourceActionId ?? "arc"}:${dollyLoss.sourceActionId ?? "dolly"}`,
            ...(dollyLoss.parameters.speedKeyframes
              ? { speedKeyframes: dollyLoss.parameters.speedKeyframes }
              : {}),
            subjectIds: arcSubjects,
          },
        },
        {
          startTime: band.startTime,
          endTime: band.endTime,
          sourceType: LossFunctionType.ArcMovement,
          sourceActionId: arcLoss.sourceActionId,
        },
      );
      conflicts.push({
        interval: [band.startTime, band.endTime],
        rule: "arc+dolly=>spiral",
        removedPrimitiveIds: removed,
        addedPrimitiveIds: [added.id],
      });
    } else {
      warnings.push(
        `Arc and Dolly on ${band.startTime}-${band.endTime}s target different subjects; spiral fusion was skipped`,
      );
    }
  }

  const hasPedestal = highLevelTypes.includes(LossFunctionType.PedestalUpMovement)
    || highLevelTypes.includes(LossFunctionType.PedestalDownMovement)
    || highLevelTypes.includes(LossFunctionType.CraneUpMovement)
    || highLevelTypes.includes(LossFunctionType.CraneDownMovement);
  if (hasArc && hasPedestal) {
    const removed = removeWhere((primitive) =>
      primitive.type === "planeHold"
      || (
        primitive.type === "orthogonalDrift"
        && (
          primitive.sourceType === LossFunctionType.PedestalUpMovement
          || primitive.sourceType === LossFunctionType.PedestalDownMovement
        )
      ),
    );
    if (removed.length > 0) conflicts.push({
      interval: [band.startTime, band.endTime],
      rule: "arc+pedestal=>helical-crane",
      removedPrimitiveIds: removed,
      addedPrimitiveIds: [],
    });
  }

  const hasFollow = highLevelTypes.includes(LossFunctionType.FollowMovement);
  if (hasFollow && (hasDollyIn || hasDollyOut)) {
    const followSpan = band.active.find((span) => span.loss.type === LossFunctionType.FollowMovement)!;
    const dollySpan = band.active.find((span) =>
      span.loss.type === LossFunctionType.DollyInMovement
      || span.loss.type === LossFunctionType.DollyOutMovement,
    )!;
    const followKey = subjectEntityKey(
      input,
      subjectIdsFromParameters(followSpan.loss.parameters),
    );
    const dollyKey = subjectEntityKey(
      input,
      subjectIdsFromParameters(dollySpan.loss.parameters),
    );
    if (followKey && followKey === dollyKey) {
      const removed = removeWhere((primitive) =>
        primitive.type === "relativeOffsetHold"
        && primitive.sourceType === LossFunctionType.FollowMovement,
      );
      if (removed.length > 0) conflicts.push({
        interval: [band.startTime, band.endTime],
        rule: "follow+dolly=>radial-follow",
        removedPrimitiveIds: removed,
        addedPrimitiveIds: [],
      });
    } else {
      warnings.push(
        `Follow and Dolly on ${band.startTime}-${band.endTime}s target different subjects; radial fusion was skipped`,
      );
    }
  }

  if (hasFollow && hasPedestal) {
    const removed = removeWhere((primitive) =>
      (
        primitive.type === "relativeOffsetHold"
        && primitive.sourceType === LossFunctionType.FollowMovement
      )
      || (
        primitive.type === "orthogonalDrift"
        && (
          primitive.sourceType === LossFunctionType.PedestalUpMovement
          || primitive.sourceType === LossFunctionType.PedestalDownMovement
        )
      ),
    );
    if (removed.length > 0) conflicts.push({
      interval: [band.startTime, band.endTime],
      rule: "follow+pedestal=>vertical-follow",
      removedPrimitiveIds: removed,
      addedPrimitiveIds: [],
    });
  }

  // Release passive holds when an explicit action owns the same channel.
  if (highLevelTypes.some((type) => TRANSLATION_TYPES.has(type))) {
    const removed = removeWhere((primitive) =>
      (
        primitive.type === "positionHold"
        || (
          primitive.type === "relativeOffsetHold"
          && primitive.sourceType === LossFunctionType.Static
        )
      )
      && (primitive.role === "stabilizer" || primitive.sourceType === LossFunctionType.Static),
    );
    if (removed.length > 0) conflicts.push({
      interval: [band.startTime, band.endTime],
      rule: "translation-removes-position-hold",
      removedPrimitiveIds: removed,
      addedPrimitiveIds: [],
    });
  }
  if (highLevelTypes.some((type) => ORIENTATION_DRIVING_TYPES.has(type))) {
    const hasPanOrTilt = highLevelTypes.some((type) => [
      LossFunctionType.PanLeftMovement,
      LossFunctionType.PanRightMovement,
      LossFunctionType.TiltUpMovement,
      LossFunctionType.TiltDownMovement,
    ].includes(type));
    const removed = removeWhere((primitive) =>
      (
        primitive.type === "orientationHold"
        || (hasPanOrTilt && primitive.type === "forwardHold")
      )
      && (primitive.role === "stabilizer" || primitive.sourceType === LossFunctionType.Static),
    );
    if (removed.length > 0) conflicts.push({
      interval: [band.startTime, band.endTime],
      rule: "rotation-removes-orientation-hold",
      removedPrimitiveIds: removed,
      addedPrimitiveIds: [],
    });
  }
  if (highLevelTypes.some((type) => FOV_DRIVING_TYPES.has(type))) {
    const removed = removeWhere((primitive) =>
      primitive.type === "fovHold"
      && (primitive.role === "stabilizer" || primitive.sourceType === LossFunctionType.Static),
    );
    if (removed.length > 0) conflicts.push({
      interval: [band.startTime, band.endTime],
      rule: highLevelTypes.includes(LossFunctionType.ZoomIn)
        || highLevelTypes.includes(LossFunctionType.ZoomOut)
        ? "zoom-removes-fov-hold"
        : "framing-removes-fov-hold",
      removedPrimitiveIds: removed,
      addedPrimitiveIds: [],
    });
  }
  if (
    highLevelTypes.includes(LossFunctionType.DutchLeftMovement)
    || highLevelTypes.includes(LossFunctionType.DutchRightMovement)
    || highLevelTypes.includes(LossFunctionType.FramingDutchAngle)
  ) {
    const removed = removeWhere((primitive) => primitive.type === "levelHorizon");
    if (removed.length > 0) conflicts.push({
      interval: [band.startTime, band.endTime],
      rule: "dutch-removes-level-horizon",
      removedPrimitiveIds: removed,
      addedPrimitiveIds: [],
    });
  }

  // Stabilizer precedence.
  // levelHorizon owns roll when present. A simultaneous rollHold re-anchors
  // at every split band's current roll and repeatedly fights the fixed level target.
  {
    const hasLevelHorizon = bandPrimitives().some((primitive) => primitive.type === "levelHorizon");
    if (hasLevelHorizon) {
      const removed = removeWhere((primitive) => primitive.type === "rollHold");
      if (removed.length > 0) conflicts.push({
        interval: [band.startTime, band.endTime],
        rule: "level-horizon-removes-roll-hold",
        removedPrimitiveIds: removed,
        addedPrimitiveIds: [],
      });
    }
  }

  // A lone off-axis hold needs more authority against numerical cross-talk.
  // Only strengthen axes with no semantic target, or the hold would fight composition.
  {
    const hasYawTarget = highLevelTypes.some((type) =>
      type === LossFunctionType.PanLeftMovement
      || type === LossFunctionType.PanRightMovement
      || YAW_PITCH_TARGETING_TYPES.has(type),
    );
    const hasPitchTarget = highLevelTypes.some((type) =>
      type === LossFunctionType.TiltUpMovement
      || type === LossFunctionType.TiltDownMovement
      || YAW_PITCH_TARGETING_TYPES.has(type),
    );
    const strengthenedIds: string[] = [];
    const strengthenedWeight = weights.semanticStabilizer * 24;
    for (const primitive of bandPrimitives()) {
      if (
        ((primitive.type === "yawHold" && !hasYawTarget) || (primitive.type === "pitchHold" && !hasPitchTarget))
        && primitive.weight < strengthenedWeight
      ) {
        primitive.weight = strengthenedWeight;
        strengthenedIds.push(primitive.id);
      }
    }
    if (strengthenedIds.length > 0) conflicts.push({
      interval: [band.startTime, band.endTime],
      rule: "under-constrained-hold-strengthened",
      removedPrimitiveIds: [],
      addedPrimitiveIds: strengthenedIds,
    });
  }

  // Composition precedence and conflicting-target diagnostics.
  const offCenterFraming = bandPrimitives().filter((primitive) =>
    primitive.type === "screenPosition"
    && primitive.sourceType === LossFunctionType.FramingPosition
    && Array.isArray(primitive.parameters.target)
    && (primitive.parameters.target[0] !== 0.5 || primitive.parameters.target[1] !== 0.5),
  );
  if (offCenterFraming.length > 0) {
    const framingSubjects = new Set(offCenterFraming.map((primitive) =>
      subjectEntityKey(input, subjectIdsFromParameters(primitive.parameters)),
    ));
    const removedDefaultCentering = removeWhere((primitive) =>
      primitive.type === "screenPosition"
      && primitive.sourceType === LossFunctionType.TrackMovement
      && framingSubjects.has(
        subjectEntityKey(input, subjectIdsFromParameters(primitive.parameters)),
      ),
    );
    if (removedDefaultCentering.length > 0) conflicts.push({
      interval: [band.startTime, band.endTime],
      rule: "explicit-framing-removes-default-centering",
      removedPrimitiveIds: removedDefaultCentering,
      addedPrimitiveIds: [],
    });
    const removed = removeWhere((primitive) =>
      primitive.type === "lookAt"
      && primitive.role === "stabilizer"
      && framingSubjects.has(
        subjectEntityKey(input, subjectIdsFromParameters(primitive.parameters)),
      ),
    );
    if (removed.length > 0) conflicts.push({
      interval: [band.startTime, band.endTime],
      rule: "screen-position-dominates-look-at",
      removedPrimitiveIds: removed,
      addedPrimitiveIds: [],
    });
  }

  const targetSignatures = new Map<string, Set<string>>();
  for (const primitive of bandPrimitives()) {
    if (!["screenScale", "screenPosition", "subjectView", "subjectElevation", "rollTarget"].includes(primitive.type)) {
      continue;
    }
    const subjectIds = subjectIdsFromParameters(primitive.parameters).join("|");
    const key = `${primitive.type}:${subjectIds}`;
    const target = primitive.parameters.target
      ?? primitive.parameters.targetCoverage
      ?? primitive.parameters.targetAzimuth
      ?? primitive.parameters.targetElevation
      ?? primitive.parameters.targetRoll;
    const signatures = targetSignatures.get(key) ?? new Set<string>();
    signatures.add(JSON.stringify(target));
    targetSignatures.set(key, signatures);
  }
  for (const [key, signatures] of targetSignatures) {
    if (signatures.size > 1) {
      warnings.push(
        `Conflicting ${key} targets on ${band.startTime}-${band.endTime}s retained as a weighted compromise`,
      );
    }
  }

  return { conflicts, warnings };
}
