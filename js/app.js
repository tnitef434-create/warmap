// Game controller: modes, clock, camera, input, panels and the war's lifecycle.
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
  const SAVE_KEY = 'warmap-iran-1902-v3';
  const MAX_PLANS = 8;
  const REINFORCE = 5000;
  const MODE_LABEL = { front: 'Front-line offensive', encircle: 'Encirclement', thrust: 'Thrust (salient)' };
  const fmt = (v) => Math.round(Math.max(0, v)).toLocaleString('en-US');
  const short = (v) => (v >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : v >= 1e4 ? `${Math.round(v / 1000)}k` : fmt(v));
  const pct = (v) => `${Math.round(WM.clamp(v, 0, 1) * 100)}%`;
  const other = (s) => (s === WM.BLUE ? WM.RED : WM.BLUE);

  const storage = {
    get() { try { return JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); } catch (e) { return null; } },
    set(v) { try { localStorage.setItem(SAVE_KEY, JSON.stringify(v)); } catch (e) { /* storage unavailable */ } },
    clear() { try { localStorage.removeItem(SAVE_KEY); } catch (e) { /* storage unavailable */ } },
  };

  // Rows of the sandbox forces table: label, value for one side, sub-row?
  const FORCE_ROWS = [
    ['Territory', (s) => `${short(s.area)} km²`],
    ['share of Iran', (s) => `${(s.share * 100).toFixed(1)}%`, true],
    ['Population', (s) => short(s.pop)],
    ['Army', (s) => fmt(s.army)],
    ['ready', (s) => fmt(s.available), true],
    ['attacking', (s) => fmt(s.deployed), true],
    ['defending sectors', (s) => fmt(s.defending), true],
    ['on defense lines', (s) => fmt(s.garrison), true],
    ['Training a day', (s) => `+${fmt(s.training)}`],
    ['Killed', (s) => fmt(s.killed)],
    ['Wounded', (s) => fmt(s.wounded)],
    ['Taken prisoner', (s) => fmt(s.captured)],
    ['Towns held', (s) => String(s.towns)],
    ['occupied', (s) => String(s.occupied), true],
    ['Provinces', (s) => String(s.provinces)],
    ['Readiness', (s) => pct(1 - s.fatigue / 0.9)],
    ['Morale', (s) => pct(s.morale / 1.2)],
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
        mode: 'sandbox', player: 0, level: 'normal',
        side: 0, tool: 'attack', drawing: null, plans: [], planCounter: 0,
        log: [], showLabels: true, showProvinces: true, uiHidden: false, winner: 0, over: false,
      };
      this.view = { cx: 0, cy: 0, scale: 1, dpr: 1, fitScale: 1, w: 1, h: 1 };
      this.mapDirty = this.overlayDirty = true;
      this.opRows = new Map();
      this.timers = { glow: 0, panels: 0, overlay: 0, save: performance.now() };
      this.menuLevel = 'normal';

      const resumed = this.restore();
      // Nothing is saved until a game has been chosen from the menu.
      this.started = resumed;
      if (!resumed) this.newGame('sandbox', 0, 'normal', true);

      this.buildForcesTable();
      this.bindUI();
      this.bindInput();
      this.resize();
      this.fit();
      this.syncMap();
      this.applyMode();
      this.refreshSpeed();
      this.renderLog();
      new ResizeObserver(() => this.resize()).observe(this.el);
      if (window.matchMedia('(max-width: 980px)').matches) this.setDiary(true);
      document.addEventListener('visibilitychange', () => { if (document.hidden) this.save(); });
      window.addEventListener('pagehide', () => this.save());
      if (!resumed) this.openMenu(false);

      this.last = performance.now();
      requestAnimationFrame((t) => this.frame(t));
      $('loading').classList.add('done');
    }

    get campaign() { return this.st.mode === 'campaign'; }

    // ------------------------------------------------------------- state ---
    newGame(mode, player, level, quiet) {
      const st = this.st;
      this.world.applyScenario();
      this.war = new WM.War(this.world);
      Object.assign(st, {
        mode, player: mode === 'campaign' ? player : 0, level, time: 0, winner: 0, over: false,
        plans: [], drawing: null, side: mode === 'campaign' ? player : 0, tool: 'attack', log: [], paused: false, history: [],
      });
      this.snapshot(true);
      this.ai = mode === 'campaign' ? new WM.AI(this.war, this.planner, other(player), level) : null;
      const held = WM.START_RED_PROVINCES.slice(0, -1).join(', ') + ' and ' + WM.START_RED_PROVINCES.slice(-1);
      this.addLog({ t: 0, side: WM.RED, text: `Red forces hold ${held}, with ${fmt(WM.START_ARMY[WM.RED])} men under arms.` });
      this.addLog({ t: 0, side: WM.BLUE, text: `Blue holds the rest of the country and the capital, Tehran, with ${fmt(WM.START_ARMY[WM.BLUE])} men.` });
      if (mode === 'campaign') {
        this.addLog({
          t: 0, side: player, kind: 'op',
          text: `You command ${WM.SIDE_NAME[player]}. ${WM.SIDE_NAME[other(player)]} is led by the computer (${WM.DIFFICULTY[level].label.toLowerCase()}).`,
        });
      }
      if (quiet) return;
      this.started = true;
      this.opRows.forEach((r) => r.li.remove());
      this.opRows.clear();
      this.syncMap();
      this.applyMode();
      this.renderLog();
      this.fit();
      this.save();
    }

    save() {
      const st = this.st;
      if (!this.war || !this.started) return;
      storage.set({
        v: 3, mode: st.mode, player: st.player, level: st.level, time: st.time, speed: st.speed,
        winner: st.winner, over: st.over, owner: this.world.encodeOwner(), war: this.war.serialize(),
        ai: this.ai ? this.ai.save() : null, log: st.log.slice(0, 150), history: (st.history || []).slice(-400),
      });
      this.timers.save = performance.now();
    }

    restore() {
      const s = storage.get();
      if (!s || s.v !== 3 || !Array.isArray(s.owner)) return false;
      if (!this.world.decodeOwner(s.owner)) { this.world.applyScenario(); return false; }
      const st = this.st;
      Object.assign(st, {
        mode: s.mode === 'campaign' ? 'campaign' : 'sandbox', player: s.player || 0, level: s.level || 'normal',
        time: +s.time || 0, speed: WM.clamp(s.speed | 0, 0, SPEEDS.length - 1), winner: s.winner || 0, over: !!s.over,
        log: Array.isArray(s.log) ? s.log : [], history: Array.isArray(s.history) ? s.history : [],
      });
      st.side = st.mode === 'campaign' ? st.player : 0;
      this.war = new WM.War(this.world);
      try {
        this.war.restore(s.war, st.time);
      } catch (e) {
        console.warn('Could not restore operations', e);
        this.war = new WM.War(this.world);
      }
      this.ai = st.mode === 'campaign' ? new WM.AI(this.war, this.planner, other(st.player), st.level, s.ai) : null;
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
      this.refreshObjectives();
      this.renderer.setGlow();
      this.mapDirty = this.overlayDirty = true;
    }

    refreshObjectives() {
      this.renderer.setObjectives(this.war.ops, this.st.plans.filter((e) => e.kind === 'attack'));
      this.mapDirty = this.overlayDirty = true;
    }

    // Show the panels that belong to the current mode.
    applyMode() {
      const st = this.st, camp = this.campaign;
      this.el.dataset.mode = st.mode;
      $('modeChip').textContent = camp ? `Campaign · ${WM.DIFFICULTY[st.level].label}` : 'Sandbox';
      $('sidesBox').hidden = camp;
      $('commandBanner').hidden = !camp;
      if (camp) {
        $('commandBanner').dataset.side = st.player;
        $('commandBanner').textContent = `You command ${WM.SIDE_NAME[st.player]}`;
      }
      $('armyCard').hidden = !camp;
      $('sandboxStats').hidden = camp;
      $('forcesTitle').textContent = camp ? 'Your army' : 'Forces';
      this.refreshPanels();
      this.refreshStats();
      this.refreshOps();
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
        // Right-click a defense line, or tap one with the defense tool, to remove it.
        if ((e.button === 2 || (this.st.tool === 'fort' && drawButton)) && pointers.size === 1) {
          const f = this.fortAt(x, y);
          if (f) { pointers.delete(e.pointerId); this.abandonFort(f); return; }
        }
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
        if (this.dialogOpen()) {
          if (e.key === 'Escape') { if (!$('attackModal').hidden) this.closeModal(); else if (!$('menu').hidden) this.closeMenu(); }
          return;
        }
        const k = e.key.toLowerCase();
        if (e.key === ' ') { e.preventDefault(); this.togglePause(); }
        else if (e.key >= '1' && e.key <= String(SPEEDS.length)) this.setSpeed(+e.key - 1);
        else if (e.key === '+' || e.key === '=') this.zoomAt(this.view.w / 2, this.view.h / 2, 1.4);
        else if (e.key === '-' || e.key === '_') this.zoomAt(this.view.w / 2, this.view.h / 2, 1 / 1.4);
        else if (k === 'f') this.fit();
        else if (k === 'h') this.toggleUi();
        else if (k === 'a') this.setTool('attack');
        else if (k === 'd') this.setTool('fort');
        else if (e.key === 'Escape') this.removePlan(this.st.plans.length ? this.st.plans[this.st.plans.length - 1].id : 0);
      });
    }

    dialogOpen() {
      return !$('attackModal').hidden || !$('menu').hidden || !$('endModal').hidden || !!this.replay;
    }

    canDraw() {
      const st = this.st;
      return st.side && st.tool && !this.dialogOpen() && !st.over && !st.winner;
    }

    startDraw(x, y) {
      this.st.drawing = [this.toWorld(x, y)];
      this.overlayDirty = true;
    }

    cancelDraw() {
      this.st.drawing = null;
      this.overlayDirty = true;
    }

    // Every finished stroke is added to the planned orders; nothing is replaced.
    endDraw() {
      const st = this.st;
      const path = st.drawing;
      st.drawing = null;
      this.overlayDirty = true;
      if (!path || path.length < 3) return;
      if (st.plans.length >= MAX_PLANS) {
        this.toast(`You can plan up to ${MAX_PLANS} orders at once. Carry them out or remove one first.`);
        return;
      }
      const entry = { id: ++st.planCounter, kind: st.tool, side: st.side, path, seed: (Math.random() * 1e6) | 0 };
      if (entry.kind === 'fort') {
        const f = this.planner.fortLine(entry.side, path, entry.seed);
        if (!f.ok) { this.toast(f.reason); return; }
        entry.fort = f;
      } else if (!this.replan(entry, false)) return;
      st.plans.push(entry);
      this.setTab('command');
      this.plansChanged();
    }

    replan(entry, flip) {
      const res = this.planner.plan(entry.side, entry.path, flip, entry.seed);
      if (!res.ok) { this.toast(res.reason); return false; }
      entry.plan = res;
      entry.prep = null;
      return true;
    }

    flipPlan(id) {
      const entry = this.st.plans.find((e) => e.id === id);
      if (entry && entry.plan && entry.plan.canFlip && this.replan(entry, !entry.plan.flipped)) this.plansChanged();
    }

    removePlan(id) {
      const st = this.st;
      const n = st.plans.length;
      st.plans = st.plans.filter((e) => e.id !== id);
      if (st.plans.length !== n) this.plansChanged();
    }

    clearPlans() {
      this.st.plans = [];
      this.st.drawing = null;
      this.plansChanged();
    }

    plansChanged() {
      this.refreshObjectives();
      this.refreshPanels();
    }

    // ---------------------------------------------------------------- UI ---
    bindUI() {
      document.querySelectorAll('.side').forEach((b) => b.addEventListener('click', () => this.selectSide(+b.dataset.side)));
      document.querySelectorAll('.tool').forEach((b) => b.addEventListener('click', () => this.setTool(b.dataset.tool)));
      $('btnPause').addEventListener('click', () => this.togglePause());
      document.querySelectorAll('.spd').forEach((b) => b.addEventListener('click', () => this.setSpeed(+b.dataset.speed)));
      $('btnAttack').addEventListener('click', () => this.openModal());
      $('btnClear').addEventListener('click', () => this.clearPlans());
      $('planList').addEventListener('click', (e) => {
        const li = e.target.closest('.plan');
        if (!li) return;
        const id = +li.dataset.id;
        if (e.target.closest('.plan-flip')) this.flipPlan(id);
        else if (e.target.closest('.plan-remove')) this.removePlan(id);
      });
      $('fortList').addEventListener('click', (e) => {
        const li = e.target.closest('.fort');
        if (!li || !e.target.closest('.fort-remove')) return;
        const f = this.war.forts.find((x) => x.id === +li.dataset.id);
        if (f) this.abandonFort(f);
      });
      $('fortClear').addEventListener('click', () => {
        for (const f of this.war.forts.filter((f) => !this.campaign || f.side === this.st.player)) this.abandonFort(f, true);
        this.refreshPanels();
        this.refreshStats();
      });
      $('zoomIn').addEventListener('click', () => this.zoomAt(this.view.w / 2, this.view.h / 2, 1.5));
      $('zoomOut').addEventListener('click', () => this.zoomAt(this.view.w / 2, this.view.h / 2, 1 / 1.5));
      $('zoomFit').addEventListener('click', () => this.fit());
      $('hideUi').addEventListener('click', () => this.toggleUi());
      $('showUi').addEventListener('click', () => this.toggleUi());
      $('optLabels').addEventListener('change', (e) => { this.st.showLabels = e.target.checked; this.overlayDirty = true; });
      $('optProvinces').addEventListener('change', (e) => { this.st.showProvinces = e.target.checked; this.overlayDirty = true; });
      $('diaryToggle').addEventListener('click', () => this.setDiary($('diary').dataset.collapsed === 'true'));
      document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => this.setTab(b.dataset.tab)));
      $('amPlans').addEventListener('input', (e) => {
        const sec = e.target.closest('.am-plan');
        if (sec) this.refreshEstimates(+sec.dataset.id);
      });
      $('amCancel').addEventListener('click', () => this.closeModal());
      $('amLaunch').addEventListener('click', () => this.launch());
      $('attackModal').addEventListener('click', (e) => { if (e.target === $('attackModal')) this.closeModal(); });
      $('opsList').addEventListener('click', (e) => {
        const li = e.target.closest('.op');
        if (!li) return;
        const op = this.war.ops.find((o) => o.id === +li.dataset.id);
        if (!op) return;
        const act = e.target.closest('[data-act]');
        if (act) this.opAction(op, act.dataset.act);
        else if (e.target.closest('.op-name')) {
          const b = this.war.battles().find((x) => x.op === op);
          if (b) this.centerOn(b.at);
        }
      });
      $('btnMenu').addEventListener('click', () => this.openMenu(true));
      $('menuResume').addEventListener('click', () => this.closeMenu());
      document.querySelectorAll('#menu [data-level]').forEach((b) => b.addEventListener('click', () => {
        this.menuLevel = b.dataset.level;
        document.querySelectorAll('#menu [data-level]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      }));
      document.querySelectorAll('#menu [data-play]').forEach((b) => b.addEventListener('click', () => {
        const p = +b.dataset.play;
        this.closeMenu();
        storage.clear();
        this.newGame(p ? 'campaign' : 'sandbox', p, this.menuLevel);
        this.toast(p ? `Campaign started. You command ${WM.SIDE_NAME[p]}; the enemy will strike soon.` : 'Sandbox: you give orders to both armies.');
      }));
      $('endWatch').addEventListener('click', () => { $('endModal').hidden = true; });
      $('endReplay').addEventListener('click', () => this.startReplay());
      $('btnReplay').addEventListener('click', () => this.startReplay());
      $('rpClose').addEventListener('click', () => this.stopReplay());
      $('rpPlay').addEventListener('click', () => {
        const rp = this.replay;
        if (rp.pos >= this.st.history.length - 1) rp.pos = 0;
        rp.playing = !rp.playing;
        $('rpPlay').textContent = rp.playing ? 'Pause' : 'Play';
      });
      document.querySelectorAll('#replayBar [data-rate]').forEach((b) => b.addEventListener('click', () => { this.replay.rate = +b.dataset.rate; }));
      $('rpSeek').addEventListener('input', (e) => { this.replay.pos = +e.target.value; this.showReplay(+e.target.value); });
      $('endNew').addEventListener('click', () => { $('endModal').hidden = true; this.openMenu(false); });
    }

    openMenu(canResume) {
      $('menuResume').hidden = !canResume;
      document.querySelectorAll('#menu [data-level]').forEach((x) => x.setAttribute('aria-pressed', String(x.dataset.level === this.menuLevel)));
      $('menu').hidden = false;
    }

    closeMenu() {
      $('menu').hidden = true;
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
      if (this.campaign) return;
      st.side = st.side === side ? 0 : side;
      if (st.side && !st.tool) st.tool = 'attack';
      this.overlayDirty = true;
      this.refreshPanels();
    }

    setTool(tool) {
      const st = this.st;
      if (!this.campaign && !st.side) { this.toast('Pick Blue or Red first.'); return; }
      st.tool = st.tool === tool ? null : tool;
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
      if (this.campaign) {
        const me = s[this.st.player], foe = s[other(this.st.player)];
        $('acReady').textContent = fmt(me.available);
        $('acSplit').textContent = `${fmt(me.deployed)} attacking · ${fmt(me.defending)} defending · ${fmt(me.garrison)} on defense lines`;
        $('acTrain').textContent = me.resting
          ? `Training +${fmt(me.training)} a day. Resting: twice the usual rate.`
          : `Training +${fmt(me.training)} a day. Stop attacking to train twice as fast.`;
        const readiness = 1 - me.fatigue / 0.9;
        $('acReadiness').style.width = pct(readiness);
        $('acReadinessTxt').textContent = pct(readiness);
        $('acMorale').style.width = pct(me.morale / 1.2);
        $('acMoraleTxt').textContent = pct(me.morale / 1.2);
        const mine = Math.round(me.share * 100);
        $('acLandYou').style.width = `${mine}%`;
        $('acLandFoe').style.width = `${100 - mine}%`;
        $('acLandTxt').textContent = `You ${mine}% of Iran · Enemy ${100 - mine}%`;
        $('acEnemy').textContent = `≈ ${fmt(Math.round(foe.army / 5000) * 5000)}`;
        $('acKilled').textContent = `${fmt(me.killed)} · ${fmt(foe.killed)}`;
        $('acTowns').textContent = `${me.towns} · ${foe.towns}`;
        this.el.dataset.player = this.st.player;
      } else {
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
    }

    refreshPanels() {
      const st = this.st, camp = this.campaign;
      this.el.classList.toggle('mode-plan', !!(st.side && st.tool));
      this.el.dataset.side = st.side || '';
      document.querySelectorAll('.side').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.side === st.side)));
      document.querySelectorAll('.tool').forEach((b) => {
        b.setAttribute('aria-pressed', String(st.tool === b.dataset.tool && !!st.side));
        b.disabled = !st.side;
      });
      const plans = st.plans;
      const enemy = st.side ? WM.SIDE_NAME[other(st.side)] : '';
      let hint;
      if (st.winner || st.over) hint = 'The war is over. Open the menu to start a new one.';
      else if (plans.length) hint = `${plans.length} ${plans.length === 1 ? 'order' : 'orders'} planned. Draw more, then carry them out all at once.`;
      else if (!st.side) hint = 'Pick a side, then draw attack lines or defense lines. You can plan several and launch them together, for one side or both.';
      else if (st.tool === 'fort') hint = `Draw a defense line inside ${WM.SIDE_NAME[st.side]} land. Attacks that reach it face about three times the resistance. It needs ${WM.FORT_MEN_PER_KM} men per km and ${WM.FORT_BUILD_HOURS} hours to dig. Tap an existing line (or right-click it) to remove it.`;
      else if (st.tool === 'attack') hint = `Draw the line your troops should reach in ${enemy} territory. A loop encircles; a short stroke is a thrust. ${camp ? 'Right-drag pans.' : ''}`;
      else hint = 'Pick Attack line or Defense line to draw. Drag the map to look around.';
      $('planHint').textContent = hint;
      $('planList').replaceChildren(...plans.map((e, i) => {
        const li = document.createElement('li');
        li.className = 'plan';
        li.dataset.id = e.id;
        li.dataset.side = e.side;
        li.innerHTML = `<div class="plan-text"><span class="plan-title"></span><span class="plan-sub"></span></div>
          <button type="button" class="plan-flip" title="Take the other side of this line" aria-label="Flip objective">⇄</button>
          <button type="button" class="plan-remove" title="Remove" aria-label="Remove">×</button>`;
        if (e.kind === 'fort') {
          li.querySelector('.plan-title').textContent = `${i + 1} · Defense line · ${WM.SIDE_NAME[e.side]}`;
          li.querySelector('.plan-sub').textContent = `${Math.round(e.fort.km)} km · ${fmt(e.fort.garrison)} men · ${WM.FORT_BUILD_HOURS} h to dig`;
          li.querySelector('.plan-flip').hidden = true;
        } else {
          const p = e.plan;
          const towns = p.cities.length ? ` · ${p.cities.slice(0, 2).join(', ')}${p.cities.length > 2 ? ` +${p.cities.length - 2}` : ''}` : '';
          li.querySelector('.plan-title').textContent = `${i + 1} · Attack · ${WM.SIDE_NAME[p.attacker]} → ${WM.SIDE_NAME[p.enemy]}`;
          li.querySelector('.plan-sub').textContent = `${MODE_LABEL[p.mode]}${p.flipped ? ' (flipped)' : ''} · ${WM.formatKm2(p.area)}${towns}`;
          li.querySelector('.plan-flip').disabled = !p.canFlip;
        }
        return li;
      }));
      $('planList').hidden = !plans.length;
      $('planActions').hidden = !plans.length;
      const nA = plans.filter((e) => e.kind === 'attack').length, nF = plans.length - nA;
      $('btnAttack').textContent = !nF ? (nA > 1 ? `Attack with all ${nA}` : 'Attack')
        : !nA ? (nF > 1 ? `Build ${nF} defense lines` : 'Build defense line') : `Carry out all ${plans.length} orders`;
      $('btnAttack').disabled = !plans.length;
      $('btnClear').disabled = !plans.length;
      this.refreshForts();
      $('hint').textContent = st.side && st.tool
        ? 'Drag to draw · Right-drag or two fingers to pan · Scroll to zoom · H hides the interface'
        : 'Drag to pan · Scroll to zoom · Space pauses · 1–4 speed · H hides the interface';
    }

    refreshForts() {
      const st = this.st;
      const forts = this.war.forts.filter((f) => !this.campaign || f.side === st.player);
      $('fortBox').hidden = !forts.length;
      $('fortList').replaceChildren(...forts.map((f) => {
        const li = document.createElement('li');
        li.className = 'fort';
        li.dataset.id = f.id;
        li.dataset.side = f.side;
        const town = this.world.nearestTown(...this.gridOf(f.path[Math.floor(f.path.length / 2)]));
        li.innerHTML = '<span class="fort-text"></span><button type="button" class="fort-remove" title="Abandon this line; its men return to the reserve" aria-label="Remove defense line">Remove</button>';
        const state = f.built < 1 ? `digging ${Math.round(f.built * 100)}%` : f.breached ? 'breached' : 'ready';
        li.querySelector('.fort-text').textContent = `${this.campaign ? '' : WM.SIDE_NAME[f.side] + ' · '}near ${town ? town.name : '?'} · ${fmt(f.garrison)} men · ${state}`;
        return li;
      }));
    }

    // The player's defense line closest to a screen point, within a few pixels.
    fortAt(sx, sy) {
      const [wx, wy] = this.toWorld(sx, sy);
      const tol = 12 / this.view.scale;
      let best = null, bd = tol;
      for (const f of this.war.forts) {
        if (this.campaign && f.side !== this.st.player) continue;
        const P = f.path;
        for (let i = 1; i < P.length; i++) {
          const [ax, ay] = P[i - 1], [bx, by] = P[i];
          const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy || 1;
          const u = WM.clamp(((wx - ax) * dx + (wy - ay) * dy) / L, 0, 1);
          const d = Math.hypot(wx - ax - u * dx, wy - ay - u * dy);
          if (d < bd) { bd = d; best = f; }
        }
      }
      return best;
    }

    abandonFort(f, quiet) {
      this.war.removeFort(f.id);
      const town = this.world.nearestTown(...this.gridOf(f.path[Math.floor(f.path.length / 2)]));
      this.addLog({ t: this.st.time, side: f.side, text: `${WM.SIDE_NAME[f.side]} abandons the defense line near ${town ? town.name : 'the front'}; ${fmt(f.garrison)} men return to the reserve.` });
      this.overlayDirty = true;
      if (!quiet) { this.refreshPanels(); this.refreshStats(); }
    }

    gridOf([x, y]) {
      return [(x - this.world.x0) / this.world.cell, (y - this.world.y0) / this.world.cell];
    }

    // Operations list, updated in place so buttons keep focus and hover.
    refreshOps() {
      const list = $('opsList');
      const ops = this.war.ops;
      const seen = new Set();
      const camp = this.campaign, me = this.st.player;
      for (const op of ops) {
        seen.add(op.id);
        let row = this.opRows.get(op.id);
        if (!row) {
          const li = document.createElement('li');
          li.className = 'op';
          li.dataset.id = op.id;
          li.dataset.side = op.side;
          const ours = !camp || op.side === me;
          if (camp && !ours) li.classList.add('enemy');
          const b = (act, label) => `<button type="button" data-act="${act}">${label}</button>`;
          const acts = !camp
            ? b('att', '+5,000 attackers') + b('pull', '−5,000 attackers') + b('def', '+5,000 defenders') + b('pulldef', '−5,000 defenders') + b('counter', 'Counter-attack') + b('replan', 'New plan from this') + b('halt', 'Halt')
            : ours
              ? b('att', 'Boost +5,000') + b('pull', 'Withdraw 5,000') + b('replan', 'New plan from this') + b('halt', 'Halt')
              : b('def', 'Send 5,000 defenders') + b('pulldef', 'Withdraw 5,000') + b('counter', 'Counter-attack');
          li.innerHTML = `<div class="op-head"><button type="button" class="op-name"></button><span class="op-status"></span></div>
            <div class="op-sub"></div><div class="progress"><i></i></div>
            <div class="op-nums"><span>Attackers</span><span class="n-att"></span><span>Defenders</span><span class="n-def"></span><span>Killed</span><span class="n-kill"></span><span>Ground taken</span><span class="n-area"></span></div>
            <p class="op-advice" hidden></p>
            <div class="op-acts">${acts}</div>`;
          li.querySelector('.op-name').textContent = `Operation ${op.name}`;
          list.prepend(li);
          row = {
            li, status: li.querySelector('.op-status'), sub: li.querySelector('.op-sub'), bar: li.querySelector('.progress i'),
            att: li.querySelector('.n-att'), def: li.querySelector('.n-def'), kill: li.querySelector('.n-kill'), area: li.querySelector('.n-area'),
            advice: li.querySelector('.op-advice'), counter: li.querySelector('[data-act="counter"]'),
          };
          this.opRows.set(op.id, row);
        }
        const age = this.st.time - op.t0;
        const trend = op.trend ?? 0.2;
        const [label, key] = age < 4 ? ['Opening', 'adv'] : trend > 0.025 ? ['Breakthrough', 'break'] : trend > 0.008 ? ['Advancing', 'adv'] : trend > 0.0016 ? ['Heavy fighting', 'heavy'] : ['Stalled', 'stall'];
        row.status.textContent = label;
        row.status.dataset.s = key;
        const day = Math.floor(age / 24) + 1, hour = Math.floor(age % 24);
        const who = camp ? (op.side === me ? 'Your attack' : 'Enemy attack on you') : `${WM.SIDE_NAME[op.side]} → ${WM.SIDE_NAME[op.enemy]}`;
        row.sub.textContent = `${who} · day ${day}, ${hour} h${op.counter ? ' · counter-attack under way' : ''}`;
        row.bar.style.width = `${((1 - op.remaining / op.total) * 100).toFixed(1)}%`;
        row.att.textContent = `${fmt(op.troops)} / ${fmt(op.troops0)}`;
        row.def.textContent = `${fmt(op.defPool)} / ${fmt(op.defPool0)}`;
        row.kill.textContent = `${fmt(op.killedAtt)} · ${fmt(op.killedDef)}`;
        row.area.textContent = `${Math.floor((1 - op.remaining / op.total) * 100)}% · ${short(Math.max(0, op.gained))} km²`;
        // Advice: call off attacks that bleed or go nowhere; strike back when holding well.
        const bleeding = op.lossAtt > 0.35 * op.troops0, stuck = age > 120 && trend < 0.0016;
        const winningDefence = op.defPool > 1.3 * op.troops && op.gained > 300 && !op.countered;
        const ownsAttack = !camp || op.side === me, ownsDefence = !camp || op.enemy === me;
        let advice = '';
        if (ownsAttack && (bleeding || stuck)) advice = `Advice: halt this attack. ${bleeding ? 'It is costing too many men' : 'It has stopped making progress'}; halting costs about ${fmt(op.troops * 0.08)} men in the retreat.`;
        else if (ownsDefence && winningDefence) advice = 'Advice: your defenders clearly outnumber the attackers here. Counter-attack to take the ground back.';
        row.advice.textContent = advice;
        row.advice.hidden = !advice;
        if (row.counter) row.counter.hidden = !winningDefence;
      }
      for (const [id, row] of this.opRows) {
        if (!seen.has(id)) { row.li.remove(); this.opRows.delete(id); }
      }
      $('opsEmpty').hidden = ops.length > 0;
      $('opsEmpty').textContent = camp ? 'No battles right now. Rest to train soldiers, dig defense lines, or attack.' : 'No offensives under way. Pick a side and draw a line into enemy land.';
      $('opsCount').textContent = ops.length ? `${ops.length} active` : '';
      $('tabOps').textContent = ops.length ? String(ops.length) : '';
    }

    opAction(op, act) {
      const st = this.st;
      if (act === 'halt') { this.haltOperation(op); return; }
      if (act === 'replan') {
        // a fresh plan on the same line, ready to adjust and launch again
        const entry = { id: ++st.planCounter, kind: 'attack', side: op.side, path: op.path, seed: (Math.random() * 1e6) | 0 };
        if (this.replan(entry, false)) {
          st.plans.push(entry);
          if (!this.campaign) st.side = op.side;
          this.setTab('command');
          this.plansChanged();
          this.toast(`New plan drawn from Operation ${op.name}'s line. Adjust it, then press Attack.`);
        }
        return;
      }
      if (act === 'counter') {
        const c = this.war.counterAttack(op, st.time, (Math.random() * 1e6) | 0);
        if (!c) { this.toast('The enemy has not taken any ground here yet.'); return; }
        {
          this.addLog({ t: st.time, side: c.side, kind: 'op', text: `Operation ${c.name}: ${WM.SIDE_NAME[c.side]} counter-attacks with ${fmt(c.troops)} of its defenders to retake the ground lost to Operation ${op.name}.` });
          this.opsChanged();
          this.toast(`Counter-attack launched: Operation ${c.name}.`);
        }
        return;
      }
      if (act === 'pull' || act === 'pulldef') {
        const side = act === 'pull' ? op.side : op.enemy;
        const n = this.war.withdraw(op, REINFORCE, side);
        if (!n) { this.toast('Too few men left there to withdraw any.'); return; }
        this.addLog({ t: st.time, side, text: `${WM.SIDE_NAME[side]} pulls ${fmt(n)} men out of the fighting around Operation ${op.name}.` });
        this.refreshOps();
        this.refreshStats();
        return;
      }
      const side = act === 'att' ? op.side : op.enemy;
      const n = this.war.reinforce(op, REINFORCE, side);
      if (!n) {
        this.toast(`${WM.SIDE_NAME[side]} has no soldiers ready. Rest the army to train more, or halt an attack.`);
        return;
      }
      const text = act === 'att'
        ? `${WM.SIDE_NAME[side]} sends ${fmt(n)} more men into Operation ${op.name}.`
        : `${WM.SIDE_NAME[side]} sends ${fmt(n)} reserves to hold against Operation ${op.name}.`;
      this.addLog({ t: st.time, side, text });
      this.refreshOps();
      this.refreshStats();
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

    toast(msg, alert) {
      if (this.st.uiHidden) return;
      const t = $('toast');
      t.textContent = msg;
      t.dataset.alert = alert ? 'true' : 'false';
      t.hidden = false;
      clearTimeout(this.toastTimer);
      this.toastTimer = setTimeout(() => { t.hidden = true; }, alert ? 6500 : 4500);
    }

    // ---------------------------------------------------------- orders ---
    // One section per planned order: attacks get troops (and, in the sandbox,
    // the enemy's defense strength) plus a forecast; defense lines show cost.
    openModal() {
      const st = this.st, war = this.war;
      if (!st.plans.length) return;
      const attacks = st.plans.filter((e) => e.kind === 'attack');
      for (const e of attacks) if (!e.prep) e.prep = WM.prepareOperation(this.world, e.plan, e.seed);
      this.frontKm = [0, war.frontLength(1), war.frontLength(2)];
      for (const side of [1, 2]) {
        const mine = attacks.filter((e) => e.side === side);
        if (!mine.length) continue;
        const forts = st.plans.filter((e) => e.kind === 'fort' && e.side === side).reduce((n, e) => n + e.fort.garrison, 0);
        const budget = Math.max(0, war.available(side) - forts) * 0.7;
        mine.forEach((e) => { e.troops = Math.max(5000, Math.round((e.prep.frontKm0 * 120) / 1000) * 1000); });
        const total = mine.reduce((n, e) => n + e.troops, 0);
        if (total > budget) mine.forEach((e) => { e.troops = Math.max(5000, Math.floor((e.troops * budget) / total / 1000) * 1000); });
      }
      st.plans.forEach((e) => { if (!e.defense) e.defense = 50; });
      let k = 0;
      $('amPlans').replaceChildren(...st.plans.map((e, i) => {
        const sec = document.createElement('section');
        sec.className = 'am-plan';
        sec.dataset.id = e.id;
        sec.dataset.side = e.side;
        if (e.kind === 'fort') {
          const town = this.world.nearestTown(...this.gridOf(e.fort.path[Math.floor(e.fort.path.length / 2)]));
          sec.innerHTML = `<h3 class="am-op"><span class="am-name"></span><span class="am-side"></span></h3>
            <p class="am-sub"></p><p class="am-fort"></p>`;
          sec.querySelector('.am-name').textContent = 'Defense line';
          sec.querySelector('.am-side').textContent = WM.SIDE_NAME[e.side];
          sec.querySelector('.am-sub').textContent = `${i + 1} · ${Math.round(e.fort.km)} km near ${town ? town.name : 'the front'}`;
          sec.querySelector('.am-fort').textContent = `${fmt(e.fort.garrison)} men are stationed on it for good. It takes ${WM.FORT_BUILD_HOURS} hours to dig; once ready, attackers face about three times the resistance there.`;
          return sec;
        }
        const p = e.plan;
        const towns = p.cities.length;
        sec.innerHTML = `
          <h3 class="am-op"><span class="am-name"></span><span class="am-side"></span></h3>
          <p class="am-sub"></p>
          <label class="am-label"><span>Troops committed</span><output class="o-troops"></output></label>
          <input type="range" class="i-troops" min="5000" step="1000" aria-label="Troops committed">
          <div class="am-scale" aria-hidden="true"><span>5,000</span><span class="o-max"></span></div>
          <div class="sandbox-only">
            <label class="am-label"><span>Enemy defense strength</span><output class="o-def"></output></label>
            <input type="range" class="i-def" min="1" max="100" aria-label="Enemy defense strength">
            <div class="am-scale" aria-hidden="true"><span>Militia</span><span>Fortified line</span></div>
          </div>
          <div class="am-tier"><span class="o-tier"></span><span class="am-def o-defenders"></span></div>
          <dl class="facts">
            <dt>Force ratio</dt><dd class="o-ratio"></dd>
            <dt>Forecast</dt><dd class="o-outcome"></dd>
            <dt>Expected end</dt><dd class="o-end"></dd>
            <dt>Our losses</dt><dd class="o-loss"></dd>
            <dt>Enemy losses</dt><dd class="o-eloss"></dd>
          </dl>`;
        sec.querySelector('.sandbox-only').hidden = this.campaign;
        sec.querySelector('.am-name').textContent = `Operation ${war.nextName(k++)}`;
        sec.querySelector('.am-side').textContent = `${WM.SIDE_NAME[p.attacker]} → ${WM.SIDE_NAME[p.enemy]}`;
        sec.querySelector('.am-sub').textContent = `${i + 1} · ${MODE_LABEL[p.mode]} · ${WM.formatKm2(p.area)} · ${towns} ${towns === 1 ? 'town' : 'towns'}`;
        const ti = sec.querySelector('.i-troops');
        ti.max = String(Math.max(5000, Math.floor(war.available(p.attacker) / 1000) * 1000));
        ti.value = String(e.troops);
        sec.querySelector('.i-def').value = String(e.defense);
        return sec;
      }));
      const nA = attacks.length, nF = st.plans.length - nA;
      $('amTitle').textContent = st.plans.length === 1
        ? (nA ? `Operation ${war.nextName(0)}` : 'Defense line')
        : `${st.plans.length} orders, carried out together`;
      $('amLaunch').textContent = !nF ? (nA > 1 ? `Launch all ${nA} attacks` : 'Launch attack')
        : !nA ? (nF > 1 ? `Build ${nF} lines` : 'Build defense line') : `Carry out all ${st.plans.length}`;
      $('amNote').hidden = !nA;
      $('attackModal').hidden = false;
      this.refreshEstimates(0);
      this.overlayDirty = true;
      const first = $('amPlans').querySelector('input');
      if (first) first.focus();
    }

    closeModal() {
      $('attackModal').hidden = true;
      this.fcQueue = [];
      this.fc = null;
      clearTimeout(this.fcTimer);
      this.overlayDirty = true;
    }

    // Reads every section, keeps each side's orders within the men it has
    // ready, works out the defenders each sector would get when launched in
    // order, and restarts the forecasts.
    refreshEstimates(changedId) {
      const st = this.st, war = this.war;
      const secs = new Map([...$('amPlans').querySelectorAll('.am-plan')].map((el) => [+el.dataset.id, el]));
      const attacks = st.plans.filter((e) => e.kind === 'attack');
      for (const e of attacks) {
        const el = secs.get(e.id);
        e.troops = +el.querySelector('.i-troops').value;
        e.defense = +el.querySelector('.i-def').value;
      }
      const cost = (e) => (e.kind === 'fort' ? e.fort.garrison : e.troops);
      const ready = [0, war.available(1), war.available(2)];
      let short = '';
      for (const side of [1, 2]) {
        const mine = st.plans.filter((e) => e.side === side);
        for (const e of mine) {
          if (e.kind !== 'attack') continue;
          const others = mine.reduce((n, o) => n + (o === e ? 0 : cost(o)), 0);
          const max = Math.max(5000, Math.floor((ready[side] - others) / 1000) * 1000);
          const input = secs.get(e.id).querySelector('.i-troops');
          input.max = String(max);
          if (e.troops > max && e.id === changedId) { e.troops = max; input.value = String(max); }
          secs.get(e.id).querySelector('.o-max').textContent = `${fmt(Math.max(0, ready[side] - others))} ready`;
        }
        const total = mine.reduce((n, e) => n + cost(e), 0);
        if (mine.length && total > ready[side]) {
          short = `${WM.SIDE_NAME[side]} has only ${fmt(ready[side])} soldiers ready for ${fmt(total)} needed. Lower the troops or remove an order.`;
        }
      }
      // Launch order matters: each sector's defenders come out of what is left.
      const avail = ready.slice();
      for (const e of st.plans) {
        if (e.kind === 'fort') { avail[e.side] -= e.fort.garrison; continue; }
        const p = e.plan;
        if (this.campaign) {
          const share = WM.clamp((1.7 * e.prep.frontKm0) / Math.max(this.frontKm[p.enemy], e.prep.frontKm0, 50), 0.1, 0.55);
          e.defenders = Math.max(1500, Math.max(0, avail[p.enemy]) * share);
        } else {
          const wanted = WM.sectorDefenders(e.prep, e.defense);
          e.defenders = Math.min(wanted, Math.max(avail[p.enemy] * 0.8, wanted * 0.25, 0));
        }
        avail[p.attacker] -= e.troops;
        avail[p.enemy] -= e.defenders;
        const el = secs.get(e.id);
        el.querySelector('.o-troops').textContent = fmt(e.troops);
        el.querySelector('.o-def').textContent = e.defense;
        el.querySelector('.o-tier').textContent = this.campaign ? 'Enemy defenders' : WM.defenseTier(e.defense);
        el.querySelector('.o-defenders').textContent = `≈ ${fmt(e.defenders)} ${this.campaign ? 'men will meet you' : 'defenders in the sector'}`;
        const ratio = e.troops / Math.max(e.defenders, 1);
        el.querySelector('.o-ratio').textContent = ratio >= 1 ? `${ratio.toFixed(1)} : 1 in our favour` : `1 : ${(1 / ratio).toFixed(1)} against us`;
        el.querySelector('.o-outcome').textContent = 'Forecasting…';
        for (const c of ['.o-outcome', '.o-end', '.o-loss', '.o-eloss']) el.querySelector(c).classList.add('pending');
        for (const c of ['.o-end', '.o-loss', '.o-eloss']) el.querySelector(c).textContent = '–';
      }
      $('amShort').textContent = short;
      $('amShort').hidden = !short;
      $('amLaunch').disabled = !!short;
      this.fcQueue = [];
      this.fc = null;
      clearTimeout(this.fcTimer);
      this.fcTimer = setTimeout(() => { this.fcQueue = attacks.slice(); }, changedId ? 220 : 0);
    }

    // Forecasts run one order at a time, a few milliseconds per frame.
    pumpForecasts() {
      if (!this.fc && this.fcQueue && this.fcQueue.length) {
        const e = this.fcQueue.shift();
        this.fc = new WM.Forecast(this.war, e.plan, e.prep, e.troops, e.defense, this.st.time, e.defenders);
        this.fcEntry = e;
      }
      if (this.fc && this.fc.run(10)) {
        this.showForecast(this.fcEntry, this.fc.result());
        this.fc = null;
      }
    }

    showForecast(entry, r) {
      const el = $('amPlans').querySelector(`.am-plan[data-id="${entry.id}"]`);
      if (!el || !r) return;
      const pctTaken = Math.round(r.progress * 100);
      el.querySelector('.o-outcome').textContent = r.reason === 'success'
        ? `Objective taken (${pctTaken}%) in ≈ ${WM.formatDuration(r.hours)}`
        : r.reason === 'exhausted'
          ? `Runs out of men at ${pctTaken}% after ≈ ${WM.formatDuration(r.hours)}`
          : r.reason === 'stalled'
            ? `Bogs down at ${pctTaken}% after ≈ ${WM.formatDuration(r.hours)}`
            : `Still fighting at ${pctTaken}% after ${WM.formatDuration(r.hours)}`;
      el.querySelector('.o-end').textContent = WM.formatStamp(this.st.time + r.hours);
      el.querySelector('.o-loss').textContent = `≈ ${fmt(r.lossAtt)} (${fmt(r.killedAtt)} killed)`;
      el.querySelector('.o-eloss').textContent = `≈ ${fmt(r.lossDef)} (${fmt(r.killedDef)} killed)`;
      for (const c of ['.o-outcome', '.o-end', '.o-loss', '.o-eloss']) el.querySelector(c).classList.remove('pending');
    }

    // Every planned order is carried out at the same moment.
    launch() {
      const st = this.st, war = this.war;
      if (!st.plans.length) return;
      this.refreshEstimates(0);
      if ($('amLaunch').disabled) return;
      const done = [];
      for (const e of st.plans) {
        if (e.kind === 'fort') {
          const f = war.addFort(e.side, e.fort.cells, e.fort.path, e.fort.facing, e.fort.km, st.time);
          if (!f) continue;
          done.push('a defense line');
          const town = this.world.nearestTown(...this.gridOf(f.path[Math.floor(f.path.length / 2)]));
          this.addLog({ t: st.time, side: f.side, text: `${WM.SIDE_NAME[f.side]} starts digging a ${Math.round(f.km)} km defense line near ${town ? town.name : 'the front'} with ${fmt(f.garrison)} men.` });
          continue;
        }
        const op = war.launch(e.plan, e.prep, { troops: e.troops, defense: this.campaign ? null : e.defense, defenders: e.defenders, t: st.time });
        if (!op) continue;
        done.push(`Operation ${op.name}`);
        const att = WM.SIDE_NAME[op.side], en = WM.SIDE_NAME[op.enemy];
        const towns = e.plan.cities.length ? ` towards ${e.plan.cities.slice(0, 3).join(', ')}` : '';
        this.addLog({
          t: st.time, side: op.side, kind: 'op',
          text: `Operation ${op.name}: ${att} attacks ${en}${towns} with ${fmt(e.troops)} men. About ${fmt(op.defPool0)} ${en} troops defend the sector.`,
        });
      }
      this.closeModal();
      st.plans = [];
      this.plansChanged();
      this.opsChanged();
      if (done.some((d) => d.startsWith('Operation'))) this.setTab('ops');
      if (!done.length) { this.toast('Those orders can no longer be carried out. Draw new lines.'); return; }
      const what = done.length === 1 ? `${done[0]} under way.` : `${done.length} orders carried out together.`;
      this.toast(st.paused ? `${what} The clock is paused; press Space to start.` : what);
    }

    haltOperation(op) {
      const events = [];
      this.war.halt(op, this.st.time, events);
      this.handleEvents(events);
      this.opsChanged();
    }

    handleEvents(events) {
      const st = this.st;
      events.sort((a, b) => a.t - b.t);
      for (const ev of events) {
        this.addLog(ev);
        if (ev.kind === 'alert' && (!this.campaign || ev.side !== st.player)) this.toast(ev.text, true);
        else if (ev.kind === 'op' && ev.opEnd) this.toast(ev.text.split(':')[0] + '.');
      }
      this.overlayDirty = true;
      if (events.some((e) => e.opStart)) this.opsChanged();
      this.checkVictory();
    }

    checkVictory() {
      const st = this.st, s = this.war.sides;
      if (st.winner) return;
      for (const side of [1, 2]) {
        if (s[other(side)].area > 1) continue;
        st.winner = side;
        st.over = true;
        this.addLog({ t: st.time, side, kind: 'op', text: `${WM.SIDE_NAME[side]} controls all of Iran. The war is over.` });
        if (this.campaign) {
          const me = s[st.player], foe = s[other(st.player)];
          const won = side === st.player;
          $('endTitle').textContent = won ? 'Victory' : 'Defeat';
          $('endText').textContent = `${won ? 'You' : 'The enemy'} took all of Iran after ${WM.formatDuration(st.time)}. You lost ${fmt(me.killed)} men killed; the enemy lost ${fmt(foe.killed)}.`;
          $('endModal').dataset.won = String(won);
          $('endModal').hidden = false;
        } else {
          this.toast(`${WM.SIDE_NAME[side]} has won the war.`);
        }
        this.refreshPanels();
      }
    }

    opsChanged() {
      this.refreshObjectives();
      this.refreshOps();
      this.refreshStats();
      this.refreshForts();
      this.save();
    }

    // Battle labels glide when a sector's centre moves instead of jumping.
    smoothBattles(list) {
      const prev = this.labelPos || new Map();
      const next = new Map();
      for (const b of list) {
        const p = prev.get(b.key);
        if (p && Math.hypot(p.at[0] - b.at[0], p.at[1] - b.at[1]) < 400) {
          const k = 0.18;
          b.at = [p.at[0] + (b.at[0] - p.at[0]) * k, p.at[1] + (b.at[1] - p.at[1]) * k];
          const dx = p.dir[0] + (b.dir[0] - p.dir[0]) * k, dy = p.dir[1] + (b.dir[1] - p.dir[1]) * k;
          const l = Math.hypot(dx, dy) || 1;
          b.dir = [dx / l, dy / l];
        }
        next.set(b.key, { at: b.at, dir: b.dir });
      }
      this.labelPos = next;
      return list;
    }

    // ---------------------------------------------------------- timelapse ---
    // The map is recorded every 6 game hours; at the end (or any time) the
    // whole war can be replayed fast or slow with its date.
    snapshot(force) {
      const st = this.st;
      if (!st.history) st.history = [];
      const last = st.history[st.history.length - 1];
      if (!force && last && st.time - last.t < 6) return;
      st.history.push({ t: st.time, o: this.world.encodeOwner() });
    }

    startReplay() {
      const st = this.st;
      this.snapshot(true);
      if (!st.history || st.history.length < 2) { this.toast('Nothing to replay yet. Let the war run a little first.'); return; }
      $('endModal').hidden = true;
      this.replay = { pos: 0, rate: 8, playing: true, buf: new Uint8Array(this.world.N) };
      this.el.classList.add('replaying');
      $('replayBar').hidden = false;
      $('rpSeek').max = String(st.history.length - 1);
      this.showReplay(0);
    }

    stopReplay() {
      this.replay = null;
      this.el.classList.remove('replaying');
      $('replayBar').hidden = true;
      this.syncMap();
    }

    showReplay(i) {
      const st = this.st, world = this.world, snap = st.history[i], buf = this.replay.buf;
      let k = 0;
      for (let j = 0; j < snap.o.length; j += 2) {
        const v = snap.o[j] === WM.RED ? 255 : 0;
        for (let r = 0; r < snap.o[j + 1]; r++) buf[world.iranCells[k++]] = v;
      }
      const h = world.halo;
      for (let j = 0; j < h.length; j += 2) buf[h[j]] = buf[h[j + 1]];
      this.renderer.setOwnership(buf);
      this.renderer.setObjectives([], []);
      $('clockDate').textContent = WM.formatDay(snap.t);
      $('clockHour').textContent = WM.formatHour(snap.t);
      $('rpSeek').value = String(i);
      $('rpDay').textContent = `Day ${Math.floor(snap.t / 24) + 1} of ${Math.floor(st.history[st.history.length - 1].t / 24) + 1}`;
      this.mapDirty = true;
    }

    replayFrame(dt) {
      const rp = this.replay, n = this.st.history.length;
      if (rp.playing) {
        const before = Math.floor(rp.pos);
        rp.pos = Math.min(n - 1, rp.pos + dt * rp.rate);
        if (Math.floor(rp.pos) !== before) this.showReplay(Math.floor(rp.pos));
        if (rp.pos >= n - 1) { rp.playing = false; $('rpPlay').textContent = 'Play'; }
      }
      document.querySelectorAll('#replayBar [data-rate]').forEach((b) => b.setAttribute('aria-pressed', String(+b.dataset.rate === rp.rate)));
      if (this.mapDirty) { this.renderer.render(this.view); this.mapDirty = false; }
      if (this.overlayDirty) {
        this.overlay.draw(this.view, { showLabels: this.st.showLabels, showProvinces: this.st.showProvinces });
        this.overlayDirty = false;
      }
    }

    // ------------------------------------------------------------- frame ---
    frame(now) {
      const st = this.st, war = this.war;
      const dt = Math.min(0.25, Math.max(0, (now - this.last) / 1000));
      this.last = now;
      const modalOpen = !$('attackModal').hidden;
      if (this.replay) { this.replayFrame(dt); requestAnimationFrame((t) => this.frame(t)); return; }

      if (!st.paused && !this.dialogOpen()) {
        const dh = dt / SPEEDS[st.speed].sph;
        const events = [];
        const before = war.ops.length, forts = war.forts.length;
        war.step(dh, st.time, events);
        st.time += dh;
        this.snapshot();
        if (this.ai && !st.over) this.ai.update(st.time, events);
        if (events.length) this.handleEvents(events);
        if (war.ops.length !== before || war.forts.length !== forts) this.opsChanged();
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
        if (war.forts.some((f) => f.built < 1)) { this.refreshForts(); this.overlayDirty = true; }
      }
      if (war.ops.length && now - this.timers.overlay > 120) {
        this.timers.overlay = now;
        this.overlayDirty = true;
      }
      if (this.logDirty) this.renderLog();
      if (modalOpen) this.pumpForecasts();

      $('clockDate').textContent = WM.formatDay(st.time);
      $('clockHour').textContent = WM.formatHour(st.time);
      $('hourFill').style.width = `${((st.time % 1) * 100).toFixed(1)}%`;

      if (this.mapDirty) {
        this.renderer.render(this.view);
        this.mapDirty = false;
      }
      if (this.overlayDirty) {
        const plans = st.plans;
        this.overlay.draw(this.view, {
          time: st.time,
          ops: war.ops,
          forts: war.forts,
          fortId: war.fortId,
          drawSide: st.side,
          drawTool: st.tool,
          drawing: st.drawing,
          plans: plans.filter((e) => e.kind === 'attack').map((e) => e.plan),
          fortPlans: plans.filter((e) => e.kind === 'fort').map((e) => e.fort),
          planArrows: modalOpen ? plans.filter((e) => e.prep).map((e) => ({ side: e.side, arrows: e.prep.arrows })) : null,
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
