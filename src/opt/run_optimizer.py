import json
import sys
from pathlib import Path

import torch

from Optimization import optimize
from Timeline_adapter import build_constraints_from_timeline


OUTPUT_DIR = Path("../shared/optimized")
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)


def process_file(input_path: Path):

    print(f"Processing {input_path.name}")

    with open(input_path, "r", encoding="utf-8") as f:
        wrapper = json.load(f)

    constraints = build_constraints_from_timeline(
        wrapper["timeline"]
    )

    # Dummy subject data until real tracking is available.
    total_frames = int(wrapper["totalDuration"]) + 1

    subject_centers = {
        "C0": torch.zeros((total_frames, 3), dtype=torch.float64)
    }

    subject_tracks = {
        "C0": [
            {
                "bbox": [800, 800, 1000, 1000]
            }
            for _ in range(total_frames)
        ]
    }

    result = optimize(
        constraints=constraints,
        total_duration=wrapper["totalDuration"],
        subject_centers=subject_centers,
        subject_tracks=subject_tracks,
    )

    output = {
        "exampleId": input_path.stem,
        "result": result,
    }

    output_path = OUTPUT_DIR / f"{input_path.stem}_optimized.json"

    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2)

    print(f"Saved {output_path.name}")


def main():

    if len(sys.argv) != 2:
        print("Usage: python run_optimizer.py <timeline_json>")
        sys.exit(1)

    input_path = Path(sys.argv[1])

    if not input_path.exists():
        print(f"Input file does not exist: {input_path}")
        sys.exit(1)

    process_file(input_path)


if __name__ == "__main__":
    main()