import * as maplibregl from 'maplibre-gl';
import type { StyleSpecification } from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
// The MapLibre worker is a self-contained module; inlining it as text lets the
// whole app ship as one HTML file.
import workerSource from 'maplibre-gl/dist/maplibre-gl-worker.mjs?raw';

export const DEM_TILES = 'https://tiles.mapterhorn.com/{z}/{x}/{y}.webp';
export const DEM_MAXZOOM = 17;
export const DEFAULT_GLYPHS = 'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';
const DEM_ATTRIBUTION = '<a href="https://mapterhorn.com/attribution" target="_blank">© Mapterhorn</a>';

export const WATER_LAYERS = ['water-fill', 'water-line'];
const WATER_COLOUR = '#9dbfd3';
const WATER_EDGE = '#7ba3bb';

/** Invisible anchor layers that define the deterministic draw order of everything added later. */
export const SLOT = {
  base: 'slot-base', // base map layers go below this
  overlay: 'slot-overlay', // relief shading + raster overlays go below this
  shadow: 'slot-shadow', // sun shadows / night go below this
  area: 'slot-area-data', // polygon/area overlays (bulletin, terrain check) go below this
  lineHighlight: 'slot-line-highlight', // selected route highlight goes below this
  line: 'slot-line-data', // vector route lines (SAC, stored routes) go below this
  point: 'slot-point-data', // point overlays (stations, avalanches, guru, crags) go below this
  top: 'slot-point-data', // alias for backwards compatibility
  tracks: 'slot-tracks', // dropped and saved tracks: above every map layer
  plan: 'slot-plan', // the route being planned or viewed: above the tracks
} as const;

const slot = (id: string) => ({ id, type: 'background' as const, layout: { visibility: 'none' as const } });

const COLOR_RELIEF = [
  'interpolate', ['linear'], ['elevation'],
  -100, '#5b88b5', 0, '#7fb08a', 400, '#a9c58a', 900, '#d9d39a', 1600, '#c9a877',
  2200, '#a98b6f', 2800, '#b9b0a8', 3400, '#e8e8ec', 4500, '#ffffff', 8800, '#ffffff',
];

/**
 * `blankless://host/path` fetches `https://host/path` and makes the blank parts of a tile transparent.
 * swisstopo's historic photo layer is white wherever a year has no imagery: whole tiles, or the
 * part of a tile beyond the edge of the photo mosaic. White that touches the tile border is removed;
 * bright spots inside a photo (snow, roofs) stay.
 */
const BLANK_TILE_BYTES = 1200; // an all-white JPEG tile
const WHITE = 244;

function registerBlanklessProtocol(): void {
  maplibregl.addProtocol('blankless', async (params, abortController) => {
    const response = await fetch(params.url.replace('blankless://', 'https://'), { signal: abortController.signal });
    if (!response.ok) throw new Error(`Tile ${response.status}`);
    const blob = await response.blob();
    if (blob.size < BLANK_TILE_BYTES) return { data: await createImageBitmap(new ImageData(1, 1)) };

    const bitmap = await createImageBitmap(blob);
    const { width, height } = bitmap;
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext('2d', { willReadFrequently: true })!;
    context.drawImage(bitmap, 0, 0);
    bitmap.close();
    const image = context.getImageData(0, 0, width, height);
    const px = image.data;
    const isWhite = (i: number) => px[i * 4 + 3] !== 0 && px[i * 4] >= WHITE && px[i * 4 + 1] >= WHITE && px[i * 4 + 2] >= WHITE;

    // Flood fill inward from every white border pixel.
    const stack: number[] = [];
    const visit = (i: number) => {
      if (isWhite(i)) {
        px[i * 4 + 3] = 0;
        stack.push(i);
      }
    };
    for (let x = 0; x < width; x++) {
      visit(x);
      visit((height - 1) * width + x);
    }
    for (let y = 0; y < height; y++) {
      visit(y * width);
      visit(y * width + width - 1);
    }
    if (!stack.length) return { data: await createImageBitmap(blob) }; // fully covered: nothing to cut
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % width;
      if (x > 0) visit(i - 1);
      if (x < width - 1) visit(i + 1);
      if (i >= width) visit(i - width);
      if (i < (height - 1) * width) visit(i + width);
    }
    return { data: await createImageBitmap(image) };
  });
}

export function createMap(container: string): maplibregl.Map {
  registerBlanklessProtocol();
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
    glyphs: DEFAULT_GLYPHS,
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
      slot(SLOT.area),
      slot(SLOT.lineHighlight),
      slot(SLOT.line),
      slot(SLOT.point),
      slot(SLOT.tracks),
      slot(SLOT.plan),
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

/**
 * Layer names inside the `water` vector source (lakes, rivers, peaks, place names). They are
 * OpenFreeMap's; after `watchVectorSource` has switched to the other provider, VersaTiles'.
 */
export const vectorLayers = { water: 'water', waterway: 'waterway', peak: 'mountain_peak', place: 'place' };
const FALLBACK_LAYERS: typeof vectorLayers = { water: 'water_polygons', waterway: 'water_lines', peak: 'mountain_peaks', place: 'place_labels' };
const FALLBACK_TILES = 'https://tiles.versatiles.org/tiles/osm-vector/{z}/{x}/{y}';
const FALLBACK_ATTRIBUTION = '<a href="https://versatiles.org" target="_blank">VersaTiles</a> © <a href="https://www.openstreetmap.org/copyright" target="_blank">OpenStreetMap</a>';

/**
 * Peak names, town names and lakes all come from one tile service. Some ad blockers stop it, and
 * it can be down: then the same data is taken from a second service (peaks there only from zoom 10).
 */
export function watchVectorSource(map: maplibregl.Map, onSwitch: () => void = () => {}): void {
  let tileErrors = 0;
  let switched = false;
  map.on('error', (event) => {
    const error = event as unknown as { sourceId?: string; tile?: unknown };
    if (switched || error.sourceId !== 'water') return;
    // The service's description failing is decisive; single tiles may fail for other reasons.
    if (error.tile && ++tileErrors < 3) return;
    switched = true;
    const layers = map.getStyle().layers;
    const mine = (layer: maplibregl.LayerSpecification) => 'source' in layer && layer.source === 'water';
    const moved = layers.filter(mine).map((layer) => ({ layer, before: layers.slice(layers.indexOf(layer) + 1).find((later) => !mine(later))?.id }));
    for (const { layer } of moved) map.removeLayer(layer.id);
    map.removeSource('water');
    map.addSource('water', { type: 'vector', tiles: [FALLBACK_TILES], maxzoom: 14, attribution: FALLBACK_ATTRIBUTION });
    const renamed = new Map(Object.entries(vectorLayers).map(([key, name]) => [name, FALLBACK_LAYERS[key as keyof typeof vectorLayers]]));
    for (const { layer, before } of moved) {
      const sourceLayer = (layer as { 'source-layer'?: string })['source-layer'];
      map.addLayer({ ...layer, 'source-layer': renamed.get(sourceLayer ?? '') ?? sourceLayer } as maplibregl.LayerSpecification, before);
    }
    Object.assign(vectorLayers, FALLBACK_LAYERS);
    console.warn('Place and peak names: first service unavailable, using the second');
    onSwitch();
  });
}
