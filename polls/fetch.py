"""Download Wikipedia pages through the MediaWiki API and cache them on disk.

Cache layout (one pair per page):
    data/raw/<Page_title_slug>.html.gz   rendered HTML of the article body
    data/raw/<Page_title_slug>.json      {"requested", "title", "revid", "fetched", "nchar"}

We use the `action=parse` API (rendered HTML, the same as you see in the browser,
templates expanded) rather than scraping https://en.wikipedia.org/wiki/... pages,
and identify ourselves with a descriptive User-Agent, as Wikimedia's API etiquette
asks: https://meta.wikimedia.org/wiki/User-Agent_policy
"""
from __future__ import annotations

import datetime as dt
import gzip
import json
import os
import pathlib
import re
import time

API = "https://en.wikipedia.org/w/api.php"

# Wikimedia asks API clients to identify themselves with a contact address. Set it once, e.g.
#   PowerShell:  $env:POLLS_USER_AGENT = "EuropePollsDashboard/1.0 (you@example.com)"
#   bash:        export POLLS_USER_AGENT="EuropePollsDashboard/1.0 (you@example.com)"
DEFAULT_UA = (os.environ.get("POLLS_USER_AGENT") or
              "EuropePollsDashboard/1.0 (personal research dashboard; set POLLS_USER_AGENT to add a contact) python-requests")


def slug(title: str) -> str:
    return re.sub(r"[^A-Za-z0-9]+", "_", title).strip("_")


def cache_paths(raw_dir: pathlib.Path, title: str):
    s = slug(title)
    return raw_dir / f"{s}.html.gz", raw_dir / f"{s}.json"


def load_cached(raw_dir: pathlib.Path, title: str):
    h, m = cache_paths(raw_dir, title)
    if not h.exists():
        return None, None
    meta = json.loads(m.read_text()) if m.exists() else {}
    return gzip.decompress(h.read_bytes()).decode("utf-8"), meta


def fetch_page(title: str, raw_dir: pathlib.Path, max_age_hours: float = 20, user_agent: str = DEFAULT_UA,
               session=None, verbose=True):
    """Return (html, meta). Uses the cache unless it is older than `max_age_hours`."""
    html_path, meta_path = cache_paths(raw_dir, title)
    if html_path.exists() and meta_path.exists():
        meta = json.loads(meta_path.read_text())
        try:
            age = dt.datetime.now(dt.timezone.utc) - dt.datetime.fromisoformat(meta["fetched"].replace("Z", "+00:00"))
        except Exception:
            age = dt.timedelta(days=999)
        if age < dt.timedelta(hours=max_age_hours):
            return gzip.decompress(html_path.read_bytes()).decode("utf-8"), meta
    import requests  # imported lazily so parsing works without network libraries

    s = session or requests.Session()
    params = {"action": "parse", "page": title, "prop": "text|revid|displaytitle", "format": "json",
              "formatversion": "2", "redirects": "1"}
    for attempt in range(4):
        try:
            r = s.get(API, params=params, headers={"User-Agent": user_agent}, timeout=60)
            if r.status_code == 429 or r.status_code >= 500:
                time.sleep(5 * (attempt + 1))
                continue
            r.raise_for_status()
            j = r.json()
            break
        except Exception as e:  # network hiccup: retry, then fall back to the cache
            if attempt == 3:
                if html_path.exists():
                    if verbose:
                        print(f"  ! fetch failed for {title!r} ({e}); using cached copy")
                    return load_cached(raw_dir, title)
                raise
            time.sleep(3 * (attempt + 1))
    if "error" in j:
        raise RuntimeError(f"Wikipedia API error for {title!r}: {j['error'].get('info')}")
    html = j["parse"]["text"]
    meta = {"requested": title, "title": j["parse"]["title"], "revid": j["parse"]["revid"],
            "fetched": dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds"), "nchar": len(html)}
    raw_dir.mkdir(parents=True, exist_ok=True)
    html_path.write_bytes(gzip.compress(html.encode("utf-8")))
    meta_path.write_text(json.dumps(meta, indent=1))
    if verbose:
        print(f"  fetched {title} (rev {meta['revid']}, {len(html):,} chars)")
    time.sleep(1.0)  # be polite
    return html, meta
