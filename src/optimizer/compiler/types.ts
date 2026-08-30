import type { LossFunction, TimelineSegment } from "../../types/solver";
import type {
  LossChannel,
  PrimitiveLoss,
  PrimitiveLossType,
  PrimitiveRole,
} from "../types";

export interface CompileBandContext {
  startTime: number;
  endTime: number;
  sourceStartTime: number;
  sourceEndTime: number;
  loss: LossFunction;
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
  tolerance?: number;
}

export interface PrimitiveSource {
  startTime: number;
  endTime: number;
  sourceType: PrimitiveLoss["sourceType"];
  sourceWeight?: number;
  sourceActionId?: string;
  explicitWeight?: number;
}

export type AddPrimitive = (
  descriptor: PrimitiveDescriptor,
  source: PrimitiveSource,
) => PrimitiveLoss;
