"""Find the national voting-intention tables on a Wikipedia page and turn them into tidy rows.

Pipeline for one page
---------------------
1. Walk the page in document order, remembering the current h2 > h3 > h4 heading path
   for every `table.wikitable`.
2. For each table build a grid (polls.htmltable) and classify its columns:
   date / pollster / client / sample / area / lead / others / undecided / party / ignore.
3. Keep only tables that look like *national vote-share* polls (date + pollster + >=2 party
   columns), drop tables whose heading path says "seats", "scenario", "regional", ... and keep
   the ones that share the main table's top-level section and party set.
4. Read every data row: fieldwork dates (with year inference), pollster, sample size,
   party shares; merged cells spanning several party columns become joint-list values.
"""
from __future__ import annotations

import datetime as dt
import re
from dataclasses import dataclass, field

from bs4 import BeautifulSoup, Tag

from .dates import parse_fieldwork
from .htmltable import Cell, table_to_grid

# ----------------------------------------------------------------------------------------------
# Vocabulary
# ----------------------------------------------------------------------------------------------
ROLE_PATTERNS: list[tuple[str, re.Pattern]] = [
    ("date", re.compile(r"(\bdates?\b|fieldwork|field\s*work|conducted|polling\s*period|\bperiod\b|\breleased?\b|\bpublished\b)", re.I)),
    ("pollster", re.compile(r"(polling\s*(firm|company|organi[sz]ation|agency|institute)|pollster|poll\s*source|\bfirm\b|\binstitute\b|\bagency\b|organi[sz]ation|^polling$|^poll$|^source$)", re.I)),
    ("client", re.compile(r"(client|commission|sponsor|media\s*partner|^for$|^publisher$)", re.I)),
    ("sample", re.compile(r"sample|^n$|respondents", re.I)),
    ("area", re.compile(r"^(area|region|coverage)$", re.I)),
    ("method", re.compile(r"^(method|mode|type)\b", re.I)),
    ("turnout", re.compile(r"turnout", re.I)),
    ("moe", re.compile(r"margin|\bmoe\b|error", re.I)),
    ("lead", re.compile(r"^lead\b|^margin$", re.I)),
    ("others", re.compile(r"^(others?|oth\.?|o|o\s*/\s*i|ind\.?\s*/\s*oth\.?|other\s+parties|others?\s*/.*|other\s*\(.*\))$", re.I)),
    ("undecided", re.compile(r"(don.?t\s*know|undecided|^und\.?$|^dk$|^none\b|^abs\.?$|abstain|abstention|blank|no\s*answer|would\s*not\s*vote|wouldn.?t\s*vote|^n/?a$|^neither$|^dk/na$|^ns/nc$|^null$|not\s*voting|non-?voters?|would\s*not)", re.I)),
    ("sources", re.compile(r"^(sources?|ref\.?|refs?|link|notes?)$", re.I)),
    ("ignore", re.compile(r"^(resp\.?|response\s*rate|majority|gov\.?|govt\.?|opp\.?|opposition|government|total|swing|red|blue|bloc|seats?|turnout|ε|valid)$", re.I)),
]

# Headings that mark tables we do NOT want (seat projections, sub-national polls, scenarios ...).
# STRONG exclusions apply anywhere in the heading path; WEAK ones are overridden when the deepest
# heading is clearly a vote-share section (e.g. Czechia's "Party and election coalition polling > Polls").
STRONG_EXCLUDE = re.compile(
    r"(seat|approval|approve|favou?rab|preferred|preference|scenario|hypothetical|alternative|"
    r"sub-?national|regional|\bregions?\b|by\s+state|constituenc|\bcit(y|ies)\b|mayor|candidate|"
    r"primar(y|ies)|by\s+age|age\s+group|demograph|senate|second\s+round|run-?off|referendum|"
    r"aggregat|trust|\bmrp\b|ranking|grade|issue|most\s+important|voting\s+preferences|"
    r"presidential|european\s+parliament|exit\s+poll|polling\s+by|among|diaspora|abroad|overseas|"
    r"wales|scotland|northern\s+ireland|london|western\s|eastern\s|flanders|wallonia|brussels|"
    r"bavaria|vienna|krak|warsaw|after\s+hypothetical|open\s+to|nation-?wide\s+csu|cdu\s+and\s+csu|"
    r"\bban\b|leaders?\b|leadership)",
    re.I,
)
WEAK_EXCLUDE = re.compile(r"(coalition|projection|\bbloc|government)", re.I)
POSITIVE = re.compile(r"(vote\s*share|voting\s*intention|party\s*vote|\bpolls?\b|poll\s*results|"
                      r"polling\s*results|opinion\s*poll|party\s*polls|nationwide|national|"
                      r"party\s*standings|^(?:19|20)\d{2})", re.I)
# Election rows that are not the national legislative election (we drop them entirely)
OTHER_ELECTION = re.compile(r"(presiden|local|municipal|regional|europe|\bEP\b|\bEU\b|primar|senate|"
                            r"mayor|referendum|round|by-?election|council|county|skopje|nysa|city)", re.I)
NUMERIC_CELL = re.compile(r"^[<>~≈]?\s*\d{1,3}(?:[.,]\d+)?\s*%?$")
DATEY_CELL = re.compile(r"\d{1,2}\s*[–-]?\s*(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{4}|\d{4}-\d{2}-\d{2}", re.I)
YEARLIKE = re.compile(r"^\D{0,25}((?:19|20)\d{2})(?:\D{0,3}((?:19|20)\d{2}))?\D{0,25}$")
ELECTION_ROW = re.compile(r"\b(elections?|results?)\b", re.I)
NA_VALUES = {"", "–", "—", "-", "?", "n/a", "na", "x", "…", "...", "•", "·", "*", "tbd"}


@dataclass
class Column:
    idx: int
    role: str | None = None          # see ROLE_PATTERNS, or 'party'
    name: str = ""                   # visible header text (e.g. "PiS")
    article: str | None = None       # linked Wikipedia article title (e.g. "Law and Justice")
    color: str | None = None         # header background colour (Wikipedia party colour)
    group: str = ""                  # super-header text, e.g. "Coalitions"
    group_span: tuple = ()           # (id, colspan) of the innermost super-header cell
    numeric_share: float = 0.0       # share of data cells that parse as numbers

    @property
    def key(self) -> str:
        return self.article or self.name


@dataclass
class TableInfo:
    index: int
    heading_path: list[str]
    grid: list[list[Cell | None]]
    n_header: int = 0
    columns: list[Column] = field(default_factory=list)
    n_data_rows: int = 0
    reason: str = ""

    @property
    def party_cols(self) -> list[Column]:
        return [c for c in self.columns if c.role == "party"]

    def col(self, role: str) -> Column | None:
        for c in self.columns:
            if c.role == role:
                return c
        return None

    @property
    def heading(self) -> str:
        return " > ".join(self.heading_path)


# ----------------------------------------------------------------------------------------------
# Helpers
# ----------------------------------------------------------------------------------------------
def parse_share(s: str | None) -> float | None:
    if s is None:
        return None
    s = s.strip().replace("−", "-")
    if s.lower() in NA_VALUES:
        return None
    m = re.search(r"([<>≤≥]?)\s*(\d+(?:[.,]\d+)?)", s)
    if not m:
        return None
    try:
        v = float(m.group(2).replace(",", "."))
    except ValueError:
        return None
    if m.group(1) in ("<", "≤"):
        v = v / 2
    if v > 100:
        return None
    return v


def parse_int(s: str | None) -> int | None:
    if not s:
        return None
    s = re.sub(r"(?<=\d)[,.\s  ](?=\d{3}\b)", "", s)
    m = re.search(r"\d+", s)
    if not m:
        return None
    v = int(m.group(0))
    return v if 50 <= v <= 10_000_000 else None


def _is_grey_or_white(color: str) -> bool:
    c = color.lstrip("#")
    if len(c) == 3:
        c = "".join(ch * 2 for ch in c)
    if len(c) != 6 or not re.fullmatch(r"[0-9a-fA-F]{6}", c):
        return color.lower() in ("white", "transparent", "inherit", "lightgrey", "lightgray", "silver")
    r, g, b = (int(c[i:i + 2], 16) for i in (0, 2, 4))
    return max(r, g, b) - min(r, g, b) < 12 and min(r, g, b) > 200


def normalise_color(color: str | None) -> str | None:
    if not color:
        return None
    color = color.strip()
    if re.fullmatch(r"#[0-9a-fA-F]{3}", color):
        color = "#" + "".join(ch * 2 for ch in color[1:])
    if re.fullmatch(r"#[0-9a-fA-F]{6}", color):
        return color.upper()
    named = {"red": "#FF0000", "blue": "#0000FF", "green": "#008000", "orange": "#FFA500",
             "yellow": "#FFFF00", "purple": "#800080", "black": "#000000", "gray": "#808080",
             "grey": "#808080", "navy": "#000080", "teal": "#008080", "maroon": "#800000"}
    return named.get(color.lower())


def iter_tables(soup: BeautifulSoup):
    """Yield (index, table, heading_path) for every top-level wikitable, in document order."""
    path: dict[int, str] = {}
    idx = 0
    for el in soup.find_all(["h2", "h3", "h4", "h5", "table"]):
        if el.name != "table":
            level = int(el.name[1])
            path[level] = el.get_text(" ", strip=True).replace("[edit]", "").strip()
            for lower in [k for k in path if k > level]:
                del path[lower]
            continue
        classes = el.get("class") or []
        if "wikitable" not in classes:
            continue
        if el.find_parent("table") is not None:
            continue
        yield idx, el, [path[k] for k in sorted(path)]
        idx += 1


def _role_for(name: str) -> str | None:
    n = name.strip()
    if not n:
        return None
    for role, pat in ROLE_PATTERNS:
        if pat.search(n):
            return role
    return None


# ----------------------------------------------------------------------------------------------
# Table analysis
# ----------------------------------------------------------------------------------------------
def analyse_table(index: int, table: Tag, heading_path: list[str]) -> TableInfo:
    grid = table_to_grid(table)
    info = TableInfo(index=index, heading_path=heading_path, grid=grid)
    if not grid or not grid[0]:
        info.reason = "empty"
        return info

    # header rows: leading rows whose own cells are all <th>
    n_header = 0
    for r, row in enumerate(grid[:6]):
        own = {id(c): c for c in row if c is not None and c.row0 == r}
        if not own or not all(c.tag == "th" for c in own.values()):
            break
        numeric = sum(1 for c in own.values() if NUMERIC_CELL.match(c.text))
        datey = any(DATEY_CELL.search(c.text) for c in own.values())
        if numeric >= 2 or datey:
            break   # an election-result / note row written with <th> cells
        n_header = r + 1
    if n_header == 0:
        n_header = 1  # some tables use <td> headers
    info.n_header = n_header
    width = len(grid[0])

    data_rows = grid[n_header:]
    info.n_data_rows = len(data_rows)

    for j in range(width):
        col = Column(idx=j)
        seen = set()
        name_cells, group_cells = [], []
        for r in range(n_header):
            cell = grid[r][j]
            if cell is None or id(cell) in seen:
                continue
            seen.add(id(cell))
            (group_cells if cell.colspan > 1 else name_cells).append(cell)
        for cell in name_cells:
            label = cell.text or ""
            if not label and cell.img_alt:
                label = cell.img_alt
            if not label and cell.link_title:
                label = cell.link_title
            if label and not col.name:
                col.name = label
                col.article = cell.link_title
        if not col.name and group_cells:
            # header spans several columns (e.g. a party with vote/seat sub-columns) -> use it
            gc = group_cells[-1]
            col.name = gc.text or gc.img_alt or (gc.link_title or "")
            col.article = gc.link_title
        name_row = min((c.row0 for c in name_cells), default=n_header)
        above = [c for c in group_cells if c.row0 < name_row]
        col.group = " ".join((c.text or c.img_alt or c.link_title or "") for c in above
                             if (c.text or c.img_alt or c.link_title))
        named = [c for c in above if (c.text or c.img_alt or c.link_title)]
        if named:
            inner = max(named, key=lambda c: c.row0)   # nearest super-header that has a name
            col.group_span = (id(inner), inner.colspan, inner.text or inner.img_alt or inner.link_title or "")
        # colour: prefer empty "colour bar" cells, then the name cell itself
        for cell in sorted(name_cells, key=lambda c: (bool(c.text), -c.row0)):
            if cell.background and normalise_color(cell.background):
                if cell.text and _is_grey_or_white(cell.background):
                    continue
                col.color = normalise_color(cell.background)
                break
        col.name = re.sub(r"\s*\[\s*\w{1,3}\s*\]\s*", " ", col.name).strip()
        col.role = _role_for(col.name)
        if col.role in ("sources", "ignore", "method", "area", "client", "others") and col.article:
            col.role = None   # e.g. Estonia's "Ref" = Reform Party, linked to its article
        if col.role is None:
            vals = [grid_row[j] for grid_row in data_rows if grid_row[j] is not None]
            uniq = {id(c): c for c in vals}.values()
            nonempty = [c for c in uniq if (c.first_line or c.text).strip().lower() not in NA_VALUES]
            nums = [c for c in nonempty if parse_share(c.first_line or c.text) is not None]
            col.numeric_share = len(nums) / max(1, len(nonempty))
            if len(nums) >= 2 and col.numeric_share >= 0.6 and col.name:
                if re.search(r"coalition|bloc|alliance\s+total|blocs", col.group, re.I):
                    col.role = "coalition"
                else:
                    col.role = "party"
        info.columns.append(col)

    # two columns pointing at the same party article (e.g. two factions): keep them apart
    seen_keys: dict[str, int] = {}
    for c in info.columns:
        if c.role == "party":
            k = c.key
            seen_keys[k] = seen_keys.get(k, 0) + 1
            if seen_keys[k] > 1:
                c.name = f"{c.name} ({seen_keys[k]})"
                c.article = f"{c.article} ({seen_keys[k]})" if c.article else None

    # Some tables label the date column "Fieldwork" + "date" across two header rows, etc.
    if info.col("date") is None:
        for c in info.columns:
            if c.role is None and re.search(r"date|fieldwork|conducted", c.group, re.I):
                c.role = "date"
                break
    return info


def is_poll_table(info: TableInfo) -> bool:
    if info.col("date") is None:
        info.reason = "no date column"
        return False
    if info.col("pollster") is None and info.col("sample") is None:
        info.reason = "no pollster/sample column"
        return False
    if len(info.party_cols) < 2:
        info.reason = f"only {len(info.party_cols)} party columns"
        return False
    if info.n_data_rows < 2:
        info.reason = "too few rows"
        return False
    return True


def select_tables(infos: list[TableInfo], include_re: str | None = None, exclude_re: str | None = None,
                  only_indices: list[int] | None = None) -> list[TableInfo]:
    """Pick the national vote-intention tables among all tables of a page."""
    excl = re.compile(exclude_re, re.I) if exclude_re else None
    incl = re.compile(include_re, re.I) if include_re else None
    cands = []
    for t in infos:
        if only_indices is not None:
            if t.index in only_indices and is_poll_table(t):
                cands.append(t)
            continue
        if not is_poll_table(t):
            continue
        h = t.heading
        if incl and not incl.search(h):
            t.reason = "not matched by include_headings"
            continue
        deepest = t.heading_path[-1] if t.heading_path else ""
        forced = bool(incl and incl.search(h))
        if not forced and STRONG_EXCLUDE.search(h):
            t.reason = "excluded heading"
            continue
        if not forced and WEAK_EXCLUDE.search(deepest):
            t.reason = "excluded heading (weak, deepest)"
            continue
        if not forced and WEAK_EXCLUDE.search(h) and not POSITIVE.search(deepest):
            t.reason = "excluded heading (weak)"
            continue
        if excl and excl.search(h):
            t.reason = "excluded by config"
            continue
        cands.append(t)
    if not cands or only_indices is not None:
        for t in cands:
            t.reason = "selected"
        return cands
    main = max(cands, key=lambda t: t.n_data_rows * len(t.party_cols))
    main_keys = {c.key for c in main.party_cols}
    main_top = main.heading_path[0] if main.heading_path else ""
    chosen = []
    for t in cands:
        keys = {c.key for c in t.party_cols}
        overlap = len(keys & main_keys) / max(1, min(len(keys), len(main_keys)))
        same_top = (t.heading_path[0] if t.heading_path else "") == main_top
        yearly = bool(t.heading_path and YEARLIKE.match(t.heading_path[-1].strip()))
        if t is main or (same_top and (overlap >= 0.6 or (yearly and overlap >= 0.3))):
            t.reason = "selected"
            chosen.append(t)
        else:
            t.reason = f"not similar to main table (overlap {overlap:.2f}, same section {same_top})"
    return chosen


# ----------------------------------------------------------------------------------------------
# Row extraction
# ----------------------------------------------------------------------------------------------
def heading_year(info: TableInfo) -> int | None:
    for h in reversed(info.heading_path):
        m = YEARLIKE.match(h.strip())
        if m:
            return int(m.group(2) or m.group(1))
    return None


def extract_rows(tables: list[TableInfo], default_year: int) -> list[dict]:
    """Read all poll rows from the selected tables (processed in page order, carrying the year)."""
    out: list[dict] = []
    ctx_year = None
    prev_end: dt.date | None = None
    direction = -1  # -1: newest first (most common); +1: oldest first
    for t in tables:
        hy = heading_year(t)
        if hy:
            ctx_year = hy
            prev_end = None
        dcol, pcol = t.col("date"), t.col("pollster")
        ccol, scol, acol = t.col("client"), t.col("sample"), t.col("area")
        ocol, ucol = t.col("others"), t.col("undecided")
        parties = t.party_cols
        width = len(t.grid[0])

        # detect sort direction from rows carrying an explicit year / sort key
        explicit = []
        for r in range(t.n_header, len(t.grid)):
            c = t.grid[r][dcol.idx]
            if c is None:
                continue
            s, e, had = parse_fieldwork(c.text, c.sort_value, hy, prefer_default_year=bool(hy))
            if e and had:
                explicit.append(e)
        if len(explicit) >= 3:
            ups = sum(1 for a, b in zip(explicit, explicit[1:]) if b > a)
            downs = sum(1 for a, b in zip(explicit, explicit[1:]) if b < a)
            direction = 1 if ups > downs else -1

        for r in range(t.n_header, len(t.grid)):
            row = t.grid[r]
            own = {id(c): c for c in row if c is not None}
            # full-width separator rows (e.g. "2025", or a note) ------------------------------
            if len(own) <= 2 and any(c.colspan >= max(3, width * 0.6) for c in own.values()):
                txt = " ".join(c.text for c in own.values())
                m = YEARLIKE.match(txt.strip())
                if m:
                    ctx_year = int(m.group(2) or m.group(1))
                    prev_end = None
                continue
            # repeated header rows inside the body
            if all(c.tag == "th" for c in own.values()) and not any(parse_share(row[p.idx].text if row[p.idx] else None) is not None for p in parties):
                continue
            dcell = row[dcol.idx]
            if dcell is None:
                continue
            pcell = row[pcol.idx] if pcol else None
            # a row whose date AND pollster cells carry down from the row above is a scenario
            # variant of the same poll (e.g. France: main row + two alternative line-ups) -> skip
            if dcell.row0 < r and (pcell is None or pcell.row0 < r):
                continue
            pollster = pcell.text if pcell is not None else ""
            year_guess = ctx_year or default_year
            label_year = None
            if ELECTION_ROW.search(pollster):
                m = re.search(r"\b((?:19|20)\d{2})\b", pollster)
                label_year = int(m.group(1)) if m else None
            start, end, had_year = parse_fieldwork(dcell.text, dcell.sort_value,
                                                   label_year or hy or year_guess,
                                                   prefer_default_year=bool(label_year or hy))
            row_text = " ".join(c.text for c in own.values() if c.text and not any(row[q.idx] is c for q in parties))
            if end is None:
                # election rows sometimes put the date in the pollster cell
                start, end, had_year = parse_fieldwork(pollster, None, year_guess)
            election_year = None
            if end is None:
                # "2026 election result" spanning pollster+date: date resolved later from the config
                m = re.search(r"\b((?:19|20)\d{2})\b", row_text)
                if ELECTION_ROW.search(row_text) and m and not OTHER_ELECTION.search(row_text):
                    election_year = int(m.group(1))
                else:
                    continue
            if end is not None and not had_year and prev_end is not None and not hy:
                # year roll-over in a table without explicit years
                if direction < 0 and end > prev_end + dt.timedelta(days=45):
                    start, end = _shift_year(start, -1), _shift_year(end, -1)
                elif direction > 0 and end < prev_end - dt.timedelta(days=45):
                    start, end = _shift_year(start, 1), _shift_year(end, 1)
            if end is not None:
                ctx_year = end.year
                prev_end = end

            is_election = election_year is not None or (
                bool(ELECTION_ROW.search(pollster) or ELECTION_ROW.search(dcell.text)
                     or (ELECTION_ROW.search(row_text) and not pollster.strip("–—- ")))
                and not re.search(r"poll", pollster, re.I))
            if is_election and OTHER_ELECTION.search(pollster + " " + dcell.text + " " + row_text):
                continue
            rec = {
                "table": t.index,
                "row": r,
                "pollster": pollster,
                "client": row[ccol.idx].text if ccol and row[ccol.idx] is not None else "",
                "area": row[acol.idx].text if acol and row[acol.idx] is not None else "",
                "start": start,
                "end": end,
                "sample": parse_int(row[scol.idx].text) if scol and row[scol.idx] is not None else None,
                "others": parse_share(row[ocol.idx].first_line) if ocol and row[ocol.idx] is not None else None,
                "undecided": parse_share(row[ucol.idx].first_line) if ucol and row[ucol.idx] is not None else None,
                "is_election": is_election,
                "election_year": election_year,
                "values": {},     # party key -> share
                "joint": {},      # "A + B" -> share for merged cells
            }
            seen_cells = set()
            for p in parties:
                cell = row[p.idx]
                if cell is None or id(cell) in seen_cells:
                    continue
                seen_cells.add(id(cell))
                v = parse_share(cell.first_line or cell.text)
                if v is None:
                    continue
                covered = [q for q in parties if row[q.idx] is cell]
                if len(covered) > 1:
                    if len(covered) > max(2, 0.5 * len(parties)):
                        continue  # a note spanning the whole table, not a joint list
                    spans = {q.group_span for q in covered}
                    g = next(iter(spans)) if len(spans) == 1 else ()
                    if g and g[1] == len(covered) and g[2]:
                        jkey = g[2]                       # e.g. "SPOLU" exactly above ODS/KDU/TOP 09
                    else:
                        jkey = " + ".join(q.key for q in covered)
                    rec["joint"][jkey] = v
                else:
                    rec["values"][p.key] = v
            if rec["values"] or rec["joint"]:
                out.append(rec)
    return out


def _shift_year(d: dt.date | None, k: int) -> dt.date | None:
    if d is None:
        return None
    try:
        return d.replace(year=d.year + k)
    except ValueError:  # 29 Feb
        return d.replace(year=d.year + k, day=28)


def parse_page(html: str, default_year: int, include_re=None, exclude_re=None, only_indices=None):
    """Return (selected_tables, all_tables, rows) for one page."""
    soup = BeautifulSoup(html, "lxml")
    infos = [analyse_table(i, t, hp) for i, t, hp in iter_tables(soup)]
    chosen = select_tables(infos, include_re, exclude_re, only_indices)
    rows = extract_rows(chosen, default_year)
    return chosen, infos, rows
