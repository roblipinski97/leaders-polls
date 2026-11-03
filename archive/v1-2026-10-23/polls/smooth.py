"""Trend lines through noisy polls: kernel-weighted local linear regression.

For every point g on a weekly grid we fit a straight line through the nearby polls,
weighting each poll by
    w = K((t - g) / h) * sqrt(n / 1000)        (Gaussian kernel K, sample size n)
and keep the fitted value at g.  This is the "LOESS-style" smoother most poll
trackers use; unlike a moving average it does not flatten at the edges of the data.

The bandwidth h adapts to how dense the polling is: at least `min_bw` days, but
wide enough to include the `k_nearest` closest polls, and at most `max_bw` days.
Germany (hundreds of polls) gets ~3-week smoothing, Luxembourg (a handful) gets
several months - otherwise sparse countries would show only dots.

The last election result is added as a very heavy pseudo-poll, so every line
starts exactly at the result.
"""
from __future__ import annotations

import numpy as np


def local_linear(t: np.ndarray, y: np.ndarray, w: np.ndarray, grid: np.ndarray,
                 min_bw: float = 21.0, max_bw: float = 150.0, k_nearest: int = 12,
                 min_support: float = 1.5) -> np.ndarray:
    """Return fitted values on `grid` (NaN where the data do not support an estimate)."""
    out = np.full(grid.shape, np.nan)
    ok = np.isfinite(y) & np.isfinite(t) & (w > 0)
    t, y, w = t[ok], y[ok], w[ok]
    if len(t) < 2:
        return out
    k = min(k_nearest, len(t)) - 1
    for i, g in enumerate(grid):
        d = np.abs(t - g)
        kth = np.partition(d, k)[k]
        h = float(np.clip(kth, min_bw, max_bw))
        if d.min() > 2.5 * h:
            continue  # no poll anywhere near: leave a gap rather than extrapolate
        kw = np.exp(-0.5 * (d / h) ** 2) * w
        if kw.sum() < min_support * 0.05:  # practically no weight
            continue
        x = t - g
        sw, swx, swxx = kw.sum(), (kw * x).sum(), (kw * x * x).sum()
        swy, swxy = (kw * y).sum(), (kw * x * y).sum()
        den = sw * swxx - swx ** 2
        if den <= 1e-9 * max(1.0, sw * swxx):
            out[i] = swy / sw
        else:
            out[i] = (swxx * swy - swx * swxy) / den
    return out


def poll_weights(sample: np.ndarray) -> np.ndarray:
    n = np.where(np.isfinite(sample) & (sample > 0), sample, 1000.0)
    return np.clip(np.sqrt(n / 1000.0), 0.4, 2.5)
