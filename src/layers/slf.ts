// Live snow and avalanche data from WSL-SLF (https://www.slf.ch, https://whiterisk.ch).
import * as maplibregl from 'maplibre-gl';
import type { ImageSource, MapGeoJSONFeature } from 'maplibre-gl';
import { interaction } from '../interaction';
import { SLOT } from '../map';

const SLF_ATTRIBUTION = '© <a href="https://www.slf.ch" target="_blank">WSL-SLF</a>';

export interface ColorScale {
  unit: string;
  steps: { color: string; start: number }[];
}

/** Reads the snow map currently shown at single points (for the route profile). */
export interface SnowSampler {
  name: string;
  unit: string;
  /** Whether the snow map is on the map right now (its data is kept after it is switched off). */
  shown: boolean;
  /** Value and class colour at a point; null where the map has no data. */
  at(lng: number, lat: number): { value: number; colour: string } | null;
}

/** Reads the avalanche bulletin shown on the map at single points (for the route profile). */
export interface DangerSampler {
  /** Danger level of the bulletin region at a point; null outside the bulletin area or without a rating. */
  at(lng: number, lat: number): {
    level: number;
    name: string;
    colour: string;
    region: string;
    bands: { from: number; to: number }[];
    /** Where the danger mainly is, from the bulletin's first avalanche problem: aspects as a bit set (bit 0 = N, 1 = NE, … clockwise; 255 = all) and the height it applies above (-1: all heights). */
    core: { aspects: number; above: number };
  } | null;
}

export interface Legend {
  title: string;
  subtitle?: string;
  unit?: string;
  entries: { color: string; label: string }[];
}

export const SNOW_PRODUCTS = {
  hs: { short: 'Depth', name: 'Snow depth', host: 'https://snow-maps-hs.slf.ch/public/hs/map', code: 'HS1D-v2', supportsCurrent: true },
  hn1: { short: 'New 1d', name: 'New snow, 1 day', host: 'https://snow-maps-hs.slf.ch/public/hn/map', code: 'HN1D', supportsCurrent: false },
  hn2: { short: 'New 2d', name: 'New snow, 2 days', host: 'https://snow-maps-hs.slf.ch/public/hn/map', code: 'HN2D', supportsCurrent: false },
  hn3: { short: 'New 3d', name: 'New snow, 3 days', host: 'https://snow-maps-hs.slf.ch/public/hn/map', code: 'HN3D', supportsCurrent: false },
  hsrel: { short: 'vs. mean', name: 'Snow depth vs. long-term mean', host: 'https://snow-maps-hsrel.slf.ch/public/hsrel/map', code: 'HSREL', supportsCurrent: true },
} as const;
export type SnowProduct = keyof typeof SNOW_PRODUCTS;

export const STATION_TYPES = {
  SNOW_HEIGHT: { name: 'Snow depth', unit: 'cm' },
  HEIGHT_NEW_SNOW_1D: { name: 'New snow, 1 day', unit: 'cm' },
  HEIGHT_NEW_SNOW_3D: { name: 'New snow, 3 days', unit: 'cm' },
  TEMPERATURE_AIR: { name: 'Air temperature', unit: '°C' },
  WIND_MEAN: { name: 'Wind (mean)', unit: 'km/h' },
} as const;
export type StationType = keyof typeof STATION_TYPES;

const DANGER: Record<string, { level: number; color: string }> = {
  low: { level: 1, color: '#ccff66' },
  moderate: { level: 2, color: '#ffff00' },
  considerable: { level: 3, color: '#ff9900' },
  high: { level: 4, color: '#ff0000' },
  very_high: { level: 5, color: '#a00000' },
};
interface BulletinRegion {
  box: number[];
  rings: number[][][][];
  properties: Record<string, any>;
}

/** The bulletin's regions with their outlines, ready for point lookups. */
function regionsOf(data: { features: any[] }): BulletinRegion[] {
  return data.features
    .filter((f) => f.geometry?.type === 'Polygon' || f.geometry?.type === 'MultiPolygon')
    .map((f) => {
      const rings: number[][][][] = f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.coordinates;
      const box = [Infinity, Infinity, -Infinity, -Infinity];
      for (const polygon of rings) {
        for (const [x, y] of polygon[0]) {
          if (x < box[0]) box[0] = x;
          if (y < box[1]) box[1] = y;
          if (x > box[2]) box[2] = x;
          if (y > box[3]) box[3] = y;
        }
      }
      return { box, rings, properties: f.properties ?? {} };
    });
}

function regionHolds(region: BulletinRegion, lng: number, lat: number): boolean {
  const [minX, minY, maxX, maxY] = region.box;
  if (lng < minX || lng > maxX || lat < minY || lat > maxY) return false;
  // Inside one of the polygons: within its outer ring and not in a hole (even-odd over all rings).
  return region.rings.some((polygon) => {
    let hit = false;
    for (const ring of polygon) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) hit = !hit;
      }
    }
    return hit;
  });
}

const SUBDIVISION: Record<string, string> = { minus: '−', neutral: '=', plus: '+' };

const R = 6378137;
const mercToLngLat = (x: number, y: number): [number, number] => [
  (x / R) * (180 / Math.PI),
  (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI),
];

const escapeHtml = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** Bulletin texts contain <br/> only; everything else is escaped. */
const richText = (s: unknown) => escapeHtml(s).replace(/&lt;br\s*\/?&gt;/g, '<br>');
/** Longer bulletin texts are HTML: keep simple structure, drop everything else (attributes, scripts, links). */
const SAFE_TAGS = new Set(['H2', 'H3', 'P', 'UL', 'OL', 'LI', 'BR', 'B', 'STRONG', 'EM', 'I']);
function safeHtml(html: unknown): string {
  const render = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return escapeHtml(node.textContent);
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const inner = [...node.childNodes].map(render).join('');
    const tag = (node as Element).tagName;
    if (!SAFE_TAGS.has(tag)) return inner;
    const name = tag === 'H2' || tag === 'H3' ? 'h4' : tag.toLowerCase();
    return name === 'br' ? '<br>' : `<${name}>${inner}</${name}>`;
  };
  return [...new DOMParser().parseFromString(String(html ?? ''), 'text/html').body.childNodes].map(render).join('');
}

export const BULLETIN_LINKS = {
  slf: 'https://www.slf.ch/en/avalanche-bulletin-and-snow-situation/',
  whiteRisk: 'https://whiterisk.ch/en/conditions/bulletin',
};

const pretty = (s: unknown) => String(s ?? '').replace(/_/g, ' ').toLowerCase();
const fmtTime = (iso: string | undefined) =>
  iso ? new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** GeoJSON properties come back from the renderer with nested values JSON-encoded. */
function parseProps(feature: MapGeoJSONFeature): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(feature.properties ?? {})) {
    if (typeof v === 'string' && /^[[{]/.test(v)) {
      try {
        out[k] = JSON.parse(v);
        continue;
      } catch {
        /* plain string */
      }
    }
    out[k] = v;
  }
  return out;
}

export class SlfLayers {
  onLegend: (key: string, legend: Legend | null) => void = () => {};
  onError: (message: string) => void = () => {};

  /** Shared by everything that shows details for a clicked map feature, so only one is open at a time. */
  readonly popup = new maplibregl.Popup({ maxWidth: '360px', closeButton: true });
  private snowToken = 0;
  private snowUrl: string | null = null;
  private stationUnit = '';

  constructor(private map: maplibregl.Map) {
    // Station value labels are drawn as generated images, so they need no glyph server
    // (the glyph URL belongs to whichever vector base map is active).
    map.on('styleimagemissing', (e) => {
      if (e.id.startsWith('lbl:')) this.addLabelImage(e.id);
    });
  }

  // ───────────── Snow maps (gridded) ─────────────

  /** Told whenever the snow map shown changes (another product, date, or none). */
  onSnowChange: () => void = () => {};
  private snowShown = false;
  private snowGrid: { bytes: Uint8Array; mask: Uint8Array; width: number; height: number; extent: number[]; scale: ColorScale; name: string } | null = null;

  /** The snow map on screen as numbers, or null if none is shown. */
  snowSampler(): SnowSampler | null {
    const grid = this.snowGrid;
    if (!grid) return null;
    const { bytes, mask, width, height, scale } = grid;
    const [minX, minY, maxX, maxY] = grid.extent;
    const first = scale.steps[0].start;
    const last = scale.steps[scale.steps.length - 1].start;
    return {
      name: grid.name,
      unit: scale.unit,
      shown: this.snowShown,
      at: (lng, lat) => {
        const x = (lng * Math.PI * R) / 180;
        const y = Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360)) * R;
        const column = Math.floor(((x - minX) / (maxX - minX)) * width);
        const row = Math.floor(((maxY - y) / (maxY - minY)) * height);
        if (column < 0 || row < 0 || column >= width || row >= height || mask[row * width + column] === 0) return null;
        const value = first + (bytes[row * width + column] / 255) * (last - first);
        let step = scale.steps[0];
        for (const candidate of scale.steps) if (value >= candidate.start - 1e-6) step = candidate;
        return { value, colour: step.color };
      },
    };
  }

  async setSnowMap(product: SnowProduct | null, date?: string, opacity = 0.75): Promise<void> {
    const token = ++this.snowToken;
    // The last map's values stay available (for a route profile coloured by them) until another one loads.
    this.snowShown = false;
    this.onSnowChange();
    this.removeLayerAndSource('slf-snow');
    if (this.snowUrl) URL.revokeObjectURL(this.snowUrl);
    this.snowUrl = null;
    this.onLegend('snow', null);
    if (!product) return;

    const spec = SNOW_PRODUCTS[product];
    const day = date || (spec.supportsCurrent ? 'current' : new Date().toISOString().slice(0, 10));
    try {
      const [scale, response] = await Promise.all([
        fetch(`${spec.host}/colorscale`).then((r) => r.json() as Promise<ColorScale>),
        fetch(`${spec.host}/${spec.code}/${day}/encoded`),
      ]);
      if (!response.ok) {
        const info = await response.json().catch(() => ({}));
        const reason = info.code === 'OUT_OF_SEASON' ? 'out of season' : info.code === 'NO_DATA' ? 'no data for this date' : `HTTP ${response.status}`;
        throw new Error(`${spec.name}: ${reason}`);
      }
      const extent = JSON.parse(response.headers.get('ch.slf.snow-maps.extent') ?? 'null') as number[] | null;
      if (!extent) throw new Error(`${spec.name}: missing extent header`);
      const validAt = response.headers.get('ch.slf.snow-maps.valid-at') ?? undefined;
      const { blob, bytes, mask, width, height } = await this.colorize(await response.blob(), scale);
      if (token !== this.snowToken) return;
      this.snowGrid = { bytes, mask, width, height, extent, scale, name: spec.name };
      this.snowShown = true;
      this.onSnowChange();

      const [minX, minY, maxX, maxY] = extent;
      this.snowUrl = URL.createObjectURL(blob);
      this.map.addSource('slf-snow', {
        type: 'image',
        url: this.snowUrl,
        coordinates: [mercToLngLat(minX, maxY), mercToLngLat(maxX, maxY), mercToLngLat(maxX, minY), mercToLngLat(minX, minY)],
      });
      (this.map.getSource('slf-snow') as ImageSource & { attribution?: string }).attribution = SLF_ATTRIBUTION;
      this.map.addLayer(
        { id: 'slf-snow', type: 'raster', source: 'slf-snow', paint: { 'raster-opacity': opacity, 'raster-fade-duration': 0 } },
        SLOT.overlay,
      );
      this.onLegend('snow', {
        title: spec.name,
        subtitle: validAt ? `valid ${fmtTime(validAt)}` : undefined,
        unit: scale.unit,
        entries: scale.steps.map((s, i) => ({
          color: s.color,
          label: i + 1 < scale.steps.length ? `${s.start}–${scale.steps[i + 1].start}` : `> ${s.start}`,
        })),
      });
    } catch (err) {
      if (token === this.snowToken) this.onError((err as Error).message);
    }
  }

  setSnowOpacity(opacity: number): void {
    if (this.map.getLayer('slf-snow')) this.map.setPaintProperty('slf-snow', 'raster-opacity', opacity);
  }

  /**
   * SLF snow maps are data images, not pictures: red = value scaled linearly between the
   * first and last step of the colour scale, blue = data mask / coverage.
   */
  private async colorize(encoded: Blob, scale: ColorScale): Promise<{ blob: Blob; bytes: Uint8Array; mask: Uint8Array; width: number; height: number }> {
    const bitmap = await createImageBitmap(encoded, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
    ctx.drawImage(bitmap, 0, 0);
    const image = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    const px = image.data;

    const first = scale.steps[0].start;
    const last = scale.steps[scale.steps.length - 1].start;
    const isDepth = scale.unit === 'cm';
    // 256-entry lookup: encoded byte → RGB of its class
    const lut = new Uint8Array(256 * 3);
    for (let byte = 0; byte < 256; byte++) {
      const value = first + (byte / 255) * (last - first);
      let step = scale.steps[0];
      for (const s of scale.steps) if (value >= s.start - 1e-6) step = s;
      lut.set(hexToRgb(step.color), byte * 3);
    }
    // The raw values are kept too, for reading the map at single points.
    const bytes = new Uint8Array(px.length / 4);
    const coverage = new Uint8Array(px.length / 4);
    for (let i = 0; i < px.length; i += 4) {
      const byte = px[i];
      const mask = px[i + 2];
      bytes[i / 4] = byte;
      coverage[i / 4] = mask;
      const empty = mask === 0 || (isDepth && byte === 0); // 0 cm stays transparent
      px[i] = lut[byte * 3];
      px[i + 1] = lut[byte * 3 + 1];
      px[i + 2] = lut[byte * 3 + 2];
      px[i + 3] = empty ? 0 : mask;
    }
    ctx.putImageData(image, 0, 0);
    return { blob: await canvas.convertToBlob({ type: 'image/png' }), bytes, mask: coverage, width: bitmap.width, height: bitmap.height };
  }

  // ───────────── Avalanche bulletin ─────────────

  /** Told whenever the bulletin shown changes (loaded or switched off). */
  onBulletinChange: () => void = () => {};
  private bulletinRegions: BulletinRegion[] | null = null;

  /** The bulletin on screen as a lookup by position, or null if it is not shown. */
  dangerSampler(): DangerSampler | null {
    const regions = this.bulletinRegions;
    if (!regions) return null;
    let last: (typeof regions)[number] | null = null; // neighbouring samples are usually in the same region
    const inside = regionHolds;
    return {
      at: (lng, lat) => {
        const region = last && inside(last, lng, lat) ? last : (regions.find((r) => inside(r, lng, lat)) ?? null);
        if (!region) return null;
        last = region;
        const p = region.properties;
        const rating = (p.dangerRatings ?? [])[0];
        const danger = DANGER[rating?.mainValue];
        if (!danger) return null;
        // Altitude ranges the avalanche problems are described for ("above 2200 m").
        const bands = ((p.avalancheProblems ?? []) as any[])
          .map((a) => ({ from: Number(a.elevation?.lowerBound), to: Number(a.elevation?.upperBound) }))
          .map((b) => ({ from: Number.isFinite(b.from) ? b.from : -Infinity, to: Number.isFinite(b.to) ? b.to : Infinity }))
          .filter((b) => Number.isFinite(b.from) || Number.isFinite(b.to));
        const main = ((p.avalancheProblems ?? []) as any[])[0];
        const sectors = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
        const listed = ((main?.aspects ?? []) as string[]).reduce((bits, name) => bits | (sectors.includes(name) ? 1 << sectors.indexOf(name) : 0), 0);
        const lower = Number(main?.elevation?.lowerBound);
        const core = { aspects: listed || 255, above: Number.isFinite(lower) ? lower : -1 };
        return { level: danger.level, name: pretty(rating.mainValue), colour: danger.color, region: (p.regions ?? []).map((r: any) => r.name).join(', '), bands, core };
      },
    };
  }

  /**
   * The bulletin for the region a point lies in, as the HTML the bulletin popup shows, or null
   * outside the bulletin's area. Loads the bulletin if it is not on the map.
   */
  async bulletinAt(lng: number, lat: number): Promise<string | null> {
    if (!this.bulletinRegions) {
      this.bulletinLoad ??= fetch('https://aws.slf.ch/api/bulletin/caaml/en/geojson')
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((data) => {
          this.bulletinRegions ??= regionsOf(data);
          this.onBulletinChange();
        })
        .finally(() => (this.bulletinLoad = null));
      await this.bulletinLoad;
    }
    const region = (this.bulletinRegions ?? []).find((r) => regionHolds(r, lng, lat));
    return region ? this.bulletinHtml(region.properties) : null;
  }
  private bulletinLoad: Promise<void> | null = null;

  private stationLists = new Map<StationType, { fetched: number; features: any[] }>();

  /** The nearest stations measuring something (snow depth, new snow…), nearest first; empty if none within `reach` km. */
  async nearestStations(type: StationType, lng: number, lat: number, count: number, reach = 40): Promise<{ name: string; elevation: number; value: number; km: number; time: string }[]> {
    let list = this.stationLists.get(type);
    if (!list || Date.now() - list.fetched > 30 * 60000) {
      const data = await fetch(`https://public-meas-data-v2.slf.ch/public/station-data/timepoint/${type}/current/geojson`).then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))));
      list = { fetched: Date.now(), features: (data.features as any[]).filter((f) => f.properties?.value !== null && f.properties?.value !== undefined) };
      this.stationLists.set(type, list);
    }
    const scale = Math.cos((lat * Math.PI) / 180);
    return list.features
      .map((f) => {
        const [x, y] = f.geometry.coordinates;
        return { name: String(f.properties.label), elevation: Number(f.properties.elevation), value: Number(f.properties.value), km: Math.hypot((x - lng) * scale, y - lat) * 111.32, time: String(f.properties.timestamp) };
      })
      .filter((station) => station.km <= reach)
      .sort((a, b) => a.km - b.km)
      .slice(0, count);
  }

  async setBulletin(on: boolean, opacity = 0.45): Promise<void> {
    this.removeLayerAndSource('slf-bulletin', ['slf-bulletin-line']);
    // The regions stay available after the layer is switched off (for a route profile coloured by them).
    this.onLegend('bulletin', null);
    if (!on) return;
    try {
      const data = await fetch('https://aws.slf.ch/api/bulletin/caaml/en/geojson').then((r) => {
        if (!r.ok) throw new Error(`Avalanche bulletin: HTTP ${r.status}`);
        return r.json();
      });
      if (this.map.getSource('slf-bulletin')) return;
      this.bulletinRegions = regionsOf(data);
      this.onBulletinChange();
      const withRating = data.features.find((f: any) => f.properties?.validTime);
      this.map.addSource('slf-bulletin', { type: 'geojson', data, attribution: `${SLF_ATTRIBUTION} avalanche bulletin (CC BY 4.0)` });
      this.map.addLayer(
        {
          id: 'slf-bulletin',
          type: 'fill',
          source: 'slf-bulletin',
          paint: { 'fill-color': ['coalesce', ['get', 'fill'], 'rgba(0,0,0,0)'], 'fill-opacity': opacity },
        },
        SLOT.top,
      );
      this.map.addLayer(
        { id: 'slf-bulletin-line', type: 'line', source: 'slf-bulletin', paint: { 'line-color': '#333', 'line-width': 0.7, 'line-opacity': 0.6 } },
        SLOT.top,
      );
      this.bindPopup('slf-bulletin', (f) => this.bulletinHtml(parseProps(f)));
      const valid = withRating?.properties.validTime;
      this.onLegend('bulletin', {
        title: 'Avalanche danger',
        subtitle: valid ? `valid until ${fmtTime(valid.endTime)}` : 'no bulletin currently',
        entries: Object.entries(DANGER).map(([name, d]) => ({ color: d.color, label: `${d.level} ${pretty(name)}` })),
      });
    } catch (err) {
      this.onError((err as Error).message);
    }
  }

  setBulletinOpacity(opacity: number): void {
    if (this.map.getLayer('slf-bulletin')) this.map.setPaintProperty('slf-bulletin', 'fill-opacity', opacity);
  }

  private bulletinHtml(p: Record<string, any>): string {
    const region = (p.regions ?? []).map((r: any) => r.name).join(', ');
    const regionId = p.regions?.[0]?.regionID as string | undefined;
    const ratings = (p.dangerRatings ?? []) as any[];
    const ratingHtml = ratings.length
      ? ratings
          .map((r) => {
            const d = DANGER[r.mainValue];
            const sub = SUBDIVISION[r.customData?.CH?.subdivision] ?? '';
            const period = r.validTimePeriod && r.validTimePeriod !== 'all_day' ? ` (${pretty(r.validTimePeriod)})` : '';
            return `<span class="danger-chip" style="background:${d?.color ?? '#ccc'}">${d?.level ?? '?'}${sub} ${escapeHtml(pretty(r.mainValue))}${period}</span>`;
          })
          .join(' ')
      : '<i>No danger rating issued</i>';
    const problems = ((p.avalancheProblems ?? []) as any[])
      .map((a) => {
        const elevation = a.elevation
          ? [a.elevation.lowerBound && `above ${escapeHtml(a.elevation.lowerBound)} m`, a.elevation.upperBound && `below ${escapeHtml(a.elevation.upperBound)} m`]
              .filter(Boolean)
              .join(', ')
          : '';
        const aspects = (a.aspects ?? []).length === 8 ? 'all aspects' : (a.aspects ?? []).join(' ');
        const meta = [aspects, elevation].filter(Boolean).join(' · ');
        return `<div class="problem"><b>${escapeHtml(pretty(a.problemType))}</b>${meta ? ` <span class="muted">${escapeHtml(meta)}</span>` : ''}<div>${richText(a.comment)}</div></div>`;
      })
      .join('');
    const valid = p.validTime ? `<div class="muted">${fmtTime(p.validTime.startTime)} → ${fmtTime(p.validTime.endTime)}</div>` : '';

    // Danger level for the coming days, as small numbered chips.
    const today = new Date().toISOString().slice(0, 10);
    const evolution = ((p.customData?.CH?.dangerRatingEvolution ?? []) as any[])
      .filter((e) => e.date >= today)
      .sort((a, b) => String(a.date).localeCompare(String(b.date)))
      .map((e) => {
        const d = DANGER[e.dangerRating?.mainValue];
        const day = new Date(`${e.date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short' });
        return `<span class="evolution-day" title="${escapeHtml(e.date)}: ${escapeHtml(pretty(e.dangerRating?.mainValue))}"><i style="background:${d?.color ?? '#ccc'}">${d?.level ?? '?'}</i>${escapeHtml(day)}</span>`;
      })
      .join('');
    const fold = (title: string, body: string) => (body ? `<details><summary>${title}</summary>${body}</details>` : '');
    const tendency = ((p.tendency ?? []) as any[]).map((t) => safeHtml(t.comment)).join('');
    const more =
      fold('Snowpack', safeHtml(p.snowpackStructure?.comment)) +
      fold('Weather forecast', safeHtml(p.weatherForecast?.comment)) +
      fold('Weather review', safeHtml(p.weatherReview?.comment)) +
      fold('Tendency', tendency);
    // White Risk (SLF's own app) opens its bulletin on a region given in the address, with all the
    // graphics; slf.ch has no such link and neither site can be shown inside another page.
    const whiteRisk = `${BULLETIN_LINKS.whiteRisk}${regionId ? `?regionId=${encodeURIComponent(regionId)}` : ''}`;
    const links =
      `<div class="popup-links"><a class="button" href="${whiteRisk}" target="_blank" rel="noopener">Show full bulletin</a>` +
      `<a href="${BULLETIN_LINKS.slf}" target="_blank" rel="noopener">SLF website</a></div>`;
    return (
      `<div class="popup"><h3>${escapeHtml(region)}</h3>${ratingHtml}${valid}` +
      (evolution ? `<div class="evolution">${evolution}</div>` : '') +
      `${problems}${more}${links}<div class="muted">Source: SLF avalanche bulletin</div></div>`
    );
  }

  // ───────────── Stations ─────────────

  async setStations(type: StationType | null): Promise<void> {
    this.removeLayerAndSource('slf-stations', ['slf-stations-label']);
    this.onLegend('stations', null);
    if (!type) return;
    const spec = STATION_TYPES[type];
    try {
      const base = 'https://public-meas-data-v2.slf.ch/public';
      const filter = type === 'WIND_MEAN' ? '?stationTypeFilter=WIND' : '';
      const [data, scale] = await Promise.all([
        fetch(`${base}/station-data/timepoint/${type}/current/geojson${filter}`).then((r) => {
          if (!r.ok) throw new Error(`SLF stations: HTTP ${r.status}`);
          return r.json();
        }),
        fetch(`${base}/map/colorscale/${type}`).then((r) => (r.ok ? (r.json() as Promise<ColorScale>) : null)).catch(() => null),
      ]);
      if (this.map.getSource('slf-stations')) return;
      this.stationUnit = scale?.unit ?? spec.unit;
      data.features = data.features.filter((f: any) => f.properties.value !== null);
      for (const f of data.features) f.properties.text = String(Math.round(f.properties.value));
      // Generate label images up front: adding them one by one on demand re-lays out the layer each time.
      for (const text of new Set<string>(data.features.map((f: any) => f.properties.text))) this.addLabelImage(`lbl:${text}`);
      this.map.addSource('slf-stations', { type: 'geojson', data, attribution: `${SLF_ATTRIBUTION} / MeteoSwiss stations` });
      this.map.addLayer(
        {
          id: 'slf-stations',
          type: 'circle',
          source: 'slf-stations',
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 6, 3, 10, 6, 14, 9],
            'circle-color': ['coalesce', ['get', 'fill'], '#999'],
            'circle-stroke-color': '#222',
            'circle-stroke-width': 1,
          },
        },
        SLOT.top,
      );
      this.map.addLayer(
        {
          id: 'slf-stations-label',
          type: 'symbol',
          source: 'slf-stations',
          minzoom: 8.5,
          layout: { 'icon-image': ['concat', 'lbl:', ['get', 'text']], 'icon-anchor': 'bottom', 'icon-offset': [0, -8], 'icon-padding': 1 },
        },
        SLOT.top,
      );
      this.bindPopup('slf-stations', (f) => {
        const p = parseProps(f);
        return `<div class="popup"><h3>${escapeHtml(p.label)}</h3><div class="big">${escapeHtml(p.value)} ${escapeHtml(this.stationUnit)}</div>
          <div>${escapeHtml(spec.name)} · ${escapeHtml(p.elevation)} m</div>
          <div class="muted">${escapeHtml(p.network)} ${escapeHtml(p.code)} · ${fmtTime(p.timestamp)}</div></div>`;
      });
      if (scale) {
        this.onLegend('stations', {
          title: `Stations: ${spec.name}`,
          unit: this.stationUnit,
          entries: scale.steps.map((s, i) => ({
            color: s.color,
            label: i + 1 < scale.steps.length ? `${s.start}–${scale.steps[i + 1].start}` : `> ${s.start}`,
          })),
        });
      }
    } catch (err) {
      this.onError((err as Error).message);
    }
  }

  private addLabelImage(id: string): void {
    if (this.map.hasImage(id)) return;
    const text = id.slice(4);
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const probe = document.createElement('canvas').getContext('2d')!;
    const font = `600 ${12 * ratio}px system-ui, sans-serif`;
    probe.font = font;
    const width = Math.ceil(probe.measureText(text).width + 8 * ratio);
    const height = Math.ceil(17 * ratio);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d')!;
    ctx.fillStyle = 'rgba(255,255,255,0.88)';
    ctx.beginPath();
    ctx.roundRect(0, 0, width, height, 4 * ratio);
    ctx.fill();
    ctx.font = font;
    ctx.fillStyle = '#111';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, width / 2, height / 2 + ratio);
    this.map.addImage(id, ctx.getImageData(0, 0, width, height), { pixelRatio: ratio });
  }

  // ───────────── Recent avalanches ─────────────

  async setAvalanches(on: boolean): Promise<void> {
    this.removeLayerAndSource('slf-avalanches');
    if (!on) return;
    try {
      const data = await fetch('https://whiterisk.ch/api/current-avalanches').then((r) => {
        if (!r.ok) throw new Error(`Recent avalanches: HTTP ${r.status}`);
        return r.json();
      });
      if (this.map.getSource('slf-avalanches')) return;
      this.map.addSource('slf-avalanches', { type: 'geojson', data, attribution: `${SLF_ATTRIBUTION} / White Risk` });
      this.map.addLayer(
        {
          id: 'slf-avalanches',
          type: 'circle',
          source: 'slf-avalanches',
          paint: {
            'circle-radius': ['match', ['get', 'avalancheSize'], 'ONE', 4, 'TWO', 6, 'THREE', 8, 'FOUR', 10, 'FIVE', 12, 5],
            'circle-color': ['coalesce', ['get', 'fill'], '#e31a1c'],
            'circle-stroke-color': '#fff',
            'circle-stroke-width': 1.5,
          },
        },
        SLOT.top,
      );
      this.bindPopup('slf-avalanches', (f) => {
        const p = parseProps(f);
        const rows = [
          ['Triggered', fmtTime(p.triggerDateTime)],
          ['Trigger', pretty(p.triggerType)],
          ['Type', pretty(p.avalancheType)],
          ['Size', pretty(p.avalancheSize)],
          ['Moisture', pretty(p.avalancheMoisture)],
          ['Start zone', [p.startZoneAspect, p.startZoneElevation && `${p.startZoneElevation} m`].filter(Boolean).join(', ')],
        ].filter(([, v]) => v);
        return `<div class="popup"><h3>Avalanche</h3><table>${rows.map(([k, v]) => `<tr><td class="muted">${k}</td><td>${escapeHtml(v)}</td></tr>`).join('')}</table></div>`;
      });
    } catch (err) {
      this.onError((err as Error).message);
    }
  }

  // ───────────── helpers ─────────────

  private bound = new Set<string>();

  private bindPopup(layerId: string, html: (feature: MapGeoJSONFeature) => string): void {
    if (this.bound.has(layerId)) return;
    this.bound.add(layerId);
    this.map.on('click', layerId, (e) => {
      const feature = e.features?.[0];
      if (!feature || interaction.drawing) return;
      // Points on top win over the bulletin polygon underneath.
      if (layerId === 'slf-bulletin') {
        const pointLayers = ['slf-stations', 'slf-avalanches', 'guru-routes'].filter((id) => this.map.getLayer(id));
        if (pointLayers.length && this.map.queryRenderedFeatures(e.point, { layers: pointLayers }).length) return;
      }
      this.popup.setLngLat(e.lngLat).setHTML(html(feature)).addTo(this.map);
    });
    this.map.on('mouseenter', layerId, () => (this.map.getCanvas().style.cursor = 'pointer'));
    this.map.on('mouseleave', layerId, () => (this.map.getCanvas().style.cursor = ''));
  }

  private removeLayerAndSource(id: string, extraLayers: string[] = []): void {
    for (const layerId of [...extraLayers, id]) if (this.map.getLayer(layerId)) this.map.removeLayer(layerId);
    if (this.map.getSource(id)) this.map.removeSource(id);
  }
}
