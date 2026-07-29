import matplotlib.pyplot as plt
import numpy as np
import torch
from LossFunctions import *
import torch
import torch.optim as optim
from SQUAD import squad_sample_torch
from Bspline import *
from initialization import initialize_control_points
from Optimization import optimize

import math

start_pose = {
    "kind": "point",
    "t": 0,
    "position": [0.0, 1.6, -6.0],
    "quaternion": [1.0, 0.0, 0.0, 0.0],
    "losses": []
}
subject_centers = {
    "C0": torch.tensor([[0.0, 1.6, 0.0]] * 120, dtype=torch.float32, device="cpu")
}
constraints = [
    start_pose,
    
    {
        "kind": "interval",
        "t0": 0, "t1":  1200,
        "losses": [
            {"type": "truckRightMovement", "distance"  :3}
        ]
    }
]

def build_subject_centers(subject_tracks, total_frames, device):
    centers = {}

    for sid, track in subject_tracks.items():
        c = []
        for f in range(total_frames):
            c.append(track[f]["C0"])
        centers[sid] = torch.tensor(c, dtype=torch.float32, device=device)

    return centers

def make_subject_tracks(
        total_frames=1200, image_w=1920, image_h=1080):
    tracks = {}
    A = []
    for f in range(total_frames):
        u = f / (total_frames - 1)
        cx = -2.0 + 4.0*u
        cz =  0.5 + 1.0*u
        cy =  1.6  
        h = 320 + int(80*math.sin(2*math.pi*u))
        w = int(h * 0.45)
        px = int(image_w*0.5 + 250*(cx/4.0))
        py = int(image_h*0.55 - 60*(cz/2.0))
        bbox = {"x1":1, "y1": 1, "x2": 1, "y2":1}
        A.append({"bbox": bbox, "C0": [0 , 0 , 0]})
    tracks["C0"] = A
    B = []
    for f in range(total_frames):
        u = f / (total_frames - 1)
        cx = 1.0
        cz = 2.5
        cy = 1.6 + 0.05*math.sin(4*math.pi*u)
        h = 220
        w = int(h * 0.45)
        px = int(image_w*0.65)
        py = int(image_h*0.58)
        bbox = {"x1": px-w//2, "y1": py-h, "x2": px+w//2, "y2": py}
        B.append({"bbox": bbox, "C0": [cx, cy, cz]})
    tracks["B"] = B

    return tracks


import numpy as np
import matplotlib.pyplot as plt

def _to_numpy(a):
    if a is None:
        return None
    if hasattr(a, "detach"):  # torch tensor
        return a.detach().cpu().numpy()
    return np.asarray(a)

def _q_normalize_np(q, eps=1e-8):
    q = np.asarray(q, dtype=np.float64)
    n = np.linalg.norm(q, axis=-1, keepdims=True)
    return q / (n + eps)

def _q_conj_np(q):
    q = np.asarray(q)
    out = q.copy()
    out[..., 1:] *= -1.0
    return out

def _q_mul_np(a, b):
    """
    Quaternion multiply for arrays (...,4), format [w,x,y,z]
    """
    aw, ax, ay, az = np.moveaxis(a, -1, 0)
    bw, bx, by, bz = np.moveaxis(b, -1, 0)

    w = aw*bw - ax*bx - ay*by - az*bz
    x = aw*bx + ax*bw + ay*bz - az*by
    y = aw*by - ax*bz + ay*bw + az*bx
    z = aw*bz + ax*by - ay*bx + az*bw
    return np.stack([w, x, y, z], axis=-1)

def _q_rotate_np(q, v):
    """
    Rotate vector(s) v by quaternion(s) q.
    q: (N,4) or (4,)
    v: (3,) or (N,3)
    Returns rotated vector(s) shape matching broadcast.
    """
    q = _q_normalize_np(q)

    v = np.asarray(v, dtype=np.float64)
    if v.ndim == 1:
        # broadcast one vector to q batch if needed
        if q.ndim == 2:
            v = np.tile(v[None, :], (q.shape[0], 1))

    zeros = np.zeros(v.shape[:-1] + (1,), dtype=v.dtype)
    vq = np.concatenate([zeros, v], axis=-1)

    return _q_mul_np(_q_mul_np(q, vq), _q_conj_np(q))[..., 1:]

def plot_points_trajectory(
    P,
    Q=None,
    fps=30,
    ax=None,
    title="Camera trajectory",
    arrow_every=None,
    arrow_len=None,
    forward_local=(0, 0, 1),  # if your camera forward is -Z, use (0,0,-1)
):
    """
    P: torch.Tensor or np.ndarray of shape (N,3)
    Q: torch.Tensor or np.ndarray of shape (N,4), quaternion [w,x,y,z] (optional)
    fps: frames per second (used for start/end time labels)

    Plot convention:
      - horizontal axes: x and z
      - vertical axis: y
    (implemented by plotting as Xplot=x, Yplot=z, Zplot=y)
    """
    # --- convert to numpy ---
    Pn = _to_numpy(P).astype(np.float64)
    Qn = _to_numpy(Q).astype(np.float64) if Q is not None else None

    if Pn.ndim != 2 or Pn.shape[1] != 3:
        raise ValueError(f"P must have shape (N,3), got {Pn.shape}")

    N = len(Pn)
    if N == 0:
        raise ValueError("P is empty")

    if Qn is not None:
        if Qn.ndim != 2 or Qn.shape[1] != 4:
            raise ValueError(f"Q must have shape (N,4), got {Qn.shape}")
        if len(Qn) != N:
            raise ValueError(f"P and Q must have same length, got {len(Pn)} and {len(Qn)}")

    # World coords
    x, y, z = Pn[:, 0], Pn[:, 1], Pn[:, 2]

    # --- remap for plotting so y is vertical ---
    # Matplotlib 3D uses z-axis as vertical on screen, so we map:
    # world (x, y, z) -> plot (X=x, Y=z, Z=y)
    Xp = x
    Yp = z
    Zp = y

    # --- axes ---
    created_ax = False
    if ax is None:
        fig = plt.figure(figsize=(8, 6))
        ax = fig.add_subplot(111, projection="3d")
        created_ax = True

    # --- main trajectory line ---
    ax.plot(Xp, Yp, Zp, marker="o", markersize=3, linewidth=1)

    # --- START / END markers ---
    ax.scatter([Xp[0]],  [Yp[0]],  [Zp[0]],  s=140, marker="*", label="Start")
    ax.scatter([Xp[-1]], [Yp[-1]], [Zp[-1]], s=120, marker="X", label="End")

    # --- START / END labels (frame + time) ---
    t0_sec = 0.0
    t1_sec = (N - 1) / float(fps)
    ax.text(Xp[0],  Yp[0],  Zp[0],  f"  START\n  f=0, t={t0_sec:.2f}s")
    ax.text(Xp[-1], Yp[-1], Zp[-1], f"  END\n  f={N-1}, t={t1_sec:.2f}s")

    # --- orientation arrows from Q (camera forward direction) ---
    if Qn is not None:
        # Choose how densely to draw arrows
        if arrow_every is None:
            arrow_every = max(1, N // 20)  # ~20 arrows max by default

        idx = np.arange(0, N, arrow_every, dtype=int)
        if idx[-1] != N - 1:
            idx = np.concatenate([idx, [N - 1]])

        Qs = _q_normalize_np(Qn[idx])

        # Forward direction in world coords
        fwd = _q_rotate_np(Qs, np.array(forward_local, dtype=np.float64))
        # normalize arrow directions
        fwd_norm = np.linalg.norm(fwd, axis=-1, keepdims=True)
        fwd = fwd / (fwd_norm + 1e-8)

        # Auto arrow length based on trajectory size
        if arrow_len is None:
            span = np.ptp(Pn, axis=0)  # world spans in x,y,z
            diag = np.linalg.norm(span)
            arrow_len = 0.06 * diag if diag > 1e-8 else 0.2

        # Scale arrows
        d_world = fwd * float(arrow_len)

        # Remap arrow directions to plot coords: (dx,dy,dz) = (x,z,y)
        dXp = d_world[:, 0]
        dYp = d_world[:, 2]
        dZp = d_world[:, 1]

        # Arrow origins
        PX = Xp[idx]
        PY = Yp[idx]
        PZ = Zp[idx]

        ax.quiver(
            PX, PY, PZ,
            dXp, dYp, dZp,
            length=1.0,          # vectors already scaled
            normalize=False,
            arrow_length_ratio=0.25
        )

    # --- cosmetics ---
    ax.set_title(title)
    ax.set_xlabel("x")
    ax.set_ylabel("z")
    ax.set_zlabel("y (vertical)")
    ax.legend()

    # Better aspect ratio (so geometry is not too distorted)
    xr = np.ptp(Xp)
    yr = np.ptp(Yp)
    zr = np.ptp(Zp)
    xr = xr if xr > 1e-6 else 1.0
    yr = yr if yr > 1e-6 else 1.0
    zr = zr if zr > 1e-6 else 1.0
    try:
        ax.set_box_aspect((xr, yr, zr))
    except Exception:
        pass  # older matplotlib may not support this

    if created_ax:
        plt.show()

    return ax


subject_tracks = make_subject_tracks()
subject_centers = build_subject_centers(subject_tracks , 1200 , "cpu")

out = optimize(constraints, total_duration=40, traj_mode="matrix", degree=3, subject_tracks=subject_tracks, subject_centers=subject_centers)

P = out["P"]
Q = out["Q"]

# degree = 15

#arc , pedestal , truck
plot_points_trajectory(P, Q )