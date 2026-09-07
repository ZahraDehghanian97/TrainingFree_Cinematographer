import type { ResolvedCameraDirectionDSL } from "../types/dsl";
import { ShotSize, SubjectView, SubjectInFramePosition, CameraMovementType, ComparisonOperator, RelativeTimeReference, CameraVerticalAngle, RelativeFPS, SpeedFunction, ConstraintType } from "../types/enums";

export interface ResolvedPromptExampleFixture {
  id: string;
  environmentId: string;
  prompt: string;
  resolvedCsl: ResolvedCameraDirectionDSL;
}

export const resolvedPromptExampleFixtures: ResolvedPromptExampleFixture[] = [{
  id: "example-01",
  environmentId: "example-01-football",
  prompt: "توپ رو دنبال کن و وقتی توپ نزدیک به دروازه شد، pedestal کن و از زاویه بالا توپ رو دنبال کن",
  resolvedCsl: {
    totalDuration: 10,
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
              act: CameraMovementType.Follow,
              targets: [{ id: "ball", description: "The ball" }]
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
              act: CameraMovementType.PedestalUp,
              duration: 3,
              speedKeyframes: [
                { normalizedTime: 0, speedMultiplier: 0 },
                { normalizedTime: 0.2, speedMultiplier: 1, easing: SpeedFunction.Increase },
                { normalizedTime: 0.8, speedMultiplier: 1 },
                { normalizedTime: 1, speedMultiplier: 0, easing: SpeedFunction.Decrease }
              ]
            }
          },
          {
            id: "follow_high_angle",
            trigger: {
              type: "relativeTime",
              actionId: "pedestal_up",
              reference: RelativeTimeReference.Start,
              offset: 0
            },
            movement: {
              act: CameraMovementType.Follow,
              targets: [{ id: "ball", description: "The ball" }],
              duration: 3
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
  id: "example-02",
  environmentId: "example-02-face-orbit",
  prompt: "از زوم روی صورت مرد شروع کن، یک stop motion بزن و ۳ دور کامل دور صورت آن بچرخ",
  resolvedCsl: {
    totalDuration: 15,
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
              targets: [{ id: "man_face", description: "The man's face" }],
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
  id: "example-03",
  environmentId: "example-03-vase-reveal",
  prompt: "ابتدا به صورت کلوزآپ گلدون رو نشون بده و بعد dolly out کن تا همزمان گلدون و مانیتور در صحنه دیده‌شوند.",
  resolvedCsl: {
    totalDuration: 20,
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
              act: CameraMovementType.DollyOut,
              targets: [{ id: "vase", description: "The vase (گلدون)" }],
              speedKeyframes: [
                { normalizedTime: 0, speedMultiplier: 0 },
                { normalizedTime: 0.1, speedMultiplier: 1, easing: SpeedFunction.Increase },
                { normalizedTime: 0.9, speedMultiplier: 1, easing: SpeedFunction.Static },
                { normalizedTime: 1, speedMultiplier: 0, easing: SpeedFunction.Decrease }
              ]
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
  id: "example-04",
  environmentId: "example-04-car-arc",
  prompt: "به مدت ۲ ثانیه ماشین رو ترک کن و یک arc right دورش بزن و همزمان با arc روی راننده زوم کن",
  resolvedCsl: {
    totalDuration: 15,
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
              targets: [{ id: "car", description: "The car (ماشین)" }],
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
              act: CameraMovementType.ArcRight,
              targets: [{ id: "car", description: "The car (ماشین)" }]
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
              act: CameraMovementType.ZoomIn,
              speedKeyframes: [
                { normalizedTime: 0, speedMultiplier: 0 },
                { normalizedTime: 0.15, speedMultiplier: 1, easing: SpeedFunction.Increase },
                { normalizedTime: 0.85, speedMultiplier: 1 },
                { normalizedTime: 1, speedMultiplier: 0, easing: SpeedFunction.Decrease }
              ],
              parameters: { zoomFactor: 6 }
            },
            constraints: [
              {
                targets: [{ id: "driver", description: "The driver (راننده)" }],
                config: {
                  type: "subjectAware",
                  shotSize: ShotSize.MediumCloseUp,
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
  id: "example-05",
  environmentId: "example-05-dolly-zoom",
  prompt: "روی چهره بازیگر Dolly Out کن و همزمان Zoom In انجام بده تا پرسپکتیو پس‌زمینه تغییر کند اما اندازه صورت ثابت بماند.",
  resolvedCsl: {
    totalDuration: 25,
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
              act: CameraMovementType.DollyOut,
              targets: [{ id: "actor_face", description: "The actor's face (چهره بازیگر)" }]
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
  id: "example-06",
  environmentId: "example-06-frozen-orbit",
  prompt: "زمان را روی ۲ ثانیه فریز کن و یک دور کامل ۳۶۰ درجه دور سوژه معلق در هوا بچرخ، سپس حرکت را با سرعت عادی ادامه بده.",
  resolvedCsl: {
    totalDuration: 5,
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
              targets: [{ id: "subject", description: "The subject" }],
              duration: 2,
              relativeFPS: RelativeFPS.Frozen,
              speedKeyframes: [
                { normalizedTime: 0, speedMultiplier: 0 },
                { normalizedTime: 0.15, speedMultiplier: 1, easing: SpeedFunction.Increase },
                { normalizedTime: 0.85, speedMultiplier: 1 },
                { normalizedTime: 1, speedMultiplier: 0, easing: SpeedFunction.Decrease }
              ],
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
              targets: [{ id: "subject", description: "The subject" }],
              relativeFPS: RelativeFPS.Normal,
              parameters: { followDelay: 0.1, leadAmount: 0.1 }
            }
          }
        ]
      }
    ]
  }
},
{
  id: "example-07",
  environmentId: "example-07-spiral-closeup",
  prompt: "از نمای بالا شروع کن و با یک حرکت حلزونی همزمان که می‌چرخی، به سوژه نزدیک شو تا به کلوزآپ چشم‌هایش برسی.",
  resolvedCsl: {
    totalDuration: 9,
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
              targets: [{ id: "subject", description: "The subject" }],
              speedKeyframes: [
                { normalizedTime: 0, speedMultiplier: 0 },
                { normalizedTime: 0.15, speedMultiplier: 1, easing: SpeedFunction.Increase },
                { normalizedTime: 0.85, speedMultiplier: 1 },
                { normalizedTime: 1, speedMultiplier: 0, easing: SpeedFunction.Decrease }
              ],
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
              act: CameraMovementType.DollyIn,
              targets: [{ id: "subject_eyes", description: "The subject's eyes (چشم‌های سوژه)" }],
              speedKeyframes: [
                { normalizedTime: 0, speedMultiplier: 0 },
                { normalizedTime: 0.15, speedMultiplier: 1, easing: SpeedFunction.Increase },
                { normalizedTime: 0.85, speedMultiplier: 1 },
                { normalizedTime: 1, speedMultiplier: 0, easing: SpeedFunction.Decrease }
              ],
              parameters: {
                distance: 7.1,
                allowSubjectIntersection: true
              }
            },
            constraints: [
              {
                targets: [{ id: "subject_eyes", description: "The subject's eyes (چشم‌های سوژه)" }],
                config: {
                  type: "subjectAware",
                  cameraAngle: CameraVerticalAngle.Eye,
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
  id: "example-08",
  environmentId: "example-08-punch-impact",
  prompt: "ابتدا صحنه مشت زدن را با Slow Motion (سرعت ۱۰٪) نشان بده و درست لحظه برخورد، سرعت را به Hyper Fast تغییر بده و روی محل ضربه زوم کن.",
  resolvedCsl: {
    totalDuration: 12,
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
              targets: [{ id: "fist", description: "The fist (مشت)" }],
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
              act: CameraMovementType.Static,
              targets: [{ id: "impact_point", description: "The point of impact (محل ضربه)" }],
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
  id: "example-09",
  environmentId: "example-09-two-people",
  prompt: "دو نفر را در نمای Long Shot دنبال کن؛ به محض اینکه فاصله آن‌ها به کمتر از ۱ متر رسید، کات بزن به Over-the-Shoulder (نمای روی شانه).",
  resolvedCsl: {
    totalDuration: 24,
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
              act: CameraMovementType.Follow,
              targets: [
                { id: "person1", description: "First person (نفر اول)" },
                { id: "person2", description: "Second person (نفر دوم)" }
              ]
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
              act: CameraMovementType.Follow,
              targets: [{ id: "person2", description: "Second person (نفر دوم)" }]
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
                  subjectFraming: {
                    position: SubjectInFramePosition.Center
                  }
                },
                allFrames: true
              },
              {
                targets: [{ id: "person2", description: "Second person (نفر دوم)" }],
                config: {
                  type: "subjectAware",
                  subjectView: SubjectView.ThreeQuarterFrontLeft
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
  id: "example-10",
  environmentId: "example-10-race-car",
  prompt: "ماشین مسابقه را دنبال کن، اگر سرعت ماشین از ۱۰۰ کیلومتر بیشتر شد، دوربین را بلرزان و عقب بکش تا حس سرعت القا شود.",
  resolvedCsl: {
    totalDuration: 13,
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
              act: CameraMovementType.Follow,
              targets: [{ id: "race_car", description: "The racing car (ماشین مسابقه)" }]
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
              act: CameraMovementType.DollyOut,
              targets: [{ id: "race_car", description: "The racing car (ماشین مسابقه)" }],
              speedKeyframes: [
                { normalizedTime: 0, speedMultiplier: 0 },
                { normalizedTime: 0.15, speedMultiplier: 1.25, easing: SpeedFunction.Increase },
                { normalizedTime: 0.85, speedMultiplier: 1 },
                { normalizedTime: 1, speedMultiplier: 0.15, easing: SpeedFunction.Decrease }
              ],
              parameters: {
                distance: 4,
                path: "spline",
                curveIntensity: 2
              }
            },
            constraints: [
              {
                targets: [{ id: "race_car", description: "The racing car (ماشین مسابقه)" }],
                config: {
                  type: "subjectAware",
                  shotSize: ShotSize.MediumLongShot,
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
  id: "example-11",
  environmentId: "example-11-horror-door",
  prompt: "برای ایجاد حس ترس، دوربین را ۳۰ درجه کج کن و به صورت دستی و لرزان به سمت در نیمه‌باز حرکت کن.",
  resolvedCsl: {
    totalDuration: 6,
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
              act: CameraMovementType.DollyIn,
              targets: [{ id: "half_open_door", description: "The half-open door (در نیمه‌باز)" }],
              speedKeyframes: [
                { normalizedTime: 0, speedMultiplier: 0 },
                { normalizedTime: 0.18, speedMultiplier: 1, easing: SpeedFunction.Increase },
                { normalizedTime: 0.82, speedMultiplier: 0.85 },
                { normalizedTime: 1, speedMultiplier: 0, easing: SpeedFunction.Decrease }
              ],
              parameters: {
                distance: 2.8,
                path: "spline",
                curveIntensity: 1
              }
            },
            constraints: [
              {
                targets: [{ id: "half_open_door", description: "The half-open door (در نیمه‌باز)" }],
                config: {
                  type: "subjectAware",
                  shotSize: ShotSize.MediumCloseUp,
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
  id: "example-12",
  environmentId: "example-12-dashboard-exit",
  prompt: "از نمای داخل ماشین (Dashboard View) شروع کن، وقتی راننده ترمز کرد، دوربین از شیشه جلو بیرون بیاید و با یک Arc سریع، نمای جلوی ماشین را نشان دهد.",
  resolvedCsl: {
    totalDuration: 18,
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
            type: "nonSubjectAware",
            extrinsics: {
              pose: {
                position: { x: 0, y: 1.23, z: 30.75 },
                rotation: {
                  x: -0.08444990967903022,
                  y: 0,
                  z: 0,
                  w: 0.9964277258061438
                }
              }
            },
            intrinsics: { fov: 48 }
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
              act: CameraMovementType.Static,
              targets: [
                {
                  id: "dashboard",
                  description: "The car's dashboard interior view (نمای داخل ماشین از داشبورد)"
                }
              ]
            }
          },
          {
            id: "exit_through_windshield",
            trigger: {
              type: "absoluteTime",
              time: 8
            },
            movement: {
              act: CameraMovementType.DollyIn,
              targets: [{ id: "car", description: "The car (ماشین)" }],
              duration: 2.5,
              speedKeyframes: [
                { normalizedTime: 0, speedMultiplier: 1 },
                { normalizedTime: 1, speedMultiplier: 2 }
              ],
              parameters: {
                distance: 5.5,
                allowSubjectIntersection: true
              }
            },
            constraints: [{
              targets: [{ id: "car", description: "The car (ماشین)" }],
              config: {
                type: "subjectAware",
                shotSize: ShotSize.MediumShot,
                subjectView: SubjectView.Back,
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
              targets: [{ id: "car", description: "The car (ماشین)" }],
              speedKeyframes: [
                { normalizedTime: 0, speedMultiplier: 2 },
                { normalizedTime: 1, speedMultiplier: 1 }
              ],
              parameters: {
                arcAngle: 180,
                arcRadius: 5.5,
                path: "spline",
                curveIntensity: 2
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
},

{
  id: "example-13",
  environmentId: "example-13-horror-door-v2",
  prompt: "ورژن ۲ برای ایجاد حس ترس، دوربین را ۳۰ درجه کج کن و به صورت دستی و لرزان به سمت در نیمه‌باز حرکت کن.",
  resolvedCsl: {
    totalDuration: 7,
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
              },
              duration: 7
            }
          },
          {
            id: "handheld_dolly_in",
            trigger: {
              type: "absoluteTime",
              time: 0
            },
            movement: {
              act: CameraMovementType.DollyIn,
              targets: [{ id: "half_open_door", description: "The half-open door (در نیمه‌باز)" }],
              duration: 7,
              speedKeyframes: [
                { normalizedTime: 0, speedMultiplier: 0 },
                { normalizedTime: 0.18, speedMultiplier: 1, easing: SpeedFunction.Increase },
                { normalizedTime: 0.82, speedMultiplier: 0.85 },
                { normalizedTime: 1, speedMultiplier: 0, easing: SpeedFunction.Decrease }
              ],
              parameters: {
                distance: 3.2,
                path: "spline",
                curveIntensity: 2
              }
            },
            constraints: [
              {
                targets: [{ id: "half_open_door", description: "The half-open door (در نیمه‌باز)" }],
                config: {
                  type: "subjectAware",
                  shotSize: ShotSize.MediumCloseUp,
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
  id: "example-14",
  environmentId: "example-14-soft-closeup",
  prompt: "از یک مدیوم‌شات سه‌رخ و سکوت ۱.۵ ثانیه‌ای شروع کن؛ بعد همزمان با Dolly In آهسته و یک Arc Right کوتاه به صورت نزدیک شو. در دو ثانیه آخر یک Zoom In خیلی نرم اضافه کن و چهره را روی یک‌سوم چپ قاب در Close Up قفل کن.",
  resolvedCsl: {
    totalDuration: 10,
    sections: [{
      initCamera: {
        targets: [{ id: "actor", description: "The actor" }],
        config: {
          type: "subjectAware",
          shotSize: ShotSize.MediumShot,
          subjectView: SubjectView.ThreeQuarterFrontLeft,
          subjectFraming: { position: SubjectInFramePosition.Center }
        }
      },
      actions: [
        {
          id: "confession_hold",
          trigger: { type: "absoluteTime", time: 0 },
          movement: {
            act: CameraMovementType.Static,
            duration: 1.5
          },
          constraints: [{
            targets: [{ id: "actor", description: "The actor" }],
            config: {
              type: "subjectAware",
              shotSize: ShotSize.MediumShot,
              subjectView: SubjectView.ThreeQuarterFrontLeft,
              subjectFraming: { position: SubjectInFramePosition.Center }
            },
            allFrames: true
          }]
        },
        {
          id: "confession_push_in",
          trigger: {
            type: "relativeTime",
            actionId: "confession_hold",
            reference: RelativeTimeReference.End,
            offset: 0
          },
          movement: {
            act: CameraMovementType.DollyIn,
            targets: [{ id: "actor_face", description: "The actor's face" }],
            duration: 8.5,
            speedKeyframes: [
              { normalizedTime: 0, speedMultiplier: 0 },
              { normalizedTime: 0.15, speedMultiplier: 0.65, easing: SpeedFunction.Increase },
              { normalizedTime: 0.7, speedMultiplier: 0.9 },
              { normalizedTime: 1, speedMultiplier: 0.1, easing: SpeedFunction.Decrease }
            ],
            parameters: {
              distance: 3.7,
              path: "spline",
              curveIntensity: 2
            }
          },
          constraints: [{
            targets: [{ id: "actor_face", description: "The actor's face" }],
            config: {
              type: "subjectAware",
              shotSize: ShotSize.CloseUp,
              subjectView: SubjectView.ThreeQuarterFrontLeft,
              subjectFraming: { position: SubjectInFramePosition.Left }
            },
            allFrames: false,
            easing: { inDuration: 2, curve: "easeInOut" }
          }]
        },
        {
          id: "confession_arc_right",
          trigger: {
            type: "relativeTime",
            actionId: "confession_hold",
            reference: RelativeTimeReference.End,
            offset: 0
          },
          movement: {
            act: CameraMovementType.ArcRight,
            targets: [{ id: "actor_face", description: "The actor's face" }],
            duration: 8.5,
            speedKeyframes: [
              { normalizedTime: 0, speedMultiplier: 0 },
              { normalizedTime: 0.15, speedMultiplier: 0.8, easing: SpeedFunction.Increase },
              { normalizedTime: 0.85, speedMultiplier: 0.8 },
              { normalizedTime: 1, speedMultiplier: 0.1, easing: SpeedFunction.Decrease }
            ],
            parameters: {
              arcAngle: 38,
              path: "spline",
              curveIntensity: 1
            }
          }
        },
        {
          id: "last_breath_zoom",
          trigger: {
            type: "relativeTime",
            actionId: "confession_push_in",
            reference: RelativeTimeReference.End,
            offset: -2
          },
          movement: {
            act: CameraMovementType.ZoomIn,
            duration: 2,
            parameters: { zoomFactor: 1.18 }
          }
        }
      ]
    }]
  }
},
{
  id: "example-15",
  environmentId: "example-15-dancer-arc",
  prompt: "از نمای Low Medium Long شروع کن. چهار ثانیه اول با Arc Left آرام و اسلوموشن دور رقصنده بچرخ؛ روی ضرب موسیقی حرکت را به Arc Left سریع همراه Pedestal Up تبدیل کن و در دو ثانیه آخر با یک فرود نرم، رقصنده را روی یک‌سوم راست قاب نگه دار.",
  resolvedCsl: {
    totalDuration: 10,
    sections: [{
      initCamera: {
        targets: [{ id: "dancer", description: "The dancer" }],
        config: {
          type: "subjectAware",
          cameraAngle: CameraVerticalAngle.Low,
          shotSize: ShotSize.MediumLongShot,
          subjectView: SubjectView.Front,
          subjectFraming: { position: SubjectInFramePosition.Center }
        }
      },
      actions: [
        {
          id: "slow_arc_intro",
          trigger: { type: "absoluteTime", time: 0 },
          movement: {
            act: CameraMovementType.ArcLeft,
            targets: [{ id: "dancer", description: "The dancer" }],
            duration: 4,
            relativeFPS: RelativeFPS.Slow,
            speedKeyframes: [
              { normalizedTime: 0, speedMultiplier: 0.35 },
              { normalizedTime: 1, speedMultiplier: 0.75 }
            ],
            parameters: {
              arcAngle: 100,
              arcRadius: 5.2,
              path: "curved",
              curveIntensity: 2
            }
          },
          constraints: [
            {
              targets: [{ id: "dancer", description: "The dancer" }],
              config: {
                type: "subjectAware",
                cameraAngle: CameraVerticalAngle.Low,
                shotSize: ShotSize.MediumLongShot,
                subjectFraming: { position: SubjectInFramePosition.Center }
              },
              allFrames: true
            },
            {
              kind: "general",
              constraint: ConstraintType.NoShake,
              allFrames: true,
              weight: 2
            }
          ]
        },
        {
          id: "beat_arc_accelerate",
          trigger: {
            type: "relativeTime",
            actionId: "slow_arc_intro",
            reference: RelativeTimeReference.End,
            offset: 0
          },
          movement: {
            act: CameraMovementType.ArcLeft,
            targets: [{ id: "dancer", description: "The dancer" }],
            duration: 4,
            relativeFPS: RelativeFPS.Fast,
            speedKeyframes: [
              { normalizedTime: 0, speedMultiplier: 0.8 },
              { normalizedTime: 0.55, speedMultiplier: 2.2 },
              { normalizedTime: 1, speedMultiplier: 0.55 }
            ],
            parameters: {
              arcAngle: 150,
              arcRadius: 4.1,
              path: "spline",
              curveIntensity: 4
            }
          },
          constraints: [
            {
              targets: [{ id: "dancer", description: "The dancer" }],
              config: {
                type: "subjectAware",
                shotSize: ShotSize.MediumShot,
                subjectView: SubjectView.ThreeQuarterFrontRight,
                subjectFraming: { position: SubjectInFramePosition.Right }
              },
              allFrames: false,
              easing: { inDuration: 1.25, outDuration: 1, curve: "easeInOut" }
            },
            {
              kind: "general",
              constraint: ConstraintType.NoShake,
              allFrames: true,
              weight: 2
            }
          ]
        },
        {
          id: "beat_pedestal_rise",
          trigger: {
            type: "relativeTime",
            actionId: "beat_arc_accelerate",
            reference: RelativeTimeReference.Start,
            offset: 0
          },
          movement: {
            act: CameraMovementType.PedestalUp,
            duration: 4,
            parameters: { distance: 2.4 }
          }
        },
        {
          id: "hero_pose_settle",
          trigger: {
            type: "relativeTime",
            actionId: "beat_arc_accelerate",
            reference: RelativeTimeReference.End,
            offset: 0
          },
          movement: {
            act: CameraMovementType.PedestalDown,
            duration: 2,
            relativeFPS: RelativeFPS.Slow,
            speedKeyframes: [
              { normalizedTime: 0, speedMultiplier: 0 },
              { normalizedTime: 0.35, speedMultiplier: 0.7, easing: SpeedFunction.Increase },
              { normalizedTime: 1, speedMultiplier: 0, easing: SpeedFunction.Decrease }
            ],
            parameters: { distance: 1.1 }
          },
          constraints: [{
            targets: [{ id: "dancer", description: "The dancer" }],
            config: {
              type: "subjectAware",
              shotSize: ShotSize.MediumShot,
              subjectView: SubjectView.ThreeQuarterFrontRight,
              subjectFraming: { position: SubjectInFramePosition.Right }
            },
            allFrames: true
          }]
        }
      ]
    }]
  }
},
{
  id: "example-16",
  environmentId: "example-16-two-actor-truck",
  prompt: "در یک پلان بدون کات، هر دو مأمور را با Truck Right داخل یک Two Shot نگه دار. وقتی فاصله‌شان به کمتر از یک متر رسید، یک Zoom In کوتاه روی کیف بزن؛ بلافاصله با Arc Right سریع از خط نگاه عبور کن و همزمان Zoom Out کن تا در پایان جای دو بازیگر در قاب عوض شود: A راست و B چپ.",
  resolvedCsl: {
    totalDuration: 10,
    sections: [{
      initCamera: {
        targets: [
          { id: "actor_a", description: "Agent A" },
          { id: "actor_b", description: "Agent B" }
        ],
        config: {
          type: "subjectAware",
          shotSize: ShotSize.MediumLongShot,
          subjectFraming: { position: SubjectInFramePosition.Center }
        }
      },
      actions: [
        {
          id: "truck_right_exchange_setup",
          trigger: { type: "absoluteTime", time: 0 },
          movement: {
            act: CameraMovementType.TruckRight,
            duration: 5,
            parameters: {
              distance: 5,
              path: "linear"
            }
          },
          constraints: [
            {
              targets: [
                { id: "actor_a", description: "Agent A" },
                { id: "actor_b", description: "Agent B" }
              ],
              config: {
                type: "subjectAware",
                shotSize: ShotSize.MediumLongShot,
                subjectFraming: { position: SubjectInFramePosition.Center }
              },
              allFrames: true
            },
            {
              kind: "general",
              constraint: ConstraintType.NoShake,
              allFrames: true,
              weight: 2
            }
          ]
        },
        {
          id: "briefcase_punch_in",
          trigger: {
            type: "distance",
            object1: { id: "actor_a", description: "Agent A" },
            object2: { id: "actor_b", description: "Agent B" },
            operator: ComparisonOperator.LessThan,
            distance: 1
          },
          movement: {
            act: CameraMovementType.ZoomIn,
            duration: 1,
            parameters: { zoomFactor: 1.55 }
          },
          constraints: [{
            targets: [{ id: "briefcase", description: "The exchanged briefcase" }],
            config: {
              type: "subjectAware",
              subjectFraming: { position: SubjectInFramePosition.Center }
            },
            allFrames: false,
            easing: { inDuration: 0.4, outDuration: 0.25, curve: "easeInOut" }
          }]
        },
        {
          id: "axis_flip_arc_right",
          trigger: {
            type: "relativeTime",
            actionId: "briefcase_punch_in",
            reference: RelativeTimeReference.End,
            offset: 0
          },
          movement: {
            act: CameraMovementType.ArcRight,
            targets: [
              { id: "actor_a", description: "Agent A" },
              { id: "actor_b", description: "Agent B" }
            ],
            duration: 4,
            speedKeyframes: [
              { normalizedTime: 0, speedMultiplier: 0 },
              { normalizedTime: 0.15, speedMultiplier: 1.9, easing: SpeedFunction.Increase },
              { normalizedTime: 0.6, speedMultiplier: 1.15 },
              { normalizedTime: 1, speedMultiplier: 0.2, easing: SpeedFunction.Decrease }
            ],
            parameters: {
              arcAngle: 165,
              path: "spline",
              curveIntensity: 4
            }
          },
          constraints: [
            {
              targets: [
                { id: "actor_a", description: "Agent A" },
                { id: "actor_b", description: "Agent B" }
              ],
              config: {
                type: "subjectAware",
                shotSize: ShotSize.MediumLongShot,
                subjectFraming: { position: SubjectInFramePosition.Center }
              },
              allFrames: true
            },
            {
              kind: "general",
              constraint: ConstraintType.NoShake,
              allFrames: true,
              weight: 2
            }
          ]
        },
        {
          id: "exchange_zoom_out",
          trigger: {
            type: "relativeTime",
            actionId: "briefcase_punch_in",
            reference: RelativeTimeReference.End,
            offset: 0
          },
          movement: {
            act: CameraMovementType.ZoomOut,
            duration: 4,
            parameters: { zoomFactor: 1.55 }
          },
          constraints: [
            {
              targets: [{ id: "actor_a", description: "Agent A" }],
              config: {
                type: "subjectAware",
                subjectFraming: { position: SubjectInFramePosition.Right }
              },
              allFrames: false,
              easing: { inDuration: 1.5, curve: "easeOut" }
            },
            {
              targets: [{ id: "actor_b", description: "Agent B" }],
              config: {
                type: "subjectAware",
                subjectFraming: { position: SubjectInFramePosition.Left }
              },
              allFrames: false,
              easing: { inDuration: 1.5, curve: "easeOut" }
            }
          ]
        }
      ]
    }]
  }
},
{
  id: "example-17",
  environmentId: "example-17-runner-speed",
  prompt: "از Low Full Shot در کنار دونده با Track شروع کن و برای مسیرش lead room بده. لحظه‌ای که سرعتش به ۸ متر بر ثانیه رسید، صحنه را به ۱۰٪ ببر و با Arc Left صدوبیست درجه از کنار به روبه‌رویش برس. بعد سرعت عادی را برگردان، Dolly Out و Follow کن تا با فضای باز جلوی حرکت در قاب چپ تمام شود.",
  resolvedCsl: {
    totalDuration: 11,
    sections: [{
      initCamera: {
        targets: [{ id: "runner", description: "The runner" }],
        config: {
          type: "subjectAware",
          cameraAngle: CameraVerticalAngle.Low,
          shotSize: ShotSize.FullShot,
          subjectView: SubjectView.Right,
          subjectFraming: { position: SubjectInFramePosition.Left }
        }
      },
      actions: [
        {
          id: "side_track_acceleration",
          trigger: { type: "absoluteTime", time: 0 },
          movement: {
            act: CameraMovementType.Track,
            targets: [{ id: "runner", description: "The runner" }],
            duration: 3,
            parameters: {
              followDelay: 0.1,
              leadAmount: 0.55,
              path: "spline",
              curveIntensity: 1
            }
          },
          constraints: [
            {
              targets: [{ id: "runner", description: "The runner" }],
              config: {
                type: "subjectAware",
                cameraAngle: CameraVerticalAngle.Low,
                shotSize: ShotSize.FullShot,
                subjectView: SubjectView.Right,
                subjectFraming: { position: SubjectInFramePosition.Left }
              },
              allFrames: true
            },
            {
              kind: "general",
              constraint: ConstraintType.NoShake,
              allFrames: true,
              weight: 2
            }
          ]
        },
        {
          id: "bullet_time_arc",
          trigger: {
            type: "velocity",
            subject: { id: "runner", description: "The runner" },
            operator: ComparisonOperator.GreaterThanOrEqual,
            speed: 8
          },
          movement: {
            act: CameraMovementType.ArcLeft,
            targets: [{ id: "runner", description: "The runner" }],
            duration: 3,
            relativeFPS: RelativeFPS.VerySlow,
            speedKeyframes: [
              { normalizedTime: 0, speedMultiplier: 0 },
              { normalizedTime: 0.15, speedMultiplier: 1.5, easing: SpeedFunction.Increase },
              { normalizedTime: 0.6, speedMultiplier: 0.65 },
              { normalizedTime: 1, speedMultiplier: 0.2, easing: SpeedFunction.Decrease }
            ],
            parameters: {
              arcAngle: 120,
              arcRadius: 3.2,
              path: "spline",
              curveIntensity: 3
            }
          },
          constraints: [
            {
              targets: [{ id: "runner", description: "The runner" }],
              config: {
                type: "subjectAware",
                shotSize: ShotSize.MediumCloseUp,
                subjectView: SubjectView.ThreeQuarterFrontLeft,
                subjectFraming: { position: SubjectInFramePosition.Center }
              },
              allFrames: false,
              easing: { inDuration: 0.9, curve: "easeInOut" }
            },
            {
              kind: "general",
              constraint: ConstraintType.NoShake,
              allFrames: true,
              weight: 2
            }
          ]
        },
        {
          id: "release_follow",
          trigger: {
            type: "relativeTime",
            actionId: "bullet_time_arc",
            reference: RelativeTimeReference.End,
            offset: 0
          },
          movement: {
            act: CameraMovementType.Follow,
            targets: [{ id: "runner", description: "The runner" }],
            duration: 5,
            relativeFPS: RelativeFPS.Normal,
            speedKeyframes: [
              { normalizedTime: 0, speedMultiplier: 0.12 },
              { normalizedTime: 0.25, speedMultiplier: 1, easing: SpeedFunction.Increase },
              { normalizedTime: 1, speedMultiplier: 1 }
            ],
            parameters: {
              followDelay: 0.1,
              leadAmount: 0.1,
              path: "spline",
              curveIntensity: 2
            }
          },
          constraints: [
            {
              targets: [{ id: "runner", description: "The runner" }],
              config: {
                type: "subjectAware",
                subjectView: SubjectView.ThreeQuarterFrontLeft
              },
              allFrames: true
            },
            {
              kind: "general",
              constraint: ConstraintType.NoShake,
              allFrames: true,
              weight: 0.25
            }
          ]
        },
        {
          id: "release_dolly_out",
          trigger: {
            type: "relativeTime",
            actionId: "bullet_time_arc",
            reference: RelativeTimeReference.End,
            offset: 0
          },
          movement: {
            act: CameraMovementType.DollyOut,
            targets: [{ id: "runner", description: "The runner" }],
            duration: 5,
            speedKeyframes: [
              { normalizedTime: 0, speedMultiplier: 0 },
              { normalizedTime: 0.25, speedMultiplier: 1, easing: SpeedFunction.Increase },
              { normalizedTime: 1, speedMultiplier: 1 }
            ],
            parameters: {
              distance: 5,
              path: "linear"
            }
          },
          constraints: [{
            targets: [{ id: "runner", description: "The runner" }],
            config: {
              type: "subjectAware",
              shotSize: ShotSize.LongShot,
              subjectFraming: { position: SubjectInFramePosition.Left }
            },
            allFrames: false,
            easing: { inDuration: 2, curve: "easeOut" }
          }]
        }
      ]
    }]
  }
},
{
  id: "example-18",
  environmentId: "example-18-eye-zoom",
  prompt: "از Close Up دست لرزان شروع کن و در ۲.۵ ثانیه با Tilt Up به چشم برس. نیم‌ثانیه مکث کن؛ سپس Dolly In و Zoom In را همزمان اجرا کن تا وارد مردمک شوی. در یک‌ونیم ثانیه آخر ۱۰ درجه Dutch Right بده و ضرب پایانی را داخل مردمک فریز کن.",
  resolvedCsl: {
    totalDuration: 10,
    sections: [{
      initCamera: {
        targets: [{ id: "hand", description: "The subject's trembling hand" }],
        config: {
          type: "subjectAware",
          shotSize: ShotSize.CloseUp,
          subjectView: SubjectView.Front,
          subjectFraming: { position: SubjectInFramePosition.Bottom }
        }
      },
      actions: [
        {
          id: "tilt_hand_to_eye",
          trigger: { type: "absoluteTime", time: 0 },
          movement: {
            act: CameraMovementType.TiltUp,
            duration: 2.5,
            speedKeyframes: [
              { normalizedTime: 0, speedMultiplier: 0 },
              { normalizedTime: 0.2, speedMultiplier: 1, easing: SpeedFunction.Increase },
              { normalizedTime: 0.8, speedMultiplier: 1 },
              { normalizedTime: 1, speedMultiplier: 0, easing: SpeedFunction.Decrease }
            ],
            parameters: { rotationAngle: 58 }
          },
          constraints: [{
            targets: [{ id: "eye", description: "The subject's eye" }],
            config: {
              type: "subjectAware",
              shotSize: ShotSize.CloseUp,
              subjectFraming: { position: SubjectInFramePosition.Center }
            },
            allFrames: false,
            easing: { inDuration: 1, curve: "easeInOut" }
          }]
        },
        {
          id: "eye_breath_hold",
          trigger: {
            type: "relativeTime",
            actionId: "tilt_hand_to_eye",
            reference: RelativeTimeReference.End,
            offset: 0
          },
          movement: {
            act: CameraMovementType.Static,
            duration: 0.5
          },
          constraints: [{
            targets: [{ id: "eye", description: "The subject's eye" }],
            config: {
              type: "subjectAware",
              shotSize: ShotSize.CloseUp,
              subjectFraming: { position: SubjectInFramePosition.Center }
            },
            allFrames: true
          }]
        },
        {
          id: "pupil_dolly_in",
          trigger: {
            type: "relativeTime",
            actionId: "eye_breath_hold",
            reference: RelativeTimeReference.End,
            offset: 0
          },
          movement: {
            act: CameraMovementType.DollyIn,
            targets: [{ id: "pupil", description: "The subject's pupil" }],
            duration: 6,
            speedKeyframes: [
              { normalizedTime: 0, speedMultiplier: 0 },
              { normalizedTime: 0.15, speedMultiplier: 0.75, easing: SpeedFunction.Increase },
              { normalizedTime: 0.7, speedMultiplier: 1.35 },
              { normalizedTime: 1, speedMultiplier: 0.1, easing: SpeedFunction.Decrease }
            ],
            parameters: {
              distance: 0.5,
              path: "linear",
              allowSubjectIntersection: true
            }
          }
        },
        {
          id: "pupil_zoom_in",
          trigger: {
            type: "relativeTime",
            actionId: "eye_breath_hold",
            reference: RelativeTimeReference.End,
            offset: 0
          },
          movement: {
            act: CameraMovementType.ZoomIn,
            duration: 6,
            parameters: { zoomFactor: 3.2 }
          },
          constraints: [{
            targets: [{ id: "pupil", description: "The subject's pupil" }],
            config: {
              type: "subjectAware",
              shotSize: ShotSize.ExtremeCloseUp,
              subjectFraming: { position: SubjectInFramePosition.Center }
            },
            allFrames: false,
            easing: { inDuration: 2, curve: "easeInOut" }
          }]
        },
        {
          id: "pupil_dutch_right",
          trigger: {
            type: "relativeTime",
            actionId: "pupil_dolly_in",
            reference: RelativeTimeReference.End,
            offset: -1.5
          },
          movement: {
            act: CameraMovementType.DutchRight,
            duration: 1.5,
            parameters: { rotationAngle: 10 }
          }
        },
        {
          id: "frozen_inside_pupil",
          trigger: {
            type: "relativeTime",
            actionId: "pupil_dolly_in",
            reference: RelativeTimeReference.End,
            offset: 0
          },
          movement: {
            act: CameraMovementType.Static,
            duration: 1,
            relativeFPS: RelativeFPS.Frozen
          },
          constraints: [{
            targets: [{ id: "pupil", description: "The subject's pupil" }],
            config: {
              type: "subjectAware",
              shotSize: ShotSize.ExtremeCloseUp,
              subjectFraming: { position: SubjectInFramePosition.Center }
            },
            allFrames: true
          }]
        }
      ]
    }]
  }
},
{
  id: "example-19",
  environmentId: "example-19-stairwell-ambush",
  prompt: "از نمای Overhead روی کارآگاه شروع کن؛ همزمان Pedestal Down و Tilt Up کن تا در دو ثانیه هم‌سطح او شوی. بعد با Truck Left در راهرو همراهش برو. وقتی به انتهای مسیر رسید، یک Pan Left سریع بزن، Zoom Out کن و با Dutch Right مهاجم پشت ستون را آشکار کن؛ سپس با یک Counter Pan Right کوتاه هر دو را در قاب نهایی جمع کن.",
  resolvedCsl: {
    totalDuration: 10,
    sections: [{
      initCamera: {
        targets: [{ id: "detective", description: "The detective" }],
        config: {
          type: "subjectAware",
          cameraAngle: CameraVerticalAngle.Overhead,
          shotSize: ShotSize.LongShot,
          subjectFraming: { position: SubjectInFramePosition.Center }
        }
      },
      actions: [
        {
          id: "descent_pedestal_down",
          trigger: { type: "absoluteTime", time: 0 },
          movement: {
            act: CameraMovementType.PedestalDown,
            duration: 2,
            parameters: { distance: 7.45 }
          },
          constraints: [{
            targets: [{ id: "detective", description: "The detective" }],
            config: {
              type: "subjectAware",
              cameraAngle: CameraVerticalAngle.Eye,
              shotSize: ShotSize.FullShot,
              subjectFraming: { position: SubjectInFramePosition.Center }
            },
            allFrames: false,
            easing: { inDuration: 1, curve: "easeInOut" }
          }]
        },
        {
          id: "descent_tilt_up",
          trigger: { type: "absoluteTime", time: 0 },
          movement: {
            act: CameraMovementType.TiltUp,
            duration: 2,
            parameters: { rotationAngle: 42 }
          }
        },
        {
          id: "corridor_truck_left",
          trigger: {
            type: "relativeTime",
            actionId: "descent_pedestal_down",
            reference: RelativeTimeReference.End,
            offset: 0
          },
          movement: {
            act: CameraMovementType.TruckLeft,
            duration: 5,
            parameters: {
              distance: 7,
              path: "linear"
            }
          },
          constraints: [{
            targets: [{ id: "detective", description: "The detective" }],
              config: {
                type: "subjectAware",
                shotSize: ShotSize.MediumLongShot,
                subjectFraming: { position: SubjectInFramePosition.Left }
              },
              allFrames: true
            },
            {
              kind: "general",
              constraint: ConstraintType.NoShake,
              allFrames: true,
              weight: 2
            }
          ]
        },
        {
          id: "ambush_pan_left",
          trigger: {
            type: "relativeTime",
            actionId: "corridor_truck_left",
            reference: RelativeTimeReference.End,
            offset: 0
          },
          movement: {
            act: CameraMovementType.PanLeft,
            duration: 1.2,
            parameters: { rotationAngle: 68 }
          },
          constraints: [{
              targets: [{ id: "pursuer", description: "The hidden pursuer" }],
              config: {
                type: "subjectAware",
                shotSize: ShotSize.LongShot,
              subjectFraming: { position: SubjectInFramePosition.Right }
            },
            allFrames: false,
            easing: { inDuration: 0.35, outDuration: 0.4, curve: "easeOut" }
          }]
        },
        {
          id: "ambush_counter_pan_right",
          trigger: {
            type: "relativeTime",
            actionId: "ambush_pan_left",
            reference: RelativeTimeReference.End,
            offset: 0
          },
          movement: {
            act: CameraMovementType.PanRight,
            duration: 1.8,
            parameters: { rotationAngle: 36 }
          },
          constraints: [{
            targets: [
              { id: "detective", description: "The detective" },
              { id: "pursuer", description: "The hidden pursuer" }
            ],
            config: {
              type: "subjectAware",
              shotSize: ShotSize.LongShot,
              subjectFraming: { position: SubjectInFramePosition.Center }
            },
            allFrames: false,
            easing: { inDuration: 1, curve: "easeOut" }
          }]
        },
        {
          id: "ambush_zoom_out",
          trigger: {
            type: "relativeTime",
            actionId: "corridor_truck_left",
            reference: RelativeTimeReference.End,
            offset: 0
          },
          movement: {
            act: CameraMovementType.ZoomOut,
            duration: 3,
            parameters: { zoomFactor: 1.55 }
          },
          constraints: [{
            targets: [
              { id: "detective", description: "The detective" },
              { id: "pursuer", description: "The hidden pursuer" }
            ],
            config: {
              type: "subjectAware",
              shotSize: ShotSize.LongShot,
              subjectFraming: { position: SubjectInFramePosition.Center }
            },
            allFrames: false,
            easing: { inDuration: 1.5, curve: "easeOut" }
          }]
        },
        {
          id: "ambush_dutch_right",
          trigger: {
            type: "relativeTime",
            actionId: "corridor_truck_left",
            reference: RelativeTimeReference.End,
            offset: 0
          },
          movement: {
            act: CameraMovementType.DutchRight,
            duration: 3,
            parameters: { rotationAngle: 14 }
          }
        }
      ]
    }]
  }
},
{
  id: "example-20",
  environmentId: "example-20-jogger-reveal",
  prompt:
    "Follow the jogger along the path, keeping the tree from blocking the shot, then crane up to reveal the fountain plaza as they arrive, and hold on them from a locked distance and angle.",
  resolvedCsl: {
    totalDuration: 10,
      sections: [
    {
      initCamera: {
        targets: [{
                    id: "jogger",
                    description: "The jogger"
                  }],
        config: {
          type: "subjectAware",
          shotSize: ShotSize.MediumShot,
          subjectView: SubjectView.ThreeQuarterFrontRight,
          subjectFraming: { position: SubjectInFramePosition.Right },
        },
      },
      actions: [
        {
          id: "follow_jogger",
          trigger: { type: "absoluteTime", time: 0 },
          movement: {
            act: CameraMovementType.Follow,
            targets: [{
                    id: "jogger",
                    description: "The jogger"
                  }],
            duration: 4,
            parameters: { followDelay: 0.3, leadAmount: 0 },
          },
          constraints: [
            {
              targets: [{
                    id: "jogger",
                    description: "The jogger"
                  }],
              config: {
                type: "subjectAware",
                shotSize: ShotSize.MediumShot,
                subjectFraming: { position: SubjectInFramePosition.Right },
              },
              allFrames: true,
            },
          ],
        },
        {
          id: "crane_reveal",
          trigger: { type: "relativeTime", actionId: "follow_jogger", reference: RelativeTimeReference.End, offset: 0 },
          movement: {
            act: CameraMovementType.CraneUp,
            targets: [{
                    id: "jogger",
                    description: "The jogger"
                  },
                  {
                    id: "fountain",
                    description: "Plaza fountain"
                  }
                ],
            duration: 3,
            parameters: { heightChange: 2.5, horizontalDistance: 1.5 },
          },

        },
        {
          id: "held_finish",
          trigger: { type: "relativeTime", actionId: "crane_reveal", reference: RelativeTimeReference.End, offset: 0 },
          movement: { act: CameraMovementType.Static, duration: 3 },
         
        },
      ],
    },
  ],
  }
},
{
  id: "example-21",
  environmentId: "example-21-rooftop-chase",
  prompt:
    "Track the runner across the rooftop until the pursuer gets within 2.5 meters, then arc around the runner to reveal the pursuer while zooming in, and finish with a stabilized locked shot maintaining the same angle and keeping both of them visible.",
  resolvedCsl: {
    totalDuration: 10,
    sections: [
      {
        initCamera: {
          targets: [
            {
              id: "runner",
              description: "The runner",
            },
          ],
          config: {
            type: "subjectAware",
            shotSize: ShotSize.MediumShot,
            subjectView: SubjectView.ThreeQuarterFrontLeft,
            subjectFraming: {
              position: SubjectInFramePosition.Left,
            },
          },
        },

        actions: [
          {
            id: "track_runner",
            trigger: {
              type: "absoluteTime",
              time: 0,
            },
            movement: {
              act: CameraMovementType.Track,
              targets: [
                {
                  id: "runner",
                  description: "The runner",
                },
              ],
              parameters: {
                followDelay: 0,
                leadAmount: 0.2,
              },
            },
            constraints: [
              {
                targets: [
                  {
                    id: "runner",
                    description: "The runner",
                  },
                ],
                config: {
                  type: "subjectAware",
                  shotSize: ShotSize.MediumShot,
                  subjectFraming: {
                    position: SubjectInFramePosition.Left,
                  },
                },
                allFrames: true,
              },
            ],
          },

          {
            id: "pursuer_closes_in",
            trigger: {
              type: "distance",
              object1: {
                id: "pursuer",
                description: "The pursuer",
              },
              object2: {
                id: "runner",
                description: "The runner",
              },
              operator: ComparisonOperator.LessThanOrEqual,
              distance: 3.5,
            },
            movement: {
              act: CameraMovementType.ArcRight,
              targets: [
                {
                  id: "runner",
                  description: "The runner",
                },
              ],
              duration: 1.5,
              parameters: {
                arcAngle: 110,
                arcRadius: 3.5,
              },
            },
            constraints: [
              {
                kind: "general",
                constraint: ConstraintType.AvoidOcclusion,
                targets: [
                  {
                    id: "runner",
                    description: "The runner",
                  },
                  {
                    id: "pursuer",
                    description: "The pursuer",
                  },
                ],
                allFrames: true,
              },
              {
                targets: [
                  {
                    id: "runner",
                    description: "The runner",
                  },
                  {
                    id: "pursuer",
                    description: "The pursuer",
                  },
                ],
                config: {
                  type: "subjectAware",
                  shotSize: ShotSize.MediumLongShot,
                  subjectFraming: {
                    position: SubjectInFramePosition.Center,
                  },
                },
                allFrames: false,
                easing: {
                  inDuration: 0.6,
                  curve: "easeOut",
                },
              },
            ],
          },

          {
            id: "zoom_on_pursuer",
            trigger: {
              type: "relativeTime",
              actionId: "pursuer_closes_in",
              reference: RelativeTimeReference.Start,
              offset: 0,
            },
            movement: {
              act: CameraMovementType.ZoomIn,
              duration: 1.5,
              parameters: {
                zoomFactor: 1.4,
              },
            },
          },

          {
            id: "tense_hold",
            trigger: {
              type: "relativeTime",
              actionId: "pursuer_closes_in",
              reference: RelativeTimeReference.End,
              offset: 0,
            },
            movement: {
              act: CameraMovementType.Follow,
              targets:[ {
                id: "pursuer",
                description: "The pursuer",
              },]
            },
           
          },
        ],
      },
    ],
  },
},
{
  id: "example-22",
  environmentId: "example-22-warehouse-onetake",
  prompt:
    "Follow the worker past the shelving, arc-and-dolly in as they slow at the crates, arc up around them as they climb to the mezzanine, follow them back down toward the loading bay, pull back to reveal the coworker once close, orbit both with a dutch tilt, crane up and zoom out over the whole floor, then lock a final stabilized hold.",
  resolvedCsl: {
    totalDuration: 22,
    sections: [
      {
        initCamera: {
          targets: [
            {
              id: "worker",
              description: "The worker",
            },
          ],
          config: {
            type: "subjectAware",
            cameraAngle: CameraVerticalAngle.High,
            shotSize: ShotSize.MediumShot,
            subjectView: SubjectView.ThreeQuarterFrontRight,
            subjectFraming: {
              position: SubjectInFramePosition.Right,
            },
          },
        },

        actions: [
          {
            id: "follow_worker",
            trigger: {
              type: "absoluteTime",
              time: 0,
            },
            movement: {
              act: CameraMovementType.Follow,
              targets: [
                {
                  id: "worker",
                  description: "The worker",
                },
              ],
              parameters: {
                followDelay: 0.2,
                leadAmount: 0,
              },
            },
            constraints: [
              {
                targets: [
                  {
                    id: "worker",
                    description: "The worker",
                  },
                ],
                config: {
                  type: "subjectAware",
                  cameraAngle: CameraVerticalAngle.High,
                  shotSize: ShotSize.MediumLongShot,
                  subjectView: SubjectView.ThreeQuarterFrontRight,
                  subjectFraming: {
                    position: SubjectInFramePosition.Right,
                  },
                },
                allFrames: true,
              },
              {
                kind: "general",
                constraint: ConstraintType.NoShake,
                allFrames: true,
              },
            ],
          },

          {
             id: "arc_dolly_crates",
              trigger: {
                type: "velocity",
                subject: {
                  id: "worker",
                  description: "The worker",
                },
                operator: ComparisonOperator.GreaterThanOrEqual,
                speed: 2.5,
              },
            movement: {
              act: CameraMovementType.ArcLeft,
              targets: [
                {
                  id: "worker",
                  description: "The worker",
                },
              ],
              duration: 2,
              parameters: {
                arcAngle: 70,
                arcRadius: 2.2,
              },
            },
            constraints: [
              {
                targets: [
                  {
                    id: "worker",
                    description: "The worker",
                  },
                ],
                config: {
                  type: "subjectAware",
                  shotSize: ShotSize.MediumCloseUp,
                  subjectView: SubjectView.Front,
                  subjectFraming: {
                    position: SubjectInFramePosition.Center,
                  },
                },
                allFrames: true,

              },
            ],
          },

          {
            id: "dolly_in_crates",
            trigger: {
              type: "relativeTime",
              actionId: "arc_dolly_crates",
              reference: RelativeTimeReference.Start,
              offset: 0,
            },
            movement: {
              act: CameraMovementType.DollyIn,
              targets: [
                {
                  id: "worker",
                  description: "The worker",
                },
              ],
              duration: 2,
              parameters: {
                distance: 1.4,
              },
            },
          },

          {
            id: "climb_mezzanine",
            trigger: {
              type: "relativeTime",
              actionId: "arc_dolly_crates",
              reference: RelativeTimeReference.End,
              offset: 0,
            },
            movement: {
              act: CameraMovementType.ArcRight,
              targets: [
                {
                  id: "worker",
                  description: "The worker",
                },
              ],
              duration: 2.5,
              parameters: {
                arcAngle: 90,
                arcRadius: 3.0,
              },
            },
          },

          {
            id: "pedestal_up_mezzanine",
            trigger: {
              type: "relativeTime",
              actionId: "climb_mezzanine",
              reference: RelativeTimeReference.Start,
              offset: 0,
            },
            movement: {
              act: CameraMovementType.PedestalUp,
              duration: 2.5,
              parameters: {
                distance: 2.2,
              },
            },
          },

          {
            id: "descend_to_bay",
            trigger: {
              type: "relativeTime",
              actionId: "climb_mezzanine",
              reference: RelativeTimeReference.End,
              offset: 0,
            },
            movement: {
              act: CameraMovementType.Follow,
              targets: [
                {
                  id: "worker",
                  description: "The worker",
                },
              ],
              parameters: {
                followDelay: 0,
                leadAmount: 0,
              },
            },
          },

          {
            id: "pedestal_down_bay",
            trigger: {
              type: "relativeTime",
              actionId: "descend_to_bay",
              reference: RelativeTimeReference.Start,
              offset: 0,
            },
            movement: {
              act: CameraMovementType.PedestalDown,
              parameters: {
                distance: 2.2,
              },
            },
          },

          {
            id: "reveal_both",
            trigger: {
              type: "distance",
              object1: {
                id: "worker",
                description: "The worker",
              },
              object2: {
                id: "coworker",
                description: "The coworker",
              },
              operator: ComparisonOperator.LessThanOrEqual,
              distance: 2.0,
            },
            movement: {
              act: CameraMovementType.Follow,
              targets: [
                {
                  id: "worker",
                  description: "The worker",
                },
              ],
              duration: 1.8,
              parameters: {
                followDelay: 0,
                leadAmount: 0,
              },
            },
            constraints: [
              {
                targets: [
                  {
                    id: "worker",
                    description: "The worker",
                  },
                  {
                    id: "coworker",
                    description: "The coworker",
                  },
                ],
                config: {
                  type: "subjectAware",
                  shotSize: ShotSize.MediumLongShot,
                  subjectFraming: {
                    position: SubjectInFramePosition.Center,
                  },
                },
                allFrames: false,
                easing: {
                  inDuration: 0.8,
                  curve: "easeOut",
                },
              },
            ],
          },

          {
            id: "dolly_out_reveal",
            trigger: {
              type: "relativeTime",
              actionId: "reveal_both",
              reference: RelativeTimeReference.Start,
              offset: 0,
            },
            movement: {
              act: CameraMovementType.DollyOut,
              targets: [
                {
                  id: "worker",
                  description: "The worker",
                },
              ],
              duration: 1.8,
              parameters: {
                distance: 2.0,
              },
            },
          },

          {
            id: "orbit_both",
            trigger: {
              type: "relativeTime",
              actionId: "reveal_both",
              reference: RelativeTimeReference.End,
              offset: 0,
            },
            movement: {
              act: CameraMovementType.Track,
              targets: [
                {
                  id: "worker",
                  description: "The worker",
                },
                {
                  id: "coworker",
                  description: "The coworker",
                },
              ],
              duration: 2.5,
              parameters: {
                followDelay: 0,
                leadAmount: 0.1,
              },
            },
            
          },

          {
            id: "dutch_tension",
            trigger: {
              type: "relativeTime",
              actionId: "orbit_both",
              reference: RelativeTimeReference.Start,
              offset: 0,
            },
            movement: {
              act: CameraMovementType.DutchRight,
              duration: 2.5,
              parameters: {
                rotationAngle: 12,
              },
            },
          },

          {
            id: "crane_reveal",
            trigger: {
              type: "relativeTime",
              actionId: "orbit_both",
              reference: RelativeTimeReference.End,
              offset: 0,
            },
            movement: {
              act: CameraMovementType.CraneUp,
              targets: [
                {
                  id: "worker",
                  description: "The worker",
                },
                {
                  id: "coworker",
                  description: "The coworker",
                },
              ],
              duration: 2.5,
              parameters: {
                heightChange: 3.0,
                horizontalDistance: 1.0,
              },
            },
            constraints: [
              {
                targets: [
                  {
                    id: "worker",
                    description: "The worker",
                  },
                  {
                    id: "coworker",
                    description: "The coworker",
                  },
                ],
                config: {
                  type: "subjectAware",
                  shotSize: ShotSize.FullShot,
                  subjectFraming: {
                    position: SubjectInFramePosition.Center,
                  },
                },
                allFrames: false,
                easing: {
                  inDuration: 1.5,
                  curve: "easeInOut",
                },
              },
            ],
          },

          {
            id: "zoom_out_reveal",
            trigger: {
              type: "relativeTime",
              actionId: "crane_reveal",
              reference: RelativeTimeReference.Start,
              offset: 0,
            },
            movement: {
              act: CameraMovementType.ZoomOut,
              duration: 2.5,
              parameters: {
                zoomFactor: 1.6,
              },
              speedKeyframes: [
                {
                  normalizedTime: 0,
                  speedMultiplier: 0.4,
                },
                {
                  normalizedTime: 0.6,
                  speedMultiplier: 1.3,
                },
                {
                  normalizedTime: 1,
                  speedMultiplier: 0.4,
                },
              ],
            },
          },

          {
            id: "finale_hold",
            trigger: {
              type: "relativeTime",
              actionId: "crane_reveal",
              reference: RelativeTimeReference.End,
              offset: 0,
            },
            movement: {
              act: CameraMovementType.Static,
              targets: [
                {
                  id: "worker",
                  description: "The worker",
                },
                {
                  id: "coworker",
                  description: "The coworker",
                },
              ],
              relativeFPS: RelativeFPS.Frozen,
            },
            constraints: [
              {
                kind: "general",
                constraint: ConstraintType.NoShake,
                allFrames: true,
              },
            ],
          },
        ],
      },
    ],
  },
},
{
  id: "example-23",
  environmentId: "example-23-factory-convergence",
  prompt: "Film one continuous 20-second shot inside a busy factory. Start by following Worker A as he moves from the east side of the production floor toward the center, keeping him in a medium-long shot. Push closer, pan and tilt with his movement, then truck and pedestal as he changes direction. When he slows down near the central machinery, arc around him while gradually zooming in so that Worker B is revealed approaching from the opposite side. As the two workers converge, widen the shot and track both of them together while keeping them visible, maintaining a consistent distance and angle and avoiding the machinery and the passing forklift. When Worker B accelerates toward the loading bay, pan with him, move laterally across the floor, lower the camera, arc around him, correct the Dutch angle, and then pull back to reveal both workers, the mezzanine, the forklift, and the loading area. Finish by orbiting around the two workers, hold them both in frame in a stable wide composition, and end on a frozen locked-off shot. Throughout the take, keep the camera smooth, avoid occlusion, respect the ground level, and make each transition feel like a deliberate continuous cinematographic move rather than a cut.",
  resolvedCsl: {
    totalDuration: 20,
    sections: [
      {
        initCamera: {
          targets: [
            {
              id: "worker_a",
              description: "Worker A target",
            },
          ],
          config: {
            type: "subjectAware",
            cameraAngle: CameraVerticalAngle.Eye,
            shotSize: ShotSize.MediumLongShot,
            subjectView: SubjectView.Front,
            subjectFraming: {
              position: SubjectInFramePosition.Center,
            },
          },
        },
        actions: [
          {
            id: "follow_worker_a_center",
            trigger: {
              type: "absoluteTime",
              time: 0,
            },
            movement: {
              act: CameraMovementType.Follow,
              targets: [
                {
                  id: "worker_a",
                  description: "Worker A target",
                },
              ],
              parameters: {
                followDelay: 0.1,
                leadAmount: 0.2,
              },
            },
            constraints: [
              {
                kind: "general",
                constraint: ConstraintType.NoShake,
                allFrames: true,
              },
              {
                kind: "general",
                constraint: ConstraintType.GroundLevel,
                allFrames: true,
              },
            ],
          },
          {
            id: "push_closer_truck_pedestal",
            trigger: {
              type: "relativeTime",
              actionId: "follow_worker_a_center",
              reference: RelativeTimeReference.End,
              offset: 0,
            },
            movement: {
              act: CameraMovementType.DollyIn,
              targets: [
                {
                  id: "worker_a",
                  description: "Worker A target",
                },
              ],
              parameters: {
                distance: 2.0,
                path: "curved",
              },
            },
          },
          {
            id: "arc_zoom_near_machine",
            trigger: {
              type: "velocity",
              subject: {
                id: "worker_a",
                description: "Worker A target",
              },
              operator: ComparisonOperator.GreaterThan,
              speed: 0.8,
            },
            movement: {
              act: CameraMovementType.ArcRight,
              targets: [
                {
                  id: "worker_a",
                  description: "Worker A target",
                },
                {
                  id: "central_machine",
                  description: "Central machine target",
                },
              ],
              parameters: {
                arcAngle: 120,
                arcRadius: 2.5,
              },
            },
          },
          {
            id: "zoom_in_reveal_worker_b",
            trigger: {
              type: "relativeTime",
              actionId: "arc_zoom_near_machine",
              reference: RelativeTimeReference.Start,
              offset: 0.5,
            },
            movement: {
              act: CameraMovementType.ZoomIn,
              parameters: {
                zoomFactor: 1.5,
              },
            },
          },
          {
            id: "converge_track_both",
            trigger: {
              type: "distance",
              object1: {
                id: "worker_a",
                description: "Worker A target",
              },
              object2: {
                id: "worker_b",
                description: "Worker B target",
              },
              operator: ComparisonOperator.LessThanOrEqual,
              distance: 3.0,
            },
            movement: {
              act: CameraMovementType.Track,
              targets: [
                {
                  id: "worker_a",
                  description: "Worker A target",
                },
                {
                  id: "worker_b",
                  description: "Worker B target",
                },
              ],
              parameters: {
                followDelay: 0,
                leadAmount: 0.1,
              },
            },
            constraints: [
              {
                kind: "general",
                constraint: ConstraintType.KeepInFrame,
                targets: [
                  {
                    id: "worker_a",
                    description: "Worker A target",
                  },
                  {
                    id: "worker_b",
                    description: "Worker B target",
                  },
                ],
                allFrames: true,
              },
              {
                kind: "general",
                constraint: ConstraintType.AvoidOcclusion,
                allFrames: true,
                                targets: [
                  {
                    id: "worker_a",
                    description: "Worker A target",
                  },
                  {
                    id: "worker_b",
                    description: "Worker B target",
                  },
                ],
              },
            ],
          },
          {
            id: "worker_b_accelerates_pan_truck",
            trigger: {
              type: "velocity",
              subject: {
                id: "worker_b",
                description: "Worker B target",
              },
              operator: ComparisonOperator.GreaterThanOrEqual,
              speed: 1.8,
            },
            movement: {
              act: CameraMovementType.TruckRight,
              parameters: {
                distance: 3.0,
              },
            },
          },
          {
            id: "lower_and_arc_worker_b",
            trigger: {
              type: "relativeTime",
              actionId: "worker_b_accelerates_pan_truck",
              reference: RelativeTimeReference.End,
              offset: 0,
            },
            movement: {
              act: CameraMovementType.PedestalDown,
              parameters: {
                heightChange: 1.2,
              },
            },
          },
          {
            id: "pull_back_reveal_all",
            trigger: {
              type: "relativeTime",
              actionId: "lower_and_arc_worker_b",
              reference: RelativeTimeReference.End,
              offset: 0,
            },
            movement: {
              act: CameraMovementType.DollyOut,
              targets: [
                {
                  id: "worker_a",
                  description: "Worker A target",
                },
                {
                  id: "worker_b",
                  description: "Worker B target",
                },
              ],
              parameters: {
                distance: 5.0,
              },
            },
          },
          {
            id: "orbit_both_workers",
            trigger: {
              type: "relativeTime",
              actionId: "pull_back_reveal_all",
              reference: RelativeTimeReference.End,
              offset: 0,
            },
            movement: {
              act: CameraMovementType.Orbit,
              targets: [
                {
                  id: "worker_a",
                  description: "Worker A target",
                },
                {
                  id: "worker_b",
                  description: "Worker B target",
                },
              ],
              parameters: {
                arcAngle: 360,
                arcRadius: 6.0,
              },
            },
            constraints: [
              {
                targets: [
                  {
                    id: "worker_a",
                    description: "Worker A target",
                  },
                  {
                    id: "worker_b",
                    description: "Worker B target",
                  },
                ],
                config: {
                  type: "subjectAware",
                  cameraAngle: CameraVerticalAngle.Eye,
                  shotSize: ShotSize.LongShot,
                  subjectView: SubjectView.Front,
                  subjectFraming: {
                    position: SubjectInFramePosition.Center,
                  },
                },
                allFrames: false,
                easing: { inDuration: 1.5, curve: "easeOut" }
              },
            ],
          },
          {
            id: "locked_off_freeze",
            trigger: {
              type: "relativeTime",
              actionId: "orbit_both_workers",
              reference: RelativeTimeReference.End,
              offset: 0,
            },
            movement: {
              act: CameraMovementType.Static,
              targets: [
                {
                  id: "worker_a",
                  description: "Worker A target",
                },
                {
                  id: "worker_b",
                  description: "Worker B target",
                },
              ],
              relativeFPS: RelativeFPS.Frozen,
            },
          },
        ],
      },
    ],
  },
}
]
