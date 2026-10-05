// Game controller: clock, camera, input, panels and the offensive lifecycle.
(function (WM) {
  'use strict';
  const $ = (id) => document.getElementById(id);

  // Seconds of real time per simulated hour.
  const SPEEDS = [
    { label: '1×', sph: 10 },
    { label: '2×', sph: 3 },
    { label: '10×', sph: 1 },
    { label: '40×', sph: 0.25 },
  ];
  const SAVE_KEY = 'warmap-iran-1902-v1';
  const MODE_LABEL = { front: 'Front-line offensive', encircle: 'Encirclement', thrust: 'Thrust (salient)' };

  const storage = {
    get() { try { return JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); } catch (e) { return null; } },
    set(v) { try { localStorage.setItem(SAVE_KEY, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
    clear() { try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* storage unavailable */ } },
  };

  class App {
    constructor(world, images) {
      this.world = world;
      this.el = $('app');
      this.planner = new WM.Planner(world);
      this.renderer = new WM.Renderer($('map'), world, images);
      this.overlay = new WM.Overlay($('overlay'), world);
      this.st = {
        time: 0, speed: 0, paused: false,
        side: 0, path: null, drawing: null, plan: null, prep: null, op: null,
        log: [], showLabels: true, showProvinces: true,
      };
      this.view = { cx: 0, cy: 0, scale: 1, dpr: 1, fitScale: 1, w: 1, h: 1 };
      this.mapDirty = true;
      this.overlayDirty = true;
      this.lastGlow = 0;
      this.lastSave = performance.now();

      if (!this.restore()) this.newWar();
      this.renderer.setField(null, null);
      this.renderer.setGlow();

      this.bindUI();
      this.bindInput();
      this.resize();
      this.fit();
      this.refreshSides();
      this.refreshPanels();
      this.refreshSpeed();
      this.renderLog();
      new ResizeObserver(() => this.resize()).observe(this.el);
      if (window.matchMedia('(max-width: 860px)').matches) this.setDiary(false);

      this.last = performance.now();
      requestAnimationFrame((t) => this.frame(t));
      $('loading').classList.add('done');
    }

    // ------------------------------------------------------------- state ---
    newWar() {
      this.world.applyScenario();
      const st = this.st;
      st.time = 0;
      st.op = null; st.plan = null; st.prep = null; st.path = null; st.side = 0;
      st.log = [];
      const held = WM.START_RED_PROVINCES.slice(0, -1).join(', ') + ' and ' + WM.START_RED_PROVINCES.slice(-1);
      this.addLog({ t: 0, side: WM.RED, text: `Red forces hold ${held}.` });
      this.addLog({ t: 0, side: WM.BLUE, text: 'Blue controls the rest of the country and the capital, Tehran.' });
    }

    save() {
      const st = this.st;
      if (st.op) return;
      storage.set({ v: 1, time: st.time, speed: st.speed, owner: this.world.encodeOwner(), log: st.log.slice(0, 120) });
      this.lastSave = performance.now();
    }

    restore() {
      const s = storage.get();
      if (!s || s.v !== 1 || !Array.isArray(s.owner)) return false;
      if (!this.world.decodeOwner(s.owner)) return false;
      this.st.time = +s.time || 0;
      this.st.speed = WM.clamp(s.speed | 0, 0, SPEEDS.length - 1);
      this.st.log = Array.isArray(s.log) ? s.log : [];
      return true;
    }

    addLog(ev) {
      this.st.log.unshift({ t: ev.t, side: ev.side || 0, text: ev.text });
      if (this.st.log.length > 200) this.st.log.length = 200;
      this.logDirty = true;
    }

    // ------------------------------------------------------------ camera ---
    resize() {
      const v = this.view;
      v.w = this.el.clientWidth;
      v.h = this.el.clientHeight;
      v.dpr = Math.min(window.devicePixelRatio || 1, 2);
      this.renderer.resize(v.w, v.h, v.dpr);
      this.overlay.resize(v.w, v.h, v.dpr);
      v.fitScale = this.fitParams().scale;
      this.clampView();
      this.mapDirty = this.overlayDirty = true;
    }

    fitParams() {
      const v = this.view;
      const [bx0, by0, bx1, by1] = this.world.geo.iranBounds;
      const narrow = v.w <= 860;
      const pad = narrow
        ? { l: 16, r: 16, t: 100, b: Math.min(v.h * 0.44, 300) + 24 }
        : { l: 332, r: v.w > 1180 ? 312 : 64, t: 128, b: 40 };
      const aw = Math.max(120, v.w - pad.l - pad.r), ah = Math.max(120, v.h - pad.t - pad.b);
      const scale = Math.min(aw / (bx1 - bx0), ah / (by1 - by0));
      const cx = (bx0 + bx1) / 2 - (pad.l - pad.r) / 2 / scale;
      const cy = (by0 + by1) / 2 - (pad.t - pad.b) / 2 / scale;
      return { scale, cx, cy };
    }

    fit() {
      const f = this.fitParams();
      Object.assign(this.view, { scale: f.scale, cx: f.cx, cy: f.cy, fitScale: f.scale });
      this.clampView();
      this.mapDirty = this.overlayDirty = true;
    }

    clampView() {
      const v = this.view, R = this.world.geo.region;
      v.scale = WM.clamp(v.scale, v.fitScale * 0.5, v.fitScale * 10);
      v.cx = WM.clamp(v.cx, 0, R.width);
      v.cy = WM.clamp(v.cy, 0, R.height);
      v.x0 = v.cx - v.w / 2 / v.scale;
      v.y0 = v.cy - v.h / 2 / v.scale;
      v.x1 = v.cx + v.w / 2 / v.scale;
      v.y1 = v.cy + v.h / 2 / v.scale;
    }

    toWorld(sx, sy) {
      const v = this.view;
      return [v.x0 + sx / v.scale, v.y0 + sy / v.scale];
    }

    zoomAt(sx, sy, factor) {
      const v = this.view;
      const [wx, wy] = this.toWorld(sx, sy);
      v.scale = WM.clamp(v.scale * factor, v.fitScale * 0.5, v.fitScale * 10);
      v.cx = wx - (sx - v.w / 2) / v.scale;
      v.cy = wy - (sy - v.h / 2) / v.scale;
      this.clampView();
      this.mapDirty = this.overlayDirty = true;
    }

    panBy(dx, dy) {
      const v = this.view;
      v.cx -= dx / v.scale;
      v.cy -= dy / v.scale;
      this.clampView();
      this.mapDirty = this.overlayDirty = true;
    }

    // ------------------------------------------------------------- input ---
    bindInput() {
      const c = $('overlay');
      const pointers = new Map();
      let gesture = null;

      const pos = (e) => {
        const r = c.getBoundingClientRect();
        return [e.clientX - r.left, e.clientY - r.top];
      };
      const pinchInfo = () => {
        const p = [...pointers.values()];
        return { cx: (p[0][0] + p[1][0]) / 2, cy: (p[0][1] + p[1][1]) / 2, d: Math.hypot(p[0][0] - p[1][0], p[0][1] - p[1][1]) };
      };

      c.addEventListener('pointerdown', (e) => {
        c.setPointerCapture(e.pointerId);
        pointers.set(e.pointerId, pos(e));
        if (pointers.size === 2) {
          if (gesture && gesture.type === 'draw') this.cancelDraw();
          gesture = { type: 'pinch', ...pinchInfo() };
          return;
        }
        if (pointers.size > 2) return;
        const [x, y] = pos(e);
        const drawButton = e.pointerType !== 'mouse' || e.button === 0;
        if (this.canDraw() && drawButton) {
          gesture = { type: 'draw', last: [x, y] };
          this.startDraw(x, y);
        } else {
          gesture = { type: 'pan', last: [x, y], moved: 0 };
          this.el.classList.add('panning');
        }
      });

      c.addEventListener('pointermove', (e) => {
        if (!pointers.has(e.pointerId)) return;
        pointers.set(e.pointerId, pos(e));
        if (!gesture) return;
        if (gesture.type === 'pinch' && pointers.size >= 2) {
          const p = pinchInfo();
          this.panBy(p.cx - gesture.cx, p.cy - gesture.cy);
          if (gesture.d > 0 && p.d > 0) this.zoomAt(p.cx, p.cy, p.d / gesture.d);
          Object.assign(gesture, p);
        } else if (gesture.type === 'pan') {
          const [x, y] = pos(e);
          this.panBy(x - gesture.last[0], y - gesture.last[1]);
          gesture.moved += Math.abs(x - gesture.last[0]) + Math.abs(y - gesture.last[1]);
          gesture.last = [x, y];
        } else if (gesture.type === 'draw') {
          const [x, y] = pos(e);
          if (Math.hypot(x - gesture.last[0], y - gesture.last[1]) >= 3) {
            gesture.last = [x, y];
            this.st.drawing.push(this.toWorld(x, y));
            this.overlayDirty = true;
          }
        }
      });

      const end = (e) => {
        if (!pointers.has(e.pointerId)) return;
        pointers.delete(e.pointerId);
        if (!gesture) return;
        if (gesture.type === 'draw') {
          gesture = null;
          this.endDraw();
        } else if (gesture.type === 'pinch') {
          if (pointers.size === 1) {
            const [p] = [...pointers.values()];
            gesture = { type: 'pan', last: p, moved: 0 };
          } else if (!pointers.size) gesture = null;
        } else if (!pointers.size) {
          gesture = null;
          this.el.classList.remove('panning');
        }
      };
      c.addEventListener('pointerup', end);
      c.addEventListener('pointercancel', end);
      c.addEventListener('contextmenu', (e) => e.preventDefault());
      c.addEventListener('wheel', (e) => {
        e.preventDefault();
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
        const [x, y] = pos(e);
        this.zoomAt(x, y, Math.exp(-e.deltaY * unit * 0.0016));
      }, { passive: false });
      c.addEventListener('dblclick', (e) => {
        if (this.canDraw()) return;
        const [x, y] = pos(e);
        this.zoomAt(x, y, 1.8);
      });

      window.addEventListener('keydown', (e) => {
        if (e.target instanceof HTMLInputElement && e.target.type !== 'checkbox') return;
        if (e.target instanceof HTMLButtonElement && (e.key === ' ' || e.key === 'Enter')) return;
        if (!$('attackModal').hidden) {
          if (e.key === 'Escape') this.closeModal();
          return;
        }
        if (e.key === ' ') { e.preventDefault(); this.togglePause(); }
        else if (e.key >= '1' && e.key <= String(SPEEDS.length)) this.setSpeed(+e.key - 1);
        else if (e.key === '+' || e.key === '=') this.zoomAt(this.view.w / 2, this.view.h / 2, 1.4);
        else if (e.key === '-' || e.key === '_') this.zoomAt(this.view.w / 2, this.view.h / 2, 1 / 1.4);
        else if (e.key === 'f' || e.key === 'F') this.fit();
        else if (e.key === 'Escape') this.clearPlan();
      });
    }

    canDraw() {
      return this.st.side && !this.st.op && $('attackModal').hidden;
    }

    startDraw(x, y) {
      const st = this.st;
      st.drawing = [this.toWorld(x, y)];
      st.plan = null;
      st.prep = null;
      this.renderer.setField(null, null);
      this.mapDirty = this.overlayDirty = true;
      this.refreshPanels();
    }

    cancelDraw() {
      this.st.drawing = null;
      this.overlayDirty = true;
    }

    endDraw() {
      const st = this.st;
      const path = st.drawing;
      st.drawing = null;
      this.overlayDirty = true;
      if (!path || path.length < 3) { this.refreshPanels(); return; }
      st.path = path;
      this.computePlan(false);
    }

    computePlan(flip) {
      const st = this.st;
      const res = this.planner.plan(st.side, st.path, flip);
      st.prep = null;
      if (!res.ok) {
        st.plan = null;
        this.toast(res.reason);
        this.renderer.setField(null, null);
      } else {
        st.plan = res;
        this.renderer.setField(null, res);
      }
      this.mapDirty = this.overlayDirty = true;
      this.refreshPanels();
    }

    clearPlan() {
      const st = this.st;
      if (st.op) return;
      st.path = null; st.plan = null; st.prep = null; st.drawing = null;
      this.renderer.setField(null, null);
      this.mapDirty = this.overlayDirty = true;
      this.refreshPanels();
    }

    // ---------------------------------------------------------------- UI ---
    bindUI() {
      document.querySelectorAll('.side').forEach((b) => {
        b.addEventListener('click', () => this.selectSide(+b.dataset.side));
      });
      $('btnPause').addEventListener('click', () => this.togglePause());
      document.querySelectorAll('.spd').forEach((b) => b.addEventListener('click', () => this.setSpeed(+b.dataset.speed)));
      $('btnAttack').addEventListener('click', () => this.openModal());
      $('btnFlip').addEventListener('click', () => { if (this.st.plan) this.computePlan(!this.st.plan.flipped); });
      $('btnClear').addEventListener('click', () => this.clearPlan());
      $('btnHalt').addEventListener('click', () => this.haltOperation());
      $('zoomIn').addEventListener('click', () => this.zoomAt(this.view.w / 2, this.view.h / 2, 1.5));
      $('zoomOut').addEventListener('click', () => this.zoomAt(this.view.w / 2, this.view.h / 2, 1 / 1.5));
      $('zoomFit').addEventListener('click', () => this.fit());
      $('optLabels').addEventListener('change', (e) => { this.st.showLabels = e.target.checked; this.overlayDirty = true; });
      $('optProvinces').addEventListener('change', (e) => { this.st.showProvinces = e.target.checked; this.overlayDirty = true; });
      $('diaryToggle').addEventListener('click', () => this.setDiary($('diary').dataset.collapsed === 'true'));
      $('defense').addEventListener('input', () => this.refreshEstimate());
      $('amCancel').addEventListener('click', () => this.closeModal());
      $('amLaunch').addEventListener('click', () => this.launch());
      $('attackModal').addEventListener('click', (e) => { if (e.target === $('attackModal')) this.closeModal(); });

      const reset = $('btnReset');
      reset.addEventListener('click', () => {
        if (!reset.classList.contains('confirm')) {
          reset.classList.add('confirm');
          reset.textContent = 'Click again to restart';
          clearTimeout(this.resetTimer);
          this.resetTimer = setTimeout(() => { reset.classList.remove('confirm'); reset.textContent = 'New war'; }, 3500);
          return;
        }
        clearTimeout(this.resetTimer);
        reset.classList.remove('confirm');
        reset.textContent = 'New war';
        storage.clear();
        this.newWar();
        this.renderer.setField(null, null);
        this.renderer.setGlow();
        this.mapDirty = this.overlayDirty = true;
        this.refreshSides();
        this.refreshPanels();
        this.renderLog();
        this.save();
        this.toast('A new war begins on 8 January 1902.');
      });
    }

    setDiary(open) {
      $('diary').dataset.collapsed = open ? 'false' : 'true';
      $('diaryToggle').setAttribute('aria-expanded', String(open));
    }

    selectSide(side) {
      const st = this.st;
      if (st.op) return;
      st.side = st.side === side ? 0 : side;
      st.path = null; st.plan = null; st.prep = null;
      this.renderer.setField(null, null);
      this.mapDirty = this.overlayDirty = true;
      this.refreshPanels();
    }

    togglePause() {
      this.st.paused = !this.st.paused;
      this.refreshSpeed();
    }

    setSpeed(i) {
      this.st.speed = i;
      this.st.paused = false;
      this.refreshSpeed();
    }

    refreshSpeed() {
      const st = this.st;
      $('btnPause').setAttribute('aria-pressed', String(st.paused));
      document.querySelectorAll('.spd').forEach((b) => {
        b.setAttribute('aria-pressed', String(!st.paused && +b.dataset.speed === st.speed));
      });
      const sph = SPEEDS[st.speed].sph;
      $('clockNote').textContent = st.paused ? 'Paused' : `1 hour = ${sph >= 1 ? sph + ' s' : sph * 1000 + ' ms'}`;
    }

    refreshSides() {
      const s = this.world.stats();
      const total = s.area[1] + s.area[2];
      const set = (side, areaEl, metaEl) => {
        $(areaEl).textContent = WM.formatKm2(s.area[side]);
        const pct = total ? (100 * s.area[side]) / total : 0;
        $(metaEl).textContent = `${pct.toFixed(1)}% · ${s.provinces[side]} provinces`;
      };
      set(WM.BLUE, 'areaBlue', 'metaBlue');
      set(WM.RED, 'areaRed', 'metaRed');
      $('balBlue').style.width = `${(100 * s.area[1]) / (total || 1)}%`;
      $('balRed').style.width = `${(100 * s.area[2]) / (total || 1)}%`;
    }

    refreshPanels() {
      const st = this.st;
      const mode = st.op ? 'op' : st.side ? 'plan' : 'idle';
      this.el.classList.toggle('mode-plan', mode === 'plan');
      this.el.dataset.side = st.op ? st.op.attacker : st.side || '';
      $('panelIdle').hidden = mode !== 'idle';
      $('panelPlan').hidden = mode !== 'plan';
      $('panelOp').hidden = mode !== 'op';
      document.querySelectorAll('.side').forEach((b) => {
        b.setAttribute('aria-pressed', String(+b.dataset.side === st.side && !st.op));
        b.disabled = !!st.op;
      });
      const hint = $('hint');
      if (mode === 'plan') {
        const enemy = WM.SIDE_NAME[st.side === WM.BLUE ? WM.RED : WM.BLUE];
        const plan = st.plan;
        $('planHint').innerHTML = plan
          ? `Hatched ground is your objective. Press <b>Attack</b> to set the enemy's defense, or draw again to replace the line.`
          : `Draw the line your troops should reach in ${enemy} territory. Everything between your front and the line becomes the objective. Draw a loop to encircle; a short stroke is a thrust.`;
        $('planFacts').hidden = !plan;
        if (plan) {
          $('pfMode').textContent = MODE_LABEL[plan.mode] + (plan.flipped ? ' (flipped)' : '');
          $('pfArea').textContent = WM.formatKm2(plan.area);
          const towns = plan.cities;
          $('pfTowns').textContent = towns.length ? towns.slice(0, 4).join(', ') + (towns.length > 4 ? ` +${towns.length - 4}` : '') : 'None';
          const prov = plan.provinces;
          $('pfProv').textContent = prov.slice(0, 3).join(', ') + (prov.length > 3 ? ` +${prov.length - 3}` : '');
        }
        $('btnAttack').disabled = !plan;
        $('btnFlip').disabled = !(plan && plan.canFlip);
        $('btnClear').disabled = !plan && !st.path;
        hint.textContent = 'Drag to draw · Right-drag or two fingers to pan · Scroll to zoom · Esc clears';
      } else if (mode === 'op') {
        hint.textContent = 'Zoom in to watch the front · Space pauses · 1–4 change speed';
      } else {
        hint.textContent = 'Drag to pan · Scroll to zoom · Space pauses · 1–4 change speed';
      }
      if (mode === 'op') this.refreshOpPanel();
    }

    refreshOpPanel() {
      const op = this.st.op;
      if (!op) return;
      const att = WM.SIDE_NAME[op.attacker], en = WM.SIDE_NAME[op.enemy];
      $('opTitle').textContent = `${att} offensive against ${en}`;
      const pct = op.progress();
      $('opBar').style.width = `${(pct * 100).toFixed(1)}%`;
      $('opTaken').textContent = `${Math.floor(pct * 100)}% · ${WM.formatKm2(op.captured)}`;
      $('opDefense').textContent = `${WM.defenseTier(op.defense)} (${op.defense})`;
      $('opElapsed').textContent = WM.formatDuration(this.st.time - op.t0);
      $('opEnd').textContent = WM.formatStamp(op.tEnd);
    }

    renderLog() {
      const ol = $('log');
      const items = this.st.log.slice(0, 80);
      ol.replaceChildren(...items.map((ev, i) => {
        const li = document.createElement('li');
        li.dataset.side = ev.side;
        if (i < (this.freshCount || 0)) li.className = 'fresh';
        const mk = document.createElement('span');
        mk.className = 'mk';
        const when = document.createElement('span');
        when.className = 'when';
        when.textContent = WM.formatStamp(ev.t);
        const what = document.createElement('span');
        what.className = 'what';
        what.textContent = ev.text;
        li.append(mk, when, what);
        return li;
      }));
      $('diaryCount').textContent = this.st.log.length ? `${this.st.log.length} entries` : '';
      this.freshCount = 0;
      this.logDirty = false;
    }

    toast(msg) {
      const t = $('toast');
      t.textContent = msg;
      t.hidden = false;
      clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => { t.hidden = true; }, 4200);
    }

    // ------------------------------------------------------- offensives ---
    openModal() {
      const st = this.st;
      if (!st.plan) return;
      const btn = $('btnAttack');
      const show = () => {
        btn.textContent = 'Attack';
        btn.disabled = false;
        const att = WM.SIDE_NAME[st.plan.attacker], en = WM.SIDE_NAME[st.plan.enemy];
        $('amTitle').textContent = `${att} offensive against ${en}`;
        const towns = st.plan.cities.length;
        $('amSub').textContent = `${MODE_LABEL[st.plan.mode]} · ${WM.formatKm2(st.plan.area)} · ${towns} ${towns === 1 ? 'town' : 'towns'}`;
        $('amAxes').textContent = st.prep.axes.length
          ? `${st.prep.axes.length}${st.prep.belts ? ` · ${st.prep.belts} defensive belt${st.prep.belts > 1 ? 's' : ''} ahead` : ''}`
          : 'None (broad-front advance)';
        $('attackModal').hidden = false;
        this.refreshEstimate();
        this.overlayDirty = true;
        $('defense').focus();
      };
      if (st.prep) { show(); return; }
      btn.textContent = 'Planning…';
      btn.disabled = true;
      setTimeout(() => {
        const seed = (Math.random() * 2 ** 31) | 0;
        st.prep = WM.prepareOperation(this.world, st.plan, seed);
        show();
      }, 30);
    }

    closeModal() {
      $('attackModal').hidden = true;
      this.overlayDirty = true;
    }

    refreshEstimate() {
      const st = this.st;
      if (!st.prep) return;
      const d = +$('defense').value;
      $('defenseOut').textContent = d;
      $('defenseTier').textContent = WM.defenseTier(d);
      const hours = st.prep.maxTref / WM.baseSpeed(d);
      $('amDuration').textContent = WM.formatDuration(hours);
      $('amEnd').textContent = WM.formatStamp(st.time + hours);
      let depth = 0;
      for (const c of st.plan.cells) depth = Math.max(depth, st.plan.D[c]);
      const kmPerDay = (depth * this.world.kmAvg) / Math.max(hours, 1) * 24;
      $('amRate').textContent = `≈ ${Math.max(1, Math.round(kmPerDay))} km/day`;
    }

    launch() {
      const st = this.st;
      if (!st.plan || !st.prep) return;
      const d = +$('defense').value;
      const op = new WM.Operation(this.world, st.plan, st.prep, d, st.time);
      st.op = op;
      this.closeModal();
      this.renderer.setField(op, null);
      const att = WM.SIDE_NAME[op.attacker], en = WM.SIDE_NAME[op.enemy];
      const towns = st.plan.cities.length ? ` towards ${st.plan.cities.slice(0, 3).join(', ')}` : '';
      this.addLog({ t: st.time, side: op.attacker, text: `${att} launches an offensive against ${en}${towns}. Enemy defense: ${WM.defenseTier(d).toLowerCase()}.` });
      this.freshCount = 1;
      this.renderLog();
      this.mapDirty = this.overlayDirty = true;
      this.refreshPanels();
      if (st.paused) this.toast('The clock is paused. Press Space or a speed button to start the offensive.');
    }

    flushEvents(events) {
      if (!events.length) return;
      events.sort((a, b) => a.t - b.t);
      for (const ev of events) this.addLog(ev);
      this.freshCount = Math.min(events.length, 6);
      this.overlayDirty = true;
    }

    finishOperation() {
      const st = this.st, op = st.op;
      const events = [];
      op.advance(op.tEnd + 1, events);
      this.flushEvents(events);
      const att = WM.SIDE_NAME[op.attacker];
      this.addLog({
        t: op.tEnd, side: op.attacker,
        text: `${att} offensive complete: ${WM.formatKm2(op.captured)} taken in ${WM.formatDuration(op.tEnd - op.t0)}.`,
      });
      this.freshCount = (this.freshCount || 0) + 1;
      this.toast(`${att} offensive complete. Choose a side to plan the next operation.`);
      this.endOperation();
    }

    haltOperation() {
      const st = this.st, op = st.op;
      if (!op) return;
      const att = WM.SIDE_NAME[op.attacker];
      this.addLog({ t: st.time, side: op.attacker, text: `${att} halts the offensive after ${WM.formatDuration(st.time - op.t0)}, holding ${WM.formatKm2(op.captured)}.` });
      this.freshCount = 1;
      this.endOperation();
    }

    endOperation() {
      const st = this.st;
      st.op = null; st.plan = null; st.prep = null; st.path = null; st.side = 0;
      this.renderer.setField(null, null);
      this.renderer.setGlow();
      this.mapDirty = this.overlayDirty = true;
      this.refreshSides();
      this.refreshPanels();
      this.renderLog();
      this.save();
    }

    // ------------------------------------------------------------- frame ---
    frame(now) {
      const st = this.st;
      const dt = Math.min(0.25, Math.max(0, (now - this.last) / 1000));
      this.last = now;
      if (!st.paused && $('attackModal').hidden) st.time += dt / SPEEDS[st.speed].sph;

      if (st.op) {
        const events = [];
        const done = st.op.advance(st.time, events);
        this.flushEvents(events);
        if (now - this.lastGlow > 500) {
          this.lastGlow = now;
          this.renderer.setGlow();
          this.refreshSides();
        }
        this.refreshOpPanel();
        if (now - (this.lastOverlayTick || 0) > 1000) {
          this.lastOverlayTick = now;
          this.overlayDirty = true;
        }
        if (done) this.finishOperation();
        this.mapDirty = true;
      }
      if (this.logDirty) this.renderLog();

      $('clockDate').textContent = WM.formatDay(st.time);
      $('clockHour').textContent = WM.formatHour(st.time);
      $('hourFill').style.width = `${((st.time % 1) * 100).toFixed(1)}%`;

      const attacker = st.op ? st.op.attacker : st.plan ? st.plan.attacker : 0;
      if (this.mapDirty) {
        this.renderer.render(this.view, { time: st.time, attacker, showTarget: !!(st.op || st.plan) });
        this.mapDirty = false;
      }
      if (this.overlayDirty) {
        const op = st.op;
        const showAxes = op || (st.prep && !$('attackModal').hidden);
        this.overlay.draw(this.view, {
          attacker: attacker || st.side,
          path: st.drawing || (st.plan ? st.plan.path : st.path),
          pathStyle: op ? 'objective' : 'plan',
          extensions: st.plan && !st.drawing ? st.plan.extensions : null,
          axes: showAxes ? (op ? op.prep.axes : st.prep.axes) : null,
          axesAlpha: op ? Math.max(0.25, 1 - op.progress()) : 1,
          showLabels: st.showLabels,
          showProvinces: st.showProvinces,
        });
        this.overlayDirty = false;
      }
      if (now - this.lastSave > 15000) this.save();
      requestAnimationFrame((t) => this.frame(t));
    }
  }

  async function boot() {
    const data = window.WARMAP_DATA;
    try {
      if (!data || !data.geo || !data.grid || !data.relief) throw new Error('Map data is missing. Run tools/build-data.mjs first.');
      const world = await WM.World.load(data);
      const [land, water] = await Promise.all([WM.loadImage(data.relief.land), WM.loadImage(data.relief.water)]);
      WM.app = new App(world, { land, water, scale: data.relief.scale });
    } catch (err) {
      console.error(err);
      const el = $('loading');
      el.classList.add('error');
      el.textContent = `The map could not start: ${err.message}`;
    }
  }
  boot();
})(window.WM);
