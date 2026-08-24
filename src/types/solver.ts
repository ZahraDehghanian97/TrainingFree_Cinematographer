import type { CameraConfig, Target } from "./camera";
import type { RelativeFPS } from "./enums";
import type { PointConstraintEasing } from "./dsl";

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
  CraneUpMovement = "craneUpMovement",
  CraneDownMovement = "craneDownMovement",

  // Framing losses
  FramingPosition = "framingPosition",
  FramingDutchAngle = "framingDutchAngle",
  ShotSize = "shotSize",
  SubjectView = "subjectView",
  CameraVerticalAngle = "cameraVerticalAngle",
  KeepInFrame = "keepInFrame",
  MaintainDistance = "maintainDistance",
  MaintainAngle = "maintainAngle",
  AvoidOcclusion = "avoidOcclusion",
  GroundLevel = "groundLevel",
  NoShake = "noShake",

  // General losses
  Collision = "collision",
  Smoothness = "smoothness",
  MinPath = "minPath",
}

export interface LossFunction {
  type: LossFunctionType;
  parameters: Record<string, unknown>;
  sourceActionId?: string;
  priority?: number;
}

// ─── Constraints (solver output) ─────────────────────────────────────────────

export interface SinglePointConstraint {
  type: "singlePoint";
  time: number;
  config: CameraConfig;
  targets?: Target[];
  weight?: number; // 0.0 – 1.0
  easing?: PointConstraintEasing;
}

export interface IntervalConstraint {
  type: "interval";
  startTime: number;
  endTime: number;
  lossFunction: LossFunction;
  weight?: number;
}

export interface LossPointConstraint {
  type: "lossPoint";
  time: number;
  lossFunctions: LossFunction[];
  weight?: number;
  easing?: PointConstraintEasing;
}

export type Constraint = SinglePointConstraint | IntervalConstraint | LossPointConstraint;

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
  weight?: number;
}

export interface PointSegment {
  kind: "point";
  time: number;
  lossFunctions: LossFunction[];
  weight?: number;
  easing?: PointConstraintEasing;
}

export type TimelineSegment = IntervalSegment | PointSegment;

export interface FlattenedTimeline {
  timeline: TimelineSegment[];
  timeWarp: TimeWarpSegment[];
  /** Playback times at which a new DSL section starts with a hard camera cut. */
  cutTimes?: number[];
}
