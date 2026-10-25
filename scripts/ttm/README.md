# Optimizer trajectory -> TTM inputs

`prepare_optimizer_view.py` turns the optimizer's `trajectory.json` into the folder that
Time-to-Move (`run-wan.sh --input-path`) expects:

    input/first_frame.png   frame 0 of the source video (TTM keeps it)
    input/motion_signal.mp4 the source scene re-rendered along the optimizer camera (RGB-D reprojection)
    input/mask.mp4          white = pixels the re-render supports (TTM re-injects them), black = to be generated
    input/prompt.txt        text prompt (override with --prompt-file)
    (+ camera_path.npz, contact_sheet.png, manifest.json, sparse_projection.mp4, source_reference.mp4 for checking)

It must live next to the supervisor's `prepare_pianist_novel_view.py` (it imports its renderer).

## Local (repo) side - the pin must use the same --start as the converter
    npm run video:pin      -- --scene the-pianist --shot orbit-25 --start 0
    npm run video:optimize -- --scene the-pianist --shot orbit-25 --subject subject_1 --start 0
    # copy video/the-pianist/shots/orbit-25/trajectory.json and video/the-pianist/scene.json to the server

## Server (dmla100), from /media/external20/morteza_abolghasemi/TTM
    E=experiments/pianist_right15_20261016
    python tools/prepare_optimizer_view.py \
      --video $E/source/the-pianist.mp4 --frontend $E/source/frontend.npz --sidecar $E/source/scene.tracking.json \
      --trajectory <path>/trajectory.json --scene-registry <path>/scene.json \
      --output experiments/pianist_orbit25/input --start 0
    # inspect contact_sheet.png and manifest.json (coverage per frame) BEFORE the 70-minute run
    bash run-wan.sh --input-path experiments/pianist_orbit25/input \
      --output-path experiments/pianist_orbit25/ttm_orbit25.mp4 --num-frames 81 --num-inference-steps 50 \
      --tweak-index 2 --tstrong-index 5 --guidance-scale 3.5 --max-area 372736 --offload model --seed 0

## Safety checks (the script aborts rather than guess)
- trajectory frame 0 must coincide with the source camera (position/rotation tolerances) - otherwise the clip would jump;
- frame 0 re-render must reproduce the source frame (zero-motion reprojection error <= 1);
- minimum per-frame coverage must exceed --min-coverage (0.25);
- trajectories with cuts (`cutBefore`) are rejected.
