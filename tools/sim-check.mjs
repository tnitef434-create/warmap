#!/usr/bin/env node
// Headless smoke test: loads the game data and simulation code in Node, plans
// a Blue offensive across the Red block and reports how it unfolds.
//
//   node tools/sim-check.mjs [defense=50] [seed=1]

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const ctx = { console, atob, Blob, Response, DecompressionStream, Math, Date, Map, Set, Promise };
ctx.window = ctx;
vm.createContext(ctx);
for (const f of ['js/data/geo.js', 'js/data/grid.js', 'js/util.js', 'js/world.js', 'js/planner.js', 'js/sim.js']) {
  vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx, { filename: f });
}
const WM = ctx.WM;
const defense = +(process.argv[2] || 50);
const seed = +(process.argv[3] || 1);

const world = await WM.World.load(ctx.WARMAP_DATA);
world.applyScenario();
const R = world.geo.region;
const project = (lon, lat) => [
  ((lon + 180) / 360) * R.world - R.ox,
  ((1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2) * R.world - R.oy,
];
const line = [[49.2, 36.4], [48.9, 35.6], [48.7, 34.8], [48.6, 34.0], [48.9, 33.3], [49.4, 32.6], [49.6, 31.9]];
const pathWorld = [];
for (let i = 1; i < line.length; i++) {
  for (let s = 0; s < 10; s++) {
    const t = s / 10;
    pathWorld.push(project(line[i - 1][0] + (line[i][0] - line[i - 1][0]) * t, line[i - 1][1] + (line[i][1] - line[i - 1][1]) * t));
  }
}

let t = performance.now();
const plan = new WM.Planner(world).plan(WM.BLUE, pathWorld);
if (!plan.ok) { console.error('plan failed:', plan.reason); process.exit(1); }
console.log(`plan: ${plan.mode}, ${plan.cells.length} cells, ${Math.round(plan.area)} km², towns: ${plan.cities.join(', ')} (${(performance.now() - t).toFixed(0)} ms)`);

t = performance.now();
const prep = WM.prepareOperation(world, plan, seed);
console.log(`prepare: ${prep.axes.length} spearheads, ${prep.belts} belts (${(performance.now() - t).toFixed(0)} ms)`);

const op = new WM.Operation(world, plan, prep, defense, 0);
console.log(`defense ${defense}: estimated ${WM.formatDuration(prep.maxTref / WM.baseSpeed(defense))}, ends at +${op.tEnd.toFixed(1)} h`);
const events = [];
const marks = [0.5, 0.9, 0.99, 1];
let mi = 0;
for (let h = 0; h <= Math.ceil(op.tEnd) + 1; h += 0.5) {
  const done = op.advance(h, events);
  while (mi < marks.length && op.progress() >= marks[mi] - 1e-9) {
    console.log(`  ${(marks[mi] * 100).toFixed(0).padStart(3)}% taken after ${WM.formatDuration(h)}`);
    mi++;
  }
  if (done) break;
}
// slowest cells: where the long tail comes from
const order = Array.from(op.order).slice(-5).map((k) => {
  const c = op.cells[k];
  return `T=${(op.T[k] - op.t0).toFixed(1)}h f=${prep.f[k].toFixed(3)} rug=${world.rug[c]} river=${world.river[c]}`;
});
console.log('slowest cells:\n  ' + order.join('\n  '));
for (const e of events.filter((e) => e.kind !== 'progress')) console.log(`  [${WM.formatStamp(e.t)}] ${e.text}`);
const lost = Array.from(op.cells).filter((c) => world.owner[c] !== WM.BLUE).length;
if (lost) { console.error(`${lost} objective cells were never taken`); process.exit(1); }
console.log('ok');
