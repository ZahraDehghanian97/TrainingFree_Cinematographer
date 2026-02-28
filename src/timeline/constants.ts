import { CameraMovementType, LossFunctionType } from "../types/CSL";


export const BASE_SPEED: Record<CameraMovementType, number> = {
  // Some default speed values taken from Chat-GPT
  dollyIn: 1.0,
  dollyOut: 1.0,
  panLeft: 0.6,
  panRight: 0.6,
  tiltUp: 0.5,
  tiltDown: 0.5,
  truckLeft: 0.9,
  truckRight: 0.9,
  pedestalUp: 0.7,
  pedestalDown: 0.7,
  arcLeft: 0.4,
  arcRight: 0.4,
  zoomIn: 0.8,
  zoomOut: 0.8,
  static: Infinity,
  follow: 1.0,
  track: 1.0,
  orbit: 0.3,
  craneUp: 0.6,
  craneDown: 0.6,
  dutchLeft: 0.4,
  dutchRight: 0.4
};

export const LOSS_MAP: Partial<Record<CameraMovementType, LossFunctionType>> = {
  // Probably must change act from CameraMovementType to string
  [CameraMovementType.DollyIn]: LossFunctionType.DollyMovement,
  [CameraMovementType.DollyOut]: LossFunctionType.DollyMovement,
  [CameraMovementType.Follow]: LossFunctionType.FollowMovement, // Must be checked
  [CameraMovementType.ZoomIn]: LossFunctionType.DollyMovement, // Must be checked
  [CameraMovementType.ZoomOut]: LossFunctionType.DollyMovement, // Must be checked
  [CameraMovementType.PanLeft]: LossFunctionType.PanMovement,
  [CameraMovementType.PanRight]: LossFunctionType.PanMovement,
  [CameraMovementType.TiltUp]: LossFunctionType.TiltMovement,
  [CameraMovementType.TiltDown]: LossFunctionType.TiltMovement,
  [CameraMovementType.TruckLeft]: LossFunctionType.TruckMovement,
  [CameraMovementType.TruckRight]: LossFunctionType.TruckMovement,
  [CameraMovementType.PedestalUp]: LossFunctionType.PedestalMovement,
  [CameraMovementType.PedestalDown]: LossFunctionType.PedestalMovement,
  [CameraMovementType.ArcLeft]: LossFunctionType.ArcMovement,
  [CameraMovementType.ArcRight]: LossFunctionType.ArcMovement,
  [CameraMovementType.Orbit]: LossFunctionType.ArcMovement, // Must be checked
  [CameraMovementType.Track]: LossFunctionType.DollyMovement, // Must be checked
  [CameraMovementType.Static]: LossFunctionType.Static, // Must be checked
};

export const FPS_WEIGHTS: Record<string, number> = {
  frozen: 5.0,
  verySlow: 3.0,
  slow: 2.0,
  normal: 1.0,
  fast: 0.5,
  veryFast: 0.2,
};