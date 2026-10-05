#!/usr/bin/env node
// Builds the map data used by the game from Natural Earth sources.
//
//   node tools/build-data.mjs <natural-earth-vector dir> <natural-earth-raster dir>
//
// Inputs (public domain, https://www.naturalearthdata.com):
//   <vector>/geojson/ne_10m_admin_0_countries.geojson
//   <vector>/geojson/ne_10m_admin_1_states_provinces.geojson
//   <vector>/geojson/ne_10m_admin_0_boundary_lines_land.geojson
//   <vector>/geojson/ne_10m_admin_1_states_provinces_lines.geojson
//   <vector>/geojson/ne_10m_populated_places.geojson
//   <vector>/geojson/ne_10m_rivers_lake_centerlines.geojson
//   <raster>/10m_rasters/SR_HR/SR_HR.tif   (shaded relief, 21600x10800)
//
// Outputs (classic scripts, so index.html also works when opened from disk):
//   js/data/geo.js     projected vector geometry, provinces, cities
//   js/data/grid.js    simulation grid: province ids, terrain roughness, rivers
//   js/data/relief.js  shaded relief + water textures as JPEG data URIs
//
// Requires ImageMagick (`convert`) for JPEG encoding.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { openTiff } from './tiff.mjs';

const [vecDir, rasDir] = process.argv.slice(2);
if (!vecDir || !rasDir) {
  console.error('usage: node tools/build-data.mjs <natural-earth-vector dir> <natural-earth-raster dir>');
  process.exit(1);
}
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const OUT = path.join(ROOT, 'js', 'data');
fs.mkdirSync(OUT, { recursive: true });
const readGeo = (name) => JSON.parse(fs.readFileSync(path.join(vecDir, 'geojson', name), 'utf8'));

// ---------------------------------------------------------------------------
// Projection: Web Mercator at zoom 7 (32768 px around the world, ~1 km/px over
// Iran). "World px" are measured from the top-left corner of the map region.
const WORLD = 32768;
const REGION = { lon0: 33, lon1: 73, lat0: 16.5, lat1: 46.5 };
const mx = (lon) => ((lon + 180) / 360) * WORLD;
const my = (lat) => ((1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2) * WORLD;
const OX = mx(REGION.lon0), OY = my(REGION.lat1);
const RW = mx(REGION.lon1) - OX, RH = my(REGION.lat0) - OY;
const project = ([lon, lat]) => [mx(lon) - OX, my(lat) - OY];
const unprojectLon = (x) => ((x + OX) / WORLD) * 360 - 180;
const unprojectLat = (y) => {
  const n = Math.PI * (1 - (2 * (y + OY)) / WORLD);
  return (Math.atan(Math.sinh(n)) * 180) / Math.PI;
};

// ---------------------------------------------------------------------------
// Geometry helpers
const polysOf = (geom) =>
  geom.type === 'Polygon' ? [geom.coordinates] : geom.type === 'MultiPolygon' ? geom.coordinates : [];
const linesOf = (geom) =>
  geom.type === 'LineString' ? [geom.coordinates] : geom.type === 'MultiLineString' ? geom.coordinates : [];

function clipRing(ring, x0, y0, x1, y1) {
  // Sutherland-Hodgman against an axis-aligned rectangle.
  const edges = [
    (p) => p[0] >= x0, (p) => p[0] <= x1, (p) => p[1] >= y0, (p) => p[1] <= y1,
  ];
  const inter = [
    (a, b) => [x0, a[1] + ((b[1] - a[1]) * (x0 - a[0])) / (b[0] - a[0])],
    (a, b) => [x1, a[1] + ((b[1] - a[1]) * (x1 - a[0])) / (b[0] - a[0])],
    (a, b) => [a[0] + ((b[0] - a[0]) * (y0 - a[1])) / (b[1] - a[1]), y0],
    (a, b) => [a[0] + ((b[0] - a[0]) * (y1 - a[1])) / (b[1] - a[1]), y1],
  ];
  let pts = ring;
  for (let e = 0; e < 4 && pts.length; e++) {
    const out = [];
    for (let i = 0; i < pts.length; i++) {
      const a = pts[(i + pts.length - 1) % pts.length], b = pts[i];
      const ain = edges[e](a), bin = edges[e](b);
      if (bin) { if (!ain) out.push(inter[e](a, b)); out.push(b); }
      else if (ain) out.push(inter[e](a, b));
    }
    pts = out;
  }
  return pts;
}

function clipLine(line, x0, y0, x1, y1) {
  // Splits a polyline into the pieces that fall inside the rectangle
  // (vertex-level test; adequate for the generous padding we use).
  const inside = (p) => p[0] >= x0 && p[0] <= x1 && p[1] >= y0 && p[1] <= y1;
  const pieces = [];
  let cur = [];
  for (let i = 0; i < line.length; i++) {
    if (inside(line[i])) {
      if (!cur.length && i > 0) cur.push(line[i - 1]);
      cur.push(line[i]);
    } else if (cur.length) {
      cur.push(line[i]);
      pieces.push(cur);
      cur = [];
    }
  }
  if (cur.length > 1) pieces.push(cur);
  return pieces;
}

function simplify(points, tol) {
  if (points.length < 3) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = keep[points.length - 1] = 1;
  const stack = [[0, points.length - 1]];
  const t2 = tol * tol;
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = points[a], [bx, by] = points[b];
    const dx = bx - ax, dy = by - ay, len2 = dx * dx + dy * dy || 1e-12;
    let best = -1, bestD = t2;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = points[i];
      let t = ((px - ax) * dx + (py - ay) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const ex = ax + t * dx - px, ey = ay + t * dy - py;
      const d = ex * ex + ey * ey;
      if (d > bestD) { bestD = d; best = i; }
    }
    if (best >= 0) { keep[best] = 1; stack.push([a, best], [best, b]); }
  }
  return points.filter((_, i) => keep[i]);
}

// Quantize to 1/10 world px and delta-encode: [x0, y0, dx1, dy1, ...]
function encode(points) {
  const out = [];
  let px = 0, py = 0;
  for (let i = 0; i < points.length; i++) {
    const x = Math.round(points[i][0] * 10), y = Math.round(points[i][1] * 10);
    if (i > 0 && x === px && y === py) continue;
    out.push(x - px, y - py);
    px = x; py = y;
  }
  return out;
}

const round1 = (v) => Math.round(v * 10) / 10;
const PAD = 40; // world px of geometry kept outside the visible region

// ---------------------------------------------------------------------------
console.log('Reading Natural Earth vectors…');
const countries = readGeo('ne_10m_admin_0_countries.geojson');
const admin1 = readGeo('ne_10m_admin_1_states_provinces.geojson');
const boundaryLines = readGeo('ne_10m_admin_0_boundary_lines_land.geojson');
const provinceLines = readGeo('ne_10m_admin_1_states_provinces_lines.geojson');
const places = readGeo('ne_10m_populated_places.geojson');
const rivers = readGeo('ne_10m_rivers_lake_centerlines.geojson');

// Land: every country polygon in the region (Iran included). Not simplified,
// so that shared borders between neighbours stay topologically identical.
const land = [];
let landPts = 0;
for (const f of countries.features) {
  for (const poly of polysOf(f.geometry)) {
    for (const ring of poly) {
      const proj = ring.map(project);
      const xs = proj.map((p) => p[0]), ys = proj.map((p) => p[1]);
      if (Math.max(...xs) < -PAD || Math.min(...xs) > RW + PAD || Math.max(...ys) < -PAD || Math.min(...ys) > RH + PAD) continue;
      const clipped = clipRing(proj, -PAD, -PAD, RW + PAD, RH + PAD);
      if (clipped.length < 3) continue;
      land.push(encode(clipped));
      landPts += clipped.length;
    }
  }
}

const iranFeature = countries.features.find((f) => f.properties.ADM0_A3 === 'IRN');
const iranPolys = polysOf(iranFeature.geometry).map((poly) => poly.map((ring) => ring.map(project)));
const iran = [];
for (const poly of iranPolys) for (const ring of poly) iran.push(encode(ring));

let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
for (const poly of iranPolys) for (const ring of poly) for (const [x, y] of ring) {
  bx0 = Math.min(bx0, x); by0 = Math.min(by0, y); bx1 = Math.max(bx1, x); by1 = Math.max(by1, y);
}

const borders = [];
for (const f of boundaryLines.features) {
  for (const line of linesOf(f.geometry)) {
    for (const piece of clipLine(line.map(project), -PAD, -PAD, RW + PAD, RH + PAD)) {
      borders.push(encode(simplify(piece, 0.15)));
    }
  }
}

const provLines = [];
for (const f of provinceLines.features) {
  if (f.properties.ADM0_A3 !== 'IRN') continue;
  for (const line of linesOf(f.geometry)) provLines.push(encode(simplify(line.map(project), 0.15)));
}

// Provinces (for the grid and for labels/events)
const provFeatures = admin1.features.filter((f) => f.properties.adm0_a3 === 'IRN');
const provinces = provFeatures.map((f, i) => {
  const p = f.properties;
  const lp = project([p.longitude, p.latitude]);
  return { id: i + 1, name: p.name_en || p.name, iso: p.iso_3166_2, label: [round1(lp[0]), round1(lp[1])] };
});

// Cities: Natural Earth places in Iran plus a few historically important towns.
const rename = {
  'Bandar-e-Abbas': 'Bandar Abbas', 'Bandar-e Bushehr': 'Bushehr', Sabzewar: 'Sabzevar',
  Khvoy: 'Khoy', Qomsheh: 'Shahreza',
};
const skip = new Set(['Khomeini Shahr', 'Yazdan', 'Varamin', 'Karaj', 'Marv Dasht']);
const cityList = [];
for (const f of places.features) {
  const p = f.properties;
  if (p.ADM0_A3 !== 'IRN' || skip.has(p.NAME)) continue;
  const [lon, lat] = f.geometry.coordinates;
  cityList.push({ name: rename[p.NAME] || p.NAME, lon, lat, pop: p.POP_MAX, rank: p.SCALERANK });
}
const extra = [
  ['Khorramshahr', 48.17, 30.44, 130000, 7], ['Shushtar', 48.85, 32.05, 100000, 8],
  ['Kazerun', 51.65, 29.62, 90000, 8], ['Lar', 54.34, 27.68, 60000, 8],
  ['Bandar Lengeh', 54.88, 26.56, 30000, 8], ['Jask', 57.77, 25.64, 20000, 9],
  ['Tabas', 56.92, 33.6, 40000, 8], ['Nain', 53.09, 32.86, 30000, 9],
  ['Damghan', 54.35, 36.17, 60000, 8], ['Babol', 52.68, 36.54, 200000, 7],
  ['Bandar Anzali', 49.46, 37.47, 110000, 8], ['Maku', 44.52, 39.29, 40000, 9],
  ['Torbat-e Heydarieh', 59.22, 35.27, 130000, 8], ['Iranshahr', 60.68, 27.2, 100000, 8],
  ['Saqqez', 46.27, 36.25, 150000, 8], ['Astara', 48.87, 38.43, 50000, 9],
];
for (const [name, lon, lat, pop, rank] of extra) cityList.push({ name, lon, lat, pop, rank });
const cities = cityList
  .sort((a, b) => b.pop - a.pop)
  .map((c) => {
    const [x, y] = project([c.lon, c.lat]);
    return { name: c.name, x: round1(x), y: round1(y), pop: c.pop, rank: c.rank };
  });

// ---------------------------------------------------------------------------
// Simulation grid: 2 world px (~2 km) per cell over Iran's bounding box plus a
// margin wide enough for the coastal glow.
const CELL = 2;
const MARGIN = 24;
const GX0 = Math.floor(bx0 / CELL) * CELL - MARGIN * CELL;
const GY0 = Math.floor(by0 / CELL) * CELL - MARGIN * CELL;
const GW = Math.ceil((bx1 - GX0) / CELL) + MARGIN;
const GH = Math.ceil((by1 - GY0) / CELL) + MARGIN;
console.log(`Grid ${GW}x${GH} cells`);

// Even-odd scanline fill of a set of rings, sampled at cell centres.
function rasterizeRings(rings, w, h, x0, y0, cell, cb) {
  const edges = [];
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      if (a[1] === b[1]) continue;
      edges.push(a[1] < b[1] ? [a[0], a[1], b[0], b[1]] : [b[0], b[1], a[0], a[1]]);
    }
  }
  let ymin = Infinity, ymax = -Infinity;
  for (const e of edges) { ymin = Math.min(ymin, e[1]); ymax = Math.max(ymax, e[3]); }
  const j0 = Math.max(0, Math.floor((ymin - y0) / cell - 0.5));
  const j1 = Math.min(h - 1, Math.ceil((ymax - y0) / cell - 0.5));
  for (let j = j0; j <= j1; j++) {
    const yc = y0 + (j + 0.5) * cell;
    const xs = [];
    for (const e of edges) {
      if (yc >= e[1] && yc < e[3]) xs.push(e[0] + ((yc - e[1]) * (e[2] - e[0])) / (e[3] - e[1]));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const i0 = Math.max(0, Math.ceil((xs[k] - x0) / cell - 0.5));
      const i1 = Math.min(w - 1, Math.floor((xs[k + 1] - x0) / cell - 0.5));
      for (let i = i0; i <= i1; i++) cb(j * w + i);
    }
  }
}

const prov = new Uint8Array(GW * GH);
provFeatures.forEach((f, idx) => {
  const rings = [];
  for (const poly of polysOf(f.geometry)) for (const ring of poly) rings.push(ring.map(project));
  rasterizeRings(rings, GW, GH, GX0, GY0, CELL, (c) => { prov[c] = idx + 1; });
});
// Cells inside the national outline that no province claimed (coastline
// mismatches between the two layers) take the nearest province.
const iranMask = new Uint8Array(GW * GH);
rasterizeRings(iranPolys.flat(), GW, GH, GX0, GY0, CELL, (c) => { iranMask[c] = 1; });
{
  const queue = [];
  for (let c = 0; c < prov.length; c++) if (prov[c]) queue.push(c);
  for (let qi = 0; qi < queue.length; qi++) {
    const c = queue[qi], x = c % GW, y = (c - x) / GW;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= GW || ny >= GH) continue;
      const n = ny * GW + nx;
      if (!prov[n] && iranMask[n]) { prov[n] = prov[c]; queue.push(n); }
    }
  }
}
let iranCells = 0;
for (let c = 0; c < prov.length; c++) if (prov[c]) iranCells++;
console.log(`Iran cells: ${iranCells}`);

// Rivers: rasterized with a strength that falls with Natural Earth scalerank.
const river = new Uint8Array(GW * GH);
for (const f of rivers.features) {
  const rank = f.properties.scalerank ?? 10;
  if (rank > 9) continue;
  const strength = Math.round(255 * Math.max(0.35, 1 - (rank - 1) / 10));
  for (const line of linesOf(f.geometry)) {
    const pts = line.map(project);
    for (let i = 1; i < pts.length; i++) {
      const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
      const steps = Math.ceil(Math.hypot(bx - ax, by - ay) / (CELL * 0.4)) + 1;
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const gx = Math.floor((ax + (bx - ax) * t - GX0) / CELL);
        const gy = Math.floor((ay + (by - ay) * t - GY0) / CELL);
        if (gx < 0 || gy < 0 || gx >= GW || gy >= GH) continue;
        const c = gy * GW + gx;
        if (prov[c]) river[c] = Math.max(river[c], strength);
      }
    }
  }
}

// ---------------------------------------------------------------------------
console.log('Reading shaded relief…');
const SRC_PPD = 60; // Natural Earth 10m rasters: 60 px per degree
const sr = openTiff(path.join(rasDir, '10m_rasters', 'SR_HR', 'SR_HR.tif'));
const cropX0 = Math.floor((REGION.lon0 + 180) * SRC_PPD) - 4;
const cropY0 = Math.floor((90 - REGION.lat1) * SRC_PPD) - 4;
const cropW = Math.ceil((REGION.lon1 - REGION.lon0) * SRC_PPD) + 8;
const cropH = Math.ceil((REGION.lat1 - REGION.lat0) * SRC_PPD) + 8;
const src = sr.readWindow(cropX0, cropY0, cropW, cropH);
sr.close();
const srcAt = (lon, lat) => {
  // bilinear sample of the equirectangular crop
  const fx = (lon + 180) * SRC_PPD - 0.5 - cropX0, fy = (90 - lat) * SRC_PPD - 0.5 - cropY0;
  const x = Math.max(0, Math.min(cropW - 2, Math.floor(fx))), y = Math.max(0, Math.min(cropH - 2, Math.floor(fy)));
  const tx = Math.max(0, Math.min(1, fx - x)), ty = Math.max(0, Math.min(1, fy - y));
  const i = y * cropW + x;
  const a = src[i] + (src[i + 1] - src[i]) * tx, b = src[i + cropW] + (src[i + cropW + 1] - src[i + cropW]) * tx;
  return a + (b - a) * ty;
};

// Relief texture in Mercator at 60 px per degree of longitude.
const TEX_SCALE = (SRC_PPD * 360) / WORLD; // texture px per world px
const TW = Math.ceil(RW * TEX_SCALE), TH = Math.ceil(RH * TEX_SCALE);
console.log(`Relief texture ${TW}x${TH}`);
const relief = new Float32Array(TW * TH);
const lonOfCol = new Float64Array(TW);
for (let u = 0; u < TW; u++) lonOfCol[u] = unprojectLon((u + 0.5) / TEX_SCALE);
for (let v = 0; v < TH; v++) {
  const lat = unprojectLat((v + 0.5) / TEX_SCALE);
  for (let u = 0; u < TW; u++) relief[v * TW + u] = srcAt(lonOfCol[u], lat);
}

// Gentle local-contrast boost (unsharp mask) to bring out ridges.
function boxBlur(a, w, h, r) {
  const tmp = new Float32Array(a.length), out = new Float32Array(a.length);
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let x = -r; x <= r; x++) s += a[y * w + Math.max(0, Math.min(w - 1, x))];
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = s / (2 * r + 1);
      s += a[y * w + Math.min(w - 1, x + r + 1)] - a[y * w + Math.max(0, x - r)];
    }
  }
  for (let x = 0; x < w; x++) {
    let s = 0;
    for (let y = -r; y <= r; y++) s += tmp[Math.max(0, Math.min(h - 1, y)) * w + x];
    for (let y = 0; y < h; y++) {
      out[y * w + x] = s / (2 * r + 1);
      s += tmp[Math.min(h - 1, y + r + 1) * w + x] - tmp[Math.max(0, y - r) * w + x];
    }
  }
  return out;
}
const blurred = boxBlur(boxBlur(relief, TW, TH, 3), TW, TH, 3);
const reliefBytes = new Uint8Array(TW * TH);
for (let i = 0; i < relief.length; i++) {
  const v = relief[i] + 0.6 * (relief[i] - blurred[i]);
  reliefBytes[i] = Math.max(0, Math.min(255, Math.round(v)));
}

// Water texture: distance from the nearest coast (land polygons rasterized at
// texture resolution), used for shallow-water shading. Half resolution.
const WW = Math.ceil(TW / 2), WH = Math.ceil(TH / 2);
const landMask = new Uint8Array(WW * WH);
{
  const rings = [];
  for (const f of countries.features) {
    for (const poly of polysOf(f.geometry)) for (const ring of poly) {
      const proj = ring.map(project);
      const clipped = clipRing(proj, -PAD, -PAD, RW + PAD, RH + PAD);
      if (clipped.length >= 3) rings.push(clipped);
    }
  }
  // rasterize each country separately (even-odd per polygon), union into mask
  for (const r of rings) rasterizeRings([r], WW, WH, 0, 0, 2 / TEX_SCALE, (c) => { landMask[c] ^= 1; });
}
const dist = new Float32Array(WW * WH);
for (let i = 0; i < dist.length; i++) dist[i] = landMask[i] ? 0 : 1e9;
for (let pass = 0; pass < 2; pass++) {
  const fwd = pass === 0;
  for (let yy = 0; yy < WH; yy++) {
    const y = fwd ? yy : WH - 1 - yy;
    for (let xx = 0; xx < WW; xx++) {
      const x = fwd ? xx : WW - 1 - xx;
      const i = y * WW + x;
      let d = dist[i];
      const s = fwd ? -1 : 1;
      if (x + s >= 0 && x + s < WW) d = Math.min(d, dist[i + s] + 1);
      if (y + s >= 0 && y + s < WH) {
        d = Math.min(d, dist[i + s * WW] + 1);
        if (x + s >= 0 && x + s < WW) d = Math.min(d, dist[i + s * WW + s] + 1.414);
        if (x - s >= 0 && x - s < WW) d = Math.min(d, dist[i + s * WW - s] + 1.414);
      }
      dist[i] = d;
    }
  }
}
const waterBytes = new Uint8Array(WW * WH);
for (let i = 0; i < dist.length; i++) {
  // 255 at the coast, fading to 0 about 60 px (~150 km) offshore
  waterBytes[i] = Math.round(255 * Math.exp(-dist[i] / 22));
}
const waterBlur = boxBlur(boxBlur(Float32Array.from(waterBytes), WW, WH, 2), WW, WH, 2);
for (let i = 0; i < waterBytes.length; i++) waterBytes[i] = Math.round(waterBlur[i]);

// Terrain roughness per grid cell: local standard deviation of the shaded
// relief (flat desert ~0, Zagros ridges high).
const rug = new Uint8Array(GW * GH);
{
  const raw = new Float32Array(GW * GH);
  for (let j = 0; j < GH; j++) {
    for (let i = 0; i < GW; i++) {
      const c = j * GW + i;
      if (!prov[c]) continue;
      const wx = GX0 + (i + 0.5) * CELL, wy = GY0 + (j + 0.5) * CELL;
      const lon = unprojectLon(wx), lat = unprojectLat(wy);
      let s = 0, s2 = 0, n = 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
        const v = srcAt(lon + dx / SRC_PPD, lat + dy / SRC_PPD);
        s += v; s2 += v * v; n++;
      }
      raw[c] = Math.sqrt(Math.max(0, s2 / n - (s / n) ** 2));
    }
  }
  const sm = boxBlur(raw, GW, GH, 1);
  for (let c = 0; c < rug.length; c++) if (prov[c]) rug[c] = Math.min(255, Math.round((sm[c] / 34) * 255));
}

// ---------------------------------------------------------------------------
// Write outputs
function jpegDataUri(bytes, w, h, quality) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'warmap-'));
  const raw = path.join(tmp, 'img.gray'), jpg = path.join(tmp, 'img.jpg');
  fs.writeFileSync(raw, bytes);
  execFileSync('convert', ['-size', `${w}x${h}`, '-depth', '8', `gray:${raw}`, '-quality', String(quality),
    '-sampling-factor', '1x1', '-strip', '-interlace', 'none', jpg]);
  const uri = 'data:image/jpeg;base64,' + fs.readFileSync(jpg).toString('base64');
  fs.rmSync(tmp, { recursive: true, force: true });
  return uri;
}
const gz = (bytes) => zlib.gzipSync(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength), { level: 9 }).toString('base64');

const header = '// Generated by tools/build-data.mjs from Natural Earth (public domain). Do not edit.\n' +
  'window.WARMAP_DATA = window.WARMAP_DATA || {};\n';

const geo = {
  region: { ...REGION, world: WORLD, ox: round1(OX), oy: round1(OY), width: round1(RW), height: round1(RH) },
  iranBounds: [round1(bx0), round1(by0), round1(bx1), round1(by1)],
  land, iran, borders, provinceLines: provLines, provinces, cities,
};
fs.writeFileSync(path.join(OUT, 'geo.js'), header + 'WARMAP_DATA.geo = ' + JSON.stringify(geo) + ';\n');

const grid = { w: GW, h: GH, x0: GX0, y0: GY0, cell: CELL, prov: gz(prov), rug: gz(rug), river: gz(river) };
fs.writeFileSync(path.join(OUT, 'grid.js'), header + 'WARMAP_DATA.grid = ' + JSON.stringify(grid) + ';\n');

const reliefOut = {
  scale: TEX_SCALE, width: TW, height: TH,
  land: jpegDataUri(reliefBytes, TW, TH, 86),
  water: jpegDataUri(waterBytes, WW, WH, 85), waterWidth: WW, waterHeight: WH,
};
fs.writeFileSync(path.join(OUT, 'relief.js'), header + 'WARMAP_DATA.relief = ' + JSON.stringify(reliefOut) + ';\n');

for (const f of ['geo.js', 'grid.js', 'relief.js']) {
  console.log(`${f}: ${(fs.statSync(path.join(OUT, f)).size / 1024).toFixed(0)} KB`);
}
console.log(`land rings: ${land.length} (${landPts} pts), borders: ${borders.length}, province lines: ${provLines.length}, cities: ${cities.length}`);
