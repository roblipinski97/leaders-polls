"""Package the site as one self-contained HTML page (CSS + JS inlined) plus its data files.

    python tools/build_artifact.py --full     -> dist/standalone/index.html (+ data/), a normal web page
    python tools/build_artifact.py            -> dist/artifact-v7/index.html: body content only, for
                                                 hosts that wrap the page themselves (Claude artifacts)
(dist/artifact/ and dist/artifact-v2/ to -v6/ hold the published versions 1 to 6 and are left alone.)

Useful for hosts that want a single page, e.g. sharing as a Claude artifact.
GitHub Pages does NOT need this: it serves the `site/` folder as it is.
"""
import pathlib
import re
import shutil

ROOT = pathlib.Path(__file__).resolve().parents[1]
SITE = ROOT / "site"


def main(content_only: bool = True):
    OUT = ROOT / "dist" / ("artifact-v7" if content_only else "standalone")
    html = (SITE / "index.html").read_text(encoding="utf-8")
    css = (SITE / "assets" / "style.css").read_text(encoding="utf-8")
    js = (SITE / "assets" / "app.js").read_text(encoding="utf-8")
    flags = (SITE / "assets" / "flags.js").read_text(encoding="utf-8")
    title = re.search(r"<title>.*?</title>", html, re.S).group(0)
    fonts = "\n".join(re.findall(r'<link rel="(?:preconnect|stylesheet)" href="https://fonts[^>]*>', html))
    desc = re.search(r'<meta name="description"[^>]*>', html).group(0)
    body = html.split("<!--CONTENT-START-->")[1].split("<!--CONTENT-END-->")[0]
    d3 = re.search(r'<script src="https://cdnjs[^"]*d3[^"]*"></script>', html).group(0)
    page = (f'{title}\n<meta name="claude:viewport-fit-sides" content="cover">\n{desc}\n{fonts}\n'
            f"<style>\n{css}\n</style>\n{body}\n{d3}\n<script>\n{flags}\n</script>\n<script>\n{js}\n</script>\n")
    if not content_only:
        page = ('<!doctype html>\n<html lang="en">\n<head>\n<meta charset="utf-8">\n'
                '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n'
                + page.replace(body, "</head>\n<body>\n" + body, 1) + "</body>\n</html>\n")
    if OUT.exists():
        shutil.rmtree(OUT)
    (OUT / "data" / "history").mkdir(parents=True)
    (OUT / "index.html").write_text(page, encoding="utf-8")
    shutil.copy(SITE / "data" / "europe.json", OUT / "data" / "europe.json")
    shutil.copy(SITE / "data" / "europe-map.json", OUT / "data" / "europe-map.json")
    shutil.copy(SITE / "data" / "timeline.json", OUT / "data" / "timeline.json")
    for f in (SITE / "data" / "history").glob("*.json"):
        shutil.copy(f, OUT / "data" / "history" / f.name)
    print(f"wrote {OUT / 'index.html'} ({len(page):,} bytes) and data/")


if __name__ == "__main__":
    import sys
    main(content_only="--full" not in sys.argv)
