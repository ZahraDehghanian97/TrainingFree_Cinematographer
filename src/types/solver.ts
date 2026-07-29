import { CameraConfig } from "./camera";
import type { RelativeFPS } from "./enums";

// ─── Loss Functions ──────────────────────────────────────────────────────────

export enum LossFunctionType {
  // Movement losses
  PedestalUpMovement = "pedestalUpMovement",
  PedestalDownMovement = "pedestalDownMovement",
  DollyInMovement = "dollyInMovement",
  DollyOutMovement = "dollyOutMovement",
  ZoomIn = "zoomInMovement",
  ZoomOut = "zoomOutMovement",
  TruckLeftMovement = "truckLeftMovement",
  TruckRightMovement = "truckRightMovement",
  PanLeftMovement = "panLeftMovement",
  PanRightMovement = "panRightMovement",
  TiltUpMovement = "tiltUpMovement",
  TiltDownMovement = "tiltDownMovement",
  DutchLeftMovement = "dutchLeftMovement",
  DutchRightMovement = "dutchRightMovement",
  ArcMovement = "arcMovement",
  Static = "Static",
  FollowMovement = "followMovement",
  TrackMovement = "trackMovement",

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

export interface TimeWarpSegment {
  startTimePlayback: number;
  endTimePlayback: number;
  rate: number;
  label: RelativeFPS;
}

export interface TimelineSolverOutput {
  sections: SectionSolverOutput[];
  timeWarp: TimeWarpSegment[];
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

export interface FlattenedTimeline {
  timeline: TimelineSegment[];
  timeWarp: TimeWarpSegment[];
}
