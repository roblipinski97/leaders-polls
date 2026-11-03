"""Refresh data/external/worldbank.json (population, GDP per capita PPP) from the World Bank API.

    python -m polls worldbank

World Development Indicators: SP.POP.TOTL (population, total) and NY.GDP.PCAP.PP.CD (GDP per
capita, PPP, current international $), latest year with data (mrnev=1) for every country shown.
"""
from __future__ import annotations

import datetime as dt
import json
import pathlib

from .enrich import ISO3
from .fetch import DEFAULT_UA

ROOT = pathlib.Path(__file__).resolve().parents[1]
INDICATORS = {"SP.POP.TOTL": "Population, total", "NY.GDP.PCAP.PP.CD": "GDP per capita, PPP (current international $)"}


def refresh(path: pathlib.Path | None = None) -> dict:
    import requests
    path = path or ROOT / "data" / "external" / "worldbank.json"
    url = (f"https://api.worldbank.org/v2/country/{';'.join(sorted(set(ISO3.values())))}/indicator/"
           f"{';'.join(INDICATORS)}?source=2&format=json&mrnev=1&per_page=1000")
    r = requests.get(url, headers={"User-Agent": DEFAULT_UA}, timeout=60)
    r.raise_for_status()
    meta, rows = r.json()
    out = {"source": f"World Bank, World Development Indicators (api.worldbank.org, WDI last updated {meta.get('lastupdated')})",
           "fetched": dt.date.today().isoformat(), "indicators": INDICATORS, "data": {}}
    for row in rows or []:
        if row.get("value") is None:
            continue
        out["data"].setdefault(row["countryiso3code"], {})[row["indicator"]["id"]] = {"year": int(row["date"]), "value": row["value"]}
    path.write_text(json.dumps(out, indent=1), encoding="utf-8")
    print(f"wrote {path}: {len(out['data'])} countries")
    return out
