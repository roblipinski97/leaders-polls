/* Are Leaders Leading? Dashboard script.
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
    lr: { code: "AT", trendsOnly: false, govt: true, minor: false, hidden: new Set(), domain: null, data: {} },
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
    // polling errors: country, election (ISO date; null = the latest), days before it, options
    pe: { code: "AT", date: null, days: clamp(Math.round(+store.get("peDays14", 14)) || 14, 1, 365), ci: false, term: false, off: new Set() },
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
    // the shading in the charts comes from the ramp's mid-tone ends: lighter than the pair itself,
    // so that "ahead" reads as clearly blue (in the default colours) and not as grey
    const wPos = P.ramp[P.ramp.length - 1], wNeg = P.ramp[0];
    root.setProperty("--lead-wash", rgba(dark ? lift(wPos) : wPos, dark ? 0.3 : 0.25));
    root.setProperty("--trail-wash", rgba(dark ? lift(wNeg) : wNeg, dark ? 0.26 : 0.2));
    // the summary's lists: the same colours, very much lighter
    root.setProperty("--lead-tint", rgba(dark ? lift(wPos) : wPos, dark ? 0.1 : 0.075));
    root.setProperty("--trail-tint", rgba(dark ? lift(wNeg) : wNeg, dark ? 0.1 : 0.075));
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

  /** "2 years, 41 days", "1 year", "251 days": calendar years first, then the remaining days. */
  function spanText(a, b) {
    let years = 0, d = a;
    for (;;) {
      const n = new Date(Date.UTC(d.getUTCFullYear() + 1, d.getUTCMonth(), d.getUTCDate()));
      if (n <= b) { years++; d = n; } else break;
    }
    const days = Math.round((b - d) / DAY);
    const yt = years ? `${years} year${years > 1 ? "s" : ""}` : "";
    const dt = `${days} day${days === 1 ? "" : "s"}`;
    return years ? (days ? `${yt}, ${dt}` : yt) : dt;
  }
  function untilText(c) {
    if (c.completed) return `election held ${fmtDayMonth(c.end)}`;
    const ref = c.asOf || state.today;
    if (c.end <= ref) return "election due";
    return spanText(ref, c.end);
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
  function tipRow(parent, color, label, value, strong, full) {
    const row = el("div", "tt-row" + (strong ? " inc" : ""));
    const key = el("i"); key.style.background = color;
    row.append(key, el("span", null, label), el("b", null, value));
    if (full) row.append(el("span", "tt-full", full));
    parent.append(row);
  }
  /** A party's full name for a tooltip: its Wikipedia article without "(Country)", or nothing when
   *  that is the same as the short label. */
  function fullName(article, label) {
    if (!article) return null;
    const f = article.replace(/\s*\([^()]*\)$/, "").trim();
    return f && f.toLowerCase() !== String(label || "").toLowerCase() ? f : null;
  }

  // ------------------------------------------------------------------------------- data prep
  function prepare(c) {
    c.start = parseISO(c.last_election);
    c.end = c.next_election ? parseISO(c.next_election) : addDays(state.today, 365);
    c.dates = c.trend.days.map((d) => addDays(c.start, d));
    c.byKey = new Map(c.parties.map((p) => [p.key, p]));
    c.periods = (c.incumbents || []).map((p) => ({ ...p, fromD: parseISO(p.from), toD: p.to ? parseISO(p.to) : null }));
    c.completed = !!c.fallback_completed_cycle;
    c.upcoming = c.upcoming_next_election ? parseISO(c.upcoming_next_election) : null;
    c.lastData = c.last_poll ? parseISO(c.last_poll) : c.start;
    c.pollDates = c.polls.t.map((t) => addDays(c.start, t));
    return derive(c, false);
  }

  /** The derived fields of a term: who governs on each date, the governing party's share and its
   *  strongest rival's along the term. atDate: the term is cut at an earlier date (c.asOf), so the
   *  incumbent, the rival and the figures are worked out here instead of read from the data. */
  function derive(c, atDate) {
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
    if (atDate) {
      const ik = c.incKeyAt[c.incKeyAt.length - 1];
      c.inc = ik ? c.byKey.get(ik) || null : null;
      c.stats = statsAt(c);
    } else {
      c.inc = c.incumbent && c.incumbent.key ? c.byKey.get(c.incumbent.key) : null;
    }
    c.rival = c.stats && c.stats.rival ? c.byKey.get(c.stats.rival) : null;
    c.termFrac = clamp(((c.asOf || state.today) - c.start) / (c.end - c.start), 0, 1);
    c.status = !c.inc || !c.stats || c.stats.gap_now == null ? "none" : c.stats.gap_now >= 0 ? "lead" : "trail";
    return c;
  }
  /** The summary figures of a term cut at an earlier date, as the data file has them for today. */
  function statsAt(c) {
    if (!c.inc) return null;
    let j = c.dates.length - 1; while (j >= 0 && c.incVal[j] == null) j--;
    if (j < 0 || c.dates[c.dates.length - 1] - c.dates[j] > 45 * DAY) return null;
    const now = c.incVal[j], rv = c.rivalVal[j];
    let lead = 0, tot = 0;
    for (let i = 0; i <= j; i++) if (c.incVal[i] != null && c.rivalVal[i] != null) { tot++; if (c.incVal[i] >= c.rivalVal[i]) lead++; }
    const result = c.inc.result;
    return { now, result, change: result != null ? now - result : null, rival: c.rivalKey[j], rival_now: rv,
      gap_now: rv != null ? now - rv : null, share_time_leading: tot ? lead / tot : null, final: null };
  }

  // ---- a country on an earlier date: the term in force then, cut at that date
  /** The current term up to date D (D on or after the last election). */
  function cutCurrent(c, D) {
    if (c.completed && D >= c.end) return c;
    let k = -1; while (k + 1 < c.dates.length && c.dates[k + 1] <= D) k++;
    if (k < 0) return null;
    const series = {};
    for (const key of Object.keys(c.trend.series)) { const a = c.trend.series[key]; series[key] = a ? a.slice(0, k + 1) : a; }
    const keep = []; c.pollDates.forEach((d, i) => { if (d <= D) keep.push(i); });
    const pv = {};
    for (const key of Object.keys(c.polls.v)) { const a = c.polls.v[key]; pv[key] = a ? keep.map((i) => a[i]) : a; }
    const o = {
      ...c, asOf: D, completed: false, note: null,
      trend: { ...c.trend, days: c.trend.days.slice(0, k + 1), series },
      dates: c.dates.slice(0, k + 1),
      polls: { ...c.polls, t: keep.map((i) => c.polls.t[i]), v: pv },
      pollDates: keep.map((i) => c.pollDates[i]), n_polls: keep.length,
      periods: c.periods.filter((pp) => pp.fromD <= D),
    };
    o.lastData = keep.length ? o.pollDates[o.pollDates.length - 1] : c.start;
    const per = o.periods[o.periods.length - 1];
    o.incumbent = per ? { ...per } : null;
    return derive(o, true);
  }
  /** The manifesto in force on date D, from a list of [date, scores] (before the first: the first). */
  function mpAt(list, D) {
    if (!list || !list.length) return null;
    let r = list[0][1];
    for (const [d, v] of list) { if (parseISO(d) <= D) r = v; else break; }
    return r;
  }
  /** An earlier term, from the country's historical data, up to date D. */
  function fromSegment(c, h, sg, D) {
    let k = -1; while (k + 1 < sg.dates.length && sg.dates[k + 1] <= D) k++;
    if (k < 0) return null;
    const ids = Object.keys(sg.series).filter((lid) => sg.series[lid] && sg.series[lid].slice(0, k + 1).some((v) => v != null));
    if (!ids.length) return null;
    // election results: the dates in the results can differ from the term's by a day or two
    const resNear = (iso) => {
      const t = parseISO(iso);
      const k = Object.keys(h.resByDate).find((d) => Math.abs(parseISO(d) - t) <= 10 * DAY);
      return k ? h.resByDate[k] : {};
    };
    const res0 = resNear(sg.start), res1 = resNear(sg.end);
    const first = (lid) => { const a = sg.series[lid]; return a && a[0] != null ? a[0] : null; };
    const keep = []; h.pollDates.forEach((d, i) => { if (d >= sg.startD && d < sg.endD && d <= D) keep.push(i); });
    const pv = {}; ids.forEach((lid) => { const a = h.polls.v[lid]; if (a) pv[lid] = keep.map((i) => a[i]); });
    const parties = ids.map((lid) => {
      const L = h.byId.get(lid) || { id: lid, label: lid };
      return { key: lid, label: L.short || L.label, article: L.article || (L.label !== (L.short || L.label) ? L.label : null),
        color: L.color, color_dark: L.color_dark || L.color, result: res0[lid] ?? first(lid), result_end: res1[lid] ?? null,
        minor: (d3.max(sg.series[lid]) || 0) < 4, family: L.family ?? null, mp: mpAt(L.mp, D), mp_inherited: false,
        n: (pv[lid] || []).filter((v) => v != null).length };
    });
    const periods = h.govts.filter((g) => g.fromD < sg.endD && g.toD > sg.startD && g.fromD <= D).map((g) => ({
      key: !g.caretaker && ids.includes(g.lineage) ? g.lineage : null, leader: g.leader, title: "Head of government",
      caretaker: g.caretaker, fromD: g.fromD < sg.startD ? sg.startD : g.fromD, toD: g.toD }));
    const o = {
      code: c.code, name: c.name, region: c.region, population: c.population, gdp_pc_ppp: c.gdp_pc_ppp,
      asOf: D, historic: true, completed: false, start: sg.startD, end: sg.endD, next_status: "held", note: null,
      parties, byKey: new Map(parties.map((pp) => [pp.key, pp])),
      trend: { days: sg.days.slice(0, k + 1).map((x) => x - sg.days[0]), series: Object.fromEntries(ids.map((lid) => [lid, sg.series[lid].slice(0, k + 1)])) },
      dates: sg.dates.slice(0, k + 1),
      polls: { t: keep.map((i) => h.polls.t[i]), v: pv }, pollDates: keep.map((i) => h.pollDates[i]), n_polls: keep.length,
      periods, source: { page: sg.page, url: sg.url, revid: sg.revid },
    };
    o.lastData = o.pollDates.length ? o.pollDates[o.pollDates.length - 1] : o.start;
    const per = periods[periods.length - 1];
    o.incumbent = per ? { leader: per.leader, title: per.title, key: per.key, caretaker: per.caretaker } : null;
    return derive(o, true);
  }
  /** Country c as it stood on date D, or null when Wikipedia has no polls for it then. h: its
   *  historical data, needed only for dates before the current term. */
  function termAt(c, D, h) {
    if (!D) return c;
    if (D >= c.start) return cutCurrent(c, D);
    if (!h) return null;
    const sg = h.segments.find((x) => x.startD <= D && D < x.endD);
    return sg ? fromSegment(c, h, sg, D) : null;
  }
  async function termAtAsync(c, D) {
    if (!D || D >= c.start) return termAt(c, D, null);
    let h = null;
    try { h = await loadHistory(c.code); } catch (e) { return null; }
    return termAt(c, D, h);
  }
  /** The date the slider is on (null: the latest polls). */
  const atDate = () => (state.mapAt != null && state.timeline ? tlDate(state.mapAt) : null);

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

  // ------------------------------------------------------------------------------- steady polling
  // Where polls are months apart the smoothed line has nothing to follow and runs flat (Austria
  // before 2012, for example). This rule, applied after the data are loaded, keeps only the
  // stretches of steady polling:
  //   maxGapDays         a gap longer than this between two polls breaks the series ...
  //   afterElectionDays  ... except after an election, when polls may pause for up to this long;
  //   minRunDays         a stretch between two breaks shorter than this is left out.
  // It applies to the historical data, the country graphs at earlier dates and the map through
  // time. The polling-error view always uses every poll. Set POLL_RULE = null to show every poll.
  const POLL_RULE = { maxGapDays: 91, afterElectionDays: 183, minRunDays: 365 };
  /** Stretches of steady polling as [from, to] in milliseconds, from poll and election dates.
   *  end: the last date of the data; a stretch still running then is extended to it. */
  function steadyRuns(pollDates, electionDates, end) {
    if (!POLL_RULE) return [[-Infinity, Infinity]];
    if (!pollDates.length) return [];
    const lastPoll = d3.max(pollDates, (d) => +d);
    const pts = [...pollDates.map((d) => ({ t: +d, e: false })), ...electionDates.filter((d) => +d <= lastPoll).map((d) => ({ t: +d, e: true }))]
      .sort((a, b) => a.t - b.t);
    const runs = []; let cur = null;
    for (const q of pts) {
      if (cur && q.t - cur.last.t <= (cur.last.e ? POLL_RULE.afterElectionDays : POLL_RULE.maxGapDays) * DAY) {
        cur.last = q; if (!q.e) cur.polls++; continue;
      }
      if (cur) runs.push(cur);
      cur = { first: q, last: q, polls: q.e ? 0 : 1 };
    }
    if (cur) runs.push(cur);
    const out = runs.filter((r) => r.polls > 0 && r.last.t - r.first.t >= POLL_RULE.minRunDays * DAY).map((r) => [r.first.t, r.last.t]);
    if (out.length && end && +end - out[out.length - 1][1] <= POLL_RULE.maxGapDays * DAY) out[out.length - 1][1] = Math.max(out[out.length - 1][1], +end);
    return out;
  }
  const inRuns = (runs, t) => runs.some(([a, b]) => t >= a && t <= b);
  /** Apply the rule to a country's historical data; the full set of polls stays in h.raw. */
  function applySteadyPolling(h) {
    h.raw = { polls: h.polls, pollDates: h.pollDates, pollEnds: h.pollEnds, segments: h.segments };
    const runs = steadyRuns(h.pollDates, h.elections.map((e) => e.d), h.end);
    h.runs = runs;
    const keep = []; h.pollDates.forEach((d, i) => { if (inRuns(runs, +d)) keep.push(i); });
    h.dropped = h.pollDates.length - keep.length;
    if (!h.dropped) return h;
    const v = {}; for (const [lid, a] of Object.entries(h.polls.v)) v[lid] = keep.map((i) => a[i]);
    h.polls = { ...h.polls, t: keep.map((i) => h.polls.t[i]), p: (h.polls.p || []).length ? keep.map((i) => h.polls.p[i]) : h.polls.p,
      n: (h.polls.n || []).length ? keep.map((i) => h.polls.n[i]) : h.polls.n,
      e: h.polls.e ? keep.map((i) => h.polls.e[i]) : h.polls.e, v };
    h.pollDates = keep.map((i) => h.raw.pollDates[i]);
    h.segments = h.segments.map((sg) => {
      const series = {};
      let any = false;
      for (const [lid, a] of Object.entries(sg.series)) {
        series[lid] = a.map((x, i) => (x != null && inRuns(runs, +sg.dates[i]) ? x : null));
        if (series[lid].some((x) => x != null)) any = true;
      }
      const first = sg.dates.find((d, i) => Object.values(series).some((a) => a[i] != null));
      return any ? { ...sg, series, firstD: first } : null;
    }).filter(Boolean);
    h.empty = !runs.length;
    if (runs.length) h.origin = new Date(runs[0][0]);
    return h;
  }

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
    const futureFrom = c.completed ? c.end : clamp(+(c.asOf || c.lastData), +c.start, +c.end);
    if (futureFrom < +c.end) {
      svg.append("rect").attr("class", "future").attr("x", x(futureFrom)).attr("y", plotTop)
        .attr("width", Math.max(0, x(c.end) - x(futureFrom))).attr("height", plotBot - plotTop);
    }
    if (o.window) {
      const w0 = clamp(+o.window[0], +c.start, +c.end), w1 = clamp(+o.window[1], +c.start, +c.end);
      svg.append("rect").attr("class", "window-band").attr("x", x(w0)).attr("y", plotTop)
        .attr("width", Math.max(2, x(w1) - x(w0))).attr("height", plotBot - plotTop);
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
    const endW = endLabel.length * 6.6 + 6;
    const startW = o.compact ? 0 : ("Election " + fmtMonYear(c.start)).length * 6.6 + 6;
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
    }

    // today marker (or the date chosen on the slider)
    const mark = c.asOf || state.today;
    if (!c.completed && mark > c.start && mark < c.end) {
      const mx = x(mark), late = mx > W - m.r - 64;
      svg.append("line").attr("class", "today-line").attr("x1", mx).attr("x2", mx)
        .attr("y1", plotTop - 4).attr("y2", plotBot);
      svg.append("text").attr("class", "today-label").attr("x", late ? mx - 3 : mx + 3).attr("y", plotTop - 4)
        .attr("text-anchor", late ? "end" : "start").text(c.asOf ? fmtDate(c.asOf) : "today");
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
    // small charts: the other main parties too (5% or more, four labels at most), instead of a legend
    if (o.compact && !cmp) keys.filter((k) => !labels.some((l) => l.k === k) && !c.byKey.get(k).minor && lastVal(c, k) >= 5)
      .sort((k1, k2) => lastVal(c, k2) - lastVal(c, k1)).slice(0, Math.max(0, 4 - labels.length)).forEach((k) => labels.push({ k, strong: false }));
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
        if (Math.abs(a.x - b.x) < 70 && b.y - a.y < 12.5) { a.y -= 0.6; b.y += 0.6; moved = true; }
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

  /** The panel's status line: who is ahead of whom (the figure itself is in the panel's head). */
  function statusWords(c) {
    if (c.status === "none") return statusText(c);
    const inc = shortLabel(c.inc.label), r = c.rival ? shortLabel(c.rival.label) : "the strongest rival";
    const g = c.stats.gap_now;
    return c.completed ? `${inc} finished ${g >= 0 ? "ahead of" : "behind"} ${r}` : `${inc} ${g >= 0 ? "ahead of" : "behind"} ${r}`;
  }
  function factsLine(parent, c, short) {
    const s = c.stats; if (!s) return;
    const ch = s.change;
    const parts = [];
    // in a panel the current share is already at the end of the line, so it is not repeated
    if (c.completed && s.final === "result") parts.push(`${fmt1(s.now)}% at the ${fmtMonYear(c.end)} election, `);
    else if (c.completed) parts.push(`${fmt1(s.now)}% at the end of the term, `);
    else if (!short) parts.push(c.asOf ? `${fmt1(s.now)}% on ${fmtDate(c.asOf)}, ` : `${fmt1(s.now)}% now, `);
    parts.push(["span", `${fmtSigned(ch)} pp`, ch > 0.05 ? "up" : ch < -0.05 ? "down" : ""]);
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
    const f = flagImg(c.code);
    head.append(f || el("span"), el("h3", null, c.name));
    // the key figure, as on the map: the governing party's lead (+) or lag (−), in pp
    const figure = (v) => { const g = el("span", "panel-gap " + (v == null ? "none" : v >= 0 ? "lead" : "trail"), v == null ? "–" : fmtSigned(v)); if (v != null) g.append(el("small", null, "pp")); return g; };
    a.append(head);
    const who = el("div", "who");
    if (c.inc) { const k = el("i", "key"); k.style.background = pcolor(c.inc); who.append(k); }
    const inc = c.incumbent || {};
    const leader = (inc.leader || "").replace(/\s*\(.*\)\s*$/, "");
    const nm = el("span", "name", leader ? `${inc.caretaker ? "Caretaker: " : ""}${leader}` : "–");
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
      head.append(figure(incNow != null ? incNow - bn.share : null));
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
      head.append(figure(c.status === "none" ? null : c.stats.gap_now));
      a.append(el("p", "status " + c.status, statusWords(c)));
      if (c.stats) { const fl = el("p", "facts"); factsLine(fl, c, true); a.append(fl); }
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


    if (!c.completed && (c.asOf || state.today) - c.lastData > 75 * DAY) a.append(el("p", "note stale", `Wikipedia lists no polls ${c.asOf ? "between " + fmtDate(c.lastData) + " and " + fmtDate(c.asOf) : "after " + fmtDate(c.lastData)}.`));
    if (c.note) a.append(el("p", "note", c.note));

    const foot = el("div", "panel-foot");
    const left = el("span", null, nextElectionText(c));
    const bar = el("span", "termbar"); bar.title = `${Math.round(c.termFrac * 100)}% of the term elapsed${c.asOf ? " on " + fmtDate(c.asOf) : ""}`;
    const fill = el("i"); fill.style.width = (c.termFrac * 100).toFixed(1) + "%"; bar.append(fill);
    const actions = el("span", "panel-actions");
    const src = el("a", null, `${c.n_polls} polls`);
    src.href = sourceHref(c.source);
    src.target = "_blank"; src.rel = "noopener"; src.title = "Source: " + c.source.page + " (Wikipedia)";
    if (c.asOf) src.textContent = `${c.n_polls} polls to date`;
    const more = el("button", "linkbtn", "Expand"); more.type = "button";
    more.addEventListener("click", () => openDetail(c));
    actions.append(src, more);
    foot.append(left, bar, actions);
    a.append(foot);
    return a;
  }
  const sourceHref = (s) => (s.revid ? `https://en.wikipedia.org/w/index.php?title=${encodeURIComponent(s.page.replace(/ /g, "_"))}&oldid=${s.revid}` : s.url);

  // ------------------------------------------------------------------------------- countries view
  function filtered(list) {
    let cs = (list || state.countries).filter((c) => state.region === "All" || c.region === state.region);
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

  let gridToken = 0;
  async function renderGrid() {
    syncPaletteSwitch();
    howtoGraphs();
    const token = ++gridToken;
    const grid = $("#grid"), tw = $("#table-wrap");
    const D = atDate();
    let list = state.countries, missing = [];
    if (D) {
      // earlier terms come from the historical data, loaded on first use
      const need = state.countries.filter((c) => D < c.start && !state.lr.data[c.code]);
      if (need.length) {
        grid.hidden = false; tw.hidden = true;
        grid.replaceChildren(el("p", "note", `Loading the polls of ${need.length} countries for earlier terms`));
        await Promise.all(need.map((c) => loadHistory(c.code).catch(() => null)));
        if (token !== gridToken) return;
      }
      list = [];
      // a term with no poll yet by that date counts as having no polls
      for (const c of state.countries) { const x = termAt(c, D, state.lr.data[c.code]); if (x && x.n_polls) list.push(x); else missing.push(c); }
    }
    const cs = filtered(list);
    grid.hidden = state.table; tw.hidden = !state.table;
    const nm = $("#not-shown");
    const hidden = (state.data.not_shown || []).map((n) => `${n.name} (${n.note})`);
    const miss = missing.filter((c) => !state.selected.size || state.selected.has(c.code));
    nm.textContent = (miss.length ? `No polls on Wikipedia for ${fmtDate(D)}: ${miss.map((c) => c.name).join(", ")}. ` : "") + (hidden.length ? "Not covered: " + hidden.join("; ") : "");
    let shared = null;
    if (state.shared) shared = niceMax(d3.max(cs, (c) => state.cls.cmp ? Math.max(maxValue(c, visibleKeys(c), !state.trendsOnly), d3.max(blocSeries(c, new Set(c.inc ? [c.inc.key] : [])).vals) || 0) : maxValue(c, visibleKeys(c), !state.trendsOnly)) || 40);
    if (state.table) { renderTable(cs); return; }
    grid.replaceChildren(...cs.map((c) => panel(c, shared)));
    if (!cs.length) grid.append(el("p", "note", D && !list.length ? `No polls on Wikipedia for ${fmtDate(D)}.` : "No country matches the current filters."));
  }
  let gridTimer = null;
  const renderGridSoon = () => { clearTimeout(gridTimer); gridTimer = setTimeout(renderGrid, 140); };

  function renderTable(cs) {
    const t = el("table");
    const head = el("thead"); const hr = el("tr");
    const D = atDate();
    const cols = [["Country"], ["Governing party"], ["Lead or lag, pp", "num"], ["Strongest rival"], [D ? `Share on ${fmtDate(D)}, %` : "Share now, %", "num"],
      ["At election, %", "num"], ["Change, pp", "num"], ["Ahead, % of term", "num"], ["Next election"], ["Polls", "num"]];
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
      // the party, with the head of government under it in small grey
      const pt = td("");
      if (c.inc) { const k = el("i", "key"); k.style.background = pcolor(c.inc); pt.append(k, document.createTextNode(c.inc.label)); } else pt.append(document.createTextNode("–"));
      if (c.incumbent && c.incumbent.leader) pt.append(el("span", "sub", c.incumbent.leader));
      td(s.gap_now != null ? fmtSigned(s.gap_now) : "–", "num key-col " + (s.gap_now == null ? "" : s.gap_now >= 0 ? "up" : "down"));
      td(c.rival ? c.rival.label : "–");
      td(fmt1(s.now), "num");
      td(fmt1(s.result), "num");
      td(fmtSigned(s.change), "num");
      td(s.share_time_leading != null ? String(Math.round(s.share_time_leading * 100)) : "–", "num");
      td(c.completed ? `held ${fmtDate(c.end)}` : fmtDate(c.end));
      td(String(c.n_polls), "num");
      body.append(r);
    }
    t.append(body);
    $("#table-wrap").replaceChildren(t);
  }

  // ------------------------------------------------------------------------------- summary
  // icons: a straight arrow for the share of governments ahead, a trend arrow for the change since
  // the election; both point up when half or more are ahead (or have gained), down otherwise
  const ICONS = {
    up: '<svg viewBox="0 0 20 20"><path d="M10 17V3.5M4.8 8.7 10 3.5l5.2 5.2"/></svg>',
    down: '<svg viewBox="0 0 20 20"><path d="M10 3v13.5M4.8 11.3 10 16.5l5.2-5.2"/></svg>',
    trendUp: '<svg viewBox="0 0 20 20"><path d="M2.2 14.6 7.6 9.2l3.2 3.2 6.6-6.6"/><path d="M11.8 5.8h5.6v5.6"/></svg>',
    trendDown: '<svg viewBox="0 0 20 20"><path d="M2.2 5.4 7.6 10.8l3.2-3.2 6.6 6.6"/><path d="M11.8 14.2h5.6V8.6"/></svg>',
  };
  /** One row per country with a governing party to follow: today, or in the week the map shows. */
  function summaryRows() {
    const at = state.mapAt != null && state.timeline ? state.mapAt : null;
    if (at == null) {
      return { at, rows: state.countries.filter((c) => c.stats && c.inc).map((c) => ({ c, gap: c.stats.gap_now, change: c.stats.change,
        inc: shortLabel(c.inc.label), rival: c.rival ? shortLabel(c.rival.label) : "the rival" })) };
    }
    const rows = [];
    for (const c of state.countries) {
      const d = mapDatum(c, at);
      if (d.hasData && d.gap != null && d.inc) rows.push({ c, gap: d.gap, change: d.change, inc: d.inc.short, rival: d.rival ? d.rival.short : "the rival" });
    }
    return { at, rows };
  }
  function renderSummary() {
    const { at, rows } = summaryRows();
    const past = at != null, n = rows.length;
    const sw = $("#s-when"); sw.hidden = !past;
    if (past) sw.textContent = `On ${fmtDate(tlDate(at))}`;
    const lead = rows.filter((r) => r.gap >= 0).length;
    const up = n > 0 && lead * 2 >= n;
    $("#s-ico-lead").innerHTML = up ? ICONS.up : ICONS.down;
    rich($("#s-trailing"), up
      ? [["b", `${lead} of ${n}`], ` governing parties ${past ? "led" : "lead"} their strongest rival in the polls.`]
      : [["b", `${n - lead} of ${n}`], ` governing parties ${past ? "were" : "are"} behind a rival in the polls.`]);
    const changes = rows.map((r) => r.change).filter((v) => v != null);
    const med = d3.median(changes), gained = changes.filter((v) => v > 0).length;
    $("#s-ico-change").innerHTML = changes.length && gained * 2 >= changes.length ? ICONS.trendUp : ICONS.trendDown;
    rich($("#s-gained"), [["b", `${gained} of ${changes.length}`], ` ${past ? "had" : "have"} gained support since their election; the median change ${past ? "was" : "is"} `,
      ["b", `${fmtSigned(med)} pp`], "."]);
    const byGap = [...rows].sort((a, b) => a.gap - b.gap);
    const list = (ul, arr, word) => ul.replaceChildren(...arr.map((r) => {
      const li = el("li"), b = el("button", "s-c"); b.type = "button";
      b.append(flagImg(r.c.code) || el("span"), el("span", "s-name", r.c.name));
      const g = el("span", "s-gap", fmtSigned(r.gap)); g.append(el("small", null, "pp"));
      b.append(g, el("span", "s-pp", `${r.inc} ${word} ${r.rival}`));
      b.setAttribute("aria-label", `${r.c.name}: ${r.inc} ${fmt1(Math.abs(r.gap))} percentage points ${word} ${r.rival}. Open its polls.`);
      b.addEventListener("click", () => openAt(r.c));
      li.append(b); return li;
    }));
    list($("#s-behind"), byGap.slice(0, 4).filter((r) => r.gap < 0), "behind");
    list($("#s-ahead"), byGap.slice(-4).reverse().filter((r) => r.gap >= 0), "ahead of");
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

  /** A scatter measure along the current term, one value per trend date, for the hover trail
   *  (null for measures that do not change within a term, such as population or GDP). */
  function measurePath(key, c) {
    const iv = c.incVal, rv = c.rivalVal;
    if (!iv) return null;
    if (key === "gap") return c.dates.map((d, i) => (iv[i] != null && rv[i] != null ? iv[i] - rv[i] : null));
    if (key === "now") return c.dates.map((d, i) => iv[i]);
    if (key === "change") return c.dates.map((d, i) => { const k = c.incKeyAt[i], pp = k && c.byKey.get(k); return iv[i] != null && pp && pp.result != null ? iv[i] - pp.result : null; });
    if (key === "lead") { let lead = 0, tot = 0; return c.dates.map((d, i) => { if (iv[i] != null && rv[i] != null) { tot++; if (iv[i] >= rv[i]) lead++; } return tot ? (lead / tot) * 100 : null; }); }
    if (key === "days") { const end = c.completed ? c.upcoming : c.end; return end ? c.dates.map((d) => Math.round((end - d) / DAY)) : null; }
    if (key === "bloc") return blocSeries(c, new Set()).vals;
    return null;
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
      // signed measures: zero always in view, but the range follows the data on each side (in steps
      // of 5) rather than mirroring the larger side, so no half of the chart stays empty
      if (V.signed) {
        const step = (v) => Math.max(5, Math.ceil((Math.abs(v) + 2) / 5) * 5);   // 2 points of room for the flags
        const lo = d3.min(vals), hi = d3.max(vals);
        return d3.scaleLinear([lo < 0 ? -step(lo) : -5, hi > 0 ? step(hi) : 5], range);
      }
      const lo = d3.min(vals), hi = d3.max(vals), pad = (hi - lo) * 0.08 || 1;
      return d3.scaleLinear([Math.min(0, lo) < 0 ? lo - pad : Math.max(0, lo - pad), hi + pad], range).nice();
    };
    const x = scaleFor(X, pts.map((p) => p.xv), [m.l, W - m.r]);
    const y = scaleFor(Y, pts.map((p) => p.yv), [H - m.b, m.t]);
    const svg = d3.create("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("role", "img")
      .attr("aria-label", `Scatterplot: ${Y.label} against ${X.label}`)
      .style("width", "100%").style("height", "auto").style("display", "block");
    // ahead / behind shading when the lead is on an axis, lighter than in the country charts so the
    // flags stay easy to read on it
    if (state.scatter.y === "gap") {
      svg.append("rect").attr("class", "lead-area q-wash").attr("x", m.l).attr("y", m.t).attr("width", W - m.l - m.r).attr("height", y(0) - m.t);
      svg.append("rect").attr("class", "trail-area q-wash").attr("x", m.l).attr("y", y(0)).attr("width", W - m.l - m.r).attr("height", H - m.b - y(0));
    } else if (state.scatter.x === "gap") {
      svg.append("rect").attr("class", "trail-area q-wash").attr("x", m.l).attr("y", m.t).attr("width", x(0) - m.l).attr("height", H - m.b - m.t);
      svg.append("rect").attr("class", "lead-area q-wash").attr("x", x(0)).attr("y", m.t).attr("width", W - m.r - x(0)).attr("height", H - m.b - m.t);
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
    // hover trail: the path a country took from its last election to now, under the flags,
    // clipped to the plot (earlier positions can lie outside today's axes)
    const clipId = "qc" + (++uid);
    svg.append("defs").append("clipPath").attr("id", clipId).append("rect").attr("x", m.l).attr("y", m.t).attr("width", W - m.l - m.r).attr("height", H - m.t - m.b);
    const trail = svg.append("g").attr("clip-path", `url(#${clipId})`);
    const clearTrail = () => { trail.selectAll("*").remove(); g.classed("q-dim", false); dots.classed("on", false); };
    const showTrail = (p) => {
      clearTrail();
      const xs = measurePath(state.scatter.x, p.c), ys = measurePath(state.scatter.y, p.c);
      if (!xs && !ys) return;
      const ok = (v, V) => v != null && isFinite(v) && (!V.log || v > 0);
      const raw = p.c.dates.map((d, i) => [xs ? xs[i] : p.xv, ys ? ys[i] : p.yv]).filter((q) => ok(q[0], X) && ok(q[1], Y));
      if (raw.length < 2) return;
      // weekly values wobble, so the path is a running average over about three months (13 weeks,
      // centred), drawn every fourth week, and ends exactly on today's flag
      const half = 6, smooth = raw.map((q, i) => {
        const win = raw.slice(Math.max(0, i - half), i + half + 1);
        return [d3.mean(win, (w) => w[0]), d3.mean(win, (w) => w[1])];
      });
      const path = smooth.filter((q, i) => i % 4 === 0);
      path[0] = raw[0];
      path.push([p.xv, p.yv]);
      const col = p.c.inc ? pcolor(p.c.inc) : "var(--ink-2)";
      const line = d3.line().x((q) => x(q[0])).y((q) => y(q[1])).curve(d3.curveCatmullRom.alpha(0.5));
      trail.append("path").attr("class", "q-trail").attr("d", line(path)).attr("stroke", col);
      const [sx, sy] = [x(path[0][0]), y(path[0][1])];
      trail.append("circle").attr("class", "q-trail-start").attr("cx", sx).attr("cy", sy).attr("r", 4).attr("fill", col);
      trail.append("text").attr("class", "q-trail-label label-halo").attr("x", sx + 7).attr("y", sy - 6).text(`${fmtMonYear(p.c.start)} election`);
      g.classed("q-dim", true); dots.classed("on", (d) => d === p);
    };
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
      .on("pointerenter", (evt, p) => showTrail(p))
      .on("pointerleave", () => { hideTip(); clearTrail(); })
      .on("focus", function (evt, p) { const r = this.getBoundingClientRect(); showTrail(p); showTip({ clientX: r.right, clientY: r.top }, (t) => tipFor(t, p)); })
      .on("blur", () => { hideTip(); clearTrail(); })
      .on("click", (evt, p) => openDetail(p.c))
      .on("keydown", (evt, p) => { if (evt.key === "Enter" || evt.key === " ") { evt.preventDefault(); openDetail(p.c); } });
    host.replaceChildren(svg.node());
    // caption: what is plotted, and the correlation
    const tx = (V, v) => (V.log ? Math.log10(v) : v);
    const r = pts.length > 2 ? pearson(pts.map((p) => tx(X, p.xv)), pts.map((p) => tx(Y, p.yv))) : null;
    $("#sc-title").textContent = `${Y.label} against ${X.label.toLowerCase()}`;
    $("#sc-sub").textContent = `Each flag is a country (${pts.length} shown${pts.length < state.countries.length ? "; countries without a governing party to follow are left out" : ""}). `
      + (r != null ? `Pearson's r = ${r.toFixed(2).replace("-", "−")}. ` : "")
      + (X.ideo || Y.ideo ? `Ideology group: ${groupName()}. ` : "") + "Hover over a flag for its path since the election; select it for the full chart.";
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
      tipRow(t, pcolor(c.inc), `${c.inc.label}, ${c.completed && c.stats.final === "result" ? "result" : c.completed ? "final trend" : "now"}`, fmt1(c.stats.now) + "%", true, fullName(c.inc.article, c.inc.label));
      tipRow(t, "transparent", "Since the election", fmtSigned(c.stats.change));
      if (c.rival) tipRow(t, pcolor(c.rival), c.stats.gap_now >= 0 ? `Ahead of ${c.rival.label}` : `Behind ${c.rival.label}`, fmt1(Math.abs(c.stats.gap_now)), false, fullName(c.rival.article, c.rival.label));
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
    PL: [19.3, 52.1], CZ: [15.4, 49.8], SK: [19.6, 48.72], AT: [13.7, 47.45], HU: [19.7, 46.95],
    SI: [14.8, 46.1, { at: [13.45, 44.05] }], HR: [16.5, 45.65], RS: [20.9, 44.05], ME: [19.25, 42.75, { at: [17.7, 41.7] }],
    IT: [12.6, 42.8], MT: [14.43, 35.9, { at: [16.4, 35.3] }], GR: [22.1, 39.6], BG: [25.2, 42.75], RO: [24.7, 45.9],
    MD: [28.5, 47.1, { at: [30.9, 45.0] }],
  };
  // shapes in the map file that are left out (Africa, Turkey and the Middle East, the Caucasus, Greenland)
  const MAP_DROP = new Set(["DZ", "MA", "TN", "TR", "SY", "IQ", "IR", "LB", "GE", "AM", "AZ", "GL"]);
  const MAP_NAMES = { BA: "Bosnia and Herzegovina", MK: "North Macedonia", "CY-N": "Northern Cyprus", XK: "Kosovo" };
  const MAP_WHY = { UA: "Not covered: under martial law no national election can be held, so there is no next election to count down to." };

  // contrast between two colours (WCAG relative luminance), for the figures printed on the map
  const lum = (col) => { const r = d3.rgb(col); const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }; return 0.2126 * f(r.r) + 0.7152 * f(r.g) + 0.0722 * f(r.b); };
  const contrast = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  /** The preferred ink if it stands out enough from the background, else the darkest or lightest. */
  function inkOn(bg, pref, min) {
    if (contrast(pref, bg) >= min) return pref;
    const alt = [cssVar("--ink"), "#ffffff", "#15181e"];
    return alt.reduce((best, cc) => (contrast(cc, bg) > contrast(best, bg) ? cc : best), alt[0]);
  }

  async function loadMap() {
    if (state.map) return state.map;
    const res = await fetch("data/europe-map.json");
    if (!res.ok) throw new Error("map file not found");
    state.map = topoFeatures(await res.json(), "countries").filter((f) => !MAP_DROP.has(f.id));
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
          const endD = addDays(tl.startD, (tl.n - 1) * tl.step);
          for (const tc of Object.values(tl.countries)) {
            tc.electionsD = tc.elections.map(parseISO);
            // steady polling (see POLL_RULE), in week indices; older data files have no poll weeks
            if (tc.pw && tc.pw.length) {
              tc.runs = steadyRuns(tc.pw.map((w) => addDays(tl.startD, w * tl.step)), tc.electionsD, endD)
                .map(([a, b]) => [Math.ceil((a - tl.startD) / DAY / tl.step), Math.floor((Math.min(b, +endD) - tl.startD) / DAY / tl.step)]);
            }
            // manifesto measures arrive as arrays in tl.measures order; turn them into objects once
            for (const L of tc.lineages) L.mpObj = (L.mp || []).map(([w, arr]) => [w, Object.fromEntries(order.map((k, j) => [k, arr[j]]))]);
          }
          state.timeline = tl; return tl;
        });
    }
    return state.timelinePromise;
  }
  const tlDate = (i) => addDays(state.timeline.startD, i * state.timeline.step);
  function tlValue(tc, li, i) {
    if (tc.runs && !tc.runs.some(([a, b]) => i >= a && i <= b)) return null;
    const pk = tc.v[li]; if (!pk) return null; const j = i - pk[0]; return j >= 0 && j < pk[1].length ? pk[1][j] : null;
  }
  /** The manifesto in force for a timeline line in week i (before its first coded manifesto: that one). */
  function tlMp(L, i) { if (!L.mpObj || !L.mpObj.length) return null; let r = L.mpObj[0][1]; for (const [k, v] of L.mpObj) { if (k <= i) r = v; else break; } return r; }

  /** What the map shows for one country: now (from the current terms) or in week i of the timeline. */
  function mapDatum(c, i) {
    const out = { c, when: i == null ? state.today : tlDate(i), hasData: true };
    if (i == null) {
      out.gap = c.status === "none" ? null : c.stats.gap_now;
      out.inc = c.inc ? { label: c.inc.label, short: shortLabel(c.inc.label), full: fullName(c.inc.article, c.inc.label), color: pcolor(c.inc), v: c.stats ? c.stats.now : null } : null;
      out.change = c.stats && c.inc ? c.stats.change : null;
      // every party's latest share, largest first (after an election just held: the result)
      const useResult = c.completed && c.stats && c.stats.final === "result";
      out.ranked = c.parties.map((p) => ({ p, v: useResult ? p.result_end : lastVal(c, p.key) })).filter((x) => x.v != null).sort((a, b) => b.v - a.v)
        .map((x) => ({ label: x.p.label, short: shortLabel(x.p.label), full: fullName(x.p.article, x.p.label), color: pcolor(x.p), v: x.v, isInc: !!(c.inc && x.p.key === c.inc.key) }));
      out.rival = c.rival ? { label: c.rival.label, short: shortLabel(c.rival.label), full: fullName(c.rival.article, c.rival.label), color: pcolor(c.rival), v: c.stats.rival_now } : null;
      out.leader = c.incumbent && c.incumbent.leader;
      out.until = untilText(c);
      const bn = blocNow(c, null);
      out.bloc = bn.share; out.blocParts = bn.parts.map((x) => ({ label: x.p.label, short: shortLabel(x.p.label), full: fullName(x.p.article, x.p.label), color: pcolor(x.p), v: x.v, mp: x.p.mp, fam: x.p.family, isInc: c.inc && x.p.key === c.inc.key, inherited: x.p.mp_inherited }));
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
    // full name of a line: its id where that is a Wikipedia article title, else its long label
    const full = (L) => fullName(/\s/.test(L.id) ? L.id : L.label, L.short || L.label);
    out.leader = gov ? gov[3] : null;
    if (li >= 0 && vals[li] != null) {
      const L = tc.lineages[li];
      out.inc = { label: L.short || L.label, short: shortLabel(L.short || L.label), full: full(L), color: col(L), v: vals[li] };
      let best = -1; vals.forEach((v, k) => { if (k !== li && v != null && (best < 0 || v > vals[best])) best = k; });
      if (best >= 0) { const R = tc.lineages[best]; out.rival = { label: R.short || R.label, short: shortLabel(R.short || R.label), full: full(R), color: col(R), v: vals[best] }; out.gap = vals[li] - vals[best]; }
      // change since the election before this week: the line's value in the week of that election
      const prev = tc.electionsD.filter((d) => d <= out.when).pop();
      if (prev) {
        const ie = Math.round((prev - state.timeline.startD) / DAY / state.timeline.step);
        let v0 = null; for (let j = ie; j <= ie + 3 && v0 == null; j++) v0 = tlValue(tc, li, j);
        out.change = v0 != null ? vals[li] - v0 : null;
      }
    }
    if (out.gap == null) out.gap = null;
    out.ranked = tc.lineages.map((L, k) => ({ label: L.short || L.label, short: shortLabel(L.short || L.label), full: full(L), color: col(L), v: vals[k], isInc: k === li }))
      .filter((x) => x.v != null).sort((a, b) => b.v - a.v);
    const nxt = tc.electionsD.find((d) => d > out.when);
    out.until = nxt ? spanText(out.when, nxt) : "";
    out.nextElection = nxt;
    const parts = [], unplaced = [];
    tc.lineages.forEach((L, k) => {
      const v = vals[k]; if (v == null) return;
      const mp = tlMp(L, i);
      if (!scored(mp, L.fam)) { if (v >= 1) unplaced.push({ label: L.label, v }); return; }
      if (inGroup(mp, L.fam)) parts.push({ label: L.short || L.label, short: shortLabel(L.short || L.label), full: full(L), color: col(L), v, mp, fam: L.fam, isInc: k === li, inherited: L.inherited });
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
      top.slice(0, 3).forEach((x, k) => tipRow(t, x.color, `${ordinal(k + 1)}: ${x.label}${x.isInc ? ", governing" : ""}`, fmt1(x.v) + "%", x.isInc, x.full));
      const r = top.findIndex((x) => x.isInc);
      if (r >= 3) tipRow(t, top[r].color, `${ordinal(r + 1)}: ${top[r].label}, governing`, fmt1(top[r].v) + "%", true, top[r].full);
      if (r < 0) t.append(el("div", "tt-sub", "No party line to follow (caretaker or non-party head of government)."));
    } else if (state.mapMode === "ideo") {
      tipRow(t, "var(--bloc)", `Ideology group (${groupName()})`, fmt1(d.bloc) + "%", true);
      d.blocParts.slice(0, 8).forEach((x) => tipRow(t, x.color, `${x.label}${partyTag(x.mp, x.fam, x.inherited)}${x.isInc ? ", governing" : ""}`, fmt1(x.v), false, x.full));
      if (d.unplacedShare >= 2) {
        const u = el("div", "tt-gap", `${state.cls.by === "family" ? "No Manifesto family" : "No Manifesto score"}: ${d.unplaced.slice(0, 4).map((x) => `${x.label} ${fmt1(x.v)}`).join(", ")}`);
        u.style.color = "var(--muted)"; t.append(u);
      }
    } else {
      if (d.inc) tipRow(t, d.inc.color, d.inc.label, fmt1(d.inc.v) + "%", true, d.inc.full);
      if (d.rival) tipRow(t, d.rival.color, d.rival.label, fmt1(d.rival.v) + "%", false, d.rival.full);
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
    // fit the tracked countries and Ukraine, plus room for the callout labels that sit outside them
    const extra = Object.values(MAP_LABELS).filter((sp) => sp[2] && sp[2].at).flatMap((sp) => [[sp[2].at[0] + 1.6, sp[2].at[1] - 0.9], [sp[2].at[0] - 1.6, sp[2].at[1] - 0.9]])
      .concat([[-10.6, 39.4]]);   // room for Portugal's label on the left edge
    const fit = { type: "FeatureCollection", features: [...feats.filter((f) => tracked.has(f.id) || f.id === "UA"), { type: "Feature", geometry: { type: "MultiPoint", coordinates: extra } }] };
    // as wide as the box allows, but never taller than the window, so the whole map fits on screen
    const layout = (w) => {
      const pr = d3.geoAzimuthalEqualArea().rotate([-11, -53]).fitWidth(w - 12, fit);
      const bb = d3.geoPath(pr).bounds(fit);
      pr.translate([pr.translate()[0] + 6 - bb[0][0], pr.translate()[1] + 7 - bb[0][1]]);
      return { proj: pr, H: Math.ceil(bb[1][1] - bb[0][1] + 14) };
    };
    let W = Wfull, L0 = layout(W);
    const maxH = window.__noFit ? Infinity : Math.max(520, window.innerHeight - 20);
    if (L0.H > maxH) { W = Math.max(420, Math.floor(W * maxH / L0.H)); L0 = layout(W); }
    const proj = L0.proj, H = L0.H, path = d3.geoPath(proj);
    const k = W / 1000;
    const numSize = clamp(21 * k, 11, 21), daySize = clamp(11 * k, 8.5, 11.5);
    const showDays = W >= 560;
    const fillFor = (d) => {
      if (!d.hasData) return cssVar("--land-off");
      if (place) { const pk = placePick(d); return blocFill(pk ? pk.v : null); }
      return ideo ? blocFill(d.bloc) : gapFill(d.gap);
    };
    const fills = new Map(feats.map((f) => [f.id, tracked.has(f.id) ? fillFor(datum.get(f.id)) : cssVar("--land-out")]));

    const svg = d3.create("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("role", "group").attr("class", ideo || place ? "seq" : null)
      .style("max-width", W < Wfull ? `${W}px` : null)
      .attr("aria-label", ideo ? `Map of Europe: combined poll share of ${groupPhrase()}` : place ? `Map of Europe: poll share of each country's ${PLACES[state.mapPlace]}`
        : "Map of Europe: poll lead or lag of each governing party");
    const id = "m" + (++uid);
    svg.append("defs").append("clipPath").attr("id", id).append("rect").attr("width", W).attr("height", H);
    const land = svg.append("g").attr("clip-path", `url(#${id})`);
    land.selectAll("path").data(feats).join("path")
      .attr("d", path)
      .attr("class", (f) => "country " + (tracked.has(f.id) ? "tracked" : "off hint"))
      .attr("fill", (f) => (tracked.has(f.id) ? fills.get(f.id) : null))
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
            .on("click", () => { hideTip(); openAt(c); })
            .on("focus", function () { const r = this.getBoundingClientRect(); showTip({ clientX: r.right, clientY: r.top }, (t) => mapTip(t, d)); })
            .on("blur", hideTip)
            .on("keydown", (evt) => { if (evt.key === "Enter" || evt.key === " ") { evt.preventDefault(); hideTip(); openAt(c); } });
        } else {
          // countries the dashboard does not cover: say why on hover
          const n = notShown.get(f.id);
          const name = (n && n.name) || MAP_NAMES[f.id] || (f.properties && f.properties.name) || f.id;
          const why = n ? "Not covered: " + (n.note || "").replace(/^./, (ch) => ch.toLowerCase()) : MAP_WHY[f.id] || "Not covered by this dashboard.";
          node.on("pointermove", (evt) => showTip(evt, (t) => { t.append(el("div", "tt-head", name)); t.append(el("div", "tt-sub tt-why", why)); }))
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

    // labels: a big figure and a small line under it, without a halo; each takes the ink that
    // stands out from what lies beneath it (the country's own colour, or the sea or land under a callout)
    const sea = cssVar("--sea") || cssVar("--bg");
    const bgAt = (pt) => {
      const ll = proj.invert(pt);
      const f = ll && feats.find((ff) => d3.geoContains(ff, ll));
      return f ? fills.get(f.id) : sea;
    };
    const inks = { up: cssVar("--lead-ink"), down: cssVar("--trail-ink"), bloc: cssVar("--bloc-ink"), none: cssVar("--muted") };
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
      const bg = opt.at ? bgAt(pt) : fills.get(code);
      lab.append("text").attr("class", "map-num " + cls)
        .attr("x", pt[0]).attr("y", pt[1] + ns * 0.3).attr("text-anchor", "middle")
        .attr("font-size", ns).attr("fill", inkOn(bg, inks[cls], 3)).attr("stroke", bg).text(txt);
      if (showDays && sub) {
        const sy = pt[1] + ns * 0.3 + daySize * 1.25;
        const sbg = opt.at ? bgAt([pt[0], sy - daySize * 0.3]) : bg;
        lab.append("text").attr("class", "map-days").attr("x", pt[0]).attr("y", sy)
          .attr("text-anchor", "middle").attr("font-size", small ? daySize * 0.92 : daySize).attr("fill", inkOn(sbg, cssVar("--ink-2"), 4)).attr("stroke", sbg).text(sub);
      }
    }
    host.replaceChildren(svg.node());

    // colour key, in three cells lined up with the time slider's row below: [left label] [bar] [right label]
    const sc = $("#map-scale");
    sc.replaceChildren();
    const bar = el("span", "bar"), narrow = window.innerWidth < 560 && !window.__noFit;
    const keyRow = (left, right) => sc.append(el("span", "k-left", left), bar, el("span", "k-right", right));
    if (place || ideo) {
      const stops = [0, 10, 20, 30, 40, 50, 60].map((v, i, a) => `${blocFill(v)} ${(i / (a.length - 1)) * 100}%`).join(", ");
      bar.style.background = `linear-gradient(to right, ${stops})`;
      keyRow("0%", narrow ? "60% or more" : "60% or more of the vote");
    } else {
      const stops = [-20, -10, -3, 0, 3, 10, 20].map((v, i, a) => `${gapFill(v)} ${(i / (a.length - 1)) * 100}%`).join(", ");
      bar.style.background = `linear-gradient(to right, ${stops})`;
      keyRow(narrow ? "20 pp behind" : "20 pp or more behind", narrow ? "20 pp ahead" : "20 pp or more ahead");
    }
    $("#map-deck").textContent = place
      ? "The share of the vote that each country's governing party, or its first, second or third party, gets in the polls. Select a country for its polls."
      : ideo
        ? "The combined share of the vote, in the polls, of the parties in an ideology group you choose, such as the radical right. Select a country for its polls."
        : "How far each governing party is ahead of or behind its strongest rival in the polls, and how long until the next election. Use the slider to go back in time, or select a country for its polls.";
    placeHowto(svg.node(), path, feats, W, at, hatched.length > 0);
    syncTime();
    if (state.view === "map") renderSummary();
  }

  // ---- "how to read" keys: a sample tile with two figures, and arrows to what they mean
  function svgEl(tag, attrs, text) {
    const e = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [a, v] of Object.entries(attrs || {})) if (v != null) e.setAttribute(a, v);
    if (text != null) e.textContent = text;
    return e;
  }
  function arrowDefs(svg, id) {
    const defs = svgEl("defs"), mk = svgEl("marker", { id, viewBox: "0 0 8 8", refX: 7, refY: 4, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" });
    mk.append(svgEl("path", { d: "M0.5 0.8 7.2 4 0.5 7.2", fill: "none", stroke: "var(--ink-2)", "stroke-width": 1.1 }));
    defs.append(mk); svg.append(defs);
  }
  /** Note lines at (x, y) with an arrow from the first line's start to the target point. */
  function note(svg, id, x, y, lines, tx, ty) {
    svg.append(svgEl("path", { class: "ht-arrow", d: `M${x - 4} ${y - 3.5} C ${(x - 4 + tx) / 2 + 6} ${y - 3.5}, ${(x - 4 + tx) / 2} ${ty}, ${tx} ${ty}`, "marker-end": `url(#${id})` }));
    lines.forEach((ln, i) => svg.append(svgEl("text", { class: "ht-note", x, y: y + i * 12.5 }, ln)));
  }
  function howtoMap(at, hatched, compact) {
    const host = $("#map-howto");
    const ideo = state.mapMode === "ideo", place = state.mapMode === "place";
    const id = "ha" + (++uid);
    host.classList.toggle("compact", !!compact);
    if (compact) return howtoMapCompact(host, id, at, hatched, ideo, place);
    const W = 352, H = 76;
    const svg = svgEl("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img",
      "aria-label": "Example: the big figure on each country and the small line under it" });
    arrowDefs(svg, id);
    let fill, big, small, n1, n2, cls;
    if (place) {
      fill = blocFill(31.2); big = "31.2"; cls = "bloc";
      small = state.mapPlace === "gov" ? "Party, 2nd" : "Party";
      n1 = [`Poll share of the ${PLACES[state.mapPlace]},`, "in per cent of the vote"];
      n2 = [state.mapPlace === "gov" ? "The party and its place in the polls" : "The party"];
    } else if (ideo) {
      fill = blocFill(24.1); big = "24.1"; cls = "bloc"; small = "Party A, Party B";
      n1 = ["Combined poll share of the", "ideology group, in per cent"]; n2 = ["Its largest parties"];
    } else {
      fill = gapFill(3.7); big = fmtSigned(3.7); cls = "up"; small = spanText(parseISO("2025-01-01"), parseISO("2026-01-24"));
      n1 = ["Governing party's lead (+) or lag (−)", "on its strongest rival, in points (pp)"]; n2 = ["Time to the next election"];
    }
    const inks = { up: cssVar("--lead-ink"), bloc: cssVar("--bloc-ink") };
    svg.append(svgEl("rect", { x: 0.5, y: 4.5, width: 116, height: 64, fill, stroke: "var(--axis)", "stroke-width": 0.8 }));
    svg.append(svgEl("text", { class: "ht-big", x: 58, y: 35, "text-anchor": "middle", "font-size": 23, fill: inkOn(fill, inks[cls], 3) }, big));
    svg.append(svgEl("text", { class: "ht-small", x: 58, y: 54, "text-anchor": "middle", fill: inkOn(fill, cssVar("--ink-2"), 4) }, small));
    note(svg, id, 140, 18, n1, 90, 26);
    note(svg, id, 140, 59, n2, 104, 52);
    const keys = el("div", "howto-keys");
    const key = (color, text, extraCls, pattern) => {
      const sp = el("span", extraCls || null), i = el("i");
      i.style.background = pattern ? "repeating-linear-gradient(45deg, transparent 0 2.5px, var(--muted) 2.5px 3.4px)" : color;
      sp.append(i, document.createTextNode(text)); keys.append(sp);
    };
    key("var(--land-out)", "Not covered (hover for why)");
    key("var(--land-off)", "No polls that week", at == null ? "hidden-key" : null);
    if (ideo && hatched) key(null, `Parties without Manifesto data poll ${UNPLACED_HATCH}% or more`, null, true);
    host.replaceChildren(svg, keys, el("p", "howto-foot", "Hover over a country for its parties; select it for its polls."));
  }
  /** The map key, narrow: the sample tile above, the notes wrapped beside it. */
  function howtoMapCompact(host, id, at, hatched, ideo, place) {
    let fill, big, small, n1, n2, cls;
    if (place) {
      fill = blocFill(31.2); big = "31.2"; cls = "bloc"; small = state.mapPlace === "gov" ? "Party, 2nd" : "Party";
      n1 = `Poll share of the ${PLACES[state.mapPlace]}, in %`; n2 = state.mapPlace === "gov" ? "The party and its place" : "The party";
    } else if (ideo) {
      fill = blocFill(24.1); big = "24.1"; cls = "bloc"; small = "Party A, B";
      n1 = "Combined poll share of the group, in %"; n2 = "Its largest parties";
    } else {
      fill = gapFill(3.7); big = fmtSigned(3.7); cls = "up"; small = spanText(parseISO("2025-01-01"), parseISO("2026-01-24"));
      n1 = "Governing party's lead (+) or lag (−) on its strongest rival, in points"; n2 = "Time to the next election";
    }
    const l1 = wrapText(n1, 20, 5), l2 = wrapText(n2, 20, 3);
    const W = 220, H = Math.max(70, 14 + l1.length * 12.5 + 8 + l2.length * 12.5);
    const svg = svgEl("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Example: the big figure on each country and the small line under it" });
    arrowDefs(svg, id);
    const inks = { up: cssVar("--lead-ink"), bloc: cssVar("--bloc-ink") };
    svg.append(svgEl("rect", { x: 0.5, y: 4.5, width: 96, height: 58, fill, stroke: "var(--axis)", "stroke-width": 0.8 }));
    svg.append(svgEl("text", { class: "ht-big", x: 48, y: 31, "text-anchor": "middle", "font-size": 20, fill: inkOn(fill, inks[cls], 3) }, big));
    svg.append(svgEl("text", { class: "ht-small", x: 48, y: 49, "text-anchor": "middle", fill: inkOn(fill, cssVar("--ink-2"), 4) }, small));
    note(svg, id, 112, 14, l1, 78, 24);
    note(svg, id, 112, 14 + l1.length * 12.5 + 8, l2, 88, 47);
    const keys = el("div", "howto-keys");
    const key = (color, text, extraCls, pattern) => {
      const sp = el("span", extraCls || null), i = el("i");
      i.style.background = pattern ? "repeating-linear-gradient(45deg, transparent 0 2.5px, var(--muted) 2.5px 3.4px)" : color;
      sp.append(i, document.createTextNode(text)); keys.append(sp);
    };
    key("var(--land-out)", "Not covered (hover for why)");
    if (at != null) key("var(--land-off)", "No polls that week");
    if (ideo && hatched) key(null, `No Manifesto data for ${UNPLACED_HATCH}%+`, null, true);
    host.replaceChildren(svg, keys, el("p", "howto-foot", "Hover over a country for its parties; select it for its polls."));
  }
  /** Put the map key in the empty top-right of the map (where Russia would be) when it fits there
   *  without touching a country; otherwise it stays at the top right of the map's options. */
  function placeHowto(svgNode, path, feats, W, at, hatched) {
    const box = $("#map-howto"), mb = $(".map-box");
    const out = () => { mb.classList.remove("howto-in-map"); box.style.left = box.style.top = box.style.right = box.style.transform = ""; };
    if (window.__noFit) { out(); return; }
    const pad = 10;
    box.style.transform = "";
    // the key grows with the map, so its text keeps pace with the map's own labels on big screens:
    // the largest size up to 1.6 times its natural size (for a map about 1,200 px wide or more)
    // that still fits the empty corner, in steps of 5%
    const kMax = clamp(svgNode.getBoundingClientRect().width / 760, 1, 1.6);
    for (const compact of [false, true]) {
      howtoMap(at, hatched, compact);
      mb.classList.add("howto-in-map");
      box.style.transform = "";
      const bw = box.offsetWidth, bh = box.offsetHeight;
      const sr = svgNode.getBoundingClientRect(), br = mb.getBoundingClientRect(), s = sr.width / W;
      for (let k = kMax; k > 0.999; k = Math.round((k - 0.05) * 100) / 100) {
        const w = bw * k, h = bh * k;
        // the key's rectangle in the map's own pixels: flush with the box's right edge, at the top
        const x1 = (br.right - sr.left) / s, x0 = x1 - w / s, y0 = 4 / s, y1 = y0 + h / s;
        const clear = x0 > 0 && y1 < svgNode.viewBox.baseVal.height && !feats.some((f) => {
          const b = path.bounds(f);
          return b[0][0] < x1 + pad && b[1][0] > x0 - pad && b[0][1] < y1 + pad && b[1][1] > y0 - pad;
        });
        if (clear) {
          box.style.transform = k > 1 ? `scale(${k})` : "";
          box.style.left = "auto"; box.style.right = "0px";
          box.style.top = (sr.top - br.top + y0 * s) + "px";
          return;
        }
      }
    }
    box.style.transform = ""; box.style.right = "";
    out(); howtoMap(at, hatched, false);
  }
  function howtoGraphs() {
    const host = $("#cn-howto");
    const cmp = state.cls.cmp;
    const id = "hg" + (++uid);
    // the term runs from the election (left line) to the next election (right line); both are
    // named in vertical text along their lines, so the end of the data is not read as an election
    const W = 386, H = 106, x0 = 16, x1 = 196, xt = 158, top = 6, bot = 98;
    const svg = svgEl("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Example chart: what each line and shade means" });
    arrowDefs(svg, id);
    // a governing party that falls below its rival, sampled every 2 px
    const gov = [[x0, 34], [46, 38], [78, 50], [108, 64], [134, 68], [xt, 66]], riv = [[x0, 68], [46, 65], [78, 55], [108, 46], [134, 43], [xt, 40]];
    const at = (pts, x) => { for (let i = 1; i < pts.length; i++) if (x <= pts[i][0]) { const [a, b] = [pts[i - 1], pts[i]]; return a[1] + (b[1] - a[1]) * (x - a[0]) / (b[0] - a[0]); } return pts[pts.length - 1][1]; };
    const xs = d3.range(x0, xt + 0.1, 2);
    const area = (pick) => "M" + xs.map((x) => `${x} ${pick(x)[0]}`).join("L") + "L" + [...xs].reverse().map((x) => `${x} ${pick(x)[1]}`).join("L") + "Z";
    svg.append(svgEl("rect", { class: "future", x: xt, y: top, width: x1 - xt, height: bot - top }));
    [30, 64].forEach((gy) => svg.append(svgEl("line", { class: "gridline", x1: x0, x2: x1, y1: gy, y2: gy })));
    svg.append(svgEl("path", { class: "lead-area", d: area((x) => { const a = at(gov, x), b = at(riv, x); return [Math.min(a, b), b]; }) }));
    svg.append(svgEl("path", { class: "trail-area", d: area((x) => { const a = at(gov, x), b = at(riv, x); return [b, Math.max(a, b)]; }) }));
    svg.append(svgEl("line", { x1: x0, x2: x1, y1: bot, y2: bot, stroke: "var(--axis)" }));
    svg.append(svgEl("line", { x1: x0, x2: x0, y1: top, y2: bot, stroke: "var(--axis)" }));
    svg.append(svgEl("line", { x1: x1, x2: x1, y1: top, y2: bot, stroke: "var(--ink-2)", "stroke-width": 1.2 }));
    svg.append(svgEl("line", { class: "today-line", x1: xt, x2: xt, y1: top, y2: bot }));
    const gcol = "var(--ink)", rcol = cmp ? "var(--bloc)" : "var(--muted)";
    [[26, 31], [40, 42], [58, 39], [72, 52], [92, 53], [104, 67], [122, 62], [146, 71]].forEach(([x, y]) => svg.append(svgEl("circle", { cx: x, cy: y, r: 2, fill: gcol, opacity: 0.4 })));
    [[30, 70], [54, 59], [86, 58], [100, 44], [126, 46], [148, 39]].forEach(([x, y]) => svg.append(svgEl("circle", { cx: x, cy: y, r: 1.8, fill: rcol, opacity: 0.45 })));
    const line = (pts) => "M" + pts.map((q) => q.join(" ")).join("L");
    svg.append(svgEl("path", { d: line(riv), fill: "none", stroke: rcol, "stroke-width": cmp ? 2.2 : 1.8, "stroke-dasharray": cmp ? "5 3" : null, "stroke-linecap": "round" }));
    svg.append(svgEl("path", { d: line(gov), fill: "none", stroke: gcol, "stroke-width": 3.6, "stroke-linecap": "round", "stroke-linejoin": "round" }));
    const nx = 230;
    note(svg, id, nx, 12, [atDate() ? "Date shown" : "Today"], xt + 1, top + 3);
    note(svg, id, nx, 32, ["Time left to the election"], 174, 24);
    note(svg, id, nx, 52, [cmp ? "Ideology group, dashed" : "Strongest rival"], 134, at(riv, 134) - 1);
    note(svg, id, nx, 72, ["Governing party, thick"], 138, at(gov, 138) + 2);
    note(svg, id, nx, 92, ["Single polls"], 149, 73);
    // the two elections, in vertical text beside their lines (drawn last, with a halo, so the
    // arrows that pass them break neatly)
    const vtext = (x, text) => svg.append(svgEl("text", { class: "ht-small label-halo", transform: `translate(${x}, ${bot - 2}) rotate(-90)`, fill: "var(--muted)" }, text));
    vtext(x0 - 4, "Election");
    vtext(x1 + 11, "Next election");
    const keys = el("div", "howto-keys");
    [["lead-wash", cmp ? "Incumbent ahead of the group" : "Incumbent ahead of the strongest rival"], ["trail-wash", "Behind it"]].forEach(([w, t]) => {
      const sp = el("span"), i = el("i"); i.style.background = `var(--${w})`;
      sp.append(i, document.createTextNode(t)); keys.append(sp);
    });
    host.replaceChildren(svg, keys, el("p", "howto-foot", "Hover over a chart for every party on that date."));
  }

  // ---- the controls above the map: what it shows, the ideology group picker, the time slider
  /** How many countries have polls in week i of the timeline. */
  function coverageAt(i) {
    const tl = state.timeline; let n = 0;
    for (const c of state.countries) { const tc = tl.countries[c.code]; if (tc && tc.lineages.some((L, li) => tlValue(tc, li, i) != null)) n++; }
    return n;
  }
  /** Put the date label under the slider's thumb, kept inside the slider's row. */
  function placeThumb(input, out) {
    const wrap = input.closest(".scale-time"); if (!wrap || !wrap.offsetParent) return;
    const r = input.getBoundingClientRect(), wr = wrap.getBoundingClientRect();
    const min = +input.min, max = +input.max, f = max > min ? (+input.value - min) / (max - min) : 1;
    const cx = r.left - wr.left + 6.5 + f * (r.width - 13), w = out.offsetWidth;
    out.style.left = clamp(cx - w / 2, 0, Math.max(0, wr.width - w)) + "px";
  }
  /** The map's slider and the country graphs' slider show one shared date. */
  function syncTime() {
    const tl = state.timeline, at = state.mapAt != null && tl ? state.mapAt : null;
    [["#map-time", "#map-date"], ["#cn-time", "#cn-date"]].forEach(([sid, oid]) => {
      const sl = $(sid), out = $(oid);
      if (tl) { sl.max = tl.n; sl.value = at == null ? tl.n : at; }
      out.hidden = at == null;
      sl.closest(".scale-time").classList.toggle("dated", at != null);
      if (at != null) {
        out.replaceChildren(el("b", null, fmtDate(tlDate(at))), el("span", null, `(${coverageAt(at)} of ${state.countries.length} countries with polls)`));
        placeThumb(sl, out);
      }
    });
  }
  let playTimer = null, stopPlay = () => {};
  function initMapControls() {
    const modeUI = (v) => {
      $("#map-ideo").hidden = v !== "ideo";
      $("#map-place").hidden = v !== "place";
      if (v === "ideo") mountIdeo($("#map-ideo"));
    };
    if (!["gov", "place", "ideo"].includes(state.mapMode)) state.mapMode = "gov";
    textRadio($("#map-mode"), [
      { label: "Government poll lead/lag", value: "gov" },
      { label: "Party shares", value: "place" },
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
    const play = $("#map-play");
    let sized = false;
    const ready = (tl) => {
      if (!sized) {
        sized = true;
        $("#time-start").textContent = $("#cn-time-start").textContent = fmtMonYear(tl.startD);
        syncTime();
      }
      return tl;
    };
    const ensure = () => loadTimeline().then(ready).catch((e) => { const md = $("#map-date"); md.hidden = false; md.textContent = "Earlier weeks could not be loaded"; throw e; });
    // both sliders: moving one moves the other, and redraws the view it sits in
    [["#map-time", () => renderMap()], ["#cn-time", () => renderGridSoon()]].forEach(([sid, draw]) => {
      const sl = $(sid);
      sl.addEventListener("pointerdown", () => { ensure(); }, { once: true });
      sl.addEventListener("focus", () => { ensure(); }, { once: true });
      sl.addEventListener("input", async () => {
        const v = +sl.value;
        const tl = await ensure();
        state.mapAt = v >= tl.n ? null : v;
        syncTime();
        draw();
      });
    });
    const setPlay = (on) => {
      play.innerHTML = on ? '<svg viewBox="0 0 7 8" aria-hidden="true"><rect x="0" y="0" width="2.3" height="8"/><rect x="4.7" y="0" width="2.3" height="8"/></svg>Pause'
        : '<svg viewBox="0 0 7 8" aria-hidden="true"><path d="M0 0 7 4 0 8z"/></svg>Time lapse';
    };
    setPlay(false);
    const stop = () => { clearInterval(playTimer); playTimer = null; setPlay(false); };
    stopPlay = stop;
    play.addEventListener("click", async () => {
      if (playTimer) { stop(); return; }
      const tl = await ensure();
      let i = state.mapAt == null ? Math.max(0, Math.round((parseISO("2000-01-01") - tl.startD) / DAY / tl.step)) : state.mapAt;
      setPlay(true);
      playTimer = setInterval(() => {
        i += 4;
        if (i >= tl.n) { state.mapAt = null; renderMap(); stop(); return; }
        state.mapAt = i; renderMap();
      }, 140);
    });
    window.addEventListener("resize", () => syncTime());
    // load the timeline in the background once the page has settled
    setTimeout(() => { loadTimeline().then(ready).catch(() => {}); }, 1200);
  }

  // ------------------------------------------------------------------------------- detail dialog
  /** Open a country's chart at the date the slider shows (the latest polls when it is at the end). */
  async function openAt(c) {
    const D = atDate();
    if (!D) { openDetail(c); return; }
    const x = await termAtAsync(c, D);
    openDetail(x || c, x ? null : `Wikipedia has no polls for ${c.name} on ${fmtDate(D)}, so this is the current term.`);
  }
  function openDetail(c, notice) {
    hideTip();
    const dlg = $("#detail");
    const fl = $("#detail-flag");
    const src = (window.FLAGS || {})[c.code];
    if (src) { fl.src = src; fl.hidden = false; } else fl.hidden = true;
    $("#detail-kicker").textContent = `${c.asOf ? "On " + fmtDate(c.asOf) + ": " : ""}${statusText(c)}. ${nextElectionText(c, true)}.`;
    $("#detail-title").textContent = c.name;
    const body = $("#detail-body");
    body.replaceChildren();
    const hidden = new Set(c.parties.filter((p) => p.minor).map((p) => p.key));
    const intro = el("p", "note");
    const inc = c.incumbent || {};
    intro.textContent = (notice ? notice + " " : "") + (inc.leader ? `${inc.title || "Head of government"}: ${inc.leader}${c.inc ? " (" + c.inc.label + ")" : ""}. ` : "")
      + `${c.n_polls} polls from ${fmtDate(c.start)} to ${fmtDate(c.lastData)}` + (c.asOf ? `, shown up to ${fmtDate(c.asOf)}. ` : ". ") + (c.note || "");
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
    ["Party", "Election result", c.completed ? "Final trend" : c.asOf ? `Trend on ${fmtDate(c.asOf)}` : "Trend now", "Change", "Polls"].forEach((h, i) => hr.append(el("th", i ? "num" : null, h)));
    const th = el("thead"); th.append(hr); t.append(th);
    const tb = el("tbody");
    ordered.forEach((p) => {
      const r = el("tr"); const now = lastVal(c, p.key);
      if (now == null && !p.n) return;
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
      const lr = el("button", "linkbtn", `Historical data for ${c.name}`); lr.type = "button";
      lr.style.fontSize = "inherit";
      lr.addEventListener("click", () => { dlg.close(); state.lr.code = c.code; $("#lr-country").value = c.code; state.lr.domain = null; state.lr.hidden = new Set(); $("#lr-ranges").dataset.code = ""; showView("timelines", true); });
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
    $("#pick-head").hidden = !lead && !share;
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
  const VIEWS = ["map", "graphs", "correlates", "timelines", "errors", "method"];
  // hashes used by earlier versions still open the right tab
  const OLD_VIEWS = { incumbents: "graphs", countries: "graphs", scatter: "correlates", longrun: "timelines", about: "method", history: "timelines" };
  function showView(v, push) {
    state.view = v;
    VIEWS.forEach((name) => {
      $("#view-" + name).hidden = name !== v;
      $("#tab-" + name).setAttribute("aria-selected", String(name === v));
    });
    if (push) { try { history.replaceState(null, "", "#" + v); } catch (e) { /* sandboxed */ } }
    hideTip();
    if (v !== "map" && playTimer) stopPlay();   // the time lapse plays on the map only
    $("#summary").hidden = v !== "map";
    syncPaletteSwitch();
    syncTime();
    if (v === "map") renderMap();
    if (v === "correlates") renderScatter();
    if (v === "graphs") { if (state.cls.cmp) mountIdeo($("#cn-ideo")); renderGrid(); }
    if (v === "timelines") renderLongRun();
    if (v === "errors") renderErrors();
  }
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => showView(t.dataset.view, true)));
  const viewFromHash = () => { const h = (location.hash || "").replace("#", ""); return OLD_VIEWS[h] || (VIEWS.includes(h) ? h : "map"); };
  /** "#about" opens the method page at the About section. */
  const toAbout = () => { if ((location.hash || "") === "#about") requestAnimationFrame(() => { const a = $("#about"); if (a) a.scrollIntoView({ block: "start" }); }); };
  window.addEventListener("hashchange", () => { const v = viewFromHash(); if (v !== state.view) showView(v, false); toAbout(); });
  // links to the About section (header and footer) work even when the address already ends in #about
  document.querySelectorAll('a[href="#about"]').forEach((a) => a.addEventListener("click", (e) => {
    e.preventDefault();
    try { history.replaceState(null, "", "#about"); } catch (err) { /* sandboxed */ }
    if (state.view !== "method") showView("method", false);
    requestAnimationFrame(() => $("#about").scrollIntoView({ block: "start" }));
  }));

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
    // last day of fieldwork (newer data files; otherwise the middle of fieldwork)
    h.pollEnds = h.polls.e ? h.polls.e.map((t) => addDays(h.origin, t)) : h.pollDates;
    h.govts = (h.governments || []).map((g) => ({ ...g, fromD: parseISO(g.from), toD: g.to ? parseISO(g.to) : state.today }));
    h.resByDate = { ...(h.elections || {}) };
    h.elections = Object.keys(h.elections || {}).sort().map((d) => ({ d: parseISO(d), res: h.elections[d] }));
    h.end = d3.max(h.segments, (s) => s.dates[s.dates.length - 1]);
    h.minorIds = new Set(h.auto ? h.lineages.filter((L) => L.max < 4).map((L) => L.id) : []);
    h.pollsterNames = h.pollsters || [];
    applySteadyPolling(h);
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
    $(".lr-box").hidden = !!h.empty;
    const pr = $("#lr-ranges");
    if (pr.dataset.code !== code) {
      pr.dataset.code = code;
      const y0 = h.origin.getUTCFullYear();
      const nPolls = h.pollDates.length;
      $("#lr-title").textContent = h.empty ? h.name : `${h.name} since ${y0}`;
      const fl = $("#lr-flag"), fsrc = (window.FLAGS || {})[code];
      if (fsrc) { fl.src = fsrc; fl.hidden = false; } else fl.hidden = true;
      const gapNote = !POLL_RULE || !h.dropped ? "" : h.empty
        ? `Wikipedia's ${d3.format(",")(h.dropped)} polls for ${h.name} are more than three months apart throughout, too sparse for a continuous line; the Polling errors view still shows those before each election.`
        : `Stretches where polls are more than three months apart are left out (${d3.format(",")(h.dropped)} polls), because a line cannot follow them.`;
      $("#lr-deck").textContent = h.empty ? gapNote : `Every national voting-intention poll on English Wikipedia across ${h.segments.length} parliamentary terms, ${d3.format(",")(nPolls)} polls in all, joined into continuous lines. `
        + (h.auto ? "Where a party was renamed or continued by a successor, its line carries on. " : "Party lineages follow renames, mergers and joint lists (PO to KO, SLD to Lewica, KNP to Konfederacja). ")
        + (h.govts.length ? "The band above the chart shows the head of government's party, and that party's line is drawn thicker while it governs. " : "") + gapNote;
      // period presets: whole span + each term
      const presets = [{ label: "All years", value: -1 }, ...h.segments.map((s, i) => ({ label: `${(s.firstD && s.firstD > s.startD ? s.firstD : s.startD).getUTCFullYear()} to ${s.endD.getUTCFullYear()}`, value: i }))];
      textRadio(pr, presets, -1, (v) => { state.lr.domain = v < 0 ? null : [h.segments[v].firstD && h.segments[v].firstD > h.segments[v].startD ? h.segments[v].firstD : h.segments[v].startD, h.segments[v].endD]; drawLongRun(h); });
      pr.hidden = !!h.empty;
      buildLrLegend(h);
      const srcs = $("#lr-sources"); srcs.replaceChildren(document.createTextNode("Wikipedia pages used: "));
      $(".lr-controls").hidden = !!h.empty;
      h.raw.segments.forEach((s, i) => {
        if (i) srcs.append(document.createTextNode(", "));
        const a = el("a", null, `${s.startD.getUTCFullYear()} to ${s.endD.getUTCFullYear()}`);
        a.href = s.revid ? `https://en.wikipedia.org/w/index.php?title=${encodeURIComponent(s.page.replace(/ /g, "_"))}&oldid=${s.revid}` : s.url;
        a.target = "_blank"; a.rel = "noopener"; a.title = s.page; srcs.append(a);
      });
      srcs.append(document.createTextNode(h.govts.length ? ". Heads of government: ParlGov to 2020, then Wikipedia." : "."));
      const lin = $("#lr-lineages"); lin.replaceChildren();
      const joined = h.lineages.filter((L) => L.names);
      $("#lr-fold").hidden = !joined.length;
      $("#lr-fold-n").textContent = joined.length ? `(${joined.length} joined lines)` : "";
      joined.forEach((L) => {
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

  // ------------------------------------------------------------------------------- polling errors
  // Pollster names on Wikipedia carry archive notes, spelling variants ("CeSID", "CeSid") and the
  // client after a slash ("IBRiS / Onet"): polls are grouped by the polling firm, shown in its most
  // common tidy spelling.
  const cleanPollster = (n) => String(n || "").replace(/\s*Archived\b.*$/i, "").replace(/\[[^\]]*\]/g, "")
    .split(/\s*\/\s*/)[0].replace(/\s+/g, " ").trim() || "Unknown";
  const pollsterKey = (n) => cleanPollster(n).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "") || "unknown";
  const isoDay = d3.utcFormat("%Y-%m-%d");
  /** Words into lines of at most n characters; lines past maxLines are joined to the last one. */
  function wrapText(text, n, maxLines = 3) {
    const lines = [];
    let cur = "";
    for (const w of String(text || "").split(/\s+/).filter(Boolean)) {
      if (!cur || (cur + " " + w).length <= n) cur = cur ? cur + " " + w : w;
      else { lines.push(cur); cur = w; }
    }
    if (cur) lines.push(cur);
    if (lines.length > maxLines) lines.splice(maxLines - 1, lines.length, lines.slice(maxLines - 1).join(" "));
    return lines;
  }
  // a fixed spread of each poll up and down its row, from its index (the same on every redraw)
  const jitter = (i) => ((((i + 1) * 2654435761) >>> 0) % 1000) / 1000 - 0.5;

  /** The parties' results at election e and every poll in the days before it. */
  function errorsData(h, e, days) {
    const raw = h.raw, from = +e.d - days * DAY;
    // a poll counts when its fieldwork ended in the chosen days before election day
    const idx = []; raw.pollEnds.forEach((d, i) => { if (+d >= from && +d < +e.d) idx.push(i); });
    const names = h.pollsterNames || [];
    const pinfo = (i) => { const pi = raw.polls.p ? raw.polls.p[i] : null; const name = cleanPollster(pi != null ? names[pi] : null); return { key: pollsterKey(name), name }; };
    // pollsters in the window, with the commonest spelling of each
    const byKey = new Map();
    idx.forEach((i) => {
      const { key, name } = pinfo(i);
      const r = byKey.get(key) || { key, n: 0, spell: new Map() };
      r.n++; r.spell.set(name, (r.spell.get(name) || 0) + 1); byKey.set(key, r);
    });
    const pollsters = [...byKey.values()].map((r) => ({ key: r.key, n: r.n, name: [...r.spell.entries()].sort((a, b) => b[1] - a[1])[0][0] }))
      .sort((a, b) => b.n - a.n || a.name.localeCompare(b.name));
    const pname = new Map(pollsters.map((q) => [q.key, q.name]));
    const used = idx.filter((i) => !state.pe.off.has(pinfo(i).key));
    const rows = Object.entries(e.res).filter(([, v]) => v != null).sort((a, b) => b[1] - a[1]).map(([lid, result]) => {
      const L = h.byId.get(lid);
      const label = L ? L.short || L.label : lid;
      const polls = [];
      const vals = raw.polls.v[lid];
      if (vals) used.forEach((i) => {
        const v = vals[i]; if (v == null) return;
        const n = raw.polls.n ? raw.polls.n[i] : null, key = pinfo(i).key;
        const half = n > 0 ? 1.96 * Math.sqrt(Math.max(0, v * (100 - v)) / n) : null;
        polls.push({ i, v, n, key, name: pname.get(key), date: raw.pollEnds[i], lo: half != null ? Math.max(0, v - half) : null, hi: half != null ? v + half : null });
      });
      const avg = polls.length ? d3.mean(polls, (q) => q.v) : null;
      return { lid, label, full: fullName(L ? (/\s/.test(L.id) ? L.id : L.label) : lid, label), color: L ? lcolor(L) : "#8a8f99",
        result, polls, avg, err: avg != null ? avg - result : null };
    });
    const pairs = rows.flatMap((r) => r.polls.map((q) => ({ q, r, d: q.v - r.result })));
    const mae1 = pairs.length ? d3.mean(pairs, (x) => Math.abs(x.d)) : null;
    const withAvg = rows.filter((r) => r.avg != null);
    const mae2 = withAvg.length ? d3.mean(withAvg, (r) => Math.abs(r.err)) : null;
    // the pollsters used, by their average miss
    const table = pollsters.filter((q) => !state.pe.off.has(q.key)).map((q) => {
      const mine = pairs.filter((x) => x.q.key === q.key);
      const worst = mine.reduce((m, x) => (!m || Math.abs(x.d) > Math.abs(m.d) ? x : m), null);
      return { ...q, polls: new Set(mine.map((x) => x.q.i)).size, mae: mine.length ? d3.mean(mine, (x) => Math.abs(x.d)) : null, worst };
    }).filter((q) => q.mae != null).sort((a, b) => a.mae - b.mae);
    return { rows, pollsters, used, mae1, mae2, table, from: new Date(from) };
  }

  function drawErrors(host, data, ci) {
    const rows = data.rows;
    const W = Math.max(330, Math.min(1180, Math.round(host.clientWidth || 900)));
    const narrow = W < 620;
    const lw = narrow ? 104 : 196, rw = narrow ? 92 : 150, rowH = narrow ? 50 : 44, top = 26, bot = 42;
    const H = top + rows.length * rowH + bot;
    const xmax = niceMax(d3.max(rows.flatMap((r) => [r.result, ...r.polls.map((q) => (ci && q.hi != null ? q.hi : q.v))])) || 20);
    const x = d3.scaleLinear([0, xmax], [lw, W - rw - 10]);
    const svg = d3.create("svg").attr("viewBox", `0 0 ${W} ${H}`).style("width", "100%").style("height", "auto").style("display", "block")
      .attr("role", "img").attr("aria-label", "Election results against the polls before the vote: " + rows.slice(0, 6).map((r) => `${r.label} ${fmt1(r.result)}%${r.avg != null ? ", polls " + fmt1(r.avg) : ""}`).join("; "));
    const ticks = x.ticks(narrow ? 5 : 10);
    svg.append("g").selectAll("line").data(ticks).join("line").attr("class", "gridline")
      .attr("x1", (d) => x(d)).attr("x2", (d) => x(d)).attr("y1", top).attr("y2", H - bot);
    const ax = svg.append("g").attr("class", "axis");
    ax.selectAll("text.t").data(ticks).join("text").attr("class", "t").attr("x", (d) => x(d)).attr("y", H - bot + 14).attr("text-anchor", "middle")
      .text((d, i) => (i === ticks.length - 1 ? d + "%" : d));
    ax.append("text").attr("class", "axis-title").attr("x", (x(0) + x(xmax)) / 2).attr("y", H - 8).attr("text-anchor", "middle").text("Share of the vote");
    const cAvg = W - 74, cErr = W - 6;
    svg.append("text").attr("class", "pe-colhead").attr("x", cAvg).attr("y", 15).attr("text-anchor", "end").text(narrow ? "Polls" : "Poll average");
    svg.append("text").attr("class", "pe-colhead").attr("x", cErr).attr("y", 15).attr("text-anchor", "end").text("Error, pp");
    rows.forEach((r, k) => {
      const y0 = top + k * rowH, cy = y0 + rowH / 2;
      const g = svg.append("g");
      g.append("line").attr("class", "gridline").attr("x1", 0).attr("x2", W).attr("y1", y0).attr("y2", y0);
      // party: abbreviation, full name under it in small grey
      const full = r.full ? wrapText(r.full, narrow ? 19 : 30, 2) : [];
      const blockH = 13 + full.length * 11.5, ty = cy - blockH / 2 + 11;
      g.append("text").attr("class", "pe-abbr").attr("x", 0).attr("y", ty).text(r.label);
      full.forEach((ln, j) => g.append("text").attr("class", "pe-full").attr("x", 0).attr("y", ty + 12 + j * 11.5).text(ln));
      // polls: intervals, then dots, spread up and down the row
      const spread = rowH * 0.42;
      const polls = g.append("g");
      r.polls.forEach((q) => {
        const py = cy + jitter(q.i) * spread;
        if (ci && q.lo != null) polls.append("line").attr("class", "pe-ci").attr("x1", x(q.lo)).attr("x2", x(Math.min(q.hi, xmax))).attr("y1", py).attr("y2", py).attr("stroke", r.color);
        polls.append("circle").attr("class", "pe-dot").attr("cx", x(q.v)).attr("cy", py).attr("r", narrow ? 2.6 : 3.1).attr("fill", r.color)
          .on("pointermove", (evt) => showTip(evt, (t) => {
            t.append(el("div", "tt-head", q.name));
            t.append(el("div", "tt-sub", `Fieldwork to ${fmtDate(q.date)}${q.n ? `, sample ${d3.format(",")(q.n)}` : ""}`));
            tipRow(t, r.color, r.label, fmt1(q.v) + "%", true, r.full);
            if (ci && q.lo != null) tipRow(t, "transparent", "95% interval", `${fmt1(q.lo)} to ${fmt1(q.hi)}`);
            const gap = el("div", "tt-gap", `${fmtSigned(q.v - r.result)} pp against the result of ${fmt1(r.result)}%`);
            t.append(gap);
          }))
          .on("pointerleave", hideTip);
      });
      // the average of the polls: a short dark tick
      if (r.avg != null) g.append("line").attr("class", "pe-avg").attr("x1", x(r.avg)).attr("x2", x(r.avg)).attr("y1", cy - 13).attr("y2", cy + 13);
      // the result: a square with the figure in it
      const sq = narrow ? 22 : 25;
      const sqG = g.append("g").style("cursor", "default")
        .on("pointermove", (evt) => showTip(evt, (t) => {
          t.append(el("div", "tt-head", r.full ? `${r.label} (${r.full})` : r.label));
          tipRow(t, r.color, "Result", fmt1(r.result) + "%", true);
          if (r.avg != null) {
            tipRow(t, "transparent", `Average of ${r.polls.length} poll${r.polls.length === 1 ? "" : "s"}`, fmt1(r.avg) + "%");
            t.append(el("div", "tt-gap", `The polls ${r.err > 0.05 ? "overstated" : r.err < -0.05 ? "understated" : "matched"} the result${Math.abs(r.err) > 0.05 ? " by " + fmt1(Math.abs(r.err)) + " pp" : ""}.`));
          } else t.append(el("div", "tt-sub", "No poll in the chosen days."));
        }))
        .on("pointerleave", hideTip);
      sqG.append("rect").attr("class", "pe-sq").attr("x", x(r.result) - sq / 2).attr("y", cy - sq / 2).attr("width", sq).attr("height", sq).attr("fill", r.color);
      sqG.append("text").attr("class", "pe-sqv").attr("x", x(r.result)).attr("y", cy + 3.4).attr("text-anchor", "middle")
        .attr("font-size", r.result >= 10 ? (narrow ? 8.4 : 9.4) : (narrow ? 8.8 : 10)).attr("fill", inkOn(r.color, "#ffffff", 3.2)).text(fmt1(r.result));
      // the numbers on the right
      g.append("text").attr("class", "pe-num").attr("x", cAvg).attr("y", cy + 4).attr("text-anchor", "end").text(r.avg != null ? fmt1(r.avg) : "–");
      g.append("text").attr("class", "pe-num strong").attr("x", cErr).attr("y", cy + 4).attr("text-anchor", "end").text(r.err != null ? fmtSigned(r.err) : "–");
    });
    svg.append("line").attr("class", "gridline").attr("x1", 0).attr("x2", W).attr("y1", top + rows.length * rowH).attr("y2", top + rows.length * rowH);
    host.replaceChildren(svg.node());
  }

  function howtoErrors() {
    const host = $("#pe-howto"), ci = state.pe.ci;
    const id = "he" + (++uid);
    // a sample row: the polls and their average on the left, the result further right; the notes
    // sit right of the row and their arrows pass below the square
    const W = 360, H = ci ? 96 : 80, cy = 34, col = "#5b79a8";
    const svg = svgEl("svg", { width: W, height: H, viewBox: `0 0 ${W} ${H}`, role: "img", "aria-label": "Example row: what the square, the dots and the tick mean" });
    arrowDefs(svg, id);
    svg.append(svgEl("line", { class: "gridline", x1: 0, x2: 190, y1: 10, y2: 10 }));
    svg.append(svgEl("line", { class: "gridline", x1: 0, x2: 190, y1: 58, y2: 58 }));
    svg.append(svgEl("text", { class: "pe-abbr", x: 0, y: cy - 2 }, "Party"));
    svg.append(svgEl("text", { class: "pe-full", x: 0, y: cy + 10 }, "Full name"));
    const dots = [[72, -6], [82, 6], [92, -2], [100, 8], [110, -8], [116, 2], [128, -5], [136, 7]];
    if (ci) svg.append(svgEl("line", { class: "pe-ci", x1: 84, x2: 124, y1: cy + 8, y2: cy + 8, stroke: col }));
    dots.forEach(([x, dy]) => svg.append(svgEl("circle", { class: "pe-dot", cx: x, cy: cy + dy, r: 3.1, fill: col })));
    svg.append(svgEl("line", { class: "pe-avg", x1: 104, x2: 104, y1: cy - 13, y2: cy + 13 }));
    svg.append(svgEl("rect", { class: "pe-sq", x: 157.5, y: cy - 12.5, width: 25, height: 25, fill: col }));
    svg.append(svgEl("text", { class: "pe-sqv", x: 170, y: cy + 3.4, "text-anchor": "middle", "font-size": 9.4, fill: "#ffffff" }, "28.8"));
    const nx = 212;
    note(svg, id, nx, 31, ["Election result, in %"], 185, cy);
    note(svg, id, nx, 52, ["Average of the polls"], 105, cy + 14);
    note(svg, id, nx, 70, ["One poll each"], 136, cy + 10);
    if (ci) note(svg, id, nx, 88, ["95% interval from sample size"], 122, cy + 10);
    host.replaceChildren(svg, el("p", "howto-foot", "Error: poll average minus result. Hover for each poll."));
  }

  let peToken = 0, peTimer = null;
  async function renderErrors() {
    syncPaletteSwitch();
    howtoErrors();
    const token = ++peToken;
    const code = state.pe.code;
    let h;
    try { h = await loadHistory(code); } catch (e) { $("#pe-chart").replaceChildren(el("p", "note", "The data could not be loaded: " + e.message)); return; }
    if (token !== peToken) return;
    const c = state.countries.find((x) => x.code === code) || { code, name: h.name };
    const els = h.elections.filter((e) => e.res && Object.keys(e.res).length).slice().reverse();
    const sel = $("#pe-election");
    if (sel.dataset.code !== code) {
      sel.dataset.code = code;
      sel.replaceChildren(...els.map((e) => { const o = el("option", null, fmtDate(e.d)); o.value = isoDay(e.d); return o; }));
    }
    const e = els.find((x) => isoDay(x.d) === state.pe.date) || els[0];
    const fl = $("#pe-flag"), fsrc = (window.FLAGS || {})[code];
    if (fsrc) { fl.src = fsrc; fl.hidden = false; } else fl.hidden = true;
    if (!e) {
      $("#pe-title").textContent = c.name;
      $("#pe-mae").textContent = "Wikipedia gives no election results for this country.";
      ["#pe-chart", "#pe-table"].forEach((q) => $(q).replaceChildren()); $("#pe-term-box").hidden = true; return;
    }
    sel.value = isoDay(e.d);
    const days = state.pe.days;
    const D = errorsData(h, e, days);
    $("#pe-title").textContent = `${c.name}, election of ${fmtDate(e.d)}`;
    const nUsed = D.used.length, nPs = new Set(D.used.map((i) => pollsterKey(cleanPollster((h.pollsterNames || [])[h.raw.polls.p ? h.raw.polls.p[i] : -1])))).size;
    $("#pe-count").textContent = D.pollsters.length ? `(${nUsed} poll${nUsed === 1 ? "" : "s"} by ${nPs} pollster${nPs === 1 ? "" : "s"})` : "(no polls)";
    const span = days === 7 ? "week" : days === 14 ? "two weeks" : days === 1 ? "day" : `${days} days`;
    $("#pe-mae").textContent = !D.pollsters.length
      ? `Wikipedia lists no national poll in the ${span} before this election; the chart shows the results only. Try a longer period.`
      : !nUsed ? "No pollster is selected; the chart shows the results only."
      : `A single poll missed a party's result by ${fmt1(D.mae1)} points on average, and the average of the polls by ${fmt1(D.mae2)} `
        + `(mean absolute errors across the parties, for polls with fieldwork ending in the ${span} before the vote).`;
    // pollster picker
    errorsKeysNow = () => D.pollsters.map((q) => q.key);
    const box = $("#pe-pollsters");
    box.replaceChildren(...D.pollsters.map((q) => {
      const lab = el("label"), cb = el("input"); cb.type = "checkbox"; cb.checked = !state.pe.off.has(q.key);
      cb.addEventListener("change", () => { if (cb.checked) state.pe.off.delete(q.key); else state.pe.off.add(q.key); renderErrors(); });
      lab.append(cb, document.createTextNode(`${q.name} (${q.n})`)); return lab;
    }));
    const on = D.pollsters.filter((q) => !state.pe.off.has(q.key)).length;
    $("#pe-pollster-count").textContent = D.pollsters.length ? (on === D.pollsters.length ? `(all ${on})` : `(${on} of ${D.pollsters.length})`) : "(none in this period)";
    drawErrors($("#pe-chart"), D, state.pe.ci);
    // pollsters by their average miss
    const tw = $("#pe-table");
    if (D.table.length) {
      const t = el("table"), cap = el("caption", "pe-caption", `Pollsters in this period, by their average miss (mean absolute error across the parties, in points)`);
      const hr = el("tr");
      [["Pollster"], ["Polls", "num"], ["Average miss, pp", "num"], ["Largest miss"]].forEach(([x, cls]) => hr.append(el("th", cls || null, x)));
      const th = el("thead"); th.append(hr); t.append(cap, th);
      const tb = el("tbody");
      D.table.forEach((q) => {
        const r = el("tr");
        r.append(el("td", null, q.name), el("td", "num", String(q.polls)), el("td", "num", fmt1(q.mae)),
          el("td", null, q.worst ? `${q.worst.r.label}, ${fmtSigned(q.worst.d)}` : "–"));
        tb.append(r);
      });
      t.append(tb); tw.replaceChildren(t); tw.hidden = false;
    } else { tw.replaceChildren(); tw.hidden = true; }
    // the term that led to this election, as in the country graphs
    const tb = $("#pe-term-box");
    tb.hidden = !state.pe.term;
    if (state.pe.term) {
      const sg = h.segments.find((x) => Math.abs(x.endD - e.d) <= 10 * DAY);
      const host = $("#pe-term-chart");
      $("#pe-term-title").textContent = `The polls through the term, ${sg ? fmtMonYear(sg.startD) : ""} to ${fmtMonYear(e.d)}`;
      $("#pe-term-sub").textContent = `The shaded band at the end is the ${span} used above. Lines and polls as in the country graphs, from every pollster.`;
      const x = sg ? fromSegment(c, h, sg, sg.endD) : null;
      if (!x) host.replaceChildren(el("p", "note", "The polls in this term are too far apart for a trend line (see About and method)."));
      else {
        x.completed = true; x.asOf = null;
        const keys = visibleKeys(x, { all: true });
        const w = Math.max(320, Math.min(1180, host.clientWidth || 900));
        drawCycleChart(host, x, { width: w, height: Math.round(w * (w < 600 ? 0.62 : 0.4)), compact: false, keys, yMax: niceMax(maxValue(x, keys, true)), polls: true, window: [D.from, e.d] });
      }
    }
    const src = h.raw.segments.find((x) => Math.abs(x.endD - e.d) <= 10 * DAY);
    const ps = $("#pe-sources"); ps.replaceChildren();
    if (src) {
      const a = el("a", null, src.page); a.href = src.revid ? `https://en.wikipedia.org/w/index.php?title=${encodeURIComponent(src.page.replace(/ /g, "_"))}&oldid=${src.revid}` : src.url;
      a.target = "_blank"; a.rel = "noopener";
      ps.append(document.createTextNode("Polls and results: English Wikipedia, "), a, document.createTextNode(" (CC BY-SA 4.0)."));
    }
  }
  function initErrorControls() {
    const cs = $("#pe-country");
    const hist = (state.data.history || []).map((code) => ({ code, name: (state.countries.find((x) => x.code === code) || { name: code }).name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    hist.forEach(({ code, name }) => { const o = el("option", null, name); o.value = code; cs.append(o); });
    if (!hist.some((x) => x.code === state.pe.code) && hist.length) state.pe.code = hist[0].code;
    cs.value = state.pe.code;
    cs.addEventListener("change", () => { state.pe.code = cs.value; state.pe.date = null; state.pe.off = new Set(); renderErrors(); });
    $("#pe-election").addEventListener("change", (ev) => { state.pe.date = ev.target.value; renderErrors(); });
    const di = $("#pe-days"); di.value = state.pe.days;
    di.addEventListener("input", () => {
      const v = Math.round(+di.value);
      if (!(v >= 1 && v <= 365)) return;
      state.pe.days = v; store.set("peDays14", v);
      clearTimeout(peTimer); peTimer = setTimeout(renderErrors, 200);
    });
    di.addEventListener("change", () => { const v = clamp(Math.round(+di.value) || 14, 1, 365); di.value = v; if (v !== state.pe.days) { state.pe.days = v; store.set("peDays14", v); renderErrors(); } });
    $("#pe-ci").addEventListener("change", (ev) => { state.pe.ci = ev.target.checked; renderErrors(); });
    $("#pe-term").addEventListener("change", (ev) => { state.pe.term = ev.target.checked; renderErrors(); });
    $("#pe-all").addEventListener("click", () => { state.pe.off = new Set(); renderErrors(); });
    $("#pe-none").addEventListener("click", () => { state.pe.off = new Set(errorsKeysNow()); renderErrors(); });
  }
  /** The pollster keys listed in the picker now (to clear them all). */
  let errorsKeysNow = () => [];

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
    $("#time-end").textContent = $("#cn-time-end").textContent = fmtMonYear(state.today);
    $("#generated").textContent = `Data built ${data.generated.replace("T", " ").slice(0, 16)} UTC from the Wikipedia pages of ${state.countries.length} countries.`;
    const np = d3.sum(state.countries, (c) => c.n_polls), hp = data.history_polls;
    rich($("#s-polls"), [["b", `${d3.format(",")(np)} polls`], " read from Wikipedia for the current terms",
      ...(hp ? [", and ", ["b", d3.format(",")(hp)], " in the historical data back to the 1990s"] : []), "."]);
    renderSummary();
    initControls();
    initMapControls();
    initScatterControls();
    initErrorControls();
    // long-run country list
    const sel = $("#lr-country");
    const hist = (data.history || ["PL"]).map((code) => ({ code, name: (state.countries.find((x) => x.code === code) || { name: code }).name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    hist.forEach(({ code, name }) => { const o = el("option", null, name); o.value = code; sel.append(o); });
    state.lr.code = hist.length ? hist[0].code : state.lr.code;   // alphabetically first (Austria)
    sel.value = state.lr.code;
    sel.addEventListener("change", () => { state.lr.code = sel.value; state.lr.domain = null; state.lr.hidden = new Set(); renderLongRun(); });
    showView(viewFromHash(), false);
    // the address "#map" names the view, not the map's box: stay at the top of the page
    if ((location.hash || "") !== "#about") requestAnimationFrame(() => window.scrollTo(0, 0));
    toAbout();
    // re-render when the theme flips (party colours have light/dark variants)
    const rerender = () => {
      renderSummary();
      applyPalette(); applyHue();
      if (state.view === "map") renderMap();
      if (state.view === "correlates") renderScatter();
      if (state.view === "graphs") renderGrid();
      if (state.view === "timelines") { $("#lr-ranges").dataset.code = ""; renderLongRun(); }
      if (state.view === "errors") renderErrors();
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
        if (state.view === "graphs") howtoGraphs();
        if (state.view === "errors") renderErrors();
      }, 200);
    });
  }
  boot();
})();
