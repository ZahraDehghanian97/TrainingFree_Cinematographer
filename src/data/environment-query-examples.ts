import type { EnvironmentQuery } from "../types/environment-query";
export interface EnvironmentQueryExample { environmentId: string; request: string; expectedQuery: EnvironmentQuery }
export const environmentQueryExamples: EnvironmentQueryExample[] = [
  { environmentId: "stadium", request: "برنده را به winner_ref متصل کن.", expectedQuery: {
    type: "resolveSubjectReferences", bindings: [{ ref: "winner_ref", status: "resolved", subjectIds: ["runner_01"] }] } },
  { environmentId: "stadium", request: "جعبهٔ مرزی توپ در لحظهٔ گل کجاست؟", expectedQuery: {
    type: "subjectBoxesAtTime", subjectIds: ["ball"], timeSeconds: 38.2 } },
  { environmentId: "stadium", request: "مسیر دوندهٔ زمین‌خورده را از ۱۳ تا ۱۸ هر نیم ثانیه بده.", expectedQuery: {
    type: "subjectBoxesInRange", subjectIds: ["runner_03"], startTimeSeconds: 13, endTimeSeconds: 18, sampleEverySeconds: .5 } },
  { environmentId: "stadium", request: "توپ اولین بار کی به فاصلهٔ دو متری دروازهٔ شرقی رسید؟", expectedQuery: {
    type: "firstWithinDistance", subjectAId: "ball", subjectBId: "goal_east", distanceMeters: 2 } },
  { environmentId: "factory", request: "جعبهٔ مرزی دو کارگر را هنگام برخورد بده.", expectedQuery: {
    type: "subjectBoxesAtTime", subjectIds: ["worker_a", "worker_b"], timeSeconds: 21 } },
  { environmentId: "factory", request: "حرکت قطعات ریخته‌شده را بین ۲۱ تا ۲۵ هر ربع ثانیه بده.", expectedQuery: {
    type: "subjectBoxesInRange", subjectIds: ["cargo_01", "cargo_02", "cargo_03"], startTimeSeconds: 21, endTimeSeconds: 25, sampleEverySeconds: .25 } },
  { environmentId: "factory", request: "کارگر ب چه زمانی به نیم‌متری خط تولید رسید؟", expectedQuery: {
    type: "firstWithinDistance", subjectAId: "worker_b", subjectBId: "production_line", distanceMeters: .5 } },
];
