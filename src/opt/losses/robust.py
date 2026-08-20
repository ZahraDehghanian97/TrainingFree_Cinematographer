"""Shared robust-loss primitives used across loss modules.

Promoted out of ``arc.py`` (which originally had a private ``_huber_loss``)
so ``interval.py`` can apply the same cap to its tolerance-normalized
translation-movement terms (``stepSmooth``, ``stepPacing``, ``orth_drift``).
Without this, those terms square an already-normalized residual with no
ceiling: a large-but-transient error early in optimization (bad initial
guess, spline not yet converged) produces a huge, unbounded gradient spike
rather than the steep-but-linear correction Huber gives once the residual
exceeds ``delta``.
"""

from __future__ import annotations

import torch


def huber_loss(
    residuals: torch.Tensor,
    delta: float = 1.0,
) -> torch.Tensor:
    """Elementwise Huber loss: quadratic within ``delta``, linear beyond it.

    ``residuals`` should already be non-dimensionalized (e.g. divided by a
    tolerance) so that ``delta=1.0`` means "one tolerance-width off" —
    matches how every caller in this codebase uses it.
    """
    absolute_residuals = residuals.abs()
    quadratic_residuals = torch.minimum(
        absolute_residuals,
        torch.tensor(
            delta,
            device=residuals.device,
            dtype=residuals.dtype,
        ),
    )
    linear_residuals = absolute_residuals - quadratic_residuals
    return 0.5 * quadratic_residuals * quadratic_residuals + delta * linear_residuals