from __future__ import annotations

import unittest

try:
    import torch
except ModuleNotFoundError:
    torch = None

try:
    from .Timeline_adapter import convert_loss
    from .run_optimizer import infer_example_id, resolve_pipeline_metadata
    from .timebase import (
        constraints_seconds_to_frames,
        frame_count_for_duration,
        seconds_to_frame_index,
    )
    from .trajectory_pipeline import (
        build_camera_trajectory,
        optimizer_quaternion_to_viewer,
        playback_from_timeline,
    )
except ImportError:
    from Timeline_adapter import convert_loss
    from run_optimizer import infer_example_id, resolve_pipeline_metadata
    from timebase import (
        constraints_seconds_to_frames,
        frame_count_for_duration,
        seconds_to_frame_index,
    )
    from trajectory_pipeline import (
        build_camera_trajectory,
        optimizer_quaternion_to_viewer,
        playback_from_timeline,
    )

if torch is not None:
    try:
        from .LossFunctions import loss_subject_view_azimuth, yaw_from_forward
    except ImportError:
        from LossFunctions import loss_subject_view_azimuth, yaw_from_forward


class TimebaseTests(unittest.TestCase):
    def test_seconds_map_to_inclusive_frame_indices(self):
        total_frames = frame_count_for_duration(10, 24)
        self.assertEqual(total_frames, 241)
        self.assertEqual(seconds_to_frame_index(0, 10, total_frames), 0)
        self.assertEqual(seconds_to_frame_index(5, 10, total_frames), 120)
        self.assertEqual(seconds_to_frame_index(10, 10, total_frames), 240)

    def test_constraint_conversion_does_not_mutate_seconds_input(self):
        constraints = [
            {"kind": "point", "t": 2.5, "losses": []},
            {"kind": "interval", "t0": 5, "t1": 10, "losses": []},
        ]
        converted = constraints_seconds_to_frames(constraints, 10, 241)
        self.assertEqual(converted[0]["t"], 60)
        self.assertEqual((converted[1]["t0"], converted[1]["t1"]), (120, 240))
        self.assertEqual(constraints[0]["t"], 2.5)
        self.assertEqual(constraints[1]["t0"], 5)


class CameraTrajectoryTests(unittest.TestCase):
    def test_quaternion_conversion_changes_plus_z_to_minus_z_convention(self):
        self.assertEqual(
            optimizer_quaternion_to_viewer([1, 0, 0, 0]),
            [0.0, 1.0, 0.0, 0.0],
        )

    def test_builds_canonical_quaternion_trajectory(self):
        result = {
            "t_query": [0, 1],
            "P": [[1, 2, 3], [4, 5, 6]],
            "Q": [[1, 0, 0, 0], [0, 0, 1, 0]],
        }
        trajectory = build_camera_trajectory(
            result,
            environment_id="example-01-football",
            duration_seconds=1,
        )
        self.assertEqual(trajectory["schemaVersion"], "1.0")
        self.assertEqual(trajectory["kind"], "cameraTrajectory")
        self.assertEqual(trajectory["orientation"], {"mode": "quaternion"})
        self.assertEqual(trajectory["clock"]["timeUnit"], "second")
        self.assertEqual(trajectory["coordinates"]["cameraForwardAxis"], "-Z")
        self.assertEqual(trajectory["samples"][0]["rotation"], [0.0, 1.0, 0.0, 0.0])
        self.assertEqual(trajectory["samples"][-1]["t"], 1.0)

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
            playback_from_timeline(timeline, 10),
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
        self.assertEqual(infer_example_id({}, "output_7"), "example-07")

    def test_wrapper_metadata_resolves_without_optimizer_dependencies(self):
        wrapper = {
            "exampleId": "example-01",
            "environmentId": "example-01-football",
            "totalDuration": 10,
            "timeline": {"timeline": [], "timeWarp": []},
        }
        metadata = resolve_pipeline_metadata(wrapper, "output_1")
        self.assertEqual(metadata["exampleId"], "example-01")
        self.assertEqual(metadata["environmentId"], "example-01-football")
        self.assertEqual(metadata["fps"], 24.0)
        self.assertEqual(metadata["coordinates"]["rotationOrder"], "quaternion-xyzw")


class TimelineAdapterTests(unittest.TestCase):
    def test_typescript_static_loss_maps_to_optimizer_static_loss(self):
        self.assertEqual(
            convert_loss({"type": "Static", "parameters": {}}),
            {"type": "static"},
        )


@unittest.skipUnless(torch is not None, "PyTorch is not installed")
class OptimizerNumericsTests(unittest.TestCase):
    def test_undefined_planar_angles_have_finite_zero_gradients(self):
        camera_positions = torch.tensor(
            [[0.0, 10.0, 0.0]],
            dtype=torch.float64,
            requires_grad=True,
        )
        subject_positions = torch.zeros((1, 3), dtype=torch.float64)
        azimuth_loss = loss_subject_view_azimuth(
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
        yaw_from_forward(vertical_forward).sum().backward()
        self.assertTrue(torch.isfinite(vertical_forward.grad).all())


if __name__ == "__main__":
    unittest.main()
