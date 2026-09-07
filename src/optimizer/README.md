# TypeScript camera trajectory optimizer

This module converts a timeline solver result and a matching 4D environment
into `CameraTrajectoryV1`. It has no optimizer-specific runtime dependency.

## Pipeline

```text
FlattenedTimeline + EnvironmentV1 + UserCameraKeyframe[]
  -> active-loss time bands
  -> high-level recipes
  -> semantic conflict resolver
  -> subject visibility and scale preferences
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
│   ├── subject-quality.ts       per-subject visibility and scale preferences
│   ├── motion-transitions.ts    automatic motion handoff windows
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
  `subjectVisibility`, `subjectScaleFloor`, `subjectView`, `subjectElevation`
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

Non-subject-aware configs accept independently optional pose position and
rotation, lens-only settings, and `lookAt` without a pose. They also accept a
rigid camera-to-world `transformMatrix` in
row-major order, with translation in the last column. A supplied matrix overrides
`pose`; matrices containing scale, shear, reflection, or perspective fail explicitly.
The optimizer reads `intrinsics.aspectRatio` from these configs and uses it for
projection, trajectory output, and the visualizer's director view. A trajectory
uses one aspect ratio: conflicting configs require an explicit `options.aspectRatio`
override, which takes precedence over the DSL. Otherwise the default is 16:9.

Dutch and Track movements preserve authored speed keyframes, including when an
unrelated constraint splits their action into multiple optimizer bands.

Shot size uses projected subject bounds rather than a distance proxy.
FramingPosition uses the requested normalized screen location. SubjectView is
relative to the sampled entity quaternion; entity-local `+Z` denotes its front
direction.

## Unspecified camera intent

An omitted CSL field means **don't care**. The compiler keeps missing radius,
distance, sweep, rotation amount, zoom factor, pose, lens, framing, path shape,
and speed profile absent. Explicit amounts, including zero where valid, produce
their requested targets. `arcLeft` and `arcRight` preserve their direction even
without a sweep; bare `orbit` leaves both direction and sweep free. Only an
explicit full turn supplies a 360-degree target.

A subject-aware config may contain only targets and its `type`. The timeline
retains that identity as `subjectPresence` metadata so quality preferences and
initialization still refer to the requested subject without inventing framing.

The named move still defines its geometry and stable channels. Arc keeps a
horizontal plane and constant radius, with that radius measured from the
candidate camera when unspecified. Follow preserves a subject-relative offset,
Track can hold a freely chosen distance, Pan/Tilt keep their inactive rotation
axes steady, Zoom keeps the camera pose steady, and Static holds its active
channels. These holds compare optimized camera states; they do not anchor the
camera to a guessed starting position, radius, lens, or roll angle. Concurrent
authored movement can release those holds through the compound rules below.

For an omitted movement amount, translation, angle, and zoom objectives use
one-sided minimum-progress penalties. They penalize a move that collapses to no
motion and stop penalizing its amount once the minimum is reached. They do not
request an exact replacement distance, sweep, or zoom factor. Authored path and
speed profiles apply to the whole source action even when other constraints
split it into multiple bands. Without an authored profile, no exact linear path
or uniform pacing target is added. Numerical initialization chooses a feasible
starting candidate using seed constants and scene bounds; those values are
never promoted into compiler targets.

`subjectVisibility` softly penalizes a relevant subject falling outside the
frustum or behind the camera, including overflow of its projected bounds.
`subjectScaleFloor` penalizes projected subject height below a useful minimum.
Both have a zero-loss region that leaves composition, distance, and view free.
They apply per target and time for subject-anchored movement and supported
subject framing intent. They do not impose centered composition or a medium
shot.

Explicit shot size overrides the scale floor for the same subject and time and
relaxes bounding-box overflow to allow intentional cropping; subject-center
visibility still applies. Entity identity associates an anchor and its parent
subject for this override. Explicit camera orientation or non-subject-aware
`lookAt` suppresses these fallback preferences in its active window. Exact point
constraints and easing windows affect only their own times. Explicit off-center
framing remains compatible with visibility inside the frame.
Automatic occlusion is also scoped to each active subject and its time window;
subjects from other shots do not contribute a visibility objective.

The public quality controls are soft objective parameters:

| `OptimizerOptions` field | Default | Meaning |
| --- | --- | --- |
| `minimumSubjectCoverage` | `0.12` | Minimum projected subject height as a fraction of frame height |
| `minimumMovementDistance` | `0.25` | Minimum progress in meters when distance is unspecified |
| `minimumMovementAngleDegrees` | `8` | Minimum sweep or rotation when the angle is unspecified |
| `minimumZoomChangeDegrees` | `2` | Minimum FOV change when the zoom factor is unspecified |
| `weights.subjectVisibility` | `2.5` | Weight of fallback frustum and bounds visibility |
| `weights.subjectScaleFloor` | `2.5` | Weight of fallback minimum subject size |

These preferences improve the objective available to the optimizer; they do
not guarantee a particular visual result or satisfy every conflicting request.
The numerical solver's loss breakdown and termination diagnostics remain the
way to inspect unresolved costs.

The environment still supplies total playback duration. The timeline scheduler
deterministically allocates omitted action durations before optimization.
Follow/Track sample the contemporaneous subject unless lead or delay is authored;
temporal offsets are not additional numerical state variables.
Sampling and output resolution, projection calibration, aspect ratio, and
safety margins retain their infrastructure defaults. For example, output FPS
uses the environment hint, aspect ratio falls back to 16:9, and collision and
near-plane clearance stay enabled. Such execution settings are separate from
an authored camera pose or composition target.

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
- Zoom sub-bands refer to the same source-action camera endpoints. An explicit
  factor constrains their FOV ratio while leaving the absolute starting FOV
  free; an omitted factor uses the minimum-change preference. No compile-time
  lens target is derived from the initialization seed.
- Smoothness and interpolation never bridge section/user cuts.
- Changes of motion within a shot get an automatic transition window (one second
  by default, shortened for nearby boundaries). `options.motionTransitionSeconds`
  controls its total duration; zero disables it. Local action constraints ease
  near the handoff and the initial trajectory blends incoming/outgoing velocity.
  Aggregate distance/angle/zoom targets and safety weights retain full strength.
  Extra optimization samples resolve short windows. Hard keyframes stay exact;
  a channel with a hard keyframe inside a window keeps its original seed.
- Output position, rotation, and FOV share tangents across sample boundaries,
  keeping velocity continuous within shots. Height and FOV remain bounded by
  their neighboring samples; zoom reversals retain their lens extremum.
- Acceleration and jerk use one subject reference for each derivative window.
  When that reference changes, the entire window uses world coordinates so a
  real camera speed jump cannot be hidden by switching moving subjects.

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
