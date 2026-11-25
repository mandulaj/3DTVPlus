// Weather forecast on the map: for towns and summits in view, the day's weather symbol, lowest and
// highest temperature and the wind, with a row of days to choose from.
//
// Data: Open-Meteo, which serves national weather models without a key; inside Switzerland and
// nearby the short range comes from MeteoSwiss's ICON model. This is model output for a point (for
// summits, adjusted to the summit's height), not the edited forecast MeteoSwiss publishes itself.
import * as maplibregl from 'maplibre-gl';
import { vectorLayers } from './map';
import { h, toast } from './ui/dom';

const API = 'https://api.open-meteo.com/v1/forecast';
const DAILY = 'weather_code,temperature_2m_min,temperature_2m_max,wind_speed_10m_max,wind_gusts_10m_max,wind_direction_10m_dominant,precipitation_sum,snowfall_sum';
const DAYS = 8;
const SOURCE = 'water'; // OpenFreeMap vector tiles (map.ts): place names and peaks
const PROBES = ['weather-places', 'weather-peaks']; // invisible layers that keep those names loaded
const MAX_PLACES = 9;
const MAX_PEAKS = 6;
const SPACING = 150; // px between forecast points
const CACHE_MINUTES = 30;

interface Spot {
  key: string;
  name: string;
  at: [number, number];
  /** Summit height in metres; undefined for towns (the model's own ground height is used). */
  ele?: number;
}

interface Forecast {
  fetched: number;
  days: string[];
  code: number[];
  min: number[];
  max: number[];
  wind: number[];
  gusts: number[];
  direction: number[];
  rain: number[];
  snow: number[];
}

/** WMO weather code → symbol and words. */
function symbol(code: number): [string, string] {
  if (code === 0) return ['☀️', 'clear'];
  if (code === 1) return ['🌤️', 'mostly clear'];
  if (code === 2) return ['⛅', 'partly cloudy'];
  if (code === 3) return ['☁️', 'overcast'];
  if (code === 45 || code === 48) return ['☁️', 'fog']; // the fog symbol is missing from common fonts
  if (code >= 51 && code <= 57) return ['🌦️', 'drizzle'];
  if (code >= 61 && code <= 67) return ['🌧️', 'rain'];
  if (code >= 71 && code <= 77) return ['🌨️', 'snow'];
  if (code >= 80 && code <= 82) return ['🌦️', 'showers'];
  if (code === 85 || code === 86) return ['🌨️', 'snow showers'];
  if (code >= 95) return ['⛈️', 'thunderstorm'];
  return ['❔', 'unknown'];
}

const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

const METEOSWISS = 'https://www.meteoswiss.admin.ch';
// MeteoSwiss's English pages use English names for these; all others use the local name.
const EXONYMS: Record<string, string> = { zuerich: 'zurich', geneve: 'geneva', luzern: 'lucerne' };

/**
 * Opens MeteoSwiss's local forecast for the place at a point, in a new tab. Its pages are addressed
 * by place name and postcode, which the official register of localities (geo.admin.ch) gives for
 * any point in Switzerland; a summit gets the forecast page of the locality it stands in.
 */
async function openMeteoSwiss(at: [number, number]): Promise<void> {
  // The tab must be opened while the click is being handled, or the browser blocks it.
  const tab = window.open('', '_blank');
  let address = `${METEOSWISS}/`;
  try {
    const query = new URLSearchParams({
      geometryType: 'esriGeometryPoint',
      geometry: `${at[0]},${at[1]}`,
      sr: '4326',
      imageDisplay: '100,100,96',
      mapExtent: `${at[0] - 0.01},${at[1] - 0.01},${at[0] + 0.01},${at[1] + 0.01}`,
      layers: 'all:ch.swisstopo-vd.ortschaftenverzeichnis_plz',
      tolerance: '0',
      returnGeometry: 'false',
    });
    const data = await (await fetch(`https://api3.geo.admin.ch/rest/services/all/MapServer/identify?${query}`)).json();
    const place = data.results?.[0]?.attributes;
    if (place?.plz && place.langtext) {
      const plain = String(place.langtext)
        .toLowerCase()
        .replace(/ä/g, 'ae')
        .replace(/ö/g, 'oe')
        .replace(/ü/g, 'ue')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '') // other accents
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '');
      address = `${METEOSWISS}/local-forecasts/${EXONYMS[plain] ?? plain}/${place.plz}.html`;
    }
  } catch {
    /* outside Switzerland or lookup unavailable: MeteoSwiss's front page */
  }
  if (tab) tab.location.href = address;
  else window.open(address, '_blank');
}

export class Weather {
  enabled = false;
  day = 0;
  onChange: () => void = () => {};
  private bar = h('div', { class: 'weather-days', hidden: true });
  private cache = new Map<string, Forecast>();
  private markers = new Map<string, maplibregl.Marker>();
  private timer: number | undefined;
  private request = 0;

  constructor(private map: maplibregl.Map) {
    document.body.append(this.bar);
    map.on('moveend', () => this.schedule());
    map.on('sourcedata', (event) => {
      if (this.enabled && event.sourceId === SOURCE && event.isSourceLoaded) this.schedule();
    });
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (on && !this.map.getLayer(PROBES[0])) {
      const probe = { type: 'circle' as const, source: SOURCE, paint: { 'circle-radius': 1, 'circle-opacity': 0 } };
      this.map.addLayer({ ...probe, id: PROBES[0], 'source-layer': vectorLayers.place });
      this.map.addLayer({ ...probe, id: PROBES[1], 'source-layer': vectorLayers.peak });
    }
    for (const id of PROBES) if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
    this.bar.hidden = !on;
    document.body.classList.toggle('weather-on', on);
    if (on) this.schedule(0);
    else {
      for (const marker of this.markers.values()) marker.remove();
      this.markers.clear();
    }
  }

  private schedule(delay = 500): void {
    if (!this.enabled) return;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.update(), delay);
  }

  /** Towns and summits in view, the more important first, spread out so their labels do not collide. */
  private spots(): Spot[] {
    const map = this.map;
    const { clientWidth: width, clientHeight: height } = map.getCanvas();
    const candidates: (Spot & { weight: number; x: number; y: number; peak: boolean })[] = [];
    const seen = new Set<string>();
    const add = (feature: maplibregl.GeoJSONFeature, peak: boolean) => {
      const p = feature.properties ?? {};
      const name = p['name:latin'] ?? p.name;
      if (!name || feature.geometry.type !== 'Point' || seen.has(name)) return;
      const at = feature.geometry.coordinates as [number, number];
      const { x, y } = map.project(at);
      if (x < 60 || y < 90 || x > width - 60 || y > height - 60) return;
      const ele = Number(p.ele);
      if (peak && !Number.isFinite(ele)) return;
      // Places: OpenStreetMap's own ranking (lower = more important), cities before villages.
      const order = { city: 0, town: 1, village: 2 }[(p.class ?? p.kind) as string]; // `kind` and `population`: the second tile service
      if (!peak && order === undefined) return;
      seen.add(name);
      candidates.push({ key: `${at[0].toFixed(2)},${at[1].toFixed(2)},${peak ? Math.round(ele) : ''}`, name, at, ele: peak ? ele : undefined, peak, x, y, weight: peak ? -ele : order! * 100 + Number(p.rank ?? (p.population ? 50 - 5 * Math.log10(Number(p.population) + 1) : 50)) });
    };
    try {
      for (const f of map.querySourceFeatures(SOURCE, { sourceLayer: vectorLayers.place })) add(f, false);
      for (const f of map.querySourceFeatures(SOURCE, { sourceLayer: vectorLayers.peak })) add(f, true);
    } catch {
      return [];
    }
    const kept: typeof candidates = [];
    const take = (peak: boolean, most: number) => {
      let taken = 0;
      for (const c of candidates.filter((c) => c.peak === peak).sort((a, b) => a.weight - b.weight)) {
        if (taken >= most) break;
        if (kept.some((k) => Math.abs(k.x - c.x) < SPACING && Math.abs(k.y - c.y) < 56)) continue;
        kept.push(c);
        taken++;
      }
    };
    take(false, MAX_PLACES);
    take(true, MAX_PEAKS);
    return kept;
  }

  private async update(): Promise<void> {
    if (!this.enabled) return;
    const token = ++this.request;
    const spots = this.spots();
    const stale = (spot: Spot) => {
      const hit = this.cache.get(spot.key);
      return !hit || Date.now() - hit.fetched > CACHE_MINUTES * 60000;
    };
    // One request for the towns, one for the summits (those carry their own height).
    const groups = [spots.filter((s) => s.ele === undefined && stale(s)), spots.filter((s) => s.ele !== undefined && stale(s))];
    try {
      await Promise.all(
        groups.filter((g) => g.length).map(async (group) => {
          const query = new URLSearchParams({
            latitude: group.map((s) => s.at[1].toFixed(3)).join(','),
            longitude: group.map((s) => s.at[0].toFixed(3)).join(','),
            daily: DAILY,
            timezone: 'auto',
            forecast_days: String(DAYS),
          });
          if (group[0].ele !== undefined) query.set('elevation', group.map((s) => Math.round(s.ele!)).join(','));
          const response = await fetch(`${API}?${query}`);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const data = await response.json();
          (Array.isArray(data) ? data : [data]).forEach((entry: any, i: number) => {
            const d = entry.daily;
            this.cache.set(group[i].key, {
              fetched: Date.now(),
              days: d.time,
              code: d.weather_code,
              min: d.temperature_2m_min,
              max: d.temperature_2m_max,
              wind: d.wind_speed_10m_max,
              gusts: d.wind_gusts_10m_max,
              direction: d.wind_direction_10m_dominant,
              rain: d.precipitation_sum,
              snow: d.snowfall_sum,
            });
          });
        }),
      );
    } catch (error) {
      if (token === this.request) toast(`Weather forecast unavailable: ${(error as Error).message}`);
    }
    if (token !== this.request || !this.enabled) return;
    if (this.cache.size > 400) for (const key of [...this.cache.keys()].slice(0, 200)) this.cache.delete(key);

    const wanted = new Set(spots.map((s) => s.key));
    for (const [key, marker] of this.markers) {
      if (!wanted.has(key)) {
        marker.remove();
        this.markers.delete(key);
      }
    }
    for (const spot of spots) {
      const forecast = this.cache.get(spot.key);
      if (!forecast) continue;
      let marker = this.markers.get(spot.key);
      if (!marker) {
        const element = h('div', { class: `weather-spot${spot.ele !== undefined ? ' summit' : ''}` });
        element.addEventListener('click', (event) => {
          event.stopPropagation();
          void openMeteoSwiss(spot.at);
        });
        marker = new maplibregl.Marker({ element, anchor: 'bottom', opacityWhenCovered: '0.25' }).setLngLat(spot.at).addTo(this.map);
        this.markers.set(spot.key, marker);
      }
      this.fill(marker.getElement(), spot, forecast);
    }
    this.renderDays(spots.map((s) => this.cache.get(s.key)).find(Boolean));
  }

  private fill(element: HTMLElement, spot: Spot, f: Forecast): void {
    const i = Math.min(this.day, f.days.length - 1);
    const [icon, words] = symbol(f.code[i]);
    const arrow = h('span', { class: 'weather-arrow' }, '↑');
    arrow.style.transform = `rotate(${(f.direction[i] + 180) % 360}deg)`; // the arrow points where the wind blows to
    const from = COMPASS[Math.round(f.direction[i] / 45) % 8];
    const wet = f.snow[i] >= 0.5 ? `, ${f.snow[i].toFixed(0)} cm new snow` : f.rain[i] >= 0.5 ? `, ${f.rain[i].toFixed(0)} mm rain` : '';
    element.title = `Click for MeteoSwiss's forecast for this place.\n${spot.name}${spot.ele !== undefined ? ` (${Math.round(spot.ele)} m)` : ''}: ${words}, ${Math.round(f.min[i])}° to ${Math.round(f.max[i])}°, wind from ${from} up to ${Math.round(f.wind[i])} km/h, gusts ${Math.round(f.gusts[i])} km/h${wet}`;
    element.replaceChildren(
      h('span', { class: 'weather-icon' }, icon),
      h(
        'span',
        { class: 'weather-text' },
        h('b', {}, spot.name),
        h('span', { class: 'weather-values' }, h('i', {}, `${Math.round(f.min[i])}°`), h('i', {}, `${Math.round(f.max[i])}°`), h('span', { class: 'weather-wind' }, arrow, `${Math.round(f.wind[i])}`)),
      ),
    );
  }

  /** The row of days at the top. */
  private renderDays(sample: Forecast | undefined): void {
    if (!sample) return;
    this.bar.replaceChildren(
      ...sample.days.map((date, i) => {
        const day = new Date(`${date}T12:00:00`);
        const label = i === 0 ? 'Today' : day.toLocaleDateString(undefined, { weekday: 'long' });
        return h(
          'button',
          {
            type: 'button',
            class: i === this.day ? 'on' : '',
            title: day.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long' }),
            onclick: () => {
              this.day = i;
              this.onChange();
              void this.update();
            },
          },
          label,
        );
      }),
    );
  }
}
