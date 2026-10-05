// Computer opponent for the campaign. It thinks once per game hour: sends
// reserves to sectors where it is outnumbered, halts offensives that are
// failing, launches new offensives at towns near the front when it has men to
// spare, and digs defense lines in front of threatened towns.
(function (WM) {
  'use strict';
  const { clamp, lerp } = WM;

  WM.DIFFICULTY = {
    easy: { label: 'Easy', maxOps: 1, commit: [0.35, 0.5], gap: [300, 520], reinforce: 0.35, recruit: 0.8, fortEvery: 220, firstAttack: 40 },
    normal: { label: 'Normal', maxOps: 2, commit: [0.45, 0.65], gap: [180, 340], reinforce: 0.7, recruit: 1.0, fortEvery: 120, firstAttack: 24 },
    hard: { label: 'Hard', maxOps: 3, commit: [0.55, 0.75], gap: [110, 220], reinforce: 1.0, recruit: 1.3, fortEvery: 70, firstAttack: 12 },
  };
  const fmt = (v) => Math.round(Math.max(0, v)).toLocaleString('en-US');

  WM.AI = class AI {
    constructor(war, planner, side, level, state) {
      this.war = war;
      this.world = war.world;
      this.planner = planner;
      this.side = side;
      this.enemy = side === WM.BLUE ? WM.RED : WM.BLUE;
      this.level = WM.DIFFICULTY[level] ? level : 'normal';
      this.cfg = WM.DIFFICULTY[this.level];
      this.rand = WM.rng((Math.random() * 1e9) | 0);
      this.reinforced = new Map();
      this.nextThink = 0;
      this.nextAttack = state && state.nextAttack != null ? state.nextAttack : null;
      this.nextFort = state && state.nextFort != null ? state.nextFort : null;
      war.recruitBonus[side] = this.cfg.recruit;
    }

    save() {
      return { nextAttack: this.nextAttack, nextFort: this.nextFort };
    }

    update(t, events) {
      if (t < this.nextThink) return;
      this.nextThink = t + 1;
      const cfg = this.cfg;
      if (this.nextAttack == null) this.nextAttack = t + cfg.firstAttack * (0.7 + 0.6 * this.rand());
      if (this.nextFort == null) this.nextFort = t + cfg.fortEvery * (0.4 + 0.6 * this.rand());
      this.defend(t, events);
      this.manage(t, events);
      if (t >= this.nextAttack) {
        this.nextAttack = this.attack(t, events) ? t + lerp(cfg.gap[0], cfg.gap[1], this.rand()) : t + 6;
      }
      if (t >= this.nextFort) {
        this.fortify(t, events);
        this.nextFort = t + cfg.fortEvery * (0.6 + 0.8 * this.rand());
      }
    }

    // Rush reserves into sectors where the enemy clearly outnumbers us, and
    // strike back where our defenders clearly outnumber the attacker.
    defend(t, events) {
      const war = this.war;
      for (const op of war.ops.slice()) {
        if (op.enemy !== this.side || op.ended || op.countered) continue;
        if (t - op.t0 > 72 && op.defPool > 1.5 * op.troops && op.gained > 300 && this.rand() < 0.15 * this.cfg.reinforce) {
          const plan = war.counterPlan(op);
          if (!plan) continue;
          op.countered = true;
          const troops = Math.round(op.defPool * 0.5);
          op.defPool -= troops; op.defPool0 -= troops;
          const seed = (this.rand() * 1e6) | 0;
          const c = war.launch(plan, WM.prepareOperation(this.world, plan, seed), { troops, defense: null, defenders: Math.max(1500, op.troops * 0.6), t });
          if (c) events.push({ t, side: this.side, kind: 'alert', opStart: c.id, text: `Enemy counter-attack! Operation ${c.name}: ${fmt(troops)} ${WM.SIDE_NAME[this.side]} troops strike back against Operation ${op.name}.` });
        }
      }
      for (const op of war.ops) {
        if (op.enemy !== this.side || op.ended) continue;
        if (t - (this.reinforced.get(op.id) ?? -1e9) < 10) continue;
        if (op.troops / Math.max(op.defPool, 1) < 1.25) continue;
        this.reinforced.set(op.id, t);
        if (this.rand() > this.cfg.reinforce) continue;
        const want = Math.min(war.available(this.side) * 0.4, op.troops * 0.8 - op.defPool);
        if (want < 3000) continue;
        const n = war.reinforce(op, want, this.side);
        if (n) {
          events.push({ t, side: this.side, kind: 'battle', text: `${WM.SIDE_NAME[this.side]} rushes ${fmt(n)} reserves to stop Operation ${op.name}.` });
        }
      }
    }

    // Halt offensives that are bleeding to death; feed ones that are working.
    manage(t, events) {
      const war = this.war;
      for (const op of war.ops.slice()) {
        if (op.side !== this.side || op.ended) continue;
        const trend = op.trend ?? 0.2;
        // stuck against far stronger defenders: call it off, as a player would
        const outmatched = t - op.t0 > 96 && op.troops < 0.6 * op.defPool && trend < 0.002;
        if ((t - op.t0 > 120 && op.troops < 0.3 * op.troops0 && trend < 0.002) || outmatched) {
          war.halt(op, t, events);
        } else if (trend > 0.01 && t - (this.reinforced.get(op.id) ?? -1e9) > 24 && war.available(this.side) > 40000 && this.rand() < 0.3 * this.cfg.reinforce) {
          this.reinforced.set(op.id, t);
          war.reinforce(op, op.troops0 * 0.2, this.side);
        }
      }
    }

    attack(t, events) {
      const war = this.war, world = this.world, side = this.side;
      if (war.ops.filter((o) => o.side === side).length >= this.cfg.maxOps) return false;
      const free = war.available(side);
      if (free < 15000 || war.sides[side].fatigue > 0.6) return false;
      const D = world.distanceFrom(side);
      for (let attempt = 0; attempt < 3; attempt++) {
        const target = this.pickTarget(D);
        if (!target) return false;
        const path = this.makePath(target, D);
        if (!path) continue;
        const seed = (this.rand() * 1e6) | 0;
        const plan = this.planner.plan(side, path, false, seed);
        if (!plan.ok || plan.area < 400 || plan.area > war.sides[this.enemy].area * 0.3) continue;
        const prep = WM.prepareOperation(world, plan, seed);
        const share = lerp(this.cfg.commit[0], this.cfg.commit[1], this.rand());
        // enough men for the size of the objective, not the whole reserve
        const need = Math.max(15000, prep.frontKm0 * 220 + plan.area * 2);
        const troops = Math.round(clamp(Math.min(free * share, need), 10000, free * 0.85) / 1000) * 1000;
        const defenders = war.autoDefenders(this.enemy, prep.frontKm0);
        const op = war.launch(plan, prep, { troops, defense: null, defenders, t });
        if (!op) continue;
        events.push({
          t, side, kind: 'alert', opStart: op.id,
          text: `Enemy offensive! Operation ${op.name}: ${fmt(troops)} ${WM.SIDE_NAME[side]} troops attack towards ${target.name}.`,
        });
        return true;
      }
      return false;
    }

    // Enemy towns within reach, weighted by size and by whether they were ours.
    pickTarget(D) {
      const { world, war, enemy, side } = this;
      let best = null, bestS = 0;
      for (const town of world.cities) {
        if (war.owner[town.cell] !== enemy) continue;
        const d = D[town.cell];
        if (d < 2 || d > 70) continue;
        let score = (0.4 + town.importance) / (1 + d / 25);
        if (town.orig === side) score *= 1.8;
        score *= 0.6 + 0.8 * this.rand();
        if (score > bestS) { bestS = score; best = { cell: town.cell, name: town.name, d }; }
      }
      if (best) return best;
      // no town in reach: any enemy ground 25–80 km behind the front
      const cells = world.iranCells;
      for (let k = 0; k < 3000; k++) {
        const c = cells[Math.floor(this.rand() * cells.length)];
        if (war.owner[c] === enemy && D[c] > 12 && D[c] < 40) {
          const town = world.nearestTown((c % world.w) + 0.5, Math.floor(c / world.w) + 0.5);
          return { cell: c, name: town ? town.name : 'the interior', d: D[c] };
        }
      }
      return null;
    }

    // Either an arc from our lines around the target and back (a front-line
    // offensive) or an arrow at it (a thrust). Returns world coordinates.
    makePath(target, D) {
      const { world, war, side, enemy } = this, { w } = world;
      const tx = (target.cell % w) + 0.5, ty = Math.floor(target.cell / w) + 0.5;
      const R = Math.max(30, target.d * 2.2);
      const border = [];
      for (const c of world.iranCells) {
        if (war.owner[c] !== side) continue;
        if (war.owner[c - 1] !== enemy && war.owner[c + 1] !== enemy && war.owner[c - w] !== enemy && war.owner[c + w] !== enemy) continue;
        const x = (c % w) + 0.5, y = Math.floor(c / w) + 0.5;
        if (Math.hypot(x - tx, y - ty) <= R) border.push([x, y]);
      }
      if (!border.length) return null;
      let n0 = border[0], nd = Infinity;
      for (const p of border) { const d = Math.hypot(p[0] - tx, p[1] - ty); if (d < nd) { nd = d; n0 = p; } }
      const dl = Math.hypot(tx - n0[0], ty - n0[1]) || 1;
      const dir = [(tx - n0[0]) / dl, (ty - n0[1]) / dl], perp = [-dir[1], dir[0]];
      const toWorld = ([gx, gy]) => [world.x0 + gx * world.cell, world.y0 + gy * world.cell];
      const width = clamp(target.d * 1.4, 20, 70);
      if (this.rand() < 0.55 && border.length > 10) {
        let a = null, b = null, amax = -Infinity, bmin = Infinity;
        for (const p of border) {
          const along = (p[0] - n0[0]) * perp[0] + (p[1] - n0[1]) * perp[1];
          if (Math.abs(along) > width) continue;
          if (along > amax) { amax = along; a = p; }
          if (along < bmin) { bmin = along; b = p; }
        }
        if (a && b && Math.hypot(a[0] - b[0], a[1] - b[1]) > 10) {
          // quadratic curve from a to b passing just beyond the target
          const tip = [tx + dir[0] * 4, ty + dir[1] * 4];
          const ctrl = [2 * tip[0] - (a[0] + b[0]) / 2, 2 * tip[1] - (a[1] + b[1]) / 2];
          const pts = [];
          for (let i = 0; i <= 24; i++) {
            const s = i / 24, u = 1 - s;
            pts.push([u * u * a[0] + 2 * u * s * ctrl[0] + s * s * b[0], u * u * a[1] + 2 * u * s * ctrl[1] + s * s * b[1]]);
          }
          return pts.map(toWorld);
        }
      }
      const p0 = [n0[0] - dir[0] * 4, n0[1] - dir[1] * 4], p1 = [tx + dir[0] * 6, ty + dir[1] * 6];
      const pts = [];
      for (let i = 0; i <= 12; i++) pts.push([lerp(p0[0], p1[0], i / 12), lerp(p0[1], p1[1], i / 12)]);
      return pts.map(toWorld);
    }

    // A defense line between the enemy and our most valuable town near the front.
    fortify(t, events) {
      const { war, world, side, enemy } = this, { w } = world;
      const free = war.available(side);
      if (free < 20000 || war.forts.filter((f) => f.side === side).length >= 6) return;
      const De = world.distanceFrom(enemy);
      let town = null, best = 0;
      for (const tw of world.cities) {
        if (war.owner[tw.cell] !== side || war.fortId[tw.cell]) continue;
        const d = De[tw.cell];
        if (d < 8 || d > 40) continue;
        const s = (0.3 + tw.importance) * (0.7 + 0.6 * this.rand());
        if (s > best) { best = s; town = tw; }
      }
      if (!town) return;
      const px = town.cell % w, py = Math.floor(town.cell / w);
      const at = (x, y) => De[y * w + x];
      // direction away from the enemy, and the line across it
      const gx = at(px + 3, py) - at(px - 3, py), gy = at(px, py + 3) - at(px, py - 3);
      const gl = Math.hypot(gx, gy) || 1;
      const tan = [-gy / gl, gx / gl];
      const depth = clamp(De[town.cell] * 0.5, 4, 14);
      const pts = [];
      for (let y = py - 35; y <= py + 35; y++) {
        for (let x = px - 35; x <= px + 35; x++) {
          const c = y * w + x;
          if (war.owner[c] !== side || Math.abs(De[c] - depth) > 0.7 || Math.hypot(x - px, y - py) > 35) continue;
          pts.push([x + 0.5, y + 0.5, (x - px) * tan[0] + (y - py) * tan[1]]);
        }
      }
      if (pts.length < 12) return;
      pts.sort((a, b) => a[2] - b[2]);
      const line = [];
      for (let i = 0; i < pts.length; i += 3) {
        // average neighbours for a smooth line
        let sx = 0, sy = 0, n = 0;
        for (let j = Math.max(0, i - 3); j <= Math.min(pts.length - 1, i + 3); j++) { sx += pts[j][0]; sy += pts[j][1]; n++; }
        line.push([world.x0 + (sx / n) * world.cell, world.y0 + (sy / n) * world.cell]);
      }
      const f = this.planner.fortLine(side, line, (this.rand() * 1e6) | 0);
      if (!f.ok || f.garrison > free * 0.4) return;
      if (war.addFort(side, f.cells, f.path, f.facing, f.km, t)) {
        events.push({ t, side, kind: 'battle', text: `${WM.SIDE_NAME[side]} is digging a defense line in front of ${town.name}.` });
      }
    }
  };
})(window.WM);
