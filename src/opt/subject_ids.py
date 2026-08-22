"""Shared convention for compound (multi-target) subject ids.

A single loss's ``subjectId`` is always one string — every lookup in
``losses/dispatcher.py`` is a plain ``subject_centers[subject_id]`` dict
index, and that's staying true; nothing there needs to know a subject can
be a group. What changes is what string a "this loss covers multiple
targets" reference collapses to, and this module is the one place that
encoding is defined, so ``Timeline_adapter.py`` (which builds that string
from a DSL-provided ``subjectIds`` list) and ``pipeline/execution.py``
(which has to recognize that string and synthesize the group's actual
world data) can't quietly disagree about the format.
"""

from __future__ import annotations

import json

COMPOUND_SUBJECT_ID_PREFIX = "__subject_group__:"
LEGACY_SUBJECT_ID_SEPARATOR = "+"


def canonical_subject_id(subject_ids) -> str:
    """Collapse an ordered/unordered iterable of subject ids into one key.

    Deduplicated and sorted so the same set of subjects always produces the
    same compound id regardless of the order they were listed in the DSL —
    ["monitor", "vase"] and ["vase", "monitor"] must resolve to the same
    synthesized entry rather than silently creating two.
    """
    unique_sorted_ids = sorted({str(subject_id) for subject_id in subject_ids})
    if not unique_sorted_ids:
        raise ValueError("subjectIds must contain at least one subject id")
    return COMPOUND_SUBJECT_ID_PREFIX + json.dumps(
        unique_sorted_ids,
        ensure_ascii=False,
        separators=(",", ":"),
    )


def split_subject_id(subject_id: str) -> list[str]:
    """Inverse of canonical_subject_id — recover the constituent ids."""
    if subject_id.startswith(COMPOUND_SUBJECT_ID_PREFIX):
        encoded = subject_id[len(COMPOUND_SUBJECT_ID_PREFIX):]
        decoded = json.loads(encoded)
        if not isinstance(decoded, list) or not all(
            isinstance(value, str) and value for value in decoded
        ):
            raise ValueError(f"Invalid compound subject id: {subject_id!r}")
        return decoded
    # Backwards compatibility for flattened timelines generated before the
    # collision-proof group encoding was introduced.
    return subject_id.split(LEGACY_SUBJECT_ID_SEPARATOR)


def is_compound_subject_id(subject_id: str) -> bool:
    return (
        subject_id.startswith(COMPOUND_SUBJECT_ID_PREFIX)
        or LEGACY_SUBJECT_ID_SEPARATOR in subject_id
    )
