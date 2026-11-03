/* Images and clips for sharing the dashboard, drawn by the dashboard itself in a headless browser.
 *
 *   node tools/make_social.js preview          site/assets/preview.png  1200 x 630, the link preview card
 *   node tools/make_social.js still            social/map-<date>.png    1080 x 1350, today's map
 *   node tools/make_social.js clip             social/clip-leadlag.mp4  the lead/lag map from 2012 to now
 *   node tools/make_social.js clip-ideo        social/clip-radical-right.mp4  poll share of the
 *                                              nationalist and radical right family, 2012 to now
 *   node tools/make_social.js all              all of the above
 *
 * Options:  --credit "you.github.io/europe-polls"   a line at the bottom right of each image
 *           --palette greenred     lead/lag colours (blueorange, the default, bavaria, greenred,
 *                                  tealplum, olivepurple); other than blueorange, files get the palette's name,
 *                                  and the preview goes to social/ instead of site/assets/
 *           --from 2012-01-01   first week of a clip      --step 2   weeks per frame
 *           --fps 20            frames per second         --hold 2.5 seconds on the last frame
 *
 * Needs Node 18 or newer and Playwright (npm install playwright, then npx playwright install
 * chromium). The clips also need ffmpeg on the PATH (https://ffmpeg.org; on Windows:
 * winget install ffmpeg). Run it from the project folder after `python -m polls update`.
 */
"use strict";
const fs = require("fs");
const path = require("path");
const http = require("http");
const { execFileSync } = require("child_process");
const { chromium } = require("playwright");

const ROOT = path.resolve(__dirname, "..");
const SITE = path.join(ROOT, "site");
const OUT = path.join(ROOT, "social");

const args = process.argv.slice(2);
const opt = (name, d) => { const i = args.indexOf("--" + name); return i >= 0 ? args[i + 1] : d; };
const what = args.find((a) => !a.startsWith("--") && !args[args.indexOf(a) - 1]?.startsWith("--")) || "all";
const CREDIT = opt("credit", "");
const PALETTE = opt("palette", "blueorange");
const TAG = PALETTE === "blueorange" ? "" : "-" + PALETTE;   // added to file names for other palettes
const FROM = opt("from", "2012-01-01");
const STEP = +opt("step", 2), FPS = +opt("fps", 20), HOLD = +opt("hold", 2.5);

// ------------------------------------------------------------------ a tiny static server for site/
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml" };
function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const p = path.join(SITE, decodeURIComponent(req.url.split("?")[0].split("#")[0]));
      if (!p.startsWith(SITE) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { "Content-Type": TYPES[path.extname(p)] || "application/octet-stream" });
      fs.createReadStream(p).pipe(res);
    });
    srv.listen(0, "127.0.0.1", () => resolve(srv));
  });
}

// ------------------------------------------------------------------ the poster laid over the page
const POSTER_CSS = `
  #poster { position: fixed; inset: 0; z-index: 1000; background: var(--bg); color: var(--ink);
    font-family: var(--font); display: grid; overflow: hidden; }
  #poster.portrait { padding: 20px 20px 14px; grid-template-rows: auto auto minmax(0, 1fr) auto auto; gap: 6px; }
  #poster.landscape { padding: 22px 0 18px 24px; grid-template-columns: 290px minmax(0, 1fr); gap: 10px; }
  #poster .p-title { font-weight: 800; font-size: 25px; line-height: 1.05; letter-spacing: -0.015em; }
  #poster.landscape .p-title { font-size: 31px; }
  #poster .p-sub { margin-top: 5px; font-size: 12.5px; line-height: 1.35; color: var(--ink-2); }
  #poster.landscape .p-sub { font-size: 14px; margin-top: 8px; }
  #poster .p-date { display: flex; align-items: baseline; gap: 8px; margin-top: 2px; }
  #poster .p-date b { font-size: 21px; font-weight: 700; }
  #poster .p-date span { font-size: 11px; color: var(--muted); }
  #poster .p-map { min-height: 0; display: flex; justify-content: center; align-items: flex-start; }
  #poster .p-map svg { height: 100%; width: auto; max-width: 100% !important; display: block; }
  #poster.landscape .p-map { overflow: hidden; align-items: flex-start; }
  #poster.landscape .p-map svg { height: auto; width: 100%; max-width: none !important; margin-top: -6px; }
  #poster.landscape .p-map g[aria-hidden="true"] { display: none; }
  #poster .p-stat { font-size: 14.5px; line-height: 1.35; margin-top: 16px; color: var(--trail-ink); }
  #poster .p-stat b { font-weight: 700; }
  #poster .map-scale { font-size: 10.5px; white-space: nowrap; }
  #poster.landscape .map-scale { font-size: 11px; }
  #poster.landscape .map-scale .bar { flex: 1 1 60px; }
  #poster .map-scale .bar { flex-basis: 150px; }
  #poster .p-foot { display: flex; justify-content: space-between; gap: 10px; font-size: 9.5px; color: var(--muted); }
  #poster.landscape .p-left { display: flex; flex-direction: column; min-width: 0; }
  #poster.landscape .p-left .p-foot { margin-top: auto; flex-direction: column; gap: 2px; font-size: 10px; }
  #poster.landscape .map-scale { margin-top: 14px; }
`;

async function openPage(browser, { width, height, mode }) {
  const ctx = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2 });
  if (process.env.SOCIAL_ROUTES) await require(path.resolve(process.env.SOCIAL_ROUTES))(ctx);
  // a fixed starting state, whatever this browser profile remembered
  await ctx.addInitScript(([m, pal]) => {
    window.__noFit = true;   // draw the map at the poster's width, not fitted to the window height
    try {
      localStorage.clear();
      const set = (k, v) => localStorage.setItem("polls2:" + k, JSON.stringify(v));
      set("mapMode", m); set("palette", pal); set("hue", "blue"); set("clsBy", "family"); set("clsFams", [70]);
    } catch (e) { /* no storage */ }
  }, [mode, PALETTE]);
  const page = await ctx.newPage();
  page.on("pageerror", (e) => console.error("page error:", e.message));
  await page.goto(`${BASE}/index.html#map`);
  await page.waitForSelector("#map svg");
  await page.addStyleTag({ content: POSTER_CSS });
  return { ctx, page };
}

/** Lay the poster over the page. kind: "portrait" or "landscape". */
async function buildPoster(page, kind, texts) {
  await page.evaluate(({ kind, texts, credit }) => {
    const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
    document.getElementById("poster")?.remove();
    const P = el("div", kind); P.id = "poster";
    const head = el("div", "p-head");
    head.append(el("div", "p-title", texts.title || "Are leaders leading in the polls?"), el("div", "p-sub", texts.sub));
    const foot = el("div", "p-foot");
    foot.append(el("span", null, texts.source), el("span", null, credit));
    if (kind === "portrait") {
      P.append(head, el("div", "p-date"), el("div", "p-map"), el("div", "map-scale"), foot);
    } else {
      const left = el("div", "p-left");
      left.append(head, el("div", "p-stat", texts.stat || ""), el("div", "map-scale"), foot);
      P.append(left, el("div", "p-map"));
    }
    document.body.append(P);
    // keep the hatching key from the latest map, so that every frame of a clip has the same rows
    const hk = document.querySelector("#map-scale .hatch-key");
    window.__hatchKey = hk ? hk.outerHTML : null;
  }, { kind, texts, credit: CREDIT });
}

/** Copy the map, its colour key and a date into the poster. */
async function paint(page, dateText, coverage) {
  await page.evaluate(({ dateText, coverage }) => {
    const P = document.getElementById("poster");
    P.querySelector(".p-map").replaceChildren(document.querySelector("#map svg").cloneNode(true));
    P.querySelector(".map-scale").replaceChildren(...[...document.querySelector("#map-scale").childNodes].map((n) => n.cloneNode(true)));
    if (window.__hatchKey && !P.querySelector(".map-scale .hatch-key")) P.querySelector(".map-scale").insertAdjacentHTML("beforeend", window.__hatchKey);
    const d = P.querySelector(".p-date");
    if (d) { d.innerHTML = ""; const b = document.createElement("b"); b.textContent = dateText; const s = document.createElement("span"); s.textContent = coverage; d.append(b, s); }
  }, { dateText, coverage });
}

/** Move the map's slider to week i of the timeline (null: the latest polls) and wait for the redraw. */
async function goTo(page, i) {
  return page.evaluate(async (i) => {
    const s = document.querySelector("#map-time");
    const before = document.querySelector("#map svg");
    s.value = i == null ? s.max : i;
    s.dispatchEvent(new Event("input", { bubbles: true }));
    for (let k = 0; k < 200 && document.querySelector("#map svg") === before; k++) await new Promise((r) => setTimeout(r, 10));
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return document.querySelector("#map-date").textContent;
  }, i);
}
async function loadTimeline(page) {
  await page.evaluate(async () => {
    const s = document.querySelector("#map-time");
    s.dispatchEvent(new Event("focus"));
    for (let k = 0; k < 500 && +s.max <= 1; k++) await new Promise((r) => setTimeout(r, 20));
  });
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const SOURCE = "Poll trends from Wikipedia's opinion-polling pages. Grey: no polls that week.";
const MODES = {
  gov: { file: "leadlag", sub: "How far the head of government's party leads (+) or trails (−) its strongest rival in the polls, in percentage points" },
  ideo: { file: "radical-right", title: "The radical right in the polls", sub: "Combined poll share of the parties in the Manifesto Project's nationalist and radical right family, in per cent", source: "Polls: Wikipedia's opinion-polling pages. Party families: Manifesto Project (MPDS 2026a). Grey: no polls." },
};

async function preview(browser) {
  const { ctx, page } = await openPage(browser, { width: 600, height: 315, mode: "gov" });
  const stat = await page.evaluate(() => document.querySelector("#s-trailing").innerHTML);
  await buildPoster(page, "landscape", { sub: "Governing parties against their strongest rivals in 31 European countries", stat, source: "Data: Wikipedia's opinion-polling pages, Manifesto Project, World Bank" });
  await paint(page, "", "");
  fs.mkdirSync(OUT, { recursive: true });
  const file = TAG ? path.join(OUT, `preview${TAG}.png`) : path.join(SITE, "assets", "preview.png");
  await page.locator("#poster").screenshot({ path: file });
  await ctx.close();
  console.log("wrote", path.relative(ROOT, file));
}

async function still(browser, mode = "gov") {
  const { ctx, page } = await openPage(browser, { width: 540, height: 675, mode });
  const asof = await page.evaluate(() => document.querySelector("#asof").textContent.replace(/^Data as of /, "").replace(/\.$/, ""));
  const M = MODES[mode];
  await buildPoster(page, "portrait", { title: M.title, sub: M.sub, source: M.source || SOURCE });
  await paint(page, asof, "latest polls");
  fs.mkdirSync(OUT, { recursive: true });
  const file = path.join(OUT, `map-${mode === "gov" ? "leadlag" + TAG : M.file}-${asof.replace(/ /g, "-")}.png`);
  await page.locator("#poster").screenshot({ path: file });
  await ctx.close();
  console.log("wrote", path.relative(ROOT, file));
}

async function clip(browser, mode = "gov") {
  const tl = JSON.parse(fs.readFileSync(path.join(SITE, "data", "timeline.json"), "utf8"));
  const start = Date.parse(tl.start), DAY = 864e5;
  const first = Math.max(0, Math.round((Date.parse(FROM) - start) / (7 * DAY)));
  const { ctx, page } = await openPage(browser, { width: 540, height: 675, mode });
  await loadTimeline(page);
  const M = MODES[mode];
  await buildPoster(page, "portrait", { title: M.title, sub: M.sub, source: M.source || SOURCE });
  const dir = fs.mkdtempSync(path.join(require("os").tmpdir(), "polls-frames-"));
  let n = 0;
  const frame = async () => { await page.locator("#poster").screenshot({ path: path.join(dir, `f${String(++n).padStart(5, "0")}.png`) }); };
  const weeks = [];
  for (let i = first; i < tl.n; i += STEP) weeks.push(i);
  if (weeks[weeks.length - 1] !== tl.n - 1) weeks.push(tl.n - 1);
  for (const i of weeks) {
    const label = await goTo(page, i);
    const d = new Date(start + i * 7 * DAY);
    const cov = (label.match(/\((\d+ of \d+) countries\)/) || [])[1];
    await paint(page, `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`, cov ? `${cov} countries with polls` : "");
    await frame();
    if (n % 50 === 0) process.stdout.write(`  ${n} frames\r`);
  }
  const last = path.join(dir, `f${String(n).padStart(5, "0")}.png`);
  for (let k = 0; k < Math.round(HOLD * FPS); k++) fs.copyFileSync(last, path.join(dir, `f${String(++n).padStart(5, "0")}.png`));
  await ctx.close();
  fs.mkdirSync(OUT, { recursive: true });
  const name = mode === "gov" ? M.file + TAG : M.file;
  const mp4 = path.join(OUT, `clip-${name}.mp4`), gif = path.join(OUT, `clip-${name}.gif`);
  try {
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-framerate", String(FPS), "-i", path.join(dir, "f%05d.png"),
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "20", "-preset", "slow", "-movflags", "+faststart", mp4]);
    execFileSync("ffmpeg", ["-y", "-loglevel", "error", "-i", mp4, "-vf",
      "fps=10,scale=540:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128[p];[b][p]paletteuse=dither=bayer:bayer_scale=4", gif]);
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(`wrote ${path.relative(ROOT, mp4)} and ${path.relative(ROOT, gif)} (${n} frames)`);
  } catch (e) {
    console.log(`ffmpeg failed or is not installed; the ${n} frames are in ${dir}`);
  }
}

let BASE;
(async () => {
  const srv = await serve();
  BASE = `http://127.0.0.1:${srv.address().port}`;
  const browser = await chromium.launch(process.env.SOCIAL_CHROMIUM ? { executablePath: process.env.SOCIAL_CHROMIUM } : {});
  try {
    if (what === "preview" || what === "all") await preview(browser);
    if (what === "still" || what === "all") { await still(browser, "gov"); await still(browser, "ideo"); }
    if (what === "clip" || what === "all") await clip(browser, "gov");
    if (what === "clip-ideo" || what === "all") await clip(browser, "ideo");
  } finally {
    await browser.close();
    srv.close();
  }
})();
