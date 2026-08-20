"""Run the timeline optimizer and publish debug and viewer-ready output."""

from __future__ import annotations

import argparse
import math
from pathlib import Path
import sys
from typing import Any, Sequence

try:
    from .pipeline.io import (
        load_json_object as _load_json_object,
        resolve_output_paths as _resolve_output_paths,
        write_json_atomically as _write_json_atomically,
    )
    from .pipeline.metadata import (
        resolve_environment as _resolve_environment,
        resolve_optimizer_metadata as _resolve_optimizer_metadata,
    )
    from .pipeline.execution import (
        build_optimizer_options as _build_optimizer_options,
        build_placeholder_subject_data as _build_placeholder_subject_data,
        build_subject_data_from_environment as _build_subject_data_from_environment,
        publish_trajectory_documents as _publish_trajectory_documents,
    )
    from .timebase import calculate_inclusive_frame_count
    from .trajectory_pipeline import build_camera_trajectory_document
except ImportError:
    from pipeline.io import (
        load_json_object as _load_json_object,
        resolve_output_paths as _resolve_output_paths,
        write_json_atomically as _write_json_atomically,
    )
    from pipeline.metadata import (
        resolve_environment as _resolve_environment,
        resolve_optimizer_metadata as _resolve_optimizer_metadata,
    )
    from pipeline.execution import (
        build_optimizer_options as _build_optimizer_options,
        build_placeholder_subject_data as _build_placeholder_subject_data,
        build_subject_data_from_environment as _build_subject_data_from_environment,
        publish_trajectory_documents as _publish_trajectory_documents,
    )
    from timebase import calculate_inclusive_frame_count
    from trajectory_pipeline import build_camera_trajectory_document
    
def _parse_positive_float(value: str) -> float:
    number = float(value)
    if not math.isfinite(number) or number <= 0:
        raise argparse.ArgumentTypeError("must be a positive finite number")
    return number


def _parse_positive_integer(value: str) -> int:
    number = int(value)
    if number <= 0:
        raise argparse.ArgumentTypeError("must be a positive integer")
    return number


def build_cli_parser() -> argparse.ArgumentParser:
    """Build the command-line parser for the optimizer pipeline."""
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
        type=_parse_positive_float,
        help="trajectory samples per second (environment fpsHint or 30 by default)",
    )
    parser.add_argument(
        "--max-iter",
        type=_parse_positive_integer,
        help="override the optimizer iteration limit",
    )
    return parser


def _load_optimizer_runtime():
    """Import heavyweight optimizer dependencies only when execution starts."""
    try:
        import torch as torch_module
    except ModuleNotFoundError as error:
        raise RuntimeError(
            "Optimizer dependency 'torch' is missing; install src/opt/requirements.txt"
        ) from error

    try:
        from .solver.optimizer import optimize_camera_trajectory
        from .Timeline_adapter import (
            build_optimizer_constraints_from_timeline,
        )
    except ImportError:
        from solver.optimizer import optimize_camera_trajectory
        from Timeline_adapter import build_optimizer_constraints_from_timeline
    return (
        torch_module,
        optimize_camera_trajectory,
        build_optimizer_constraints_from_timeline,
    )


def _optimize_timeline(
    timeline_wrapper: dict[str, Any],
    pipeline_metadata: dict[str, Any],
    *,
    max_iterations: int | None,
) -> dict[str, Any]:
    torch_module, optimize_camera_trajectory, build_constraints = (
        _load_optimizer_runtime()
    )
    
        # Attempt to resolve environment JSON and extract trajectory keyframes
    try:
        environment_json = _resolve_environment(
            timeline_wrapper, pipeline_metadata["exampleId"]
        )
    except (FileNotFoundError, KeyError, ValueError):
        environment_json = None
        
    # If you want to use overviewCamera coords from environment files just pass environment_json to the build_constraints function    
    optimizer_constraints = build_constraints(pipeline_metadata["timeline"])

    frame_count = calculate_inclusive_frame_count(
        pipeline_metadata["durationSeconds"],
        pipeline_metadata["fps"],
    )

    subject_centers, subject_tracks = _build_subject_data_from_environment(
        environment_json,
        frame_count,
        pipeline_metadata["fps"],
        torch_module,
        constraints=optimizer_constraints,
        timewarp_segments=pipeline_metadata["timeline"].get("timeWarp"),
        duration_seconds=pipeline_metadata["durationSeconds"],
    )

    optimize_options = _build_optimizer_options(
        optimizer_constraints,
        pipeline_metadata,
        subject_centers,
        subject_tracks,
        max_iterations,
    )
    return optimize_camera_trajectory(**optimize_options)


def _build_pipeline_documents(
    timeline_path: Path,
    pipeline_metadata: dict[str, Any],
    optimizer_result: dict[str, Any],
) -> tuple[dict[str, Any], dict[str, Any]]:
    debug_document = {
        "exampleId": timeline_path.stem,
        "result": optimizer_result,
    }
    trajectory_document = build_camera_trajectory_document(
        optimizer_result,
        environment_id=pipeline_metadata["environmentId"],
        duration_seconds=pipeline_metadata["durationSeconds"],
        coordinates=pipeline_metadata["coordinates"],
        intrinsics=pipeline_metadata["intrinsics"],
        flattened_timeline=pipeline_metadata["timeline"],
    )
    return debug_document, trajectory_document


def process_timeline_file(
    timeline_path: Path,
    *,
    trajectory_output: Path | None = None,
    debug_output: Path | None = None,
    frames_per_second_override: float | None = None,
    max_iterations: int | None = None,
) -> dict[str, Path | None]:
    """Optimize one timeline wrapper and publish its trajectory documents."""
    timeline_path = timeline_path.resolve()
    print(f"Processing {timeline_path.name}")
    timeline_wrapper = _load_json_object(
        timeline_path,
        f"timeline wrapper {timeline_path}",
    )
    pipeline_metadata = _resolve_optimizer_metadata(
        timeline_wrapper,
        timeline_path.stem,
        frames_per_second_override,
    )
    optimizer_result = _optimize_timeline(
        timeline_wrapper,
        pipeline_metadata,
        max_iterations=max_iterations,
    )
    debug_document, trajectory_document = _build_pipeline_documents(
        timeline_path,
        pipeline_metadata,
        optimizer_result,
    )
    output_paths = _publish_trajectory_documents(
        timeline_path=timeline_path,
        pipeline_metadata=pipeline_metadata,
        debug_document=debug_document,
        trajectory_document=trajectory_document,
        resolve_paths=_resolve_output_paths,
        write_json=_write_json_atomically,
        debug_output=debug_output,
        trajectory_output=trajectory_output,
    )

    print(f"Saved optimizer debug: {output_paths['debug']}")
    print(f"Saved camera trajectory archive: {output_paths['archive']}")
    if output_paths["viewer"] is not None:
        print(f"Published viewer trajectory: {output_paths['viewer']}")
    return output_paths


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_cli_parser()
    parsed_arguments = parser.parse_args(argv)
    timeline_path = parsed_arguments.timeline_json.resolve()
    if not timeline_path.is_file():
        parser.error(f"input file does not exist: {timeline_path}")

    try:
        process_timeline_file(
            timeline_path,
            trajectory_output=parsed_arguments.trajectory_output,
            debug_output=parsed_arguments.debug_output,
            frames_per_second_override=parsed_arguments.fps,
            max_iterations=parsed_arguments.max_iter,
        )
    except (OSError, RuntimeError, ValueError) as error:
        print(f"Optimizer pipeline failed: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())