// Shared helpers: math, seeded randomness, noise, a binary heap, calendar.
(function (WM) {
  'use strict';

  WM.clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
  WM.lerp = (a, b, t) => a + (b - a) * t;
  WM.smoothstep = (a, b, x) => {
    const t = WM.clamp((x - a) / (b - a), 0, 1);
    return t * t * (3 - 2 * t);
  };

  // mulberry32: small, fast, seedable PRNG returning [0, 1)
  WM.rng = function (seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  // Seeded 2D gradient noise in roughly [-1, 1], plus fractal sum.
  WM.makeNoise = function (seed) {
    const rand = WM.rng(seed);
    const perm = new Uint16Array(512);
    const p = Array.from({ length: 256 }, (_, i) => i);
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [p[i], p[j]] = [p[j], p[i]];
    }
    for (let i = 0; i < 512; i++) perm[i] = p[i & 255];
    const gx = new Float32Array(256), gy = new Float32Array(256);
    for (let i = 0; i < 256; i++) {
      const a = rand() * Math.PI * 2;
      gx[i] = Math.cos(a);
      gy[i] = Math.sin(a);
    }
    const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
    function noise(x, y) {
      const xi = Math.floor(x), yi = Math.floor(y);
      const xf = x - xi, yf = y - yi;
      const X = xi & 255, Y = yi & 255;
      const g = (ix, iy, dx, dy) => {
        const h = perm[ix + perm[iy]];
        return gx[h] * dx + gy[h] * dy;
      };
      const n00 = g(X, Y, xf, yf), n10 = g(X + 1, Y, xf - 1, yf);
      const n01 = g(X, Y + 1, xf, yf - 1), n11 = g(X + 1, Y + 1, xf - 1, yf - 1);
      const u = fade(xf), v = fade(yf);
      return 1.41 * ((n00 + (n10 - n00) * u) + ((n01 + (n11 - n01) * u) - (n00 + (n10 - n00) * u)) * v);
    }
    function fbm(x, y, octaves = 4) {
      let s = 0, amp = 1, norm = 0, f = 1;
      for (let o = 0; o < octaves; o++) {
        s += amp * noise(x * f + o * 17.3, y * f - o * 9.1);
        norm += amp;
        amp *= 0.5;
        f *= 2.03;
      }
      return s / norm;
    }
    return { noise, fbm };
  };

  // Binary min-heap of (key, value) pairs; duplicates allowed (lazy deletion).
  WM.MinHeap = class {
    constructor(capacity = 1024) {
      this.keys = new Float64Array(capacity);
      this.vals = new Int32Array(capacity);
      this.size = 0;
    }
    push(key, val) {
      if (this.size === this.keys.length) {
        const k = new Float64Array(this.size * 2), v = new Int32Array(this.size * 2);
        k.set(this.keys); v.set(this.vals);
        this.keys = k; this.vals = v;
      }
      let i = this.size++;
      const keys = this.keys, vals = this.vals;
      while (i > 0) {
        const parent = (i - 1) >> 1;
        if (keys[parent] <= key) break;
        keys[i] = keys[parent];
        vals[i] = vals[parent];
        i = parent;
      }
      keys[i] = key;
      vals[i] = val;
    }
    // Returns the value with the smallest key; the key is left in this.lastKey.
    pop() {
      const keys = this.keys, vals = this.vals;
      const topVal = vals[0];
      this.lastKey = keys[0];
      const n = --this.size;
      if (n > 0) {
        const key = keys[n], val = vals[n];
        let i = 0;
        for (;;) {
          let c = 2 * i + 1;
          if (c >= n) break;
          if (c + 1 < n && keys[c + 1] < keys[c]) c++;
          if (keys[c] >= key) break;
          keys[i] = keys[c];
          vals[i] = vals[c];
          i = c;
        }
        keys[i] = key;
        vals[i] = val;
      }
      return topVal;
    }
  };

  // --- Calendar: simulation time is hours since 8 January 1902, 00:00 ------
  const EPOCH = Date.UTC(1902, 0, 8, 0, 0, 0);
  const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
    'September', 'October', 'November', 'December'];
  const MONTHS_SHORT = MONTHS.map((m) => m.slice(0, 3));
  WM.hourDate = (hours) => new Date(EPOCH + Math.floor(hours) * 3600e3);
  WM.formatDay = (hours) => {
    const d = WM.hourDate(hours);
    return `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  };
  WM.formatHour = (hours) => `${String(WM.hourDate(hours).getUTCHours()).padStart(2, '0')}:00`;
  WM.formatStamp = (hours) => {
    const d = WM.hourDate(hours);
    return `${d.getUTCDate()} ${MONTHS_SHORT[d.getUTCMonth()]} ${d.getUTCFullYear()} · ${String(d.getUTCHours()).padStart(2, '0')}:00`;
  };
  WM.formatDuration = (hours) => {
    const h = Math.max(0, Math.round(hours));
    const d = Math.floor(h / 24), r = h % 24;
    if (d === 0) return `${r} h`;
    return r ? `${d} d ${r} h` : `${d} d`;
  };
  WM.formatKm2 = (v) => `${Math.round(v).toLocaleString('en-US')} km²`;

  // --- Data decoding ---------------------------------------------------------
  WM.base64ToBytes = function (b64) {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };
  WM.gunzipBase64 = async function (b64) {
    const bytes = WM.base64ToBytes(b64);
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  };
  // Decode a delta-encoded ring/line (units of 1/10 world px) to [x0,y0,x1,y1,...]
  WM.decodeLine = function (enc) {
    const out = new Float32Array(enc.length);
    let x = 0, y = 0;
    for (let i = 0; i < enc.length; i += 2) {
      x += enc[i];
      y += enc[i + 1];
      out[i] = x / 10;
      out[i + 1] = y / 10;
    }
    return out;
  };
  WM.loadImage = (src) =>
    new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Image failed to load'));
      img.src = src;
    });
})((window.WM = window.WM || {}));
