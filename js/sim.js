// Battle simulation.
//
// Ownership changes cell by cell (~2 km). Each offensive is an army with a
// number of men, split between holding troops spread along the whole front
// and a few battle groups that concentrate on narrow sectors. Where a battle
// group presses, the front breaks; elsewhere it barely moves. The defender
// brings up reserves against each thrust, so groups stall and shift their
// effort, and defenders counter-attack the flanks of salients. Several
// offensives by both sides can run at once; where they meet head-on the
// stronger side pushes. Cut-off pockets lose supply and surrender.
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
  // Defenders per km of front for a defense strength of 1-100.
  WM.defenseDensity = (d) => 14 * Math.exp(0.03 * d);
  WM.START_ARMY = [0, 260000, 150000];
  WM.START_MORALE = [0, 0.8, 0.88];

  const VMAX = 1.6;        // km/h, unopposed advance (~25-40 km a day incl. halts)
  const VMAX_CAP = 0.9;    // km/h, fastest sustained sector pace
  const STEP = 0.1;        // h, longest simulation sub-step
  const HOLD_SHARE = 0.3;  // share of an offensive's men holding the wider front
  const LOSS_RATE = 0.0003;
  const KILLED_SHARE = 0.3;
  const CODENAMES = ['Rostam', 'Simurgh', 'Kaveh', 'Arash', 'Sohrab', 'Damavand', 'Esfandiar', 'Zagros', 'Anahita',
    'Bahram', 'Alborz', 'Karun', 'Fereydun', 'Siavash', 'Gordafarid', 'Jamshid', 'Mithra', 'Tahmineh', 'Kay Khosrow',
    'Bijan', 'Manuchehr', 'Garshasp', 'Rudaba', 'Zal', 'Giv', 'Gudarz', 'Babak', 'Shirin', 'Farhad', 'Tus'];
  const NB = [[-1, -1, 0.7], [0, -1, 1], [1, -1, 0.7], [-1, 0, 1], [1, 0, 1], [-1, 1, 0.7], [0, 1, 1], [1, 1, 0.7]];
  const WEIGHTS = Float32Array.from(NB.map((n) => n[2]));

  // ---------------------------------------------------------------------------
  // Planning: spearhead axes, defensive belts and static attack weights.
  WM.prepareOperation = function (world, plan, seed) {
    const { w, owner, kmAvg } = world;
    const { cells, attacker, D } = plan;
    const rand = WM.rng(seed);

    let x0 = w, y0 = world.h, x1 = 0, y1 = 0, Dmax = 0, deepest = cells[0];
    for (const c of cells) {
      const x = c % w, y = (c - x) / w;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (D[c] > Dmax) { Dmax = D[c]; deepest = c; }
    }
    const bbox = { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    const DmaxKm = Math.max(1, Dmax * kmAvg);

    const seeds = [];
    for (const c of cells) {
      const x = c % w;
      if ((x > 0 && owner[c - 1] === attacker) || (x < w - 1 && owner[c + 1] === attacker) ||
        owner[c - w] === attacker || owner[c + w] === attacker) seeds.push(c);
    }
    const xy = (c) => [(c % w) + 0.5, Math.floor(c / w) + 0.5];

    // Battle groups start on the front and drive into the depth.
    const axes = [];
    if (seeds.length) {
      const frontKm = seeds.length * kmAvg;
      const nAxes = DmaxKm < 20 ? 1 : clamp(Math.round(frontKm / 260 + rand() * 1.5), 1, 4);
      const deep = [];
      for (const c of cells) if (D[c] >= 0.65 * Dmax) deep.push(c);
      const starts = [seeds[Math.floor(rand() * seeds.length)]];
      while (starts.length < nAxes) {
        let best = seeds[0], bestD = -1;
        for (let t = 0; t < 300; t++) {
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
        let e = deep.length ? deep[0] : deepest, bestScore = Infinity;
        for (let t = 0; t < Math.min(deep.length, 1500); t++) {
          const cand = deep[Math.floor(rand() * deep.length)];
          const [cx, cy] = xy(cand);
          const score = Math.hypot(cx - sx, cy - sy) * (0.75 + 0.5 * rand());
          if (score < bestScore) { bestScore = score; e = cand; }
        }
        const [ex, ey] = xy(e);
        axes.push({ sx, sy, ex, ey, strength: 0.7 + 1.0 * rand(), width: (9 + 10 * rand()) / kmAvg });
      }
    }
    const belts = [];
    if (DmaxKm > 60) {
      const r = rand(), nBelts = r < 0.3 ? 0 : r < 0.75 ? 1 : 2;
      for (let i = 0; i < nBelts; i++) belts.push({ depth: DmaxKm * (0.28 + 0.45 * rand()), width: 2.5 + 2 * rand() });
    }
    const att = WM.attackWeights(world, bbox, cells, axes, belts, seed, D, DmaxKm);
    const toWorld = (gx, gy) => [world.x0 + gx * world.cell, world.y0 + gy * world.cell];
    return {
      seed, bbox, att, axes, belts, depthMaxKm: DmaxKm, deepest,
      frontKm0: Math.max(seeds.length * kmAvg * 0.7, 20),
      arrows: axes.map((a) => ({ from: toWorld(a.sx, a.sy), to: toWorld(a.ex, a.ey) })),
    };
  };

  // Per-cell multiplier on attack strength: sector strength, defensive belts,
  // break-in difficulty at the old front and exhaustion with depth.
  WM.attackWeights = function (world, bbox, cells, axes, belts, seed, D, DmaxKm) {
    const { w, kmAvg } = world;
    const att = new Float32Array(bbox.w * bbox.h);
    const nz = WM.makeNoise(seed), nzC = WM.makeNoise(seed + 977);
    for (const c of cells) {
      const x = c % w, y = (c - x) / w;
      const lx = x - bbox.x0, ly = y - bbox.y0;
      if (lx < 0 || ly < 0 || lx >= bbox.w || ly >= bbox.h) continue;
      const X = x * kmAvg, Y = y * kmAvg, Dkm = Math.min(D[c] * kmAvg, DmaxKm);
      const sector = Math.exp(0.4 * nz.fbm(X / 170, Y / 170, 3));
      let axis = 0;
      for (const a of axes) {
        const dx = a.ex - a.sx, dy = a.ey - a.sy, l2 = dx * dx + dy * dy || 1;
        const t = clamp(((x + 0.5 - a.sx) * dx + (y + 0.5 - a.sy) * dy) / l2, 0, 1);
        const dist = Math.hypot(a.sx + t * dx - x - 0.5, a.sy + t * dy - y - 0.5);
        axis += a.strength * Math.exp(-((dist / a.width) ** 2));
      }
      let belt = 1;
      belts.forEach((b, i) => {
        const band = Math.exp(-(((Dkm - b.depth) / b.width) ** 2));
        if (band < 0.01) return;
        const gap = smoothstep(0.22, 0.55, nzC.fbm(X / 55 + 31 * i, Y / 55, 2));
        belt *= 1 - 0.8 * band * (1 - gap);
      });
      const breakIn = 0.55 + 0.45 * smoothstep(0, 12, Dkm);
      const tiring = 1 - 0.3 * (Dkm / DmaxKm);
      att[ly * bbox.w + lx] = sector * (1 + 0.3 * Math.min(axis, 2)) * belt * breakIn * tiring;
    }
    return att;
  };

  const newSide = (s) => ({
    army: WM.START_ARMY[s], army0: WM.START_ARMY[s], killed: 0, wounded: 0, captured: 0,
    morale: WM.START_MORALE[s], area: 0, pop: 0, towns: 0, occupied: 0,
    recovering: 0, fatigue: 0, training: 0, resting: true,
  });
  // New soldiers per day before modifiers: a fixed draft plus the population held.
  WM.RECRUIT_BASE = [0, 400, 650];
  WM.FORT_MEN_PER_KM = 60;
  WM.FORT_BUILD_HOURS = 30;

  // ---------------------------------------------------------------------------
  WM.War = class War {
    constructor(world, opts = {}) {
      this.world = world;
      const N = world.N;
      this.owner = opts.owner || world.owner;
      this.quiet = !!opts.quiet;
      this.prog = new Float32Array(N);
      this.pushBy = [null, new Uint8Array(N), new Uint8Array(N)];
      this.slots = new Array(256).fill(null);
      this.ops = [];
      this.counter = 0;
      this.sides = [null, newSide(1), newSide(2)];
      this.offsets = Int32Array.from(NB.map(([dx, dy]) => dy * world.w + dx));
      // Defense lines: per-cell fortification level (0..1) and owning line.
      this.fort = new Float32Array(N);
      this.fortId = new Int16Array(N);
      this.forts = [];
      this.fortCounter = 0;
      this.weak = [];
      // Recruitment multipliers per side (campaign difficulty).
      this.recruitBonus = [0, 1, 1];
      if (!this.quiet) {
        this.display = new Uint8Array(N);
        this.pocketHours = new Float32Array(N);
        this.labels = new Int32Array(N);
        this.stack = new Int32Array(N);
        this.pocketClock = 0;
        this.provHeld = [null, new Int32Array(world.provinces.length + 1), new Int32Array(world.provinces.length + 1)];
        this.provCtl = new Uint8Array(world.provinces.length + 1);
      }
      this.recount();
    }

    // Territory, population, towns and provinces from the ownership grid.
    recount() {
      const { world, owner } = this;
      for (const s of [1, 2]) Object.assign(this.sides[s], { area: 0, pop: 0, towns: 0, occupied: 0 });
      if (this.provHeld) { this.provHeld[1].fill(0); this.provHeld[2].fill(0); }
      for (const c of world.iranCells) {
        const o = owner[c];
        if (o !== 1 && o !== 2) continue;
        const S = this.sides[o];
        S.area += world.rowArea[(c / world.w) | 0];
        S.pop += world.pop[c];
        if (this.provHeld) this.provHeld[o][world.prov[c]]++;
      }
      for (const t of world.cities) {
        const o = owner[t.cell];
        if (o !== 1 && o !== 2) continue;
        this.sides[o].towns++;
        if (t.orig !== o) this.sides[o].occupied++;
      }
      if (this.provCtl) {
        world.provinces.forEach((p) => {
          this.provCtl[p.id] = this.provHeld[1][p.id] >= p.cells * 0.98 ? 1 : this.provHeld[2][p.id] >= p.cells * 0.98 ? 2 : 0;
        });
      }
      if (this.display) this.refreshDisplay();
    }

    refreshDisplay() {
      for (const c of this.world.iranCells) this.touch(c);
      this.dirty = true;
    }

    // Ownership as the renderer sees it: 0 Blue … 255 Red, with partial
    // capture progress in between so the front moves smoothly.
    touch(c) {
      if (!this.display) return;
      const o = this.owner[c], p = this.prog[c];
      this.display[c] = o === WM.RED ? 255 - ((p * 255) | 0) : o === WM.BLUE ? (p * 255) | 0 : 0;
      this.dirty = true;
    }

    syncHalo() {
      const h = this.world.halo, d = this.display;
      for (let i = 0; i < h.length; i += 2) d[h[i]] = d[h[i + 1]];
    }

    deployed(side) {
      let n = 0;
      for (const op of this.ops) if (op.side === side) n += op.troops;
      return n;
    }
    defending(side) {
      let n = 0;
      for (const op of this.ops) if (op.enemy === side) n += op.defPool;
      return n;
    }
    garrison(side) {
      let n = 0;
      for (const f of this.forts) if (f.side === side) n += f.garrison;
      return n;
    }
    available(side) {
      return Math.max(0, this.sides[side].army - this.deployed(side) - this.defending(side) - this.garrison(side));
    }
    // Length of the front between the two sides, in km.
    frontLength(side) {
      const { world, owner } = this, w = world.w, other = side === 1 ? 2 : 1;
      let n = 0;
      for (const c of world.iranCells) {
        if (owner[c] !== side) continue;
        if (owner[c - 1] === other || owner[c + 1] === other || owner[c - w] === other || owner[c + w] === other) n++;
      }
      return n * world.kmAvg;
    }
    // Campaign defense: the defender pulls a share of its free men into the
    // attacked sector, more for a wide attack on a short front.
    autoDefenders(side, sectorKm) {
      const free = this.available(side);
      const total = Math.max(this.frontLength(side), sectorKm, 50);
      return Math.max(1500, free * clamp((1.7 * sectorKm) / total, 0.1, 0.55));
    }
    // Send more men into a battle, as attackers or defenders.
    reinforce(op, n, side) {
      const add = Math.min(n, this.available(side));
      if (op.ended || add < 500) return 0;
      if (side === op.side) { op.troops += add; op.troops0 += add; }
      else { op.defPool += add; op.defPool0 += add; }
      return add;
    }
    // Men the defender can put into a new sector of the front.
    defendersFor(side, wanted) {
      return Math.min(wanted, Math.max(this.available(side) * 0.8, wanted * 0.25, 0));
    }

    local(op, c) {
      const w = this.world.w, x = c % w, lx = x - op.bx, ly = (c - x) / w - op.by;
      return lx < 0 || ly < 0 || lx >= op.bw || ly >= op.bh ? -1 : ly * op.bw + lx;
    }

    // Iran never touches the edge of the grid, so neighbours of Iran cells
    // need no bounds checks.
    adjacentTo(c, side) {
      const own = this.owner, OFF = this.offsets;
      for (let k = 0; k < 8; k++) if (own[c + OFF[k]] === side) return true;
      return false;
    }

    addFront(op, c) {
      const l = this.local(op, c);
      if (l < 0 || !op.obj[l] || op.inFront[l]) return;
      op.inFront[l] = 1;
      if (op.frontN === op.front.length) {
        const f = new Int32Array(op.front.length * 2);
        f.set(op.front);
        op.front = f;
      }
      op.front[op.frontN++] = c;
    }

    dropFront(op, i) {
      const c = op.front[i];
      op.inFront[this.local(op, c)] = 0;
      op.front[i] = op.front[--op.frontN];
    }

    markPush(side) {
      const P = this.pushBy[side], w = this.world.w;
      P.fill(0);
      for (const op of this.ops) {
        if (op.side !== side || op.ended) continue;
        for (let ly = 0; ly < op.bh; ly++) for (let lx = 0; lx < op.bw; lx++) {
          if (op.obj[ly * op.bw + lx]) P[(op.by + ly) * w + op.bx + lx] = op.slot;
        }
      }
    }

    // ------------------------------------------------------- defense lines ---
    addFort(side, cells, path, facing, km, t) {
      const garrison = Math.round(WM.FORT_MEN_PER_KM * km);
      if (this.available(side) < garrison) return null;
      const id = ++this.fortCounter;
      const f = { id, side, cells: Int32Array.from(cells), path, facing, km, garrison, garrison0: garrison, built: 0, t0: t, alive: 0 };
      for (const c of f.cells) {
        if (this.owner[c] !== side || this.fortId[c]) continue;
        this.fortId[c] = id;
        f.alive++;
      }
      if (!f.alive) return null;
      this.forts.push(f);
      return f;
    }

    buildForts(h) {
      for (const f of this.forts) {
        if (f.built >= 1) continue;
        f.built = Math.min(1, f.built + h / WM.FORT_BUILD_HOURS);
        for (const c of f.cells) if (this.fortId[c] === f.id) this.fort[c] = f.built;
      }
    }

    loseFort(c, t, events) {
      const f = this.forts.find((x) => x.id === this.fortId[c]);
      this.fortId[c] = 0;
      this.fort[c] = 0;
      if (!f) return;
      const lost = f.garrison0 / Math.max(1, f.cells.length);
      f.garrison = Math.max(0, f.garrison - lost);
      f.alive--;
      const S = this.sides[f.side];
      S.army = Math.max(0, S.army - lost);
      S.killed += lost * 0.4;
      S.captured += lost * 0.3;
      S.wounded += lost * 0.3;
      if (!f.breached && events && !this.quiet) {
        f.breached = true;
        const town = this.world.nearestTown((c % this.world.w) + 0.5, Math.floor(c / this.world.w) + 0.5);
        events.push({ t, side: f.side === 1 ? 2 : 1, kind: 'alert', text: `The ${WM.SIDE_NAME[f.side]} defense line near ${town ? town.name : 'the front'} is breached.` });
      }
      if (f.alive <= 0) this.forts = this.forts.filter((x) => x !== f);
    }

    removeFort(id) {
      const f = this.forts.find((x) => x.id === id);
      if (!f) return;
      for (const c of f.cells) if (this.fortId[c] === id) { this.fortId[c] = 0; this.fort[c] = 0; }
      this.forts = this.forts.filter((x) => x !== f);
    }

    // ------------------------------------------------------------- launch ---
    launch(plan, prep, { troops, defense, t, name, defenders }) {
      const world = this.world, w = world.w;
      const side = plan.attacker, enemy = plan.enemy;
      const { x0: bx, y0: by, w: bw, h: bh } = prep.bbox;
      const obj = new Uint8Array(bw * bh);
      const objCells = [];
      for (const c of plan.cells) {
        if (this.owner[c] !== enemy) continue;
        const x = c % w, y = (c - x) / w;
        obj[(y - by) * bw + (x - bx)] = 1;
        objCells.push(c);
      }
      const slot = this.slots.indexOf(null, 1);
      if (!objCells.length || slot < 0) return null;
      const defPool = defenders ?? this.defendersFor(enemy, WM.sectorDefenders(prep, defense));
      const id = ++this.counter;
      const op = {
        slot, id, name: name || CODENAMES[(id - 1) % CODENAMES.length], side, enemy,
        bx, by, bw, bh, obj, objCells: Int32Array.from(objCells), att: prep.att,
        inFront: new Uint8Array(bw * bh), front: new Int32Array(512), frontN: 0,
        troops, troops0: troops, defense, defPool, defPool0: defPool,
        lossAtt: 0, lossDef: 0, killedAtt: 0, killedDef: 0,
        t0: t, lastGain: t, gained: 0, total: objCells.length, remaining: objCells.length,
        frontKm: 0, holdDen: 0, attDen: 0, defBase: 0, counter: null, lastCounter: t,
        seed: prep.seed, noise: WM.makeNoise(prep.seed ^ 0x2545f491), rand: WM.rng(prep.seed ^ 0x9e37),
        axes: prep.axes, belts: prep.belts, depthMaxKm: prep.depthMaxKm, arrows: prep.arrows,
        mode: plan.mode, path: plan.path, extensions: plan.extensions, cities: plan.cities, ended: false,
      };
      this.slots[slot] = op;
      this.ops.push(op);
      for (const c of op.objCells) if (this.adjacentTo(c, side)) this.addFront(op, c);
      op.groups = this.makeGroups(op, prep.axes, prep.deepest, t);
      this.markPush(side);
      return op;
    }

    nextName(offset = 0) {
      return CODENAMES[(this.counter + offset) % CODENAMES.length];
    }

    makeGroups(op, axes, deepest, t) {
      const { w, kmAvg } = this.world;
      const first = op.frontN ? op.front[0] : op.objCells[0];
      const list = axes.length ? axes : [{
        sx: (first % w) + 0.5, sy: Math.floor(first / w) + 0.5,
        ex: (deepest % w) + 0.5, ey: Math.floor(deepest / w) + 0.5, strength: 1,
      }];
      return list.map((a) => ({
        x: a.sx, y: a.sy, tx: a.sx, ty: a.sy, gx: a.ex, gy: a.ey,
        share: a.strength, r: (11 + 9 * op.rand()) / kmAvg, react: 0, gainT: t, retargetT: t,
      }));
    }

    // --------------------------------------------------------------- step ---
    step(dt, t, events) {
      const n = Math.max(1, Math.ceil(dt / STEP));
      const h = dt / n;
      for (let k = 0; k < n; k++) this.tick(h, t + h * k, events);
    }

    tick(h, t, events) {
      for (const op of this.ops) if (!op.ended) this.advance(op, h, t, events);
      for (const op of this.ops) if (!op.ended) this.checkEnd(op, t, events);
      if (this.ops.some((o) => o.ended)) this.ops = this.ops.filter((o) => !o.ended);
      this.buildForts(h);
      if (this.quiet) return;
      for (const s of [1, 2]) {
        const S = this.sides[s];
        let attacking = 0, defending = 0;
        for (const op of this.ops) { if (op.side === s) attacking++; else defending++; }
        // Resting armies train twice as fast and their wounded return sooner.
        S.resting = attacking === 0;
        S.training = (WM.RECRUIT_BASE[s] + 0.0001 * S.pop) * (S.resting ? 2 : 1) * this.recruitBonus[s] * (0.6 + 0.5 * S.morale);
        const back = S.recovering * (S.resting ? 0.08 : 0.04) * (h / 24);
        S.army += (S.training * h) / 24 + back;
        S.recovering -= back;
        // Rest restores readiness; holding the line while not attacking is half a rest.
        S.fatigue += h * (0.004 * attacking + 0.002 * defending) - h * (attacking ? 0.003 : defending ? 0.012 : 0.02);
        S.fatigue = clamp(S.fatigue, 0, 0.9);
        S.morale += (0.8 - S.morale) * h * 0.003;
        S.morale = clamp(S.morale, 0.15, 1.2);
      }
      this.pocketClock += h;
      if (this.pocketClock >= 2) {
        this.updatePockets(this.pocketClock, t, events);
        this.pocketClock = 0;
      }
    }

    advance(op, h, t, events) {
      const world = this.world, own = this.owner, prog = this.prog;
      const { w, kmAvg, defMod, moveMod, rateNoise, rowKm } = world;
      const A = op.side, D = op.enemy, sA = this.sides[A], sD = this.sides[D];
      const pushD = this.pushBy[D], pocket = this.pocketHours;
      const OFF = this.offsets, WGT = WEIGHTS;

      const raw = Math.max(op.frontN * kmAvg * 0.7, 6);
      op.frontKm = op.frontKm > 0 ? op.frontKm + (raw - op.frontKm) * Math.min(1, h * 0.4) : raw;
      op.holdDen = (op.troops * HOLD_SHARE) / op.frontKm;
      op.attDen = op.troops / op.frontKm;
      const groups = op.groups;
      let shares = 0;
      for (const g of groups) shares += g.share;
      for (const g of groups) {
        g.den = (op.troops * (1 - HOLD_SHARE) * g.share) / shares / (2 * g.r * kmAvg);
        g.r2 = g.r * g.r;
        g.q2 = 2.6 * g.r2;
        g.lim = 9 * g.r2;
      }
      const armyD = Math.sqrt(clamp(sD.army / sD.army0, 0.1, 1));
      op.defBase = (op.defPool / op.frontKm) * armyD * (0.75 + 0.35 * sD.morale) * (1 - 0.3 * sD.fatigue) + 4;
      const mA = (0.75 + 0.35 * sA.morale) * (1 - 0.35 * sA.fatigue);
      const fort = this.fort;
      this.weak = this.weak.filter((z) => z.until > t);
      const weak = this.weak.filter((z) => z.side === D);

      let lossA = 0, lossD = 0;
      for (let i = 0; i < op.frontN;) {
        const c = op.front[i];
        if (own[c] !== D) { this.dropFront(op, i); continue; }
        const x = c % w, y = (c - x) / w;
        let nA = 0, counter = 0;
        for (let k = 0; k < 8; k++) {
          const n = c + OFF[k];
          if (own[n] !== A) continue;
          nA += WGT[k];
          const s = pushD[n];
          if (s) { const o2 = this.slots[s]; if (o2 && o2.attDen * 0.7 > counter) counter = o2.attDen * 0.7; }
        }
        if (nA === 0) { this.dropFront(op, i); continue; }
        let focus = 0, react = 0;
        for (const g of groups) {
          const d2 = (x + 0.5 - g.x) ** 2 + (y + 0.5 - g.y) ** 2;
          if (d2 > g.lim) continue;
          focus += g.den * Math.exp(-d2 / g.r2);
          react += g.react * Math.exp(-d2 / g.q2);
        }
        const l = (y - op.by) * op.bw + (x - op.bx);
        const sector = Math.exp(0.35 * op.noise.noise((x * kmAvg) / 80 + t * 0.03, (y * kmAvg) / 80 - t * 0.02));
        const pa = (op.holdDen + focus) * op.att[l] * mA * sector;
        const outflank = 1 + 0.75 * Math.max(0, nA - 2.4);
        const cut = pocket ? 1 - Math.min(0.75, pocket[c] / 72) : 1;
        let shaken = 1;
        for (const z of weak) if ((x - z.gx) ** 2 + (y - z.gy) ** 2 < z.r * z.r) shaken = 0.55;
        const pd = (op.defBase * shaken * (1 + 0.9 * react) * defMod[c] * cut * (1 + 2.6 * fort[c])) / outflank + counter;
        const ratio = pa / pd;
        let gv = 0;
        if (ratio < 0.4) {
          if (prog[c] > 0) { prog[c] = Math.max(0, prog[c] - h * 0.06); this.touch(c); }
        } else {
          gv = Math.max(0.02, (ratio - 0.55) / (ratio + 0.7));
          const speed = Math.min(VMAX_CAP, VMAX * gv * moveMod[c] * clamp(nA / 2.4, 0.35, 1.7) * rateNoise[c]);
          prog[c] += (speed * h) / rowKm[y];
        }
        const m = Math.min(pa, pd);
        lossA += m * (1.15 - 0.5 * gv);
        lossD += m * (0.7 + 0.9 * gv);
        if (prog[c] >= 1) { this.flip(c, A, t, events, op); continue; }
        if (gv) this.touch(c);
        i++;
      }
      this.applyLosses(op, lossA * kmAvg * h * LOSS_RATE, lossD * kmAvg * h * LOSS_RATE, false);
      this.moveGroups(op, h, t, events);
      this.counterAttack(op, h, t, events);
    }

    applyLosses(op, a, d, defenderAttacking) {
      const sA = this.sides[op.side], sD = this.sides[op.enemy];
      a = Math.min(a, op.troops);
      d = Math.min(d, op.defPool);
      op.troops -= a; op.lossAtt += a; op.killedAtt += a * KILLED_SHARE;
      op.defPool -= d; op.lossDef += d; op.killedDef += d * KILLED_SHARE;
      sA.army = Math.max(0, sA.army - a); sA.killed += a * KILLED_SHARE; sA.wounded += a * (1 - KILLED_SHARE);
      sD.army = Math.max(0, sD.army - d); sD.killed += d * KILLED_SHARE; sD.wounded += d * (1 - KILLED_SHARE);
      sA.recovering += a * (1 - KILLED_SHARE) * 0.6;
      sD.recovering += d * (1 - KILLED_SHARE) * 0.6;
      sA.fatigue += (a / Math.max(sA.army, 20000)) * 1.6;
      sD.fatigue += (d / Math.max(sD.army, 20000)) * 1.6;
      sA.morale -= (a / Math.max(sA.army, 1000)) * (defenderAttacking ? 0.9 : 0.5);
      sD.morale -= (d / Math.max(sD.army, 1000)) * 0.7;
    }

    // Battle groups follow their spearhead; when a thrust stalls against the
    // defender's reserves, or reaches its goal, the effort moves elsewhere.
    moveGroups(op, h, t, events) {
      const { w } = this.world;
      for (const g of op.groups) {
        g.react = Math.min(1.5, g.react + h / 26);
        if (t >= g.retargetT && op.frontN) {
          g.retargetT = t + 0.5;
          let best = -1, bestS = Infinity, near = -1, nearD = Infinity;
          const lim = (2.5 * g.r) ** 2;
          for (let i = 0; i < op.frontN; i++) {
            const c = op.front[i], x = (c % w) + 0.5, y = Math.floor(c / w) + 0.5;
            const d2 = (x - g.x) ** 2 + (y - g.y) ** 2;
            if (d2 < nearD) { nearD = d2; near = c; }
            if (d2 > lim) continue;
            const s = Math.hypot(x - g.gx, y - g.gy) + 0.3 * Math.sqrt(d2);
            if (s < bestS) { bestS = s; best = c; }
          }
          const c = best >= 0 ? best : near;
          g.tx = (c % w) + 0.5;
          g.ty = Math.floor(c / w) + 0.5;
        }
        const k = Math.min(1, h * 0.9);
        g.x += (g.tx - g.x) * k;
        g.y += (g.ty - g.y) * k;
        const goalCell = Math.floor(g.gy) * w + Math.floor(g.gx);
        const arrived = this.owner[goalCell] === op.side || Math.hypot(g.x - g.gx, g.y - g.gy) < 3;
        const stalled = t - g.gainT > 9 + 5 * op.rand();
        if ((arrived || stalled) && op.frontN) this.regroup(op, g, t, events, stalled && !arrived);
      }
    }

    regroup(op, g, t, events, stalled) {
      const { w } = this.world;
      const rand = op.rand;
      const before = this.world.nearestTown(g.x, g.y);
      let best = op.front[0], bestS = -Infinity;
      for (let k = 0; k < 40; k++) {
        const c = op.front[Math.floor(rand() * op.frontN)];
        const x = (c % w) + 0.5, y = Math.floor(c / w) + 0.5;
        let md = 60;
        for (const o of op.groups) if (o !== g) md = Math.min(md, Math.hypot(x - o.x, y - o.y));
        const s = md / 60 - 0.45 * (this.world.defMod[c] - 1) + 0.7 * rand();
        if (s > bestS) { bestS = s; best = c; }
      }
      g.x = g.tx = (best % w) + 0.5;
      g.y = g.ty = Math.floor(best / w) + 0.5;
      const L = 14 + 30 * rand();
      let goal = -1, goalS = Infinity;
      for (let k = 0; k < 80; k++) {
        const c = op.objCells[Math.floor(rand() * op.objCells.length)];
        if (this.owner[c] !== op.enemy) continue;
        const s = Math.abs(Math.hypot((c % w) + 0.5 - g.x, Math.floor(c / w) + 0.5 - g.y) - L);
        if (s < goalS) { goalS = s; goal = c; }
      }
      if (goal >= 0) { g.gx = (goal % w) + 0.5; g.gy = Math.floor(goal / w) + 0.5; }
      g.react = 0;
      g.gainT = t;
      g.share = 0.6 + 0.9 * rand();
      if (stalled && events && !this.quiet && rand() < 0.6) {
        const after = this.world.nearestTown(g.x, g.y);
        const side = WM.SIDE_NAME[op.side];
        const text = before && after && before !== after
          ? `${side} attack near ${before.name} stalls; the effort shifts towards ${after.name}.`
          : `${side} attack near ${(before || after || { name: 'the front' }).name} is held. A fresh assault is prepared.`;
        events.push({ t, side: op.side, kind: 'battle', text });
      }
    }

    // Defenders strike the flank of a salient and retake ground for a while.
    counterAttack(op, h, t, events) {
      const world = this.world, { w, h: H, N, kmAvg, defMod, moveMod, rateNoise, rowKm } = world;
      const own = this.owner, prog = this.prog, A = op.side, D = op.enemy, rand = op.rand, OFF = this.offsets;
      if (!op.counter) {
        if (op.defPool < 0.3 * op.defPool0 || t - op.lastCounter < 8 || op.frontN < 12) return;
        const p = 0.03 * h * clamp(op.defBase / (op.holdDen + 1), 0.3, 2.5);
        if (rand() > p) return;
        let best = op.front[0], bestS = -Infinity;
        for (let k = 0; k < 30; k++) {
          const c = op.front[Math.floor(rand() * op.frontN)];
          const x = (c % w) + 0.5, y = Math.floor(c / w) + 0.5;
          let md = Infinity, r = 1;
          for (const g of op.groups) { const d = Math.hypot(x - g.x, y - g.y); if (d < md) { md = d; r = g.r; } }
          const s = -Math.abs(md / r - 2) + rand();
          if (s > bestS) { bestS = s; best = c; }
        }
        let cx = (best % w) + 0.5, cy = Math.floor(best / w) + 0.5;
        for (const [dx, dy] of NB) {
          const n = best + dy * w + dx;
          if (n >= 0 && n < N && own[n] === A) { cx += dx; cy += dy; break; }
        }
        op.counter = { x: cx, y: cy, r: (9 + 8 * rand()) / kmAvg, until: t + 6 + 10 * rand(), den: op.defBase * (1.8 + rand()) };
        if (events && !this.quiet) {
          const town = world.nearestTown(cx, cy);
          events.push({ t, side: D, kind: 'battle', text: `${WM.SIDE_NAME[D]} counter-attacks near ${town ? town.name : 'the front'}.` });
        }
        return;
      }
      const ct = op.counter;
      if (t > ct.until || op.defPool < 0.15 * op.defPool0) { op.counter = null; op.lastCounter = t; return; }
      const R = Math.ceil(ct.r * 2), r2 = ct.r * ct.r;
      const mD = 0.75 + 0.35 * this.sides[D].morale, mA = 0.75 + 0.35 * this.sides[A].morale;
      let lossA = 0, lossD = 0;
      for (let y = Math.max(0, Math.floor(ct.y) - R); y <= Math.min(H - 1, Math.floor(ct.y) + R); y++) {
        for (let x = Math.max(0, Math.floor(ct.x) - R); x <= Math.min(w - 1, Math.floor(ct.x) + R); x++) {
          const c = y * w + x;
          if (own[c] !== A) continue;
          const l = this.local(op, c);
          if (l < 0 || !op.obj[l]) continue;
          const d2 = (x + 0.5 - ct.x) ** 2 + (y + 0.5 - ct.y) ** 2;
          const wgt = Math.exp(-d2 / r2);
          if (wgt < 0.05) continue;
          let nD = 0;
          for (let k = 0; k < 8; k++) if (own[c + OFF[k]] === D) nD += WEIGHTS[k];
          if (!nD) continue;
          let focus = 0;
          for (const g of op.groups) {
            const g2 = (x + 0.5 - g.x) ** 2 + (y + 0.5 - g.y) ** 2;
            if (g2 < g.lim) focus += g.den * Math.exp(-g2 / g.r2);
          }
          const pa = ct.den * wgt * mD;
          const pd = ((op.holdDen + focus) * defMod[c] * mA * 0.8) / (1 + 0.75 * Math.max(0, nD - 2.4));
          const ratio = pa / pd;
          const m = Math.min(pa, pd);
          if (ratio < 0.6) { lossD += m; continue; }
          const gv = (ratio - 0.6) / (ratio + 0.7);
          prog[c] += (Math.min(VMAX_CAP, VMAX * gv * moveMod[c] * clamp(nD / 2.4, 0.35, 1.7) * rateNoise[c]) * h) / rowKm[y];
          lossA += m * (0.7 + 0.9 * gv);
          lossD += m * (1.1 - 0.5 * gv);
          if (prog[c] >= 1) this.flip(c, D, t, events, null);
          else this.touch(c);
        }
      }
      this.applyLosses(op, lossA * kmAvg * h * LOSS_RATE, lossD * kmAvg * h * LOSS_RATE, true);
    }

    // --------------------------------------------------------------- flip ---
    flip(c, A, t, events, byOp) {
      const world = this.world, own = this.owner, { w } = world;
      const D = own[c];
      own[c] = A;
      this.prog[c] = 0;
      if (this.fortId[c]) this.loseFort(c, t, events);
      const a = world.rowArea[(c / w) | 0];
      const sA = this.sides[A], sD = this.sides[D];
      sA.area += a; sD.area -= a;
      sA.pop += world.pop[c]; sD.pop -= world.pop[c];
      if (!this.quiet) {
        this.touch(c);
        const p = world.prov[c];
        this.provHeld[A][p]++;
        this.provHeld[D][p]--;
        const P = world.provinces[p - 1];
        if (this.provCtl[p] !== A && this.provHeld[A][p] >= P.cells * 0.98) {
          // provCtl remembers who last held the whole province
          if (this.provCtl[p] === D) {
            sA.morale += 0.02; sD.morale -= 0.03;
            if (events) events.push({ t, side: A, kind: 'province', text: `${P.name} province is under ${WM.SIDE_NAME[A]} control.` });
          }
          this.provCtl[p] = A;
        }
        const ti = world.townAt[c];
        if (ti) {
          const town = world.cities[ti - 1];
          sA.towns++; sD.towns--;
          if (town.orig === A) sD.occupied--; else sA.occupied++;
          const weight = 0.004 + 0.03 * town.importance;
          sA.morale += weight; sD.morale -= weight * 1.3;
          if (events) {
            const verb = town.orig === A ? 'liberate' : 'occupy';
            events.push({ t, side: A, kind: 'town', text: `${WM.SIDE_NAME[A]} troops ${verb} ${town.name}.` });
          }
        }
      }
      const x = c % w, y = (c - x) / w;
      for (const op of this.ops) {
        if (op.ended) continue;
        const l = this.local(op, c);
        const inObj = l >= 0 && op.obj[l];
        if (op.side === A) {
          if (inObj) { op.remaining--; op.gained += a; }
          if (op === byOp) {
            op.lastGain = t;
            op.lastCell = c;
            for (const g of op.groups) if ((x + 0.5 - g.x) ** 2 + (y + 0.5 - g.y) ** 2 < 2.4 * g.r2) g.gainT = t;
          }
          for (let k = 0; k < 8; k++) {
            const n = c + this.offsets[k];
            if (own[n] === op.enemy) this.addFront(op, n);
          }
        } else if (op.side === D) {
          if (inObj) { op.remaining++; op.gained -= a; }
          if (inObj && this.adjacentTo(c, D)) this.addFront(op, c);
        }
      }
    }

    checkEnd(op, t, events) {
      const done = 1 - op.remaining / op.total;
      // Net progress over the last day; an offensive that no longer gains
      // ground has culminated, even if fighting goes back and forth.
      if (!op.hist) op.hist = [];
      if (!op.hist.length || t - op.hist[op.hist.length - 1][0] >= 3) {
        op.hist.push([t, done]);
        if (op.hist.length > 9) op.hist.shift();
      }
      const ago = op.hist[0];
      op.trend = t - ago[0] > 2 ? ((done - ago[1]) / (t - ago[0])) * 24 : 0.2;
      const culminated = t - op.t0 > 168 && t - ago[0] >= 23 && done - ago[1] < 0.0012;
      if (op.remaining <= 0 || (done >= 0.96 && (t - op.lastGain > 6 || culminated))) return this.endOp(op, 'success', t, events);
      if (culminated) return this.endOp(op, done >= 0.85 ? 'success' : 'stalled', t, events);
      if (op.troops < 0.12 * op.troops0) return this.endOp(op, 'exhausted', t, events);
      if (t - op.lastGain > 168) return this.endOp(op, 'stalled', t, events);
      if (!op.frontN && t - op.lastGain > 3) {
        // Remaining objective cut off from our lines (an island or enclave): land there.
        const { w } = this.world;
        const ref = op.lastCell ?? op.objCells[0];
        const rx = ref % w, ry = Math.floor(ref / w);
        let best = -1, bd = Infinity;
        for (const c of op.objCells) {
          if (this.owner[c] !== op.enemy) continue;
          const d = ((c % w) - rx) ** 2 + (Math.floor(c / w) - ry) ** 2;
          if (d < bd) { bd = d; best = c; }
        }
        if (best >= 0) this.flip(best, op.side, t, events, op);
      }
    }

    endOp(op, reason, t, events) {
      op.ended = true;
      op.endReason = reason;
      op.tEnd = t;
      for (let i = 0; i < op.frontN; i++) {
        const c = op.front[i];
        if (this.owner[c] === op.enemy) { this.prog[c] = 0; this.touch(c); }
      }
      this.slots[op.slot] = null;
      this.markPush(op.side);
      if (!events || this.quiet) return;
      const side = WM.SIDE_NAME[op.side];
      const fmt = (v) => Math.round(v).toLocaleString('en-US');
      const toll = `${side} lost ${fmt(op.lossAtt)} men (${fmt(op.killedAtt)} killed), ${WM.SIDE_NAME[op.enemy]} ${fmt(op.lossDef)} (${fmt(op.killedDef)} killed).`;
      const took = WM.formatKm2(Math.max(0, op.gained));
      const text = {
        success: `Operation ${op.name} achieves its objective: ${took} taken in ${WM.formatDuration(t - op.t0)}. ${toll}`,
        exhausted: `Operation ${op.name} runs out of men after ${WM.formatDuration(t - op.t0)}, holding ${took}. ${toll}`,
        stalled: `Operation ${op.name} bogs down after ${WM.formatDuration(t - op.t0)}, holding ${took}. ${toll}`,
        halted: `Operation ${op.name} is halted after ${WM.formatDuration(t - op.t0)}, holding ${took}. ${toll}`,
      }[reason];
      events.push({ t, side: op.side, kind: 'op', text, opEnd: reason });
    }

    // Calling off an attack is not free: the retreat costs men, and the
    // sector it falls back to is shaken for two days, easy to attack.
    halt(op, t, events) {
      if (!op.ended) {
        const lost = op.troops * 0.08;
        this.applyLosses(op, lost, 0, false);
        const b = this.battles().find((x) => x.op === op);
        if (b) {
          const [x, y] = b.at;
          this.weak.push({ side: op.side, gx: (x - this.world.x0) / this.world.cell, gy: (y - this.world.y0) / this.world.cell, r: 30, until: t + 168 });
        }
        this.endOp(op, 'halted', t, events);
        if (events && !this.quiet && lost > 50) {
          events.push({ t, side: op.side, kind: 'battle', text: `The retreat from Operation ${op.name} costs ${WM.SIDE_NAME[op.side]} ${Math.round(lost).toLocaleString('en-US')} men; the line there is shaken.` });
        }
      }
      this.ops = this.ops.filter((o) => !o.ended);
    }

    // Pull men out of a battle back into the reserve.
    withdraw(op, n, side) {
      if (op.ended) return 0;
      if (side === op.side) {
        const k = Math.max(0, Math.min(n, op.troops - 3000));
        op.troops -= k; op.troops0 = Math.max(op.troops, op.troops0 - k);
        return k;
      }
      const k = Math.max(0, Math.min(n, op.defPool - 1500));
      op.defPool -= k; op.defPool0 = Math.max(op.defPool, op.defPool0 - k);
      return k;
    }

    // Defenders who are winning strike back: a plan to retake the ground this
    // attack has taken. Returns null if it has taken nothing.
    counterPlan(op) {
      const world = this.world, side = op.enemy;
      const mask = new Uint8Array(world.N), cells = [];
      let area = 0;
      for (const c of op.objCells) if (this.owner[c] === op.side) { mask[c] = 1; cells.push(c); area += world.rowArea[(c / world.w) | 0]; }
      if (cells.length < 6) return null;
      return {
        ok: true, attacker: side, enemy: op.side, mode: 'front', mask, cells: Int32Array.from(cells), area,
        cities: world.cities.filter((ct) => mask[ct.cell]).map((ct) => ct.name), provinces: [],
        D: world.distanceFrom(side), path: op.path, extensions: [], canFlip: false, flipped: false,
      };
    }

    // Pockets: territory fully surrounded by the enemy loses supply, fights
    // ever more weakly and finally surrenders.
    updatePockets(dtH, t, events) {
      const world = this.world, own = this.owner, { w, N } = world;
      const labels = this.labels, stack = this.stack;
      for (const S of [1, 2]) {
        const E = S === 1 ? 2 : 1;
        labels.fill(0);
        const comps = [null];
        for (const c0 of world.iranCells) {
          if (own[c0] !== S || labels[c0]) continue;
          const id = comps.length;
          const comp = { size: 0, open: false, sx: 0, sy: 0, hours: 0 };
          comps.push(comp);
          let sp = 0;
          stack[sp++] = c0;
          labels[c0] = id;
          while (sp) {
            const c = stack[--sp], x = c % w;
            comp.size++;
            comp.sx += x;
            comp.sy += (c - x) / w;
            const nbs = [x > 0 ? c - 1 : -1, x < w - 1 ? c + 1 : -1, c - w, c + w];
            for (const n of nbs) {
              if (n < 0 || n >= N) { comp.open = true; continue; }
              const o = own[n];
              if (o === S) { if (!labels[n]) { labels[n] = id; stack[sp++] = n; } } else if (o !== E) comp.open = true;
            }
          }
        }
        let main = 1;
        for (let i = 2; i < comps.length; i++) if (comps[i].size > comps[main].size) main = i;
        for (const c of world.iranCells) {
          if (own[c] !== S) continue;
          const id = labels[c], comp = comps[id];
          if (id !== main && !comp.open) {
            this.pocketHours[c] += dtH;
            comp.hours = Math.max(comp.hours, this.pocketHours[c]);
          } else this.pocketHours[c] = 0;
        }
        for (let i = 1; i < comps.length; i++) {
          const comp = comps[i];
          if (i === main || comp.open) continue;
          const area = comp.size * world.kmAvg * world.kmAvg;
          const town = world.nearestTown(comp.sx / comp.size, comp.sy / comp.size);
          const where = town ? town.name : 'the front';
          if (comp.hours <= dtH + 1e-6 && comp.size >= 25 && events) {
            events.push({ t, side: E, kind: 'pocket', text: `${WM.SIDE_NAME[S]} forces are encircled near ${where} (${WM.formatKm2(area)}).` });
          }
          if (comp.hours >= 30 + area / 250) this.surrender(S, E, i, area, where, t, events);
        }
      }
    }

    surrender(S, E, id, area, where, t, events) {
      const world = this.world, labels = this.labels;
      const prisoners = Math.round(Math.min(this.sides[S].army * 0.5, area * 2.2));
      for (const c of world.iranCells) if (labels[c] === id && this.owner[c] === S) this.flip(c, E, t, events, null);
      const sS = this.sides[S], sE = this.sides[E];
      sS.army -= prisoners;
      sS.captured += prisoners;
      sS.morale -= 0.04;
      sE.morale += 0.03;
      if (events && prisoners >= 200) {
        events.push({ t, side: E, kind: 'pocket', text: `Encircled ${WM.SIDE_NAME[S]} troops near ${where} surrender: ${prisoners.toLocaleString('en-US')} taken prisoner.` });
      }
    }

    // ------------------------------------------------------------- stats ---
    stats() {
      const world = this.world;
      const power = [0, 0, 0];
      for (const s of [1, 2]) {
        const S = this.sides[s];
        power[s] = S.army * (0.55 + 0.45 * S.morale) + S.pop * 0.012 + S.towns * 900;
      }
      const out = [null];
      for (const s of [1, 2]) {
        const S = this.sides[s];
        let provinces = 0;
        if (this.provHeld) world.provinces.forEach((p) => { if (this.provHeld[s][p.id] * 2 >= p.cells) provinces++; });
        out.push({
          ...S, provinces, share: S.area / (this.sides[1].area + this.sides[2].area || 1),
          deployed: this.deployed(s), defending: this.defending(s), available: this.available(s), garrison: this.garrison(s),
          power: power[s] / (power[1] + power[2] || 1),
        });
      }
      return out;
    }

    // Where the fighting is and how many men are in it, for the map. Long
    // fronts are split into sectors (about one per 220 km) and each gets its
    // own count: the holding troops spread along the front plus the battle
    // groups in that sector, against the defenders spread the same way and
    // massed where they react to a thrust.
    battles() {
      const world = this.world, { w } = world, own = this.owner;
      const toWorld = (gx, gy) => [world.x0 + gx * world.cell, world.y0 + gy * world.cell];
      const out = [];
      for (const op of this.ops) {
        if (op.ended || !op.frontN) continue;
        const k = clamp(Math.round(op.frontKm / 220), 1, 6);
        const step = Math.max(1, Math.floor(op.frontN / 600));
        const px = [], py = [];
        for (let i = 0; i < op.frontN; i += step) {
          const c = op.front[i];
          px.push((c % w) + 0.5);
          py.push(Math.floor(c / w) + 0.5);
        }
        const m = px.length;
        // k-means seeded with last frame's sectors so labels stay put
        let cx = op.sectors && op.sectors.length === k ? op.sectors.map((q) => q[0]) : null;
        let cy = cx ? op.sectors.map((q) => q[1]) : null;
        if (!cx) {
          cx = [px[0]]; cy = [py[0]];
          while (cx.length < k) {
            let best = 0, bd = -1;
            for (let i = 0; i < m; i++) {
              let d = Infinity;
              for (let j = 0; j < cx.length; j++) d = Math.min(d, (px[i] - cx[j]) ** 2 + (py[i] - cy[j]) ** 2);
              if (d > bd) { bd = d; best = i; }
            }
            cx.push(px[best]); cy.push(py[best]);
          }
        }
        const lab = new Int8Array(m);
        const count = new Array(k).fill(0);
        for (let it = 0; it < 4; it++) {
          const sx = new Array(k).fill(0), sy = new Array(k).fill(0);
          count.fill(0);
          for (let i = 0; i < m; i++) {
            let bj = 0, bd = Infinity;
            for (let j = 0; j < k; j++) {
              const d = (px[i] - cx[j]) ** 2 + (py[i] - cy[j]) ** 2;
              if (d < bd) { bd = d; bj = j; }
            }
            lab[i] = bj; sx[bj] += px[i]; sy[bj] += py[i]; count[bj]++;
          }
          for (let j = 0; j < k; j++) if (count[j]) { cx[j] = sx[j] / count[j]; cy[j] = sy[j] / count[j]; }
        }
        op.sectors = cx.map((x, j) => [x, cy[j]]);
        // men per sector
        let shares = 0;
        for (const g of op.groups) shares += g.share;
        const att = new Array(k).fill(0), dw = new Array(k).fill(0);
        for (let j = 0; j < k; j++) att[j] = (op.troops * HOLD_SHARE * count[j]) / m;
        for (const g of op.groups) {
          let bj = 0, bd = Infinity;
          for (let j = 0; j < k; j++) {
            const d = (g.x - cx[j]) ** 2 + (g.y - cy[j]) ** 2;
            if (d < bd) { bd = d; bj = j; }
          }
          att[bj] += (op.troops * (1 - HOLD_SHARE) * g.share) / (shares || 1);
          dw[bj] += count[bj] * 0.9 * g.react;
        }
        let dsum = 0;
        for (let j = 0; j < k; j++) { dw[j] += count[j]; dsum += dw[j]; }
        for (let j = 0; j < k; j++) {
          if (!count[j]) continue;
          // anchor on the front: the sampled front cell nearest the sector centre
          let bi = 0, bd = Infinity;
          for (let i = 0; i < m; i++) {
            if (lab[i] !== j) continue;
            const d = (px[i] - cx[j]) ** 2 + (py[i] - cy[j]) ** 2;
            if (d < bd) { bd = d; bi = i; }
          }
          const gx = Math.floor(px[bi]), gy = Math.floor(py[bi]);
          let vx = 0, vy = 0;
          for (let dy = -6; dy <= 6; dy++) for (let dx = -6; dx <= 6; dx++) {
            const o = own[(gy + dy) * w + gx + dx];
            const sgn = o === op.enemy ? 1 : o === op.side ? -1 : 0;
            vx += dx * sgn;
            vy += dy * sgn;
          }
          const len = Math.hypot(vx, vy) || 1;
          out.push({
            op, key: `${op.id}:${j}`, at: toWorld(px[bi], py[bi]), dir: [vx / len, vy / len],
            attackers: Math.round(att[j]), defenders: Math.round((op.defPool * dw[j]) / (dsum || 1)),
          });
        }
      }
      return out;
    }

    // ---------------------------------------------------------- persistence ---
    serialize() {
      const rle = (arr) => {
        const out = [];
        let v = 0, run = 0;
        for (let i = 0; i < arr.length; i++) {
          const b = arr[i] ? 1 : 0;
          if (b === v) run++;
          else { out.push(run); v = b; run = 1; }
        }
        out.push(run);
        return out;
      };
      const r1 = (v) => Math.round(v * 10) / 10;
      return {
        sides: this.sides.slice(1).map((s) => ({ ...s })),
        counter: this.counter,
        fortCounter: this.fortCounter,
        forts: this.forts.map((f) => ({
          id: f.id, side: f.side, cells: Array.from(f.cells), facing: f.facing, km: f.km,
          garrison: f.garrison, garrison0: f.garrison0, built: f.built, t0: f.t0, breached: !!f.breached,
          path: f.path.map(([x, y]) => [r1(x), r1(y)]),
        })),
        ops: this.ops.map((op) => ({
          id: op.id, name: op.name, side: op.side, enemy: op.enemy,
          bbox: { x0: op.bx, y0: op.by, w: op.bw, h: op.bh }, obj: rle(op.obj),
          troops: op.troops, troops0: op.troops0, defense: op.defense, defPool: op.defPool, defPool0: op.defPool0,
          lossAtt: op.lossAtt, lossDef: op.lossDef, killedAtt: op.killedAtt, killedDef: op.killedDef,
          t0: op.t0, lastGain: op.lastGain, gained: op.gained, total: op.total, seed: op.seed,
          axes: op.axes, belts: op.belts, depthMaxKm: op.depthMaxKm, arrows: op.arrows, mode: op.mode, cities: op.cities,
          path: op.path.map(([x, y]) => [r1(x), r1(y)]),
          extensions: (op.extensions || []).map((seg) => seg.map(([x, y]) => [r1(x), r1(y)])),
          groups: op.groups.map((g) => ({ x: g.x, y: g.y, gx: g.gx, gy: g.gy, share: g.share, r: g.r })),
        })),
      };
    }

    restore(data, t) {
      if (!data || !Array.isArray(data.sides)) return;
      data.sides.forEach((s, i) => Object.assign(this.sides[i + 1], s));
      this.counter = data.counter || 0;
      this.fortCounter = data.fortCounter || 0;
      for (const d of data.forts || []) {
        const f = { ...d, cells: Int32Array.from(d.cells), alive: 0 };
        for (const c of f.cells) {
          if (this.owner[c] !== f.side || this.fortId[c]) continue;
          this.fortId[c] = f.id;
          this.fort[c] = f.built;
          f.alive++;
        }
        if (f.alive) this.forts.push(f);
      }
      const world = this.world, w = world.w;
      for (const d of data.ops || []) {
        const { x0: bx, y0: by, w: bw, h: bh } = d.bbox;
        const obj = new Uint8Array(bw * bh);
        let k = 0, v = 0;
        for (const run of d.obj) { if (v) obj.fill(1, k, k + run); k += run; v ^= 1; }
        const objCells = [];
        for (let ly = 0; ly < bh; ly++) for (let lx = 0; lx < bw; lx++) if (obj[ly * bw + lx]) objCells.push((by + ly) * w + bx + lx);
        const slot = this.slots.indexOf(null, 1);
        if (slot < 0 || !objCells.length) continue;
        const D = world.distanceFrom(d.side);
        const att = WM.attackWeights(world, d.bbox, objCells, d.axes, d.belts, d.seed, D, d.depthMaxKm);
        const op = {
          ...d, slot, bx, by, bw, bh, obj, objCells: Int32Array.from(objCells), att,
          inFront: new Uint8Array(bw * bh), front: new Int32Array(512), frontN: 0, remaining: 0,
          frontKm: 0, holdDen: 0, attDen: 0, defBase: 0, counter: null, lastCounter: t,
          noise: WM.makeNoise(d.seed ^ 0x2545f491), rand: WM.rng(d.seed ^ 0x9e37), ended: false,
          groups: d.groups.map((g) => ({ ...g, tx: g.x, ty: g.y, react: 0, gainT: t, retargetT: t })),
        };
        delete op.bbox;
        for (const c of objCells) if (this.owner[c] !== op.side) op.remaining++;
        this.slots[slot] = op;
        this.ops.push(op);
        for (const c of objCells) if (this.owner[c] === op.enemy && this.adjacentTo(c, op.side)) this.addFront(op, c);
      }
      this.markPush(1);
      this.markPush(2);
      this.recount();
    }
  };

  // Runs a planned offensive on its own, on a copy of the map, to forecast how
  // it would go if the enemy launched nothing in the meantime. Runs in slices
  // so the page stays responsive.
  WM.Forecast = class Forecast {
    constructor(war, plan, prep, troops, defense, t, defenders) {
      const world = war.world;
      let f = war.forecaster;
      if (!f) f = war.forecaster = new WM.War(world, { owner: new Uint8Array(world.N), quiet: true });
      f.owner.set(war.owner);
      f.prog.fill(0);
      f.ops = [];
      f.slots.fill(null);
      f.pushBy[1].fill(0);
      f.pushBy[2].fill(0);
      f.fort.set(war.fort);
      f.fortId.fill(0);
      war.sides.forEach((s, i) => { if (s) Object.assign(f.sides[i], s); });
      this.f = f;
      this.t0 = this.t = t;
      this.op = f.launch(plan, prep, { troops, defense, t, name: 'forecast' });
      if (this.op) {
        // Match the defenders the real launch would get, given commitments elsewhere.
        this.op.defPool = this.op.defPool0 = defenders ?? war.defendersFor(plan.enemy, WM.sectorDefenders(prep, defense));
      }
      this.done = !this.op;
    }

    run(budgetMs) {
      const start = performance.now();
      const limit = this.t0 + 24 * 40;
      let n = 0;
      while (!this.done) {
        this.f.tick(STEP, this.t, null);
        this.t += STEP;
        if (this.op.ended || this.t >= limit) this.done = true;
        if (++n % 20 === 0 && performance.now() - start > budgetMs) break;
      }
      return this.done;
    }

    result() {
      const op = this.op;
      if (!op) return null;
      return {
        hours: this.t - this.t0, reason: op.ended ? op.endReason : 'ongoing',
        progress: 1 - op.remaining / op.total, lossAtt: op.lossAtt, lossDef: op.lossDef,
        killedAtt: op.killedAtt, killedDef: op.killedDef, defenders: op.defPool0,
      };
    }
  };

  WM.forecast = function (war, plan, prep, troops, defense, t) {
    const f = new WM.Forecast(war, plan, prep, troops, defense, t);
    while (!f.run(1e9));
    return f.result();
  };

  // Men the defender would like to hold a planned sector with.
  WM.sectorDefenders = (prep, defense) => WM.defenseDensity(defense) * prep.frontKm0 * (1 + prep.depthMaxKm / 90);
})(window.WM);
