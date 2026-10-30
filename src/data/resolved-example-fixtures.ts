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
  return { id, trigger: { type: "absoluteTime", time }, movement: { act, targets: subjects, duration,
      parameters: act === CameraMovementType.DollyIn ? { distance: 1.3, handheld: false }
        : act === CameraMovementType.DollyOut ? { distance: 2.5, handheld: false }
        : act === CameraMovementType.ArcRight ? { arcAngle: 14, arcRadius: 12, constantSpeed: true, handheld: false }
        : { followDelay: 0.1, leadAmount: 0.6, handheld: false } },
    constraints: [
      { kind: "general", constraint: ConstraintType.NoShake, allFrames: true },
      { kind: "general", constraint: ConstraintType.KeepInFrame, targets: subjects, allFrames: true },
      { targets: subjects, config: { type: "subjectAware", shotSize: ShotSize.LongShot }, allFrames: true },
    ] };
}
/** Only two environments. Additional films should reuse environmentId, not clone a scene. */
export const resolvedPromptExampleFixtures: ResolvedPromptExampleFixture[] = [
  { id: "stadium", environmentId: "stadium",
    prompt: "Create a 48-second real-time stadium film. Establish the six runners with a smooth elevated outside-track follow, then transfer attention to runner_03 before the fall at scene 13.7 s and hold the whole body through recovery at 16.8–18 s. Rejoin runner_01 for the finish at 38 s, give the football goal at 38.2 s its own readable coverage, then make a restrained outside arc for the winner's jump at 39.3–40.3 s and the fluttering flower shower. Let the moving flags and splitting finish ribbon add environmental action. Keep transitions collision-safe, the horizon level, and the subjects clear; the visible sideline cameraman is a character, not this filming viewpoint.",
    resolvedCsl: { totalDuration: 48, sections: [{ actions: [
      shot("race_open", 0, 12.3, ["runner_01", "runner_02", "track_cameraman"]),
      shot("fall_and_recovery", 12.3, 6.7, ["runner_03"]),
      shot("race_finish", 19, 19.1, ["runner_01", "runner_02"]),
      shot("simultaneous_goal", 38.1, 1, ["ball", "goal_east"]),
      shot("jump_and_flowers", 39.1, 8.9, ["runner_01"], CameraMovementType.ArcRight),
    ] }] } },
  { id: "factory", environmentId: "factory",
    prompt: "Create a 48-second real-time industrial film. Begin with a controlled product-led track along the moving conveyor, detailed cargo and coordinated robot sweeps. Dolly gently toward worker_a and worker_b during their argument, then widen before the shove at scene 20 s. Keep the collision at 21 s, the six staggered tumbling pieces, and the emergency response readable as one causal sequence. The button press at 21.7 s starts a one-second mechanical deceleration, not an instantaneous freeze. Let rebounds and rolling parts settle before a slow retreat into the crew's response. Stay in the open aisle and below the roof; preserve the line's stopped state while the people continue to react.",
    resolvedCsl: { totalDuration: 48, sections: [{ actions: [
      shot("production", 0, 11, ["cargo_01", "robot_1", "worker_03"], CameraMovementType.Track),
      shot("argument", 11, 9, ["worker_a", "worker_b"], CameraMovementType.DollyIn),
      shot("shove_and_impact", 20, 2.7, ["worker_a", "worker_b", "cargo_01"]),
      shot("fallen_cargo", 22.7, 3.3, ["worker_b", "cargo_01", "cargo_04"]),
      shot("response", 26, 22, ["worker_a", "worker_b", "worker_05"], CameraMovementType.DollyOut),
    ] }] } },
];
