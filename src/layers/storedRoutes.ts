// Routes kept as files next to the page (public/data/…), cut into cells and loaded for the area
// in view: Camptocamp, Skitourenguru's route network, swisstopo's snowshoe routes. What differs
// between the sources (where the files are, how a route is described) is in a RouteSpec.
import { previewRoute } from '../routePreview';
import type * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource } from 'maplibre-gl';
import { interaction } from '../interaction';
import { SLOT } from '../map';
import { describeStats, linesOf, mainClimb, trackStats } from '../trackStats';
import { cellsInView } from './routeCells';
import { filtersClimb, gradeRank, isActive, passes, type RouteFilter, type Scale } from './routeFilter';

type Properties = Record<string, any>;

export interface RouteSpec {
  /** Short id: prefix of the map layers and key in the page address. */
  id: string;
  /** As shown in the menu. */
  name: string;
  colour: string;
  /** Folder of the cell files and address of the index. */
  cellPath: string;
  indexPath: string;
  /** Reads what is needed from the index file. */
  readIndex(json: any): { fetched: string; cells: string[]; size: number; licence?: string };
  /** What the collection is and how it relates to other sources, for the menu's (i) note. */
  about?: string;
  /** Where there is data. */
  coverage: string;
  /** Shown in the map's attribution corner (HTML) and at the foot of the popup (text). */
  attribution: string;
  credit: string;
  /** Kind of route, on the coloured chip. */
  chip(p: Properties): string;
  title(p: Properties): string;
  /** Short facts for one line; empty or missing ones are left out. */
  facts(p: Properties): unknown[];
  links(p: Properties): { label: string; href: string; muted?: boolean }[];
  /** Grade scale for the filter and the route's place on it (null: no grade). */
  scale: Scale | null;
  rank(p: Properties): number | null;
  /** Height gain listed in the data; undefined if the data has none (it is then measured when a filter needs it). */
  up(p: Properties): number | null | undefined;
  /** The lines are recorded tracks with a direction of travel (measure them as drawn). */
  recorded: boolean;
}

const MIN_ZOOM = 9;
/** Layers of the SAC routes: where one of those is clicked too, its popup is shown instead. */
const SAC_LAYERS = ['sac-routes-casing', 'sac-climbing'];
const escapeHtml = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const NO_LINES: [number, number][][] = [];

/** All sources on a map share one popup: a click lists the routes of every source under it. */
const registry = new WeakMap<maplibregl.Map, StoredRoutes[]>();

export class StoredRoutes {
  enabled = false;
  filter: RouteFilter | null = null;
  onError: (message: string) => void = () => {};
  /** Told when routes cannot be shown at the current zoom ("zoom in"), or can again (null). */
  onHint: (hint: string | null) => void = () => {};
  private index: { fetched: string; cells: Set<string>; size: number } | null = null;
  private ready: Promise<boolean> | null = null;
  private cells = new Map<string, GeoJSON.Feature[] | Promise<GeoJSON.Feature[]>>();
  private loaded: GeoJSON.Feature[] = []; // all routes of the cells in view
  private drawn: GeoJSON.Feature[] = []; // those of them the filter lets through
  private lines: [number, number][][] = [];
  private climbs = new Map<number, number | null>(); // measured height gain, for sources that list none
  private measuring = 0;
  private timer: number | undefined;
  private request = 0;
  private readonly source: string;
  private readonly marked: string;
  private readonly layers: { casing: string; line: string; point: string };

  constructor(
    private map: maplibregl.Map,
    private popup: maplibregl.Popup,
    readonly spec: RouteSpec,
  ) {
    this.source = `routes-${spec.id}`;
    this.marked = `${this.source}-highlight`;
    this.layers = { casing: `${this.source}-casing`, line: `${this.source}-line`, point: `${this.source}-point` };
    map.on('moveend', () => this.schedule());
    const all = registry.get(map);
    if (all) all.push(this);
    else {
      registry.set(map, [this]);
      map.on('click', (event) => openPopup(map, popup, event));
      popup.on('close', () => registry.get(map)?.forEach((source) => source.highlight([])));
    }
  }

  async setEnabled(on: boolean): Promise<void> {
    this.enabled = on;
    if (on) {
      this.ready ??= this.load();
      if (!(await this.ready)) this.ready = null; // failed: try again next time it is switched on
    }
    for (const id of [...Object.values(this.layers), this.marked]) {
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

  /** Limits the routes shown to a range of grades and of height gain. */
  setFilter(filter: RouteFilter | null): void {
    this.filter = isActive(filter ?? undefined) ? filter : null;
    this.redraw();
  }

  private schedule(delay = 250): void {
    if (!this.enabled) return;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.refresh(), delay);
  }

  private async load(): Promise<boolean> {
    const { spec, map } = this;
    try {
      const response = await fetch(spec.indexPath);
      if (!response.ok) throw new Error(String(response.status));
      const index = spec.readIndex(await response.json());
      this.index = { fetched: index.fetched, cells: new Set(index.cells), size: index.size };
    } catch {
      this.onError(`${spec.name} could not be loaded (the routes are stored next to the page: not available when it is opened as a single file).`);
      return false;
    }
    const empty: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: [] };
    map.addSource(this.source, { type: 'geojson', data: empty, attribution: `${spec.attribution} (copy of ${escapeHtml(this.index.fetched)})` });
    map.addSource(this.marked, { type: 'geojson', data: empty });
    const lines = ['!=', ['geometry-type'], 'Point'] as never;
    const round = { 'line-cap': 'round' as const, 'line-join': 'round' as const };
    map.addLayer({ id: this.marked, type: 'line', source: this.marked, layout: round, paint: { 'line-color': '#00d5ff', 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 10, 14, 18], 'line-opacity': 0.9 } }, SLOT.lineHighlight);
    map.addLayer({ id: this.layers.casing, type: 'line', source: this.source, filter: lines, minzoom: MIN_ZOOM, layout: round, paint: { 'line-color': '#ffffff', 'line-opacity': 0.75, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 3, 14, 6.5] } }, SLOT.line);
    map.addLayer({ id: this.layers.line, type: 'line', source: this.source, filter: lines, minzoom: MIN_ZOOM, layout: round, paint: { 'line-color': spec.colour, 'line-width': ['interpolate', ['linear'], ['zoom'], 10, 1.5, 14, 3.5] } }, SLOT.line);
    // Routes without a drawn line: a dot where the source places them (usually the summit).
    map.addLayer(
      { id: this.layers.point, type: 'circle', source: this.source, filter: ['==', ['geometry-type'], 'Point'], minzoom: MIN_ZOOM, paint: { 'circle-radius': ['interpolate', ['linear'], ['zoom'], 9, 3, 14, 6], 'circle-color': spec.colour, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 1.5 } },
      SLOT.point,
    );
    for (const id of [this.layers.casing, this.layers.point]) {
      map.on('mouseenter', id, () => interaction.setHover(map, id, true));
      map.on('mouseleave', id, () => interaction.setHover(map, id, false));
    }
    return true;
  }

  /** Loads the cells the view touches and draws their routes. */
  private async refresh(): Promise<void> {
    if (!this.enabled || !this.index || !this.map.getSource(this.source)) return;
    const { name } = this.spec;
    if (this.map.getZoom() < MIN_ZOOM) {
      this.onHint(`Zoom in to see ${name}.`);
      return;
    }
    const bounds = this.map.getBounds();
    const view = { west: bounds.getWest(), south: bounds.getSouth(), east: bounds.getEast(), north: bounds.getNorth() };
    // About the same ground per view whatever the cell size.
    const most = Math.round(3 / this.index.size ** 2);
    const names = cellsInView(view, this.index.cells, most, this.index.size);
    const all = cellsInView(view, this.index.cells, Infinity, this.index.size).length;
    const token = ++this.request;
    const loaded = await Promise.all(names.map((cell) => this.cell(cell).catch(() => null)));
    if (token !== this.request) return;
    if (loaded.some((cell) => cell === null)) this.onError(`Some of ${name} could not be loaded.`);
    // No hint where a collection simply has nothing: with several switched on, most views are outside some of them.
    this.onHint(all > names.length ? 'Shown near the map centre only: zoom in for the rest.' : null);
    const seen = new Set<string | number>();
    const routes: GeoJSON.Feature[] = [];
    for (const cell of loaded) {
      for (const feature of cell ?? []) {
        const key = feature.id ?? feature.properties?.id;
        if (key !== undefined) {
          if (seen.has(key)) continue;
          seen.add(key);
        }
        routes.push(feature);
      }
    }
    if (routes.length === this.loaded.length && routes.every((feature, i) => feature === this.loaded[i])) return; // same cells as before
    this.loaded = routes;
    this.redraw();
  }

  private redraw(): void {
    const { filter, spec } = this;
    const upOf = (feature: GeoJSON.Feature) => {
      const listed = spec.up(feature.properties ?? {});
      return listed !== undefined ? listed : this.climbs.get(Number(feature.id)); // undefined: not measured yet
    };
    this.drawn = filter ? this.loaded.filter((feature) => passes(filter, spec.scale ? spec.rank(feature.properties ?? {}) : null, upOf(feature))) : this.loaded;
    this.lines = this.drawn.flatMap((feature) => linesOf(feature.geometry));
    (this.map.getSource(this.source) as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: this.drawn });
    if (filter && filtersClimb(filter)) void this.measureClimbs();
  }

  /** Height gain of routes whose data lists none, measured along their line; the map follows as results come in. */
  private async measureClimbs(): Promise<void> {
    const run = ++this.measuring;
    const missing = this.loaded.filter((feature) => this.spec.up(feature.properties ?? {}) === undefined && !this.climbs.has(Number(feature.id)) && feature.geometry.type !== 'Point');
    for (const [n, feature] of missing.entries()) {
      this.climbs.set(Number(feature.id), await mainClimb(linesOf(feature.geometry)).catch(() => null));
      if (run !== this.measuring) return; // a newer run took over (it redraws)
      if (n % 25 === 24 || n === missing.length - 1) {
        this.measuring++; // not to be restarted by this redraw
        this.redraw();
        if (n < missing.length - 1) return void this.measureClimbs();
      }
    }
  }

  private cell(name: string): Promise<GeoJSON.Feature[]> {
    const hit = this.cells.get(name);
    if (hit) return Promise.resolve(hit);
    const promise = fetch(`${this.spec.cellPath}/${name}.json`).then(async (response) => {
      if (!response.ok) throw new Error(String(response.status));
      const features = ((await response.json()) as GeoJSON.FeatureCollection).features;
      this.cells.set(name, features);
      return features;
    });
    promise.catch(() => this.cells.delete(name));
    this.cells.set(name, promise);
    return promise;
  }

  highlight(ids: number[]): void {
    const features = ids.length ? this.drawn.filter((f) => ids.includes(Number(f.id)) && f.geometry.type !== 'Point') : [];
    (this.map.getSource(this.marked) as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features });
  }

  /** The routes of this source under a click. */
  hitsAt(x: number, y: number): GeoJSON.Feature[] {
    if (!this.enabled || !this.map.getLayer(this.layers.casing)) return [];
    const hits = this.map.queryRenderedFeatures([[x - 6, y - 6], [x + 6, y + 6]], { layers: [this.layers.casing, this.layers.point] });
    const ids = [...new Set(hits.map((f) => Number(f.id ?? f.properties.id)))];
    return ids.map((id) => this.drawn.find((f) => Number(f.id) === id)).filter((f): f is GeoJSON.Feature => !!f);
  }

  /** One route's block in the popup. `key` identifies it there. */
  row(route: GeoJSON.Feature, key: string): string {
    const { spec } = this;
    const p = route.properties ?? {};
    const facts = spec.facts(p).filter(Boolean).map(String).join(' · ');
    const links = spec
      .links(p)
      .filter((link) => /^https?:\/\//i.test(link.href))
      .map((link) => `<a${link.muted ? ' class="muted"' : ''} href="${escapeHtml(link.href)}" target="_blank" rel="noopener">${escapeHtml(link.label)}</a>`)
      .join(' ');
    return (
      `<div class="problem route-option" data-route="${key}" title="Click to show only this route on the map">` +
      `<span class="danger-chip" style="background:${spec.colour};color:#fff">${escapeHtml(spec.chip(p))}</span>` +
      `<div><b style="text-transform:none">${escapeHtml(spec.title(p))}</b></div>` +
      (facts ? `<div>${escapeHtml(facts)}</div>` : '') +
      `<div class="muted" data-track="${key}">${route.geometry.type === 'Point' ? 'No line drawn for this route' : ''}</div>` +
      `${links}</div>`
    );
  }

  /** Length and height gain along a route's line, measured on the elevation model, as text. */
  async measured(route: GeoJSON.Feature): Promise<string | null> {
    if (route.geometry.type === 'Point') return null;
    const stats = await trackStats(linesOf(route.geometry), undefined, this.spec.recorded).catch(() => null);
    if (!stats) return null;
    // Uploaded tracks often include the approach, the descent or a second day.
    const listed = Number(this.spec.up(route.properties ?? {}));
    return `Line: ${describeStats(stats)}${this.spec.recorded && listed > 0 && stats.up > listed * 1.3 ? ' (track covers more than the described route)' : ''}`;
  }
}

/** Opens the shared popup for a click: every enabled source's routes under it, at most 12. */
function openPopup(map: maplibregl.Map, popup: maplibregl.Popup, event: maplibregl.MapMouseEvent): void {
  if (interaction.drawing) return;
  const { x, y } = event.point;
  const sources = registry.get(map) ?? [];
  const found = sources.flatMap((source) => source.hitsAt(x, y).map((route) => ({ source, route }))).slice(0, 12);
  if (!found.length) return;
  // Where an SAC route is under the click too, its popup is shown instead.
  const sac = SAC_LAYERS.filter((id) => map.getLayer(id));
  if (sac.length && map.queryRenderedFeatures([[x - 6, y - 6], [x + 6, y + 6]], { layers: sac }).length) return;
  const key = (entry: (typeof found)[number]) => `${entry.source.spec.id}:${Number(entry.route.id)}`;
  const credits = [...new Set(found.map((entry) => entry.source.spec.credit))];
  popup
    .setLngLat(event.lngLat)
    .setHTML(`<div class="popup"><h3>Route${found.length > 1 ? 's' : ''} here</h3>${found.map((entry) => entry.source.row(entry.route, key(entry))).join('')}${credits.map((credit) => `<div class="muted">${escapeHtml(credit)}</div>`).join('')}</div>`)
    .addTo(map);
  const mark = (entries: typeof found) => {
    for (const source of sources) source.highlight(entries.filter((entry) => entry.source === source).map((entry) => Number(entry.route.id)));
  };
  mark(found); // after opening: that closes the previous popup, which clears the marking
  const preview = (entry: (typeof found)[number]) => void previewRoute(entry.source.spec.title(entry.route.properties ?? {}), linesOf(entry.route.geometry));
  const firstLine = found.find((entry) => entry.route.geometry.type !== 'Point');
  if (firstLine) preview(firstLine);
  const options = [...(popup.getElement()?.querySelectorAll<HTMLElement>('.route-option') ?? [])];
  for (const option of options) {
    option.addEventListener('click', (click) => {
      if ((click.target as HTMLElement).closest('a')) return;
      const alone = !option.classList.contains('on');
      for (const other of options) other.classList.toggle('on', alone && other === option);
      mark(alone ? found.filter((entry) => key(entry) === option.dataset.route) : found);
      const chosen = found.find((entry) => key(entry) === option.dataset.route);
      if (alone && chosen && chosen.route.geometry.type !== 'Point') preview(chosen);
    });
  }
  void (async () => {
    for (const entry of found) {
      const text = await entry.source.measured(entry.route);
      const slot = popup.getElement()?.querySelector(`[data-track="${key(entry)}"]`);
      if (text && slot) slot.textContent = text;
    }
  })();
}
