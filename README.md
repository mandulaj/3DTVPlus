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
- **Look around**: Shift+drag turns the camera in place (up to just below the horizon), e.g. to look up a
  mountain from the valley floor. Normal tilt (Ctrl+drag / right-drag) stops at 78°.
- **Tracks**: drop GPX, TCX or FIT files on the page to draw them on the terrain. They stay in the browser
  (local storage, about 5 MB) and are restored after a reload.
- **Presets**: one-click layer sets (ski touring, snowshoe, avalanche terrain, snow conditions, hiking, biking,
  pistes, aerial). See `src/layers/presets.ts`.
- **Route planner**: "Plan a route" in the panel. Click points on the map; a dotted preview shows the next leg. Clicks on a
  path follow it — first the SAC routes shown on the map, then OpenStreetMap paths (BRouter) — and clicks beside a
  path run straight. Double-click to finish; click an end to continue,
  click the line to add a point, drag points, right-click to delete. Live distance, ascent, descent, walking time
  and elevation profile; rename, keep in the track list, export GPX. Dropped tracks open in it via ✎.
- **SAC routes**: hiking, mountaineering, climbing, via ferrata, ski touring and snowshoe routes from the SAC route
  portal's public map service, in the portal's colours; click a route for difficulty and a link to its SAC page.
  Content © SAC, shown unofficially.
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

## Safety

Snow and avalanche layers are for orientation only. For decisions in avalanche terrain use the official
bulletin at [slf.ch](https://www.slf.ch) / [whiterisk.ch](https://whiterisk.ch).
