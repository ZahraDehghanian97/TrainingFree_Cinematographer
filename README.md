# TrainingFree Cinematographer

A TypeScript camera-direction DSL and timeline solver, with a browser visualizer for evaluating generated camera trajectories inside prompt-specific 4D environments (3D space over playback time).

## Authored environments and connected architecture

The bundled suite contains **32 authored environments, 25 enclosed volumes,
11 connected stair flights, 2,400 entities (primarily structural components),
22 original procedural GLB assets, and 32 scene-matched camera references**.
Rooms now have continuous walls and full ceilings, real door/window openings,
and supported furniture and luminaires. Warehouses have accessible mezzanines;
the rooftop has a finite building and a stair to the occupied floor below.
Profile-wide random dressing has been replaced with deterministic scene-specific
layouts. Examples 24–32 retain their original omission/“don't-care” prompts and CSL.

See [the environment rebuild guide](docs/ENVIRONMENT_REBUILD.md) for authoring,
scene-by-scene changes, validation, and limitations. Bundled camera references
are synthetic storyboards, not optimized output or measured ground truth.

```bash
npm ci
npm run visualizer               # Bundled scenes/references need no regeneration
npm run generate:examples        # Rebuild assets, scenes, references, then audit
npm run typecheck:references     # Reference + architectural contracts
npm run test:node                # 109 checked-in Node tests
```

**Building cutaway · God view** is an inspection option, enabled by default.
Turn it off to inspect the closed building. Cutaway hides the roof and only the
camera-facing outer walls in God view; Director POV always restores complete
architecture. Cutaway never changes collision or reference-audit geometry.

The delivered tree is based on the uploaded archive's full `origin/integration`
branch at `cf55327acdc72743402ac1a78f4f422e1a80f0e5`, not its timeline-only
`master` checkout. Legacy optimizer snapshots are marked stale and are not
used as automatic replay fallbacks.

Validation in the editing environment: 109 Node tests passed; all 32 sampled
reference audits passed; 6,745 layout checks passed; the dependency-light
reference/layout typecheck passed. A full browser build and browser/WebGL
review were **not** completed because package installation was unavailable.

## Camera Lab visualizer

```bash
npm install
npm run visualizer
```

Open `http://127.0.0.1:4173` and choose one of the 32 prompt environments. Each
catalog entry loads its scene-matched authored reference by default. You can
still request, upload, or paste generated optimizer output. God view shows the
environment, path, and moving camera frustum. Director POV renders through the
camera.

### Interactive prompt-to-trajectory pipeline

Camera Lab supports both paths after an environment is selected:

- **Replay reference** loads the checked-in authored reference immediately, without an LLM call. The UI labels it “Authored reference (not optimized)”.
- **Run full pipeline** sends the example prompt through the same live pipeline as a custom request.
- **Custom prompt** accepts up to 4,000 characters in any language and runs the complete flow.

The live flow is:

```text
prompt
  -> director LLM -> validated semantic CameraDirectionDraft (no runtime IDs)
  -> grounding LLM + selected EnvironmentV1 -> validated subject bindings
  -> deterministic binder -> resolved CSL with environment subject IDs
  -> timeline solver + 4D environment events -> flattened timeline
  -> trajectory optimizer -> CameraTrajectoryV1
  -> Camera Lab 4D playback (God view / Director POV)
```

Every completed stage is inspectable in the JSON drawer. The UI receives real
stage transitions over a same-origin SSE stream and supports cancellation,
retry, and stale-run protection when the selected environment changes.

For local LLM runs, copy `.env.example` to `.env`, set `AI_GATEWAY_API_KEY`, and
start `npm run visualizer`. All production LLM calls use Vercel AI Gateway;
`zai/glm-5.3-flash` is the shared default for director, grounding, repair, and
environment-query parsing. `LLM_CSL_MODEL`, `LLM_GROUNDING_MODEL`,
`LLM_REPAIR_MODEL`, and `LLM_ENVIRONMENT_QUERY_MODEL` can override individual
stages, while `LLM_MODEL` remains their common fallback. Credentials stay in
the Node/Vite server and are never sent to the browser.

The local API exposes `POST /api/pipeline/runs`, an SSE stream at
`GET /api/pipeline/runs/:runId/events`, run snapshots, and cancellation via
`DELETE /api/pipeline/runs/:runId`. The included implementation is an in-memory
development/preview backend. Its optimizer runs in a Node worker so the SSE loop
stays responsive and cancellation can terminate a synchronous solve;
`PIPELINE_MAX_CONCURRENT_RUNS` (default `2`) bounds simultaneous Gateway and
worker load. Deploy the same API contract behind a persistent job store and
worker pool when production runs must survive server restarts or scale across
instances.

#### Inspecting stage results and failures

- Click any completed stage row marked **View** to open that stage's JSON result.
- **Inspect details** opens the Run log with the run ID, ordered SSE events,
  timings, available artifacts, and safe error metadata. A failed stage and its
  **View details** action open the same log even when stage 1 produced no output.
- Keep the `npm run visualizer` terminal open while debugging. Each non-cancelled
  failure writes one redacted JSON record to stderr. Match its `errorId` to the
  Run log to inspect the server-only cause chain and stack without logging API
  keys, request bodies, response bodies, or the director prompt.
- A retained run can also be inspected with
  `GET /api/pipeline/runs/:runId` or replayed as SSE with
  `GET /api/pipeline/runs/:runId/events`.

`LLM_TIMEOUT_MS` is the total deadline across transport attempts (the example
configuration uses `180000`), and `LLM_MAX_TRANSPORT_RETRIES` bounds retryable
408/409/429/5xx or network failures (default `2`). Restart the visualizer after
changing `.env`; environment settings are loaded once per server process.

The visualizer is data-driven:

- `web/public/environments/manifest.json` is the environment catalog.
- `web/public/environments/example-01.json` through `example-32.json` contain scene geometry, optional semantic anchors, and object tracks.
- `src/types/environment.ts` defines the environment contract.
- Environments have authored lighting profiles, textured floors, detailed props,
  and image-based material reflections. Director POV hides the diagnostic path,
  grid, and bounds; **Object bounds** also shows the grid in God view.
- Example 03 includes a locally bundled CC0 ceramic vase from Poly Haven. See
  [asset credits](web/public/models/ATTRIBUTION.md).
- Fifteen original procedural models under `web/public/models/generated/` add benches, trees, streetlamps, industrial equipment, stage structures, and an open loading-bay portal. Their manifest records dimensions, checksums, and MIT provenance.
- `src/types/trajectory.ts` defines accepted camera documents.
- `web/public/trajectories/ai-generated/example-01-camera.json` through
  `example-32-camera.json` are reproducible scene-matched authored references. Per-example plans, input hashes, provenance, artistic choices, and sampled audit results live under `web/public/trajectories/reference-metadata/`. The legacy `ai-generated` directory name is retained for compatibility; generation does not call an external AI model.

### Adding 3D models and environment appearance

Put a `.glb`, or a `.gltf` with its referenced buffers/textures, under
`web/public/models/`. Replace an entity's `visual`, keeping its tracked transform,
semantic anchors, and collision bounds:

```json
{
  "type": "model",
  "url": "/models/ceramic-vase/ceramic_vase_01_1k.gltf",
  "fitToBounds": true,
  "fallback": {
    "type": "preset",
    "name": "vase",
    "params": { "height": 0.95 }
  }
}
```

`fitToBounds` uniformly fits and centers the model inside the existing entity
bounds. Omit it to keep the asset's authored meter scale and origin. Optional
visual-local `position`, `rotation` (xyzw quaternion), and `scale` adjust only the
model, never the tracked entity or its anchors. Align those points when replacing
people or other framing subjects. The fallback stays visible while loading or if
loading fails. External HTTP(S) assets require CORS; bundled assets work offline.
The imported-model loader renders static model poses; entity tracks still animate the
whole model. Embedded skeletal animation and Draco/KTX2 decoders are not configured.

The built-in `humanoid` preset has a skinned skeleton and uses `params.color` for
skin, `shirtColor` / `trouserColor` for clothing, and `hairColor` for hair. Leave
`params.motion` unset (or `"auto"`) for walking, running, and idle animation based
on the entity's path, or use `"idle"`, `"dance"`, `"float"`, or `"punch"` for a
specific action. Motion follows environment time, so seeking, slow motion, and
frozen segments also control the limbs. Walking bodies face their travel direction
with gradual turns, while standing actors and explicit actions keep their authored
facing. Automatic humanoid paths ease between timed waypoints and hold still at
stops; the renderer and environment queries sample the same path. Entity rotations
still define camera anchors independently of the visual body's walking direction.

`world.profile` accepts `studio`, `daylight`, `road`, `park`, `industrial`,
`corridor`, `stage`, or `rooftop`; `world.exposure` adjusts brightness.
`world.ground.surface` accepts `concrete`, `wood`, `asphalt`, `grass`, or `stage`.
Existing ground dimensions and entity motion retain their original meaning.

### Compact 4D camera input

For position-only model output, declare the point layout explicitly. Here, 4D means `[x, y, z, time]`:

```json
{
  "schemaVersion": "1.0",
  "kind": "cameraPath4d",
  "environmentId": "example-01-football",
  "layout": ["x", "y", "z", "t"],
  "orientation": {
    "mode": "lookAtTarget",
    "targetId": "ball",
    "up": [0, 1, 0]
  },
  "points": [
    [5, 2.4, 13, 0],
    [4.3, 3.2, 4, 6.5],
    [2.5, 6.2, -5.3, 10]
  ]
}
```

The canonical `cameraTrajectory` format additionally supports per-sample quaternion or look-at orientation, FOV, cuts, and action IDs. The upload adapter also accepts self-contained `cameraOptimizerDiagnostics` output, the pasted prototype's `{ "frames": [...] }` shape, and normalizes each supported input before playback.

### Slow motion, frozen time, and fast motion

Camera playback and environment playback are separate. The camera continues along its trajectory while `playback.rateSegments` controls how quickly scene time advances:

```json
{
  "playback": {
    "rateSegments": [
      { "startTime": 0, "endTime": 2, "rate": 0, "label": "frozen" },
      { "startTime": 2, "endTime": 5, "rate": 1, "label": "normal" }
    ]
  }
}
```

`rate: 0` freezes scene objects, `0.1` advances them at 10% speed, `1` is normal, and rates above `1` produce fast motion. These semantic scene rates are independent of the transport's `0.1×`–`4×` viewer speed. The rate band under the timeline and the Scene speed/Scene time readouts show both effects during playback.

All v1 data uses a right-handed, Y-up coordinate system, meters for distance, seconds for playback time, and quaternion order `[x, y, z, w]`. Position alone is enough to draw a path; Director POV also needs an orientation policy such as `lookAtTarget` or `pathTangent`.

## LLM-powered environment queries

`src/environment/` exposes a typed query layer over the existing `EnvironmentV1` schema. It currently simulates the future 4D recognition module. The director-to-CSL model never receives or invents runtime scene IDs: it emits CSL-local semantic references, which are bound after generation and before timeline solving.

```ts
import { createEnvironmentSubjectResolver, queryEnvironment } from "./src/environment";
import { bindCameraDirectionDraft } from "./src/grounding";
import { solveTimeline } from "./src/timeline/solver";

const answer = await queryEnvironment(environment, "توپ اولین بار کی به دو متری دروازه رسید؟");
const resolver = createEnvironmentSubjectResolver(environment);
const { csl, bindings } = await bindCameraDirectionDraft(
  draftCsl,
  { directorPrompt, scene: { id: environment.id } },
  resolver,
);
const timeline = solveTimeline(csl, environment);
```

The grounding boundary is:

```text
director prompt -> semantic CameraDirectionDraft -> 4D/env binding
                -> resolved CameraDirectionDSL -> timeline solver -> optimizer
```

The example pipeline has an explicit `EXAMPLE_BINDING_MODE` hyperparameter:

- `resolved` (default) reads `resolvedCsl` directly from
  `src/data/resolved-example-fixtures.ts` and skips draft creation and subject
  binding entirely. This is the deterministic path when runtime IDs are known.
- `llm` converts the selected fixture into an opaque semantic draft, loads the
  matching `EnvironmentV1`, and calls the real environment-backed LLM resolver.
  The returned bindings are compared with the fixture ground truth for
  evaluation, but a valid mismatch is not replaced: the timeline continues
  with the IDs selected by the LLM.

`src/data/examples.ts` only contains the conversion/evaluation helpers for the
`llm` experiment; it is no longer the canonical example catalog.

The [prompt/DSL audit](docs/example-prompt-dsl-audit.md) records corrections and
remaining approximations for all 32 examples, including requests the current
DSL or environment cannot fully express. Passing the fixture tests verifies
the encoded intent and stored timelines; it does not establish visual fidelity.

A draft subject is `{ ref, description }`, where `ref` is only a CSL-local
correlation key. A resolved camera target is `{ id, description }`, where `id`
is an optimizer-addressable runtime subject ID returned by the 4D module.
Every environment entity is addressable by its own ID. Optional
`semanticAnchors` add named points or regions within an entity—such as a face,
eye, hand, or impact point—without acting as an allowlist for whole objects.
Exact groups can declare `cardinality: { min: 2, max: 2 }`. Movement-axis
references remain independent from framing references. Truck (camera-right) and
Pedestal (world-up) are subjectless translations and therefore do not carry
movement subject references; use framing constraints when a subject must remain
composed during those moves.

CSL represents **don't care by omitting a field**. An omitted initial camera,
shot size, composition, view, lens, movement amount, or path shape remains
unspecified through parsing, subject binding, and timeline compilation. Do not
use `null` or a string sentinel, and do not supply a plausible number as a
placeholder. Explicit values, including zero where valid, retain their meaning.

For example, “arc left around the actor” needs only:

```json
{
  "totalDuration": 8,
  "sections": [{
    "actions": [{
      "id": "arc_actor",
      "trigger": { "type": "absoluteTime", "time": 0 },
      "movement": {
        "act": "arcLeft",
        "targets": [{ "ref": "actor", "description": "The actor" }]
      }
    }]
  }]
}
```

The leftward direction is explicit; radius, sweep, framing, and starting pose
are free choices for the optimizer. Bare `orbit` likewise leaves its sweep
unspecified; “one full orbit” supplies `parameters.arcAngle: 360`.
`nonSubjectAware` configs can contain only lens settings or `lookAt`, and
`extrinsics.pose.position` and `.rotation` are independently optional. Supplied
vectors and rotations must still be complete. Section boundaries remain cuts
even when `initCamera` is absent.

The optimizer uses soft subject visibility and minimum useful screen-size
preferences for subject-anchored moves with unspecified framing. These quality
preferences leave radius and exact composition free and yield to explicit
framing requests. Numerical initialization supplies a candidate camera only at
the optimization stage; it does not turn its guesses into requested constraints.
The environment still owns `totalDuration`. Omitted action durations are
allocated by the existing deterministic timeline scheduler inside that window.
The original demos (01–23) contain authored artistic choices beyond their short prompts;
the director model uses separate sparse examples to avoid learning those choices
as implied requirements.

Examples **24–32** are a separate don't-care suite with sparse reference CSL,
scene-matched bundled trajectories, and Persian prompts. Select them in Camera
Lab and use **Replay bundled** to compare the optimizer output, or **Run full
pipeline** to test the prompt with the configured model. See the
[manual test guide](examples/dont-care.md) for comparison pairs and expected behavior.
Rebuild just this suite without an LLM using `npm run generate:dont-care`.

Supported requests include:

- batch-binding semantic CSL references to runtime environment subjects,
- world-space 3D subject boxes at one playback time,
- subject boxes over a time range,
- the first time two subjects are within a requested distance,
- the first time a subject reaches a requested speed, and
- how many times the distance between two subjects crosses a requested value.

An explicit movement duration on an environment-triggered action is a requested
maximum. After the event is causally aligned to a playback frame, the timeline
solver shortens that action only when needed to end at `totalDuration`;
statically timed actions keep strict duration validation.

DSL distance and velocity triggers support all six `ComparisonOperator` values.
Values within `environment.evaluation.epsilon` of the threshold (default `1e-7`)
compare equal; strict comparisons exclude that band. Velocity normally compares
speed magnitude; `direction` selects the signed velocity along a normalized
world-space vector and allows signed thresholds. A condition already true at
scene time zero starts at playback time zero.

Nested `and`/`or` triggers combine latched events: `and` waits for every child,
while `or` uses the earliest reachable child. Conditions need not remain true
simultaneously. Relative `start`/`middle`/`end` references work inside these
expressions. Event times account for scene playback rates before being aligned
to playback frames. Actions declaring `relativeFPS` must have non-overlapping
intervals so the timeline and optimizer share one unambiguous scene clock.

For local development, configure Vercel AI Gateway in `.env` (see `.env.example`):

```dotenv
AI_GATEWAY_API_KEY=...
LLM_MODEL=zai/glm-5.3-flash
EXAMPLE_BINDING_MODE=resolved
```

`LLM_MODEL` is optional; `zai/glm-5.3-flash` is the project-wide default. On Vercel,
Gateway can authenticate through OIDC without an API key. The parser uses the
AI SDK's built-in Vercel AI Gateway provider and `Output.object()` with the
exported Zod `environmentQuerySchema`; the same schema validates the model
response and supplies the TypeScript `EnvironmentQuery` type.
`parseEnvironmentQuery()` and `executeEnvironmentQuery()` are also exported
separately when callers want to inspect/cache the parsed intent or execute a
query without an LLM call. Development/few-shot coverage lives in
`src/data/environment-query-examples.ts`.

`bindCameraDirectionDraft()` resolves all unique references in one batch and
hydrates every target-bearing CSL slot: initial camera targets, movement axes,
framing constraints, distance/velocity triggers, compound triggers, and
target-based `lookAt`. Its resolver is injectable: `EnvironmentV1` plus
`parseEnvironmentQuery()` is the simulator adapter today; production can swap
in the real 4D module without changing the binder, solver, or optimizer.
Resolver responses are runtime-validated and must identify the same scene (and,
when supplied, scene revision) requested by the binding pass.

`src/data/resolved-example-fixtures.ts` contains the executable, already-bound
replay fixtures. Those IDs model the output of the grounding stage and are not
part of the director-to-CSL examples.

## Point-constraint easing

Point-only DSL constraints (`allFrames: false`) can optionally fade in before the point and/or fade out after it:

```ts
{
  targets: [{ id: "actor", description: "The actor" }],
  config: {
    type: "subjectAware",
    shotSize: ShotSize.CloseUp,
  },
  allFrames: false,
  easing: {
    inDuration: 2,
    outDuration: 0.75,
    curve: "easeInOut",
  },
}
```

Supported curves are `linear`, `easeIn`, `easeOut`, and `easeInOut`. Without
`easing`, point constraints keep the original exact-point behavior. Easing
metadata is preserved through the solver/flattener and converted to per-sample
weights by the TypeScript optimizer.

## TypeScript trajectory optimizer

`src/optimizer/` contains the complete dependency-free numerical optimizer. It
optimizes camera position, quaternion orientation, and vertical FOV. Its inputs
are the flattened timeline, the matching `EnvironmentV1` 4D scene, and optional
user camera keyframes. Its output is a canonical `CameraTrajectoryV1` document.

The optimizer compiles high-level requests into dimensionless primitive
residuals, resolves semantic conflicts across all losses active in the same
time band, adds global safety/regularity terms, and solves the weighted
objective. For example, concurrent Arc and Dolly become a spiral radius
schedule instead of contradictory constant-radius and dolly terms.

```ts
import { optimizeCameraTrajectory } from "./src/optimizer";

const result = optimizeCameraTrajectory({
  environment,
  timeline: flattenedTimeline,
  userKeyframes: [
    {
      time: 0,
      position: [0, 2, 6],
      lookAt: [0, 1, 0],
      fovYDegrees: 50,
      // mode defaults to "hard"
    },
    {
      time: 4,
      mode: "soft",
      weight: 2,
      position: [2, 2.5, 3],
    },
  ],
});

console.log(result.trajectory);
console.log(result.diagnostics);
```

If the caller has the direct `solveTimeline()` result instead, use
`optimizeTimelineSolverOutput()`; it performs the flattening step internally.

Hard keyframes lock only the supplied channels exactly. Soft keyframes become
high-priority anchor residuals. `rotation` and `lookAt` are mutually exclusive;
`lookAt` uses world-up unless `up` is supplied. See
`src/optimizer/README.md` for the primitive vocabulary, compound rules, public
types, and numerical defaults.

## Commands

```bash
npm run build          # Type-check/build the Node library and browser app
npm test               # Run Node tests, then the web Vitest suite
npm run test:node      # Run Node timeline, grounding, and optimizer tests
npm start              # Run timeline solver + optimizer for all examples
npm run pipeline       # Alias for the same end-to-end pipeline
npm run generate:trajectories # Generate all 32 trajectories and matching timeline JSON
npm run generate:timelines    # Refresh all 32 timeline documents without optimization
npm run visualizer     # Start Camera Lab in development mode
npm run preview:visualizer
```

Install the Node dependencies once, then run every example or one example by
number/id. No second runtime or optimizer dependency is required:

```bash
npm install
npm run pipeline
npm run pipeline -- --example 1
npm run pipeline -- --example example-01
npm run pipeline -- --example example-01 --binding-mode resolved
npm run pipeline -- --example example-01 --binding-mode llm
npm run pipeline -- --example example-07 --keyframes ./my-keyframes.json
npm run generate:trajectories
npm run generate:trajectories -- --example example-09 --iterations 60
npm run generate:trajectories -- --example example-07 --keyframes examples/user-keyframes.example.json
```

`--binding-mode` overrides `EXAMPLE_BINDING_MODE`. The `llm` mode makes one
Gateway request per selected example, while `resolved` performs no binding API
call. LLM-mode output persists the selected bindings and their comparison with
fixture ground truth under `subjectBinding` in the timeline wrapper.

`--keyframes` accepts either a JSON array or
`{ "environmentId": "...", "keyframes": [...] }` and requires one selected
example. `--optimizer-iterations <n>` is available for deterministic ablations
and fast smoke tests.

`generate:trajectories` is the dependency-light resolved-fixture path: it skips
LLM binding and timeline image generation, writes viewer JSON under
`web/public/trajectories/optimized/`, and writes self-contained, viewer-loadable
plans/diagnostics under `shared/optimized/`. Matching prompts and compiled timelines
are written to `shared/timeline/`. It accepts `--example`, `--iterations`,
`--optimization-fps`, `--output-fps`, and `--keyframes` (with one example).

After editing fixture prompts or CSL, `npm run generate:timelines` refreshes only
the timeline documents without running the optimizer. This is the same generator's
`--timeline-only` mode; `--example example-20` and `--suite dont-care` can narrow
the selection. Regenerate trajectories to update camera playback after CSL changes.

For each example, the pipeline writes:

- Timeline JSON/SVG/PNG diagnostics to `src/outputs/`.
- The optimizer handoff document to `shared/timeline/`.
- Optimizer diagnostics and a canonical archive to `shared/optimized/`.
- A viewer-ready camera trajectory to
  `web/public/trajectories/optimized/<example-id>-camera.json`.

Start Camera Lab with `npm run visualizer` and choose the matching environment;
the generated trajectory loads automatically. The pipeline also prints a direct
Camera Lab URL for every processed example. A specific trajectory URL can be
requested with `?environment=<environment-id>&trajectory=<json-url>`. Optimizer
validation/numeric failures and missing viewer trajectories stop the pipeline
with a non-zero exit status.
