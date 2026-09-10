import type { EnvironmentQuery } from "../types/environment-query";

export interface EnvironmentQueryExample {
  environmentId: string;
  request: string;
  expectedQuery: EnvironmentQuery;
}

export const environmentQueryExamples: EnvironmentQueryExample[] = [
  {
    environmentId: "example-18-eye-zoom",
    request: "مرجع pupil_ref با توصیف «مردمک سوژه» را به سوژهٔ متناظر در محیط متصل کن.",
    expectedQuery: {
      type: "resolveSubjectReferences",
      bindings: [{ ref: "pupil_ref", status: "resolved", subjectIds: ["pupil"] }],
    },
  },
  {
    environmentId: "example-03-vase-reveal",
    request: "مرجع vase_ref برای گلدان و مرجع monitor_ref برای مانیتور را به سوژه‌های متناظر در محیط متصل کن.",
    expectedQuery: {
      type: "resolveSubjectReferences",
      bindings: [
        { ref: "vase_ref", status: "resolved", subjectIds: ["vase"] },
        { ref: "monitor_ref", status: "resolved", subjectIds: ["monitor"] },
      ],
    },
  },
  {
    environmentId: "example-01-football",
    request: "جعبهٔ مرزی توپ در ثانیه ۳ کجاست؟",
    expectedQuery: { type: "subjectBoxesAtTime", subjectIds: ["ball"], timeSeconds: 3 },
  },
  {
    environmentId: "example-03-vase-reveal",
    request: "در ثانیه ۲.۵ جعبهٔ مرزی گلدون و مانیتور رو بده",
    expectedQuery: { type: "subjectBoxesAtTime", subjectIds: ["vase", "monitor"], timeSeconds: 2.5 },
  },
  {
    environmentId: "example-16-two-actor-truck",
    request: "جعبهٔ مرزی هر دو بازیگر رو از ثانیه ۲ تا ۶ توی یک لیست بده",
    expectedQuery: {
      type: "subjectBoxesInRange",
      subjectIds: ["actor_a", "actor_b"],
      startTimeSeconds: 2,
      endTimeSeconds: 6,
    },
  },
  {
    environmentId: "example-01-football",
    request: "از ثانیه ۱ تا ۴ هر نیم ثانیه جعبهٔ مرزی توپ رو بده",
    expectedQuery: {
      type: "subjectBoxesInRange",
      subjectIds: ["ball"],
      startTimeSeconds: 1,
      endTimeSeconds: 4,
      sampleEverySeconds: 0.5,
    },
  },
  {
    environmentId: "example-01-football",
    request: "توپ اولین بار کی به فاصله ۲ متری دروازه رسید؟",
    expectedQuery: {
      type: "firstWithinDistance",
      subjectAId: "ball",
      subjectBId: "goal",
      distanceMeters: 2,
    },
  },
  {
    environmentId: "example-09-two-people",
    request: "نفر اول چه زمانی به فاصلهٔ یک متری نفر دوم رسید؟",
    expectedQuery: {
      type: "firstWithinDistance",
      subjectAId: "person1",
      subjectBId: "person2",
      distanceMeters: 1,
    },
  },
  {
    environmentId: "example-10-race-car",
    request: "ماشین مسابقه کی به سرعت ۷۲ کیلومتر بر ساعت رسید؟",
    expectedQuery: {
      type: "firstSpeedReached",
      subjectId: "race_car",
      speedMetersPerSecond: 20,
    },
  },
  {
    environmentId: "example-17-runner-speed",
    request: "دونده چه زمانی به سرعت ۸ متر بر ثانیه می‌رسد؟",
    expectedQuery: {
      type: "firstSpeedReached",
      subjectId: "runner",
      speedMetersPerSecond: 8,
    },
  },
  {
    environmentId: "example-16-two-actor-truck",
    request: "فاصله دو بازیگر چند بار دقیقا ۱ متر شده؟",
    expectedQuery: {
      type: "distanceCrossingCount",
      subjectAId: "actor_a",
      subjectBId: "actor_b",
      distanceMeters: 1,
    },
  },
  {
    environmentId: "example-18-eye-zoom",
    request: "جعبهٔ مرزی چشم رو بین ثانیه ۳ تا ۴ با فاصله نمونه‌برداری ۰.۲۵ ثانیه بده",
    expectedQuery: {
      type: "subjectBoxesInRange",
      subjectIds: ["eye"],
      startTimeSeconds: 3,
      endTimeSeconds: 4,
      sampleEverySeconds: 0.25,
    },
  },
  {
    environmentId: "example-19-stairwell-ambush",
    request: "در ثانیه ۸ جعبهٔ مرزی کارآگاه و مهاجم پشت ستون رو بده",
    expectedQuery: {
      type: "subjectBoxesAtTime",
      subjectIds: ["detective", "pursuer"],
      timeSeconds: 8,
    },
  },
  {
    environmentId: "example-03-vase-reveal",
    request: "رنگ دیوار چیه؟",
    expectedQuery: {
      type: "unsupported",
      reason: "این درخواست خارج از پرس‌وجوهای پشتیبانی‌شدهٔ محیط است.",
    },
  },
];
