// Turns a line drawn by the player into an objective: the set of enemy cells
// the offensive will try to take.
//
//  * Front line: the stroke (extended to the nearest edge if it stops short)
//    cuts the enemy's territory; everything cut off from the enemy's rear is
//    the objective. "Flip" takes the other side instead.
//  * Encirclement: a closed loop takes the enemy territory inside it.
//  * Thrust: a stroke that ends deep inside enemy land takes a corridor
//    around the line (a salient).
(function (WM) {
  'use strict';
  const { clamp } = WM;

  WM.Planner = class Planner {
    constructor(world) {
      this.world = world;
      const N = world.N;
      this.barrier = new Uint8Array(N);
      this.sub = new Int32Array(N);
      this.orig = new Int32Array(N);
      this.stack = new Int32Array(N);
      this.mark = new Int32Array(N);
      this.gen = 0;
    }

    plan(attacker, pathWorld, flip = false, seed = 1) {
      const world = this.world;
      const enemy = attacker === WM.BLUE ? WM.RED : WM.BLUE;
      const { x0, y0, cell } = world;

      // Grid-space path without near-duplicate points.
      const raw = [];
      for (const [x, y] of pathWorld) {
        const gx = (x - x0) / cell, gy = (y - y0) / cell;
        const last = raw[raw.length - 1];
        if (!last || Math.hypot(gx - last[0], gy - last[1]) >= 0.5) raw.push([gx, gy]);
      }
      if (raw.length < 2) return { ok: false, reason: 'Draw a longer line.' };
      let len = 0;
      for (let i = 1; i < raw.length; i++) len += Math.hypot(raw[i][0] - raw[i - 1][0], raw[i][1] - raw[i - 1][1]);
      const closed = len > 30 && Math.hypot(raw[0][0] - raw[raw.length - 1][0], raw[0][1] - raw[raw.length - 1][1]) < Math.max(5, 0.12 * len);
      // The hand-drawn stroke becomes a believable border: it bends to rivers
      // and broken ground and gains natural irregularity at every scale.
      const pts = this.realistic(closed ? raw.slice(0, -1) : raw, closed, seed);
      if (closed) pts.push(pts[0]);

      const barrier = this.barrier;
      barrier.fill(0);
      for (let i = 1; i < pts.length; i++) this.rasterSegment(pts[i - 1], pts[i], barrier);
      let touchesEnemy = false;
      for (let c = 0; c < world.N && !touchesEnemy; c++) if (barrier[c] && world.owner[c] === enemy) touchesEnemy = true;
      const D = world.distanceFrom(attacker);

      let result = null;
      if (closed) result = this.encircle(pts, attacker, enemy);
      else if (touchesEnemy) {
        result = this.frontLine(pts, len, attacker, enemy, D, flip, seed);
        // A stroke whose loose end had to be tied back to our lines and only
        // encloses a sliver was meant as an arrow: treat it as a thrust.
        if (result && result.extensions.length && result.count < 0.08 * len * len) result = null;
      }
      if (!result && touchesEnemy && !closed) result = this.thrust(pts, len, attacker, enemy, D, seed);

      if (!result || result.count < 6) {
        return {
          ok: false,
          reason: `That line does not reach into ${WM.SIDE_NAME[enemy]} territory. Start at your own front and draw into the enemy's land.`,
        };
      }

      const mask = result.mask;
      const cells = [];
      let area = 0;
      for (let c = 0; c < world.N; c++) {
        if (mask[c]) { cells.push(c); area += world.rowArea[(c / world.w) | 0]; }
      }
      const cities = world.cities.filter((ct) => mask[ct.cell]).map((ct) => ct.name);
      const provSet = new Set();
      for (const c of cells) provSet.add(world.prov[c]);
      const toWorld = (line) => line.map(([gx, gy]) => [x0 + gx * cell, y0 + gy * cell]);
      return {
        ok: true,
        attacker, enemy, mode: result.mode, mask, cells: Int32Array.from(cells), area, cities,
        provinces: [...provSet].map((id) => world.provinces[id - 1].name),
        D, path: toWorld(pts), extensions: (result.extensions || []).map(toWorld), canFlip: !!result.canFlip, flipped: flip,
      };
    }

    // Resamples a stroke (grid units) and turns it into a natural-looking
    // border line. End points stay where they were drawn.
    realistic(pts, closed, seed) {
      const { river, rug } = this.world;
      const STEP = 0.5;
      const res = [pts[0]];
      let carry = 0;
      const seq = closed ? [...pts, pts[0]] : pts;
      for (let i = 1; i < seq.length; i++) {
        const [ax, ay] = seq[i - 1], [bx, by] = seq[i];
        const L = Math.hypot(bx - ax, by - ay);
        let d = STEP - carry;
        while (d <= L) {
          res.push([ax + ((bx - ax) * d) / L, ay + ((by - ay) * d) / L]);
          d += STEP;
        }
        carry = L - (d - STEP);
      }
      if (closed) res.pop();
      else res.push(pts[pts.length - 1]);
      const n = res.length;
      if (n < 6) return res;
      const at = (i) => res[closed ? (i + n) % n : Math.max(0, Math.min(n - 1, i))];
      const normals = res.map((_, i) => {
        const a = at(i - 6), b = at(i + 6);
        const dx = b[0] - a[0], dy = b[1] - a[1], l = Math.hypot(dx, dy) || 1;
        return [-dy / l, dx / l];
      });
      const attract = (x, y) => {
        const c = this.cellOf([x, y]);
        return c < 0 ? 0 : (river[c] / 255) * 1.6 + (rug[c] / 255) * 0.35;
      };
      // Pull towards rivers and ridges within ~12 km, then smooth the pull.
      const pull = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        const [px, py] = res[i], [nx, ny] = normals[i];
        let best = 0, bestS = attract(px, py) + 0.12;
        for (let o = -7; o <= 7; o++) {
          const s = attract(px + nx * o, py + ny * o) - 0.012 * o * o;
          if (s > bestS) { bestS = s; best = o; }
        }
        pull[i] = best;
      }
      const smooth = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let s = 0, ws = 0;
        for (let k = -20; k <= 20; k++) {
          const j = closed ? (i + k + n) % n : i + k;
          if (j < 0 || j >= n) continue;
          const wgt = Math.exp(-(k * k) / 128);
          s += pull[j] * wgt;
          ws += wgt;
        }
        smooth[i] = s / ws;
      }
      const nz = WM.makeNoise(seed * 7919 + 11);
      const out = [];
      let arc = 0;
      for (let i = 0; i < n; i++) {
        if (i) arc += Math.hypot(res[i][0] - res[i - 1][0], res[i][1] - res[i - 1][1]);
        const frac = 6.5 * nz.noise(arc / 55, 0.37) + 3.0 * nz.noise(arc / 18, 3.7) +
          1.3 * nz.noise(arc / 6, 7.9) + 0.6 * nz.noise(arc / 2.1, 12.1) + 0.25 * nz.noise(arc / 0.8, 17.3);
        const taper = closed ? 1 : Math.min(1, i / 20, (n - 1 - i) / 20);
        const o = (smooth[i] * 0.85 + frac) * taper;
        out.push([res[i][0] + normals[i][0] * o, res[i][1] + normals[i][1] * o]);
      }
      return out;
    }

    rasterSegment(a, b, out) {
      const { w, h } = this.world;
      const steps = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.4));
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const i = Math.floor(a[0] + (b[0] - a[0]) * t), j = Math.floor(a[1] + (b[1] - a[1]) * t);
        if (i >= 0 && j >= 0 && i < w && j < h) out[j * w + i] = 1;
      }
    }

    cellOf(p) {
      const { w, h } = this.world;
      const i = Math.floor(p[0]), j = Math.floor(p[1]);
      return i < 0 || j < 0 || i >= w || j >= h ? -1 : j * w + i;
    }

    // Breadth-first search for the closest cell not held by `enemy`.
    nearestNonEnemy(start, enemy, limit = 250000) {
      const { w, N, owner } = this.world;
      const mark = this.mark, q = this.stack, gen = ++this.gen;
      let head = 0, tail = 0;
      q[tail++] = start;
      mark[start] = gen;
      while (head < tail && tail < limit) {
        const c = q[head++];
        if (owner[c] !== enemy) return c;
        const x = c % w;
        const nb = [x > 0 ? c - 1 : -1, x < w - 1 ? c + 1 : -1, c - w, c + w];
        for (const n of nb) {
          if (n < 0 || n >= N || mark[n] === gen) continue;
          mark[n] = gen;
          q[tail++] = n;
        }
      }
      return -1;
    }

    // Flood-fill labelling (4-connected) of cells where include[c] is non-zero.
    label(include, labels) {
      const { w, N } = this.world;
      const stack = this.stack;
      labels.fill(0);
      let n = 0;
      for (let c0 = 0; c0 < N; c0++) {
        if (!include[c0] || labels[c0]) continue;
        n++;
        let sp = 0;
        stack[sp++] = c0;
        labels[c0] = n;
        while (sp) {
          const c = stack[--sp], x = c % w;
          if (x > 0 && include[c - 1] && !labels[c - 1]) { labels[c - 1] = n; stack[sp++] = c - 1; }
          if (x < w - 1 && include[c + 1] && !labels[c + 1]) { labels[c + 1] = n; stack[sp++] = c + 1; }
          if (c >= w && include[c - w] && !labels[c - w]) { labels[c - w] = n; stack[sp++] = c - w; }
          if (c < N - w && include[c + w] && !labels[c + w]) { labels[c + w] = n; stack[sp++] = c + w; }
        }
      }
      return n;
    }

    frontLine(pts, len, attacker, enemy, D, flip, seed) {
      const world = this.world;
      const { w, N, owner } = world;
      const barrier = this.barrier;
      const extensions = [];

      // Extend loose ends to the nearest edge of enemy territory.
      const ends = [pts[0], pts[pts.length - 1]].map((p) => {
        const c = this.cellOf(p);
        return { p, c, loose: c >= 0 && owner[c] === enemy };
      });
      const reach = ends.map((e) => {
        if (!e.loose) return null;
        const t = this.nearestNonEnemy(e.c, enemy);
        if (t < 0) return null;
        const tx = (t % w) + 0.5, ty = Math.floor(t / w) + 0.5;
        return { t: [tx, ty], dist: Math.hypot(tx - e.p[0], ty - e.p[1]) };
      });
      const looseCount = ends.filter((e) => e.loose).length;
      if (looseCount === 1) {
        // A line from our side that stops deep in enemy land is a thrust,
        // unless it stops just short of an edge.
        const r = reach[ends[0].loose ? 0 : 1];
        if (!r || r.dist > Math.max(12, 0.2 * len)) return null;
      }
      ends.forEach((e, i) => {
        if (!e.loose || !reach[i]) return;
        const seg = this.realistic([e.p, reach[i].t], false, seed + 31 * (i + 1));
        for (let k = 1; k < seg.length; k++) this.rasterSegment(seg[k - 1], seg[k], barrier);
        extensions.push(seg);
      });

      const isEnemy = new Uint8Array(N), open = new Uint8Array(N);
      for (let c = 0; c < N; c++) {
        if (owner[c] === enemy) { isEnemy[c] = 1; open[c] = barrier[c] ? 0 : 1; }
      }
      const nOrig = this.label(isEnemy, this.orig);
      const nSub = this.label(open, this.sub);
      const sub = this.sub, orig = this.orig;

      const maxD = new Float32Array(nSub + 1).fill(-1);
      const origOf = new Int32Array(nSub + 1);
      const touchA = new Uint8Array(nSub + 1);
      const size = new Int32Array(nSub + 1);
      for (let c = 0; c < N; c++) {
        const s = sub[c];
        if (!s) continue;
        size[s]++;
        if (D[c] > maxD[s]) maxD[s] = D[c];
        origOf[s] = orig[c];
        if (!touchA[s]) {
          const x = c % w;
          if ((x > 0 && owner[c - 1] === attacker) || (x < w - 1 && owner[c + 1] === attacker) ||
            (c >= w && owner[c - w] === attacker) || (c < N - w && owner[c + w] === attacker)) touchA[s] = 1;
        }
      }
      const touched = new Uint8Array(nOrig + 1);
      for (let c = 0; c < N; c++) if (barrier[c] && owner[c] === enemy) touched[orig[c]] = 1;

      // The enemy's rear in each split region is the piece deepest behind the line.
      const rear = new Int32Array(nOrig + 1);
      const rearD = new Float32Array(nOrig + 1).fill(-1);
      for (let s = 1; s <= nSub; s++) {
        const o = origOf[s];
        if (touched[o] && maxD[s] > rearD[o]) { rearD[o] = maxD[s]; rear[o] = s; }
      }
      const pick = new Uint8Array(nSub + 1), alt = new Uint8Array(nSub + 1);
      let nPick = 0, nAlt = 0;
      for (let s = 1; s <= nSub; s++) {
        const o = origOf[s];
        if (!touched[o]) continue;
        if (s !== rear[o] && touchA[s]) { pick[s] = 1; nPick += size[s]; } else { alt[s] = 1; nAlt += size[s]; }
      }
      if (!nPick) return null;
      // Only offer the other side when it is a comparable bite, not the
      // enemy's entire hinterland.
      const altOk = nAlt > 0 && nAlt <= 2.5 * nPick;
      const chosen = flip && altOk ? alt : pick;

      const mask = new Uint8Array(N);
      let count = 0;
      for (let c = 0; c < N; c++) if (chosen[sub[c]] && sub[c]) { mask[c] = 1; count++; }
      // The drawn line itself becomes part of the new front.
      const add = [];
      for (let c = 0; c < N; c++) {
        if (!barrier[c] || owner[c] !== enemy || mask[c]) continue;
        const x = c % w;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          if ((x + dx < 0) || (x + dx >= w)) continue;
          const n = c + dy * w + dx;
          if (n >= 0 && n < N && mask[n]) { add.push(c); dy = dx = 2; }
        }
      }
      for (const c of add) { mask[c] = 1; count++; }
      return { mask, count, mode: 'front', extensions, canFlip: altOk };
    }

    encircle(pts, attacker, enemy) {
      const world = this.world;
      const { w, h, N, owner } = world;
      const mask = new Uint8Array(N);
      let count = 0;
      const edges = [];
      for (let i = 0; i < pts.length; i++) {
        const a = pts[i], b = pts[(i + 1) % pts.length];
        if (a[1] !== b[1]) edges.push(a[1] < b[1] ? [a[0], a[1], b[0], b[1]] : [b[0], b[1], a[0], a[1]]);
      }
      for (let j = 0; j < h; j++) {
        const yc = j + 0.5;
        const xs = [];
        for (const e of edges) if (yc >= e[1] && yc < e[3]) xs.push(e[0] + ((yc - e[1]) * (e[2] - e[0])) / (e[3] - e[1]));
        if (xs.length < 2) continue;
        xs.sort((a, b) => a - b);
        for (let k = 0; k + 1 < xs.length; k += 2) {
          const i0 = Math.max(0, Math.ceil(xs[k] - 0.5)), i1 = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5));
          for (let i = i0; i <= i1; i++) {
            const c = j * w + i;
            if (owner[c] === enemy) { mask[c] = 1; count++; }
          }
        }
      }
      return count ? { mask, count, mode: 'encircle' } : null;
    }

    thrust(pts, len, attacker, enemy, D, seed) {
      const world = this.world;
      const { w, h, N, owner, kmAvg } = world;
      const radius = clamp(0.22 * len * kmAvg, 16, 55) / kmAvg;
      const mask = new Uint8Array(N);
      const nz = WM.makeNoise(seed * 31 + 5);
      for (let i = 1; i < pts.length; i++) {
        const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
        const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1e-9;
        const i0 = Math.max(0, Math.floor(Math.min(ax, bx) - radius)), i1 = Math.min(w - 1, Math.ceil(Math.max(ax, bx) + radius));
        const j0 = Math.max(0, Math.floor(Math.min(ay, by) - radius)), j1 = Math.min(h - 1, Math.ceil(Math.max(ay, by) + radius));
        for (let j = j0; j <= j1; j++) for (let ii = i0; ii <= i1; ii++) {
          const c = j * w + ii;
          if (owner[c] !== enemy || mask[c]) continue;
          const px = ii + 0.5, py = j + 0.5;
          const t = clamp(((px - ax) * dx + (py - ay) * dy) / l2, 0, 1);
          // taper the corridor towards the tip of the arrow
          const along = (i - 1 + t) / Math.max(1, pts.length - 1);
          const r = radius * (1 - 0.45 * along * along) * (1 + 0.28 * nz.fbm(px / 9, py / 9, 4));
          if (Math.hypot(ax + t * dx - px, ay + t * dy - py) <= r) mask[c] = 1;
        }
      }
      // Keep the pieces connected to our lines (or the closest one, for a landing).
      const lab = this.sub;
      const n = this.label(mask, lab);
      if (!n) return null;
      const keep = new Uint8Array(n + 1);
      const best = new Float32Array(n + 1).fill(1e9);
      for (let c = 0; c < N; c++) {
        const s = lab[c];
        if (!s) continue;
        best[s] = Math.min(best[s], D[c]);
      }
      let any = false;
      for (let s = 1; s <= n; s++) if (best[s] <= 1.5) { keep[s] = 1; any = true; }
      if (!any) {
        let bs = 1;
        for (let s = 2; s <= n; s++) if (best[s] < best[bs]) bs = s;
        keep[bs] = 1;
      }
      let count = 0;
      for (let c = 0; c < N; c++) {
        if (mask[c] && keep[lab[c]]) count++;
        else mask[c] = 0;
      }
      return { mask, count, mode: 'thrust' };
    }
  };
})(window.WM);
