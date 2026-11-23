import type * as maplibregl from 'maplibre-gl';
import { CATALOG, KEY_PROVIDERS, byId, defaultParam, type KeyProvider, type LayerDef } from '../layers/catalog';
import type { LayerManager } from '../layers/manager';
import { PRESETS, type Preset } from '../layers/presets';
import { SNOW_PRODUCTS, STATION_TYPES, type Legend, type SlfLayers, type SnowProduct, type StationType } from '../layers/slf';
import { WATER_LAYERS } from '../map';
import { h, slider } from './dom';

export interface SlfState {
  snow: SnowProduct | '';
  snowDate: string;
  snowOpacity: number;
  bulletin: boolean;
  bulletinOpacity: number;
  stations: StationType | '';
  avalanches: boolean;
}

export interface TerrainState {
  exaggeration: number;
  hillshade: number;
  colorRelief: boolean;
  /** Draw lakes and rivers in blue where no base map shows them. */
  water: boolean;
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

export class Panel {
  private legends = new Map<string, Legend>();
  private legendBox = h('div', { class: 'legends' });
  private overlayRows = new Map<string, { extra: HTMLElement; checkbox: HTMLInputElement }>();
  private baseParamBox = h('div', { class: 'row-extra' });
  private baseSelect!: HTMLSelectElement;
  private slfBox = h('div');
  private reliefScale = 1;

  constructor(
    private root: HTMLElement,
    private map: maplibregl.Map,
    private layers: LayerManager,
    private slf: SlfLayers,
    readonly slfState: SlfState,
    readonly terrain: TerrainState,
    private onStateChange: () => void,
  ) {
    slf.onLegend = (key, legend) => {
      if (legend) this.legends.set(key, legend);
      else this.legends.delete(key);
      this.renderLegends();
    };
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
      this.buildOverlays(),
      this.buildTerrain(),
      this.buildSettings(),
    );
    this.syncSlf();
    this.root.append(toggle, body, this.legendBox);
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
    return h('div', { class: 'section-body preset-box' }, select);
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
    s.stations = preset.slf?.stations ?? '';
    s.avalanches = preset.slf?.avalanches ?? false;
    void this.slf.setSnowMap(s.snow || null, undefined, s.snowOpacity);
    void this.slf.setBulletin(s.bulletin, s.bulletinOpacity);
    void this.slf.setStations(s.stations || null);
    void this.slf.setAvalanches(s.avalanches);
    this.syncSlf();
    this.onStateChange();
  }

  /** Rebuild the SLF controls from the current state. */
  syncSlf(): void {
    this.slfBox.replaceChildren(this.buildSlf());
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
    if (def?.note) this.baseParamBox.append(h('div', { class: 'muted' }, def.note));
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
    if (!state) return;
    row.extra.append(slider(state.opacity, 0, 1, 0.05, (v) => this.layers.setOverlayOpacity(id, v), 'Opacity'));
    const control = paramControl(def, state.param, (value) => void this.layers.setOverlayParam(id, value));
    if (control) row.extra.append(control);
  }

  syncAllOverlays(): void {
    for (const id of this.overlayRows.keys()) this.syncOverlay(id);
  }

  // ── SLF snow & avalanche ──

  private buildSlf(): HTMLElement {
    const s = this.slfState;
    const changed = () => this.onStateChange();

    const snowSelect = h('select', { class: 'wide' }, h('option', { value: '' }, 'Snow map: off'));
    for (const [key, product] of Object.entries(SNOW_PRODUCTS)) snowSelect.append(h('option', { value: key, selected: s.snow === key }, product.name));
    const snowDate = h('input', { type: 'date', value: s.snowDate, max: new Date().toISOString().slice(0, 10), title: 'Date (empty = latest)' });
    const applySnow = () => {
      s.snow = snowSelect.value as SnowProduct | '';
      s.snowDate = snowDate.value;
      void this.slf.setSnowMap(s.snow || null, s.snowDate || undefined, s.snowOpacity);
      changed();
    };
    snowSelect.onchange = applySnow;
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
      snowSelect,
      h('div', { class: 'row-extra' }, snowOpacity, snowDate),
      h('label', { class: 'row' }, bulletin, h('span', {}, 'Avalanche bulletin (danger level)')),
      h('div', { class: 'row-extra' }, bulletinOpacity),
      stations,
      h('label', { class: 'row' }, avalanches, h('span', {}, 'Recent avalanches')),
      h('div', { class: 'muted' }, 'Click a region, station or avalanche for details.'),
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
      return [h('label', { class: 'row' }, h('span', {}, `${KEY_PROVIDERS[provider].name} API key`)), field];
    });
    return section(
      'Settings',
      false,
      ...keys,
      h('div', { class: 'muted' }, 'Keys are stored in this browser only; they are not part of the shared URL.'),
      h('label', { class: 'row' }, h('span', {}, 'CORS proxy prefix')),
      input,
      h('div', { class: 'muted' }, 'Only for layers marked "proxy" (SLF terrain maps). The tile URL is appended to this prefix. Not needed under "npm run dev".'),
    );
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
