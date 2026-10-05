# Iran 1902 War Map

A real-time war map of Iran. You command either side, Blue or Red. Draw a line into the other side's territory and launch an offensive, then watch the border move across the real terrain hour by hour.

![Opening situation: Red holds the western highlands, Blue the rest of Iran](docs/screenshot.jpg)

## Play

Open `index.html` in a modern browser (Chrome, Edge, Firefox or Safari with WebGL2). No server or build step is needed, and it works straight from disk.

1. **Pick a side.** Click **Blue** or **Red** in the command panel. You can command either side, one operation at a time.
2. **Draw the objective.** Drag a line into the enemy's land. Everything between your current front and the line becomes the objective, shown hatched.
   - A line that crosses enemy land is a **front-line offensive**. Ends that stop short are tied to the nearest edge.
   - A closed loop is an **encirclement** and takes the enemy ground inside it.
   - A short arrow that stops deep in enemy land is a **thrust**: a salient along the arrow.
   - **Flip objective** takes the other side of your line when that is a comparable piece.
3. **Attack.** Set the enemy's defense strength from 1 (scattered militia) to 100 (fortified line). Stronger defenses take longer. The dialog shows the estimated duration, the expected completion date and the rate of advance.
4. **Watch.** The front advances in real time. Zoom in to see it break through, stall and flow around towns. The war diary records captured towns and provinces.
5. When the offensive ends, or you **halt** it, pick a side again and plan the next attack or a counter-attack from the new borders.

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
| Zoom | Scroll wheel, `+` / `−`, double-click | Pinch |
| Show all of Iran | `F` or ⤢ | ⤢ |
| Pause / resume | `Space` | ❚❚ |
| Speed | `1`–`4` | Speed buttons |
| Clear the line | `Esc` | Clear |

The map state, clock and diary are saved in the browser. **New war** resets to the opening situation.

## How the fighting is simulated

Iran is divided into a grid of about 385,000 cells of roughly 2 × 2 km. For each objective cell the game works out a local rate of advance from:

- **Terrain roughness**, measured from the shaded relief. The Zagros and Alborz ranges are slow going; the central deserts are fast.
- **Rivers**, from Natural Earth's river centrelines. Crossing a major river costs time.
- **Towns**, which hold out. Bigger towns hold out longer, so the front flows around them and pockets form.
- **Sector strength**: some sectors of the enemy line are stronger than others.
- **Spearheads** (1–4 per offensive): fast corridors that drive deep and can encircle the ground between them. They are drawn as arrows.
- **Defensive belts** at some depth behind the enemy front, which stall the advance until it finds a gap.
- **Break-in and exhaustion**: the first kilometres are the hardest, and the advance tires with depth.

A fast-marching (Eikonal) solver turns these speeds into the hour at which the front reaches every cell. The WebGL renderer compares those arrival times with the clock for every pixel, so the border moves smoothly at any zoom.

## Project layout

```
index.html          page and UI markup
css/style.css       interface styles
js/util.js          noise, heap, calendar, decoding helpers
js/world.js         simulation grid and ownership
js/planner.js       turns a drawn line into an objective
js/sim.js           rate-of-advance model, fast marching, running offensives
js/renderer.js      WebGL2 map: stencilled land/water/Iran, relief shading, moving front
js/overlay.js       borders, drawn line, spearhead arrows, town labels (Canvas 2D)
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
node tools/sim-check.mjs [defense] [seed]   # plan and run an offensive headlessly
node tools/bundle.mjs                       # single-file build in dist/
```
