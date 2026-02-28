export type Scale = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;

/** Physical or virtual camera movement types */
export enum CameraMovementType {
  Static = "static",

  // Subject-following
  Follow = "follow",
  Track = "track",

  // Dolly (forward/backward along camera Z-axis)
  DollyIn = "dollyIn",
  DollyOut = "dollyOut",

  // Pan (rotation around Y-axis, camera stays in place)
  PanLeft = "panLeft",
  PanRight = "panRight",

  // Tilt (rotation around X-axis, camera stays in place)
  TiltUp = "tiltUp",
  TiltDown = "tiltDown",

  // Truck (lateral movement along X-axis)
  TruckLeft = "truckLeft",
  TruckRight = "truckRight",

  // Pedestal (vertical movement along Y-axis)
  PedestalUp = "pedestalUp",
  PedestalDown = "pedestalDown",

  // Arc (circular movement around subject)
  ArcLeft = "arcLeft",
  ArcRight = "arcRight",

  // Crane (combined vertical + angular)
  CraneUp = "craneUp",
  CraneDown = "craneDown",

  // Dutch angle (roll rotation around Z-axis)
  DutchLeft = "dutchLeft",
  DutchRight = "dutchRight",

  // Zoom (lens-based, not physical movement)
  ZoomIn = "zoomIn",
  ZoomOut = "zoomOut",

  // Full orbit (360° around subject)
  Orbit = "orbit",
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

// ─── Time & Speed Enums ──────────────────────────────────────────────────────

export enum SpeedFunction {
  Increase = "increase",
  Decrease = "decrease",
  Static = "static",
}

export enum RelativeFPS {
  Frozen = "frozen",
  VerySlow = "verySlow",
  Slow = "slow",
  Normal = "normal",
  Fast = "fast",
  VeryFast = "veryFast",
}

// ─── Trigger & Comparison Enums ──────────────────────────────────────────────

export enum ComparisonOperator {
  LessThan = "lessThan",
  LessThanOrEqual = "lessThanOrEqual",
  Equal = "equal",
  GreaterThanOrEqual = "greaterThanOrEqual",
  GreaterThan = "greaterThan",
  NotEqual = "notEqual",
}

export enum RelativeTimeReference {
  Start = "start",
  End = "end",
  Middle = "middle",
}

export enum EventType {
  Distance = "distance",
  Velocity = "velocity",
}

export enum ConstraintType {
  NoShake = "noShake",
  KeepInFrame = "keepInFrame",
  MaintainDistance = "maintainDistance",
  MaintainAngle = "maintainAngle",
  AvoidOcclusion = "avoidOcclusion",
  GroundLevel = "groundLevel",
}
