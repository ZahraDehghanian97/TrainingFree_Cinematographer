import numpy as np
import torch

from timebase import seconds_to_frame_index


TRANSLATION_MOVES = {
    "truckLeftMovement":  ("right", -1),
    "truckRightMovement": ("right", +1),

    "dollyInMovement":    ("forward", +1),
    "dollyOutMovement":   ("forward", -1),

    "pedestalUpMovement":   ("up", +1),
    "pedestalDownMovement": ("up", -1),
}

ROTATION_MOVES = {
    "panLeftMovement":  ("yaw",  +1),
    "panRightMovement": ("yaw",  -1),

    "tiltUpMovement":   ("pitch", +1),
    "tiltDownMovement": ("pitch", -1),
}

def q_normalize(q, eps=1e-9):
    q = np.asarray(q, dtype=float)
    return q / (np.linalg.norm(q) + eps)

def q_mul(a, b):
    aw, ax, ay, az = a
    bw, bx, by, bz = b
    return np.array([
        aw*bw - ax*bx - ay*by - az*bz,
        aw*bx + ax*bw + ay*bz - az*by,
        aw*by - ax*bz + ay*bw + az*bx,
        aw*bz + ax*by - ay*bx + az*bw
    ], dtype=float)

def q_conj(q):
    return np.array([q[0], -q[1], -q[2], -q[3]], dtype=float)

def q_rotate(q, v):
   
    qv = np.array([0.0, v[0], v[1], v[2]])
    return q_mul(q_mul(q, qv), q_conj(q))[1:]

def q_from_axis_angle(axis, angle_rad):
    axis = np.asarray(axis, dtype=float)
    axis = axis / (np.linalg.norm(axis) + 1e-9)
    s = np.sin(angle_rad / 2.0)
    return q_normalize(np.array([np.cos(angle_rad/2.0), axis[0]*s, axis[1]*s, axis[2]*s]))

def look_at_quat(cam_pos, target_pos, world_up=np.array([0,1,0], dtype=float)):
    f = np.asarray(target_pos - cam_pos, dtype=float)
    fn = np.linalg.norm(f)
    if fn < 1e-9:
        return np.array([1,0,0,0], dtype=float)
    f = f / fn

    up = world_up / (np.linalg.norm(world_up) + 1e-9)
    r = np.cross(up, f)
    rn = np.linalg.norm(r)
    if rn < 1e-9:
       
        r = np.array([1,0,0], dtype=float)
    else:
        r = r / rn
    u = np.cross(f, r)
    R = np.stack([r, u, f], axis=1)
    tr = np.trace(R)
    if tr > 0:
        S = np.sqrt(tr + 1.0) * 2
        w = 0.25 * S
        x = (R[2,1] - R[1,2]) / S
        y = (R[0,2] - R[2,0]) / S
        z = (R[1,0] - R[0,1]) / S
    else:
        if R[0,0] > R[1,1] and R[0,0] > R[2,2]:
            S = np.sqrt(1.0 + R[0,0] - R[1,1] - R[2,2]) * 2
            w = (R[2,1] - R[1,2]) / S
            x = 0.25 * S
            y = (R[0,1] + R[1,0]) / S
            z = (R[0,2] + R[2,0]) / S
        elif R[1,1] > R[2,2]:
            S = np.sqrt(1.0 + R[1,1] - R[0,0] - R[2,2]) * 2
            w = (R[0,2] - R[2,0]) / S
            x = (R[0,1] + R[1,0]) / S
            y = 0.25 * S
            z = (R[1,2] + R[2,1]) / S
        else:
            S = np.sqrt(1.0 + R[2,2] - R[0,0] - R[1,1]) * 2
            w = (R[1,0] - R[0,1]) / S
            x = (R[0,2] + R[2,0]) / S
            y = (R[1,2] + R[2,1]) / S
            z = 0.25 * S

    return q_normalize(np.array([w,x,y,z], dtype=float))

def slerp(q0, q1, u):
    q0 = q_normalize(q0); q1 = q_normalize(q1)
    dot = float(np.dot(q0, q1))
    if dot < 0.0:
        q1 = -q1
        dot = -dot
    dot = np.clip(dot, -1.0, 1.0)
    if dot > 0.9995:
        return q_normalize((1-u)*q0 + u*q1)
    omega = np.arccos(dot)
    so = np.sin(omega)
    return q_normalize(np.sin((1-u)*omega)/so * q0 + np.sin(u*omega)/so * q1)
SHOT_H_FRAC = {
    "extremeCloseUp": 0.80,
    "closeUp":        0.60,
    "mediumCloseUp":  0.45,
    "mediumShot":     0.35,
    "mediumLongShot": 0.25,
    "fullShot":       0.18,
    "longShot":       0.12,
    "veryLongShot":   0.08,
    "extremeLongShot":0.05,
}

VIEW_YAW_DEG = {
    "front": 0.0,
    "threeQuarterFrontLeft":  45.0,
    "threeQuarterFrontRight": -45.0,
    "left":  90.0,
    "right": -90.0,
    "threeQuarterBackLeft":  135.0,
    "threeQuarterBackRight": -135.0,
    "back": 180.0,
}

def bbox_center(b):
    return np.array([(b["x1"]+b["x2"])/2.0, (b["y1"]+b["y2"])/2.0], dtype=float)

def bbox_height_frac(b, image_h):
    return float((b["y2"] - b["y1"]) / max(image_h, 1.0))

def estimate_camera_distance_from_shot(bbox, shot_size, image_h, base_dist=4.0):
    target = SHOT_H_FRAC.get(shot_size, 0.25)
    h = bbox_height_frac(bbox, image_h)
    h = max(h, 1e-3)
    scale = h / target
    return base_dist * scale

def estimate_subject_world_center(subject_track, frame_idx):
    
    
    info = subject_track[frame_idx]
    if "center3d" in info:
        return np.array(info["center3d"], dtype=float)
    
    c2 = bbox_center(info["bbox"])
    return np.array([c2[0], 0.0, c2[1]], dtype=float)


def merge_control_point(existing, new, mode="blend", w_new=0.7):
    
    if existing is None:
        return new
    if mode == "override":
        return new

    p = (1-w_new)*existing["p"] + w_new*new["p"]
    q = slerp(existing["q"], new["q"], w_new)
    out = dict(existing)
    out["p"] = p
    out["q"] = q
    return out


def initialize_control_points(
    constraints,
    subject_tracks,
    image_w, image_h,
    subject_centers=None,
    default_k=4,
    default_radius=4.0,
    default_move_dist=1.0,
    time_mode="frame",   
    total_frames=None,
    total_duration=None,
):
    
    cp_map = {}  

    def to_tau(t):
        return float(t)

    def to_frame_index(t):
        if total_frames is None:
            raise ValueError("total_frames is required for subject-aware initialization")
        if time_mode == "frame":
            index = int(round(float(t)))
        elif time_mode == "seconds":
            if total_duration is None:
                raise ValueError("total_duration is required when time_mode='seconds'")
            index = seconds_to_frame_index(t, total_duration, total_frames)
        elif time_mode == "normalized":
            index = int(round(float(t) * (total_frames - 1)))
        else:
            raise ValueError(f"Unknown time_mode: {time_mode}")
        return min(max(index, 0), total_frames - 1)

    def insert_cp(t, p, q, hard=False):
        t = to_tau(t)
        new = {"t": t, "p": np.asarray(p, float), "q": np.array(q_normalize((q)))}
        mode = "override" if hard else "blend"
        cp_map[t] = merge_control_point(cp_map.get(t), new, mode=mode)

    
    def get_last_cp_before(t):
        t = to_tau(t)
        keys = [k for k in cp_map.keys() if k <= t]
        if not keys:
            return None
        return cp_map[max(keys)]

    
    for c in constraints:
        kind = c["kind"]
        losses = c.get("losses", [])

        if kind == "point":
            t = c["t"]
            

            subj_id = c.get("subjectId", None)
            if subj_id is None:
                subj_id = next(
                    (
                        loss.get("subjectId")
                        for loss in losses
                        if loss.get("subjectId") is not None
                    ),
                    None,
                )
            if subj_id is None:
                
                p = np.array(c["position"], float)
                q = np.array(c["quaternion"], float)
                insert_cp(t, p, q, hard=True)
                insert_cp(t, p, q, hard=True)
                insert_cp(t, p, q, hard=True)
                continue

            
            frame_idx = to_frame_index(t)
            track = subject_tracks[subj_id]
            subj_center = estimate_subject_world_center(track, frame_idx)

            
            shot_size = None
            view = "front"
            flag_keyframe = False

            for lf in losses:
                if lf["type"] == "NonSubjectAware":
                    insert_cp(t, np.array(lf['p']), np.array(lf['q']), hard=True)
                    insert_cp(t, np.array(lf['p']), np.array(lf['q']), hard=True)
                    insert_cp(t, np.array(lf['p']), np.array(lf['q']), hard=True)
                
                if lf["type"] == "shotSize":
                    shot_size = lf.get("shotSize")
                if lf["type"] == "subjectView":
                    view = lf.get("view", view)

            
            bbox = track[frame_idx]["bbox"]
            dist = estimate_camera_distance_from_shot(bbox, shot_size or "mediumLongShot", image_h)

            yaw = np.deg2rad(VIEW_YAW_DEG.get(view, 0.0))
            
            offset = np.array([np.sin(yaw)*dist, 0.0, -np.cos(yaw)*dist], float)
            cam_pos = subj_center + offset
            cam_q = look_at_quat(cam_pos, subj_center)

            insert_cp(t, cam_pos, cam_q, hard=False)
            insert_cp(t, cam_pos, cam_q, hard=False)
            insert_cp(t, cam_pos, cam_q, hard=False)
        elif kind == "interval":
            t0, t1 = c["t0"], c["t1"]
            start_cp = get_last_cp_before(t0)
            if start_cp is None:
                start_cp = {"t": to_tau(t0), "p": np.array([0,0,0], float), "q": np.array([1,0,0,0], float)}
                insert_cp(t0, start_cp["p"], start_cp["q"], hard=False)

            motion_types = {
                "arcMovement",

                "truckLeftMovement",
                "truckRightMovement",

                "dollyInMovement",
                "dollyOutMovement",

                "pedestalUpMovement",
                "pedestalDownMovement",

                "panLeftMovement",
                "panRightMovement",

                "tiltUpMovement",
                "tiltDownMovement",
            }

            motion = [
                lf
                for lf in losses
                if lf["type"] in motion_types
            ]

            if len(motion) == 0:
                k = c.get("k", default_k)
                ts = np.linspace(to_tau(t0), to_tau(t1), k)
                for tt in ts:
                    # just hold last pose
                    insert_cp(tt, start_cp["p"], start_cp["q"], hard=False)
                continue
            generated = [{"t": to_tau(t0), "p": start_cp["p"].copy(), "q": start_cp["q"].copy()}]

            for lf in motion:
                typ = lf["type"]


                if typ == "arcMovement":
                    subj_id = lf["subjectId"]
                    radius = float(lf.get("radius", default_radius))
                    angle_deg = float(lf.get("angleDeg", 90.0))
                    angle_rad = np.deg2rad(angle_deg)
                    quarters = max(1, int(np.ceil(abs(angle_deg) / 90.0)))
                    pts_per_quarter = 3
                    npts = quarters * pts_per_quarter + 1 
                    ts = np.linspace(to_tau(t0), to_tau(t1), npts)
                    mid = (to_tau(t0) + to_tau(t1)) / 2.0
                    mid_frame = to_frame_index(mid)
                    # Use real subject centers if available; otherwise use the dummy origin.
                    if subject_centers is not None and subj_id in subject_centers:
                        center = np.asarray(subject_centers[subj_id][mid_frame], dtype=float)
                    else:
                        center = np.zeros(3, dtype=float)
                    p0 = generated[-1]["p"]
                    v0 = p0 - center
                    v0_xy = np.array([v0[0], v0[1]], float) 
                    if np.linalg.norm(v0_xy) < 1e-6:
                        start_ang = 0.0
                    else:
                        start_ang = np.arctan2(v0_xy[1], v0_xy[0])
                    for i, tt in enumerate(ts):
                        u = i / (len(ts)-1)
                        ang = start_ang + u * angle_rad
                        z_const = p0[2]

                        cam_pos = np.array([
                            center[0] + np.cos(ang) * radius,
                            center[1] + np.sin(ang) * radius,
                            z_const
                        ], dtype=float)
                        cam_q = look_at_quat(cam_pos, center)
                        generated.append({"t": tt, "p": cam_pos, "q": cam_q})

                elif typ in TRANSLATION_MOVES:

                    dist = float(lf.get("distance", default_move_dist))

                    k = c.get("k", default_k)
                    ts = np.linspace(to_tau(t0), to_tau(t1), k)

                    q0 = generated[-1]["q"]
                    p0 = generated[-1]["p"]

                    right = q_rotate(q0, np.array([1,0,0], float))
                    up = q_rotate(q0, np.array([0,1,0], float))
                    forward = q_rotate(q0, np.array([0,0,1], float))

                    axis_name, sign = TRANSLATION_MOVES[typ]

                    axis = {
                        "right": right,
                        "up": up,
                        "forward": forward,
                    }[axis_name]

                    for i, tt in enumerate(ts):
                        u = i / (len(ts)-1)
                        generated.append({
                            "t": tt,
                            "p": p0 + sign * u * dist * axis,
                            "q": q0,
                        })


                elif typ in ROTATION_MOVES:

                    angle = np.deg2rad(float(lf.get("angleDeg", 30.0)))

                    k = c.get("k", default_k)
                    ts = np.linspace(to_tau(t0), to_tau(t1), k)

                    p0 = generated[-1]["p"]
                    q0 = generated[-1]["q"]

                    axis_type, sign = ROTATION_MOVES[typ]

                    if axis_type == "yaw":
                        local_axis = np.array([0,1,0], float)
                    else:
                        local_axis = np.array([1,0,0], float)

                    axis_world = q_rotate(q0, local_axis)

                    for i, tt in enumerate(ts):
                        u = i / (len(ts)-1)

                        dq = q_from_axis_angle(
                            axis_world,
                            sign * u * angle
                        )

                        generated.append({
                            "t": tt,
                            "p": p0,
                            "q": q_mul(dq, q0),
                        })
            for g in generated:
                insert_cp(g["t"], g["p"], g["q"], hard=False)

        else:
            raise ValueError(f"Unknown constraint kind: {kind}")
    cps = [cp_map[k] for k in sorted(cp_map.keys())]
    return cps
