# TrainingFree Cinematographer

A TypeScript camera-direction DSL and timeline solver, with a browser visualizer for evaluating generated camera trajectories inside prompt-specific 4D environments (3D space over playback time).

## Camera Lab visualizer

```bash
npm install
npm run visualizer
```

Open `http://127.0.0.1:4173` and choose one of the 19 prompt environments. Each
catalog entry loads its scene-matched bundled trajectory by default. You can
still request, upload, or paste generated optimizer output. God view shows the
environment, path, and moving camera frustum. Director POV renders through the
camera.

### Interactive prompt-to-trajectory pipeline

Camera Lab supports both paths after an environment is selected:

- **Replay bundled** loads the checked-in trajectory immediately, without an LLM call.
- **Run full pipeline** sends the example prompt through the same live pipeline as a custom request.
- **Custom prompt** accepts up to 4,000 characters in any language and runs the complete flow.

The live flow is:

```text
prompt
  -> director LLM -> validated semantic CameraDirectionDraft (no runtime IDs)
  -> grounding LLM + selected EnvironmentV1 -> validated target bindings
  -> deterministic binder -> resolved CSL with environment target IDs
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
- `web/public/environments/example-01.json` through `example-19.json` contain scene geometry, semantic targets, and object tracks.
- `src/types/environment.ts` defines the environment contract.
- `src/types/trajectory.ts` defines accepted camera documents.
- `web/public/trajectories/ai-generated/example-01-camera.json` through
  `example-19-camera.json` are complete scene-matched reference trajectories. Examples 14–18 add cinematic multi-action/easing coverage, and example 19 completes coverage for the remaining implemented Pan/Tilt/Truck/Pedestal/Zoom/Dutch directions.

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

A draft subject is `{ ref, description }`, where `ref` is only a CSL-local
correlation key. A resolved target is `{ id, description }`, where `id` is an
optimizer-addressable runtime target/track ID returned by the 4D module.
Exact groups can declare `cardinality: { min: 2, max: 2 }`. Movement-axis
references remain independent from framing references. Truck (camera-right) and
Pedestal (world-up) are subjectless translations and therefore do not carry
movement subject references; use framing constraints when a subject must remain
composed during those moves.

Supported requests include:

- batch-binding semantic CSL references to runtime environment targets,
- world-space 3D subject boxes at one playback time,
- subject boxes over a time range,
- the first time two subjects are within a requested distance,
- the first time a subject reaches a requested speed, and
- how many times the distance between two subjects crosses a requested value.

An explicit movement duration on an environment-triggered action is a requested
maximum. After the event is causally aligned to a playback frame, the timeline
solver shortens that action only when needed to end at `totalDuration`;
statically timed actions keep strict duration validation.

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
npm run generate:trajectories # Generate all 19 trajectories without LLM/visualizer work
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
plans/diagnostics under `shared/optimized/`. It accepts `--example`, `--iterations`,
`--optimization-fps`, `--output-fps`, and `--keyframes` (with one example).

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
