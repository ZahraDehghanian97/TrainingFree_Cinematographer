import { CoordinateSystemV1, Quat, Vec3 } from "./environment";

export interface CameraIntrinsicsV1 {
  projection: "perspective";
  fovYDegrees: number;
  near: number;
  far: number;
}

export type CameraOrientationV1 =
  | { mode: "quaternion" }
  | { mode: "perSampleLookAt"; up: Vec3 }
  | { mode: "lookAtTarget"; targetId: string; up: Vec3 }
  | { mode: "lookAtPoint"; point: Vec3; up: Vec3 }
  | { mode: "pathTangent"; up: Vec3 };

export interface CameraSampleV1 {
  /** Playback time in seconds. */
  t: number;
  position: Vec3;
  /** Required for trajectories whose orientation mode is `quaternion`. */
  rotation?: Quat;
  /** Required for trajectories whose orientation mode is `perSampleLookAt`. */
  lookAt?: Vec3;
  fovYDegrees?: number;
  /** Starts a new path segment instead of interpolating from the prior sample. */
  cutBefore?: boolean;
  actionId?: string;
}

/** Named scene-speed presets used by the camera-direction DSL. */
export type PlaybackRateLabelV1 =
  | "frozen"
  | "verySlow"
  | "slow"
  | "normal"
  | "fast"
  | "veryFast";

/**
 * Controls how quickly the environment timeline advances while camera playback
 * continues normally. A rate of 0 freezes the scene, 0.1 is 10% slow motion,
 * 1 is normal speed, and values above 1 are fast motion.
 */
export interface PlaybackRateSegmentV1 {
  startTime: number;
  endTime: number;
  rate: number;
  label?: PlaybackRateLabelV1;
}

export interface CameraPlaybackV1 {
  rateSegments: PlaybackRateSegmentV1[];
}

/** Canonical, fully normalized camera trajectory document. */
export interface CameraTrajectoryV1 {
  schemaVersion: "1.0";
  kind: "cameraTrajectory";
  environmentId: string;
  clock: {
    durationSeconds: number;
    timeUnit: "second";
  };
  coordinates: CoordinateSystemV1;
  intrinsics: CameraIntrinsicsV1;
  orientation: CameraOrientationV1;
  /** Optional scene-speed changes evaluated on the camera playback clock. */
  playback?: CameraPlaybackV1;
  samples: CameraSampleV1[];
}

/** One raw model output point in the declared x, y, z, t layout. */
export type CameraPath4dPoint = [x: number, y: number, z: number, t: number];

/**
 * Compact upload format for position-only model output. It should be normalized
 * into CameraTrajectoryV1 before rendering or evaluating the path.
 */
export interface CameraPath4dV1 {
  schemaVersion: "1.0";
  kind: "cameraPath4d";
  environmentId: string;
  layout: ["x", "y", "z", "t"];
  orientation: CameraOrientationV1;
  playback?: CameraPlaybackV1;
  points: CameraPath4dPoint[];
}

export type CameraTrajectoryDocumentV1 = CameraTrajectoryV1 | CameraPath4dV1;
