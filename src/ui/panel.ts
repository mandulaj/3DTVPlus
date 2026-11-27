import type * as maplibregl from 'maplibre-gl';
import { CATALOG, KEY_PROVIDERS, byId, defaultParam, type KeyProvider, type LayerDef } from '../layers/catalog';
import type { LayerManager } from '../layers/manager';
import { SAC_DISCIPLINES, type SacDiscipline, type SacRoutes } from '../layers/sac';
import type { Skitourenguru } from '../layers/skitourenguru';
import { PRESETS, type Preset } from '../layers/presets';
import { SNOW_PRODUCTS, STATION_TYPES, type Legend, type SlfLayers, type SnowProduct, type StationType } from '../layers/slf';
import { WATER_LAYERS } from '../map';
import { unofficial } from '../unofficial';
import type { RouteFilter } from '../layers/routeFilter';
import type { RouteSpec } from '../layers/storedRoutes';
import { routeFilterUi, type RouteFilterUi } from './routeFilterUi';
import { REPORT_SPANS, reportLegend } from '../layers/gipfelbuch';
import { h, info, slider } from './dom';

export interface SlfState {
  snow: SnowProduct | '';
  snowDate: string;
  snowOpacity: number;
  bulletin: boolean;
  bulletinOpacity: number;
  stations: StationType | '';
  avalanches: boolean;
  /** Skitourenguru routes with today's risk rating. */
  guru: boolean;
}

export interface TerrainState {
  exaggeration: number;
  hillshade: number;
  colorRelief: boolean;
  /** How strongly the elevation colours cover what is underneath (0–1). */
  colorReliefOpacity: number;
  /** Draw lakes and rivers in blue where no base map shows them. */
  water: boolean;
  /** Summit markers with name, altitude and distance. */
  peaks: boolean;
}

function groupBy<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)!.push(item);
  }
  return groups;
}

function section(title: string, open: boolean, ...children: (Node | null)[]): HTMLDetailsElement {
  // A leading symbol ("⛷ Ski touring") is set apart so all titles line up.
  const match = /^(\S+) (.+)$/u.exec(title);
  const symbol = match && !/^[\w(]/.test(match[1]) ? match[1] : null;
  const summary = symbol ? h('summary', {}, h('span', { class: 'section-icon', 'aria-hidden': 'true' }, symbol), match![2]) : h('summary', {}, title);
  return h('details', { open, class: 'section' }, summary, h('div', { class: 'section-body' }, ...children));
}

/** Menu sections by topic, and the map overlays (catalog ids) listed in each. */
const TOPIC_OVERLAYS: Record<string, string[]> = {
  ski: ['ch-skitouren', 'ch-snowshoe', 'ch-winter-huts', 'ch-winter-lifts', 'ch-wildlife', 'osm-pistes', 'wmt-slopes'],
  snow: ['ch-slope30', 'ch-slope-classes', 'slf-cat', 'slf-ath', 'slf-slope', 'fr-slopes', 'ch-protect-forest', 'gibs-snow'],
  hiking: ['ch-hiking', 'ch-wanderland', 'wmt-hiking', 'ch-huntingban'],
  cycling: ['ch-veloland', 'ch-mtbland', 'wmt-cycling', 'wmt-mtb'],
  weather: ['rainviewer'],
};
const SAC_NOTE = 'Lines from the SAC route portal, asked live from SAC (Switzerland and nearby, from zoom 10). The most complete and current set, with a link to each route\'s SAC page. Unofficial use: SAC has granted no licence for showing its data here, which is why it must be switched on under Settings.';
/** What each kind of SAC route is, and how it relates to the other sources of the same routes. */
const SAC_NOTES: Partial<Record<SacDiscipline, string>> = {
  ski_tour: `${SAC_NOTE} The same routes are largely also in "Ski routes Switzerland" (open data, a checked subset) and drawn on the "swisstopo ski routes" map layer: one of the three is usually enough.`,
  snowshoe_tour: `${SAC_NOTE} The same routes are also in "Snowshoe routes Switzerland" (open data) and on the "swisstopo snowshoe routes" map layer.`,
};
/** Clearer names in the menu where the catalog name alone would be mistaken for a line source. */
const OVERLAY_NAMES: Record<string, string> = { 'ch-skitouren': 'swisstopo ski routes (map picture)', 'ch-snowshoe': 'swisstopo snowshoe routes (map picture)' };
/** Notes for map overlays that show the same thing as a line source. */
const OVERLAY_NOTES: Record<string, string> = {
  'ch-skitouren': 'swisstopo\'s official ski route map, drawn as a picture: complete and with the route numbers, but the lines cannot be filtered or followed by the planner. Click a route for its details. Same routes as "SAC ski touring" and "Ski routes Switzerland".',
  'ch-snowshoe': 'swisstopo\'s official snowshoe route map, drawn as a picture. Same routes as the "Snowshoe routes Switzerland" lines, which can be filtered and followed by the planner.',
};
/** SAC route kinds per section. */
const TOPIC_SAC: Record<string, SacDiscipline[]> = {
  ski: ['ski_tour', 'snowshoe_tour'],
  hiking: ['mountain_hiking', 'alpine_tour', 'via_ferrata', 'climbing'],
};

function paramControl(def: LayerDef, value: string | undefined, onchange: (value: string) => void): HTMLElement | null {
  if (!def.param) return null;
  const current = value ?? defaultParam(def)!;
  if (def.param.kind === 'date') {
    return h('input', {
      type: 'date',
      value: current,
      max: new Date().toISOString().slice(0, 10),
      onchange: (e: Event) => (e.target as HTMLInputElement).value && onchange((e.target as HTMLInputElement).value),
    });
  }
  const select = h('select', { onchange: (e: Event) => onchange((e.target as HTMLSelectElement).value) });
  for (const option of def.param.options) select.append(h('option', { value: option.value, selected: option.value === current }, option.label));
  return select;
}

/** Overlay under which the Skitourenguru toggle appears. */
const GURU_PARENT = 'ch-skitouren';

export class Panel {
  private legends = new Map<string, Legend>();
  private legendBox = h('div', { class: 'legends' });
  private overlayRows = new Map<string, { extra: HTMLElement; checkbox: HTMLInputElement }[]>();
  private sections = new Map<string, HTMLDetailsElement>();
  private baseParamBox = h('div', { class: 'row-extra' });
  private baseSelect!: HTMLSelectElement;
  private slfBox = h('div');
  private sacBoxes = new Map<SacDiscipline, HTMLInputElement>();
  private sacParts: { body: HTMLElement; hint: HTMLElement; ids: SacDiscipline[] }[] = [];
  private reliefScale = 1;
  /** Set by the app: switches the peak labels. */
  onPeaks: (on: boolean) => void = () => {};
  /** Set by the app: switches the weather forecast on the map. */
  onWeather: (on: boolean) => void = () => {};
  onWebcams: (on: boolean) => void = () => {};
  /** An API key was entered or removed under Settings. */
  onKey: (provider: KeyProvider) => void = () => {};
  webcamBox = h('input', { type: 'checkbox', onchange: () => this.onWebcams(this.webcamBox.checked) });
  webcamHint = h('div', { class: 'muted' });
  weatherBox = h('input', { type: 'checkbox', onchange: () => this.onWeather(this.weatherBox.checked) });
  /** Set by the app: opens or closes the route planner. */
  /** Adds a tool's own block to a section of the panel (by topic; unknown topics go above Settings). */
  addTo(topic: string, block: HTMLElement): void {
    const body = this.sections.get(topic)?.querySelector(':scope > .section-body');
    if (body) body.append(block);
    else this.settingsSection?.before(block);
  }

  /** Opens a section (and any parent section wrapping it) and brings it into view. */
  openSection(topic: string): void {
    const target = this.sections.get(topic);
    if (!target) return;
    target.open = true;
    for (let parent = target.parentElement?.closest('details'); parent; parent = parent.parentElement?.closest('details')) {
      (parent as HTMLDetailsElement).open = true;
    }
    target.scrollIntoView({ block: 'nearest' });
  }

  /** Adds, updates or removes a layer's entry in the unified legend window below the menu. */
  setLegend(key: string, legend: Legend | null): void {
    if (legend) this.legends.set(key, legend);
    else this.legends.delete(key);
    this.renderLegends();
  }

  onPlan: () => void = () => {};
  onImport: () => void = () => {};

  constructor(
    private root: HTMLElement,
    private map: maplibregl.Map,
    private layers: LayerManager,
    private slf: SlfLayers,
    private guru: Skitourenguru,
    private sac: SacRoutes,
    /** Stored route collections, each with a switch and a filter in the menu. */
    private routes: RouteSpec[],
    readonly slfState: SlfState,
    readonly terrain: TerrainState,
    private onStateChange: () => void,
  ) {
    const onLegend = (key: string, legend: Legend | null) => this.setLegend(key, legend);
    slf.onLegend = onLegend;
    guru.onLegend = onLegend;
    this.build();
  }

  private build(): void {
    const toggle = h('button', { class: 'panel-toggle', title: 'Show / hide layers', onclick: () => this.root.classList.toggle('collapsed') }, '☰');
    const body = h(
      'div',
      { class: 'panel-body' },
      h('h1', {}, '3D Terrain Viewer'),
      this.buildPresets(),
      this.buildBaseAndTerrain(),
      this.buildWeather(),
      this.buildSnow(),
      this.buildRoutes(),
      this.buildMore(),
      this.buildSettings(),
    );
    this.sac.onHint = (hint) => this.sacParts.forEach((part) => (part.hint.textContent = hint ?? ''));
    this.renderSac();
    this.syncSlf();
    this.legendBox.hidden = true;
    this.root.append(toggle, body, this.legendBox);
    // Each section's header shows how many things are switched on inside it.
    body.addEventListener('change', () => window.setTimeout(() => this.countActive(), 0));
    body.addEventListener('click', () => window.setTimeout(() => this.countActive(), 0));
    this.countActive();
    // On a phone the map comes first: the layer panel opens on demand.
    if (window.matchMedia('(max-width: 700px)').matches) this.root.classList.add('collapsed');
  }

  // ── Weather ──

  private buildWeather(): HTMLElement {
    return this.topic(
      'weather',
      '🌤️ Weather & webcams',
      false,
      h('label', { class: 'row' }, this.weatherBox, h('span', {}, 'Towns and summits in view'), info('Lowest and highest temperature, weather and strongest wind (km/h, arrow shows where it blows to) for the day chosen at the top of the map. Model forecast from Open-Meteo; in and around Switzerland from the MeteoSwiss ICON model. Summit values are for summit height.')),
      h('label', { class: 'row' }, this.webcamBox, h('span', {}, 'Webcams'), info('Camera icons where a webcam is known; click one for a link to it. Without setup they come from OpenStreetMap (a stored copy for Switzerland and around; link only). With your own free Windy Webcams API key (Settings) they come from Windy, with a preview picture.')),
      this.webcamHint,
      ...this.overlayRowsFor('weather'),
    );
  }

  // ── Topic sections ──

  private topic(id: string, title: string, open: boolean, ...children: (Node | null)[]): HTMLDetailsElement {
    const made = section(title, open, ...children);
    this.sections.set(id, made);
    return made;
  }

  private overlayRowsFor(topic: string): HTMLElement[] {
    return TOPIC_OVERLAYS[topic].map((id) => byId.get(id)).filter((def): def is LayerDef => !!def).map((def) => this.overlayRow(def));
  }

  /** How many switches are on in each section, shown beside its title. */
  countActive(): void {
    for (const made of this.sections.values()) {
      const seenShared = new Set<string>();
      const checkboxes = [...made.querySelectorAll('input[type="checkbox"]:checked')].filter((box) => {
        if (box.closest('.check-manual')) return false;
        const shared = (box as HTMLElement).dataset.shared;
        if (shared) {
          if (seenShared.has(shared)) return false;
          seenShared.add(shared);
        }
        return true;
      });
      const on = checkboxes.length + made.querySelectorAll('.segmented button.on:not([data-key=""])').length + [...made.querySelectorAll('select.counted')].filter((select) => (select as HTMLSelectElement).value !== '').length;
      const summary = made.querySelector(':scope > summary')!;
      if (on) summary.setAttribute('data-on', String(on));
      else summary.removeAttribute('data-on');
    }
  }

  private buildRoutes(): HTMLElement {
    return this.topic('routes', '📍 Routes', false, this.buildSki(), this.buildHiking(), this.buildCycling());
  }

  private buildSki(): HTMLElement {
    return this.topic(
      'ski',
      '⛷️ Ski touring & snowshoe',
      false,
      h('div', { class: 'group-title' }, 'Routes'),
      this.sacPart('ski'),
      ...this.routes.flatMap((spec) => this.routeRow(spec)),
      h('div', { class: 'group-title' }, 'Map layers'),
      ...this.overlayRowsFor('ski'),
      ...this.hutRow(),
      ...this.reportRow(),
    );
  }

  private buildSnow(): HTMLElement {
    const made = this.topic('snow', '❄️ Snow & avalanches', true, this.slfBox, h('div', { class: 'group-title' }, 'Avalanche terrain'), ...this.overlayRowsFor('snow'));
    made.querySelector('summary')?.append(info('SLF data covers Switzerland. Click a region, station or avalanche on the map for details.'));
    return made;
  }

  private buildHiking(): HTMLElement {
    return this.topic('hiking', '🥾 Hiking & mountaineering', false, ...this.overlayRowsFor('hiking'), this.sacPart('hiking'), ...this.hutRow(), ...this.reportRow());
  }

  private buildCycling(): HTMLElement {
    return this.topic('cycling', '🚲 Cycling', false, ...this.overlayRowsFor('cycling'));
  }

  /** Every map overlay not listed under a topic. */
  private buildMore(): HTMLElement {
    const listed = new Set(Object.values(TOPIC_OVERLAYS).flat());
    const container = h('div', {});
    for (const [group, defs] of groupBy(CATALOG.filter((l) => l.role === 'overlay' && !listed.has(l.id)), (l) => l.group)) {
      container.append(h('div', { class: 'group-title' }, group));
      for (const def of defs) container.append(this.overlayRow(def));
    }
    return this.topic('more', '🧭 More maps', false, container);
  }

  // ── Stored routes (Camptocamp, Skitourenguru's network, …) ──

  onRoute: (id: string, on: boolean) => void = () => {};
  onRouteFilter: (id: string, filter: RouteFilter | null) => void = () => {};
  private routeBoxes = new Map<string, HTMLInputElement>();
  private routeHints = new Map<string, HTMLElement>();

  private routeRow(spec: RouteSpec): HTMLElement[] {
    const box = h('input', { type: 'checkbox', onchange: () => this.onRoute(spec.id, box.checked) });
    this.routeBoxes.set(spec.id, box);
    const hint = h('div', { class: 'muted' });
    this.routeHints.set(spec.id, hint);
    const swatch = h('i', { class: 'swatch' });
    swatch.style.background = spec.colour;
    const label = h('label', { class: 'row' }, box, swatch, h('span', {}, spec.name), info(`${spec.about ? `${spec.about} ` : ''}${spec.credit}. A copy stored with this site, not updated live; covers ${spec.coverage}. Click a route for details. The route planner follows the lines.`));
    if (!spec.scale) return [label, hint];
    const filter = routeFilterUi(spec.scale, null, spec.up({}) === undefined ? 'Height gain measured along the line on the map (takes a moment for many routes)' : 'Height gain as listed by the source', (value) => this.onRouteFilter(spec.id, value));
    this.filterUis.set(spec.id, filter);
    return [h('div', { class: 'filter-row' }, label, filter.toggle), filter.body, hint];
  }

  /** Shows a stored route collection as switched on or off (set elsewhere: page address, preset). */
  showRoute(id: string, on: boolean): void {
    const box = this.routeBoxes.get(id);
    if (box) box.checked = on;
    this.countActive();
  }

  showRouteHint(id: string, hint: string | null): void {
    const element = this.routeHints.get(id);
    if (element) element.textContent = hint ?? '';
  }

  // ── Huts ──

  onHuts: (on: boolean) => void = () => {};
  private hutBoxes: HTMLInputElement[] = [];
  private hutHints: HTMLElement[] = [];

  /** The hut switch appears under several topics: the copies stay in step. */
  private hutRow(): HTMLElement[] {
    const box = h('input', {
      type: 'checkbox',
      'data-shared': 'huts',
      onchange: () => {
        this.showHuts(box.checked);
        this.onHuts(box.checked);
      },
    });
    const hint = h('div', { class: 'muted' });
    this.hutBoxes.push(box);
    this.hutHints.push(hint);
    return [h('label', { class: 'row' }, box, h('span', {}, 'Huts and shelters (refuges.info)'), info('Staffed huts, unstaffed shelters and lodgings from refuges.info (CC BY-SA), asked live for the area in view. Mainly the French and western Alps and the Pyrenees. Click one for details and a link.')), hint];
  }

  showHuts(on: boolean): void {
    for (const box of this.hutBoxes) box.checked = on;
    this.countActive();
  }

  showHutHint(hint: string | null): void {
    for (const element of this.hutHints) element.textContent = hint ?? '';
  }

  // ── Condition reports (gipfelbuch.ch) ──

  onReports: (on: boolean, days: number) => void = () => {};
  private reportBoxes: HTMLInputElement[] = [];
  private reportSpans: HTMLSelectElement[] = [];
  private reportHints: HTMLElement[] = [];
  private reportExtras: HTMLElement[] = [];

  /** Like the hut switch, this appears under several topics and the copies stay in step. */
  private reportRow(): HTMLElement[] {
    const change = () => {
      this.showReports(box.checked, Number(span.value));
      this.onReports(box.checked, Number(span.value));
    };
    const box = h('input', { type: 'checkbox', 'data-shared': 'reports', onchange: change });
    const span = h('select', { title: 'Show reports since', onchange: change }, ...REPORT_SPANS.map((s) => h('option', { value: String(s.days), selected: s.days === 7 }, s.name)));
    const hint = h('div', { class: 'muted' });
    const extra = h('div', { class: 'row-extra report-options', hidden: true }, h('div', { class: 'row' }, h('span', { class: 'muted' }, 'Since'), span), hint);
    this.reportBoxes.push(box);
    this.reportSpans.push(span);
    this.reportHints.push(hint);
    this.reportExtras.push(extra);
    return [
      h('label', { class: 'row' }, box, h('span', {}, 'Condition reports (gipfelbuch.ch)'), info('Recent tour reports from gipfelbuch.ch. Pin colour shows the activity (blue snow, green hiking, gray climbing) and fades from vivid to very light with age; the corner dot shows reported conditions. Click a pin for an excerpt and link. The list is a stored copy and only as fresh as its last refresh (shown below when switched on).')),
      extra,
    ];
  }

  showReports(on: boolean, days?: number): void {
    for (const box of this.reportBoxes) box.checked = on;
    if (days) for (const span of this.reportSpans) span.value = String(days);
    for (const extra of this.reportExtras) extra.hidden = !on;
    this.setLegend('reports', on ? reportLegend() : null);
    this.countActive();
  }

  showReportHint(hint: string | null): void {
    for (const element of this.reportHints) element.textContent = hint ?? '';
  }

  // ── SAC routes ──

  private filterUis = new Map<string, RouteFilterUi>();

  /** Show a route filter that was set elsewhere (restored from the page address). Key: SAC discipline or stored route id. */
  showRouteFilter(key: string, filter: RouteFilter | null): void {
    this.filterUis.get(key)?.set(filter);
  }
  private settingsSection: HTMLElement | null = null;

  /** The SAC route kinds that belong to a topic, as a block of its section. */
  private sacPart(topic: string): HTMLElement {
    const part = { body: h('div', { class: 'sac-body' }), hint: h('div', { class: 'muted' }), ids: TOPIC_SAC[topic] };
    this.sacParts.push(part);
    return part.body;
  }

  /** The discipline checkboxes, or the invitation to switch unofficial data on. */
  private renderSac(): void {
    this.sacBoxes.clear();
    for (const part of this.sacParts) {
      const names = part.ids.map((id) => SAC_DISCIPLINES[id].name.toLowerCase()).join(', ');
      if (!unofficial.enabled) {
        part.body.replaceChildren(
          h('div', { class: 'muted sac-note' }, `SAC route portal (${names}): SAC content without an open licence, loaded only if you switch unofficial data on. `, h('a', { href: '#', onclick: (event: Event) => { event.preventDefault(); this.showSettings(); } }, 'Open Settings')),
        );
        continue;
      }
      const rows = part.ids.flatMap((id) => {
        const discipline = SAC_DISCIPLINES[id];
        const swatch = h('i', { class: 'swatch' });
        swatch.style.background = discipline.colour;
        const box = h('input', {
          type: 'checkbox',
          checked: this.sac.enabled.has(id),
          onchange: () => {
            this.sac.setDiscipline(id, box.checked);
            this.onStateChange();
          },
        });
        this.sacBoxes.set(id, box);
        const label = h('label', { class: 'row' }, box, swatch, h('span', {}, `SAC ${discipline.name.toLowerCase()}`), info(SAC_NOTES[id] ?? SAC_NOTE));
        if (!discipline.scale) return [label];
        const filter = routeFilterUi(discipline.scale, this.sac.filters.get(id) ?? null, 'Height gain measured along the line on the map (takes a moment for many routes)', (value) => {
          this.sac.setFilter(id, value);
          this.onStateChange();
        });
        this.filterUis.set(id, filter);
        return [h('div', { class: 'filter-row' }, label, filter.toggle), filter.body];
      });
      part.body.replaceChildren(...rows, part.hint);
    }
    this.countActive();
  }

  private showSettings(): void {
    if (!this.settingsSection) return;
    (this.settingsSection as HTMLDetailsElement).open = true;
    this.settingsSection.scrollIntoView({ block: 'nearest' });
  }

  /** Unofficial data switched on or off in Settings. */
  private setUnofficial(on: boolean): void {
    unofficial.enabled = on;
    if (!on) {
      this.sac.setDisciplines([]);
      this.slfState.guru = false;
      void this.guru.setEnabled(false);
    }
    this.renderSac();
    this.syncOverlay(GURU_PARENT);
    this.onStateChange();
  }

  syncSac(): void {
    for (const [id, box] of this.sacBoxes) box.checked = this.sac.enabled.has(id);
    this.countActive();
  }

  // ── Presets ──

  private buildPresets(): HTMLElement {
    const select = h('select', {
      class: 'wide preset',
      title: 'Replace the current layers with a ready-made combination',
      onchange: () => {
        const preset = PRESETS.find((p) => p.id === select.value);
        select.value = ''; // acts as a menu: the layers below show what is active
        if (preset) void this.applyPreset(preset);
      },
    });
    select.append(h('option', { value: '' }, 'Apply preset…'));
    for (const preset of PRESETS) select.append(h('option', { value: preset.id }, preset.name));
    const plan = h('button', { type: 'button', class: 'plan-button', title: 'Draw a route on the map: distance, ascent, elevation profile, GPX export', onclick: () => this.onPlan() }, '✎ Plan a route');
    const open = h('button', { type: 'button', class: 'plan-button', title: 'Show recorded tracks from GPX, TCX or FIT files on the map (or drop the files on the page)', onclick: () => this.onImport() }, '⇪ Import track');
    return h('div', { class: 'section-body preset-box' }, select, h('div', { class: 'plan-row' }, plan, open));
  }

  private presetToken = 0;

  async applyPreset(preset: Preset): Promise<void> {
    const token = ++this.presetToken;
    await this.layers.setBase(preset.base);
    if (token !== this.presetToken) return;
    this.syncBase();
    for (const id of [...this.layers.overlays.keys()]) {
      await this.layers.setOverlay(id, false);
      if (token !== this.presetToken) return;
    }
    for (const overlay of preset.overlays) {
      await this.layers.setOverlay(overlay.id, true, { opacity: overlay.opacity });
      if (token !== this.presetToken) return;
    }
    this.syncAllOverlays();

    const s = this.slfState;
    s.snow = preset.slf?.snow ?? '';
    s.snowDate = '';
    s.bulletin = preset.slf?.bulletin ?? false;
    if (preset.slf?.snowOpacity !== undefined) s.snowOpacity = preset.slf.snowOpacity;
    if (preset.slf?.bulletinOpacity !== undefined) s.bulletinOpacity = preset.slf.bulletinOpacity;
    s.stations = preset.slf?.stations ?? '';
    s.avalanches = preset.slf?.avalanches ?? false;
    s.guru = false;
    void this.guru.setEnabled(false);
    this.sac.setDisciplines(unofficial.enabled ? (preset.sac ?? []) : []);
    for (const d of [...this.sac.filters.keys()]) {
      this.sac.setFilter(d, null);
      this.showRouteFilter(d, null);
    }
    for (const spec of this.routes) {
      const on = preset.routes?.includes(spec.id) ?? false;
      this.showRoute(spec.id, on);
      this.onRoute(spec.id, on);
      this.onRouteFilter(spec.id, null);
      this.showRouteFilter(spec.id, null);
    }
    this.showHuts(Boolean(preset.huts));
    this.onHuts(Boolean(preset.huts));
    this.showReports(false);
    this.onReports(false, Number(this.reportSpans[0]?.value) || 7);
    if (this.weatherBox.checked) {
      this.weatherBox.checked = false;
      this.onWeather(false);
    }
    if (this.webcamBox.checked) {
      this.webcamBox.checked = false;
      this.onWebcams(false);
    }
    this.syncSac();
    void this.slf.setSnowMap(s.snow || null, undefined, s.snowOpacity);
    void this.slf.setBulletin(s.bulletin, s.bulletinOpacity);
    void this.slf.setStations(s.stations || null);
    void this.slf.setAvalanches(s.avalanches);
    this.syncSlf();
    if (preset.topic) this.openSection(preset.topic);
    this.onStateChange();
  }

  /** Rebuild the SLF controls from the current state. */
  syncSlf(): void {
    this.slfBox.replaceChildren(...this.buildSlf());
    this.countActive();
  }

  /** Sunlight mode tones the generic relief shading down so it does not compete with real shadows. */
  setReliefScale(scale: number): void {
    if (scale === this.reliefScale) return;
    this.reliefScale = scale;
    this.map.setPaintProperty('hillshade', 'hillshade-exaggeration', this.terrain.hillshade * scale);
  }

  // ── Base map & terrain ──

  private buildBaseAndTerrain(): HTMLElement {
    const select = h('select', { class: 'wide', onchange: () => this.pickBase(select.value) });
    select.append(h('option', { value: '' }, 'None (relief only)'));
    for (const [group, defs] of groupBy(CATALOG.filter((l) => l.role === 'base'), (l) => l.group)) {
      const optgroup = h('optgroup', { label: group });
      for (const def of defs) optgroup.append(h('option', { value: def.id }, def.name));
      select.append(optgroup);
    }
    this.baseSelect = select;
    const made = this.topic(
      'base',
      '🗺️ Base map & terrain',
      true,
      select,
      this.baseParamBox,
      h('div', { class: 'group-title' }, 'Terrain'),
      ...this.buildTerrainControls(),
    );
    this.sections.set('terrain', made);
    return made;
  }

  private pickBase(id: string): void {
    void this.layers.setBase(id || null).then(() => this.syncBase());
    // Without a base map the colour relief makes the terrain readable.
    if (!id && !this.terrain.colorRelief) this.setColorRelief(true);
  }

  syncBase(): void {
    this.baseSelect.value = this.layers.baseId ?? '';
    this.applyWater();
    const def = this.layers.baseId ? byId.get(this.layers.baseId) : undefined;
    this.baseParamBox.replaceChildren();
    if (def?.param) {
      const control = paramControl(def, this.layers.baseParam, (value) => void this.layers.setBase(def.id, value));
      if (control) this.baseParamBox.append(h('label', {}, 'Date '), control);
    }
    if (def?.note) this.baseParamBox.append(info(def.note));
  }

  // ── Overlays ──

  private overlayRow(def: LayerDef): HTMLElement {
    const checkbox = h('input', {
      type: 'checkbox',
      onchange: async () => {
        if (checkbox.checked && def.needsProxy && !(await this.layers.proxyAvailable())) {
          checkbox.checked = false;
          this.layers.onError(`"${def.name}" has no CORS headers. Run via "npm run dev" or set a CORS proxy under Settings.`);
          return;
        }
        await this.layers.setOverlay(def.id, checkbox.checked);
        this.syncOverlay(def.id);
      },
    });
    const extra = h('div', { class: 'row-extra' });
    if (!this.overlayRows.has(def.id)) this.overlayRows.set(def.id, []);
    this.overlayRows.get(def.id)!.push({ extra, checkbox });
    const label = h('label', { class: 'row' }, checkbox, h('span', {}, OVERLAY_NAMES[def.id] ?? def.name), OVERLAY_NOTES[def.id] ? info(OVERLAY_NOTES[def.id]) : null, def.needsProxy ? h('span', { class: 'badge', title: 'Needs dev server or CORS proxy' }, 'proxy') : null);
    return h('div', {}, label, extra);
  }

  syncOverlay(id: string): void {
    const def = byId.get(id);
    if (!def) return;
    for (const row of this.overlayRows.get(id) ?? []) this.syncOverlayRow(id, def, row);
    this.countActive();
  }

  private syncOverlayRow(id: string, def: LayerDef, row: { extra: HTMLElement; checkbox: HTMLInputElement }): void {
    const state = this.layers.overlays.get(id);
    row.checkbox.checked = !!state;
    row.extra.replaceChildren();
    if (id === GURU_PARENT && !state && this.slfState.guru) {
      // The risk ratings make no sense without the routes they belong to.
      this.slfState.guru = false;
      void this.guru.setEnabled(false);
      this.onStateChange();
    }
    if (!state) return;
    row.extra.append(slider(state.opacity, 0, 1, 0.05, (v) => this.layers.setOverlayOpacity(id, v), 'Opacity'));
    const control = paramControl(def, state.param, (value) => void this.layers.setOverlayParam(id, value));
    if (control) row.extra.append(control);
    if (id === GURU_PARENT && unofficial.enabled) {
      const s = this.slfState;
      const box = h('input', {
        type: 'checkbox',
        checked: s.guru,
        onchange: () => {
          s.guru = box.checked;
          void this.guru.setEnabled(s.guru);
          this.onStateChange();
        },
      });
      row.extra.append(
        h(
          'label',
          { class: 'row sub-option', title: 'Ski tours across the Alps with Skitourenguru\'s avalanche risk rating for today. Downloads about 14 MB.' },
          box,
          h('span', {}, 'Skitourenguru risk rating'),
          h('span', { class: 'badge', title: 'Unofficial use of Skitourenguru data' }, 'unofficial'),
        ),
      );
    }
  }

  syncAllOverlays(): void {
    for (const id of this.overlayRows.keys()) this.syncOverlay(id);
  }

  // ── SLF snow & avalanche ──

  private buildSlf(): HTMLElement[] {
    const s = this.slfState;
    const changed = () => this.onStateChange();

    // One click per snow map: a row of buttons, the active one highlighted.
    const snowButtons = h('div', { class: 'segmented', role: 'group', 'aria-label': 'Snow map' });
    const markSnow = () => {
      for (const button of snowButtons.children) button.classList.toggle('on', (button as HTMLElement).dataset.key === s.snow);
    };
    const snowChoices: [string, string, string][] = [['', 'Off', 'No snow map'], ...Object.entries(SNOW_PRODUCTS).map(([key, product]): [string, string, string] => [key, product.short, product.name])];
    for (const [key, label, title] of snowChoices) {
      snowButtons.append(
        h('button', { type: 'button', title, 'data-key': key, onclick: () => {
          s.snow = key as SnowProduct | '';
          markSnow();
          applySnow();
        } }, label),
      );
    }
    markSnow();
    const snowDate = h('input', { type: 'date', value: s.snowDate, max: new Date().toISOString().slice(0, 10), title: 'Date (empty = latest)' });
    const applySnow = () => {
      s.snowDate = snowDate.value;
      void this.slf.setSnowMap(s.snow || null, s.snowDate || undefined, s.snowOpacity);
      changed();
    };
    snowDate.onchange = applySnow;
    const snowOpacity = slider(s.snowOpacity, 0, 1, 0.05, (v) => {
      s.snowOpacity = v;
      this.slf.setSnowOpacity(v);
    }, 'Opacity');

    const bulletin = h('input', {
      type: 'checkbox',
      checked: s.bulletin,
      onchange: () => {
        s.bulletin = bulletin.checked;
        void this.slf.setBulletin(s.bulletin, s.bulletinOpacity);
        changed();
      },
    });
    const bulletinOpacity = slider(s.bulletinOpacity, 0, 1, 0.05, (v) => {
      s.bulletinOpacity = v;
      this.slf.setBulletinOpacity(v);
    }, 'Opacity');

    const stations = h('select', { class: 'wide' }, h('option', { value: '' }, 'Stations: off'));
    for (const [key, type] of Object.entries(STATION_TYPES)) stations.append(h('option', { value: key, selected: s.stations === key }, `Stations: ${type.name}`));
    stations.onchange = () => {
      s.stations = stations.value as StationType | '';
      void this.slf.setStations(s.stations || null);
      changed();
    };

    const avalanches = h('input', {
      type: 'checkbox',
      checked: s.avalanches,
      onchange: () => {
        s.avalanches = avalanches.checked;
        void this.slf.setAvalanches(s.avalanches);
        changed();
      },
    });

    stations.classList.add('counted');
    return [
      h('div', { class: 'group-title' }, 'Snow map (SLF)'),
      snowButtons,
      h('div', { class: 'row-extra' }, snowOpacity, snowDate),
      h('label', { class: 'row' }, bulletin, h('span', {}, 'Avalanche bulletin (danger level)')),
      h('div', { class: 'row-extra' }, bulletinOpacity),
      stations,
      h('label', { class: 'row' }, avalanches, h('span', {}, 'Recent avalanches')),
    ];
  }

  // ── Terrain ──

  private colorReliefBox!: HTMLInputElement;

  private setColorRelief(on: boolean): void {
    this.terrain.colorRelief = on;
    if (this.colorReliefBox) this.colorReliefBox.checked = on;
    this.map.setLayoutProperty('color-relief', 'visibility', on ? 'visible' : 'none');
    this.applyWater();
    this.onStateChange();
  }

  /** Blue water belongs to the relief view: without a base map, or under elevation colours that cover it. */
  private applyWater(): void {
    const show = this.terrain.water && (!this.layers.baseId || this.terrain.colorRelief);
    for (const id of WATER_LAYERS) this.map.setLayoutProperty(id, 'visibility', show ? 'visible' : 'none');
  }

  applyTerrain(): void {
    const t = this.terrain;
    this.map.setTerrain({ source: 'dem', exaggeration: t.exaggeration });
    this.map.setPaintProperty('hillshade', 'hillshade-exaggeration', t.hillshade * this.reliefScale);
    this.map.setLayoutProperty('hillshade', 'visibility', t.hillshade > 0 ? 'visible' : 'none');
    this.map.setLayoutProperty('color-relief', 'visibility', t.colorRelief ? 'visible' : 'none');
    this.map.setPaintProperty('color-relief', 'color-relief-opacity', t.colorReliefOpacity);
    this.applyWater();
  }

  private buildTerrainControls(): HTMLElement[] {
    const t = this.terrain;
    const exaggerationLabel = h('span', { class: 'value' }, `${t.exaggeration.toFixed(1)}×`);
    this.colorReliefBox = h('input', { type: 'checkbox', checked: t.colorRelief, onchange: () => this.setColorRelief(this.colorReliefBox.checked) });
    return [
      h('label', { class: 'row' }, h('span', {}, 'Vertical exaggeration'), exaggerationLabel),
      slider(t.exaggeration, 1, 3, 0.1, (v) => {
        t.exaggeration = v;
        exaggerationLabel.textContent = `${v.toFixed(1)}×`;
        this.map.setTerrain({ source: 'dem', exaggeration: v });
        this.onStateChange();
      }),
      h('label', { class: 'row' }, h('span', {}, 'Relief shading')),
      slider(t.hillshade, 0, 1, 0.05, (v) => {
        t.hillshade = v;
        this.applyTerrain();
        this.onStateChange();
      }),
      h('label', { class: 'row' }, this.colorReliefBox, h('span', {}, 'Elevation colours')),
      h(
        'div',
        { class: 'row-extra' },
        slider(t.colorReliefOpacity, 0.1, 1, 0.05, (v) => {
          t.colorReliefOpacity = v;
          this.map.setPaintProperty('color-relief', 'color-relief-opacity', v);
          this.onStateChange();
        }, 'Strength of the elevation colours'),
      ),
      h(
        'label',
        { class: 'row', title: 'Shown without a base map or with elevation colours' },
        h('input', {
          type: 'checkbox',
          checked: t.water,
          onchange: (e: Event) => {
            t.water = (e.target as HTMLInputElement).checked;
            this.applyWater();
            this.onStateChange();
          },
        }),
        h('span', {}, 'Blue lakes and rivers'),
      ),
      h(
        'label',
        { class: 'row', title: 'Name, altitude and distance from the camera. Click a label to stand on that summit.' },
        h('input', {
          type: 'checkbox',
          checked: t.peaks,
          onchange: (e: Event) => {
            t.peaks = (e.target as HTMLInputElement).checked;
            this.onPeaks(t.peaks);
            this.onStateChange();
          },
        }),
        h('span', {}, 'Peak names'),
      ),
    ];
  }

  // ── Settings ──

  private buildSettings(): HTMLElement {
    const input = h('input', {
      type: 'text',
      class: 'wide',
      placeholder: 'e.g. https://my-proxy.example/?url=',
      value: this.layers.userProxy,
      onchange: () => (this.layers.userProxy = input.value.trim()),
    });
    const keys = (Object.keys(KEY_PROVIDERS) as KeyProvider[]).flatMap((provider) => {
      const field = h('input', {
        type: 'password',
        class: 'wide',
        autocomplete: 'off',
        placeholder: KEY_PROVIDERS[provider].help,
        value: this.layers.getKey(provider),
        onchange: () => {
          this.layers.setKey(provider, field.value.trim());
          this.onKey(provider);
          // Reload the base map if it was waiting for this key.
          const selected = byId.get(this.baseSelect.value);
          if (selected?.needsKey === provider) void this.layers.setBase(selected.id).then(() => this.syncBase());
        },
      });
      return [h('label', { class: 'row' }, h('span', {}, `${KEY_PROVIDERS[provider].name} API key`), info(`${KEY_PROVIDERS[provider].help}. Keys are stored in this browser only; they are not part of shared links.`)), field];
    });
    const unofficialBox = h('input', { type: 'checkbox', checked: unofficial.enabled, onchange: () => this.setUnofficial(unofficialBox.checked) });
    return (this.settingsSection = section(
      '⚙️ Settings',
      false,
      h('label', { class: 'row' }, unofficialBox, h('span', {}, 'Show unofficial third-party data'), info('SAC route portal lines and Skitourenguru risk ratings. This is their content, fetched live from their servers; no licence has been granted for showing it here. Off unless you switch it on in this browser.')),
      h(
        'div',
        { class: 'row' },
        h('span', {}, 'Mouse and keyboard controls'),
        info(
          'Drag: move. Wheel: zoom. Right-drag or Ctrl+drag: turn and tilt around the screen centre. ' +
            'Middle-drag or Shift+drag: look around from where the camera is. Ctrl+middle-drag: swing around the point under the cursor. ' +
            'Double middle-click: north up. Shift+wheel: move forward and back. Alt+wheel: time of day (sunlight on). ' +
            'Keys: W A S D move, Q E turn, R F tilt, Shift faster, N north up, L look mode, Ctrl+F search.',
        ),
      ),
      ...keys,
      h('label', { class: 'row' }, h('span', {}, 'CORS proxy prefix'), info('Only for layers marked "proxy" (SLF terrain maps). The tile URL is appended to this prefix. Not needed under "npm run dev".')),
      input,
    ));
  }

  // ── Legends (grouped inside one unified window below the main menu) ──

  private legendOpen = true;

  private renderLegends(): void {
    this.legendBox.replaceChildren();
    this.legendBox.hidden = this.legends.size === 0;
    if (this.legends.size === 0) return;

    const entryEl = (e: { color: string; label: string; shape?: 'swatch' | 'pill' | 'dot' }) =>
      h('div', { class: 'legend-entry' }, h('i', { class: e.shape ?? 'swatch', style: `background:${e.color}` }), e.label);

    const items = [...this.legends.values()].map((legend) => {
      const rows = legend.rows
        ? legend.rows.map((row) =>
            h(
              'div',
              { class: 'legend-entries' },
              row.heading ? h('span', { class: 'muted legend-row-heading' }, row.heading) : null,
              ...row.entries.map(entryEl),
            ),
          )
        : [h('div', { class: 'legend-entries' }, ...legend.entries.map(entryEl))];
      return h(
        'div',
        { class: 'legend-item' },
        h('div', { class: 'legend-title' }, legend.title + (legend.unit ? ` (${legend.unit})` : '')),
        legend.subtitle ? h('div', { class: 'muted' }, legend.subtitle) : null,
        ...rows,
      );
    });

    const win = h(
      'details',
      {
        class: 'legend-window',
        open: this.legendOpen,
        ontoggle: (e: Event) => (this.legendOpen = (e.target as HTMLDetailsElement).open),
      },
      h('summary', { class: 'legend-window-header' }, 'Legend'),
      h('div', { class: 'legend-window-body' }, ...items),
    );
    this.legendBox.append(win);
  }
}
