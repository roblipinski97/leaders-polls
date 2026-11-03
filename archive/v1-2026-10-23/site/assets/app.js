/* Leading and laden leaders — dashboard script.
 * Reads data/europe.json (built by `python -m polls build`) and data/history/<CC>.json.
 * Plain browser JavaScript + D3 v7; no build step needed.
 */
(() => {
  "use strict";

  // ------------------------------------------------------------------------------- helpers
  const DAY = 864e5;
  const $ = (s, el = document) => el.querySelector(s);
  const parseISO = (s) => { const [y, m, d] = s.slice(0, 10).split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };
  const addDays = (date, n) => new Date(date.getTime() + n * DAY);
  const fmtDate = d3.utcFormat("%-d %b %Y");
  const fmtMonYear = d3.utcFormat("%b %Y");
  const fmt1 = (v) => (v == null || Number.isNaN(v) ? "–" : v.toFixed(1));
  const fmtSigned = (v) => (v == null ? "–" : (v > 0.05 ? "+" : v < -0.05 ? "−" : "±") + Math.abs(v).toFixed(1));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };
  const store = {
    get(k, d) { try { const v = localStorage.getItem("polls:" + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("polls:" + k, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
  };
  let uid = 0;

  const state = {
    data: null, countries: [], today: new Date(),
    region: store.get("region", "All"), sort: store.get("sort", "gap"),
    shared: store.get("shared", false), minor: store.get("minor", false), polls: store.get("polls", false),
    table: false, selected: new Set(store.get("selected", [])),
    lr: { code: "PL", polls: true, govt: true, hidden: new Set(), domain: null, data: {} },
  };

  function isDark() {
    const t = document.documentElement.dataset.theme;
    if (t === "dark") return true;
    if (t === "light") return false;
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  }
  const pcolor = (p) => (p ? (isDark() ? p.color_dark : p.color) : null) || "#8a8f99";

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
    const svg = d3.create("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("role", "img")
      .attr("aria-label", o.aria || c.name);

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
      .attr("font-family", "var(--font-data)").attr("font-size", 10).attr("fill", "var(--muted)")
      .text((d, i) => (i === yt.length - 1 ? d + "%" : d));
    // x axis: years, plus the election date at the right edge
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
    const pts = c.dates.map((d, i) => ({ d, a: c.incVal[i], b: c.rivalVal[i] }));
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
      // the "lead tape": a strip along the baseline, green when ahead, red when behind
      const tape = svg.append("g");
      const state_ = (i) => (!def(pts[i]) ? (c.incKeyAt[i] ? null : "tape-none") : pts[i].a >= pts[i].b ? "tape-lead" : "tape-trail");
      let runStart = 0;
      for (let i = 1; i <= pts.length; i++) {
        if (i < pts.length && state_(i) === state_(runStart)) continue;
        const cls = state_(runStart);
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
    if (o.polls) {
      const pg = svg.append("g").attr("opacity", o.compact ? 0.32 : 0.42);
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
    const curRival = c.rival ? c.rival.key : null;
    const lines = svg.append("g").attr("fill", "none").attr("stroke-linecap", "round").attr("stroke-linejoin", "round");
    const incKeys = new Set(c.periods.map((p) => p.key).filter(Boolean));
    for (const k of keys) {
      const p = c.byKey.get(k);
      const minor = p.minor;
      lines.append("path").attr("d", line(series(k))).attr("stroke", pcolor(p))
        .attr("stroke-width", k === curRival ? 2 : minor ? 1.1 : 1.6)
        .attr("opacity", o.focus && o.focus !== k ? 0.15 : k === curRival ? 0.85 : minor ? 0.35 : 0.5)
        .attr("data-key", k);
    }
    // governing party: thick and opaque, only over the dates it governed
    for (const per of c.periods) {
      if (!per.key) continue;
      const p = c.byKey.get(per.key);
      if (!p) continue;
      const seg = c.dates.map((d, i) => ({ d, v: d >= per.fromD && (!per.toD || d <= per.toD) ? (c.trend.series[per.key] || [])[i] : null }));
      lines.append("path").attr("d", line(seg)).attr("stroke", pcolor(p)).attr("stroke-width", o.compact ? 3.4 : 4)
        .attr("opacity", 1);
    }

    // election result of today's incumbent, as a dot on the start line
    if (c.inc && c.inc.result != null) {
      svg.append("circle").attr("class", "result-dot").attr("cx", x(c.start)).attr("cy", y(c.inc.result))
        .attr("r", 4).attr("fill", pcolor(c.inc));
    }
    if (c.completed && c.inc && c.inc.result_end != null) {
      svg.append("circle").attr("class", "result-dot").attr("cx", x(c.end)).attr("cy", y(c.inc.result_end))
        .attr("r", 4.5).attr("fill", pcolor(c.inc));
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
    const placed = labels.filter((l) => l.i >= 0).sort((a, b) => a.y - b.y);
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
      const p = c.byKey.get(l.k);
      const right = l.x + 4 + 48 < W;
      svg.append("text").attr("class", "end-label label-halo" + (l.strong ? " strong" : ""))
        .attr("x", right ? l.x + 5 : l.x - 5).attr("y", l.y + 3.5).attr("text-anchor", right ? "start" : "end")
        .text(`${shortLabel(p.label)} ${fmt1(l.v)}`);
    }

    // interaction: crosshair + tooltip with every visible party at that date
    const cross = svg.append("line").attr("class", "crosshair").attr("y1", plotTop).attr("y2", plotBot).attr("visibility", "hidden");
    const overlay = svg.append("rect").attr("x", m.l).attr("y", plotTop).attr("width", Math.max(0, x(c.end) - m.l))
      .attr("height", plotBot - plotTop).attr("fill", "transparent").style("cursor", "crosshair");
    const bis = d3.bisector((d) => d).center;
    const moveTo = (i, evt) => {
      i = clamp(i, 0, c.dates.length - 1);
      cross.attr("x1", x(c.dates[i])).attr("x2", x(c.dates[i])).attr("visibility", "visible");
      showTip(evt, (t) => buildCycleTip(t, c, i, keys));
    };
    overlay.on("pointermove", (evt) => {
      const [px] = d3.pointer(evt);
      moveTo(bis(c.dates, x.invert(px)), evt);
    }).on("pointerleave", () => { cross.attr("visibility", "hidden"); hideTip(); });
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

  const shortLabel = (s) => (s.length > 16 ? s.split(/[\s–-]+/).map((w) => w[0]).join("").toUpperCase() : s);

  function buildCycleTip(t, c, i, keys) {
    t.append(el("div", "tt-head", fmtDate(c.dates[i])));
    const per = [...c.periods].reverse().find((p) => p.fromD <= c.dates[i]);
    if (per && per.leader) t.append(el("div", "tt-sub", `${per.title || "PM"}: ${per.leader}`));
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
      gap.textContent = d >= 0 ? `${ip.label} ahead of ${rp.label} by ${fmt1(d)} pts` : `${ip.label} behind ${rp.label} by ${fmt1(-d)} pts`;
      gap.style.color = d >= 0 ? "var(--lead)" : "var(--trail)";
      t.append(gap);
    }
  }

  // ------------------------------------------------------------------------------- panels
  function statusPill(c) {
    const s = el("span", "pill " + c.status);
    if (c.status === "none") { s.textContent = c.incumbent && c.incumbent.caretaker ? "Caretaker government" : "No governing party"; return s; }
    const r = c.rival ? c.rival.label : "rival";
    s.textContent = c.status === "lead" ? `▲ ${fmt1(c.stats.gap_now)} ahead of ${shortLabel(r)}` : `▼ ${fmt1(-c.stats.gap_now)} behind ${shortLabel(r)}`;
    s.title = c.status === "lead" ? "Trend lead over the strongest other party" : "Trend deficit to the leading party";
    return s;
  }

  function nextElectionText(c, long) {
    if (c.completed) return `Election held ${fmtDate(c.end)}`;
    const st = c.next_status === "deadline" ? "by " : c.next_status === "expected" ? "expected " : "on ";
    return `${long ? "Next election" : "Election"} ${st}${fmtDate(c.end)}`;
  }

  function panel(c, yMax) {
    const a = el("article", "panel"); a.id = "p-" + c.code;
    const head = el("div", "panel-head");
    head.append(el("h3", null, c.name), statusPill(c));
    const who = el("div", "who");
    if (c.inc) { const k = el("i", "key"); k.style.background = pcolor(c.inc); who.append(k); }
    const inc = c.incumbent || {};
    const leader = (inc.leader || "").replace(/\s*\(.*\)\s*$/, "");
    const nm = el("span", "name", leader ? `${leader}${c.inc ? " · " + c.inc.label : ""}` : "—");
    if (inc.leader) nm.title = `${inc.title || "Head of government"}: ${inc.leader}${c.inc ? " — " + (c.inc.article || c.inc.label) : ""}`;
    who.append(nm);
    head.append(who);
    a.append(head);

    if (c.stats) {
      const figs = el("dl", "figs");
      const f = (label, value, cls) => { const d = el("div"); d.append(el("dt", null, label), el("dd", cls, value)); figs.append(d); };
      f(c.completed ? "Final trend" : "Polling now", fmt1(c.stats.now) + "%");
      const ch = c.stats.change;
      f(c.completed ? "Change over term" : "Since the election", fmtSigned(ch) + " pts", ch > 0.05 ? "up" : ch < -0.05 ? "down" : "");
      if (c.stats.share_time_leading != null) f("Time in the lead", Math.round(c.stats.share_time_leading * 100) + "%");
      a.append(figs);
    }

    const chart = el("div", "chart");
    a.append(chart);
    const keys = visibleKeys(c);
    const aria = c.stats
      ? `${c.name}: ${c.inc.label} at ${fmt1(c.stats.now)} percent, ${c.status === "lead" ? "ahead of" : "behind"} ${c.rival ? c.rival.label : "the rival"} by ${fmt1(Math.abs(c.stats.gap_now))} points.`
      : c.name;
    drawCycleChart(chart, c, { width: 360, height: 196, compact: true, keys, yMax: yMax || niceMax(maxValue(c, keys, state.polls)), polls: state.polls, aria });

    const leg = el("div", "plegend");
    const shown = keys.map((k) => ({ p: c.byKey.get(k), v: lastVal(c, k) })).filter((r) => r.v != null)
      .sort((x1, x2) => x2.v - x1.v);
    shown.slice(0, 6).forEach(({ p, v }) => {
      const s = el("span"); const i = el("i"); i.style.background = pcolor(p);
      s.append(i, document.createTextNode(shortLabel(p.label) + " "), el("b", null, fmt1(v)));
      leg.append(s);
    });
    if (shown.length > 6) leg.append(el("span", null, `+${shown.length - 6} more`));
    a.append(leg);

    if (!c.completed && state.today - c.lastData > 75 * DAY) {
      a.append(el("p", "note stale", `Wikipedia lists no polls after ${fmtDate(c.lastData)}.`));
    }
    if (c.note) a.append(el("p", "note", c.note));

    const foot = el("div", "panel-foot");
    const left = el("span", null, nextElectionText(c));
    const bar = el("span", "termbar"); bar.title = `${Math.round(c.termFrac * 100)}% of the term elapsed`;
    const fill = el("i"); fill.style.width = (c.termFrac * 100).toFixed(1) + "%"; bar.append(fill);
    const actions = el("span", "panel-actions");
    const src = el("a", "src", `${c.n_polls} polls ↗`);
    src.href = c.source.revid ? `https://en.wikipedia.org/w/index.php?title=${encodeURIComponent(c.source.page.replace(/ /g, "_"))}&oldid=${c.source.revid}` : c.source.url;
    src.target = "_blank"; src.rel = "noopener"; src.title = "Source: " + c.source.page + " (Wikipedia)";
    const more = el("button", "linkbtn", "Expand"); more.type = "button";
    more.addEventListener("click", () => openDetail(c));
    actions.append(src, more);
    foot.append(left, bar, actions);
    a.append(foot);
    return a;
  }

  // value at the end of the trend (null when a party is no longer polled, e.g. a dissolved list)
  const lastVal = (c, k) => { const s = c.trend.series[k] || []; return s.length ? s[s.length - 1] : null; };

  // ------------------------------------------------------------------------------- incumbents view
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
    }[state.sort];
    return cs.sort(by);
  }

  function renderGrid() {
    const cs = filtered();
    const grid = $("#grid"), tw = $("#table-wrap");
    grid.hidden = state.table; tw.hidden = !state.table;
    let shared = null;
    if (state.shared) shared = niceMax(d3.max(cs, (c) => maxValue(c, visibleKeys(c), state.polls)) || 40);
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
      td(c.name);
      td((c.incumbent && c.incumbent.leader) || "—");
      const pt = td("");
      if (c.inc) { const k = el("i", "key"); k.style.background = pcolor(c.inc); pt.append(k, document.createTextNode(c.inc.label)); }
      td(fmt1(s.now), "num");
      td(fmt1(s.result), "num");
      td(fmtSigned(s.change), "num " + (s.change > 0.05 ? "up" : s.change < -0.05 ? "down" : ""));
      td(c.rival ? c.rival.label : "—");
      td(fmtSigned(s.gap_now), "num " + (s.gap_now >= 0 ? "up" : "down"));
      td(s.share_time_leading != null ? Math.round(s.share_time_leading * 100) + "%" : "–", "num");
      td(String(c.n_polls), "num");
      td(c.completed ? `held ${fmtDate(c.end)}` : fmtDate(c.end));
      body.append(r);
    }
    t.append(body);
    $("#table-wrap").replaceChildren(t);
  }

  function renderSummary() {
    const withInc = state.countries.filter((c) => c.stats && c.inc);
    const trailing = withInc.filter((c) => c.stats.gap_now < 0);
    $("#hero-trailing").textContent = trailing.length;
    $("#hero-total").textContent = withInc.length;
    const changes = withInc.map((c) => c.stats.change).filter((v) => v != null);
    $("#tile-median").textContent = fmtSigned(d3.median(changes)) + " pts";
    $("#tile-gained").textContent = `${changes.filter((v) => v > 0).length} of ${changes.length}`;
    $("#tile-polls").textContent = d3.format(",")(d3.sum(state.countries, (c) => c.n_polls));
    const byGap = [...withInc].sort((a, b) => a.stats.gap_now - b.stats.gap_now);
    const list = (id, arr) => {
      const ul = $(id); ul.replaceChildren();
      arr.forEach((c) => {
        const li = el("li"); const k = el("i"); k.style.background = pcolor(c.inc);
        const b = el("button", "linkbtn", c.name); b.type = "button"; b.addEventListener("click", () => openDetail(c));
        li.append(k, b, el("span", null, ` ${c.inc.label} `), el("b", c.stats.gap_now >= 0 ? "up" : "down", fmtSigned(c.stats.gap_now)));
        ul.append(li);
      });
    };
    list("#most-behind", byGap.slice(0, 4));
    list("#most-ahead", byGap.slice(-4).reverse());
    renderQuadrant(withInc);
  }

  function renderQuadrant(cs) {
    const host = $("#quadrant");
    const W = 640, H = 340, m = { t: 24, r: 18, b: 34, l: 44 };
    const xs = cs.map((c) => c.stats.change), ys = cs.map((c) => c.stats.gap_now);
    const xr = Math.max(8, Math.ceil(d3.max(xs.map(Math.abs)) / 5) * 5);
    const yr = Math.max(10, Math.ceil(d3.max(ys.map(Math.abs)) / 10) * 10);
    const x = d3.scaleLinear([-xr, xr], [m.l, W - m.r]);
    const y = d3.scaleLinear([-yr, yr], [H - m.b, m.t]);
    const svg = d3.create("svg").attr("viewBox", `0 0 ${W} ${H}`).attr("role", "img")
      .attr("aria-label", "Scatter of governing parties: change since the election against lead or deficit to the strongest rival.")
      .style("width", "100%").style("height", "auto").style("display", "block");
    svg.append("rect").attr("class", "lead-area").attr("x", m.l).attr("y", m.t).attr("width", W - m.l - m.r).attr("height", y(0) - m.t);
    svg.append("rect").attr("class", "trail-area").attr("x", m.l).attr("y", y(0)).attr("width", W - m.l - m.r).attr("height", H - m.b - y(0));
    const gx = x.ticks(8), gy = y.ticks(6);
    svg.append("g").selectAll("line").data(gx).join("line").attr("class", "gridline")
      .attr("x1", (d) => x(d)).attr("x2", (d) => x(d)).attr("y1", m.t).attr("y2", H - m.b);
    svg.append("g").selectAll("line").data(gy).join("line").attr("class", "gridline")
      .attr("y1", (d) => y(d)).attr("y2", (d) => y(d)).attr("x1", m.l).attr("x2", W - m.r);
    svg.append("line").attr("x1", x(0)).attr("x2", x(0)).attr("y1", m.t).attr("y2", H - m.b).attr("stroke", "var(--axis)");
    svg.append("line").attr("y1", y(0)).attr("y2", y(0)).attr("x1", m.l).attr("x2", W - m.r).attr("stroke", "var(--axis)");
    const ax = svg.append("g").attr("class", "axis");
    ax.selectAll("text.x").data(gx).join("text").attr("class", "x").attr("x", (d) => x(d)).attr("y", H - m.b + 13)
      .attr("text-anchor", "middle").text((d) => (d > 0 ? "+" : "") + d);
    ax.selectAll("text.y").data(gy).join("text").attr("class", "y").attr("x", m.l - 6).attr("y", (d) => y(d) + 3.5)
      .attr("text-anchor", "end").text((d) => (d > 0 ? "+" : "") + d);
    ax.append("text").attr("x", W - m.r).attr("y", H - 4).attr("text-anchor", "end").text("change since the election (pts) →");
    ax.append("text").attr("x", m.l - 30).attr("y", m.t - 10).attr("text-anchor", "start").text("↑ lead over the strongest rival (pts)");
    const corner = (tx, ty, anchor, label) => svg.append("text").attr("x", tx).attr("y", ty).attr("text-anchor", anchor)
      .attr("font-size", 10.5).attr("fill", "var(--muted)").attr("font-family", "var(--font-body)").text(label);
    corner(W - m.r - 6, m.t + 14, "end", "gaining and ahead");
    corner(m.l + 6, m.t + 14, "start", "losing but ahead");
    corner(m.l + 6, H - m.b - 8, "start", "losing and behind");
    corner(W - m.r - 6, H - m.b - 8, "end", "gaining but behind");
    const pts = cs.map((c) => ({ c, px: x(c.stats.change), py: y(c.stats.gap_now) }));
    // label placement: greedy, trying 8 positions around each dot, avoiding dots and earlier labels
    const boxes = pts.map((p) => ({ x0: p.px - 6, x1: p.px + 6, y0: p.py - 6, y1: p.py + 6 }));
    const hit = (b) => boxes.some((o) => b.x0 < o.x1 && b.x1 > o.x0 && b.y0 < o.y1 && b.y1 > o.y0);
    const cand = [[8, 3.5, "start"], [-8, 3.5, "end"], [0, -9, "middle"], [0, 15, "middle"], [7, -6, "start"], [-7, -6, "end"], [7, 12, "start"], [-7, 12, "end"]];
    [...pts].sort((a, b) => a.px - b.px).forEach((p) => {
      const w = 15;
      for (const [dx, dy, anc] of cand) {
        const lx = p.px + dx, ly = p.py + dy;
        const x0 = anc === "start" ? lx : anc === "end" ? lx - w : lx - w / 2;
        const b = { x0, x1: x0 + w, y0: ly - 8, y1: ly + 1 };
        if (!hit(b) && b.x0 > m.l && b.x1 < W - m.r) { p.lx = lx; p.ly = ly; p.anc = anc; boxes.push(b); return; }
      }
      p.lx = p.px + 8; p.ly = p.py + 3.5; p.anc = "start";
    });
    const g = svg.append("g");
    const dots = g.selectAll("g").data(pts).join("g").style("cursor", "pointer").attr("tabindex", 0)
      .attr("role", "button").attr("aria-label", (p) => `${p.c.name}: ${p.c.inc.label}, change ${fmtSigned(p.c.stats.change)}, gap ${fmtSigned(p.c.stats.gap_now)}`);
    dots.append("circle").attr("cx", (p) => p.px).attr("cy", (p) => p.py).attr("r", 12).attr("fill", "transparent");
    dots.append("circle").attr("class", "result-dot").attr("cx", (p) => p.px).attr("cy", (p) => p.py).attr("r", 5.5)
      .attr("fill", (p) => pcolor(p.c.inc));
    dots.append("text").attr("class", "label-halo").attr("x", (p) => p.lx).attr("y", (p) => p.ly).attr("text-anchor", (p) => p.anc)
      .attr("font-family", "var(--font-data)").attr("font-size", 10).attr("fill", "var(--ink)").text((p) => p.c.code);
    dots.on("pointermove", (evt, p) => showTip(evt, (t) => quadTip(t, p.c)))
      .on("pointerleave", hideTip)
      .on("focus", function (evt, p) { const r = this.getBoundingClientRect(); showTip({ clientX: r.right, clientY: r.top }, (t) => quadTip(t, p.c)); })
      .on("blur", hideTip)
      .on("click", (evt, p) => openDetail(p.c))
      .on("keydown", (evt, p) => { if (evt.key === "Enter" || evt.key === " ") { evt.preventDefault(); openDetail(p.c); } });
    host.replaceChildren(svg.node());
  }

  function quadTip(t, c) {
    t.append(el("div", "tt-head", c.name));
    t.append(el("div", "tt-sub", `${c.incumbent.leader} · ${c.inc.label}`));
    tipRow(t, pcolor(c.inc), "Now", fmt1(c.stats.now) + "%", true);
    tipRow(t, "transparent", c.completed ? "Change over term" : "Since election", fmtSigned(c.stats.change));
    if (c.rival) tipRow(t, pcolor(c.rival), c.stats.gap_now >= 0 ? `Lead over ${c.rival.label}` : `Behind ${c.rival.label}`, fmt1(Math.abs(c.stats.gap_now)));
  }

  // ------------------------------------------------------------------------------- detail dialog
  function openDetail(c) {
    const dlg = $("#detail");
    $("#detail-kicker").textContent = `${c.region} · ${nextElectionText(c, true)}`;
    $("#detail-title").textContent = c.name;
    const body = $("#detail-body");
    body.replaceChildren();
    const hidden = new Set(c.parties.filter((p) => p.minor).map((p) => p.key));
    const intro = el("p", "note");
    const inc = c.incumbent || {};
    intro.textContent = (inc.leader ? `${inc.title || "Head of government"}: ${inc.leader}${c.inc ? " (" + c.inc.label + ")" : ""}. ` : "")
      + `${c.n_polls} polls from ${fmtDate(c.start)} to ${fmtDate(c.lastData)}. ` + (c.note || "");
    const chart = el("div", "chart");
    const legend = el("div", "detail-legend");
    const table = el("div", "table-wrap");
    body.append(intro, legend, chart, table);
    const draw = () => {
      const keys = visibleKeys(c, { hidden, all: true });
      const w = Math.max(360, Math.min(1060, (dlg.clientWidth || 1000) - 40));
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
      name.append(k, document.createTextNode(p.label + (p.article && p.article !== p.label ? ` — ${p.article}` : "")));
      r.append(name, el("td", "num", fmt1(p.result)), el("td", "num", fmt1(now)));
      const ch = now != null && p.result != null ? now - p.result : null;
      r.append(el("td", "num " + (ch > 0.05 ? "up" : ch < -0.05 ? "down" : ""), fmtSigned(ch)), el("td", "num", String(p.n)));
      tb.append(r);
    });
    t.append(tb); table.replaceChildren(t);
    const src = el("p", "note");
    const a = el("a", null, "Wikipedia: " + c.source.page);
    a.href = c.source.url; a.target = "_blank"; a.rel = "noopener";
    src.append(document.createTextNode("Source: "), a, document.createTextNode(c.source.revid ? ` (revision ${c.source.revid}, CC BY-SA 4.0)` : ""));
    body.append(src);
    if (typeof dlg.showModal === "function") dlg.showModal(); else dlg.setAttribute("open", "");
    draw();
  }
  $("#detail-close").addEventListener("click", () => { $("#detail").close(); hideTip(); });
  $("#detail").addEventListener("click", (e) => { if (e.target === $("#detail")) $("#detail").close(); });

  // ------------------------------------------------------------------------------- controls
  function initControls() {
    const regions = ["All", ...new Set(state.countries.map((c) => c.region).filter(Boolean))];
    const rc = $("#region-chips");
    regions.forEach((r) => {
      const b = el("button", "chip", r); b.type = "button"; b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(state.region === r));
      b.addEventListener("click", () => {
        state.region = r; store.set("region", r);
        rc.querySelectorAll(".chip").forEach((x) => x.setAttribute("aria-checked", String(x.textContent === r)));
        renderGrid();
      });
      rc.append(b);
    });
    const sort = $("#sort"); sort.value = state.sort;
    sort.addEventListener("change", () => { state.sort = sort.value; store.set("sort", state.sort); renderGrid(); });
    const bind = (id, k) => {
      const i = $(id); i.checked = state[k];
      i.addEventListener("change", () => { state[k] = i.checked; store.set(k, i.checked); renderGrid(); });
    };
    bind("#opt-shared", "shared"); bind("#opt-minor", "minor"); bind("#opt-polls", "polls");
    const setTable = (v) => {
      state.table = v;
      $("#show-charts").setAttribute("aria-pressed", String(!v)); $("#show-table").setAttribute("aria-pressed", String(v));
      renderGrid();
    };
    $("#show-charts").addEventListener("click", () => setTable(false));
    $("#show-table").addEventListener("click", () => setTable(true));
    // countries
    const cc = $("#country-chips");
    const sorted = [...state.countries].sort((a, b) => a.name.localeCompare(b.name));
    const updateCount = () => {
      $("#country-count").textContent = state.selected.size ? `(${state.selected.size} of ${state.countries.length} selected)` : `(all ${state.countries.length})`;
    };
    sorted.forEach((c) => {
      const b = el("button", "chip", c.name); b.type = "button";
      b.setAttribute("aria-pressed", String(state.selected.has(c.code)));
      b.addEventListener("click", () => {
        if (state.selected.has(c.code)) state.selected.delete(c.code); else state.selected.add(c.code);
        b.setAttribute("aria-pressed", String(state.selected.has(c.code)));
        store.set("selected", [...state.selected]); updateCount(); renderGrid();
      });
      cc.append(b);
    });
    $("#pick-all").addEventListener("click", () => {
      state.selected = new Set(state.countries.map((c) => c.code));
      cc.querySelectorAll(".chip").forEach((x) => x.setAttribute("aria-pressed", "true"));
      store.set("selected", [...state.selected]); updateCount(); renderGrid();
    });
    $("#pick-none").addEventListener("click", () => {
      state.selected = new Set();
      cc.querySelectorAll(".chip").forEach((x) => x.setAttribute("aria-pressed", "false"));
      store.set("selected", []); updateCount(); renderGrid();
    });
    updateCount();
  }

  // ------------------------------------------------------------------------------- tabs
  function showView(v, push) {
    ["incumbents", "longrun", "method"].forEach((name) => {
      $("#view-" + name).hidden = name !== v;
      $("#tab-" + name).setAttribute("aria-selected", String(name === v));
    });
    if (push) { try { history.replaceState(null, "", "#" + v); } catch (e) { /* sandboxed */ } }
    if (v === "longrun") renderLongRun();
  }
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => showView(t.dataset.view, true)));

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
    state.lr.data[code] = h;
    return h;
  }

  async function renderLongRun() {
    const code = state.lr.code;
    let h;
    try { h = await loadHistory(code); } catch (e) {
      $("#lr-chart").replaceChildren(el("p", "note", "Long-run data could not be loaded: " + e.message)); return;
    }
    // period presets: whole span + each term
    const pr = $("#lr-ranges");
    if (!pr.dataset.code || pr.dataset.code !== code) {
      pr.dataset.code = code; pr.replaceChildren();
      const presets = [{ label: "All years", dom: null }, ...h.segments.map((s) => ({ label: `${s.startD.getUTCFullYear()}–${String(s.endD.getUTCFullYear()).slice(-2)}`, dom: [s.startD, s.endD] }))];
      presets.forEach((p, idx) => {
        const b = el("button", "chip", p.label); b.type = "button"; b.setAttribute("aria-pressed", String(idx === 0));
        b.addEventListener("click", () => {
          state.lr.domain = p.dom; pr.querySelectorAll(".chip").forEach((x) => x.setAttribute("aria-pressed", String(x === b)));
          drawLongRun(h);
        });
        pr.append(b);
      });
      const legend = $("#lr-legend"); legend.replaceChildren();
      h.lineages.forEach((L) => {
        const b = el("button"); b.type = "button"; b.setAttribute("aria-pressed", "true");
        const i = el("i"); i.style.background = isDark() ? L.color_dark : L.color;
        b.append(i, document.createTextNode(L.label)); b.title = L.names || L.label;
        b.addEventListener("click", () => {
          if (state.lr.hidden.has(L.id)) state.lr.hidden.delete(L.id); else state.lr.hidden.add(L.id);
          b.setAttribute("aria-pressed", String(!state.lr.hidden.has(L.id)));
          drawLongRun(h);
        });
        b.addEventListener("pointerenter", () => drawLongRun(h, L.id));
        b.addEventListener("pointerleave", () => drawLongRun(h));
        legend.append(b);
      });
      const lin = $("#lr-lineages"); lin.replaceChildren();
      h.lineages.forEach((L) => {
        const d = el("div"); const i = el("i"); i.style.background = isDark() ? L.color_dark : L.color;
        const t = el("span"); t.append(el("b", null, L.label + ": "), document.createTextNode(L.names || ""));
        d.append(i, t); lin.append(d);
      });
    }
    drawLongRun(h);
    drawOverview(h);
  }

  function lcolor(L) { return isDark() ? L.color_dark : L.color; }

  function drawLongRun(h, focus) {
    const host = $("#lr-chart");
    const W = Math.max(340, Math.min(1400, host.clientWidth || 1100));
    const H = Math.round(clamp(W * 0.42, 300, 540));
    const govtH = state.lr.govt ? 18 : 0;
    const m = { t: 18 + govtH + 8, r: 74, b: 26, l: 34 };
    const dom = state.lr.domain || [h.origin, h.end];
    const x = d3.scaleUtc(dom, [m.l, W - m.r]);
    const ids = h.lineages.map((L) => L.id).filter((id) => !state.lr.hidden.has(id));
    let ymax = 0;
    for (const s of h.segments) for (const id of ids) (s.series[id] || []).forEach((v, i) => { if (v != null && s.dates[i] >= dom[0] && s.dates[i] <= dom[1] && v > ymax) ymax = v; });
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
    // government band
    if (state.lr.govt) {
      const gb = plot.append("g");
      h.govts.forEach((g) => {
        const L = h.byId.get(g.lineage);
        const x0 = x(g.fromD), x1 = x(g.toD);
        gb.append("rect").attr("x", x0).attr("y", 14).attr("width", Math.max(0, x1 - x0 - 1)).attr("height", govtH)
          .attr("fill", L ? lcolor(L) : "var(--axis)").attr("opacity", 0.85)
          .on("pointermove", (evt) => showTip(evt, (t) => { t.append(el("div", "tt-head", g.leader || "")); t.append(el("div", "tt-sub", `${fmtDate(g.fromD)} – ${g.to ? fmtDate(g.toD) : "today"}`)); if (L) tipRow(t, lcolor(L), L.label, ""); }))
          .on("pointerleave", hideTip);
        const surname = (g.leader || "").split(" ").slice(-1)[0];
        if (x1 - x0 > surname.length * 6 + 8) gb.append("text").attr("x", x0 + 4).attr("y", 14 + govtH - 5).attr("class", "govt-label")
          .attr("fill", "#fff").text(surname).style("pointer-events", "none");
      });
      svg.append("text").attr("class", "election-label").attr("x", m.l).attr("y", 10).text("Prime minister's camp");
    }
    // election lines
    h.elections.forEach((e) => {
      if (e.d < dom[0] || e.d > dom[1]) return;
      plot.append("line").attr("class", "election-line").attr("x1", x(e.d)).attr("x2", x(e.d)).attr("y1", m.t - 4).attr("y2", H - m.b);
      plot.append("text").attr("class", "election-label label-halo").attr("x", x(e.d) + 3).attr("y", m.t + 6).text(e.d.getUTCFullYear());
    });
    // polls
    if (state.lr.polls) {
      const pg = plot.append("g").attr("opacity", 0.28);
      for (const lid of ids) {
        const L = h.byId.get(lid); const vals = h.polls.v[lid]; if (!vals) continue;
        for (let i = 0; i < vals.length; i++) {
          const d = h.pollDates[i];
          if (vals[i] == null || d < dom[0] || d > dom[1]) continue;
          pg.append("circle").attr("cx", x(d)).attr("cy", y(vals[i])).attr("r", 1.5).attr("fill", lcolor(L));
        }
      }
    }
    const line = d3.line().defined((p) => p.v != null).x((p) => x(p.d)).y((p) => y(p.v)).curve(d3.curveMonotoneX);
    const lg = plot.append("g").attr("fill", "none").attr("stroke-linecap", "round").attr("stroke-linejoin", "round");
    for (const lid of ids) {
      const L = h.byId.get(lid);
      for (const s of h.segments) {
        const arr = s.series[lid]; if (!arr) continue;
        // governing camp thicker while in office
        lg.append("path").attr("d", line(s.dates.map((d, i) => ({ d, v: arr[i] })))).attr("stroke", lcolor(L))
          .attr("stroke-width", 2).attr("opacity", focus && focus !== lid ? 0.12 : 0.9);
        const gov = s.dates.map((d, i) => ({ d, v: h.govts.some((g) => g.lineage === lid && d >= g.fromD && d <= g.toD) ? arr[i] : null }));
        lg.append("path").attr("d", line(gov)).attr("stroke", lcolor(L)).attr("stroke-width", 3.6).attr("opacity", focus && focus !== lid ? 0.12 : 1);
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
      labs.forEach((l) => svg.append("text").attr("class", "end-label label-halo strong").attr("x", l.x + 5).attr("y", l.y + 3.5).text(`${l.L.short || l.L.label} ${fmt1(l.v)}`));
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
          if (g) t.append(el("div", "tt-sub", "PM: " + g.leader));
          ids.map((lid) => ({ L: h.byId.get(lid), v: (p.s.series[lid] || [])[p.i] })).filter((r) => r.v != null).sort((a, b) => b.v - a.v)
            .forEach((r) => tipRow(t, lcolor(r.L), r.L.label, fmt1(r.v), g && g.lineage === r.L.id));
        });
      })
      .on("pointerleave", () => { cross.attr("visibility", "hidden"); hideTip(); });
    host.replaceChildren(svg.node());
  }

  function drawOverview(h) {
    const host = $("#lr-overview");
    const W = Math.max(340, Math.min(1400, host.clientWidth || 1100)), H = 58, m = { t: 4, r: 74, b: 18, l: 34 };
    const x = d3.scaleUtc([h.origin, h.end], [m.l, W - m.r]);
    const y = d3.scaleLinear([0, 60], [H - m.b, m.t]);
    const svg = d3.create("svg").attr("viewBox", `0 0 ${W} ${H}`).style("width", "100%").style("height", "auto").style("display", "block");
    const line = d3.line().defined((p) => p.v != null).x((p) => x(p.d)).y((p) => y(p.v));
    for (const L of h.lineages) for (const s of h.segments) {
      const arr = s.series[L.id]; if (!arr) continue;
      svg.append("path").attr("d", line(s.dates.map((d, i) => ({ d, v: arr[i] })))).attr("fill", "none").attr("stroke", lcolor(L)).attr("stroke-width", 1).attr("opacity", 0.7);
    }
    svg.append("g").attr("class", "axis").attr("transform", `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(W / 90).tickSizeOuter(0));
    const brush = d3.brushX().extent([[m.l, m.t], [W - m.r, H - m.b]]).on("end", (evt) => {
      if (!evt.sourceEvent) return;
      state.lr.domain = evt.selection ? evt.selection.map(x.invert) : null;
      $("#lr-ranges").querySelectorAll(".chip").forEach((b, i) => b.setAttribute("aria-pressed", String(!evt.selection && i === 0)));
      drawLongRun(h);
    });
    svg.append("g").attr("class", "brush").call(brush);
    svg.append("text").attr("class", "election-label").attr("x", W - m.r + 6).attr("y", H - m.b - 4).text("drag to zoom");
    host.replaceChildren(svg.node());
  }

  $("#lr-polls").addEventListener("change", (e) => { state.lr.polls = e.target.checked; renderLongRun(); });
  $("#lr-govt").addEventListener("change", (e) => { state.lr.govt = e.target.checked; renderLongRun(); });

  // ------------------------------------------------------------------------------- boot
  async function boot() {
    let data;
    try {
      const res = await fetch("data/europe.json");
      data = await res.json();
    } catch (e) {
      $("#grid").replaceChildren(el("p", "note", "The data file could not be loaded. Run `python -m polls build` and serve the site folder over HTTP."));
      return;
    }
    state.data = data;
    state.today = data.today ? parseISO(data.today) : new Date();
    state.countries = data.countries.map(prepare);
    $("#asof").textContent = "data as of " + fmtDate(state.today);
    $("#generated").textContent = `Data built ${data.generated.replace("T", " ").slice(0, 16)} UTC from ${state.countries.length} countries' Wikipedia pages.`;
    const hidden = (data.not_shown || []).map((n) => `${n.name} (${n.note})`);
    $("#not-shown").textContent = hidden.length ? "Not shown: " + hidden.join(" · ") : "";
    renderSummary();
    initControls();
    renderGrid();
    // long-run country list
    const sel = $("#lr-country");
    (data.history || ["PL"]).forEach((code) => {
      const c = state.countries.find((x) => x.code === code);
      const o = el("option", null, c ? c.name : code); o.value = code; sel.append(o);
    });
    sel.addEventListener("change", () => { state.lr.code = sel.value; state.lr.domain = null; state.lr.hidden = new Set(); renderLongRun(); });
    const hash = (location.hash || "").replace("#", "");
    showView(["incumbents", "longrun", "method"].includes(hash) ? hash : "incumbents", false);
    // re-render when the theme flips (party colours have light/dark variants)
    const rerender = () => { renderSummary(); renderGrid(); if (!$("#view-longrun").hidden) { $("#lr-ranges").dataset.code = ""; renderLongRun(); } };
    window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", rerender);
    new MutationObserver(rerender).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    let rt;
    window.addEventListener("resize", () => { clearTimeout(rt); rt = setTimeout(() => { renderSummary(); if (!$("#view-longrun").hidden) renderLongRun(); }, 200); });
  }
  boot();
})();
