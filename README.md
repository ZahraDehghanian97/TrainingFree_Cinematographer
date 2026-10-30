> **New: 10 cinematic examples.** See [the cinematic suite guide](examples/cinematic-suite/PROJECT_GUIDE.md). In the main visualizer, select an **Environment**, then choose its **Prompt** from the adjacent menu.

# TrainingFree Cinematographer — Two Shared Environments

**[راهنمای کامل فارسی](README.fa.md)**

The runtime catalogue contains exactly **stadium** and **factory**. Any number of films or custom director prompts may reuse these two worlds; film identity is separate from environment identity.

This revision uses the complete `origin/integration` tree at `e6bdc9d` embedded in the supplied archive. The archive's checked-out master tree contained only the timeline component. The original archive has not been modified.

## Run

```bash
npm ci
npm run visualizer
```

Open `http://127.0.0.1:4173`. Select an **Environment**, then a **Prompt**. Each world offers its default prompt and five cinematic examples; selecting a prompt loads its camera reference automatically. Use **Replay reference** to replay the selected example or **Run full pipeline** to generate a new trajectory from its prompt. Bundled authored camera paths do not require an API key. **Director** is the filming camera; **God** is the free overview. The scene-event buttons seek to event times, including when a camera trajectory changes scene playback speed. A frozen trajectory that never reaches an event reports that fact instead of seeking to an unrelated time.

For text-to-camera generation, copy `.env.example` to `.env`, set credentials/models available to your account, and use **Custom prompt / Run full pipeline**. The two environments are allowlisted by `EnvironmentRepository`. Actor motion is not generated or reset by a camera prompt.

Requirements: Node.js 22+, npm, and Python 3 for regeneration. Dependency versions and the supplied package lock are retained. No external model downloads are needed after installing the project dependencies; procedural assets are bundled.

## Worlds

| | Stadium | Factory |
|---|---|---|
| Clock | 48 s | 48 s |
| Cast | 6 runners, exactly 24 football players, 72 spectators, separate sideline cameraman, 2 marshals | 8 workers |
| Set | Six-lane track around a marked football field, goals, stands, finish line/ribbon, start/finish flags and scoreboards | Original architectural shell retained; 28 m production line, 3 assembly robots, press and packaging stations, safety controls |
| Action | Variable running speeds, fall/recovery, race win at 38 s, football goal at 38.2 s, winner's jump, 27 thrown flowers | Production, argument, shove, impact at 21 s, six pieces of falling cargo, emergency ramp-down, crew reaction |
| Bundled reference | Two explicit cuts for simultaneous-goal coverage | Continuous authored take |

All motion uses the absolute scene clock. Root transforms are baked into standard EnvironmentV1 channels shared by the browser and optimizer. Skeletal performances are layered on the existing path-derived gait. Flags, belt slats, robot joints and scoreboards use absolute-time evaluators. There is no accumulated physics state to break reverse seeking.

## Generate and test

```bash
npm run generate:environments
npm run generate:timelines
npm run audit:environments
npm run audit:references
npm run test:node
npm run typecheck:scenarios
npm run typecheck:references
npm run check:syntax
```

`generate:examples` regenerates assets and only these two worlds. `generate:references` rebuilds the worlds and bundled authored references as a single deterministic operation. Generated environment/reference edits will be overwritten; edit the Python source instead. Existing optimized outputs are marked stale after regeneration.

```bash
npm run generate:trajectories -- --example stadium --iterations 100 --optimization-fps 1 --output-fps 24
npm run generate:trajectories -- --example factory --iterations 100 --optimization-fps 1 --output-fps 24
```

These are example computational budgets, not quality guarantees. `npm run smoke:optimizer` performs initialization/export with zero refinement iterations; it is separate from the test suite because populated worlds can be expensive to initialize.

## Source map

- `scripts/generate-two-environments.py`: sole world generator, root motion, events, authored cameras and metadata hashes.
- `scripts/scene-layouts/factory-shell.json`: non-playable static authoring template retained from the original factory.
- `web/src/scenario-props.ts`: batched track/line geometry, instanced belt slats, flags, robots, flowers, camera equipment and boards.
- `web/src/humanoid.ts`, `performance-motion.ts`: sports clothing, workwear, lightweight ensemble rigs and event performances.
- `src/environment/performance.ts`: shared event/clip validation and deterministic blend weights.
- `src/data/resolved-example-fixtures.ts`: two default films; additional films should reuse one of the two environment IDs.
- `src/pipeline/director.ts`, `orchestrator.ts`: provide semantic scene-beat descriptions/times to the existing camera-direction pipeline.

## Validation boundary

**55 Node tests pass**, including the original 22 GLB asset tests and the new scene/reference acceptance checks. Scene and reference/core TypeScript checks pass. The 4 Hz environment audit compared 126,801 transforms; 10 Hz conservative camera point/AABB probes produced no warnings. Refer to [the validation report](docs/VALIDATION.md) for exact commands and limitations.

**Not verified here:** a Vite production build, browser/WebGL appearance or frame rate, a live LLM request, or a completed full numerical camera optimization. Browser dependencies could not be downloaded in the execution environment; `build:web` stopped with `vite: not found`. A 40-second initializer smoke attempt did not finish. Bundled paths are honestly labelled **authored references, not optimized output or measured ground truth**.

This is a deterministic staged cinematic scene, not a real-time rigid-body/ragdoll solver, autonomous football game, or photorealistic video generator. Bounding boxes are conservative approximations, not detailed animated limb/cloth collision meshes.

The original MIT license is retained.
