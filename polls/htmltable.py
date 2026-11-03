"""Turn an HTML <table> into a rectangular grid, resolving rowspan/colspan.

Wikipedia polling tables use merged cells everywhere: the "Polling firm" header
spans two header rows, a joint list's result spans two party columns, and so on.
Pandas' read_html copies merged values into every covered position, which hides
the fact that a value was merged.  Here we keep a pointer to the *original* cell
in every grid position, so later code can tell "one value spanning two columns"
apart from "two equal values".
"""
from __future__ import annotations

import copy
import re
from dataclasses import dataclass, field

from bs4 import BeautifulSoup, Tag

_WS = re.compile(r"\s+")
_HEX = re.compile(r"background(?:-color)?\s*:\s*(#[0-9a-fA-F]{3,8}\b|[a-zA-Z]+)\s*(?:!important)?\s*(?:;|$)")


@dataclass(eq=False)
class Cell:
    tag: str            # 'th' or 'td'
    el: Tag             # the original BeautifulSoup element
    text: str           # cleaned visible text (footnotes, hidden sort keys removed)
    first_line: str     # cleaned text of the first line (before the first <br>)
    colspan: int
    rowspan: int
    row0: int           # grid row where the cell starts
    col0: int           # grid column where the cell starts
    sort_value: str | None = None
    background: str | None = None
    link_title: str | None = None
    link_href: str | None = None
    img_alt: str | None = None
    bold: bool = False
    extra: dict = field(default_factory=dict)


def _clean_copy(el: Tag) -> Tag:
    """Copy of the element with footnote markers, styles and hidden parts removed."""
    el = copy.copy(el)
    for bad in el.select("sup.reference, sup.noprint, style, .sortkey, .reference, "
                         ".mw-collapsible-content, .hidden-content, [style*='display:none'], "
                         "[style*='display: none']"):
        bad.decompose()
    return el


def _text(el: Tag) -> str:
    t = el.get_text(" ", strip=True).replace("\xa0", " ").replace(" ", " ")
    return _WS.sub(" ", t).strip()


def _first_line(el: Tag) -> str:
    """Text before the first <br> (Spanish tables put seat counts on a second line)."""
    parts, buf = [], []
    for node in el.descendants:
        if isinstance(node, Tag) and node.name == "br":
            break
        if isinstance(node, str) and not isinstance(node, Tag):
            buf.append(str(node))
    t = "".join(buf).replace("\xa0", " ")
    return _WS.sub(" ", t).strip()


def _background(el: Tag) -> str | None:
    style = el.get("style") or ""
    m = _HEX.search(style)
    if m:
        return m.group(1)
    if el.get("bgcolor"):
        return el.get("bgcolor")
    return None


def _main_link(el: Tag) -> tuple[str | None, str | None, str | None]:
    """(title, href, img_alt) of the first internal wiki link / image inside the cell."""
    img_alt = None
    img = el.find("img")
    if img is not None:
        img_alt = img.get("alt") or None
    for a in el.find_all("a"):
        href = a.get("href") or ""
        if href.startswith("#") or "external" in (a.get("class") or []):
            continue
        if href.startswith("/wiki/") and ":" not in href[6:].split("#")[0].replace("_(", ""):
            return a.get("title"), href, img_alt
        if href.startswith("/wiki/"):
            # File:..., Template:... etc. -> skip
            continue
    return None, None, img_alt


def _sort_value(el: Tag) -> str | None:
    if el.get("data-sort-value"):
        return el.get("data-sort-value")
    inner = el.find(attrs={"data-sort-value": True})
    if inner is not None:
        return inner.get("data-sort-value")
    sk = el.find(class_="sortkey")
    if sk is not None:
        return _text(sk)
    return None


def own_rows(table: Tag) -> list[Tag]:
    """<tr> elements belonging to this table (not to nested tables)."""
    return [tr for tr in table.find_all("tr") if tr.find_parent("table") is table]


def table_to_grid(table: Tag) -> list[list[Cell | None]]:
    rows = own_rows(table)
    grid: list[list[Cell | None]] = []
    pending: dict[tuple[int, int], Cell] = {}   # (row, col) -> cell spilling down from above
    for r, tr in enumerate(rows):
        row: list[Cell | None] = []
        c = 0
        cells = [x for x in tr.find_all(["th", "td"], recursive=False)]

        def fill_pending():
            nonlocal c
            while (r, c) in pending:
                row.append(pending.pop((r, c)))
                c += 1

        fill_pending()
        for el in cells:
            fill_pending()
            try:
                colspan = max(1, min(int(re.sub(r"\D", "", el.get("colspan", "1")) or 1), 100))
            except ValueError:
                colspan = 1
            try:
                rowspan = max(1, min(int(re.sub(r"\D", "", el.get("rowspan", "1")) or 1), 1000))
            except ValueError:
                rowspan = 1
            clean = _clean_copy(el)
            title, href, alt = _main_link(el)
            cell = Cell(
                tag=el.name, el=el, text=_text(clean), first_line=_first_line(clean),
                colspan=colspan, rowspan=rowspan, row0=r, col0=c,
                sort_value=_sort_value(el), background=_background(el),
                link_title=title, link_href=href, img_alt=alt,
                bold=el.find(["b", "strong"]) is not None,
            )
            for k in range(colspan):
                row.append(cell)
                for dr in range(1, rowspan):
                    pending[(r + dr, c + k)] = cell
            c += colspan
        fill_pending()
        grid.append(row)
    width = max((len(r) for r in grid), default=0)
    for row in grid:
        row.extend([None] * (width - len(row)))
    return grid


def soup_of(html: str) -> BeautifulSoup:
    return BeautifulSoup(html, "lxml")
