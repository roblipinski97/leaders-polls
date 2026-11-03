"""How parties are classified, from the Manifesto Project (MARPOR).

For every coded election manifesto the dataset gives the share of its quasi-sentences in 56
policy categories, a party family (constant over time) and several summary scales. The dashboard
uses the party family and the measures in VARS below:
  rile      right-left: 13 right categories minus 13 left ones (Laver & Budge 1992), -100..+100
  planeco   market regulation + economic planning + controlled economy   (per403+per404+per412)
  markeco   free market economy + economic orthodoxy                      (per401+per414)
  welfare   equality + welfare state expansion                            (per503+per504)
  intpeace  peace + military negative + foreign special relations negative (per102+per105+per106)
  eu        European Community/Union positive minus negative              (per108-per110)
  nation    national way of life positive minus negative                  (per601-per602)
  multicult multiculturalism positive minus negative                      (per607-per608)
  laworder  law and order                                                  (per605)
  environ   environmental protection                                       (per501)
The value used on a date is that of the manifesto in force then (the latest before it, or the
first one when the party had none yet).

Matching Wikipedia's party keys to Manifesto parties is automatic where the English names or the
abbreviations agree, and set by hand in config/ideology_overrides.yaml otherwise. Parties without
a coded manifesto (most new parties) get no score unless the overrides say which coded party they
continue (`inherit`). Every match is listed in data/processed/ideology_matches.csv.

Data: Lehmann, P. et al. (2026). The Manifesto Data Collection. Manifesto Project
(MRG/CMP/MARPOR). Version 2026a. WZB / IfDem. https://doi.org/10.25522/manifesto.mpds.2026a
"""
from __future__ import annotations

import csv
import datetime as dt
import difflib
import pathlib
import re
from collections import defaultdict

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[1]
MPDS = ROOT / "data" / "external" / "MPDS_2026a.csv"

COUNTRY = {
    "GB": "United Kingdom", "IE": "Ireland", "FR": "France", "NL": "Netherlands", "LU": "Luxembourg",
    "DE": "Germany", "AT": "Austria", "DK": "Denmark", "SE": "Sweden", "NO": "Norway", "FI": "Finland",
    "IS": "Iceland", "EE": "Estonia", "LV": "Latvia", "LT": "Lithuania", "ES": "Spain", "PT": "Portugal",
    "IT": "Italy", "MT": "Malta", "GR": "Greece", "PL": "Poland", "CZ": "Czech Republic", "SK": "Slovakia",
    "HU": "Hungary", "SI": "Slovenia", "HR": "Croatia", "RO": "Romania", "BG": "Bulgaria", "RS": "Serbia",
    "ME": "Montenegro", "MD": "Moldova",
}
# party families, as named in the MPDS codebook
PARFAM = {10: "Ecological", 20: "Socialist or other left", 30: "Social democratic", 40: "Liberal",
          50: "Christian democratic", 60: "Conservative", 70: "Nationalist and radical right", 80: "Agrarian",
          90: "Ethnic and regional", 95: "Special issue", 98: "Electoral alliance of diverse origin", 999: "Missing"}


def _num(r, col):
    v = r.get(col)
    return float(v) if v not in (None, "", "NA") else 0.0


# measure -> how it is computed from one MPDS row (order matters: the timeline stores values by position)
VARS = {
    "rile": lambda r: _num(r, "rile"),
    "planeco": lambda r: _num(r, "planeco"),
    "markeco": lambda r: _num(r, "markeco"),
    "welfare": lambda r: _num(r, "welfare"),
    "intpeace": lambda r: _num(r, "intpeace"),
    "eu": lambda r: _num(r, "per108") - _num(r, "per110"),
    "nation": lambda r: _num(r, "per601") - _num(r, "per602"),
    "multicult": lambda r: _num(r, "per607") - _num(r, "per608"),
    "laworder": lambda r: _num(r, "per605"),
    "environ": lambda r: _num(r, "per501"),
}
VAR_ORDER = list(VARS)


def _norm(s: str) -> str:
    s = re.sub(r"\s*\([^)]*\)", "", s or "")
    s = s.lower().replace("&", " and ").replace("’", "'")
    s = re.sub(r"\bthe\b", " ", s)
    return re.sub(r"[^a-z0-9ąćęłńóśźżäöüåæøéèáíúčšžťďňřěýőűâîăşţ]+", " ", s).strip()


def load_mpds(path: pathlib.Path = MPDS, since: dt.date = dt.date(1985, 1, 1)) -> dict:
    """country code -> {party code: {"names", "abbrevs", "parfam", "series": [(date, {measure: value}, pervote)]}}"""
    inv = {v: k for k, v in COUNTRY.items()}
    out: dict[str, dict] = defaultdict(dict)
    with open(path, encoding="utf-8") as f:
        for r in csv.DictReader(f):
            cc = inv.get(r["countryname"])
            if not cc:
                continue
            try:
                d = dt.datetime.strptime(r["edate"], "%d/%m/%Y").date()
            except ValueError:
                continue
            if d < since or r["rile"] in ("", "NA"):
                continue
            p = out[cc].setdefault(int(r["party"]), {"names": [], "abbrevs": [], "parfam": None, "series": []})
            if r["partyname"] not in ("", "NA") and r["partyname"] not in p["names"]:
                p["names"].append(r["partyname"])
            if r["partyabbrev"] not in ("", "NA") and r["partyabbrev"] not in p["abbrevs"]:
                p["abbrevs"].append(r["partyabbrev"])
            p["parfam"] = int(float(r["parfam"])) if r["parfam"] not in ("", "NA") else p["parfam"]
            vals = {k: round(f(r), 2) for k, f in VARS.items()}
            p["series"].append((d, vals, float(r["pervote"]) if r["pervote"] not in ("", "NA") else None))
    for parties in out.values():
        for p in parties.values():
            p["series"].sort(key=lambda x: x[0])
    return out


def load_overrides(path: pathlib.Path | None = None) -> dict:
    path = path or ROOT / "config" / "ideology_overrides.yaml"
    if not path.exists():
        return {}
    return yaml.safe_load(path.read_text(encoding="utf-8")) or {}


class Matcher:
    """Finds the Manifesto party for a dashboard party key within one country."""

    def __init__(self, mpds: dict, overrides: dict):
        self.mpds, self.over = mpds, overrides

    def match(self, cc: str, key: str, labels: list[str]) -> tuple[list[int], str]:
        """-> (Manifesto party codes, how it was matched)."""
        parties = self.mpds.get(cc, {})
        over_cc = self.over.get(cc) or {}
        if key in over_cc:
            ov = over_cc[key]
            if ov in (None, "none", False):
                return [], "override: none"
            if isinstance(ov, dict):
                if ov.get("inherit"):
                    codes, how = self.match(cc, ov["inherit"], [])
                    return codes, f"inherited from {ov['inherit']}" + (f": {ov['note']}" if ov.get("note") else "")
                codes = ov.get("codes") or ([ov["code"]] if ov.get("code") else [])
                how = "inherited" if ov.get("inherited") else "override"
                return [int(c) for c in codes], how + (f": {ov['note']}" if ov.get("note") else "")
            if isinstance(ov, (int, str)) and str(ov).isdigit():
                return [int(ov)], "override"
            if isinstance(ov, list):
                return [int(c) for c in ov], "override"
            return [], "override: none"
        if not parties:
            return [], "country not in Manifesto data"
        if " + " in key:
            return [], "joint list (no single manifesto)"
        nk = _norm(key)
        # 1. exact English name
        for code, p in parties.items():
            if any(_norm(n) == nk for n in p["names"]):
                return [code], "name"
        # 2. abbreviation equals the column label
        labs = {re.sub(r"[\s.]+", "", l).lower() for l in labels + [key] if l and len(l) <= 12}
        hits = [code for code, p in parties.items()
                if any(re.sub(r"[\s.]+", "", a).lower() in labs for a in p["abbrevs"])]
        if len(hits) == 1:
            return hits, "abbreviation"
        # 3. close English name
        names = {(_norm(n)): code for code, p in parties.items() for n in p["names"]}
        best = difflib.get_close_matches(nk, list(names), n=1, cutoff=0.88)
        if best and len(nk) > 6:
            return [names[best[0]]], f"similar name ({best[0]})"
        return [], "no match"

    def series(self, cc: str, codes: list[int]) -> list[tuple[dt.date, dict]]:
        """[(election date, {measure: value})]; two codes coded at one election (rare) are averaged."""
        parties = self.mpds.get(cc, {})
        by_d = defaultdict(list)
        for c in codes:
            for d, vals, _ in parties.get(c, {}).get("series", []):
                by_d[d].append(vals)
        return [(d, {k: round(sum(v[k] for v in vs) / len(vs), 2) for k in VAR_ORDER}) for d, vs in sorted(by_d.items())]

    def describe(self, cc: str, codes: list[int]) -> str:
        parties = self.mpds.get(cc, {})
        return "; ".join(f"{c} {parties[c]['names'][-1]}" + (f" ({parties[c]['abbrevs'][-1]})" if parties[c]['abbrevs'] else "")
                         for c in codes if c in parties)

    def parfam(self, cc: str, codes: list[int]) -> int | None:
        """Party family code of the most recently coded of the parties."""
        parties = self.mpds.get(cc, {})
        coded = [(parties[c]["series"][-1][0], parties[c]["parfam"]) for c in codes if c in parties and parties[c]["parfam"]]
        return max(coded)[1] if coded else None


def value_at(series, when: dt.date, measure: str = "rile"):
    """The manifesto value in force on a date."""
    if not series:
        return None
    before = [v[measure] for d, v in series if d <= when]
    return before[-1] if before else series[0][1][measure]


def write_report(rows: list[dict]):
    path = ROOT / "data" / "processed" / "ideology_matches.csv"
    path.parent.mkdir(parents=True, exist_ok=True)
    seen = {}
    for r in rows:   # one row per (country, key), keeping the largest share seen
        k = (r["country"], r["key"])
        if k not in seen or (r["max_share"] or 0) > (seen[k]["max_share"] or 0):
            seen[k] = r
    with open(path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=["country", "key", "label", "max_share", "how", "manifesto", "family", "rile_latest", "rile_year"])
        w.writeheader()
        for r in sorted(seen.values(), key=lambda r: (r["country"], -(r["max_share"] or 0))):
            w.writerow(r)
    return path
