import { LossFunctionType } from "../../types/solver";
import {
  DEFAULT_OPTIMIZER_WEIGHTS,
  DEFAULT_OPTIONS,
} from "../config/defaults";
import { finiteNumber } from "../shared/parameter-values";
import type {
  CameraOptimizerInput,
  CompiledLossPlan,
  ConflictResolution,
  OptimizerWeights,
} from "../types";
import { resolveBandConflicts } from "./conflict-resolution";
import { resolveFixedFovTargets } from "./fov-targets";
import { buildGlobalLossDescriptors } from "./global-losses";
import { descriptorsForUserKeyframe } from "./keyframe-recipes";
import { descriptorsForLoss } from "./loss-recipes";
import { createPrimitiveStore } from "./primitive-store";
import { buildActiveLossBands } from "./timeline-bands";
import type {
  CompileBandContext,
  PrimitiveDescriptor,
} from "./types";

export function compileLossPlan(input: CameraOptimizerInput): CompiledLossPlan {
  const durationSeconds = input.environment.clock.durationSeconds;
  const weights: OptimizerWeights = { ...DEFAULT_OPTIMIZER_WEIGHTS, ...input.options?.weights };
  const { primitives, add } = createPrimitiveStore(weights);
  const conflicts: ConflictResolution[] = [];
  const warnings: string[] = [];

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
      };

      for (const descriptor of descriptorsForLoss(context)) {
        const bandDescriptor: PrimitiveDescriptor = span.pointTime === undefined
          ? descriptor
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

  // 3. Compile point constraints with no easing window.
  for (const segment of input.timeline.timeline) {
    if (segment.kind !== "point") continue;

    const inDuration = finiteNumber(segment.easing?.inDuration, 0);
    const outDuration = finiteNumber(segment.easing?.outDuration, 0);
    const startTime = Math.max(0, segment.time - inDuration);
    const endTime = Math.min(durationSeconds, segment.time + outDuration);
    if (endTime - startTime > 1e-9) continue;

    for (const loss of segment.lossFunctions) {
      const priorityScale = 1 + Math.max(0, finiteNumber(loss.priority, 0)) * 0.1;
      const sourceWeight = finiteNumber(segment.weight, 1) * priorityScale;
      const context: CompileBandContext = {
        startTime,
        endTime,
        sourceStartTime: segment.time,
        sourceEndTime: segment.time,
        loss,
      };

      for (const descriptor of descriptorsForLoss(context)) {
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
            startTime,
            endTime,
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

  // 5. Add enabled whole-trajectory regularizers.
  for (const { descriptor, weight } of buildGlobalLossDescriptors(input, weights, primitives)) {
    add(descriptor, {
      startTime: 0,
      endTime: durationSeconds,
      sourceType: "global",
      explicitWeight: weight,
    });
  }

  // 6. Freeze lens targets, then put the public plan in stable order.
  resolveFixedFovTargets(
    primitives,
    input.options?.initialFovYDegrees ?? DEFAULT_OPTIONS.initialFovYDegrees,
  );
  primitives.sort(
    (a, b) => a.startTime - b.startTime || a.endTime - b.endTime || a.id.localeCompare(b.id),
  );

  return {
    durationSeconds,
    primitives,
    conflicts,
    warnings: [...new Set(warnings)],
  };
}
