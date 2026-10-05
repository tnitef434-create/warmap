// WebGL2 map renderer.
//
// Land, water and Iran are separated with the stencil buffer using the vector
// outlines (crisp at any zoom). Each layer is then shaded from the Natural
// Earth relief. Inside Iran, ownership comes from the simulation field: per
// cell the time the front arrives, so the moving front is computed per pixel.
(function (WM) {
  'use strict';

  const VS_QUAD = `#version 300 es
in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;

  const VS_POLY = `#version 300 es
in vec2 a_pos;
uniform vec3 u_view;
uniform vec2 u_res;
void main() {
  vec2 p = (a_pos - u_view.xy) / u_view.z;
  gl_Position = vec4(p.x / u_res.x * 2.0 - 1.0, 1.0 - p.y / u_res.y * 2.0, 0.0, 1.0);
}`;

  const FS_NULL = `#version 300 es
precision mediump float;
out vec4 o;
void main() { o = vec4(0.0); }`;

  const COMMON = `#version 300 es
precision highp float;
precision highp int;
uniform vec3 u_view;      // world x/y at the top-left device pixel, world units per device pixel
uniform vec2 u_res;       // canvas size in device pixels
uniform vec2 u_region;    // map region size in world px
uniform float u_dpr;
uniform sampler2D u_relief;
uniform sampler2D u_detail;
uniform vec2 u_reliefTexels;  // relief texture size in texels
uniform float u_magnified;    // 1 when relief texels are larger than a screen pixel
uniform float u_detailAmp;
out vec4 o;

vec2 worldPos() {
  return vec2(u_view.x + gl_FragCoord.x * u_view.z, u_view.y + (u_res.y - gl_FragCoord.y) * u_view.z);
}
float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
// B-spline bicubic filtering from four bilinear taps, so magnified relief
// stays smooth instead of showing the texel grid.
vec4 cubicWeights(float v) {
  vec4 n = vec4(1.0, 2.0, 3.0, 4.0) - v;
  vec4 s = n * n * n;
  float x = s.x, y = s.y - 4.0 * s.x, z = s.z - 4.0 * s.y + 6.0 * s.x;
  return vec4(x, y, z, 6.0 - x - y - z) / 6.0;
}
float bicubic(sampler2D t, vec2 uv, vec2 size) {
  vec2 p = uv * size - 0.5;
  vec2 f = fract(p);
  p -= f;
  vec4 xc = cubicWeights(f.x), yc = cubicWeights(f.y);
  vec4 c = p.xxyy + vec2(-0.5, 1.5).xyxy;
  vec4 s = vec4(xc.xz + xc.yw, yc.xz + yc.yw);
  vec4 off = (c + vec4(xc.yw, yc.yw) / s) / size.xxyy;
  float s0 = texture(t, off.xz).r, s1 = texture(t, off.yz).r;
  float s2 = texture(t, off.xw).r, s3 = texture(t, off.yw).r;
  float sx = s.x / (s.x + s.y), sy = s.z / (s.z + s.w);
  return mix(mix(s3, s2, sx), mix(s1, s0, sx), sy);
}
// Signed shading from the shaded relief: 0 on flat ground, + lit, - shadow.
float relief(vec2 w) {
  vec2 uv = w / u_region;
  float h = u_magnified > 0.5 ? bicubic(u_relief, uv, u_reliefTexels) : texture(u_relief, uv).r;
  return (h * 255.0 - 206.0) / 52.0;
}
// Fine procedural rock texture that takes over when the relief is magnified.
float detail(vec2 w) {
  float a = texture(u_detail, w / 46.0).r - 0.5;
  float b = texture(u_detail, w / 12.5 + 0.31).r - 0.5;
  return (a * 0.85 + b * 0.5) * u_detailAmp;
}
vec3 finish(vec3 c, vec2 w) {
  vec2 uv = gl_FragCoord.xy / u_res;
  float vig = 1.0 - 0.28 * smoothstep(0.35, 0.95, length((uv - 0.5) * vec2(1.0, 0.85)) * 1.25);
  // fade out at the edges of the mapped region
  vec2 e = min(w, u_region - w);
  float edge = smoothstep(0.0, 160.0, min(e.x, e.y));
  c *= vig * mix(0.35, 1.0, edge);
  c += (hash(gl_FragCoord.xy + fract(w * 0.001)) - 0.5) * 0.018;
  return c;
}
`;

  const FS_WATER = COMMON + `
uniform sampler2D u_water;
uniform sampler2D u_glow;
uniform vec4 u_glowRect;
uniform vec3 u_blue;
uniform vec3 u_red;
void main() {
  vec2 w = worldPos();
  float coast = texture(u_water, w / u_region).r;
  vec3 deep = vec3(0.012, 0.040, 0.092);
  vec3 shallow = vec3(0.030, 0.090, 0.180);
  vec3 col = mix(deep, shallow, pow(coast, 1.6));
  float ripple = texture(u_detail, w / 140.0 + vec2(0.13, 0.71)).r - 0.5;
  col *= 1.0 + ripple * 0.10;
  vec2 gu = (w - u_glowRect.xy) / u_glowRect.zw;
  vec4 g = texture(u_glow, gu);
  if (gu.x > 0.0 && gu.y > 0.0 && gu.x < 1.0 && gu.y < 1.0 && g.r > 0.002) {
    vec3 gc = (g.g * u_red + g.b * u_blue) / max(g.r, 1e-3);
    col = mix(col, gc * 0.62, clamp(g.r * 1.15, 0.0, 1.0) * 0.62);
  }
  o = vec4(finish(col, w), 1.0);
}`;

  const FS_LAND = COMMON + `
void main() {
  vec2 w = worldPos();
  float s = relief(w) + detail(w) * 0.5;
  vec3 base = vec3(0.150, 0.152, 0.158);
  vec3 col = base * clamp(1.0 + 0.62 * s, 0.35, 1.9);
  o = vec4(finish(col, w), 1.0);
}`;

  const FS_IRAN = COMMON + `
uniform highp sampler2D u_field;   // per cell: arrival time, base owner (1 = red), cell crossing time, objective flag
uniform vec4 u_grid;               // grid origin x/y, cell size (world px)
uniform ivec2 u_gridSize;
uniform float u_time;              // simulation hours
uniform int u_attacker;            // 0 none, 1 blue, 2 red
uniform float u_showTarget;
uniform vec3 u_blue;
uniform vec3 u_red;
uniform vec3 u_blueHi;
uniform vec3 u_redHi;

vec4 cellState(ivec2 c) {
  c = clamp(c, ivec2(0), u_gridSize - 1);
  vec4 f = texelFetch(u_field, c, 0);
  float s = clamp((u_time - f.x) / f.z + 0.5, 0.0, 1.0);
  float red = f.y > 0.5 ? 1.0 - s : s;
  float since = u_time - f.x;
  float fresh = f.w > 0.5 && since > 0.0 ? exp(-since / 14.0) : 0.0;
  float fight = f.w > 0.5 ? exp(-abs(since) / (1.5 * f.z + 0.6)) : 0.0;
  return vec4(red, f.w, fresh, fight);
}

vec3 tint(vec3 base, float s) {
  float l = clamp(0.80 + 0.46 * s, 0.22, 1.7);
  vec3 c = base * l;
  return c + max(l - 1.0, 0.0) * 0.30 * vec3(1.0);
}

void main() {
  vec2 w = worldPos();
  vec2 g = (w - u_grid.xy) / u_grid.z - 0.5;
  vec2 fl = floor(g);
  vec2 fr = g - fl;
  ivec2 i0 = ivec2(fl);
  vec4 a = cellState(i0), b = cellState(i0 + ivec2(1, 0));
  vec4 c = cellState(i0 + ivec2(0, 1)), d = cellState(i0 + ivec2(1, 1));
  vec4 v = mix(mix(a, b, fr.x), mix(c, d, fr.x), fr.y);

  // Organic, slightly fractal edge instead of a smooth bilinear contour.
  float wob = (texture(u_detail, w / 21.0).r - 0.5) * 0.55 + (texture(u_detail, w / 5.3 + 0.5).r - 0.5) * 0.3;
  float r = v.x + wob * 0.55;
  float aa = fwidth(r) * 0.85 + 1e-4;
  float red = smoothstep(0.5 - aa, 0.5 + aa, r);

  float s = relief(w) + detail(w) * 0.55;
  vec3 col = mix(tint(u_blue, s), tint(u_red, s), red);

  // Thin shadowed seam along the front.
  float seam = 1.0 - smoothstep(0.0, aa * 2.4, abs(r - 0.5));
  col *= 1.0 - 0.38 * seam;

  vec3 att = u_attacker == 2 ? u_redHi : u_blueHi;
  if (u_attacker > 0) {
    // Newly taken ground glows faintly; the active front flickers with fire.
    float own = u_attacker == 2 ? red : 1.0 - red;
    col += att * 0.10 * v.z * own;
    float flick = 0.55 + 0.45 * sin(u_time * 9.0 + hash(floor(w / 3.0)) * 40.0);
    float band = 1.0 - smoothstep(0.0, aa * 9.0 + 0.04, abs(r - 0.5));
    col += vec3(1.0, 0.62, 0.25) * v.w * band * flick * 0.55;

    // Objective still to be taken: hatched in the attacker's colour.
    float t = v.y + wob * 0.3;
    float aat = fwidth(t) * 0.85 + 1e-4;
    float tgt = smoothstep(0.5 - aat, 0.5 + aat, t) * (1.0 - own);
    float stripe = smoothstep(0.35, 0.5, abs(fract((gl_FragCoord.x + gl_FragCoord.y) / (9.0 * u_dpr)) - 0.5) * 2.0);
    col = mix(col, att, tgt * stripe * 0.36 * u_showTarget);
    float outline = 1.0 - smoothstep(0.0, aat * 2.0, abs(t - 0.5));
    col = mix(col, att * 1.15, outline * (1.0 - own) * 0.85 * u_showTarget);
  }
  o = vec4(finish(col, w), 1.0);
}`;

  function compile(gl, type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }
  function program(gl, vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fs));
    gl.bindAttribLocation(p, 0, 'a_pos');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    const uni = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const info = gl.getActiveUniform(p, i);
      uni[info.name] = gl.getUniformLocation(p, info.name);
    }
    return { p, uni };
  }

  // Triangle fans for every ring: drawn with an INVERT stencil op they give the
  // even-odd fill of arbitrary polygons with holes, no triangulation needed.
  function fans(rings) {
    let count = 0;
    for (const r of rings) count += Math.max(0, r.length / 2 - 2) * 6;
    const out = new Float32Array(count);
    let k = 0;
    for (const r of rings) {
      const n = r.length / 2;
      for (let i = 1; i < n - 1; i++) {
        out[k++] = r[0]; out[k++] = r[1];
        out[k++] = r[i * 2]; out[k++] = r[i * 2 + 1];
        out[k++] = r[i * 2 + 2]; out[k++] = r[i * 2 + 3];
      }
    }
    return out;
  }

  // Tileable rock texture: ridged periodic noise, embossed from the north-west.
  function makeDetailTexture(size) {
    const rand = WM.rng(1902);
    const layers = [8, 16, 32, 64].map((period) => {
      const v = new Float32Array(period * period);
      for (let i = 0; i < v.length; i++) v[i] = rand();
      return { period, v };
    });
    const height = new Float32Array(size * size);
    const smooth = (t) => t * t * (3 - 2 * t);
    layers.forEach(({ period, v }, li) => {
      const amp = [0.5, 0.28, 0.15, 0.08][li];
      for (let y = 0; y < size; y++) {
        const fy = (y / size) * period, iy = Math.floor(fy), ty = smooth(fy - iy);
        for (let x = 0; x < size; x++) {
          const fx = (x / size) * period, ix = Math.floor(fx), tx = smooth(fx - ix);
          const at = (i, j) => v[((j % period) * period) + (i % period)];
          const n = WM.lerp(WM.lerp(at(ix, iy), at(ix + 1, iy), tx), WM.lerp(at(ix, iy + 1), at(ix + 1, iy + 1), tx), ty);
          height[y * size + x] += amp * (1 - Math.abs(n * 2 - 1));
        }
      }
    });
    const out = new Uint8Array(size * size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const h0 = height[((y - 1 + size) % size) * size + ((x - 1 + size) % size)];
        const h1 = height[((y + 1) % size) * size + ((x + 1) % size)];
        out[y * size + x] = WM.clamp(Math.round(128 + (h0 - h1) * 520 + (height[y * size + x] - 0.5) * 60), 0, 255);
      }
    }
    return out;
  }

  WM.Renderer = class Renderer {
    constructor(canvas, world, images) {
      const gl = canvas.getContext('webgl2', { antialias: true, stencil: true, alpha: false, premultipliedAlpha: false });
      if (!gl) throw new Error('WebGL2 is not available in this browser.');
      this.gl = gl;
      this.canvas = canvas;
      this.world = world;
      const geo = world.geo;
      this.region = [geo.region.width, geo.region.height];
      this.reliefScale = images.scale;
      this.reliefTexels = [images.land.naturalWidth || images.land.width, images.land.naturalHeight || images.land.height];

      this.progPoly = program(gl, VS_POLY, FS_NULL);
      this.progWater = program(gl, VS_QUAD, FS_WATER);
      this.progLand = program(gl, VS_QUAD, FS_LAND);
      this.progIran = program(gl, VS_QUAD, FS_IRAN);

      const buffer = (data) => {
        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        const b = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, b);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
        gl.bindVertexArray(null);
        return { vao, count: data.length / 2 };
      };
      this.quad = buffer(new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]));
      this.landFans = buffer(fans(geo.land.map(WM.decodeLine)));
      this.iranFans = buffer(fans(geo.iran.map(WM.decodeLine)));

      const tex = (unit, setup) => {
        const t = gl.createTexture();
        gl.activeTexture(gl.TEXTURE0 + unit);
        gl.bindTexture(gl.TEXTURE_2D, t);
        setup();
        return t;
      };
      const linearMip = (wrap) => {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
        gl.generateMipmap(gl.TEXTURE_2D);
      };
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      this.texRelief = tex(0, () => {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, gl.RED, gl.UNSIGNED_BYTE, images.land);
        linearMip(gl.CLAMP_TO_EDGE);
      });
      this.texWater = tex(2, () => {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, gl.RED, gl.UNSIGNED_BYTE, images.water);
        linearMip(gl.CLAMP_TO_EDGE);
      });
      const DS = 512;
      const detail = makeDetailTexture(DS);
      this.texDetail = tex(1, () => {
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, DS, DS, 0, gl.RED, gl.UNSIGNED_BYTE, detail);
        linearMip(gl.REPEAT);
      });
      const ext = gl.getExtension('EXT_texture_filter_anisotropic');
      if (ext) {
        const max = gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT);
        for (const [unit, t] of [[0, this.texRelief], [1, this.texDetail]]) {
          gl.activeTexture(gl.TEXTURE0 + unit);
          gl.bindTexture(gl.TEXTURE_2D, t);
          gl.texParameterf(gl.TEXTURE_2D, ext.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, max));
        }
      }
      this.texField = tex(3, () => {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      });
      this.texGlow = tex(4, () => {
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      });
      this.fieldData = new Float32Array(world.N * 4);
      this.glowScale = 4;
      this.glowW = Math.ceil(world.w / this.glowScale);
      this.glowH = Math.ceil(world.h / this.glowScale);
    }

    // Upload ownership for the current state, optionally with an offensive
    // (op) or a planned objective (plan) layered on top.
    setField(op, plan) {
      const world = this.world;
      const { N, owner, nearest } = world;
      const F = this.fieldData;
      const objective = op ? op.plan.mask : plan ? plan.mask : null;
      const base = op ? op.baseOwner : owner;
      for (let c = 0; c < N; c++) {
        const k = c * 4;
        F[k] = 1e9;
        F[k + 1] = base[c] === WM.RED ? 1 : 0;
        F[k + 2] = 1;
        F[k + 3] = objective && objective[c] ? 1 : 0;
      }
      if (op) {
        for (let i = 0; i < op.cells.length; i++) {
          const k = op.cells[i] * 4;
          F[k] = op.T[i] - op.t0;
          F[k + 2] = Math.max(op.tau[i], 0.05);
        }
        this.fieldEpoch = op.t0;
      } else {
        this.fieldEpoch = 0;
      }
      // carry values a little past the coastline / borders
      for (let c = 0; c < N; c++) {
        const src = nearest[c];
        if (src >= 0 && src !== c) {
          const k = c * 4, s = src * 4;
          F[k] = F[s]; F[k + 1] = F[s + 1]; F[k + 2] = F[s + 2]; F[k + 3] = F[s + 3];
        }
      }
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, this.texField);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA32F, world.w, world.h, 0, gl.RGBA, gl.FLOAT, F);
    }

    // Coastal glow: blurred, low-resolution copy of the current ownership.
    setGlow() {
      const world = this.world;
      const { w, h, owner } = world;
      const S = this.glowScale, GW = this.glowW, GH = this.glowH;
      let red = new Float32Array(GW * GH), blue = new Float32Array(GW * GH);
      for (const c of world.iranCells) {
        const x = c % w, y = (c - x) / w;
        const g = Math.floor(y / S) * GW + Math.floor(x / S);
        if (owner[c] === WM.RED) red[g] += 1 / (S * S);
        else blue[g] += 1 / (S * S);
      }
      const blur = (a) => {
        const t = new Float32Array(a.length), o = new Float32Array(a.length), r = 3;
        for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
          let s = 0;
          for (let d = -r; d <= r; d++) { const xx = x + d; if (xx >= 0 && xx < GW) s += a[y * GW + xx]; }
          t[y * GW + x] = s / (2 * r + 1);
        }
        for (let y = 0; y < GH; y++) for (let x = 0; x < GW; x++) {
          let s = 0;
          for (let d = -r; d <= r; d++) { const yy = y + d; if (yy >= 0 && yy < GH) s += t[yy * GW + x]; }
          o[y * GW + x] = s / (2 * r + 1);
        }
        return o;
      };
      red = blur(blur(red));
      blue = blur(blur(blue));
      const data = new Uint8Array(GW * GH * 4);
      for (let i = 0; i < GW * GH; i++) {
        const total = Math.min(1, red[i] + blue[i]);
        data[i * 4] = Math.round(255 * Math.min(1, total * 1.6));
        data[i * 4 + 1] = Math.round(255 * Math.min(1, red[i] * 1.6));
        data[i * 4 + 2] = Math.round(255 * Math.min(1, blue[i] * 1.6));
        data[i * 4 + 3] = 255;
      }
      const gl = this.gl;
      gl.activeTexture(gl.TEXTURE4);
      gl.bindTexture(gl.TEXTURE_2D, this.texGlow);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, GW, GH, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    }

    resize(cssW, cssH, dpr) {
      const W = Math.round(cssW * dpr), H = Math.round(cssH * dpr);
      if (this.canvas.width !== W || this.canvas.height !== H) {
        this.canvas.width = W;
        this.canvas.height = H;
      }
    }

    render(view, sim) {
      const gl = this.gl;
      const W = this.canvas.width, H = this.canvas.height;
      gl.viewport(0, 0, W, H);
      gl.clearColor(0.012, 0.03, 0.07, 1);
      gl.clearStencil(0);
      gl.stencilMask(0xff);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);

      const wpp = 1 / (view.scale * view.dpr);
      const viewU = [view.x0, view.y0, wpp];
      const texelPx = 1 / (this.reliefScale * wpp); // device pixels per relief texel

      // 1) stencil: bit 0 = land, bit 1 = Iran
      gl.enable(gl.STENCIL_TEST);
      gl.colorMask(false, false, false, false);
      gl.useProgram(this.progPoly.p);
      gl.uniform3fv(this.progPoly.uni.u_view, viewU);
      gl.uniform2f(this.progPoly.uni.u_res, W, H);
      gl.stencilFunc(gl.ALWAYS, 0, 0xff);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT);
      gl.stencilMask(0x01);
      gl.bindVertexArray(this.landFans.vao);
      gl.drawArrays(gl.TRIANGLES, 0, this.landFans.count);
      gl.stencilMask(0x02);
      gl.bindVertexArray(this.iranFans.vao);
      gl.drawArrays(gl.TRIANGLES, 0, this.iranFans.count);
      gl.colorMask(true, true, true, true);
      gl.stencilMask(0x00);
      gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
      gl.bindVertexArray(this.quad.vao);

      const common = (prog) => {
        gl.useProgram(prog.p);
        const u = prog.uni;
        gl.uniform3fv(u.u_view, viewU);
        gl.uniform2f(u.u_res, W, H);
        gl.uniform2fv(u.u_region, this.region);
        gl.uniform1f(u.u_dpr, view.dpr);
        gl.uniform1i(u.u_relief, 0);
        gl.uniform1i(u.u_detail, 1);
        gl.uniform2fv(u.u_reliefTexels, this.reliefTexels);
        gl.uniform1f(u.u_magnified, texelPx > 1.15 ? 1 : 0);
        gl.uniform1f(u.u_detailAmp, 0.55 + 0.9 * WM.smoothstep(1, 5, texelPx));
        return u;
      };
      const C = WM.COLORS;

      // 2) water
      let u = common(this.progWater);
      gl.uniform1i(u.u_water, 2);
      gl.uniform1i(u.u_glow, 4);
      const world = this.world;
      gl.uniform4f(u.u_glowRect, world.x0, world.y0, this.glowW * this.glowScale * world.cell, this.glowH * this.glowScale * world.cell);
      gl.uniform3fv(u.u_blue, C.blue);
      gl.uniform3fv(u.u_red, C.red);
      gl.stencilFunc(gl.EQUAL, 0, 0x01);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      // 3) neighbouring countries
      common(this.progLand);
      gl.stencilFunc(gl.EQUAL, 0x01, 0x03);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      // 4) Iran
      u = common(this.progIran);
      gl.uniform1i(u.u_field, 3);
      gl.uniform4f(u.u_grid, world.x0, world.y0, world.cell, 0);
      gl.uniform2i(u.u_gridSize, world.w, world.h);
      gl.uniform1f(u.u_time, sim.time - this.fieldEpoch);
      gl.uniform1i(u.u_attacker, sim.attacker || 0);
      gl.uniform1f(u.u_showTarget, sim.showTarget ? 1 : 0);
      gl.uniform3fv(u.u_blue, C.blue);
      gl.uniform3fv(u.u_red, C.red);
      gl.uniform3fv(u.u_blueHi, C.blueHi);
      gl.uniform3fv(u.u_redHi, C.redHi);
      gl.stencilFunc(gl.EQUAL, 0x02, 0x02);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      gl.disable(gl.STENCIL_TEST);
      gl.bindVertexArray(null);
    }
  };

  // Linear-ish RGB used by the shaders.
  WM.COLORS = {
    blue: [0.105, 0.255, 0.80],
    red: [0.62, 0.085, 0.085],
    blueHi: [0.42, 0.62, 1.0],
    redHi: [1.0, 0.36, 0.30],
  };
})(window.WM);
