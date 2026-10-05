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

    applyScenario(redProvinces = WM.START_RED_PROVINCES) {
      const red = new Set(redProvinces);
      const R = this.geo.region;
      // Red also holds the western uplands of Isfahan province, linking its
      // northern block with Chaharmahal; the line there is an irregular front.
      const lonToX = (lon) => ((lon + 180) / 360) * R.world - R.ox;
      const cutX = lonToX(51.0), wobble = lonToX(51.7) - cutX;
      const noise = WM.makeNoise(1902);
      this.owner.fill(0);
      for (const c of this.iranCells) {
        const name = this.provinces[this.prov[c] - 1].name;
        let isRed = red.has(name);
        if (!isRed && name === 'Isfahan') {
          const [x, y] = this.cellCenter(c);
          isRed = x < cutX + wobble * noise.fbm(x / 140, y / 90, 5);
        }
        this.owner[c] = isRed ? WM.RED : WM.BLUE;
      }
    }

    stats() {
      const area = [0, 0, 0];
      const provHeld = this.provinces.map(() => [0, 0, 0]);
      for (const c of this.iranCells) {
        const o = this.owner[c];
        area[o] += this.rowArea[(c / this.w) | 0];
        provHeld[this.prov[c] - 1][o]++;
      }
      const provinces = [0, 0, 0];
      this.provinces.forEach((p, i) => {
        if (provHeld[i][WM.BLUE] / p.cells >= 0.5) provinces[WM.BLUE]++;
        else provinces[WM.RED]++;
      });
      return { area, provinces };
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
