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



export interface ConstraintConfig {
  targets?: Target[];
  config: CameraConfig;
  allFrames: boolean; // true → enforce throughout the action; false → only at end
}

export interface Action {
  id: string;
  name?: string;
  trigger: TriggerSpec;
  movement: Movement;
  priority?: number;
  constraints?: ConstraintConfig[];
}

export interface InitCamera {
  targets: Target[];
  config: CameraConfig;
}

export interface Section {
  initCamera: InitCamera;
  actions: Action[];
}

export interface CameraDirectionDSL {
  sections: Section[];
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

export const promptExamples: { prompt: string, csl: CameraDirectionDSL }[] = [{
  prompt: "توپ رو دنبال کن و وقتی توپ نزدیک به دروازه شد، pedestal کن و از زاویه بالا توپ رو دنبال کن",
  csl: {
    sections: [
      {
        initCamera: {
          targets: [
            {
              id: "ball",
              description: "The ball"
            }
          ],
          config: {
            type: "subjectAware",
            shotSize: ShotSize.MediumShot,
            subjectView: SubjectView.Front,
            subjectFraming: {
              position: SubjectInFramePosition.Center
            }
          }
        },
        actions: [
          {
            id: "follow_ball",
            trigger: {
              type: "absoluteTime",
              time: 0
            },
            movement: {
              act: CameraMovementType.Follow
            }
          },
          {
            id: "pedestal_up",
            trigger: {
              type: "distance",
              object1: { id: "ball", description: "The ball" },
              object2: { id: "goal", description: "The goal" },
              operator: ComparisonOperator.LessThan,
              distance: 5
            },
            movement: {
              act: CameraMovementType.PedestalUp
            }
          },
          {
            id: "follow_high_angle",
            trigger: {
              type: "relativeTime",
              actionId: "pedestal_up",
              reference: RelativeTimeReference.End,
              offset: 0
            },
            movement: {
              act: CameraMovementType.Follow
            },
            constraints: [
              {
                targets: [{ id: "ball", description: "The ball" }],
                config: {
                  type: "subjectAware",
                  cameraAngle: CameraVerticalAngle.High,
                  shotSize: ShotSize.MediumShot,
                  subjectFraming: {
                    position: SubjectInFramePosition.Center
                  }
                },
                allFrames: true
              }
            ]
          }
        ]
      }
    ]
  }
},
{
  prompt: "از زوم روی صورت مرد شروع کن، یک stop motion بزن و ۳ دور کامل دور صورت آن بچرخ",
  csl: {
    sections: [
      {
        initCamera: {
          targets: [
            {
              id: "man_face",
              description: "The man's face"
            }
          ],
          config: {
            type: "subjectAware",
            shotSize: ShotSize.ExtremeCloseUp,
            subjectView: SubjectView.Front,
            subjectFraming: {
              position: SubjectInFramePosition.Center
            }
          }
        },
        actions: [
          {
            id: "orbit_stop_motion",
            trigger: {
              type: "absoluteTime",
              time: 0
            },
            movement: {
              act: CameraMovementType.Orbit,
              relativeFPS: RelativeFPS.Frozen,
              parameters: {
                arcAngle: 1080
              }
            },
            constraints: [
              {
                targets: [{ id: "man_face", description: "The man's face" }],
                config: {
                  type: "subjectAware",
                  shotSize: ShotSize.ExtremeCloseUp,
                  subjectFraming: {
                    position: SubjectInFramePosition.Center
                  }
                },
                allFrames: true
              }
            ]
          }
        ]
      }
    ]
  }
},
{
  prompt: "ابتدا به صورت کلوزآپ گلدون رو نشون بده و بعد dolly out کن تا همزمان گلدون و مانیتور در صحنه دیده‌شوند.",
  csl: {
    sections: [
      {
        initCamera: {
          targets: [
            {
              id: "vase",
              description: "The vase (گلدون)"
            }
          ],
          config: {
            type: "subjectAware",
            shotSize: ShotSize.CloseUp,
            subjectView: SubjectView.Front,
            subjectFraming: {
              position: SubjectInFramePosition.Center
            }
          }
        },
        actions: [
          {
            id: "dolly_out_reveal",
            trigger: {
              type: "absoluteTime",
              time: 0
            },
            movement: {
              act: CameraMovementType.DollyOut
            },
            constraints: [
              {
                targets: [
                  { id: "vase", description: "The vase (گلدون)" },
                  { id: "monitor", description: "The monitor (مانیتور)" }
                ],
                config: {
                  type: "subjectAware",
                  shotSize: ShotSize.MediumShot,
                  subjectFraming: {
                    position: SubjectInFramePosition.Center
                  }
                },
                allFrames: false
              }
            ]
          }
        ]
      }
    ]
  }
},
{
  prompt: "به مدت ۲ ثانیه ماشین رو ترک کن و یک arc right دورش بزن و همزمان با arc روی راننده زوم کن",
  csl: {
    sections: [
      {
        initCamera: {
          targets: [
            {
              id: "car",
              description: "The car (ماشین)"
            }
          ],
          config: {
            type: "subjectAware",
            shotSize: ShotSize.MediumShot,
            subjectView: SubjectView.Front,
            subjectFraming: {
              position: SubjectInFramePosition.Center
            }
          }
        },
        actions: [
          {
            id: "track_car",
            trigger: {
              type: "absoluteTime",
              time: 0
            },
            movement: {
              act: CameraMovementType.Track,
              duration: 2
            }
          },
          {
            id: "arc_right_car",
            trigger: {
              type: "relativeTime",
              actionId: "track_car",
              reference: RelativeTimeReference.End,
              offset: 0
            },
            movement: {
              act: CameraMovementType.ArcRight
            },
            constraints: [
              {
                targets: [{ id: "car", description: "The car (ماشین)" }],
                config: {
                  type: "subjectAware",
                  subjectFraming: {
                    position: SubjectInFramePosition.Center
                  }
                },
                allFrames: true
              }
            ]
          },
          {
            id: "zoom_in_driver",
            trigger: {
              type: "relativeTime",
              actionId: "track_car",
              reference: RelativeTimeReference.End,
              offset: 0
            },
            movement: {
              act: CameraMovementType.ZoomIn
            },
            constraints: [
              {
                targets: [{ id: "driver", description: "The driver (راننده)" }],
                config: {
                  type: "subjectAware",
                  shotSize: ShotSize.CloseUp,
                  subjectFraming: {
                    position: SubjectInFramePosition.Center
                  }
                },
                allFrames: false
              }
            ]
          }
        ]
      }
    ]
  }
},
{
  prompt: "روی چهره بازیگر Dolly Out کن و همزمان Zoom In انجام بده تا پرسپکتیو پس‌زمینه تغییر کند اما اندازه صورت ثابت بماند.",
  csl: {
    sections: [
      {
        initCamera: {
          targets: [
            {
              id: "actor_face",
              description: "The actor's face (چهره بازیگر)"
            }
          ],
          config: {
            type: "subjectAware",
            shotSize: ShotSize.CloseUp,
            subjectView: SubjectView.Front,
            subjectFraming: {
              position: SubjectInFramePosition.Center
            }
          }
        },
        actions: [
          {
            id: "dolly_out_face",
            trigger: {
              type: "absoluteTime",
              time: 0
            },
            movement: {
              act: CameraMovementType.DollyOut
            },
            constraints: [
              {
                targets: [{ id: "actor_face", description: "The actor's face (چهره بازیگر)" }],
                config: {
                  type: "subjectAware",
                  shotSize: ShotSize.CloseUp,
                  subjectFraming: {
                    position: SubjectInFramePosition.Center
                  }
                },
                allFrames: true
              }
            ]
          },
          {
            id: "zoom_in_face",
            trigger: {
              type: "absoluteTime",
              time: 0
            },
            movement: {
              act: CameraMovementType.ZoomIn
            },
            constraints: [
              {
                targets: [{ id: "actor_face", description: "The actor's face (چهره بازیگر)" }],
                config: {
                  type: "subjectAware",
                  shotSize: ShotSize.CloseUp,
                  subjectFraming: {
                    position: SubjectInFramePosition.Center
                  }
                },
                allFrames: true
              }
            ]
          }
        ]
      }
    ]
  }
},
{
  prompt: "زمان را روی ۲ ثانیه فریز کن و یک دور کامل ۳۶۰ درجه دور سوژه معلق در هوا بچرخ، سپس حرکت را با سرعت عادی ادامه بده.",
  csl: {
    sections: [
      {
        initCamera: {
          targets: [
            {
              id: "subject",
              description: "The subject"
            }
          ],
          config: {
            type: "subjectAware",
            shotSize: ShotSize.MediumShot,
            subjectView: SubjectView.Front,
            subjectFraming: {
              position: SubjectInFramePosition.Center
            }
          }
        },
        actions: [
          {
            id: "frozen_orbit_360",
            trigger: {
              type: "absoluteTime",
              time: 0
            },
            movement: {
              act: CameraMovementType.Orbit,
              duration: 2,
              relativeFPS: RelativeFPS.Frozen,
              parameters: {
                arcAngle: 360
              }
            },
            constraints: [
              {
                targets: [{ id: "subject", description: "The subject" }],
                config: {
                  type: "subjectAware",
                  shotSize: ShotSize.MediumShot,
                  subjectFraming: {
                    position: SubjectInFramePosition.Center
                  }
                },
                allFrames: true
              }
            ]
          },
          {
            id: "resume_normal_speed",
            trigger: {
              type: "relativeTime",
              actionId: "frozen_orbit_360",
              reference: RelativeTimeReference.End,
              offset: 0
            },
            movement: {
              act: CameraMovementType.Follow,
              relativeFPS: RelativeFPS.Normal
            }
          }
        ]
      }
    ]
  }
},
{
  prompt: "از نمای بالا شروع کن و با یک حرکت حلزونی همزمان که می‌چرخی، به سوژه نزدیک شو تا به کلوزآپ چشم‌هایش برسی.",
  csl: {
    sections: [
      {
        initCamera: {
          targets: [
            {
              id: "subject",
              description: "The subject"
            }
          ],
          config: {
            type: "subjectAware",
            cameraAngle: CameraVerticalAngle.BirdsEye,
            shotSize: ShotSize.LongShot,
            subjectView: SubjectView.Front,
            subjectFraming: {
              position: SubjectInFramePosition.Center
            }
          }
        },
        actions: [
          {
            id: "spiral_orbit",
            trigger: {
              type: "absoluteTime",
              time: 0
            },
            movement: {
              act: CameraMovementType.Orbit,
              parameters: {
                arcAngle: 720,
                path: "spline"
              }
            },
            constraints: [
              {
                targets: [{ id: "subject", description: "The subject" }],
                config: {
                  type: "subjectAware",
                  subjectFraming: {
                    position: SubjectInFramePosition.Center
                  }
                },
                allFrames: true
              }
            ]
          },
          {
            id: "spiral_dolly_in",
            trigger: {
              type: "absoluteTime",
              time: 0
            },
            movement: {
              act: CameraMovementType.DollyIn
            },
            constraints: [
              {
                targets: [{ id: "subject_eyes", description: "The subject's eyes (چشم‌های سوژه)" }],
                config: {
                  type: "subjectAware",
                  cameraAngle: CameraVerticalAngle.Eye,
                  shotSize: ShotSize.ExtremeCloseUp,
                  subjectFraming: {
                    position: SubjectInFramePosition.Center
                  }
                },
                allFrames: false
              }
            ]
          }
        ]
      }
    ]
  }
},
{
  prompt: "ابتدا صحنه مشت زدن را با Slow Motion (سرعت ۱۰٪) نشان بده و درست لحظه برخورد، سرعت را به Hyper Fast تغییر بده و روی محل ضربه زوم کن.",
  csl: {
    sections: [
      {
        initCamera: {
          targets: [
            {
              id: "fist",
              description: "The fist (مشت)"
            }
          ],
          config: {
            type: "subjectAware",
            shotSize: ShotSize.MediumShot,
            subjectView: SubjectView.ThreeQuarterFrontRight,
            subjectFraming: {
              position: SubjectInFramePosition.Center
            }
          }
        },
        actions: [
          {
            id: "slow_motion_punch",
            trigger: {
              type: "absoluteTime",
              time: 0
            },
            movement: {
              act: CameraMovementType.Follow,
              relativeFPS: RelativeFPS.VerySlow
            },
            constraints: [
              {
                targets: [{ id: "fist", description: "The fist (مشت)" }],
                config: {
                  type: "subjectAware",
                  shotSize: ShotSize.MediumShot,
                  subjectFraming: {
                    position: SubjectInFramePosition.Center
                  }
                },
                allFrames: true
              }
            ]
          },
          {
            id: "hyper_fast_impact",
            trigger: {
              type: "distance",
              object1: { id: "fist", description: "The fist (مشت)" },
              object2: { id: "target", description: "The impact target (محل ضربه)" },
              operator: ComparisonOperator.LessThanOrEqual,
              distance: 0
            },
            movement: {
              act: CameraMovementType.Follow,
              relativeFPS: RelativeFPS.VeryFast
            }
          },
          {
            id: "zoom_in_impact",
            trigger: {
              type: "distance",
              object1: { id: "fist", description: "The fist (مشت)" },
              object2: { id: "target", description: "The impact target (محل ضربه)" },
              operator: ComparisonOperator.LessThanOrEqual,
              distance: 0
            },
            movement: {
              act: CameraMovementType.ZoomIn
            },
            constraints: [
              {
                targets: [{ id: "impact_point", description: "The point of impact (محل ضربه)" }],
                config: {
                  type: "subjectAware",
                  shotSize: ShotSize.ExtremeCloseUp,
                  subjectFraming: {
                    position: SubjectInFramePosition.Center
                  }
                },
                allFrames: false
              }
            ]
          }
        ]
      }
    ]
  }
},
{
  prompt: "دو نفر را در نمای Long Shot دنبال کن؛ به محض اینکه فاصله آن‌ها به کمتر از ۱ متر رسید، کات بزن به Over-the-Shoulder (نمای روی شانه).",
  csl: {
    sections: [
      {
        initCamera: {
          targets: [
            { id: "person1", description: "First person (نفر اول)" },
            { id: "person2", description: "Second person (نفر دوم)" }
          ],
          config: {
            type: "subjectAware",
            shotSize: ShotSize.LongShot,
            subjectView: SubjectView.Front,
            subjectFraming: {
              position: SubjectInFramePosition.Center
            }
          }
        },
        actions: [
          {
            id: "follow_two_people",
            trigger: {
              type: "absoluteTime",
              time: 0
            },
            movement: {
              act: CameraMovementType.Follow
            },
            constraints: [
              {
                targets: [
                  { id: "person1", description: "First person (نفر اول)" },
                  { id: "person2", description: "Second person (نفر دوم)" }
                ],
                config: {
                  type: "subjectAware",
                  shotSize: ShotSize.LongShot,
                  subjectFraming: {
                    position: SubjectInFramePosition.Center
                  }
                },
                allFrames: true
              }
            ]
          }
        ]
      },
      {
        initCamera: {
          targets: [
            { id: "person2", description: "Second person (نفر دوم)" }
          ],
          config: {
            type: "subjectAware",
            shotSize: ShotSize.MediumCloseUp,
            subjectView: SubjectView.ThreeQuarterFrontLeft,
            subjectFraming: {
              position: SubjectInFramePosition.Center
            }
          }
        },
        actions: [
          {
            id: "ots_cut",
            trigger: {
              type: "distance",
              object1: { id: "person1", description: "First person (نفر اول)" },
              object2: { id: "person2", description: "Second person (نفر دوم)" },
              operator: ComparisonOperator.LessThan,
              distance: 1
            },
            movement: {
              act: CameraMovementType.Static
            },
            constraints: [
              {
                targets: [
                  { id: "person1_shoulder", description: "First person's shoulder (شانه نفر اول)" },
                  { id: "person2", description: "Second person (نفر دوم)" }
                ],
                config: {
                  type: "subjectAware",
                  shotSize: ShotSize.MediumCloseUp,
                  subjectView: SubjectView.ThreeQuarterFrontLeft,
                  subjectFraming: {
                    position: SubjectInFramePosition.Center
                  }
                },
                allFrames: true
              }
            ]
          }
        ]
      }
    ]
  }
},
{
  prompt: "ماشین مسابقه را دنبال کن، اگر سرعت ماشین از ۱۰۰ کیلومتر بیشتر شد، دوربین را بلرزان و عقب بکش تا حس سرعت القا شود.",
  csl: {
    sections: [
      {
        initCamera: {
          targets: [
            {
              id: "race_car",
              description: "The racing car (ماشین مسابقه)"
            }
          ],
          config: {
            type: "subjectAware",
            shotSize: ShotSize.MediumShot,
            subjectView: SubjectView.ThreeQuarterFrontLeft,
            subjectFraming: {
              position: SubjectInFramePosition.Center
            }
          }
        },
        actions: [
          {
            id: "follow_race_car",
            trigger: {
              type: "absoluteTime",
              time: 0
            },
            movement: {
              act: CameraMovementType.Follow
            },
            constraints: [
              {
                targets: [{ id: "race_car", description: "The racing car (ماشین مسابقه)" }],
                config: {
                  type: "subjectAware",
                  shotSize: ShotSize.MediumShot,
                  subjectFraming: {
                    position: SubjectInFramePosition.Center
                  }
                },
                allFrames: true
              }
            ]
          },
          {
            id: "dolly_out_shake",
            trigger: {
              type: "velocity",
              subject: { id: "race_car", description: "The racing car (ماشین مسابقه)" },
              operator: ComparisonOperator.GreaterThan,
              speed: 27.78 // 100 km/h in m/s
            },
            movement: {
              act: CameraMovementType.DollyOut
            },
            constraints: [
              {
                targets: [{ id: "race_car", description: "The racing car (ماشین مسابقه)" }],
                config: {
                  type: "subjectAware",
                  shotSize: ShotSize.MediumLongShot,
                  subjectFraming: {
                    position: SubjectInFramePosition.Center,
                    dutchAngleScale: 4
                  }
                },
                allFrames: true
              }
            ]
          }
        ]
      }
    ]
  }
},
{
  prompt: "برای ایجاد حس ترس، دوربین را ۳۰ درجه کج کن و به صورت دستی و لرزان به سمت در نیمه‌باز حرکت کن.",
  csl: {
    sections: [
      {
        initCamera: {
          targets: [
            {
              id: "half_open_door",
              description: "The half-open door (در نیمه‌باز)"
            }
          ],
          config: {
            type: "subjectAware",
            shotSize: ShotSize.MediumShot,
            subjectView: SubjectView.Front,
            subjectFraming: {
              position: SubjectInFramePosition.Center
            }
          }
        },
        actions: [
          {
            id: "dutch_tilt_30",
            trigger: {
              type: "absoluteTime",
              time: 0
            },
            movement: {
              act: CameraMovementType.DutchLeft,
              parameters: {
                rotationAngle: 30
              }
            }
          },
          {
            id: "handheld_dolly_in",
            trigger: {
              type: "absoluteTime",
              time: 0
            },
            movement: {
              act: CameraMovementType.DollyIn
            },
            constraints: [
              {
                targets: [{ id: "half_open_door", description: "The half-open door (در نیمه‌باز)" }],
                config: {
                  type: "subjectAware",
                  shotSize: ShotSize.MediumCloseUp,
                  subjectFraming: {
                    position: SubjectInFramePosition.Center,
                    dutchAngleScale: 7
                  }
                },
                allFrames: true
              }
            ]
          }
        ]
      }
    ]
  }
},
{
  prompt: "از نمای داخل ماشین (Dashboard View) شروع کن، وقتی راننده ترمز کرد، دوربین از شیشه جلو بیرون بیاید و با یک Arc سریع، نمای جلوی ماشین را نشان دهد.",
  csl: {
    sections: [
      {
        initCamera: {
          targets: [
            {
              id: "dashboard",
              description: "The car's dashboard interior view (نمای داخل ماشین از داشبورد)"
            }
          ],
          config: {
            type: "subjectAware",
            shotSize: ShotSize.CloseUp,
            subjectView: SubjectView.Back,
            subjectFraming: {
              position: SubjectInFramePosition.Center
            }
          }
        },
        actions: [
          {
            id: "dashboard_static",
            trigger: {
              type: "absoluteTime",
              time: 0
            },
            movement: {
              act: CameraMovementType.Static
            }
          },
          {
            id: "exit_through_windshield",
            trigger: {
              type: "velocity",
              subject: { id: "car", description: "The car (ماشین)" },
              operator: ComparisonOperator.LessThan,
              speed: 5
            },
            movement: {
              act: CameraMovementType.DollyIn,
              speedKeyframes: [
                { normalizedTime: 0, speedMultiplier: 1 },
                { normalizedTime: 1, speedMultiplier: 2 }
              ]
            },
            constraints: [{
              targets: [{ id: "car", description: "The car (ماشین)" }],
              config: {
                type: "subjectAware",
                shotSize: ShotSize.MediumShot,
                subjectView: SubjectView.Front,
                subjectFraming: {
                  position: SubjectInFramePosition.Center
                }
              },
              allFrames: false
            }]
          },
          {
            id: "arc_front_reveal",
            trigger: {
              type: "relativeTime",
              actionId: "exit_through_windshield",
              reference: RelativeTimeReference.End,
              offset: 0
            },
            movement: {
              act: CameraMovementType.ArcRight,
              speedKeyframes: [
                { normalizedTime: 0, speedMultiplier: 2 },
                { normalizedTime: 1, speedMultiplier: 1 }
              ],
              parameters: {
                arcAngle: 180
              }
            },
            constraints: [
              {
                targets: [{ id: "car", description: "The car (ماشین)" }],
                config: {
                  type: "subjectAware",
                  shotSize: ShotSize.MediumShot,
                  subjectView: SubjectView.Front,
                  subjectFraming: {
                    position: SubjectInFramePosition.Center
                  }
                },
                allFrames: false
              }
            ]
          }
        ]
      }
    ]
  }
}]
