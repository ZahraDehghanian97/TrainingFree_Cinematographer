from typing import Dict, Any, List, Optional, Tuple
import math
import torch
import torch.nn.functional as F
from dataclasses import dataclass
W = {
    # --- Translation motion when magnitude provided ---
    "trans_keep_rot" : 1.0,
    "rot_keep_trans" : 1.0,
    "truck_target": 1.0,
    "dolly_target": 1.0,
    "pedestal_target": 1.0,

    # --- Translation motion when magnitude missing (direction-only) ---
    "move_dir": 0.2,                # penalize wrong-direction step
    "move_progress": 0.2,           # ensure some net progress
    "move_progress_tau": 0.025,      # minimum net displacement along axis (world units)

    # --- Drift penalties (keep motion “pure” in intended axis) ---
    "orth_drift": 100.0,

    # --- Rotation motion when angle provided ---
    "pan_target": 500.0,
    "tilt_target": 500.0,

    # --- Rotation motion when angle missing (direction-only) ---
    "rot_dir": 2000,                 # penalize wrong-direction step
    "rot_progress": 0.2,            # ensure some net rotation progress
    "rot_progress_tau_deg": 0.08,    # minimum degrees rotated if angle missing

    # --- Arc ---
    "arc_radius_target": 2000.0,       # if radius provided
    "arc_radius_const": 10000.0,        # if radius missing (keep constant radius)
    "arc_angle_target": 5.0, 
    "arc_angle_uniform":1.0,       # if angle provided
    "arc_angle_dir": 2.0,   
    "arc_angle_progress_spec": 1.0,        # direction monotonic (also when angle missing)
    "arc_angle_progress_margin_deg": 5.0, 
    "arc_angle_step_cap" : 0.5,
    "arc_angle_step_cap_mult" : 2.5,
    "arc_angle_step_cap_min_deg" : 6.0, 
    "arc_plane_fit" : 1.0,
    "arc_plane_step" : 0.1,
    "arc_plane_detach_normal" : 1.0,  # ensure some orbit when angle missing
    "arc_angle_tau_deg": 30,      # minimum degrees orbit when angle missing
    "arc_lookat": 200,
    "arc_y_hold": 0,              # keep Y fixed during arc (optional)

    #follow/track
    "follow_keep_trans" : 500 ,
    "follow_lookat" : 20,
    "track_keep_distance" : 200,
    "track_lookat" : 20,
    "inframe_left" : 50,
    "inframe_righ" : 50,
    "inframe_top" : 50,
    "inframe_buttom" : 50,
    "inframe_depth" : 200,


    # --- Subject-aware framing / view / shot ---
    "lookat": 0.008,                  # forward aligns with subject direction
    "framing_ray": 0.004,             # subject lies on camera ray (proxy)
    "shot_distance": 50,           # match distance heuristic from shot size
    "subject_view": 30,
    "subject_view_orient" : 30,            # match azimuth around subject

    # --- MinPath per-interval ---
    "min_path_interval": 10,
}


SHOT_DISTANCE = {
    "extremeCloseUp": 1.2,
    "closeUp":        1.6,
    "mediumCloseUp":  2.2,
    "mediumShot":     3.0,
    "mediumLongShot": 4.0,
    "fullShot":       5.0,
    "longShot":       7.0,
    "veryLongShot":   9.0,
    "extremeLongShot":12.0,
}


VIEW_AZIMUTH_DEG = {
    "front": 0.0,
    "threeQuarterFrontLeft": 45.0,
    "threeQuarterFrontRight": -45.0,
    "left": 90.0,
    "right": -90.0,
    "threeQuarterBackLeft": 135.0,
    "threeQuarterBackRight": -135.0,
    "back": 180.0,
}

def q_normalize(q: torch.Tensor, eps: float = 1e-8) -> torch.Tensor:
    return q / (q.norm(dim=-1, keepdim=True) + eps)

def q_conj(q: torch.Tensor) -> torch.Tensor:
    return torch.cat([q[..., :1], -q[..., 1:]], dim=-1)

def q_mul(a: torch.Tensor, b: torch.Tensor) -> torch.Tensor:
    aw, ax, ay, az = a.unbind(dim=-1)
    bw, bx, by, bz = b.unbind(dim=-1)
    w = aw*bw - ax*bx - ay*by - az*bz
    x = aw*bx + ax*bw + ay*bz - az*by
    y = aw*by - ax*bz + ay*bw + az*bx
    z = aw*bz + ax*by - ay*bx + az*bw
    return torch.stack([w, x, y, z], dim=-1)

def q_rotate(q: torch.Tensor, v: torch.Tensor) -> torch.Tensor:
    q = q_normalize(q)
    vq = torch.cat([torch.zeros_like(v[..., :1]), v], dim=-1)
    return q_mul(q_mul(q, vq), q_conj(q))[..., 1:]

def safe_norm(x: torch.Tensor, eps: float = 1e-8) -> torch.Tensor:
    return torch.sqrt((x * x).sum(dim=-1, keepdim=True) + eps)

def normalize_vec(x: torch.Tensor, eps: float = 1e-8) -> torch.Tensor:
    return x / safe_norm(x, eps)

def dot(a: torch.Tensor, b: torch.Tensor) -> torch.Tensor:
    return (a * b).sum(dim=-1, keepdim=True)

def lookat_dot_loss(forward_unit: torch.Tensor, to_target_unit: torch.Tensor) -> torch.Tensor:
    
    d = dot(forward_unit, to_target_unit).clamp(-1.0, 1.0)
    return (1.0 - d*d)

def project_onto(v: torch.Tensor, axis_unit: torch.Tensor) -> torch.Tensor:
    """Scalar projection (v·axis). axis_unit: (...,3) broadcastable."""
    return (v * axis_unit).sum(dim=-1, keepdim=True)

def unwrap_angle(theta: torch.Tensor) -> torch.Tensor:
    
    if theta.numel() <= 1:
        return theta

    d = theta[1:] - theta[:-1]
    
    d_wrapped = torch.atan2(torch.sin(d), torch.cos(d))
    out = torch.cat([theta[:1], theta[:1] + torch.cumsum(d_wrapped, dim=0)], dim=0)
    return out

def axis_from_q(
    q: torch.Tensor,
    forward_local=(0, 0, 1),
    right_local=(1, 0, 0),
    up_local=(0, 1, 0),
) -> Tuple[torch.Tensor, torch.Tensor, torch.Tensor]:
    
    device, dtype = q.device, q.dtype
    f = q_rotate(q, torch.tensor(forward_local, device=device, dtype=dtype))
    r = q_rotate(q, torch.tensor(right_local, device=device, dtype=dtype))
    u = q_rotate(q, torch.tensor(up_local, device=device, dtype=dtype))
    return normalize_vec(f), normalize_vec(r), normalize_vec(u)

def yaw_from_forward(f: torch.Tensor) -> torch.Tensor:
    
    return torch.atan2(f[..., 0], -f[..., 2])

def pitch_from_forward(f: torch.Tensor) -> torch.Tensor:
    
    horiz = torch.sqrt(f[..., 0]**2 + f[..., 2]**2 + 1e-8)
    return torch.atan2(f[..., 1], horiz)

def clamp_interval(t0: int, t1: int, N: int) -> Tuple[int, int]:
    t0 = max(0, int(t0))
    t1 = min(N - 1, int(t1))
    return t0, t1