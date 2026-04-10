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