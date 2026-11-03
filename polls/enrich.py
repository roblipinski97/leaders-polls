"""Second build step: add context to the built data, and the weekly timeline behind the map slider.

    python -m polls enrich        (also run at the end of `python -m polls build`)

Reads   site/data/europe.json, site/data/history/<CC>.json
Adds    to every party: its Manifesto Project left-right position (RILE) where it can be matched
        to every country: population and GDP per capita, PPP (World Bank WDI)
Writes  site/data/timeline.json: for each country and each week since its first poll on Wikipedia,
        every party's trend value, the head of government's party, and each party's RILE in force,
        so the map can be redrawn for any past date without loading the full histories.
        data/processed/ideology_matches.csv: how every party was matched (check this)
        data/processed/manifesto_cache.json: the matched Manifesto data, so that a machine without
        the Manifesto Project CSV (for example the GitHub workflow, since the raw dataset is kept out
        of the public repository) still gets every party's family and positions
"""
from __future__ import annotations

import datetime as dt
import json
import pathlib

from .ideology import MPDS, PARFAM, VAR_ORDER, Matcher, load_mpds, load_overrides, write_report

ROOT = pathlib.Path(__file__).resolve().parents[1]
ISO3 = {"GB": "GBR", "IE": "IRL", "FR": "FRA", "NL": "NLD", "LU": "LUX", "DE": "DEU", "AT": "AUT", "DK": "DNK",
        "SE": "SWE", "NO": "NOR", "FI": "FIN", "IS": "ISL", "EE": "EST", "LV": "LVA", "LT": "LTU", "ES": "ESP",
        "PT": "PRT", "IT": "ITA", "MT": "MLT", "GR": "GRC", "PL": "POL", "CZ": "CZE", "SK": "SVK", "HU": "HUN",
        "SI": "SVN", "HR": "HRV", "RO": "ROU", "BG": "BGR", "RS": "SRB", "ME": "MNE", "MD": "MDA",
        "BE": "BEL", "CH": "CHE", "CY": "CYP"}
STEP = 7


def _d(s):
    return dt.date.fromisoformat(str(s)[:10])


def enrich(site_data: pathlib.Path | None = None, today: dt.date | None = None) -> dict:
    site_data = pathlib.Path(site_data or ROOT / "site" / "data")
    europe = json.loads((site_data / "europe.json").read_text(encoding="utf-8"))
    today = _d(europe.get("today") or dt.date.today())

    # ---------------------------------------------------------------- World Bank context
    wb_path = ROOT / "data" / "external" / "worldbank.json"
    wb = json.loads(wb_path.read_text(encoding="utf-8")) if wb_path.exists() else {"data": {}}
    for c in europe["countries"]:
        row = wb["data"].get(ISO3.get(c["code"], ""), {})
        pop, gdp = row.get("SP.POP.TOTL"), row.get("NY.GDP.PCAP.PP.CD")
        c["population"] = {"value": pop["value"], "year": pop["year"]} if pop else None
        c["gdp_pc_ppp"] = {"value": round(gdp["value"]), "year": gdp["year"]} if gdp else None
    europe["worldbank_source"] = wb.get("source")

    # ---------------------------------------------------------------- Manifesto positions
    report = []
    matcher = Matcher(load_mpds(), load_overrides()) if MPDS.exists() else None
    cache_path = ROOT / "data" / "processed" / "manifesto_cache.json"
    cache = {} if matcher else (json.loads(cache_path.read_text(encoding="utf-8")) if cache_path.exists() else {})
    if matcher is None:
        print("enrich: " + (f"no {MPDS.name}; using the saved matches in {cache_path.name}" if cache else f"no {MPDS.name} and no saved matches; parties get no Manifesto data"))

    def position(cc, key, labels, max_share, kind="p"):
        ck = f"{kind}|{cc}|{key}"
        if matcher is None:
            return cache.get(ck)
        codes, how = matcher.match(cc, key, labels)
        series = matcher.series(cc, codes)
        fam = matcher.parfam(cc, codes)
        report.append({"country": cc, "key": key, "label": labels[0] if labels else key, "max_share": max_share,
                       "how": how, "manifesto": matcher.describe(cc, codes),
                       "family": PARFAM.get(fam, "") if fam else "",
                       "rile_latest": series[-1][1]["rile"] if series else "", "rile_year": series[-1][0].year if series else ""})
        if not series:
            return None
        out = {"series": [[d.isoformat(), v] for d, v in series], "how": how,
               "inherited": how.startswith("inherited"), "manifesto": matcher.describe(cc, codes), "family": fam}
        cache[ck] = out
        return out

    for c in europe["countries"]:
        for p in c["parties"]:
            pos = position(c["code"], p["key"], [p["label"]], p.get("max") or p.get("result") or 0)
            for k in ("rile", "rile_year", "rile_inherited", "rile_note", "manifesto", "family", "mp", "mp_year", "mp_inherited", "mp_note"):
                p.pop(k, None)
            if pos:
                p["mp"] = pos["series"][-1][1]                  # latest manifesto, all measures
                p["mp_year"] = int(pos["series"][-1][0][:4])
                p["mp_inherited"] = pos["inherited"]
                p["mp_note"] = pos["how"] if pos["how"].startswith("inherited") else None
                p["manifesto"] = pos["manifesto"]
            else:
                p["mp"] = None
            p["family"] = pos["family"] if pos else None
    europe["manifesto_measures"] = VAR_ORDER
    europe["party_families"] = {str(k): v for k, v in PARFAM.items()}
    europe["manifesto_source"] = ("Manifesto Project Dataset (MPDS) version 2026a, Lehmann et al. 2026, "
                                  "https://doi.org/10.25522/manifesto.mpds.2026a") if (matcher or cache) else None

    # ---------------------------------------------------------------- weekly timeline
    hist = {}
    for f in sorted((site_data / "history").glob("*.json")):
        h = json.loads(f.read_text(encoding="utf-8"))
        hist[h["code"]] = h
    if not hist:
        (site_data / "europe.json").write_text(json.dumps(europe, ensure_ascii=False, separators=(",", ":")))
        return europe
    start = min(_d(h["origin"]) for h in hist.values())
    n = (today - start).days // STEP + 1
    grid = [start + dt.timedelta(days=STEP * i) for i in range(n)]
    idx = lambda d: (d - start).days // STEP
    current = {c["code"]: c for c in europe["countries"]}
    tl = {"start": start.isoformat(), "step": STEP, "n": n, "today": today.isoformat(), "measures": VAR_ORDER, "countries": {}}
    for cc, h in hist.items():
        origin = _d(h["origin"])
        lin = h["lineages"]
        lid_index = {L["id"]: i for i, L in enumerate(lin)}
        values = [[None] * n for _ in lin]
        last_seen = [None] * len(lin)
        for s in sorted(h["segments"], key=lambda s: s["start"]):
            s0, s1 = _d(s["start"]), _d(s["end"])
            days = s["days"]
            open_seg = s is h["segments"][-1] and s1 >= today - dt.timedelta(days=120)
            for li, L in enumerate(lin):
                arr = s["series"].get(L["id"])
                if not arr:
                    continue
                for k, dd in enumerate(days):
                    v = arr[k]
                    if v is None:
                        continue
                    d = origin + dt.timedelta(days=dd)
                    i = idx(d)
                    if 0 <= i < n:
                        values[li][i] = round(v, 1)
                        last_seen[li] = i
                # fill weekly gaps inside the segment (segment grids are weekly from their own start)
            # carry the last values of the running term forward to today (polls end before today)
            if open_seg:
                for li in range(len(lin)):
                    j = last_seen[li]
                    if j is not None and idx(s1) - 2 <= j:
                        for i in range(j + 1, min(n, j + 1 + 13)):
                            values[li][i] = values[li][j]
        # bridge short holes (up to 26 weeks) by straight lines: the smoother leaves a gap where polls
        # are far apart, and the map would otherwise blink on and off between polls
        for arr in values:
            last = None
            for i in range(n):
                if arr[i] is None:
                    continue
                if last is not None and 1 < i - last <= 27:
                    for k in range(last + 1, i):
                        arr[k] = round(arr[last] + (arr[i] - arr[last]) * (k - last) / (i - last), 1)
                last = i
        packed, lin_out = [], []
        for li, L in enumerate(lin):
            arr = values[li]
            nz = [i for i, v in enumerate(arr) if v is not None]
            if not nz:
                continue
            a, b = nz[0], nz[-1]
            packed.append([a, arr[a:b + 1]])
            pos = position(cc, L["id"], [L.get("short") or L["label"], L["label"]], L.get("max") or 0, kind="l")
            lin_out.append({"id": L["id"], "label": L["label"], "short": L.get("short") or L["label"],
                            "color": L["color"], "color_dark": L["color_dark"],
                            # [[week index of the election, [measures in manifesto_measures order]], ...]
                            "mp": [[idx(_d(d)), [v[k] for k in VAR_ORDER]] for d, v in pos["series"]] if pos else None,
                            "fam": pos["family"] if pos else None,
                            "inherited": bool(pos and pos["inherited"])})
            L.pop("rile", None)
            L["mp"] = pos["series"] if pos else None
            L["family"] = pos["family"] if pos else None
        keep_ids = [L["id"] for L in lin_out]
        gov = []
        for g in h.get("governments") or []:
            a = max(0, idx(_d(g["from"])))
            b = min(n - 1, idx(_d(g["to"])) if g.get("to") else n - 1)
            if b < 0 or a > n - 1:
                continue
            li = keep_ids.index(g["lineage"]) if g.get("lineage") in keep_ids else -1
            gov.append([a, b, li, g.get("leader") or "", 1 if g.get("caretaker") else 0])
        elections = sorted(h.get("elections", {}).keys())
        cur = current.get(cc)
        if cur:
            nxt = cur.get("upcoming_next_election") if cur.get("fallback_completed_cycle") else cur.get("next_election")
            if nxt and nxt not in elections:
                elections.append(nxt)
        tl["countries"][cc] = {"lineages": lin_out, "v": packed, "gov": gov, "elections": sorted(elections)}
        (site_data / "history" / f"{cc}.json").write_text(json.dumps(h, ensure_ascii=False, separators=(",", ":")))
    (site_data / "timeline.json").write_text(json.dumps(tl, ensure_ascii=False, separators=(",", ":")))
    (site_data / "europe.json").write_text(json.dumps(europe, ensure_ascii=False, separators=(",", ":")))
    path = write_report(report) if report else None
    if matcher:
        cache_path.write_text(json.dumps(cache, ensure_ascii=False, separators=(",", ":"), sort_keys=True), encoding="utf-8")
    matched = sum(1 for r in report if r["rile_latest"] != "")
    print(f"enrich: timeline {n} weeks x {len(tl['countries'])} countries; "
          + (f"{matched}/{len(report)} party entries have a Manifesto position" + (f" (see {path})" if path else "")
             if matcher else f"Manifesto data from {len(cache)} saved matches"))
    return europe
