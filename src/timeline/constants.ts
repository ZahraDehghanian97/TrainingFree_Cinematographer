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
  [CameraMovementType.DollyIn]: LossFunctionType.DollyInMovement,
  [CameraMovementType.DollyOut]: LossFunctionType.DollyOutMovement,
  [CameraMovementType.ZoomIn]: LossFunctionType.ZoomIn,   
  [CameraMovementType.ZoomOut]: LossFunctionType.ZoomOut,  
  [CameraMovementType.Follow]: LossFunctionType.FollowMovement,
  [CameraMovementType.Track]: LossFunctionType.TrackMovement,     
  [CameraMovementType.Static]: LossFunctionType.Static,

  [CameraMovementType.PanLeft]: LossFunctionType.PanLeftMovement,
  [CameraMovementType.PanRight]: LossFunctionType.PanRightMovement,
  [CameraMovementType.TiltUp]: LossFunctionType.TiltUpMovement,
  [CameraMovementType.TiltDown]: LossFunctionType.TiltDownMovement,
  [CameraMovementType.DutchRight]: LossFunctionType.DutchRightMovement,
  [CameraMovementType.DutchLeft]: LossFunctionType.DutchLeftMovement,
  

  [CameraMovementType.TruckLeft]: LossFunctionType.TruckLeftMovement,
  [CameraMovementType.TruckRight]: LossFunctionType.TruckRightMovement,

  [CameraMovementType.PedestalUp]: LossFunctionType.PedestalUpMovement,
  [CameraMovementType.PedestalDown]: LossFunctionType.PedestalDownMovement,

  [CameraMovementType.ArcLeft]: LossFunctionType.ArcMovement,
  [CameraMovementType.ArcRight]: LossFunctionType.ArcMovement,
  [CameraMovementType.Orbit]: LossFunctionType.ArcMovement,       
};

/**
 * Scene-time rate used by Camera Lab while camera playback keeps advancing.
 * These are rates, not duration multipliers: 0 freezes the scene, values below
 * 1 slow it down, and values above 1 speed it up.
 */
export const SCENE_PLAYBACK_RATE: Record<RelativeFPS, number> = {
  [RelativeFPS.Frozen]: 0,
  [RelativeFPS.VerySlow]: 0.1,
  [RelativeFPS.Slow]: 0.5,
  [RelativeFPS.Normal]: 1.0,
  [RelativeFPS.Fast]: 2.0,
  [RelativeFPS.VeryFast]: 4.0,
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
