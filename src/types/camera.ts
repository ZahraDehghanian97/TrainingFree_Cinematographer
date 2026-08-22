import {
  CameraVerticalAngle,
  Scale,
  ShotSize,
  SubjectInFramePosition,
  SubjectView,
} from "./enums";

// ─── 3D Primitives ───────────────────────────────────────────────────────────

export interface Vector3 {
  x: number;
  y: number;
  z: number;
}

export interface Quaternion {
  x: number;
  y: number;
  z: number;
  w: number;
}

export interface EulerAngles {
  pitch: number;
  yaw: number;
  roll: number;
}

export type TransformMatrix4x4 = [
  [number, number, number, number],
  [number, number, number, number],
  [number, number, number, number],
  [number, number, number, number],
];

// ─── Camera Pose & Intrinsics ────────────────────────────────────────────────

export interface CameraPose {
  position: Vector3;
  rotation: Quaternion | EulerAngles;
}

export interface CameraExtrinsics {
  pose: CameraPose;
  transformMatrix?: TransformMatrix4x4;
}

export interface CameraIntrinsics {
  focalLength?: number;       // mm
  fov?: number;               // degrees
  aspectRatio?: number;
  sensorSize?: { width: number; height: number }; // mm
}

// ─── Targets & Framing ───────────────────────────────────────────────────────

export interface SubjectReference {
  /** CSL-local correlation key. This is never an environment/track ID. */
  ref: string;
  id?: never;
  /** Semantic subject description produced by the director-to-CSL model. */
  description: string;
  /** Defaults to exactly one. Use { min: 2, max: 2 } for "both actors". */
  cardinality?: {
    min: number;
    max?: number;
  };
}

export interface Target {
  /** Runtime subject/track ID supplied by the 4D recognition module. */
  id: string;
  ref?: never;
  description: string;
}

export type CameraTargetDescriptor = SubjectReference | Target;

export interface SubjectFraming {
  position?: SubjectInFramePosition;
  dutchAngleScale?: Scale;
}

// ─── Camera Config (discriminated union) ─────────────────────────────────────

export interface SubjectAwareCameraConfig {
  type: "subjectAware";
  cameraAngle?: CameraVerticalAngle;
  shotSize?: ShotSize;
  subjectView?: SubjectView;
  subjectFraming?: SubjectFraming;
}

export interface NonSubjectAwareCameraConfig<
  TTarget extends CameraTargetDescriptor = Target,
> {
  type: "nonSubjectAware";
  extrinsics: CameraExtrinsics;
  intrinsics?: CameraIntrinsics;
  lookAt?: Vector3 | TTarget[];
}

export type CameraConfig<TTarget extends CameraTargetDescriptor = Target> =
  | SubjectAwareCameraConfig
  | NonSubjectAwareCameraConfig<TTarget>;
