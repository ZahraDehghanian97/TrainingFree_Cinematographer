# Ten cinematic examples for the two existing environments

This package adds **10 complete prompt → CSL → synthetic camera-reference examples**: five for `stadium` and five for `factory`. Each example uses the original **48-second** scene clock at normal speed, with **1,441 camera samples at 30 Hz**, including both endpoints. The collection contains **14,410 exported camera samples**.

The references are AI-authored camera designs synthesized by a deterministic, scene-aware Python generator. They are **synthetic ground truth**, not measured footage, not outputs from the project's numerical optimizer, and not a claim that a prompt has one uniquely correct camera solution. No model API or API key is needed to replay or regenerate the supplied references.

## Open the films

Use this completed project rather than the older timeline-only checkout at the root of the uploaded archive. With Node.js 22 or newer, run from the project directory:

```sh
npm ci
npm run visualizer
```

Open the main visualizer:

```text
http://127.0.0.1:4173/
```

Choose an **Environment**, then select a film in the adjacent **Prompt** menu. Each environment offers its original default prompt and five cinematic examples. Selecting a prompt displays the full text in the Example panel and loads that film's camera reference. Choose **Director POV** to watch through the filming camera, and use the normal playback controls to play or scrub. **Replay reference** replays the selected film; **Run full pipeline** generates a new trajectory using its prompt. The prompt, CSL JSON, and trajectory JSON are also available in the example folders listed below. Open the viewer through the project server rather than `file://`.

## The collection

| # | Environment | Film | Camera design |
|---|---|---|---|
| 01 | `stadium` | [The Winner's Run](stadium-01-winners-run/prompt.txt) | Hero tracking / finish / crane reveal |
| 02 | `stadium` | [Fall and Resolve](stadium-02-fall-and-resolve/prompt.txt) | Recovery story / anticipatory widening |
| 03 | `stadium` | [The Decisive Play](stadium-03-decisive-play/prompt.txt) | Ball tracking / settled goal coverage |
| 04 | `stadium` | [Behind the Sideline Lens](stadium-04-behind-the-lens/prompt.txt) | Character study / parallel tracking |
| 05 | `stadium` | [The Stadium Breathes](stadium-05-stadium-breathes/prompt.txt) | 60-degree aerial arc / geographic master |
| 06 | `factory` | [Production to Stillness](factory-01-production-to-stillness/prompt.txt) | Product-led opening / dramatic reveal |
| 07 | `factory` | [The Aisle Two-Shot](factory-02-aisle-two-shot/prompt.txt) | Intimate two-shot / anticipatory retreat |
| 08 | `factory` | [The Chain Reaction](factory-03-chain-reaction/prompt.txt) | High-angle master / spatial causality |
| 09 | `factory` | [The Emergency Operator](factory-04-emergency-operator/prompt.txt) | Supporting character / response coverage |
| 10 | `factory` | [One Piece, Many Consequences](factory-05-one-piece/prompt.txt) | Cargo-led story / floor-level aftermath |

See [the full prompt and shot catalogue](CATALOGUE.md) for complete prompts, phase timings, action types, explicit primary subjects, and numeric camera keyframes.

## Files per example

Each directory under `examples/cinematic-suite/<example-id>/` contains:

| File | Use |
|---|---|
| `prompt.txt` | The complete English director prompt. |
| `csl.json` | Runtime-resolved CSL with real environment IDs, timing, camera initialization, movement, and constraints. |
| `draft-csl.json` | The same CSL with semantic target references instead of bound IDs. |
| `binding.json` | The explicit semantic-reference → environment-target mapping. |
| `trajectory.json` | The complete generated reference in the native `CameraTrajectoryV1` format. |
| `keyframes.json` | Human-readable samples at phase boundaries and scene beats; not a replacement for the dense trajectory. |
| `storyboard.json` | Named phases, primary targets, scene beats, and suggested inspection times. |
| `timeline.json` | Timeline compiled by the actual project solver and flattener. |
| `metadata.json` | Reference status, conventions, generation method, and source/artifact SHA-256 hashes. |
| `validation.json` | Camera clearance, framing, static-phase, motion, and proxy-visibility audit. |

`dataset.json` indexes all ten examples and embeds each prompt and resolved CSL. Browser-ready copies are in `web/public/trajectories/cinematic-suite/`. The TypeScript fixture export is `src/data/cinematic-examples.ts`.

## Trajectory and CSL contract

Positions are world-space metres. The supplied worlds use a right-handed, Y-up convention with camera forward along local **−Z**. Rotations are **XYZW quaternions**, not Euler angles. Field of view is **vertical degrees**; aspect ratio is **16:9**. Time is in seconds, and `playback time == scene time`; no retiming or cuts are introduced.

Each exported sample includes `t`, `position`, `positionVelocity`, `positionAcceleration`, `rotation`, `lookAt`, `fovYDegrees`, and `actionId`. The trajectory declares `orientation.mode = "quaternion"` and `interpolation.position = "quinticHermite"`. Camera position is interpolated with its velocity and acceleration jets; orientation uses quaternion SLERP. `lookAt` is a composition aid, not an instruction to discard the supplied quaternion: some films use an off-centre screen composition. Do not rename quaternion components, reinterpret FOV as horizontal, or treat every sampled pose as a cut.

The `shot-XX` action names denote phases **within one continuous take**, not edits. Some phases have concurrent dolly, crane, or zoom actions. CSL camera initialization and phase endpoint pose/lens constraints are populated from the authored reference. The semantic action and constraint structure remains available for controlled experiments, but it does not mathematically determine every intermediate sample. The deterministic generator is the exact regeneration source; running the numerical optimizer from CSL can produce a different path.

The generator samples the existing world transforms, including the native humanoid monotone-Hermite locomotion override. It uses symmetric **offline** smoothing to anticipate motion without reproducing every subject jolt. This is a reference-authoring method, not a causal online controller. Actor motion, event timing, object IDs, world geometry, and both environment JSON files are unchanged.

## Regenerate and check

Python 3.10 or newer and NumPy/SciPy are needed only for reference generation and the geometric audit:

```sh
python3 -m pip install -r requirements-cinematic.txt
npm run generate:cinematic
npm run typecheck:cinematic
npm run test:cinematic
npm run timelines:cinematic
```

`test:cinematic` runs native runtime validation first, then audits the exported JSON. Regeneration overwrites the ten generated reference pairs and their public mirrors, not the source environment files. After regeneration, rerun validation to refresh the reports.

The existing trajectory CLI now accepts `--suite cinematic`, or one of the ten IDs through `--example`. Timeline-only use is tested. Full numerical optimization is separate and is **not** needed for reference playback:

```sh
npm run generate:trajectories -- --suite cinematic --timeline-only
```

The two original default examples remain the default CLI selection. Cinematic timeline and optional optimizer artifacts use each film's ID, avoiding collisions with `output_1` and `output_2`.

## What was verified

**10/10** resolved CSL documents passed the project's grounding validation and target resolution. All ten compiled into timelines and loaded with the native browser trajectory parser with no warnings. Native replay was sampled at **60 Hz**, and the independent exported-file geometric audit evaluated **28,810 camera-time probes** across the collection.

Every explicitly required primary subject's complete transformed conservative bounding box stayed inside the camera frame at the tested times. The smallest normalized edge margin was **0.027**. A **0.25 m camera sphere** cleared all supplied entity bounding-box proxies at those times; the smallest sphere-to-proxy clearance across the collection was **0.913 m**. Unit quaternion continuity, finite values, constant scene/playback timing, static holds, lens ranges, and level horizons were also checked.

The Python sampler was cross-checked against the native project subject sampler: the largest absolute coordinate difference at the recorded control points was **1.12e-10 m**. Source environment hashes, generated metadata hashes, and browser-mirror equality passed. The new example integration and CLI passed a targeted strict TypeScript check, and the cinematic timeline-only CLI ran for all ten films.

These are **sampled geometric checks**, not continuous collision proofs or rendered-mesh visibility guarantees. Brief centre/upper-probe occlusions remain in some sports footage and around the factory collision; per-action percentages, first blocked times, and likely blocking proxies are recorded in `validation.json`. A subject can be inside the frame while partly occluded. No claim of perfect uninterrupted visibility is made.

**Not run here:** pixel-level WebGL film review, the complete dependency-installed application build, or full numerical camera optimization. Dependency installation was unavailable in the execution environment; a separate gallery browser smoke attempt was also blocked by the browser's local-address policy. The native loader, solver, sampler, generated-data checks, and targeted TypeScript checks above did run. The design is cinematic by authoring intent, while final aesthetic approval should use the included gallery and `storyboard.json` inspection times.

## Source provenance

The uploaded archive contained the complete scenes on Git branch **`origin/integration`**, commit **`14001bc9fc80a9dbe0f8e2f79c47036535fa06ab`**; its active checkout was an older, timeline-only tree. The completed project was built from that integration tree. `source-provenance.json` records the original source hashes, and the audit compares the current files against them. Git history, installed dependencies, credentials, and temporary build/download files are not included in this delivery.

This collection covers five narrative viewpoints in each existing world. It deliberately keeps a common full-length timeline and continuous-take format. It should not be interpreted as a diverse benchmark for cuts, retiming, arbitrary unknown environments, or human-rated cinematographic quality.
