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

SUBJECT_ID_SEPARATOR = "+"


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
    return SUBJECT_ID_SEPARATOR.join(unique_sorted_ids)


def split_subject_id(subject_id: str) -> list[str]:
    """Inverse of canonical_subject_id — recover the constituent ids."""
    return subject_id.split(SUBJECT_ID_SEPARATOR)


def is_compound_subject_id(subject_id: str) -> bool:
    return SUBJECT_ID_SEPARATOR in subject_id