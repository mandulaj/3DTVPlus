# 3D Terrain Viewer — Roadmap & TODO

A prioritized roadmap for improving stability, performance, modularity, and outdoor features while keeping the app **100% static / zero-backend** (hostable on GitHub Pages with browser-local storage via IndexedDB).

---

## Phase 1 — Stability, Bug Fixes & CI Foundation

*Low-risk, high-impact fixes to prevent race conditions, UI traps, data loss, and security issues.*

- [x] **Async race conditions & request cancellation**:
  - Add monotonic request tokens + `AbortController` to `SlfLayers` (`setBulletin`, `setStations`, `setAvalanches`), `SacRoutes` click lookups, `TerrainCheck` (`compute`/`clear`), `Planner` (`suggestName`/`connect`), `Panel.applyPreset`, `Search`, and `SunControls.locateZone`.
  - Check `response.ok` before `.json()` across all API clients (especially `src/layers/sac.ts`, preventing HTTP 429/503 from permanently caching `null` grades).
  - Add `AbortSignal.timeout` + clean cancellation to `elevation.ts`, `places.ts`, `weather.ts`, `weatherCard.ts`, and `planner.ts` (BRouter).
- [x] **Deterministic Z-order & unified map interactions**:
  - Split `SLOT.top` in `src/map.ts` into deterministic sub-slots: `slot-area-data` → `slot-line-highlight` → `slot-line-data` → `slot-point-data` (so toggling Avalanche Bulletin ON never paints over routes or stations).
  - Restore default MapLibre `glyphs` when switching from an external vector base style back to a raster base map.
  - Replace `interaction = { drawing: false }` with an explicit tool-mode controller (`'explore' | 'draw-route' | 'draw-area'`) respected by **all** DOM markers (`PeakLabels`, `Huts`, `Gipfelbuch`, `Webcams`, `Weather`), and centralize click priority (`point > line > area > async raster identify`) + hover cursor ref-counting.
- [x] **Data pipeline & deployment fixes**:
  - Fix `scripts/deploy.sh` so deploying doesn't overwrite live cron-refreshed `data/gipfelbuch.json` on `gh-pages`.
  - Fix cross-cell route disappearance in `scripts/fetch-skitourenguru.mjs`, `fetch-snowshoe.mjs`, and `fetch-camptocamp.mjs` (index each route into every cell its geometry intersects, deduplicating by ID on load).
- [x] **Security, parser & UX hardening**:
  - Cap `DecompressionStream` output size in `src/share.ts` (prevent decompression-bomb tab crashes) and validate decoded coordinate bounds (`[-90, 90]`, `[-180, 180]`).
  - Use `encodeURIComponent(url)` in `LayerManager` `userProxy` concatenation; validate `https?://` on all popup `href`s (`routes.ts`, `routeSources.ts`); escape `validTimePeriod` in `slf.ts` (`bulletinHtml`).
  - Add DataView bounds checks in `readFit()` (`src/trackFiles.ts`).
  - Fix `typing()` in `src/keys.ts` so checkboxes and range sliders don't block `WASDQERF`/`N`/`L`/`/` shortcuts.
  - Add a touch-accessible way to delete intermediate waypoints in `Planner` (iOS Safari does not fire `contextmenu` on `<div>` markers).
- [x] **CI & typechecking**:
  - Add `"tests"` to `tsconfig.json` `"include"`.
  - Add `.github/workflows/ci.yml` running `npm test` and `npm run build` on pushes and PRs.

---

## Phase 2 — Core Performance, Sun Realism & IndexedDB Storage

*Removes frame drops and freezes, upgrades 3D sunlight realism, and replaces the 5 MB `localStorage` ceiling with browser-native IndexedDB.*

- [x] **Browser IndexedDB storage layer** *(100% client-side, zero backend)*:
  - Migrate saved GPX/TCX/FIT tracks from `localStorage` (`src/tracks.ts`) to **IndexedDB** (`src/storage.ts`, with automatic one-time migration of existing `localStorage` tracks), eliminating the ~5 MB UTF-16 quota ceiling and establishing the shared store for Phase 4 Custom Layers.
- [x] **3D viewport & DEM optimizations**:
  - Implement a shared horizon-clipped 3D bounding box helper (`src/viewport.ts`) for `sac.ts`, `huts.ts`, `storedRoutes.ts`, and `webcams.ts` (prevents cell/API explosions at 60–89° pitch).
  - Prefetch unique DEM tiles in parallel in `elevations()` (`src/elevation.ts`), fix FIFO → true LRU cache eviction, and bound caches on `StoredRoutes`, `Huts`, and `SacRoutes`.
- [x] **Sun & shadow performance + realism**:
  - Fix time-slider scrubbing lag: debounce `history.replaceState`, drop GPU-stalling `pointCoordinate` readbacks, reduce shadow throttle (2.5 s → 400 ms), fix `shadow.worker.ts` `fieldCache` LRU thrashing, build pyramid levels in parallel, and add a per-worker stall watchdog in `shadowProtocol.ts`.
  - **Fix sun rendering in front of mountains**: Move `SunDisc` from an HTML overlay into a WebGL depth-tested `CustomLayerInterface` so the sun genuinely sets *behind* mountain ridges (including partial ridge eclipse).
  - **Realistic sunrise / sunset alpenglow on peaks**: Dynamically shift sunlit terrain tint, hillshade highlight color, and shadow ambient color by solar elevation angle (warm golden-orange alpenglow at `0°–15°` elevation, cool indigo shadows, transitioning smoothly to daylight).
- [x] **Avalanche `TerrainCheck` & `Planner` performance**:
  - Transfer typed arrays (`Transferable[]`) to `CheckWorker`, enlarge runout margin (`200 m` → `450 m`), and release retained `heights` buffers after compute.
  - Upgrade `Network.route()` from uninformed Dijkstra to A* with a detour budget and $O(L)$ path reconstruction.
- [x] **Peak & marker DOM optimizations**:
  - Batch `PeakLabels` DOM reads/writes (eliminating 36 synchronous layout reflows/frame) and viewport-cull `Gipfelbuch` pins (`MAX_SHOWN = 120` prioritized by recency). *(Full migration of markers to WebGL symbol layers can follow inside Phase 3's `LayerPlugin` architecture.)*

---

## Phase 3 — Modular `LayerPlugin` Architecture & Test Suite

*Makes plugging in new layers and cross-layer interactions clean, declarative, and well-tested.*

- [ ] **Unified `LayerPlugin` + `LayerHost` architecture**:
  - Consolidate the 9 ad-hoc layer patterns into one `LayerPlugin` interface with declarative UI controls, topic assignment, URL hash serialization, lifecycle `AbortSignal`s, unified Legend registration, and structured `license` metadata.
  - Fix `Panel.applyPreset()` to cleanly reset all registered plugins (including reports, webcams, weather, peaks, and route filters).
- [ ] **Inter-layer capability registries**:
  - Introduce `ConditionsRegistry` (`snowAt`, `dangerAt`, `slopeAt`, `zonesAt`, `stationsNear`, `bulletinHtmlAt`) so `Planner`, `TerrainCheck`, and `WeatherCard` work with any regional provider instead of hardcoding `SlfLayers`.
  - Introduce activity-tagged `RoutableNetworkRegistry` (`ski`, `snowshoe`, `hiking`, `cycling`) so summer hike planning doesn't snap onto winter ski lines.
- [ ] **Refactor monoliths & expand test coverage**:
  - Split `src/planner.ts` (1,538 LoC) and `src/ui/panel.ts` (854 LoC) into focused modules.
  - Extract pure testable modules (`src/urlState.ts`, `src/sun/shadowMath.ts`, `src/layers/caaml.ts`) and expand Vitest coverage + add Playwright smoke tests.

---

## Phase 4 — Custom User Layers & Strava History Importer

*100% client-side custom maps & personal activity heatmaps stored in browser IndexedDB.*

- [ ] **Unified drag-and-drop & Import pipeline**:
  - Auto-detect file types when dropped onto the map or selected via **Import**:
    - **Tracks** (`GPX`, `TCX`, `FIT`) → open in track viewer / add to track list.
    - **Vector map layers** (`GeoJSON`, `KML`, `KMZ`) → add as a toggleable custom WebGL layer with feature click popups.
    - **Georeferenced raster layers** (`KMZ GroundOverlay`, `GeoTIFF` via lazy-loaded `geotiff.js`, or image + corner coordinates JSON) → drape directly onto 3D terrain via MapLibre `ImageSource`.
- [ ] **Custom Layers UI & styling**:
  - New **Custom layers** section in the sidebar with per-layer toggle, **color picker** (plus optional color-by-activity/property), opacity slider, line-width control, rename, and delete.
  - Persist all imported custom layers in **IndexedDB** so they remain available across reloads with zero backend.
- [ ] **Strava history converter script (`scripts/strava-to-layer.mjs`)**:
  - Local Node CLI taking a personal Strava account export ZIP/folder (`activities.csv` + `.gpx`/`.fit.gz`/`.tcx.gz` files) or any local folder of tracks.
  - Simplifies and merges all tracks into a single compact `.geojson` custom layer tagged with activity type (`Ski Touring`, `Hike`, `Ride`, `Paragliding`, etc.), date, distance, and ascent — ready to drag-and-drop onto the map and save in IndexedDB.

---

## Phase 5 — 🪂 Paragliding Category, 3D Airspace & 0-MB Alpine Catalog Wins

- [ ] **0-MB Quick Catalog Wins (`src/layers/catalog.ts`)**:
  - Switzerland OGD: Winter hiking (`ch.astra.winterwanderwege` WMTS), daily Hiking closures & detours (`ch.astra.wanderland-sperrungen_umleitungen` live WMS + optional geo.admin click-identify), Glider Chart (`ch.bazl.segelflugkarte` WMTS), and Aviation Obstacles / Cables (`ch.bazl.luftfahrthindernis` WMTS).
  - Skyways & thermals (`thermal.kk7.ch`, verify TMS/XYZ scheme & CORS; CC BY-NC-SA).
  - **OpenAIP** live vector airspace tiles (`openaip` added to `KEY_PROVIDERS` in Settings, 0 MB stored in repo).
- [ ] **Paragliding section & preset**:
  - Group skyways/thermals, glider chart, cables/obstacles, ICAO chart, OpenAIP airspace, multi-altitude wind (surface / 850 hPa / 700 hPa via Open-Meteo + SLF wind stations), and take-off/landing sites (OSM `sport=free_flying` / ParaglidingEarth with wind-direction roses).
- [ ] **Click-to-inspect vertical airspace & 3D airspace visualization**:
  - Click any point to display the vertical airspace stack (CTR, TMA, HX, D/R/P zones, floor & ceiling altitudes, and flyable height above terrain).
  - Render **3D extruded airspace volumes** (`fill-extrusion` with `fill-extrusion-base` & `fill-extrusion-height` in metres) so flyable 3D corridors are visible directly above the mountains.

---

## Phase 6 — Alpine & Global Route Expansion (Alps-First → Global PMTiles)

*Strict license isolation: ODbL, CC BY-SA, CC BY-ND 4.0, CC0, CC BY 4.0, Public Domain, and Swiss OGD are always kept as separate sources/layers with dynamic attribution.*

- [ ] **High-value Alpine route upgrades**:
  - **Official swisstopo/SAC Ski Routes (`ch.swisstopo-karto.skitouren` STAC GPKG)**: Clone `scripts/fetch-snowshoe.mjs` to replace/upgrade `stg-ch` with full official OGD metadata (`difficulty_en`, ascent/descent, times, SAC portal link).
  - **Alps-wide Camptocamp**: Widen `fetch-camptocamp.mjs` bbox to full Alps (`5.0 44.0 16.0 48.0`) and add `mountain_climbing`, `rock_climbing`, `ice_climbing`, and `snowshoeing`.
  - **OSM Alpine Vector Pack (`scripts/fetch-osm-alpine.mjs`)**: Compact ODbL extracts for `via_ferrata` (`K1–K6`), `tourism=alpine_hut`/`wilderness_hut` (filling the CH/AT/IT gap in `refuges.info`), `sac_scale` T4–T6 alpine trails, `sport=climbing` crags, and `sport=free_flying` launches.
  - *(Optional)* `skitour.fr` pre-fetched FR Alps/Pyrenees ski topos & outings (CC BY-SA 4.0 / CC BY-NC-ND 4.0).
- [ ] **Multi-country snow, avalanche & weather**:
  - Generic **CAAMLv6 / EAWS Avalanche Bulletin** provider (instantly unlocks AT/IT `lawinen.report` alongside SLF, plus adapters for FR Météo-France BERA, NO Varsom, NA Avalanche.org).
  - Camptocamp live `/outings` condition reports (FR/CH/IT/ES), region-adaptive presets, global base map fallback outside CH, and CH-bbox gating for SLF/MeteoSwiss calls in `WeatherCard`.
- [ ] **Global route networks (0-MB live APIs → PMTiles)**:
  - **0-MB live government portals**: Norway **Kartverket Turrutebasen** (WMS + WFS identify), New Zealand **DOC Tracks** (live ArcGIS REST GeoJSON), USA **USGS National Digital Trails** (live ArcGIS REST).
  - **PMTiles (`pmtiles` protocol + free-tier Cloudflare R2)** for large global vector networks (5–10× smaller than JSON, GPU-native filtering, `z >= 12` planner snapping):
    - **OpenBeta** (CC0 global climbing crag index <3 MB + live `api.openbeta.io` GraphQL route list on click).
    - **OpenSkiData** (ODbL global pistes, lifts, backcountry/nordic runs).
    - **Global OSM Outdoor Routes** (hiking, MTB, via ferrata, paddling `route=canoe` via `osmium` + `tippecanoe`).

---

## Phase 7 — Advanced Backcountry Features, Offline PWA & GPU 3D Engine Spike

- [ ] **GPU-accelerated 3D rendering & engine evaluation spike** *(benchmarking `map.beyondmaps.app`)*:
  - Prototype WebGL2/WebGPU GPU-accelerated terrain shadows & atmospheric scattering for 60 fps real-time time-slider scrubbing.
  - Evaluate **MapLibre + Three.js hybrid (`CustomLayerInterface`)** (keeps all 55+ raster/vector layers & globe while using Three.js for 3D airspace, sun/sky, and GPU lighting) vs a **full custom Three.js / WebGPU terrain engine**.
- [ ] **Offline Backcountry PWA**:
  - Code-split Vite build (drop monolithic 2 MB `viteSingleFile` render block) + add Web App Manifest & Service Worker.
  - One-tap *"Download area for offline"* caching DEM, base topo tiles, route cells, saved tracks, and latest avalanche bulletin for zero-reception alpine use.
- [ ] **Route Sun/Shadow & Aspect-Crux Timeline**:
  - Combine `Planner` + `SunController` + DEM to show when each segment enters/leaves direct sun along a tour plus an aspect-elevation rose.
- [ ] **Automated Route Hazard & Wildlife-Zone Warnings**:
  - Flag planned route segments crossing `>30° / >35° / >40°` slopes, runout zones, active winter wildlife quiet zones (`ch-wildruhe`), or glaciers.
- [ ] **Public Transport Trailhead Integration (SBB / PostAuto / ÖBB)**:
  - Overlay mountain transit stops, snap route start/end to stops, and open pre-filled SBB / ÖBB timetables.
- [ ] **3D Route Flyover & Live GPS Breadcrumb**:
  - Smooth 3D camera fly-along synced to the elevation profile / recorded timestamps, plus live GPS altitude & remaining climb readout.
