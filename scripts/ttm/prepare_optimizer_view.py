#!/usr/bin/env python3
"""Build TTM conditioning (motion_signal / mask / first_frame) from an OPTIMIZER camera path.

This is the sibling of prepare_pianist_novel_view.py. That script invents the camera move
(orbit + dolly + rise around the subject); this one takes the camera move from the
camera optimizer (CameraTrajectoryV1 JSON). Everything else is reused unchanged from the
supervisor's validated builder, which is imported from the same folder (copy this file next to
prepare_pianist_novel_view.py, e.g. TTM/tools/): RGB-D re-rendering with a z-buffer, nearest-colour
hole fill, white = supported pixel mask, ffmpeg encoders.

Per output frame k (time t_k = start + k / fps in scene time):
  1. source frame f_k = frame whose timestamp is nearest to t_k (as in the supervisor's builder);
     its own RGB, dense depth, intrinsics and camera pose are used, so the moving subject stays in
     its true pose at t_k;
  2. target camera = optimizer pose at t_k, converted from the environment frame (+Y up, -Z forward,
     metres) to the tracker world frame (OpenCV: +X right, +Y down, +Z forward, relative units):
         c2w_tracker = C @ inv(M) @ E(t_k) @ diag(1,-1,-1,1)          (E positions divided by metres-per-unit)
     M is sidecar coordinates.trackerWorldToEnvironment, and C is a rigid correction fixed by frame 0
     so that the first target pose equals the real source camera exactly (C is ~identity when the
     trajectory was pinned with `npm run video:pin`; a large C aborts the run);
  3. target intrinsics = source intrinsics of the first frame, with the focal length rescaled by the
     optimizer's fovY(t) relative to its value at t_k=start (zoom about the principal point).

Output folder = drop-in TTM `--input-path` (same files as the supervisor's builder).
"""
from __future__ import annotations

import argparse
import json
import math
import shutil
import sys
from pathlib import Path

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import prepare_pianist_novel_view as base  # noqa: E402  (supervisor's builder, unchanged)

FLIP = np.diag([1.0, -1.0, -1.0, 1.0])  # OpenCV camera axes <-> environment camera axes


# --------------------------------------------------------------------------- trajectory

def quat_to_matrix(q):
    x, y, z, w = (float(v) for v in q)
    n = math.sqrt(x * x + y * y + z * z + w * w)
    x, y, z, w = x / n, y / n, z / n, w / n
    return np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ])


def slerp(q0, q1, s):
    q0 = np.asarray(q0, float) / np.linalg.norm(q0)
    q1 = np.asarray(q1, float) / np.linalg.norm(q1)
    dot = float(np.dot(q0, q1))
    if dot < 0:
        q1, dot = -q1, -dot
    if dot > 0.9995:
        q = q0 + s * (q1 - q0)
    else:
        theta = math.acos(min(1.0, dot))
        q = (math.sin((1 - s) * theta) * q0 + math.sin(s * theta) * q1) / math.sin(theta)
    return q / np.linalg.norm(q)


def quintic_hermite(t0, t1, p0, v0, a0, p1, v1, a1, t):
    h = t1 - t0
    s = (t - t0) / h
    s3, s4, s5 = s ** 3, s ** 4, s ** 5
    h00 = 1 - 10 * s3 + 15 * s4 - 6 * s5
    h10 = s - 6 * s3 + 8 * s4 - 3 * s5
    h20 = 0.5 * s * s - 1.5 * s3 + 1.5 * s4 - 0.5 * s5
    h01 = 10 * s3 - 15 * s4 + 6 * s5
    h11 = -4 * s3 + 7 * s4 - 3 * s5
    h21 = 0.5 * s3 - s4 + 0.5 * s5
    return (h00 * p0 + h10 * h * v0 + h20 * h * h * a0 +
            h01 * p1 + h11 * h * v1 + h21 * h * h * a1)


class Trajectory:
    """CameraTrajectoryV1 samples with the document's declared position interpolation."""

    def __init__(self, document):
        assert document.get("kind") == "cameraTrajectory", "not a CameraTrajectoryV1 document"
        assert document["orientation"]["mode"] == "quaternion", "only quaternion orientation is supported"
        samples = document["samples"]
        assert len(samples) >= 2
        self.t = np.array([s["t"] for s in samples], float)
        assert np.all(np.diff(self.t) > 0), "sample times must strictly increase"
        self.p = np.array([s["position"] for s in samples], float)
        self.q = np.array([s["rotation"] for s in samples], float)
        self.fov = np.array([s["fovYDegrees"] for s in samples], float)
        self.v = np.array([s.get("positionVelocity", [np.nan] * 3) for s in samples], float)
        self.a = np.array([s.get("positionAcceleration", [np.nan] * 3) for s in samples], float)
        declared = document.get("interpolation", {}).get("position", "linear")
        self.use_hermite = declared == "quinticHermite" and np.isfinite(self.v).all() and np.isfinite(self.a).all()
        assert not any("cutBefore" in s and s["cutBefore"] for s in samples), \
            "trajectories with cuts need one TTM clip per cut"

    def at(self, time, linear=False):
        time = float(np.clip(time, self.t[0], self.t[-1]))
        i = int(np.clip(np.searchsorted(self.t, time, side="right") - 1, 0, len(self.t) - 2))
        s = (time - self.t[i]) / (self.t[i + 1] - self.t[i])
        if self.use_hermite and not linear:
            position = quintic_hermite(self.t[i], self.t[i + 1], self.p[i], self.v[i], self.a[i],
                                       self.p[i + 1], self.v[i + 1], self.a[i + 1], time)
        else:
            position = (1 - s) * self.p[i] + s * self.p[i + 1]
        rotation = slerp(self.q[i], self.q[i + 1], s)
        fov = (1 - s) * self.fov[i] + s * self.fov[i + 1]
        return position, rotation, float(fov)


def environment_pose(position_metres, rotation, metres_per_unit):
    pose = np.eye(4)
    pose[:3, :3] = quat_to_matrix(rotation)
    pose[:3, 3] = np.asarray(position_metres) / metres_per_unit
    return pose


def rotation_angle_degrees(rotation):
    return math.degrees(math.acos(float(np.clip((np.trace(rotation) - 1) / 2, -1, 1))))


# --------------------------------------------------------------------------- rendering

def render_rgbd_two_cameras(rgb, depth, good, k_source, k_target, source_pose, target_pose):
    """Identical to prepare_pianist_novel_view.render_rgbd, with separate source/target intrinsics."""
    height, width = depth.shape
    yy, xx = np.indices((height, width), dtype=np.float64)
    pixels = np.stack([xx, yy, np.ones_like(xx)], -1).reshape(-1, 3)
    chosen = np.flatnonzero(good.ravel() & np.isfinite(depth.ravel()) & (depth.ravel() > 0))
    points = (pixels[chosen] @ np.linalg.inv(k_source).T) * depth.ravel()[chosen, None]
    relative = np.linalg.inv(target_pose) @ source_pose
    points = points @ relative[:3, :3].T + relative[:3, 3]
    projection = points @ k_target.T
    z = points[:, 2]
    finite = np.isfinite(projection).all(1) & (z > 1e-8)
    projection, z, chosen = projection[finite], z[finite], chosen[finite]
    xy = projection[:, :2] / projection[:, 2, None]
    inside = ((xy[:, 0] >= -1) & (xy[:, 0] <= width) & (xy[:, 1] >= -1) & (xy[:, 1] <= height))
    xy, z, chosen = xy[inside], z[inside], chosen[inside]
    basis = np.floor(xy).astype(np.int64)
    fraction = xy - basis
    candidates = []
    zbuffer = np.full(height * width, np.inf)
    for dx, dy in ((0, 0), (1, 0), (0, 1), (1, 1)):
        weight = ((fraction[:, 0] if dx else 1 - fraction[:, 0]) *
                  (fraction[:, 1] if dy else 1 - fraction[:, 1]))
        x, y = basis[:, 0] + dx, basis[:, 1] + dy
        keep = (weight > .05) & (x >= 0) & (x < width) & (y >= 0) & (y < height)
        destination = y[keep] * width + x[keep]
        candidate = (destination, z[keep], weight[keep], chosen[keep])
        candidates.append(candidate)
        np.minimum.at(zbuffer, destination, candidate[1])
    sums = np.zeros((height * width, 3), dtype=np.float64)
    weights = np.zeros(height * width, dtype=np.float64)
    colors = rgb.reshape(-1, 3)
    for destination, depths, weight, color_ids in candidates:
        front = depths <= zbuffer[destination] * 1.002 + 1e-8
        destination, weight, color_ids = destination[front], weight[front], color_ids[front]
        weights += np.bincount(destination, weights=weight, minlength=height * width)
        for channel in range(3):
            sums[:, channel] += np.bincount(
                destination, weights=weight * colors[color_ids, channel], minlength=height * width)
    valid = weights.reshape(height, width) > 0
    sparse = np.zeros_like(rgb)
    sparse.reshape(-1, 3)[valid.ravel()] = np.clip(
        np.rint(sums[valid.ravel()] / weights[valid.ravel(), None]), 0, 255).astype(np.uint8)
    return sparse, valid


# --------------------------------------------------------------------------- main

def run(args):
    assert shutil.which("ffmpeg"), "ffmpeg required"
    sidecar = json.loads(args.sidecar.read_text())
    source = sidecar["source"]
    source_indices = np.asarray(sidecar["sourceFrameIndices"], dtype=np.int64)
    source_times = np.asarray(sidecar["timestampsSeconds"], dtype=np.float64)
    assert np.array_equal(source_indices, np.arange(len(source_indices)))

    registry = json.loads(args.scene_registry.read_text()) if args.scene_registry else None
    metres_per_unit = (registry["metersPerTrackerUnitApplied"] if registry else args.meters_per_unit)
    assert metres_per_unit and metres_per_unit > 0, "need --scene-registry or --meters-per-unit"
    trajectory_document = json.loads(args.trajectory.read_text())
    trajectory = Trajectory(trajectory_document)
    if registry and trajectory_document.get("environmentId") != registry["sceneId"]:
        raise ValueError(f"trajectory is for {trajectory_document.get('environmentId')!r}, scene is {registry['sceneId']!r}")

    start = trajectory.t[0] if args.start is None else args.start
    times = start + np.arange(args.frames, dtype=np.float64) / args.fps
    assert times[0] >= trajectory.t[0] - 1e-6 and times[-1] <= trajectory.t[-1] + 1e-6, \
        f"clip window {times[0]:.3f}..{times[-1]:.3f}s is outside the trajectory {trajectory.t[0]:.3f}..{trajectory.t[-1]:.3f}s"
    assert times[-1] <= source_times[-1], "clip runs past the end of the source video"
    chosen = np.abs(source_times[:, None] - times[None]).argmin(axis=0)

    with np.load(args.frontend, allow_pickle=False) as archive:
        depths = archive["depths"].astype(np.float32)
        source_poses = archive["c2w"].astype(np.float64)
        source_intrinsics = archive["intrinsics"].astype(np.float64)
        certainty = archive["uncertainty"]
    assert len(depths) == len(source_indices) and certainty.shape == depths.shape
    assert depths.shape[1:] == (source["inferenceHeight"], source["inferenceWidth"])
    assert source_poses.shape == (len(depths), 4, 4)
    valid_depth = np.isfinite(depths) & (depths > 0) & (certainty > .5)  # True = good in SpaTracker

    env_from_tracker = np.asarray(sidecar["coordinates"]["trackerWorldToEnvironment"], float)
    tracker_from_env = np.linalg.inv(env_from_tracker)

    # --- trajectory -> tracker world, anchored so frame 0 is the real camera ------------------------
    def to_tracker(position, rotation):
        return tracker_from_env @ environment_pose(position, rotation, metres_per_unit) @ FLIP

    p0, q0, fov0 = trajectory.at(times[0])
    first_frame = int(chosen[0])
    anchor = source_poses[first_frame] @ np.linalg.inv(to_tracker(p0, q0))
    anchor_translation = float(np.linalg.norm(anchor[:3, 3]))
    anchor_rotation = rotation_angle_degrees(anchor[:3, :3])
    scene_size = float(np.ptp(source_poses[:, :3, 3], axis=0).max()) or 1.0
    print(json.dumps({"start_anchor_translation_units": anchor_translation,
                      "start_anchor_rotation_degrees": anchor_rotation}), flush=True)
    if not args.allow_start_mismatch and (anchor_translation > args.start_tolerance_units
                                          or anchor_rotation > args.start_tolerance_degrees):
        raise SystemExit(
            f"The trajectory does not start at the source camera (offset {anchor_translation:.4f} units, "
            f"{anchor_rotation:.2f} deg). Pin it with `npm run video:pin` and re-run the optimizer, "
            f"or pass --allow-start-mismatch to apply this offset to the whole path.")

    # Declared quintic interpolation vs plain linear: a large gap would mean noisy jets.
    spline_gap = max(float(np.linalg.norm(trajectory.at(t)[0] - trajectory.at(t, linear=True)[0])) for t in times)
    print(json.dumps({"max_spline_vs_linear_metres": spline_gap}), flush=True)

    # Target focal length scale relative to the start (zoom about the principal point).
    tan0 = math.tan(math.radians(fov0) / 2)

    # --- geometry of image sizes (same derivation as the supervisor's builder) ---------------------
    inference_width = int(source["inferenceWidth"])
    resized_height = round(source["height"] * inference_width / source["width"] / 14) * 14
    crop_top = (resized_height - source["inferenceHeight"]) // 2
    if crop_top:
        raise ValueError("This builder expects full vertical depth support; cropped source requires explicit mask padding")
    infer_to_source = base.pixel_resize_matrix(inference_width, resized_height, source["width"], source["height"])
    crop_inverse = np.eye(3)
    crop_inverse[1, 2] = crop_top
    infer_to_output = (base.pixel_resize_matrix(source["width"], source["height"], args.width, args.height)
                       @ infer_to_source @ crop_inverse)
    k_start = infer_to_output @ source_intrinsics[first_frame]

    args.output.mkdir(parents=True, exist_ok=True)
    writers = {name: base.Encoder(args.output / f"{name}.mp4", args.fps, args.width, args.height,
                                  lossless=name == "mask")
               for name in ("motion_signal", "mask", "sparse_projection", "source_reference")}
    capture = cv2.VideoCapture(str(args.video))
    assert capture.isOpened()
    assert (int(capture.get(cv2.CAP_PROP_FRAME_WIDTH)), int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))) == (source["width"], source["height"])

    decoded_index, rgb = -1, None
    target_poses, target_intrinsics, fovs, coverage = [], [], [], []
    distance_to_source, snapshots, zero_validation = [], [], None
    try:
        for index, frame_index in enumerate(chosen):
            while decoded_index < frame_index:
                ok, decoded = capture.read()
                assert ok, f"Source decode failed at {decoded_index + 1}"
                decoded_index += 1
                if decoded_index == frame_index:
                    rgb = cv2.resize(decoded, (args.width, args.height), interpolation=cv2.INTER_AREA)
            depth = cv2.resize(depths[frame_index], (args.width, args.height), interpolation=cv2.INTER_NEAREST)
            good = cv2.resize(valid_depth[frame_index].astype(np.uint8), (args.width, args.height),
                              interpolation=cv2.INTER_NEAREST).astype(bool)
            k_source = infer_to_output @ source_intrinsics[frame_index]
            source_pose = source_poses[frame_index]

            position, rotation, fov = trajectory.at(times[index])
            target_pose = anchor @ to_tracker(position, rotation)
            scale = tan0 / math.tan(math.radians(fov) / 2)
            k_target = k_start.copy()
            k_target[0, 0] *= scale
            k_target[1, 1] *= scale

            sparse, valid = render_rgbd_two_cameras(rgb, depth, good, k_source, k_target, source_pose, target_pose)
            if index == 0:
                # Zero-motion reprojection must reproduce every supported pixel exactly.
                error = np.abs(sparse[valid].astype(float) - rgb[valid].astype(float))
                zero_validation = {"mean_absolute_error_255": float(error.mean()),
                                   "max_absolute_error_255": float(error.max()),
                                   "supported_fraction": float(valid.mean())}
                assert zero_validation["max_absolute_error_255"] <= 1, \
                    f"first frame does not reproject onto itself: {zero_validation}"
                sparse, valid = rgb.copy(), np.ones((args.height, args.width), dtype=bool)
                assert cv2.imwrite(str(args.output / "first_frame.png"), rgb)
            filled = base.fill_rgb(sparse, valid)
            mask = np.repeat((valid.astype(np.uint8) * 255)[..., None], 3, axis=2)
            for name, frame in (("motion_signal", filled), ("mask", mask),
                                ("sparse_projection", sparse), ("source_reference", rgb)):
                writers[name].write(frame)
            target_poses.append(target_pose)
            target_intrinsics.append(k_target)
            fovs.append(fov)
            coverage.append(float(valid.mean()))
            distance_to_source.append(float(np.linalg.norm(target_pose[:3, 3] - source_pose[:3, 3])))
            if index in (0, args.frames // 2, args.frames - 1):
                snapshots.append((index, rgb.copy(), sparse.copy(), filled.copy(), mask.copy()))
            if index % 10 == 0 or index == args.frames - 1:
                print(json.dumps({"frame": index, "t": float(times[index]), "source_frame": int(frame_index),
                                  "fovY_degrees": fov, "valid_fraction": coverage[-1]}), flush=True)
    finally:
        capture.release()
        for writer in writers.values():
            writer.close()
    assert min(coverage) > args.min_coverage, \
        f"Insufficient observed-pixel support (min {min(coverage):.3f} <= {args.min_coverage}); shorten the arc or keep the lens"

    np.savez_compressed(args.output / "camera_path.npz", timestamps=times,
                        source_timestamps=source_times[chosen], source_frame_indices=chosen,
                        source_c2w=source_poses[chosen], target_c2w=np.asarray(target_poses),
                        intrinsics=np.asarray(target_intrinsics), fov_y_degrees=np.asarray(fovs),
                        valid_fraction=np.asarray(coverage), start_anchor=anchor,
                        target_to_source_camera_distance_units=np.asarray(distance_to_source))
    prompt = args.prompt_file.read_text().strip() if args.prompt_file else base.PROMPT
    (args.output / "prompt.txt").write_text(prompt + "\n")

    thumb_width = 416
    thumb_height = round(args.height * thumb_width / args.width)
    canvas = np.full((3 * (thumb_height + 32) + 30, 4 * thumb_width, 3), 20, dtype=np.uint8)
    for row, (index, reference, sparse, filled, mask) in enumerate(snapshots):
        for col, (name, frame) in enumerate(zip(("Source", "Observed reprojection", "TTM motion signal", "Known-pixel mask"),
                                               (reference, sparse, filled, mask))):
            y, x = row * (thumb_height + 32), col * thumb_width
            cv2.putText(canvas, f"{name} | {index / args.fps:.2f}s | fovY {fovs[index]:.1f}",
                        (x + 6, y + 22), cv2.FONT_HERSHEY_SIMPLEX, .43, (240, 240, 240), 1, cv2.LINE_AA)
            canvas[y + 32:y + 32 + thumb_height, x:x + thumb_width] = cv2.resize(frame, (thumb_width, thumb_height))
    cv2.putText(canvas, "Optimizer camera path. Black mask regions require model completion.",
                (8, canvas.shape[0] - 9), cv2.FONT_HERSHEY_SIMPLEX, .48, (220, 220, 220), 1, cv2.LINE_AA)
    assert cv2.imwrite(str(args.output / "contact_sheet.png"), canvas)

    manifest = {
        "kind": "optimizer-trajectory-observed-rgbd-conditioning",
        "frames": args.frames, "fps": args.fps, "width": args.width, "height": args.height,
        "scene_window_seconds": [float(times[0]), float(times[-1])],
        "source_frame_indices": chosen.tolist(),
        "trajectory": str(args.trajectory), "trajectory_sha256": base.sha256(args.trajectory),
        "trajectory_environment_id": trajectory_document.get("environmentId"),
        "metres_per_tracker_unit": metres_per_unit,
        "position_interpolation": "quinticHermite" if trajectory.use_hermite else "linear",
        "max_spline_vs_linear_metres": spline_gap,
        "start_anchor": {"translation_units": anchor_translation, "rotation_degrees": anchor_rotation,
                         "tolerance_units": args.start_tolerance_units,
                         "tolerance_degrees": args.start_tolerance_degrees},
        "fov_y_degrees": {"start": fovs[0], "min": float(min(fovs)), "max": float(max(fovs))},
        "intrinsics": "start-frame source intrinsics (resized to output); focal length scaled by tan(fov_start/2)/tan(fov_t/2)",
        "pose_rule": "target_c2w = anchor @ inv(trackerWorldToEnvironment) @ E(t) @ diag(1,-1,-1,1), E positions divided by metres_per_tracker_unit",
        "valid_fraction_min": min(coverage), "valid_fraction_mean": float(np.mean(coverage)),
        "valid_fraction_final": coverage[-1], "minimum_coverage_required": args.min_coverage,
        "zero_motion_reprojection": zero_validation,
        "source_video": str(args.video), "source_video_sha256": base.sha256(args.video),
        "frontend": str(args.frontend), "frontend_sha256": base.sha256(args.frontend),
        "tracking_sidecar": str(args.sidecar), "tracking_sidecar_sha256": base.sha256(args.sidecar),
        "mask_meaning": "white=observed z-buffer-supported pixel; black=unobserved; RGB hole fill does not alter mask",
        "limitations": ["Relative-scale monocular geometry is estimated, not ground truth",
                        "metres_per_tracker_unit is a user estimate (person height)",
                        "Newly exposed surfaces are unsupported and require TTM generation",
                        "Source frames are sampled by nearest original timestamp"],
    }
    (args.output / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(json.dumps({"complete": True, "output": str(args.output), "valid_fraction_min": min(coverage),
                      "valid_fraction_final": coverage[-1], "zero_motion": zero_validation}), flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--video", type=Path, required=True)
    parser.add_argument("--frontend", type=Path, required=True, help="SpaTracker frontend .npz (depths, c2w, intrinsics, uncertainty)")
    parser.add_argument("--sidecar", type=Path, required=True, help="scene.tracking.json")
    parser.add_argument("--trajectory", type=Path, required=True, help="video/<scene>/shots/<shot>/trajectory.json")
    parser.add_argument("--scene-registry", type=Path, help="video/<scene>/scene.json (supplies metres-per-unit)")
    parser.add_argument("--meters-per-unit", type=float, help="alternative to --scene-registry")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--start", type=float, default=None, help="scene time of output frame 0 (default: first trajectory sample)")
    parser.add_argument("--width", type=int, default=832)
    parser.add_argument("--height", type=int, default=448)
    parser.add_argument("--frames", type=int, default=81)
    parser.add_argument("--fps", type=float, default=16)
    parser.add_argument("--min-coverage", type=float, default=.25)
    parser.add_argument("--prompt-file", type=Path, help="text for TTM; default is the supervisor's pianist prompt")
    parser.add_argument("--start-tolerance-units", type=float, default=0.005,
                        help="max allowed offset between trajectory start and source camera (tracker units)")
    parser.add_argument("--start-tolerance-degrees", type=float, default=0.5)
    parser.add_argument("--allow-start-mismatch", action="store_true")
    arguments = parser.parse_args()
    assert arguments.frames > 1 and arguments.width % 2 == arguments.height % 2 == 0 and arguments.fps > 0
    assert 0 < arguments.min_coverage <= 1
    run(arguments)


if __name__ == "__main__":
    main()
