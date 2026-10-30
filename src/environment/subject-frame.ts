import type { Quat, SceneEntityV1 } from "../types/environment";

/** Directional camera constraints use the visible subject's front, independently of its geometry transform. */
export function localSubjectFrame(entity: SceneEntityV1): Quat {
  const visual = entity.visual;
  const presetFacesNegativeZ = visual.type === "preset"
    && (visual.name === "car" || (visual.name === "humanoid" && visual.params?.pose === "driving"));
  const axis = entity.forwardAxis ?? (presetFacesNegativeZ ? "-Z" : "+Z");
  switch (axis) {
    case "+X": return [0, Math.SQRT1_2, 0, Math.SQRT1_2];
    case "-X": return [0, -Math.SQRT1_2, 0, Math.SQRT1_2];
    case "-Z": return [0, 1, 0, 0];
    default: return [0, 0, 0, 1];
  }
}
