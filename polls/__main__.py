"""Command line entry point.

    python -m polls build                 fetch (if older than 20 h) + parse + write site/data
    python -m polls build --offline       only use cached pages in data/raw
    python -m polls build --only PL DE    a subset of countries
    python -m polls fetch                 just refresh the raw cache
    python -m polls tables PL             list every table on a country's pages (to tune config)
    python -m polls update                refetch, roll over cycles where an election was held,
                                          rebuild (see polls/update.py; --offline, --no-build)
    python -m polls discover              find past polling pages on Wikipedia (network)
    python -m polls discover --plan       write config/history.yaml from the newest discovery file
    python -m polls enrich                re-add Manifesto positions, World Bank data and the map
                                          timeline to the built data (fast; no parsing)
    python -m polls worldbank             refresh population and GDP per capita (World Bank API)
"""
import argparse
import pathlib
import sys

from .build import ROOT, build_site, load_config


def main(argv=None):
    ap = argparse.ArgumentParser(prog="python -m polls")
    sub = ap.add_subparsers(dest="cmd", required=True)
    b = sub.add_parser("build", help="fetch, parse, smooth and write the dashboard data")
    b.add_argument("--offline", action="store_true", help="use cached pages only")
    b.add_argument("--only", nargs="*", help="country codes, e.g. PL DE")
    b.add_argument("--config", default=None)
    f = sub.add_parser("fetch", help="refresh the raw page cache")
    f.add_argument("--max-age", type=float, default=0, help="hours; 0 = always refetch")
    t = sub.add_parser("tables", help="show how every table on a country's pages was classified")
    t.add_argument("code")
    u = sub.add_parser("update", help="refetch, detect elections held, roll cycles over, rebuild")
    u.add_argument("--offline", action="store_true", help="use cached pages only")
    u.add_argument("--no-build", action="store_true", help="only write config/rollover.yaml")
    u.add_argument("--only", nargs="*", help="country codes")
    sub.add_parser("enrich", help="add Manifesto positions, World Bank data and the map timeline")
    sub.add_parser("worldbank", help="refresh population and GDP per capita from the World Bank API")
    d = sub.add_parser("discover", help="find past polling pages (writes data/discovery/...)")
    d.add_argument("--plan", action="store_true", help="write config/history.yaml from the newest discovery file")
    d.add_argument("--only", nargs="*", help="country codes")
    args = ap.parse_args(argv)

    if args.cmd == "build":
        build_site(args.config, offline=args.offline, only=set(args.only) if args.only else None)
        print("\nWrote site/data/europe.json, site/data/history/*.json (and the same with \"don't know\""
              " answers kept in site/data/with-dk/), data/processed/polls_long.csv")
        print("Check data/processed/diagnostics.txt for what was read from each page.")
    elif args.cmd == "fetch":
        from .fetch import fetch_page
        cfg = load_config()
        for code, c in cfg["countries"].items():
            for cyc in (c.get("cycles") or []) + (c.get("history_cycles") or []):
                fetch_page(cyc["page"], ROOT / "data" / "raw", max_age_hours=args.max_age if cyc in (c.get("cycles") or []) else max(args.max_age, 24 * 30))
    elif args.cmd == "update":
        from .update import run_update
        run_update(offline=args.offline, build=not args.no_build, only=set(args.only) if args.only else None)
    elif args.cmd == "worldbank":
        from .worldbank import refresh
        refresh()
        from .enrich import enrich_both
        enrich_both()
    elif args.cmd == "enrich":
        from .enrich import enrich_both
        enrich_both()
    elif args.cmd == "discover":
        import datetime as dt, json
        from .discover import discover_online, make_history_plan, newest_discovery, write_history_yaml
        if not args.plan:
            discover_online(set(args.only) if args.only else None)
        path = newest_discovery()
        plan = make_history_plan(json.loads(path.read_text(encoding="utf-8")),
                                 load_config(generated=False)["countries"], dt.date.today())
        write_history_yaml(plan, path.name)
    elif args.cmd == "tables":
        import gzip
        from .fetch import load_cached
        from .parse import parse_page
        cfg = load_config()
        c = cfg["countries"][args.code.upper()]
        for cyc in (c.get("cycles") or []) + (c.get("history_cycles") or []):
            html, meta = load_cached(ROOT / "data" / "raw", cyc["page"])
            if html is None:
                print(f"(not cached) {cyc['page']}")
                continue
            chosen, infos, rows = parse_page(html, 2026, cyc.get("include_headings"), cyc.get("exclude_headings"),
                                             cyc.get("tables"), cyc.get("require_headings"))
            print(f"\n=== {cyc['page']}  ({len(rows)} rows from tables {[t.index for t in chosen]})")
            for t in infos:
                print(f"  {'+' if t in chosen else ' '} T{t.index:02d} rows={t.n_data_rows:4d} [{t.heading[:70]}] {t.reason}")
                if t in chosen:
                    print(f"        parties: {[c.name for c in t.party_cols]}")


if __name__ == "__main__":
    sys.exit(main())
