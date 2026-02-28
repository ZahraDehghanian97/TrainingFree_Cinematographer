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

export interface ConstraintConfig {
  targets?: Target[];
  config: CameraConfig;
  /** true → enforce on every frame; false → enforce only at the action's end */
  allFrames: boolean;
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
