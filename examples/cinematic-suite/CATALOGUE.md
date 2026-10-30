# Cinematic catalogue — ten complete examples

Five films per original environment. All are 48-second, normal-speed continuous takes with 1,441 camera samples. The paths are AI-authored synthetic references, not measured footage or optimizer output. Each table describes phases inside a take, not cuts.

Full numeric data is in each `trajectory.json`; the pose rows below are only inspection points. Positions are world-space metres, Y-up; FOV is vertical degrees. Quaternions and derivative data are in the JSON files.

## 01. The Winner's Run

**Environment:** `stadium` · **ID:** `stadium-01-winners-run` · **Design:** Hero tracking / finish / crane reveal

[Prompt](stadium-01-winners-run/prompt.txt) · [Resolved CSL](stadium-01-winners-run/csl.json) · [Semantic CSL](stadium-01-winners-run/draft-csl.json) · [Full trajectory](stadium-01-winners-run/trajectory.json) · [Validation](stadium-01-winners-run/validation.json)

### Text prompt

Create one uninterrupted 48-second sports-hero shot in the stadium, at normal scene speed. Follow runner 01, the red-shirted eventual winner, from the outside of the athletics track; this is the main filming camera, not the visible sideline cameraman. Begin with a generous elevated three-quarter view and descend into a smooth, slightly trailing track by 8 seconds. Keep the runner just left of centre with breathing room rather than chasing every footfall. Maintain the outward-side route around the bend. From 33 to 37 seconds widen and rise gently so the finish ribbon is readable. Stay on this runner through the finish at 38 seconds and the celebratory jump at 39.3–40.3 seconds. From 41 to 48 seconds crane up and pull back to include the nearby flower shower and spectators, while retaining the winner as the visual anchor. Use a level horizon, restrained lens changes, and no cuts, shake, slow motion, or teleports.

### CSL phase plan

| Time (s) | Phase | Main movement | Required primary subjects |
|---|---|---|---|
| 0–8 | Establish and descend | `follow` | `runner_01` |
| 8–33 | Outside-track hero follow | `follow` | `runner_01` |
| 33–41 | Finish and celebration | `follow` | `runner_01` |
| 41–48 | Winner-to-crowd reveal | `craneUp` | `runner_01` |

### Generated camera inspection points

| Scene time (s) | Position X, Y, Z (m) | FOV Y (°) |
|---|---|---|
| 0 | -30.589, 8.000, -45.610 | 45.00 |
| 5 | -46.765, 7.058, -44.061 | 39.20 |
| 25 | -45.796, 6.700, 43.402 | 37.00 |
| 39.8 | 46.297, 7.700, 44.610 | 45.00 |
| 45 | 46.300, 11.050, 49.035 | 47.50 |
| 48 | 46.300, 13.000, 51.610 | 50.00 |

**Geometric audit:** PASS; minimum 0.25 m camera-sphere clearance 3.529 m. Required primary bounds stayed fully in-frame at 60 Hz.

**Proxy-visibility review:** runner_01: 99.40% of 8–33s has at least one clear centre/upper probe; runner_01: 99.17% of 33–41s has at least one clear centre/upper probe. These are centre/upper probes, not rendered-pixel measurements.

## 02. Fall and Resolve

**Environment:** `stadium` · **ID:** `stadium-02-fall-and-resolve` · **Design:** Recovery story / anticipatory widening

[Prompt](stadium-02-fall-and-resolve/prompt.txt) · [Resolved CSL](stadium-02-fall-and-resolve/csl.json) · [Semantic CSL](stadium-02-fall-and-resolve/draft-csl.json) · [Full trajectory](stadium-02-fall-and-resolve/trajectory.json) · [Validation](stadium-02-fall-and-resolve/validation.json)

### Text prompt

Film a continuous 48-second recovery story centred on runner 03, the yellow-shirted runner, in the stadium. Start in a stable elevated side-follow outside the racing lanes. Track this runner, not the race leader. Between 10 and 13.5 seconds move outward and slightly upward, widening before the fall begins at 13.7 seconds. Keep the entire falling body and the patch of track visible through the fall and recovery at 16.8–18 seconds; do not make an abrupt camera dip. Between 18.5 and 24 seconds ease back into the following distance as the runner resumes the race. Continue with this same runner through their later finish around 44.8 seconds. End with a gentle elevated pullback that gives the recovered runner room in the frame. Retain natural scene timing, smooth acceleration and a level horizon; use no cuts, dramatic roll, or freeze frames.

### CSL phase plan

| Time (s) | Phase | Main movement | Required primary subjects |
|---|---|---|---|
| 0–10 | Track the recovering protagonist | `follow` | `runner_03` |
| 10–18.5 | Anticipate and cover the fall | `follow` | `runner_03` |
| 18.5–24 | Rejoin the run | `follow` | `runner_03` |
| 24–41 | Recovery tracking | `follow` | `runner_03` |
| 41–48 | Late finish and release | `craneUp` | `runner_03` |

### Generated camera inspection points

| Scene time (s) | Position X, Y, Z (m) | FOV Y (°) |
|---|---|---|
| 0 | -39.754, 5.200, -46.050 | 39.00 |
| 8 | -68.775, 4.541, -38.920 | 37.12 |
| 15 | -93.699, 6.000, -13.428 | 45.00 |
| 23 | -85.384, 4.854, 24.152 | 38.31 |
| 44.8 | 34.240, 6.656, 48.950 | 42.64 |
| 48 | 36.800, 8.000, 51.050 | 46.00 |

**Geometric audit:** PASS; minimum 0.25 m camera-sphere clearance 1.751 m. Required primary bounds stayed fully in-frame at 60 Hz.

**Proxy-visibility review:** runner_03: 99.05% of 41–48s has at least one clear centre/upper probe. These are centre/upper probes, not rendered-pixel measurements.

## 03. The Decisive Play

**Environment:** `stadium` · **ID:** `stadium-03-decisive-play` · **Design:** Ball tracking / settled goal coverage

[Prompt](stadium-03-decisive-play/prompt.txt) · [Resolved CSL](stadium-03-decisive-play/csl.json) · [Semantic CSL](stadium-03-decisive-play/draft-csl.json) · [Full trajectory](stadium-03-decisive-play/trajectory.json) · [Validation](stadium-03-decisive-play/validation.json)

### Text prompt

Make a 48-second, single-take football sequence inside the stadium. Follow the ball from an elevated touchline-style camera on the positive-Z side of the pitch, keeping enough field in view to understand the passing play. Smooth the camera path across changes in ball direction instead of copying the ball's sharp turns. From 29 to 35 seconds leave the moving follow rig and settle into a wider fixed view containing the approaching ball and the east goal. Hold this shot through the kick, the goal at 38.2 seconds, and the ball settling in the net; do not cut away to the simultaneous running-race finish. After 40 seconds drift gently toward a more frontal view of the east goal and finish on the result of the play. Use normal playback, a level horizon, a moderately wide lens, and no handheld shake or snap pans.

### CSL phase plan

| Time (s) | Phase | Main movement | Required primary subjects |
|---|---|---|---|
| 0–29 | Ball-led field coverage | `track` | `ball` |
| 29–35 | Settle for the attack | `track` | `ball` |
| 35–40 | Hold the ball and east goal | `static` | `ball`, `goal_east` |
| 40–48 | Goal aftermath drift | `arcRight` | `ball`, `goal_east` |

### Generated camera inspection points

| Scene time (s) | Position X, Y, Z (m) | FOV Y (°) |
|---|---|---|
| 0 | -19.282, 8.500, 26.299 | 43.00 |
| 8 | 3.744, 8.500, 33.385 | 43.00 |
| 24 | 6.200, 8.500, 20.400 | 43.00 |
| 37.6 | 33.000, 8.500, 23.000 | 48.00 |
| 43 | 33.479, 8.500, 22.984 | 46.83 |
| 48 | 36.816, 8.500, 23.933 | 44.00 |

**Geometric audit:** PASS; minimum 0.25 m camera-sphere clearance 6.422 m. Required primary bounds stayed fully in-frame at 60 Hz.

**Proxy-visibility review:** ball: 97.36% of 0–29s has at least one clear centre/upper probe; ball: 93.63% of 29–35s has at least one clear centre/upper probe; ball: 98.34% of 35–40s has at least one clear centre/upper probe. These are centre/upper probes, not rendered-pixel measurements.

## 04. Behind the Sideline Lens

**Environment:** `stadium` · **ID:** `stadium-04-behind-the-lens` · **Design:** Character study / parallel tracking

[Prompt](stadium-04-behind-the-lens/prompt.txt) · [Resolved CSL](stadium-04-behind-the-lens/csl.json) · [Semantic CSL](stadium-04-behind-the-lens/draft-csl.json) · [Full trajectory](stadium-04-behind-the-lens/trajectory.json) · [Validation](stadium-04-behind-the-lens/validation.json)

### Text prompt

Create a 48-second behind-the-scenes portrait of the independent sideline cameraman in the stadium. The visible track_cameraman is the subject, carrying the physical shoulder camera; do not mistake him for the filming viewpoint. Track from farther outside the oval, above the spectator sightline, starting slightly behind him. Move with his run in a stable medium-long composition and let the racing action appear as context behind him. From 12 to 32 seconds make a very gradual transition toward a side/front-quarter relationship without orbiting through the track or stands. Continue through the race finish, then widen and rise from 34 to 48 seconds to show the operator within the event he is filming. Keep his full body and equipment readable, respect the grandstands, maintain a level horizon, and use one uninterrupted take at normal speed.

### CSL phase plan

| Time (s) | Phase | Main movement | Required primary subjects |
|---|---|---|---|
| 0–12 | Follow the operator | `follow` | `track_cameraman` |
| 12–32 | Gradual parallel lead change | `follow` | `track_cameraman` |
| 32–40 | Finish-line context | `follow` | `track_cameraman` |
| 40–48 | Operator within the event | `craneUp` | `track_cameraman` |

### Generated camera inspection points

| Scene time (s) | Position X, Y, Z (m) | FOV Y (°) |
|---|---|---|
| 0 | -31.589, 6.300, -50.710 | 40.00 |
| 5 | -48.114, 5.998, -50.047 | 37.59 |
| 21 | -71.815, 5.800, 42.436 | 36.00 |
| 35 | 25.936, 7.055, 46.572 | 36.28 |
| 45 | 46.300, 9.229, 53.458 | 47.62 |
| 48 | 46.300, 10.000, 56.210 | 49.00 |

**Geometric audit:** PASS; minimum 0.25 m camera-sphere clearance 2.325 m. Required primary bounds stayed fully in-frame at 60 Hz.

**Proxy-visibility review:** track_cameraman: 93.14% of 32–40s has at least one clear centre/upper probe. These are centre/upper probes, not rendered-pixel measurements.

## 05. The Stadium Breathes

**Environment:** `stadium` · **ID:** `stadium-05-stadium-breathes` · **Design:** 60-degree aerial arc / geographic master

[Prompt](stadium-05-stadium-breathes/prompt.txt) · [Resolved CSL](stadium-05-stadium-breathes/csl.json) · [Semantic CSL](stadium-05-stadium-breathes/draft-csl.json) · [Full trajectory](stadium-05-stadium-breathes/trajectory.json) · [Validation](stadium-05-stadium-breathes/validation.json)

### Text prompt

Make a 48-second architectural aerial master of the stadium, not a close-up sports shot. Keep the athletics oval, infield football pitch, and stands readable together. Move through a steady 60-degree rightward arc around the centre at an approximately 170-metre horizontal radius. Begin at 67 metres height, descend smoothly to 58 metres over the first 12 seconds, hold that height until 36 seconds, then rise smoothly to 73 metres by the end. Use a fixed 58-degree vertical field of view and a level horizon. The ongoing race and football match should remain environmental activity inside the composition; do not promise facial or ball detail from this distance. Preserve the full normal-speed scene clock and use no cuts, zooms, shake, or sudden changes of angular pace.

### CSL phase plan

| Time (s) | Phase | Main movement | Required primary subjects |
|---|---|---|---|
| 0–12 | Descending aerial arc | `arcRight` | `athletics_track`, `football_pitch` |
| 12–36 | Geographic master | `arcRight` | `athletics_track`, `football_pitch` |
| 36–48 | Ascending final arc | `arcRight` | `athletics_track`, `football_pitch` |

### Generated camera inspection points

| Scene time (s) | Position X, Y, Z (m) | FOV Y (°) |
|---|---|---|
| 0 | 71.845, 67.000, 154.072 | 58.00 |
| 16 | 120.208, 58.000, 120.208 | 58.00 |
| 32 | 154.072, 58.000, 71.845 | 58.00 |
| 48 | 169.353, 73.000, 14.816 | 58.00 |

**Geometric audit:** PASS; minimum 0.25 m camera-sphere clearance 94.113 m. Required primary bounds stayed fully in-frame at 60 Hz.

**Proxy-visibility review:** No phase fell below 99.9% with at least one clear centre/upper probe. This does not establish full-body pixel visibility.

## 06. Production to Stillness

**Environment:** `factory` · **ID:** `factory-01-production-to-stillness` · **Design:** Product-led opening / dramatic reveal

[Prompt](factory-01-production-to-stillness/prompt.txt) · [Resolved CSL](factory-01-production-to-stillness/csl.json) · [Semantic CSL](factory-01-production-to-stillness/draft-csl.json) · [Full trajectory](factory-01-production-to-stillness/trajectory.json) · [Validation](factory-01-production-to-stillness/validation.json)

### Text prompt

Create one continuous 48-second factory sequence that changes from ordered production to quiet aftermath. Start by tracking cargo 01 along the conveyor in a composed product-led view, with the assembly line as background. Between 8 and 16 seconds smoothly leave the product tracking rig and reveal workers A and B in the south aisle; widen the lens gradually during the handoff. Be settled by 16 seconds in a stable elevated view that contains the argument, the shove at 20 seconds, the collision at 21 seconds, and the first falling pieces of cargo. Hold the physical camera still from 16 to 24 seconds so the cause and effect remain easy to read. From 24 to 48 seconds slowly pull back and rise, including the workers' reaction and the stopped production line. Stay inside the factory below its ceiling, preserve the normal scene clock, and use no cuts or camera shake.

### CSL phase plan

| Time (s) | Phase | Main movement | Required primary subjects |
|---|---|---|---|
| 0–8 | Conveyor product tracking | `track` | `cargo_01` |
| 8–16 | Product-to-workers handoff | `track` | Transition / establishing frame; no per-frame primary constraint |
| 16–24 | Locked causal master | `static` | `worker_a`, `worker_b`, `cargo_06` |
| 24–48 | Pull back into stillness | `craneUp` | `worker_a`, `worker_b` |

### Generated camera inspection points

| Scene time (s) | Position X, Y, Z (m) | FOV Y (°) |
|---|---|---|
| 0 | -10.030, 3.400, 3.950 | 32.00 |
| 4 | -7.900, 3.400, 3.950 | 32.00 |
| 16 | 4.800, 4.700, 9.000 | 53.00 |
| 21.5 | 4.800, 4.700, 9.000 | 53.00 |
| 43 | 9.307, 7.219, 15.614 | 53.61 |
| 48 | 10.000, 7.600, 17.000 | 55.00 |

**Geometric audit:** PASS; minimum 0.25 m camera-sphere clearance 1.650 m. Required primary bounds stayed fully in-frame at 60 Hz.

**Proxy-visibility review:** worker_a: 99.58% of 16–24s has at least one clear centre/upper probe; worker_b: 96.26% of 16–24s has at least one clear centre/upper probe. These are centre/upper probes, not rendered-pixel measurements.

## 07. The Aisle Two-Shot

**Environment:** `factory` · **ID:** `factory-02-aisle-two-shot` · **Design:** Intimate two-shot / anticipatory retreat

[Prompt](factory-02-aisle-two-shot/prompt.txt) · [Resolved CSL](factory-02-aisle-two-shot/csl.json) · [Semantic CSL](factory-02-aisle-two-shot/draft-csl.json) · [Full trajectory](factory-02-aisle-two-shot/trajectory.json) · [Validation](factory-02-aisle-two-shot/validation.json)

### Text prompt

Film workers A and B in a restrained, uninterrupted 48-second two-shot in the factory's south aisle. Start in an elevated wide shot that contains both separated workers and looks over the control cabinet. Descend and tighten gradually as they converge, reaching a near-eye-level full two-shot by 12 seconds. Hold a respectful distance through the argument at 12.2–17 seconds. Between 17 and 20 seconds retreat, rise, and widen before the shove: the audience must see both bodies and the space between them. Maintain that more generous view through the impact at 21 seconds and the cargo spill, without whipping the camera toward individual falling items. After 25 seconds drift back into a quiet, wider two-shot of the workers and their immediate surroundings. Keep screen geography consistent from the same side of the aisle, use normal playback, and avoid cuts, shake, and extreme lens distortion.

### CSL phase plan

| Time (s) | Phase | Main movement | Required primary subjects |
|---|---|---|---|
| 0–12 | Converging two-shot | `track` | `worker_a`, `worker_b` |
| 12–17 | Argument at respectful distance | `follow` | `worker_a`, `worker_b` |
| 17–25 | Retreat before the shove | `follow` | `worker_a`, `worker_b` |
| 25–36 | Release into aftermath | `follow` | `worker_a`, `worker_b` |
| 36–48 | Quiet final two-shot | `static` | `worker_a`, `worker_b` |

### Generated camera inspection points

| Scene time (s) | Position X, Y, Z (m) | FOV Y (°) |
|---|---|---|
| 0 | 0.501, 7.100, 6.000 | 78.00 |
| 5 | 0.865, 5.940, 6.000 | 67.85 |
| 15 | 0.860, 2.500, 7.738 | 40.00 |
| 21 | 1.917, 4.000, 8.714 | 51.00 |
| 38 | 3.250, 3.500, 12.125 | 43.00 |
| 48 | 3.250, 3.500, 12.125 | 43.00 |

**Geometric audit:** PASS; minimum 0.25 m camera-sphere clearance 1.714 m. Required primary bounds stayed fully in-frame at 60 Hz.

**Proxy-visibility review:** worker_a: 99.58% of 17–25s has at least one clear centre/upper probe; worker_b: 97.92% of 17–25s has at least one clear centre/upper probe. These are centre/upper probes, not rendered-pixel measurements.

## 08. The Chain Reaction

**Environment:** `factory` · **ID:** `factory-03-chain-reaction` · **Design:** High-angle master / spatial causality

[Prompt](factory-03-chain-reaction/prompt.txt) · [Resolved CSL](factory-03-chain-reaction/csl.json) · [Semantic CSL](factory-03-chain-reaction/draft-csl.json) · [Full trajectory](factory-03-chain-reaction/trajectory.json) · [Validation](factory-03-chain-reaction/validation.json)

### Text prompt

Create a 48-second high-angle, single-take factory master that explains the chain reaction spatially. Begin with a broad interior view of the conveyor and its two end stations. Over the first 14 seconds move closer to an elevated view of the central south-side work area, remaining around 8.1 metres high and below the ceiling and beams. From 14 to 26 seconds lock both camera position and aim. In that frame, show workers A and B, the shove at 20 seconds, the impact and clustered cargo spill at 21 seconds, and the emergency operator near the control station at 21.7 seconds. Prioritize clear spatial relationships over close-ups. After 26 seconds slowly withdraw and drift to the right to reveal the stopped line and the wider response. Use a level horizon, normal speed, gentle lens changes, and no cuts or shake.

### CSL phase plan

| Time (s) | Phase | Main movement | Required primary subjects |
|---|---|---|---|
| 0–14 | Interior geography to causal master | `dollyIn` | Transition / establishing frame; no per-frame primary constraint |
| 14–26 | Locked high-angle chain reaction | `static` | `worker_a`, `worker_b`, `cargo_06`, `worker_05` |
| 26–48 | Reveal the stopped system | `dollyOut` | `worker_a`, `worker_b`, `worker_05` |

### Generated camera inspection points

| Scene time (s) | Position X, Y, Z (m) | FOV Y (°) |
|---|---|---|
| 0 | 0.000, 8.100, 12.000 | 68.00 |
| 15 | 2.000, 8.100, 6.500 | 56.00 |
| 21.7 | 2.000, 8.100, 6.500 | 56.00 |
| 42 | 3.742, 8.187, 10.420 | 60.36 |
| 48 | 4.000, 8.200, 11.000 | 61.00 |

**Geometric audit:** PASS; minimum 0.25 m camera-sphere clearance 0.913 m. Required primary bounds stayed fully in-frame at 60 Hz.

**Proxy-visibility review:** worker_a: 99.58% of 14–26s has at least one clear centre/upper probe; worker_b: 95.28% of 14–26s has at least one clear centre/upper probe. These are centre/upper probes, not rendered-pixel measurements.

## 09. The Emergency Operator

**Environment:** `factory` · **ID:** `factory-04-emergency-operator` · **Design:** Supporting character / response coverage

[Prompt](factory-04-emergency-operator/prompt.txt) · [Resolved CSL](factory-04-emergency-operator/csl.json) · [Semantic CSL](factory-04-emergency-operator/draft-csl.json) · [Full trajectory](factory-04-emergency-operator/trajectory.json) · [Validation](factory-04-emergency-operator/validation.json)

### Text prompt

Make a 48-second factory sequence centred on worker 05, the emergency-stop operator, rather than the arguing pair. Begin from the south-east in a calm three-quarter composition that includes worker 05 and the control station. Push in very gently until 16 seconds, then lock the camera through 24 seconds. Keep a clear oblique view when the worker reaches the station around 21.7 seconds and the production line ramps down by 22.7 seconds; do not invent a close-up button-press animation that the scene does not contain. From 24 to 35 seconds rise and pull back, shifting the composition toward the affected workers and the operator together. Finish with a slow lateral drift through 48 seconds that connects the emergency response to the aftermath. Remain inside the room, avoid hiding the operator behind the control cabinet, preserve normal playback, and use no cuts or shake.

### CSL phase plan

| Time (s) | Phase | Main movement | Required primary subjects |
|---|---|---|---|
| 0–16 | Approach the operator | `dollyIn` | `worker_05`, `control_station` |
| 16–24 | Emergency-stop coverage | `static` | `worker_05`, `control_station` |
| 24–35 | Connect operator and aftermath | `craneUp` | Transition / establishing frame; no per-frame primary constraint |
| 35–48 | Response tableau | `truckLeft` | `worker_a`, `worker_b`, `worker_05` |

### Generated camera inspection points

| Scene time (s) | Position X, Y, Z (m) | FOV Y (°) |
|---|---|---|
| 0 | 12.000, 4.000, 5.500 | 39.00 |
| 8 | 11.150, 3.650, 6.650 | 37.50 |
| 21.7 | 10.300, 3.300, 7.800 | 36.00 |
| 29 | 8.847, 4.463, 9.544 | 40.98 |
| 44 | 4.320, 6.100, 12.000 | 48.00 |
| 48 | 3.800, 6.100, 12.000 | 48.00 |

**Geometric audit:** PASS; minimum 0.25 m camera-sphere clearance 1.594 m. Required primary bounds stayed fully in-frame at 60 Hz.

**Proxy-visibility review:** No phase fell below 99.9% with at least one clear centre/upper probe. This does not establish full-body pixel visibility.

## 10. One Piece, Many Consequences

**Environment:** `factory` · **ID:** `factory-05-one-piece` · **Design:** Cargo-led story / floor-level aftermath

[Prompt](factory-05-one-piece/prompt.txt) · [Resolved CSL](factory-05-one-piece/csl.json) · [Semantic CSL](factory-05-one-piece/draft-csl.json) · [Full trajectory](factory-05-one-piece/trajectory.json) · [Validation](factory-05-one-piece/validation.json)

### Text prompt

Tell a 48-second factory story through cargo 06, the sixth piece that spills from the production line. For the first 15 seconds smoothly track this piece with a relatively tight product-led composition; show enough conveyor to establish its movement. Between 15 and 20 seconds rise, move farther out, and widen before the impact. Track the piece through its airborne motion beginning at 21.3 seconds and its bounce and settling, smoothing the camera rather than copying the object's vertical jolt. Keep the production line and fragments of the workers' action as context. Between 26 and 34 seconds make a deliberate smooth handoff to a low oblique, stationary view of the resting piece on the floor. Hold that quiet insert from 34 to 48 seconds while the factory aftermath continues behind it. Use a level horizon, normal scene speed, no cuts, no focus-pull claims, and no camera intersections with the floor, workers, or machinery.

### CSL phase plan

| Time (s) | Phase | Main movement | Required primary subjects |
|---|---|---|---|
| 0–15 | Product-led tracking | `track` | `cargo_06` |
| 15–20 | Anticipatory lift and widen | `track` | `cargo_06` |
| 20–26 | Spill, bounce, and settling | `track` | `cargo_06` |
| 26–34 | Handoff to low aftermath insert | `track` | `cargo_06` |
| 34–48 | Resting piece, living background | `static` | `cargo_06` |

### Generated camera inspection points

| Scene time (s) | Position X, Y, Z (m) | FOV Y (°) |
|---|---|---|
| 0 | -6.234, 3.400, 4.140 | 29.00 |
| 5 | -3.550, 3.400, 4.140 | 29.00 |
| 21.7 | 6.153, 5.800, 7.472 | 44.00 |
| 23 | 7.486, 5.800, 9.717 | 44.00 |
| 40 | 4.035, 2.060, 7.070 | 31.00 |
| 48 | 4.035, 2.060, 7.070 | 31.00 |

**Geometric audit:** PASS; minimum 0.25 m camera-sphere clearance 1.433 m. Required primary bounds stayed fully in-frame at 60 Hz.

**Proxy-visibility review:** No phase fell below 99.9% with at least one clear centre/upper probe. This does not establish full-body pixel visibility.
