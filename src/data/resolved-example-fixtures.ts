import type { ResolvedCameraDirectionDSL } from "../types/dsl";
import { ShotSize, SubjectView, SubjectInFramePosition, CameraMovementType, ComparisonOperator, RelativeTimeReference, CameraVerticalAngle, RelativeFPS } from "../types/enums";

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
              act: CameraMovementType.Follow,
              targets: [{ id: "ball", description: "The ball" }]
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
              targets: [{ id: "vase", description: "The vase (گلدون)" }]
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
              relativeFPS: RelativeFPS.Normal
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
              targets: [{ id: "subject_eyes", description: "The subject's eyes (چشم‌های سوژه)" }]
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
              act: CameraMovementType.Follow,
              targets: [{ id: "fist", description: "The fist (مشت)" }],
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
              targets: [{ id: "race_car", description: "The racing car (ماشین مسابقه)" }]
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
              targets: [{ id: "half_open_door", description: "The half-open door (در نیمه‌باز)" }]
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
              targets: [{ id: "car", description: "The car (ماشین)" }],
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
              targets: [{ id: "car", description: "The car (ماشین)" }],
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
              duration: 5
            }
          },
          {
            id: "handheld_dolly_in",
            trigger: {
              type: "absoluteTime",
              time: 2
            },
            movement: {
              act: CameraMovementType.DollyIn,
              targets: [{ id: "half_open_door", description: "The half-open door (در نیمه‌باز)" }],
              duration: 5
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
              { normalizedTime: 0, speedMultiplier: 0.35 },
              { normalizedTime: 0.65, speedMultiplier: 0.9 },
              { normalizedTime: 1, speedMultiplier: 0.45 }
            ],
            parameters: {
              distance: 3.6,
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
            parameters: {
              arcAngle: 38,
              arcRadius: 3.8,
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
          constraints: [{
            targets: [{ id: "dancer", description: "The dancer" }],
            config: {
              type: "subjectAware",
              cameraAngle: CameraVerticalAngle.Low,
              shotSize: ShotSize.MediumLongShot,
              subjectFraming: { position: SubjectInFramePosition.Center }
            },
            allFrames: true
          }]
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
          constraints: [{
            targets: [{ id: "dancer", description: "The dancer" }],
            config: {
              type: "subjectAware",
              shotSize: ShotSize.MediumShot,
              subjectView: SubjectView.ThreeQuarterFrontRight,
              subjectFraming: { position: SubjectInFramePosition.Right }
            },
            allFrames: false,
            easing: { inDuration: 1.25, outDuration: 1, curve: "easeInOut" }
          }]
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
            act: CameraMovementType.Static,
            duration: 2,
            relativeFPS: RelativeFPS.Slow
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
          subjectView: SubjectView.Front,
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
              path: "spline",
              curveIntensity: 1
            }
          },
          constraints: [{
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
          }]
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
              shotSize: ShotSize.CloseUp,
              subjectFraming: { position: SubjectInFramePosition.Center }
            },
            allFrames: false,
            easing: { inDuration: 0.4, outDuration: 0.25, curve: "easeInOut" }
          }]
        },
        {
          id: "axis_flip_arc_right",
          trigger: {
            type: "distance",
            object1: { id: "actor_a", description: "Agent A" },
            object2: { id: "actor_b", description: "Agent B" },
            operator: ComparisonOperator.LessThan,
            distance: 1
          },
          movement: {
            act: CameraMovementType.ArcRight,
            targets: [
              { id: "actor_a", description: "Agent A" },
              { id: "actor_b", description: "Agent B" }
            ],
            duration: 5,
            speedKeyframes: [
              { normalizedTime: 0, speedMultiplier: 1.9 },
              { normalizedTime: 0.45, speedMultiplier: 1.25 },
              { normalizedTime: 1, speedMultiplier: 0.45 }
            ],
            parameters: {
              arcAngle: 165,
              arcRadius: 4.2,
              path: "spline",
              curveIntensity: 4
            }
          },
          constraints: [{
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
          }]
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
            parameters: { zoomFactor: 1.45 }
          },
          constraints: [
            {
              targets: [{ id: "actor_a", description: "Agent A" }],
              config: {
                type: "subjectAware",
                shotSize: ShotSize.MediumShot,
                subjectFraming: { position: SubjectInFramePosition.Right }
              },
              allFrames: false,
              easing: { inDuration: 1.5, curve: "easeOut" }
            },
            {
              targets: [{ id: "actor_b", description: "Agent B" }],
              config: {
                type: "subjectAware",
                shotSize: ShotSize.MediumShot,
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
          constraints: [{
            targets: [{ id: "runner", description: "The runner" }],
            config: {
              type: "subjectAware",
              cameraAngle: CameraVerticalAngle.Low,
              shotSize: ShotSize.FullShot,
              subjectView: SubjectView.Right,
              subjectFraming: { position: SubjectInFramePosition.Left }
            },
            allFrames: true
          }]
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
              { normalizedTime: 0, speedMultiplier: 1.5 },
              { normalizedTime: 0.6, speedMultiplier: 0.65 },
              { normalizedTime: 1, speedMultiplier: 0.35 }
            ],
            parameters: {
              arcAngle: 120,
              arcRadius: 3.2,
              path: "spline",
              curveIntensity: 3
            }
          },
          constraints: [{
            targets: [{ id: "runner", description: "The runner" }],
            config: {
              type: "subjectAware",
              shotSize: ShotSize.MediumCloseUp,
              subjectView: SubjectView.ThreeQuarterFrontRight,
              subjectFraming: { position: SubjectInFramePosition.Center }
            },
            allFrames: true
          }]
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
            parameters: {
              followDelay: 0.15,
              leadAmount: 0.65,
              path: "spline",
              curveIntensity: 2
            }
          },
          constraints: [{
            targets: [{ id: "runner", description: "The runner" }],
            config: {
              type: "subjectAware",
              shotSize: ShotSize.MediumLongShot,
              subjectView: SubjectView.ThreeQuarterFrontRight,
              subjectFraming: { position: SubjectInFramePosition.Left }
            },
            allFrames: true
          }]
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
            parameters: {
              distance: 5,
              path: "spline",
              curveIntensity: 2
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
            parameters: { rotationAngle: 28 }
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
              { normalizedTime: 0, speedMultiplier: 0.45 },
              { normalizedTime: 0.7, speedMultiplier: 1.35 },
              { normalizedTime: 1, speedMultiplier: 0.35 }
            ],
            parameters: {
              distance: 3.8,
              path: "spline",
              curveIntensity: 2
            }
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
  prompt: "از نمای Overhead روی کارآگاه شروع کن؛ همزمان Pedestal Down و Tilt Down کن تا در دو ثانیه هم‌سطح او شوی. بعد با Truck Left در راهرو همراهش برو. وقتی به انتهای مسیر رسید، یک Pan Left سریع بزن، Zoom Out کن و با Dutch Right مهاجم پشت ستون را آشکار کن؛ سپس با یک Counter Pan Right کوتاه هر دو را در قاب نهایی جمع کن.",
  resolvedCsl: {
    totalDuration: 10,
    sections: [{
      initCamera: {
        targets: [{ id: "detective", description: "The detective" }],
        config: {
          type: "subjectAware",
          cameraAngle: CameraVerticalAngle.Overhead,
          shotSize: ShotSize.LongShot,
          subjectView: SubjectView.ThreeQuarterFrontLeft,
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
            parameters: { distance: 3.8 }
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
          id: "descent_tilt_down",
          trigger: { type: "absoluteTime", time: 0 },
          movement: {
            act: CameraMovementType.TiltDown,
            duration: 2,
            parameters: { rotationAngle: 45 }
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
              path: "spline",
              curveIntensity: 2
            }
          },
          constraints: [{
            targets: [{ id: "detective", description: "The detective" }],
            config: {
              type: "subjectAware",
              shotSize: ShotSize.MediumLongShot,
              subjectView: SubjectView.ThreeQuarterFrontLeft,
              subjectFraming: { position: SubjectInFramePosition.Left }
            },
            allFrames: true
          }]
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
            parameters: { rotationAngle: 75 }
          },
          constraints: [{
            targets: [{ id: "pursuer", description: "The hidden pursuer" }],
            config: {
              type: "subjectAware",
              shotSize: ShotSize.MediumShot,
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
            parameters: { rotationAngle: 30 }
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
}

]
