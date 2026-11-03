# Leading and laden leaders: a European polling dashboard

An interactive dashboard built from the opinion-polling articles on English Wikipedia.

* **Incumbents.** One small chart per country, running from the last election to the next.
  The head of government's party is the thick line. The shading between it and its strongest
  rival shows whether the governing party is ahead (green) or behind (red), with a strip along
  the bottom showing the same through the term. The x-axis ends on the date of the next
  election, so a line that stops early means part of the term is still to come.
* **Long view.** Several terms chained into continuous party lineages. Poland 1997–2026 is
  included; other countries can be added in the config.
* **Method & sources.** Every chart links to the exact Wikipedia revision it was built from.

```
config/countries.yaml     <- the only file you normally edit (pages, incumbents, election dates)
polls/                    <- Python pipeline: fetch -> parse -> clean -> smooth -> JSON/CSV
  fetch.py                   MediaWiki API download + on-disk cache (data/raw)
  htmltable.py               HTML table -> grid, resolving merged cells (rowspan/colspan)
  parse.py                   find the national vote-share tables, classify columns, read rows
  dates.py                   "19–21 Oct", "30 Sep – 2 Oct 2026", sort keys, missing years
  colors.py                  party colours: Wikipedia's, made distinguishable (OKLab)
  smooth.py                  local linear (LOESS-type) trend lines
  build.py                   orchestration, incumbency periods, joint lists, lineages
site/                     <- the dashboard (static: HTML + CSS + JS with D3, no build step)
  data/europe.json           generated: every country's current term
  data/history/PL.json       generated: long-run lineages
data/processed/
  polls_long.csv             generated: tidy poll x party table (use it in R / Stata / pandas)
  diagnostics.txt            generated: which tables were read on every page and why
.github/workflows/update.yml   daily re-scrape + publish on GitHub Pages
r/explore_polls.R          example of using the CSV in R
tools/build_artifact.py    one-file version of the site (for single-page hosts)
```

## Run it on your computer

You need Python 3.9 or newer (Anaconda is fine). In a terminal (Anaconda Prompt, or PowerShell)
opened in this folder:

```powershell
pip install -r requirements.txt
$env:POLLS_USER_AGENT = "EuropePollsDashboard/1.0 (your-email@example.com)"   # Wikimedia asks for a contact
python -m polls build            # downloads the pages (cached for 20 h), writes site/data
python -m http.server 8000 --directory site
```

Then open http://localhost:8000. The page has to be served over HTTP like this, because
browsers block data loading when you double-click `index.html` directly.

Useful variants:

| Command | What it does |
|---|---|
| `python -m polls build --offline` | rebuild from the cached pages only (no internet) |
| `python -m polls build --only PL DE` | rebuild a few countries |
| `python -m polls fetch` | force a fresh download of every page |
| `python -m polls tables PL` | list every table on a country's pages and whether it was used |

## Keeping it current: `config/countries.yaml`

Wikipedia supplies the polls. The **context** comes from the config: who governs, when the next
election is, and which pages to read. Update it when:

* **the head of government changes.** Add a period under `incumbents`, giving the date, the
  party as it appears in the polling table (`match`), and the leader. The thick line switches
  party at that date. A caretaker or non-party PM with an empty `match: []` draws no thick line.
* **an election is called or held.** Change `next_election` (and `next_election_status`:
  `scheduled`, `expected` or `deadline`). After an election, put the new "next election" page
  first under `cycles` with `start: <election date>`, and give the old page an `end:`.
  Until the new term has 5 polls, the dashboard keeps showing the completed term.
* **a table is misread.** Run `python -m polls tables XX`, then add `include_headings`,
  `exclude_headings` or an explicit `tables: [..]` list to that cycle. Use `aliases` to merge
  joint lists into the party they belong to, `labels` for display names, `colors` for colours.

The facts in the shipped config were checked on **23 October 2026**. They include several recent
changes: Burnham replacing Starmer, Magyar's Tisza government, Radev's Progressive Bulgaria,
Janša's return, Babiš, Jetten, Niculescu in Romania, Spain's snap election on 29 Nov 2026, and
Serbia's on 25 Oct 2026.

### Adding a long-run history for another country

Add the older polling pages as further `cycles` (newest first, each with `start` and `end`).
Then add a `history: lineages:` block, as Poland's does: each lineage lists the party keys,
meaning the Wikipedia article titles of the parties, that belong to one political current
across renames and joint lists. Unmapped keys are listed in `diagnostics.txt`.

## How the parser decides what to read

1. Every `wikitable` on the page is turned into a grid with merged cells resolved, so a joint
   list's value spanning two party columns stays *one* value.
2. Columns are classified from their header text: date, pollster, sample, others, undecided,
   lead, or party. Party columns are those with mostly numeric cells, and a party column linked
   to a Wikipedia article (Estonia's "Ref" is the Reform Party) is never mistaken for something
   else. Each party's colour is read from the header cell.
3. Tables under headings such as *seats, projection, scenario, regional, approval, leader,
   preferred* are skipped. The remaining tables in the main table's section are kept, including
   per-year tables whose party list changed during the term.
4. Dates: a year written in the cell is used first, then the section heading's year ("2025"),
   then Wikipedia's hidden sort key. The sort keys are sometimes wrong (the 2025 Portuguese page
   had 2019 keys on 2025 polls), so they come last.

## How the colours work

Each party keeps its Wikipedia colour, since readers recognise it. Within a country, parties
are processed from largest to smallest. If a party's colour is closer than a set perceptual
distance (in OKLab) to a colour already taken, it is nudged in lightness, then hue, by the
smallest change that separates the two. Poland's two navy parties (PiS, Konfederacja) and two
crimson ones (Lewica, Razem) are examples. Too-pale colours (yellow FDP, light ÖVP) are darkened
so they read on white, and a lighter variant is generated for dark mode. In the long view, two
lineages only have to differ if they were ever on screen at the same time.

## Publishing

* **GitHub Pages (recommended).** Push this folder to a GitHub repository, then set
  *Settings → Pages → Source: GitHub Actions*. The workflow in `.github/workflows/update.yml`
  re-scrapes Wikipedia every morning, commits the refreshed data (which keeps a history of the
  numbers), and deploys `site/`.
* **Any static host** (Netlify, Cloudflare Pages, a university web space): upload the `site/` folder.
* **A single page**: `python tools/build_artifact.py --full` writes `dist/standalone/`.

Wikipedia content is licensed CC BY-SA 4.0. The dashboard attributes and links every source page.

## Known limitations

* English Wikipedia's page for the next French legislative election lists no polls after
  October 2025. The panel says so; the French-language Wikipedia is far more complete.
* Belgium (regional polls only), Switzerland (collegial executive) and Cyprus (presidential
  system) are listed but not charted. Albania, North Macedonia, Kosovo and Turkey have no
  current English polling table; Bosnia, Ukraine, Georgia and Armenia are not included yet.
* Pollsters differ in method and in whether they report undecided voters. Shares are rescaled
  to decided voters where the table reports undecided voters inside the 100%.
