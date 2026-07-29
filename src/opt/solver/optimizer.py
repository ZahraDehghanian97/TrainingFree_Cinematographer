"""Public camera trajectory optimizer and its focused execution steps."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable

import numpy as np
import torch
import torch.optim as torch_optim

try:
    from ..Bspline import build_bspline_basis_matrix
    from ..initialization import initialize_camera_control_points
    from ..interpolation import (
        build_linear_interpolation_matrix,
        interpolate_quaternions_piecewise,
    )
    from ..losses.dispatcher import compute_trajectory_loss
    from ..timebase import (
        calculate_inclusive_frame_count,
        convert_constraint_times_to_frame_indices,
    )
except ImportError:
    from Bspline import build_bspline_basis_matrix
    from initialization import initialize_camera_control_points
    from interpolation import (
        build_linear_interpolation_matrix,
        interpolate_quaternions_piecewise,
    )
    from losses.dispatcher import compute_trajectory_loss
    from timebase import (
        calculate_inclusive_frame_count,
        convert_constraint_times_to_frame_indices,
    )


PositionEvaluator = Callable[[torch.Tensor], torch.Tensor]


@dataclass(frozen=True)
class OptimizationTensors:
    """Trainable controls and their sampling timebases."""

    position_control_points: torch.nn.Parameter
    raw_quaternion_control_points: torch.nn.Parameter
    control_times: torch.Tensor
    query_times: torch.Tensor
    frame_constraints: list


@dataclass(frozen=True)
class OptimizationRun:
    """Outputs retained from the iterative optimization loop."""

    loss_history: list[float]
    final_loss_report: Any


def create_open_uniform_knot_vector_torch(
    control_point_count: int,
    degree: int,
    device,
    dtype,
):
    """Create a clamped, open-uniform knot vector on a Torch device."""
    knot_count = control_point_count + degree + 1
    internal_knot_count = knot_count - 2 * (degree + 1)
    if internal_knot_count < 0:
        raise ValueError("Need n_ctrl >= degree+1")

    if internal_knot_count == 0:
        internal_knots = torch.empty((0,), device=device, dtype=dtype)
    else:
        internal_knots = torch.linspace(
            0.0,
            1.0,
            internal_knot_count + 2,
            device=device,
            dtype=dtype,
        )[1:-1]

    return torch.cat(
        [
            torch.zeros(degree + 1, device=device, dtype=dtype),
            internal_knots,
            torch.ones(degree + 1, device=device, dtype=dtype),
        ]
    )


def validate_optimization_arguments(
    duration_seconds,
    frames_per_second,
    max_iterations,
) -> tuple[float, float]:
    """Normalize public scalar inputs and reject an empty iteration budget."""
    duration_seconds = float(duration_seconds)
    frames_per_second = float(frames_per_second)
    if max_iterations <= 0:
        raise ValueError("max_iterations must be positive")
    return duration_seconds, frames_per_second


def setup_control_tensors(
    *,
    constraints: list,
    duration_seconds: float,
    frames_per_second: float,
    image_width,
    image_height,
    subject_tracks,
    subject_centers,
    device,
    spline_degree: int,
    initialization_mode: str,
    default_interval_sample_count: int,
) -> OptimizationTensors:
    """Initialize trainable controls and the frame-aligned optimization inputs."""
    frame_count = calculate_inclusive_frame_count(
        duration_seconds,
        frames_per_second,
    )
    control_points = initialize_camera_control_points(
        constraints=constraints,
        subject_tracks=subject_tracks,
        subject_centers=subject_centers,
        image_width=image_width,
        image_height=image_height,
        default_sample_count=default_interval_sample_count,
        time_mode="seconds",
        total_frame_count=frame_count,
        total_duration=duration_seconds,
    )
    frame_constraints = convert_constraint_times_to_frame_indices(
        constraints,
        duration_seconds,
        frame_count,
    )

    initial_positions, initial_quaternions, control_times = (
        _build_initial_control_tensors(control_points, device)
    )
    if initialization_mode == "constant":
        initial_quaternions = torch.tensor(
            [[1, 0, 0, 0]] * len(initial_quaternions),
            dtype=torch.float64,
            device=device,
        )
        initial_positions = torch.ones_like(initial_positions)

    control_point_count = initial_positions.shape[0]
    _validate_control_point_count(control_point_count, spline_degree)

    return OptimizationTensors(
        position_control_points=torch.nn.Parameter(initial_positions.clone()),
        raw_quaternion_control_points=torch.nn.Parameter(initial_quaternions.clone()),
        control_times=control_times,
        query_times=torch.linspace(
            0.0,
            duration_seconds,
            frame_count,
            device=device,
            dtype=torch.float64,
        ),
        frame_constraints=frame_constraints,
    )


def _build_initial_control_tensors(
    control_points: list,
    device,
) -> tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    initial_position_values = []
    initial_quaternion_values = []
    control_time_values = []
    for control_point in control_points:
        control_time_values.append(control_point["t"])
        initial_position_values.append(control_point["p"])
        initial_quaternion_values.append(control_point["q"])

    initial_positions = torch.tensor(
        np.asarray(initial_position_values),
        dtype=torch.float64,
        device=device,
    )
    initial_quaternions = torch.tensor(
        np.asarray(initial_quaternion_values),
        dtype=torch.float64,
        device=device,
    )
    control_times = torch.tensor(
        control_time_values,
        dtype=torch.float64,
        device=device,
    )
    return initial_positions, initial_quaternions, control_times


def _validate_control_point_count(
    control_point_count: int,
    spline_degree: int,
) -> None:
    if control_point_count < spline_degree + 1:
        raise ValueError(
            "Need at least degree+1 control points. "
            f"Got {control_point_count}, degree={spline_degree}"
        )


def build_position_evaluator(
    *,
    trajectory_mode: str,
    control_times: torch.Tensor,
    query_times: torch.Tensor,
    control_point_count: int,
    spline_degree: int,
    device,
) -> PositionEvaluator:
    """Build the fixed linear map used to sample position control points."""
    if trajectory_mode == "matrix":
        knots = create_open_uniform_knot_vector_torch(
            control_point_count,
            spline_degree,
            device=device,
            dtype=torch.float,
        )
        normalized_query_times = np.linspace(
            0.0,
            1.0,
            query_times.shape[0],
        )
        position_basis_matrix = torch.tensor(
            build_bspline_basis_matrix(
                normalized_query_times,
                knots,
                spline_degree,
                derivative_order=0,
            ),
            dtype=torch.float64,
            device=device,
        )
        return lambda control_points: position_basis_matrix @ control_points

    if trajectory_mode == "interpolation":
        interpolation_matrix = build_linear_interpolation_matrix(
            control_times,
            query_times,
        )
        return lambda control_points: interpolation_matrix @ control_points

    raise ValueError(f"Unknown trajectory mode: {trajectory_mode}")


def normalize_quaternion_control_points(
    raw_quaternion_control_points: torch.Tensor,
) -> torch.Tensor:
    """Normalize trainable quaternions with the optimizer's stable epsilon."""
    return raw_quaternion_control_points / (
        raw_quaternion_control_points.norm(dim=-1, keepdim=True) + 1e-8
    )


def validate_finite_gradients(
    named_parameters: tuple[tuple[str, torch.nn.Parameter], ...],
    iteration: int,
) -> None:
    """Reject a step when any populated parameter gradient is non-finite."""
    for parameter_name, parameter in named_parameters:
        if parameter.grad is not None and not torch.isfinite(parameter.grad).all():
            raise RuntimeError(
                f"Non-finite gradient for {parameter_name} at iter {iteration}"
            )


def run_optimization_step(
    *,
    parameter_optimizer: torch_optim.Optimizer,
    tensors: OptimizationTensors,
    evaluate_positions: PositionEvaluator,
    subject_centers,
    iteration: int,
):
    """Execute one differentiable loss, gradient, and parameter update step."""
    parameter_optimizer.zero_grad()
    trajectory_positions = evaluate_positions(tensors.position_control_points)
    normalized_quaternion_control_points = normalize_quaternion_control_points(
        tensors.raw_quaternion_control_points
    )
    trajectory_quaternions = interpolate_quaternions_piecewise(
        tensors.control_times,
        normalized_quaternion_control_points,
        tensors.query_times,
    )
    loss_report = compute_trajectory_loss(
        camera_positions=trajectory_positions,
        camera_quaternions=trajectory_quaternions,
        constraints=tensors.frame_constraints,
        subject_centers=subject_centers,
    )
    total_loss = loss_report.total
    if not torch.isfinite(total_loss):
        raise RuntimeError(
            f"Loss became non-finite at iter {iteration}: {total_loss.item()}"
        )

    total_loss.backward()
    validate_finite_gradients(
        (
            ("camera position control points", tensors.position_control_points),
            (
                "camera rotation control points",
                tensors.raw_quaternion_control_points,
            ),
        ),
        iteration,
    )
    parameter_optimizer.step()
    _renormalize_quaternion_control_points(tensors.raw_quaternion_control_points)
    return loss_report


def _renormalize_quaternion_control_points(
    raw_quaternion_control_points: torch.nn.Parameter,
) -> None:
    with torch.no_grad():
        raw_quaternion_control_points[:] = normalize_quaternion_control_points(
            raw_quaternion_control_points
        )


def run_optimization_loop(
    *,
    tensors: OptimizationTensors,
    evaluate_positions: PositionEvaluator,
    subject_centers,
    learning_rate,
    max_iterations: int,
    loss_threshold,
    trajectory_mode: str,
) -> OptimizationRun:
    """Run Adam until the requested loss or iteration threshold is reached."""
    parameter_optimizer = torch_optim.Adam(
        [
            tensors.position_control_points,
            tensors.raw_quaternion_control_points,
        ],
        lr=learning_rate,
    )
    loss_history = []
    current_loss = float("inf")
    iteration = 0
    while current_loss > loss_threshold and iteration < max_iterations:
        iteration += 1
        loss_report = run_optimization_step(
            parameter_optimizer=parameter_optimizer,
            tensors=tensors,
            evaluate_positions=evaluate_positions,
            subject_centers=subject_centers,
            iteration=iteration,
        )
        current_loss = float(loss_report.total.item())
        loss_history.append(current_loss)
        report_iteration_progress(iteration, current_loss, trajectory_mode)

        if current_loss <= loss_threshold:
            break

    return OptimizationRun(
        loss_history=loss_history,
        final_loss_report=loss_report,
    )


def report_iteration_progress(
    iteration: int,
    current_loss: float,
    trajectory_mode: str,
) -> None:
    """Print a periodic optimization progress line."""
    if iteration % 100 == 0:
        print(f"Iter {iteration:4d} | Loss {current_loss:.6f} | mode={trajectory_mode}")


def report_final_loss_breakdown(loss_report) -> None:
    """Print the final aggregate and per-term losses."""
    print("\nFinal loss breakdown:")
    print(f"{'TOTAL':40} {loss_report.total.detach().item():.4f}")

    for term_name, term_value in sorted(loss_report.terms.items()):
        print(f"{term_name:40} {term_value.detach().item():.4f}")


def serialize_optimization_result(
    *,
    tensors: OptimizationTensors,
    evaluate_positions: PositionEvaluator,
    loss_history: list[float],
    trajectory_mode: str,
) -> dict:
    """Evaluate final samples and convert optimizer tensors to plain values."""
    with torch.no_grad():
        final_positions = (
            evaluate_positions(tensors.position_control_points).detach().cpu()
        )
        normalized_quaternion_control_points = normalize_quaternion_control_points(
            tensors.raw_quaternion_control_points
        )
        final_quaternions = (
            interpolate_quaternions_piecewise(
                tensors.control_times,
                normalized_quaternion_control_points,
                tensors.query_times,
            )
            .detach()
            .cpu()
        )

    return {
        "t_ctrl": tensors.control_times.detach().cpu().tolist(),
        "t_query": tensors.query_times.detach().cpu().tolist(),
        "P": final_positions.tolist(),
        "Q": final_quaternions.tolist(),
        "history": loss_history,
        "traj_mode": trajectory_mode,
    }


def optimize_camera_trajectory(
    constraints: list,
    duration_seconds,
    frames_per_second=30,
    image_width=1920,
    image_height=1080,
    subject_tracks=None,
    subject_centers=None,
    device="cpu",
    learning_rate=1e-2,
    max_iterations=2000,
    loss_threshold=1,
    spline_degree=30,
    initialization_mode="constraint",
    trajectory_mode="matrix",
    default_interval_sample_count=50,
):
    """Optimize camera position and orientation samples for the constraints."""
    duration_seconds, frames_per_second = validate_optimization_arguments(
        duration_seconds,
        frames_per_second,
        max_iterations,
    )
    tensors = setup_control_tensors(
        constraints=constraints,
        duration_seconds=duration_seconds,
        frames_per_second=frames_per_second,
        subject_tracks=subject_tracks,
        subject_centers=subject_centers,
        image_width=image_width,
        image_height=image_height,
        device=device,
        spline_degree=spline_degree,
        initialization_mode=initialization_mode,
        default_interval_sample_count=default_interval_sample_count,
    )
    evaluate_positions = build_position_evaluator(
        trajectory_mode=trajectory_mode,
        control_times=tensors.control_times,
        query_times=tensors.query_times,
        control_point_count=tensors.position_control_points.shape[0],
        spline_degree=spline_degree,
        device=device,
    )
    optimization_run = run_optimization_loop(
        tensors=tensors,
        evaluate_positions=evaluate_positions,
        subject_centers=subject_centers,
        learning_rate=learning_rate,
        max_iterations=max_iterations,
        loss_threshold=loss_threshold,
        trajectory_mode=trajectory_mode,
    )
    report_final_loss_breakdown(optimization_run.final_loss_report)
    return serialize_optimization_result(
        tensors=tensors,
        evaluate_positions=evaluate_positions,
        loss_history=optimization_run.loss_history,
        trajectory_mode=trajectory_mode,
    )
