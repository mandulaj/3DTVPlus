// Skitourenguru: ski tours across the Alps with that service's avalanche risk rating for today.
// Data is fetched live from skitourenguru.com (their web app's own files); it is their content,
// shown here unofficially, and no substitute for their site or for the avalanche bulletin.
import type * as maplibregl from 'maplibre-gl';
import { interaction } from '../interaction';
import { SLOT } from '../map';
import type { Legend } from './slf';

const DATA = 'https://www.skitourenguru.com/calc_data2/json';
const SITE = 'https://www.skitourenguru.com/';
const ID = 'guru-routes';
const ATTRIBUTION = '© <a href="https://www.skitourenguru.com" target="_blank">Skitourenguru</a>';
// Their scale: 0–1 low, 1–2 elevated, 2–3 high risk.
const COLOURS = { none: '#9aa3ad', low: '#33cc66', elevated: '#ff9933', high: '#e30613' };

const R = 6378137;
const toLngLat = (x: number, y: number): [number, number] => [(x / R) * (180 / Math.PI), (2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI)];
const escapeHtml = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export class Skitourenguru {
  onLegend: (key: string, legend: Legend | null) => void = () => {};
  onError: (message: string) => void = () => {};
  private token = 0;
  private bound = false;

  constructor(
    private map: maplibregl.Map,
    private popup: maplibregl.Popup,
  ) {}

  async setEnabled(on: boolean): Promise<void> {
    const token = ++this.token;
    if (this.map.getLayer(ID)) this.map.removeLayer(ID);
    if (this.map.getSource(ID)) this.map.removeSource(ID);
    this.onLegend('guru', null);
    if (!on) return;
    try {
      const [routes, summary] = await Promise.all([
        fetch(`${DATA}/Alps_Symbols_900913.json`).then((r) => {
          if (!r.ok) throw new Error(`Skitourenguru: HTTP ${r.status}`);
          return r.json();
        }),
        fetch(`${DATA}/RiskSummary.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null),
      ]);
      if (token !== this.token) return;

      let rated = 0;
      const features = (routes.features as any[]).map((f) => {
        const p = f.properties;
        const risk = typeof p.risk === 'number' ? p.risk : -1;
        if (risk >= 0) rated++;
        return {
          type: 'Feature' as const,
          geometry: { type: 'Point' as const, coordinates: toLngLat(f.geometry.coordinates[0], f.geometry.coordinates[1]) },
          properties: { start: p.start, stop: p.stop, startEle: p.startEle, stopEle: p.stopEle, ascent: p.ele, length: p.len, hours: p.time, risk },
        };
      });
      this.map.addSource(ID, { type: 'geojson', data: { type: 'FeatureCollection', features }, attribution: ATTRIBUTION });
      this.map.addLayer(
        {
          id: ID,
          type: 'circle',
          source: ID,
          minzoom: 8,
          paint: {
            'circle-radius': ['interpolate', ['linear'], ['zoom'], 8, 2.5, 11, 5, 14, 8],
            'circle-color': ['case', ['<', ['get', 'risk'], 0], COLOURS.none, ['<', ['get', 'risk'], 1], COLOURS.low, ['<', ['get', 'risk'], 2], COLOURS.elevated, COLOURS.high],
            'circle-stroke-color': '#ffffff',
            'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 8, 0.5, 12, 1.5],
            // Routes without a rating today stay in the background.
            'circle-opacity': ['case', ['<', ['get', 'risk'], 0], 0.55, 1],
          },
        },
        SLOT.top,
      );
      this.bind();

      const newest = ((summary?.regions ?? []) as any[]).map((r) => r.generated).filter(Boolean).sort().pop();
      this.onLegend('guru', {
        title: 'Skitourenguru risk rating',
        subtitle: `${rated} of ${features.length} routes rated${newest ? `, latest update ${new Date(newest).toLocaleDateString()}` : ''}. Unofficial.`,
        entries: [
          { color: COLOURS.low, label: 'low' },
          { color: COLOURS.elevated, label: 'elevated' },
          { color: COLOURS.high, label: 'high' },
          { color: COLOURS.none, label: 'not rated' },
        ],
      });
    } catch (error) {
      if (token === this.token) this.onError((error as Error).message);
    }
  }

  private bind(): void {
    if (this.bound) return;
    this.bound = true;
    this.map.on('click', ID, (event) => {
      const p = event.features?.[0]?.properties;
      if (!p || interaction.drawing) return;
      const risk = Number(p.risk);
      const level = risk < 0 ? 'not rated today' : risk < 1 ? 'low' : risk < 2 ? 'elevated' : 'high';
      const colour = risk < 0 ? COLOURS.none : risk < 1 ? COLOURS.low : risk < 2 ? COLOURS.elevated : COLOURS.high;
      const rows = [
        ['Start', `${p.start}, ${p.startEle} m`],
        ['Summit', `${p.stop}, ${p.stopEle} m`],
        ['Ascent', `${p.ascent} m`],
        ['Length', `${(Number(p.length) / 1000).toFixed(1)} km`],
        ['Time', `${Number(p.hours).toFixed(1)} h`],
      ]
        .map(([label, value]) => `<tr><td class="muted">${label}</td><td>${escapeHtml(value)}</td></tr>`)
        .join('');
      this.popup
        .setLngLat(event.lngLat)
        .setHTML(
          `<div class="popup"><h3>${escapeHtml(p.stop)}</h3>` +
            `<span class="danger-chip" style="background:${colour}">Risk ${risk < 0 ? '–' : risk.toFixed(2)} · ${level}</span>` +
            `<table>${rows}</table>` +
            `<div class="popup-links"><a href="${SITE}" target="_blank" rel="noopener">Open Skitourenguru</a></div>` +
            `<div class="muted">Source: Skitourenguru (scale 0–3). Unofficial copy, not a safety tool.</div></div>`,
        )
        .addTo(this.map);
    });
    this.map.on('mouseenter', ID, () => (this.map.getCanvas().style.cursor = 'pointer'));
    this.map.on('mouseleave', ID, () => (this.map.getCanvas().style.cursor = ''));
  }
}
