import * as maplibregl from 'maplibre-gl';
import type { StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// The MapLibre worker is a self-contained module; inlining it as text lets the
// whole app ship as one HTML file.
import workerSource from 'maplibre-gl/dist/maplibre-gl-worker.mjs?raw';

export const DEM_TILES = 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp';
export const DEM_MAXZOOM = 17;
const DEM_ATTRIBUTION = '<a href="https://mapterhorn.com/attribution" target="_blank">© Mapterhorn</a>';

export const WATER_LAYERS = ['water-fill', 'water-line'];
const WATER_COLOUR = '#9dbfd3';
const WATER_EDGE = '#7ba3bb';

/** Invisible anchor layers that define the draw order of everything added later. */
export const SLOT = {
  base: 'slot-base', // base map layers go below this
  overlay: 'slot-overlay', // relief shading + raster overlays go below this
  shadow: 'slot-shadow', // sun shadows / night go below this
  top: 'slot-top', // vector data (bulletin, stations) goes below this
} as const;

const slot = (id: string) => ({ id, type: 'background' as const, layout: { visibility: 'none' as const } });

const COLOR_RELIEF = [
  'interpolate', ['linear'], ['elevation'],
  -100, '#5b88b5', 0, '#7fb08a', 400, '#a9c58a', 900, '#d9d39a', 1600, '#c9a877',
  2200, '#a98b6f', 2800, '#b9b0a8', 3400, '#e8e8ec', 4500, '#ffffff', 8800, '#ffffff',
];

export function createMap(container: string): maplibregl.Map {
  maplibregl.setWorkerUrl(URL.createObjectURL(new Blob([workerSource], { type: 'text/javascript' })));

  const dem = {
    type: 'raster-dem' as const,
    tiles: [DEM_TILES],
    encoding: 'terrarium' as const,
    tileSize: 512,
    maxzoom: DEM_MAXZOOM,
    attribution: DEM_ATTRIBUTION,
  };

  const style: StyleSpecification = {
    version: 8,
    projection: { type: 'globe' },
    // One elevation source feeds terrain, relief shading and elevation colours:
    // a second copy doubles downloads, decoding and texture uploads.
    sources: {
      dem,
      // Lakes and rivers for the relief-only view (base maps bring their own). Loaded only while shown.
      water: {
        type: 'vector',
        url: 'https://tiles.openfreemap.org/planet',
        attribution: '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> © <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>',
      },
    },
    terrain: { source: 'dem', exaggeration: 1 },
    sky: {
      'sky-color': '#5b9bd9',
      'horizon-color': '#dfeaf2',
      'fog-color': '#dfeaf2',
      'sky-horizon-blend': 0.6,
      'horizon-fog-blend': 0.5,
      'fog-ground-blend': 0.2,
      'atmosphere-blend': ['interpolate', ['linear'], ['zoom'], 0, 1, 6, 0.6, 9, 0],
    },
    layers: [
      { id: 'background', type: 'background', paint: { 'background-color': '#dfe3e6' } },
      slot(SLOT.base),
      {
        id: 'color-relief',
        type: 'color-relief',
        source: 'dem',
        layout: { visibility: 'none' },
        paint: { 'color-relief-color': COLOR_RELIEF as never, 'color-relief-opacity': 0.8 },
      },
      // Water sits under the relief shading, in a muted tone, so it reads as part of the terrain.
      {
        id: 'water-fill',
        type: 'fill',
        source: 'water',
        'source-layer': 'water',
        layout: { visibility: 'none' },
        paint: { 'fill-color': WATER_COLOUR, 'fill-outline-color': WATER_COLOUR }, // a darker outline would also trace tile edges across lakes
      },
      {
        id: 'water-line',
        type: 'line',
        source: 'water',
        'source-layer': 'waterway',
        minzoom: 10,
        layout: { visibility: 'none', 'line-cap': 'round' },
        paint: { 'line-color': WATER_EDGE, 'line-opacity': 0.8, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 0.4, 14, 1.6, 18, 5] },
      },
      {
        id: 'hillshade',
        type: 'hillshade',
        source: 'dem',
        paint: {
          'hillshade-method': 'standard',
          'hillshade-exaggeration': 0.35,
          'hillshade-illumination-direction': 315,
          'hillshade-illumination-anchor': 'map',
          'hillshade-shadow-color': '#1b2233',
          'hillshade-highlight-color': '#ffffff',
          'hillshade-accent-color': '#1b2233',
        },
      },
      slot(SLOT.overlay),
      slot(SLOT.shadow),
      slot(SLOT.top),
    ],
  };

  const map = new maplibregl.Map({
    container,
    style,
    center: [7.08683, 46.11329],
    zoom: 12.5,
    pitch: 60,
    bearing: 19,
    // Steeper views reach the horizon and need several times more tiles. Shift+drag looks higher (lookAround.ts).
    maxPitch: 78,
    hash: 'map',
    attributionControl: { compact: true },
    canvasContextAttributes: { antialias: true },
    maxTileCacheZoomLevels: 3,
  });

  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
  map.addControl(new maplibregl.GlobeControl(), 'top-right');
  map.addControl(new maplibregl.TerrainControl({ source: 'dem', exaggeration: 1 }), 'top-right');
  map.addControl(new maplibregl.FullscreenControl(), 'top-right');
  map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: false }), 'top-right');
  map.addControl(new maplibregl.ScaleControl({ maxWidth: 160 }), 'bottom-right');

  return map;
}

/** Extra state kept in the URL hash next to MapLibre's own `map=` entry. */
export function readHash(): URLSearchParams {
  return new URLSearchParams(location.hash.replace(/^#/, ''));
}

export function writeHash(update: Record<string, string | null>): void {
  const params = readHash();
  for (const [k, v] of Object.entries(update)) {
    if (v === null || v === '') params.delete(k);
    else params.set(k, v);
  }
  // Keep the hash readable: MapLibre writes its own entry unencoded.
  const text = [...params.entries()].map(([k, v]) => `${k}=${k === 'map' ? v : encodeURIComponent(v)}`).join('&');
  history.replaceState(history.state, '', `#${text}`);
}
