import type { Vec3 } from "../../types/environment";
import { DEFAULT_OPTIONS } from "../config/defaults";
import {
  add3,
  cameraForward,
  cameraRight,
  clamp,
  length3,
  lookAtQuaternion,
  normalize3,
  scale3,
  sub3,
} from "../shared/math";
import { asQuat, asVec3 } from "../shared/parameter-values";
import { projectWorldBox } from "../scene/projection";
import {
  findPrimitive,
  isPrimitiveActiveAt,
  samplePrimitiveSubject,
} from "../scene/primitive-context";
import { sampleSubjectAggregate } from "../scene/subjects";
import { playbackToSceneTime } from "../shared/time";
import type {
  CameraOptimizerInput,
  CameraStateSample,
  CompiledLossPlan,
} from "../types";

function firstAvailableSubject(
  input: CameraOptimizerInput,
  plan: CompiledLossPlan,
  playbackTime: number,
) {
  for (const primitive of plan.primitives) {
    const subject = samplePrimitiveSubject(input, primitive, playbackTime);
    if (subject) return subject;
  }

  const fallbackId = input.environment.targets[0]?.id
    ?? input.environment.entities[0]?.id;
  if (!fallbackId) return undefined;
  const sceneTime = playbackToSceneTime(
    playbackTime,
    input.timeline.timeWarp,
    input.environment.clock.durationSeconds,
  );
  return sampleSubjectAggregate(input.environment, [fallbackId], sceneTime);
}

function projectedDistanceForCoverage(
  input: CameraOptimizerInput,
  target: NonNullable<ReturnType<typeof samplePrimitiveSubject>>,
  direction: Vec3,
  fovYDegrees: number,
  targetCoverage: number,
): number {
  const aspectRatio = input.options?.aspectRatio ?? DEFAULT_OPTIONS.aspectRatio;
  let lowerDistance = 0.05;
  let upperDistance = 80;
  for (let iteration = 0; iteration < 36; iteration += 1) {
    const candidateDistance = (lowerDistance + upperDistance) / 2;
    const candidatePosition = add3(target.center, scale3(direction, candidateDistance));
    const projected = projectWorldBox(
      target.box,
      candidatePosition,
      lookAtQuaternion(candidatePosition, target.center),
      fovYDegrees,
      aspectRatio,
    );
    if (projected.behindCamera || projected.height > targetCoverage) {
      lowerDistance = candidateDistance;
    } else {
      upperDistance = candidateDistance;
    }
  }
  return (lowerDistance + upperDistance) / 2;
}

/** Builds the static pose used at the start of a shot or immediately after a cut. */
export function createInitialCameraState(
  input: CameraOptimizerInput,
  plan: CompiledLossPlan,
  initialFovYDegrees: number,
  playbackTime = 0,
): CameraStateSample {
  const fallbackTarget = firstAvailableSubject(input, plan, playbackTime);
  const overview = input.environment.world?.overviewCamera;
  let position: Vec3 = overview
    ? [...overview.position]
    : fallbackTarget
      ? add3(fallbackTarget.center, [
          0,
          Math.max(1, fallbackTarget.box.size[1] * 0.25),
          5,
        ])
      : [0, 2, 5];
  let fovYDegrees = initialFovYDegrees;

  const pointPrimitives = plan.primitives.filter((primitive) =>
    isPrimitiveActiveAt(primitive, playbackTime),
  );
  const viewPrimitive = findPrimitive(pointPrimitives, "subjectView");
  const elevationPrimitive = findPrimitive(pointPrimitives, "subjectElevation");
  const scalePrimitive = findPrimitive(pointPrimitives, "screenScale");
  const semanticTarget = viewPrimitive
    ? samplePrimitiveSubject(input, viewPrimitive, playbackTime)
    : elevationPrimitive
      ? samplePrimitiveSubject(input, elevationPrimitive, playbackTime)
      : scalePrimitive
        ? samplePrimitiveSubject(input, scalePrimitive, playbackTime)
        : fallbackTarget;

  if (semanticTarget) {
    const targetCoverage = typeof scalePrimitive?.parameters.targetCoverage === "number"
      ? scalePrimitive.parameters.targetCoverage
      : 0.35;
    const targetHeight = Math.max(0.2, semanticTarget.box.size[1]);
    let distance = clamp(
      targetHeight / Math.max(
        0.05,
        2 * targetCoverage * Math.tan(fovYDegrees * Math.PI / 360),
      ),
      0.55,
      80,
    );
    const azimuth = typeof viewPrimitive?.parameters.targetAzimuth === "number"
      ? viewPrimitive.parameters.targetAzimuth
      : 0;
    const elevation = typeof elevationPrimitive?.parameters.targetElevation === "number"
      ? elevationPrimitive.parameters.targetElevation
      : 0.1;
    const horizontalDistance = distance * Math.cos(elevation);
    const localDirection: Vec3 = [
      Math.sin(azimuth) * horizontalDistance,
      Math.sin(elevation) * distance,
      Math.cos(azimuth) * horizontalDistance,
    ];
    let worldDirection: Vec3 = viewPrimitive
      ? add3(
          scale3(cameraRight(semanticTarget.rotation), localDirection[0]),
          add3(
            scale3([0, 1, 0], localDirection[1]),
            scale3(scale3(cameraForward(semanticTarget.rotation), -1), localDirection[2]),
          ),
        )
      : [0, localDirection[1], localDirection[2]];

    if (scalePrimitive && semanticTarget.box.size[1] > 1e-6) {
      // Refine the flat-plane estimate against the projection model used by
      // the objective so deep AABBs do not start tighter than requested.
      const direction = normalize3(worldDirection, [0, 0, 1]);
      distance = projectedDistanceForCoverage(
        input,
        semanticTarget,
        direction,
        fovYDegrees,
        targetCoverage,
      );
      worldDirection = scale3(direction, distance);
    }
    position = add3(semanticTarget.center, worldDirection);
  }

  const radiusPrimitive = findPrimitive(pointPrimitives, "radiusHold");
  const requestedRadius = radiusPrimitive?.parameters.targetRadius;
  const radiusTarget = radiusPrimitive
    ? samplePrimitiveSubject(input, radiusPrimitive, playbackTime)
    : undefined;
  if (radiusTarget && typeof requestedRadius === "number") {
    const relative = sub3(position, radiusTarget.center);
    const horizontalDirection = normalize3([relative[0], 0, relative[2]], [0, 0, 1]);
    position = [
      radiusTarget.center[0] + horizontalDirection[0] * requestedRadius,
      position[1],
      radiusTarget.center[2] + horizontalDirection[2] * requestedRadius,
    ];

    // A requested orbit radius owns camera position, so the lens absorbs any
    // simultaneous shot-size request.
    if (semanticTarget && scalePrimitive) {
      const targetCoverage = typeof scalePrimitive.parameters.targetCoverage === "number"
        ? scalePrimitive.parameters.targetCoverage
        : 0.35;
      const targetHeight = Math.max(0.2, semanticTarget.box.size[1]);
      const distance = Math.max(0.05, length3(sub3(position, semanticTarget.center)));
      fovYDegrees = clamp(
        2 * Math.atan(
          targetHeight / Math.max(0.05, 2 * targetCoverage * distance),
        ) * 180 / Math.PI,
        8,
        120,
      );
    }
  }

  const positionAnchor = findPrimitive(pointPrimitives, "positionAnchor");
  const anchoredPosition = asVec3(positionAnchor?.parameters.target);
  if (anchoredPosition) position = anchoredPosition;

  const lookTarget = semanticTarget?.center
    ?? overview?.target
    ?? add3(position, [0, 0, -1]);
  let rotation = lookAtQuaternion(position, lookTarget);
  const rotationAnchor = findPrimitive(pointPrimitives, "rotationAnchor");
  const anchoredRotation = asQuat(rotationAnchor?.parameters.target);
  const anchoredLookAt = asVec3(rotationAnchor?.parameters.lookAt);
  if (anchoredRotation) rotation = anchoredRotation;
  else if (anchoredLookAt) rotation = lookAtQuaternion(position, anchoredLookAt);

  const fovAnchor = findPrimitive(pointPrimitives, "fovAnchor");
  const anchoredFov = fovAnchor?.parameters.target;
  return {
    time: playbackTime,
    position,
    rotation,
    fovYDegrees: typeof anchoredFov === "number" ? anchoredFov : fovYDegrees,
  };
}
