// Mountain huts and shelters from refuges.info (CC BY-SA), asked live for the area in view.
// Mostly the French and western Alps and the Pyrenees.
import * as maplibregl from 'maplibre-gl';
import { h } from '../ui/dom';

const API = 'https://www.refuges.info/api/bbox';
const KINDS = 'cabane,refuge,gite'; // unstaffed shelter, staffed hut, lodging
const MIN_ZOOM = 9;
const CELL = 0.5; // degrees: asked once per cell
const MAX_CELLS_PER_VIEW = 9;
const MAX_SHOWN = 120;

interface Hut {
  id: string;
  name: string;
  kind: string;
  at: [number, number];
  altitude: number | null;
  beds: number | null;
  link: string;
}

const escapeHtml = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** French kind names as refuges.info gives them, in English. */
const KIND_NAMES: [RegExp, string, string][] = [
  [/refuge gard/i, 'Staffed hut', 'staffed'],
  [/cabane non gard|abri/i, 'Unstaffed shelter', 'shelter'],
  [/g[iî]te/i, 'Lodging', 'lodging'],
];

export class Huts {
  enabled = false;
  onError: (message: string) => void = () => {};
  onHint: (hint: string | null) => void = () => {};
  private cells = new Map<string, Hut[] | Promise<Hut[]>>();
  private markers = new Map<string, maplibregl.Marker>();
  private timer: number | undefined;
  private request = 0;
  private complained = false;

  constructor(
    private map: maplibregl.Map,
    private popup: maplibregl.Popup,
  ) {
    map.on('moveend', () => this.schedule());
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (on) this.schedule(0);
    else {
      this.request++;
      this.show([]);
      this.onHint(null);
    }
  }

  private schedule(delay = 400): void {
    if (!this.enabled) return;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.update(), delay);
  }

  private async update(): Promise<void> {
    if (!this.enabled) return;
    if (this.map.getZoom() < MIN_ZOOM) {
      this.show([]);
      this.onHint('Zoom in to see huts.');
      return;
    }
    const token = ++this.request;
    const bounds = this.map.getBounds();
    const view = { west: bounds.getWest(), south: bounds.getSouth(), east: bounds.getEast(), north: bounds.getNorth() };
    const centre = [(view.west + view.east) / 2, (view.south + view.north) / 2];
    const wanted: { x: number; y: number; distance: number }[] = [];
    for (let x = Math.floor(view.west / CELL); x * CELL < view.east; x++) {
      for (let y = Math.floor(view.south / CELL); y * CELL < view.north; y++) wanted.push({ x, y, distance: Math.hypot((x + 0.5) * CELL - centre[0], (y + 0.5) * CELL - centre[1]) });
    }
    wanted.sort((a, b) => a.distance - b.distance);
    let huts: Hut[];
    try {
      huts = (await Promise.all(wanted.slice(0, MAX_CELLS_PER_VIEW).map((cell) => this.cell(cell.x, cell.y)))).flat();
    } catch (error) {
      if (token === this.request && !this.complained) {
        this.complained = true; // once, not on every move
        this.onError(`Huts could not be loaded: ${(error as Error).message}`);
      }
      return;
    }
    if (token !== this.request || !this.enabled) return;
    const inView = huts.filter((hut) => hut.at[0] >= view.west && hut.at[0] <= view.east && hut.at[1] >= view.south && hut.at[1] <= view.north);
    this.onHint(inView.length ? null : 'No huts known here (refuges.info covers mainly the French and western Alps).');
    this.show(inView.slice(0, MAX_SHOWN));
  }

  private cell(x: number, y: number): Promise<Hut[]> {
    const name = `${x},${y}`;
    const hit = this.cells.get(name);
    if (hit) return Promise.resolve(hit);
    const query = new URLSearchParams({ bbox: [x * CELL, y * CELL, (x + 1) * CELL, (y + 1) * CELL].join(','), type_points: KINDS, format: 'geojson', nb_points: '250', detail: 'simple' });
    const promise = fetch(`${API}?${query}`, { signal: AbortSignal.timeout(20000) }).then(async (response) => {
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const huts: Hut[] = [];
      for (const feature of ((await response.json()).features ?? []) as any[]) {
        const p = feature.properties ?? {};
        const [lng, lat] = feature.geometry?.coordinates ?? [];
        const link = String(p.lien ?? '');
        if (!Number.isFinite(lng) || !Number.isFinite(lat) || !/^https:\/\/www\.refuges\.info\//.test(link)) continue;
        const altitude = Number(p.coord?.alt);
        const beds = Number(p.places?.valeur);
        huts.push({ id: String(p.id), name: String(p.nom ?? 'Hut'), kind: String(p.type?.valeur ?? ''), at: [lng, lat], altitude: Number.isFinite(altitude) ? altitude : null, beds: Number.isFinite(beds) && beds > 0 ? beds : null, link });
      }
      this.cells.set(name, huts);
      return huts;
    });
    promise.catch(() => this.cells.delete(name));
    this.cells.set(name, promise);
    return promise;
  }

  private show(huts: Hut[]): void {
    const wanted = new Set(huts.map((hut) => hut.id));
    for (const [id, marker] of this.markers) {
      if (!wanted.has(id)) {
        marker.remove();
        this.markers.delete(id);
      }
    }
    for (const hut of huts) {
      if (this.markers.has(hut.id)) continue;
      const kind = KIND_NAMES.find(([pattern]) => pattern.test(hut.kind));
      const element = h('button', { type: 'button', class: `hut ${kind?.[2] ?? ''}`, title: `${hut.name}${hut.altitude ? `, ${Math.round(hut.altitude)} m` : ''}`, 'aria-label': `Hut: ${hut.name}` }, '⌂');
      element.addEventListener('click', (event) => {
        event.stopPropagation();
        const facts = [kind?.[1] ?? hut.kind, hut.altitude && `${Math.round(hut.altitude)} m`, hut.beds && `${hut.beds} places to sleep`].filter(Boolean).join(' · ');
        this.popup
          .setLngLat(hut.at)
          .setHTML(`<div class="popup"><h3>${escapeHtml(hut.name)}</h3><div>${escapeHtml(facts)}</div><div class="popup-links"><a class="button" href="${escapeHtml(hut.link)}" target="_blank" rel="noopener">Open on refuges.info</a></div><div class="muted">Source: refuges.info, CC BY-SA</div></div>`)
          .addTo(this.map);
      });
      this.markers.set(hut.id, new maplibregl.Marker({ element, anchor: 'bottom', opacityWhenCovered: '0.3' }).setLngLat(hut.at).addTo(this.map));
    }
  }
}
