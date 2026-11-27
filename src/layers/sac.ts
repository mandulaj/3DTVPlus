// SAC route portal: route lines for every discipline, loaded for the area in view from the portal's
// own public map service, with links back to the portal. Content © Swiss Alpine Club SAC; full route
// descriptions stay on sac-cas.ch (where a membership login applies).
import { previewRoute } from '../routePreview';
import type * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource } from 'maplibre-gl';
import { interaction } from '../interaction';
import { SLOT } from '../map';
import { toLv95, toWgs84 } from '../swissGrid';
import { describeStats, mainClimb, trackStats } from '../trackStats';
import { filtersClimb, filtersGrade, gradeRank, isActive, passes, type RouteFilter, type Scale } from './routeFilter';

const API = 'https://www.suissealpine.sac-cas.ch/api/1';
const PORTAL = 'https://www.sac-cas.ch/en/huts-and-tours/sac-route-portal';
const ATTRIBUTION = '© <a href="https://www.sac-cas.ch/en/huts-and-tours/sac-route-portal/" target="_blank">SAC route portal</a>';

/** Colours as on the SAC portal map. */
export const SAC_DISCIPLINES = {
  mountain_hiking: { name: 'Hiking', colour: '#237100', scale: 'hiking' },
  alpine_tour: { name: 'Mountaineering', colour: '#9b40de', scale: 'alpine' },
  climbing: { name: 'Climbing', colour: '#ff3d12', scale: null }, // crags, not lines: nothing to filter
  via_ferrata: { name: 'Via ferrata', colour: '#ff8800', scale: 'ferrata' },
  ski_tour: { name: 'Ski touring', colour: '#0033ff', scale: 'alpine' },
  snowshoe_tour: { name: 'Snowshoe', colour: '#008a79', scale: 'snowshoe' },
} as const satisfies Record<string, { name: string; colour: string; scale: Scale | null }>;
export type SacDiscipline = keyof typeof SAC_DISCIPLINES;

const SOURCE = 'sac-routes';
const POINTS = 'sac-climbing';
const HIGHLIGHT = 'sac-highlight';
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
  /** Per discipline: only routes within these limits are shown. */
  readonly filters = new Map<SacDiscipline, RouteFilter>();
  /** Looked up as filters need them: a route's grade (null: none given) and height gain. */
  private grades = new Map<number, string | null>();
  private climbs = new Map<number, number | null>();
  private hidden = new Set<number>();
  private filterRun = 0;

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

  /** Limits one discipline's routes to a range of grades and of height gain (null: no limit). */
  setFilter(discipline: SacDiscipline, filter: RouteFilter | null): void {
    if (isActive(filter ?? undefined)) this.filters.set(discipline, filter!);
    else this.filters.delete(discipline);
    void this.applyFilters();
  }

  /**
   * Works out which drawn routes the filters hide. Grades come from the SAC portal (one request
   * per 150 routes), height gain is measured along the line; both only for disciplines that are
   * filtered on them, and routes stay visible until their values are known.
   */
  private async applyFilters(): Promise<void> {
    const run = ++this.filterRun;
    const idOf = (f: GeoJSON.Feature) => Number(f.properties?.route_id);
    const filtered = this.drawn.filter((f) => f.geometry.type === 'LineString' && this.enabled.has(f.properties?.type) && this.filters.has(f.properties?.type));
    const update = () => {
      const hidden = new Set<number>();
      for (const f of filtered) {
        const id = idOf(f);
        const discipline = f.properties?.type as SacDiscipline;
        const scale = SAC_DISCIPLINES[discipline].scale;
        const grade = this.grades.get(id);
        const rank = grade === undefined ? undefined : scale ? gradeRank(scale, grade) : null;
        if (!passes(this.filters.get(discipline)!, rank, this.climbs.get(id))) hidden.add(id);
      }
      const changed = hidden.size !== this.hidden.size || [...hidden].some((id) => !this.hidden.has(id));
      this.hidden = hidden;
      if (changed) {
        this.filterVersion++;
        this.applyFilter();
      }
    };
    update();

    const needGrade = [...new Set(filtered.filter((f) => filtersGrade(this.filters.get(f.properties?.type)!) && !this.grades.has(idOf(f))).map(idOf))];
    for (let i = 0; i < needGrade.length; i += 150) {
      const ids = needGrade.slice(i, i + 150);
      try {
        const response = await fetch(`${API}/route/search?lang=en&output_lang=en&limit=200&id=${ids.join(',')}`, { signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        for (const route of (data.results ?? []) as { id: number; main_difficulty?: string }[]) this.grades.set(Number(route.id), route.main_difficulty ?? null);
        for (const id of ids) if (!this.grades.has(id)) this.grades.set(id, null);
      } catch {
        this.onError('SAC route grades could not be loaded: the difficulty filter is incomplete.');
        break;
      }
      if (run !== this.filterRun) return;
      update();
    }

    const needClimb = [...new Set(filtered.filter((f) => filtersClimb(this.filters.get(f.properties?.type)!) && !this.climbs.has(idOf(f))).map(idOf))];
    for (const [n, id] of needClimb.entries()) {
      const lines = this.drawn.filter((f) => idOf(f) === id && !f.properties?.alternative && f.geometry.type === 'LineString').map((f) => (f.geometry as GeoJSON.LineString).coordinates as [number, number][]);
      this.climbs.set(id, await mainClimb(lines).catch(() => null));
      if (run !== this.filterRun) return;
      if (n % 25 === 24) update();
    }
    update();
  }
  private filterVersion = 0;

  /** Lines of the enabled disciplines currently on the map, for routing along them. Changes identity when the set changes. */
  routable(): [number, number][][] {
    const key = `${this.request}:${this.filterVersion}:${[...this.enabled].join()}`;
    if (key !== this.routableKey) {
      this.routableKey = key;
      this.routableLines = this.drawn
        .filter((f) => this.enabled.has(f.properties?.type) && f.geometry.type === 'LineString' && !this.hidden.has(Number(f.properties?.route_id)))
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
    this.map.addLayer({ ...line, id: LINE_LAYERS[0], paint: { 'line-color': '#ffffff', 'line-opacity': 0.75, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 3, 14, 6.5] } }, SLOT.line);
    // Variants of a route are drawn lighter than its main line.
    const opacity = ['case', ['get', 'alternative'], 0.6, 1] as never;
    this.map.addLayer({ ...line, id: LINE_LAYERS[1], paint: { 'line-color': colour, 'line-width': width, 'line-opacity': opacity } }, SLOT.line);
    this.map.addLayer({ ...line, id: LINE_LAYERS[2], layout: { 'line-join': 'round' }, paint: { 'line-color': colour, 'line-width': width, 'line-opacity': opacity, 'line-dasharray': [2, 2] } }, SLOT.line);
    this.map.addLayer(
      {
        id: POINTS,
        type: 'circle',
        source: POINTS,
        minzoom: MIN_ZOOM,
        paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 10, 4, 14, 7], 'circle-color': SAC_DISCIPLINES.climbing.colour, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5 },
      },
      SLOT.point,
    );
    this.map.addSource(HIGHLIGHT, { type: 'geojson', data: empty });
    this.map.addLayer(
      { id: HIGHLIGHT, type: 'line', source: HIGHLIGHT, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#00d5ff', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 10, 14, 18], 'line-opacity': 0.9 } }, // a wide glow under the route's own line
      SLOT.lineHighlight,
    );
    this.popup.on('close', () => this.highlight([]));
    this.applyFilter();
    this.bind();
  }

  private applyFilter(): void {
    if (!this.map.getLayer(LINE_LAYERS[0])) return;
    const wanted = ['all', ['in', ['get', 'type'], ['literal', [...this.enabled]]], ['!', ['in', ['get', 'route_id'], ['literal', [...this.hidden]]]]];
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
    if (this.filters.size) void this.applyFilters();
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

  private clickToken = 0;
  private clickAbort: AbortController | null = null;

  private bind(): void {
    if (this.bound) return;
    this.bound = true;
    for (const id of [LINE_LAYERS[0], POINTS]) {
      this.map.on('mouseenter', id, () => interaction.setHover(this.map, id, true));
      this.map.on('mouseleave', id, () => interaction.setHover(this.map, id, false));
    }

    this.map.on('click', async (event) => {
      if (!this.enabled.size || !this.map.getLayer(LINE_LAYERS[0]) || interaction.drawing) return;
      const { x, y } = event.point;
      const hits = this.map.queryRenderedFeatures([[x - 6, y - 6], [x + 6, y + 6]], { layers: [LINE_LAYERS[0], POINTS] });
      if (!hits.length) return;
      const token = ++this.clickToken;
      this.clickAbort?.abort();
      const controller = (this.clickAbort = new AbortController());
      const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15000)]);
      const point = hits.find((f) => f.layer.id === POINTS);
      if (point) return this.showPoi(event.lngLat, Number(point.properties.id), token, signal);
      const ids = [...new Set(hits.map((f) => Number(f.properties.route_id)))].slice(0, 8);
      this.popup.setLngLat(event.lngLat).setHTML('<div class="popup muted">Loading route…</div>').addTo(this.map);
      try {
        const response = await fetch(`${API}/route/search?lang=en&output_lang=en&id=${ids.join(',')}`, { signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (token !== this.clickToken) return;
        const rows = ((data.results ?? []) as any[]).map((route) => {
          const discipline = SAC_DISCIPLINES[route.type as SacDiscipline];
          const destination = [text(route.destination_poi?.display_name), route.destination_poi?.altitude && `${Math.round(route.destination_poi.altitude)} m`].filter(Boolean).join(', ');
          const link = `${PORTAL}/${route.destination_poi?.id}/${route.type}/${route.id}`;
          return (
            `<div class="problem route-option" data-route="${Number(route.id)}" title="Click to show only this route on the map"><span class="danger-chip" style="background:${discipline?.colour ?? '#777'};color:#fff">${escapeHtml(discipline?.name ?? route.type)}</span>` +
            (route.main_difficulty ? ` <b>${escapeHtml(route.main_difficulty)}</b>` : '') +
            `<div><b style="text-transform:none">${escapeHtml(destination)}</b></div><div>${escapeHtml(text(route.title))}</div>` +
            `<div class="muted" data-track="${Number(route.id)}"></div>` +
            `<a href="${escapeHtml(link)}" target="_blank" rel="noopener">Open in SAC route portal</a></div>`
          );
        });
        this.popup.setHTML(`<div class="popup"><h3>SAC route${rows.length > 1 ? 's' : ''}</h3>${rows.join('') || '<i>No details available</i>'}<div class="muted">Source: SAC route portal</div></div>`);
        // All listed routes are marked; clicking one in the list marks that one alone (again: all).
        const listed = ((data.results ?? []) as any[]).map((route) => Number(route.id));
        this.highlight(listed);
        // The route (the first listed, then whichever is picked) also opens in the track viewer.
        const names = new Map(((data.results ?? []) as any[]).map((route) => [Number(route.id), [text(route.destination_poi?.display_name), text(route.title)].filter(Boolean).join(': ') || 'SAC route']));
        const preview = (id: number) => {
          const lines = this.drawn
            .filter((f) => Number(f.properties?.route_id) === id && !f.properties?.alternative && f.geometry.type === 'LineString')
            .map((f) => (f.geometry as GeoJSON.LineString).coordinates as [number, number][]);
          if (lines.length) void previewRoute(names.get(id) ?? 'SAC route', lines);
        };
        if (listed.length) preview(listed[0]);
        const options = [...(this.popup.getElement()?.querySelectorAll<HTMLElement>('.route-option') ?? [])];
        for (const option of options) {
          option.addEventListener('click', (click) => {
            if ((click.target as HTMLElement).closest('a')) return;
            const alone = !option.classList.contains('on');
            for (const other of options) other.classList.toggle('on', alone && other === option);
            this.highlight(alone ? [Number(option.dataset.route)] : listed);
            if (alone) preview(Number(option.dataset.route));
          });
        }
        void this.measure(ids);
      } catch (err) {
        if (token !== this.clickToken || (err as Error).name === 'AbortError') return;
        this.popup.setHTML('<div class="popup">Route details could not be loaded.</div>');
      }
    });
  }

  /** Marks the given routes on the map (their variants too); none clears the marking. */
  private highlight(ids: number[]): void {
    const features = ids.length ? this.drawn.filter((f) => ids.includes(Number(f.properties?.route_id)) && f.geometry.type === 'LineString') : [];
    (this.map.getSource(HIGHLIGHT) as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features });
  }

  /** Fills in each listed route's length and height gain, measured along its line on the map. */
  private async measure(ids: number[]): Promise<void> {
    for (const id of ids) {
      const lines = this.drawn
        .filter((f) => Number(f.properties?.route_id) === id && !f.properties?.alternative && f.geometry.type === 'LineString')
        .map((f) => (f.geometry as GeoJSON.LineString).coordinates as [number, number][]);
      if (!lines.length) continue;
      const stats = await trackStats(lines).catch(() => null);
      // The popup may show something else by now: then the place to write to is gone.
      const slot = this.popup.getElement()?.querySelector(`[data-track="${id}"]`);
      if (stats && slot) {
        slot.textContent = describeStats(stats);
        (slot as HTMLElement).title = 'Measured along the line on the map, from its lower to its higher end (variants not counted)';
      }
    }
  }

  private async showPoi(lngLat: maplibregl.LngLat, id: number, token: number, signal: AbortSignal): Promise<void> {
    const link = `${PORTAL}/${id}/`;
    const body = (name: string) =>
      `<div class="popup"><h3>${escapeHtml(name)}</h3><span class="danger-chip" style="background:${SAC_DISCIPLINES.climbing.colour};color:#fff">Climbing</span>` +
      `<div class="popup-links"><a href="${link}" target="_blank" rel="noopener">Open in SAC route portal</a></div><div class="muted">Source: SAC route portal</div></div>`;
    this.popup.setLngLat(lngLat).setHTML(body('Climbing area')).addTo(this.map);
    try {
      const response = await fetch(`${API}/poi/search?lang=en&output_lang=en&id=${id}`, { signal });
      if (!response.ok) return;
      const data = await response.json();
      if (token !== this.clickToken) return;
      const poi = data.results?.[0];
      if (poi) this.popup.setHTML(body([text(poi.display_name), poi.altitude && `${Math.round(poi.altitude)} m`].filter(Boolean).join(', ')));
    } catch {
      /* the link alone is enough */
    }
  }
}
