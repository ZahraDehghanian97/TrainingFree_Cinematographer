import type { EnvironmentQuery } from "../types/environment-query";

export interface EnvironmentQueryExample {
  environmentId: string;
  request: string;
  expectedQuery: EnvironmentQuery;
}

export const environmentQueryExamples: EnvironmentQueryExample[] = [
  {
    environmentId: "example-01-football",
    request: "باکس توپ در ثانیه ۳ کجاست؟",
    expectedQuery: { type: "subjectBoxesAtTime", subjectIds: ["ball"], timeSeconds: 3 },
  },
  {
    environmentId: "example-03-vase-reveal",
    request: "در ثانیه ۲.۵ باکس گلدون و مانیتور رو بده",
    expectedQuery: { type: "subjectBoxesAtTime", subjectIds: ["vase", "monitor"], timeSeconds: 2.5 },
  },
  {
    environmentId: "example-16-two-actor-truck",
    request: "باکس هر دو بازیگر رو از ثانیه ۲ تا ۶ توی یک لیست بده",
    expectedQuery: {
      type: "subjectBoxesInRange",
      subjectIds: ["actor_a", "actor_b"],
      startTimeSeconds: 2,
      endTimeSeconds: 6,
    },
  },
  {
    environmentId: "example-01-football",
    request: "از ثانیه ۱ تا ۴ هر نیم ثانیه bbox توپ رو بده",
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
    request: "کی person a به یک متری person b رسید؟",
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
    request: "runner چه زمانی به سرعت ۸ متر بر ثانیه می‌رسه؟",
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
    request: "باکس چشم رو بین ثانیه ۳ تا ۴ با فاصله نمونه‌برداری ۰.۲۵ ثانیه بده",
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
    request: "در ثانیه ۸ باکس کارآگاه و مهاجم پشت ستون رو بده",
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
      reason: "The request is outside the supported environment query operations.",
    },
  },
];
