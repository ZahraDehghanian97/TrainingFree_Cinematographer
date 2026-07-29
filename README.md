# TrainingFree Cinematographer

A TypeScript camera-direction DSL and timeline solver, with a browser visualizer for evaluating generated camera trajectories inside prompt-specific 4D environments (3D space over playback time).

## Camera Lab visualizer

```bash
npm install
npm run visualizer
```

Open `http://127.0.0.1:4173` and choose one of the 13 prompt environments. Each
catalog entry loads its scene-matched bundled trajectory by default. You can
still request, upload, or paste generated optimizer output. God view shows the
environment, path, and moving camera frustum. Director POV renders through the
camera.

The visualizer is data-driven:

- `web/public/environments/manifest.json` is the environment catalog.
- `web/public/environments/example-01.json` through `example-13.json` contain scene geometry, semantic targets, and object tracks.
- `src/types/environment.ts` defines the environment contract.
- `src/types/trajectory.ts` defines accepted camera documents.
- `web/public/trajectories/ai-generated/example-01-camera.json` through
  `example-13-camera.json` are complete reference trajectories.

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

## Commands

```bash
npm run build          # Type-check/build the Node library and browser app
npm test               # Run schema, interpolation, and upload tests
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
```

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
