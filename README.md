# Iran 1902 War Map

A real-time war map of Iran. You command both sides, Blue and Red. Draw a line into the other side's territory, commit troops and launch an offensive, then watch the battle move across the real terrain hour by hour. Several offensives can run at once, for both sides, and they fight each other where they meet.

![Two offensives under way: troop numbers on each side of the front, operations on the left, forces and the war diary on the right](docs/screenshot.jpg)

## Play

Open `index.html` in a modern browser (Chrome, Edge, Firefox or Safari with WebGL2). No server or build step is needed, and it works straight from disk.

1. **Pick a side.** Click **Blue** or **Red** under *Plan an offensive for*. The button shows how many men that side has ready.
2. **Draw the objective.** Drag a line into the enemy's land. When you let go, your stroke is reshaped into a realistic front line: it bends towards nearby rivers and broken ground and gains natural irregularity. Everything between your current front and the line becomes the objective, shown hatched.
   - A line that crosses enemy land is a **front-line offensive**. Ends that stop short are tied to the nearest edge.
   - A closed loop is an **encirclement** and takes the enemy ground inside it.
   - A short arrow that stops deep in enemy land is a **thrust**: a salient along the arrow.
   - ⇄ next to a planned line takes the other side of it when that is a comparable piece; × removes the line.
3. **Draw more lines.** Each new stroke is added to the list of planned lines; nothing is replaced. Switch to the other side and draw its lines too if you want Blue and Red to attack at the same moment.
4. **Attack.** One press launches every planned line together. For each line, choose how many troops to commit and the enemy's defense strength, from 1 (scattered militia) to 100 (fortified line). A side can't commit more men than it has ready across all its lines. Each line shows how many defenders hold its sector, the force ratio, and a forecast: duration, expected end date and losses on both sides. Stronger defenses take longer and cost more.
5. **Keep going.** You can plan and launch more lines while offensives are running. Where Blue and Red offensives meet head-on, the stronger side pushes.
6. **Watch.** The two big numbers on the map are the men fighting in each battle: the attacker's on his side of the front, the defender's on the other. They fall as casualties mount. Zoom in to watch breakthroughs, counter-attacks and encirclements. Press `H` to hide the interface.
7. An offensive ends when it takes its objective, runs out of men, or bogs down. You can also **halt** it from the operations list and keep the ground taken.

### Panels

- **Operations**: every running offensive with its status (breakthrough, advancing, heavy fighting, stalled), attackers and defenders remaining, killed on both sides and ground taken. Click an operation's name to fly to its battle.
- **Forces**: territory, population, army size (and how much of it is attacking or defending), killed, wounded, taken prisoner, towns held and occupied, provinces, morale and the balance of power.
- **War diary**: offensives launched and ended, towns occupied and liberated, counter-attacks, encirclements and surrenders.

### Time

The war starts on **8 January 1902, 00:00**. The clock advances by the hour.

| Speed | Real time per hour |
|-------|--------------------|
| 1×    | 10 s               |
| 2×    | 3 s                |
| 10×   | 1 s                |
| 40×   | 0.25 s             |

### Controls

| Action | Mouse / keyboard | Touch |
|--------|------------------|-------|
| Draw the objective line | Left-drag (after picking a side) | One finger |
| Pan | Right- or middle-drag, or left-drag when no side is picked | Two fingers |
| Zoom (down to a few km across) | Scroll wheel, `+` / `−`, double-click | Pinch |
| Show all of Iran | `F` or ⤢ | ⤢ |
| Hide / show the interface | `H` or the eye button | Eye button |
| Pause / resume | `Space` | ❚❚ |
| Speed | `1`–`4` | Speed buttons |
| Remove the last planned line | `Esc` | × on the line |

The war, its running operations, the clock and the diary are saved in the browser. **New war** resets to the opening situation: Blue with 260,000 men, Red with 150,000.

## How the fighting is simulated

Iran is divided into a grid of about 385,000 cells of roughly 2 × 2 km. Ownership changes cell by cell, in real time.

- **Armies.** Each offensive has the troops you committed. About a third hold the whole front thinly; the rest form one to four **battle groups** that concentrate on narrow sectors. Where a battle group presses, the front breaks; elsewhere it barely moves.
- **Defenders.** The defending side puts men into the sector according to the defense strength, limited by what it has free after its other commitments. It brings up reserves against each thrust, so a breakthrough slows down after a day or so. The attacking group then stalls and shifts its effort to another part of the front.
- **Counter-attacks.** Defenders strike the flanks of salients and retake ground for a few hours.
- **Ground.** Mountains (measured from the shaded relief) slow movement and favour the defender; rivers are hard to cross; towns are fortified and hold out, so the front flows around them.
- **Outflanking.** Ground surrounded on several sides falls quickly. Territory cut off completely loses supply, fights ever more weakly and finally surrenders, and its garrison is taken prisoner.
- **Losses.** Casualties come from the strength of both sides along the engaged front; about 30% are killed. An offensive whose men fall below a minimum, or that stops gaining ground for a day, ends.
- **Morale and power.** Taking towns and provinces raises morale, losses and encirclements lower it, and morale makes troops fight better or worse. Each side recruits slowly from the population it holds. Power combines army size, morale, population and towns.

The renderer draws ownership per pixel from the grid, with a fractal edge, so borders stay irregular and natural at every zoom level.

## Project layout

```
index.html          page and UI markup
css/style.css       interface styles
js/util.js          noise, heap, calendar, decoding helpers
js/world.js         simulation grid and ownership
js/planner.js       turns a drawn line into a realistic front and an objective
js/sim.js           battle engine: armies, battle groups, counter-attacks, pockets, forecasts
js/renderer.js      WebGL2 map: stencilled land/water/Iran, relief shading, live ownership
js/overlay.js       borders, lines, spearhead arrows, troop numbers, town labels (Canvas 2D)
js/app.js           clock, camera, input, panels
js/data/*.js        generated map data (do not edit)
tools/              data build, single-file bundler, headless simulation check
```

## Map data

All geography comes from [Natural Earth](https://www.naturalearthdata.com) (public domain):

- 1:10m admin-0 countries, land boundaries, admin-1 provinces and province lines
- 1:10m populated places and rivers
- 1:10m shaded relief raster (`SR_HR`), reprojected to Web Mercator

To rebuild `js/data/` you need Node 18+ and ImageMagick, plus local copies of the two Natural Earth repositories:

```sh
git clone --depth 1 --filter=blob:none --sparse https://github.com/nvkelso/natural-earth-vector
git -C natural-earth-vector sparse-checkout set geojson
git clone --depth 1 --filter=blob:none --sparse https://github.com/nvkelso/natural-earth-raster
git -C natural-earth-raster sparse-checkout set 10m_rasters/SR_HR

node tools/build-data.mjs natural-earth-vector natural-earth-raster
```

## Checks and builds

```sh
node tools/sim-check.mjs [defense] [seed] [troops]   # run two opposing offensives headlessly
node tools/bundle.mjs                                # single-file build in dist/
```
