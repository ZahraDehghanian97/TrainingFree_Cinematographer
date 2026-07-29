

from __future__ import annotations
from dataclasses import dataclass
from typing import Dict, Any, List, Optional, Tuple
import math
import torch
import torch.nn.functional as F


W = {
    "trans_keep_rot" : 5000,
    "rot_keep_trans" : 5000,
    "truck_target": 2000,
    "dolly_target": 2000,
    "pedestal_target": 2000,

    # translation motion when magnitude missing
    "move_dir": 1000,                # penalize wrong-direction step
    "move_progress": 3000,           # ensure some net progress
    "move_progress_tau": 0.025,      # minimum net displacement along axis (world units)

    #Drift penalties
    "orth_drift": 1000.0,

    #Rotation motion when angle provided
    "pan_target": 500.0,
    "tilt_target": 500.0,

    #Rotation motion when angle missing
    "rot_dir": 2000,                 # penalize wrong-direction step
    "rot_progress": 200,            # ensure some net rotation progress
    "rot_progress_tau_deg": 0.08,    # minimum degrees rotated if angle missing

    # Arc
    "arc_radius_target": 10000.0,       # if radius provided
    "arc_radius_const": 10000.0,        # if radius missing (keep constant radius)
    "arc_angle_target": 5000.0, 
    "arc_angle_uniform":1000.0,       # if angle provided
    "arc_angle_dir": 2000.0,   
    "arc_angle_progress_spec": 1000.0,        # direction monotonic (also when angle missing)
    "arc_angle_progress_margin_deg": 500.0, 
    "arc_angle_step_cap" : 50,
    "arc_angle_step_cap_mult" : 250,
    "arc_angle_step_cap_min_deg" : 600, 
    "arc_plane_fit" : 1000,
    "arc_plane_step" : 0.1,
    "arc_plane_detach_normal" : 1.0,  # ensure some orbit when angle missing
    "arc_angle_tau_deg": 30,      # minimum degrees orbit when angle missing
    "arc_lookat": 2000,
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


    # Subject-aware framing / view / shot
    "lookat": 80,                  # forward aligns with subject direction
    "framing_ray": 100,             # subject lies on camera ray (proxy)
    "shot_distance": 500,           # match distance heuristic from shot size
    "subject_view": 300,
    "subject_view_orient" : 30,            # match azimuth around subject

    #MinPath per-interval
    "min_path_interval": 100,

    "point_position": 1000.0,        # weight for anchoring translation at specific frame
    "point_rotation": 1000.0,
}

# heuristic shot-size -> target distance (scene-scale dependent; tune)
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

TRANSLATION_MOVES = {
    "dollyInMovement": ("dolly", +1),
    "dollyOutMovement": ("dolly", -1),

    "truckLeftMovement": ("truck", -1),
    "truckRightMovement": ("truck", +1),

    "pedestalUpMovement": ("pedestal", +1),
    "pedestalDownMovement": ("pedestal", -1),
}

ROTATION_MOVES = {
    "panLeftMovement": ("pan", -1),
    "panRightMovement": ("pan", +1),

    "tiltUpMovement": ("tilt", +1),
    "tiltDownMovement": ("tilt", -1),
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



def min_path_interval(P: torch.Tensor, t0: int, t1: int) -> torch.Tensor:
    N = P.shape[0]
    t0, t1 = clamp_interval(t0, t1, N)
    if t1 <= t0:
        return torch.zeros((), device=P.device, dtype=P.dtype)
    d = P[t0+1:t1+1] - P[t0:t1]
    return torch.sqrt((d*d).sum(dim=-1) + 1e-8).mean()



def loss_keep_rotation(Q: torch.Tensor, t0: int, t1: int) -> torch.Tensor:
    
    q0 = Q[t0:t0+1]                          
    q_int = Q[t0:t1+1]                       
    dots = (q_int * q0).sum(dim=-1).abs()    
    return (1.0 - dots**2).mean()

def loss_keep_translation(P: torch.Tensor, t0: int, t1: int) -> torch.Tensor:
    
    p0 = P[t0]                               
    diff = P[t0:t1+1] - p0                   
    return (diff.pow(2).sum(dim=-1)).mean()


def loss_translate_local_axis(
    P: torch.Tensor,
    Q: torch.Tensor,
    t0: int,
    t1: int,
    axis_name: str,
    sign: float,
    distance: Optional[float] = None,
) -> Dict[str, torch.Tensor]:

    device, dtype = P.device, P.dtype

    t0, t1 = clamp_interval(t0, t1, P.shape[0])
    if t1 <= t0:
        return {}

    # ------------------------------------------------------------------
    # Reference frame at start
    # ------------------------------------------------------------------

    P0 = P[t0]

    forward, right, up = (
        v[0] for v in axis_from_q(Q[t0:t0 + 1])
    )

    axis_lookup = {
        "truck": right,
        "dolly": forward,
        "pedestal": up,
    }

    weight_lookup = {
        "truck": W["truck_target"],
        "dolly": W["dolly_target"],
        "pedestal": W["pedestal_target"],
    }

    axis = axis_lookup[axis_name]
    target_weight = weight_lookup[axis_name]

    # ------------------------------------------------------------------
    # Motion along desired axis
    # ------------------------------------------------------------------

    delta = P[t0 + 1:t1 + 1] - P[t0:t1]

    step_progress = sign * (delta * axis).sum(dim=-1)

    total_progress = sign * ((P[t1] - P0) * axis).sum()

    losses: Dict[str, torch.Tensor] = {}

    # ------------------------------------------------------------------
    # Desired translation
    # ------------------------------------------------------------------

    prefix = f"{axis_name}Movement"

    if distance is None:

        losses[f"{prefix}/direction"] = (
            W["move_dir"]
            * (F.relu(-step_progress) ** 2).mean()
        )

        losses[f"{prefix}/progress"] = (
            W["move_progress"]
            * (
                F.relu(
                    float(W["move_progress_tau"]) - total_progress
                ) ** 2
            )
        )

    else:

        losses[f"{prefix}/target"] = (
            target_weight
            * (total_progress - float(distance)) ** 2
        )

        losses[f"{prefix}/direction"] = (
            W["move_dir"]
            * (F.relu(-step_progress) ** 2).mean()
        )

    # ------------------------------------------------------------------
    # Penalize drift on orthogonal axes
    # ------------------------------------------------------------------

    if W["orth_drift"] > 0:

        displacement = P[t0:t1 + 1] - P0

        orth_axes = {
            "truck": [forward, up],
            "dolly": [right, up],
            "pedestal": [forward, right],
        }

        drift = torch.zeros((), device=device, dtype=dtype)

        for orth in orth_axes[axis_name]:
            drift += (
                project_onto(
                    displacement,
                    orth.unsqueeze(0)
                ).squeeze(-1).pow(2).mean()
            )

        losses[f"{prefix}/drift"] = (
            W["orth_drift"] * drift
        )
    print("Losses:", losses)
    print("total_progress =", total_progress.item())
    print("target =", distance)
    return losses

def loss_static_interval(P: torch.Tensor, Q: torch.Tensor, t0: int, t1: int) -> Dict[str, torch.Tensor]:
    N = P.shape[0]
    t0, t1 = clamp_interval(t0, t1, N)
    if t1 <= t0:
        return {}

    out: Dict[str, torch.Tensor] = {}
    Pseg = P[t0:t1+1]             
    P0 = Pseg[:1]                   
    L_p_anchor = ((Pseg - P0).pow(2).sum(dim=-1)).mean()
    dP = Pseg[1:] - Pseg[:-1]       
    if dP.numel() > 0:
        L_p_step = (dP.pow(2).sum(dim=-1)).mean()
    else:
        L_p_step = torch.zeros((), device=P.device, dtype=P.dtype)

    out["static/trans_anchor"] = W.get("static_trans_anchor", 0.0) * L_p_anchor
    out["static/trans_step"]   = W.get("static_trans_step",   0.0) * L_p_step


    Qseg = q_normalize(Q[t0:t1+1])     
    Q0 = Qseg[:1]                  

    dots_anchor = (Qseg * Q0).sum(dim=-1).abs().clamp(0.0, 1.0)
    L_q_anchor = (1.0 - dots_anchor**2).mean()

    if Qseg.shape[0] >= 2:
        dots_step = (Qseg[1:] * Qseg[:-1]).sum(dim=-1).abs().clamp(0.0, 1.0)
        L_q_step = (1.0 - dots_step**2).mean()
    else:
        L_q_step = torch.zeros((), device=Q.device, dtype=Q.dtype)

    out["static/rot_anchor"] = W.get("static_rot_anchor", 0.0) * L_q_anchor
    out["static/rot_step"]   = W.get("static_rot_step",   0.0) * L_q_step

    return out


def loss_pan_tilt_framewise(
    Q: torch.Tensor,
    t0: int,
    t1: int,
    move_type: str,
    angle_deg: Optional[float] = None,
) -> Dict[str, torch.Tensor]:

    device, dtype = Q.device, Q.dtype

    N = Q.shape[0]
    t0, t1 = clamp_interval(t0, t1, N)

    if t1 <= t0:
        return {}

    f, _, _ = axis_from_q(Q[t0:t1 + 1])

    yaw = unwrap_angle(yaw_from_forward(f))
    pitch = unwrap_angle(pitch_from_forward(f))

    configs = {
        "panLeftMovement": {
            "angles": yaw,
            "sign": 1.0,
            "weight": W["pan_target"],
        },
        "panRightMovement": {
            "angles": yaw,
            "sign": -1.0,
            "weight": W["pan_target"],
        },
        "tiltUpMovement": {
            "angles": pitch,
            "sign": 1.0,
            "weight": W["tilt_target"],
        },
        "tiltDownMovement": {
            "angles": pitch,
            "sign": -1.0,
            "weight": W["tilt_target"],
        },
    }

    if move_type not in configs:
        raise ValueError(f"Unknown movement type: {move_type}")

    cfg = configs[move_type]

    a = cfg["angles"]
    sign = cfg["sign"]
    target_weight = cfg["weight"]

    delta = a[1:] - a[:-1]
    total = sign * (a[-1] - a[0])

    out: Dict[str, torch.Tensor] = {}

    if angle_deg is None:

        out[f"{move_type}/dir"] = (
            W["rot_dir"]
            * (F.relu(-sign * delta) ** 2).mean()
        )

        tau = math.radians(float(W["rot_progress_tau_deg"]))

        out[f"{move_type}/progress"] = (
            W["rot_progress"]
            * (F.relu(tau - total) ** 2)
        )

    else:

        target = math.radians(float(angle_deg))

        out[f"{move_type}/target_end"] = (
            target_weight
            * ((total - target) ** 2)
        )

        out[f"{move_type}/monotonic"] = (
            W["rot_dir"]
            * (F.relu(-sign * delta) ** 2).mean()
        )

    return out


def project_world_points_to_image(
    Ps: torch.Tensor,           
    Qs: torch.Tensor,         
    Xw: torch.Tensor,          
    fx: float, fy: float, cx: float, cy: float,
    eps: float = 1e-6,
):
    f, r, u = axis_from_q(Qs)                    

    d = Xw - Ps[:, None, :]                     

    x_cam = (d * r[:, None, :]).sum(dim=-1)     
    y_cam = (d * u[:, None, :]).sum(dim=-1)     
    z_cam = (d * f[:, None, :]).sum(dim=-1)    

    x_pix = fx * (x_cam / (z_cam + eps)) + cx
    y_pix = cy - fy * (y_cam / (z_cam + eps))  

    return x_pix, y_pix, z_cam


def loss_subject_bbox_in_frame(
    Ps: torch.Tensor,          
    Qs: torch.Tensor,        
    Bws: torch.Tensor,            
    image_w: int,
    image_h: int,
    fx: float, fy: float, cx: float, cy: float,
    margin_px: float = 20.0,
    z_near: float = 1e-3,
) -> Dict[str, torch.Tensor]:
    
    device, dtype = Ps.device, Ps.dtype
    if Ps.numel() == 0 or Qs.numel() == 0 or Bws.numel() == 0:
        zero = torch.zeros((), device=device, dtype=dtype)
        return {
            "inFrame/left": zero, "inFrame/right": zero,
            "inFrame/top": zero, "inFrame/bottom": zero,
            "inFrame/depth": zero,
        }

    x_pix, y_pix, z_cam = project_world_points_to_image(Ps, Qs, Bws, fx, fy, cx, cy)

    xmin = x_pix.min(dim=1).values
    xmax = x_pix.max(dim=1).values
    ymin = y_pix.min(dim=1).values
    ymax = y_pix.max(dim=1).values
    L_left   = (F.relu(margin_px - xmin) ** 2).mean()
    L_right  = (F.relu(xmax - (float(image_w) - margin_px)) ** 2).mean()
    L_top    = (F.relu(margin_px - ymin) ** 2).mean()
    L_bottom = (F.relu(ymax - (float(image_h) - margin_px)) ** 2).mean()
    L_depth  = (F.relu(float(z_near) - z_cam) ** 2).mean()

    return {
        "inFrame/left":   W.get("inframe_left", 1.0)   * L_left,
        "inFrame/right":  W.get("inframe_right", 1.0)  * L_right,
        "inFrame/top":    W.get("inframe_top", 1.0)    * L_top,
        "inFrame/bottom": W.get("inframe_bottom", 1.0) * L_bottom,
        "inFrame/depth":  W.get("inframe_depth", 1.0)  * L_depth,
    }


def loss_follow_interval(
    P: torch.Tensor,
    Q: torch.Tensor,
    t0: int, t1: int,
    Ss: torch.Tensor,         
    Bws: torch.Tensor,          
    image_w: int, image_h: int,
    fx: float, fy: float, cx: float, cy: float,
    margin_px: float = 20.0,
) -> Dict[str, torch.Tensor]:
    N = P.shape[0]
    t0, t1 = clamp_interval(t0, t1, N)
    if t1 <= t0:
        return {}

    Ps = P[t0:t1+1]
    Qs = Q[t0:t1+1]

    out: Dict[str, torch.Tensor] = {}
  
    L_keepP = loss_keep_translation(P, t0, t1)
    out["follow/keepTrans"] = W.get("follow_keep_trans", 1.0) * L_keepP

   
    out.update(
        loss_subject_bbox_in_frame(
            Ps, Qs, Bws, image_w, image_h, fx, fy, cx, cy, margin_px=margin_px
        )
    )

    framing = loss_framing_position_proxy(Ps, Qs, Ss)
    if "framing/lookat" in framing:
        out["follow/lookat"] = W.get("follow_lookat", 1.0) * (framing["framing/lookat"] / max(W.get("lookat", 1.0), 1e-8))

    return out


def loss_keep_subject_distance(
    Ps: torch.Tensor,   
    Ss: torch.Tensor,   
) -> torch.Tensor:
    if Ps.numel() == 0 or Ss.numel() == 0:
        return torch.zeros((), device=Ps.device, dtype=Ps.dtype)

    d = safe_norm(Ps - Ss).squeeze(-1)    
    d0 = d[0].detach()
    return ((d - d0) ** 2).mean()


def loss_track_interval(
    P: torch.Tensor,
    Q: torch.Tensor,
    t0: int, t1: int,
    Ss: torch.Tensor,             
    Bws: torch.Tensor,         
    image_w: int, image_h: int,
    fx: float, fy: float, cx: float, cy: float,
    margin_px: float = 20.0,
) -> Dict[str, torch.Tensor]:
    N = P.shape[0]
    t0, t1 = clamp_interval(t0, t1, N)
    if t1 <= t0:
        return {}

    Ps = P[t0:t1+1]
    Qs = Q[t0:t1+1]

    out: Dict[str, torch.Tensor] = {}

    L_keepD = loss_keep_subject_distance(Ps, Ss)
    out["track/keepDistance"] = W.get("track_keep_distance", 1.0) * L_keepD
    out.update(
        loss_subject_bbox_in_frame(
            Ps, Qs, Bws, image_w, image_h, fx, fy, cx, cy, margin_px=margin_px
        )
    )
    framing = loss_framing_position_proxy(Ps, Qs, Ss)
    if "framing/lookat" in framing:
        out["track/lookat"] = W.get("track_lookat", 1.0) * (framing["framing/lookat"] / max(W.get("lookat", 1.0), 1e-8))

    return out


def loss_arc_framewise(
    P: torch.Tensor, Q: torch.Tensor,
    center: torch.Tensor,        
    t0: int, t1: int,
    radius: Optional[float],      
    angle_deg: Optional[float],   
    hold_y: bool = True,
) -> Dict[str, torch.Tensor]:

    def huber(x: torch.Tensor, delta: float = 1.0) -> torch.Tensor:
        ax = x.abs()
        q = torch.minimum(ax, torch.tensor(delta, device=x.device, dtype=x.dtype))
        lin = ax - q
        return 0.5 * q * q + delta * lin

    def _normalize(x: torch.Tensor, eps: float = 1e-8) -> torch.Tensor:
        return x / torch.sqrt((x * x).sum(dim=-1, keepdim=True) + eps)

    def _project_to_plane(x: torch.Tensor, nrm: torch.Tensor) -> torch.Tensor:
        d = (x * nrm[None, :]).sum(dim=-1, keepdim=True)
        return x - d * nrm[None, :]

    if angle_deg is None:
        raise ValueError("loss_arc_framewise: angle_deg must not be None in this version.")

    tol_radius = float(W.get("arc_tol_radius", 1.0))
    tol_plane  = float(W.get("arc_tol_plane",  1.0))
    tol_ang    = float(W.get("arc_tol_ang",    1.0))
    tol_acc    = float(W.get("arc_tol_acc",    1.0))

    n = int(W.get("arc_samples", 128))
    N = P.shape[0]
    t0, t1 = clamp_interval(t0, t1, N)
    if t1 <= t0:
        return {}
    L = (t1 - t0 + 1)
    if L <= n:
        idx = torch.arange(t0, t1 + 1, device=P.device)
    else:
        idxf = torch.linspace(t0, t1, steps=n, device=P.device)
        idx = torch.unique(idxf.round().long())
        if idx[0].item() != t0:
            idx = torch.cat([torch.tensor([t0], device=P.device), idx])
        if idx[-1].item() != t1:
            idx = torch.cat([idx, torch.tensor([t1], device=P.device)])
    idx = idx.clamp(0, N - 1)

    p = P[idx]
    q = Q[idx]

    if center.ndim == 1:
        c = center.to(device=P.device, dtype=P.dtype)[None, :].expand(p.shape[0], 3)
    else:
        c = center[idx].to(device=P.device, dtype=P.dtype)

    out: Dict[str, torch.Tensor] = {}

    idx_ang = torch.arange(t0, t1 + 1, device=P.device)
    p_ang = P[idx_ang]

    if center.ndim == 1:
        c_ang = center.to(device=P.device, dtype=P.dtype)[None, :].expand(p_ang.shape[0], 3)
    else:
        c_ang = center[idx_ang].to(device=P.device, dtype=P.dtype)

    v_ang = p_ang - c_ang 

    if v_ang.shape[0] >= 3:
        Cfit = (v_ang.transpose(0, 1) @ v_ang) / max(1, v_ang.shape[0])
        Cfit = Cfit + 1e-8 * torch.eye(3, device=P.device, dtype=P.dtype)
        evals, evecs = torch.linalg.eigh(Cfit)
        n_fit = evecs[:, 0]
        n_fit = n_fit / (torch.sqrt((n_fit * n_fit).sum()) + 1e-8)
        if v_ang.shape[0] >= 2:
            cs = torch.cross(v_ang[:-1], v_ang[1:], dim=-1).sum(dim=0)
            cs_norm = torch.sqrt((cs * cs).sum() + 1e-8)
            if cs_norm > 1e-6:
                ref_n = cs / cs_norm
            else:
                ref_n = torch.tensor([0.0, 1.0, 0.0], device=P.device, dtype=P.dtype)
        else:
            ref_n = torch.tensor([0.0, 1.0, 0.0], device=P.device, dtype=P.dtype)

        if (n_fit * ref_n).sum() < 0:
            n_fit = -n_fit
        if float(W.get("arc_plane_detach_normal", 1.0)) > 0:
            n_fit = n_fit.detach()
    else:
        n_fit = torch.tensor([0.0, 1.0, 0.0], device=P.device, dtype=P.dtype)
    if hold_y:
        w_plane = float(W.get("arc_plane_fit", W.get("arc_y_hold", 0.0)))
        if w_plane > 0:
            d_plane = (v_ang * n_fit[None, :]).sum(dim=-1) 
            r_plane = d_plane / tol_plane
            out["arc/plane"] = w_plane * huber(r_plane, 1.0).mean()    
        w_plane_step = float(W.get("arc_plane_step", W.get("arc_y_step", 0.0)))
        if w_plane_step > 0 and v_ang.shape[0] >= 2:
            d_plane = (v_ang * n_fit[None, :]).sum(dim=-1)
            dd = (d_plane[1:] - d_plane[:-1]) / tol_plane
            out["arc/plane_step"] = w_plane_step * huber(dd, 1.0).mean()


    v = p - c
    v_in_plane = _project_to_plane(v, n_fit)
    r_now = torch.sqrt((v_in_plane * v_in_plane).sum(dim=-1) + 1e-8)
    if radius is None:
        r0 = r_now[0].detach()
        r_res = (r_now - r0) / tol_radius
        L_rad = huber(r_res, 1.0).mean()
        out["arc/radius_const"] = W["arc_radius_const"] * L_rad

        w_mag = float(W.get("arc_radius_mag", 0.0))
        if w_mag > 0:
            out["arc/radius_mag"] = w_mag * (r_now.mean() ** 2)
        r_ref_for_aux = r0
    else:
        r = float(radius)
        r_ref = torch.tensor(r, device=P.device, dtype=P.dtype)
        r_res = (r_now - r_ref) / tol_radius
        L_rad = huber(r_res, 1.0).mean()
        out["arc/radius_target"] = W["arc_radius_target"] * L_rad
        r_ref_for_aux = r_ref
    w_inner = float(W.get("arc_inner_barrier", 0.0))
    if w_inner > 0:
        v_ang_plane = _project_to_plane(v_ang, n_fit)
        r_ang_now = torch.sqrt((v_ang_plane * v_ang_plane).sum(dim=-1) + 1e-8)
        inner_frac = float(W.get("arc_inner_frac", 0.85))
        r_floor = inner_frac * r_ref_for_aux
        inner_violation = F.relu(r_floor - r_ang_now) / tol_radius
        out["arc/radius_inner_barrier"] = w_inner * huber(inner_violation, 1.0).mean()
    vproj = _project_to_plane(v_ang, n_fit)
    u = _normalize(vproj)

    if u.shape[0] >= 2:
        u0 = u[:-1]
        u1 = u[1:]

        cross = torch.cross(u0, u1, dim=-1)
        sinv = (cross * n_fit[None, :]).sum(dim=-1)
        cosv = torch.clamp((u0 * u1).sum(dim=-1), -1.0, 1.0)
        dtheta = torch.atan2(sinv, cosv)  
        theta = dtheta.sum()            

        theta_des = math.radians(float(angle_deg))
        sign = 1.0 if theta_des >= 0 else -1.0
        back = F.relu(-sign * dtheta) / tol_ang
        out["arc/angle_dir"] = W["arc_angle_dir"] * huber(back, 1.0).mean()
        r_ang = (theta - theta_des) / tol_ang
        out["arc/angle_target"] = W["arc_angle_target"] * huber(r_ang, 1.0)
        K = dtheta.numel()
        if K >= 2:
            cum = torch.cumsum(dtheta, dim=0)
            fracs = torch.arange(1, K + 1, device=P.device, dtype=P.dtype) / float(K)
            desired_cum = torch.tensor(theta_des, device=P.device, dtype=P.dtype) * fracs
            w_uniform = float(W.get("arc_angle_uniform", 0.0))
            if w_uniform > 0:
                e_sched = (cum - desired_cum) / tol_ang
                out["arc/angle_uniform"] = w_uniform * huber(e_sched, 1.0).mean()
            w_prog_spec = float(W.get("arc_angle_progress_spec", 0.0))
            if w_prog_spec > 0:
                margin_deg = float(W.get("arc_angle_progress_margin_deg", 5.0))
                margin = torch.tensor(math.radians(margin_deg), device=P.device, dtype=P.dtype)

                signed_cum = sign * cum
                signed_des = sign * desired_cum
                lag  = F.relu((signed_des - margin) - signed_cum) / tol_ang
                lead = F.relu(signed_cum - (signed_des + margin)) / tol_ang

                out["arc/angle_progress_spec"] = w_prog_spec * (
                    huber(lag, 1.0).mean() + huber(lead, 1.0).mean()
                )
            w_step_cap = float(W.get("arc_angle_step_cap", 0.0))
            if w_step_cap > 0:
                avg_step = abs(theta_des) / max(1, K)
                mult = float(W.get("arc_angle_step_cap_mult", 2.5))
                min_cap_deg = float(W.get("arc_angle_step_cap_min_deg", 6.0))
                min_cap = math.radians(min_cap_deg)
                step_cap = max(mult * avg_step, min_cap)

                step_excess = F.relu(dtheta.abs() - step_cap) / tol_ang
                out["arc/angle_step_cap"] = w_step_cap * huber(step_excess, 1.0).mean()

    w_acc = float(W.get("arc_acc", 0.0))
    if w_acc > 0 and p.shape[0] >= 3:
        acc = p[2:] - 2.0 * p[1:-1] + p[:-2]
        a = torch.sqrt((acc * acc).sum(dim=-1) + 1e-8)
        r_acc = a / tol_acc
        out["arc/acc"] = w_acc * huber(r_acc, 1.0).mean()
    fwd, _, _ = axis_from_q(q)
    dir_des = _normalize(c - p)
    cosang = torch.clamp((fwd * dir_des).sum(dim=-1), -1.0, 1.0)
    out["arc/lookat"] = W["arc_lookat"] * ((1.0 - cosang) ** 2).mean()

    return out


def loss_shot_size_distance(Ps: torch.Tensor, Ss: torch.Tensor, shot_size: str) -> Dict[str, torch.Tensor]:
    
    if Ps.numel() == 0 or Ss.numel() == 0:
        zero = torch.zeros((), device=Ps.device, dtype=Ps.dtype)
        return {"shotSize/dist": zero}
    target = SHOT_DISTANCE.get(shot_size, SHOT_DISTANCE['mediumLongShot'])
    d = safe_norm(Ss - Ps).squeeze(-1)
    loss = ((d - target)**2).mean()
    return {"shotSize/dist": W['shot_distance'] * loss}

def loss_subject_view_azimuth(Ps: torch.Tensor, Ss: torch.Tensor, view: str) -> Dict[str, torch.Tensor]:
    if Ps.numel() == 0 or Ss.numel() == 0:
        zero = torch.zeros((), device=Ps.device, dtype=Ps.dtype)
        return {"subjectView/azimuth": zero}
    target = math.radians(VIEW_AZIMUTH_DEG.get(view, 0.0))
    v = Ps - Ss
    az = torch.atan2(v[:,0], -v[:,2])
    err = torch.atan2(torch.sin(az - target), torch.cos(az - target))
    loss = (err**2).mean()
    return {"subjectView/azimuth": W['subject_view'] * loss}

def loss_subject_view_orientation(Ps, Qs, Ss, view):
    out = loss_subject_view_azimuth(Ps, Ss, view)
    f, _, _ = axis_from_q(Qs)                  
    yaw = unwrap_angle(yaw_from_forward(f)) 
    target = math.radians(VIEW_AZIMUTH_DEG[view])
    err = torch.atan2(torch.sin(yaw - target),
                      torch.cos(yaw - target))
    out["subjectView/orientYaw"] = W["subject_view_orient"] * (err**2).mean()
    return out

def loss_framing_position_proxy(Ps: torch.Tensor, Qs: torch.Tensor, Ss: torch.Tensor) -> Dict[str, torch.Tensor]:
    if Ps.numel() == 0 or Qs.numel() == 0 or Ss.numel() == 0:
        zero = torch.zeros((), device=Ps.device, dtype=Ps.dtype)
        return {"framing/lookat": zero, "framing/ray": zero}
    f, _, _ = axis_from_q(Qs)
    d = Ss - Ps
    d_hat = normalize_vec(d)
    look = lookat_dot_loss(f, d_hat).mean()
    along = (d * f).sum(dim=-1, keepdim=True) * f
    perp = d - along
    ray = (perp.pow(2).sum(dim=-1)).mean()
    return {"framing/lookat": W['lookat'] * look, "framing/ray": W['framing_ray'] * ray}

def non_subject_aware_loss(
    Ps: torch.Tensor,
    Qs: torch.Tensor,
    target_position: Optional[List[float]],
    target_rotation: Optional[List[float]]
) -> Dict[str, torch.Tensor]:

    device, dtype = Ps.device, Ps.dtype
    out: Dict[str, torch.Tensor] = {}
    if target_position is not None:
        p_target = torch.tensor(target_position, device=device, dtype=dtype)
        loss_pos = ((Ps - p_target) ** 2).sum(dim=-1).mean()
        out["point/position"] = W.get("point_position", 1000.0) * loss_pos
    if target_rotation is not None:
        q_target = torch.tensor(target_rotation, device=device, dtype=dtype)
        q_target = q_normalize(q_target.unsqueeze(0))
        Q_norm = q_normalize(Qs)
        dot_product = (Q_norm * q_target).sum(dim=-1).abs().clamp(0.0, 1.0)
        loss_rot = (1.0 - dot_product ** 2).mean()
        
        out["point/rotation"] = W.get("point_rotation", 1000.0) * loss_rot

    return out



@dataclass
class LossReport:
    total: torch.Tensor
    terms: Dict[str, torch.Tensor]

def compute_total_loss_frames(
    P: torch.Tensor,
    Q: torch.Tensor,
    constraints: List[Dict[str, Any]],
    subject_centers: Optional[Dict[str, torch.Tensor]] = None,
    image_h = 1800,
    image_w = 1800,
    subject_bbox_world = None,

) -> LossReport:
    device, dtype = P.device, P.dtype
    N = P.shape[0]

    terms: Dict[str, torch.Tensor] = {}

    def add_terms(d: Dict[str, torch.Tensor]):
        for k, v in d.items():
            if not torch.is_tensor(v):
                v = torch.tensor(v, device=device, dtype=dtype)
            terms[k] = terms.get(k, torch.zeros((), device=device, dtype=dtype)) + v

    for c in constraints:
        kind = c["kind"]
        losses = c.get("losses", [])

        if kind == "interval":
            t0 = int(c["t0"]); t1 = int(c["t1"])
            t0c, t1c = clamp_interval(t0, t1, N)
            if t1c <= t0c:
                continue

            
            if W["min_path_interval"] > 0:
                terms["minPath/interval"] = terms.get("minPath/interval", torch.zeros((), device=device, dtype=dtype)) \
                                            + W["min_path_interval"] * min_path_interval(P, t0c, t1c)

            for lf in losses:
                typ = lf["type"]

                
                if typ in (
                    "truckLeftMovement",
                    "truckRightMovement",
                    "dollyInMovement",
                    "dollyOutMovement",
                    "pedestalUpMovement",
                    "pedestalDownMovement",
                ):

                    axis_name, sign = TRANSLATION_MOVES[typ]

                    distance = lf.get("distance")
                    if distance is not None:
                        distance = float(distance)

                    
                    add_terms(
                        loss_translate_local_axis(
                            P=P,
                            Q=Q,
                            t0=t0c,
                            t1=t1c,
                            axis_name=axis_name,
                            sign=sign,
                            distance=distance,
                        )
                    )

                    w_rot = float(W.get("trans_keep_rot", 0.0))
                    if w_rot > 0:
                        terms[f"{typ}/keepRot"] = (
                            terms.get(
                                f"{typ}/keepRot",
                                torch.zeros((), device=device, dtype=dtype),
                            )
                            + w_rot * loss_keep_rotation(Q, t0c, t1c)
                        )

                
                elif typ in (
                    "panLeftMovement",
                    "panRightMovement",
                    "tiltUpMovement",
                    "tiltDownMovement",
                ):
                    angle = lf.get("angleDeg")
                    if angle is not None:
                        angle = float(angle)

                    add_terms(
                        loss_pan_tilt_framewise(
                            Q=Q,
                            t0=t0c,
                            t1=t1c,
                            move_type=typ,
                            angle=angle,
                        )
                    )

                    w_pos = float(W.get("rot_keep_trans", 0.0))
                    if w_pos > 0:
                        terms[f"{typ}/keepTrans"] = (
                            terms.get(
                                f"{typ}/keepTrans",
                                torch.zeros((), device=device, dtype=dtype),
                            )
                            + w_pos * loss_keep_translation(P, t0c, t1c)
                        )

                
                elif typ == "arcMovement":
                    if subject_centers is None:
                        continue
                    sid = lf.get("subjectId", c.get("subjectId", None))
                    
                    if sid is None:
                        continue
                    center = subject_centers[sid].detach()
                    radius = lf.get("radius", None)     
                    radius = None if radius is None else float(radius)
                    angle = lf.get("angleDeg", None)   
                    angle = None if angle is None else float(angle)
                    add_terms(loss_arc_framewise(P, Q, center, t0c, t1c, radius, angle, hold_y=True))
                elif typ in ("framingPosition", "shotSize", "subjectView"):
                    if subject_centers is None:
                        continue
                    sid = lf.get("subjectId", c.get("subjectId", None))
                    if sid is None:
                        continue
                    Ps = P[t0c:t1c+1]
                    Qs = Q[t0c:t1c+1]
                    Ss = subject_centers[sid][t0c:t1c+1]

                    if typ == "framingPosition":
                        add_terms(loss_framing_position_proxy(Ps, Qs, Ss))
                    elif typ == "shotSize":
                        shot = lf.get("shotSize", "mediumLongShot")
                        add_terms(loss_shot_size_distance(Ps, Ss, shot))
                    elif typ == "subjectView":
                        view = lf.get("view", "front")
                        add_terms(loss_subject_view_orientation(Ps, Qs, Ss, view))
                elif typ in ("static", "staticMovement"):
                        add_terms(loss_static_interval(P, Q, t0c, t1c))

                elif typ == "followMovement":
                    sid = lf.get("subjectId", c.get("subjectId"))
                    if sid is None or subject_centers is None or subject_bbox_world is None:
                        continue
                    Ps = P[t0c:t1c+1]
                    Qs = Q[t0c:t1c+1]
                    Ss = subject_centers[sid][t0c:t1c+1]
                    Bws = subject_bbox_world[sid][t0c:t1c+1] 
                    add_terms(loss_follow_interval(
                        P, Q, t0c, t1c, Ss, Bws,
                        image_w=image_w, image_h=image_h, fx=fx, fy=fy, cx=cx, cy=cy,
                        margin_px=lf.get("marginPx", 20.0),
                    ))

                elif typ == "trackMovement":
                    sid = lf.get("subjectId", c.get("subjectId"))
                    if sid is None or subject_centers is None or subject_bbox_world is None:
                        continue
                    Ss = subject_centers[sid][t0c:t1c+1]
                    Bws = subject_bbox_world[sid][t0c:t1c+1]
                    add_terms(loss_track_interval(
                        P, Q, t0c, t1c, Ss, Bws,
                        image_w=image_w, image_h=image_h, fx=fx, fy=fy, cx=cx, cy=cy,
                        margin_px=lf.get("marginPx", 20.0),
                    ))

                

        elif kind == "point":
            t = int(c["t"])
            if t < 0 or t >= N:
                continue

            if len(losses) == 0:
                t = c.get('t')
                position = c.get("position")
                rotation = c.get("quaternion")
                Ps = P[t:t+1]
                Qs = Q[t:t+1]
                add_terms(non_subject_aware_loss(Ps , Qs , position , rotation))
                

            for lf in losses:
                typ = lf["type"]
                if typ in ("framingPosition", "shotSize", "subjectView"):
                    if subject_centers is None:
                        continue
                    sid = lf.get("subjectId", c.get("subjectId", None))
                    if sid is None:
                        continue

                    Ps = P[t:t+1]
                    Qs = Q[t:t+1]
                    Ss = subject_centers[sid][t:t+1]

                    if typ == "framingPosition":
                        add_terms(loss_framing_position_proxy(Ps, Qs, Ss))
                    elif typ == "shotSize":
                        shot = lf.get("shotSize", "mediumLongShot")
                        add_terms(loss_shot_size_distance(Ps, Ss, shot))
                    elif typ == "subjectView":
                        view = lf.get("view", "front")
                        add_terms(loss_subject_view_orientation(Ps , Qs, Ss, view))

        else:
            raise ValueError(f"Unknown constraint kind: {kind}")

    total = torch.zeros((), device=device, dtype=dtype)
    
    for v in terms.values():
        total = total + v

    return LossReport(total=total, terms=terms)