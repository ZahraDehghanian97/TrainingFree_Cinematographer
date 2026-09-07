import { LossFunctionType } from "../../types/solver";

export const TRANSLATION_TYPES: ReadonlySet<LossFunctionType> = new Set([
  LossFunctionType.DollyInMovement,
  LossFunctionType.DollyOutMovement,
  LossFunctionType.TruckLeftMovement,
  LossFunctionType.TruckRightMovement,
  LossFunctionType.PedestalUpMovement,
  LossFunctionType.PedestalDownMovement,
  LossFunctionType.ArcMovement,
  LossFunctionType.FollowMovement,
  LossFunctionType.TrackMovement,
  LossFunctionType.CraneUpMovement,
  LossFunctionType.CraneDownMovement,
]);

const ROTATION_TYPES: ReadonlySet<LossFunctionType> = new Set([
  LossFunctionType.PanLeftMovement,
  LossFunctionType.PanRightMovement,
  LossFunctionType.TiltUpMovement,
  LossFunctionType.TiltDownMovement,
  LossFunctionType.DutchLeftMovement,
  LossFunctionType.DutchRightMovement,
]);

export const ORIENTATION_DRIVING_TYPES: ReadonlySet<LossFunctionType> = new Set([
  ...ROTATION_TYPES,
  LossFunctionType.ArcMovement,
  LossFunctionType.FollowMovement,
  LossFunctionType.TrackMovement,
  LossFunctionType.FramingPosition,
  LossFunctionType.FramingDutchAngle,
  LossFunctionType.ShotSize,
  LossFunctionType.SubjectView,
  LossFunctionType.CameraVerticalAngle,
  LossFunctionType.KeepInFrame,
]);

export const FOV_DRIVING_TYPES: ReadonlySet<LossFunctionType> = new Set([
  LossFunctionType.ZoomIn,
  LossFunctionType.ZoomOut,
  LossFunctionType.ShotSize,
  LossFunctionType.KeepInFrame,
]);

export const YAW_PITCH_TARGETING_TYPES: ReadonlySet<LossFunctionType> = new Set([
  LossFunctionType.FramingPosition,
  LossFunctionType.ShotSize,
  LossFunctionType.SubjectView,
  LossFunctionType.CameraVerticalAngle,
  LossFunctionType.FollowMovement,
  LossFunctionType.TrackMovement,
  LossFunctionType.ArcMovement,
]);

export const FRAMING_TARGETS: Record<string, [number, number]> = {
  topLeft: [0.25, 0.25],
  top: [0.5, 0.25],
  topRight: [0.75, 0.25],
  left: [0.25, 0.5],
  center: [0.5, 0.5],
  right: [0.75, 0.5],
  bottomLeft: [0.25, 0.75],
  bottom: [0.5, 0.75],
  bottomRight: [0.75, 0.75],
};

export const SHOT_SIZE_COVERAGE: Record<string, number> = {
  extremeCloseUp: 0.9,
  closeUp: 0.7,
  mediumCloseUp: 0.56,
  mediumShot: 0.43,
  mediumLongShot: 0.34,
  fullShot: 0.27,
  longShot: 0.19,
  veryLongShot: 0.12,
  extremeLongShot: 0.07,
};

export const SUBJECT_VIEW_AZIMUTH_DEGREES: Record<string, number> = {
  front: 0,
  threeQuarterFrontRight: 45,
  right: 90,
  threeQuarterBackRight: 135,
  back: 180,
  threeQuarterBackLeft: -135,
  left: -90,
  threeQuarterFrontLeft: -45,
};

export const VERTICAL_ANGLE_DEGREES: Record<string, number> = {
  wormsEye: -35,
  low: -18,
  eye: 0,
  high: 20,
  overhead: 42,
  birdsEye: 58,
  topDown: 88,
};
