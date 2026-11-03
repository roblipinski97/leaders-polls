/* Are leaders leading? Dashboard script.
 * Reads data/europe.json, data/europe-map.json and data/history/<CC>.json (built by
 * `python -m polls build`). Plain browser JavaScript and D3 v7; no build step.
 */
(() => {
  "use strict";

  // ------------------------------------------------------------------------------- helpers
  const DAY = 864e5;
  const $ = (s, root = document) => root.querySelector(s);
  const parseISO = (s) => { const [y, m, d] = s.slice(0, 10).split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
  const addDays = (date, n) => new Date(date.getTime() + n * DAY);
  const fmtDate = d3.utcFormat("%-d %b %Y");
  const fmtDayMonth = d3.utcFormat("%-d %b");
  const fmtMonYear = d3.utcFormat("%b %Y");
  const fmt1 = (v) => (v == null || Number.isNaN(v) ? "–" : v.toFixed(1));
  const fmtSigned = (v) => (v == null ? "–" : (v > 0.05 ? "+" : v < -0.05 ? "−" : "±") + Math.abs(v).toFixed(1));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const store = {
    get(k, d) { try { const v = localStorage.getItem("polls2:" + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("polls2:" + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
  };
  let uid = 0;

  const state = {
    data: null, countries: [], today: new Date(), view: "map",
    region: store.get("region", "All"), sort: store.get("sort", "gap"),
    shared: store.get("shared", false), minor: store.get("minor", false), trendsOnly: store.get("trendsOnly", false),
    table: false, selected: new Set(store.get("selected", [])),
    lr: { code: "PL", trendsOnly: false, govt: true, minor: false, hidden: new Set(), domain: null, data: {} },
    map: null,
    mapMode: store.get("mapMode", "gov"),          // "gov": government poll lead/lag; "place": poll share of the party in a
                                                     // given place; "ideo": poll share of an ideology group
    mapAt: null,                                     // null = latest data; else a week index into the timeline
    timeline: null, timelinePromise: null,
    // ideology group: by "family" (Manifesto Project party family) or by one measure with a range per measure
    cls: { by: store.get("clsBy", "family"), fams: new Set(store.get("clsFams", [70])), ranges: store.get("clsRanges", {}), cmp: store.get("ideoCmp", false) },
    scatter: { x: store.get("scX", "change"), y: store.get("scY", "gap") },
    palette: store.get("palette", "blueorange"),
    mapPlace: store.get("mapPlace", "gov"),        // "place" mode: "gov" (governing party) or "1", "2", "3"
    hue: store.get("hue", "blue"),
    theme: store.get("theme", "light"),                // light by default, whatever the system setting
  };

  function isDark() {
    const t = document.documentElement.dataset.theme;
    if (t === "dark") return true;
    if (t === "light") return false;
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  }
  const pcolor = (p) => (p ? (isDark() ? p.color_dark : p.color) : null) || "#8a8f99";
  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  // ------------------------------------------------------------------------------- palettes
  // Only the "ahead / behind" (positive / negative) colours change; party colours never do.
  // ramp: map fill from strongly negative to strongly positive (the ends are kept mid-dark so the
  // figures printed on top stay readable).
  const PALETTES = {
    blueorange: { label: "Blue and orange", pos: "#052c5d", neg: "#db551e", posInk: "#052c5d", negInk: "#a63d10",
      ramp: ["#db551e", "#f19a48", "#fcd27a", "#f4f3ef", "#bfe0f1", "#7ec1e4", "#3b78b4"] },
    bavaria: { label: "Bavarian blue and red", pos: "#1561B3", neg: "#B22234", posInk: "#0f4f95", negInk: "#9c1c2c",
      ramp: ["#B22234", "#D8585D", "#F49E7C", "#FDE08B", "#D2E6F5", "#98C9EE", "#4F98D8", "#1561B3"] },
    greenred: { label: "Green and red", pos: "#11744a", neg: "#c0322f", posInk: "#0b5d3a", negInk: "#9e2421",
      ramp: ["#d9695f", "#e9a199", "#f3d3cf", "#f3f2ef", "#cfe3d6", "#94c3a6", "#5a9f78"] },
    tealplum: { label: "Teal and plum", pos: "#0f7c80", neg: "#8e3a74", posInk: "#0b6366", negInk: "#76285f",
      ramp: ["#9c4a84", "#c387b1", "#e7cde0", "#f3f2ef", "#c6e4e2", "#74bdbb", "#228b8e"] },
    olivepurple: { label: "Olive and violet", pos: "#5f7d1c", neg: "#6b3fa0", posInk: "#4b6413", negInk: "#56308a",
      ramp: ["#7650ab", "#a98bd0", "#ddd2ee", "#f3f2ef", "#e0e8c6", "#abc070", "#6f8c27"] },
  };
  const palette = () => PALETTES[state.palette] || PALETTES.blueorange;

  /** Write the palette into the CSS variables used everywhere for ahead / behind. */
  function applyPalette() {
    const P = palette(), root = document.documentElement.style, dark = isDark();
    const lift = (c) => d3.interpolateLab(c, "#ffffff")(0.38);
    const rgba = (c, a) => { const r = d3.rgb(c); return `rgba(${r.r}, ${r.g}, ${r.b}, ${a})`; };
    const pos = dark ? lift(P.pos) : P.pos, neg = dark ? lift(P.neg) : P.neg;
    root.setProperty("--lead", pos); root.setProperty("--trail", neg);
    root.setProperty("--lead-ink", dark ? d3.interpolateLab(P.pos, "#ffffff")(0.55) : P.posInk);
    root.setProperty("--trail-ink", dark ? d3.interpolateLab(P.neg, "#ffffff")(0.5) : P.negInk);
    root.setProperty("--lead-wash", rgba(pos, dark ? 0.17 : 0.13));
    root.setProperty("--trail-wash", rgba(neg, dark ? 0.17 : 0.12));
  }
  /** Map fill for a value in [-20, +20] (beyond is clamped). */
  function rampColor(v) {
    const P = palette();
    let ramp = P.ramp;
    if (isDark()) { const n = cssVar("--neutral-fill") || "#262a31"; ramp = ramp.map((c) => d3.interpolateLab(c, n)(0.38)); }
    const t = (clamp(v, -20, 20) + 20) / 40;
    const k = t * (ramp.length - 1), i = Math.min(ramp.length - 2, Math.floor(k));
    return d3.interpolateLab(ramp[i], ramp[i + 1])(k - i);
  }

  // One hue for the poll share of an ideology group, from white (none) to the full colour.
  const HUES = {
    red: { label: "Red", c: "#a50f15" }, orange: { label: "Orange", c: "#d94801", ink: "#a63603" },
    blue: { label: "Blue", c: "#08519c" }, green: { label: "Green", c: "#006d2c" },
  };
  const hue = () => HUES[state.hue] || HUES.blue;
  function applyHue() {
    const H = hue(), root = document.documentElement.style, dark = isDark();
    const c = dark ? d3.interpolateLab(H.c, "#ffffff")(0.3) : H.c, r = d3.rgb(c);
    root.setProperty("--bloc", c);
    root.setProperty("--bloc-ink", dark ? d3.interpolateLab(H.c, "#ffffff")(0.5) : H.ink || H.c);
    root.setProperty("--bloc-wash", `rgba(${r.r}, ${r.g}, ${r.b}, ${dark ? 0.2 : 0.13})`);
  }

  function flagImg(code, cls = "flag") {
    const src = (window.FLAGS || {})[code];
    if (!src) return null;
    const img = el("img", cls); img.src = src; img.alt = ""; img.width = 22; img.height = 22;
    return img;
  }

  /** "2 years and 41 days", "1 year", "251 days": calendar years first, then the remaining days. */
  function spanText(a, b) {
    let years = 0, d = a;
    for (;;) {
      const n = new Date(Date.UTC(d.getUTCFullYear() + 1, d.getUTCMonth(), d.getUTCDate()));
      if (n <= b) { years++; d = n; } else break;
    }
    const days = Math.round((b - d) / DAY);
    const yt = years ? `${years} year${years > 1 ? "s" : ""}` : "";
    const dt = `${days} day${days === 1 ? "" : "s"}`;
    return years ? (days ? `${yt} and ${dt}` : yt) : dt;
  }
  function untilText(c) {
    if (c.completed) return `election held ${fmtDayMonth(c.end)}`;
    if (c.end <= state.today) return "election due";
    return spanText(state.today, c.end);
  }

  /** Append a sentence built from parts: strings, or [tag, text, className, onClick]. */
  function rich(parent, parts) {
    parent.replaceChildren();
    for (const p of parts) {
      if (typeof p === "string") { parent.append(document.createTextNode(p)); continue; }
      if (p instanceof Node) { parent.append(p); continue; }
      const [tag, text, cls, onClick] = p;
      const e = el(tag, cls || null, text);
      if (onClick) { e.type = "button"; e.addEventListener("click", onClick); }
      parent.append(e);
    }
  }

  // ------------------------------------------------------------------------------- tooltip
  const tip = $("#tooltip");
  function showTip(evt, build) {
    tip.replaceChildren();
    build(tip);
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    let x = evt.clientX + 14, y = evt.clientY + 14;
    if (x + r.width > window.innerWidth - 8) x = evt.clientX - r.width - 14;
    if (y + r.height > window.innerHeight - 8) y = evt.clientY - r.height - 14;
    tip.style.left = Math.max(8, x) + "px";
    tip.style.top = Math.max(8, y) + "px";
  }
  const hideTip = () => { tip.hidden = true; };
  function tipRow(parent, color, label, value, strong) {
    const row = el("div", "tt-row" + (strong ? " inc" : ""));
    const key = el("i"); key.style.background = color;
    row.append(key, el("span", null, label), el("b", null, value));
    parent.append(row);
  }

  // ------------------------------------------------------------------------------- data prep
  function prepare(c) {
    c.start = parseISO(c.last_election);
    c.end = c.next_election ? parseISO(c.next_election) : addDays(state.today, 365);
    c.dates = c.trend.days.map((d) => addDays(c.start, d));
    c.byKey = new Map(c.parties.map((p) => [p.key, p]));
    c.periods = (c.incumbents || []).map((p) => ({ ...p, fromD: parseISO(p.from), toD: p.to ? parseISO(p.to) : null }));
    c.incKeyAt = c.dates.map((d) => { let k = null; for (const p of c.periods) if (p.fromD <= d) k = p.key; return k; });
    const keys = c.parties.map((p) => p.key);
    c.incVal = []; c.rivalVal = []; c.rivalKey = [];
    c.dates.forEach((d, i) => {
      const k = c.incKeyAt[i];
      const v = k && c.trend.series[k] ? c.trend.series[k][i] : null;
      let best = null, bk = null;
      for (const o of keys) {
        if (o === k) continue;
        const s = c.trend.series[o];
        const ov = s ? s[i] : null;
        if (ov != null && (best == null || ov > best)) { best = ov; bk = o; }
      }
      c.incVal.push(v == null ? null : v); c.rivalVal.push(best); c.rivalKey.push(bk);
    });
    c.inc = c.incumbent && c.incumbent.key ? c.byKey.get(c.incumbent.key) : null;
    c.rival = c.stats && c.stats.rival ? c.byKey.get(c.stats.rival) : null;
    c.completed = !!c.fallback_completed_cycle;
    c.upcoming = c.upcoming_next_election ? parseISO(c.upcoming_next_election) : null;
    c.termFrac = clamp((state.today - c.start) / (c.end - c.start), 0, 1);
    c.lastData = c.last_poll ? parseISO(c.last_poll) : c.start;
    c.status = !c.inc || !c.stats ? "none" : c.stats.gap_now >= 0 ? "lead" : "trail";
    c.pollDates = c.polls.t.map((t) => addDays(c.start, t));
    return c;
  }

  function visibleKeys(c, opts = {}) {
    const hidden = opts.hidden || new Set();
    const incKeys = new Set(c.periods.map((p) => p.key).filter(Boolean));
    return c.parties
      .filter((p) => !hidden.has(p.key))
      .filter((p) => opts.all || state.minor || !p.minor || incKeys.has(p.key) || (c.rival && p.key === c.rival.key))
      .filter((p) => c.trend.series[p.key] && c.trend.series[p.key].some((v) => v != null))
      .map((p) => p.key);
  }

  function maxValue(c, keys, withPolls) {
    let m = 0;
    for (const k of keys) {
      for (const v of c.trend.series[k] || []) if (v != null && v > m) m = v;
      const p = c.byKey.get(k);
      if (p && p.result != null && p.result > m) m = p.result;
      if (withPolls) for (const v of c.polls.v[k] || []) if (v != null && v > m) m = v;
    }
    return m;
  }
  const niceMax = (m) => Math.max(20, Math.ceil((m + 3) / 10) * 10);
  const shortLabel = (s) => (s.length > 16 ? s.split(/[\s–-]+/).map((w) => w[0]).join("").toUpperCase() : s);
  // value at the end of the trend: the last trend point if it is within 45 days of the end of the
  // term's grid (the line can stop a few days short after the last poll), otherwise null (a party
  // no longer polled, such as a dissolved list)
  const lastVal = (c, k) => {
    const s = c.trend.series[k] || [], d = c.trend.days;
    for (let i = s.length - 1; i >= 0; i--) if (s[i] != null) return d[d.length - 1] - d[i] <= 45 ? s[i] : null;
    return null;
  };

  // ------------------------------------------------------------------------------- ideology groups
  // Parties are grouped by one Manifesto Project variable at a time: the party family, or one of the
  // measures below. Each measure is a share of the manifesto's statements, in per cent; the "for minus
  // against" measures subtract the negative category from the positive one. The slider ends stand
  // for "or less" and "or more".
  const MEASURES = {
    rile: { label: "Left–right (RILE)", short: "RILE", lo: -60, hi: 60, step: 1, dp: 0, signed: true, ends: ["left", "right"],
      about: "Right-wing minus left-wing statements, as a share of the manifesto: below zero is left, above zero is right (the Manifesto Project's RILE index, 26 categories)." },
    planeco: { label: "Market regulation and planning", short: "Regulation and planning", lo: 0, hi: 20, step: 0.5, dp: 1,
      about: "Share of the manifesto calling for market regulation, economic planning or a controlled economy (categories 403, 404 and 412)." },
    markeco: { label: "Free market economy", short: "Free market", lo: 0, hi: 20, step: 0.5, dp: 1,
      about: "Share of the manifesto in favour of the free market and economic orthodoxy (categories 401 and 414)." },
    welfare: { label: "Welfare state and equality", short: "Welfare and equality", lo: 0, hi: 40, step: 1, dp: 1,
      about: "Share of the manifesto in favour of equality and a larger welfare state (categories 503 and 504)." },
    intpeace: { label: "Peace and anti-militarism", short: "Peace", lo: 0, hi: 10, step: 0.5, dp: 1,
      about: "Share of the manifesto in favour of peace, against the military and against special relationships with particular countries (categories 102, 105 and 106)." },
    eu: { label: "European Union, for minus against", short: "EU", lo: -10, hi: 10, step: 0.5, dp: 1, signed: true, ends: ["against", "for"],
      about: "Statements for the European Union minus statements against it, as a share of the manifesto (category 108 minus 110)." },
    nation: { label: "National way of life, for minus against", short: "National way of life", lo: -10, hi: 20, step: 0.5, dp: 1, signed: true, ends: ["against", "for"],
      about: "Appeals to patriotism and the nation's history and culture minus statements against them (category 601 minus 602)." },
    multicult: { label: "Multiculturalism, for minus against", short: "Multiculturalism", lo: -10, hi: 10, step: 0.5, dp: 1, signed: true, ends: ["against", "for"],
      about: "Statements for cultural diversity minus statements for cultural integration (category 607 minus 608)." },
    laworder: { label: "Law and order", short: "Law and order", lo: 0, hi: 20, step: 0.5, dp: 1,
      about: "Share of the manifesto calling for stricter law enforcement and tougher action on crime (category 605)." },
    environ: { label: "Environmental protection", short: "Environment", lo: 0, hi: 20, step: 0.5, dp: 1,
      about: "Share of the manifesto on protecting the environment and fighting climate change (category 501)." },
  };
  const FAMILY_CODES = [10, 20, 30, 40, 50, 60, 70, 80, 90, 95, 98];
  const famName = (f) => ((state.data && state.data.party_families) || {})[String(f)] || "Unknown family";
  function fmtM(k, v) {
    const m = MEASURES[k], r = +(+v).toFixed(m.dp), s = Math.abs(r).toFixed(m.dp);
    return m.signed ? (r > 0 ? "+" : r < 0 ? "−" : "") + s : s;
  }

  /** Preset ranges: named ones for left-right, quarters and tenths of today's parties for the rest. */
  const presetCache = {};
  function presetsFor(k) {
    if (presetCache[k]) return presetCache[k];
    const m = MEASURES[k];
    let out;
    if (k === "rile") {
      out = [{ label: "Most left", lo: m.lo, hi: -25 }, { label: "Left", lo: -25, hi: -10 }, { label: "Centre", lo: -10, hi: 10 },
        { label: "Right", lo: 10, hi: 25 }, { label: "Most right", lo: 25, hi: m.hi }];
    } else {
      const vals = [];
      state.countries.forEach((c) => c.parties.forEach((p) => { if (p.mp && p.mp[k] != null && lastVal(c, p.key) != null) vals.push(p.mp[k]); }));
      vals.sort(d3.ascending);
      const q = (f) => clamp(Math.round(d3.quantileSorted(vals, f) / m.step) * m.step, m.lo, m.hi);
      out = [{ label: "Bottom tenth", lo: m.lo, hi: q(0.1) }, { label: "Bottom quarter", lo: m.lo, hi: q(0.25) },
        { label: "Top quarter", lo: q(0.75), hi: m.hi }, { label: "Top tenth", lo: q(0.9), hi: m.hi }];
      // when a tenth and a quarter round to the same cut, keep the quarter, the wider and honest name
      out = out.filter((p) => !(p.label.endsWith("tenth") && out.some((o) => o !== p && o.lo === p.lo && o.hi === p.hi)));
    }
    out.push({ label: "All", lo: m.lo, hi: m.hi });
    return (presetCache[k] = out);
  }
  function rangeOf(k) {
    if (state.cls.ranges[k]) return state.cls.ranges[k];
    const pr = presetsFor(k);
    const d = k === "rile" ? pr.find((p) => p.label === "Most right") : pr.find((p) => p.label === "Top quarter") || pr[pr.length - 1];
    return { lo: d.lo, hi: d.hi };
  }
  function rangeText(k) {
    const m = MEASURES[k], r = rangeOf(k), a = r.lo <= m.lo, b = r.hi >= m.hi;
    if (a && b) return `any ${m.short} score`;
    if (a) return `${m.short} ${fmtM(k, r.hi)} or lower`;
    if (b) return `${m.short} ${fmtM(k, r.lo)} or higher`;
    return `${m.short} ${fmtM(k, r.lo)} to ${fmtM(k, r.hi)}`;
  }
  const famList = () => [...state.cls.fams].sort((a, b) => a - b).map(famName);
  /** Short name of the chosen group, for legends and labels. */
  function groupName() {
    if (state.cls.by !== "family") return rangeText(state.cls.by);
    const f = famList();
    return f.length ? f.join(", ") : "no family ticked";
  }
  /** The chosen group as a noun phrase: "parties in the Ecological family", "parties with RILE +25 or higher". */
  function groupPhrase() {
    if (state.cls.by !== "family") return `parties with ${rangeText(state.cls.by)}`;
    const f = famList();
    if (!f.length) return "no parties (no family is ticked)";
    return `parties in the ${f.length === 1 ? f[0] : f.slice(0, -1).join(", ") + " and " + f[f.length - 1]} famil${f.length === 1 ? "y" : "ies"}`;
  }
  /** Has the party what the current grouping needs (a family, or a score on the measure)? */
  const scored = (mp, fam) => (state.cls.by === "family" ? fam != null && fam !== 999 : !!(mp && mp[state.cls.by] != null));
  function inGroup(mp, fam) {
    const by = state.cls.by;
    if (by === "family") return fam != null && state.cls.fams.has(fam);
    const v = mp ? mp[by] : null;
    if (v == null) return false;
    const m = MEASURES[by], r = rangeOf(by);
    return (r.lo <= m.lo || v >= r.lo - 1e-9) && (r.hi >= m.hi || v <= r.hi + 1e-9);
  }
  /** What to print after a party's name in a list of the group: its score, or its family when several are ticked. */
  function partyTag(mp, fam, inherited) {
    const inh = inherited ? ", inherited" : "";
    if (state.cls.by === "family") return state.cls.fams.size > 1 ? ` (${famName(fam)}${inh})` : inherited ? " (inherited)" : "";
    const v = mp ? mp[state.cls.by] : null;
    return v == null ? "" : ` (${fmtM(state.cls.by, v)}${inh})`;
  }
  const missingWord = () => (state.cls.by === "family" ? "no Manifesto family" : "no Manifesto score");

  /** Parties of a country's current term in the group, with their latest trend values. */
  function blocNow(c, excludeKey) {
    const parts = [], unplaced = [];
    for (const p of c.parties) {
      const v = lastVal(c, p.key); if (v == null) continue;
      if (!scored(p.mp, p.family)) { if (v >= 1) unplaced.push({ p, v }); continue; }
      if (p.key === excludeKey) continue;
      if (inGroup(p.mp, p.family)) parts.push({ p, v });
    }
    parts.sort((a, b) => b.v - a.v); unplaced.sort((a, b) => b.v - a.v);
    return { share: d3.sum(parts, (x) => x.v), parts, unplaced, unplacedShare: d3.sum(unplaced, (x) => x.v) };
  }
  /** The group's parties added up, along the term (trend) and per poll. */
  function blocSeries(c, exclude) {
    const keys = c.parties.filter((p) => inGroup(p.mp, p.family) && !exclude.has(p.key)).map((p) => p.key);
    const add = (get, n) => Array.from({ length: n }, (_, i) => {
      let sum = 0, any = false;
      for (const k of keys) { const v = get(k, i); if (v != null) { sum += v; any = true; } }
      return any ? sum : null;
    });
    return { keys, vals: add((k, i) => (c.trend.series[k] || [])[i], c.dates.length), polls: add((k, j) => (c.polls.v[k] || [])[j], c.polls.t.length) };
  }

  const ideoSyncs = new Set();
  let ideoTimer = null;
  function clsChanged() {
    store.set("clsBy", state.cls.by); store.set("clsFams", [...state.cls.fams]); store.set("clsRanges", state.cls.ranges);
    ideoSyncs.forEach((f) => f());
    clearTimeout(ideoTimer);
    ideoTimer = setTimeout(() => {
      if (state.view === "map") renderMap();
      if (state.view === "correlates") renderScatter();
      if (state.view === "graphs") renderGrid();
    }, 60);
  }
  function setRange(k, lo, hi, fromSlider) {
    if (lo > hi) { if (fromSlider === "lo") hi = lo; else lo = hi; }
    state.cls.ranges[k] = { lo, hi };
    clsChanged();
  }

  /** The group picker: what to group by, then family boxes or a range (presets, two sliders, a strip). */
  function mountIdeo(host) {
    if (host.dataset.mounted) return;
    host.dataset.mounted = "1";
    const box = el("div", "ideo");
    const top = el("div", "ideo-by");
    const sel = el("select"); sel.id = host.id + "-by";
    const lab = el("label", "select"); lab.htmlFor = sel.id;
    lab.append(el("span", null, "Group parties by"), sel);
    const og1 = el("optgroup"); og1.label = "Manifesto Project classification";
    const of = el("option", null, "Party family"); of.value = "family"; og1.append(of);
    const og2 = el("optgroup"); og2.label = "Manifesto Project measures";
    Object.entries(MEASURES).forEach(([k, m]) => { const o = el("option", null, m.label); o.value = k; og2.append(o); });
    sel.append(og1, og2);
    sel.addEventListener("change", () => { state.cls.by = sel.value; clsChanged(); });
    top.append(lab);
    const about = el("p", "ideo-about");
    const body = el("div", "ideo-body");
    const note = el("p", "note");
    box.append(top, about, body, note); host.append(box);
    let mode = null, ctl = null;
    const sync = () => {
      sel.value = state.cls.by;
      if (mode !== state.cls.by) {
        mode = state.cls.by; body.replaceChildren();
        ctl = mode === "family" ? buildFamilies(body) : buildMeasure(body, host.id, mode);
      }
      about.textContent = mode === "family"
        ? "The party family recorded by the Manifesto Project, one per party. Tick one family or several; the figure after each is how many of its parties poll 3% or more."
        : MEASURES[mode].about;
      ctl.sync();
      note.textContent = groupNote(host.id === "map-ideo");
    };
    ideoSyncs.add(sync);
    sync();
  }
  function buildFamilies(body) {
    const wrap = el("div", "fam-list"); wrap.setAttribute("role", "group"); wrap.setAttribute("aria-label", "Party families");
    const counts = new Map();
    state.countries.forEach((c) => c.parties.forEach((p) => { if (p.family != null && (lastVal(c, p.key) || 0) >= 3) counts.set(p.family, (counts.get(p.family) || 0) + 1); }));
    const boxes = FAMILY_CODES.map((f) => {
      const lab = el("label", "check"); const cb = el("input"); cb.type = "checkbox";
      cb.addEventListener("change", () => { if (cb.checked) state.cls.fams.add(f); else state.cls.fams.delete(f); clsChanged(); });
      lab.append(cb, el("span", null, `${famName(f)} (${counts.get(f) || 0})`));
      wrap.append(lab); return [f, cb];
    });
    body.append(wrap);
    return { sync: () => boxes.forEach(([f, cb]) => { cb.checked = state.cls.fams.has(f); }) };
  }
  function buildMeasure(body, hostId, k) {
    const m = MEASURES[k];
    const pres = el("div", "textlinks"); pres.setAttribute("role", "radiogroup"); pres.setAttribute("aria-label", `Preset ranges of ${m.label}`);
    const sl = el("div", "ideo-sliders");
    const mk = (key, label) => {
      const lab = el("label"); const inp = el("input"); inp.type = "range"; inp.id = `${hostId}-${key}`;
      inp.min = m.lo; inp.max = m.hi; inp.step = m.step; lab.htmlFor = inp.id;
      const out = el("output"); out.htmlFor = inp.id;
      lab.append(el("span", null, label), inp, out);
      inp.addEventListener("input", () => { const r = rangeOf(k); setRange(k, key === "lo" ? +inp.value : r.lo, key === "hi" ? +inp.value : r.hi, key); });
      return { lab, inp, out };
    };
    const a = mk("lo", "From"), b = mk("hi", "to");
    sl.append(a.lab, b.lab);
    const strip = el("div", "ideo-strip");
    body.append(pres, sl, strip);
    const btns = presetsFor(k).map((pr) => {
      const btn = el("button", "tl", pr.label); btn.type = "button"; btn.setAttribute("role", "radio");
      btn.addEventListener("click", () => setRange(k, pr.lo, pr.hi));
      pres.append(btn); return [pr, btn];
    });
    new ResizeObserver(() => { if (state.cls.by === k && strip.isConnected) drawStrip(strip, k); }).observe(strip);
    return {
      sync: () => {
        const r = rangeOf(k);
        a.inp.value = r.lo; b.inp.value = r.hi;
        a.out.textContent = r.lo <= m.lo && m.lo < 0 ? `${fmtM(k, m.lo)} or less` : fmtM(k, r.lo);
        b.out.textContent = r.hi >= m.hi ? `${fmtM(k, m.hi)} or more` : fmtM(k, r.hi);
        btns.forEach(([pr, btn]) => btn.setAttribute("aria-checked", String(pr.lo === r.lo && pr.hi === r.hi)));
        drawStrip(strip, k);
      },
    };
  }
  /** One sentence on who is in the group today, and who cannot be placed. */
  function groupNote(onMap) {
    const by = state.cls.by, now = [];
    let none = 0;
    state.countries.forEach((c) => c.parties.forEach((p) => {
      const v = lastVal(c, p.key); if (v == null || v < 3) return;
      if (!scored(p.mp, p.family)) none++; else if (inGroup(p.mp, p.family)) now.push({ c, p, v });
    }));
    now.sort((x, y) => y.v - x.v);
    const ex = now.slice(0, 5).map((x) => `${shortLabel(x.p.label)} (${x.c.code}${by === "family" ? "" : ", " + fmtM(by, x.p.mp[by])})`).join(", ");
    return (now.length ? `The group takes in ${now.length} ${now.length === 1 ? "party" : "parties"} polling 3% or more, for example ${ex}. ` : "No party polling 3% or more is in the group. ")
      + `${none} parties polling 3% or more have ${missingWord()} and are never counted`
      + (onMap ? `; where such parties poll ${UNPLACED_HATCH}% or more together, the country is hatched on the map, because its figure may be too low.` : ".")
      + (by === "family" ? "" : ` Each mark above is a party polling 2% or more, placed by its latest manifesto${by === "rile" ? "" : "; quarters and tenths divide the parties polled today"}.`);
  }
  function drawStrip(host, k) {
    const m = MEASURES[k], r = rangeOf(k);
    const W = Math.max(280, Math.round(host.clientWidth || 600)), H = 46;
    const x = d3.scaleLinear([m.lo, m.hi], [8, W - 8]);
    const svg = d3.create("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("role", "img")
      .attr("aria-label", `Party positions on ${m.label}; chosen range ${rangeText(k)}`);
    const lo = Math.max(m.lo, r.lo), hi = Math.min(m.hi, r.hi);
    svg.append("rect").attr("class", "strip-band").attr("x", x(lo)).attr("y", 2).attr("width", Math.max(1, x(hi) - x(lo))).attr("height", 28);
    const pts = [];
    state.countries.forEach((c) => c.parties.forEach((p) => { const v = lastVal(c, p.key); if (p.mp && p.mp[k] != null && v >= 2) pts.push({ c, p, v, s: p.mp[k] }); }));
    pts.sort((a, b) => a.s - b.s);
    const g = svg.append("g");
    pts.forEach((d, i) => {
      g.append("circle").attr("cx", x(clamp(d.s, m.lo, m.hi))).attr("cy", 9 + (i % 4) * 5.5).attr("r", clamp(Math.sqrt(d.v) * 0.75, 1.6, 4.2))
        .attr("fill", pcolor(d.p)).attr("opacity", inGroup(d.p.mp, d.p.family) ? 0.95 : 0.3)
        .on("pointermove", (evt) => showTip(evt, (t) => {
          t.append(el("div", "tt-head", `${d.p.label} (${d.c.name})`));
          t.append(el("div", "tt-sub", `${m.short} ${fmtM(k, d.s)} (${d.p.mp_year} manifesto${d.p.mp_inherited ? ", inherited" : ""})${d.p.family ? ". " + famName(d.p.family) : ""}. Polling ${fmt1(d.v)}%.`));
        }))
        .on("pointerleave", hideTip);
    });
    const ax = svg.append("g").attr("class", "strip-axis");
    x.ticks(W < 480 ? 4 : 6).filter((t) => !m.ends || (x(t) > 40 && x(t) < W - 40)).forEach((t) => {
      ax.append("line").attr("x1", x(t)).attr("x2", x(t)).attr("y1", 31).attr("y2", 34);
      ax.append("text").attr("x", x(t)).attr("y", 44).attr("text-anchor", "middle").text(fmtM(k, t).replace(/\.0$/, ""));
    });
    if (m.ends) {
      ax.append("text").attr("x", 8).attr("y", 44).text(m.ends[0]);
      ax.append("text").attr("x", W - 8).attr("y", 44).attr("text-anchor", "end").text(m.ends[1]);
    }
    host.replaceChildren(svg.node());
  }

  // ------------------------------------------------------------------------------- cycle chart
  /** Draw one country's term: lines, lead/deficit shading, today marker, end labels. */
  function drawCycleChart(host, c, o) {
    const W = o.width, H = o.height;
    const m = { t: o.compact ? 14 : 22, r: o.compact ? 46 : 70, b: 26, l: o.compact ? 24 : 32 };
    const keys = o.keys;
    const x = d3.scaleUtc([c.start, c.end], [m.l, W - m.r]);
    const y = d3.scaleLinear([0, o.yMax], [H - m.b - 7, m.t]);
    const plotTop = m.t, plotBot = H - m.b - 7;
    const id = "c" + (++uid);
    const svg = d3.create("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("role", "img").attr("aria-label", o.aria || c.name);

    // remaining term
    const futureFrom = c.completed ? c.end : clamp(+c.lastData, +c.start, +c.end);
    if (futureFrom < +c.end) {
      svg.append("rect").attr("class", "future").attr("x", x(futureFrom)).attr("y", plotTop)
        .attr("width", Math.max(0, x(c.end) - x(futureFrom))).attr("height", plotBot - plotTop);
    }
    // grid + y labels
    const yt = y.ticks(o.compact ? 4 : 6);
    const g = svg.append("g");
    g.selectAll("line").data(yt).join("line").attr("class", "gridline")
      .attr("x1", m.l).attr("x2", W - m.r).attr("y1", (d) => y(d)).attr("y2", (d) => y(d));
    g.selectAll("text").data(yt).join("text").attr("class", "axis-y")
      .attr("x", m.l - 5).attr("y", (d) => y(d) + 3.5).attr("text-anchor", "end")
      .text((d, i) => (i === yt.length - 1 ? d + "%" : d));
    // x axis: years, plus the election dates at both ends
    const ax = svg.append("g").attr("class", "axis");
    ax.append("line").attr("x1", m.l).attr("x2", x(c.end)).attr("y1", plotBot).attr("y2", plotBot);
    const endLabel = (c.completed ? "Election " : "") + fmtMonYear(c.end);
    const endW = endLabel.length * 6.1 + 6;
    const startW = o.compact ? 0 : ("Election " + fmtMonYear(c.start)).length * 6.1 + 6;
    const years = d3.utcYear.range(addDays(c.start, 1), c.end)
      .filter((d) => x(d) - x(c.start) > startW / 2 + 14 && x(c.end) - x(d) > endW + 14);
    ax.selectAll("text.yr").data(years).join("text").attr("class", "yr")
      .attr("x", (d) => x(d)).attr("y", H - 6).attr("text-anchor", "middle").text(d3.utcFormat("%Y"));
    ax.selectAll("line.yt").data(years).join("line").attr("class", "yt")
      .attr("x1", (d) => x(d)).attr("x2", (d) => x(d)).attr("y1", plotBot).attr("y2", plotBot + 3);
    ax.append("line").attr("x1", x(c.end)).attr("x2", x(c.end)).attr("y1", plotTop).attr("y2", plotBot + 3)
      .attr("stroke", "var(--ink-2)").attr("stroke-width", 1.2);
    ax.append("text").attr("x", x(c.end)).attr("y", H - 6).attr("text-anchor", "end").text(endLabel);
    ax.append("text").attr("x", x(c.start)).attr("y", H - 6).attr("text-anchor", "start")
      .text(o.compact ? "" : "Election " + fmtMonYear(c.start));

    // lead / deficit shading between the governing party and its strongest rival
    const cmp = o.compare || null;   // the ideology group, added up, instead of the rival
    const pts = c.dates.map((d, i) => ({ d, a: c.incVal[i], b: cmp ? cmp.vals[i] : c.rivalVal[i] }));
    const def = (p) => p.a != null && p.b != null;
    if (pts.some(def)) {
      const defs = svg.append("defs");
      defs.append("clipPath").attr("id", id + "-above").append("path")
        .attr("d", d3.area().defined(def).x((p) => x(p.d)).y0(plotTop).y1((p) => y(p.b))(pts));
      defs.append("clipPath").attr("id", id + "-below").append("path")
        .attr("d", d3.area().defined(def).x((p) => x(p.d)).y0((p) => y(p.b)).y1(plotBot)(pts));
      svg.append("path").attr("class", "lead-area").attr("clip-path", `url(#${id}-above)`)
        .attr("d", d3.area().defined(def).x((p) => x(p.d)).y0((p) => y(p.a)).y1(plotBot)(pts));
      svg.append("path").attr("class", "trail-area").attr("clip-path", `url(#${id}-below)`)
        .attr("d", d3.area().defined(def).x((p) => x(p.d)).y0(plotTop).y1((p) => y(p.a))(pts));
      // the "lead tape": a strip along the baseline, in the "ahead" colour or the "behind" colour
      const tape = svg.append("g");
      const stateAt = (i) => (!def(pts[i]) ? (c.incKeyAt[i] ? null : "tape-none") : pts[i].a >= pts[i].b ? "tape-lead" : "tape-trail");
      let runStart = 0;
      for (let i = 1; i <= pts.length; i++) {
        if (i < pts.length && stateAt(i) === stateAt(runStart)) continue;
        const cls = stateAt(runStart);
        const x0 = x(pts[runStart].d), x1 = x(pts[Math.min(i, pts.length - 1)].d);
        if (cls && x1 > x0) tape.append("rect").attr("class", cls).attr("x", x0).attr("y", plotBot + 1).attr("width", x1 - x0).attr("height", 4);
        runStart = i;
      }
    }

    // today marker
    if (!c.completed && state.today > c.start && state.today < c.end) {
      svg.append("line").attr("class", "today-line").attr("x1", x(state.today)).attr("x2", x(state.today))
        .attr("y1", plotTop - 4).attr("y2", plotBot);
      svg.append("text").attr("class", "today-label").attr("x", x(state.today) + 3).attr("y", plotTop - 4).text("today");
    }

    // handovers of the head of government
    c.periods.slice(1).forEach((p) => {
      if (p.fromD <= c.start || p.fromD >= c.end) return;
      const hx = x(p.fromD);
      svg.append("line").attr("class", "handover").attr("x1", hx).attr("x2", hx).attr("y1", plotTop).attr("y2", plotBot);
      if (!o.compact) {
        const surname = (p.leader || "").replace(/\s*\(.*\)$/, "").split(" ").slice(-1)[0];
        svg.append("text").attr("class", "handover-label label-halo").attr("x", hx + 3).attr("y", plotTop + 9).text(surname);
      }
    });

    // individual polls
    if (o.polls && cmp) {
      const pg = svg.append("g").attr("opacity", o.compact ? 0.4 : 0.5);
      cmp.polls.forEach((v, i) => { if (v != null) pg.append("circle").attr("cx", x(c.pollDates[i])).attr("cy", y(v)).attr("r", o.compact ? 1.5 : 2.1).attr("fill", "var(--bloc)"); });
    }
    if (o.polls) {
      const pg = svg.append("g").attr("opacity", o.compact ? 0.34 : 0.42);
      for (const k of keys) {
        const vals = c.polls.v[k]; if (!vals) continue;
        const col = pcolor(c.byKey.get(k));
        const isInc = c.periods.some((p) => p.key === k);
        for (let i = 0; i < vals.length; i++) {
          if (vals[i] == null) continue;
          pg.append("circle").attr("cx", x(c.pollDates[i])).attr("cy", y(vals[i]))
            .attr("r", o.compact ? 1.4 : isInc ? 2.4 : 1.9).attr("fill", col);
        }
      }
    }

    // party trend lines: others first (lighter), then the governing party on top
    const line = d3.line().defined((v) => v.v != null).x((v) => x(v.d)).y((v) => y(v.v)).curve(d3.curveMonotoneX);
    const series = (k) => c.dates.map((d, i) => ({ d, v: (c.trend.series[k] || [])[i] }));
    const curRival = c.rival && !cmp ? c.rival.key : null;
    const lines = svg.append("g").attr("fill", "none").attr("stroke-linecap", "round").attr("stroke-linejoin", "round");
    if (cmp) {
      lines.append("path").attr("d", line(c.dates.map((d, i) => ({ d, v: cmp.vals[i] })))).attr("stroke", "var(--bloc)")
        .attr("stroke-width", o.compact ? 2.4 : 3).attr("stroke-dasharray", "6 3");
    }
    for (const k of keys) {
      const p = c.byKey.get(k);
      lines.append("path").attr("d", line(series(k))).attr("stroke", pcolor(p))
        .attr("stroke-width", k === curRival ? 2 : p.minor ? 1.1 : 1.6)
        .attr("opacity", k === curRival ? 0.85 : p.minor ? 0.35 : 0.5);
    }
    // governing party: thick and opaque, only over the dates it governed
    for (const per of c.periods) {
      if (!per.key) continue;
      const p = c.byKey.get(per.key);
      if (!p) continue;
      const seg = c.dates.map((d, i) => ({ d, v: d >= per.fromD && (!per.toD || d <= per.toD) ? (c.trend.series[per.key] || [])[i] : null }));
      lines.append("path").attr("d", line(seg)).attr("stroke", pcolor(p)).attr("stroke-width", o.compact ? 3.4 : 4).attr("opacity", 1);
    }

    // election results of today's incumbent, as dots on the start (and end) line
    if (c.inc && c.inc.result != null) {
      svg.append("circle").attr("class", "result-dot").attr("cx", x(c.start)).attr("cy", y(c.inc.result)).attr("r", 4).attr("fill", pcolor(c.inc));
    }
    if (c.completed && c.inc && c.inc.result_end != null) {
      svg.append("circle").attr("class", "result-dot").attr("cx", x(c.end)).attr("cy", y(c.inc.result_end)).attr("r", 4.5).attr("fill", pcolor(c.inc));
    }

    // end labels for the governing party and its main rival
    const lastIdx = (k) => { const s = c.trend.series[k] || []; for (let i = s.length - 1; i >= 0; i--) if (s[i] != null) return i; return -1; };
    const labels = [];
    if (c.inc) labels.push({ k: c.inc.key, strong: true });
    if (curRival && keys.includes(curRival)) labels.push({ k: curRival, strong: false });
    if (!o.compact) for (const k of keys) if (!labels.some((l) => l.k === k) && !c.byKey.get(k).minor && lastVal(c, k) != null) labels.push({ k, strong: false });
    labels.forEach((l) => {
      const i = lastIdx(l.k); l.i = i;
      if (i < 0) return;
      l.x = x(c.dates[i]); l.y = y(c.trend.series[l.k][i]); l.v = c.trend.series[l.k][i];
    });
    if (cmp) {
      let i = cmp.vals.length - 1; while (i >= 0 && cmp.vals[i] == null) i--;
      if (i >= 0) labels.push({ k: "__bloc", i, x: x(c.dates[i]), y: y(cmp.vals[i]), v: cmp.vals[i], strong: true });
    }
    const placed = labels.filter((l) => l.i >= 0);
    for (let it = 0; it < 300; it++) {     // simple vertical de-collision
      let moved = false;
      placed.sort((p1, p2) => p1.y - p2.y);
      for (let j = 1; j < placed.length; j++) {
        const a = placed[j - 1], b = placed[j];
        if (Math.abs(a.x - b.x) < 70 && b.y - a.y < 11) { a.y -= 0.6; b.y += 0.6; moved = true; }
      }
      if (!moved) break;
    }
    for (const l of placed) {
      const right = l.x + 4 + 48 < W;
      const name = l.k === "__bloc" ? "Group" : shortLabel(c.byKey.get(l.k).label);
      const t = svg.append("text").attr("class", "end-label label-halo" + (l.strong ? " strong" : ""))
        .attr("x", right ? l.x + 5 : l.x - 5).attr("y", l.y + 3.5).attr("text-anchor", right ? "start" : "end")
        .text(`${name} ${fmt1(l.v)}`);
      if (l.k === "__bloc") t.attr("fill", "var(--bloc-ink)");
    }

    // interaction: crosshair + tooltip with every visible party at that date
    const cross = svg.append("line").attr("class", "crosshair").attr("y1", plotTop).attr("y2", plotBot).attr("visibility", "hidden");
    const overlay = svg.append("rect").attr("x", m.l).attr("y", plotTop).attr("width", Math.max(0, x(c.end) - m.l))
      .attr("height", plotBot - plotTop).attr("fill", "transparent").style("cursor", "crosshair");
    const bis = d3.bisector((d) => d).center;
    const moveTo = (i, evt) => {
      i = clamp(i, 0, c.dates.length - 1);
      cross.attr("x1", x(c.dates[i])).attr("x2", x(c.dates[i])).attr("visibility", "visible");
      showTip(evt, (t) => buildCycleTip(t, c, i, keys, cmp));
    };
    overlay.on("pointermove", (evt) => { const [px] = d3.pointer(evt); moveTo(bis(c.dates, x.invert(px)), evt); })
      .on("pointerleave", () => { cross.attr("visibility", "hidden"); hideTip(); });
    host.replaceChildren(svg.node());
    // keyboard: arrows move the crosshair
    host.tabIndex = 0;
    let ki = c.dates.length - 1;
    host.onkeydown = (e) => {
      if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
      e.preventDefault();
      ki = clamp(ki + (e.key === "ArrowRight" ? 1 : -1), 0, c.dates.length - 1);
      const r = host.getBoundingClientRect();
      moveTo(ki, { clientX: r.left + (x(c.dates[ki]) / W) * r.width, clientY: r.top + r.height * 0.3 });
    };
    host.onblur = () => { cross.attr("visibility", "hidden"); hideTip(); };
  }

  function buildCycleTip(t, c, i, keys, cmp) {
    t.append(el("div", "tt-head", fmtDate(c.dates[i])));
    const per = [...c.periods].reverse().find((p) => p.fromD <= c.dates[i]);
    if (per && per.leader) t.append(el("div", "tt-sub", `${per.title || "Head of government"}: ${per.leader}`));
    if (cmp) {
      const ik = c.incKeyAt[i], ip = ik ? c.byKey.get(ik) : null;
      if (ip && c.incVal[i] != null) tipRow(t, pcolor(ip), ip.label, fmt1(c.incVal[i]), true);
      if (cmp.vals[i] != null) tipRow(t, "var(--bloc)", `Ideology group (${groupName()})`, fmt1(cmp.vals[i]), true);
      cmp.keys.map((k) => ({ p: c.byKey.get(k), v: (c.trend.series[k] || [])[i] })).filter((r) => r.v != null).sort((a, b) => b.v - a.v)
        .forEach((r) => tipRow(t, pcolor(r.p), `   ${r.p.label}${partyTag(r.p.mp, r.p.family, r.p.mp_inherited)}`, fmt1(r.v)));
      if (c.incVal[i] != null && cmp.vals[i] != null) {
        const d = c.incVal[i] - cmp.vals[i];
        const gap = el("div", "tt-gap", d >= 0 ? `Governing party ${fmt1(d)} pp ahead of the group` : `Governing party ${fmt1(-d)} pp behind the group`);
        gap.style.color = d >= 0 ? "var(--lead-ink)" : "var(--trail-ink)";
        t.append(gap);
      }
      return;
    }
    const rows = keys.map((k) => ({ k, v: (c.trend.series[k] || [])[i] })).filter((r) => r.v != null).sort((a, b) => b.v - a.v);
    for (const r of rows.slice(0, 10)) {
      const p = c.byKey.get(r.k);
      tipRow(t, pcolor(p), p.label, fmt1(r.v), r.k === c.incKeyAt[i]);
    }
    const a = c.incVal[i], b = c.rivalVal[i];
    if (a != null && b != null) {
      const ip = c.byKey.get(c.incKeyAt[i]), rp = c.byKey.get(c.rivalKey[i]);
      const d = a - b;
      const gap = el("div", "tt-gap");
      gap.textContent = d >= 0 ? `${ip.label} ${fmt1(d)} pp ahead of ${rp.label}` : `${ip.label} ${fmt1(-d)} pp behind ${rp.label}`;
      gap.style.color = d >= 0 ? "var(--lead-ink)" : "var(--trail-ink)";
      t.append(gap);
    }
  }

  // ------------------------------------------------------------------------------- sentences
  function statusText(c) {
    if (c.status === "none") return c.incumbent && c.incumbent.caretaker ? "Caretaker government, no party line" : "No governing party to follow";
    const inc = shortLabel(c.inc.label), r = c.rival ? shortLabel(c.rival.label) : "the strongest rival";
    const g = c.stats.gap_now;
    if (c.completed) return g >= 0 ? `${inc} finished ${fmt1(g)} pp ahead of ${r}` : `${inc} finished ${fmt1(-g)} pp behind ${r}`;
    return g >= 0 ? `${inc} ${fmt1(g)} pp ahead of ${r}` : `${inc} ${fmt1(-g)} pp behind ${r}`;
  }

  function factsLine(parent, c) {
    const s = c.stats; if (!s) return;
    const ch = s.change;
    const parts = [];
    if (c.completed && s.final === "result") parts.push(`${fmt1(s.now)}% at the ${fmtMonYear(c.end)} election, `);
    else if (c.completed) parts.push(`${fmt1(s.now)}% at the end of the term, `);
    else parts.push(`${fmt1(s.now)}% now, `);
    parts.push(["span", `${fmtSigned(ch)}`, ch > 0.05 ? "up" : ch < -0.05 ? "down" : ""]);
    parts.push(` since the ${fmtMonYear(c.start)} election`);
    if (s.share_time_leading != null) parts.push(`, ahead for ${Math.round(s.share_time_leading * 100)}% of the term`);
    parts.push(".");
    rich(parent, parts);
  }

  function nextElectionText(c, long) {
    if (c.completed) return `Election held ${fmtDate(c.end)}` + (long && c.upcoming ? `; next one by ${fmtDate(c.upcoming)} (estimated)` : "");
    const st = c.next_status === "deadline" ? "due by " : c.next_status === "expected" ? "expected " : c.next_status === "estimated" ? "estimated " : "on ";
    return `${long ? "Next election" : "Election"} ${st}${fmtDate(c.end)}`;
  }

  // ------------------------------------------------------------------------------- panels
  function panel(c, yMax) {
    const a = el("article", "panel"); a.id = "p-" + c.code;
    const head = el("div", "panel-head");
    const f = flagImg(c.code); if (f) head.append(f);
    head.append(el("h3", null, c.name));
    a.append(head);
    const who = el("div", "who");
    if (c.inc) { const k = el("i", "key"); k.style.background = pcolor(c.inc); who.append(k); }
    const inc = c.incumbent || {};
    const leader = (inc.leader || "").replace(/\s*\(.*\)\s*$/, "");
    const nm = el("span", "name", leader ? `${leader}${c.inc ? ", " + c.inc.label : ""}` : "–");
    if (inc.leader) nm.title = `${inc.title || "Head of government"}: ${inc.leader}${c.inc ? " (" + (c.inc.article || c.inc.label) + ")" : ""}`;
    who.append(nm);
    a.append(who);
    const cmpOn = state.cls.cmp;
    let cmp = null, bn = null;
    if (cmpOn) {
      const ex = new Set(c.inc ? [c.inc.key] : []);
      cmp = blocSeries(c, ex); bn = blocNow(c, c.inc ? c.inc.key : null);
      const incNow = c.inc ? lastVal(c, c.inc.key) : null;
      const cls = incNow == null ? "none" : incNow >= bn.share ? "lead" : "trail";
      a.append(el("p", "status " + cls, c.inc && incNow != null
        ? `${shortLabel(c.inc.label)} ${fmt1(incNow)}, ideology group ${fmt1(bn.share)}` : `Ideology group ${fmt1(bn.share)}`));
      const fl = el("p", "facts");
      const incIn = c.inc && scored(c.inc.mp, c.inc.family) && inGroup(c.inc.mp, c.inc.family);
      const parts = [bn.parts.length ? "In the group: " + bn.parts.map((x) => `${shortLabel(x.p.label)} ${fmt1(x.v)}`).join(", ") + "." : `No ${incIn ? "other " : ""}party here is in the group (${groupName()}).`];
      if (incIn) parts.push(` ${shortLabel(c.inc.label)} is itself in the group and not counted in it.`);
      if (c.inc && !scored(c.inc.mp, c.inc.family)) parts.push(` ${shortLabel(c.inc.label)} has ${missingWord()}.`);
      const big = bn.unplaced.filter((x) => x.v >= 5 && (!c.inc || x.p.key !== c.inc.key));
      if (big.length) parts.push(` ${state.cls.by === "family" ? "No family" : "No score"}: ${big.map((x) => `${shortLabel(x.p.label)} ${fmt1(x.v)}`).join(", ")}.`);
      fl.textContent = parts.join("");
      a.append(fl);
    } else {
      a.append(el("p", "status " + c.status, statusText(c)));
      if (c.stats) { const fl = el("p", "facts"); factsLine(fl, c); a.append(fl); }
    }

    const chart = el("div", "chart");
    a.append(chart);
    const incKeys = [...new Set(c.periods.map((pp) => pp.key).filter((k) => k && c.byKey.has(k)))];
    const keys = cmpOn ? incKeys : visibleKeys(c);
    const aria = c.stats ? `${c.name}: ${statusText(c)}.` : c.name;
    const polls = !state.trendsOnly;
    let ymax = yMax || niceMax(maxValue(c, keys, polls));
    if (cmpOn && !yMax) ymax = niceMax(Math.max(maxValue(c, keys, polls), d3.max(cmp.vals) || 0, polls ? d3.max(cmp.polls) || 0 : 0));
    drawCycleChart(chart, c, { width: 360, height: 196, compact: true, keys, yMax: ymax, polls, aria, compare: cmp });

    const leg = el("div", "plegend");
    const shown = (cmpOn ? [...incKeys, ...cmp.keys] : keys).map((k) => ({ p: c.byKey.get(k), v: lastVal(c, k) })).filter((r) => r.v != null).sort((x1, x2) => x2.v - x1.v);
    shown.slice(0, 6).forEach(({ p, v }) => {
      const s = el("span"); const i = el("i"); i.style.background = pcolor(p);
      s.append(i, document.createTextNode(shortLabel(p.label) + " "), el("b", null, fmt1(v)));
      leg.append(s);
    });
    if (shown.length > 6) leg.append(el("span", null, `and ${shown.length - 6} more`));
    a.append(leg);

    if (!c.completed && state.today - c.lastData > 75 * DAY) a.append(el("p", "note stale", `Wikipedia lists no polls after ${fmtDate(c.lastData)}.`));
    if (c.note) a.append(el("p", "note", c.note));

    const foot = el("div", "panel-foot");
    const left = el("span", null, nextElectionText(c));
    const bar = el("span", "termbar"); bar.title = `${Math.round(c.termFrac * 100)}% of the term elapsed`;
    const fill = el("i"); fill.style.width = (c.termFrac * 100).toFixed(1) + "%"; bar.append(fill);
    const actions = el("span", "panel-actions");
    const src = el("a", null, `${c.n_polls} polls`);
    src.href = sourceHref(c.source);
    src.target = "_blank"; src.rel = "noopener"; src.title = "Source: " + c.source.page + " (Wikipedia)";
    const more = el("button", "linkbtn", "Expand"); more.type = "button";
    more.addEventListener("click", () => openDetail(c));
    actions.append(src, more);
    foot.append(left, bar, actions);
    a.append(foot);
    return a;
  }
  const sourceHref = (s) => (s.revid ? `https://en.wikipedia.org/w/index.php?title=${encodeURIComponent(s.page.replace(/ /g, "_"))}&oldid=${s.revid}` : s.url);

  // ------------------------------------------------------------------------------- countries view
  function filtered() {
    let cs = state.countries.filter((c) => state.region === "All" || c.region === state.region);
    if (state.selected.size) cs = cs.filter((c) => state.selected.has(c.code));
    const by = {
      gap: (a, b) => (a.stats ? a.stats.gap_now : 99) - (b.stats ? b.stats.gap_now : 99),
      "gap-desc": (a, b) => (b.stats ? b.stats.gap_now : -99) - (a.stats ? a.stats.gap_now : -99),
      change: (a, b) => (a.stats ? a.stats.change ?? 0 : 99) - (b.stats ? b.stats.change ?? 0 : 99),
      next: (a, b) => (a.completed ? 1e15 : +a.end) - (b.completed ? 1e15 : +b.end),
      term: (a, b) => b.termFrac - a.termFrac,
      name: (a, b) => a.name.localeCompare(b.name),
      bloc: (a, b) => blocNow(b, b.inc && state.cls.cmp ? b.inc.key : null).share - blocNow(a, a.inc && state.cls.cmp ? a.inc.key : null).share,
    }[state.sort] || ((a, b) => a.name.localeCompare(b.name));
    return cs.sort(by);
  }

  function renderGrid() {
    syncPaletteSwitch();
    const cs = filtered();
    const grid = $("#grid"), tw = $("#table-wrap");
    grid.hidden = state.table; tw.hidden = !state.table;
    let shared = null;
    if (state.shared) shared = niceMax(d3.max(cs, (c) => state.cls.cmp ? Math.max(maxValue(c, visibleKeys(c), !state.trendsOnly), d3.max(blocSeries(c, new Set(c.inc ? [c.inc.key] : [])).vals) || 0) : maxValue(c, visibleKeys(c), !state.trendsOnly)) || 40);
    document.querySelector(".lk-bloc-item").hidden = !state.cls.cmp;
    const lks = document.querySelectorAll(".legend-key .lk");
    lks.forEach((n) => {
      if (n.querySelector(".sw-lead")) n.lastChild.textContent = state.cls.cmp ? "Governing party ahead of the ideology group" : "Ahead of the strongest rival";
      if (n.querySelector(".sw-trail")) n.lastChild.textContent = state.cls.cmp ? "Behind it" : "Behind";
    });
    if (state.table) { renderTable(cs); return; }
    grid.replaceChildren(...cs.map((c) => panel(c, shared)));
    if (!cs.length) grid.append(el("p", "note", "No country matches the current filters."));
  }

  function renderTable(cs) {
    const t = el("table");
    const head = el("thead"); const hr = el("tr");
    const cols = [["Country"], ["Head of government"], ["Governing party"], ["Now", "num"], ["At election", "num"], ["Change", "num"],
      ["Strongest rival"], ["Gap", "num"], ["Ahead (share of term)", "num"], ["Polls", "num"], ["Next election"]];
    cols.forEach(([h, cls]) => hr.append(el("th", cls || null, h)));
    head.append(hr); t.append(head);
    const body = el("tbody");
    for (const c of cs) {
      const r = el("tr");
      const s = c.stats || {};
      const td = (txt, cls) => { const d = el("td", cls || null, txt); r.append(d); return d; };
      const nameCell = td("");
      const f = flagImg(c.code); if (f) nameCell.append(f);
      nameCell.append(document.createTextNode(c.name));
      td((c.incumbent && c.incumbent.leader) || "–");
      const pt = td("");
      if (c.inc) { const k = el("i", "key"); k.style.background = pcolor(c.inc); pt.append(k, document.createTextNode(c.inc.label)); }
      td(fmt1(s.now), "num");
      td(fmt1(s.result), "num");
      td(fmtSigned(s.change), "num " + (s.change > 0.05 ? "up" : s.change < -0.05 ? "down" : ""));
      td(c.rival ? c.rival.label : "–");
      td(fmtSigned(s.gap_now), "num " + (s.gap_now >= 0 ? "up" : "down"));
      td(s.share_time_leading != null ? Math.round(s.share_time_leading * 100) + "%" : "–", "num");
      td(String(c.n_polls), "num");
      td(c.completed ? `held ${fmtDate(c.end)}` : fmtDate(c.end));
      body.append(r);
    }
    t.append(body);
    $("#table-wrap").replaceChildren(t);
  }

  // ------------------------------------------------------------------------------- summary sentences
  function renderSummary() {
    const withInc = state.countries.filter((c) => c.stats && c.inc);
    const n = withInc.length;
    const trailing = withInc.filter((c) => c.stats.gap_now < 0).length;
    rich($("#s-trailing"), [["b", `${trailing} of ${n}`], " governing parties are behind a rival in the polls."]);
    const changes = withInc.map((c) => c.stats.change).filter((v) => v != null);
    const med = d3.median(changes);
    const sm = $("#s-median");
    sm.className = "s-line " + (med < -0.05 ? "neg" : med > 0.05 ? "pos" : "");
    rich(sm, ["The median change since their election is ", ["b", `${fmtSigned(med)} pp`], " (percentage points)."]);
    const gained = changes.filter((v) => v > 0).length;
    rich($("#s-gained"), [["b", `${gained} of ${changes.length}`], " have gained support since their election."]);
    const byGap = [...withInc].sort((a, b) => a.stats.gap_now - b.stats.gap_now);
    const listParts = (arr, word) => {
      const parts = [];
      arr.forEach((c, i) => {
        if (i) parts.push(i === arr.length - 1 ? " and " : ", ");
        const g = c.stats.gap_now;
        // flag and name kept together on one line
        const who = el("span", "who-c"), f = flagImg(c.code, "flag flag-inline"), btn = el("button", "linkbtn " + (g >= 0 ? "up" : "down"), c.name);
        btn.type = "button"; btn.addEventListener("click", () => openDetail(c));
        if (f) who.append(f);
        who.append(btn); parts.push(who);
        parts.push(` (${shortLabel(c.inc.label)}, ${fmt1(Math.abs(g))} pp ${word} ${c.rival ? shortLabel(c.rival.label) : "the rival"})`);
      });
      return parts;
    };
    rich($("#s-behind"), ["Furthest behind: ", ...listParts(byGap.slice(0, 4), "behind"), "."]);
    rich($("#s-ahead"), ["Furthest ahead: ", ...listParts(byGap.slice(-4).reverse(), "ahead of"), "."]);
    const np = d3.sum(state.countries, (c) => c.n_polls);
    const hp = state.data.history_polls;
    rich($("#s-polls"), [["b", `${d3.format(",")(np)} polls`], " read from Wikipedia for the current terms",
      ...(hp ? [", and ", ["b", d3.format(",")(hp)], " in the intra-country timelines going back to the 1990s"] : []), "."]);
  }

  // ------------------------------------------------------------------------------- scatterplot
  const fmtPop = (v) => (v >= 1e6 ? `${d3.format(".3~")(v / 1e6)} million` : `${d3.format(",")(Math.round(v / 1000))} thousand`);
  const SC_VARS = {
    gap: { label: "Government's current poll lead over its strongest rival", unit: "pp", signed: true, get: (c) => (c.stats && c.inc ? c.stats.gap_now : null), fmt: fmtSigned },
    change: { label: "Government's poll change since the election", unit: "pp", signed: true, get: (c) => (c.stats && c.inc ? c.stats.change : null), fmt: fmtSigned },
    now: { label: "Government's current poll share", unit: "%", get: (c) => (c.stats && c.inc ? c.stats.now : null), fmt: (v) => fmt1(v) + "%" },
    lead: { label: "Government's time in the lead", unit: "% of the term", get: (c) => (c.stats && c.stats.share_time_leading != null && c.inc ? c.stats.share_time_leading * 100 : null), fmt: (v) => Math.round(v) + "%" },
    days: { label: "Days to the next election", unit: "days", get: (c) => { const d = c.completed ? c.upcoming : c.end; return d ? Math.round((d - state.today) / DAY) : null; }, fmt: (v) => d3.format(",")(v) },
    pop: { label: "Population", unit: "log scale", log: true, get: (c) => (c.population ? c.population.value : null), fmt: fmtPop,
      tick: (v) => (v >= 1e6 ? d3.format("~")(v / 1e6) + "m" : d3.format("~")(v / 1e3) + "k") },
    gdp: { label: "GDP per capita, PPP", unit: "current international $", get: (c) => (c.gdp_pc_ppp ? c.gdp_pc_ppp.value : null),
      fmt: (v) => "$" + d3.format(",")(Math.round(v / 100) * 100), tick: (v) => "$" + d3.format("~")(v / 1000) + "k" },
    bloc: { label: "Poll share of the ideology group", unit: "% of the vote", get: (c) => blocNow(c, null).share, fmt: (v) => fmt1(v) + "%", ideo: true },
  };

  function initScatterControls() {
    const fill = (sel, cur) => {
      sel.replaceChildren();
      Object.entries(SC_VARS).forEach(([k, v]) => { const o = el("option", null, `${v.label} (${v.unit})`); o.value = k; sel.append(o); });
      sel.value = cur;
    };
    const sx = $("#sc-x"), sy = $("#sc-y");
    fill(sx, state.scatter.x); fill(sy, state.scatter.y);
    const changed = () => {
      state.scatter.x = sx.value; state.scatter.y = sy.value;
      store.set("scX", sx.value); store.set("scY", sy.value);
      renderScatter();
    };
    sx.addEventListener("change", changed); sy.addEventListener("change", changed);
    $("#sc-swap").addEventListener("click", () => { const t = sx.value; sx.value = sy.value; sy.value = t; changed(); });
  }

  function renderScatter() {
    syncPaletteSwitch();
    const X = SC_VARS[state.scatter.x] || SC_VARS.change, Y = SC_VARS[state.scatter.y] || SC_VARS.gap;
    const ideoHost = $("#sc-ideo");
    ideoHost.hidden = !(X.ideo || Y.ideo);
    if (X.ideo || Y.ideo) mountIdeo(ideoHost);
    const pts = state.countries.map((c) => ({ c, xv: X.get(c), yv: Y.get(c) })).filter((p) => p.xv != null && p.yv != null && (!X.log || p.xv > 0) && (!Y.log || p.yv > 0));
    const host = $("#quadrant");
    // drawn at the real width, so flags and labels keep their size on a phone
    const W = Math.max(320, Math.round(host.clientWidth || 980));
    const H = Math.round(W < 640 ? W * 0.92 : clamp(window.innerHeight - 170, 420, W * 0.66));
    const m = { t: 14, r: 18, b: 46, l: 66 };
    const scaleFor = (V, vals, range) => {
      if (V.log) return d3.scaleLog([d3.min(vals) * 0.8, d3.max(vals) * 1.25], range);
      if (V.signed) { const r = Math.max(5, Math.ceil(d3.max(vals.map(Math.abs)) / 5) * 5); return d3.scaleLinear([-r, r], range); }
      const lo = d3.min(vals), hi = d3.max(vals), pad = (hi - lo) * 0.08 || 1;
      return d3.scaleLinear([Math.min(0, lo) < 0 ? lo - pad : Math.max(0, lo - pad), hi + pad], range).nice();
    };
    const x = scaleFor(X, pts.map((p) => p.xv), [m.l, W - m.r]);
    const y = scaleFor(Y, pts.map((p) => p.yv), [H - m.b, m.t]);
    const svg = d3.create("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("role", "img")
      .attr("aria-label", `Scatterplot: ${Y.label} against ${X.label}`)
      .style("width", "100%").style("height", "auto").style("display", "block");
    // ahead / behind shading when the lead is on an axis
    if (state.scatter.y === "gap") {
      svg.append("rect").attr("class", "lead-area").attr("x", m.l).attr("y", m.t).attr("width", W - m.l - m.r).attr("height", y(0) - m.t);
      svg.append("rect").attr("class", "trail-area").attr("x", m.l).attr("y", y(0)).attr("width", W - m.l - m.r).attr("height", H - m.b - y(0));
    } else if (state.scatter.x === "gap") {
      svg.append("rect").attr("class", "trail-area").attr("x", m.l).attr("y", m.t).attr("width", x(0) - m.l).attr("height", H - m.b - m.t);
      svg.append("rect").attr("class", "lead-area").attr("x", x(0)).attr("y", m.t).attr("width", W - m.r - x(0)).attr("height", H - m.b - m.t);
    }
    const nT = W < 640 ? 5 : 9;
    const gx = X.log ? x.ticks(nT).filter((t, i, a) => a.length < 12 || [1, 2, 5].includes(+String(t)[0])) : x.ticks(nT);
    const gy = Y.log ? y.ticks(6).filter((t) => [1, 2, 5].includes(+String(t)[0])) : y.ticks(6);
    svg.append("g").selectAll("line").data(gx).join("line").attr("class", "gridline").attr("x1", (d) => x(d)).attr("x2", (d) => x(d)).attr("y1", m.t).attr("y2", H - m.b);
    svg.append("g").selectAll("line").data(gy).join("line").attr("class", "gridline").attr("y1", (d) => y(d)).attr("y2", (d) => y(d)).attr("x1", m.l).attr("x2", W - m.r);
    if (!X.log && x.domain()[0] < 0 && x.domain()[1] > 0) svg.append("line").attr("x1", x(0)).attr("x2", x(0)).attr("y1", m.t).attr("y2", H - m.b).attr("stroke", "var(--axis)");
    if (!Y.log && y.domain()[0] < 0 && y.domain()[1] > 0) svg.append("line").attr("y1", y(0)).attr("y2", y(0)).attr("x1", m.l).attr("x2", W - m.r).attr("stroke", "var(--axis)");
    const tickTxt = (V) => (d) => (V.tick ? V.tick(d) : V.signed ? (d > 0 ? "+" : "") + d : d3.format("~")(d));
    const ax = svg.append("g").attr("class", "axis");
    ax.selectAll("text.x").data(gx).join("text").attr("class", "x").attr("x", (d) => x(d)).attr("y", H - m.b + 14).attr("text-anchor", "middle").text(tickTxt(X));
    ax.selectAll("text.y").data(gy).join("text").attr("class", "y").attr("x", m.l - 6).attr("y", (d) => y(d) + 3.5).attr("text-anchor", "end").text(tickTxt(Y));
    // axis titles centred on their axes, the vertical one turned to read upwards
    ax.append("text").attr("class", "axis-title").attr("x", (m.l + W - m.r) / 2).attr("y", H - 8).attr("text-anchor", "middle").text(`${X.label}, ${X.unit}`);
    ax.append("text").attr("class", "axis-title").attr("text-anchor", "middle")
      .attr("transform", `translate(16, ${(m.t + H - m.b) / 2}) rotate(-90)`).text(`${Y.label}, ${Y.unit}`);
    if (state.scatter.x === "change" && state.scatter.y === "gap") {
      const corner = (tx, ty, anchor, label) => svg.append("text").attr("class", "q-corner").attr("x", tx).attr("y", ty).attr("text-anchor", anchor).text(label);
      corner(W - m.r - 6, m.t + 15, "end", "gaining and ahead");
      corner(m.l + 6, m.t + 15, "start", "losing but ahead");
      corner(m.l + 6, H - m.b - 9, "start", "losing and behind");
      corner(W - m.r - 6, H - m.b - 9, "end", "gaining but behind");
    }
    const R = W < 640 ? 7.5 : 9;
    pts.forEach((p) => { p.px = x(p.xv); p.py = y(p.yv); });
    // label placement: greedy, trying 8 positions around each flag, avoiding flags and earlier labels
    const boxes = pts.map((p) => ({ x0: p.px - R, x1: p.px + R, y0: p.py - R, y1: p.py + R }));
    const hit = (bx) => boxes.some((o) => bx.x0 < o.x1 && bx.x1 > o.x0 && bx.y0 < o.y1 && bx.y1 > o.y0);
    const cand = [[R + 3, 3.5, "start"], [-R - 3, 3.5, "end"], [0, -R - 3, "middle"], [0, R + 11, "middle"], [R, -R, "start"], [-R, -R, "end"], [R, R + 8, "start"], [-R, R + 8, "end"]];
    [...pts].sort((a, b2) => a.px - b2.px).forEach((p) => {
      const w = 15;
      for (const [dx, dy, anc] of cand) {
        const lx = p.px + dx, ly = p.py + dy;
        const x0 = anc === "start" ? lx : anc === "end" ? lx - w : lx - w / 2;
        const bx = { x0, x1: x0 + w, y0: ly - 8, y1: ly + 1 };
        if (!hit(bx) && bx.x0 > m.l && bx.x1 < W - m.r) { p.lx = lx; p.ly = ly; p.anc = anc; boxes.push(bx); return; }
      }
      p.lx = p.px + R + 3; p.ly = p.py + 3.5; p.anc = "start";
    });
    const g = svg.append("g");
    const dots = g.selectAll("g").data(pts).join("g").style("cursor", "pointer").attr("tabindex", 0)
      .attr("role", "button").attr("aria-label", (p) => `${p.c.name}: ${Y.label} ${Y.fmt(p.yv)}, ${X.label} ${X.fmt(p.xv)}`);
    dots.append("circle").attr("cx", (p) => p.px).attr("cy", (p) => p.py).attr("r", R + 4).attr("fill", "transparent");
    dots.each(function (p) {
      const src = (window.FLAGS || {})[p.c.code];
      const sel = d3.select(this);
      if (src) {
        sel.append("image").attr("href", src).attr("x", p.px - R).attr("y", p.py - R).attr("width", 2 * R).attr("height", 2 * R);
        sel.append("circle").attr("class", "q-ring").attr("cx", p.px).attr("cy", p.py).attr("r", R + 0.5);
      } else sel.append("circle").attr("cx", p.px).attr("cy", p.py).attr("r", 5.5).attr("fill", "var(--ink-2)");
    });
    dots.append("text").attr("class", "q-code label-halo").attr("x", (p) => p.lx).attr("y", (p) => p.ly).attr("text-anchor", (p) => p.anc).text((p) => p.c.code);
    const tipFor = (t, p) => {
      countryTip(t, p.c);
      const extra = el("div", "tt-gap");
      extra.append(el("div", null, `${Y.label}: ${Y.fmt(p.yv)}`), el("div", null, `${X.label}: ${X.fmt(p.xv)}`));
      t.append(extra);
    };
    dots.on("pointermove", (evt, p) => showTip(evt, (t) => tipFor(t, p)))
      .on("pointerleave", hideTip)
      .on("focus", function (evt, p) { const r = this.getBoundingClientRect(); showTip({ clientX: r.right, clientY: r.top }, (t) => tipFor(t, p)); })
      .on("blur", hideTip)
      .on("click", (evt, p) => openDetail(p.c))
      .on("keydown", (evt, p) => { if (evt.key === "Enter" || evt.key === " ") { evt.preventDefault(); openDetail(p.c); } });
    host.replaceChildren(svg.node());
    // caption: what is plotted, and the correlation
    const tx = (V, v) => (V.log ? Math.log10(v) : v);
    const r = pts.length > 2 ? pearson(pts.map((p) => tx(X, p.xv)), pts.map((p) => tx(Y, p.yv))) : null;
    $("#sc-title").textContent = `${Y.label} against ${X.label.toLowerCase()}`;
    $("#sc-sub").textContent = `Each flag is a country (${pts.length} shown${pts.length < state.countries.length ? "; countries without a governing party to follow are left out" : ""}). `
      + (r != null ? `Pearson's r = ${r.toFixed(2).replace("-", "−")}. ` : "")
      + (X.ideo || Y.ideo ? `Ideology group: ${groupName()}. ` : "") + "Hover or tap a flag for detail; select it for the full chart.";
    const src = [];
    if (state.scatter.x === "pop" || state.scatter.y === "pop" || state.scatter.x === "gdp" || state.scatter.y === "gdp") src.push("Population and GDP per capita (PPP, current international $): World Bank, World Development Indicators, 2025.");
    if (X.ideo || Y.ideo) src.push("Party families and positions: Manifesto Project (MPDS 2026a), each party's latest coded manifesto.");
    $("#sc-sources").textContent = src.join(" ");
  }
  function pearson(a, b) {
    const n = a.length, ma = d3.mean(a), mb = d3.mean(b);
    let sab = 0, saa = 0, sbb = 0;
    for (let i = 0; i < n; i++) { const da = a[i] - ma, db = b[i] - mb; sab += da * db; saa += da * da; sbb += db * db; }
    return saa && sbb ? sab / Math.sqrt(saa * sbb) : null;
  }

  function countryTip(t, c) {
    t.append(el("div", "tt-head", c.name));
    const inc = c.incumbent || {};
    if (inc.leader) t.append(el("div", "tt-sub", `${inc.leader}${c.inc ? ", " + c.inc.label : ""}`));
    if (c.stats && c.inc) {
      tipRow(t, pcolor(c.inc), c.completed && c.stats.final === "result" ? "Result" : c.completed ? "Final trend" : "Now", fmt1(c.stats.now) + "%", true);
      tipRow(t, "transparent", "Since the election", fmtSigned(c.stats.change));
      if (c.rival) tipRow(t, pcolor(c.rival), c.stats.gap_now >= 0 ? `Ahead of ${c.rival.label}` : `Behind ${c.rival.label}`, fmt1(Math.abs(c.stats.gap_now)));
    } else {
      t.append(el("div", "tt-sub", statusText(c)));
    }
    const nx = el("div", "tt-gap", nextElectionText(c, true));
    nx.style.color = "var(--ink-2)";
    t.append(nx);
  }

  // ------------------------------------------------------------------------------- map
  /** Minimal TopoJSON decoder (quantized, delta-encoded arcs) for the shipped map file. */
  function topoFeatures(topo, name) {
    const tr = topo.transform;
    const arcs = tr
      ? topo.arcs.map((arc) => { let x0 = 0, y0 = 0; return arc.map(([a, b]) => { x0 += a; y0 += b; return [x0 * tr.scale[0] + tr.translate[0], y0 * tr.scale[1] + tr.translate[1]]; }); })
      : topo.arcs.map((arc) => arc.map(([a, b]) => [a, b]));
    const arcPts = (i) => (i < 0 ? arcs[~i].slice().reverse() : arcs[i]);
    const ring = (idxs) => { const pts = []; idxs.forEach((i, k) => { const a = arcPts(i); pts.push(...(k ? a.slice(1) : a)); }); return pts; };
    const geom = (g) => (g.type === "Polygon" ? { type: "Polygon", coordinates: g.arcs.map(ring) }
      : g.type === "MultiPolygon" ? { type: "MultiPolygon", coordinates: g.arcs.map((p) => p.map(ring)) } : null);
    return topo.objects[name].geometries.map((g) => ({ type: "Feature", id: g.id, properties: g.properties || {}, geometry: geom(g) }))
      .filter((f) => f.geometry);
  }

  // label anchor [lon, lat]; callouts put the label elsewhere ([lon, lat] of the label) with a leader line
  const MAP_LABELS = {
    IS: [-18.6, 64.9], IE: [-8.0, 53.1], GB: [-1.6, 52.7], PT: [-8.0, 39.7], ES: [-3.6, 40.2], FR: [2.4, 46.9],
    NL: [5.7, 52.4, { at: [3.0, 54.1] }], LU: [6.1, 49.75, { at: [4.0, 50.75] }], DE: [10.2, 51.1], DK: [9.2, 56.1],
    NO: [8.8, 61.2], SE: [15.0, 62.6], FI: [26.0, 62.9], EE: [25.8, 58.75], LV: [25.6, 56.9], LT: [24.0, 55.35],
    PL: [19.3, 52.1], CZ: [15.4, 49.8], SK: [19.6, 48.72], AT: [14.2, 47.55], HU: [19.4, 47.1],
    SI: [14.8, 46.1, { at: [13.6, 44.0] }], HR: [16.5, 45.65], RS: [20.9, 44.05], ME: [19.25, 42.75, { at: [17.7, 41.7] }],
    IT: [12.6, 42.8], MT: [14.43, 35.9, { at: [16.4, 35.3] }], GR: [22.1, 39.6], BG: [25.2, 42.75], RO: [24.7, 45.9],
    MD: [28.5, 47.1, { at: [31.4, 46.7] }],
  };

  async function loadMap() {
    if (state.map) return state.map;
    const res = await fetch("data/europe-map.json");
    if (!res.ok) throw new Error("map file not found");
    state.map = topoFeatures(await res.json(), "countries");
    return state.map;
  }

  const UNPLACED_HATCH = 15;   // % of the vote without Manifesto data above which a country is hatched
  function gapFill(gap) {
    if (gap == null) return cssVar("--neutral-fill");
    // gentle at small gaps, so a 1-point lead does not look like a landslide
    const s = Math.sign(gap) * 20 * Math.pow(Math.min(Math.abs(gap), 20) / 20, 0.8);
    return rampColor(s);
  }
  /** Map fill for an ideology group's share: white at 0%, the full colour at 60% or more. */
  function blocFill(share) {
    if (share == null) return cssVar("--neutral-fill");
    const t = Math.pow(Math.min(share, 60) / 60, 0.8), H = hue();
    if (isDark()) return d3.interpolateLab(cssVar("--neutral-fill"), d3.interpolateLab(H.c, "#ffffff")(0.18))(t);
    return d3.interpolateLab("#ffffff", H.c)(t);
  }

  // ---- the weekly timeline (loaded on first use of the slider)
  function loadTimeline() {
    if (state.timeline) return Promise.resolve(state.timeline);
    if (!state.timelinePromise) {
      state.timelinePromise = fetch("data/timeline.json").then((r) => { if (!r.ok) throw new Error("timeline not found"); return r.json(); })
        .then((tl) => {
          tl.startD = parseISO(tl.start);
          const order = tl.measures || [];
          for (const tc of Object.values(tl.countries)) {
            tc.electionsD = tc.elections.map(parseISO);
            // manifesto measures arrive as arrays in tl.measures order; turn them into objects once
            for (const L of tc.lineages) L.mpObj = (L.mp || []).map(([w, arr]) => [w, Object.fromEntries(order.map((k, j) => [k, arr[j]]))]);
          }
          state.timeline = tl; return tl;
        });
    }
    return state.timelinePromise;
  }
  const tlDate = (i) => addDays(state.timeline.startD, i * state.timeline.step);
  function tlValue(tc, li, i) { const pk = tc.v[li]; if (!pk) return null; const j = i - pk[0]; return j >= 0 && j < pk[1].length ? pk[1][j] : null; }
  /** The manifesto in force for a timeline line in week i (before its first coded manifesto: that one). */
  function tlMp(L, i) { if (!L.mpObj || !L.mpObj.length) return null; let r = L.mpObj[0][1]; for (const [k, v] of L.mpObj) { if (k <= i) r = v; else break; } return r; }

  /** What the map shows for one country: now (from the current terms) or in week i of the timeline. */
  function mapDatum(c, i) {
    const out = { c, when: i == null ? state.today : tlDate(i), hasData: true };
    if (i == null) {
      out.gap = c.status === "none" ? null : c.stats.gap_now;
      out.inc = c.inc ? { label: c.inc.label, short: shortLabel(c.inc.label), color: pcolor(c.inc), v: c.stats ? c.stats.now : null } : null;
      // every party's latest share, largest first (after an election just held: the result)
      const useResult = c.completed && c.stats && c.stats.final === "result";
      out.ranked = c.parties.map((p) => ({ p, v: useResult ? p.result_end : lastVal(c, p.key) })).filter((x) => x.v != null).sort((a, b) => b.v - a.v)
        .map((x) => ({ label: x.p.label, short: shortLabel(x.p.label), color: pcolor(x.p), v: x.v, isInc: !!(c.inc && x.p.key === c.inc.key) }));
      out.rival = c.rival ? { label: c.rival.label, color: pcolor(c.rival), v: c.stats.rival_now } : null;
      out.leader = c.incumbent && c.incumbent.leader;
      out.until = untilText(c);
      const bn = blocNow(c, null);
      out.bloc = bn.share; out.blocParts = bn.parts.map((x) => ({ label: x.p.label, short: shortLabel(x.p.label), color: pcolor(x.p), v: x.v, mp: x.p.mp, fam: x.p.family, isInc: c.inc && x.p.key === c.inc.key, inherited: x.p.mp_inherited }));
      out.unplaced = bn.unplaced.map((x) => ({ label: x.p.label, v: x.v })); out.unplacedShare = bn.unplacedShare;
      return out;
    }
    const tc = state.timeline.countries[c.code];
    if (!tc) { out.hasData = false; return out; }
    const vals = tc.lineages.map((L, li) => tlValue(tc, li, i));
    if (!vals.some((v) => v != null)) { out.hasData = false; return out; }
    let gov = null; for (const g of tc.gov) if (g[0] <= i && i <= g[1]) gov = g;
    const li = gov ? gov[2] : -1;
    const col = (L) => (isDark() ? L.color_dark : L.color);
    out.leader = gov ? gov[3] : null;
    if (li >= 0 && vals[li] != null) {
      const L = tc.lineages[li];
      out.inc = { label: L.label, short: shortLabel(L.short || L.label), color: col(L), v: vals[li] };
      let best = -1; vals.forEach((v, k) => { if (k !== li && v != null && (best < 0 || v > vals[best])) best = k; });
      if (best >= 0) { out.rival = { label: tc.lineages[best].label, color: col(tc.lineages[best]), v: vals[best] }; out.gap = vals[li] - vals[best]; }
    }
    if (out.gap == null) out.gap = null;
    out.ranked = tc.lineages.map((L, k) => ({ label: L.label, short: shortLabel(L.short || L.label), color: col(L), v: vals[k], isInc: k === li }))
      .filter((x) => x.v != null).sort((a, b) => b.v - a.v);
    const nxt = tc.electionsD.find((d) => d > out.when);
    out.until = nxt ? spanText(out.when, nxt) : "";
    out.nextElection = nxt;
    const parts = [], unplaced = [];
    tc.lineages.forEach((L, k) => {
      const v = vals[k]; if (v == null) return;
      const mp = tlMp(L, i);
      if (!scored(mp, L.fam)) { if (v >= 1) unplaced.push({ label: L.label, v }); return; }
      if (inGroup(mp, L.fam)) parts.push({ label: L.label, short: shortLabel(L.short || L.label), color: col(L), v, mp, fam: L.fam, isInc: k === li, inherited: L.inherited });
    });
    parts.sort((a, b) => b.v - a.v); unplaced.sort((a, b) => b.v - a.v);
    out.bloc = d3.sum(parts, (x) => x.v); out.blocParts = parts; out.unplaced = unplaced; out.unplacedShare = d3.sum(unplaced, (x) => x.v);
    return out;
  }

  // ---- "Poll share by party place": the governing party, or the party in first, second or third place
  const PLACES = { gov: "governing party", 1: "leading party", 2: "second party", 3: "third party" };
  const ordinal = (n) => n + (n % 10 === 1 && n % 100 !== 11 ? "st" : n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th");
  /** The party the "place" mode shows for a country, with its share and its place in the polls. */
  function placePick(d) {
    if (!d.hasData || !d.ranked) return null;
    if (state.mapPlace === "gov") {
      if (!d.inc || d.inc.v == null) return null;
      const r = d.ranked.findIndex((x) => x.isInc);
      return { ...d.inc, rank: r >= 0 ? r + 1 : null };
    }
    const k = +state.mapPlace - 1, x = d.ranked[k];
    return x ? { ...x, rank: k + 1 } : null;
  }

  function mapTip(t, d) {
    const c = d.c;
    t.append(el("div", "tt-head", c.name + (state.mapAt == null ? "" : `, ${fmtDate(d.when)}`)));
    if (!d.hasData) { t.append(el("div", "tt-sub", "No polls on Wikipedia for this week.")); return; }
    if (d.leader) t.append(el("div", "tt-sub", `Head of government: ${d.leader}`));
    if (state.mapMode === "place") {
      const top = d.ranked || [];
      top.slice(0, 3).forEach((x, k) => tipRow(t, x.color, `${ordinal(k + 1)}: ${x.label}${x.isInc ? ", governing" : ""}`, fmt1(x.v) + "%", x.isInc));
      const r = top.findIndex((x) => x.isInc);
      if (r >= 3) tipRow(t, top[r].color, `${ordinal(r + 1)}: ${top[r].label}, governing`, fmt1(top[r].v) + "%", true);
      if (r < 0) t.append(el("div", "tt-sub", "No party line to follow (caretaker or non-party head of government)."));
    } else if (state.mapMode === "ideo") {
      tipRow(t, "var(--bloc)", `Ideology group (${groupName()})`, fmt1(d.bloc) + "%", true);
      d.blocParts.slice(0, 8).forEach((x) => tipRow(t, x.color, `${x.label}${partyTag(x.mp, x.fam, x.inherited)}${x.isInc ? ", governing" : ""}`, fmt1(x.v)));
      if (d.unplacedShare >= 2) {
        const u = el("div", "tt-gap", `${state.cls.by === "family" ? "No Manifesto family" : "No Manifesto score"}: ${d.unplaced.slice(0, 4).map((x) => `${x.label} ${fmt1(x.v)}`).join(", ")}`);
        u.style.color = "var(--muted)"; t.append(u);
      }
    } else {
      if (d.inc) tipRow(t, d.inc.color, d.inc.label, fmt1(d.inc.v) + "%", true);
      if (d.rival) tipRow(t, d.rival.color, d.rival.label, fmt1(d.rival.v) + "%");
      if (d.gap != null) {
        const g = el("div", "tt-gap", d.gap >= 0 ? `Governing party ${fmt1(d.gap)} pp ahead` : `Governing party ${fmt1(-d.gap)} pp behind`);
        g.style.color = d.gap >= 0 ? "var(--lead-ink)" : "var(--trail-ink)"; t.append(g);
      } else t.append(el("div", "tt-sub", "No party line to follow (caretaker or non-party head of government)."));
    }
    const nx = el("div", "tt-gap", state.mapAt == null ? nextElectionText(c, true) : d.nextElection ? `Next election ${fmtDate(d.nextElection)}` : "");
    nx.style.color = "var(--ink-2)"; t.append(nx);
  }

  async function renderMap() {
    syncPaletteSwitch();
    const host = $("#map");
    let feats;
    try { feats = await loadMap(); } catch (e) { host.replaceChildren(el("p", "note", "The map could not be loaded: " + e.message)); return; }
    const Wfull = Math.max(300, Math.round(host.clientWidth || 900));
    const ideo = state.mapMode === "ideo", place = state.mapMode === "place";
    const at = state.mapAt != null && state.timeline ? state.mapAt : null;
    const tracked = new Map(state.countries.map((c) => [c.code, c]));
    const datum = new Map(state.countries.map((c) => [c.code, mapDatum(c, at)]));
    const notShown = new Map((state.data.not_shown || []).map((n) => [n.code, n]));
    // fit the tracked countries plus room for the callout labels that sit outside them
    const extra = Object.values(MAP_LABELS).filter((s) => s[2] && s[2].at).flatMap((s) => [[s[2].at[0] + 1.6, s[2].at[1] - 0.9], [s[2].at[0] - 1.6, s[2].at[1] - 0.9]])
      .concat([[-10.6, 39.4]]);   // room for Portugal's label on the left edge
    const fit = { type: "FeatureCollection", features: [...feats.filter((f) => tracked.has(f.id)), { type: "Feature", geometry: { type: "MultiPoint", coordinates: extra } }] };
    // as wide as the box allows, but never taller than the window, so the whole map fits on screen
    const layout = (w) => {
      const pr = d3.geoAzimuthalEqualArea().rotate([-11, -53]).fitWidth(w - 12, fit);
      const bb = d3.geoPath(pr).bounds(fit);
      pr.translate([pr.translate()[0] + 6 - bb[0][0], pr.translate()[1] + 7 - bb[0][1]]);
      return { proj: pr, H: Math.ceil(bb[1][1] - bb[0][1] + 14) };
    };
    let W = Wfull, L0 = layout(W);
    // as tall as the window (less a small margin), so the whole map fits on screen once scrolled to
    const maxH = window.__noFit ? Infinity : Math.max(520, window.innerHeight - 20);
    if (L0.H > maxH) { W = Math.max(420, Math.floor(W * maxH / L0.H)); L0 = layout(W); }
    const proj = L0.proj, H = L0.H, path = d3.geoPath(proj);
    const k = W / 1000;
    const numSize = clamp(21 * k, 11, 21), daySize = clamp(11 * k, 8.5, 11.5);
    const showDays = W >= 560;
    const fillFor = (d) => {
      if (!d.hasData) return "var(--land-off)";
      if (place) { const pk = placePick(d); return blocFill(pk ? pk.v : null); }
      return ideo ? blocFill(d.bloc) : gapFill(d.gap);
    };

    const svg = d3.create("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("role", "group").attr("class", ideo || place ? "seq" : null)
      .style("max-width", W < Wfull ? `${W}px` : null)
      .attr("aria-label", ideo ? `Map of Europe: combined poll share of ${groupPhrase()}` : place ? `Map of Europe: poll share of each country's ${PLACES[state.mapPlace]}`
        : "Map of Europe: poll lead or lag of each governing party");
    const id = "m" + (++uid);
    svg.append("defs").append("clipPath").attr("id", id).append("rect").attr("width", W).attr("height", H);
    const land = svg.append("g").attr("clip-path", `url(#${id})`);
    land.selectAll("path").data(feats).join("path")
      .attr("d", path)
      .attr("class", (f) => "country " + (tracked.has(f.id) ? "tracked" : "off"))
      .attr("fill", (f) => (tracked.has(f.id) ? fillFor(datum.get(f.id)) : null))
      .each(function (f) {
        const c = tracked.get(f.id);
        const node = d3.select(this);
        if (c) {
          const d = datum.get(f.id);
          const pk = place ? placePick(d) : null;
          const lab = place ? `${c.name}: ${PLACES[state.mapPlace]}${pk ? `, ${pk.label}, ${fmt1(pk.v)}%` : ", none"}`
            : ideo ? `${c.name}: ideology group ${fmt1(d.bloc)}%` : `${c.name}: ${at == null ? statusText(c) : d.gap == null ? "no party line" : fmtSigned(d.gap) + " pp"}`;
          node.attr("tabindex", 0).attr("role", "button").attr("aria-label", lab + ".");
          node.on("pointermove", (evt) => showTip(evt, (t) => mapTip(t, d)))
            .on("pointerleave", hideTip)
            .on("click", () => { hideTip(); openDetail(c); })
            .on("focus", function () { const r = this.getBoundingClientRect(); showTip({ clientX: r.right, clientY: r.top }, (t) => mapTip(t, d)); })
            .on("blur", hideTip)
            .on("keydown", (evt) => { if (evt.key === "Enter" || evt.key === " ") { evt.preventDefault(); hideTip(); openDetail(c); } });
        } else if (notShown.has(f.id)) {
          const n = notShown.get(f.id);
          node.on("pointermove", (evt) => showTip(evt, (t) => { t.append(el("div", "tt-head", n.name)); t.append(el("div", "tt-sub", "Not tracked. " + (n.note || ""))); }))
            .on("pointerleave", hideTip);
        }
      });
    // ideology mode: hatch the countries where parties without Manifesto data poll a lot, since the
    // group's share there may be too low (Romania's AUR, for example, has no Manifesto data)
    const hatched = ideo ? feats.filter((f) => { const d = datum.get(f.id); return d && d.hasData && d.unplacedShare >= UNPLACED_HATCH; }) : [];
    if (hatched.length) {
      const pat = svg.select("defs").append("pattern").attr("id", id + "-hatch").attr("patternUnits", "userSpaceOnUse")
        .attr("width", 5).attr("height", 5).attr("patternTransform", "rotate(45)");
      pat.append("line").attr("x1", 0).attr("y1", 0).attr("x2", 0).attr("y2", 5).style("stroke", "var(--ink-2)").attr("stroke-width", 1).attr("opacity", 0.5);
      land.append("g").attr("pointer-events", "none").selectAll("path").data(hatched).join("path")
        .attr("d", path).attr("fill", `url(#${id}-hatch)`).attr("stroke", "none");
    }

    // labels: big coloured figure, small grey line under it
    const lab = svg.append("g").attr("aria-hidden", "true");
    for (const [code, spec] of Object.entries(MAP_LABELS)) {
      const c = tracked.get(code); if (!c) continue;
      const d = datum.get(code);
      if (!d.hasData) continue;
      const anchor = proj([spec[0], spec[1]]);
      const opt = spec[2] || {};
      const small = !!opt.at;
      const pt = opt.at ? proj(opt.at) : anchor;
      if (!anchor || !pt) continue;
      const ns = small ? numSize * 0.82 : numSize;
      if (opt.at) {
        lab.append("line").attr("class", "map-leader").attr("x1", anchor[0]).attr("y1", anchor[1])
          .attr("x2", pt[0] + (pt[0] < anchor[0] ? ns * 1.3 : -ns * 1.3)).attr("y2", pt[1] - ns * 0.3);
        lab.append("circle").attr("cx", anchor[0]).attr("cy", anchor[1]).attr("r", 1.8).attr("fill", "var(--ink-2)");
      }
      let txt, cls, sub;
      if (place) {
        const pk = placePick(d);
        txt = pk ? fmt1(pk.v) : "–"; cls = pk ? "bloc" : "none";
        sub = !pk ? "" : state.mapPlace === "gov" && pk.rank ? `${pk.short}, ${ordinal(pk.rank)}` : pk.short;
      } else if (ideo) {
        if (d.blocParts.length) {
          txt = fmt1(d.bloc); cls = "bloc";
          sub = d.blocParts.slice(0, 2).map((x) => x.short).join(", ") + (d.blocParts.length > 2 ? ` and ${d.blocParts.length - 2} more` : "");
        } else { txt = "0"; cls = "none"; sub = ""; }
      } else {
        txt = d.gap == null ? "–" : fmtSigned(d.gap); cls = d.gap == null ? "none" : d.gap >= 0 ? "up" : "down";
        sub = d.until;
      }
      lab.append("text").attr("class", "map-num " + cls)
        .attr("x", pt[0]).attr("y", pt[1] + ns * 0.3).attr("text-anchor", "middle")
        .attr("font-size", ns).attr("stroke-width", Math.max(2.5, ns * 0.16)).text(txt);
      if (showDays && sub) {
        lab.append("text").attr("class", "map-days").attr("x", pt[0]).attr("y", pt[1] + ns * 0.3 + daySize * 1.25)
          .attr("text-anchor", "middle").attr("font-size", small ? daySize * 0.92 : daySize).attr("stroke-width", 2.5).text(sub);
      }
    }
    host.replaceChildren(svg.node());

    // colour key and note
    const sc = $("#map-scale");
    sc.replaceChildren();
    const bar = el("span", "bar");
    // four cells, lined up with the time slider's row below: [ ] [left label] [bar] [right label]
    const keyRow = (left, right) => sc.append(el("span", "k-pad"), el("span", "k-left", left), bar, el("span", "k-right", right));
    if (place) {
      const stops = [0, 10, 20, 30, 40, 50, 60].map((v, i, a) => `${blocFill(v)} ${(i / (a.length - 1)) * 100}%`).join(", ");
      bar.style.background = `linear-gradient(to right, ${stops})`;
      keyRow("0%", "60% or more of the vote");
      $("#map-note").textContent = `Big figures: poll share of each country's ${PLACES[state.mapPlace]}, in per cent of the poll trend` + (at == null ? " (the result where an election has just been held)" : "")
        + `. Small figures: the party${state.mapPlace === "gov" ? " and its place in the polls" : ""}. Read with the lead/lag map: the same lag weighs more where the largest party polls 22% than where two parties share 90%. Select a country for its polls.`;
    } else if (ideo) {
      const stops = [0, 10, 20, 30, 40, 50, 60].map((v, i, a) => `${blocFill(v)} ${(i / (a.length - 1)) * 100}%`).join(", ");
      bar.style.background = `linear-gradient(to right, ${stops})`;
      keyRow("0%", "60% or more of the vote");
      $("#map-note").textContent = `Big figures: combined poll share of the ${groupPhrase()}, governing party included. Small figures: the largest of them. Hover a country for its parties; select it for its polls.`;
    } else {
      const stops = [-20, -10, -3, 0, 3, 10, 20].map((v, i, a) => `${gapFill(v)} ${(i / (a.length - 1)) * 100}%`).join(", ");
      bar.style.background = `linear-gradient(to right, ${stops})`;
      keyRow("20 pp behind", "20 pp or more ahead");
      $("#map-note").textContent = "Big figures: the governing party's poll lead (+) or lag (−) against its strongest rival, in percentage points (pp) of the poll trend. Small figures: time until the next election, scheduled or legally due" + (at == null ? "" : ", counted from the date shown to the election that followed") + ". Select a country for its polls.";
    }
    const covered = [...datum.values()].filter((d) => d.hasData).length;
    const md = $("#map-date");
    md.textContent = at == null ? "" : `${fmtDate(tlDate(at))}: ${covered} of ${state.countries.length} countries with polls`;
    md.hidden = at == null;
  }

  // ---- the controls above the map: what it shows, the ideology group picker, the time slider
  let playTimer = null;
  function initMapControls() {
    const modeUI = (v) => {
      $("#map-ideo").hidden = v !== "ideo";
      $("#map-place").hidden = v !== "place";
      if (v === "ideo") mountIdeo($("#map-ideo"));
    };
    if (!["gov", "place", "ideo"].includes(state.mapMode)) state.mapMode = "gov";
    textRadio($("#map-mode"), [
      { label: "Government poll lead/lag", value: "gov" },
      { label: "Poll share by party place", value: "place" },
      { label: "Poll share of parties by ideology", value: "ideo" },
    ], state.mapMode, (v) => {
      state.mapMode = v; store.set("mapMode", v);
      modeUI(v);
      renderMap();
    });
    if (!PLACES[state.mapPlace]) state.mapPlace = "gov";
    textRadio($("#map-place"), [
      { label: "Governing party", value: "gov" }, { label: "Leading party", value: "1" },
      { label: "Second party", value: "2" }, { label: "Third party", value: "3" },
    ], state.mapPlace, (v) => { state.mapPlace = v; store.set("mapPlace", v); renderMap(); });
    modeUI(state.mapMode);
    const slider = $("#map-time"), play = $("#map-play");
    let sized = false;
    const ready = (tl) => {
      if (!sized) {
        sized = true; slider.max = tl.n; if (state.mapAt == null) slider.value = tl.n;
        $("#time-start").textContent = fmtMonYear(tl.startD);
      }
      return tl;
    };
    const ensure = () => loadTimeline().then(ready).catch((e) => { const md = $("#map-date"); md.hidden = false; md.textContent = "Earlier weeks could not be loaded"; throw e; });
    slider.addEventListener("pointerdown", () => { ensure(); }, { once: true });
    slider.addEventListener("focus", () => { ensure(); }, { once: true });
    slider.addEventListener("input", async () => {
      const v = +slider.value;
      const tl = await ensure();
      state.mapAt = v >= tl.n ? null : v;
      renderMap();
    });
    const stop = () => { clearInterval(playTimer); playTimer = null; play.textContent = "Time lapse"; };
    play.addEventListener("click", async () => {
      if (playTimer) { stop(); return; }
      const tl = await ensure();
      let i = state.mapAt == null ? Math.max(0, Math.round((parseISO("2000-01-01") - tl.startD) / DAY / tl.step)) : state.mapAt;
      play.textContent = "Pause";
      playTimer = setInterval(() => {
        i += 4;
        if (i >= tl.n) { state.mapAt = null; slider.value = tl.n; renderMap(); stop(); return; }
        state.mapAt = i; slider.value = i; renderMap();
      }, 140);
    });
    // load the timeline in the background once the page has settled
    setTimeout(() => { loadTimeline().then(ready).catch(() => {}); }, 1200);
  }

  // ------------------------------------------------------------------------------- detail dialog
  function openDetail(c) {
    hideTip();
    const dlg = $("#detail");
    const fl = $("#detail-flag");
    const src = (window.FLAGS || {})[c.code];
    if (src) { fl.src = src; fl.hidden = false; } else fl.hidden = true;
    $("#detail-kicker").textContent = `${statusText(c)}. ${nextElectionText(c, true)}.`;
    $("#detail-title").textContent = c.name;
    const body = $("#detail-body");
    body.replaceChildren();
    const hidden = new Set(c.parties.filter((p) => p.minor).map((p) => p.key));
    const intro = el("p", "note");
    const inc = c.incumbent || {};
    intro.textContent = (inc.leader ? `${inc.title || "Head of government"}: ${inc.leader}${c.inc ? " (" + c.inc.label + ")" : ""}. ` : "")
      + `${c.n_polls} polls from ${fmtDate(c.start)} to ${fmtDate(c.lastData)}. ` + (c.note || "");
    const chart = el("div", "chart");
    const legend = el("div", "toggles");
    const table = el("div", "table-wrap");
    body.append(intro, legend, chart, table);
    const draw = () => {
      const keys = visibleKeys(c, { hidden, all: true });
      const w = Math.max(340, Math.min(1060, (dlg.clientWidth || 1000) - 40));
      drawCycleChart(chart, c, { width: w, height: Math.round(w * (w < 600 ? 0.62 : 0.44)), compact: false, keys, yMax: niceMax(maxValue(c, keys, true)), polls: true });
    };
    const ordered = [...c.parties].sort((a, b) => (lastVal(c, b.key) ?? -1) - (lastVal(c, a.key) ?? -1));
    ordered.forEach((p) => {
      if (!c.trend.series[p.key] || !c.trend.series[p.key].some((v) => v != null)) return;
      const b = el("button"); b.type = "button";
      b.setAttribute("aria-pressed", String(!hidden.has(p.key)));
      const i = el("i"); i.style.background = pcolor(p);
      b.append(i, document.createTextNode(p.label + " "), el("b", null, fmt1(lastVal(c, p.key))));
      b.title = p.article || p.key;
      b.addEventListener("click", () => {
        if (hidden.has(p.key)) hidden.delete(p.key); else hidden.add(p.key);
        b.setAttribute("aria-pressed", String(!hidden.has(p.key)));
        draw();
      });
      legend.append(b);
    });
    // party table
    const t = el("table");
    const hr = el("tr");
    ["Party", "Election result", c.completed ? "Final trend" : "Trend now", "Change", "Polls"].forEach((h, i) => hr.append(el("th", i ? "num" : null, h)));
    const th = el("thead"); th.append(hr); t.append(th);
    const tb = el("tbody");
    ordered.forEach((p) => {
      const r = el("tr"); const now = lastVal(c, p.key);
      const name = el("td"); const k = el("i", "key"); k.style.background = pcolor(p);
      const full = p.article ? p.article.replace(/\s*\([^()]*\)$/, "") : null;
      name.append(k, document.createTextNode(p.label + (full && full !== p.label ? ` (${full})` : "")));
      r.append(name, el("td", "num", fmt1(p.result)), el("td", "num", fmt1(now)));
      const ch = now != null && p.result != null ? now - p.result : null;
      r.append(el("td", "num " + (ch > 0.05 ? "up" : ch < -0.05 ? "down" : ""), fmtSigned(ch)), el("td", "num", String(p.n)));
      tb.append(r);
    });
    t.append(tb); table.replaceChildren(t);
    const foot = el("p", "note");
    const a = el("a", null, "Wikipedia: " + c.source.page);
    a.href = sourceHref(c.source); a.target = "_blank"; a.rel = "noopener";
    foot.append(document.createTextNode("Source: "), a, document.createTextNode(c.source.revid ? ` (revision ${c.source.revid}, CC BY-SA 4.0). ` : ". "));
    if ((state.data.history || []).includes(c.code)) {
      const lr = el("button", "linkbtn", `Intra-country timeline of ${c.name}`); lr.type = "button";
      lr.style.fontSize = "inherit";
      lr.addEventListener("click", () => { dlg.close(); state.lr.code = c.code; $("#lr-country").value = c.code; state.lr.domain = null; state.lr.hidden = new Set(); showView("timelines", true); });
      foot.append(lr);
    }
    body.append(foot);
    if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", "");
    draw();
  }
  $("#detail-close").addEventListener("click", () => { $("#detail").close(); hideTip(); });
  $("#detail").addEventListener("click", (e) => { if (e.target === $("#detail")) $("#detail").close(); });

  // ------------------------------------------------------------------------------- controls
  function textRadio(host, items, current, onPick) {
    host.replaceChildren();
    items.forEach((it) => {
      const b = el("button", "tl", it.label); b.type = "button"; b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(it.value === current));
      b.addEventListener("click", () => {
        host.querySelectorAll(".tl").forEach((x) => x.setAttribute("aria-checked", String(x === b)));
        onPick(it.value);
      });
      host.append(b);
    });
  }

  function initControls() {
    state.region = "All";   // regions are no longer offered; "Choose countries" picks any set
    const sort = $("#sort"); sort.value = state.sort;
    sort.addEventListener("change", () => { state.sort = sort.value; store.set("sort", state.sort); renderGrid(); });
    const bind = (sel, k) => {
      const i = $(sel); i.checked = state[k];
      i.addEventListener("change", () => { state[k] = i.checked; store.set(k, i.checked); renderGrid(); });
    };
    bind("#opt-shared", "shared"); bind("#opt-minor", "minor"); bind("#opt-trends", "trendsOnly");
    const oi = $("#opt-ideo"); oi.checked = state.cls.cmp;
    $("#cn-ideo").hidden = !state.cls.cmp;
    oi.addEventListener("change", () => {
      state.cls.cmp = oi.checked; store.set("ideoCmp", oi.checked);
      $("#cn-ideo").hidden = !oi.checked;
      if (oi.checked) mountIdeo($("#cn-ideo"));
      renderGrid();
    });
    const setTable = (v) => {
      state.table = v;
      $("#show-charts").setAttribute("aria-checked", String(!v)); $("#show-table").setAttribute("aria-checked", String(v));
      renderGrid();
    };
    $("#show-charts").addEventListener("click", () => setTable(false));
    $("#show-table").addEventListener("click", () => setTable(true));
    // countries
    const cc = $("#country-checks");
    const sorted = [...state.countries].sort((a, b) => a.name.localeCompare(b.name));
    const updateCount = () => {
      $("#country-count").textContent = state.selected.size ? `(${state.selected.size} of ${state.countries.length})` : `(all ${state.countries.length})`;
    };
    const boxes = [];
    sorted.forEach((c) => {
      const lab = el("label"); const i = el("input"); i.type = "checkbox"; i.id = "pick-" + c.code;
      i.checked = state.selected.has(c.code);
      i.addEventListener("change", () => {
        if (i.checked) state.selected.add(c.code); else state.selected.delete(c.code);
        store.set("selected", [...state.selected]); updateCount(); renderGrid();
      });
      lab.append(i, document.createTextNode(c.name)); cc.append(lab); boxes.push([c, i]);
    });
    $("#pick-all").addEventListener("click", () => {
      state.selected = new Set(state.countries.map((c) => c.code)); boxes.forEach(([, i]) => { i.checked = true; });
      store.set("selected", [...state.selected]); updateCount(); renderGrid();
    });
    $("#pick-none").addEventListener("click", () => {
      state.selected = new Set(); boxes.forEach(([, i]) => { i.checked = false; });
      store.set("selected", []); updateCount(); renderGrid();
    });
    updateCount();
  }

  // ------------------------------------------------------------------------------- palette picker
  /** Light or dark: the page follows the picker, not the system setting. */
  function applyTheme() { document.documentElement.dataset.theme = state.theme === "dark" ? "dark" : "light"; }

  /** Show only the colour pickers whose colours are on screen: lead/lag where a government's lead or
   *  lag is coloured, the ideology share colour where an ideology group is. */
  function syncPaletteSwitch() {
    const v = state.view, X = SC_VARS[state.scatter.x] || {}, Y = SC_VARS[state.scatter.y] || {};
    const lead = (v === "map" && state.mapMode === "gov") || v === "graphs"
      || (v === "correlates" && (state.scatter.x === "gap" || state.scatter.y === "gap"));
    const share = (v === "map" && state.mapMode !== "gov") || (v === "graphs" && state.cls.cmp)
      || (v === "correlates" && !!(X.ideo || Y.ideo));
    $("#pick-leadlag").hidden = !lead;
    $("#pick-share").hidden = !share;

  }

  function initPalette() {
    const th = $("#theme");
    th.value = state.theme === "dark" ? "dark" : "light";
    th.addEventListener("change", () => { state.theme = th.value; store.set("theme", th.value); applyTheme(); });
    const hs = $("#hue");
    Object.entries(HUES).forEach(([k, H]) => { const o = el("option", null, H.label); o.value = k; hs.append(o); });
    if (!HUES[state.hue]) state.hue = "blue";
    hs.value = state.hue;
    const hsw = el("span", "swatch"); hsw.setAttribute("aria-hidden", "true");
    const paintHue = () => { hsw.replaceChildren(...[0, 15, 30, 45, 60].map((v) => { const i = el("i"); i.style.background = blocFill(v); return i; })); };
    hs.parentNode.insertBefore(hsw, hs);
    applyHue(); paintHue();
    hs.addEventListener("change", () => {
      state.hue = hs.value; store.set("hue", hs.value);
      applyHue(); paintHue();
      ideoSyncs.forEach((f) => f());
      if (state.view === "map") renderMap();
      if (state.view === "graphs") renderGrid();
    });
    const sel = $("#palette");
    Object.entries(PALETTES).forEach(([k, P]) => { const o = el("option", null, P.label); o.value = k; sel.append(o); });
    if (!PALETTES[state.palette]) state.palette = "blueorange";
    sel.value = state.palette;
    const sw = el("span", "swatch"); sw.setAttribute("aria-hidden", "true");
    const paint = () => { sw.replaceChildren(...[-20, -8, 0, 8, 20].map((v) => { const i = el("i"); i.style.background = rampColor(v); return i; })); };
    sel.parentNode.insertBefore(sw, sel);
    applyPalette(); paint();
    sel.addEventListener("change", () => {
      state.palette = sel.value; store.set("palette", sel.value);
      applyPalette(); paint();
      renderSummary();
      if (state.view === "map") renderMap();
      if (state.view === "correlates") renderScatter();
      if (state.view === "graphs") renderGrid();
      if (state.view === "timelines") renderLongRun();
    });
  }

  // ------------------------------------------------------------------------------- tabs
  const VIEWS = ["map", "graphs", "correlates", "timelines", "method"];
  // hashes used by earlier versions still open the right tab
  const OLD_VIEWS = { incumbents: "graphs", countries: "graphs", scatter: "correlates", longrun: "timelines" };
  function showView(v, push) {
    state.view = v;
    VIEWS.forEach((name) => {
      $("#view-" + name).hidden = name !== v;
      $("#tab-" + name).setAttribute("aria-selected", String(name === v));
    });
    if (push) { try { history.replaceState(null, "", "#" + v); } catch (e) { /* sandboxed */ } }
    hideTip();
    $("#summary").hidden = v !== "map";
    syncPaletteSwitch();
    if (v === "map") renderMap();
    if (v === "correlates") renderScatter();
    if (v === "graphs") { if (state.cls.cmp) mountIdeo($("#cn-ideo")); renderGrid(); }
    if (v === "timelines") renderLongRun();
  }
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => showView(t.dataset.view, true)));
  const viewFromHash = () => { const h = (location.hash || "").replace("#", ""); return OLD_VIEWS[h] || (VIEWS.includes(h) ? h : "map"); };
  window.addEventListener("hashchange", () => { const v = viewFromHash(); if (v !== state.view) showView(v, false); });

  // ------------------------------------------------------------------------------- long run
  async function loadHistory(code) {
    if (state.lr.data[code]) return state.lr.data[code];
    const res = await fetch(`data/history/${code}.json`);
    if (!res.ok) throw new Error(`history for ${code} not found`);
    const h = await res.json();
    h.origin = parseISO(h.origin);
    h.segments.forEach((s) => { s.dates = s.days.map((d) => addDays(h.origin, d)); s.startD = parseISO(s.start); s.endD = parseISO(s.end); });
    h.byId = new Map(h.lineages.map((L) => [L.id, L]));
    h.pollDates = h.polls.t.map((t) => addDays(h.origin, t));
    h.govts = (h.governments || []).map((g) => ({ ...g, fromD: parseISO(g.from), toD: g.to ? parseISO(g.to) : state.today }));
    h.elections = Object.keys(h.elections || {}).sort().map((d) => ({ d: parseISO(d), res: h.elections[d] }));
    h.end = d3.max(h.segments, (s) => s.dates[s.dates.length - 1]);
    h.minorIds = new Set(h.auto ? h.lineages.filter((L) => L.max < 4).map((L) => L.id) : []);
    state.lr.data[code] = h;
    return h;
  }
  const lrHidden = (h, id) => state.lr.hidden.has(id) || (!state.lr.minor && h.minorIds.has(id));

  async function renderLongRun() {
    const code = state.lr.code;
    let h;
    try { h = await loadHistory(code); } catch (e) {
      $("#lr-chart").replaceChildren(el("p", "note", "The timeline could not be loaded: " + e.message)); return;
    }
    const pr = $("#lr-ranges");
    if (pr.dataset.code !== code) {
      pr.dataset.code = code;
      const y0 = h.origin.getUTCFullYear();
      const nPolls = d3.sum(h.segments, (s) => s.n_polls);
      $("#lr-title").textContent = `${h.name} since ${y0}`;
      $("#lr-deck").textContent = `Every national voting-intention poll on English Wikipedia across ${h.segments.length} parliamentary terms, ${d3.format(",")(nPolls)} polls in all, joined into continuous lines. `
        + (h.auto ? "Where a party was renamed or continued by a successor, its line carries on. " : "Party lineages follow renames, mergers and joint lists (PO to KO, SLD to Lewica, KNP to Konfederacja). ")
        + (h.govts.length ? "The band above the chart shows the head of government's party, and that party's line is drawn thicker while it governs." : "");
      // period presets: whole span + each term
      const presets = [{ label: "All years", value: -1 }, ...h.segments.map((s, i) => ({ label: `${s.startD.getUTCFullYear()} to ${s.endD.getUTCFullYear()}`, value: i }))];
      textRadio(pr, presets, -1, (v) => { state.lr.domain = v < 0 ? null : [h.segments[v].startD, h.segments[v].endD]; drawLongRun(h); });
      buildLrLegend(h);
      const srcs = $("#lr-sources"); srcs.replaceChildren(document.createTextNode("Wikipedia pages used: "));
      h.segments.forEach((s, i) => {
        if (i) srcs.append(document.createTextNode(", "));
        const a = el("a", null, `${s.startD.getUTCFullYear()} to ${s.endD.getUTCFullYear()}`);
        a.href = s.revid ? `https://en.wikipedia.org/w/index.php?title=${encodeURIComponent(s.page.replace(/ /g, "_"))}&oldid=${s.revid}` : s.url;
        a.target = "_blank"; a.rel = "noopener"; a.title = s.page; srcs.append(a);
      });
      srcs.append(document.createTextNode(h.govts.length ? ". Heads of government: ParlGov to 2020, then Wikipedia." : "."));
      const lin = $("#lr-lineages"); lin.replaceChildren();
      h.lineages.filter((L) => L.names).forEach((L) => {
        const d = el("div"); const i = el("i"); i.style.background = lcolor(L);
        const t = el("span"); t.append(el("b", null, L.label + ": "), document.createTextNode(L.names || ""));
        d.append(i, t); lin.append(d);
      });
    }
    drawLongRun(h);
    drawOverview(h);
  }

  function buildLrLegend(h) {
    const legend = $("#lr-legend"); legend.replaceChildren(); legend.className = "lr-legend toggles";
    [...h.lineages].sort((a, b) => b.max - a.max).forEach((L) => {
      if (!state.lr.minor && h.minorIds.has(L.id)) return;
      const b = el("button"); b.type = "button"; b.setAttribute("aria-pressed", String(!state.lr.hidden.has(L.id)));
      const i = el("i"); i.style.background = lcolor(L);
      b.append(i, document.createTextNode(L.label)); b.title = L.names || L.article || L.label;
      b.addEventListener("click", () => {
        if (state.lr.hidden.has(L.id)) state.lr.hidden.delete(L.id); else state.lr.hidden.add(L.id);
        b.setAttribute("aria-pressed", String(!state.lr.hidden.has(L.id)));
        drawLongRun(h);
      });
      b.addEventListener("pointerenter", () => drawLongRun(h, L.id));
      b.addEventListener("pointerleave", () => drawLongRun(h));
      legend.append(b);
    });
  }

  function lcolor(L) { return isDark() ? L.color_dark : L.color; }

  function drawLongRun(h, focus) {
    const host = $("#lr-chart");
    const W = Math.max(320, Math.min(1400, host.clientWidth || 1100));
    const H = Math.round(clamp(W * 0.42, 300, 540));
    const govtH = state.lr.govt && h.govts.length ? 18 : 0;
    const m = { t: 18 + govtH + 8, r: 104, b: 26, l: 34 };
    const dom = state.lr.domain || [h.origin, h.end];
    const x = d3.scaleUtc(dom, [m.l, W - m.r]);
    const ids = h.lineages.map((L) => L.id).filter((lid) => !lrHidden(h, lid));
    let ymax = 0;
    for (const s of h.segments) for (const lid of ids) (s.series[lid] || []).forEach((v, i) => { if (v != null && s.dates[i] >= dom[0] && s.dates[i] <= dom[1] && v > ymax) ymax = v; });
    const y = d3.scaleLinear([0, niceMax(ymax)], [H - m.b, m.t]);
    const svg = d3.create("svg").attr("viewBox", `0 0 ${W} ${H}`).style("width", "100%").style("height", "auto").style("display", "block")
      .attr("role", "img").attr("aria-label", `${h.name}: party support in polls since ${h.origin.getUTCFullYear()}`);
    const id = "lr" + (++uid);
    svg.append("defs").append("clipPath").attr("id", id).append("rect").attr("x", m.l).attr("y", 0).attr("width", W - m.l - m.r).attr("height", H);
    const yt = y.ticks(6);
    svg.append("g").selectAll("line").data(yt).join("line").attr("class", "gridline").attr("x1", m.l).attr("x2", W - m.r).attr("y1", (d) => y(d)).attr("y2", (d) => y(d));
    svg.append("g").attr("class", "axis").selectAll("text").data(yt).join("text").attr("x", m.l - 5).attr("y", (d) => y(d) + 3.5).attr("text-anchor", "end")
      .text((d, i) => (i === yt.length - 1 ? d + "%" : d));
    const ax = svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`)
      .call(d3.axisBottom(x).ticks(Math.min(14, W / 80)).tickSizeOuter(0));
    ax.select(".domain").attr("stroke", "var(--axis)");
    const plot = svg.append("g").attr("clip-path", `url(#${id})`);
    // head-of-government band
    if (govtH) {
      const gb = plot.append("g");
      h.govts.forEach((g) => {
        const L = h.byId.get(g.lineage);
        const x0 = x(g.fromD), x1 = x(g.toD);
        if (x1 < m.l || x0 > W - m.r) return;
        gb.append("rect").attr("x", x0).attr("y", 14).attr("width", Math.max(0, x1 - x0 - 1)).attr("height", govtH)
          .attr("fill", L ? lcolor(L) : "var(--axis)").attr("opacity", g.caretaker ? 0.5 : 0.88)
          .on("pointermove", (evt) => showTip(evt, (t) => {
            t.append(el("div", "tt-head", g.leader || ""));
            t.append(el("div", "tt-sub", `${fmtDate(g.fromD)} to ${g.to ? fmtDate(g.toD) : "today"}${g.caretaker ? ", caretaker" : ""}`));
            if (L) tipRow(t, lcolor(L), L.label, ""); else if (g.party) tipRow(t, "var(--axis)", g.party, "");
          }))
          .on("pointerleave", hideTip);
        const surname = (g.leader || "").replace(/\s*\(.*\)$/, "").split(" ").slice(-1)[0];
        if (x1 - x0 > surname.length * 6 + 8) gb.append("text").attr("x", Math.max(x0, m.l) + 4).attr("y", 14 + govtH - 5).attr("class", "govt-label")
          .attr("fill", L ? "#fff" : "var(--ink)").text(surname).style("pointer-events", "none");
      });
      svg.append("text").attr("class", "election-label").attr("x", m.l).attr("y", 10).text("Head of government");
    }
    // election lines
    h.elections.forEach((e) => {
      if (e.d < dom[0] || e.d > dom[1]) return;
      plot.append("line").attr("class", "election-line").attr("x1", x(e.d)).attr("x2", x(e.d)).attr("y1", m.t - 4).attr("y2", H - m.b);
      plot.append("text").attr("class", "election-label label-halo").attr("x", x(e.d) + 3).attr("y", m.t + 6).text(e.d.getUTCFullYear());
    });
    // polls
    if (!state.lr.trendsOnly) {
      const pg = plot.append("g").attr("opacity", 0.28);
      for (const lid of ids) {
        const L = h.byId.get(lid); const vals = h.polls.v[lid]; if (!vals) continue;
        const col = lcolor(L);
        for (let i = 0; i < vals.length; i++) {
          const d = h.pollDates[i];
          if (vals[i] == null || d < dom[0] || d > dom[1]) continue;
          pg.append("circle").attr("cx", x(d)).attr("cy", y(vals[i])).attr("r", 1.5).attr("fill", col);
        }
      }
    }
    const line = d3.line().defined((p) => p.v != null).x((p) => x(p.d)).y((p) => y(p.v)).curve(d3.curveMonotoneX);
    const lg = plot.append("g").attr("fill", "none").attr("stroke-linecap", "round").attr("stroke-linejoin", "round");
    for (const lid of ids) {
      const L = h.byId.get(lid);
      for (const s of h.segments) {
        const arr = s.series[lid]; if (!arr) continue;
        lg.append("path").attr("d", line(s.dates.map((d, i) => ({ d, v: arr[i] })))).attr("stroke", lcolor(L))
          .attr("stroke-width", 1.8).attr("opacity", focus && focus !== lid ? 0.12 : 0.85);
        // the head of government's party thicker while in office
        const gov = s.dates.map((d, i) => ({ d, v: h.govts.some((g) => g.lineage === lid && !g.caretaker && d >= g.fromD && d <= g.toD) ? arr[i] : null }));
        if (gov.some((p) => p.v != null)) lg.append("path").attr("d", line(gov)).attr("stroke", lcolor(L)).attr("stroke-width", 3.6).attr("opacity", focus && focus !== lid ? 0.12 : 1);
      }
    }
    // end labels for lineages alive at the right edge of the view
    const lastSeg = h.segments.filter((s) => s.startD <= dom[1]).slice(-1)[0];
    if (lastSeg) {
      const labs = [];
      for (const lid of ids) {
        const arr = lastSeg.series[lid]; if (!arr) continue;
        let i = arr.length - 1; while (i >= 0 && (arr[i] == null || lastSeg.dates[i] > dom[1])) i--;
        if (i < 0 || arr[i] < 2 || dom[1] - lastSeg.dates[i] > 400 * DAY) continue;
        labs.push({ L: h.byId.get(lid), x: x(lastSeg.dates[i]), y: y(arr[i]), v: arr[i] });
      }
      labs.sort((a, b) => a.y - b.y);
      for (let it = 0; it < 300; it++) { let mv = false; for (let j = 1; j < labs.length; j++) if (labs[j].y - labs[j - 1].y < 11) { labs[j - 1].y -= 0.6; labs[j].y += 0.6; mv = true; } if (!mv) break; }
      labs.forEach((l) => svg.append("text").attr("class", "end-label label-halo strong").attr("x", l.x + 5).attr("y", l.y + 3.5).text(`${shortLabel(l.L.short || l.L.label)} ${fmt1(l.v)}`));
    }
    // crosshair
    const all = [];
    for (const s of h.segments) s.dates.forEach((d, i) => all.push({ s, i, d }));
    all.sort((a, b) => a.d - b.d);
    const cross = svg.append("line").attr("class", "crosshair").attr("y1", m.t).attr("y2", H - m.b).attr("visibility", "hidden");
    const bis = d3.bisector((p) => p.d).center;
    svg.append("rect").attr("x", m.l).attr("y", m.t).attr("width", W - m.l - m.r).attr("height", H - m.t - m.b).attr("fill", "transparent")
      .on("pointermove", (evt) => {
        const [px] = d3.pointer(evt);
        const p = all[bis(all, x.invert(px))]; if (!p) return;
        cross.attr("x1", x(p.d)).attr("x2", x(p.d)).attr("visibility", "visible");
        showTip(evt, (t) => {
          t.append(el("div", "tt-head", fmtDate(p.d)));
          const g = h.govts.filter((gg) => gg.fromD <= p.d).slice(-1)[0];
          if (g) t.append(el("div", "tt-sub", "Head of government: " + g.leader));
          ids.map((lid) => ({ L: h.byId.get(lid), v: (p.s.series[lid] || [])[p.i] })).filter((r) => r.v != null).sort((a, b) => b.v - a.v).slice(0, 12)
            .forEach((r) => tipRow(t, lcolor(r.L), r.L.label, fmt1(r.v), g && g.lineage === r.L.id));
        });
      })
      .on("pointerleave", () => { cross.attr("visibility", "hidden"); hideTip(); });
    host.replaceChildren(svg.node());
  }

  function drawOverview(h) {
    const host = $("#lr-overview");
    const W = Math.max(320, Math.min(1400, host.clientWidth || 1100)), H = 58, m = { t: 4, r: 104, b: 18, l: 34 };
    const x = d3.scaleUtc([h.origin, h.end], [m.l, W - m.r]);
    const ymax = d3.max(h.lineages, (L) => L.max) || 60;
    const y = d3.scaleLinear([0, ymax], [H - m.b, m.t]);
    const svg = d3.create("svg").attr("viewBox", `0 0 ${W} ${H}`).style("width", "100%").style("height", "auto").style("display", "block");
    const line = d3.line().defined((p) => p.v != null).x((p) => x(p.d)).y((p) => y(p.v));
    for (const L of h.lineages) {
      if (lrHidden(h, L.id)) continue;
      for (const s of h.segments) {
        const arr = s.series[L.id]; if (!arr) continue;
        svg.append("path").attr("d", line(s.dates.map((d, i) => ({ d, v: arr[i] })))).attr("fill", "none").attr("stroke", lcolor(L)).attr("stroke-width", 1).attr("opacity", 0.7);
      }
    }
    svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(W / 90).tickSizeOuter(0));
    const brush = d3.brushX().extent([[m.l, m.t], [W - m.r, H - m.b]]).on("end", (evt) => {
      if (!evt.sourceEvent) return;
      state.lr.domain = evt.selection ? evt.selection.map(x.invert) : null;
      $("#lr-ranges").querySelectorAll(".tl").forEach((b, i) => b.setAttribute("aria-checked", String(!evt.selection && i === 0)));
      drawLongRun(h);
    });
    svg.append("g").attr("class", "brush").call(brush);
    svg.append("text").attr("class", "election-label").attr("x", W - m.r + 6).attr("y", H - m.b - 4).text("drag to zoom");
    host.replaceChildren(svg.node());
  }

  $("#lr-trends").addEventListener("change", (e) => { state.lr.trendsOnly = e.target.checked; renderLongRun(); });
  $("#lr-govt").addEventListener("change", (e) => { state.lr.govt = e.target.checked; renderLongRun(); });
  $("#lr-minor").addEventListener("change", (e) => {
    state.lr.minor = e.target.checked;
    const h = state.lr.data[state.lr.code]; if (h) buildLrLegend(h);
    renderLongRun();
  });

  // ------------------------------------------------------------------------------- boot
  async function boot() {
    let data;
    try {
      const res = await fetch("data/europe.json");
      data = await res.json();
    } catch (e) {
      $("#summary").replaceChildren(el("p", "note", "The data file could not be loaded. Run `python -m polls build` and serve the site folder over HTTP."));
      return;
    }
    state.data = data;
    state.today = data.today ? parseISO(data.today) : new Date();
    state.countries = data.countries.map(prepare);
    applyTheme();
    initPalette();
    $("#asof").textContent = `(data as of ${fmtDate(state.today)})`;
    $("#time-end").textContent = fmtMonYear(state.today);
    $("#generated").textContent = `Data built ${data.generated.replace("T", " ").slice(0, 16)} UTC from the Wikipedia pages of ${state.countries.length} countries.`;
    const hidden = (data.not_shown || []).map((n) => `${n.name} (${n.note})`);
    $("#not-shown").textContent = hidden.length ? "Not shown: " + hidden.join("; ") : "";
    renderSummary();
    initControls();
    initMapControls();
    initScatterControls();
    // long-run country list
    const sel = $("#lr-country");
    const hist = (data.history || ["PL"]).map((code) => ({ code, name: (state.countries.find((x) => x.code === code) || { name: code }).name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    hist.forEach(({ code, name }) => { const o = el("option", null, name); o.value = code; sel.append(o); });
    sel.value = state.lr.code;
    sel.addEventListener("change", () => { state.lr.code = sel.value; state.lr.domain = null; state.lr.hidden = new Set(); renderLongRun(); });
    showView(viewFromHash(), false);
    // re-render when the theme flips (party colours have light/dark variants)
    const rerender = () => {
      renderSummary();
      applyPalette(); applyHue();
      if (state.view === "map") renderMap();
      if (state.view === "correlates") renderScatter();
      if (state.view === "graphs") renderGrid();
      if (state.view === "timelines") { $("#lr-ranges").dataset.code = ""; renderLongRun(); }
      ideoSyncs.forEach((f) => f());
    };
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", rerender);
    new MutationObserver(rerender).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    let rt, lastW = window.innerWidth, lastH = window.innerHeight;
    window.addEventListener("resize", () => {
      clearTimeout(rt);
      rt = setTimeout(() => {
        if (Math.abs(window.innerWidth - lastW) < 8 && Math.abs(window.innerHeight - lastH) < 60) return;
        lastW = window.innerWidth; lastH = window.innerHeight;
        if (state.view === "map") renderMap();
        if (state.view === "correlates") renderScatter();
        if (state.view === "timelines") renderLongRun();
      }, 200);
    });
  }
  boot();
})();
