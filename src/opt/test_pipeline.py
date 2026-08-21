from __future__ import annotations

from contextlib import redirect_stdout
import io
import unittest
from unittest.mock import patch

try:
    import torch
except ModuleNotFoundError:
    torch = None

try:
    from .Timeline_adapter import (
        build_optimizer_constraints_from_timeline,
        convert_timeline_loss_to_optimizer_loss,
        extract_overview_camera,
    )
    from .math3d.numpy_quaternions import rotate_vector_by_quaternion
    from .pipeline.metadata import (
        infer_example_id_from_wrapper,
        resolve_optimizer_metadata,
    )
    from .pipeline.trajectory import convert_optimizer_quaternion_to_viewer
    from .timebase import (
        calculate_inclusive_frame_count,
        convert_constraint_times_to_frame_indices,
        timestamp_to_frame_index,
    )
    from .trajectory_pipeline import (
        build_camera_trajectory_document,
        build_playback_metadata_from_timeline,
    )
except ImportError:
    from Timeline_adapter import (
        build_optimizer_constraints_from_timeline,
        convert_timeline_loss_to_optimizer_loss,
        extract_overview_camera,
    )
    from math3d.numpy_quaternions import rotate_vector_by_quaternion
    from pipeline.metadata import (
        infer_example_id_from_wrapper,
        resolve_optimizer_metadata,
    )
    from pipeline.trajectory import convert_optimizer_quaternion_to_viewer
    from timebase import (
        calculate_inclusive_frame_count,
        convert_constraint_times_to_frame_indices,
        timestamp_to_frame_index,
    )
    from trajectory_pipeline import (
        build_camera_trajectory_document,
        build_playback_metadata_from_timeline,
    )

if torch is not None:
    try:
        from .initialization import initialize_camera_control_points
        from .losses.arc import arc_movement_losses
        from .losses.config import LOSS_WEIGHTS
        from .losses.dispatcher import compute_trajectory_loss
        from .losses.subject import subject_view_azimuth_losses
        from .math3d.camera import yaw_from_forward_vectors
        from .solver.optimizer import optimize_camera_trajectory
    except ImportError:
        from initialization import initialize_camera_control_points
        from losses.arc import arc_movement_losses
        from losses.config import LOSS_WEIGHTS
        from losses.dispatcher import compute_trajectory_loss
        from losses.subject import subject_view_azimuth_losses
        from math3d.camera import yaw_from_forward_vectors
        from solver.optimizer import optimize_camera_trajectory


class TimebaseTests(unittest.TestCase):
    def test_seconds_map_to_inclusive_frame_indices(self):
        frame_count = calculate_inclusive_frame_count(10, 24)
        self.assertEqual(frame_count, 241)
        self.assertEqual(timestamp_to_frame_index(0, 10, frame_count), 0)
        self.assertEqual(timestamp_to_frame_index(5, 10, frame_count), 120)
        self.assertEqual(timestamp_to_frame_index(10, 10, frame_count), 240)

    def test_point_easing_durations_convert_to_frame_spans(self):
        constraints = [
            {
                "kind": "point",
                "t": 5,
                "losses": [],
                "easing": {
                    "inDuration": 2,
                    "outDuration": 1,
                    "curve": "linear",
                },
            }
        ]
        converted = convert_constraint_times_to_frame_indices(
            constraints,
            10,
            101,
        )
        self.assertEqual(converted[0]["t"], 50)
        self.assertEqual(converted[0]["easing"]["inFrames"], 20)
        self.assertEqual(converted[0]["easing"]["outFrames"], 10)
        self.assertNotIn("inFrames", constraints[0]["easing"])

    def test_constraint_conversion_does_not_mutate_seconds_input(self):
        constraints = [
            {"kind": "point", "t": 2.5, "losses": []},
            {"kind": "interval", "t0": 5, "t1": 10, "losses": []},
        ]
        converted_constraints = convert_constraint_times_to_frame_indices(
            constraints,
            10,
            241,
        )
        self.assertEqual(converted_constraints[0]["t"], 60)
        self.assertEqual(
            (
                converted_constraints[1]["t0"],
                converted_constraints[1]["t1"],
            ),
            (120, 240),
        )
        self.assertEqual(constraints[0]["t"], 2.5)
        self.assertEqual(constraints[1]["t0"], 5)


class CameraTrajectoryTests(unittest.TestCase):
    def test_quaternion_conversion_changes_plus_z_to_minus_z_convention(self):
        self.assertEqual(
            convert_optimizer_quaternion_to_viewer([1, 0, 0, 0]),
            [0.0, 1.0, 0.0, 0.0],
        )

    def test_builds_canonical_quaternion_trajectory(self):
        optimizer_result = {
            "t_query": [0, 1],
            "P": [[1, 2, 3], [4, 5, 6]],
            "Q": [[1, 0, 0, 0], [0, 0, 1, 0]],
        }
        trajectory_document = build_camera_trajectory_document(
            optimizer_result,
            environment_id="example-01-football",
            duration_seconds=1,
        )
        self.assertEqual(trajectory_document["schemaVersion"], "1.0")
        self.assertEqual(trajectory_document["kind"], "cameraTrajectory")
        self.assertEqual(
            trajectory_document["orientation"],
            {"mode": "quaternion"},
        )
        self.assertEqual(trajectory_document["clock"]["timeUnit"], "second")
        self.assertEqual(
            trajectory_document["coordinates"]["cameraForwardAxis"],
            "-Z",
        )
        self.assertEqual(
            trajectory_document["samples"][0]["rotation"],
            [0.0, 1.0, 0.0, 0.0],
        )
        self.assertEqual(trajectory_document["samples"][-1]["t"], 1.0)

    def test_playback_normalizes_legacy_overlapping_normal_band(self):
        timeline = {
            "timeWarp": [
                {
                    "startTimePlayback": 0,
                    "endTimePlayback": 5,
                    "rate": 0.2,
                    "label": "slow",
                },
                {
                    "startTimePlayback": 0,
                    "endTimePlayback": 5,
                    "rate": 1,
                },
                {
                    "startTimePlayback": 5,
                    "endTimePlayback": 10,
                    "rate": 1,
                    "label": "normal",
                },
            ]
        }
        self.assertEqual(
            build_playback_metadata_from_timeline(timeline, 10),
            {
                "rateSegments": [
                    {
                        "startTime": 0.0,
                        "endTime": 5.0,
                        "rate": 0.2,
                        "label": "slow",
                    },
                    {
                        "startTime": 5.0,
                        "endTime": 10.0,
                        "rate": 1.0,
                        "label": "normal",
                    },
                ]
            },
        )


class WrapperMetadataTests(unittest.TestCase):
    def test_legacy_output_name_infers_example(self):
        self.assertEqual(
            infer_example_id_from_wrapper({}, "output_7"),
            "example-07",
        )

    def test_wrapper_metadata_resolves_without_optimizer_dependencies(self):
        wrapper = {
            "exampleId": "example-01",
            "environmentId": "example-01-football",
            "totalDuration": 10,
            "timeline": {"timeline": [], "timeWarp": []},
        }
        resolved_metadata = resolve_optimizer_metadata(wrapper, "output_1")
        self.assertEqual(resolved_metadata["exampleId"], "example-01")
        self.assertEqual(
            resolved_metadata["environmentId"],
            "example-01-football",
        )
        self.assertEqual(resolved_metadata["fps"], 24.0)
        self.assertEqual(
            resolved_metadata["coordinates"]["rotationOrder"],
            "quaternion-xyzw",
        )


class TimelineAdapterTests(unittest.TestCase):
    def test_point_easing_is_preserved_by_timeline_adapter(self):
        constraints = build_optimizer_constraints_from_timeline(
            {
                "timeline": [
                    {
                        "kind": "point",
                        "time": 4,
                        "weight": 0.75,
                        "easing": {
                            "inDuration": 1.5,
                            "outDuration": 0.5,
                            "curve": "easeInOut",
                        },
                        "lossFunctions": [],
                    }
                ]
            },
            environment_json={
                "world": {
                    "overviewCamera": {
                        "position": [0, 0, 10],
                        "target": [0, 0, 0],
                    }
                }
            },
        )
        point = constraints[-1]
        self.assertEqual(point["position"], [0.0, 0.0, 10.0])
        self.assertEqual(point["weight"], 0.75)
        self.assertEqual(
            point["easing"],
            {
                "inDuration": 1.5,
                "outDuration": 0.5,
                "curve": "easeInOut",
            },
        )

    def test_overview_camera_quaternion_uses_optimizer_forward_axis(self):
        position, quaternion = extract_overview_camera(
            {
                "world": {
                    "overviewCamera": {
                        "position": [0, 0, 10],
                        "target": [0, 0, 0],
                    }
                }
            }
        )
        self.assertEqual(position, [0.0, 0.0, 10.0])
        forward = rotate_vector_by_quaternion(quaternion, [0, 0, 1])
        for actual, expected in zip(forward, [0.0, 0.0, -1.0]):
            self.assertAlmostEqual(actual, expected, places=6)

    def test_typescript_static_loss_maps_to_optimizer_static_loss(self):
        self.assertEqual(
            convert_timeline_loss_to_optimizer_loss(
                {"type": "Static", "parameters": {}}
            ),
            {"type": "static"},
        )


@unittest.skipUnless(torch is not None, "PyTorch is not installed")
class OptimizerNumericsTests(unittest.TestCase):
    def test_point_easing_spreads_loss_to_neighboring_frames(self):
        camera_positions = torch.zeros((5, 3), dtype=torch.float64)
        camera_quaternions = torch.tensor(
            [[1.0, 0.0, 0.0, 0.0]] * 5,
            dtype=torch.float64,
        )
        with patch.dict(
            LOSS_WEIGHTS,
            {"point_position": 1.0, "point_rotation": 0.0},
        ):
            exact = compute_trajectory_loss(
                camera_positions,
                camera_quaternions,
                constraints=[
                    {
                        "kind": "point",
                        "t": 2,
                        "position": [1.0, 0.0, 0.0],
                        "losses": [],
                    }
                ],
            )
            eased = compute_trajectory_loss(
                camera_positions,
                camera_quaternions,
                constraints=[
                    {
                        "kind": "point",
                        "t": 2,
                        "position": [1.0, 0.0, 0.0],
                        "losses": [],
                        "easing": {
                            "inFrames": 2,
                            "outFrames": 2,
                            "curve": "linear",
                        },
                    }
                ],
            )
        self.assertGreater(exact.terms["point/position"].item(), 0.0)
        self.assertAlmostEqual(
            eased.terms["point/position"].item(),
            exact.terms["point/position"].item() * 2.0,
            places=6,
        )

    def test_initialization_builds_local_axis_translation_samples(self):
        control_points = initialize_camera_control_points(
            constraints=[
                {
                    "kind": "point",
                    "t": 0,
                    "position": [0, 0, 0],
                    "quaternion": [1, 0, 0, 0],
                    "losses": [],
                },
                {
                    "kind": "interval",
                    "t0": 0,
                    "t1": 2,
                    "k": 3,
                    "losses": [
                        {
                            "type": "truckRightMovement",
                            "distance": 2,
                        }
                    ],
                },
            ],
            subject_tracks={},
            image_width=1920,
            image_height=1080,
        )

        self.assertEqual(
            [point["t"] for point in control_points],
            [0.0, 1.0, 2.0],
        )
        torch.testing.assert_close(
            torch.tensor(
                [point["p"].tolist() for point in control_points],
                dtype=torch.float64,
            ),
            torch.tensor(
                [
                    [0.0, 0.0, 0.0],
                    [1.0, 0.0, 0.0],
                    [2.0, 0.0, 0.0],
                ],
                dtype=torch.float64,
            ),
            rtol=0,
            atol=1e-8,
        )

    def test_arc_initialization_orbits_in_the_horizontal_xz_plane(self):
        control_points = initialize_camera_control_points(
            constraints=[
                {
                    "kind": "point",
                    "t": 0,
                    "position": [2, 1, 0],
                    "quaternion": [1, 0, 0, 0],
                    "losses": [],
                },
                {
                    "kind": "interval",
                    "t0": 0,
                    "t1": 2,
                    "losses": [
                        {
                            "type": "arcMovement",
                            "subjectId": "actor",
                            "radius": 2,
                            "angleDeg": 90,
                        }
                    ],
                },
            ],
            subject_tracks={},
            subject_centers={
                "actor": torch.zeros((3, 3), dtype=torch.float64),
            },
            total_frame_count=3,
            image_width=1920,
            image_height=1080,
        )

        positions = torch.tensor(
            [point["p"].tolist() for point in control_points],
            dtype=torch.float64,
        )
        torch.testing.assert_close(
            positions[:, 1],
            torch.ones_like(positions[:, 1]),
        )
        torch.testing.assert_close(
            torch.linalg.vector_norm(positions[:, [0, 2]], dim=-1),
            torch.full((len(control_points),), 2.0, dtype=torch.float64),
        )
        torch.testing.assert_close(
            positions[-1],
            torch.tensor([0.0, 1.0, -2.0], dtype=torch.float64),
            atol=1e-8,
            rtol=0,
        )

    def test_arc_loss_helpers_preserve_finite_gradients(self):
        angles = torch.linspace(
            0.0,
            torch.pi / 2.0,
            7,
            dtype=torch.float64,
        )
        camera_positions = torch.stack(
            [
                2.0 * torch.cos(angles),
                torch.zeros_like(angles),
                2.0 * torch.sin(angles),
            ],
            dim=-1,
        ).requires_grad_()
        camera_quaternions = torch.tensor(
            [[1.0, 0.0, 0.0, 0.0]] * 7,
            dtype=torch.float64,
            requires_grad=True,
        )
        loss_terms = arc_movement_losses(
            camera_positions,
            camera_quaternions,
            torch.zeros((7, 3), dtype=torch.float64),
            0,
            6,
            radius=2.0,
            angle_deg=90.0,
        )
        total_loss = sum(
            loss_terms.values(),
            torch.zeros((), dtype=torch.float64),
        )
        total_loss.backward()

        self.assertIn("arc/radius_reg", loss_terms)
        self.assertIn("arc/angle_target", loss_terms)
        self.assertIn("arc/lookat", loss_terms)
        self.assertTrue(torch.isfinite(total_loss))
        self.assertTrue(torch.isfinite(camera_positions.grad).all())
        self.assertTrue(torch.isfinite(camera_quaternions.grad).all())

    def test_optimizer_pipeline_runs_one_interpolation_step(self):
        constraints = [
            {
                "kind": "point",
                "t": 0.0,
                "position": [0.0, 0.0, 0.0],
                "quaternion": [1.0, 0.0, 0.0, 0.0],
                "losses": [],
            },
            {
                "kind": "point",
                "t": 1.0,
                "position": [1.0, 0.0, 0.0],
                "quaternion": [1.0, 0.0, 0.0, 0.0],
                "losses": [],
            },
        ]
        with redirect_stdout(io.StringIO()):
            result = optimize_camera_trajectory(
                constraints,
                duration_seconds=1.0,
                frames_per_second=2,
                trajectory_mode="interpolation",
                spline_degree=1,
                max_iterations=1,
                loss_threshold=-1,
            )

        self.assertEqual(result["traj_mode"], "interpolation")
        self.assertEqual(len(result["t_query"]), 3)
        self.assertEqual(len(result["P"]), 3)
        self.assertEqual(len(result["Q"]), 3)
        self.assertEqual(len(result["history"]), 1)

    def test_pan_tilt_dispatch_uses_readable_angle_keyword(self):
        camera_positions = torch.zeros((3, 3), dtype=torch.float64)
        camera_quaternions = torch.tensor(
            [[1.0, 0.0, 0.0, 0.0]] * 3,
            dtype=torch.float64,
            requires_grad=True,
        )
        loss_report = compute_trajectory_loss(
            camera_positions,
            camera_quaternions,
            constraints=[
                {
                    "kind": "interval",
                    "t0": 0,
                    "t1": 2,
                    "losses": [
                        {
                            "type": "panLeftMovement",
                            "angleDeg": 30,
                        }
                    ],
                }
            ],
        )

        self.assertTrue(torch.isfinite(loss_report.total))
        self.assertIn("panLeftMovement/target_end", loss_report.terms)

    def test_undefined_planar_angles_have_finite_zero_gradients(self):
        camera_positions = torch.tensor(
            [[0.0, 10.0, 0.0]],
            dtype=torch.float64,
            requires_grad=True,
        )
        subject_positions = torch.zeros((1, 3), dtype=torch.float64)
        azimuth_loss = subject_view_azimuth_losses(
            camera_positions,
            subject_positions,
            "front",
        )["subjectView/azimuth"]
        azimuth_loss.backward()

        self.assertTrue(torch.isfinite(azimuth_loss))
        self.assertTrue(torch.isfinite(camera_positions.grad).all())

        vertical_forward = torch.tensor(
            [[0.0, 1.0, 0.0]],
            dtype=torch.float64,
            requires_grad=True,
        )
        yaw_from_forward_vectors(vertical_forward).sum().backward()
        self.assertTrue(torch.isfinite(vertical_forward.grad).all())


if __name__ == "__main__":
    unittest.main()
