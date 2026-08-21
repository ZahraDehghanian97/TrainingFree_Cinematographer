import {
  CameraMovementType,
  ComparisonOperator,
  RelativeTimeReference,
  Scale,
  SpeedFunction,
  RelativeFPS,
} from "./enums";
import { CameraConfig, Target, Vector3 } from "./camera";

// ─── Triggers ────────────────────────────────────────────────────────────────

export interface AbsoluteTimeTrigger {
  type: "absoluteTime";
  time: number;
}

export interface RelativeTimeTrigger {
  type: "relativeTime";
  actionId: string;
  reference: RelativeTimeReference;
  offset: number; // seconds (can be negative)
}

export interface DistanceEventTrigger {
  type: "distance";
  object1: Target;
  object2: Target;
  operator: ComparisonOperator;
  distance: number;
}

export interface VelocityEventTrigger {
  type: "velocity";
  subject: Target;
  operator: ComparisonOperator;
  speed: number;       // m/s
  direction?: Vector3;
}

export type EventTrigger = DistanceEventTrigger | VelocityEventTrigger;
export type Trigger = EventTrigger | AbsoluteTimeTrigger | RelativeTimeTrigger;

export interface CompoundTrigger {
  operator: "and" | "or";
  triggers: (Trigger | CompoundTrigger)[];
}

export type TriggerSpec = Trigger | CompoundTrigger;

// ─── Movement ────────────────────────────────────────────────────────────────

export interface SpeedKeyframe {
  normalizedTime: number;   // 0..1
  speedMultiplier: number;
  easing?: SpeedFunction;
}

export interface MovementParameters {
  // Arc / Orbit
  arcAngle?: number;
  arcRadius?: number;

  // Pan / Tilt
  rotationAngle?: number;

  // Dolly / Truck / Pedestal
  distance?: number;

  // Crane
  heightChange?: number;
  horizontalDistance?: number;

  // Zoom
  zoomFactor?: number;

  // Follow / Track
  followDelay?: number;
  leadAmount?: number;

  // General
  path?: "linear" | "curved" | "spline";
  curveIntensity?: Scale;
}

export interface Movement {
  act: CameraMovementType;
  duration?: number;
  speedKeyframes?: SpeedKeyframe[];
  relativeFPS?: RelativeFPS;
  parameters?: MovementParameters;
}

// ─── Constraints & Actions ───────────────────────────────────────────────────

export type PointConstraintEasingCurve = "linear" | "easeIn" | "easeOut" | "easeInOut";

/**
 * Optional temporal falloff for a point-only constraint (`allFrames: false`).
 * Durations are measured in seconds around the action end-time point.
 */
export interface PointConstraintEasing {
  /** Fade the point constraint in during this many seconds before the point. */
  inDuration?: number;
  /** Fade the point constraint out during this many seconds after the point. */
  outDuration?: number;
  /** Defaults to `easeInOut`. */
  curve?: PointConstraintEasingCurve;
}

export interface ConstraintConfig {
  targets?: Target[];
  config: CameraConfig;
  /** true → enforce on every frame; false → enforce at the action end point. */
  allFrames: boolean;
  /** Optional soft temporal window for point-only constraints. Invalid when allFrames=true. */
  easing?: PointConstraintEasing;
}

export interface Action {
  id: string;
  name?: string;
  trigger: TriggerSpec;
  movement: Movement;
  priority?: number;
  constraints?: ConstraintConfig[];
}

// ─── Section & Top-level DSL ─────────────────────────────────────────────────

export interface InitCamera {
  targets: Target[];
  config: CameraConfig;
}

export interface Section {
  initCamera: InitCamera;
  actions: Action[];
}

export interface CameraDirectionDSL {
  sections: Section[];
  totalDuration: number;
}
