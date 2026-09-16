import type { Quat, Vec3 } from "../../types/environment";
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
import { asVec3 } from "../shared/parameter-values";
import {
  findPrimitive,
  isPrimitiveActiveAt,
  samplePrimitiveSubject,
} from "../scene/primitive-context";
import { sampleSubjectAggregate } from "../scene/subjects";
import { playbackToSceneTime } from "../shared/time";
import { applyCompositionOrientation } from "./motion-step";
import { projectedDistanceForCoverage } from "./framing-distance";
import type { SeedChoices } from "./seed-defaults";
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
  const active = plan.primitives.filter((primitive) => isPrimitiveActiveAt(primitive, playbackTime))
    .sort((a, b) => b.startTime - a.startTime || a.id.localeCompare(b.id));
  for (const primitive of [...active, ...plan.primitives]) {
    const subject = samplePrimitiveSubject(input, primitive, playbackTime);
    if (subject) return subject;
  }

  const fallbackId = input.environment.semanticAnchors[0]?.id
    ?? input.environment.entities[0]?.id;
  if (!fallbackId) return undefined;
  const sceneTime = playbackToSceneTime(
    playbackTime,
    input.timeline.timeWarp,
    input.environment.clock.durationSeconds,
  );
  return sampleSubjectAggregate(input.environment, [fallbackId], sceneTime);
}

/** Builds the static pose used at the start of a shot or immediately after a cut. */
export function createInitialCameraState(
  input: CameraOptimizerInput,
  plan: CompiledLossPlan,
  initialFovYDegrees: number,
  playbackTime = 0,
  pointOrientationBaselines: Map<string, Quat> = new Map(),
  choices: SeedChoices = {},
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
  let fovYDegrees = choices.fovYDegrees ?? initialFovYDegrees;

  const pointPrimitives = plan.primitives.filter((primitive) =>
    isPrimitiveActiveAt(primitive, playbackTime),
  ).sort((a, b) => b.startTime - a.startTime || a.id.localeCompare(b.id));
  const viewPrimitive = findPrimitive(pointPrimitives, "subjectView");
  const elevationPrimitive = findPrimitive(pointPrimitives, "subjectElevation");
  const scalePrimitive = findPrimitive(pointPrimitives, "screenScale");
  const compositionPrimitive = findPrimitive(pointPrimitives, "screenPosition")
    ?? findPrimitive(pointPrimitives, "lookAt");
  const semanticTarget = viewPrimitive
    ? samplePrimitiveSubject(input, viewPrimitive, playbackTime)
    : elevationPrimitive
      ? samplePrimitiveSubject(input, elevationPrimitive, playbackTime)
      : scalePrimitive
        ? samplePrimitiveSubject(input, scalePrimitive, playbackTime)
        : compositionPrimitive
          ? samplePrimitiveSubject(input, compositionPrimitive, playbackTime)
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
      : choices.azimuth ?? 0;
    const elevation = typeof elevationPrimitive?.parameters.targetElevation === "number"
      ? elevationPrimitive.parameters.targetElevation
      : choices.elevation ?? 0.1;
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
      : localDirection;

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
        { allowNearPlaneLimited: true },
      );
      worldDirection = scale3(direction, distance);
    }
    if (!scalePrimitive) worldDirection = scale3(worldDirection, choices.distanceScale ?? 1);
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
  const rotation = lookAtQuaternion(position, lookTarget);

  const fovAnchor = findPrimitive(pointPrimitives, "fovAnchor");
  const anchoredFov = fovAnchor?.parameters.target;
  const state = {
    time: playbackTime,
    position,
    rotation,
    fovYDegrees: typeof anchoredFov === "number" ? anchoredFov : fovYDegrees,
  };
  applyCompositionOrientation(state, input, plan, pointOrientationBaselines);
  return state;
}
