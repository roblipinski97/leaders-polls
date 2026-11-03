"""Parse Wikipedia fieldwork-date strings.

Examples handled:
    "19–21 Oct", "30 Sep – 2 Oct 2026", "16 Oct 2026", "Oct 2026", "October 16–18, 2026",
    "2026-10-16", "16.10.2026", "16/10/2026", "28 Dec 2025 – 3 Jan 2026", "Late Oct 2026".
Year is often missing in the text (it sits in a section heading, or only in the
hidden sort key), so callers pass `default_year` and/or an ISO `sort_value`.
"""
from __future__ import annotations

import datetime as dt
import re

MONTHS = {
    "jan": 1, "january": 1, "feb": 2, "february": 2, "mar": 3, "march": 3, "apr": 4, "april": 4,
    "may": 5, "jun": 6, "june": 6, "jul": 7, "july": 7, "aug": 8, "august": 8, "sep": 9, "sept": 9,
    "september": 9, "oct": 10, "october": 10, "nov": 11, "november": 11, "dec": 12, "december": 12,
}
_MON = r"(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?"
_TOKEN = re.compile(rf"(\d{{4}})-(\d{{1,2}})-(\d{{1,2}})|(\d{{1,2}})[./](\d{{1,2}})[./](\d{{4}})|{_MON}|(\d{{4}})|(\d{{1,2}})(?:st|nd|rd|th)?", re.I)
ISO = re.compile(r"^\s*0*(\d{4})-(\d{2})-(\d{2})")


def _safe_date(y, m, d):
    try:
        return dt.date(int(y), int(m), int(d))
    except (ValueError, TypeError):
        return None


def _month_last_day(y, m):
    nxt = dt.date(y + (m == 12), m % 12 + 1, 1)
    return (nxt - dt.timedelta(days=1)).day


def parse_sort_value(sv: str | None) -> dt.date | None:
    if not sv:
        return None
    m = ISO.match(sv)
    if m:
        return _safe_date(*m.groups())
    return None


def tokenize(text: str):
    """Return a list of tokens: ('date', date) | ('mon', m) | ('year', y) | ('day', d)."""
    out = []
    for m in _TOKEN.finditer(text):
        if m.group(1):
            out.append(("date", _safe_date(m.group(1), m.group(2), m.group(3))))
        elif m.group(4):
            out.append(("date", _safe_date(m.group(6), m.group(5), m.group(4))))
        elif m.group(7):
            key = m.group(7).lower().rstrip(".")
            out.append(("mon", MONTHS.get(key) or MONTHS[key[:3]]))
        elif m.group(8):
            y = int(m.group(8))
            if 1900 < y < 2100:
                out.append(("year", y))
        elif m.group(9):
            d = int(m.group(9))
            if 1 <= d <= 31:
                out.append(("day", d))
    return out


def parse_fieldwork(text: str, sort_value: str | None = None, default_year: int | None = None,
                    prefer_default_year: bool = False):
    """Return (start, end, had_year) or (None, None, False).

    Priority for the year: (1) a year written in the text; (2) `default_year` when
    `prefer_default_year` (the year of the section heading, e.g. "2025"); (3) the year of the
    hidden ISO sort key; (4) `default_year`.  Sort keys are only a fallback because editors
    copy-paste them and they are sometimes wrong.
    """
    text = (text or "").replace("–", "-").replace("—", "-").replace("−", "-")
    toks = [t for t in tokenize(text) if t[1] is not None]
    sv_date = parse_sort_value(sort_value)

    full = [t[1] for t in toks if t[0] == "date"]
    if len(full) >= 1:
        start, end = full[0], full[-1]
        return min(start, end), max(start, end), True

    # Build (day?, month, year?) groups from left to right. A group closes when a month is seen
    # (for "16 Oct" / "16-18 Oct") or when a day follows a month (US style "Oct 16").
    groups = []  # list of dicts with keys d, m, y
    cur: dict = {}
    pending_days: list[int] = []
    for kind, val in toks:
        if kind == "day":
            if "m" in cur and "d" not in cur and not pending_days:
                cur["d"] = val          # US style "October 16"
            else:
                if "m" in cur:
                    groups.append(cur)
                    cur = {}
                pending_days.append(val)
        elif kind == "mon":
            if "m" in cur:
                groups.append(cur)
                cur = {}
            if pending_days:
                # "16-18 Oct": every pending day gets this month
                for d in pending_days[:-1]:
                    groups.append({"d": d, "m": val})
                cur = {"d": pending_days[-1], "m": val}
                pending_days = []
            else:
                cur = {"m": val}
        elif kind == "year":
            if pending_days and "m" not in cur:
                # "18-20, 2026" after US "Oct 16-" pattern is rare; attach to last group
                for d in pending_days:
                    groups.append({"d": d, "m": groups[-1]["m"] if groups else None})
                pending_days = []
            if "m" in cur:
                cur["y"] = val
                groups.append(cur)
                cur = {}
            else:
                for g in groups:
                    g.setdefault("y", val)
    if pending_days and "m" in cur:
        # US style "October 16-18": days after a month that already has a day
        groups.append(cur)
        cur = {}
        for d in pending_days:
            groups.append({"d": d, "m": groups[-1]["m"]})
        pending_days = []
    if cur:
        groups.append(cur)
    groups = [g for g in groups if g.get("m")]
    if not groups:
        if sv_date:
            return sv_date, sv_date, True
        return None, None, False

    had_year = any("y" in g for g in groups)
    # propagate year backwards from the last group that has one; fill from the sort value / default
    end_g = groups[-1]
    if "y" not in end_g:
        later = [g["y"] for g in groups if "y" in g]
        if later:
            end_g["y"] = later[-1]
        elif prefer_default_year and default_year:
            end_g["y"] = default_year
        elif sv_date and sv_date.month == end_g["m"]:
            end_g["y"] = sv_date.year
        elif default_year:
            end_g["y"] = default_year
        elif sv_date:
            end_g["y"] = sv_date.year
        else:
            return None, None, False
    for i in range(len(groups) - 2, -1, -1):
        g, nxt = groups[i], groups[i + 1]
        if "y" not in g:
            g["y"] = nxt["y"] - 1 if g["m"] > nxt["m"] else nxt["y"]

    def to_date(g, is_end):
        d = g.get("d") or (_month_last_day(g["y"], g["m"]) if is_end else 1)
        return _safe_date(g["y"], g["m"], d)

    start, end = to_date(groups[0], False), to_date(groups[-1], True)
    if start and end and start > end:
        start, end = end, start
    used_sv = bool(sv_date) and not had_year and not prefer_default_year and end is not None \
        and end.year == sv_date.year
    return start, end, had_year or used_sv
