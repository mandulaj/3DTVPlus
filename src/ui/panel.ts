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
import { routeFilterUi, type RouteFilterUi } from './routeFilterUi';
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
  return h('details', { open, class: 'section' }, h('summary', {}, title), h('div', { class: 'section-body' }, ...children));
}

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
  private overlayRows = new Map<string, { extra: HTMLElement; checkbox: HTMLInputElement }>();
  private baseParamBox = h('div', { class: 'row-extra' });
  private baseSelect!: HTMLSelectElement;
  private slfBox = h('div');
  private sacBoxes = new Map<SacDiscipline, HTMLInputElement>();
  private sacHint = h('div', { class: 'muted' });
  private reliefScale = 1;
  /** Set by the app: switches the peak labels. */
  onPeaks: (on: boolean) => void = () => {};
  /** Set by the app: switches the weather forecast on the map. */
  onWeather: (on: boolean) => void = () => {};
  weatherBox = h('input', { type: 'checkbox', onchange: () => this.onWeather(this.weatherBox.checked) });
  /** Set by the app: opens or closes the route planner. */
  onPlan: () => void = () => {};

  constructor(
    private root: HTMLElement,
    private map: maplibregl.Map,
    private layers: LayerManager,
    private slf: SlfLayers,
    private guru: Skitourenguru,
    private sac: SacRoutes,
    readonly slfState: SlfState,
    readonly terrain: TerrainState,
    private onStateChange: () => void,
  ) {
    const onLegend = (key: string, legend: Legend | null) => {
      if (legend) this.legends.set(key, legend);
      else this.legends.delete(key);
      this.renderLegends();
    };
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
      this.buildBase(),
      this.slfBox,
      this.buildWeather(),
      this.buildSac(),
      this.buildOverlays(),
      this.buildTerrain(),
      this.buildSettings(),
    );
    this.syncSlf();
    this.root.append(toggle, body, this.legendBox);
    // On a phone the map comes first: the layer panel opens on demand.
    if (window.matchMedia('(max-width: 700px)').matches) this.root.classList.add('collapsed');
  }

  // ── Weather ──

  private buildWeather(): HTMLElement {
    return section(
      'Weather forecast',
      false,
      h('label', { class: 'row' }, this.weatherBox, h('span', {}, 'Towns and summits in view'), info('Lowest and highest temperature, weather and strongest wind (km/h, arrow shows where it blows to) for the day chosen at the top of the map. Model forecast from Open-Meteo; in and around Switzerland from the MeteoSwiss ICON model. Summit values are for summit height.')),
    );
  }

  // ── SAC routes ──

  private sacBody = h('div', { class: 'section-body sac-body' });
  onCamptocamp: (on: boolean) => void = () => {};
  onCamptocampFilter: (filter: RouteFilter | null) => void = () => {};
  private filterUis = new Map<string, RouteFilterUi>();

  /** Show a route filter that was set elsewhere (restored from the page address). Key: SAC discipline or "c2c". */
  showRouteFilter(key: string, filter: RouteFilter | null): void {
    this.filterUis.get(key)?.set(filter);
  }
  camptocampHint = h('div', { class: 'muted' });
  camptocampBox = h('input', { type: 'checkbox', onchange: () => this.onCamptocamp(this.camptocampBox.checked) });
  private settingsSection: HTMLElement | null = null;

  private buildSac(): HTMLElement {
    this.sac.onHint = (hint) => (this.sacHint.textContent = hint ?? '');
    this.renderSac();
    const wrapper = section('Routes (SAC, Camptocamp)', false);
    wrapper.querySelector('summary')?.append(info('Route lines from the SAC route portal. Click a route for difficulty and a link to its SAC page. Switzerland and nearby, from zoom 10.'));
    wrapper.querySelector('.section-body')?.replaceWith(this.sacBody);
    const swatch = h('i', { class: 'swatch' });
    swatch.style.background = '#e8590c';
    const c2cFilter = routeFilterUi('french', null, 'Height gain as listed on Camptocamp', (value) => this.onCamptocampFilter(value));
    this.filterUis.set('c2c', c2cFilter);
    wrapper.append(
      h(
        'div',
        { class: 'section-body' },
        h(
          'div',
          { class: 'filter-row' },
          h(
            'label',
            { class: 'row' },
            this.camptocampBox,
            swatch,
            h('span', {}, 'Camptocamp ski tours'),
            info('Ski touring routes from camptocamp.org (CC BY-SA), as a copy stored with this site: Switzerland, not updated live. Dots are routes without a drawn line. Click for details and a link. The route planner follows the lines. The filter uses Camptocamp\'s overall grade (F to ED).'),
          ),
          c2cFilter.toggle,
        ),
        c2cFilter.body,
        this.camptocampHint,
      ),
    );
    return wrapper;
  }

  /** The discipline checkboxes, or the invitation to switch unofficial data on. */
  private renderSac(): void {
    this.sacBoxes.clear();
    if (!unofficial.enabled) {
      this.sacBody.replaceChildren(
        h('div', { class: 'muted' }, 'Route lines from the SAC route portal are SAC content without an open licence. They are loaded from SAC only if you switch unofficial data on.'),
        h('button', { type: 'button', class: 'wide plan-button', onclick: () => this.showSettings() }, 'Open Settings'),
      );
      return;
    }
    const rows = (Object.keys(SAC_DISCIPLINES) as SacDiscipline[]).flatMap((id) => {
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
      const label = h('label', { class: 'row' }, box, swatch, h('span', {}, discipline.name));
      if (!discipline.scale) return [label];
      const filter = routeFilterUi(discipline.scale, this.sac.filters.get(id) ?? null, 'Height gain measured along the line on the map (takes a moment for many routes)', (value) => {
        this.sac.setFilter(id, value);
        this.onStateChange();
      });
      this.filterUis.set(id, filter);
      return [h('div', { class: 'filter-row' }, label, filter.toggle), filter.body];
    });
    this.sacBody.replaceChildren(...rows, this.sacHint);
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
    const plan = h('button', { type: 'button', class: 'wide plan-button', title: 'Draw a route on the map: distance, ascent, elevation profile, GPX export', onclick: () => this.onPlan() }, '✎ Plan a route');
    return h('div', { class: 'section-body preset-box' }, select, plan);
  }

  async applyPreset(preset: Preset): Promise<void> {
    await this.layers.setBase(preset.base);
    this.syncBase();
    for (const id of [...this.layers.overlays.keys()]) await this.layers.setOverlay(id, false);
    for (const overlay of preset.overlays) await this.layers.setOverlay(overlay.id, true, { opacity: overlay.opacity });
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
    this.camptocampBox.checked = Boolean(preset.c2c);
    this.onCamptocamp(this.camptocampBox.checked);
    this.syncSac();
    void this.slf.setSnowMap(s.snow || null, undefined, s.snowOpacity);
    void this.slf.setBulletin(s.bulletin, s.bulletinOpacity);
    void this.slf.setStations(s.stations || null);
    void this.slf.setAvalanches(s.avalanches);
    this.syncSlf();
    this.onStateChange();
  }

  /** Rebuild the SLF controls from the current state. */
  syncSlf(): void {
    const slfSection = this.buildSlf();
    slfSection.querySelector('summary')?.append(info('Click a region, station or avalanche on the map for details.'));
    this.slfBox.replaceChildren(slfSection);
  }

  /** Sunlight mode tones the generic relief shading down so it does not compete with real shadows. */
  setReliefScale(scale: number): void {
    if (scale === this.reliefScale) return;
    this.reliefScale = scale;
    this.map.setPaintProperty('hillshade', 'hillshade-exaggeration', this.terrain.hillshade * scale);
  }

  // ── Base map ──

  private buildBase(): HTMLElement {
    const select = h('select', { class: 'wide', onchange: () => this.pickBase(select.value) });
    select.append(h('option', { value: '' }, 'None (relief only)'));
    for (const [group, defs] of groupBy(CATALOG.filter((l) => l.role === 'base'), (l) => l.group)) {
      const optgroup = h('optgroup', { label: group });
      for (const def of defs) optgroup.append(h('option', { value: def.id }, def.name));
      select.append(optgroup);
    }
    this.baseSelect = select;
    return section('Base map', true, select, this.baseParamBox);
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

  private buildOverlays(): HTMLElement {
    const container = h('div', {});
    for (const [group, defs] of groupBy(CATALOG.filter((l) => l.role === 'overlay'), (l) => l.group)) {
      container.append(h('div', { class: 'group-title' }, group));
      for (const def of defs) container.append(this.overlayRow(def));
    }
    return section('Overlays', false, container);
  }

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
    this.overlayRows.set(def.id, { extra, checkbox });
    const label = h('label', { class: 'row' }, checkbox, h('span', {}, def.name), def.needsProxy ? h('span', { class: 'badge', title: 'Needs dev server or CORS proxy' }, 'proxy') : null);
    return h('div', {}, label, extra);
  }

  syncOverlay(id: string): void {
    const row = this.overlayRows.get(id);
    const def = byId.get(id);
    if (!row || !def) return;
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

  private buildSlf(): HTMLElement {
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

    return section(
      'Snow & avalanches (SLF, Switzerland)',
      true,
      h('div', { class: 'group-title' }, 'Snow map'),
      snowButtons,
      h('div', { class: 'row-extra' }, snowOpacity, snowDate),
      h('label', { class: 'row' }, bulletin, h('span', {}, 'Avalanche bulletin (danger level)')),
      h('div', { class: 'row-extra' }, bulletinOpacity),
      stations,
      h('label', { class: 'row' }, avalanches, h('span', {}, 'Recent avalanches')),
    );
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

  private buildTerrain(): HTMLElement {
    const t = this.terrain;
    const exaggerationLabel = h('span', { class: 'value' }, `${t.exaggeration.toFixed(1)}×`);
    this.colorReliefBox = h('input', { type: 'checkbox', checked: t.colorRelief, onchange: () => this.setColorRelief(this.colorReliefBox.checked) });
    return section(
      'Terrain',
      false,
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
    );
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
          // Reload the base map if it was waiting for this key.
          const selected = byId.get(this.baseSelect.value);
          if (selected?.needsKey === provider) void this.layers.setBase(selected.id).then(() => this.syncBase());
        },
      });
      return [h('label', { class: 'row' }, h('span', {}, `${KEY_PROVIDERS[provider].name} API key`), info(`${KEY_PROVIDERS[provider].help}. Keys are stored in this browser only; they are not part of shared links.`)), field];
    });
    const unofficialBox = h('input', { type: 'checkbox', checked: unofficial.enabled, onchange: () => this.setUnofficial(unofficialBox.checked) });
    return (this.settingsSection = section(
      'Settings',
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

  // ── Legends ──

  private renderLegends(): void {
    this.legendBox.replaceChildren();
    for (const legend of this.legends.values()) {
      this.legendBox.append(
        h(
          'div',
          { class: 'legend' },
          h('div', { class: 'legend-title' }, legend.title + (legend.unit ? ` (${legend.unit})` : '')),
          legend.subtitle ? h('div', { class: 'muted' }, legend.subtitle) : null,
          h('div', { class: 'legend-entries' }, ...legend.entries.map((e) => h('div', { class: 'legend-entry' }, h('i', { style: `background:${e.color}` }), e.label))),
        ),
      );
    }
  }
}
