"""Keep the dashboard current when elections happen.

    python -m polls update              refetch every page, detect elections held since the
                                        config was written, roll the polling windows over,
                                        write config/rollover.yaml, then rebuild the data
    python -m polls update --offline    same, from the cached pages only (no network)
    python -m polls update --no-build   only write config/rollover.yaml

What "rolling over" means for a country whose election has just been held (date D):
  1. the running cycle is closed at D (its page is renamed to the stable "Opinion polling for the
     <year> ... election" title when that page exists);
  2. the result in the election article's infobox becomes the closing result;
  3. if Wikipedia already has a page for the next election, it becomes the new running cycle
     (start D); until it has at least 5 polls the dashboard keeps showing the completed cycle;
  4. the outgoing government stays on as caretaker from D, so the thick line keeps following it
     until you add the new head of government to config/countries.yaml;
  5. the next election date is estimated from the term length and marked "estimated".

config/rollover.yaml is generated: edit config/countries.yaml instead. Once you have moved an
election into countries.yaml (a cycle that starts or ends on D), the rollover entry is ignored.
"""
from __future__ import annotations

import datetime as dt
import json
import pathlib
import re

import yaml

from .discover import ELECTION_NOUN, MONTHS
from .fetch import API, DEFAULT_UA, cache_paths, load_cached

ROOT = pathlib.Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"

# Maximum legislative term in years (used only to estimate the next election date).
TERM_YEARS = {"GB": 5, "IE": 5, "FR": 5, "LU": 5, "IT": 5, "MT": 5, "BG": 4, "PT": 4, "RO": 4}


def _d(x):
    if x is None or x == "":
        return None
    return x if isinstance(x, dt.date) else dt.date.fromisoformat(str(x)[:10])


# ----------------------------------------------------------------------------------------------
# Reading an election article
# ----------------------------------------------------------------------------------------------
def parse_election_article(html: str) -> dict:
    """Date, whether it has been held, and the vote shares in the infobox results table."""
    from bs4 import BeautifulSoup
    soup = BeautifulSoup(html, "lxml")
    text = re.sub(r"\s+", " ", soup.get_text(" "))
    held = bool(re.search(r"\b(were|was) held\b", text[:4000]))
    date = None
    m = re.search(rf"\b(?:were|was|will be|are to be|is to be) held[^.]{{0,120}}?\bon (\d{{1,2}}) ({MONTHS}) (\d{{4}})", text[:6000])
    if not m:
        m = re.search(rf"\bon (\d{{1,2}}) ({MONTHS}) (\d{{4}})", text[:3000])
    if m:
        date = dt.datetime.strptime(" ".join(m.groups()), "%d %B %Y").date()
    results = {}
    for tab in soup.select("table.ib-legis-elect-results, table.infobox"):
        for tr in tab.find_all("tr"):
            pct = tr.select_one(".ib-legis-elect-percent")
            if pct is None:
                continue
            try:
                v = float(pct.get_text(strip=True).replace(",", ".").rstrip("%"))
            except ValueError:
                continue
            a = next((a for a in tr.find_all("a") if a.get("title") and not a.find_parent("td", class_=re.compile("leader"))), None)
            if a is not None:
                results.setdefault(re.sub(r" \(page does not exist\)$", "", a["title"]), v)
        if results:
            break
    return {"date": date, "held_text": held, "results": results}


# ----------------------------------------------------------------------------------------------
# Talking to Wikipedia (or to the cache, offline)
# ----------------------------------------------------------------------------------------------
class Wiki:
    def __init__(self, offline: bool = False):
        self.offline = offline
        self.session = None
        if not offline:
            import requests
            self.session = requests.Session()
            self.session.headers["User-Agent"] = DEFAULT_UA

    def resolve(self, titles: list[str]) -> dict[str, str | None]:
        """requested title -> canonical title (after redirects), or None if the page is missing."""
        out = {}
        if self.offline:
            for t in titles:
                h, m = cache_paths(RAW, t)
                out[t] = json.loads(m.read_text()).get("title", t) if m.exists() else None
            return out
        for i in range(0, len(titles), 50):
            chunk = titles[i:i + 50]
            j = self.session.get(API, params={"action": "query", "titles": "|".join(chunk), "redirects": 1,
                                              "format": "json", "formatversion": 2}, timeout=60).json()
            norm = {n["from"]: n["to"] for n in j["query"].get("normalized", [])}
            red = {r["from"]: r["to"] for r in j["query"].get("redirects", [])}
            present = {p["title"] for p in j["query"]["pages"] if not p.get("missing")}
            for t in chunk:
                c = norm.get(t, t)
                c = red.get(c, c)
                out[t] = c if c in present else None
        return out

    def lead(self, title: str) -> str | None:
        """HTML of the article's lead section (infobox included)."""
        if self.offline:
            html, _ = load_cached(RAW, title)
            return html
        j = self.session.get(API, params={"action": "parse", "page": title, "prop": "text", "section": 0,
                                          "redirects": 1, "format": "json", "formatversion": 2}, timeout=60).json()
        return j.get("parse", {}).get("text")


# ----------------------------------------------------------------------------------------------
# Detection
# ----------------------------------------------------------------------------------------------
def open_cycle(c: dict) -> dict | None:
    return next((cy for cy in c.get("cycles") or [] if not cy.get("end")), None)


def held_elections(wiki: Wiki, code: str, start: dt.date, today: dt.date) -> list[dict]:
    """Legislative elections held after `start` (the opening election of the running cycle)."""
    noun = ELECTION_NOUN[code]
    years = range(start.year, today.year + 1)
    cands = [f"Next {noun}"] + [f"{y} {noun}" for y in years] + \
            [f"{m} {y} {noun}" for y in years for m in MONTHS.split("|")]
    res = wiki.resolve(cands)
    seen, out = set(), []
    for t in cands:
        canon = res.get(t)
        if not canon or canon in seen:
            continue
        seen.add(canon)
        html = wiki.lead(canon if not wiki.offline else t)
        if not html:
            continue
        info = parse_election_article(html)
        d = info["date"]
        if info["results"] and d and start + dt.timedelta(days=20) < d <= today:
            out.append({"article": canon, "date": d, "results": info["results"]})
    out.sort(key=lambda e: e["date"])
    return out


def next_cycle_page(wiki: Wiki, code: str, held: dict, closed_pages: set[str]) -> str | None:
    noun = ELECTION_NOUN[code]
    y = held["date"].year
    cands = [f"Opinion polling for the next {noun}", f"Next {noun}"]
    for k in range(1, 6):
        cands += [f"Opinion polling for the {y + k} {noun}", f"{y + k} {noun}"]
    res = wiki.resolve(cands)
    for t in cands:
        canon = res.get(t)
        if canon and canon not in closed_pages and canon != held["article"]:
            return canon
    return None


def detect(cfg: dict, today: dt.date | None = None, offline: bool = False, only=None) -> dict:
    today = today or dt.date.today()
    wiki = Wiki(offline=offline)
    out = {}
    for code, c in cfg["countries"].items():
        if c.get("skip") or code not in ELECTION_NOUN or (only and code not in only):
            continue
        cyc = open_cycle(c)
        if cyc is None:
            continue
        start = _d(cyc["start"])
        try:
            held = held_elections(wiki, code, start, today)
        except Exception as e:  # one country failing must not stop the others
            print(f"{code}: could not check ({e!r})")
            continue
        if not held:
            continue
        entries = []
        closed = {cy["page"] for cy in c.get("cycles") or []}
        for h in held:
            stable = f"Opinion polling for the {h['article']}"
            r = wiki.resolve([stable, cyc["page"]])
            closed_page = r.get(stable) or cyc["page"]
            closed.add(closed_page)
            nxt = next_cycle_page(wiki, code, h, closed | {cyc["page"]})
            term = TERM_YEARS.get(code, 4)
            est = h["date"].replace(year=h["date"].year + term) if not (h["date"].month == 2 and h["date"].day == 29) \
                else h["date"].replace(year=h["date"].year + term, day=28)
            entries.append({"date": h["date"].isoformat(), "article": h["article"],
                            "closed_page": closed_page, "next_page": nxt,
                            "result": {k: v for k, v in h["results"].items()},
                            "next_election": est.isoformat()})
            print(f"{code}: election held {h['date']} ({h['article']}); "
                  f"closed cycle page: {closed_page}; next page: {nxt or 'not yet on Wikipedia'}")
        out[code] = {"held": entries}
    return out


# ----------------------------------------------------------------------------------------------
# Applying rollover.yaml to the loaded config
# ----------------------------------------------------------------------------------------------
def apply_rollover(cfg: dict, roll: dict) -> None:
    for code, r in (roll.get("countries") or {}).items():
        c = cfg["countries"].get(code)
        if not c:
            continue
        for h in sorted(r.get("held") or [], key=lambda e: e["date"]):
            d = _d(h["date"])
            cycles = c.setdefault("cycles", [])
            if any(_d(cy.get("end")) == d or _d(cy["start"]) == d for cy in cycles):
                continue   # already in countries.yaml
            cyc = open_cycle(c)
            if cyc is None or _d(cyc["start"]) >= d:
                continue
            cyc["page"] = h.get("closed_page") or cyc["page"]
            cyc["end"] = d
            if h.get("result"):
                cyc["end_result"] = h["result"]
            if h.get("next_page"):
                cycles.insert(0, {"page": h["next_page"], "start": d, "start_result": h.get("result") or None})
            inc = sorted(c.get("incumbents") or [], key=lambda x: _d(x["from"]))
            if inc and not any(_d(x["from"]) >= d for x in inc):
                last = inc[-1]
                leader = re.sub(r"\s*\([^)]*\)", "", str(last.get("leader") or "")).strip()
                c["incumbents"] = inc + [{
                    "from": d, "match": list(last.get("match") or []),
                    "leader": f"{leader} (caretaker)" if leader else "caretaker", "title": last.get("title"),
                    "caretaker": True,
                    "note": f"Election held {d.isoformat()}; the outgoing government stays on until a new one "
                            f"is formed (edit config/countries.yaml when it is)."}]
            c["next_election"] = _d(h.get("next_election")) or c.get("next_election")
            c["next_election_status"] = "estimated"
            c["rolled_over"] = d.isoformat()


def write_rollover(roll: dict, today: dt.date) -> pathlib.Path:
    path = ROOT / "config" / "rollover.yaml"
    head = ("# GENERATED by `python -m polls update` on " + today.isoformat() + ".\n"
            "# Elections held since config/countries.yaml was last edited. Do not edit by hand:\n"
            "# move the change into countries.yaml (new cycle, new head of government) instead.\n")
    path.write_text(head + yaml.safe_dump({"generated": today.isoformat(), "countries": roll},
                                          allow_unicode=True, sort_keys=False, width=140), encoding="utf-8")
    return path


def run_update(offline: bool = False, build: bool = True, only=None, today: dt.date | None = None):
    from .build import build_site, load_config
    from .fetch import fetch_page
    today = today or dt.date.today()
    base = load_config(generated=False)
    if not offline:
        print("Refreshing pages ...")
        for code, c in base["countries"].items():
            if c.get("skip") or (only and code not in only):
                continue
            for cyc in (c.get("cycles") or [])[:2]:
                try:
                    fetch_page(cyc["page"], RAW, max_age_hours=0)
                except Exception as e:
                    print(f"  ! {code}: {cyc['page']}: {e}")
    print("Checking for elections held since the config was written ...")
    roll = detect(base, today, offline=offline, only=only)
    path = write_rollover(roll, today)
    print(f"wrote {path} ({len(roll)} countr{'y' if len(roll) == 1 else 'ies'} rolled over)")
    if not offline:
        cfg = load_config()
        for code, c in cfg["countries"].items():
            if code in roll:
                for cyc in (c.get("cycles") or [])[:2]:
                    fetch_page(cyc["page"], RAW, max_age_hours=0)
    if build:
        build_site(offline=offline, today=today)
