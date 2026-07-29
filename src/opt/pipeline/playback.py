"""Validation and normalization for timeline playback-rate segments."""

from __future__ import annotations

from typing import Any, Iterable

from .trajectory import coerce_finite_number


PLAYBACK_RATE_LABELS = {
    "frozen",
    "verySlow",
    "slow",
    "normal",
    "fast",
    "veryFast",
}


def _parse_playback_segment(
    segment: dict[str, Any],
    source_index: int,
    duration_seconds: float,
) -> dict[str, Any]:
    start_time = coerce_finite_number(
        segment.get("startTimePlayback"),
        f"timeWarp[{source_index}].startTimePlayback",
    )
    end_time = coerce_finite_number(
        segment.get("endTimePlayback"),
        f"timeWarp[{source_index}].endTimePlayback",
    )
    playback_rate = coerce_finite_number(
        segment.get("rate"),
        f"timeWarp[{source_index}].rate",
    )
    label = segment.get("label")
    if label is not None and label not in PLAYBACK_RATE_LABELS:
        raise ValueError(
            f"timeWarp[{source_index}].label is not a supported rate label"
        )
    if start_time < 0 or end_time <= start_time or end_time > duration_seconds:
        raise ValueError(
            f"timeWarp[{source_index}] must fit inside "
            f"0..{duration_seconds} seconds"
        )
    if playback_rate < 0:
        raise ValueError(f"timeWarp[{source_index}].rate must be non-negative")
    if label == "frozen" and playback_rate != 0:
        raise ValueError(f"timeWarp[{source_index}] labeled frozen must have rate 0")
    return {
        "start": start_time,
        "end": end_time,
        "rate": playback_rate,
        "label": label,
        "sourceIndex": source_index,
    }


def _parse_unique_playback_segments(
    raw_segments: Iterable[dict[str, Any]],
    duration_seconds: float,
) -> list[dict[str, Any]]:
    parsed_segments: list[dict[str, Any]] = []
    seen_segment_keys: set[tuple[float, float, float, str | None]] = set()
    for source_index, segment in enumerate(raw_segments):
        parsed_segment = _parse_playback_segment(
            segment,
            source_index,
            duration_seconds,
        )
        segment_key = (
            parsed_segment["start"],
            parsed_segment["end"],
            parsed_segment["rate"],
            parsed_segment["label"],
        )
        if segment_key in seen_segment_keys:
            continue
        seen_segment_keys.add(segment_key)
        parsed_segments.append(parsed_segment)
    return parsed_segments


def _select_active_segment(
    parsed_segments: list[dict[str, Any]],
    interval_start: float,
    interval_end: float,
) -> dict[str, Any] | None:
    active_segments = [
        segment
        for segment in parsed_segments
        if segment["start"] <= interval_start and segment["end"] >= interval_end
    ]
    if not active_segments:
        return None

    # Legacy solver files contain normal-speed bands on top of an explicit
    # slow/fast band. Prefer the explicit non-normal rate, with later source
    # entries winning any remaining ambiguity.
    non_normal_segments = [
        segment for segment in active_segments if segment["rate"] != 1.0
    ]
    return max(
        non_normal_segments or active_segments,
        key=lambda segment: segment["sourceIndex"],
    )


def _append_or_merge_segment(
    normalized_segments: list[dict[str, Any]],
    selected_segment: dict[str, Any],
    interval_start: float,
    interval_end: float,
) -> None:
    normalized_segment = {
        "startTime": interval_start,
        "endTime": interval_end,
        "rate": selected_segment["rate"],
    }
    if selected_segment["label"] is not None:
        normalized_segment["label"] = selected_segment["label"]

    if (
        normalized_segments
        and normalized_segments[-1]["endTime"] == interval_start
        and normalized_segments[-1]["rate"] == normalized_segment["rate"]
        and normalized_segments[-1].get("label") == normalized_segment.get("label")
    ):
        normalized_segments[-1]["endTime"] = interval_end
    else:
        normalized_segments.append(normalized_segment)


def normalize_playback_segments(
    raw_segments: Iterable[dict[str, Any]],
    duration_seconds: float,
) -> list[dict[str, Any]]:
    """Produce ordered, non-overlapping rate bands from solver time-warp data."""
    parsed_segments = _parse_unique_playback_segments(
        raw_segments,
        duration_seconds,
    )
    if not parsed_segments:
        return []

    boundaries = sorted(
        {
            boundary
            for segment in parsed_segments
            for boundary in (segment["start"], segment["end"])
        }
    )
    normalized_segments: list[dict[str, Any]] = []
    for interval_start, interval_end in zip(boundaries, boundaries[1:]):
        selected_segment = _select_active_segment(
            parsed_segments,
            interval_start,
            interval_end,
        )
        if selected_segment is None:
            continue
        _append_or_merge_segment(
            normalized_segments,
            selected_segment,
            interval_start,
            interval_end,
        )
    return normalized_segments
