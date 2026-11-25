// Camptocamp routes from a snapshot stored with the site (public/data/camptocamp, made by
// scripts/fetch-camptocamp.mjs) in half-degree cells, loaded for the area in view. Their API does not answer pages of other websites, but the
// content is openly licensed (CC BY-SA), so a copy with attribution can be shown.
import type * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource } from 'maplibre-gl';
import { interaction } from '../interaction';
import { SLOT } from '../map';
import { describeStats, linesOf, trackStats } from '../trackStats';
import { cellsInView } from './camptocampCells';
import { gradeRank, isActive, passes, type RouteFilter } from './routeFilter';

const DATA = './data/camptocamp';
const ACTIVITY = 'skitouring';
const SOURCE = 'camptocamp';
const HIGHLIGHT = 'camptocamp-highlight';
const LAYERS = { casing: 'camptocamp-casing', line: 'camptocamp-line', point: 'camptocamp-point' };
const COLOUR = '#e8590c';
const SITE = 'https://www.camptocamp.org/routes';
const MIN_ZOOM = 9;
const MAX_CELLS_PER_VIEW = 12;
const ACTIVITY_NAMES: Record<string, string> = { skitouring: 'Ski tour', snowshoeing: 'Snowshoe tour', hiking: 'Hike', mountain_climbing: 'Mountaineering' };
/** Layers of other route sources: where one of those is clicked too, its popup is shown instead. */
const OTHER_ROUTE_LAYERS = ['sac-routes-casing', 'sac-climbing'];

const escapeHtml = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

interface Index {
  cell: number;
  activities: Record<string, { fetched: string; cells: string[] }>;
}

export class Camptocamp {
  enabled = false;
  onError: (message: string) => void = () => {};
  /** Told when routes cannot be shown at the current zoom ("zoom in"), or can again (null). */
  onHint: (hint: string | null) => void = () => {};
  private index: { fetched: string; cells: Set<string>; size: number } | null = null;
  private ready: Promise<boolean> | null = null;
  private cells = new Map<string, GeoJSON.Feature[] | Promise<GeoJSON.Feature[]>>();
  private loaded: GeoJSON.Feature[] = []; // all routes of the cells in view
  private drawn: GeoJSON.Feature[] = []; // those of them the filter lets through
  filter: RouteFilter | null = null;
  private lines: [number, number][][] = [];
  private timer: number | undefined;
  private request = 0;

  constructor(
    private map: maplibregl.Map,
    private popup: maplibregl.Popup,
  ) {
    map.on('moveend', () => this.schedule());
  }

  async setEnabled(on: boolean): Promise<void> {
    this.enabled = on;
    if (on) {
      this.ready ??= this.load();
      if (!(await this.ready)) this.ready = null; // failed: try again next time it is switched on
    }
    for (const id of [...Object.values(LAYERS), HIGHLIGHT]) {
      if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', this.enabled ? 'visible' : 'none');
    }
    if (on) this.schedule(0);
    else {
      this.highlight([]);
      this.onHint(null);
    }
  }

  /** Route lines currently on the map, for the planner to follow. Changes identity when the set changes. */
  routable(): [number, number][][] {
    return this.enabled ? this.lines : NO_LINES;
  }

  private schedule(delay = 250): void {
    if (!this.enabled) return;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.refresh(), delay);
  }

  private async load(): Promise<boolean> {
    try {
      const response = await fetch(`${DATA}/index.json`);
      if (!response.ok) throw new Error(String(response.status));
      const index = (await response.json()) as Index;
      const entry = index.activities[ACTIVITY];
      this.index = { fetched: entry.fetched, cells: new Set(entry.cells), size: index.cell };
    } catch {
      this.onError('Camptocamp routes could not be loaded (they are stored next to the page: not available when it is opened as a single file).');
      return false;
    }
    const map = this.map;
    const empty: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
    const attribution = `Routes © <a href="https://www.camptocamp.org" target="_blank">Camptocamp</a> contributors, CC BY-SA (copy of ${this.index.fetched})`;
    map.addSource(SOURCE, { type: 'geojson', data: empty, attribution });
    map.addSource(HIGHLIGHT, { type: 'geojson', data: empty });
    const lines = ['!=', ['geometry-type'], 'Point'] as never;
    const round = { 'line-cap': 'round' as const, 'line-join': 'round' as const };
    map.addLayer({ id: HIGHLIGHT, type: 'line', source: HIGHLIGHT, layout: round, paint: { 'line-color': '#00d5ff', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 10, 14, 18], 'line-opacity': 0.9 } }, SLOT.top);
    map.addLayer({ id: LAYERS.casing, type: 'line', source: SOURCE, filter: lines, minzoom: MIN_ZOOM, layout: round, paint: { 'line-color': '#ffffff', 'line-opacity': 0.75, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 3, 14, 6.5] } }, SLOT.top);
    map.addLayer({ id: LAYERS.line, type: 'line', source: SOURCE, filter: lines, minzoom: MIN_ZOOM, layout: round, paint: { 'line-color': COLOUR, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.5, 14, 3.5] } }, SLOT.top);
    // Routes without a drawn line: a dot where Camptocamp places them (usually the summit).
    map.addLayer(
      { id: LAYERS.point, type: 'circle', source: SOURCE, filter: ['==', ['geometry-type'], 'Point'], minzoom: MIN_ZOOM, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 3, 14, 6], 'circle-color': COLOUR, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5 } },
      SLOT.top,
    );
    for (const id of [LAYERS.casing, LAYERS.point]) {
      map.on('mouseenter', id, () => (map.getCanvas().style.cursor = 'pointer'));
      map.on('mouseleave', id, () => (map.getCanvas().style.cursor = ''));
    }
    this.popup.on('close', () => this.highlight([]));
    map.on('click', (event) => this.onClick(event));
    return true;
  }

  /** Loads the cells the view touches and draws their routes. */
  private async refresh(): Promise<void> {
    if (!this.enabled || !this.index || !this.map.getSource(SOURCE)) return;
    if (this.map.getZoom() < MIN_ZOOM) {
      this.onHint('Zoom in to see Camptocamp routes.');
      return;
    }
    const bounds = this.map.getBounds();
    const view = { west: bounds.getWest(), south: bounds.getSouth(), east: bounds.getEast(), north: bounds.getNorth() };
    const names = cellsInView(view, this.index.cells, MAX_CELLS_PER_VIEW, this.index.size);
    const all = cellsInView(view, this.index.cells, Infinity, this.index.size).length;
    const token = ++this.request;
    const loaded = await Promise.all(names.map((name) => this.cell(name).catch(() => null)));
    if (token !== this.request) return;
    if (loaded.some((cell) => cell === null)) this.onError('Some Camptocamp routes could not be loaded.');
    this.onHint(all > names.length ? 'Camptocamp routes shown near the map centre only: zoom in for the rest.' : names.length ? null : 'No Camptocamp routes stored for this area (Switzerland only).');
    const routes = loaded.flatMap((cell) => cell ?? []);
    if (routes.length === this.loaded.length && routes.every((feature, i) => feature === this.loaded[i])) return; // same cells as before
    this.loaded = routes;
    this.redraw();
  }

  /** Limits the routes shown to a range of grades (Camptocamp's overall grade) and of listed height gain. */
  setFilter(filter: RouteFilter | null): void {
    this.filter = isActive(filter ?? undefined) ? filter : null;
    this.redraw();
  }

  private redraw(): void {
    const filter = this.filter;
    this.drawn = filter ? this.loaded.filter((f) => passes(filter, gradeRank('french', f.properties?.rating), f.properties?.up ?? null)) : this.loaded;
    this.lines = this.drawn.flatMap((feature) => linesOf(feature.geometry));
    (this.map.getSource(SOURCE) as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: this.drawn });
  }

  private cell(name: string): Promise<GeoJSON.Feature[]> {
    const hit = this.cells.get(name);
    if (hit) return Promise.resolve(hit);
    const promise = fetch(`${DATA}/${ACTIVITY}/${name}.json`).then(async (response) => {
      if (!response.ok) throw new Error(String(response.status));
      const features = ((await response.json()) as GeoJSON.FeatureCollection).features;
      this.cells.set(name, features);
      return features;
    });
    promise.catch(() => this.cells.delete(name));
    this.cells.set(name, promise);
    return promise;
  }

  private highlight(ids: number[]): void {
    const features = ids.length ? this.drawn.filter((f) => ids.includes(Number(f.id)) && f.geometry.type !== 'Point') : [];
    (this.map.getSource(HIGHLIGHT) as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features });
  }

  private onClick(event: maplibregl.MapMouseEvent): void {
    if (!this.enabled || interaction.drawing || !this.map.getLayer(LAYERS.casing)) return;
    const { x, y } = event.point;
    const hits = this.map.queryRenderedFeatures([[x - 6, y - 6], [x + 6, y + 6]], { layers: [LAYERS.casing, LAYERS.point] });
    const ids = [...new Set(hits.map((f) => Number(f.properties.id)))].slice(0, 12);
    if (!ids.length) return;
    // One popup for all route sources: where an SAC route is under the click too, that one is shown.
    const others = OTHER_ROUTE_LAYERS.filter((id) => this.map.getLayer(id));
    if (others.length && this.map.queryRenderedFeatures([[x - 6, y - 6], [x + 6, y + 6]], { layers: others }).length) return;
    const routes = ids.map((id) => this.drawn.find((f) => Number(f.id) === id)!).filter(Boolean);
    const rows = routes.map((route) => {
      const p = route.properties ?? {};
      const facts = [p.rating && `grade ${p.rating}`, p.ski && `ski ${p.ski}`, p.up && `↑ ${p.up} m`, p.top && `top ${p.top} m`, p.aspects && `faces ${String(p.aspects).replace(/,/g, ', ')}`].filter(Boolean).join(' · ');
      return (
        `<div class="problem route-option" data-route="${Number(p.id)}" title="Click to show only this route on the map">` +
        `<span class="danger-chip" style="background:${COLOUR};color:#fff">${escapeHtml(ACTIVITY_NAMES[p.activity] ?? 'Route')}</span>` +
        `<div><b style="text-transform:none">${escapeHtml(p.title)}</b></div>` +
        (facts ? `<div>${escapeHtml(facts)}</div>` : '') +
        `<div class="muted" data-track="${Number(p.id)}">${route.geometry.type === 'Point' ? 'No line drawn for this route' : ''}</div>` +
        `<a href="${SITE}/${Number(p.id)}" target="_blank" rel="noopener">Open on Camptocamp</a>` +
        ` <a class="muted" href="${escapeHtml(p.credit)}" target="_blank" rel="noopener">authors</a></div>`
      );
    });
    this.popup
      .setLngLat(event.lngLat)
      .setHTML(`<div class="popup"><h3>Camptocamp route${rows.length > 1 ? 's' : ''}</h3>${rows.join('')}<div class="muted">Source: Camptocamp, CC BY-SA, copy of ${escapeHtml(this.index?.fetched)}</div></div>`)
      .addTo(this.map);
    this.highlight(ids); // after opening: that closes the previous popup, which clears the marking
    const options = [...(this.popup.getElement()?.querySelectorAll<HTMLElement>('.route-option') ?? [])];
    for (const option of options) {
      option.addEventListener('click', (click) => {
        if ((click.target as HTMLElement).closest('a')) return;
        const alone = !option.classList.contains('on');
        for (const other of options) other.classList.toggle('on', alone && other === option);
        this.highlight(alone ? [Number(option.dataset.route)] : ids);
      });
    }
    void this.measure(routes);
  }

  /** Length and height gain along each drawn line, in its recorded direction, measured on the elevation model. */
  private async measure(routes: GeoJSON.Feature[]): Promise<void> {
    for (const route of routes) {
      if (route.geometry.type === 'Point') continue;
      const stats = await trackStats(linesOf(route.geometry), undefined, true).catch(() => null);
      const slot = this.popup.getElement()?.querySelector(`[data-track="${Number(route.id)}"]`);
      if (!stats || !slot) continue;
      // Uploaded tracks often include the approach, the descent or a second day.
      const listed = Number(route.properties?.up);
      const more = listed > 0 && stats.up > listed * 1.3;
      slot.textContent = `Line: ${describeStats(stats)}${more ? ' (track covers more than the described route)' : ''}`;
    }
  }
}

const NO_LINES: [number, number][][] = [];
