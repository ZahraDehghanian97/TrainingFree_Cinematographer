import type { UserCameraKeyframe } from "../types";
import type { PrimitiveDescriptor } from "./types";

export function descriptorsForUserKeyframe(keyframe: UserCameraKeyframe): PrimitiveDescriptor[] {
  const shared = { hard: (keyframe.mode ?? "hard") === "hard", keyframeTime: keyframe.time };
  const descriptors: PrimitiveDescriptor[] = [];
  if (keyframe.position) descriptors.push({
    type: "positionAnchor",
    channel: "position",
    role: "primary",
    parameters: { ...shared, target: keyframe.position },
  });
  if (keyframe.rotation) descriptors.push({
    type: "rotationAnchor",
    channel: "rotation",
    role: "primary",
    parameters: { ...shared, target: keyframe.rotation },
  });
  if (keyframe.lookAt) descriptors.push({
    type: "rotationAnchor",
    channel: "rotation",
    role: "primary",
    parameters: { ...shared, lookAt: keyframe.lookAt },
  });
  if (keyframe.fovYDegrees !== undefined) descriptors.push({
    type: "fovAnchor",
    channel: "intrinsics",
    role: "primary",
    parameters: { ...shared, target: keyframe.fovYDegrees },
  });
  return descriptors;
}

