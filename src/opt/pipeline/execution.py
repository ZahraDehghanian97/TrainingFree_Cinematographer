"""Execution and publication helpers for the optimizer pipeline."""

from __future__ import annotations

from pathlib import Path
from typing import Any
from typing import Any, Dict, List, Tuple


def build_placeholder_subject_data(torch_module, frame_count: int):
    """Build the temporary subject channel used until tracking is connected."""
    subject_centers = {
        "C0": torch_module.zeros(
            (frame_count, 3),
            dtype=torch_module.float64,
        )
    }
    subject_tracks = {
        "C0": [
            {
                "bbox": {
                    "x1": 800,
                    "y1": 800,
                    "x2": 1000,
                    "y2": 1000,
                },
                "center3d": [0.0, 0.0, 0.0],
            }
            for _ in range(frame_count)
        ]
    }
    return subject_centers, subject_tracks


"""Subject extraction helper from environment definitions."""

try:
    from ..subject_ids import (
        canonical_subject_id,
        is_compound_subject_id,
        split_subject_id,
    )
    from .playback import normalize_playback_segments
except ImportError:
    from subject_ids import (
        canonical_subject_id,
        is_compound_subject_id,
        split_subject_id,
    )
    from pipeline.playback import normalize_playback_segments


PLACEHOLDER_BBOX = {"x1": 800, "y1": 800, "x2": 1000, "y2": 1000}


def _build_scene_time_lookup(
    raw_timewarp_segments: list[dict[str, Any]] | None,
    duration_seconds: float,
):
    """Build a playback_time -> scene_time mapping from timeWarp segments.

    Before this existed, timeWarp was ONLY consumed by
    trajectory_pipeline.py to attach display metadata to the final exported
    trajectory — the VIEWER would correctly slow down or freeze playback,
    but every subject position used DURING OPTIMIZATION was resolved with
    raw, un-warped playback time (frame_idx * dt straight into keyframe
    interpolation). For a "freeze time, orbit, then resume" shot, that
    meant the optimizer was shaping the camera around a subject it believed
    was continuously moving through the frozen window, while the viewer
    would go on to render that exact window with the subject held still —
    two different ideas of where the subject was, for the same frames.

    Returns a callable: scene_time_lookup(playback_time) -> scene_time.
    Any playback-time span not covered by an explicit timeWarp segment
    defaults to rate=1 (normal speed) — matches the implicit unwarped
    behavior for timelines that don't declare a rate for some span, rather
    than leaving a gap.
    """
    normalized_segments = normalize_playback_segments(
        raw_timewarp_segments or [],
        duration_seconds,
    )
    if not normalized_segments:
        return None  # no timeWarp at all: caller keeps using raw time as-is

    # Gap-fill so the band list covers [0, duration_seconds] with no holes,
    # defaulting any uncovered span to rate=1 (normal speed).
    bands: list[dict[str, float]] = []
    cursor = 0.0
    for segment in normalized_segments:
        if segment["startTime"] > cursor:
            bands.append(
                {"startTime": cursor, "endTime": segment["startTime"], "rate": 1.0}
            )
        bands.append(
            {
                "startTime": segment["startTime"],
                "endTime": segment["endTime"],
                "rate": float(segment["rate"]),
            }
        )
        cursor = segment["endTime"]
    if cursor < duration_seconds:
        bands.append({"startTime": cursor, "endTime": duration_seconds, "rate": 1.0})

    # Cumulative scene-time at each band boundary — scene_time_at() below
    # only needs to find which band a query falls in and add the partial
    # progress through that one band.
    cumulative_scene_time = [0.0]
    for band in bands:
        span = band["endTime"] - band["startTime"]
        cumulative_scene_time.append(
            cumulative_scene_time[-1] + band["rate"] * span
        )

    def scene_time_at(playback_time: float) -> float:
        clamped_time = min(max(playback_time, 0.0), duration_seconds)
        for band_index, band in enumerate(bands):
            if band["startTime"] <= clamped_time <= band["endTime"]:
                progress_into_band = clamped_time - band["startTime"]
                return (
                    cumulative_scene_time[band_index]
                    + band["rate"] * progress_into_band
                )
        return cumulative_scene_time[-1]  # unreachable given clamp + full coverage

    return scene_time_at


def _interpolate_position_keyframes(
    keyframes: list[dict[str, Any]],
    time: float,
) -> list[float]:
    """Linearly interpolate 3D position keyframes with hold extrapolation."""
    if not keyframes:
        return [0.0, 0.0, 0.0]

    # Extrapolation: hold edge values
    if time <= keyframes[0]["t"]:
        return [float(v) for v in keyframes[0]["value"]]
    if time >= keyframes[-1]["t"]:
        return [float(v) for v in keyframes[-1]["value"]]

    # Piecewise linear interpolation
    for k1, k2 in zip(keyframes[:-1], keyframes[1:]):
        t1, t2 = float(k1["t"]), float(k2["t"])
        if t1 <= time <= t2:
            alpha = (time - t1) / (t2 - t1 + 1e-12)
            v1, v2 = k1["value"], k2["value"]
            return [
                float(v1[i]) + alpha * (float(v2[i]) - float(v1[i]))
                for i in range(3)
            ]

    return [float(v) for v in keyframes[-1]["value"]]


def _resolve_raw_position_series(
    position_data: Any,
    frame_count: int,
    dt: float,
    scene_time_lookup=None,
) -> list[list[float]]:
    """Per-frame entity-origin world position — NOT anchor-adjusted.

    Kept separate from the anchor-adjusted "center" used for framing/lookat
    targets, because a target's localBounds (used for compound-subject
    union boxes below) is defined relative to the entity's own origin, not
    relative to its localAnchor — the anchor is just a representative
    tracking point, distinct from the shape's actual extent.

    ``scene_time_lookup``, when given, maps each frame's raw playback time
    through the timeline's timeWarp bands before indexing into the
    entity's keyframes — see _build_scene_time_lookup. Omitted entirely
    when the timeline has no timeWarp, in which case scene time IS
    playback time and nothing changes from before.
    """
    if isinstance(position_data, list) and len(position_data) == 3:
        static_pos = [float(component) for component in position_data]
        return [static_pos for _ in range(frame_count)]

    if isinstance(position_data, dict):
        keyframes = position_data.get("keyframes", [])
        if keyframes:
            results = []
            for frame_idx in range(frame_count):
                playback_time = frame_idx * dt
                scene_time = (
                    scene_time_lookup(playback_time)
                    if scene_time_lookup is not None
                    else playback_time
                )
                results.append(
                    _interpolate_position_keyframes(keyframes, scene_time)
                )
            return results

    return []


def _resolve_world_bounds_series(
    raw_positions: list[list[float]],
    local_bounds: dict[str, Any] | None,
) -> tuple[list[list[float]], list[list[float]]] | None:
    """Per-frame world-space (min, max) AABB corners for a target.

    Returns None when the target has no usable localBounds — callers fall
    back to treating the target as a zero-size point (min == max == its
    anchor-adjusted center) rather than failing outright, so a target
    that's missing bounds data can still participate in a compound union,
    just without contributing any extent of its own.
    """
    if not local_bounds or local_bounds.get("type") != "box":
        return None
    box_min = local_bounds.get("min")
    box_max = local_bounds.get("max")
    if not (isinstance(box_min, list) and isinstance(box_max, list)):
        return None

    world_min = [
        [raw[i] + float(box_min[i]) for i in range(3)] for raw in raw_positions
    ]
    world_max = [
        [raw[i] + float(box_max[i]) for i in range(3)] for raw in raw_positions
    ]
    return world_min, world_max


def _referenced_compound_subject_ids(
    constraints: list[dict[str, Any]] | None,
    known_subject_ids: set[str] | None = None,
) -> set[str]:
    """Collect every compound subjectId actually used across constraints."""
    referenced: set[str] = set()
    known_subject_ids = known_subject_ids or set()
    if not constraints:
        return referenced
    for constraint in constraints:
        for loss_spec in constraint.get("losses", []):
            subject_id = loss_spec.get("subjectId")
            if (
                isinstance(subject_id, str)
                and subject_id not in known_subject_ids
                and is_compound_subject_id(subject_id)
            ):
                referenced.add(subject_id)
    return referenced


def _synthesize_compound_subjects(
    compound_ids: set[str],
    subject_centers: dict[str, Any],
    subject_world_bounds: dict[str, tuple[list[list[float]], list[list[float]]]],
    subject_tracks: dict[str, Any],
    frame_count: int,
    torch_module: Any,
) -> None:
    """Add a union-box center (and placeholder track) entry per compound id.

    The union is a real per-frame AABB union of the constituents' world
    bounds — not an average of their centers — so e.g. a compound of a
    small nearby object and a large distant one gets a center genuinely
    between their extents, not skewed toward whichever center happens to
    sit closer to the camera. A constituent with no bounds data (see
    _resolve_world_bounds_series) degrades to a zero-size point at its own
    center rather than being dropped, so the union still forms.
    """
    for compound_id in compound_ids:
        constituent_ids = split_subject_id(compound_id)
        missing_ids = [
            constituent_id
            for constituent_id in constituent_ids
            if constituent_id not in subject_centers
        ]
        if missing_ids:
            raise ValueError(
                f"subjectIds {missing_ids} referenced in the timeline have no "
                f"matching environment target id (compound id: {compound_id!r})"
            )

        union_min: list[list[float]] | None = None
        union_max: list[list[float]] | None = None
        for constituent_id in constituent_ids:
            bounds = subject_world_bounds.get(constituent_id)
            if bounds is None:
                # No localBounds for this target: treat as a zero-size
                # point at its already-resolved (anchor-adjusted) center.
                point = subject_centers[constituent_id].tolist()
                constituent_min, constituent_max = point, point
            else:
                constituent_min, constituent_max = bounds

            if union_min is None:
                union_min, union_max = constituent_min, constituent_max
            else:
                union_min = [
                    [min(union_min[f][i], constituent_min[f][i]) for i in range(3)]
                    for f in range(frame_count)
                ]
                union_max = [
                    [max(union_max[f][i], constituent_max[f][i]) for i in range(3)]
                    for f in range(frame_count)
                ]

        union_center = [
            [(union_min[f][i] + union_max[f][i]) / 2.0 for i in range(3)]
            for f in range(frame_count)
        ]
        subject_centers[compound_id] = torch_module.tensor(
            union_center, dtype=torch_module.float32
        )
        subject_tracks[compound_id] = [
            {"bbox": dict(PLACEHOLDER_BBOX), "center3d": union_center[f]}
            for f in range(frame_count)
        ]


def build_subject_data_from_environment(
    environment_json: dict[str, Any] | None,
    frame_count: int,
    fps: float,
    torch_module: Any,
    constraints: list[dict[str, Any]] | None = None,
    timewarp_segments: list[dict[str, Any]] | None = None,
    duration_seconds: float | None = None,
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Extract 3D subject centers from environment definitions.

    Maps primary target to 'C0' to support DSL inputs lacking explicit
    subjectIDs, while also indexing targets/entities by their environment
    IDs. When ``constraints`` references a compound subjectId (see
    subject_ids.py — a DSL loss with multiple "subjectIds"), a union entry
    for it is synthesized here from its constituents' real world bounds.

    ``timewarp_segments`` (the timeline's raw ``timeWarp`` array) and
    ``duration_seconds`` together let keyframed entity positions be
    resolved in SCENE time rather than raw playback time — see
    _build_scene_time_lookup. Without both, a "freeze time, orbit, then
    resume" timeline would have the optimizer track a subject that's
    silently still moving during what's meant to be a frozen window, even
    though the viewer (which DOES apply timeWarp, via
    trajectory_pipeline.py's playback metadata) would render it held
    still — the two disagreeing about where the subject actually is for
    the same frames. Omit either to fall back to raw playback time exactly
    as before (e.g. for timelines with no timeWarp at all).
    """
    if not environment_json:
        return build_placeholder_subject_data(torch_module, frame_count)

    entities = {
        e["id"]: e
        for e in environment_json.get("entities", [])
        if isinstance(e, dict)
    }
    targets = environment_json.get("targets", [])
    dt = 1.0 / fps

    scene_time_lookup = None
    if timewarp_segments is not None and duration_seconds is not None:
        scene_time_lookup = _build_scene_time_lookup(
            timewarp_segments,
            float(duration_seconds),
        )

    subject_centers: dict[str, Any] = {}
    subject_tracks: dict[str, Any] = {}
    subject_world_bounds: dict[str, tuple[list[list[float]], list[list[float]]]] = {}

    def _resolve_position_series(position_data: Any, local_anchor: list[float]) -> list[list[float]]:
        anchor = [float(local_anchor[0]), float(local_anchor[1]), float(local_anchor[2])]
        raw_positions = _resolve_raw_position_series(
            position_data, frame_count, dt, scene_time_lookup
        )
        return [
            [raw[i] + anchor[i] for i in range(3)]
            for raw in raw_positions
        ]

    # 1. Extract position data for targets in environment_json
    for idx, target in enumerate(targets):
        target_id = target.get("id")
        entity_id = target.get("entityId", "")
        local_anchor = target.get("localAnchor", [0.0, 0.95, 0.0])
        entity = entities.get(entity_id, {})
        position_data = entity.get("transform", {}).get("position", [0.0, 0.0, 0.0])

        raw_positions = _resolve_raw_position_series(
            position_data, frame_count, dt, scene_time_lookup
        )
        if not raw_positions:
            continue
        anchor = [float(local_anchor[i]) for i in range(3)]
        centers_list = [
            [raw[i] + anchor[i] for i in range(3)] for raw in raw_positions
        ]

        centers_tensor = torch_module.tensor(centers_list, dtype=torch_module.float32)

        # Assign primary target (targets[0]) to 'C0' so DSL losses without subjectIDs find it
        if idx == 0:
            subject_centers["C0"] = centers_tensor

        if target_id:
            subject_centers[target_id] = centers_tensor

            world_bounds = _resolve_world_bounds_series(
                raw_positions,
                target.get("localBounds"),
            )
            if world_bounds is not None:
                subject_world_bounds[target_id] = world_bounds

        track_entries = [
            {
                "bbox": dict(PLACEHOLDER_BBOX),
                "center3d": centers_list[i],
            }
            for i in range(frame_count)
        ]
        subject_tracks[target_id or f"target_{idx}"] = track_entries
        if idx == 0:
            # Preserve the legacy alias without dropping the real semantic ID.
            subject_tracks["C0"] = track_entries

    # 2. Extract entity positions directly if targets list was empty
    if not subject_centers and entities:
        for entity_id, entity in entities.items():
            position_data = entity.get("transform", {}).get("position", [0.0, 0.0, 0.0])
            centers_list = _resolve_position_series(position_data, [0.0, 0.0, 0.0])
            if centers_list:
                centers_tensor = torch_module.tensor(centers_list, dtype=torch_module.float32)
                subject_centers[entity_id] = centers_tensor
                if "C0" not in subject_centers:
                    subject_centers["C0"] = centers_tensor

    if not subject_centers:
        return build_placeholder_subject_data(torch_module, frame_count)

    compound_ids = _referenced_compound_subject_ids(
        constraints,
        set(subject_centers),
    )
    if compound_ids:
        _synthesize_compound_subjects(
            compound_ids,
            subject_centers,
            subject_world_bounds,
            subject_tracks,
            frame_count,
            torch_module,
        )

    return subject_centers, subject_tracks

def build_optimizer_options(
    optimizer_constraints: list[dict[str, Any]],
    pipeline_metadata: dict[str, Any],
    subject_centers,
    subject_tracks,
    max_iterations: int | None,
) -> dict[str, Any]:
    """Translate pipeline metadata into optimizer keyword arguments."""
    optimize_options: dict[str, Any] = {
        "constraints": optimizer_constraints,
        "duration_seconds": pipeline_metadata["durationSeconds"],
        "frames_per_second": pipeline_metadata["fps"],
        "subject_centers": subject_centers,
        "subject_tracks": subject_tracks,
    }
    if max_iterations is not None:
        optimize_options["max_iterations"] = max_iterations
    return optimize_options


def publish_trajectory_documents(
    *,
    timeline_path: Path,
    pipeline_metadata: dict[str, Any],
    debug_document: dict[str, Any],
    trajectory_document: dict[str, Any],
    resolve_paths,
    write_json,
    debug_output: Path | None,
    trajectory_output: Path | None,
) -> dict[str, Path | None]:
    """Resolve destinations and publish debug, archive, and viewer documents."""
    debug_path, archive_path, viewer_path = resolve_paths(
        timeline_path,
        pipeline_metadata["exampleId"],
        debug_output=debug_output,
        trajectory_output=trajectory_output,
    )
    write_json(debug_path, debug_document)
    write_json(archive_path, trajectory_document)
    if viewer_path is not None and viewer_path.resolve() != archive_path.resolve():
        write_json(viewer_path, trajectory_document)
    return {
        "debug": debug_path,
        "archive": archive_path,
        "viewer": viewer_path,
    }
