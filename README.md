# 3D Terrain Viewer

Full-screen browser 3D map: open map layers draped over high-resolution
[Mapterhorn](https://mapterhorn.com) terrain, live SLF snow and avalanche data,
globe view when zoomed out, and sunlight with terrain-cast shadows for any date and time.

Built on [MapLibre GL JS](https://maplibre.org). No API keys, no backend.

## Run

```sh
npm install
npm run dev        # http://localhost:5173, includes proxy for SLF terrain tiles
npm run build      # writes dist/index.html, one self-contained file
```

`npm run deploy` builds and publishes `dist/index.html` to the `gh-pages` branch (GitHub Pages).

`dist/index.html` works from any static file server (`python -m http.server --directory dist`).
It only pulls tiles and data from the public services listed below.

## Features

- **Terrain**: Mapterhorn elevation tiles (down to 0.5 m in Switzerland), relief shading,
  optional elevation colours, vertical exaggeration 1–3×.
- **Globe**: zoom out and the map becomes a globe; zoom in and it flattens to Mercator.
- **Layers**: ~25 base maps and ~30 overlays, each overlay with its own opacity. See `src/layers/catalog.ts`.
- **SLF (Switzerland)**: snow depth, new snow (1/2/3 days), snow depth relative to long-term mean,
  avalanche bulletin danger regions, station measurements, recent avalanches. Click for details.
- **Sunlight**: date picker and time slider (your local time zone), play button. Relief shading and sky
  follow the sun, and the sun disc is drawn in the sky ("Face sun" turns the camera toward it). Shadows are
  computed from the elevation data in web workers, including earth curvature and peaks far outside the view.
  On the globe the night side is shaded.
- **Look around**: Shift+drag or middle-button drag turns the camera in place (up to just below the horizon),
  e.g. to look up a mountain from the valley floor. Normal tilt (Ctrl+drag / right-drag) stops at 78°.
- **Camptocamp routes**: ski touring routes from [camptocamp.org](https://www.camptocamp.org) for Switzerland and the eastern Alps
  (Routes section, also part of the "Ski touring CH" preset). Lines where a track was uploaded, dots otherwise;
  click for grade, height gain, measured line and a link. The route planner follows the lines. Camptocamp's API
  does not answer other websites, so the routes are a copy stored with the site in `public/data/camptocamp/`
  (half-degree cells, loaded for the area in view). Refresh or widen it with
  `node scripts/fetch-camptocamp.mjs [west south east north] [activity]`. Needs a web server: the files are not
  reachable when `index.html` is opened directly from disk.
- **Ski route networks**: selectable ski touring lines for Switzerland (swisstopo/SAC), Austria, Bavaria and
  South Tyrol (ÖAV, DAV, AVS) and the French Alps and Pyrenees (Petzl Foundation), all from Skitourenguru's open
  route network, plus swisstopo/SAC snowshoe routes. Stored with the site in quarter-degree cells
  (`public/data/routes/`), loaded for the area in view; click for grade, measured length and ascent; the planner
  follows them. Refresh with `node scripts/fetch-skitourenguru.mjs [ch] [at] [fr]` and
  `node scripts/fetch-snowshoe.mjs`.
- **Huts**: staffed huts, shelters and lodgings from refuges.info, asked live for the area in view (mainly the
  French and western Alps).
- **Condition reports**: recent tour reports from gipfelbuch.ch as pins coloured by age (today … older), with
  a "since" filter (3 days to 1 month). Click a pin for a short excerpt and a link to the report. gipfelbuch.ch
  cannot be asked from a web page, so the list is a stored copy: `node scripts/fetch-gipfelbuch.mjs` refreshes
  it, and `.github/workflows/gipfelbuch.yml` does so three times a day on the published page.
- **Route preview**: clicking a route line (SAC, swisstopo ski/snowshoe, Skitourenguru networks, Camptocamp)
  opens it in the track viewer: profile, statistics, snow/slope/danger colouring. From there name it, save it
  to your tracks or press Edit to use it as the start of your own tour.
- **Menu by topic**: Ski touring & snowshoe, Snow & avalanches, Hiking & mountaineering, Cycling, Weather &
  webcams, Terrain, More maps. Each section shows how many things are switched on in it; a preset switches on
  everything that belongs to its activity and opens its section.
- **Route filters**: "Filter" beside each kind of SAC route and beside Camptocamp limits the routes on the map
  to a range of grades (T1–T6, L–EX, WT1–WT6, K1–K6; Camptocamp F–ED) and of ascent. SAC grades are looked up
  at the SAC portal and SAC ascent is measured along the line, both only while such a filter is set.
- **Weather & conditions card**: click a forecast pill (or right-click the map, "Weather here") for current
  weather at that height, freezing level, nearest SLF snow stations, the avalanche bulletin of the region and
  tables for the last 3 and next 7 days. The place name in the card links to MeteoSwiss (yr.no abroad).
- **Webcams**: camera icons with a link to the webcam. From OpenStreetMap, as a stored copy for Switzerland and
  around (`node scripts/fetch-webcams.mjs` refreshes it); with your own free Windy Webcams API key (Settings)
  from Windy instead, with preview pictures.
- **Avalanche terrain check**: draw an area, or take a 150 m strip along the route in the planner; every 10 m
  cell is classed low / elevated / high after the Graphical Reduction Method (danger level against the steepest
  ground within 20 m, one level lower outside the critical aspects and heights) from today's SLF bulletin or a
  level set by hand. Blue marks gentler ground that avalanches from critical slopes above could reach. It reads
  terrain shape only: a planning aid, not an assessment of the snowpack.
- **Import track**: button beside "Plan a route" (same as dropping GPX, TCX or FIT files on the page).
- **More controls**: Ctrl+middle-drag swings the camera around the point under the cursor; double middle-click
  puts north up; Shift+wheel moves forward and back keeping height above ground; Alt+wheel changes the time of
  day while sunlight is on (Alt+Shift: single minutes). Keys: W A S D move, Q E turn, R F tilt (Shift: faster),
  N north up, L look mode.
- **Tracks**: drop GPX, TCX or FIT files on the page to draw them on the terrain. They stay in the browser
  (local storage, about 5 MB) and are restored after a reload.
- **Presets**: one-click layer sets (ski touring, snowshoe, avalanche terrain, snow conditions, hiking, biking,
  pistes, aerial). See `src/layers/presets.ts`.
- **Route planner**: "Plan a route" in the panel. Click points on the map; a dotted preview shows the next leg. Clicks on a
  path follow it — first the SAC routes shown on the map, then OpenStreetMap paths (BRouter) — and clicks beside a
  path run straight. Double-click to finish; click an end to continue,
  click the line to add a point, drag points, right-click to delete. Live distance, ascent, descent, walking time
  and elevation profile; rename, keep in the track list, export GPX. Dropped tracks open in it via ✎.
- **Share a track**: 🔗 on a track or in the planner copies a link that carries the track itself (simplified and
  compressed into the part after `#`, which is never sent to a server). Whoever opens it sees the track with its
  profile and can save it. A link can also point at a track file hosted elsewhere: `#gpx=https://…/tour.gpx`
  (that host must allow cross-site reading).
- **Profile colours**: the planner's "Colour" choice shows gradient, snow depth (from the snow map that is on),
  terrain slope angle (classes from 30°, computed from the elevation model) or the bulletin's danger level along
  the route. Orientation only, not a risk assessment.
- **Recorded tracks**: heights and times in GPX/TCX/FIT files are kept. Viewing such a track shows recorded time,
  moving time, speed and pace, can switch the profile to recorded heights, colour by speed, and exports the
  recording unchanged. Editing turns it into a plain route.
- **Weather forecast**: for towns and summits in view, weather symbol, lowest/highest temperature and wind for a
  day chosen from a row of eight; model forecast from Open-Meteo (MeteoSwiss ICON model in and around
  Switzerland), summit values adjusted to summit height. Not MeteoSwiss's own edited forecast.
- **Quick search**: Ctrl+F (or `/`, or the 🔍 button) finds peaks, towns, huts and lakes by name, typos allowed
  (OpenStreetMap via Photon); empty box suggests the highest peaks in view.
- **Touch**: on phones the layer panel and planner adapt; taps add points ("Done" finishes), drag and pinch work
  on the profile, a long press opens the map popup, and the eye button makes dragging turn the camera in place.
- **SAC routes**: hiking, mountaineering, climbing, via ferrata, ski touring and snowshoe routes from the SAC route
  portal's public map service, in the portal's colours; click a route for difficulty and a link to its SAC page.
  Content © SAC, shown unofficially. Off by default: SAC and Skitourenguru data load only after "Show unofficial
  third-party data" is switched on under *Settings* (stored per browser; links cannot switch it on).
- **Peak names**: markers with name, altitude and distance from the camera (OpenStreetMap peaks); click one to stand
  on that summit, then Shift+drag to look around.
- **Routes**: with the ski or snowshoe route overlay on, click a route for difficulty, times and a link to the
  SAC route portal (lookup via geo.admin.ch). Optional Skitourenguru layer: tours across the Alps coloured by that
  service's risk rating for today (their data, fetched live, shown unofficially).
- **Bulletin details**: click a danger region for problems, snowpack, weather and tendency; "Show full
  bulletin" opens that region on White Risk (neither slf.ch nor whiterisk.ch allows embedding).
- **Historic aerial photos**: swisstopo SWISSIMAGE time travel 1926–2025 as an overlay; areas without photos for the
  chosen year stay transparent.
- **Blue water**: lakes and rivers (OpenFreeMap / OpenStreetMap) in the relief-only view and under elevation colours.
- **Mapy.com** outdoor and winter maps: enter your API key under *Settings* (kept in the browser's storage).
- **Shareable URL**: view, layers and sun time are stored in the URL hash.

## How shadows work

`src/sun/shadow.worker.ts` computes one shadow tile per map tile from 256×256 terrain samples. It sweeps a
"shadow surface" across a mosaic of elevation tiles, away from the sun: each cell takes the surface of the cell
before it, lowered by the sun's slope, unless the terrain there is higher. Up to four nested mosaics are swept
(tile zoom, and 2, 4, 6 zoom levels coarser) so distant peaks cast shadows too; the sun disc's width gives a
soft edge. Shaded ground is drawn dark blue, sunlit ground gets a light warm tint, and generic relief shading
is toned down in sunlight mode so the two are easy to tell apart. Tiles reach MapLibre through a `shadow://`
protocol and are recomputed when the time changes.

Limits: a tile takes about 20 ms once its elevation data is cached, several hundred ms when it has to be
downloaded first. Shadows are computed from zoom 7 to 15 (about 3 m ground resolution); closer in they are upscaled.

## Layers marked "proxy"

SLF's avalanche terrain maps (CAT, ATH, slope) send no CORS headers and have no published licence;
they are included for personal use. They work under `npm run dev` / `npm run preview` (built-in proxy).
In the static build, enter a CORS proxy prefix under *Settings* to enable them; the tile URL is appended
to that prefix. All other layers need no proxy.

## Data sources and attribution

| Data | Source | Terms |
|---|---|---|
| Elevation | [Mapterhorn](https://mapterhorn.com/attribution) (swisstopo swissALTI3D and others) | open, attribution |
| Swiss maps, imagery, thematic layers | [swisstopo / geo.admin.ch](https://www.geo.admin.ch) | open government data, attribution |
| OSM-based maps | OpenStreetMap, OpenTopoMap, CyclOSM, OpenFreeMap, Waymarked Trails, OpenSnowMap, OpenRailwayMap | ODbL / CC-BY-SA, fair use |
| Imagery | Esri World Imagery, EOX Sentinel-2 cloudless (CC BY-NC-SA), NASA GIBS | see providers |
| Neighbours | basemap.at, IGN Géoplateforme, BKG TopPlusOpen, Kartverket, Province of Bolzano | open, attribution |
| Snow, avalanche bulletin, stations | [WSL-SLF](https://www.slf.ch) (bulletin CC BY 4.0) | attribution |
| Radar | RainViewer | personal use |
| Mapy.com outdoor / winter | [Mapy.com REST API](https://developer.mapy.com) | own API key; their terms require attribution and logo |

These are free public services without guarantees. Keep usage light; do not bulk-download tiles.

`npm run check-layers` fetches one sample tile per catalogue entry and reports status and CORS.

`npm test` runs the unit tests (track files, share links, route search, time model, grid maths); `npm run deploy`
runs them first. No CI workflow is included: add one under `.github/workflows` if wanted.

## Safety

Snow and avalanche layers are for orientation only. For decisions in avalanche terrain use the official
bulletin at [slf.ch](https://www.slf.ch) / [whiterisk.ch](https://whiterisk.ch).

## Data licences

The code does not cover the data under `public/data/`. Each collection is a copy of someone else's work, kept
unchanged apart from conversion to longitude/latitude (rounded to about 1 m) and sorting into cells:

- `camptocamp/`: © Camptocamp contributors, [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/) (a
  few CC BY-NC-ND). Each route keeps its licence and a link to its authors (`credit`).
- `routes/stg-ch/`: ski routes © swisstopo / SAC, swisstopo open data licence (source to be named), taken from
  the [Skitourenguru route network](https://github.com/skitourenguru/Routes).
- `routes/stg-at/`: © ÖAV, DAV, AVS – Ski Touring Routes for Austria, Germany and South Tyrol,
  [CC BY-ND 4.0](https://creativecommons.org/licenses/by-nd/4.0/), from the same repository.
- `routes/stg-fr/`: ski routes created and maintained by the Petzl Foundation in cooperation with Skitourenguru
  GmbH, CC BY-ND 4.0 (their smoothed lines from download.skitourenguru.com). The Italian part of that network
  is under a private licence and is not included.
- `routes/ch-snowshoe/`: snowshoe routes © swisstopo / SAC, swisstopo open data.
- `webcams.json`: © OpenStreetMap contributors, ODbL.
- `gipfelbuch.json`: titles, dates, authors, positions and a short excerpt (at most 220 characters) of public
  condition reports on [gipfelbuch.ch](https://www.gipfelbuch.ch/verhaeltnisse/uebersicht), each linking to the
  full report there. The reports belong to their authors and gipfelbuch.ch; no licence for reuse is stated, so
  this is meant for personal use. Remove the file and the workflow if that is not acceptable.

The Skitourenguru repository also says its data may be used for private, non-commercial purposes only. This
viewer is a private, non-commercial project; whoever reuses it otherwise must check those terms, and whether
converting coordinates counts as a change under "no derivatives".
