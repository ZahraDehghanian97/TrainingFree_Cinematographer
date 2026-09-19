import type { Action, ResolvedCameraDirectionDSL } from "../types/dsl";
import { CameraMovementType, ConstraintType, ShotSize } from "../types/enums";

export interface ResolvedPromptExampleFixture {
  id: string;
  environmentId: string;
  prompt: string;
  resolvedCsl: ResolvedCameraDirectionDSL;
}
const descriptions: Record<string,string> = {
 runner_01:"دوندهٔ اول، برندهٔ مسابقه", runner_02:"دوندهٔ دوم با لباس آبی", runner_03:"دوندهٔ سوم که زمین می‌خورد",
 track_cameraman:"فیلم‌بردار مستقل که کنار پیست می‌دود", ball:"توپ فوتبال", goal_east:"دروازهٔ شرقی فوتبال",
 cargo_01:"اولین قطعهٔ تولید که از ریل می‌افتد", cargo_04:"چهارمین قطعهٔ تولید که می‌افتد", robot_1:"بازوی مونتاژ اول",
 worker_a:"کارگر الف که دیگری را هل می‌دهد", worker_b:"کارگر ب که به خط تولید برخورد می‌کند",
 worker_03:"کارگر خط تولید سوم", worker_05:"کارگر مسئول توقف اضطراری",
};
function shot(id: string, time: number, duration: number, targets: string[], act = CameraMovementType.Follow): Action {
  const subjects = targets.map(id => ({ id, description: descriptions[id] ?? id }));
  return { id, trigger: { type: "absoluteTime", time }, movement: { act, targets: subjects, duration },
    constraints: [
      { kind: "general", constraint: ConstraintType.NoShake, allFrames: true },
      { kind: "general", constraint: ConstraintType.KeepInFrame, targets: subjects, allFrames: true },
      { targets: subjects, config: { type: "subjectAware", shotSize: ShotSize.LongShot }, allFrames: true },
    ] };
}
/** Only two environments. Additional films should reuse environmentId, not clone a scene. */
export const resolvedPromptExampleFixtures: ResolvedPromptExampleFixture[] = [
  { id: "stadium", environmentId: "stadium",
    prompt: "مسابقهٔ شش دونده را در پیست دور زمین فوتبال دنبال کن؛ زمین‌خوردن دوندهٔ سوم، برد دوندهٔ اول در ثانیهٔ ۳۸، گل فوتبال در ۳۸٫۲ و سپس پرش برنده و گل‌افشانی را نشان بده. فیلم‌بردار کنار زمین شخصیت مستقلی است.",
    resolvedCsl: { totalDuration: 48, sections: [{ actions: [
      shot("race_open", 0, 12.3, ["runner_01", "runner_02", "track_cameraman"]),
      shot("fall_and_recovery", 12.3, 6.7, ["runner_03"]),
      shot("race_finish", 19, 19.1, ["runner_01", "runner_02"]),
      shot("simultaneous_goal", 38.1, 1, ["ball", "goal_east"]),
      shot("jump_and_flowers", 39.1, 8.9, ["runner_01"], CameraMovementType.ArcRight),
    ] }] } },
  { id: "factory", environmentId: "factory",
    prompt: "کارخانهٔ فعال و حرکت قطعات روی خط تولید را معرفی کن؛ مشاجرهٔ دو کارگر، هل‌دادن در ثانیهٔ ۲۰، برخورد به ریل و ریزش وسایل در ۲۱، توقف اضطراری و واکنش همکاران را ثبت کن.",
    resolvedCsl: { totalDuration: 48, sections: [{ actions: [
      shot("production", 0, 11, ["cargo_01", "robot_1", "worker_03"], CameraMovementType.Track),
      shot("argument", 11, 9, ["worker_a", "worker_b"], CameraMovementType.DollyIn),
      shot("shove_and_impact", 20, 2.7, ["worker_a", "worker_b", "cargo_01"]),
      shot("fallen_cargo", 22.7, 3.3, ["worker_b", "cargo_01", "cargo_04"]),
      shot("response", 26, 22, ["worker_a", "worker_b", "worker_05"], CameraMovementType.DollyOut),
    ] }] } },
];
