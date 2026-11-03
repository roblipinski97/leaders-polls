"""Party colours: keep Wikipedia's familiar party colours, but make them tell apart.

The problem: within one country several parties often share a colour family
(Poland: PiS #263778 and Konfederacja #122746 are both navy; Germany: AfD and the
Union's black vs. dark greys; the Nordics: three different reds).  Thin lines on
a small chart then become impossible to match to a label.

The approach (all computed in OKLab, a perceptually uniform colour space, where the
Euclidean distance between two colours ~ how different they look):

1. Start from the colour Wikipedia uses in the table header (readers recognise it).
2. Clamp lightness so every line is visible on a light *and* on a dark background
   (very pale yellows/greys get darkened; near-black gets lifted for dark mode).
3. Walk the parties from largest to smallest.  Big parties keep their colour; if a
   smaller party is closer than DELTA_MIN to any colour already taken, try nudged
   variants (lighter/darker, then hue rotations) and take the one that maximises
   the distance to the others while changing the original as little as possible.
4. Parties with no colour on Wikipedia get the most distinct colour from a fallback
   qualitative palette.

Colour is never the only cue in the dashboard: lines carry direct labels, the
incumbent is drawn thicker, and minor parties are drawn as thin grey context.
"""
from __future__ import annotations

import math

DELTA_MIN = 0.12      # minimum OKLab distance between two party colours in one chart
FALLBACK = ["#4E79A7", "#F28E2B", "#E15759", "#76B7B2", "#59A14F", "#EDC948", "#B07AA1",
            "#FF9DA7", "#9C755F", "#BAB0AC", "#2F4B7C", "#A05195", "#D45087", "#665191"]


# --- sRGB <-> OKLab -----------------------------------------------------------------------------
def _srgb_to_lin(c: float) -> float:
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def _lin_to_srgb(c: float) -> float:
    return 12.92 * c if c <= 0.0031308 else 1.055 * c ** (1 / 2.4) - 0.055


def hex_to_rgb(h: str) -> tuple[float, float, float]:
    h = h.lstrip("#")
    return tuple(int(h[i:i + 2], 16) / 255 for i in (0, 2, 4))  # type: ignore


def rgb_to_hex(rgb) -> str:
    return "#" + "".join(f"{round(max(0, min(1, c)) * 255):02X}" for c in rgb)


def rgb_to_oklab(rgb):
    r, g, b = (_srgb_to_lin(c) for c in rgb)
    l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b
    m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b
    s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b
    l, m, s = (math.copysign(abs(x) ** (1 / 3), x) for x in (l, m, s))
    return (0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
            1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
            0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s)


def oklab_to_rgb(lab):
    L, a, b = lab
    l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3
    m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3
    s = (L - 0.0894841775 * a - 1.2914855480 * b) ** 3
    r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s
    g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s
    bb = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
    return tuple(_lin_to_srgb(max(0.0, c)) if c >= 0 else 0.0 for c in (r, g, bb))


def to_lch(h: str):
    L, a, b = rgb_to_oklab(hex_to_rgb(h))
    return L, math.hypot(a, b), math.degrees(math.atan2(b, a)) % 360


def from_lch(L: float, C: float, H: float) -> str:
    """OKLCH -> hex, reducing chroma until the colour fits in sRGB."""
    for _ in range(40):
        a, b = C * math.cos(math.radians(H)), C * math.sin(math.radians(H))
        rgb = oklab_to_rgb((L, a, b))
        lin_ok = all(-1e-4 <= c <= 1 + 1e-4 for c in rgb)
        if lin_ok:
            return rgb_to_hex(rgb)
        C *= 0.92
    return rgb_to_hex(oklab_to_rgb((L, 0, 0)))


def delta(h1: str, h2: str) -> float:
    a, b = rgb_to_oklab(hex_to_rgb(h1)), rgb_to_oklab(hex_to_rgb(h2))
    return math.dist(a, b)


def clamp_for_light_bg(h: str, lo: float = 0.30, hi: float = 0.78) -> str:
    L, C, H = to_lch(h)
    return from_lch(min(max(L, lo), hi), C, H) if (L < lo or L > hi) else h


def dark_variant(h: str, lo: float = 0.58, hi: float = 0.90) -> str:
    """Same hue, lifted so it reads on a dark background."""
    L, C, H = to_lch(h)
    return from_lch(min(max(L, lo), hi), C, H) if (L < lo or L > hi) else h


def distinguish(parties: list[tuple[str, str | None, float]], coexist=None) -> dict[str, dict]:
    """parties: (key, wikipedia_colour or None, importance). Returns key -> {light, dark, source}.

    `coexist(a, b)` (optional) says whether two parties ever appear on screen at the same time;
    parties from different eras (e.g. Samoobrona 2001 and Polska 2050 in 2023) may then share
    a colour family without being nudged apart.
    """
    taken_by: list[tuple[str, str]] = []
    out: dict[str, dict] = {}
    order = sorted(parties, key=lambda p: -p[2])
    for key, col, _w in order:
        taken = [c for k, c in taken_by if coexist is None or coexist(key, k)]
        if not col:
            # most distinct fallback colour
            best = max(FALLBACK, key=lambda f: min([delta(f, t) for t in taken] or [1]))
            col, source = best, "fallback"
        else:
            source = "wikipedia"
        base = clamp_for_light_bg(col)
        if taken and min(delta(base, t) for t in taken) < DELTA_MIN:
            L, C, H = to_lch(base)
            candidates = []
            for dL in (0, 0.1, -0.1, 0.18, -0.18, 0.26):
                for dH in (0, 18, -18, 35, -35, 60, -60):
                    for cmul in (1.0, 1.3, 0.7):
                        if dL == 0 and dH == 0 and cmul == 1.0:
                            continue
                        Ln = min(max(L + dL, 0.30), 0.80)
                        cand = from_lch(Ln, max(C * cmul, 0.03 if C < 0.03 else C * cmul), (H + dH) % 360)
                        sep = min(delta(cand, t) for t in taken)
                        change = delta(cand, base)
                        candidates.append((sep >= DELTA_MIN, -change if sep >= DELTA_MIN else sep, cand))
            candidates.sort(key=lambda x: (x[0], x[1]), reverse=True)
            base = candidates[0][2]
            source += "+adjusted"
        taken_by.append((key, base))
        out[key] = {"light": base, "dark": dark_variant(base), "source": source, "wikipedia": col}
    return out
