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
      this.labelFont = getComputedStyle(document.documentElement).getPropertyValue('--font-ui').trim() || 'sans-serif';
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

      if (st.axes) this.drawAxes(st.axes, st.attacker, px, st.axesAlpha ?? 1);
      if (st.path && st.path.length > 1) this.drawPath(st.path, st.attacker, px, st.pathStyle, st.extensions);
      if (st.showLabels) this.drawCities(view, px);
    }

    drawPath(path, side, px, style, extensions) {
      const ctx = this.ctx;
      const col = side === WM.RED ? '255, 120, 105' : '125, 170, 255';
      const trace = () => {
        ctx.beginPath();
        ctx.moveTo(path[0][0], path[0][1]);
        for (let i = 1; i < path.length; i++) ctx.lineTo(path[i][0], path[i][1]);
      };
      const faint = style === 'objective';
      trace();
      ctx.strokeStyle = 'rgba(0, 0, 0, 0.55)';
      ctx.lineWidth = (faint ? 3 : 5) * px;
      ctx.stroke();
      trace();
      ctx.setLineDash(faint ? [6 * px, 5 * px] : []);
      ctx.strokeStyle = `rgba(${col}, ${faint ? 0.75 : 1})`;
      ctx.lineWidth = (faint ? 1.5 : 2.6) * px;
      ctx.stroke();
      ctx.setLineDash([]);
      if (extensions && !faint) {
        ctx.setLineDash([3 * px, 4 * px]);
        ctx.strokeStyle = `rgba(${col}, 0.7)`;
        ctx.lineWidth = 1.4 * px;
        const { x0, y0, cell } = this.world;
        for (const [a, b] of extensions) {
          ctx.beginPath();
          ctx.moveTo(x0 + a[0] * cell, y0 + a[1] * cell);
          ctx.lineTo(x0 + b[0] * cell, y0 + b[1] * cell);
          ctx.stroke();
        }
        ctx.setLineDash([]);
      }
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
        ctx.lineWidth = 3 * px;
        ctx.strokeStyle = 'rgba(5, 8, 14, 0.8)';
        ctx.strokeText(c.name, x + 6 * px, y);
        ctx.fillStyle = 'rgba(240, 236, 226, 0.92)';
        ctx.fillText(c.name, x + 6 * px, y);
      }
    }
  };
})(window.WM);
