"""Run the timeline optimizer and publish both debug and viewer-ready output."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
import re
import sys
from typing import Any, Sequence

try:
    from .timebase import frame_count_for_duration
    from .trajectory_pipeline import build_camera_trajectory
except ImportError:
    from timebase import frame_count_for_duration
    from trajectory_pipeline import build_camera_trajectory


PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEBUG_OUTPUT_DIR = PROJECT_ROOT / "shared" / "optimized"
VIEWER_OUTPUT_DIR = PROJECT_ROOT / "web" / "public" / "trajectories" / "optimized"
ENVIRONMENT_DIR = PROJECT_ROOT / "web" / "public" / "environments"

DEFAULT_FPS = 30.0
SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
LEGACY_OUTPUT_STEM = re.compile(r"^output_(\d+)$")


def _positive_float(value: str) -> float:
    number = float(value)
    if not math.isfinite(number) or number <= 0:
        raise argparse.ArgumentTypeError("must be a positive finite number")
    return number


def _positive_int(value: str) -> int:
    number = int(value)
    if number <= 0:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return number


def build_argument_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=(
            "Optimize a flattened timeline, keep the raw optimizer result, and "
            "emit a canonical CameraTrajectoryV1 for the web viewer."
        )
    )
    parser.add_argument("timeline_json", type=Path, help="timeline wrapper JSON")
    parser.add_argument(
        "--trajectory-output",
        type=Path,
        help=(
            "viewer trajectory destination; defaults to "
            "web/public/trajectories/optimized/<exampleId>-camera.json"
        ),
    )
    parser.add_argument(
        "--debug-output",
        type=Path,
        help=(
            "raw optimizer destination; defaults to "
            "shared/optimized/<input-stem>_optimized.json"
        ),
    )
    parser.add_argument(
        "--fps",
        type=_positive_float,
        help="trajectory samples per second (environment fpsHint or 30 by default)",
    )
    parser.add_argument(
        "--max-iter",
        type=_positive_int,
        help="override the optimizer iteration limit",
    )
    return parser


def _metadata_value(wrapper: dict[str, Any], key: str) -> Any:
    if key in wrapper:
        return wrapper[key]
    metadata = wrapper.get("metadata")
    if isinstance(metadata, dict):
        return metadata.get(key)
    return None


def infer_example_id(wrapper: dict[str, Any], input_stem: str) -> str | None:
    example_id = _metadata_value(wrapper, "exampleId")
    if example_id is not None:
        if not isinstance(example_id, str) or not SAFE_ID.fullmatch(example_id):
            raise ValueError("exampleId must be a filesystem-safe non-empty string")
        return example_id

    embedded_environment = wrapper.get("environment")
    if isinstance(embedded_environment, dict):
        prompt_example_id = embedded_environment.get("promptExampleId")
        if isinstance(prompt_example_id, str) and prompt_example_id:
            return prompt_example_id

    legacy_match = LEGACY_OUTPUT_STEM.fullmatch(input_stem)
    if legacy_match:
        return f"example-{int(legacy_match.group(1)):02d}"
    return None


def _read_json_object(path: Path, description: str) -> dict[str, Any]:
    try:
        with path.open("r", encoding="utf-8") as file:
            value = json.load(file)
    except json.JSONDecodeError as error:
        raise ValueError(f"{description} is not valid JSON: {error}") from error
    if not isinstance(value, dict):
        raise ValueError(f"{description} must contain a JSON object")
    return value


def _find_environment(
    wrapper: dict[str, Any],
    example_id: str | None,
) -> dict[str, Any] | None:
    embedded = wrapper.get("environment")
    if isinstance(embedded, dict):
        return embedded

    if example_id is not None:
        candidate = ENVIRONMENT_DIR / f"{example_id}.json"
        if candidate.is_file():
            return _read_json_object(candidate, f"environment {candidate}")

    environment_id = _metadata_value(wrapper, "environmentId")
    if isinstance(environment_id, str) and ENVIRONMENT_DIR.is_dir():
        for candidate in sorted(ENVIRONMENT_DIR.glob("*.json")):
            if candidate.name == "manifest.json":
                continue
            environment = _read_json_object(candidate, f"environment {candidate}")
            if environment.get("id") == environment_id:
                return environment
    return None


def resolve_pipeline_metadata(
    wrapper: dict[str, Any],
    input_stem: str,
    fps_override: float | None = None,
) -> dict[str, Any]:
    timeline = wrapper.get("timeline")
    if not isinstance(timeline, dict) or not isinstance(timeline.get("timeline"), list):
        raise ValueError("timeline wrapper must contain timeline.timeline[]")

    duration_value = wrapper.get("totalDuration")
    if isinstance(duration_value, bool) or not isinstance(duration_value, (int, float)):
        raise ValueError("timeline wrapper totalDuration must be a number")
    duration = float(duration_value)
    if not math.isfinite(duration) or duration <= 0:
        raise ValueError("timeline wrapper totalDuration must be positive and finite")

    example_id = infer_example_id(wrapper, input_stem)
    environment = _find_environment(wrapper, example_id)
    environment_id = _metadata_value(wrapper, "environmentId")
    if environment_id is None and environment is not None:
        environment_id = environment.get("id")
    if not isinstance(environment_id, str) or not environment_id.strip():
        raise ValueError(
            "timeline wrapper must provide environmentId (or resolve to a matching "
            "web/public/environments/<exampleId>.json)"
        )
    if environment is not None:
        resolved_environment_id = environment.get("id")
        if resolved_environment_id != environment_id:
            raise ValueError(
                f"environmentId {environment_id!r} does not match environment "
                f"{resolved_environment_id!r}"
            )
        environment_duration = environment.get("clock", {}).get("durationSeconds")
        if (
            isinstance(environment_duration, (int, float))
            and not isinstance(environment_duration, bool)
            and not math.isclose(float(environment_duration), duration, abs_tol=1e-9)
        ):
            raise ValueError(
                f"totalDuration {duration} does not match environment duration "
                f"{environment_duration}"
            )

    coordinates = _metadata_value(wrapper, "coordinates")
    if coordinates is None and environment is not None:
        coordinates = environment.get("coordinates")
    if coordinates is not None and not isinstance(coordinates, dict):
        raise ValueError("coordinates metadata must be an object")

    intrinsics = _metadata_value(wrapper, "intrinsics")
    if intrinsics is None and environment is not None:
        environment_camera = environment.get("camera")
        if isinstance(environment_camera, dict):
            intrinsics = environment_camera.get("intrinsics")
        if intrinsics is None:
            intrinsics = environment.get("intrinsics")
    if intrinsics is not None and not isinstance(intrinsics, dict):
        raise ValueError("intrinsics metadata must be an object")

    fps_value: Any = fps_override
    if fps_value is None:
        fps_value = _metadata_value(wrapper, "fps")
    if fps_value is None:
        fps_value = _metadata_value(wrapper, "fpsHint")
    if fps_value is None and environment is not None:
        fps_value = environment.get("clock", {}).get("fpsHint")
    if fps_value is None:
        fps_value = DEFAULT_FPS
    if isinstance(fps_value, bool) or not isinstance(fps_value, (int, float)):
        raise ValueError("fps must be a number")
    fps = float(fps_value)
    if not math.isfinite(fps) or fps <= 0:
        raise ValueError("fps must be positive and finite")

    return {
        "exampleId": example_id,
        "environmentId": environment_id,
        "durationSeconds": duration,
        "timeline": timeline,
        "coordinates": coordinates,
        "intrinsics": intrinsics,
        "fps": fps,
    }


def default_output_paths(
    input_path: Path,
    example_id: str | None,
    *,
    debug_output: Path | None = None,
    trajectory_output: Path | None = None,
) -> tuple[Path, Path, Path | None]:
    debug_path = (
        debug_output.resolve()
        if debug_output is not None
        else DEBUG_OUTPUT_DIR / f"{input_path.stem}_optimized.json"
    )
    archive_path = DEBUG_OUTPUT_DIR / f"{input_path.stem}_camera.json"
    if trajectory_output is not None:
        viewer_path = trajectory_output.resolve()
    elif example_id is not None:
        viewer_path = VIEWER_OUTPUT_DIR / f"{example_id}-camera.json"
    else:
        viewer_path = None
    return debug_path, archive_path, viewer_path


def _write_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = path.with_name(f".{path.name}.tmp")
    try:
        with temporary_path.open("w", encoding="utf-8") as file:
            json.dump(value, file, ensure_ascii=False, indent=2, allow_nan=False)
            file.write("\n")
        temporary_path.replace(path)
    except BaseException:
        temporary_path.unlink(missing_ok=True)
        raise


def _load_optimizer_dependencies():
    try:
        import torch
    except ModuleNotFoundError as error:
        raise RuntimeError(
            "Optimizer dependency 'torch' is missing; install src/opt/requirements.txt"
        ) from error

    try:
        from .Optimization import optimize
        from .Timeline_adapter import build_constraints_from_timeline
    except ImportError:
        from Optimization import optimize
        from Timeline_adapter import build_constraints_from_timeline
    return torch, optimize, build_constraints_from_timeline


def process_file(
    input_path: Path,
    *,
    trajectory_output: Path | None = None,
    debug_output: Path | None = None,
    fps_override: float | None = None,
    max_iter: int | None = None,
) -> dict[str, Path | None]:
    input_path = input_path.resolve()
    print(f"Processing {input_path.name}")
    wrapper = _read_json_object(input_path, f"timeline wrapper {input_path}")
    metadata = resolve_pipeline_metadata(wrapper, input_path.stem, fps_override)

    torch, optimize, build_constraints_from_timeline = _load_optimizer_dependencies()
    constraints = build_constraints_from_timeline(metadata["timeline"])

    # Dummy subject data remains in place until tracking/environment channels are
    # connected. Its length now matches the optimizer's inclusive sample clock.
    total_frames = frame_count_for_duration(
        metadata["durationSeconds"],
        metadata["fps"],
    )
    subject_centers = {
        "C0": torch.zeros((total_frames, 3), dtype=torch.float64)
    }
    subject_tracks = {
        "C0": [
            {
                "bbox": {
                    "x1": 800,
                    "y1": 800,
                    "x2": 1000,
                    "y2": 1000,
                },
                "center3d": [0.0, 0.0, 0.0],
            }
            for _ in range(total_frames)
        ]
    }

    optimize_options: dict[str, Any] = {
        "constraints": constraints,
        "total_duration": metadata["durationSeconds"],
        "fps": metadata["fps"],
        "subject_centers": subject_centers,
        "subject_tracks": subject_tracks,
    }
    if max_iter is not None:
        optimize_options["max_iter"] = max_iter
    result = optimize(**optimize_options)

    debug_document = {
        "exampleId": input_path.stem,
        "result": result,
    }
    trajectory = build_camera_trajectory(
        result,
        environment_id=metadata["environmentId"],
        duration_seconds=metadata["durationSeconds"],
        coordinates=metadata["coordinates"],
        intrinsics=metadata["intrinsics"],
        flattened_timeline=metadata["timeline"],
    )

    debug_path, archive_path, viewer_path = default_output_paths(
        input_path,
        metadata["exampleId"],
        debug_output=debug_output,
        trajectory_output=trajectory_output,
    )
    _write_json(debug_path, debug_document)
    _write_json(archive_path, trajectory)
    if viewer_path is not None and viewer_path.resolve() != archive_path.resolve():
        _write_json(viewer_path, trajectory)

    print(f"Saved optimizer debug: {debug_path}")
    print(f"Saved camera trajectory archive: {archive_path}")
    if viewer_path is not None:
        print(f"Published viewer trajectory: {viewer_path}")
    return {
        "debug": debug_path,
        "archive": archive_path,
        "viewer": viewer_path,
    }


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_argument_parser()
    args = parser.parse_args(argv)
    input_path = args.timeline_json.resolve()
    if not input_path.is_file():
        parser.error(f"input file does not exist: {input_path}")

    try:
        process_file(
            input_path,
            trajectory_output=args.trajectory_output,
            debug_output=args.debug_output,
            fps_override=args.fps,
            max_iter=args.max_iter,
        )
    except (OSError, RuntimeError, ValueError) as error:
        print(f"Optimizer pipeline failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
