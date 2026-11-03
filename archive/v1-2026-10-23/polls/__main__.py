"""Command line entry point.

    python -m polls build                 fetch (if older than 20 h) + parse + write site/data
    python -m polls build --offline       only use cached pages in data/raw
    python -m polls build --only PL DE    a subset of countries
    python -m polls fetch                 just refresh the raw cache
    python -m polls tables PL             list every table on a country's pages (to tune config)
"""
import argparse
import pathlib
import sys

from .build import ROOT, build_all, load_config


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
    args = ap.parse_args(argv)

    if args.cmd == "build":
        build_all(args.config, offline=args.offline, only=set(args.only) if args.only else None)
        print("\nWrote site/data/europe.json, site/data/history/*.json, data/processed/polls_long.csv")
        print("Check data/processed/diagnostics.txt for what was read from each page.")
    elif args.cmd == "fetch":
        from .fetch import fetch_page
        cfg = load_config()
        for code, c in cfg["countries"].items():
            for cyc in c.get("cycles") or []:
                fetch_page(cyc["page"], ROOT / "data" / "raw", max_age_hours=args.max_age)
    elif args.cmd == "tables":
        import gzip
        from .fetch import load_cached
        from .parse import parse_page
        cfg = load_config()
        for cyc in cfg["countries"][args.code.upper()].get("cycles") or []:
            html, meta = load_cached(ROOT / "data" / "raw", cyc["page"])
            if html is None:
                print(f"(not cached) {cyc['page']}")
                continue
            chosen, infos, rows = parse_page(html, 2026, cyc.get("include_headings"), cyc.get("exclude_headings"), cyc.get("tables"))
            print(f"\n=== {cyc['page']}  ({len(rows)} rows from tables {[t.index for t in chosen]})")
            for t in infos:
                print(f"  {'+' if t in chosen else ' '} T{t.index:02d} rows={t.n_data_rows:4d} [{t.heading[:70]}] {t.reason}")
                if t in chosen:
                    print(f"        parties: {[c.name for c in t.party_cols]}")


if __name__ == "__main__":
    sys.exit(main())
