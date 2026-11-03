"""Find the Wikipedia pages that hold past polling, and write config/history.yaml.

Two steps, both re-runnable:

    python -m polls discover            # 1. ask the Wikipedia API which election and polling
                                        #    pages exist -> data/discovery/discovery_<date>.json
    python -m polls discover --plan     # 2. turn the newest discovery file into config/history.yaml

Step 2 is what the build reads: one list of cycles per country, each cycle being a page plus the
election dates that open and close it. config/history.yaml is generated, so do not edit it by hand;
put fixes in DATE_FIXES / SKIP_PAGES below, or in config/countries.yaml, then re-run step 2.

How a cycle is chosen for an election E:
  * "Opinion polling for the E" if that page exists (kind = polling), else
  * the article "E" itself (kind = article), whose "Opinion polls" section is read, if it has one.
The cycle runs from the previous election (any national legislative election in the list) to E.
"""
from __future__ import annotations

import datetime as dt
import json
import pathlib
import re
import time

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[1]
DISC_DIR = ROOT / "data" / "discovery"

# How each country's legislative elections are titled on English Wikipedia.
ELECTION_NOUN = {
    "GB": "United Kingdom general election", "IE": "Irish general election",
    "FR": "French legislative election", "NL": "Dutch general election",
    "LU": "Luxembourg general election", "DE": "German federal election",
    "AT": "Austrian legislative election", "DK": "Danish general election",
    "SE": "Swedish general election", "NO": "Norwegian parliamentary election",
    "FI": "Finnish parliamentary election", "IS": "Icelandic parliamentary election",
    "EE": "Estonian parliamentary election", "LV": "Latvian parliamentary election",
    "LT": "Lithuanian parliamentary election", "ES": "Spanish general election",
    "PT": "Portuguese legislative election", "IT": "Italian general election",
    "MT": "Maltese general election", "GR": "Greek parliamentary election",
    "PL": "Polish parliamentary election", "CZ": "Czech parliamentary election",
    "SK": "Slovak parliamentary election", "HU": "Hungarian parliamentary election",
    "SI": "Slovenian parliamentary election", "HR": "Croatian parliamentary election",
    "RO": "Romanian parliamentary election", "BG": "Bulgarian parliamentary election",
    "RS": "Serbian parliamentary election", "ME": "Montenegrin parliamentary election",
    "MD": "Moldovan parliamentary election",
}

# Dates the automatic lookup missed or got wrong (first round for two-round systems).
DATE_FIXES = {
    "2017 French legislative election": "2017-06-11",
    "2024 French legislative election": "2024-06-30",
    "2007 French legislative election": "2007-06-10",
    "2015 United Kingdom general election": "2015-05-07",
    "2024 United Kingdom general election": "2024-07-04",
    "2002 Portuguese legislative election": "2002-03-17",
    "2005 Portuguese legislative election": "2005-02-20",
    "2009 Portuguese legislative election": "2009-09-27",
    "2011 Portuguese legislative election": "2011-06-05",
    "2015 Portuguese legislative election": "2015-10-04",
    "2002 Irish general election": "2002-05-17",
    "2007 Irish general election": "2007-05-24",
    "2016 Irish general election": "2016-02-26",
    "2020 Irish general election": "2020-02-08",
    "2013 German federal election": "2013-09-22",
}
# Overview pages that cover several elections in one year: the per-election pages are used instead.
OVERVIEW_PAGES = {
    "2021 Bulgarian parliamentary election", "2024 Bulgarian parliamentary election",
    "2015 Greek parliamentary election", "Opinion polling for the 2023 Greek legislative election",
    "2019 Spanish general election", "2009 Moldovan parliamentary election",
}
# pages not read (the election still counts as a cycle boundary)
SKIP_PAGES = OVERVIEW_PAGES | {
    # poll table whose header does not line up with its rows (every value spans two columns)
    "2016 Romanian parliamentary election",
}
# Elections the title search did not return (needed as cycle boundaries).
EXTRA_ELECTIONS = {
    "BG": [["November 2021 Bulgarian parliamentary election", "2021-11-14"]],
}
EARLIEST = dt.date(1990, 1, 1)   # long view starts no earlier than this


# ----------------------------------------------------------------------------------------------
# Step 1: online discovery (MediaWiki API)
# ----------------------------------------------------------------------------------------------
MONTHS = "January|February|March|April|May|June|July|August|September|October|November|December"


def _api(session, **params):
    params.update(format="json", formatversion=2)
    for attempt in range(4):
        r = session.get("https://en.wikipedia.org/w/api.php", params=params, timeout=60)
        if r.status_code == 429:
            time.sleep(5 * (attempt + 1))
            continue
        r.raise_for_status()
        return r.json()
    r.raise_for_status()


def _infobox_date(html: str) -> str | None:
    """Election date from the article lead: the first ISO date in a <span class="bday"> or the
    first 'D Month YYYY' in the first paragraph."""
    m = re.search(r'class="[^"]*\b(?:bday|dtstart)\b[^"]*"[^>]*>(\d{4}-\d{2}-\d{2})', html)
    if m:
        return m.group(1)
    text = re.sub(r"<[^>]+>", " ", html)
    m = re.search(rf"\b(\d{{1,2}}) ({MONTHS}) (\d{{4}})\b", text)
    if m:
        return dt.datetime.strptime(" ".join(m.groups()), "%d %B %Y").date().isoformat()
    m = re.search(rf"\b({MONTHS}) (\d{{1,2}}), (\d{{4}})\b", text)
    if m:
        return dt.datetime.strptime(" ".join(m.groups()), "%B %d %Y").date().isoformat()
    return None


def discover_online(codes=None, user_agent=None) -> dict:
    import requests
    from .fetch import DEFAULT_UA
    s = requests.Session()
    s.headers["User-Agent"] = user_agent or DEFAULT_UA
    out = {"generated": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"),
           "edates": {}, "plan": {}}
    for cc, noun in ELECTION_NOUN.items():
        if codes and cc not in codes:
            continue
        titles = set()
        sroffset = 0
        while True:
            j = _api(s, action="query", list="search", srsearch=f'intitle:"{noun}"', srlimit=500,
                     sroffset=sroffset, srnamespace=0)
            for hit in j["query"]["search"]:
                t = hit["title"]
                if re.fullmatch(rf"(?:(?:{MONTHS}) )?\d{{4}} {re.escape(noun)}", t):
                    titles.add(t)
            if "continue" not in j:
                break
            sroffset = j["continue"]["sroffset"]
        edates = []
        for t in sorted(titles):
            d = DATE_FIXES.get(t)
            if not d:
                j = _api(s, action="parse", page=t, prop="text", section=0, redirects=1)
                d = _infobox_date(j.get("parse", {}).get("text", ""))
            edates.append([t, d])
            time.sleep(0.2)
        edates.sort(key=lambda x: (x[1] or x[0][-4:]))
        out["edates"][cc] = edates
        # which have a dedicated polling page?
        cand = [f"Opinion polling for the {t}" for t, _ in edates]
        exists = set()
        for i in range(0, len(cand), 50):
            j = _api(s, action="query", titles="|".join(cand[i:i + 50]), redirects=1)
            redirected = {r["from"]: r["to"] for r in j["query"].get("redirects", [])}
            for p in j["query"]["pages"]:
                if not p.get("missing"):
                    exists.add(p["title"])
            for a, b in redirected.items():
                if b in exists and not b.startswith(("Opinion polling for the next", )):
                    exists.add(a)
        plan = []
        for t, d in edates:
            pt = f"Opinion polling for the {t}"
            plan.append({"election": t, "date": d, "page": pt if pt in exists else t,
                         "kind": "polling" if pt in exists else "article"})
        out["plan"][cc] = plan
        print(f"{cc}: {len(edates)} elections, {sum(p['kind'] == 'polling' for p in plan)} polling pages")
    DISC_DIR.mkdir(parents=True, exist_ok=True)
    path = DISC_DIR / f"discovery_{dt.date.today().isoformat()}.json"
    path.write_text(json.dumps(out, ensure_ascii=False, indent=1), encoding="utf-8")
    print("wrote", path)
    return out


# ----------------------------------------------------------------------------------------------
# Step 2: plan -> config/history.yaml
# ----------------------------------------------------------------------------------------------
def newest_discovery() -> pathlib.Path:
    files = sorted(DISC_DIR.glob("*discovery_*.json"), key=lambda p: p.stem.split("_")[-1])
    if not files:
        raise FileNotFoundError("no data/discovery/*discovery_*.json; run `python -m polls discover` first")
    return files[-1]


def make_history_plan(disc: dict, countries: dict, today: dt.date | None = None) -> dict:
    today = today or dt.date.today()
    out = {}
    for cc, cfg in countries.items():
        if cfg.get("skip") or cc not in disc.get("plan", {}):
            continue
        fixed = {t: DATE_FIXES.get(t, d)
                 for t, d in disc.get("edates", {}).get(cc, []) + EXTRA_ELECTIONS.get(cc, [])}
        for e in disc["plan"][cc]:
            fixed.setdefault(e["election"], DATE_FIXES.get(e["election"], e["date"]))
            if e["election"] in DATE_FIXES:
                fixed[e["election"]] = DATE_FIXES[e["election"]]
        # every known election date, used to find the start of each cycle
        dates = sorted({dt.date.fromisoformat(d) for t, d in fixed.items() if d and t not in OVERVIEW_PAGES})
        configured = {c["page"] for c in cfg.get("cycles") or []}
        cycles = []
        for e in disc["plan"][cc]:
            d = fixed.get(e["election"]) or e["date"]
            if not d or e["page"] in SKIP_PAGES or e["election"] in SKIP_PAGES:
                continue
            end = dt.date.fromisoformat(d)
            if end > today:
                continue                     # future election: its page is the current cycle
            prev = [x for x in dates if x < end - dt.timedelta(days=20)]
            if not prev:
                continue
            start = prev[-1]
            if start < EARLIEST or e["page"] in configured:
                continue
            c = {"page": e["page"], "start": start.isoformat(), "end": end.isoformat(),
                 "kind": e["kind"]}
            if e["kind"] == "article":
                c["require_headings"] = "(?i)opinion poll|polling|polls"
            cycles.append(c)
        cycles.sort(key=lambda c: c["start"], reverse=True)
        out[cc] = {"cycles": cycles}
    return out


def write_history_yaml(plan: dict, source: str):
    path = ROOT / "config" / "history.yaml"
    head = ("# GENERATED by `python -m polls discover --plan` from " + source + "\n"
            "# Past polling cycles for the long-run view. Do not edit by hand: fix dates in\n"
            "# polls/discover.py (DATE_FIXES, SKIP_PAGES) or per-cycle options in countries.yaml.\n")
    body = yaml.safe_dump({"countries": plan}, allow_unicode=True, sort_keys=True, width=140)
    path.write_text(head + body, encoding="utf-8")
    n = sum(len(v["cycles"]) for v in plan.values())
    print(f"wrote {path} ({n} past cycles in {len(plan)} countries)")
