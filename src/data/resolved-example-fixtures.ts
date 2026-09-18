import { improveCinematicFixtures } from "./cinematic-improvements";
import type { Action, ResolvedCameraDirectionDSL } from "../types/dsl";
import type { Target } from "../types/camera";
import { ShotSize, SubjectView, SubjectInFramePosition, CameraMovementType, ComparisonOperator, RelativeTimeReference, CameraVerticalAngle, RelativeFPS, SpeedFunction, ConstraintType } from "../types/enums";
import { dontCarePromptExampleFixtures } from "./dont-care-examples";

export interface ResolvedPromptExampleFixture {
  id: string;
  environmentId: string;
  prompt: string;
  resolvedCsl: ResolvedCameraDirectionDSL;
}

// Qualitative scene beats retain their timing/pacing, while unrequested geometric
// amounts and framing stay omitted. The optimizer chooses those free dimensions.
const factoryWorkerA = { id: "worker_a", description: "کارگر الف" };
const factoryWorkerB = { id: "worker_b", description: "کارگر ب" };
const factoryWorkers = [factoryWorkerA, factoryWorkerB];

/** Apply the factory prompt's whole-take safety intent to each movement. */
function withContinuousSafety(actions: Action[]): Action[] {
  let activeTargets: Target[] = [];
  return actions.map((action) => {
    const targets = action.movement.targets?.length
      ? action.movement.targets
      : (action.constraints ?? []).flatMap((constraint) => constraint.targets ?? []);
    if (targets.length) {
      activeTargets = [...new Map(targets.map((target) => [target.id, target])).values()];
    }
    return {
      ...action,
      constraints: [
        ...(action.constraints ?? []),
        { kind: "general", constraint: ConstraintType.NoShake, allFrames: true },
        ...(activeTargets.length ? [{
          kind: "general" as const,
          constraint: ConstraintType.AvoidOcclusion,
          targets: activeTargets,
          allFrames: true,
        }] : []),
      ],
    };
  });
}

const basePromptExampleFixtures: ResolvedPromptExampleFixture[] = [{
  id: "example-01",
  environmentId: "example-01-football",
  prompt: "توپ را دنبال کن و وقتی به دروازه نزدیک شد، دوربین را عمودی بالا ببر و توپ را از زاویهٔ بالا دنبال کن.",
  resolvedCsl: {
    totalDuration: 10,
    sections: [
      {
        actions: [
          {
            id: "follow_ball",
            trigger: {
              type: "absoluteTime",
              time: 0
            },
            movement: {
              act: CameraMovementType.Follow,
              targets: [{ id: "ball", description: "توپ" }]
            }
          },
          {
            id: "pedestal_up",
            trigger: {
              type: "distance",
              object1: { id: "ball", description: "توپ" },
              object2: { id: "goal", description: "دروازه" },
              operator: ComparisonOperator.LessThan,
              distance: 5
            },
            movement: {
              act: CameraMovementType.PedestalUp,
              duration: 3,
              // Visible rise requested in the playback review; this amount
              // is an authored demo correction, not inferred by the director.
              parameters: { distance: 2.5 },
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
              targets: [{ id: "ball", description: "توپ" }],
              duration: 3
            },
            constraints: [
              {
                targets: [{ id: "ball", description: "توپ" }],
                config: {
                  type: "subjectAware",
                  cameraAngle: CameraVerticalAngle.High,
                },
                allFrames: false,
                easing: { inDuration: 3, curve: "easeInOut" }
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
  prompt: "از نمای بسیار نزدیک صورت مرد شروع کن، زمان را متوقف کن و سه دور کامل دور صورت او بچرخ.",
  resolvedCsl: {
    totalDuration: 15,
    sections: [
      {
        initCamera: {
          targets: [
            {
              id: "man_face",
              description: "صورت مرد"
            }
          ],
          config: {
            type: "subjectAware",
            shotSize: ShotSize.ExtremeCloseUp,
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
              targets: [{ id: "man_face", description: "صورت مرد" }],
              relativeFPS: RelativeFPS.Frozen,
              parameters: {
                arcAngle: 1080
              }
            }
          }
        ]
      }
    ]
  }
},
{
  id: "example-03",
  environmentId: "example-03-vase-reveal",
  prompt: "ابتدا گلدان را در نمای نزدیک نشان بده، سپس دوربین را عقب بکش تا گلدان و مانیتور همزمان در قاب دیده شوند.",
  resolvedCsl: {
    totalDuration: 20,
    sections: [
      {
        initCamera: {
          targets: [
            {
              id: "vase",
              description: "گلدان"
            }
          ],
          config: {
            type: "subjectAware",
            shotSize: ShotSize.CloseUp,
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
              targets: [{ id: "vase", description: "گلدان" }],
              parameters: { path: "linear" },
              speedKeyframes: [
                { normalizedTime: 0, speedMultiplier: 0 },
                { normalizedTime: 0.1, speedMultiplier: 1, easing: SpeedFunction.Increase },
                { normalizedTime: 0.9, speedMultiplier: 1, easing: SpeedFunction.Static },
                { normalizedTime: 1, speedMultiplier: 0, easing: SpeedFunction.Decrease }
              ]
            },
            constraints: [
              {
                kind: "general",
                constraint: ConstraintType.KeepInFrame,
                targets: [
                  { id: "vase", description: "گلدان" },
                  { id: "monitor", description: "مانیتور" }
                ],
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
  prompt: "دو ثانیه ماشین را تعقیب کن، سپس در یک مسیر قوسی به سمت راست دور آن بچرخ و همزمان روی راننده زوم کن.",
  resolvedCsl: {
    totalDuration: 15,
    sections: [
      {
        initCamera: {
          targets: [{ id: "driver", description: "راننده" }],
          config: { type: "subjectAware", cameraAngle: CameraVerticalAngle.Eye }
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
              targets: [{ id: "car", description: "ماشین" }],
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
              targets: [{ id: "car", description: "ماشین" }],
            },
            constraints: [{
              targets: [{ id: "driver", description: "راننده" }],
              config: { type: "subjectAware", cameraAngle: CameraVerticalAngle.Eye },
              allFrames: true
            }]
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
              targets: [{ id: "driver", description: "راننده" }],
              speedKeyframes: [
                { normalizedTime: 0, speedMultiplier: 0 },
                { normalizedTime: 0.15, speedMultiplier: 1, easing: SpeedFunction.Increase },
                { normalizedTime: 0.85, speedMultiplier: 1 },
                { normalizedTime: 1, speedMultiplier: 0, easing: SpeedFunction.Decrease }
              ],
            },
            constraints: [
              {
                kind: "general",
                constraint: ConstraintType.KeepInFrame,
                targets: [{ id: "driver", description: "راننده" }],
                allFrames: true
              },
              {
                targets: [{ id: "driver", description: "راننده" }],
                config: {
                  type: "subjectAware",
                  shotSize: ShotSize.CloseUp,
                },
                allFrames: false,
                easing: { inDuration: 13, curve: "easeInOut" }
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
  prompt: "دوربین را از چهرهٔ بازیگر دور کن و همزمان زوم را بیشتر کن تا پرسپکتیو پس‌زمینه تغییر کند اما اندازهٔ صورت در قاب ثابت بماند.",
  resolvedCsl: {
    totalDuration: 25,
    sections: [
      {
        initCamera: {
          targets: [
            {
              id: "actor_face",
              description: "چهرهٔ بازیگر"
            }
          ],
          config: {
            type: "subjectAware",
            shotSize: ShotSize.CloseUp,
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
              targets: [{ id: "actor_face", description: "چهرهٔ بازیگر" }]
            },
            constraints: [
              {
                targets: [{ id: "actor_face", description: "چهرهٔ بازیگر" }],
                config: {
                  type: "subjectAware",
                  shotSize: ShotSize.CloseUp,
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
                targets: [{ id: "actor_face", description: "چهرهٔ بازیگر" }],
                config: {
                  type: "subjectAware",
                  shotSize: ShotSize.CloseUp,
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
  prompt: "زمان را در ثانیهٔ ۲ متوقف کن و یک دور کامل ۳۶۰ درجه دور سوژهٔ معلق در هوا بچرخ، سپس حرکت را با سرعت عادی ادامه بده.",
  resolvedCsl: {
    totalDuration: 5,
    sections: [
      {
        initCamera: {
          targets: [{ id: "subject", description: "سوژه" }],
          config: {
            type: "subjectAware",
            cameraAngle: CameraVerticalAngle.Eye,
          }
        },
        actions: [
          {
            id: "follow_before_freeze",
            trigger: { type: "absoluteTime", time: 0 },
            movement: {
              act: CameraMovementType.Static,
              targets: [{ id: "subject", description: "سوژه" }],
              duration: 2,
            },
            constraints: [{
              targets: [{ id: "subject", description: "سوژه" }],
              config: { type: "subjectAware", cameraAngle: CameraVerticalAngle.Eye },
              allFrames: true
            }]
          },
          {
            id: "frozen_orbit_360",
            trigger: {
              type: "absoluteTime",
              time: 2
            },
            movement: {
              act: CameraMovementType.Orbit,
              targets: [{ id: "subject", description: "سوژه" }],
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
                targets: [{ id: "subject", description: "سوژه" }],
                config: {
                  type: "subjectAware",
                  cameraAngle: CameraVerticalAngle.Eye,
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
              act: CameraMovementType.Static,
              targets: [{ id: "subject", description: "سوژه" }],
              relativeFPS: RelativeFPS.Normal,
            },
            constraints: [{
              targets: [{ id: "subject", description: "سوژه" }],
              config: { type: "subjectAware", cameraAngle: CameraVerticalAngle.Eye },
              allFrames: true
            }]
          }
        ]
      }
    ]
  }
},
{
  id: "example-07",
  environmentId: "example-07-spiral-closeup",
  prompt: "از نمای بالا شروع کن و با یک حرکت حلزونی، همزمان با یک دور کامل چرخش به سوژه نزدیک شو تا به نمای نزدیک چشم‌هایش برسی.",
  resolvedCsl: {
    totalDuration: 9,
    sections: [
      {
        initCamera: {
          targets: [
            {
              id: "subject",
              description: "سوژه"
            }
          ],
          config: {
            type: "subjectAware",
            cameraAngle: CameraVerticalAngle.BirdsEye,
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
              targets: [{ id: "subject_eyes", description: "چشم‌های سوژه" }],
              parameters: { arcAngle: 360, constantSpeed: true },
              speedKeyframes: [
                { normalizedTime: 0, speedMultiplier: 1 },
                { normalizedTime: 1, speedMultiplier: 1 }
              ],
            },
            constraints: [
              {
                targets: [{ id: "subject", description: "سوژه" }],
                config: {
                  type: "subjectAware",
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
              targets: [{ id: "subject_eyes", description: "چشم‌های سوژه" }],
              parameters: { constantSpeed: true },
              speedKeyframes: [
                { normalizedTime: 0, speedMultiplier: 1 },
                { normalizedTime: 1, speedMultiplier: 1 }
              ],
            },
            constraints: [
              {
                targets: [{ id: "subject_eyes", description: "چشم‌های سوژه" }],
                config: {
                  type: "subjectAware",
                  shotSize: ShotSize.CloseUp,
                  subjectFraming: { position: SubjectInFramePosition.Center }
                },
                allFrames: false,
                easing: { inDuration: 3, curve: "easeInOut" }
              },
              {
                targets: [{ id: "subject_eyes", description: "چشم‌های سوژه" }],
                config: {
                  type: "subjectAware",
                  subjectView: SubjectView.Front,
                  cameraAngle: CameraVerticalAngle.Eye,
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
  prompt: "ابتدا صحنهٔ مشت‌زدن را با حرکت آهسته و سرعت ۱۰٪ نشان بده؛ درست در لحظهٔ برخورد، سرعت را بسیار زیاد کن و روی محل ضربه زوم کن.",
  resolvedCsl: {
    totalDuration: 12,
    sections: [
      {
        initCamera: {
          targets: [{ id: "fist", description: "مشت" }],
          config: {
            type: "subjectAware",
            shotSize: ShotSize.LongShot,
            subjectView: SubjectView.ThreeQuarterFrontRight,
            cameraAngle: CameraVerticalAngle.Eye,
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
              targets: [{ id: "fist", description: "مشت" }],
              relativeFPS: RelativeFPS.VerySlow
            },
            constraints: [
              {
                targets: [{ id: "fist", description: "مشت" }],
                config: {
                  type: "subjectAware",
                },
                allFrames: true
              }
            ]
          },
          {
            id: "hyper_fast_impact",
            trigger: {
              type: "distance",
              object1: { id: "fist", description: "مشت" },
              object2: { id: "target", description: "هدف ضربه" },
              operator: ComparisonOperator.LessThanOrEqual,
              distance: 0
            },
            movement: {
              act: CameraMovementType.Static,
              targets: [{ id: "impact_point", description: "محل برخورد ضربه" }],
              relativeFPS: RelativeFPS.VeryFast
            }
          },
          {
            id: "zoom_in_impact",
            trigger: {
              type: "distance",
              object1: { id: "fist", description: "مشت" },
              object2: { id: "target", description: "هدف ضربه" },
              operator: ComparisonOperator.LessThanOrEqual,
              distance: 0
            },
            movement: {
              act: CameraMovementType.ZoomIn
            },
            constraints: [
              {
                targets: [{ id: "impact_point", description: "محل برخورد ضربه" }],
                config: {
                  type: "subjectAware",
                  subjectFraming: { position: SubjectInFramePosition.Center }
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
  prompt: "دو نفر را در نمای دور دنبال کن؛ به‌محض اینکه فاصلهٔ آن‌ها به کمتر از یک متر رسید، به نمای روی شانه کات بزن.",
  resolvedCsl: {
    totalDuration: 24,
    sections: [
      {
        initCamera: {
          targets: [
            { id: "person1", description: "نفر اول" },
            { id: "person2", description: "نفر دوم" }
          ],
          config: {
            type: "subjectAware",
            shotSize: ShotSize.LongShot,
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
                { id: "person1", description: "نفر اول" },
                { id: "person2", description: "نفر دوم" }
              ]
            },
            constraints: [
              {
                targets: [
                  { id: "person1", description: "نفر اول" },
                  { id: "person2", description: "نفر دوم" }
                ],
                config: {
                  type: "subjectAware",
                  shotSize: ShotSize.LongShot,
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
            { id: "person2_face", description: "چهره و بالاتنهٔ نفر دوم" }
          ],
          config: {
            type: "subjectAware",
            shotSize: ShotSize.MediumCloseUp,
          }
        },
        actions: [
          {
            id: "ots_cut",
            trigger: {
              type: "distance",
              object1: { id: "person1", description: "نفر اول" },
              object2: { id: "person2", description: "نفر دوم" },
              operator: ComparisonOperator.LessThan,
              distance: 1
            },
            movement: {
              act: CameraMovementType.Follow,
              targets: [{ id: "person2_face", description: "چهره و بالاتنهٔ نفر دوم" }]
            },
            constraints: [
              {
                targets: [
                  { id: "person1_shoulder", description: "شانهٔ نفر اول" }
                ],
                config: {
                  type: "subjectAware",
                  subjectView: SubjectView.ThreeQuarterBackRight,
                  subjectFraming: { position: SubjectInFramePosition.BottomLeft, dutchAngleScale: 0 }
                },
                allFrames: true
              },
              {
                targets: [{ id: "person2_face", description: "چهره و بالاتنهٔ نفر دوم" }],
                config: {
                  type: "subjectAware",
                  shotSize: ShotSize.MediumCloseUp,
                  cameraAngle: CameraVerticalAngle.Eye,
                  subjectFraming: { position: SubjectInFramePosition.Center }
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
  prompt: "ماشین مسابقه را دنبال کن؛ اگر سرعت آن از ۱۰۰ کیلومتر بر ساعت بیشتر شد، دوربین را بلرزان و عقب بکش تا حس سرعت القا شود.",
  resolvedCsl: {
    totalDuration: 13,
    sections: [
      {
        actions: [
          {
            id: "follow_race_car",
            trigger: {
              type: "absoluteTime",
              time: 0
            },
            movement: {
              act: CameraMovementType.Follow,
              targets: [{ id: "race_car", description: "ماشین مسابقه" }]
            },
            constraints: [
              {
                targets: [{ id: "race_car", description: "ماشین مسابقه" }],
                config: {
                  type: "subjectAware",
                },
                allFrames: true
              }
            ]
          },
          {
            id: "dolly_out_shake",
            trigger: {
              type: "velocity",
              subject: { id: "race_car", description: "ماشین مسابقه" },
              operator: ComparisonOperator.GreaterThan,
              speed: 100 / 3.6 // 100 km/h in m/s, without shifting the threshold
            },
            movement: {
              act: CameraMovementType.DollyOut,
              targets: [{ id: "race_car", description: "ماشین مسابقه" }],
              speedKeyframes: [
                { normalizedTime: 0, speedMultiplier: 0 },
                { normalizedTime: 0.15, speedMultiplier: 1.25, easing: SpeedFunction.Increase },
                { normalizedTime: 0.85, speedMultiplier: 1 },
                { normalizedTime: 1, speedMultiplier: 0.15, easing: SpeedFunction.Decrease }
              ],
              parameters: {
                handheld: true
              }
            },
            constraints: [
              {
                targets: [{ id: "race_car", description: "ماشین مسابقه" }],
                config: {
                  type: "subjectAware",
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
  prompt: "برای ایجاد حس ترس، دوربین را ۳۰ درجه کج کن و به‌صورت روی دست و لرزان به سمت در نیمه‌باز حرکت کن.",
  resolvedCsl: {
    totalDuration: 6,
    sections: [
      {
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
              targets: [{ id: "half_open_door", description: "در نیمه‌باز" }],
              speedKeyframes: [
                { normalizedTime: 0, speedMultiplier: 0 },
                { normalizedTime: 0.18, speedMultiplier: 1, easing: SpeedFunction.Increase },
                { normalizedTime: 0.82, speedMultiplier: 0.85 },
                { normalizedTime: 1, speedMultiplier: 0, easing: SpeedFunction.Decrease }
              ],
              parameters: {
                handheld: true
              }
            },
            constraints: [
              {
                targets: [{ id: "half_open_door", description: "در نیمه‌باز" }],
                config: {
                  type: "subjectAware",
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
  prompt: "از نمای داخل ماشین و پشت داشبورد شروع کن؛ وقتی راننده ترمز کرد، دوربین از شیشهٔ جلو بیرون بیاید و با یک چرخش قوسی سریع، نمای جلوی ماشین را نشان بدهد.",
  resolvedCsl: {
    totalDuration: 18,
    sections: [
      {
        initCamera: {
          targets: [
            {
              id: "dashboard",
              description: "نمای داخل ماشین از پشت داشبورد"
            }
          ],
          config: {
            type: "nonSubjectAware",
            extrinsics: {
              pose: {
                position: { x: -0.15, y: 1.23, z: 30.25 },
                rotation: {
                  x: 0,
                  y: 0,
                  z: 0,
                  w: 1
                }
              }
            },
            intrinsics: { fov: 70 },
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
                  description: "نمای داخل ماشین از پشت داشبورد"
                }
              ]
            }
          },
          {
            id: "exit_through_windshield",
            trigger: {
              type: "velocity",
              subject: { id: "car", description: "ماشین" },
              operator: ComparisonOperator.LessThan,
              speed: 5
            },
            movement: {
              act: CameraMovementType.DollyIn,
              targets: [{ id: "car_front_exit", description: "نقطهٔ خروج هم‌ارتفاع دوربین در جلوی شیشهٔ ماشین" }],
              duration: 2.5,
              speedKeyframes: [
                { normalizedTime: 0, speedMultiplier: 0 },
                { normalizedTime: 0.2, speedMultiplier: 1, easing: SpeedFunction.Increase },
                { normalizedTime: 0.8, speedMultiplier: 1 },
                { normalizedTime: 1, speedMultiplier: 0, easing: SpeedFunction.Decrease }
              ],
              parameters: {
                distance: 5,
                path: "linear",
                allowSubjectIntersection: true
              }
            },
            constraints: [{
              targets: [{ id: "car", description: "ماشین" }],
              config: {
                type: "subjectAware",
              },
              allFrames: false,
              easing: { inDuration: 1, curve: "easeInOut" }
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
              targets: [{ id: "car", description: "ماشین" }],
              // The windshield exit already reaches the front. A full reveal
              // returns to that side; the former half-turn ended at the rear.
              parameters: { arcAngle: 360 },
              speedKeyframes: [
                { normalizedTime: 0, speedMultiplier: 0 },
                { normalizedTime: 0.15, speedMultiplier: 1, easing: SpeedFunction.Increase },
                { normalizedTime: 1, speedMultiplier: 1 }
              ],
            },
            constraints: [
              {
                targets: [{ id: "car", description: "ماشین" }],
                config: {
                  type: "subjectAware",
                  subjectView: SubjectView.Front,
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
  prompt: "نسخهٔ دوم: برای ایجاد حس ترس، دوربین را ۳۰ درجه کج کن و به‌صورت روی دست و لرزان به سمت در نیمه‌باز حرکت کن.",
  resolvedCsl: {
    totalDuration: 7,
    sections: [
      {
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
              targets: [{ id: "half_open_door", description: "در نیمه‌باز" }],
              duration: 7,
              speedKeyframes: [
                { normalizedTime: 0, speedMultiplier: 0 },
                { normalizedTime: 0.18, speedMultiplier: 1, easing: SpeedFunction.Increase },
                { normalizedTime: 0.82, speedMultiplier: 0.85 },
                { normalizedTime: 1, speedMultiplier: 0, easing: SpeedFunction.Decrease }
              ],
              parameters: {
                handheld: true
              }
            },
            constraints: [
              {
                targets: [{ id: "half_open_door", description: "در نیمه‌باز" }],
                config: {
                  type: "subjectAware",
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
  prompt: "از یک نمای متوسط سه‌رخ و سکوت ۱٫۵ ثانیه‌ای شروع کن؛ سپس با حرکت آهستهٔ دوربین به جلو و یک چرخش قوسی کوتاه به راست، به صورت نزدیک شو. در دو ثانیهٔ آخر، زوم بسیار نرمی به جلو اضافه کن و چهره را در نمای نزدیک روی یک‌سوم چپ قاب نگه دار.",
  resolvedCsl: {
    totalDuration: 10,
    sections: [{
      initCamera: {
        targets: [{ id: "actor", description: "بازیگر" }],
        config: {
          type: "subjectAware",
          shotSize: ShotSize.MediumShot,
          subjectView: SubjectView.ThreeQuarterFrontLeft,
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
            targets: [{ id: "actor", description: "بازیگر" }],
            config: {
              type: "subjectAware",
              shotSize: ShotSize.MediumShot,
              subjectView: SubjectView.ThreeQuarterFrontLeft,
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
            targets: [{ id: "actor_face", description: "چهرهٔ بازیگر" }],
            duration: 8.5,
            speedKeyframes: [
              { normalizedTime: 0, speedMultiplier: 0 },
              { normalizedTime: 0.15, speedMultiplier: 0.65, easing: SpeedFunction.Increase },
              { normalizedTime: 0.7, speedMultiplier: 0.9 },
              { normalizedTime: 1, speedMultiplier: 0.1, easing: SpeedFunction.Decrease }
            ],
          }
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
            targets: [{ id: "actor_face", description: "چهرهٔ بازیگر" }],
            duration: 8.5,
            speedKeyframes: [
              { normalizedTime: 0, speedMultiplier: 0 },
              { normalizedTime: 0.15, speedMultiplier: 0.8, easing: SpeedFunction.Increase },
              { normalizedTime: 0.85, speedMultiplier: 0.8 },
              { normalizedTime: 1, speedMultiplier: 0.1, easing: SpeedFunction.Decrease }
            ],
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
            speedKeyframes: [
              { normalizedTime: 0, speedMultiplier: 0 },
              { normalizedTime: 0.5, speedMultiplier: 1, easing: SpeedFunction.Increase },
              { normalizedTime: 1, speedMultiplier: 0, easing: SpeedFunction.Decrease }
            ],
          },
          constraints: [{
            targets: [{ id: "actor_face", description: "چهرهٔ بازیگر" }],
            config: {
              type: "subjectAware",
              shotSize: ShotSize.CloseUp,
              subjectFraming: { position: SubjectInFramePosition.Left }
            },
            allFrames: true
          }]
        }
      ]
    }]
  }
},
{
  id: "example-15",
  environmentId: "example-15-dancer-arc",
  prompt: "از نمای متوسطِ دور با زاویهٔ پایین شروع کن. چهار ثانیهٔ اول با چرخش قوسی آرام به چپ و حرکت آهسته دور رقصنده بچرخ؛ روی ضرب موسیقی، چرخش به چپ را سریع کن و همزمان دوربین را عمودی بالا ببر. در دو ثانیهٔ آخر، با فرودی نرم رقصنده را روی یک‌سوم راست قاب نگه دار.",
  resolvedCsl: {
    totalDuration: 10,
    sections: [{
      initCamera: {
        targets: [{ id: "dancer", description: "رقصنده" }],
        config: {
          type: "subjectAware",
          cameraAngle: CameraVerticalAngle.Low,
          shotSize: ShotSize.MediumLongShot,
        }
      },
      actions: [
        {
          id: "slow_arc_intro",
          trigger: { type: "absoluteTime", time: 0 },
          movement: {
            act: CameraMovementType.ArcLeft,
            targets: [{ id: "dancer", description: "رقصنده" }],
            duration: 4,
            speedKeyframes: [
              { normalizedTime: 0, speedMultiplier: 0.35 },
              { normalizedTime: 1, speedMultiplier: 0.75 }
            ],
          },
          constraints: [
            {
              targets: [{ id: "dancer", description: "رقصنده" }],
              config: {
                type: "subjectAware",
                cameraAngle: CameraVerticalAngle.Low,
                shotSize: ShotSize.MediumLongShot,
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
            targets: [{ id: "dancer", description: "رقصنده" }],
            duration: 4,
            speedKeyframes: [
              { normalizedTime: 0, speedMultiplier: 0.8 },
              { normalizedTime: 0.55, speedMultiplier: 2.2 },
              { normalizedTime: 1, speedMultiplier: 0.55 }
            ],
          },
          constraints: [
            {
              targets: [{ id: "dancer", description: "رقصنده" }],
              config: {
                type: "subjectAware",
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
            speedKeyframes: [
              { normalizedTime: 0, speedMultiplier: 0 },
              { normalizedTime: 0.35, speedMultiplier: 0.7, easing: SpeedFunction.Increase },
              { normalizedTime: 1, speedMultiplier: 0, easing: SpeedFunction.Decrease }
            ],
          },
          constraints: [{
            targets: [{ id: "dancer", description: "رقصنده" }],
            config: {
              type: "subjectAware",
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
  prompt: "در یک پلان بدون کات، با حرکت جانبی دوربین به راست هر دو مأمور را در یک نمای دونفره نگه دار. وقتی فاصله‌شان به کمتر از یک متر رسید، زومی کوتاه به جلو روی کیف بزن؛ بلافاصله با چرخش قوسی سریع به راست از خط نگاه عبور کن و همزمان زوم را باز کن تا در پایان جای دو بازیگر عوض شود: مأمور الف در راست قاب و مأمور ب در چپ قاب.",
  resolvedCsl: {
    totalDuration: 10,
    sections: [{
      actions: [
        {
          id: "truck_right_exchange_setup",
          trigger: { type: "absoluteTime", time: 0 },
          movement: {
            act: CameraMovementType.TruckRight,
            duration: 5,
            parameters: { path: "linear" },
          },
          constraints: [
            {
              kind: "general",
              constraint: ConstraintType.KeepInFrame,
              targets: [
                { id: "actor_a", description: "مأمور الف" },
                { id: "actor_b", description: "مأمور ب" }
              ],
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
            object1: { id: "actor_a", description: "مأمور الف" },
            object2: { id: "actor_b", description: "مأمور ب" },
            operator: ComparisonOperator.LessThan,
            distance: 1
          },
          movement: {
            act: CameraMovementType.ZoomIn,
            duration: 1,
          },
          constraints: [{
            targets: [{ id: "briefcase", description: "کیف در حال مبادله" }],
            config: {
              type: "subjectAware",
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
              { id: "actor_a", description: "مأمور الف" },
              { id: "actor_b", description: "مأمور ب" }
            ],
            duration: 4,
            speedKeyframes: [
              { normalizedTime: 0, speedMultiplier: 0 },
              { normalizedTime: 0.15, speedMultiplier: 1.9, easing: SpeedFunction.Increase },
              { normalizedTime: 0.6, speedMultiplier: 1.15 },
              { normalizedTime: 1, speedMultiplier: 0.2, easing: SpeedFunction.Decrease }
            ],
          },
          constraints: [
            {
              kind: "general",
              constraint: ConstraintType.KeepInFrame,
              targets: [
                { id: "actor_a", description: "مأمور الف" },
                { id: "actor_b", description: "مأمور ب" }
              ],
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
          },
          constraints: [
            {
              targets: [{ id: "actor_a", description: "مأمور الف" }],
              config: {
                type: "subjectAware",
                subjectFraming: { position: SubjectInFramePosition.Right }
              },
              allFrames: false,
              easing: { inDuration: 1.5, curve: "easeOut" }
            },
            {
              targets: [{ id: "actor_b", description: "مأمور ب" }],
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
  prompt: "از نمای تمام‌قد با زاویهٔ پایین در کنار دونده شروع کن، همراه او حرکت کن و جلوی مسیرش فضای خالی بده. لحظه‌ای که سرعتش به ۸ متر بر ثانیه رسید، سرعت صحنه را به ۱۰٪ کاهش بده و با چرخش قوسی ۱۲۰ درجه به چپ، از کنار به روبه‌رویش برس. سپس سرعت عادی را برگردان، دوربین را عقب بکش و او را دنبال کن تا در پایان، دونده در چپ قاب باشد و جلوی حرکتش فضای باز بماند.",
  resolvedCsl: {
    totalDuration: 11,
    sections: [{
      initCamera: {
        targets: [{ id: "runner", description: "دونده" }],
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
            targets: [{ id: "runner", description: "دونده" }],
          },
          constraints: [
            {
              targets: [{ id: "runner", description: "دونده" }],
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
            subject: { id: "runner", description: "دونده" },
            operator: ComparisonOperator.GreaterThanOrEqual,
            speed: 8
          },
          movement: {
            act: CameraMovementType.ArcLeft,
            targets: [{ id: "runner", description: "دونده" }],
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
            }
          },
          constraints: [
            {
              targets: [{ id: "runner", description: "دونده" }],
              config: {
                type: "subjectAware",
                subjectView: SubjectView.Front,
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
            targets: [{ id: "runner", description: "دونده" }],
            relativeFPS: RelativeFPS.Normal,
          },
          constraints: [
            {
              targets: [{ id: "runner", description: "دونده" }],
              config: {
                type: "subjectAware",
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
            targets: [{ id: "runner", description: "دونده" }],
            speedKeyframes: [
              { normalizedTime: 0, speedMultiplier: 0 },
              { normalizedTime: 0.25, speedMultiplier: 1, easing: SpeedFunction.Increase },
              { normalizedTime: 1, speedMultiplier: 1 }
            ],
          },
          constraints: [{
            targets: [{ id: "runner", description: "دونده" }],
            config: {
              type: "subjectAware",
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
  prompt: "از نمای نزدیک دست لرزان شروع کن و در ۲٫۵ ثانیه با چرخش عمودی دوربین به بالا به چشم برس. نیم‌ثانیه مکث کن؛ سپس دوربین را به جلو ببر و همزمان زوم را بیشتر کن تا وارد مردمک شوی. در یک‌ونیم ثانیهٔ آخر دوربین را ۱۰ درجه به راست کج کن و ضرب پایانی را داخل مردمک با توقف زمان ثبت کن.",
  resolvedCsl: {
    totalDuration: 10,
    sections: [{
      initCamera: {
        targets: [{ id: "hand", description: "دست لرزان سوژه" }],
        config: {
          type: "subjectAware",
          shotSize: ShotSize.CloseUp,
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
          },
          constraints: [{
            targets: [{ id: "eye", description: "چشم سوژه" }],
            config: {
              type: "subjectAware",
              shotSize: ShotSize.CloseUp,
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
            targets: [{ id: "eye", description: "چشم سوژه" }],
            config: {
              type: "subjectAware",
              shotSize: ShotSize.CloseUp,
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
            targets: [{ id: "pupil", description: "مردمک سوژه" }],
            duration: 5.5,
            speedKeyframes: [
              { normalizedTime: 0, speedMultiplier: 0 },
              { normalizedTime: 0.15, speedMultiplier: 0.75, easing: SpeedFunction.Increase },
              { normalizedTime: 0.7, speedMultiplier: 1.35 },
              { normalizedTime: 1, speedMultiplier: 0.1, easing: SpeedFunction.Decrease }
            ],
            parameters: {
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
            duration: 5.5,
          },
          constraints: [{
            targets: [{ id: "pupil", description: "مردمک سوژه" }],
            config: {
              type: "subjectAware",
              shotSize: ShotSize.ExtremeCloseUp,
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
            offset: 0
          },
          movement: {
            act: CameraMovementType.DutchRight,
            duration: 1.5,
            relativeFPS: RelativeFPS.Frozen,
            parameters: { rotationAngle: 10 }
          },
          constraints: [{
            targets: [{ id: "pupil", description: "مردمک سوژه" }],
            config: {
              type: "subjectAware",
              shotSize: ShotSize.ExtremeCloseUp,
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
  prompt: "از نمای عمودی بالا روی کارآگاه شروع کن؛ همزمان دوربین را پایین بیاور و رو به بالا بچرخان تا در دو ثانیه هم‌سطح او شوی. سپس با حرکت جانبی به چپ در راهرو همراهش برو. وقتی به انتهای مسیر رسید، دوربین را سریع به چپ بچرخان، زوم را باز کن و با کج‌کردن دوربین به راست، مهاجم پشت ستون را آشکار کن؛ سپس با یک چرخش افقی کوتاه به راست، هر دو را در قاب نهایی جا بده.",
  resolvedCsl: {
    totalDuration: 10,
    sections: [{
      initCamera: {
        targets: [{ id: "detective", description: "کارآگاه" }],
        config: {
          type: "subjectAware",
          cameraAngle: CameraVerticalAngle.TopDown,
        }
      },
      actions: [
        {
          id: "descent_pedestal_down",
          trigger: { type: "absoluteTime", time: 0 },
          movement: {
            act: CameraMovementType.PedestalDown,
            duration: 2,
          },
          constraints: [{
            targets: [{ id: "detective", description: "کارآگاه" }],
            config: {
              type: "subjectAware",
              cameraAngle: CameraVerticalAngle.Eye,
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
          },
          constraints: [{
            targets: [{ id: "detective", description: "کارآگاه" }],
              config: {
                type: "subjectAware",
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
          },
          constraints: [{
              kind: "general",
              constraint: ConstraintType.KeepInFrame,
              targets: [{ id: "pursuer", description: "تعقیب‌کنندهٔ پنهان" }],
            allFrames: false,
            easing: { inDuration: 0.35, outDuration: 0.4, curve: "easeOut" }
          }, {
            kind: "general",
            constraint: ConstraintType.AvoidOcclusion,
            targets: [{ id: "pursuer", description: "تعقیب‌کنندهٔ پنهان" }],
            allFrames: false
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
          },
          constraints: [{
            kind: "general",
            constraint: ConstraintType.KeepInFrame,
            targets: [
              { id: "detective", description: "کارآگاه" },
              { id: "pursuer", description: "تعقیب‌کنندهٔ پنهان" }
            ],
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
          },
          constraints: [{
            targets: [
              { id: "detective", description: "کارآگاه" },
              { id: "pursuer", description: "تعقیب‌کنندهٔ پنهان" }
            ],
            config: {
              type: "subjectAware",
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
    "دونده را در مسیر دنبال کن و نگذار درخت جلوی دید را بگیرد. وقتی به میدان رسید، دوربین را بالا ببر تا میدان و آب‌نما آشکار شوند؛ سپس با فاصله و زاویهٔ ثابت او را در قاب نگه دار.",
  resolvedCsl: {
    totalDuration: 10,
      sections: [
    {
      actions: [
        {
          id: "follow_jogger",
          trigger: { type: "absoluteTime", time: 0 },
          movement: {
            act: CameraMovementType.Follow,
            targets: [{
                    id: "jogger",
                    description: "دونده"
                  }],
            duration: 4,
          },
          constraints: [
            {
              targets: [{
                    id: "jogger",
                    description: "دونده"
                  }],
              config: {
                type: "subjectAware",
              },
              allFrames: true,
            },
            {
              kind: "general",
              constraint: ConstraintType.AvoidOcclusion,
              targets: [{ id: "jogger", description: "دونده" }],
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
                    description: "دونده"
                  },
                  {
                    id: "fountain",
                    description: "آب‌نمای میدان"
                  }
                ],
            duration: 3,
          },
          constraints: [{
            kind: "general",
            constraint: ConstraintType.KeepInFrame,
            targets: [
              { id: "jogger", description: "دونده" },
              { id: "fountain", description: "آب‌نمای میدان" },
            ],
            allFrames: false,
          }],
        },
        {
          id: "held_finish",
          trigger: { type: "relativeTime", actionId: "crane_reveal", reference: RelativeTimeReference.End, offset: 0 },
          movement: { act: CameraMovementType.Static, targets: [{ id: "jogger", description: "دونده" }], duration: 3 },
          constraints: [
            { kind: "general", constraint: ConstraintType.KeepInFrame, targets: [{ id: "jogger", description: "دونده" }], allFrames: true },
            { kind: "general", constraint: ConstraintType.MaintainDistance, targets: [{ id: "jogger", description: "دونده" }], allFrames: true },
            { kind: "general", constraint: ConstraintType.MaintainAngle, targets: [{ id: "jogger", description: "دونده" }], allFrames: true },
          ],
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
    "دونده را روی پشت‌بام تعقیب کن تا تعقیب‌کننده به فاصلهٔ ۲٫۵ متری او برسد؛ سپس در مسیری قوسی دور دونده بچرخ و همزمان زوم را بیشتر کن تا تعقیب‌کننده آشکار شود. در پایان، با یک نمای ثابت و بدون لرزش، زاویه را حفظ کن و هر دو را در قاب نگه دار.",
  resolvedCsl: {
    totalDuration: 10,
    sections: [
      {

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
                  description: "دونده",
                },
              ],
            },
            constraints: [
              {
                targets: [
                  {
                    id: "runner",
                    description: "دونده",
                  },
                ],
                config: {
                  type: "subjectAware",
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
                description: "تعقیب‌کننده",
              },
              object2: {
                id: "runner",
                description: "دونده",
              },
              operator: ComparisonOperator.LessThanOrEqual,
              distance: 2.5,
            },
            movement: {
              act: CameraMovementType.Orbit,
              targets: [
                {
                  id: "runner",
                  description: "دونده",
                },
              ],
              duration: 1.5,
            },
            constraints: [
              {
                kind: "general",
                constraint: ConstraintType.AvoidOcclusion,
                targets: [
                  {
                    id: "runner",
                    description: "دونده",
                  },
                  {
                    id: "pursuer",
                    description: "تعقیب‌کننده",
                  },
                ],
                allFrames: true,
              },
              {
                targets: [
                  {
                    id: "runner",
                    description: "دونده",
                  },
                  {
                    id: "pursuer",
                    description: "تعقیب‌کننده",
                  },
                ],
                config: {
                  type: "subjectAware",
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
              act: CameraMovementType.Static,
            },
            constraints: [{
              kind: "general", constraint: ConstraintType.KeepInFrame,
              targets: [{ id: "runner", description: "دونده" }, { id: "pursuer", description: "تعقیب‌کننده" }],
              allFrames: true,
            }, {
              kind: "general", constraint: ConstraintType.MaintainAngle,
              targets: [{ id: "runner", description: "دونده" }, { id: "pursuer", description: "تعقیب‌کننده" }],
              allFrames: true,
            }, { kind: "general", constraint: ConstraintType.NoShake, allFrames: true }],
           
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
    "کارگر را از کنار قفسه‌ها دنبال کن. وقتی کنار جعبه‌ها کند شد، با حرکت قوسی دور او بچرخ و همزمان نزدیک شو. هنگام بالارفتن او به نیم‌طبقه، در مسیری قوسی دورش بالا برو؛ سپس در بازگشت به پایین و به سمت سکوی بارگیری دنبالش کن. وقتی به همکارش نزدیک شد، دوربین را عقب بکش تا همکار آشکار شود. با دوربین کج دور هر دو بچرخ، دوربین را بالا ببر و زوم را باز کن تا کل سالن دیده شود؛ سپس با یک نمای ثابت و بدون لرزش پایان بده.",
  resolvedCsl: {
    totalDuration: 22,
    sections: [
      {

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
                  description: "کارگر",
                },
              ],
            },
            constraints: [
              {
                targets: [
                  {
                    id: "worker",
                    description: "کارگر",
                  },
                ],
                config: {
                  type: "subjectAware",
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
                  description: "کارگر",
                },
                operator: ComparisonOperator.LessThan,
                speed: 0.5,
              },
            movement: {
              act: CameraMovementType.Orbit,
              targets: [
                {
                  id: "worker",
                  description: "کارگر",
                },
              ],
              duration: 2,
            },
            constraints: [
              {
                targets: [
                  {
                    id: "worker",
                    description: "کارگر",
                  },
                ],
                config: {
                  type: "subjectAware",
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
                  description: "کارگر",
                },
              ],
              duration: 2,
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
              act: CameraMovementType.Orbit,
              targets: [
                {
                  id: "worker",
                  description: "کارگر",
                },
              ],
              duration: 2.5,
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
                  description: "کارگر",
                },
              ],
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
            },
          },

          {
            id: "reveal_both",
            trigger: {
              type: "distance",
              object1: {
                id: "worker",
                description: "کارگر",
              },
              object2: {
                id: "coworker",
                description: "همکار",
              },
              operator: ComparisonOperator.LessThanOrEqual,
              distance: 2.0,
            },
            movement: {
              act: CameraMovementType.Follow,
              targets: [
                {
                  id: "worker",
                  description: "کارگر",
                },
              ],
              duration: 1.8,
            },
            constraints: [
              {
                kind: "general",
                constraint: ConstraintType.KeepInFrame,
                targets: [
                  {
                    id: "worker",
                    description: "کارگر",
                  },
                  {
                    id: "coworker",
                    description: "همکار",
                  },
                ],
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
                  description: "کارگر",
                },
              ],
              duration: 1.8,
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
              act: CameraMovementType.Orbit,
              targets: [
                {
                  id: "worker",
                  description: "کارگر",
                },
                {
                  id: "coworker",
                  description: "همکار",
                },
              ],
              duration: 2.5,
            },
            constraints: [{
              kind: "general",
              constraint: ConstraintType.KeepInFrame,
              targets: [
                { id: "worker", description: "کارگر" },
                { id: "coworker", description: "همکار" },
              ],
              allFrames: true,
            }],
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
                  description: "کارگر",
                },
                {
                  id: "coworker",
                  description: "همکار",
                },
              ],
              duration: 2.5,
            },
            constraints: [
              {
                targets: [
                  {
                    id: "worker",
                    description: "کارگر",
                  },
                  {
                    id: "coworker",
                    description: "همکار",
                  },
                ],
                config: {
                  type: "subjectAware",
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
            },
            constraints: [
              {
                kind: "general",
                constraint: ConstraintType.KeepInFrame,
                targets: [
                  { id: "worker", description: "کارگر" },
                  { id: "coworker", description: "همکار" },
                ],
                allFrames: true,
              },
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
  prompt: "یک پلان پیوستهٔ ۲۰ ثانیه‌ای درون کارخانه‌ای شلوغ بگیر. با دنبال‌کردن کارگر الف از سمت شرق سالن تولید به سمت مرکز شروع کن و او را در نمای متوسطِ دور نگه دار. نزدیک‌تر شو و با حرکت او دوربین را افقی و عمودی بچرخان؛ سپس هنگام تغییر مسیرش، دوربین را جانبی و عمودی جابه‌جا کن. وقتی کنار دستگاه‌های مرکزی کند شد، در مسیری قوسی دورش بچرخ و به‌تدریج زوم را بیشتر کن تا کارگر ب که از سمت مقابل نزدیک می‌شود آشکار شود. با نزدیک‌شدن دو کارگر، نما را بازتر کن و هر دو را با هم تعقیب کن؛ آن‌ها را در دید نگه دار، فاصله و زاویه را ثابت حفظ کن و از دستگاه‌ها و لیفتراک در حال عبور دوری کن. وقتی کارگر ب به سمت سکوی بارگیری شتاب گرفت، با او دوربین را افقی بچرخان، جانبی در سالن حرکت کن، دوربین را پایین بیاور، در مسیری قوسی دورش بچرخ و کجی دوربین را اصلاح کن. سپس عقب بکش تا هر دو کارگر، نیم‌طبقه، لیفتراک و محوطهٔ بارگیری دیده شوند. در پایان دور دو کارگر بچرخ، هر دو را در یک قاب باز و پایدار نگه دار و با نمای ثابت و توقف زمان تمام کن. در تمام پلان، حرکت دوربین نرم باشد، دید سوژه‌ها مسدود نشود، دوربین از سطح زمین پایین‌تر نرود و هر گذار مانند یک حرکت پیوسته و هدفمند سینمایی احساس شود.",
  resolvedCsl: {
    totalDuration: 20,
    sections: [{
      initCamera: {
        targets: [factoryWorkerA],
        config: { type: "subjectAware", shotSize: ShotSize.MediumLongShot },
      },
      actions: withContinuousSafety([
        {
          id: "follow_worker_a_center",
          trigger: { type: "absoluteTime", time: 0 },
          movement: { act: CameraMovementType.Follow, targets: [factoryWorkerA] },
          constraints: [{
            targets: [factoryWorkerA],
            config: { type: "subjectAware", shotSize: ShotSize.MediumLongShot },
            allFrames: true,
          }],
        },
        {
          id: "push_closer_truck_pedestal",
          trigger: { type: "relativeTime", actionId: "follow_worker_a_center", reference: RelativeTimeReference.End, offset: 0 },
          movement: { act: CameraMovementType.DollyIn, targets: [factoryWorkerA] },
        },
        {
          id: "pan_with_worker_a",
          trigger: { type: "relativeTime", actionId: "push_closer_truck_pedestal", reference: RelativeTimeReference.Start, offset: 0 },
          movement: { act: CameraMovementType.PanLeft },
          constraints: [{ targets: [factoryWorkerA], config: { type: "subjectAware" }, allFrames: true }],
        },
        {
          id: "tilt_with_worker_a",
          trigger: { type: "relativeTime", actionId: "push_closer_truck_pedestal", reference: RelativeTimeReference.Start, offset: 0 },
          movement: { act: CameraMovementType.TiltUp },
        },
        {
          id: "truck_with_worker_a",
          trigger: { type: "relativeTime", actionId: "push_closer_truck_pedestal", reference: RelativeTimeReference.End, offset: 0 },
          movement: { act: CameraMovementType.TruckLeft },
          constraints: [{ targets: [factoryWorkerA], config: { type: "subjectAware" }, allFrames: true }],
        },
        {
          id: "pedestal_with_worker_a",
          trigger: { type: "relativeTime", actionId: "truck_with_worker_a", reference: RelativeTimeReference.Start, offset: 0 },
          movement: { act: CameraMovementType.PedestalUp },
        },
        {
          id: "arc_zoom_near_machine",
          // In this scene westward motion slows after the approach. Projecting
          // velocity avoids mistaking the initial slow start for this event.
          trigger: {
            type: "velocity", subject: factoryWorkerA,
            operator: ComparisonOperator.LessThan, speed: 0.46,
            direction: { x: -1, y: 0, z: 0 },
          },
          movement: { act: CameraMovementType.Orbit, targets: [factoryWorkerA] },
          constraints: [{ kind: "general", constraint: ConstraintType.KeepInFrame, targets: factoryWorkers, allFrames: false }],
        },
        {
          id: "zoom_in_reveal_worker_b",
          trigger: { type: "relativeTime", actionId: "arc_zoom_near_machine", reference: RelativeTimeReference.Start, offset: 0 },
          movement: { act: CameraMovementType.ZoomIn },
          constraints: [{ kind: "general", constraint: ConstraintType.KeepInFrame, targets: factoryWorkers, allFrames: false }],
        },
        {
          id: "converge_track_both",
          trigger: {
            type: "distance", object1: factoryWorkerA, object2: factoryWorkerB,
            operator: ComparisonOperator.LessThanOrEqual, distance: 0.8,
          },
          movement: { act: CameraMovementType.Track, targets: factoryWorkers },
          constraints: [
            { kind: "general", constraint: ConstraintType.KeepInFrame, targets: factoryWorkers, allFrames: true },
            { kind: "general", constraint: ConstraintType.MaintainDistance, targets: factoryWorkers, allFrames: true },
            { kind: "general", constraint: ConstraintType.MaintainAngle, targets: factoryWorkers, allFrames: true },
          ],
        },
        {
          id: "widen_convergence",
          trigger: { type: "relativeTime", actionId: "converge_track_both", reference: RelativeTimeReference.Start, offset: 0 },
          movement: { act: CameraMovementType.ZoomOut },
        },
        {
          id: "worker_b_accelerates_pan_truck",
          trigger: { type: "velocity", subject: factoryWorkerB, operator: ComparisonOperator.GreaterThanOrEqual, speed: 1.8 },
          movement: { act: CameraMovementType.TruckRight, duration: 2 },
          constraints: [{ targets: [factoryWorkerB], config: { type: "subjectAware" }, allFrames: true }],
        },
        {
          id: "pan_with_worker_b",
          trigger: { type: "relativeTime", actionId: "worker_b_accelerates_pan_truck", reference: RelativeTimeReference.Start, offset: 0 },
          movement: { act: CameraMovementType.PanRight, duration: 2 },
          constraints: [{ targets: [factoryWorkerB], config: { type: "subjectAware" }, allFrames: true }],
        },
        {
          id: "lower_and_arc_worker_b",
          trigger: { type: "relativeTime", actionId: "worker_b_accelerates_pan_truck", reference: RelativeTimeReference.End, offset: 0 },
          movement: { act: CameraMovementType.PedestalDown },
          constraints: [{ targets: [factoryWorkerB], config: { type: "subjectAware" }, allFrames: true }],
        },
        {
          id: "arc_around_worker_b",
          trigger: { type: "relativeTime", actionId: "lower_and_arc_worker_b", reference: RelativeTimeReference.End, offset: 0 },
          movement: { act: CameraMovementType.Orbit, targets: [factoryWorkerB] },
          constraints: [{
            targets: [factoryWorkerB],
            config: { type: "subjectAware", subjectFraming: { dutchAngleScale: 0 } },
            allFrames: false,
          }],
        },
        {
          id: "pull_back_reveal_all",
          trigger: { type: "relativeTime", actionId: "arc_around_worker_b", reference: RelativeTimeReference.End, offset: 0 },
          movement: { act: CameraMovementType.DollyOut, targets: factoryWorkers },
          constraints: [{
            kind: "general",
            constraint: ConstraintType.KeepInFrame,
            targets: [...factoryWorkers, { id: "loading_bay_frame", description: "محوطهٔ بارگیری" }],
            allFrames: false,
          }],
        },
        {
          id: "orbit_both_workers",
          trigger: { type: "relativeTime", actionId: "pull_back_reveal_all", reference: RelativeTimeReference.End, offset: 0 },
          movement: { act: CameraMovementType.Orbit, targets: factoryWorkers },
          constraints: [{
            targets: factoryWorkers,
            config: { type: "subjectAware", shotSize: ShotSize.LongShot },
            allFrames: true,
          }, {
            kind: "general", constraint: ConstraintType.KeepInFrame, targets: factoryWorkers, allFrames: true,
          }],
        },
        {
          id: "locked_off_freeze",
          trigger: { type: "relativeTime", actionId: "orbit_both_workers", reference: RelativeTimeReference.End, offset: 0 },
          movement: { act: CameraMovementType.Static, relativeFPS: RelativeFPS.Frozen },
          constraints: [{
            targets: factoryWorkers,
            config: { type: "subjectAware", shotSize: ShotSize.LongShot },
            allFrames: true,
          }, {
            kind: "general", constraint: ConstraintType.KeepInFrame, targets: factoryWorkers, allFrames: true,
          }],
        },
      ]),
    }],
  },
},
...dontCarePromptExampleFixtures,
]

/** Canonical public fixtures; prompt/CSL corrections are applied once. */
export const resolvedPromptExampleFixtures = improveCinematicFixtures(basePromptExampleFixtures);
