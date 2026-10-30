# Cinematic dataset — 10 examples

Five examples use `stadium`; five use `factory`. Each folder contains a complete director prompt, resolved CSL, semantic CSL and binding, 48-second trajectory with 1,441 samples, keyframes, storyboard, compiled timeline, metadata, and validation results.

Read **CATALOGUE.md** for all ten complete prompts and their timed camera plans. **PROJECT_GUIDE.md** contains the full project usage guide, schema conventions, regeneration commands, provenance, and validation boundaries. It describes paths relative to the completed project. This data-only archive does not contain the viewer, source worlds, or generation code: use the companion completed-project archive for those.

## Load the pairs with standard Python

```python
import json
from pathlib import Path

base = Path(".")  # Directory containing dataset.json.
dataset = json.loads((base / "dataset.json").read_text(encoding="utf-8"))
for example in dataset["examples"]:
    prompt = example["prompt"]
    csl = example["resolvedCsl"]
    trajectory = json.loads(
        (base / example["files"]["trajectory"]).read_text(encoding="utf-8")
    )
    assert trajectory["environmentId"] == example["environmentId"]
    assert len(trajectory["samples"]) == 1441
    print(example["id"], trajectory["samples"][0]["position"])
```

No model API is needed. The camera paths are **AI-authored synthetic references**, not measured or uniquely optimal ground truth. Preserve the supplied XYZ/XYZW convention, vertical field of view, normal scene clock, interpolation mode, and position derivative fields. For replay, use the native quaternion orientation; `lookAt` alone does not preserve off-centre framing.

`validation-report.json` records sampled framing and clearance, plus remaining proxy-visibility notes. `runtime-validation.json` records actual project parser/solver/sampler checks. `source-provenance.json` identifies the two original worlds and their hashes. `DELIVERY_VALIDATION.json` records delivery-level checks and tests not run.
