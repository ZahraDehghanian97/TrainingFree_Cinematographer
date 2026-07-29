"""Shared loss weights and constraint lookup tables.

The dictionaries in this module are intentionally mutable, so callers can tune
``LOSS_WEIGHTS`` in place while every loss module shares the same objects.
"""

LOSS_WEIGHTS = {
    "trans_keep_rot": 5000,
    "rot_keep_trans": 5000,
    "truck_target": 2000,
    "dolly_target": 2000,
    "pedestal_target": 2000,
    # translation motion when magnitude missing
    "move_dir": 1000,
    "move_progress": 3000,
    "move_progress_tau": 0.025,
    # Drift penalties
    "orth_drift": 1000.0,
    # Rotation motion when angle provided
    "pan_target": 500.0,
    "tilt_target": 500.0,
    # Rotation motion when angle missing
    "rot_dir": 2000,
    "rot_progress": 200,
    "rot_progress_tau_deg": 0.08,
    # Arc
    "arc_radius_target": 10000.0,
    "arc_radius_const": 10000.0,
    "arc_angle_target": 5000.0,
    "arc_angle_uniform": 1000.0,
    "arc_angle_dir": 2000.0,
    "arc_angle_progress_spec": 1000.0,
    "arc_angle_progress_margin_deg": 500.0,
    "arc_angle_step_cap": 50,
    "arc_angle_step_cap_mult": 250,
    "arc_angle_step_cap_min_deg": 600,
    "arc_plane_fit": 1000,
    "arc_plane_step": 0.1,
    "arc_plane_detach_normal": 1.0,
    "arc_angle_tau_deg": 30,
    "arc_lookat": 2000,
    "arc_y_hold": 0,
    # follow/track
    "follow_keep_trans": 500,
    "follow_lookat": 20,
    "track_keep_distance": 200,
    "track_lookat": 20,
    "inframe_left": 50,
    "inframe_righ": 50,
    "inframe_top": 50,
    "inframe_buttom": 50,
    "inframe_depth": 200,
    # Subject-aware framing / view / shot
    "lookat": 80,
    "framing_ray": 100,
    "shot_distance": 500,
    "subject_view": 300,
    "subject_view_orient": 30,
    # MinPath per-interval
    "min_path_interval": 100,
    "point_position": 1000.0,
    "point_rotation": 1000.0,
}

SHOT_DISTANCE_BY_SIZE = {
    "extremeCloseUp": 1.2,
    "closeUp": 1.6,
    "mediumCloseUp": 2.2,
    "mediumShot": 3.0,
    "mediumLongShot": 4.0,
    "fullShot": 5.0,
    "longShot": 7.0,
    "veryLongShot": 9.0,
    "extremeLongShot": 12.0,
}

VIEW_AZIMUTH_DEGREES = {
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
