// Game controller: clock, camera, input, panels and the war's lifecycle.
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
  const SAVE_KEY = 'warmap-iran-1902-v2';
  const MODE_LABEL = { front: 'Front-line offensive', encircle: 'Encirclement', thrust: 'Thrust (salient)' };
  const fmt = (v) => Math.round(Math.max(0, v)).toLocaleString('en-US');
  const short = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e4 ? `${Math.round(v / 1000)}k` : fmt(v));

  const storage = {
    get() { try { return JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); } catch (e) { return null; } },
    set(v) { try { localStorage.setItem(SAVE_KEY, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
    clear() { try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* storage unavailable */ } },
  };

  // Rows of the forces table: label, value for one side, optional sub-row.
  const FORCE_ROWS = [
    ['Territory', (s) => `${short(s.area)} km²`],
    ['share of Iran', (s) => `${(s.share * 100).toFixed(1)}%`, true],
    ['Population', (s) => short(s.pop)],
    ['Army', (s) => fmt(s.army)],
    ['attacking', (s) => fmt(s.deployed), true],
    ['defending sectors', (s) => fmt(s.defending), true],
    ['Killed', (s) => fmt(s.killed)],
    ['Wounded', (s) => fmt(s.wounded)],
    ['Taken prisoner', (s) => fmt(s.captured)],
    ['Towns held', (s) => String(s.towns)],
    ['occupied', (s) => String(s.occupied), true],
    ['Provinces', (s) => String(s.provinces)],
    ['Morale', (s) => `${Math.round(Math.min(1, s.morale / 1.2) * 100)}%`],
  ];

  class App {
    constructor(world, images) {
      this.world = world;
      this.el = $('app');
      this.planner = new WM.Planner(world);
      this.renderer = new WM.Renderer($('map'), world, images);
      this.overlay = new WM.Overlay($('overlay'), world);
      this.st = {
        time: 0, speed: 0, paused: false,
        side: 0, drawing: null, path: null, plan: null, prep: null, planSeed: 1,
        log: [], showLabels: true, showProvinces: true, uiHidden: false, winner: 0,
      };
      this.view = { cx: 0, cy: 0, scale: 1, dpr: 1, fitScale: 1, w: 1, h: 1 };
      this.mapDirty = this.overlayDirty = true;
      this.opRows = new Map();
      this.timers = { glow: 0, panels: 0, overlay: 0, save: performance.now() };

      if (!this.restore()) this.newWar();
      this.syncMap();

      this.buildForcesTable();
      this.bindUI();
      this.bindInput();
      this.resize();
      this.fit();
      this.refreshPanels();
      this.refreshSpeed();
      this.refreshStats();
      this.refreshOps();
      this.renderLog();
      new ResizeObserver(() => this.resize()).observe(this.el);
      if (window.matchMedia('(max-width: 980px)').matches) this.setDiary(true);
      document.addEventListener('visibilitychange', () => { if (document.hidden) this.save(); });
      window.addEventListener('pagehide', () => this.save());

      this.last = performance.now();
      requestAnimationFrame((t) => this.frame(t));
      $('loading').classList.add('done');
    }

    // ------------------------------------------------------------- state ---
    newWar() {
      this.world.applyScenario();
      this.war = new WM.War(this.world);
      const st = this.st;
      st.time = 0;
      st.plan = null; st.prep = null; st.path = null; st.side = 0; st.winner = 0;
      st.log = [];
      const held = WM.START_RED_PROVINCES.slice(0, -1).join(', ') + ' and ' + WM.START_RED_PROVINCES.slice(-1);
      this.addLog({ t: 0, side: WM.RED, text: `Red forces hold ${held}, with ${fmt(WM.START_ARMY[WM.RED])} men under arms.` });
      this.addLog({ t: 0, side: WM.BLUE, text: `Blue holds the rest of the country and the capital, Tehran, with ${fmt(WM.START_ARMY[WM.BLUE])} men.` });
    }

    save() {
      const st = this.st;
      storage.set({
        v: 2, time: st.time, speed: st.speed, winner: st.winner,
        owner: this.world.encodeOwner(), war: this.war.serialize(), log: st.log.slice(0, 150),
      });
      this.timers.save = performance.now();
    }

    restore() {
      const s = storage.get();
      if (!s || s.v !== 2 || !Array.isArray(s.owner)) return false;
      if (!this.world.decodeOwner(s.owner)) { this.world.applyScenario(); return false; }
      const st = this.st;
      st.time = +s.time || 0;
      st.speed = WM.clamp(s.speed | 0, 0, SPEEDS.length - 1);
      st.winner = s.winner || 0;
      st.log = Array.isArray(s.log) ? s.log : [];
      this.war = new WM.War(this.world);
      try {
        this.war.restore(s.war, st.time);
      } catch (e) {
        console.warn('Could not restore operations', e);
        this.war = new WM.War(this.world);
      }
      return true;
    }

    addLog(ev) {
      this.st.log.unshift({ t: ev.t, side: ev.side || 0, kind: ev.kind || '', text: ev.text });
      if (this.st.log.length > 250) this.st.log.length = 250;
      this.freshCount = (this.freshCount || 0) + 1;
      this.logDirty = true;
    }

    // Push the whole simulation state to the GPU.
    syncMap() {
      this.war.refreshDisplay();
      this.war.syncHalo();
      this.renderer.setOwnership(this.war.display);
      this.war.dirty = false;
      this.renderer.setObjectives(this.war.ops, this.st.plan);
      this.renderer.setGlow();
      this.mapDirty = this.overlayDirty = true;
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
      const col = v.w > 1240 ? 300 : 268;
      const pad = v.w <= 980
        ? { l: 16, r: 16, t: 96, b: Math.min(v.h * 0.44, 320) + 70 }
        : { l: col + 40, r: col + 40, t: 116, b: 60 };
      const aw = Math.max(120, v.w - pad.l - pad.r), ah = Math.max(120, v.h - pad.t - pad.b);
      const scale = Math.min(aw / (bx1 - bx0), ah / (by1 - by0));
      return {
        scale,
        cx: (bx0 + bx1) / 2 - (pad.l - pad.r) / 2 / scale,
        cy: (by0 + by1) / 2 - (pad.t - pad.b) / 2 / scale,
      };
    }

    fit() {
      const f = this.fitParams();
      Object.assign(this.view, { scale: f.scale, cx: f.cx, cy: f.cy, fitScale: f.scale });
      this.clampView();
      this.mapDirty = this.overlayDirty = true;
    }

    clampView() {
      const v = this.view, R = this.world.geo.region;
      v.scale = WM.clamp(v.scale, v.fitScale * 0.5, v.fitScale * 40);
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
      v.scale = WM.clamp(v.scale * factor, v.fitScale * 0.5, v.fitScale * 40);
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

    centerOn([x, y]) {
      const v = this.view;
      v.cx = x;
      v.cy = y;
      v.scale = Math.max(v.scale, v.fitScale * 3);
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
          gesture = { type: 'pan', last: [x, y] };
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
          if (pointers.size === 1) gesture = { type: 'pan', last: [...pointers.values()][0] };
          else if (!pointers.size) gesture = null;
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
        const k = e.key.toLowerCase();
        if (e.key === ' ') { e.preventDefault(); this.togglePause(); }
        else if (e.key >= '1' && e.key <= String(SPEEDS.length)) this.setSpeed(+e.key - 1);
        else if (e.key === '+' || e.key === '=') this.zoomAt(this.view.w / 2, this.view.h / 2, 1.4);
        else if (e.key === '-' || e.key === '_') this.zoomAt(this.view.w / 2, this.view.h / 2, 1 / 1.4);
        else if (k === 'f') this.fit();
        else if (k === 'h') this.toggleUi();
        else if (e.key === 'Escape') this.clearPlan();
      });
    }

    canDraw() {
      return this.st.side && $('attackModal').hidden && !this.st.winner;
    }

    startDraw(x, y) {
      const st = this.st;
      st.drawing = [this.toWorld(x, y)];
      st.plan = null;
      st.prep = null;
      this.renderer.setObjectives(this.war.ops, null);
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
      st.planSeed = (Math.random() * 1e6) | 0;
      this.computePlan(false);
    }

    computePlan(flip) {
      const st = this.st;
      const res = this.planner.plan(st.side, st.path, flip, st.planSeed);
      st.prep = null;
      if (!res.ok) {
        st.plan = null;
        this.toast(res.reason);
      } else {
        st.plan = res;
        this.setTab('command');
      }
      this.renderer.setObjectives(this.war.ops, st.plan);
      this.mapDirty = this.overlayDirty = true;
      this.refreshPanels();
    }

    clearPlan() {
      const st = this.st;
      st.path = null; st.plan = null; st.prep = null; st.drawing = null;
      this.renderer.setObjectives(this.war.ops, null);
      this.mapDirty = this.overlayDirty = true;
      this.refreshPanels();
    }

    // ---------------------------------------------------------------- UI ---
    bindUI() {
      document.querySelectorAll('.side').forEach((b) => b.addEventListener('click', () => this.selectSide(+b.dataset.side)));
      $('btnPause').addEventListener('click', () => this.togglePause());
      document.querySelectorAll('.spd').forEach((b) => b.addEventListener('click', () => this.setSpeed(+b.dataset.speed)));
      $('btnAttack').addEventListener('click', () => this.openModal());
      $('btnFlip').addEventListener('click', () => { if (this.st.plan) this.computePlan(!this.st.plan.flipped); });
      $('btnClear').addEventListener('click', () => this.clearPlan());
      $('zoomIn').addEventListener('click', () => this.zoomAt(this.view.w / 2, this.view.h / 2, 1.5));
      $('zoomOut').addEventListener('click', () => this.zoomAt(this.view.w / 2, this.view.h / 2, 1 / 1.5));
      $('zoomFit').addEventListener('click', () => this.fit());
      $('hideUi').addEventListener('click', () => this.toggleUi());
      $('showUi').addEventListener('click', () => this.toggleUi());
      $('optLabels').addEventListener('change', (e) => { this.st.showLabels = e.target.checked; this.overlayDirty = true; });
      $('optProvinces').addEventListener('change', (e) => { this.st.showProvinces = e.target.checked; this.overlayDirty = true; });
      $('diaryToggle').addEventListener('click', () => this.setDiary($('diary').dataset.collapsed === 'true'));
      document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => this.setTab(b.dataset.tab)));
      $('troops').addEventListener('input', () => this.refreshEstimate(true));
      $('defense').addEventListener('input', () => this.refreshEstimate(true));
      $('amCancel').addEventListener('click', () => this.closeModal());
      $('amLaunch').addEventListener('click', () => this.launch());
      $('attackModal').addEventListener('click', (e) => { if (e.target === $('attackModal')) this.closeModal(); });
      $('opsList').addEventListener('click', (e) => {
        const li = e.target.closest('.op');
        if (!li) return;
        const op = this.war.ops.find((o) => o.id === +li.dataset.id);
        if (!op) return;
        if (e.target.closest('.op-halt')) this.haltOperation(op);
        else if (e.target.closest('.op-name')) {
          const b = this.war.battles().find((x) => x.op === op);
          if (b) this.centerOn(b.at);
        }
      });

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
        this.syncMap();
        this.refreshPanels();
        this.refreshStats();
        this.refreshOps();
        this.renderLog();
        this.save();
        this.toast('A new war begins on 8 January 1902.');
      });
    }

    setTab(tab) {
      this.el.dataset.tab = tab;
    }

    setDiary(collapsed) {
      const small = window.matchMedia('(max-width: 980px)').matches;
      const c = small ? false : collapsed;
      $('diary').dataset.collapsed = c ? 'true' : 'false';
      $('diaryToggle').setAttribute('aria-expanded', String(!c));
    }

    toggleUi() {
      const st = this.st;
      st.uiHidden = !st.uiHidden;
      this.el.classList.toggle('ui-hidden', st.uiHidden);
      $('showUi').hidden = !st.uiHidden;
      if (st.uiHidden) $('toast').hidden = true;
    }

    selectSide(side) {
      const st = this.st;
      st.side = st.side === side ? 0 : side;
      st.path = null; st.plan = null; st.prep = null;
      this.renderer.setObjectives(this.war.ops, null);
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

    buildForcesTable() {
      const body = $('forcesBody');
      this.forceCells = FORCE_ROWS.map(([label, , sub]) => {
        const tr = document.createElement('tr');
        if (sub) tr.className = 'sub';
        const th = document.createElement('td');
        th.textContent = label;
        const b = document.createElement('td'), r = document.createElement('td');
        tr.append(th, b, r);
        body.append(tr);
        return [b, r];
      });
    }

    refreshStats() {
      const s = this.war.stats();
      FORCE_ROWS.forEach(([, get], i) => {
        this.forceCells[i][0].textContent = get(s[1]);
        this.forceCells[i][1].textContent = get(s[2]);
      });
      const pb = Math.round(s[1].power * 100);
      $('powBlue').style.width = `${pb}%`;
      $('powRed').style.width = `${100 - pb}%`;
      $('powBlueTxt').textContent = `Blue ${pb}`;
      $('powRedTxt').textContent = `${100 - pb} Red`;
      $('readyBlue').textContent = `${fmt(s[1].available)} ready`;
      $('readyRed').textContent = `${fmt(s[2].available)} ready`;
    }

    refreshPanels() {
      const st = this.st;
      this.el.classList.toggle('mode-plan', !!st.side);
      this.el.dataset.side = st.side || '';
      document.querySelectorAll('.side').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.side === st.side)));
      const plan = st.plan;
      const hint = $('hint');
      if (st.winner) {
        $('planHint').textContent = `${WM.SIDE_NAME[st.winner]} controls all of Iran. Start a new war to play again.`;
      } else if (!st.side) {
        $('planHint').textContent = 'Pick the side you want to attack with. You can run several offensives at once, for both sides.';
      } else {
        const enemy = WM.SIDE_NAME[st.side === WM.BLUE ? WM.RED : WM.BLUE];
        $('planHint').innerHTML = plan
          ? `Hatched ground is the objective. The line has been shaped into a realistic front. Press <b>Attack</b> to commit troops, or draw again.`
          : `Draw the line your troops should reach in ${enemy} territory. Everything between your front and the line becomes the objective. A loop encircles; a short stroke is a thrust.`;
      }
      $('planFacts').hidden = !plan;
      $('planActions').hidden = !st.side;
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
      hint.textContent = st.side
        ? 'Drag to draw · Right-drag or two fingers to pan · Scroll to zoom · H hides the interface'
        : 'Drag to pan · Scroll to zoom · Space pauses · 1–4 speed · H hides the interface';
    }

    // Operations list, updated in place so buttons keep focus and hover.
    refreshOps() {
      const list = $('opsList');
      const ops = this.war.ops;
      const seen = new Set();
      for (const op of ops) {
        seen.add(op.id);
        let row = this.opRows.get(op.id);
        if (!row) {
          const li = document.createElement('li');
          li.className = 'op';
          li.dataset.id = op.id;
          li.dataset.side = op.side;
          li.innerHTML = `<div class="op-head"><button type="button" class="op-name link-like"></button><span class="op-status"></span></div>
            <div class="op-sub"></div><div class="progress"><i></i></div>
            <div class="op-nums"><span>Attackers</span><span class="n-att"></span><span>Defenders</span><span class="n-def"></span><span>Killed</span><span class="n-kill"></span><span>Ground taken</span><span class="n-area"></span></div>
            <button type="button" class="op-halt">Halt offensive</button>`;
          li.querySelector('.op-name').textContent = `Operation ${op.name}`;
          list.prepend(li);
          row = {
            li, status: li.querySelector('.op-status'), sub: li.querySelector('.op-sub'), bar: li.querySelector('.progress i'),
            att: li.querySelector('.n-att'), def: li.querySelector('.n-def'), kill: li.querySelector('.n-kill'), area: li.querySelector('.n-area'),
          };
          this.opRows.set(op.id, row);
        }
        const age = this.st.time - op.t0;
        const trend = op.trend ?? 0.2;
        const [label, key] = age < 4 ? ['Opening', 'adv'] : trend > 0.12 ? ['Breakthrough', 'break'] : trend > 0.04 ? ['Advancing', 'adv'] : trend > 0.008 ? ['Heavy fighting', 'heavy'] : ['Stalled', 'stall'];
        row.status.textContent = label;
        row.status.dataset.s = key;
        const day = Math.floor(age / 24) + 1, hour = Math.floor(age % 24);
        row.sub.textContent = `${WM.SIDE_NAME[op.side]} → ${WM.SIDE_NAME[op.enemy]} · day ${day}, ${hour} h${op.counter ? ' · under counter-attack' : ''}`;
        row.bar.style.width = `${((1 - op.remaining / op.total) * 100).toFixed(1)}%`;
        row.att.textContent = `${fmt(op.troops)} / ${fmt(op.troops0)}`;
        row.def.textContent = `${fmt(op.defPool)} / ${fmt(op.defPool0)}`;
        row.kill.textContent = `${fmt(op.killedAtt)} · ${fmt(op.killedDef)}`;
        row.area.textContent = `${Math.floor((1 - op.remaining / op.total) * 100)}% · ${short(Math.max(0, op.gained))} km²`;
      }
      for (const [id, row] of this.opRows) {
        if (!seen.has(id)) { row.li.remove(); this.opRows.delete(id); }
      }
      $('opsEmpty').hidden = ops.length > 0;
      $('opsCount').textContent = ops.length ? `${ops.length} active` : '';
      $('tabOps').textContent = ops.length ? String(ops.length) : '';
    }

    renderLog() {
      const items = this.st.log.slice(0, 120);
      const fresh = Math.min(this.freshCount || 0, 8);
      $('log').replaceChildren(...items.map((ev, i) => {
        const li = document.createElement('li');
        li.dataset.side = ev.side;
        li.dataset.kind = ev.kind || '';
        if (i < fresh) li.className = 'fresh';
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
      if (this.st.uiHidden) return;
      const t = $('toast');
      t.textContent = msg;
      t.hidden = false;
      clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => { t.hidden = true; }, 4500);
    }

    // ------------------------------------------------------- offensives ---
    openModal() {
      const st = this.st;
      if (!st.plan) return;
      const avail = this.war.available(st.plan.attacker);
      if (avail < 5000) {
        this.toast(`${WM.SIDE_NAME[st.plan.attacker]} has no troops to spare. Halt an offensive or wait for recruits.`);
        return;
      }
      st.prep = WM.prepareOperation(this.world, st.plan, st.planSeed);
      const att = WM.SIDE_NAME[st.plan.attacker], en = WM.SIDE_NAME[st.plan.enemy];
      $('amTitle').textContent = `Operation ${this.war.nextName()}`;
      const towns = st.plan.cities.length;
      $('amSub').textContent = `${att} against ${en} · ${MODE_LABEL[st.plan.mode]} · ${WM.formatKm2(st.plan.area)} · ${towns} ${towns === 1 ? 'town' : 'towns'}`;
      const max = Math.floor(avail / 1000) * 1000;
      const troops = $('troops');
      troops.max = String(max);
      const suggested = Math.round((st.prep.frontKm0 * 120) / 1000) * 1000;
      troops.value = String(WM.clamp(suggested, 5000, Math.max(5000, Math.round(max * 0.6 / 1000) * 1000)));
      $('troopsMax').textContent = `${fmt(max)} ready`;
      $('attackModal').hidden = false;
      this.refreshEstimate(false);
      this.overlayDirty = true;
      $('troops').focus();
    }

    closeModal() {
      $('attackModal').hidden = true;
      this.fc = null;
      clearTimeout(this.fcTimer);
      this.overlayDirty = true;
    }

    refreshEstimate(debounce) {
      const st = this.st;
      if (!st.prep) return;
      const troops = +$('troops').value, d = +$('defense').value;
      $('troopsOut').textContent = fmt(troops);
      $('defenseOut').textContent = d;
      $('defenseTier').textContent = WM.defenseTier(d);
      const defenders = this.war.defendersFor(st.plan.enemy, WM.sectorDefenders(st.prep, d));
      $('amDefenders').textContent = `≈ ${fmt(defenders)} defenders in the sector`;
      const ratio = troops / Math.max(defenders, 1);
      $('amRatio').textContent = ratio >= 1 ? `${ratio.toFixed(1)} : 1 in our favour` : `1 : ${(1 / ratio).toFixed(1)} against us`;
      for (const id of ['amOutcome', 'amEnd', 'amLosses', 'amEnemyLosses']) {
        $(id).textContent = id === 'amOutcome' ? 'Forecasting…' : '–';
        $(id).classList.toggle('pending', true);
      }
      this.fc = null;
      clearTimeout(this.fcTimer);
      this.fcTimer = setTimeout(() => {
        this.fc = new WM.Forecast(this.war, st.plan, st.prep, troops, d, st.time);
      }, debounce ? 220 : 0);
    }

    showForecast(r) {
      if (!r) return;
      const pct = Math.round(r.progress * 100);
      const outcome = r.reason === 'success'
        ? `Objective taken (${pct}%) in ≈ ${WM.formatDuration(r.hours)}`
        : r.reason === 'exhausted'
          ? `Runs out of men at ${pct}% after ≈ ${WM.formatDuration(r.hours)}`
          : r.reason === 'stalled'
            ? `Bogs down at ${pct}% after ≈ ${WM.formatDuration(r.hours)}`
            : `Still fighting at ${pct}% after ${WM.formatDuration(r.hours)}`;
      $('amOutcome').textContent = outcome;
      $('amEnd').textContent = WM.formatStamp(this.st.time + r.hours);
      $('amLosses').textContent = `≈ ${fmt(r.lossAtt)} (${fmt(r.killedAtt)} killed)`;
      $('amEnemyLosses').textContent = `≈ ${fmt(r.lossDef)} (${fmt(r.killedDef)} killed)`;
      for (const id of ['amOutcome', 'amEnd', 'amLosses', 'amEnemyLosses']) $(id).classList.remove('pending');
    }

    launch() {
      const st = this.st;
      if (!st.plan || !st.prep) return;
      const troops = +$('troops').value, d = +$('defense').value;
      const op = this.war.launch(st.plan, st.prep, { troops, defense: d, t: st.time });
      this.closeModal();
      if (!op) { this.toast('That objective is no longer held by the enemy. Draw a new line.'); this.clearPlan(); return; }
      const att = WM.SIDE_NAME[op.side], en = WM.SIDE_NAME[op.enemy];
      const towns = st.plan.cities.length ? ` towards ${st.plan.cities.slice(0, 3).join(', ')}` : '';
      this.addLog({
        t: st.time, side: op.side, kind: 'op',
        text: `Operation ${op.name}: ${att} attacks ${en}${towns} with ${fmt(troops)} men. About ${fmt(op.defPool0)} ${en} troops defend the sector (${WM.defenseTier(d).toLowerCase()}).`,
      });
      st.plan = null; st.prep = null; st.path = null;
      this.renderer.setObjectives(this.war.ops, null);
      this.mapDirty = this.overlayDirty = true;
      this.refreshPanels();
      this.refreshOps();
      this.refreshStats();
      this.setTab('ops');
      this.toast(st.paused ? `Operation ${op.name} is ready. The clock is paused; press Space to start.` : `Operation ${op.name} launched.`);
    }

    haltOperation(op) {
      const events = [];
      this.war.halt(op, this.st.time, events);
      this.handleEvents(events);
      this.opsChanged();
    }

    handleEvents(events) {
      events.sort((a, b) => a.t - b.t);
      for (const ev of events) {
        this.addLog(ev);
        if (ev.kind === 'op') this.toast(ev.text.split(':')[0] + '.');
      }
      this.overlayDirty = true;
      const s = this.war.sides;
      if (!this.st.winner) {
        for (const side of [1, 2]) {
          const other = side === 1 ? 2 : 1;
          if (s[other].area <= 1) {
            this.st.winner = side;
            this.addLog({ t: this.st.time, side, kind: 'op', text: `${WM.SIDE_NAME[side]} controls all of Iran. The war is over.` });
            this.toast(`${WM.SIDE_NAME[side]} has won the war.`);
            this.refreshPanels();
          }
        }
      }
    }

    opsChanged() {
      this.renderer.setObjectives(this.war.ops, this.st.plan);
      this.mapDirty = this.overlayDirty = true;
      this.refreshOps();
      this.refreshStats();
      this.save();
    }

    // Battle labels glide to a new position when the main effort moves
    // instead of jumping there.
    smoothBattles(list) {
      const prev = this.labelPos || new Map();
      const next = new Map();
      for (const b of list) {
        const p = prev.get(b.op.id);
        if (p && Math.hypot(p.at[0] - b.at[0], p.at[1] - b.at[1]) < 400) {
          const k = 0.18;
          b.at = [p.at[0] + (b.at[0] - p.at[0]) * k, p.at[1] + (b.at[1] - p.at[1]) * k];
          let dx = p.dir[0] + (b.dir[0] - p.dir[0]) * k, dy = p.dir[1] + (b.dir[1] - p.dir[1]) * k;
          const l = Math.hypot(dx, dy) || 1;
          b.dir = [dx / l, dy / l];
        }
        next.set(b.op.id, { at: b.at, dir: b.dir });
      }
      this.labelPos = next;
      return list;
    }

    // ------------------------------------------------------------- frame ---
    frame(now) {
      const st = this.st, war = this.war;
      const dt = Math.min(0.25, Math.max(0, (now - this.last) / 1000));
      this.last = now;
      const modalOpen = !$('attackModal').hidden;

      if (!st.paused && !modalOpen) {
        const dh = dt / SPEEDS[st.speed].sph;
        const events = [];
        const before = war.ops.length;
        war.step(dh, st.time, events);
        st.time += dh;
        if (events.length) this.handleEvents(events);
        if (war.ops.length !== before) this.opsChanged();
      }
      if (war.dirty) {
        war.syncHalo();
        this.renderer.setOwnership(war.display);
        war.dirty = false;
        this.mapDirty = true;
        this.ownChanged = true;
      }
      if (this.ownChanged && now - this.timers.glow > 700) {
        this.renderer.setGlow();
        this.timers.glow = now;
        this.ownChanged = false;
      }
      if (now - this.timers.panels > 250) {
        this.timers.panels = now;
        this.refreshStats();
        this.refreshOps();
      }
      if (war.ops.length && now - this.timers.overlay > 120) {
        this.timers.overlay = now;
        this.overlayDirty = true;
      }
      if (this.logDirty) this.renderLog();
      if (this.fc) {
        if (this.fc.run(10)) {
          this.showForecast(this.fc.result());
          this.fc = null;
        }
      }

      $('clockDate').textContent = WM.formatDay(st.time);
      $('clockHour').textContent = WM.formatHour(st.time);
      $('hourFill').style.width = `${((st.time % 1) * 100).toFixed(1)}%`;

      if (this.mapDirty) {
        this.renderer.render(this.view, { planSide: st.plan ? st.plan.attacker : 0 });
        this.mapDirty = false;
      }
      if (this.overlayDirty) {
        this.overlay.draw(this.view, {
          time: st.time,
          ops: war.ops,
          planSide: st.side,
          path: st.drawing || (st.plan ? st.plan.path : null),
          drawing: !!st.drawing,
          extensions: st.plan && !st.drawing ? st.plan.extensions : null,
          planArrows: st.prep && modalOpen ? st.prep.arrows : null,
          battles: this.smoothBattles(war.battles()),
          showLabels: st.showLabels,
          showProvinces: st.showProvinces,
        });
        this.overlayDirty = false;
      }
      if (now - this.timers.save > 10000) this.save();
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
