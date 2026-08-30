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

## Module layout

```text
optimizer/
├── compiler/          semantic timeline -> primitive loss plan
│   ├── index.ts                 readable compilation pipeline
│   ├── timeline-bands.ts        overlap and easing band construction
│   ├── loss-recipes.ts          high-level loss -> primitive recipes
│   ├── conflict-resolution.ts   compound-shot and channel rules
│   ├── constants.ts             cinematic targets and loss groups
│   ├── global-losses.ts         whole-trajectory regularizers
│   ├── keyframe-recipes.ts      user-authored anchors
│   ├── primitive-store.ts       loss materialization and stable IDs
│   ├── fov-targets.ts           fixed zoom-target chaining
│   ├── subjects.ts              target/entity identity helpers
│   └── types.ts                 compiler-private contracts
├── config/            defaults, option resolution, and validation
├── initialization/    base pose, motion steps, and orientation transitions
├── scene/             subjects, projection, and spatial queries
├── solver/            objective evaluation and numerical refinement
├── trajectory/        output interpolation and trajectory construction
├── shared/            math, time, keyframe, and parameter helpers
├── index.ts           public optimization pipeline
└── types.ts           public optimizer contracts
```

Each folder exposes or contains one pipeline responsibility. Cross-stage helpers
live in `shared/`; scene sampling stays isolated from solver and output logic.

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
- Level-horizon constraints replace simultaneous roll holds.
- Under-constrained yaw/pitch holds are strengthened when no semantic loss owns that axis.
- Off-center framing -> centered look-at stabilizers are released.
- Static releases only channels explicitly driven by simultaneous movement.
- Targeted Static shots remain mounted in the subject's translating frame;
  untargeted Static shots remain locked in world space.
- Targeted Dolly/Crane translations and global path regularizers measure
  camera motion relative to inherited subject translation.
- `allowSubjectIntersection` explicitly permits an interior/exit move through
  its targeted subject without disabling collision checks for other geometry.
- Zoom sub-bands share fixed compile-time FOV targets instead of deriving a
  moving target from the state currently being optimized.
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
easing boundaries, cuts, user-keyframe times, and adaptive arc samples that keep
orbit steps at or below 15 degrees. Position uses time-aware cubic Hermite
resampling within each cut segment, FOV remains linear, and quaternion
orientation uses shortest-arc SLERP. Dense output therefore does not turn a
coarse orbit into a polygon or interpolate toward a post-cut pose.

Refinement uses deterministic simultaneous-perturbation gradient estimates,
Adam scaling, cut-aware temporal filtering, and monotone backtracking. The
filter removes high-frequency cross-talk from whole-trajectory perturbations
without coupling separate shots. Objective-evaluation count is independent of
the number of free variables. The solver retains the best finite state and
never returns a worse state than initialization. Rejected-step exhaustion is
reported as `stalled`, not `converged`. Defaults are 3 Hz plus adaptive arc
samples, 5000 iterations, environment `fpsHint` for output, and a fixed seed.

Scene time is obtained by integrating timeline rate segments over the camera
playback clock. Target centers, rotated/scaled bounds, subject orientation,
ground, collision, and occlusion therefore follow the 4D scene during frozen,
slow, or fast playback. Follow/Track interpret `followDelay` and `leadAmount`
as seconds and sample the subject at `playbackTime + leadAmount - followDelay`.
