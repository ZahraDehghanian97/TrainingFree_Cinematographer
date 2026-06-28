import { CameraDirectionDSL } from "../types/dsl";
import { ShotSize, SubjectView, SubjectInFramePosition, CameraMovementType, ComparisonOperator, RelativeTimeReference, CameraVerticalAngle, RelativeFPS } from "../types/enums";

export const promptExamples: { prompt: string, csl: CameraDirectionDSL }[] = [{
  prompt: "توپ رو دنبال کن و وقتی توپ نزدیک به دروازه شد، pedestal کن و از زاویه بالا توپ رو دنبال کن",
  csl: {
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
  prompt: "زمان را روی ۲ ثانیه فریز کن و یک دور کامل ۳۶۰ درجه دور سوژه معلق در هوا بچرخ، سپس حرکت را با سرعت عادی ادامه بده.",
  csl: {
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
},

{
  prompt: "ورژن ۲ برای ایجاد حس ترس، دوربین را ۳۰ درجه کج کن و به صورت دستی و لرزان به سمت در نیمه‌باز حرکت کن.",
  csl: {
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
}

]
