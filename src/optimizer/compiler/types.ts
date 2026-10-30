import type { LossFunction, TimelineSegment } from "../../types/solver";
import type {
  LossChannel,
  PrimitiveLoss,
  PrimitiveLossType,
  PrimitiveRole,
  SemanticTargetOptions,
} from "../types";

export interface CompileBandContext {
  startTime: number;
  endTime: number;
  sourceStartTime: number;
  sourceEndTime: number;
  loss: LossFunction;
  semanticTargets?: SemanticTargetOptions;
}

export interface ActiveLossSpan {
  startTime: number;
  endTime: number;
  sourceStartTime: number;
  sourceEndTime: number;
  weight: number;
  loss: LossFunction;
  pointTime?: number;
  easing?: Extract<TimelineSegment, { kind: "point" }>["easing"];
}

export interface ActiveLossBand {
  startTime: number;
  endTime: number;
  active: ActiveLossSpan[];
}

export interface PrimitiveDescriptor {
  type: PrimitiveLossType;
  channel: LossChannel;
  role: PrimitiveRole;
  parameters?: Record<string, unknown>;
  weightScale?: number;
  /** Residual normalization scale, expressed in the residual's physical units. */
  tolerance?: number;
}

export interface PrimitiveSource {
  startTime: number;
  endTime: number;
  sourceType: PrimitiveLoss["sourceType"];
  sourceWeight?: number;
  sourceActionId?: string;
  normalizationDuration?: number;
  explicitWeight?: number;
}

export type AddPrimitive = (
  descriptor: PrimitiveDescriptor,
  source: PrimitiveSource,
) => PrimitiveLoss;
