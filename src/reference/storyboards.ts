import type { EnvironmentV1 } from "../types/environment";
import type { ReferencePlan, ReferenceKnot } from "./types";
const target = (id: string) => ({ ids: [id] });
/** Generic alternative reference utility; the bundled edited references are authored in Python. */
export function referenceStoryboard(number: number, environment?: EnvironmentV1): ReferencePlan {
  const id = environment?.id ?? (number === 1 ? "stadium" : number === 2 ? "factory" : "");
  if (id !== "stadium" && id !== "factory") throw new Error(`Unsupported shared environment: ${id}`);
  const subjects = id === "stadium" ? ["runner_01", "runner_03", "runner_01"] : ["cargo_01", "worker_a", "worker_b"];
  const times = id === "stadium" ? [0, 14, 38, 48] : [0, 14, 21, 48];
  const knots: ReferenceKnot[] = times.map((at, index) => ({
    at, rig: target(subjects[Math.min(index, 2)]!), aim: target(subjects[Math.min(index, 2)]!),
    offset: id === "stadium" ? [8, 5, 12] : [4, 3, 6], fov: 55,
    ...(index > 0 && index < 3 ? { cutBefore: true } : {}),
  }));
  return { version: "1.0", exampleId: id, knots, artisticChoices: ["Authored coverage of the two shared environments."],
    limitations: ["Not optimizer output or a collision-free camera guarantee."] };
}
