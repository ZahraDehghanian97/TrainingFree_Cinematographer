import type { Target } from "../types/camera";
import {
  CameraMovementType,
  ShotSize,
  SubjectInFramePosition,
} from "../types/enums";
import type { ResolvedPromptExampleFixture } from "./resolved-example-fixtures";

export interface DontCarePromptExampleFixture extends ResolvedPromptExampleFixture {
  title: string;
  /** Existing scene reused so prompt changes can be compared on identical motion. */
  sourceExampleId: string;
  /** What to inspect when playing the optimized camera in the visualizer. */
  explanation: string;
}

const dancer: Target = { id: "dancer", description: "رقصنده" };
const dancerFace: Target = { id: "dancer_face", description: "صورت رقصنده" };
const agentA: Target = { id: "actor_a", description: "مأمور الف" };
const agentB: Target = { id: "actor_b", description: "مأمور ب" };
const runner: Target = { id: "runner", description: "دونده" };

/**
 * Sparse, executable reference CSL: omitted properties represent don't-care.
 * Durations come from the scene clock; time-zero triggers only start the action.
 * These fixtures intentionally contain no generated initial poses or framing.
 */
export const dontCarePromptExampleFixtures: DontCarePromptExampleFixture[] = [
  {
    id: "example-24",
    environmentId: "example-24-dont-care-arc",
    sourceExampleId: "example-15",
    title: "پارامترهای آزاد: چرخش ساده",
    prompt: "در مسیری قوسی دور رقصنده بچرخ.",
    explanation: "شعاع، مقدار چرخش، دوربین آغازین و قاب‌بندی آزادند. حرکت باید دیده شود و رقصنده از قاب خارج یا بیش‌ازحد کوچک نشود.",
    resolvedCsl: {
      totalDuration: 10,
      sections: [{
        actions: [{
          id: "orbit_dancer_free",
          trigger: { type: "absoluteTime", time: 0 },
          movement: { act: CameraMovementType.Orbit, targets: [dancer] },
        }],
      }],
    },
  },
  {
    id: "example-25",
    environmentId: "example-25-dont-care-radius",
    sourceExampleId: "example-15",
    title: "پارامترهای آزاد: چرخش با شعاع مشخص",
    prompt: "در مسیری قوسی با شعاع ۴ متر دور رقصنده بچرخ.",
    explanation: "با مثال ۲۴ مقایسه کنید: فقط شعاع ۴ متر صریح شده است؛ مقدار چرخش، قاب‌بندی و دوربین آغازین همچنان آزادند.",
    resolvedCsl: {
      totalDuration: 10,
      sections: [{
        actions: [{
          id: "orbit_dancer_radius",
          trigger: { type: "absoluteTime", time: 0 },
          movement: {
            act: CameraMovementType.Orbit,
            targets: [dancer],
            parameters: { arcRadius: 4 },
          },
        }],
      }],
    },
  },
  {
    id: "example-26",
    environmentId: "example-26-dont-care-framing",
    sourceExampleId: "example-15",
    title: "پارامترهای آزاد: سوژه در راست قاب با اندازهٔ نمای آزاد",
    prompt: "در مسیری قوسی به چپ دور رقصنده بچرخ و او را سمت راست قاب نگه دار.",
    explanation: "تنها جای سوژه در قاب تعیین شده است. رقصنده باید سمت راست بماند؛ اندازهٔ نما و شعاع مسیر قوسی را بهینه‌ساز انتخاب می‌کند.",
    resolvedCsl: {
      totalDuration: 10,
      sections: [{
        actions: [{
          id: "arc_dancer_right_framing",
          trigger: { type: "absoluteTime", time: 0 },
          movement: { act: CameraMovementType.ArcLeft, targets: [dancer] },
          constraints: [{
            targets: [dancer],
            config: {
              type: "subjectAware",
              subjectFraming: { position: SubjectInFramePosition.Right },
            },
            allFrames: true,
          }],
        }],
      }],
    },
  },
  {
    id: "example-27",
    environmentId: "example-27-dont-care-closeup",
    sourceExampleId: "example-15",
    title: "پارامترهای آزاد: نمای نزدیک صورت",
    prompt: "در مسیری قوسی به چپ دور رقصنده بچرخ و صورتش را در نمای نزدیک نگه دار.",
    explanation: "نمای نزدیک صورت صریح است؛ نمایش کامل بدن نباید به صورت تحمیل شود. جای صورت در قاب، شعاع و مقدار چرخش تعیین نشده‌اند.",
    resolvedCsl: {
      totalDuration: 10,
      sections: [{
        actions: [{
          id: "arc_dancer_face_closeup",
          trigger: { type: "absoluteTime", time: 0 },
          movement: { act: CameraMovementType.ArcLeft, targets: [dancer] },
          constraints: [{
            targets: [dancerFace],
            config: { type: "subjectAware", shotSize: ShotSize.CloseUp },
            allFrames: true,
          }],
        }],
      }],
    },
  },
  {
    id: "example-28",
    environmentId: "example-28-dont-care-truck",
    sourceExampleId: "example-15",
    title: "پارامترهای آزاد: حرکت جانبی با سوژهٔ مشخص",
    prompt: "با حرکت جانبی دوربین به راست از رقصنده فیلم بگیر.",
    explanation: "سوژه فقط در قید آگاه از سوژه معرفی شده و قاب‌بندی خالی است. ترجیح دیده‌شدن رقصنده باید فعال شود و مقدار حرکت جانبی آزاد بماند.",
    resolvedCsl: {
      totalDuration: 10,
      sections: [{
        actions: [{
          id: "truck_right_dancer",
          trigger: { type: "absoluteTime", time: 0 },
          movement: { act: CameraMovementType.TruckRight },
          constraints: [{
            targets: [dancer],
            config: { type: "subjectAware" },
            allFrames: true,
          }],
        }],
      }],
    },
  },
  {
    id: "example-29",
    environmentId: "example-29-dont-care-follow",
    sourceExampleId: "example-17",
    title: "پارامترهای آزاد: دنبال‌کردن دونده با سرعت متغیر",
    prompt: "دونده را دنبال کن.",
    explanation: "در مسیر بلند و با تغییر سرعت دونده، بدون تعیین فاصله، زاویه، اندازهٔ نما یا دوربین آغازین، او باید در قاب قابل‌دیدن بماند.",
    resolvedCsl: {
      totalDuration: 11,
      sections: [{
        actions: [{
          id: "follow_runner_free",
          trigger: { type: "absoluteTime", time: 0 },
          movement: { act: CameraMovementType.Follow, targets: [runner] },
        }],
      }],
    },
  },
  {
    id: "example-30",
    environmentId: "example-30-dont-care-group",
    sourceExampleId: "example-16",
    title: "پارامترهای آزاد: تعقیب دو سوژهٔ متحرک",
    prompt: "هر دو مأمور را با حرکت دوربین دنبال کن.",
    explanation: "دو مأمور ابتدا از هم دورند، نزدیک می‌شوند و دوباره فاصله می‌گیرند. هر دو باید قابل‌دیدن بمانند؛ اندازهٔ نما و چینش آن‌ها در قاب آزاد است.",
    resolvedCsl: {
      totalDuration: 10,
      sections: [{
        actions: [{
          id: "track_both_agents_free",
          trigger: { type: "absoluteTime", time: 0 },
          movement: { act: CameraMovementType.Track, targets: [agentA, agentB] },
        }],
      }],
    },
  },
  {
    id: "example-31",
    environmentId: "example-31-dont-care-cut",
    sourceExampleId: "example-16",
    title: "پارامترهای آزاد: کات بین دو سوژه",
    prompt: "چهار ثانیه مأمور الف را دنبال کن، سپس کات بزن و مأمور ب را دنبال کن.",
    explanation: "در ثانیهٔ ۴ سوژه عوض می‌شود. هر پلان بدون دوربین آغازین مستقل حل می‌شود و ترجیح دیده‌شدن مأمور الف نباید به پلان مأمور ب منتقل شود.",
    resolvedCsl: {
      totalDuration: 10,
      sections: [
        {
          actions: [{
            id: "follow_agent_a_before_cut",
            trigger: { type: "absoluteTime", time: 0 },
            movement: {
              act: CameraMovementType.Follow,
              targets: [agentA],
              duration: 4,
            },
          }],
        },
        {
          actions: [{
            id: "follow_agent_b_after_cut",
            trigger: { type: "absoluteTime", time: 4 },
            movement: { act: CameraMovementType.Follow, targets: [agentB] },
          }],
        },
      ],
    },
  },
  {
    id: "example-32",
    environmentId: "example-32-dont-care-zoom",
    sourceExampleId: "example-15",
    title: "پارامترهای آزاد: شروع با مشخصات لنز",
    prompt: "با میدان دید ۷۰ درجه شروع کن و روی صورت رقصنده دو برابر زوم کن.",
    explanation: "فقط میدان دید آغازین و ضریب زوم صریح‌اند. موقعیت و جهت دوربین آزاد است؛ صورت از قید بدون قاب‌بندی شناخته می‌شود و باید قابل‌دیدن بماند.",
    resolvedCsl: {
      totalDuration: 10,
      sections: [{
        initCamera: {
          targets: [],
          config: { type: "nonSubjectAware", intrinsics: { fov: 70 } },
        },
        actions: [{
          id: "zoom_dancer_face_free_pose",
          trigger: { type: "absoluteTime", time: 0 },
          movement: {
            act: CameraMovementType.ZoomIn,
            parameters: { zoomFactor: 2 },
          },
          constraints: [{
            targets: [dancerFace],
            config: { type: "subjectAware" },
            allFrames: true,
          }],
        }],
      }],
    },
  },
];
