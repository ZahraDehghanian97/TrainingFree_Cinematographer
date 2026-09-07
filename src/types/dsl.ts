import type {
  CameraMovementType,
  ComparisonOperator,
  RelativeTimeReference,
  Scale,
  SpeedFunction,
  RelativeFPS,
  ConstraintType,
} from "./enums";
import {
  type CameraConfig,
  type CameraTargetDescriptor,
  type SubjectReference,
  type Target,
  type Vector3,
} from "./camera";

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

export interface DistanceEventTrigger<
  TTarget extends CameraTargetDescriptor = Target,
> {
  type: "distance";
  object1: TTarget;
  object2: TTarget;
  operator: ComparisonOperator;
  distance: number;
}

export interface VelocityEventTrigger<
  TTarget extends CameraTargetDescriptor = Target,
> {
  type: "velocity";
  subject: TTarget;
  operator: ComparisonOperator;
  speed: number;       // m/s
  direction?: Vector3;
}

export type EventTrigger<TTarget extends CameraTargetDescriptor = Target> =
  | DistanceEventTrigger<TTarget>
  | VelocityEventTrigger<TTarget>;
export type Trigger<TTarget extends CameraTargetDescriptor = Target> =
  | EventTrigger<TTarget>
  | AbsoluteTimeTrigger
  | RelativeTimeTrigger;

export interface CompoundTrigger<
  TTarget extends CameraTargetDescriptor = Target,
> {
  operator: "and" | "or";
  triggers: (Trigger<TTarget> | CompoundTrigger<TTarget>)[];
}

export type TriggerSpec<TTarget extends CameraTargetDescriptor = Target> =
  | Trigger<TTarget>
  | CompoundTrigger<TTarget>;

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

  // Permit an explicitly targeted camera move through its subject geometry.
  allowSubjectIntersection?: boolean;

  // General
  path?: "linear" | "curved" | "spline";
  curveIntensity?: Scale;
}

export interface Movement<TTarget extends CameraTargetDescriptor = Target> {
  act: CameraMovementType;
  targets?: TTarget[];
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

export interface ConstraintConfig<
  TTarget extends CameraTargetDescriptor = Target,
> {
  /** Discriminates this camera-config constraint from `kind: "general"`. */
  kind?: never;
  targets?: TTarget[];
  config: CameraConfig<TTarget>;
  /** true → enforce on every frame; false → enforce at the action end point. */
  allFrames: boolean;
  /** Optional soft temporal window for point-only constraints. Invalid when allFrames=true. */
  easing?: PointConstraintEasing;
}

/** Environment/safety/regularity constraint compiled directly to a loss. */
export interface GeneralConstraintConfig<
  TTarget extends CameraTargetDescriptor = Target,
> {
  kind: "general";
  constraint: ConstraintType;
  targets?: TTarget[];
  parameters?: Record<string, unknown>;
  allFrames: boolean;
  weight?: number;
  easing?: PointConstraintEasing;
}

export type ActionConstraintConfig<
  TTarget extends CameraTargetDescriptor = Target,
> = ConstraintConfig<TTarget> | GeneralConstraintConfig<TTarget>;

export interface Action<TTarget extends CameraTargetDescriptor = Target> {
  id: string;
  name?: string;
  trigger: TriggerSpec<TTarget>;
  movement: Movement<TTarget>;
  priority?: number;
  constraints?: ActionConstraintConfig<TTarget>[];
}

// ─── Section & Top-level DSL ─────────────────────────────────────────────────

export interface InitCamera<TTarget extends CameraTargetDescriptor = Target> {
  targets: TTarget[];
  config: CameraConfig<TTarget>;
}

export interface Section<TTarget extends CameraTargetDescriptor = Target> {
  initCamera: InitCamera<TTarget>;
  actions: Action<TTarget>[];
}

export interface CameraDirectionDSL<
  TTarget extends CameraTargetDescriptor = Target,
> {
  sections: Section<TTarget>[];
  totalDuration: number;
}

/** Semantic CSL emitted before the 4D recognition module binds runtime IDs. */
export type CameraDirectionDraft = CameraDirectionDSL<SubjectReference>;

/** Executable CSL whose subject references have runtime 4D IDs. */
export type ResolvedCameraDirectionDSL = CameraDirectionDSL<Target>;
