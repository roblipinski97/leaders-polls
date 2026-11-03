// Build site/data/europe-map.json: a small TopoJSON of Europe for the map view.
//
//   npm install world-atlas@2.0.2 topojson-client@3.1.0 topojson-server@3.0.1 topojson-simplify@3.0.3 d3-geo@3.1.1
//   node tools/make_map.mjs
//
// Source: Natural Earth 1:50m admin-0 countries via the world-atlas package (public domain).
// Countries are clipped to a box around Europe and simplified; each feature carries its ISO code.
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(process.env.NODE_MODULES ? path.join(process.env.NODE_MODULES, "x.js") : import.meta.url);
const topojson = require("topojson-client");
const { topology } = require("topojson-server");
const { presimplify, simplify, quantile } = require("topojson-simplify");
const d3 = require("d3-geo");

const here = path.dirname(fileURLToPath(import.meta.url));
const atlas = JSON.parse(fs.readFileSync(require.resolve("world-atlas/countries-50m.json"), "utf8"));

// ISO 3166-1 numeric -> alpha-2 for Europe and its neighbours
const ISO = {
  "008": "AL", "020": "AD", "040": "AT", "112": "BY", "056": "BE", "070": "BA", "100": "BG", "191": "HR",
  "196": "CY", "203": "CZ", "208": "DK", "233": "EE", "246": "FI", "250": "FR", "276": "DE", "300": "GR",
  "348": "HU", "352": "IS", "372": "IE", "380": "IT", "428": "LV", "438": "LI", "440": "LT", "442": "LU",
  "470": "MT", "498": "MD", "492": "MC", "499": "ME", "528": "NL", "807": "MK", "578": "NO", "616": "PL",
  "620": "PT", "642": "RO", "643": "RU", "674": "SM", "688": "RS", "703": "SK", "705": "SI", "724": "ES",
  "752": "SE", "756": "CH", "804": "UA", "826": "GB", "792": "TR", "268": "GE", "051": "AM", "031": "AZ",
  "504": "MA", "012": "DZ", "788": "TN", "434": "LY", "818": "EG", "760": "SY", "368": "IQ", "364": "IR",
  "398": "KZ", "422": "LB", "376": "IL", "400": "JO", "275": "PS", "682": "SA", "336": "VA", "304": "GL",
};
const BOX = [[-26, 33.5], [46, 71.5]];   // lon/lat clip box

const all = topojson.feature(atlas, atlas.objects.countries).features;
const keep = [];
for (const f of all) {
  const code = ISO[f.id] || (f.properties.name === "Kosovo" ? "XK" : f.properties.name === "N. Cyprus" ? "CY-N" : null);
  if (!code) continue;
  const b = d3.geoBounds(f);
  if (b[1][0] < BOX[0][0] || b[0][0] > BOX[1][0] || b[1][1] < BOX[0][1] || b[0][1] > BOX[1][1]) continue;
  // clip polygons to the box (drops French Guiana, Svalbard, Siberia ...)
  const clipped = clipFeature(f, BOX);
  if (!clipped) continue;
  keep.push({ type: "Feature", id: code, properties: { name: f.properties.name }, geometry: clipped });
}

function clipRing(ring, [[x0, y0], [x1, y1]]) {
  // Sutherland-Hodgman against the four box edges (lon/lat treated as planar, fine at this scale)
  const edges = [
    (p) => p[0] >= x0, (p) => p[0] <= x1, (p) => p[1] >= y0, (p) => p[1] <= y1,
  ];
  const inter = [
    (a, b) => [x0, a[1] + (b[1] - a[1]) * (x0 - a[0]) / (b[0] - a[0])],
    (a, b) => [x1, a[1] + (b[1] - a[1]) * (x1 - a[0]) / (b[0] - a[0])],
    (a, b) => [a[0] + (b[0] - a[0]) * (y0 - a[1]) / (b[1] - a[1]), y0],
    (a, b) => [a[0] + (b[0] - a[0]) * (y1 - a[1]) / (b[1] - a[1]), y1],
  ];
  let out = ring.slice(0, -1);
  for (let e = 0; e < 4; e++) {
    const inp = out; out = [];
    if (!inp.length) break;
    for (let i = 0; i < inp.length; i++) {
      const a = inp[(i + inp.length - 1) % inp.length], b = inp[i];
      const ain = edges[e](a), bin = edges[e](b);
      if (bin) { if (!ain) out.push(inter[e](a, b)); out.push(b); }
      else if (ain) out.push(inter[e](a, b));
    }
  }
  if (out.length < 3) return null;
  out.push(out[0]);
  return out;
}
function clipFeature(f, box) {
  const polys = f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
  const res = [];
  for (const poly of polys) {
    const outer = clipRing(poly[0], box);
    if (!outer) continue;
    const holes = poly.slice(1).map((r) => clipRing(r, box)).filter(Boolean);
    res.push([outer, ...holes]);
  }
  // Jan Mayen (Norway) sits alone in the Norwegian Sea: leave it out
  for (let i = res.length - 1; i >= 0; i--) {
    const xs = res[i][0].map((p) => p[0]), ys = res[i][0].map((p) => p[1]);
    if (f.id === "578" && Math.max(...xs) < 0 && Math.min(...ys) > 70) res.splice(i, 1);
  }
  if (!res.length) return null;
  return res.length === 1 ? { type: "Polygon", coordinates: res[0] } : { type: "MultiPolygon", coordinates: res };
}

let topo = topology({ countries: { type: "FeatureCollection", features: keep } }, 1e5);
topo = presimplify(topo);
topo = simplify(topo, quantile(topo, 0.1));
topo = topojson.quantize(topo, 1e4);   // integer, delta-encoded arcs with a transform
// drop properties we do not need, keep ids
const out = path.join(here, "..", "site", "data", "europe-map.json");
fs.writeFileSync(out, JSON.stringify(topo));
console.log(`wrote ${out}: ${keep.length} countries, ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
