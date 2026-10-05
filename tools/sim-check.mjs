#!/usr/bin/env node
// Headless smoke test: loads the game data and battle code in Node, launches a
// Blue offensive across the Red block plus a simultaneous Red attack towards
// Tehran, and reports how both unfold.
//
//   node tools/sim-check.mjs [defense=50] [seed=1] [troops=60000]

import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
// The game scripts expect a browser `window`; run them in this global scope.
globalThis.window = globalThis;
for (const f of ['js/data/geo.js', 'js/data/grid.js', 'js/util.js', 'js/world.js', 'js/planner.js', 'js/sim.js', 'js/ai.js']) {
  (0, eval)(fs.readFileSync(path.join(ROOT, f), 'utf8') + `\n//# sourceURL=${f}`);
}
const ctx = globalThis;
const WM = ctx.WM;
const defense = +(process.argv[2] || 50);
const seed = +(process.argv[3] || 1);
const troops = +(process.argv[4] || 60000);

const world = await WM.World.load(ctx.WARMAP_DATA);
world.applyScenario();
const R = world.geo.region;
const project = (lon, lat) => [
  ((lon + 180) / 360) * R.world - R.ox,
  ((1 - Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) / Math.PI) / 2) * R.world - R.oy,
];
const stroke = (pts) => {
  const out = [];
  for (let i = 1; i < pts.length; i++) {
    for (let s = 0; s < 10; s++) {
      const t = s / 10;
      out.push(project(pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t));
    }
  }
  return out;
};

const planner = new WM.Planner(world);
const war = new WM.War(world);
let t0 = performance.now();
const plan = planner.plan(WM.BLUE, stroke([[49.2, 36.4], [48.9, 35.6], [48.7, 34.8], [48.6, 34.0], [48.9, 33.3], [49.4, 32.6], [49.6, 31.9]]), false, seed);
if (!plan.ok) { console.error('plan failed:', plan.reason); process.exit(1); }
console.log(`Blue plan: ${plan.mode}, ${Math.round(plan.area)} km², towns ${plan.cities.join(', ')} (${(performance.now() - t0).toFixed(0)} ms)`);
const prep = WM.prepareOperation(world, plan, seed);
t0 = performance.now();
const fc = WM.forecast(war, plan, prep, troops, defense, 0);
console.log(`forecast: ${fc.reason} ${(fc.progress * 100).toFixed(0)}% in ${WM.formatDuration(fc.hours)}, losses ${Math.round(fc.lossAtt)} vs ${Math.round(fc.lossDef)}, defenders ${Math.round(fc.defenders)} (${(performance.now() - t0).toFixed(0)} ms)`);
const blue = war.launch(plan, prep, { troops, defense, t: 0 });

// Red strikes towards Tehran at the same time.
const plan2 = planner.plan(WM.RED, stroke([[50.0, 35.2], [50.6, 35.5], [51.1, 35.7]]), false, seed + 1);
let red = null;
if (plan2.ok) {
  red = war.launch(plan2, WM.prepareOperation(world, plan2, seed + 1), { troops: 40000, defense: 40, t: 0 });
  console.log(`Red plan: ${plan2.mode}, ${Math.round(plan2.area)} km²`);
}

const events = [];
t0 = performance.now();
let t = 0;
for (; t < 24 * 30 && war.ops.length; t += 1) {
  war.step(1, t, events);
  if (t % 24 === 0) {
    const line = [blue, red].filter(Boolean).map((op) =>
      `${op.name}${op.ended ? '(' + op.endReason + ')' : ''} ${(100 * (1 - op.remaining / op.total)).toFixed(0)}% ` +
      `troops ${Math.round(op.troops)} def ${Math.round(op.defPool)} front ${op.frontN}`).join(' | ');
    console.log(`  +${String(t).padStart(3)}h ${line}`);
  }
}
console.log(`ran ${t} h in ${(performance.now() - t0).toFixed(0)} ms`);
const s = war.stats();
for (const side of [1, 2]) {
  const S = s[side];
  console.log(`${WM.SIDE_NAME[side]}: ${Math.round(S.area)} km², army ${Math.round(S.army)}, killed ${Math.round(S.killed)}, captured ${Math.round(S.captured)}, towns ${S.towns} (${S.occupied} occupied), morale ${S.morale.toFixed(2)}, power ${(S.power * 100).toFixed(0)}%`);
}
const counts = {};
for (const e of events) counts[e.kind] = (counts[e.kind] || 0) + 1;
console.log('events', JSON.stringify(counts));
for (const e of events.filter((e) => e.kind !== 'town').slice(0, 14)) console.log(`  [${WM.formatStamp(e.t)}] ${e.text}`);
// consistency: area bookkeeping matches the grid
war.recount();
const s2 = war.stats();
if (Math.abs(s2[1].area - s[1].area) > 5 || s2[1].towns !== s[1].towns) { console.error('bookkeeping drift', s[1].area, s2[1].area, s[1].towns, s2[1].towns); process.exit(1); }

// Campaign: two computer players fight for 20 days.
world.applyScenario();
const war2 = new WM.War(world);
const ais = [new WM.AI(war2, planner, WM.BLUE, 'normal'), new WM.AI(war2, planner, WM.RED, 'hard')];
const ev2 = [];
const lastKilled = [];
t0 = performance.now();
for (let h = 0; h < 24 * 20; h += 0.5) {
  war2.step(0.5, h, ev2);
  for (const ai of ais) ai.update(h + 0.5, ev2);
  // The dead stay dead: killed only grows, and nobody fights who is not in the army.
  for (const side of [1, 2]) {
    const S = war2.sides[side];
    const committed = war2.deployed(side) + war2.defending(side) + war2.garrison(side);
    if (S.killed < (lastKilled[side] || 0) - 1e-6) { console.error(`killed went down for side ${side} at ${h} h`); process.exit(1); }
    if (committed > S.army + 1) { console.error(`side ${side} has ${Math.round(committed)} men committed but an army of ${Math.round(S.army)} at ${h} h`); process.exit(1); }
    lastKilled[side] = S.killed;
  }
}
const k2 = {};
for (const e of ev2) k2[e.kind] = (k2[e.kind] || 0) + 1;
const s3 = war2.stats();
console.log(`AI vs AI, 20 days in ${(performance.now() - t0).toFixed(0)} ms: events ${JSON.stringify(k2)}, forts ${war2.forts.length}, ops running ${war2.ops.length}`);
for (const side of [1, 2]) {
  const S = s3[side];
  console.log(`  ${WM.SIDE_NAME[side]}: ${(S.share * 100).toFixed(1)}% of Iran, army ${Math.round(S.army)} (ready ${Math.round(S.available)}), killed ${Math.round(S.killed)}, training ${Math.round(S.training)}/day, readiness ${((1 - S.fatigue / 0.9) * 100).toFixed(0)}%`);
}
for (const e of ev2.filter((e) => e.kind === 'alert' || e.kind === 'op').slice(0, 10)) console.log(`  [${WM.formatStamp(e.t)}] ${e.text}`);
if (!k2.alert) { console.error('the AI never attacked'); process.exit(1); }
console.log('ok');
