import { LossFunctionType } from "../../types/solver";
import {
  subjectIdsFromParameters,
} from "../shared/parameter-values";
import type {
  CameraOptimizerInput,
  ConflictResolution,
  MotionTransition,
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
import { subjectTimingParameters } from "../scene/primitive-context";
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
      // The fused schedule replaces both actions' local radius/path losses.
      // Preserve the transition edges from either contributor, even when the
      // other action continues through the handoff.
      const motionTransitions = [...new Map(bandPrimitives()
        .filter((primitive) =>
          subjectEntityKey(input, subjectIdsFromParameters(primitive.parameters)) === sharedEntityKey
          && (
            (primitive.sourceType === arcLoss.type && primitive.sourceActionId === arcLoss.sourceActionId)
            || (primitive.sourceType === dollyLoss.type && primitive.sourceActionId === dollyLoss.sourceActionId)
          ),
        )
        .flatMap((primitive) => primitive.parameters.motionTransitions as MotionTransition[] | undefined ?? [])
        .filter((window) => [
          arcSpan.sourceStartTime, arcSpan.sourceEndTime,
          dollySpan.sourceStartTime, dollySpan.sourceEndTime,
        ].some((edge) => Math.abs(window.boundaryTime - edge) <= 1e-8))
        .map((window) => [window.boundaryTime, window] as const)).values()]
        .sort((left, right) => left.boundaryTime - right.boundaryTime);
      const removed = removeWhere((primitive) =>
        subjectEntityKey(input, subjectIdsFromParameters(primitive.parameters)) === sharedEntityKey
        && (
          ((primitive.type === "radiusHold" || primitive.type === "planeHold")
            && primitive.sourceType === LossFunctionType.ArcMovement)
          || (
            ["axisProgress", "totalProgressTarget", "orthogonalDrift", "pathProfile", "stepPacing", "stepSmoothness"].includes(primitive.type)
            && (
              primitive.sourceType === LossFunctionType.DollyInMovement
              || primitive.sourceType === LossFunctionType.DollyOutMovement
            )
          )
        ),
      );
      const distance = typeof dollyLoss.parameters.distance === "number"
        ? Math.abs(dollyLoss.parameters.distance)
        : undefined;
      const sign = dollyLoss.type === LossFunctionType.DollyInMovement ? -1 : 1;
      const added = add(
        {
          type: "radiusSchedule",
          channel: "subjectRelative",
          role: "primary",
          parameters: {
            sign,
            ...(distance === undefined ? {} : { deltaRadius: sign * distance }),
            motionStartTime: dollySpan.sourceStartTime,
            motionEndTime: dollySpan.sourceEndTime,
            scheduleKey: `${arcLoss.sourceActionId ?? "arc"}:${dollyLoss.sourceActionId ?? "dolly"}`,
            // A dolly towards a detail (for example the eyes) approaches that
            // anchor in 3D. A horizontal body-radius schedule would discard
            // its vertical travel and prevent an elevated spiral descending.
            radiusMetric: "distance",
            orbitSubjectIds: arcSubjects,
            ...(dollyLoss.parameters.speedKeyframes
              ? { speedKeyframes: dollyLoss.parameters.speedKeyframes }
              : {}),
            ...(motionTransitions.length > 0 ? { motionTransitions } : {}),
            subjectIds: dollySubjects,
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

  const follows = band.active.filter((span) => span.loss.type === LossFunctionType.FollowMovement);
  const verticalTypes = new Set([
    LossFunctionType.PedestalUpMovement, LossFunctionType.PedestalDownMovement,
    LossFunctionType.CraneUpMovement, LossFunctionType.CraneDownMovement,
  ]);
  const companions = band.active.filter((span) => verticalTypes.has(span.loss.type)
    || span.loss.type === LossFunctionType.DollyInMovement || span.loss.type === LossFunctionType.DollyOutMovement);
  for (const follow of follows) {
    const followIds = subjectIdsFromParameters(follow.loss.parameters);
    const followKey = subjectEntityKey(input, followIds);
    if (!followKey) continue;
    const sameRig = (parameters: Record<string, unknown>, startTime: number, endTime: number): boolean => {
      const ids = subjectIdsFromParameters(parameters);
      // An otherwise world-space move may inherit the only active Follow rig.
      if (ids.length > 0) return subjectEntityKey(input, ids) === followKey;
      const rigs = new Set(input.timeline.timeline.flatMap((segment) =>
        segment.kind !== "interval" || segment.startTime >= endTime || segment.endTime <= startTime
          ? [] : segment.lossFunctions.filter((loss) => loss.type === LossFunctionType.FollowMovement)
            .map((loss) => subjectEntityKey(input, subjectIdsFromParameters(loss.parameters))),
      ));
      return rigs.size === 1 && rigs.has(followKey);
    };
    const ownsFollow = (primitive: PrimitiveLoss): boolean =>
      primitive.sourceType === LossFunctionType.FollowMovement
      && primitive.sourceActionId === follow.loss.sourceActionId
      && subjectEntityKey(input, subjectIdsFromParameters(primitive.parameters)) === followKey;
    // After a genuine relative move, hold its resulting rig offset. Unrelated
    // band boundaries keep the original reference and cannot reset the target.
    const completedEnds = input.timeline.timeline.flatMap((segment) => {
      if (segment.kind !== "interval" || segment.endTime > band.startTime + 1e-9
        || segment.endTime <= follow.sourceStartTime || segment.startTime >= follow.sourceEndTime) return [];
      return segment.lossFunctions.some((loss) => (verticalTypes.has(loss.type)
        || loss.type === LossFunctionType.DollyInMovement || loss.type === LossFunctionType.DollyOutMovement)
        && sameRig(loss.parameters, Math.max(segment.startTime, follow.sourceStartTime), segment.endTime))
        ? [segment.endTime] : [];
    });
    if (completedEnds.length > 0) {
      const referenceTime = Math.max(...completedEnds);
      for (const primitive of bandPrimitives()) {
        if (!ownsFollow(primitive) || !["relativeOffsetHold", "distanceHold"].includes(primitive.type)) continue;
        primitive.parameters.referenceTime = referenceTime;
        if (primitive.type === "distanceHold") {
          delete primitive.parameters.distance;
          delete primitive.parameters.targetDistance;
        }
      }
    }
    const matches = companions.filter((companion) => sameRig(companion.loss.parameters, band.startTime, band.endTime));
    if (matches.length === 0) continue;
    const followPrimitive = bandPrimitives().find((primitive) => ownsFollow(primitive)
      && primitive.type === "relativeOffsetHold");
    if (!followPrimitive) continue;
    const timing = subjectTimingParameters(followPrimitive.parameters);
    for (const primitive of bandPrimitives()) {
      const isCompanion = matches.some((companion) => primitive.sourceType === companion.loss.type
        && primitive.sourceActionId === companion.loss.sourceActionId);
      const isFusedOrbit = primitive.sourceType === LossFunctionType.ArcMovement
        && subjectEntityKey(input, subjectIdsFromParameters(primitive.parameters)) === followKey;
      if (!isCompanion && !isFusedOrbit) continue;
      // Keep this action's own motionStart/End and speedKeyframes for its
      // relative displacement; inherit only the subject reference clock.
      primitive.parameters = {
        ...primitive.parameters,
        ...timing,
        ...(subjectIdsFromParameters(primitive.parameters).length > 0 ? {} : { subjectIds: followIds }),
      };
    }
    const removed = removeWhere((primitive) => ownsFollow(primitive)
      && ["relativeOffsetHold", "velocityMatch", "distanceHold"].includes(primitive.type));
    const addedIds: string[] = [];
    const requestedDistance = follow.loss.parameters.distance;
    if (typeof requestedDistance === "number" && band.startTime <= follow.sourceStartTime + 1e-9
      && band.endTime >= follow.sourceStartTime - 1e-9) {
      // In a compound move a Follow distance is the initial rig distance; a
      // persistent distance hold would contradict the requested relative move.
      addedIds.push(add({
        type: "distanceHold", channel: "subjectRelative", role: "primary",
        parameters: { ...followPrimitive.parameters, distance: requestedDistance },
      }, {
        startTime: follow.sourceStartTime, endTime: follow.sourceStartTime,
        sourceType: follow.loss.type, sourceActionId: follow.loss.sourceActionId,
        sourceWeight: follow.weight,
      }).id);
    }
    if (removed.length > 0) conflicts.push({
      interval: [band.startTime, band.endTime],
      rule: matches.some((companion) => verticalTypes.has(companion.loss.type))
        ? "follow+pedestal=>vertical-follow" : "follow+dolly=>radial-follow",
      removedPrimitiveIds: removed,
      addedPrimitiveIds: addedIds,
    });
  }

  // Release passive holds when an explicit action owns the same channel.
  //
  // BUG FIX: all three rules below previously had a
  // `|| primitive.sourceType === LossFunctionType.Static` carve-out in
  // their removal predicate, which stripped Static's OWN holds
  // (positionHold/relativeOffsetHold/orientationHold/fovHold — all
  // deliberately role:"primary" in Static's own recipe, unlike every other
  // stabilizer here) whenever practically any composition loss co-occurred.
  // Since a Static hold's accompanying ShotSize/FramingPosition (there to
  // reinforce the framing it's holding) is the NORMAL way Static gets
  // authored — not an edge case — this meant Static's "don't move"
  // declaration was almost always being silently discarded, precisely when
  // it mattered most. Confirmed on eye_breath_hold (example-18):
  // orientationHold was removed there, and with nothing left to resist it,
  // pitch swung ~26 degrees during what's supposed to be a dead-stop hold.
  // Fixed by removing the Static carve-out from all three: they now only
  // ever remove role:"stabilizer" holds, which was almost certainly the
  // original intent — role:"primary" existing specifically so Static's
  // holds can't be casually overridden.
  if (highLevelTypes.some((type) => TRANSLATION_TYPES.has(type))) {
    const removed = removeWhere((primitive) =>
      primitive.type === "positionHold" && primitive.role === "stabilizer",
    );
    if (removed.length > 0) conflicts.push({
      interval: [band.startTime, band.endTime],
      rule: "translation-removes-position-hold",
      removedPrimitiveIds: removed,
      addedPrimitiveIds: [],
    });
  }
  if (highLevelTypes.some((type) => ORIENTATION_DRIVING_TYPES.has(type))) {
    const hasPan = highLevelTypes.includes(LossFunctionType.PanLeftMovement)
      || highLevelTypes.includes(LossFunctionType.PanRightMovement);
    const hasTilt = highLevelTypes.includes(LossFunctionType.TiltUpMovement)
      || highLevelTypes.includes(LossFunctionType.TiltDownMovement);
    const removed = removeWhere((primitive) =>
      (
        primitive.type === "orientationHold"
        || ((hasPan || hasTilt) && primitive.type === "forwardHold")
        || (hasPan && primitive.type === "yawHold")
        || (hasTilt && primitive.type === "pitchHold")
      )
      && primitive.role === "stabilizer",
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
      primitive.type === "fovHold" && primitive.role === "stabilizer",
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
    const removed = removeWhere((primitive) => primitive.type === "levelHorizon"
      || (primitive.type === "rollHold" && primitive.role === "stabilizer"));
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
