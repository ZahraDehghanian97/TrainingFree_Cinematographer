import { CameraMovementType, RelativeFPS } from "../types/enums";
import { LossFunctionType } from "../types/solver";

export const BASE_SPEED: Record<CameraMovementType, number> = {
  [CameraMovementType.Static]: Infinity,
  [CameraMovementType.Follow]: 1.0,
  [CameraMovementType.Track]: 1.0,
  [CameraMovementType.DollyIn]: 1.0,
  [CameraMovementType.DollyOut]: 1.0,
  [CameraMovementType.PanLeft]: 0.6,
  [CameraMovementType.PanRight]: 0.6,
  [CameraMovementType.TiltUp]: 0.5,
  [CameraMovementType.TiltDown]: 0.5,
  [CameraMovementType.TruckLeft]: 0.9,
  [CameraMovementType.TruckRight]: 0.9,
  [CameraMovementType.PedestalUp]: 0.7,
  [CameraMovementType.PedestalDown]: 0.7,
  [CameraMovementType.ArcLeft]: 0.4,
  [CameraMovementType.ArcRight]: 0.4,
  [CameraMovementType.Orbit]: 0.3,
  [CameraMovementType.CraneUp]: 0.6,
  [CameraMovementType.CraneDown]: 0.6,
  [CameraMovementType.DutchLeft]: 0.4,
  [CameraMovementType.DutchRight]: 0.4,
  [CameraMovementType.ZoomIn]: 0.8,
  [CameraMovementType.ZoomOut]: 0.8,
};

export const MOVEMENT_TO_LOSS: Partial<Record<CameraMovementType, LossFunctionType>> = {
  [CameraMovementType.DollyIn]: LossFunctionType.DollyMovement,
  [CameraMovementType.DollyOut]: LossFunctionType.DollyMovement,
  [CameraMovementType.ZoomIn]: LossFunctionType.ZoomIn,   //  dedicated ZoomMovement
  [CameraMovementType.ZoomOut]: LossFunctionType.ZoomOut,   // dedicated ZoomMovement
  [CameraMovementType.Follow]: LossFunctionType.FollowMovement,
  [CameraMovementType.Track]: LossFunctionType.DollyMovement,     // TODO: dedicated TrackMovement?
  [CameraMovementType.Static]: LossFunctionType.Static,

  [CameraMovementType.PanLeft]: LossFunctionType.PanMovement,
  [CameraMovementType.PanRight]: LossFunctionType.PanMovement,
  [CameraMovementType.TiltUp]: LossFunctionType.TiltMovement,
  [CameraMovementType.TiltDown]: LossFunctionType.TiltMovement,
  [CameraMovementType.DutchRight]: LossFunctionType.DutchMovement,
  [CameraMovementType.DutchLeft]: LossFunctionType.DutchMovement,
  

  [CameraMovementType.TruckLeft]: LossFunctionType.TruckMovement,
  [CameraMovementType.TruckRight]: LossFunctionType.TruckMovement,

  [CameraMovementType.PedestalUp]: LossFunctionType.PedestalMovement,
  [CameraMovementType.PedestalDown]: LossFunctionType.PedestalMovement,

  [CameraMovementType.ArcLeft]: LossFunctionType.ArcMovement,
  [CameraMovementType.ArcRight]: LossFunctionType.ArcMovement,
  [CameraMovementType.Orbit]: LossFunctionType.ArcMovement,       // TODO: dedicated OrbitMovement?
};

export const FPS_DURATION_WEIGHT: Record<RelativeFPS, number> = {
  [RelativeFPS.Frozen]: 5.0, // TODO: Must change to explicit duration
  [RelativeFPS.VerySlow]: 3.0,
  [RelativeFPS.Slow]: 2.0,
  [RelativeFPS.Normal]: 1.0,
  [RelativeFPS.Fast]: 0.5,
  [RelativeFPS.VeryFast]: 0.2,
};

// ─── Solver Defaults ────────────────────────────────

/** Estimated time offset (seconds) when a distance trigger fires */
export const DEFAULT_DISTANCE_TRIGGER_OFFSET = 5;

/** Estimated time offset (seconds) when a velocity trigger fires */
export const DEFAULT_VELOCITY_TRIGGER_OFFSET = 3;

/** Default dolly/follow distance when not specified in movement parameters */
export const DEFAULT_DOLLY_DISTANCE = 2;

/** Default pan/tilt rotation angle (degrees) when not specified */
export const DEFAULT_ROTATION_ANGLE = 30;

/** Default arc sweep angle (degrees) when not specified */
export const DEFAULT_ARC_ANGLE = 45;

/** Default arc radius (meters) when not specified */
export const DEFAULT_ARC_RADIUS = 2;
