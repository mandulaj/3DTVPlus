// SAC route portal: route lines for every discipline, loaded for the area in view from the portal's
// own public map service, with links back to the portal. Content © Swiss Alpine Club SAC; full route
// descriptions stay on sac-cas.ch (where a membership login applies).
import type * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource } from 'maplibre-gl';
import { interaction } from '../interaction';
import { SLOT } from '../map';
import { toLv95, toWgs84 } from '../swissGrid';

const API = 'https://www.suissealpine.sac-cas.ch/api/1';
const PORTAL = 'https://www.sac-cas.ch/en/huts-and-tours/sac-route-portal';
const ATTRIBUTION = '© <a href="https://www.sac-cas.ch/en/huts-and-tours/sac-route-portal/" target="_blank">SAC route portal</a>';

/** Colours as on the SAC portal map. */
export const SAC_DISCIPLINES = {
  mountain_hiking: { name: 'Hiking', colour: '#237100' },
  alpine_tour: { name: 'Mountaineering', colour: '#9b40de' },
  climbing: { name: 'Climbing', colour: '#ff3d12' },
  via_ferrata: { name: 'Via ferrata', colour: '#ff8800' },
  ski_tour: { name: 'Ski touring', colour: '#0033ff' },
  snowshoe_tour: { name: 'Snowshoe', colour: '#008a79' },
} as const;
export type SacDiscipline = keyof typeof SAC_DISCIPLINES;

const SOURCE = 'sac-routes';
const POINTS = 'sac-climbing';
const LINE_LAYERS = ['sac-routes-casing', 'sac-routes-plain', 'sac-routes-dashed'];
const MIN_ZOOM = 10;
const CELL = 16000; // metres (LV95): one request per cell
const MAX_CELLS_PER_VIEW = 9;
const MAX_CACHED_CELLS = 40;

const escapeHtml = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const text = (value: unknown): string => (value && typeof value === 'object' ? String(Object.values(value)[0] ?? '') : String(value ?? ''));

interface Cell {
  lines: GeoJSON.Feature[];
  points: GeoJSON.Feature[];
}

export class SacRoutes {
  onError: (message: string) => void = () => {};
  /** Told when routes cannot be shown at the current zoom ("zoom in"), or can again (null). */
  onHint: (hint: string | null) => void = () => {};
  readonly enabled = new Set<SacDiscipline>();
  private cells = new Map<string, Cell | Promise<Cell>>();
  private bound = false;
  private timer: number | undefined;
  private request = 0;
  private drawn: GeoJSON.Feature[] = [];

  constructor(
    private map: maplibregl.Map,
    private popup: maplibregl.Popup,
  ) {
    map.on('moveend', () => this.schedule());
  }

  setDiscipline(discipline: SacDiscipline, on: boolean): void {
    if (on) this.enabled.add(discipline);
    else this.enabled.delete(discipline);
    this.applyFilter();
    this.schedule(0);
  }

  setDisciplines(disciplines: SacDiscipline[]): void {
    this.enabled.clear();
    for (const d of disciplines) if (d in SAC_DISCIPLINES) this.enabled.add(d);
    this.applyFilter();
    this.schedule(0);
  }

  /** Lines of the enabled disciplines currently on the map, for routing along them. Changes identity when the set changes. */
  routable(): [number, number][][] {
    const key = `${this.request}:${[...this.enabled].join()}`;
    if (key !== this.routableKey) {
      this.routableKey = key;
      this.routableLines = this.drawn
        .filter((f) => this.enabled.has(f.properties?.type) && f.geometry.type === 'LineString')
        .map((f) => (f.geometry as GeoJSON.LineString).coordinates as [number, number][]);
    }
    return this.routableLines;
  }
  private routableKey = '';
  private routableLines: [number, number][][] = [];

  private schedule(delay = 250): void {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.refresh(), delay);
  }

  private ensureLayers(): void {
    if (this.map.getSource(SOURCE)) return;
    const empty: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
    this.map.addSource(SOURCE, { type: 'geojson', data: empty, attribution: ATTRIBUTION });
    this.map.addSource(POINTS, { type: 'geojson', data: empty });
    const colour = ['match', ['get', 'type'], ...Object.entries(SAC_DISCIPLINES).flatMap(([id, d]) => [id, d.colour]), '#777777'] as never;
    const width = ['interpolate', ['linear'], ['zoom'], 10, 1.5, 14, 3.5] as never;
    const line = { type: 'line' as const, source: SOURCE, minzoom: MIN_ZOOM, layout: { 'line-cap': 'round' as const, 'line-join': 'round' as const } };
    this.map.addLayer({ ...line, id: LINE_LAYERS[0], paint: { 'line-color': '#ffffff', 'line-opacity': 0.75, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 3, 14, 6.5] } }, SLOT.top);
    // Variants of a route are drawn lighter than its main line.
    const opacity = ['case', ['get', 'alternative'], 0.6, 1] as never;
    this.map.addLayer({ ...line, id: LINE_LAYERS[1], paint: { 'line-color': colour, 'line-width': width, 'line-opacity': opacity } }, SLOT.top);
    this.map.addLayer({ ...line, id: LINE_LAYERS[2], layout: { 'line-join': 'round' }, paint: { 'line-color': colour, 'line-width': width, 'line-opacity': opacity, 'line-dasharray': [2, 2] } }, SLOT.top);
    this.map.addLayer(
      {
        id: POINTS,
        type: 'circle',
        source: POINTS,
        minzoom: MIN_ZOOM,
        paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 4, 14, 7], 'circle-color': SAC_DISCIPLINES.climbing.colour, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5 },
      },
      SLOT.top,
    );
    this.applyFilter();
    this.bind();
  }

  private applyFilter(): void {
    if (!this.map.getLayer(LINE_LAYERS[0])) return;
    const wanted = ['in', ['get', 'type'], ['literal', [...this.enabled]]];
    const dashed = ['in', ['get', 'style'], ['literal', ['dashed', 'dotted']]];
    this.map.setFilter(LINE_LAYERS[0], wanted as never);
    this.map.setFilter(LINE_LAYERS[1], ['all', wanted, ['!', dashed]] as never);
    this.map.setFilter(LINE_LAYERS[2], ['all', wanted, dashed] as never);
    this.map.setLayoutProperty(POINTS, 'visibility', this.enabled.has('climbing') ? 'visible' : 'none');
  }

  private async refresh(): Promise<void> {
    if (!this.enabled.size) {
      this.onHint(null);
      (this.map.getSource(SOURCE) as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: [] });
      (this.map.getSource(POINTS) as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: [] });
      return;
    }
    this.ensureLayers();
    if (this.map.getZoom() < MIN_ZOOM) {
      this.onHint('Zoom in to see SAC routes.');
      return;
    }
    const bounds = this.map.getBounds();
    const corners = [bounds.getSouthWest(), bounds.getNorthEast(), bounds.getNorthWest(), bounds.getSouthEast()].map((c) => toLv95(c.lng, c.lat));
    const x0 = Math.floor(Math.min(...corners.map((c) => c[0])) / CELL);
    const x1 = Math.floor(Math.max(...corners.map((c) => c[0])) / CELL);
    const y0 = Math.floor(Math.min(...corners.map((c) => c[1])) / CELL);
    const y1 = Math.floor(Math.max(...corners.map((c) => c[1])) / CELL);
    // Steep views see far: load the cells nearest the map centre first, up to a limit.
    const centre = toLv95(this.map.getCenter().lng, this.map.getCenter().lat);
    const wanted: [number, number][] = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) wanted.push([x, y]);
    wanted.sort((a, b) => Math.hypot((a[0] + 0.5) * CELL - centre[0], (a[1] + 0.5) * CELL - centre[1]) - Math.hypot((b[0] + 0.5) * CELL - centre[0], (b[1] + 0.5) * CELL - centre[1]));
    const view = wanted.slice(0, MAX_CELLS_PER_VIEW);
    this.onHint(wanted.length > view.length ? 'SAC routes shown near the map centre only: zoom in for the rest.' : null);

    const token = ++this.request;
    const loaded = await Promise.all(view.map(([x, y]) => this.cell(x, y).catch(() => null)));
    if (token !== this.request) return;
    if (loaded.some((c) => c === null)) this.onError('Some SAC routes could not be loaded.');
    const seen = new Set<string | number>();
    const unique = (features: GeoJSON.Feature[]) => features.filter((f) => (seen.has(f.id!) ? false : (seen.add(f.id!), true)));
    const cells = loaded.filter((c): c is Cell => c !== null);
    this.drawn = unique(cells.flatMap((c) => c.lines));
    (this.map.getSource(SOURCE) as GeoJSONSource).setData({ type: 'FeatureCollection', features: this.drawn });
    (this.map.getSource(POINTS) as GeoJSONSource).setData({ type: 'FeatureCollection', features: unique(cells.flatMap((c) => c.points)) });
  }

  private cell(x: number, y: number): Promise<Cell> {
    const key = `${x}/${y}`;
    const hit = this.cells.get(key);
    if (hit) {
      this.cells.delete(key); // most recently used last
      this.cells.set(key, hit);
      return Promise.resolve(hit);
    }
    const bbox = [x * CELL, y * CELL, (x + 1) * CELL, (y + 1) * CELL].join(',');
    const get = (path: string) =>
      fetch(`${API}/${path}/layer?bbox=${bbox}`).then((r) => {
        if (!r.ok) throw new Error(`SAC ${r.status}`);
        return r.json() as Promise<GeoJSON.FeatureCollection>;
      });
    const convert = (coordinates: unknown): unknown =>
      typeof (coordinates as number[])[0] === 'number' ? toWgs84((coordinates as number[])[0], (coordinates as number[])[1]) : (coordinates as unknown[]).map(convert);
    const promise = Promise.all([get('route'), get('poi')]).then(([routes, pois]): Cell => {
      const cell: Cell = {
        lines: routes.features.map((f) => ({ ...f, geometry: { ...f.geometry, coordinates: convert((f.geometry as GeoJSON.LineString).coordinates) } as GeoJSON.Geometry })),
        // Climbing is listed per crag or summit, not as lines.
        points: pois.features
          .filter((f) => Object.keys((f.properties?.routes_by_discipline as object) ?? {}).some((d) => d === 'climbing' || d === 'alpine_climbing'))
          .map((f) => ({
            ...f,
            geometry: { type: 'Point', coordinates: toWgs84(...((f.geometry as GeoJSON.Point).coordinates as [number, number])) },
            properties: { id: f.properties?.id, kind: f.properties?.type },
          })),
      };
      this.cells.set(key, cell);
      return cell;
    });
    promise.catch(() => this.cells.delete(key));
    this.cells.set(key, promise);
    if (this.cells.size > MAX_CACHED_CELLS) this.cells.delete(this.cells.keys().next().value!);
    return promise;
  }

  private bind(): void {
    if (this.bound) return;
    this.bound = true;
    const hover = (on: boolean) => () => (this.map.getCanvas().style.cursor = on ? 'pointer' : '');
    for (const id of [LINE_LAYERS[0], POINTS]) {
      this.map.on('mouseenter', id, hover(true));
      this.map.on('mouseleave', id, hover(false));
    }

    this.map.on('click', async (event) => {
      if (!this.enabled.size || !this.map.getLayer(LINE_LAYERS[0]) || interaction.drawing) return;
      const { x, y } = event.point;
      const hits = this.map.queryRenderedFeatures([[x - 6, y - 6], [x + 6, y + 6]], { layers: [LINE_LAYERS[0], POINTS] });
      if (!hits.length) return;
      const point = hits.find((f) => f.layer.id === POINTS);
      if (point) return this.showPoi(event.lngLat, Number(point.properties.id));
      const ids = [...new Set(hits.map((f) => Number(f.properties.route_id)))].slice(0, 8);
      this.popup.setLngLat(event.lngLat).setHTML('<div class="popup muted">Loading route…</div>').addTo(this.map);
      try {
        const data = await fetch(`${API}/route/search?lang=en&output_lang=en&id=${ids.join(',')}`).then((r) => r.json());
        const rows = ((data.results ?? []) as any[]).map((route) => {
          const discipline = SAC_DISCIPLINES[route.type as SacDiscipline];
          const destination = [text(route.destination_poi?.display_name), route.destination_poi?.altitude && `${Math.round(route.destination_poi.altitude)} m`].filter(Boolean).join(', ');
          const link = `${PORTAL}/${route.destination_poi?.id}/${route.type}/${route.id}`;
          return (
            `<div class="problem"><span class="danger-chip" style="background:${discipline?.colour ?? '#777'};color:#fff">${escapeHtml(discipline?.name ?? route.type)}</span>` +
            (route.main_difficulty ? ` <b>${escapeHtml(route.main_difficulty)}</b>` : '') +
            `<div><b style="text-transform:none">${escapeHtml(destination)}</b></div><div>${escapeHtml(text(route.title))}</div>` +
            `<a href="${escapeHtml(link)}" target="_blank" rel="noopener">Open in SAC route portal</a></div>`
          );
        });
        this.popup.setHTML(`<div class="popup"><h3>SAC route${rows.length > 1 ? 's' : ''}</h3>${rows.join('') || '<i>No details available</i>'}<div class="muted">Source: SAC route portal</div></div>`);
      } catch {
        this.popup.setHTML('<div class="popup">Route details could not be loaded.</div>');
      }
    });
  }

  private async showPoi(lngLat: maplibregl.LngLat, id: number): Promise<void> {
    const link = `${PORTAL}/${id}/`;
    const body = (name: string) =>
      `<div class="popup"><h3>${escapeHtml(name)}</h3><span class="danger-chip" style="background:${SAC_DISCIPLINES.climbing.colour};color:#fff">Climbing</span>` +
      `<div class="popup-links"><a href="${link}" target="_blank" rel="noopener">Open in SAC route portal</a></div><div class="muted">Source: SAC route portal</div></div>`;
    this.popup.setLngLat(lngLat).setHTML(body('Climbing area')).addTo(this.map);
    try {
      const data = await fetch(`${API}/poi/search?lang=en&output_lang=en&id=${id}`).then((r) => r.json());
      const poi = data.results?.[0];
      if (poi) this.popup.setHTML(body([text(poi.display_name), poi.altitude && `${Math.round(poi.altitude)} m`].filter(Boolean).join(', ')));
    } catch {
      /* the link alone is enough */
    }
  }
}
