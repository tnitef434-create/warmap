// The simulation grid: which side owns each ~2 km cell of Iran, plus static
// terrain layers (province, roughness, rivers) baked by tools/build-data.mjs.
(function (WM) {
  'use strict';

  WM.NONE = 0;
  WM.BLUE = 1;
  WM.RED = 2;
  WM.SIDE_NAME = { 1: 'Blue', 2: 'Red' };

  // Opening situation, matching the reference map: a Red-held block in the
  // western highlands, the rest of the country Blue.
  WM.START_RED_PROVINCES = ['Kurdistan', 'Kermanshah', 'Hamadan', 'Lorestan', 'Markazi', 'Chaharmahal and Bakhtiari'];

  WM.World = class World {
    static async load(data) {
      const g = data.grid;
      const [prov, rug, river] = await Promise.all([
        WM.gunzipBase64(g.prov), WM.gunzipBase64(g.rug), WM.gunzipBase64(g.river),
      ]);
      return new World(data.geo, g, prov, rug, river);
    }

    constructor(geo, g, prov, rug, river) {
      this.geo = geo;
      this.w = g.w; this.h = g.h; this.x0 = g.x0; this.y0 = g.y0; this.cell = g.cell;
      const w = this.w, h = this.h, N = (this.N = w * h);
      this.prov = prov; this.rug = rug; this.river = river;
      this.owner = new Uint8Array(N);

      // Cell size varies with latitude in Mercator; keep km and km² per row.
      const R = geo.region;
      this.rowKm = new Float32Array(h);
      this.rowArea = new Float32Array(h);
      for (let j = 0; j < h; j++) {
        const gy = this.y0 + (j + 0.5) * this.cell + R.oy;
        const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * gy) / R.world)));
        const km = (40075.016686 / R.world) * Math.cos(lat) * this.cell;
        this.rowKm[j] = km;
        this.rowArea[j] = km * km;
      }
      this.kmAvg = this.rowKm[h >> 1];

      const iran = [];
      for (let c = 0; c < N; c++) if (prov[c]) iran.push(c);
      this.iranCells = Int32Array.from(iran);

      // Nearest Iran cell for every cell (multi-source BFS); lets textures carry
      // ownership slightly past the coastline so the vector outline clips cleanly.
      this.nearest = new Int32Array(N).fill(-1);
      const queue = new Int32Array(N);
      let head = 0, tail = 0;
      for (const c of this.iranCells) { this.nearest[c] = c; queue[tail++] = c; }
      while (head < tail) {
        const c = queue[head++], x = c % w;
        const src = this.nearest[c];
        if (x > 0 && this.nearest[c - 1] < 0) { this.nearest[c - 1] = src; queue[tail++] = c - 1; }
        if (x < w - 1 && this.nearest[c + 1] < 0) { this.nearest[c + 1] = src; queue[tail++] = c + 1; }
        if (c >= w && this.nearest[c - w] < 0) { this.nearest[c - w] = src; queue[tail++] = c - w; }
        if (c < N - w && this.nearest[c + w] < 0) { this.nearest[c + w] = src; queue[tail++] = c + w; }
      }

      this.provinces = geo.provinces.map((p) => ({ ...p, cells: 0, area: 0 }));
      this.totalArea = 0;
      for (const c of this.iranCells) {
        const a = this.rowArea[(c / w) | 0];
        const p = this.provinces[prov[c] - 1];
        p.cells++;
        p.area += a;
        this.totalArea += a;
      }

      this.cities = [];
      for (const c of geo.cities) {
        const cell = this.cellAt(c.x, c.y);
        if (cell < 0 || !prov[cell]) continue;
        const importance = WM.clamp((Math.log10(c.pop) - 4.3) / 2.6, 0, 1);
        this.cities.push({ ...c, cell, importance, province: prov[cell] });
      }
      for (const t of this.cities) t.orig = this.scenarioOwner(t.cell);
      this.buildBattlefield();
    }

    // Static layers used by the battle model.
    buildBattlefield() {
      const { w, N, prov, rug, river } = this;
      this.defMod = new Float32Array(N);   // how well the ground favours the defender
      this.moveMod = new Float32Array(N);  // how quickly troops can move across it
      this.rateNoise = new Float32Array(N);
      this.pop = new Float32Array(N);      // inhabitants, scaled to Persia's ~10 million in 1902
      this.townAt = new Int16Array(N);
      const rand = WM.rng(4242);
      let weight = 0;
      for (const c of this.iranCells) {
        const r = rug[c] / 255, x = c % w;
        let rv = river[c];
        if (x > 0) rv = Math.max(rv, river[c - 1]);
        if (x < w - 1) rv = Math.max(rv, river[c + 1]);
        if (c >= w) rv = Math.max(rv, river[c - w]);
        if (c < N - w) rv = Math.max(rv, river[c + w]);
        this.defMod[c] = (1 + 0.85 * Math.pow(r, 0.9)) * (1 + 0.9 * (rv / 255));
        this.moveMod[c] = 1.12 - 0.6 * Math.pow(r, 0.85);
        this.rateNoise[c] = Math.exp(0.6 * (rand() + rand() + rand() - 1.5));
        const wt = this.rowArea[(c / w) | 0] * (1.25 - 0.75 * r);
        this.pop[c] = wt;
        weight += wt;
      }
      for (const c of this.iranCells) this.pop[c] *= 7.6e6 / weight;
      let urban = 0;
      for (const t of this.cities) urban += Math.pow(t.pop, 0.8);
      this.cities.forEach((t, i) => {
        if (!this.townAt[t.cell]) this.townAt[t.cell] = i + 1;
        this.pop[t.cell] += (2.4e6 * Math.pow(t.pop, 0.8)) / urban;
        // towns are fortified: defenders hold out in and around them
        const rc = (3 + 7 * t.importance) / this.kmAvg, R = Math.ceil(rc * 2.5);
        const cx = t.cell % w, cy = Math.floor(t.cell / w);
        for (let y = cy - R; y <= cy + R; y++) for (let x = cx - R; x <= cx + R; x++) {
          if (x < 0 || y < 0 || x >= w || y >= this.h) continue;
          const c = y * w + x;
          if (!prov[c]) continue;
          this.defMod[c] *= 1 + (1 + 1.8 * t.importance) * Math.exp(-((x - cx) ** 2 + (y - cy) ** 2) / (rc * rc));
        }
      });
      // Cells just outside Iran's raster mask copy a nearby Iran cell so the
      // vector coastline never shows a gap.
      const halo = [];
      for (let c = 0; c < N; c++) {
        const s = this.nearest[c];
        if (prov[c] || s < 0) continue;
        if (Math.abs((c % w) - (s % w)) <= 4 && Math.abs(Math.floor(c / w) - Math.floor(s / w)) <= 4) halo.push(c, s);
      }
      this.halo = Int32Array.from(halo);
    }

    cellAt(x, y) {
      const i = Math.floor((x - this.x0) / this.cell), j = Math.floor((y - this.y0) / this.cell);
      if (i < 0 || j < 0 || i >= this.w || j >= this.h) return -1;
      return j * this.w + i;
    }

    cellCenter(c) {
      const i = c % this.w, j = (c - i) / this.w;
      return [this.x0 + (i + 0.5) * this.cell, this.y0 + (j + 0.5) * this.cell];
    }

    // Opening owner of a cell: a Red-held block in the western highlands,
    // reaching into the western uplands of Isfahan along an irregular front.
    scenarioOwner(c) {
      if (!this._scenario) {
        const R = this.geo.region;
        const lonToX = (lon) => ((lon + 180) / 360) * R.world - R.ox;
        this._scenario = {
          red: new Set(WM.START_RED_PROVINCES),
          cutX: lonToX(51.0), wobble: lonToX(51.7) - lonToX(51.0), noise: WM.makeNoise(1902),
        };
      }
      const S = this._scenario;
      if (!this.prov[c]) return WM.NONE;
      const name = this.provinces[this.prov[c] - 1].name;
      if (S.red.has(name)) return WM.RED;
      if (name === 'Isfahan') {
        const [x, y] = this.cellCenter(c);
        if (x < S.cutX + S.wobble * S.noise.fbm(x / 140, y / 90, 5)) return WM.RED;
      }
      return WM.BLUE;
    }

    applyScenario() {
      this.owner.fill(0);
      for (const c of this.iranCells) this.owner[c] = this.scenarioOwner(c);
    }

    nearestTown(gx, gy) {
      let best = null, bd = Infinity;
      for (const t of this.cities) {
        const x = t.cell % this.w, y = Math.floor(t.cell / this.w);
        const d = (x - gx) ** 2 + (y - gy) ** 2;
        if (d < bd) { bd = d; best = t; }
      }
      return best;
    }

    // Approximate Euclidean distance (in cells) from every cell to the nearest
    // cell owned by `side`, via a two-pass chamfer transform.
    distanceFrom(side) {
      const { w, h, N, owner } = this;
      const d = new Float32Array(N);
      const INF = 1e9, DIAG = 1.41421356;
      for (let c = 0; c < N; c++) d[c] = owner[c] === side ? 0 : INF;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const c = y * w + x;
          let v = d[c], t;
          if (v === 0) continue;
          if (x > 0 && (t = d[c - 1] + 1) < v) v = t;
          if (y > 0) {
            if ((t = d[c - w] + 1) < v) v = t;
            if (x > 0 && (t = d[c - w - 1] + DIAG) < v) v = t;
            if (x < w - 1 && (t = d[c - w + 1] + DIAG) < v) v = t;
          }
          d[c] = v;
        }
      }
      for (let y = h - 1; y >= 0; y--) {
        for (let x = w - 1; x >= 0; x--) {
          const c = y * w + x;
          let v = d[c], t;
          if (v === 0) continue;
          if (x < w - 1 && (t = d[c + 1] + 1) < v) v = t;
          if (y < h - 1) {
            if ((t = d[c + w] + 1) < v) v = t;
            if (x < w - 1 && (t = d[c + w + 1] + DIAG) < v) v = t;
            if (x > 0 && (t = d[c + w - 1] + DIAG) < v) v = t;
          }
          d[c] = v;
        }
      }
      return d;
    }

    // Run-length encoding of ownership over Iran's cells, for saving.
    encodeOwner() {
      const out = [];
      let prev = -1, run = 0;
      for (const c of this.iranCells) {
        const o = this.owner[c];
        if (o === prev) run++;
        else { if (run) out.push(prev, run); prev = o; run = 1; }
      }
      if (run) out.push(prev, run);
      return out;
    }

    decodeOwner(rle) {
      let k = 0;
      for (let i = 0; i < rle.length; i += 2) {
        const v = rle[i];
        if (v !== WM.BLUE && v !== WM.RED) return false;
        for (let r = 0; r < rle[i + 1]; r++) {
          if (k >= this.iranCells.length) return false;
          this.owner[this.iranCells[k++]] = v;
        }
      }
      return k === this.iranCells.length;
    }
  };
})(window.WM);
