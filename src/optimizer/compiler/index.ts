import { LossFunctionType } from "../../types/solver";
import {
  DEFAULT_OPTIMIZER_WEIGHTS,
} from "../config/defaults";
import { finiteNumber } from "../shared/parameter-values";
import type {
  CameraOptimizerInput,
  CompiledLossPlan,
  ConflictResolution,
  OptimizerWeights,
} from "../types";
import { resolveBandConflicts } from "./conflict-resolution";
import { buildGlobalLossDescriptors } from "./global-losses";
import { descriptorsForUserKeyframe } from "./keyframe-recipes";
import { descriptorsForLoss } from "./loss-recipes";
import { createPrimitiveStore } from "./primitive-store";
import { buildActiveLossBands } from "./timeline-bands";
import { buildMotionTransitions } from "./motion-transitions";
import { addSubjectQualityLosses } from "./subject-quality";
import type {
  CompileBandContext,
  PrimitiveDescriptor,
} from "./types";
import { validateSemanticTargets } from "../config/semantic-targets";

const EASED_POINT_ENDPOINT_TYPES = new Set([
  LossFunctionType.ShotSize, LossFunctionType.FramingPosition,
  LossFunctionType.SubjectView, LossFunctionType.CameraVerticalAngle,
  LossFunctionType.FramingDutchAngle, LossFunctionType.KeepInFrame,
  LossFunctionType.MinPath,
]);

export function compileLossPlan(input: CameraOptimizerInput): CompiledLossPlan {
  validateSemanticTargets(input.options?.semanticTargets);
  const durationSeconds = input.environment.clock.durationSeconds;
  const weights: OptimizerWeights = { ...DEFAULT_OPTIMIZER_WEIGHTS, ...input.options?.weights };
  const { primitives, add } = createPrimitiveStore(weights);
  const conflicts: ConflictResolution[] = [];
  const warnings: string[] = [];
  const motionTransitions = buildMotionTransitions(input);

  // 1. Compile every active semantic band into primitive losses.
  for (const band of buildActiveLossBands(input.timeline.timeline, durationSeconds)) {
    const bandStartIndex = primitives.length;
    const highLevelTypes: LossFunctionType[] = [];

    for (const span of band.active) {
      const { loss } = span;
      highLevelTypes.push(loss.type);
      const priorityScale = 1 + Math.max(0, finiteNumber(loss.priority, 0)) * 0.1;
      const sourceWeight = span.weight * priorityScale;
      const context: CompileBandContext = {
        startTime: band.startTime,
        endTime: band.endTime,
        sourceStartTime: span.sourceStartTime,
        sourceEndTime: span.sourceEndTime,
        loss,
        semanticTargets: input.options?.semanticTargets,
      };

      for (const descriptor of descriptorsForLoss(context)) {
        const windows = span.pointTime === undefined ? motionTransitions.filter((window) =>
          Math.abs(window.boundaryTime - span.sourceStartTime) <= 1e-8
          || Math.abs(window.boundaryTime - span.sourceEndTime) <= 1e-8,
        ) : [];
        const bandDescriptor: PrimitiveDescriptor = span.pointTime === undefined
          ? {
              ...descriptor,
              parameters: {
                referenceTime: span.sourceStartTime,
                ...(descriptor.parameters ?? {}),
                ...(windows.length > 0 ? { motionTransitions: windows } : {}),
              },
            }
          : {
              ...descriptor,
              parameters: {
                ...(descriptor.parameters ?? {}),
                pointTime: span.pointTime,
                ...(span.easing ? { easing: span.easing } : {}),
              },
            };
        add(bandDescriptor, {
          startTime: band.startTime,
          endTime: band.endTime,
          sourceType: loss.type,
          sourceWeight,
          sourceActionId: loss.sourceActionId,
          normalizationDuration: span.endTime - span.startTime,
        });
      }
    }

    // 2. Reconcile compound actions and competing channel owners in this band.
    const resolution = resolveBandConflicts({
      input,
      band,
      highLevelTypes,
      weights,
      primitives,
      bandStartIndex,
      add,
    });
    conflicts.push(...resolution.conflicts);
    warnings.push(...resolution.warnings);
  }

  // 3. Preserve composition at the actual authored point as well as its eased
  // support. Otherwise a tiny final quadrature interval can make the requested
  // endpoint negligible compared with the earlier, partially weighted window.
  for (const segment of input.timeline.timeline) {
    if (segment.kind !== "point") continue;

    const inDuration = finiteNumber(segment.easing?.inDuration, 0);
    const outDuration = finiteNumber(segment.easing?.outDuration, 0);
    const startTime = Math.max(0, segment.time - inDuration);
    const endTime = Math.min(durationSeconds, segment.time + outDuration);
    const hasEasingWindow = endTime - startTime > 1e-9;

    for (const loss of segment.lossFunctions) {
      if (hasEasingWindow && !EASED_POINT_ENDPOINT_TYPES.has(loss.type)) continue;
      const priorityScale = 1 + Math.max(0, finiteNumber(loss.priority, 0)) * 0.1;
      const sourceWeight = finiteNumber(segment.weight, 1) * priorityScale;
      const context: CompileBandContext = {
        startTime: segment.time,
        endTime: segment.time,
        sourceStartTime: segment.time,
        sourceEndTime: segment.time,
        loss,
        semanticTargets: input.options?.semanticTargets,
      };

      for (const descriptor of descriptorsForLoss(context)) {
        if (hasEasingWindow && descriptor.role !== "primary") continue;
        add(
          {
            ...descriptor,
            parameters: {
              ...(descriptor.parameters ?? {}),
              pointTime: segment.time,
              ...(segment.easing ? { easing: segment.easing } : {}),
            },
          },
          {
            startTime: segment.time,
            endTime: segment.time,
            sourceType: loss.type,
            sourceWeight,
            sourceActionId: loss.sourceActionId,
          },
        );
      }
    }
  }

  // 4. Add explicit user keyframes.
  for (const keyframe of input.userKeyframes ?? []) {
    const mode = keyframe.mode ?? "hard";
    const explicitWeight = mode === "hard"
      ? weights.userSoftKeyframe * 4
      : weights.userSoftKeyframe * finiteNumber(keyframe.weight, 1);

    for (const descriptor of descriptorsForUserKeyframe(keyframe)) {
      add(descriptor, {
        startTime: keyframe.time,
        endTime: keyframe.time,
        sourceType: "userKeyframe",
        explicitWeight,
      });
    }
  }

  // Unspecified composition stays free inside a useful visibility/scale region.
  addSubjectQualityLosses(input, primitives, weights, add);

  // 5. Add enabled whole-trajectory regularizers.
  for (const { descriptor, weight, startTime, endTime, normalizationDuration } of buildGlobalLossDescriptors(input, weights, primitives)) {
    add(descriptor, {
      startTime: startTime ?? 0,
      endTime: endTime ?? durationSeconds,
      sourceType: "global",
      explicitWeight: weight,
      normalizationDuration,
    });
  }

  // 6. Put the public plan in stable order; no seed value becomes a target.
  primitives.sort(
    (a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id),
  );

  return {
    durationSeconds,
    motionTransitions,
    primitives,
    conflicts,
    warnings: [...new Set(warnings)],
  };
}
