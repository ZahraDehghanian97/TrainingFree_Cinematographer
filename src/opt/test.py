import math

import matplotlib.pyplot as plt
import numpy as np
import torch

try:
    from .solver.optimizer import optimize_camera_trajectory
except ImportError:
    from solver.optimizer import optimize_camera_trajectory

start_pose = {
    "kind": "point",
    "t": 0,
    "position": [0.0, 1.6, -6.0],
    "quaternion": [1.0, 0.0, 0.0, 0.0],
    "losses": [],
}
subject_centers = {
    "C0": torch.tensor([[0.0, 1.6, 0.0]] * 120, dtype=torch.float32, device="cpu")
}
constraints = [
    start_pose,
    {
        "kind": "interval",
        "t0": 0,
        "t1": 1200,
        "losses": [{"type": "truckRightMovement", "distance": 3}],
    },
]


def build_subject_centers(subject_tracks, frame_count, device):
    subject_centers_by_id = {}

    for subject_id, subject_track in subject_tracks.items():
        frame_centers = []
        for frame_index in range(frame_count):
            frame_centers.append(subject_track[frame_index]["C0"])
        subject_centers_by_id[subject_id] = torch.tensor(
            frame_centers,
            dtype=torch.float32,
            device=device,
        )

    return subject_centers_by_id


def make_subject_tracks(
    frame_count=1200,
    image_width=1920,
    image_height=1080,
):
    subject_tracks = {}
    primary_subject_track = []
    for _ in range(frame_count):
        bbox = {"x1": 1, "y1": 1, "x2": 1, "y2": 1}
        primary_subject_track.append({"bbox": bbox, "C0": [0, 0, 0]})
    subject_tracks["C0"] = primary_subject_track

    secondary_subject_track = []
    for frame_index in range(frame_count):
        progress = frame_index / (frame_count - 1)
        center_x = 1.0
        center_z = 2.5
        center_y = 1.6 + 0.05 * math.sin(4 * math.pi * progress)
        bbox_height = 220
        bbox_width = int(bbox_height * 0.45)
        pixel_center_x = int(image_width * 0.65)
        pixel_center_y = int(image_height * 0.58)
        bbox = {
            "x1": pixel_center_x - bbox_width // 2,
            "y1": pixel_center_y - bbox_height,
            "x2": pixel_center_x + bbox_width // 2,
            "y2": pixel_center_y,
        }
        secondary_subject_track.append(
            {
                "bbox": bbox,
                "C0": [center_x, center_y, center_z],
            }
        )
    subject_tracks["B"] = secondary_subject_track

    return subject_tracks


def _to_numpy_array(value):
    if value is None:
        return None
    if hasattr(value, "detach"):  # torch tensor
        return value.detach().cpu().numpy()
    return np.asarray(value)


def _normalize_quaternions_numpy(quaternions, epsilon=1e-8):
    quaternions = np.asarray(quaternions, dtype=np.float64)
    quaternion_norms = np.linalg.norm(
        quaternions,
        axis=-1,
        keepdims=True,
    )
    return quaternions / (quaternion_norms + epsilon)


def _conjugate_quaternions_numpy(quaternions):
    quaternions = np.asarray(quaternions)
    conjugated_quaternions = quaternions.copy()
    conjugated_quaternions[..., 1:] *= -1.0
    return conjugated_quaternions


def _multiply_quaternions_numpy(left_quaternions, right_quaternions):
    """
    Quaternion multiply for arrays (...,4), format [w,x,y,z]
    """
    left_w, left_x, left_y, left_z = np.moveaxis(
        left_quaternions,
        -1,
        0,
    )
    right_w, right_x, right_y, right_z = np.moveaxis(
        right_quaternions,
        -1,
        0,
    )

    product_w = (
        left_w * right_w - left_x * right_x - left_y * right_y - left_z * right_z
    )
    product_x = (
        left_w * right_x + left_x * right_w + left_y * right_z - left_z * right_y
    )
    product_y = (
        left_w * right_y - left_x * right_z + left_y * right_w + left_z * right_x
    )
    product_z = (
        left_w * right_z + left_x * right_y - left_y * right_x + left_z * right_w
    )
    return np.stack(
        [product_w, product_x, product_y, product_z],
        axis=-1,
    )


def _rotate_vectors_by_quaternion_numpy(quaternions, vectors):
    """
    Rotate vector(s) v by quaternion(s) q.
    q: (N,4) or (4,)
    v: (3,) or (N,3)
    Returns rotated vector(s) shape matching broadcast.
    """
    quaternions = _normalize_quaternions_numpy(quaternions)

    vectors = np.asarray(vectors, dtype=np.float64)
    if vectors.ndim == 1:
        # broadcast one vector to q batch if needed
        if quaternions.ndim == 2:
            vectors = np.tile(
                vectors[None, :],
                (quaternions.shape[0], 1),
            )

    zero_scalar_components = np.zeros(
        vectors.shape[:-1] + (1,),
        dtype=vectors.dtype,
    )
    vector_quaternions = np.concatenate(
        [zero_scalar_components, vectors],
        axis=-1,
    )

    return _multiply_quaternions_numpy(
        _multiply_quaternions_numpy(
            quaternions,
            vector_quaternions,
        ),
        _conjugate_quaternions_numpy(quaternions),
    )[..., 1:]


def plot_camera_trajectory(
    camera_positions,
    camera_quaternions=None,
    fps=30,
    axis=None,
    title="Camera trajectory",
    arrow_every=None,
    arrow_len=None,
    forward_local=(0, 0, 1),  # if your camera forward is -Z, use (0,0,-1)
):
    """
    camera_positions: array of shape (frame_count, 3)
    camera_quaternions: optional wxyz array of shape (frame_count, 4)
    fps: frames per second (used for start/end time labels)

    Plot convention:
      - horizontal axes: x and z
      - vertical axis: y
    (implemented by plotting as Xplot=x, Yplot=z, Zplot=y)
    """
    # --- convert to numpy ---
    positions_array = _to_numpy_array(camera_positions).astype(np.float64)
    quaternions_array = (
        _to_numpy_array(camera_quaternions).astype(np.float64)
        if camera_quaternions is not None
        else None
    )

    if positions_array.ndim != 2 or positions_array.shape[1] != 3:
        raise ValueError(
            "camera_positions must have shape "
            f"(frame_count, 3), got {positions_array.shape}"
        )

    frame_count = len(positions_array)
    if frame_count == 0:
        raise ValueError("camera_positions is empty")

    if quaternions_array is not None:
        if quaternions_array.ndim != 2 or quaternions_array.shape[1] != 4:
            raise ValueError(
                "camera_quaternions must have shape "
                f"(frame_count, 4), got {quaternions_array.shape}"
            )
        if len(quaternions_array) != frame_count:
            raise ValueError(
                "camera_positions and camera_quaternions must have "
                f"the same length, got {frame_count} and "
                f"{len(quaternions_array)}"
            )

    # World coords
    world_x = positions_array[:, 0]
    world_y = positions_array[:, 1]
    world_z = positions_array[:, 2]

    # --- remap for plotting so y is vertical ---
    # Matplotlib 3D uses z-axis as vertical on screen, so we map:
    # world (x, y, z) -> plot (X=x, Y=z, Z=y)
    plot_x = world_x
    plot_y = world_z
    plot_z = world_y

    # --- axes ---
    created_axis = False
    if axis is None:
        figure = plt.figure(figsize=(8, 6))
        axis = figure.add_subplot(111, projection="3d")
        created_axis = True

    # --- main trajectory line ---
    axis.plot(
        plot_x,
        plot_y,
        plot_z,
        marker="o",
        markersize=3,
        linewidth=1,
    )

    # --- START / END markers ---
    axis.scatter(
        [plot_x[0]],
        [plot_y[0]],
        [plot_z[0]],
        s=140,
        marker="*",
        label="Start",
    )
    axis.scatter(
        [plot_x[-1]],
        [plot_y[-1]],
        [plot_z[-1]],
        s=120,
        marker="X",
        label="End",
    )

    # --- START / END labels (frame + time) ---
    start_time_seconds = 0.0
    end_time_seconds = (frame_count - 1) / float(fps)
    axis.text(
        plot_x[0],
        plot_y[0],
        plot_z[0],
        f"  START\n  frame=0, t={start_time_seconds:.2f}s",
    )
    axis.text(
        plot_x[-1],
        plot_y[-1],
        plot_z[-1],
        (f"  END\n  frame={frame_count - 1}, t={end_time_seconds:.2f}s"),
    )

    # --- orientation arrows from Q (camera forward direction) ---
    if quaternions_array is not None:
        # Choose how densely to draw arrows
        if arrow_every is None:
            arrow_every = max(
                1,
                frame_count // 20,
            )  # ~20 arrows max by default

        arrow_indices = np.arange(
            0,
            frame_count,
            arrow_every,
            dtype=int,
        )
        if arrow_indices[-1] != frame_count - 1:
            arrow_indices = np.concatenate([arrow_indices, [frame_count - 1]])

        sampled_quaternions = _normalize_quaternions_numpy(
            quaternions_array[arrow_indices]
        )

        # Forward direction in world coords
        forward_directions = _rotate_vectors_by_quaternion_numpy(
            sampled_quaternions,
            np.array(forward_local, dtype=np.float64),
        )
        # normalize arrow directions
        forward_norms = np.linalg.norm(
            forward_directions,
            axis=-1,
            keepdims=True,
        )
        forward_directions = forward_directions / (forward_norms + 1e-8)

        # Auto arrow length based on trajectory size
        if arrow_len is None:
            trajectory_span = np.ptp(
                positions_array,
                axis=0,
            )  # world spans in x,y,z
            span_diagonal = np.linalg.norm(trajectory_span)
            arrow_len = 0.06 * span_diagonal if span_diagonal > 1e-8 else 0.2

        # Scale arrows
        arrow_vectors_world = forward_directions * float(arrow_len)

        # Remap arrow directions to plot coords: (dx,dy,dz) = (x,z,y)
        arrow_plot_x = arrow_vectors_world[:, 0]
        arrow_plot_y = arrow_vectors_world[:, 2]
        arrow_plot_z = arrow_vectors_world[:, 1]

        # Arrow origins
        arrow_origin_x = plot_x[arrow_indices]
        arrow_origin_y = plot_y[arrow_indices]
        arrow_origin_z = plot_z[arrow_indices]

        axis.quiver(
            arrow_origin_x,
            arrow_origin_y,
            arrow_origin_z,
            arrow_plot_x,
            arrow_plot_y,
            arrow_plot_z,
            length=1.0,  # vectors already scaled
            normalize=False,
            arrow_length_ratio=0.25,
        )

    # --- cosmetics ---
    axis.set_title(title)
    axis.set_xlabel("x")
    axis.set_ylabel("z")
    axis.set_zlabel("y (vertical)")
    axis.legend()

    # Better aspect ratio (so geometry is not too distorted)
    x_range = np.ptp(plot_x)
    y_range = np.ptp(plot_y)
    z_range = np.ptp(plot_z)
    x_range = x_range if x_range > 1e-6 else 1.0
    y_range = y_range if y_range > 1e-6 else 1.0
    z_range = z_range if z_range > 1e-6 else 1.0
    try:
        axis.set_box_aspect((x_range, y_range, z_range))
    except Exception:
        pass  # older matplotlib may not support this

    if created_axis:
        plt.show()

    return axis


if __name__ == "__main__":
    subject_tracks = make_subject_tracks()
    subject_centers = build_subject_centers(
        subject_tracks,
        1200,
        "cpu",
    )

    optimizer_result = optimize_camera_trajectory(
        constraints,
        duration_seconds=40,
        trajectory_mode="matrix",
        spline_degree=3,
        subject_tracks=subject_tracks,
        subject_centers=subject_centers,
    )

    camera_positions = optimizer_result["P"]
    camera_quaternions = optimizer_result["Q"]

    # arc, pedestal, truck
    plot_camera_trajectory(camera_positions, camera_quaternions)
