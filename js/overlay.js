// Canvas 2D layer on top of the WebGL map: borders, the player's line,
// spearhead arrows and city labels. Geometry lives in world px; the canvas
// transform maps it to the screen, so line widths are divided by the scale.
(function (WM) {
  'use strict';

  const toPath = (lines, closed) => {
    const p = new Path2D();
    for (const enc of lines) {
      const pts = WM.decodeLine(enc);
      p.moveTo(pts[0], pts[1]);
      for (let i = 2; i < pts.length; i += 2) p.lineTo(pts[i], pts[i + 1]);
      if (closed) p.closePath();
    }
    return p;
  };

  WM.Overlay = class Overlay {
    constructor(canvas, world) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.world = world;
      const geo = world.geo;
      this.iran = toPath(geo.iran, true);
      this.borders = toPath(geo.borders, false);
      this.provinceLines = toPath(geo.provinceLines, false);
      const css = getComputedStyle(document.documentElement);
      this.labelFont = css.getPropertyValue('--font-ui').trim() || 'sans-serif';
      this.numberFont = css.getPropertyValue('--font-numbers').trim() || this.labelFont;
    }

    resize(cssW, cssH, dpr) {
      const W = Math.round(cssW * dpr), H = Math.round(cssH * dpr);
      if (this.canvas.width !== W || this.canvas.height !== H) {
        this.canvas.width = W;
        this.canvas.height = H;
      }
    }

    draw(view, st) {
      const ctx = this.ctx;
      const { dpr, scale } = view;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      const k = scale * dpr;
      ctx.setTransform(k, 0, 0, k, -view.x0 * k, -view.y0 * k);
      const px = 1 / scale; // one CSS pixel in world units
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';

      ctx.strokeStyle = 'rgba(175, 178, 184, 0.5)';
      ctx.lineWidth = 0.9 * px;
      ctx.stroke(this.borders);

      if (st.showProvinces) {
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
        ctx.lineWidth = 0.7 * px;
        ctx.stroke(this.provinceLines);
      }

      ctx.strokeStyle = 'rgba(255, 255, 255, 0.14)';
      ctx.lineWidth = 4.5 * px;
      ctx.stroke(this.iran);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.96)';
      ctx.lineWidth = 1.35 * px;
      ctx.stroke(this.iran);

      const world = this.world;
      for (const f of st.forts || []) {
        const fid = st.fortId;
        this.drawFort(f.path, f.side, f.facing, px, f.built, (x, y) => {
          const c = world.cellAt(x, y);
          if (c < 0) return false;
          // a vertex counts as long as a cell of this line survives next to it
          for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (fid[c + dy * world.w + dx] === f.id) return true;
          return false;
        });
      }
      for (const f of st.fortPlans || []) this.drawFort(f.path, f.side, f.facing, px, 0.35, null);
      for (const op of st.ops || []) {
        this.drawLine(op.path, op.side, px, 'objective');
        for (const seg of op.extensions || []) this.drawLine(seg, op.side, px, 'objective');
        const age = st.time - op.t0;
        if (age < 18 && op.arrows) this.drawAxes(op.arrows, op.side, px, 1 - age / 18);
      }
      for (const a of st.planArrows || []) this.drawAxes(a.arrows, a.side, px, 1);
      for (const plan of st.plans || []) {
        this.drawLine(plan.path, plan.attacker, px, 'plan');
        for (const seg of plan.extensions || []) this.drawLine(seg, plan.attacker, px, 'extension');
      }
      if (st.drawing && st.drawing.length > 1) this.drawLine(st.drawing, st.drawSide, px, st.drawTool === 'fort' ? 'fortdraw' : 'drawing');
      if (st.showLabels) this.drawCities(view, px);
      if (st.battles) this.drawBattles(view, st.battles);
    }

    drawLine(path, side, px, style) {
      if (!path || path.length < 2) return;
      const ctx = this.ctx;
      const col = side === WM.RED ? '255, 120, 105' : '125, 170, 255';
      const trace = () => {
        ctx.beginPath();
        ctx.moveTo(path[0][0], path[0][1]);
        for (let i = 1; i < path.length; i++) ctx.lineTo(path[i][0], path[i][1]);
      };
      const faint = style === 'objective' || style === 'extension';
      if (!faint) {
        trace();
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
        ctx.lineWidth = 4.6 * px;
        ctx.stroke();
      }
      trace();
      ctx.setLineDash(style === 'objective' ? [5 * px, 5 * px] : style === 'extension' || style === 'fortdraw' ? [3 * px, 4 * px] : []);
      ctx.strokeStyle = `rgba(${col}, ${style === 'objective' ? 0.6 : style === 'extension' ? 0.75 : 1})`;
      ctx.lineWidth = (faint ? 1.4 : style === 'drawing' ? 2.2 : 2.4) * px;
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // A defense line: a thick line with small teeth facing the enemy, the
    // usual map symbol for a fortified line. Dashed while it is being dug;
    // stretches that have been overrun are not drawn.
    drawFort(path, side, facing, px, built, alive) {
      if (!path || path.length < 2) return;
      const ctx = this.ctx;
      const col = side === WM.RED ? '255, 140, 125' : '160, 195, 255';
      const a = 0.5 + 0.5 * Math.min(1, built);
      const runs = [];
      let cur = [];
      for (const p of path) {
        if (!alive || alive(p[0], p[1])) cur.push(p);
        else if (cur.length) { runs.push(cur); cur = []; }
      }
      if (cur.length) runs.push(cur);
      const spacing = 13 * px, tooth = 7 * px;
      for (const run of runs) {
        if (run.length < 2) continue;
        const trace = () => {
          ctx.beginPath();
          ctx.moveTo(run[0][0], run[0][1]);
          for (let i = 1; i < run.length; i++) ctx.lineTo(run[i][0], run[i][1]);
        };
        trace();
        ctx.setLineDash([]);
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.lineWidth = 6 * px;
        ctx.stroke();
        trace();
        ctx.setLineDash(built < 1 ? [7 * px, 4 * px] : []);
        ctx.strokeStyle = `rgba(${col}, ${a})`;
        ctx.lineWidth = 3.2 * px;
        ctx.stroke();
        ctx.setLineDash([]);
        // teeth
        ctx.beginPath();
        let carry = spacing / 2;
        for (let i = 1; i < run.length; i++) {
          const [ax, ay] = run[i - 1], [bx, by] = run[i];
          const L = Math.hypot(bx - ax, by - ay);
          if (!L) continue;
          const ux = (bx - ax) / L, uy = (by - ay) / L, nx = -uy * facing, ny = ux * facing;
          let d = carry;
          while (d < L) {
            const x = ax + ux * d, y = ay + uy * d;
            ctx.moveTo(x - ux * tooth * 0.7, y - uy * tooth * 0.7);
            ctx.lineTo(x + nx * tooth, y + ny * tooth);
            ctx.lineTo(x + ux * tooth * 0.7, y + uy * tooth * 0.7);
            ctx.closePath();
            d += spacing;
          }
          carry = d - L;
        }
        ctx.lineWidth = 1.5 * px;
        ctx.strokeStyle = 'rgba(0, 0, 0, 0.6)';
        ctx.stroke();
        ctx.fillStyle = `rgba(${col}, ${a})`;
        ctx.fill();
      }
    }

    // Men engaged on each side of every battle, set on either side of the
    // front in big numerals: the attacker's on his side, the defender's on
    // the other. Labels of neighbouring battles are nudged apart.
    drawBattles(view, battles) {
      const ctx = this.ctx;
      const { dpr } = view;
      ctx.save();
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const size = view.w < 700 ? 20 : 27;
      ctx.font = `700 ${size}px ${this.numberFont}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      const placed = [];
      const hits = (b) => placed.some((p) => b[0] < p[2] && b[2] > p[0] && b[1] < p[3] && b[3] > p[1]);
      const order = battles.slice().sort((a, b) => b.attackers + b.defenders - a.attackers - a.defenders);
      for (const b of order) {
        const sx = (b.at[0] - view.x0) * view.scale, sy = (b.at[1] - view.y0) * view.scale;
        if (sx < -300 || sy < -300 || sx > view.w + 300 || sy > view.h + 300) continue;
        const [dx, dy] = b.dir;
        const texts = [Math.max(0, b.attackers).toLocaleString('en-US'), Math.max(0, b.defenders).toLocaleString('en-US')];
        const widths = texts.map((t) => ctx.measureText(t).width);
        // distance from the front so each number clears it, whatever the front's angle
        const off = widths.map((tw) => 0.5 * (Math.abs(dx) * tw + Math.abs(dy) * size) + 7);
        let shift = 0, boxes;
        for (let tries = 0; tries < 5; tries++) {
          const px = -dy * shift, py = dx * shift;
          boxes = [-1, 1].map((k, i) => {
            const x = sx + px + dx * off[i] * k, y = sy + py + dy * off[i] * k;
            return [x - widths[i] / 2 - 3, y - size / 2 - 2, x + widths[i] / 2 + 3, y + size / 2 + 2, x, y];
          });
          if (!boxes.some(hits)) break;
          shift = (tries % 2 ? -1 : 1) * (Math.floor(tries / 2) + 1) * size * 0.9;
        }
        // Still overlapping a stronger sector's numbers: leave this pair out
        // (zooming in makes room for it).
        if (boxes.some(hits)) continue;
        boxes.forEach((bx, i) => {
          placed.push(bx);
          const [, , , , x, y] = bx;
          ctx.lineWidth = 5;
          ctx.strokeStyle = 'rgba(8, 10, 14, 0.5)';
          ctx.strokeText(texts[i], x + 1, y + 2);
          ctx.lineWidth = 3.2;
          ctx.strokeStyle = 'rgba(8, 10, 14, 0.92)';
          ctx.strokeText(texts[i], x, y);
          ctx.fillStyle = '#ffffff';
          ctx.fillText(texts[i], x, y);
        });
      }
      ctx.restore();
    }

    // Spearheads drawn as tapered arrows, the way staff maps show them.
    drawAxes(axes, side, px, alpha) {
      const ctx = this.ctx;
      const fill = side === WM.RED ? `rgba(255, 110, 95, ${0.42 * alpha})` : `rgba(120, 165, 255, ${0.42 * alpha})`;
      const edge = `rgba(255, 255, 255, ${0.55 * alpha})`;
      for (const a of axes) {
        const [sx, sy] = a.from, [ex, ey] = a.to;
        const dx = ex - sx, dy = ey - sy, len = Math.hypot(dx, dy);
        if (len < 6) continue;
        const ux = dx / len, uy = dy / len, nx = -uy, ny = ux;
        const w0 = Math.min(len * 0.12, 14) + 2 * px, w1 = w0 * 0.55, head = Math.min(len * 0.3, w0 * 3.2);
        const bx = ex - ux * head, by = ey - uy * head;
        // slight curve for a hand-drawn feel
        const mx = sx + dx * 0.5 + nx * len * 0.06, my = sy + dy * 0.5 + ny * len * 0.06;
        ctx.beginPath();
        ctx.moveTo(sx + nx * w0, sy + ny * w0);
        ctx.quadraticCurveTo(mx + nx * (w0 + w1) / 2, my + ny * (w0 + w1) / 2, bx + nx * w1, by + ny * w1);
        ctx.lineTo(bx + nx * w1 * 2.1, by + ny * w1 * 2.1);
        ctx.lineTo(ex, ey);
        ctx.lineTo(bx - nx * w1 * 2.1, by - ny * w1 * 2.1);
        ctx.lineTo(bx - nx * w1, by - ny * w1);
        ctx.quadraticCurveTo(mx - nx * (w0 + w1) / 2, my - ny * (w0 + w1) / 2, sx - nx * w0, sy - ny * w0);
        ctx.closePath();
        ctx.fillStyle = fill;
        ctx.fill();
        ctx.strokeStyle = edge;
        ctx.lineWidth = 1 * px;
        ctx.stroke();
      }
    }

    drawCities(view, px) {
      const ctx = this.ctx;
      const world = this.world;
      // Show more towns as the player zooms in.
      const zoom = view.scale / view.fitScale;
      const maxRank = zoom < 1.25 ? 3 : zoom < 1.9 ? 5 : zoom < 3 ? 6 : zoom < 5 ? 7 : 9;
      const minPop = zoom < 1.25 ? 1e6 : zoom < 1.9 ? 4e5 : zoom < 3 ? 1.5e5 : 0;
      const size = 11.5 * px;
      ctx.font = `500 ${size}px ${this.labelFont}`;
      ctx.textBaseline = 'middle';
      const placed = [];
      for (const c of world.cities) {
        if (c.rank > maxRank && c.pop < minPop) continue;
        const x = c.x, y = c.y;
        if (x < view.x0 - 50 * px || y < view.y0 - 50 * px || x > view.x1 + 50 * px || y > view.y1 + 50 * px) continue;
        const tw = ctx.measureText(c.name).width;
        const box = [x - 4 * px, y - 8 * px, x + tw + 10 * px, y + 8 * px];
        if (placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1])) continue;
        placed.push(box);
        const owner = world.owner[c.cell];
        ctx.beginPath();
        ctx.rect(x - 2.6 * px, y - 2.6 * px, 5.2 * px, 5.2 * px);
        ctx.fillStyle = owner === WM.RED ? '#ff8a7a' : '#a9c4ff';
        ctx.fill();
        ctx.lineWidth = 1.2 * px;
        ctx.strokeStyle = 'rgba(0,0,0,0.75)';
        ctx.stroke();
        if (c.orig && owner !== c.orig) {
          // occupied town: ringed in white
          ctx.beginPath();
          ctx.rect(x - 4.6 * px, y - 4.6 * px, 9.2 * px, 9.2 * px);
          ctx.lineWidth = 1.1 * px;
          ctx.strokeStyle = 'rgba(255,255,255,0.85)';
          ctx.stroke();
        }
        ctx.lineWidth = 3 * px;
        ctx.strokeStyle = 'rgba(5, 8, 14, 0.8)';
        ctx.strokeText(c.name, x + 6 * px, y);
        ctx.fillStyle = 'rgba(240, 236, 226, 0.92)';
        ctx.fillText(c.name, x + 6 * px, y);
      }
    }
  };
})(window.WM);
