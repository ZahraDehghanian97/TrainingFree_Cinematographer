# Optimizer module layout

Implementation code is grouped by responsibility:

- `math3d/`: NumPy and Torch quaternion math plus camera geometry.
- `losses/`: loss configuration, interval/subject/arc losses, and dispatch.
- `solver/`: control-point initialization and the iterative optimizer engine.
- `pipeline/`: metadata, playback, trajectory serialization, and file output.

Import descriptive APIs from those packages, for example
`solver.optimizer.optimize_camera_trajectory` and
`losses.dispatcher.compute_trajectory_loss`. Short-name compatibility wrappers
have been removed.

`run_optimizer.py` remains at the root because the TypeScript pipeline launches
that file directly. The modules reachable from it support both package imports
(`src.opt...`) and the bare imports required when it runs from `src/opt`.

Run the optimizer checks from the repository root:

```bash
PYTHONDONTWRITEBYTECODE=1 python3.10 -m unittest src.opt.test_pipeline -v
ruff check src/opt --exclude '*.ipynb'
```
