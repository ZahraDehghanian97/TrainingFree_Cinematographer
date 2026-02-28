import { CameraConfig } from "./camera";

// ─── Loss Functions ──────────────────────────────────────────────────────────

export enum LossFunctionType {
  // Movement losses
  PedestalMovement = "pedestalMovement",
  DollyMovement = "dollyMovement",
  TruckMovement = "truckMovement",
  PanMovement = "panMovement",
  TiltMovement = "tiltMovement",
  ArcMovement = "arcMovement",
  Static = "Static",
  FollowMovement = "followMovement",

  // Framing losses
  FramingPosition = "framingPosition",
  ShotSize = "shotSize",
  SubjectView = "subjectView",

  // General losses
  Collision = "collision",
  Smoothness = "smoothness",
  MinPath = "minPath",
}

export interface LossFunction {
  type: LossFunctionType;
  parameters: Record<string, unknown>;
}

// ─── Constraints (solver output) ─────────────────────────────────────────────

export interface SinglePointConstraint {
  type: "singlePoint";
  time: number;
  config: CameraConfig;
  weight?: number; // 0.0 – 1.0
}

export interface IntervalConstraint {
  type: "interval";
  startTime: number;
  endTime: number;
  lossFunction: LossFunction;
  weight?: number;
}

export type Constraint = SinglePointConstraint | IntervalConstraint;

// ─── Solver Output ───────────────────────────────────────────────────────────

export interface SectionSolverOutput {
  initKeyframes: SinglePointConstraint[];
  constraints: Constraint[];
}

export interface TimelineSolverOutput {
  sections: SectionSolverOutput[];
}

// ─── Normalized Timeline (final output) ──────────────────────────────────────

export interface IntervalSegment {
  kind: "interval";
  startTime: number;
  endTime: number;
  lossFunctions: LossFunction[];
}

export interface PointSegment {
  kind: "point";
  time: number;
  lossFunctions: LossFunction[];
}

export type TimelineSegment = IntervalSegment | PointSegment;
export type FlattenedTimeline = TimelineSegment[];
