# TypeScript camera trajectory optimizer

This module converts a timeline solver result and a matching 4D environment
into `CameraTrajectoryV1`. It has no optimizer-specific runtime dependency.

The [implementation report](../../docs/mathematical-fixes.fa.md) records the
mathematical changes, validation, and remaining research limitations in Persian.
The [original audit](../../docs/mathematical-audit.fa.md) preserves the prior
implementation's derivations and counterexamples.

## Pipeline

```text
FlattenedTimeline + EnvironmentV1 + UserCameraKeyframe[]
  -> active-loss time bands
  -> high-level recipes
  -> semantic conflict resolver
  -> subject visibility and scale preferences
  -> primitive loss plan
  -> compound-aware initialization
  -> scene-aware candidate selection
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

Every residual is divided by a scale in its own units before weighting.
The serialized `tolerance` field is a residual scale, not a zero-cost error band
or a hard feasibility tolerance. Endpoint errors and rates use separate scales: meters and meters/second,
radians and radians/second, or log focal ratio and log focal ratio/second.
Authored FOV anchors and FOV holds retain degree-based tolerances.

## Mathematical objective

The optimizer solves a local, nonconvex trajectory problem. For an interval
primitive, its cost has the form

```text
J_k = weight_k / sourceDuration_k
      * sum_i measure_ki * activation_ki * rho(residual_ki / tolerance_ki).
```

`measure` is a temporal quadrature weight or the explicit duration of a step.
Pointwise samples use trapezoidal weights on the actual, potentially irregular
time grid. Derivative samples extend to the edges of their own shot support;
their stencils and quadrature never bridge a cut. Different residual families,
such as an endpoint amount and a rate, are integrated separately. Split bands
retain their original source duration, including generated subject-quality and
occlusion terms, so subdividing an instruction does not duplicate its budget.
This is a numerical approximation of a time integral, not an assertion that
every nonlinear cost is identical at every sampling resolution.

Ordinary semantic and sampled relative-regularity errors use Huber loss with threshold 2 after
normalization. User soft anchors, safety-channel terms, `bboxInFrame`, and world
position acceleration/jerk use a squared penalty. Easing, suppression, and transition activation multiply the
loss outside Huber; they do not change its transition threshold. Point targets
use unit measure rather than division by a zero duration. Nonfinite states or
residuals produce an infinite objective and cannot silently remove a constraint.

`pathLength` is the exception to duration averaging and Huber: it sums
`norm(delta relativePosition) / distanceTolerance`. This is geometric polygonal
length over optimization knots, excluding cuts. It is independent of traversal
speed on a fixed polygon, and approximates the length of the resampled Hermite
curve. A moving reference yields relative path length; this is distinct from
world-space distance traveled.

World acceleration and jerk are analytic derivatives of the same C2 quintic
position curve used for output, browser replay, and collision. Five-point
Gauss-Legendre quadrature integrates their squared polynomial norms exactly
on each unweighted piece; time-varying activation is evaluated numerically.
The local nonlinear solve does not certify a globally minimum-jerk solution.
Angular acceleration remains a sampled SO(3) finite-difference regularizer.

`weights.globalRelativeSmoothness` and `weights.globalRelativeJerk` optionally
add subject-relative divided-difference costs (both default to zero). They
are separate from physical world acceleration/jerk. Relative acceleration uses
the three-knot barycenter; jerk uses the four-knot barycenter. Stencils with a
changing subject reference use world displacements throughout that stencil.

## High-level coverage

Recipes cover every movement in `CameraMovementType`, including Crane, Zoom,
Dutch, Follow, Track, Orbit, Pan/Tilt, Truck, Pedestal, Dolly, Arc, and Static.
Framing covers shot sizes, all nine frame positions, subject-relative views,
vertical camera angles, projected bounds, and Dutch framing scale. General
constraints cover no-shake, keep-in-frame, distance/angle maintenance,
occlusion, ground clearance, collision, smoothness, and minimum path.

Semantic names retain their authored numeric prototypes by default. Applications
can supply accepted regions instead of point targets without changing the DSL:

```ts
options: {
  semanticTargets: {
    shotSizeCoverage: { mediumShot: [0.35, 0.5] },
    framingRegions: { center: { x: [0.45, 0.55], y: [0.45, 0.55] } },
  },
}
```

These example ranges are user conventions, not calibrated cinematic laws.
The residual is distance to the interval/rectangle, with zero cost inside it.
The midpoint is used only to initialize a candidate; it is not a target inside
the accepted region. Invalid names, ranges, or region keys fail validation.

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
Bounds are clipped against the configured near plane before perspective
division; a close subject crossing that plane still contributes its visible
extent. Initialization and the objective use the same near-plane convention.
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
candidate camera when unspecified. Follow preserves an offset from its sampled subject reference,
Track can hold a freely chosen distance, Pan/Tilt keep their inactive rotation
axes steady, Zoom keeps the camera pose steady, and Static holds its active
channels. These holds compare optimized camera states; they do not anchor the
camera to a guessed starting position, radius, lens, or roll angle. Concurrent
authored movement can release passive holds through the compound rules below.
Static's explicit primary holds remain authored intent and may conflict with
another simultaneous instruction.

For an omitted movement amount, translation, angle, and zoom objectives use
one-sided minimum-progress penalties. They penalize a move that collapses to no
motion and stop penalizing its amount once the minimum is reached. They do not
request an exact replacement distance, sweep, or zoom factor. Authored path and
speed profiles apply to the whole source action even when other constraints
split it into multiple bands. Without an authored profile, no exact linear path
or uniform pacing target is added. Numerical initialization chooses a feasible
starting candidate using seed constants and scene bounds; those values are
never promoted into compiler targets.

Initialization evaluates coherent candidates for free starting bearing, lens,
distance, elevation, and movement amounts against the complete scene and loss
plan. This lets an unspecified arc choose a different radius, side, direction
(for bare Orbit), or sweep before local refinement. Authored radii, sweeps,
directions, poses, and framing remain in force. Candidate selection prefers a
collision-free path when one is available; refinement cannot introduce a
clearance violation into that path to lower another cost.

`subjectVisibility` softly penalizes a relevant subject falling outside the
frustum or behind the camera, including overflow of its projected bounds.
`subjectScaleFloor` penalizes projected subject height below a useful minimum.
Both have a zero-loss region that leaves composition, distance, and view free.
They apply per target and time for subject-anchored movement and supported
subject framing intent. They do not impose centered composition or a medium
shot.

Unauthored gaps within a shot retain the last relevant subject, or the first
upcoming subject before any instruction starts. Only visibility and useful
scale carry across the gap; movement and framing targets do not. Explicit
actions and cuts bound this fallback, so a pan or a new shot can change focus.

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
| `minimumDollyDistanceRatio` | `0.3` | Additional free-dolly progress floor as a fraction of the starting camera-to-subject distance |
| `minimumMovementAngleDegrees` | `8` | Minimum pan, tilt, or roll when the angle is unspecified |
| `minimumOrbitAngleDegrees` | `30` | Minimum arc sweep when the angle is unspecified |
| `minimumZoomChangeDegrees` | `2` | Minimum FOV change when the zoom factor is unspecified |
| `weights.subjectVisibility` | `2.5` | Weight of fallback frustum and bounds visibility |
| `weights.subjectScaleFloor` | `2.5` | Weight of fallback minimum subject size |

These values and semantic weight ratios are empirical design preferences;
they are not derived universal laws of cinematography. They improve the
objective available to the optimizer but do not guarantee a particular visual
result or satisfy every conflicting request. Numeric priority scales a soft
weight; it does not create a lexicographic hierarchy of semantic constraints.
The numerical solver's loss breakdown and termination diagnostics remain the
way to inspect unresolved costs.

The environment still supplies total playback duration. The timeline scheduler
deterministically allocates omitted action durations before optimization.
Follow/Track sample the contemporaneous subject unless lead, delay, or a speed
profile is authored. Those reference-clock controls are not additional
numerical state variables.
Sampling and output resolution, projection calibration, aspect ratio, and
safety margins retain their infrastructure defaults. For example, output FPS
uses the environment hint, aspect ratio falls back to 16:9, and collision and
near-plane clearance stay enabled. Such execution settings are separate from
an authored camera pose or composition target.

## Motion clocks and optical zoom

For normalized action time `u`, nonnegative speed multipliers define
`s(u) = integral(0..u, speed) / integral(0..1, speed)`. Constant, linear, and
quadratic pieces are integrated analytically at their authored keyframes;
cached prefix integrals preserve narrow pulses and monotone progress. A
profile with zero total integral is invalid; a hold is expressed as Static.
Omitting the profile leaves pacing free in the objective. The seed still
needs a numerical starting trajectory and uses linear progress by default.

For Follow/Track with a profile, the subject reference is sampled at playback
time `t_ref = start + duration * s(u)` within the source action; outside it the
ordinary playback clock is retained. Lead and delay are added to `t_ref`, then
the result is converted to scene time by integrating playback rates. Offset,
velocity, quality, and automatic occlusion terms share this reference clock.
Velocity matching differentiates that same sampled reference and applies no
second speed multiplier. This can follow a past or future position on the
subject trajectory; it does not retime the actual scene or its obstacles.

Offsets and relative path measurements subtract subject translation in world
axes. They do not use a rotating body-mounted frame. `subjectView` separately
uses the subject's quaternion to measure its local viewing direction.

`zoomFactor` is an optical focal-length ratio. With vertical FOV `phi` in
radians and `z > 0`, zoom-in follows

```text
logFocal = -log(tan(phi / 2))
logFocal(t) = logFocal(start) + s(u) * log(z)
phi(t) = 2 * atan(tan(phi(start) / 2) / z**s(u)).
```

Zoom-out reverses the sign of the log-focal increment. A factor below one
therefore reverses the usual direction, while a factor of one preserves the
lens. The solver, initialization, and output interpolation use this optical
coordinate; public states and hard FOV controls remain in degrees. Explicit
factors constrain the focal ratio and leave the starting lens free.

The path names are compatibility contracts: `curved` is a sinusoidal arch,
and legacy `spline` is a sinusoidal S-bend, not a polynomial spline. An omitted
curve amplitude minimizes the complete weighted radial-Huber and minimum-bend
objective shared across every band of the source action. Each sign branch is
convex and both are compared. Without a speed profile, phase comes from the
candidate's normalized axial displacement, leaving traversal timing free.
An authored profile determines phase in time. Authored curve intensity retains
its configured amplitude rule.

## Compound rules

- Arc + Dolly -> spiral `radiusSchedule`; constant radius and linear drift are removed.
- Arc + Pedestal/Crane -> helical/crane arc; constant horizontal plane is removed.
- Follow + Dolly/Pedestal/Crane on the same rig -> relative movement around the
  shared subject reference; incompatible full offset and velocity holds are
  removed. A world-space mover may inherit the sole active Follow rig. Its
  relative-distance pacing stays independent of the Follow reference pacing.
  An explicit Follow distance sets the initial rig distance during composition.
  After a partially overlapping move, Follow holds the offset reached at that
  move's endpoint. Unrelated band boundaries do not reset the reference.
- Translation + Pan/Tilt/Dutch/Zoom -> position-hold stabilizers are released.
- Explicit rotation/composition -> incompatible orientation holds are released.
- Dutch -> level-horizon is released.
- Level-horizon constraints replace simultaneous roll holds.
- Under-constrained yaw/pitch holds are strengthened when no semantic loss owns that axis.
- Off-center framing -> centered look-at stabilizers are released.
- Static primary holds are retained; channel-release rules remove passive
  stabilizers rather than silently dropping an authored Static constraint.
- Targeted Static shots remain mounted in the subject's translating frame;
  untargeted Static shots remain locked in world space.
- Targeted Dolly/Crane translations and the global path-length regularizer measure
  camera motion relative to inherited subject translation.
- `allowSubjectIntersection` explicitly permits an interior/exit move through
  its targeted subject without disabling collision checks for other geometry.
- Zoom sub-bands refer to the same source-action camera endpoints. An explicit
  factor constrains their focal-length ratio while leaving the absolute starting FOV
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
- Position uses shared velocity and acceleration jets, giving C2 continuity
  within shots. Bernstein control bounds keep height between optimization-knot
  values without pointwise clamping. Rotation and log focal length retain C1
  Hermite resampling; this does not promise continuous angular acceleration.
  Exact exported-curve playback metadata currently applies to position only.
- Eased composition points blend the complete orientation from the underlying
  shot toward the requested subject and framing. With no underlying orientation
  owner, the seed retains the window-entry pose so easing is independent of
  sample density. Initialization and objective weights use the same authored
  entrance and release curves.
- Physical acceleration/jerk always measure world motion. Optional relative
  regularizers use one reference per derivative window and fall back to world
  coordinates when that reference changes.

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
authored or seeded orbit steps at or below 15 degrees. Optimized angular motion
can still require a finer grid; the rule is not an a posteriori angle bound.
Position uses C2 quintic Hermite segments. Initial shared jets come from a C2
cubic interpolating spline with endpoint accelerations estimated from adjacent
quadratics. A per-knot height limiter scales velocity and acceleration together,
preserving C2 continuity and bounding the Bernstein height controls. This is a
specified finite-dimensional curve family, not an exact minimum-jerk interpolant.
Rotation and log focal length use C1 Hermite resampling with shortest-arc quaternion signs.
No curve interpolates toward a post-cut pose.

Every optimization knot survives output resampling. New JSON documents include
`interpolation.position: "quinticHermite"` and each sample's `positionVelocity`
(m/s) and `positionAcceleration` (m/s²). Camera Lab evaluates that exact position
polynomial, including between output samples. Legacy documents retain linear
position playback. Output FPS is a minimum sampling density, not an exact count.

The numerical state has seven free coordinates per unconstrained sample:
position divided by a physical reference length, a three-component world-frame
rotation tangent, and log focal length. Rotation increments use the SO(3)
exponential, `R_new = Exp(deltaRotation) R_base`; accepted steps recenter the
chart. Thus the solver does not optimize four redundant quaternion components.
Unlocked FOV is bounded to 8–120 degrees; hard channels are reapplied exactly.

Refinement uses deterministic two-sided simultaneous perturbations, Adam
scaling, a temporal Sobolev filter, and monotone backtracking. The filter solves

```text
min_z 1/2 * integral (z - direction)^2 dt
      + smoothingSeconds^2/2 * integral (dz/dt)^2 dt,
```

using a mass-lumped piecewise-linear discretization on the actual timestamps.
Its reusable tridiagonal solve accounts for uneven sample spacing. Cuts remove
connecting edges and locked coordinates have zero update. This filters the
proposed direction; it does not certify a minimum-jerk trajectory.

Each main SPSA gradient estimate uses four objective evaluations regardless of
the number of free coordinates. Backtracking adds evaluations; a bounded
coordinate fallback can add up to four per free coordinate. The cost of each
evaluation also depends on trajectory and scene size. Accepted states lower
the objective and never exceed the preceding enabled collision/ground
violation, apart from the explicit 1e-6-meter numerical tolerance. The best
finite state is retained. Nonfinite probes never enter Adam's moments.

Twelve accepted improvements below the relative threshold report
`objectivePlateau`; rejected-step exhaustion reports `stalled`. The current
solver always reports `converged: false`, because it computes no stationarity
or global-optimality certificate. Zero iterations or no free coordinates
report `initialState`. Defaults are 3 Hz plus adaptive arc samples, 5000
iterations, environment `fpsHint` for output, and a fixed seed.

## Scene geometry, visibility, and scale

Scene time is the clamped integral of timeline rate segments over camera
playback time. A zero rate freezes the scene; it does not freeze the camera.
Subject transforms and obstacle bounds follow that scene clock. Authored
Follow/Track profiles and lead/delay affect their target reference as described
above. Rate jumps can produce subject-velocity jumps; no smooth retiming is
inferred from a piecewise-constant rate schedule.

Collision checks sweep the camera between optimization knots, using the same
quintic position curve as output and a Bernstein convex-hull chord-deviation
bound. The polynomial is restricted analytically to each sweep interval; a
cubic-only deviation estimate is not applied to quintics. Entity bounds
are local to the entity transform. Animation, time-warp, and exemption
boundaries split the swept intervals. Affine obstacle boxes use an exact
moving-box model; nonlinear translation, scale, and rotation use conservative
enclosures of the complete interval for supported scene channels. Temporal
subdivision tightens those enclosures rather than being relied upon to catch
motion between samples. Step-animation teleports use one-sided poses and do
not create a fictional sweep across the gap.

These guarantees concern the supplied bounding geometry and supported motion
model. Conservative bounds can reject a visually clear path, and inaccurate
reconstructed bounds cannot establish physical clearance. The final resampled
trajectory is checked too; `maximumSafetyViolationMeters` and warnings report
remaining collision/ground shortfalls, including conflicts with hard
keyframes. A finite local search does not prove that a feasible trajectory
exists or that every conflicting instruction can be satisfied.

`occlusion` measures clearance along representative sight segments from the
camera to the subject center and eight bounding-box corners. Each segment uses
its minimum signed distance to other entities' boxes and a nonnegative sight
margin; violations combine as an RMS residual. The target's own entity is
excluded. This provides a clearance signal for thin obstacles and near misses;
it is not projected visible-area estimation or a guarantee that every subject
pixel is visible. Visibility is still evaluated at temporal samples, while
camera collision uses continuous sweeps.

Canonical environments use meters. Authored scenes may omit
`coordinates.metricScale`; reconstructed scenes can record
`{ status: "calibrated", metersPerUnit: 1 }` after converting their coordinates.
The optimizer rejects `metricScale.status: "relative"`, noncanonical metric
conversion factors, and legacy `RELATIVE-SCALE` prompts. Monocular relative
coordinates must be calibrated and converted before meter-valued safety
margins or requested movement distances can be interpreted physically.
