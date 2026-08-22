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

The canonical `cameraTrajectory` format additionally supports per-sample quaternion or look-at orientation, FOV, cuts, and action IDs. The upload adapter also accepts the pasted prototype's `{ "frames": [...] }` shape and normalizes it before playback.

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
const timeline = solveTimeline(csl);
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

For local development, configure Vercel AI Gateway in `.env` (see `.env.example`):

```dotenv
AI_GATEWAY_API_KEY=...
LLM_MODEL=google/gemini-3.7-flash
EXAMPLE_BINDING_MODE=resolved
```

`LLM_MODEL` is optional; `google/gemini-3.7-flash` is the default. On Vercel,
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

Supported curves are `linear`, `easeIn`, `easeOut`, and `easeInOut`. Without `easing`, point constraints keep the original exact-point behavior. Easing metadata is preserved through the solver/flattener and converted to per-frame weights by the Python optimizer.

## Commands

```bash
npm run build          # Type-check/build the Node library and browser app
npm test               # Run Node tests, then the web Vitest suite
npm run test:node      # Run Node grounding/binding tests
npm start              # Run timeline solver + optimizer for all examples
npm run pipeline       # Alias for the same end-to-end pipeline
npm run visualizer     # Start Camera Lab in development mode
npm run preview:visualizer
```

Install the Python optimizer dependencies once, then run either every example or
one example by number/id:

```bash
python3 -m pip install -r src/opt/requirements.txt
npm run pipeline
npm run pipeline -- --example 1
npm run pipeline -- --example example-01
npm run pipeline -- --example example-01 --binding-mode resolved
npm run pipeline -- --example example-01 --binding-mode llm
```

`--binding-mode` overrides `EXAMPLE_BINDING_MODE`. The `llm` mode makes one
Gateway request per selected example, while `resolved` performs no binding API
call. LLM-mode output persists the selected bindings and their comparison with
fixture ground truth under `subjectBinding` in the timeline wrapper.

Set `PYTHON_BIN` if the dependencies are installed in a particular interpreter,
for example `PYTHON_BIN=.venv/bin/python npm run pipeline -- --example example-01`.

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
launch errors, non-zero exits, and missing viewer trajectories stop the pipeline
with a non-zero exit status.
