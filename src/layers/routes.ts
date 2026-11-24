// Click on a swisstopo ski or snowshoe route: look the route up at geo.admin.ch and show its
// details with a link to the SAC route portal (the route network on these layers is the SAC's).
import type * as maplibregl from 'maplibre-gl';
import type { GeoJSONSource } from 'maplibre-gl';
import { interaction } from '../interaction';
import { SLOT } from '../map';
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

interface RouteResult {
  layerBodId: string;
  geometry?: GeoJSON.Geometry;
  properties?: Record<string, string | number | null>;
  attributes?: Record<string, string | number | null>;
}

export function enableRouteInfo(map: maplibregl.Map, layers: LayerManager, popup: maplibregl.Popup): void {
  let request = 0;

  const clear = () => (map.getSource(HIGHLIGHT) as GeoJSONSource | undefined)?.setData({ type: 'FeatureCollection', features: [] });
  popup.on('close', clear);

  function active(): string[] {
    return Object.keys(ROUTE_LAYERS).filter((id) => layers.overlays.has(id));
  }

  map.on('click', async (event) => {
    const wanted = active();
    if (!wanted.length || map.getZoom() < 10 || interaction.drawing) return;
    const token = ++request;
    const { x, y } = event.point;
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
      const response = await fetch(`${IDENTIFY}?${query}`);
      if (!response.ok) return;
      results = (await response.json()).results ?? [];
    } catch {
      return; // lookup service unreachable: the map still works
    }
    if (token !== request) return;
    // Many drawn segments carry no description: prefer one that does.
    const described = results.map((r) => ({ r, p: r.properties ?? r.attributes ?? {} })).filter(({ p }) => p.target_name || p.url_sac_en);
    if (!described.length) return;
    const { r, p } = described.find(({ p }) => p.url_sac_en) ?? described[0];

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
    const title = [p.target_name, p.target_altitude && `${p.target_altitude} m`].filter(Boolean).join(', ');
    const kind = r.layerBodId.includes('schneeschuh') ? 'Snowshoe route' : 'Ski route';
    const link = p.url_sac_en
      ? `<div class="popup-links"><a href="${escapeHtml(p.url_sac_en)}" target="_blank" rel="noopener">Open in SAC route portal</a></div>`
      : '';
    const others = described.length > 1 ? `<div class="muted">${described.length - 1} more route(s) here: click a little to the side.</div>` : '';
    popup
      .setLngLat(event.lngLat)
      .setHTML(`<div class="popup"><h3>${escapeHtml(title || kind)}</h3><div class="muted">${kind}${p.name_en ? `: ${escapeHtml(p.name_en)}` : ''}</div><table>${rows}</table>${link}${others}<div class="muted">Source: swisstopo / SAC</div></div>`)
      .addTo(map);
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
      SLOT.top,
    );
  }
}
