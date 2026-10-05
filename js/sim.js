// Offensive simulation.
//
// Every objective cell gets a local rate of advance from terrain roughness,
// rivers, towns, defensive belts, spearhead axes and random sector strength.
// A fast-marching (Eikonal) solve then gives the hour at which the front
// reaches each cell. The renderer thresholds those arrival times against the
// clock every frame, so the front moves continuously, stalls in the
// mountains, flows around towns and races down the spearhead corridors.
(function (WM) {
  'use strict';
  const { clamp, smoothstep } = WM;

  WM.DEFENSE_TIERS = [
    [20, 'Scattered militia'],
    [40, 'Light garrison'],
    [60, 'Regular army'],
    [80, 'Entrenched army'],
    [101, 'Fortified line'],
  ];
  WM.defenseTier = (d) => WM.DEFENSE_TIERS.find(([max]) => d < max)[1];

  // Rate of advance on open ground (km/h) against a defense of strength 1-100.
  WM.baseSpeed = (defense) => 9 * Math.exp(-0.0275 * defense);

  // Builds the defense-independent part of an offensive: speed factors and
  // reference arrival times (hours at a base speed of 1 km/h).
  WM.prepareOperation = function (world, plan, seed) {
    const { w, h, N, owner, rug, river, rowKm, kmAvg } = world;
    const { cells, mask, attacker, D } = plan;
    const n = cells.length;
    const rand = WM.rng(seed);
    const nzA = WM.makeNoise(seed), nzB = WM.makeNoise(seed ^ 0x5bd1e995), nzC = WM.makeNoise(seed + 977);

    let Dmax = 0;
    for (let k = 0; k < n; k++) Dmax = Math.max(Dmax, D[cells[k]]);
    const DmaxKm = Math.max(1, Dmax * kmAvg);

    // Jump-off cells: objective cells touching our lines.
    const seeds = [];
    for (let k = 0; k < n; k++) {
      const c = cells[k], x = c % w;
      if ((x > 0 && owner[c - 1] === attacker) || (x < w - 1 && owner[c + 1] === attacker) ||
        (c >= w && owner[c - w] === attacker) || (c < N - w && owner[c + w] === attacker)) seeds.push(c);
    }

    // Spearhead axes (Schwerpunkte): fast corridors from the front towards the
    // depth of the objective.
    const axes = [];
    if (seeds.length && DmaxKm > 25) {
      const frontKm = seeds.length * kmAvg;
      const nAxes = clamp(Math.round(frontKm / 320 + rand() * 1.4), 1, 4);
      const deep = [];
      for (let k = 0; k < n; k++) if (D[cells[k]] >= 0.72 * Dmax) deep.push(cells[k]);
      const xy = (c) => [c % w + 0.5, Math.floor(c / w) + 0.5];
      const starts = [seeds[Math.floor(rand() * seeds.length)]];
      while (starts.length < nAxes) {
        let best = -1, bestD = -1;
        for (let t = 0; t < 400; t++) {
          const s = seeds[Math.floor(rand() * seeds.length)];
          const [sx, sy] = xy(s);
          let md = Infinity;
          for (const o of starts) { const [ox, oy] = xy(o); md = Math.min(md, Math.hypot(sx - ox, sy - oy)); }
          if (md > bestD) { bestD = md; best = s; }
        }
        starts.push(best);
      }
      for (const s of starts) {
        const [sx, sy] = xy(s);
        let e = deep[0], bestScore = Infinity;
        for (let t = 0; t < Math.min(deep.length, 1500); t++) {
          const cand = deep[Math.floor(rand() * deep.length)];
          const [cx, cy] = xy(cand);
          const score = Math.hypot(cx - sx, cy - sy) * (0.75 + 0.5 * rand());
          if (score < bestScore) { bestScore = score; e = cand; }
        }
        const [ex, ey] = xy(e);
        if (Math.hypot(ex - sx, ey - sy) < 4) continue;
        axes.push({ sx, sy, ex, ey, strength: 0.9 + 1.4 * rand(), width: (8 + 14 * rand()) / kmAvg });
      }
    }

    // Prepared defensive belts at some depth behind the enemy front.
    const belts = [];
    if (DmaxKm > 60) {
      const r = rand(), nBelts = r < 0.3 ? 0 : r < 0.75 ? 1 : 2;
      for (let i = 0; i < nBelts; i++) belts.push({ depth: DmaxKm * (0.28 + 0.45 * rand()), width: 2.5 + 2 * rand() });
    }

    // Towns hold out: strong slowdown around each city, scaled by its size.
    const cityF = new Float32Array(N).fill(1);
    for (const city of world.cities) {
      if (!mask[city.cell]) {
        // still let nearby objective cells feel a town just outside the objective
        let near = false;
        const cx = city.cell % w, cy = Math.floor(city.cell / w);
        for (let d = -6; d <= 6 && !near; d += 3) for (let e = -6; e <= 6 && !near; e += 3) {
          const nc = (cy + d) * w + cx + e;
          if (nc >= 0 && nc < N && mask[nc]) near = true;
        }
        if (!near) continue;
      }
      const imp = city.importance;
      const S = 0.45 + 0.3 * imp, rKm = 4 + 10 * imp, rc = rKm / kmAvg;
      const cx = city.cell % w, cy = Math.floor(city.cell / w);
      const R = Math.ceil(rc * 2.5);
      for (let y = Math.max(0, cy - R); y <= Math.min(h - 1, cy + R); y++) {
        for (let x = Math.max(0, cx - R); x <= Math.min(w - 1, cx + R); x++) {
          const c = y * w + x;
          if (!mask[c]) continue;
          const d2 = ((x - cx) ** 2 + (y - cy) ** 2) / (rc * rc);
          cityF[c] *= 1 - S * Math.exp(-d2);
        }
      }
    }

    const f = new Float32Array(N);
    const fList = new Float32Array(n);
    for (let k = 0; k < n; k++) {
      const c = cells[k], x = c % w, y = (c - x) / w;
      const X = x * kmAvg, Y = y * kmAvg;
      const Dkm = D[c] * kmAvg;

      const terrain = 1.12 - 0.72 * Math.pow(rug[c] / 255, 0.85);
      let rv = river[c];
      if (x > 0) rv = Math.max(rv, river[c - 1]);
      if (x < w - 1) rv = Math.max(rv, river[c + 1]);
      if (c >= w) rv = Math.max(rv, river[c - w]);
      if (c < N - w) rv = Math.max(rv, river[c + w]);
      const riverF = 1 - 0.8 * (rv / 255);
      const sector = Math.exp(0.6 * nzA.fbm(X / 170, Y / 170, 3) + 0.3 * nzB.fbm(X / 48, Y / 48, 2));

      let axisF = 1;
      for (const a of axes) {
        const dx = a.ex - a.sx, dy = a.ey - a.sy, l2 = dx * dx + dy * dy;
        const t = ((x + 0.5 - a.sx) * dx + (y + 0.5 - a.sy) * dy) / l2;
        const tc = clamp(t, 0, 1);
        const dist = Math.hypot(a.sx + tc * dx - x - 0.5, a.sy + tc * dy - y - 0.5);
        const fade = t > 1 ? Math.exp(-(t - 1) * 4) : 1 - 0.35 * tc;
        axisF += a.strength * fade * Math.exp(-((dist / a.width) ** 2));
      }
      axisF = Math.min(axisF, 3.4);

      let beltF = 1;
      belts.forEach((b, i) => {
        const band = Math.exp(-(((Dkm - b.depth) / b.width) ** 2));
        if (band < 0.01) return;
        const gap = smoothstep(0.22, 0.55, nzC.fbm(X / 55 + 31 * i, Y / 55, 2));
        beltF *= 1 - 0.88 * band * (1 - gap) * (1 - 0.55 * Math.min(1, axisF - 1));
      });

      // Slow break-in at the enemy's forward positions, tiring with depth.
      const phase = (0.38 + 0.62 * smoothstep(0, 18, Dkm)) * (1 - 0.3 * (Dkm / DmaxKm));

      const v = clamp(terrain * riverF * cityF[c] * sector * axisF * beltF * phase, 0.06, 4);
      f[c] = v;
      fList[k] = v;
    }

    const T = fastMarch(world, mask, f, seeds, D);
    const Tref = new Float32Array(n);
    let maxT = 0;
    for (let k = 0; k < n; k++) {
      Tref[k] = T[cells[k]];
      maxT = Math.max(maxT, Tref[k]);
    }

    const toWorld = (gx, gy) => [world.x0 + gx * world.cell, world.y0 + gy * world.cell];
    return {
      cells, f: fList, Tref, maxTref: maxT, seedCount: seeds.length,
      axes: axes.map((a) => ({ from: toWorld(a.sx, a.sy), to: toWorld(a.ex, a.ey), strength: a.strength })),
      belts: belts.length,
    };
  };

  // First-order fast marching method on the 4-connected grid restricted to
  // `mask`. Speeds are km/h-equivalents; cell size varies per row.
  function fastMarch(world, mask, f, seeds, D) {
    const { w, h, N, rowKm, kmAvg } = world;
    const T = new Float64Array(N).fill(Infinity);
    const state = new Uint8Array(N); // 0 far, 1 trial, 2 accepted
    const heap = new WM.MinHeap(1 << 16);

    const solve = (c) => {
      const x = c % w, y = (c - x) / w;
      let a = Infinity, b = Infinity;
      if (x > 0 && state[c - 1] === 2) a = T[c - 1];
      if (x < w - 1 && state[c + 1] === 2) a = Math.min(a, T[c + 1]);
      if (y > 0 && state[c - w] === 2) b = T[c - w];
      if (y < h - 1 && state[c + w] === 2) b = Math.min(b, T[c + w]);
      if (a > b) { const t = a; a = b; b = t; }
      const hh = rowKm[y] / f[c];
      if (b === Infinity || b - a >= hh) return a + hh;
      return 0.5 * (a + b + Math.sqrt(2 * hh * hh - (b - a) * (b - a)));
    };
    const run = () => {
      while (heap.size) {
        const c = heap.pop();
        if (state[c] === 2) continue;
        state[c] = 2;
        const x = c % w;
        const nbs = [x > 0 ? c - 1 : -1, x < w - 1 ? c + 1 : -1, c >= w ? c - w : -1, c < N - w ? c + w : -1];
        for (const nb of nbs) {
          if (nb < 0 || !mask[nb] || state[nb] === 2) continue;
          const t = solve(nb);
          if (t < T[nb]) { T[nb] = t; state[nb] = 1; heap.push(t, nb); }
        }
      }
    };

    for (const c of seeds) {
      const t = (0.5 * rowKm[(c / w) | 0]) / f[c];
      if (t < T[c]) { T[c] = t; state[c] = 1; heap.push(t, c); }
    }
    run();

    // Pockets with no land contact (islands, cut-off enclaves) are taken by a
    // landing at their point closest to our lines, after a delay.
    for (let round = 0; round < 50; round++) {
      let best = -1, bestD = Infinity;
      for (let c = 0; c < N; c++) {
        if (mask[c] && state[c] !== 2 && D[c] < bestD) { bestD = D[c]; best = c; }
      }
      if (best < 0) break;
      let reached = 0;
      for (let c = 0; c < N; c++) if (state[c] === 2 && T[c] > reached) reached = T[c];
      const t = Math.min(reached, 40) + (bestD * kmAvg) / 0.7 + 12;
      T[best] = t; state[best] = 1; heap.push(t, best);
      run();
    }
    return T;
  }

  // A running offensive: converts reference times to clock hours for a given
  // defense strength and advances ownership as the clock passes each cell.
  WM.Operation = class Operation {
    constructor(world, plan, prep, defense, t0) {
      this.world = world;
      this.plan = plan;
      this.prep = prep;
      this.attacker = plan.attacker;
      this.enemy = plan.enemy;
      this.defense = defense;
      this.t0 = t0;
      this.baseOwner = world.owner.slice();
      const base = (this.base = WM.baseSpeed(defense));
      const { w, rowKm, rowArea } = world;
      const n = prep.cells.length;
      this.cells = prep.cells;
      this.T = new Float32Array(n);
      this.tau = new Float32Array(n);
      let end = t0;
      for (let k = 0; k < n; k++) {
        const y = (prep.cells[k] / w) | 0;
        this.T[k] = t0 + prep.Tref[k] / base;
        // time for the front to cross this cell; only used to smooth the edge
        this.tau[k] = Math.min(rowKm[y] / (base * prep.f[k]), 3);
        end = Math.max(end, this.T[k] + 0.5 * this.tau[k]);
      }
      this.tEnd = end;
      const order = new Uint32Array(n);
      for (let k = 0; k < n; k++) order[k] = k;
      const T = this.T;
      this.order = order.sort((a, b) => T[a] - T[b]);
      this.ptr = 0;
      this.captured = 0;
      this.totalArea = plan.area;
      this.rowArea = rowArea;

      const kOfCell = new Map();
      for (let k = 0; k < n; k++) kOfCell.set(prep.cells[k], k);
      this.cityEvents = world.cities
        .filter((c) => plan.mask[c.cell])
        .map((c) => ({ city: c, t: this.T[kOfCell.get(c.cell)] }))
        .sort((a, b) => a.t - b.t);
      this.cityPtr = 0;

      this.provHeld = new Int32Array(world.provinces.length + 1);
      for (const c of world.iranCells) if (world.owner[c] === this.attacker) this.provHeld[world.prov[c]]++;
      this.provFallen = new Uint8Array(world.provinces.length + 1);
      world.provinces.forEach((p) => { if (this.provHeld[p.id] >= p.cells * 0.98) this.provFallen[p.id] = 1; });
      this.milestone = 0;
    }

    // Capture every cell whose arrival time has passed. Returns true when done.
    advance(t, events) {
      const { world, cells, T, order, attacker } = this;
      const { owner, prov, w } = world;
      const n = cells.length;
      while (this.ptr < n && T[order[this.ptr]] <= t) {
        const k = order[this.ptr++];
        const c = cells[k];
        if (owner[c] !== attacker) {
          owner[c] = attacker;
          this.captured += this.rowArea[(c / w) | 0];
          const p = prov[c];
          this.provHeld[p]++;
          const P = world.provinces[p - 1];
          if (!this.provFallen[p] && this.provHeld[p] >= P.cells * 0.98) {
            this.provFallen[p] = 1;
            events.push({ t: T[k], side: attacker, kind: 'province', text: `${P.name} province is under ${WM.SIDE_NAME[attacker]} control.` });
          }
        }
      }
      while (this.cityPtr < this.cityEvents.length && this.cityEvents[this.cityPtr].t <= t) {
        const ev = this.cityEvents[this.cityPtr++];
        events.push({ t: ev.t, side: attacker, kind: 'city', text: `${WM.SIDE_NAME[attacker]} troops take ${ev.city.name}.` });
      }
      const pct = this.progress();
      for (const m of [0.25, 0.5, 0.75]) {
        if (this.milestone < m && pct >= m) {
          this.milestone = m;
          events.push({ t, side: attacker, kind: 'progress', text: `${Math.round(m * 100)}% of the objective taken.` });
        }
      }
      return this.ptr >= n && t >= this.tEnd;
    }

    progress() {
      return this.totalArea ? Math.min(1, this.captured / this.totalArea) : 1;
    }
  };
})(window.WM);
