// Battlefield effects: shell bursts along active fronts, on their own canvas
// between the map and the labels. Each burst is a short ground flash, a
// fireball, a dust shock ring and flying debris, then a column of dust and
// smoke that spreads and drifts with the wind, leaving a fading scorch mark.
// Fire is heaviest where battle groups and counter-attacks are fighting.
// Positions live in world px; sizes in km, clamped to a visible screen size.
(function (WM) {
  'use strict';
  const { clamp } = WM;

  const MAX_LIVE = 520;
  const MAX_SCORCH = 700;

  // Billowing smoke or dust: clustered blobs, then torn up by noise so the
  // edges are wispy, with light on one side and shadow on the other.
  const puffSprite = (rgb, seed) => {
    const S = 128, c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d'), rand = WM.rng(seed), nz = WM.makeNoise(seed * 7 + 3);
    for (let i = 0; i < 64; i++) {
      const gauss = () => (rand() + rand() + rand() - 1.5) / 1.5;
      const x = S / 2 + gauss() * S * 0.2, y = S / 2 + gauss() * S * 0.2, r = S * (0.05 + 0.12 * rand());
      const gr = g.createRadialGradient(x, y, 0, x, y, r);
      const al = 0.12 + 0.2 * rand();
      gr.addColorStop(0, `rgba(255,255,255,${al})`);
      gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr;
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
    const im = g.getImageData(0, 0, S, S), d = im.data;
    const [R, G, B] = rgb;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const n = nz.fbm(x / 18, y / 18, 4);
      const rr = Math.hypot(x - S / 2, y - S / 2) / (S / 2);
      const edge = clamp(1.25 - rr * 1.15 + 0.35 * n, 0, 1);
      const shade = 0.82 + 0.3 * ((S - x - y) / (2 * S)) + 0.18 * nz.fbm(x / 9 + 40, y / 9, 2);
      d[i] = clamp(R * shade, 0, 255); d[i + 1] = clamp(G * shade, 0, 255); d[i + 2] = clamp(B * shade, 0, 255);
      d[i + 3] = clamp(d[i + 3] * edge * (0.7 + 0.6 * (n * 0.5 + 0.5)) * 1.6, 0, 255);
    }
    g.putImageData(im, 0, 0);
    return c;
  };
  // Fireball: a ragged ball whose colour follows temperature, white-hot in
  // the middle through yellow and orange to a dull red rim.
  const fireSprite = (seed) => {
    const S = 96, c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d'), nz = WM.makeNoise(seed * 13 + 1);
    const im = g.createImageData(S, S), d = im.data;
    const ramp = [[0, [110, 20, 0, 0]], [0.18, [170, 45, 8, 0.55]], [0.4, [240, 110, 25, 0.85]], [0.65, [255, 190, 80, 0.95]], [0.85, [255, 238, 170, 1]], [1, [255, 252, 238, 1]]];
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const rr = Math.hypot(x - S / 2, y - S / 2) / (S / 2);
      const n = nz.fbm(x / 12, y / 12, 3);
      const t = clamp(1 - rr * (1 + 0.45 * n), 0, 1);
      let k = 0;
      while (k < ramp.length - 2 && t > ramp[k + 1][0]) k++;
      const [t0, c0] = ramp[k], [t1, c1] = ramp[k + 1], u = clamp((t - t0) / (t1 - t0), 0, 1);
      for (let j = 0; j < 3; j++) d[i + j] = c0[j] + (c1[j] - c0[j]) * u;
      d[i + 3] = 255 * (c0[3] + (c1[3] - c0[3]) * u);
    }
    g.putImageData(im, 0, 0);
    return c;
  };
  const glowSprite = (stops) => {
    const S = 64, c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    const gr = g.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
    for (const [o, col] of stops) gr.addColorStop(o, col);
    g.fillStyle = gr;
    g.fillRect(0, 0, S, S);
    return c;
  };
  // Scorched, cratered earth: dark and blotchy, never a clean circle.
  const scorchSprite = (seed) => {
    const S = 64, c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d'), nz = WM.makeNoise(seed * 5 + 11);
    const im = g.createImageData(S, S), d = im.data;
    for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
      const i = (y * S + x) * 4;
      const rr = Math.hypot(x - S / 2, y - S / 2) / (S / 2);
      const n = nz.fbm(x / 8, y / 8, 3);
      const a = clamp(1 - rr * (1 + 0.6 * n), 0, 1);
      d[i] = 18; d[i + 1] = 13; d[i + 2] = 9;
      d[i + 3] = 255 * Math.min(1, a * 1.4) * (0.6 + 0.4 * (n * 0.5 + 0.5));
    }
    g.putImageData(im, 0, 0);
    return c;
  };

  WM.Effects = class Effects {
    constructor(canvas, world) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.world = world;
      this.live = [];
      this.scorch = [];
      this.queue = [];      // delayed shells of a salvo
      this.clock = 0;
      this.carry = new Map(); // fractional spawns per operation
      this.wind = Math.random() * Math.PI * 2;
      this.rand = Math.random;
      this.reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
      this.sprites = {
        dust: [puffSprite([150, 132, 106], 1), puffSprite([132, 118, 98], 2)],
        smoke: [puffSprite([128, 128, 130], 3), puffSprite([100, 100, 104], 4)],
        dark: [puffSprite([40, 37, 36], 5), puffSprite([58, 54, 52], 6)],
        fire: [fireSprite(1), fireSprite(2), fireSprite(3)],
        light: glowSprite([[0, 'rgba(255,200,120,0.6)'], [0.35, 'rgba(255,150,70,0.2)'], [1, 'rgba(255,120,40,0)']]),
        ring: glowSprite([[0, 'rgba(225,210,185,0)'], [0.62, 'rgba(225,210,185,0)'], [0.84, 'rgba(225,210,185,0.55)'], [1, 'rgba(225,210,185,0)']]),
        scorch: [scorchSprite(1), scorchSprite(2), scorchSprite(3)],
      };
      this.dirty = false;
    }

    resize(cssW, cssH, dpr) {
      const W = Math.round(cssW * dpr), H = Math.round(cssH * dpr);
      if (this.canvas.width !== W || this.canvas.height !== H) {
        this.canvas.width = W;
        this.canvas.height = H;
      }
      this.dirty = true;
    }

    clear() {
      this.live.length = 0;
      this.scorch.length = 0;
      this.queue.length = 0;
      this.dirty = true;
    }

    // dt: real seconds. firing: the war is running. pace: game hours per real second.
    update(dt, view, war, firing, pace) {
      this.clock += dt;
      this.wind += (this.rand() - 0.5) * dt * 0.05;
      const world = this.world, { w } = world, cell = world.cell;
      if (firing && war.ops.length) {
        // Visible part of the map, with a margin, in grid cells.
        const gx0 = (view.x0 - world.x0) / cell - 4, gx1 = (view.x1 - world.x0) / cell + 4;
        const gy0 = (view.y0 - world.y0) / cell - 4, gy1 = (view.y1 - world.y0) / cell + 4;
        const tempo = clamp(Math.sqrt(pace / 0.1), 0.6, 2.2) * (this.reduced ? 0.3 : 1);
        for (const op of war.ops) {
          if (op.ended || !op.frontN) continue;
          // Guns per km of front grow with the men fighting there.
          const men = Math.min(op.troops, op.defPool * 1.6) + 0.3 * Math.max(op.troops, op.defPool);
          const perKm = clamp(Math.sqrt(men) / 900, 0.01, 0.06);
          const want = perKm * op.frontKm * tempo * dt + (this.carry.get(op) || 0);
          let n = Math.floor(want);
          this.carry.set(op, want - n);
          for (let tries = 0; n > 0 && tries < n * 3 + 6; tries++) {
            const at = this.pickSpot(op, w);
            if (!at) continue;
            const [gx, gy] = at;
            if (gx < gx0 || gx > gx1 || gy < gy0 || gy > gy1) { n--; continue; }
            this.salvo(gx, gy, op);
            n--;
          }
        }
        for (const op of this.carry.keys()) if (op.ended) this.carry.delete(op);
      }
      // Shells of a salvo arrive a moment apart.
      for (let i = this.queue.length - 1; i >= 0; i--) {
        const q = this.queue[i];
        if (this.clock >= q.at) { this.spawn(q.x, q.y, q.heavy); this.queue.splice(i, 1); }
      }
      // Retire finished bursts and old scorch marks.
      let j = 0;
      for (const e of this.live) if (this.clock - e.t0 < e.life) this.live[j++] = e;
      this.live.length = j;
      j = 0;
      for (const s of this.scorch) if (this.clock - s.t0 < s.life) this.scorch[j++] = s;
      this.scorch.length = j;
      this.dirty = this.dirty || this.live.length > 0 || this.scorch.length > 0;
    }

    // Most fire falls where battle groups press or a counter-attack strikes;
    // the rest is spread along the whole front.
    pickSpot(op, w) {
      const r = this.rand();
      let c;
      if (r < 0.5 && op.groups && op.groups.length) {
        const g = op.groups[Math.floor(this.rand() * op.groups.length)];
        let best = -1, bd = Infinity;
        for (let k = 0; k < 10; k++) {
          const cc = op.front[Math.floor(this.rand() * op.frontN)];
          const d = ((cc % w) + 0.5 - g.x) ** 2 + (Math.floor(cc / w) + 0.5 - g.y) ** 2;
          if (d < bd) { bd = d; best = cc; }
        }
        c = best;
      } else if (r < 0.62 && op.counter) {
        const ct = op.counter, a = this.rand() * Math.PI * 2, d = Math.sqrt(this.rand()) * ct.r * 1.2;
        return [ct.x + Math.cos(a) * d, ct.y + Math.sin(a) * d];
      } else c = op.front[Math.floor(this.rand() * op.frontN)];
      if (c == null || c < 0) return null;
      // Shells land around the line: mostly on the defender's positions,
      // some on the attacker's (counter-battery fire).
      const jx = (this.rand() - 0.5) * 4.5, jy = (this.rand() - 0.5) * 4.5;
      return [(c % w) + 0.5 + jx, Math.floor(c / w) + 0.5 + jy];
    }

    salvo(gx, gy, op) {
      const world = this.world;
      const x = world.x0 + gx * world.cell, y = world.y0 + gy * world.cell;
      const heavy = this.rand() < 0.1;
      const shells = this.rand() < 0.3 ? 2 + Math.floor(this.rand() * 4) : 1;
      this.spawn(x, y, heavy);
      for (let i = 1; i < shells; i++) {
        const a = this.rand() * Math.PI * 2, d = (0.3 + this.rand()) * world.cell * 0.5;
        this.queue.push({ at: this.clock + i * (0.07 + 0.18 * this.rand()), x: x + Math.cos(a) * d, y: y + Math.sin(a) * d, heavy });
      }
    }

    spawn(x, y, heavy) {
      if (this.live.length >= MAX_LIVE) return;
      const rand = this.rand;
      const sparks = [];
      const nS = heavy ? 14 : 8;
      for (let i = 0; i < nS; i++) {
        const a = rand() * Math.PI * 2;
        sparks.push({ dx: Math.cos(a), dy: Math.sin(a), v: 2 + 4 * rand(), life: 0.2 + 0.5 * rand(), w: 0.5 + rand() });
      }
      const fires = [];
      for (let i = 0, n = heavy ? 4 : 3; i < n; i++) {
        const a = rand() * Math.PI * 2, d = i ? 0.25 + 0.35 * rand() : 0;
        fires.push({ ox: Math.cos(a) * d, oy: Math.sin(a) * d, s: i ? 0.5 + 0.4 * rand() : 1, k: Math.floor(rand() * 3), delay: i * 0.03 * rand(), rot: rand() * 6.28 });
      }
      const puffs = [];
      for (let i = 0, n = heavy ? 7 : 5; i < n; i++) {
        const a = rand() * Math.PI * 2;
        puffs.push({
          ox: Math.cos(a) * 0.55 * rand(), oy: Math.sin(a) * 0.55 * rand(), grow: 1.5 + 1.7 * rand(),
          delay: i * 0.04 + 0.08 * rand(), rot: (rand() - 0.5) * 1.2, k: Math.floor(rand() * 2), rise: 0.6 + 0.8 * rand(),
        });
      }
      this.live.push({
        x, y, t0: this.clock, heavy, km: (heavy ? 0.75 : 0.42) * (0.75 + 0.5 * rand()),
        life: heavy ? 9 + 4 * rand() : 5 + 3 * rand(), sparks, fires, puffs,
      });
      if (this.scorch.length >= MAX_SCORCH) this.scorch.shift();
      this.scorch.push({ x, y, t0: this.clock, life: 30 + 20 * rand(), km: (heavy ? 0.6 : 0.36) * (0.8 + 0.4 * rand()), rot: rand() * 6.28, k: Math.floor(rand() * 3) });
    }

    draw(view) {
      if (!this.dirty) return;
      const ctx = this.ctx, { dpr, scale } = view;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      this.dirty = false;
      if (!this.live.length && !this.scorch.length) return;
      const world = this.world;
      const pxPerKm = (scale * world.cell) / world.kmAvg;
      const W = view.w, H = view.h, now = this.clock, S = this.sprites;
      // Bursts are drawn larger than life so they read at campaign zoom levels.
      const size = (km) => clamp(km * pxPerKm * 2.4, 2, 26);
      const wind = this.wind, wx = Math.cos(wind), wy = Math.sin(wind);
      const off = (sx, sy, m) => sx < -m || sy < -m || sx > W + m || sy > H + m;
      // Sprite centred at (x, y), radius r, turned by rot and stretched by k along it.
      const put = (sp, x, y, r, alpha, rot = 0, k = 1) => {
        if (alpha <= 0.004 || r <= 0.2) return;
        ctx.globalAlpha = Math.min(1, alpha);
        const c = Math.cos(rot) * dpr, s = Math.sin(rot) * dpr;
        ctx.setTransform(c * k, s * k, -s, c, x * dpr, y * dpr);
        ctx.drawImage(sp, -r, -r, 2 * r, 2 * r);
      };

      // Scorched ground first, under everything.
      ctx.globalCompositeOperation = 'source-over';
      for (const s of this.scorch) {
        const sx = (s.x - view.x0) * scale, sy = (s.y - view.y0) * scale;
        if (off(sx, sy, 30)) continue;
        const age = (now - s.t0) / s.life;
        put(S.scorch[s.k], sx, sy, size(s.km), 0.55 * Math.min(1, (now - s.t0) * 3) * (1 - age) ** 2, s.rot);
      }

      // Dust thrown up first, then a smoke column that spreads, thins and
      // is drawn out downwind.
      for (const e of this.live) {
        const sx = (e.x - view.x0) * scale, sy = (e.y - view.y0) * scale;
        if (off(sx, sy, 90)) continue;
        const r = size(e.km), a = now - e.t0, life = e.life;
        for (const p of e.puffs) {
          const t = a - p.delay;
          if (t <= 0) continue;
          const u = t / (life - p.delay);
          if (u >= 1) continue;
          const R = r * (0.6 + p.grow * (1 - Math.exp(-t * 2.2)) + 0.7 * u);
          const drift = r * 0.32 * t * p.rise;
          const x = sx + p.ox * r + wx * drift, y = sy + p.oy * r + wy * drift;
          const alpha = (e.heavy ? 0.8 : 0.66) * Math.min(1, t * 8) * (1 - u) ** 1.6;
          const stretch = 1 + 0.9 * Math.min(1, t / 4);
          const dustW = clamp(1 - t / 1.4, 0, 1);
          const smoke = e.heavy ? S.dark[p.k] : S.smoke[p.k];
          put(S.dust[p.k], x, y, R, alpha * dustW, wind + p.rot, stretch);
          put(smoke, x, y, R, alpha * (1 - dustW), wind + p.rot, stretch);
        }
      }

      // Fire, light and sparks, added on top.
      ctx.globalCompositeOperation = 'lighter';
      for (const e of this.live) {
        const a = now - e.t0;
        if (a > 0.9) continue;
        const sx = (e.x - view.x0) * scale, sy = (e.y - view.y0) * scale;
        if (off(sx, sy, 60)) continue;
        const r = size(e.km);
        if (a < 0.2) put(S.light, sx, sy, r * (e.heavy ? 6.5 : 5), (1 - a / 0.2) ** 2);
        const fb = e.heavy ? 0.5 : 0.34;
        for (const f of e.fires) {
          const t = a - f.delay;
          if (t < 0 || t > fb) continue;
          const u = t / fb;
          put(S.fire[f.k], sx + f.ox * r, sy + f.oy * r, r * f.s * (0.55 + 0.75 * Math.sqrt(u)), (1 - u) ** 1.4, f.rot + u);
        }
        if (r >= 3) {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.lineCap = 'round';
          for (const s of e.sparks) {
            if (a > s.life) continue;
            const u = a / s.life, k = r * s.v * 0.5;
            const d0 = k * (1 - Math.exp(-Math.max(0, a - 0.04) * 6)), d1 = k * (1 - Math.exp(-a * 6));
            ctx.globalAlpha = (1 - u) ** 1.2;
            ctx.strokeStyle = u < 0.35 ? 'rgb(255,236,190)' : 'rgb(255,140,60)';
            ctx.lineWidth = Math.max(0.5, r * 0.06 * s.w);
            ctx.beginPath();
            ctx.moveTo(sx + s.dx * d0, sy + s.dy * d0);
            ctx.lineTo(sx + s.dx * (d1 + 0.5), sy + s.dy * (d1 + 0.5));
            ctx.stroke();
          }
        }
      }

      // Shock wave: a soft ring of raised dust racing outwards.
      ctx.globalCompositeOperation = 'source-over';
      for (const e of this.live) {
        const a = now - e.t0;
        if (a > 0.32) continue;
        const r = size(e.km);
        if (r < 4) continue;
        const sx = (e.x - view.x0) * scale, sy = (e.y - view.y0) * scale;
        const u = a / 0.32;
        put(S.ring, sx, sy, r * (0.9 + 2.8 * Math.sqrt(u)), 0.5 * (1 - u) ** 2);
      }
      ctx.globalAlpha = 1;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
    }
  };
})(window.WM);
