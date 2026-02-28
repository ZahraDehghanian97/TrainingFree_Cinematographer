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

export interface Target {
  id: string;
  description: string;
}

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

export interface NonSubjectAwareCameraConfig {
  type: "nonSubjectAware";
  extrinsics: CameraExtrinsics;
  intrinsics?: CameraIntrinsics;
  lookAt?: Vector3 | Target[];
}

export type CameraConfig = SubjectAwareCameraConfig | NonSubjectAwareCameraConfig;
