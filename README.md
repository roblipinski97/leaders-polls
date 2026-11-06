# Are Leaders Leading? A European polling dashboard

An interactive dashboard built from the opinion-polling articles on English Wikipedia.

* **Map.** Three modes. *Government poll lead/lag*: Europe coloured by how far the head of
  government's party is ahead of its strongest rival (blue) or behind it (orange), with the gap in
  points and the time left until the next election. *Party shares*: the poll share of
  the governing party (with its place in the polls) or of the first, second or third party.
  *Poll share of parties by ideology*: the
  combined poll share of an ideology group (see below). The slider and *Time lapse* button above the map
  redraw it for any week since 1991 that the historical data cover; the summary in the left column
  follows the date. A small key at the top right explains the figures. Countries the dashboard does
  not cover are dark grey, with the reason on hover. Selecting a country opens its full chart, at
  the date the map shows.
* **Country graphs.** One chart per country from the last election to the next. The thick line is
  the head of government's party; individual polls are shown unless you tick *Trends only*.
  *Compare with an ideology group* replaces the other parties with one dashed line: the combined
  share of the group (the governing party itself excluded). A time slider, shared with the map's,
  shows each country's term as it stood on any earlier date, with the polls up to that date.
* **Correlates.** Any two of: lead over the rival, change since the election, governing
  party's support, time in the lead, days to the next election, population (log scale),
  GDP per capita PPP (World Bank), and the poll share of the ideology group.
* **Historical data.** Every polling page back to the 1990s chained into continuous
  lines, for all 31 countries, with a band showing who headed the government. Only stretches of
  steady polling are drawn (see *Steady polling* below).
* **Polling errors.** For any election in the historical data: each party's result (a square)
  against every poll whose fieldwork ended in the chosen number of days before the vote (dots,
  one week by default), with optional 95% intervals from the sample size, a pollster filter, the
  poll average's error per party, a table of pollsters by their average miss, and the term's
  polls over time.
* **About and method.** Who made it, the credits, how to cite it, and how it is made. Every chart
  links to the exact Wikipedia revision it was built from.
* **Ideology groups.** Parties can be grouped by their Manifesto Project party family (one or
  several ticked) or by a range on one of ten Manifesto measures: left–right (RILE), market
  regulation and planning, free market economy, welfare state and equality, peace and
  anti-militarism, European Union (for minus against), national way of life (for minus against),
  multiculturalism (for minus against), law and order, environmental protection.
* **Colours.** The *Map colours* menus in the left column, under the list of views, each shown only
  when its colours are on screen: the pair for a government's lead or lag (blue and orange,
  the default, then Bavarian blue and red, green and red, teal and plum, olive and violet), and the
  single colour of a share of the vote, from white to full red, orange, blue or green. Party colours stay.

```
config/countries.yaml       <- the file you normally edit (pages, incumbents, election dates)
config/history_merges.yaml  <- hand-kept: which party names continue one line in the historical data
config/history.yaml         generated: past polling pages per country   (python -m polls discover --plan)
config/rollover.yaml        generated: elections held since countries.yaml was edited (python -m polls update)
config/governments.yaml     generated: heads of government since 1985   (python tools/make_governments.py)
polls/                      Python pipeline: fetch -> parse -> clean -> smooth -> JSON/CSV
  fetch.py                     MediaWiki API download + on-disk cache (data/raw)
  htmltable.py                 HTML table -> grid, resolving merged cells (rowspan/colspan)
  parse.py                     find the national vote-share tables, classify columns, read rows
  dates.py                     "19–21 Oct", "30 Sep – 2 Oct 2026", sort keys, missing years
  colors.py                    party colours: Wikipedia's, made distinguishable (OKLab)
  smooth.py                    local linear (LOESS-type) trend lines
  build.py                     orchestration, incumbency periods, joint lists, historical data
  update.py                    detect held elections and roll the polling windows over
  discover.py                  find past polling pages on Wikipedia
site/                       the dashboard (static HTML + CSS + JS with D3, no build step)
  data/europe.json             generated: every country's current term
  data/history/<CC>.json       generated: historical data per country
  data/europe-map.json         map shapes (Natural Earth 1:50m, via tools/make_map.mjs)
  assets/flags.js              round flags, inlined as data URIs
data/processed/
  polls_long.csv               generated: tidy poll x party table (use it in R / Stata / pandas)
  diagnostics.txt              generated: which tables were read on every page and why
data/external/parlgov_pm_cabinets.csv   ParlGov cabinets to 2020 (source of the government band)
update.ps1, update.sh       the one-line refresh, for Windows and macOS/Linux
.github/workflows/update.yml   daily refresh + publish on GitHub Pages
r/explore_polls.R           example of using the CSV in R
tools/build_artifact.py     one-file version of the site (for single-page hosts)
```

## Run it on your computer

You need Python 3.9 or newer (Anaconda is fine). In a terminal (Anaconda Prompt, or PowerShell)
opened in this folder:

```powershell
pip install -r requirements.txt
$env:POLLS_USER_AGENT = "EuropePollsDashboard/1.0 (your-email@example.com)"   # Wikimedia asks for a contact
python -m polls update           # refresh the polls, roll over any election just held, rebuild
python -m http.server 8000 --directory site
```

Then open http://localhost:8000. The page has to be served over HTTP like this, because
browsers block data loading when you double-click `index.html` directly.

## Renewing the polls

One command does everything:

```powershell
.\update.ps1          # Windows PowerShell   (or:  python -m polls update)
./update.sh           # macOS / Linux
```

`python -m polls update`

1. re-downloads the page of every running term;
2. checks Wikipedia's election articles for a national election held since the term began
   (for example Serbia's of 25 October 2026);
3. if there was one, **rolls the window over**: the running term is closed at the election
   date, the result in the article's infobox becomes the closing point, and Wikipedia's page for
   the following election (when it exists) becomes the new running term. Until that page has
   5 polls the dashboard keeps showing the completed term, with the result in place of the trend.
   The outgoing government is marked as caretaker from the election day, and the next election
   date is estimated from the term length;
4. writes what it found to `config/rollover.yaml` and rebuilds `site/data`.

`config/rollover.yaml` is generated and overwritten on every run. When the new government is
sworn in, put it in `config/countries.yaml` (see below): add the incumbent period, move the
new page to the top of `cycles` and give the old one its `end:`. From then on the rollover
entry for that election is ignored. Other variants:

| Command | What it does |
|---|---|
| `python -m polls update --offline` | the same from cached pages only (no internet) |
| `python -m polls update --no-build` | only detect elections and write `config/rollover.yaml` |
| `python -m polls build` | rebuild without the election check (pages cached 20 h; old terms 30 days) |
| `python -m polls build --only PL DE` | rebuild a few countries |
| `python -m polls fetch` | force a fresh download of every current page |
| `python -m polls tables PL` | list every table on a country's pages and whether it was used |
| `python -m polls discover` then `--plan` | search Wikipedia again for past polling pages, rewrite `config/history.yaml` |

The GitHub workflow runs `python -m polls update` every morning, so a published copy rolls
over on its own.

## Keeping the context right: `config/countries.yaml`

Wikipedia supplies the polls. The **context** comes from the config: who governs, when the next
election is, and which pages to read. Update it when:

* **the head of government changes.** Add a period under `incumbents`, giving the date, the
  party as it appears in the polling table (`match`), and the leader. The thick line switches
  party at that date. A caretaker or non-party PM with an empty `match: []` draws no thick line.
* **an election is called.** Change `next_election` (and `next_election_status`:
  `scheduled`, `expected` or `deadline`).
* **a table is misread.** Run `python -m polls tables XX`, then add `include_headings`,
  `exclude_headings` or an explicit `tables: [..]` list to that cycle. Use `aliases` to merge
  joint lists into the party they belong to, `labels` for display names, `colors` for colours.

The facts in the shipped config were checked on **3 November 2026**.

### The historical data

`config/history.yaml` lists every past term per country: the dedicated "Opinion polling for
the ... election" page where Wikipedia has one, otherwise the election article (whose "Opinion
polls" section is read). Pages whose numbers do not add up to vote shares are skipped and named
in `diagnostics.txt`; old Dutch pages, which only give seat projections, are read as shares of
the 150 seats.

Each party key (usually its Wikipedia article title) is its own line. When a party was renamed
or continued by a successor, add the join to `config/history_merges.yaml`, for example
`"Brexit Party": "Reform UK"`. Poland instead has fully curated lineages in `countries.yaml`
(`history: lineages:`). The government band comes from `config/governments.yaml`: ParlGov to
2020 plus hand-entered cabinets since, and Serbia, Moldova and Montenegro.

## Ideology: the Manifesto Project data

`data/external/MPDS_2026a.csv` (Manifesto Project Dataset 2026a, with its codebook) gives each
party's family and the coded content of every election manifesto. `polls/ideology.py` computes
the ten measures listed in its `VARS` (add one there and in `MEASURES` in `site/assets/app.js`
to offer it on the page) and matches the dashboard's party
keys to Manifesto parties on English names and abbreviations; `config/ideology_overrides.yaml`
fixes the rest by hand (party code, several codes for a line that continued several parties,
`inherit` for a new party that split from or ran inside a coded one, or `null`). Every match is
written to `data/processed/ideology_matches.csv`; check it after editing the overrides, then run
`python -m polls enrich` (a few seconds, no re-parsing). To use a newer Manifesto release,
replace the CSV and change `MPDS` at the top of `polls/ideology.py`.

Population and GDP per capita come from `data/external/worldbank.json`; refresh it with
`python -m polls worldbank`. The map's slider reads `site/data/timeline.json`, which
`python -m polls enrich` (and every build) writes from the historical data.

## How the parser decides what to read

1. Every `wikitable` on the page is turned into a grid with merged cells resolved, so a joint
   list's value spanning two party columns stays *one* value.
2. Columns are classified from their header text: date, pollster, sample, others, undecided,
   lead, or party. Party columns are those with mostly numeric cells, and a party column linked
   to a Wikipedia article (Estonia's "Ref" is the Reform Party) is never mistaken for something
   else. Bloc totals ("Red (A+B+F+Ø)", "Government", "Opposition") are ignored.
3. Tables under headings such as *seats, projection, scenario, regional, approval, leader,
   preferred, likelihood* are skipped, and exit polls are dropped. The remaining tables in the
   main table's section are kept, including per-year tables whose party list changed.
4. Dates: a year written in the cell is used first, then the section heading's year ("2025"),
   then Wikipedia's hidden sort key.
5. Shares are re-based to decided voters when a poll reports undecided ("don't know") answers
   inside its base. The build writes a second copy of the data with those answers kept, as printed
   on Wikipedia, to `site/data/with-dk/` (same files; there the lines are not tied to the election
   result, which counts decided voters only). The site's left column switches between the two; the
   polling errors always use the first.

## How the colours work

Each party keeps its Wikipedia colour, since readers recognise it. Within a country, parties
are processed from largest to smallest. If a party's colour is closer than a set perceptual
distance (in OKLab) to a colour already taken, it is nudged in lightness, then hue, by the
smallest change that separates the two. Too-pale colours are darkened so they read on white,
and a lighter variant is generated for dark mode. In the historical data, two lines only have to
differ if they were ever on screen at the same time.

## Publishing

* **GitHub Pages (recommended)**, step by step below. The workflow re-scrapes Wikipedia every
  morning, commits the refreshed data (which keeps a history of the numbers), redraws the
  link-preview image and deploys `site/`.
* **Any static host** (Netlify, Cloudflare Pages, a university web space): upload `site/`.
* **A single page**: `python tools/build_artifact.py --full` writes `dist/standalone/`.

### GitHub Pages, step by step (Windows, no command line)

1. **Account and app.** Create a free account at github.com and install GitHub Desktop
   (desktop.github.com). Sign in to it with the account.
2. **Make the folder a repository.** In GitHub Desktop: *File > Add local repository*, choose this
   folder; it offers to *create a repository* here. Name it, for example, `europe-polls`. The
   `.gitignore` file keeps out what should not be public or is too big: the Wikipedia page cache,
   the Manifesto Project CSV and codebook (registered download; the site uses the saved matches in
   `data/processed/manifesto_cache.json` instead), `dist/`, `social/`, archives and the flag folder.
   Check the list of changed files before the first commit; none of those should appear.
3. **Commit and publish.** Write a summary ("First version"), *Commit to main*, then *Publish
   repository*. Untick *Keep this code private*: on a free account Pages needs a public repository.
4. **Switch Pages on.** On github.com, in the repository: *Settings > Pages > Build and deployment
   > Source: GitHub Actions*.
5. **Tell Wikipedia who you are.** *Settings > Secrets and variables > Actions > Variables > New
   repository variable*: name `POLLS_USER_AGENT`, value `EuropePollsDashboard/1.0 (your email)`.
   Wikimedia asks automated readers for a contact; it is sent only in the request header.
6. **First run.** *Actions > Update polls and deploy > Run workflow*. The first run downloads every
   polling page, so it takes longer than the daily ones. When it shows a green tick, the site is at
   `https://<your-user-name>.github.io/europe-polls/`. If it fails, the red step's log says why.
7. **Check the link preview.** Paste the address into LinkedIn's Post Inspector
   (linkedin.com/post-inspector); it shows the card with `site/assets/preview.png`. On X and
   Bluesky, start writing a post with the link and the card appears.
8. **From then on** it refreshes itself every morning at 05:17 UTC. When you change something
   locally (for example `config/countries.yaml`), first click *Fetch origin* and *Pull* in GitHub
   Desktop, because the workflow commits new data every day, then commit and *Push origin*; every
   push also redeploys.
9. **Optional: your own domain.** Buy one from any registrar, add it under *Settings > Pages >
   Custom domain*, add the DNS record GitHub shows (a CNAME to `<your-user-name>.github.io`), and set
   a repository variable `SITE_URL` to the new address so link previews use it.
10. **Optional: visitor counts.** Create a free GoatCounter account (goatcounter.com) and remove the
    comment marks around its line near the top of `site/index.html`, with your code in it.

### Images and clips for social media

`node tools/make_social.js` draws them with the dashboard itself: `preview` (the link-preview
card, `site/assets/preview.png`), `still` (today's map, 1080 x 1350), `clip` (the lead/lag map
from 2012 to now as MP4 and GIF) and `clip-ideo` (the same for the nationalist and radical right
family). Add `--credit "your site address"` to print it at the bottom. It needs Node, Playwright
(`npm install playwright` and `npx playwright install chromium`) and, for clips, ffmpeg.

Wikipedia content is licensed CC BY-SA 4.0. The dashboard attributes and links every source page.
Map shapes: Natural Earth (public domain). Cabinets to 2020: ParlGov (parlgov.org).
Party positions: Lehmann et al. (2026), The Manifesto Data Collection, version 2026a
(https://doi.org/10.25522/manifesto.mpds.2026a). Population and GDP: World Bank WDI.

## Versions

* `archive/v1-2026-10-23/` is the first published version (incumbents grid, Poland long view).
* Version 2 (3 November 2026): map, flags, long view for every country, election rollover,
  new typography.
* Version 3: map through time, left–right ranges (Manifesto Project), scatterplot tab with World
  Bank variables, colour palettes.
* Version 4: new title, tabs renamed and reordered (Map, Country graphs,
  Correlates, Intra-country timelines, Method and sources; old links still work), ideology groups
  by party family or any of ten Manifesto measures, a single-hue ideology share colour, map
  controls and key above the map.
* Version 5 adds the link-preview image and `tools/make_social.js` (images and clips for social
  media), shows only the colour picker that applies to what is on screen, hatches countries on the
  ideology map where parties without Manifesto data poll 15% or more, and lets the GitHub workflow
  run without the Manifesto Project CSV (saved matches in `data/processed/manifesto_cache.json`).
* Version 6: renamed "Are leaders leading in the polls?"; the Correlates variables and colour
  pickers name the government and the kind of scale explicitly; the two colour keys line up.
* Version 7: blue and orange is the default lead/lag palette; the written summary sits above the
  map, which now uses the full width; a third map mode, *Poll share by party place*.
* Version 8: light theme by default with a light/dark picker beside the colour pickers; a shorter
  header with the tabs beside the title; a compact summary with flags and "pp"; the colour key next
  to the map modes; the map sized to fit the window; *Time lapse* instead of *Play*; the date the
  latest polls were fetched.
* Version 9: renamed "Are leaders leading?"; the views are a menu in a left column, with the
  summary (on the map) and the colour and theme menus under it; the colour key and the time slider
  share one length, with the first and last dates at its ends; Country graphs drop the region
  filter (Choose countries covers it); Correlates stack the two menus and fill the window; the
  Intra-country timelines start with the country menu; "pp" for percentage points throughout.
* Version 10: the map fills the window's height, with its caption to the right on wide screens;
  the date appears only when looking back in time; the hatching is explained in the ideology
  group's note rather than in the colour key; Correlates' axis titles are centred on their axes.
* Version 11: publication pass. A small "how to read" key at the top right of the map and of the
  country graphs replaces the caption and the legend row; the map takes the full width, its colour
  key sits on the left and *Time lapse* to the right of the slider, with the date and the number of
  countries polled under the slider's thumb; figures on the map without a halo, in an ink chosen
  for contrast; countries not covered in darker grey with the reason on hover; Africa, Turkey and
  the Caucasus left out, Ukraine shown; segmented tabs; a thinner slider; a time slider on the
  country graphs, shared with the map, and charts opened from the map at the map's date; the
  summary as one row per country with arrow icons that turn with the majority; icons in the list
  of views; About section, credits in the header and a footer; *Historical data*, *Party shares* and
  *Map colours* as names; lighter blue shading for "ahead"; "2 years, 186 days"; the historical
  data open on Austria, with the flag by the title and the party lineages folded away.
### Steady polling

Where polls are months apart the smoothed lines have nothing to follow and run flat. After the
data are loaded, `POLL_RULE` at the top of `site/assets/app.js` keeps only stretches of steady
polling: a gap of more than `maxGapDays` (91) between two polls breaks a series, except after an
election, when polls may pause for up to `afterElectionDays` (183); stretches shorter than
`minRunDays` (365) between two breaks are dropped. It applies to the historical data, the country
graphs at earlier dates and the map through time (which reads the weeks with polls, `pw`, from
`timeline.json`); the Polling errors view uses every poll. Set `POLL_RULE = null` to switch it off.
With the default settings Austria starts in 2012, Luxembourg has no continuous line, and France,
Malta, Montenegro and Serbia lose their sparsest years.

* Version 12: a small *Time lapse* button right after the slider's end date; the summary's
  "furthest behind" and "furthest ahead" lists on very light tints of the two map colours; no lead
  strip under the country charts; the elections named in vertical text in the charts' key; the
  About section links the author's website and says the views are not those of any institution.
* Version 13: a *Polling errors* view (results against the final polls, pollster filter, 95%
  intervals, pollster table, the term's polls); stretches of sparse polling left out of the
  historical lines and the map through time; the map's key placed in the empty space east of
  Finland when it fits; "Are Leaders Leading?" in title case; "Incumbent ahead of the strongest
  rival" in the country graphs' key. The history files now carry each poll's last day of
  fieldwork (`polls.e`) and the timeline the weeks with polls (`pw`).
* Version 14: design pass after Adam Kucharski's "Ten reasons your vibe-coded dashboard looks
  vibe-coded". One set of design tokens in `site/assets/style.css` (seven type sizes, three line
  heights, a 4 px spacing grid, one control height); the summary is the only framed element, charts
  and tables sit on the page, the keys on a light grey ground; each country graph leads with its
  lead or lag as a large signed figure, labels its main lines directly instead of a legend, and
  no longer repeats names and values; the table puts the lead or lag next to the party, with units
  in the headers; the Correlates axes follow the data; the footer and the Polling errors text
  state each fact once.
* Version 15: every view opens with its name and a short plain explanation above its controls;
  the map's key grows with the map on big screens, its mode buttons, colour bar (25% thicker) and
  time slider (40% thicker track) are centred; the keys sit on a neutral grey with black-edged
  swatches, and the ahead and behind shading in the country graphs is stronger; hovering over a
  flag in Correlates draws the path that government took since its election; Polling errors opens
  on the last two weeks before the vote, with its title and explanation above the controls and
  see-through result squares; charts line up with the text above them; map labels keep a halo in
  the dark theme.
* Version 16: a shorter subtitle, "Opinion polling for the next parliamentary elections across
  Europe", also used in the link previews.
* Version 17: a menu in the left column to include or exclude "don't know" answers (the data now
  comes in two copies, `site/data/` and `site/data/with-dk/`); the colour menus stay in every view,
  under "Colours"; a crown marks the countries furthest ahead and a tumbling crown those furthest
  behind.
* Version 18: "Furthest ahead" listed above "Furthest behind"; a note that the figure at the end
  of a line was its trend (replaced in version 19).
* Version 19: today's figures (shares, lead or lag, change since the election, the map) are the
  latest poll's, so they match the Wikipedia table; polls whose fieldwork ended on the same day are
  averaged, without weights. The lines stay the trend, with the latest poll ringed at their ends.
  The country table can unfold every poll of the term, laid out like Wikipedia's table; one or two
  selected countries fill the width. Polls are stored to two decimals and with their "don't know"
  share (`polls.u`).
* Version 20: "don't know" answers included by default; the time sliders show the latest poll on
  or before the chosen date too (the timeline's `src`: polls by their last day of fieldwork, and
  election results), with that poll's date next to the date in the map's tooltip; thin rules
  between the summary's parts; the map's colour bar and time slider 30% thicker.

## Known limitations

* English Wikipedia's page for the next French legislative election lists no polls after
  October 2025. The panel says so; the French-language Wikipedia is far more complete.
* Belgium (regional polls only), Switzerland (collegial executive) and Cyprus (presidential
  system) are listed but not charted.
* Older terms are uneven: before about 2010 many countries' election articles have no poll
  table, so their timelines start later (Lithuania in 2016, Latvia in 2018).
* The government band matches the head of government's party to a poll line by name; a few
  early cabinets (for example Poland's Bielecki, 1991) have no matching line and show grey.
