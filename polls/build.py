"""Build the dashboard data: fetch -> parse -> clean -> smooth -> JSON/CSV.

Outputs
-------
data/processed/polls_long.csv      one row per (poll, party): tidy, ready for R / pandas
data/processed/diagnostics.txt     what was selected on every page (check this after edits)
site/data/europe.json              current cycle for every country (incumbents grid)
site/data/history/<CC>.json        long-run series across several cycles (e.g. Poland 2001-)
"""
from __future__ import annotations

import csv
import datetime as dt
import json
import math
import pathlib
import re
from collections import Counter, defaultdict

import numpy as np
import yaml

from .colors import distinguish
from .fetch import fetch_page, load_cached
from .parse import parse_page
from .smooth import local_linear, poll_weights

ROOT = pathlib.Path(__file__).resolve().parents[1]
STEP_DAYS = 7
ELECTION_WEIGHT = 12.0   # election result counts like ~12 large polls in the smoother
MINOR_MAX = 3.0          # parties never above this (trend) are "minor"


# ----------------------------------------------------------------------------------------------
def load_config(path: pathlib.Path | None = None, generated: bool = True) -> dict:
    """countries.yaml, plus the two generated files when present:
    config/history.yaml   past cycles for the long-run view   (python -m polls discover --plan)
    config/rollover.yaml  elections held since countries.yaml was last edited (python -m polls update)
    """
    path = path or ROOT / "config" / "countries.yaml"
    with open(path, encoding="utf-8") as f:
        cfg = yaml.safe_load(f)
    if generated:
        roll = ROOT / "config" / "rollover.yaml"
        if roll.exists():
            from .update import apply_rollover
            apply_rollover(cfg, yaml.safe_load(roll.read_text(encoding="utf-8")) or {})
        cur = ROOT / "config" / "history_merges.yaml"
        if cur.exists():
            for code, hc in (yaml.safe_load(cur.read_text(encoding="utf-8")) or {}).items():
                if code in cfg["countries"]:
                    h = cfg["countries"][code].setdefault("history", {}) or {}
                    cfg["countries"][code]["history"] = h
                    for key in ("merge", "labels", "drop", "result_merge"):
                        if hc.get(key):
                            h[key] = hc[key]
        hist = ROOT / "config" / "history.yaml"
        if hist.exists():
            h = (yaml.safe_load(hist.read_text(encoding="utf-8")) or {}).get("countries") or {}
            for code, hc in h.items():
                if code in cfg["countries"]:
                    cfg["countries"][code]["history_cycles"] = hc.get("cycles") or []
    for code, c in cfg["countries"].items():
        for cyc in (c.get("cycles") or []) + (c.get("history_cycles") or []):
            if c.get("seat_total") and "seat_total" not in cyc:
                cyc["seat_total"] = c["seat_total"]
    return cfg


def _d(x) -> dt.date | None:
    if x is None or x == "":
        return None
    if isinstance(x, dt.date):
        return x
    return dt.date.fromisoformat(str(x)[:10])


def _days(d: dt.date, origin: dt.date) -> int:
    return (d - origin).days


def wiki_url(title: str) -> str:
    return "https://en.wikipedia.org/wiki/" + title.replace(" ", "_")


# ----------------------------------------------------------------------------------------------
# Reading one cycle (one Wikipedia page restricted to a date window)
# ----------------------------------------------------------------------------------------------
def read_cycle(code: str, cyc: dict, raw_dir: pathlib.Path, offline: bool, diag: list[str],
               today: dt.date) -> dict:
    page = cyc["page"]
    if offline:
        html, meta = load_cached(raw_dir, page)
        if html is None:
            raise FileNotFoundError(f"{code}: no cached copy of {page!r} (run without --offline)")
    else:
        # pages of cycles that closed long ago hardly change: refresh them monthly, not daily
        closed_long_ago = cyc.get("end") and _d(cyc["end"]) < today - dt.timedelta(days=90)
        html, meta = fetch_page(page, raw_dir, max_age_hours=24 * 30 if closed_long_ago else 20)
    start = _d(cyc["start"])
    end = _d(cyc.get("end")) or today
    default_year = min(end.year, today.year)
    chosen, infos, rows = parse_page(html, default_year, cyc.get("include_headings"),
                                     cyc.get("exclude_headings"), cyc.get("tables"),
                                     cyc.get("require_headings"))
    if not chosen and cyc.get("seat_total") and not cyc.get("include_headings"):
        # Dutch pages often only have seat projections: read those (converted to % below)
        chosen, infos, rows = parse_page(html, default_year, r"(?i)\bseats?\b", None, None,
                                         cyc.get("require_headings"))
        chosen = [t for t in chosen if not re.search(r"(?i)panel|by\s+province|regional", t.heading)]
        rows = [r for r in rows if r["table"] in {t.index for t in chosen}]
    diag.append(f"[{code}] {page}  (rev {meta.get('revid')})  window {start} .. {cyc.get('end') or 'open'}")
    for t in infos:
        mark = "+" if t in chosen else " "
        if t in chosen or t.n_data_rows >= 5:
            diag.append(f"   {mark} T{t.index:02d} rows={t.n_data_rows:4d} [{t.heading[:70]}] {t.reason}")

    # --- window filter, election rows ----------------------------------------------------------
    lo, hi = start - dt.timedelta(days=3), end + dt.timedelta(days=1)
    polls, elections = [], []
    dropped = Counter()
    for r in rows:
        if r["end"] is None and r.get("election_year"):
            # undated "2026 election result" row: attach it to the matching cycle boundary
            for b in (start, _d(cyc.get("end"))):
                if b and b.year == r["election_year"]:
                    r["start"] = r["end"] = b
                    break
        if r["end"] is None:
            dropped["no date"] += 1
            continue
        if r["is_election"]:
            elections.append(r)
            continue
        if not (lo <= r["end"] <= hi):
            dropped["outside window"] += 1
            continue
        if r["end"] > today + dt.timedelta(days=2):
            dropped["future date"] += 1
            continue
        polls.append(r)
    # seat projections printed instead of vote shares (old Dutch / Luxembourg tables)
    n_seats = cyc.get("seat_total")
    if n_seats:
        conv = 0
        for r in polls + elections:
            vals = list(r["values"].values()) + list(r["joint"].values())
            if vals and all(abs(v - round(v)) < 1e-9 for v in vals) and 0.93 * n_seats <= math.fsum(vals) <= 1.01 * n_seats:
                f = 100.0 / n_seats
                r["values"] = {k: v * f for k, v in r["values"].items()}
                r["joint"] = {k: v * f for k, v in r["joint"].items()}
                r["others"] = r["others"] * f if r.get("others") is not None else None
                r["from_seats"] = True
                conv += 1
        if conv:
            diag.append(f"     {conv} rows were seat projections (of {n_seats}): converted to % of seats")
    # the result that opens the cycle (and, for closed cycles, the one that ends it)
    def closest(target):
        c = [e for e in elections if abs((e["end"] - target).days) <= 10]
        return min(c, key=lambda e: abs((e["end"] - target).days)) if c else None
    res_start = closest(start)
    res_end = closest(_d(cyc["end"])) if cyc.get("end") else None

    def from_infobox(shares, when):   # result taken from the election article (python -m polls update)
        return {"values": {k: float(v) for k, v in shares.items()}, "joint": {}, "others": None,
                "undecided": None, "start": when, "end": when, "is_election": True,
                "pollster": "Election result (article infobox)", "sample": None}
    if res_start is None and cyc.get("start_result"):
        res_start = from_infobox(cyc["start_result"], start)
    if cyc.get("end") and res_end is None and cyc.get("end_result"):
        res_end = from_infobox(cyc["end_result"], _d(cyc["end"]))
    if dropped:
        diag.append(f"     dropped rows: {dict(dropped)}")
    diag.append(f"     polls kept: {len(polls)}  | start result: {'yes' if res_start else 'MISSING'}"
                + (f" | end result: {'yes' if res_end else 'MISSING'}" if cyc.get("end") else ""))

    # --- labels & colours as seen in this page's headers ----------------------------------------
    labels, colors = defaultdict(Counter), defaultdict(Counter)
    for t in chosen:
        for c in t.party_cols:
            labels[c.key][c.name] += 1
            if c.color:
                colors[c.key][c.color] += 1
        # joint lists: colour of the group header if any (else first member)
        for c in t.party_cols:
            if c.group:
                labels[c.group][c.group] += 1
    return {"page": page, "meta": meta, "start": start, "end": _d(cyc.get("end")), "polls": polls,
            "res_start": res_start, "res_end": res_end, "labels": labels, "colors": colors,
            "name": cyc.get("name") or f"{start.year}–"}


def normalise(rec: dict) -> dict[str, float]:
    """Shares excluding undecided, when the poll reports undecided inside the 100%."""
    vals = dict(rec["values"])
    vals.update(rec["joint"])
    und = rec.get("undecided")
    # math.fsum: exact float addition, so results are identical on every Python version
    tot = math.fsum(list(vals.values()) + [rec.get("others") or 0])
    # the undecided were part of the base (tot + und ~ 100, or a bit less when "won't vote" etc.
    # are reported in columns we ignore): re-base to decided voters
    if und and und > 0 and 80 <= tot + und <= 105 and tot > 0:
        f = 100.0 / tot if rec.get("others") is not None else 100.0 / (100.0 - und)
        return {k: v * f for k, v in vals.items()}
    return vals


def fold_joint_lists(polls, results, aliases, diag, code):
    """Joint-list cells ("A + B", spanning two party columns) -> one continuing series.

    Frequent joint series are folded into their senior partner (the member with the higher
    average share when polled alone) unless the config maps them explicitly (`aliases`).
    Rare ones (a handful of scenario polls) are dropped, so they cannot spike a party's line.
    """
    joint = Counter(k for p in polls for k in p["norm"] if " + " in k and k not in aliases)
    if not joint:
        return
    solo_mean = defaultdict(list)
    for p in polls:
        for k, v in p["norm"].items():
            if " + " not in k:
                solo_mean[k].append(v)
    threshold = max(5, 0.05 * len(polls))
    mapping = {}
    for k, n in joint.items():
        members = [m for m in k.split(" + ") if m in solo_mean]
        if n < threshold or not members:
            mapping[k] = None
        else:
            mapping[k] = max(members, key=lambda m: sum(solo_mean[m]) / len(solo_mean[m]))
    for p in polls + [r for r in results if r]:
        for field in ("norm", "rawm"):
            if field not in p:
                continue
            new = {}
            for k, v in p[field].items():
                if k in mapping:
                    if mapping[k] is None or mapping[k] in p[field]:
                        continue
                    k = mapping[k]
                new[k] = new.get(k, 0) + v
            p[field] = new
    diag.append(f"     joint lists: " + "; ".join(f"{k[:60]} x{joint[k]} -> {mapping[k]}" for k in joint))


def apply_aliases(vals: dict[str, float], aliases: dict[str, str]) -> dict[str, float]:
    if not aliases:
        return vals
    out: dict[str, float] = {}
    for k, v in vals.items():
        k2 = aliases.get(k, k)
        out[k2] = out.get(k2, 0.0) + v if k2 in out else v
    return out


# ----------------------------------------------------------------------------------------------
# Trend computation for a set of polls
# ----------------------------------------------------------------------------------------------
def trends_for(polls: list[dict], start: dt.date, last: dt.date, keys: list[str],
               res_start: dict | None, res_end: dict | None, end: dt.date | None,
               step: int = STEP_DAYS) -> tuple[list[dt.date], dict[str, list]]:
    grid_end = end if (end and res_end) else last
    n = max(1, (grid_end - start).days // step + 1)
    grid_dates = [start + dt.timedelta(days=i * step) for i in range(n)]
    if grid_dates[-1] < grid_end:
        grid_dates.append(grid_end)
    g = np.array([_days(d, start) for d in grid_dates], dtype=float)
    series = {}
    for k in keys:
        t, y, w = [], [], []
        for p in polls:
            v = p["norm"].get(k)
            if v is None:
                continue
            mid = p["end"] - (p["end"] - (p["start"] or p["end"])) / 2
            t.append(_days(mid, start)); y.append(v); w.append(p["w"])
        n_polls = len(t)
        for res, when in ((res_start, start), (res_end, end)):
            if res and k in res["norm"]:
                t.append(_days(when, start)); y.append(res["norm"][k]); w.append(ELECTION_WEIGHT)
        if n_polls < 3:
            continue
        fit = local_linear(np.array(t, float), np.array(y, float), np.array(w, float), g)
        # do not draw a party before its first / after its last appearance in polls
        first, lastp = min(t), max(t)
        fit[(g < first - 10) | (g > lastp + 10)] = np.nan
        fit = np.clip(fit, 0, 100)
        series[k] = [None if not math.isfinite(v) else round(float(v), 2) for v in fit]
    return grid_dates, series


# ----------------------------------------------------------------------------------------------
# One country, current cycle
# ----------------------------------------------------------------------------------------------
def build_country(code: str, cfg: dict, raw_dir: pathlib.Path, offline: bool, diag: list[str],
                  today: dt.date, csv_rows: list[dict]) -> dict | None:
    cycles = cfg.get("cycles") or []
    if not cycles:
        return None
    aliases = cfg.get("aliases") or {}
    cur = read_cycle(code, cycles[0], raw_dir, offline, diag, today)
    use = cur
    fallback = bool(cycles[0].get("end"))   # first listed cycle already closed by an election
    min_polls = cfg.get("min_polls", 5)
    if len(cur["polls"]) < min_polls and len(cycles) > 1:
        prev = read_cycle(code, cycles[1], raw_dir, offline, diag, today)
        if len(prev["polls"]) >= min_polls:
            use, fallback = prev, True
            diag.append(f"     -> fewer than {min_polls} polls in current cycle: showing completed cycle")

    polls = use["polls"]
    sample = np.array([p["sample"] if p["sample"] else np.nan for p in polls], float)
    w = poll_weights(sample)
    for p, wi in zip(polls, w):
        p["norm"] = apply_aliases(normalise(p), aliases)
        p["rawm"] = apply_aliases({**p["values"], **p["joint"]}, aliases)   # as printed, for the CSV
        p["w"] = float(wi)
    for res in (use["res_start"], use["res_end"]):
        if res:
            res["norm"] = apply_aliases(normalise(res), aliases)

    fold_joint_lists(polls, [use["res_start"], use["res_end"]], aliases, diag, code)
    keys = sorted({k for p in polls for k in p["norm"]})
    last_poll = max((p["end"] for p in polls), default=use["start"])
    grid_dates, series = trends_for(polls, use["start"], last_poll, keys, use["res_start"],
                                    use["res_end"], use["end"])

    # --- party table ---------------------------------------------------------------------------
    def label_for(k):
        return short_label(k, use["labels"].get(k), cfg.get("labels") or {})

    parties = []
    for k in keys:
        s = [v for v in series.get(k, []) if v is not None]
        # value at the end of the trend; None for parties that stopped being polled (dissolved, merged)
        last = series[k][-1] if series.get(k) else None
        parties.append({
            "key": k, "label": label_for(k),
            "article": k if " " in k or "(" in k else None,
            "n": sum(1 for p in polls if k in p["norm"]),
            "last": last, "max": max(s) if s else None,
            "result": round(use["res_start"]["norm"][k], 2) if use["res_start"] and k in use["res_start"]["norm"] else None,
            "result_end": round(use["res_end"]["norm"][k], 2) if use["res_end"] and k in use["res_end"]["norm"] else None,
            "wiki_color": (use["colors"].get(k) or Counter()).most_common(1)[0][0] if use["colors"].get(k) else None,
        })
    # drop parties with almost no data
    parties = [p for p in parties if p["n"] >= 3 or (p["result"] or 0) >= 3]
    overrides = cfg.get("colors") or {}
    palette = distinguish([(p["key"], overrides.get(p["key"]) or p["wiki_color"], p["max"] or p["result"] or 0)
                           for p in parties])
    for p in parties:
        p["color"], p["color_dark"] = palette[p["key"]]["light"], palette[p["key"]]["dark"]
        if p["key"] in overrides:
            p["color"] = overrides[p["key"]]
        p["minor"] = (p["max"] or 0) < MINOR_MAX and (p["result"] or 0) < MINOR_MAX
    parties.sort(key=lambda p: (p["last"] is None, -(p["last"] if p["last"] is not None else (p["result"] or 0))))

    # --- incumbents (dated periods) ------------------------------------------------------------
    periods = resolve_incumbents(cfg, parties, use["start"], use["end"] or today, diag, code)
    current = periods[-1] if periods else None
    inc = next((p for p in parties if current and p["key"] == current.get("key")), None)
    stats = incumbent_stats(inc, parties, series, grid_dates, periods, use["start"]) if inc else None
    # completed cycle with a known result: the final standing is the result, not the trend
    if stats and use["end"] and use["res_end"] and inc["key"] in use["res_end"]["norm"]:
        rn = use["res_end"]["norm"]
        rk = max((k for k in rn if k != inc["key"]), key=lambda k: rn[k], default=None)
        if rk is not None:
            stats.update({"now": round(rn[inc["key"]], 2), "rival": rk, "rival_now": round(rn[rk], 2),
                          "gap_now": round(rn[inc["key"]] - rn[rk], 2),
                          "change": round(rn[inc["key"]] - inc["result"], 2) if inc["result"] is not None else None,
                          "rank_now": 1 + sum(1 for k in rn if k != inc["key"] and rn[k] > rn[inc["key"]]),
                          "final": "result"})

    # --- polls in compact columnar form ----------------------------------------------------------
    pk = [p["key"] for p in parties]
    pollsters = sorted({p["pollster"] for p in polls})
    pidx = {n: i for i, n in enumerate(pollsters)}
    polls_sorted = sorted(polls, key=lambda p: p["end"])
    cols = {
        "t": [_days(p["end"] - (p["end"] - (p["start"] or p["end"])) / 2, use["start"]) for p in polls_sorted],
        "s": [_days(p["start"] or p["end"], use["start"]) for p in polls_sorted],
        "e": [_days(p["end"], use["start"]) for p in polls_sorted],
        "p": [pidx[p["pollster"]] for p in polls_sorted],
        "n": [p["sample"] for p in polls_sorted],
        "v": {k: [round(p["norm"][k], 1) if k in p["norm"] else None for p in polls_sorted] for k in pk},
    }
    for p in polls_sorted:
        for k, v in p["norm"].items():
            csv_rows.append({"country": code, "cycle": use["name"], "page": use["page"],
                             "pollster": p["pollster"], "client": p["client"], "area": p["area"],
                             "fieldwork_start": (p["start"] or p["end"]).isoformat(),
                             "fieldwork_end": p["end"].isoformat(), "sample_size": p["sample"] or "",
                             "party": k, "share_raw": round(p["rawm"][k], 3) if k in p.get("rawm", {}) else "",
                             "share": round(v, 3), "undecided": p.get("undecided") or ""})

    meta = use["meta"]
    return {
        "code": code, "name": cfg["name"], "region": cfg.get("region"),
        "legislature": cfg.get("legislature"),
        "incumbent": current,
        "incumbents": periods,
        "last_election": (use["start"]).isoformat(),
        "next_election": (use["end"] or _d(cfg.get("next_election"))).isoformat() if (use["end"] or cfg.get("next_election")) else None,
        "next_status": "held" if fallback else cfg.get("next_election_status"),
        "fallback_completed_cycle": fallback,
        "upcoming_next_election": str(cfg.get("next_election")) if cfg.get("next_election") else None,
        "note": cfg.get("note"),
        "source": {"page": use["page"], "url": wiki_url(meta.get("title") or use["page"]),
                   "revid": meta.get("revid"), "fetched": meta.get("fetched")},
        "parties": parties,
        "trend": {"start": use["start"].isoformat(), "days": [_days(d, use["start"]) for d in grid_dates],
                  "series": {k: series.get(k) for k in pk}},
        "polls": cols, "pollsters": pollsters,
        "n_polls": len(polls), "last_poll": last_poll.isoformat(),
        "stats": stats,
    }


def short_label(k: str, seen: Counter | None, overrides: dict) -> str:
    """Display label: config override, else the most common header text (short form preferred),
    without a trailing "(political party)"-style disambiguator."""
    if overrides.get(k):
        return overrides[k]
    if seen:
        lab = seen.most_common(1)[0][0]
        if len(lab) > 22:   # header showed the full article name: prefer a short alias
            shorter = [x for x in seen if len(x) <= 22]
            if shorter:
                lab = shorter[0]
        return re.sub(r"\s*\((?:[^()]*?(party|political|alliance|coalition)?[^()]*)\)$", "", lab).strip() or lab
    return re.sub(r"\s*\([^()]*\)$", "", k).strip() or k


def resolve_incumbents(cfg, parties, start, end, diag, code):
    """Turn config periods into [{from, to, key, label, leader, ...}] clipped to [start, end]."""
    raw = sorted(cfg.get("incumbents") or [], key=lambda x: _d(x["from"]))
    out = []
    for i, per in enumerate(raw):
        f = _d(per["from"])
        t = _d(raw[i + 1]["from"]) if i + 1 < len(raw) else None
        if t is not None and t <= start:
            continue
        if f > end:
            continue
        match = [m.lower() for m in (per.get("match") or [])]
        party = next((p for p in parties if p["key"].lower() in match or p["label"].lower() in match), None)
        if match and party is None:
            diag.append(f"     !! [{code}] incumbent {per.get('match')} not found among {[p['key'] for p in parties][:14]}")
        out.append({
            "from": max(f, start).isoformat(), "to": t.isoformat() if t else None,
            "key": party["key"] if party else None, "label": party["label"] if party else None,
            "leader": per.get("leader"), "title": per.get("title"),
            "caretaker": bool(per.get("caretaker")), "note": per.get("note"),
        })
    return out


def incumbent_stats(inc, parties, series, grid_dates, periods, origin):
    """Headline numbers for the current incumbent + the lead/deficit series of whoever governed."""
    k = inc["key"]
    s = series.get(k) or []
    keys = [p["key"] for p in parties]

    def key_at(d):
        cur = None
        for per in periods:
            if dt.date.fromisoformat(per["from"]) <= d:
                cur = per["key"]
        return cur

    gaps, lead_n, total = [], 0, 0
    for i, d in enumerate(grid_dates):
        gk = key_at(d)
        v = series.get(gk, [None] * len(grid_dates))[i] if gk else None
        if v is None:
            gaps.append(None)
            continue
        rival = max((series[o][i] for o in keys if o != gk and series.get(o) and series[o][i] is not None), default=None)
        if rival is None:
            gaps.append(None)
            continue
        gaps.append(round(v - rival, 2))
        total += 1
        lead_n += v > rival
    last_i = max((i for i, v in enumerate(s) if v is not None), default=None)
    if last_i is None:
        return None
    rival_key, rival_val = None, None
    for o in keys:
        if o != k and series.get(o) and series[o][last_i] is not None and (rival_val is None or series[o][last_i] > rival_val):
            rival_key, rival_val = o, series[o][last_i]
    return {
        "now": s[last_i], "result": inc["result"],
        "change": round(s[last_i] - inc["result"], 2) if inc["result"] is not None else None,
        "rival": rival_key, "rival_now": rival_val,
        "gap_now": round(s[last_i] - rival_val, 2) if rival_val is not None else None,
        "share_time_leading": round(lead_n / total, 3) if total else None,
        "rank_now": 1 + sum(1 for o in keys if o != k and series.get(o) and series[o][last_i] is not None and series[o][last_i] > s[last_i]),
        "gaps": gaps,
    }


# ----------------------------------------------------------------------------------------------
# Long-run history (several cycles chained, parties mapped to lineages)
# ----------------------------------------------------------------------------------------------
def history_cycles(cfg: dict) -> list[dict]:
    """Cycles of the long view: the configured ones plus the generated past ones (history.yaml)."""
    cycles = list(cfg.get("cycles") or [])
    pages = {c["page"] for c in cycles}
    cycles += [c for c in cfg.get("history_cycles") or [] if c["page"] not in pages]
    return cycles


def build_history(code: str, cfg: dict, raw_dir: pathlib.Path, offline: bool, diag: list[str],
                  today: dt.date, governments: list[dict] | None = None) -> dict | None:
    """Several cycles chained.

    With `history.lineages` in the config (Poland) parties are mapped to curated lineages; without
    it every party key is its own series, after `aliases` and `history.merge` (renames, joint lists).
    """
    hcfg = cfg.get("history") or {}
    cyc_cfg = history_cycles(cfg)
    if len(cyc_cfg) < 2:
        return None
    lineages = hcfg.get("lineages") or []
    auto = not lineages
    aliases = dict(cfg.get("aliases") or {})
    merge = dict(hcfg.get("merge") or {})
    drop = set(hcfg.get("drop") or [])
    result_merge = dict(hcfg.get("result_merge") or {})   # names used only in election-result rows
    member_of = {}
    for L in lineages:
        for m in L.get("members", []):
            member_of[m] = L["id"]

    cycles = []
    for c in cyc_cfg:
        try:
            r = read_cycle(code, c, raw_dir, offline, diag, today)
        except FileNotFoundError as e:
            diag.append(f"     (history) {e}")
            continue
        if len(r["polls"]) < 3:
            continue
        sums = sorted(math.fsum(normalise(p).values()) + (p.get("others") or 0) for p in r["polls"])
        med = sums[len(sums) // 2]
        if med < 70 or med > 115:
            diag.append(f"     (history) {r['page']}: dropped, median poll total {med:.0f}% (not vote shares?)")
            continue
        cycles.append(r)
    if len(cycles) < 2:
        return None
    cycles.sort(key=lambda c: c["start"])
    # share election results between neighbouring cycles when one page lacks the row
    for a, b in zip(cycles, cycles[1:]):
        if a["end"] and abs((a["end"] - b["start"]).days) <= 3:
            if a["res_end"] is None and b["res_start"] is not None:
                a["res_end"] = dict(b["res_start"])
            if b["res_start"] is None and a["res_end"] is not None:
                b["res_start"] = dict(a["res_end"])
    origin = cycles[0]["start"]

    def to_lineage(vals: dict[str, float], unmapped: Counter | None) -> dict[str, float]:
        out: dict[str, float] = {}
        for k, v in vals.items():
            k = aliases.get(k, k)
            if k in drop:
                continue
            if auto:
                lid = merge.get(k, k)
                # a rename can appear twice in one poll (two tables, two names): keep one value
                out[lid] = max(out.get(lid, 0), v)
                continue
            else:
                lid = member_of.get(k)
                if lid is None:
                    if unmapped is not None:
                        unmapped[k] += 1
                    continue
            out[lid] = out.get(lid, 0) + v
        return out

    all_polls, elections = [], {}
    unmapped = Counter()
    segments = []
    seen_labels: dict[str, Counter] = defaultdict(Counter)
    seen_colors: dict[str, Counter] = defaultdict(Counter)
    last_seen: dict[str, str] = {}
    for c in cycles:
        polls = c["polls"]
        w = poll_weights(np.array([p["sample"] if p["sample"] else np.nan for p in polls], float))
        for p, wi in zip(polls, w):
            p["norm"], p["w"] = to_lineage(normalise(p), unmapped), float(wi)
        for res in (c["res_start"], c["res_end"]):
            if res:
                res["norm"] = to_lineage({result_merge.get(k, k): v for k, v in normalise(res).items()}, None)
        if auto:
            fold_joint_lists(polls, [c["res_start"], c["res_end"]], {}, diag, code)
        for res in (c["res_start"], c["res_end"]):
            if res:
                elections[res["end"].isoformat()] = {k: round(v, 2) for k, v in res["norm"].items()}
        keys = sorted({k for p in polls for k in p["norm"]})
        last = max(p["end"] for p in polls)
        gd, ser = trends_for(polls, c["start"], last, keys, c["res_start"], c["res_end"], c["end"])
        segments.append({"start": c["start"].isoformat(), "end": (c["end"] or last).isoformat(),
                         "page": c["page"], "url": wiki_url(c["meta"].get("title") or c["page"]),
                         "revid": c["meta"].get("revid"), "n_polls": len(polls),
                         "days": [_days(d, origin) for d in gd],
                         "series": ser})
        all_polls.extend(polls)
        # labels / colours as printed on the pages (auto mode), newest page wins
        for k0, cnt in c["labels"].items():
            lid = merge.get(aliases.get(k0, k0), aliases.get(k0, k0))
            seen_labels[lid].update(cnt)
        for k0, cnt in c["colors"].items():
            lid = merge.get(aliases.get(k0, k0), aliases.get(k0, k0))
            if cnt:
                seen_colors[lid] = cnt   # cycles run oldest -> newest, so the newest colour wins
        for k in keys:
            last_seen[k] = segments[-1]["end"]
    if unmapped:
        diag.append(f"[{code}] history: unmapped party keys (top): {unmapped.most_common(25)}")

    if auto:
        overrides = {**(cfg.get("labels") or {}), **(hcfg.get("labels") or {})}
        color_over = {**(cfg.get("colors") or {}), **(hcfg.get("colors") or {})}
        ids = sorted({k for s in segments for k in s["series"]})
        lineages = []
        for k in ids:
            n = sum(1 for p in all_polls if k in p["norm"])
            col = color_over.get(k) or (seen_colors[k].most_common(1)[0][0] if seen_colors.get(k) else None)
            lineages.append({"id": k, "label": short_label(k, seen_labels.get(k), overrides),
                             "short": short_label(k, seen_labels.get(k), overrides),
                             "color": col, "article": k if (" " in k or "(" in k) and " + " not in k else None,
                             "n": n})
    lin_out = []
    for L in lineages:
        vals = [v for s in segments for v in (s["series"].get(L["id"]) or []) if v is not None]
        if not vals:
            continue
        if auto and (max(vals) < 2.0 or L["n"] < 8):
            continue
        lin_out.append({"id": L["id"], "label": L["label"], "short": L.get("short") or L["label"], "color": L.get("color"),
                        "names": L.get("names"), "family": L.get("family"), "max": round(max(vals), 2),
                        "note": L.get("note"), "article": L.get("article")})
    keep = {L["id"] for L in lin_out}
    for sgm in segments:
        sgm["series"] = {k: v for k, v in sgm["series"].items() if k in keep}
    span = {}
    for L in lin_out:
        ds = [s["start"] for s in segments if any(v is not None for v in (s["series"].get(L["id"]) or []))]
        de = [s["end"] for s in segments if any(v is not None for v in (s["series"].get(L["id"]) or []))]
        span[L["id"]] = (min(ds), max(de)) if ds else ("9999", "0000")
    overlap = lambda a, b: span[a][0] < span[b][1] and span[b][0] < span[a][1]
    pal = distinguish([(L["id"], L["color"], L["max"]) for L in lin_out], coexist=overlap)
    for L in lin_out:
        L["color"], L["color_dark"] = pal[L["id"]]["light"], pal[L["id"]]["dark"]
        L["from"], L["to"] = span[L["id"]]
    pollsters = sorted({p["pollster"] for p in all_polls})
    pidx = {n: i for i, n in enumerate(pollsters)}
    all_polls.sort(key=lambda p: p["end"])
    ids = [L["id"] for L in lin_out]
    polls_cols = {
        "t": [_days(p["end"] - (p["end"] - (p["start"] or p["end"])) / 2, origin) for p in all_polls],
        "p": [pidx[p["pollster"]] for p in all_polls],
        "n": [p["sample"] for p in all_polls],
        "v": {k: [round(p["norm"][k], 1) if k in p["norm"] else None for p in all_polls] for k in ids},
    }
    gov = governments_for(code, cfg, lin_out, origin, today, diag, governments, member_of, aliases, merge)
    diag.append(f"[{code}] history: {len(segments)} cycles, {len(all_polls)} polls, {len(lin_out)} series, "
                f"{len(gov)} government periods ({sum(1 for g in gov if g['lineage'])} matched to a series)")
    return {"code": code, "name": cfg["name"], "origin": origin.isoformat(), "lineages": lin_out,
            "governments": gov, "segments": segments, "elections": elections, "polls": polls_cols,
            "pollsters": pollsters, "auto": auto,
            "generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")}


def _norm_name(x: str) -> str:
    x = re.sub(r"\s*\([^)]*\)", "", x or "").lower()
    return re.sub(r"[^a-z0-9]+", " ", x).strip()


def governments_for(code, cfg, lin_out, origin, today, diag, governments, member_of, aliases, merge):
    """Who governed when: config/governments.yaml (past) + countries.yaml incumbents (recent).

    Each period gets the series (lineage) of the head of government's party when it can be found
    by name; otherwise the band is drawn without a party."""
    import difflib
    raw = []
    for g in governments or []:
        raw.append({"from": _d(g["from"]), "leader": g.get("leader"), "party": g.get("party"),
                    "party_short": g.get("party_short"), "caretaker": bool(g.get("caretaker")),
                    "match": [g.get("party"), g.get("party_short")] + list(g.get("match") or [])})
    inc = sorted(cfg.get("incumbents") or [], key=lambda x: _d(x["from"]))
    if inc:
        first = _d(inc[0]["from"])
        raw = [g for g in raw if g["from"] < first]
        for per in inc:
            raw.append({"from": _d(per["from"]), "leader": per.get("leader"), "party": None, "party_short": None,
                        "caretaker": bool(per.get("caretaker")), "match": list(per.get("match") or [])})
    raw.sort(key=lambda g: g["from"])
    by_norm = {}
    for L in lin_out:
        for name in (L["id"], L["label"], L.get("short")):
            if name:
                by_norm.setdefault(_norm_name(name), L["id"])
    ids = {L["id"] for L in lin_out}
    for m, lid in member_of.items():
        if lid in ids:
            by_norm.setdefault(_norm_name(m), lid)

    def find(names):
        for m in names:
            if not m:
                continue
            m2 = aliases.get(m, m)
            lid = member_of.get(m2) or merge.get(m2, m2 if m2 in ids else None)
            if lid in ids:
                return lid
            n = _norm_name(m)
            if n in by_norm:
                return by_norm[n]
        for m in names:
            if m and len(_norm_name(m)) > 6:
                best = difflib.get_close_matches(_norm_name(m), list(by_norm), n=1, cutoff=0.86)
                if best:
                    return by_norm[best[0]]
        return None

    out, unmatched = [], []
    for i, g in enumerate(raw):
        to = raw[i + 1]["from"] if i + 1 < len(raw) else None
        if to is not None and to <= origin:
            continue
        lid = find(g["match"])
        if lid is None and any(g["match"]):
            unmatched.append(f"{g['leader']} ({g['party'] or g['match']})")
        out.append({"from": g["from"].isoformat(), "to": to.isoformat() if to else None,
                    "lineage": lid, "leader": g["leader"], "party": g.get("party_short") or g.get("party"),
                    "caretaker": g["caretaker"]})
    # merge consecutive periods of the same leader and party (e.g. reshuffled cabinets)
    merged = []
    for g in out:
        if merged and merged[-1]["leader"] == g["leader"] and merged[-1]["lineage"] == g["lineage"] \
                and merged[-1]["caretaker"] == g["caretaker"]:
            merged[-1]["to"] = g["to"]
        else:
            merged.append(g)
    if unmatched:
        diag.append(f"     [{code}] government parties not matched to a series: {unmatched[:12]}")
    return merged


# ----------------------------------------------------------------------------------------------
def build_all(config_path=None, offline=False, only=None, out_dir=None, raw_dir=None, today=None):
    cfg = load_config(config_path)
    raw_dir = pathlib.Path(raw_dir or ROOT / "data" / "raw")
    out_dir = pathlib.Path(out_dir or ROOT / "site" / "data")
    proc = ROOT / "data" / "processed"
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "history").mkdir(exist_ok=True)
    proc.mkdir(parents=True, exist_ok=True)
    today = today or dt.date.today()
    diag: list[str] = []
    countries, csv_rows = [], []
    history_polls = 0
    gpath = ROOT / "config" / "governments.yaml"
    governments = (yaml.safe_load(gpath.read_text(encoding="utf-8")) or {}).get("countries", {}) if gpath.exists() else {}
    for code, ccfg in cfg["countries"].items():
        if only and code not in only:
            continue
        if ccfg.get("skip"):
            diag.append(f"[{code}] skipped: {ccfg.get('note', '')}")
            continue
        try:
            res = build_country(code, ccfg, raw_dir, offline, diag, today, csv_rows)
            if res:
                countries.append(res)
                print(f"{code}: {res['n_polls']:4d} polls, {len(res['parties']):2d} parties, "
                      f"incumbent {(res['incumbent'] or {}).get('label')}: "
                      f"{(res['stats'] or {}).get('now')} (gap {(res['stats'] or {}).get('gap_now')})")
        except Exception as e:  # keep going: one broken page must not break the dashboard
            import traceback
            diag.append(f"[{code}] FAILED: {e!r}\n{traceback.format_exc()}")
            print(f"{code}: FAILED {e!r}")
        if ccfg.get("history") or ccfg.get("history_cycles"):
            try:
                h = build_history(code, ccfg, raw_dir, offline, diag, today, governments.get(code))
                if h:
                    history_polls += sum(s["n_polls"] for s in h["segments"])
                    (out_dir / "history" / f"{code}.json").write_text(json.dumps(h, ensure_ascii=False, separators=(",", ":")))
                    print(f"{code}: history {sum(s['n_polls'] for s in h['segments'])} polls, {len(h['lineages'])} lineages")
            except Exception as e:
                import traceback
                diag.append(f"[{code}] history FAILED: {e!r}\n{traceback.format_exc()}")
                print(f"{code}: history FAILED {e!r}")
    history_codes = [code for code, c in cfg["countries"].items()
                     if (c.get("history") or c.get("history_cycles")) and (out_dir / "history" / f"{code}.json").exists()]
    not_shown = [{"code": code, "name": c["name"], "note": c.get("note", "")}
                 for code, c in cfg["countries"].items() if c.get("skip")]
    payload = {"generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
               "today": today.isoformat(), "title": cfg.get("title"), "countries": countries,
               "history": history_codes, "history_polls": history_polls, "not_shown": not_shown}
    (out_dir / "europe.json").write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")))
    with open(proc / "polls_long.csv", "w", newline="", encoding="utf-8") as f:
        if csv_rows:
            wr = csv.DictWriter(f, fieldnames=list(csv_rows[0].keys()))
            wr.writeheader()
            wr.writerows(csv_rows)
    (proc / "diagnostics.txt").write_text("\n".join(diag), encoding="utf-8")
    # context (Manifesto positions, World Bank figures) and the weekly timeline for the map slider
    from .enrich import enrich
    payload = enrich(out_dir)
    return payload
