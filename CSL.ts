export type Scale = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

export enum CameraMovementType {
  Static = "static",

  // Subject-following movements
  Follow = "follow", // Camera follows subject maintaining relative position
  Track = "track", // Camera tracks subject movement

  // Dolly movements (forward/backward along camera's Z-axis)
  DollyIn = "dollyIn",
  DollyOut = "dollyOut",

  // Pan movements (rotation around camera's Y-axis, camera stays in place)
  PanLeft = "panLeft",
  PanRight = "panRight",

  // Tilt movements (rotation around camera's X-axis, camera stays in place)
  TiltUp = "tiltUp",
  TiltDown = "tiltDown",

  // Truck movements (lateral movement along camera's X-axis)
  TruckLeft = "truckLeft",
  TruckRight = "truckRight",

  // Pedestal movements (vertical movement along camera's Y-axis)
  PedestalUp = "pedestalUp",
  PedestalDown = "pedestalDown",

  // Arc movements (circular movement around subject)
  ArcLeft = "arcLeft",
  ArcRight = "arcRight",

  // Crane movements (combined vertical + angular movement)
  CraneUp = "craneUp",
  CraneDown = "craneDown",

  // Dutch angle movements (roll rotation around camera's Z-axis)
  DutchLeft = "dutchLeft",
  DutchRight = "dutchRight",

  // Zoom (lens-based, not physical movement)
  ZoomIn = "zoomIn",
  ZoomOut = "zoomOut",

  Orbit = "orbit", // Full 360° around subject
}


export enum CameraVerticalAngle {
  WormsEye = "wormsEye",
  Low = "low",
  Eye = "eye",
  High = "high",
  Overhead = "overhead",
  BirdsEye = "birdsEye",
  TopDown = "topDown",
}


export enum ShotSize {
  ExtremeCloseUp = "extremeCloseUp",
  CloseUp = "closeUp",
  MediumCloseUp = "mediumCloseUp",
  MediumShot = "mediumShot",
  MediumLongShot = "mediumLongShot",
  FullShot = "fullShot",
  LongShot = "longShot",
  VeryLongShot = "veryLongShot",
  ExtremeLongShot = "extremeLongShot",
}


export enum SubjectView {
  Front = "front",
  Back = "back",
  Left = "left",
  Right = "right",
  ThreeQuarterFrontLeft = "threeQuarterFrontLeft",
  ThreeQuarterFrontRight = "threeQuarterFrontRight",
  ThreeQuarterBackLeft = "threeQuarterBackLeft",
  ThreeQuarterBackRight = "threeQuarterBackRight",
}


export enum SubjectInFramePosition {
  TopLeft = "topLeft",
  Top = "top",
  TopRight = "topRight",
  Left = "left",
  Center = "center",
  Right = "right",
  BottomLeft = "bottomLeft",
  Bottom = "bottom",
  BottomRight = "bottomRight",
}


export enum SpeedFunction {
  Increase = "increase",
  Decrease = "decrease",
  Static = "static",
}


export enum RelativeFPS {
  Frozen = "frozen", // Stop-motion effect
  VerySlow = "verySlow", // Extreme slow-motion
  Slow = "slow", // Slow-motion
  Normal = "normal", // Real-time
  Fast = "fast", // Slight speed-up
  VeryFast = "veryFast", // Time-lapse effect
}

export enum ComparisonOperator {
  LessThan = "lessThan",
  LessThanOrEqual = "lessThanOrEqual",
  Equal = "equal",
  GreaterThanOrEqual = "greaterThanOrEqual",
  GreaterThan = "greaterThan",
  NotEqual = "notEqual",
}

export enum RelativeTimeReference {
  Start = "start", // Start of referenced action
  End = "end", // End of referenced action
  Middle = "middle", // Middle point of referenced action
}

export enum EventType {
  Distance = "distance", // Euclidean distance between objects
  Velocity = "velocity", // Subject velocity threshold
}

export enum ConstraintType {
  NoShake = "noShake", // Smooth, stabilized movement
  KeepInFrame = "keepInFrame", // Keep subject(s) always visible
  MaintainDistance = "maintainDistance", // Fixed distance to subject
  MaintainAngle = "maintainAngle", // Fixed angle relative to subject
  AvoidOcclusion = "avoidOcclusion", // Don't let objects block view
  GroundLevel = "groundLevel", // Keep camera at ground level
}


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

export interface CameraPose {
  position: Vector3;
  rotation: Quaternion | EulerAngles;
}

export interface CameraExtrinsics {
  pose: CameraPose;
  transformMatrix?: [
    [number, number, number, number],
    [number, number, number, number],
    [number, number, number, number],
    [number, number, number, number]
  ];
}

export interface CameraIntrinsics {
  focalLength?: number; // in mm
  fov?: number;
  aspectRatio?: number;
  sensorSize?: { width: number; height: number }; // in mm
}


export interface Target {
  id: string;
  description: string;
}

export interface SubjectFraming {
  position?: SubjectInFramePosition;
  dutchAngleScale?: Scale;
}

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
  speed: number; // units per second
  direction?: Vector3; // Optional: specific direction
}

export type EventTrigger =
  | DistanceEventTrigger
  | VelocityEventTrigger;

export interface AbsoluteTimeTrigger {
  type: "absoluteTime";
  time: number;
}

export interface RelativeTimeTrigger {
  type: "relativeTime";
  actionId: string;
  reference: RelativeTimeReference;
  offset: number; // in seconds (can be negative)
}

export type Trigger = EventTrigger | AbsoluteTimeTrigger | RelativeTimeTrigger;

export interface CompoundTrigger {
  operator: "and" | "or";
  triggers: (Trigger | CompoundTrigger)[];
}

export type TriggerSpec = Trigger | CompoundTrigger;

export interface SpeedKeyframe {
  normalizedTime: number;
  speedMultiplier: number;
  easing?: SpeedFunction;
}

export interface Movement {
  act: CameraMovementType;
  endConfig?: CameraConfig;
  duration?: number;
  speedKeyframes?: SpeedKeyframe[];
  relativeFPS?: RelativeFPS;
  parameters?: MovementParameters;
}

export interface MovementParameters {
  arcAngle?: number;
  arcRadius?: number;

  // For Pan/Tilt
  rotationAngle?: number;

  // For Dolly/Truck/Pedestal
  distance?: number;

  // For Crane
  heightChange?: number; // Vertical distance
  horizontalDistance?: number; // Horizontal distance

  // For Zoom
  zoomFactor?: number; // End focal length / start focal length

  // For Follow/Track
  followDelay?: number; // Seconds of lag behind subject
  leadAmount?: number; // How far ahead to anticipate movement

  // General
  path?: "linear" | "curved" | "spline"; // Path interpolation type
  curveIntensity?: Scale; // How curved the path is
}


export interface VisibilityConstraint {
  type: "visibility";
  targets: Target[];
  minVisibility?: number; // 0.0 to 1.0, portion that must be visible
  allFrames?: boolean; // Must be visible in every frame
}

export interface DistanceConstraint {
  type: "distance";
  target: Target;
  minDistance?: number;
  maxDistance?: number;
  exactDistance?: number;
}

export interface AngleConstraint {
  type: "angle";
  target: Target;
  horizontalAngle?: { min?: number; max?: number };
  verticalAngle?: { min?: number; max?: number };
}

export type Constraint =
  | VisibilityConstraint
  | DistanceConstraint
  | AngleConstraint;

export interface ConstraintsConfig {
  constraints: Constraint[];
  allFramesVisibility?: boolean;
  staticDistance?: boolean;
  staticCameraSubjectRotation?: boolean;
  noShake?: boolean;
}

export interface Action {
  id: string;
  name?: string;
  trigger: TriggerSpec;
  targets: Target[];
  movement: Movement;
  priority?: number;
  constraints?: ConstraintsConfig;
}

export interface InitCamera {
  targets: Target[];
  config: CameraConfig;
  globalConstraints?: ConstraintsConfig;
}

export interface CameraDirectionDSL {
  initCamera: InitCamera;
  actions: Action[];
}

// ============================================================================
// HELPER TYPES FOR TIMELINE SOLVER OUTPUT
// ============================================================================

export interface SinglePointConstraint {
  type: "singlePoint";
  time: number; // in seconds
  config: CameraConfig;
  weight?: number; // Importance in optimization (0.0 to 1.0)
}

export interface IntervalConstraint {
  type: "interval";
  startTime: number;
  endTime: number;
  lossFunction: LossFunction;
  weight?: number;
}

export interface LossFunction {
  type: LossFunctionType;
  parameters: Record<string, unknown>;
}

export enum LossFunctionType {
  PedestalMovement = "pedestalMovement",
  DollyMovement = "dollyMovement",
  TruckMovement = "truckMovement",
  PanMovement = "panMovement",
  TiltMovement = "tiltMovement",
  ArcMovement = "arcMovement",

  FramingPosition = "framingPosition",
  ShotSize = "shotSize",
  SubjectView = "subjectView",

  // General losses
  Collision = "collision",
  Smoothness = "smoothness",
  MinPath = "minPath",
}

export interface TimelineSolverOutput {
  initKeyframes: SinglePointConstraint[];
  constraints: (SinglePointConstraint | IntervalConstraint)[];
}
