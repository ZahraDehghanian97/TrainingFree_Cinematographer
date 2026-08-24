# TypeScript camera trajectory optimizer

This module converts a timeline solver result and a matching 4D environment
into `CameraTrajectoryV1`. It has no optimizer-specific runtime dependency.

## Pipeline

```text
FlattenedTimeline + EnvironmentV1 + UserCameraKeyframe[]
  -> active-loss time bands
  -> high-level recipes
  -> semantic conflict resolver
  -> primitive loss plan
  -> compound-aware initialization
  -> dependency-free numerical refinement
  -> position/quaternion/FOV resampling
  -> CameraTrajectoryV1
```

`compileLossPlan()` is public so recipe output can be inspected or tested
without numerical refinement. `optimizeCameraTrajectory()` accepts a flattened
timeline; `optimizeTimelineSolverOutput()` accepts the direct `solveTimeline()`
result. Both return the plan, canonical trajectory, loss breakdown, conflicts,
warnings, and termination diagnostics.

## Primitive vocabulary

- Anchors/holds: `positionAnchor`, `rotationAnchor`, `fovAnchor`,
  `positionHold`, `orientationHold`, `forwardHold`, `yawHold`, `pitchHold`,
  `rollHold`, `fovHold`
- Translation: `axisProgress`, `totalProgressTarget`, `orthogonalDrift`,
  `pathProfile`, `stepPacing`, `stepSmoothness`
- Arc/rotation: `angularProgress`, `angularDirection`, `angularPacing`,
  `planeHold`, `radiusHold`, `radiusSchedule`, `rollProgress`, `rollTarget`,
  `levelHorizon`
- Composition: `lookAt`, `screenPosition`, `bboxInFrame`, `screenScale`,
  `subjectView`, `subjectElevation`
- Subject motion: `distanceHold`, `relativeOffsetHold`, `bearingHold`,
  `elevationHold`, `velocityMatch`
- Lens: `intrinsicsProgress`, `intrinsicsPacing`
- Safety/regularity: `collisionClearance`, `nearPlaneClearance`, `occlusion`,
  `heightAboveGround`, `groundClearance`, `accelerationSmoothness`,
  `angularAccelerationSmoothness`,
  `jerkSmoothness`, `pathLength`

Every residual is divided by a domain tolerance before its independent weight
is applied. This keeps meters, radians, normalized frame coordinates, and FOV
degrees compatible.

## High-level coverage

Recipes cover every movement in `CameraMovementType`, including Crane, Zoom,
Dutch, Follow, Track, Orbit, Pan/Tilt, Truck, Pedestal, Dolly, Arc, and Static.
Framing covers shot sizes, all nine frame positions, subject-relative views,
vertical camera angles, projected bounds, and Dutch framing scale. General
constraints cover no-shake, keep-in-frame, distance/angle maintenance,
occlusion, ground clearance, collision, smoothness, and minimum path.

Shot size uses projected subject bounds rather than a distance proxy.
FramingPosition uses the requested normalized screen location. SubjectView is
relative to the sampled entity quaternion; entity-local `+Z` denotes its front
direction.

## Compound rules

- Arc + Dolly -> spiral `radiusSchedule`; constant radius and linear drift are removed.
- Arc + Pedestal/Crane -> helical/crane arc; constant horizontal plane is removed.
- Follow + Dolly -> radial follow; fixed relative offset is removed.
- Translation + Pan/Tilt/Dutch/Zoom -> position-hold stabilizers are released.
- Explicit rotation/composition -> incompatible orientation holds are released.
- Dutch -> level-horizon is released.
- Off-center framing -> centered look-at stabilizers are released.
- Static releases only channels explicitly driven by simultaneous movement.
- Smoothness and interpolation never bridge section/user cuts.

## User keyframes

```ts
interface UserCameraKeyframe {
  id?: string;
  time: number;
  mode?: "hard" | "soft"; // default hard
  weight?: number;         // soft only
  position?: [number, number, number];
  rotation?: [number, number, number, number]; // xyzw
  lookAt?: [number, number, number];
  up?: [number, number, number];
  fovYDegrees?: number;
  cutBefore?: boolean;
}
```

Hard channels are removed from the free numerical state and re-applied after
every decode. They remain exact even if they conflict with safety or semantic
terms; diagnostics report remaining safety cost. Conflicting hard values at the
same time/channel fail validation.

## Numerical method

The state grid contains uniform optimization samples plus timeline boundaries,
easing boundaries, cuts, and user-keyframe times. Position and FOV are linearly
resampled; quaternion orientation uses shortest-arc SLERP, matching the viewer.

Refinement uses deterministic simultaneous-perturbation gradient estimates,
Adam scaling, and monotone backtracking. Objective-evaluation count is
independent of the number of free variables. The solver retains the best finite
state and never returns a worse state than initialization. Defaults are 3 Hz,
120 iterations, environment `fpsHint` for output, and a fixed seed.

Scene time is obtained by integrating timeline rate segments over the camera
playback clock. Target centers, rotated/scaled bounds, subject orientation,
ground, collision, and occlusion therefore follow the 4D scene during frozen,
slow, or fast playback. Follow/Track interpret `followDelay` and `leadAmount`
as seconds and sample the subject at `playbackTime + leadAmount - followDelay`.
