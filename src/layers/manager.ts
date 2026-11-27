import type * as maplibregl from 'maplibre-gl';
import type { LayerSpecification, SourceSpecification, StyleSpecification } from 'maplibre-gl';
import { DEFAULT_GLYPHS, SLOT } from '../map';
import { KEY_PROVIDERS, byId, defaultParam, type KeyProvider, type LayerDef } from './catalog';

const PROXY_KEY = 'terrain-viewer.corsProxy';
const KEY_PREFIX = 'terrain-viewer.apiKey.';
const DEV_PROXY = '/proxy/slf-map';
const DEV_PROXY_HOST = 'https://map.slf.ch';

export interface OverlayState {
  opacity: number;
  param?: string;
}

/** Adds and removes catalogue layers on the map, keeping draw order via slots. */
export class LayerManager {
  baseId: string | null = null;
  baseParam: string | undefined;
  readonly overlays = new Map<string, OverlayState>();
  onChange: () => void = () => {};
  onError: (message: string) => void = () => {};

  private baseToken = 0;
  private baseLayerIds: string[] = [];
  private baseSourceIds: string[] = [];
  private devProxy: Promise<boolean> | null = null;

  constructor(private map: maplibregl.Map) {}

  // ── CORS proxy for the few hosts without CORS headers ──

  get userProxy(): string {
    try {
      return localStorage.getItem(PROXY_KEY) ?? '';
    } catch {
      return '';
    }
  }

  set userProxy(value: string) {
    try {
      if (value) localStorage.setItem(PROXY_KEY, value);
      else localStorage.removeItem(PROXY_KEY);
    } catch {
      /* storage unavailable: setting lasts for this session only */
    }
  }

  /** API keys stay in this browser's storage: never in the page URL or the built file. */
  getKey(provider: KeyProvider): string {
    try {
      return localStorage.getItem(KEY_PREFIX + provider) ?? '';
    } catch {
      return this.sessionKeys.get(provider) ?? '';
    }
  }

  setKey(provider: KeyProvider, value: string): void {
    this.sessionKeys.set(provider, value);
    try {
      if (value) localStorage.setItem(KEY_PREFIX + provider, value);
      else localStorage.removeItem(KEY_PREFIX + provider);
    } catch {
      /* storage unavailable: key lasts for this session only */
    }
  }
  private sessionKeys = new Map<KeyProvider, string>();

  /** True when the page is served by `vite dev`/`vite preview`, which proxy map.slf.ch. */
  hasDevProxy(): Promise<boolean> {
    this.devProxy ??= fetch(`${DEV_PROXY}/mapcache/wmts/1.0.0/ch.slf.globalslope/default/GoogleMapsCompatible/8/89/133.png`)
      .then((r) => r.ok && (r.headers.get('content-type') ?? '').startsWith('image/'))
      .catch(() => false);
    return this.devProxy;
  }

  async proxyAvailable(): Promise<boolean> {
    return this.userProxy !== '' || (await this.hasDevProxy());
  }

  private async resolveTiles(def: LayerDef, param: string | undefined): Promise<string> {
    let url = def.resolveTiles ? await def.resolveTiles() : def.tiles!;
    if (def.param) url = url.replace('{param}', param ?? defaultParam(def)!);
    if (def.needsKey) {
      const key = this.getKey(def.needsKey);
      if (!key) throw new Error(`"${def.name}" needs a ${KEY_PROVIDERS[def.needsKey].name} API key. Enter it under Settings.`);
      url = url.replace('{key}', encodeURIComponent(key));
    }
    if (def.needsProxy) {
      if (this.userProxy) {
        if (!/^https?:\/\//i.test(this.userProxy)) throw new Error('CORS proxy prefix must start with http:// or https://');
        url = this.userProxy + (this.userProxy.includes('?') ? encodeURIComponent(url) : url);
      } else if (await this.hasDevProxy()) url = url.replace(DEV_PROXY_HOST, DEV_PROXY);
      else throw new Error(`"${def.name}" needs a CORS proxy (see Settings).`);
    }
    return url;
  }

  private rasterSource(def: LayerDef, url: string): SourceSpecification {
    return {
      type: 'raster',
      tiles: [url],
      tileSize: def.tileSize ?? 256,
      minzoom: def.minzoom ?? 0,
      maxzoom: def.maxzoom ?? 18,
      attribution: def.attribution,
    };
  }

  // ── Base map ──

  async setBase(id: string | null, param?: string): Promise<void> {
    const token = ++this.baseToken;
    const def = id ? byId.get(id) : undefined;
    if (id && (!def || def.role !== 'base')) return;

    let prepared: { sources: Record<string, SourceSpecification>; layers: LayerSpecification[]; style?: StyleSpecification } = {
      sources: {},
      layers: [],
    };
    try {
      if (def?.kind === 'raster') {
        const url = await this.resolveTiles(def, param);
        prepared.sources['base:raster'] = this.rasterSource(def, url);
        prepared.layers.push({ id: 'base:raster', type: 'raster', source: 'base:raster', paint: { 'raster-fade-duration': 150 } });
      } else if (def?.kind === 'style') {
        prepared = await this.loadExternalStyle(def);
      }
    } catch (err) {
      this.onError(`Base map failed: ${(err as Error).message}`);
      return;
    }
    if (token !== this.baseToken) return; // superseded by a newer selection

    for (const layerId of this.baseLayerIds) if (this.map.getLayer(layerId)) this.map.removeLayer(layerId);
    for (const sourceId of this.baseSourceIds) if (this.map.getSource(sourceId)) this.map.removeSource(sourceId);

    this.map.setGlyphs(prepared.style?.glyphs ?? DEFAULT_GLYPHS);
    if (prepared.style?.sprite) this.map.setSprite(prepared.style.sprite as string);
    for (const [sourceId, source] of Object.entries(prepared.sources)) this.map.addSource(sourceId, source);
    for (const layer of prepared.layers) this.map.addLayer(layer, SLOT.base);

    this.baseLayerIds = prepared.layers.map((l) => l.id);
    this.baseSourceIds = Object.keys(prepared.sources);
    this.baseId = id;
    this.baseParam = def?.param ? (param ?? defaultParam(def)) : undefined;
    this.onChange();
  }

  /** Fetch a third-party vector style and namespace its sources/layers so it can live inside ours. */
  private async loadExternalStyle(def: LayerDef) {
    const response = await fetch(def.styleUrl!);
    if (!response.ok) throw new Error(`style ${response.status}`);
    const style = (await response.json()) as StyleSpecification;
    const sources: Record<string, SourceSpecification> = {};
    for (const [sourceId, source] of Object.entries(style.sources)) {
      sources[`base:${sourceId}`] = { ...source, attribution: def.attribution } as SourceSpecification;
    }
    const layers = style.layers.map((layer) => {
      const copy = { ...layer, id: `base:${layer.id}` } as LayerSpecification & { source?: string };
      if (copy.source) copy.source = `base:${copy.source}`;
      return copy as LayerSpecification;
    });
    return { sources, layers, style };
  }

  // ── Overlays ──

  async setOverlay(id: string, on: boolean, state?: Partial<OverlayState>): Promise<void> {
    const def = byId.get(id);
    if (!def || def.role !== 'overlay') return;
    const layerId = `ov:${id}`;
    if (this.map.getLayer(layerId)) this.map.removeLayer(layerId);
    if (this.map.getSource(layerId)) this.map.removeSource(layerId);
    if (!on) {
      this.overlays.delete(id);
      this.onChange();
      return;
    }
    const current: OverlayState = {
      opacity: state?.opacity ?? this.overlays.get(id)?.opacity ?? def.opacity ?? 1,
      param: state?.param ?? this.overlays.get(id)?.param ?? defaultParam(def),
    };
    this.overlays.set(id, current);
    try {
      const url = await this.resolveTiles(def, current.param);
      if (!this.overlays.has(id) || this.map.getSource(layerId)) return; // toggled again meanwhile
      this.map.addSource(layerId, this.rasterSource(def, url));
      this.map.addLayer(
        { id: layerId, type: 'raster', source: layerId, paint: { 'raster-opacity': current.opacity, 'raster-fade-duration': 150 } },
        SLOT.overlay,
      );
    } catch (err) {
      this.overlays.delete(id);
      this.onError((err as Error).message);
    }
    this.onChange();
  }

  setOverlayOpacity(id: string, opacity: number): void {
    const state = this.overlays.get(id);
    if (!state) return;
    state.opacity = opacity;
    if (this.map.getLayer(`ov:${id}`)) this.map.setPaintProperty(`ov:${id}`, 'raster-opacity', opacity);
    this.onChange();
  }

  setOverlayParam(id: string, param: string): Promise<void> {
    return this.setOverlay(id, true, { param });
  }

  // ── URL state ──

  serializeOverlays(): string {
    return [...this.overlays.entries()]
      .map(([id, s]) => {
        const def = byId.get(id)!;
        const parts = [id, String(Math.round(s.opacity * 100))];
        if (def.param && s.param) parts.push(s.param);
        return parts.join('~');
      })
      .join(',');
  }

  async restoreOverlays(text: string): Promise<void> {
    for (const entry of text.split(',').filter(Boolean)) {
      const [id, opacity, param] = entry.split('~');
      const value = Number(opacity);
      await this.setOverlay(id, true, { opacity: Number.isFinite(value) ? value / 100 : undefined, param: param || undefined });
    }
  }
}
