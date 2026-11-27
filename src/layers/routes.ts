// Click on a swisstopo ski or snowshoe route: look the route up at geo.admin.ch and show its
// details with a link to the SAC route portal (the route network on these layers is the SAC's).
import { previewRoute } from '../routePreview';
import type * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource } from 'maplibre-gl';
import { interaction } from '../interaction';
import { SLOT } from '../map';
import { describeStats, linesOf, trackStats } from '../trackStats';
import type { LayerManager } from './manager';

/** Overlay id in catalog.ts → layer id at geo.admin.ch. */
const ROUTE_LAYERS: Record<string, string> = {
  'ch-skitouren': 'ch.swisstopo-karto.skitouren',
  'ch-snowshoe': 'ch.swisstopo-karto.schneeschuhrouten',
};
const IDENTIFY = 'https://api3.geo.admin.ch/rest/services/all/MapServer/identify';
const HIGHLIGHT = 'route-highlight';
const CLICK_RADIUS = 9; // px

const escapeHtml = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const safeHref = (url: unknown): string | null => (typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null);

interface RouteResult {
  layerBodId: string;
  geometry?: GeoJSON.Geometry;
  properties?: Record<string, string | number | null>;
  attributes?: Record<string, string | number | null>;
}

export function enableRouteInfo(map: maplibregl.Map, layers: LayerManager, popup: maplibregl.Popup): void {
  let request = 0;
  let controller: AbortController | null = null;

  const clear = () => (map.getSource(HIGHLIGHT) as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: [] });
  popup.on('close', clear);

  function active(): string[] {
    return Object.keys(ROUTE_LAYERS).filter((id) => layers.overlays.has(id));
  }

  map.on('click', async (event) => {
    const wanted = active();
    if (!wanted.length || map.getZoom() < 10 || interaction.drawing) return;
    const { x, y } = event.point;
    // Vector point/line layers take priority over async raster identify.
    const vectorLayers = map
      .getStyle()
      .layers.map((l) => l.id)
      .filter((id) => ['slf-stations', 'slf-avalanches', 'guru-routes', 'sac-routes-casing', 'sac-climbing'].includes(id) || /^routes-.*-(casing|point)$/.test(id));
    if (vectorLayers.length && map.queryRenderedFeatures([[x - 6, y - 6], [x + 6, y + 6]], { layers: vectorLayers }).length) return;
    const token = ++request;
    controller?.abort();
    controller = new AbortController();
    const a = map.unproject([x - CLICK_RADIUS, y + CLICK_RADIUS]);
    const b = map.unproject([x + CLICK_RADIUS, y - CLICK_RADIUS]);
    const box = [Math.min(a.lng, b.lng), Math.min(a.lat, b.lat), Math.max(a.lng, b.lng), Math.max(a.lat, b.lat)].map((v) => v.toFixed(6)).join(',');
    const query = new URLSearchParams({
      geometryType: 'esriGeometryEnvelope',
      geometry: box,
      mapExtent: box,
      imageDisplay: '100,100,96',
      tolerance: '0',
      sr: '4326',
      layers: `all:${wanted.map((id) => ROUTE_LAYERS[id]).join(',')}`,
      returnGeometry: 'true',
      geometryFormat: 'geojson',
      lang: 'en',
      limit: '10',
    });
    let results: RouteResult[];
    try {
      const response = await fetch(`${IDENTIFY}?${query}`, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(10000)]) });
      if (!response.ok) return;
      results = (await response.json()).results ?? [];
    } catch {
      return; // lookup service unreachable or aborted: the map still works
    }
    if (token !== request) return;
    // Many drawn segments carry no description: prefer one that does.
    const described = results.map((r) => ({ r, p: r.properties ?? r.attributes ?? {} })).filter(({ p }) => p.target_name || p.url_sac_en);
    if (!described.length) return;
    // Several routes here: the one with a portal page first, the others listed to switch to.
    described.sort((x, y) => Number(Boolean(y.p.url_sac_en)) - Number(Boolean(x.p.url_sac_en)));
    const titleOf = (p: Record<string, string | number | null>) => [p.target_name, p.target_altitude && `${p.target_altitude} m`].filter(Boolean).join(', ');

    let shown = 0;
    const show = async (index: number): Promise<void> => {
      const mine = ++shown;
      const { r, p } = described[index];
      showHighlight(r.geometry);
      const rows = [
        ['Difficulty', p.difficulty_en],
        ['Ascent time', p.ascent_time_label],
        ['Ascent', p.ascent_altitude && `${p.ascent_altitude} m`],
        ['Descent', p.descent_altitude && `${p.descent_altitude} m`],
      ]
        .filter(([, value]) => value)
        .map(([label, value]) => `<tr><td class="muted">${label}</td><td>${escapeHtml(value)}</td></tr>`)
        .join('');
      const kind = r.layerBodId.includes('schneeschuh') ? 'Snowshoe route' : 'Ski route';
      const sacHref = safeHref(p.url_sac_en);
      const link = sacHref
        ? `<div class="popup-links"><a href="${escapeHtml(sacHref)}" target="_blank" rel="noopener">Open in SAC route portal</a></div>`
        : '';
      const others =
        described.length > 1
          ? `<div class="muted">Routes here:</div>` +
            described
              .map(({ p: other }, i) => `<div class="route-option${i === index ? ' on' : ''}" data-option="${i}">${escapeHtml(titleOf(other) || other.name_en || 'Route')}${other.difficulty_en ? ` <span class="muted">${escapeHtml(other.difficulty_en)}</span>` : ''}</div>`)
              .join('')
          : '';
      popup
        .setLngLat(event.lngLat)
        .setHTML(`<div class="popup"><h3>${escapeHtml(titleOf(p) || kind)}</h3><div class="muted">${kind}${p.name_en ? `: ${escapeHtml(p.name_en)}` : ''}</div><table>${rows}</table><div class="muted" data-track title="Measured along the highlighted line, from its lower to its higher end"></div>${link}${others}<div class="muted">Source: swisstopo / SAC</div></div>`)
        .addTo(map);
      showHighlight(r.geometry); // again: opening the popup closes the previous one, which clears the marking
      void previewRoute(titleOf(p) || kind, linesOf(r.geometry));
      for (const option of popup.getElement()?.querySelectorAll<HTMLElement>('[data-option]') ?? []) option.addEventListener('click', () => void show(Number(option.dataset.option)));
      const stats = await trackStats(linesOf(r.geometry)).catch(() => null);
      const slot = popup.getElement()?.querySelector('[data-track]');
      if (stats && slot && token === request && mine === shown) slot.textContent = `Line: ${describeStats(stats)}`;
    };
    await show(0);
  });

  function showHighlight(geometry: GeoJSON.Geometry | undefined): void {
    const data: GeoJSON.FeatureCollection = { type: 'FeatureCollection', features: geometry ? [{ type: 'Feature', properties: {}, geometry }] : [] };
    const source = map.getSource(HIGHLIGHT) as GeoJSONSource | undefined;
    if (source) {
      source.setData(data);
      return;
    }
    map.addSource(HIGHLIGHT, { type: 'geojson', data });
    map.addLayer(
      { id: HIGHLIGHT, type: 'line', source: HIGHLIGHT, layout: { 'line-cap': 'round', 'line-join': 'round' }, paint: { 'line-color': '#00d5ff', 'line-width': 5, 'line-opacity': 0.85 } },
      SLOT.lineHighlight,
    );
  }
}
