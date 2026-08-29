import type { EnvironmentV1, Quat, Vec3 } from "../types/environment";
import type { CameraTrajectoryV1 } from "../types/trajectory";
import type {
  FlattenedTimeline,
  LossFunctionType,
  TimelineSolverOutput,
} from "../types/solver";

export type KeyframeMode = "hard" | "soft";

/** A user-authored camera state. Omitted channels remain unconstrained. */
export interface UserCameraKeyframe {
  id?: string;
  time: number;
  /** Hard keyframes lock supplied channels exactly. Defaults to hard. */
  mode?: KeyframeMode;
  /** Multiplier for soft keyframes. Ignored for hard channels. */
  weight?: number;
  position?: Vec3;
  rotation?: Quat;
  /** Convenience alternative to rotation. Invalid when rotation is also set. */
  lookAt?: Vec3;
  /** World-up by default when lookAt is used. */
  up?: Vec3;
  fovYDegrees?: number;
  cutBefore?: boolean;
}

export type PrimitiveLossType =
  | "positionAnchor"
  | "rotationAnchor"
  | "fovAnchor"
  | "positionHold"
  | "orientationHold"
  | "forwardHold"
  | "yawHold"
  | "pitchHold"
  | "rollHold"
  | "fovHold"
  | "axisProgress"
  | "totalProgressTarget"
  | "orthogonalDrift"
  | "pathProfile"
  | "stepPacing"
  | "stepSmoothness"
  | "angularProgress"
  | "angularDirection"
  | "angularPacing"
  | "planeHold"
  | "radiusHold"
  | "radiusSchedule"
  | "lookAt"
  | "screenPosition"
  | "bboxInFrame"
  | "screenScale"
  | "distanceHold"
  | "relativeOffsetHold"
  | "bearingHold"
  | "elevationHold"
  | "velocityMatch"
  | "subjectView"
  | "subjectElevation"
  | "rollProgress"
  | "rollTarget"
  | "levelHorizon"
  | "intrinsicsProgress"
  | "intrinsicsPacing"
  | "collisionClearance"
  | "nearPlaneClearance"
  | "occlusion"
  | "heightAboveGround"
  | "groundClearance"
  | "accelerationSmoothness"
  | "angularAccelerationSmoothness"
  | "jerkSmoothness"
  | "pathLength";

export type LossChannel =
  | "position"
  | "rotation"
  | "intrinsics"
  | "composition"
  | "subjectRelative"
  | "safety"
  | "regularity";

export type PrimitiveRole = "primary" | "stabilizer" | "regularizer";

export interface PrimitiveLoss {
  id: string;
  type: PrimitiveLossType;
  startTime: number;
  endTime: number;
  weight: number;
  /** Domain-specific acceptable error used to make the residual dimensionless. */
  tolerance: number;
  channel: LossChannel;
  role: PrimitiveRole;
  sourceType: LossFunctionType | "userKeyframe" | "global";
  sourceActionId?: string;
  parameters: Record<string, unknown>;
}

export interface ConflictResolution {
  interval: [number, number];
  rule:
    | "arc+dolly=>spiral"
    | "arc+pedestal=>helical-crane"
    | "follow+dolly=>radial-follow"
    | "translation-removes-position-hold"
    | "rotation-removes-orientation-hold"
    | "zoom-removes-fov-hold"
    | "framing-removes-fov-hold"
    | "dutch-removes-level-horizon"
    | "screen-position-dominates-look-at"
    | "under-constrained-hold-strengthened"
    | "level-horizon-removes-roll-hold";
  removedPrimitiveIds: string[];
  addedPrimitiveIds: string[];
}

export interface CompiledLossPlan {
  durationSeconds: number;
  primitives: PrimitiveLoss[];
  conflicts: ConflictResolution[];
  warnings: string[];
}

export interface OptimizerWeights {
  userSoftKeyframe: number;
  semanticPrimary: number;
  semanticStabilizer: number;
  globalSmoothness: number;
  globalAngularSmoothness: number;
  globalJerk: number;
  globalCollision: number;
  globalOcclusion: number;
  globalGround: number;
  globalMinPath: number;
}

export interface OptimizerOptions {
  /** Internal samples per second. Timeline boundaries/keyframes are always added. */
  optimizationFps?: number;
  /** Output samples per second. Defaults to the environment fpsHint. */
  outputFps?: number;
  iterations?: number;
  randomSeed?: number;
  initialFovYDegrees?: number;
  aspectRatio?: number;
  cameraRadius?: number;
  collisionMargin?: number;
  nearPlane?: number;
  farPlane?: number;
  weights?: Partial<OptimizerWeights>;
  /** Disable only for focused tests or ablations. */
  globalLosses?: Partial<{
    smoothness: boolean;
    angularSmoothness: boolean;
    jerk: boolean;
    collision: boolean;
    occlusion: boolean;
    ground: boolean;
    minPath: boolean;
  }>;
}

export interface CameraOptimizerInput {
  environment: EnvironmentV1;
  timeline: FlattenedTimeline;
  userKeyframes?: UserCameraKeyframe[];
  options?: OptimizerOptions;
}

/** Convenience input when the timeline has not yet been flattened. */
export type TimelineSolverCameraOptimizerInput = Omit<CameraOptimizerInput, "timeline"> & {
  timeline: TimelineSolverOutput;
};

export interface CameraStateSample {
  time: number;
  position: Vec3;
  rotation: Quat;
  fovYDegrees: number;
}

export interface LossBreakdownEntry {
  id: string;
  type: PrimitiveLossType;
  weightedLoss: number;
}

export interface OptimizerDiagnostics {
  initialLoss: number;
  finalLoss: number;
  iterations: number;
  converged: boolean;
  terminationReason: "converged" | "stalled" | "maxIterations" | "initialState";
  optimizationSampleCount: number;
  outputSampleCount: number;
  primitiveCount: number;
  conflicts: ConflictResolution[];
  lossBreakdown: LossBreakdownEntry[];
  elapsedMilliseconds: number;
  warnings: string[];
}

export interface CameraOptimizerResult {
  trajectory: CameraTrajectoryV1;
  diagnostics: OptimizerDiagnostics;
  compiledPlan: CompiledLossPlan;
}

/** Self-contained persisted optimizer output that can also be opened by Camera Lab. */
export interface CameraOptimizerDiagnosticsDocumentV1 {
  schemaVersion: "1.0";
  kind: "cameraOptimizerDiagnostics";
  exampleId?: string;
  environmentId: string;
  trajectory: CameraTrajectoryV1;
  diagnostics: OptimizerDiagnostics;
  compiledPlan: CompiledLossPlan;
}