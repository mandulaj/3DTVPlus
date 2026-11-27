// Webcams on the map. Without anything set up they come from OpenStreetMap (places tagged with a
// webcam address: a link, no picture), as a copy stored with the site. With the user's own Windy Webcams API key (Settings) they
// come from Windy instead, with a preview picture.
import * as maplibregl from 'maplibre-gl';
import { interaction } from '../interaction';
import { h } from '../ui/dom';

const DATA = './data/webcams.json';
const WINDY = 'https://api.windy.com/webcams/api/v3/webcams';
const MIN_ZOOM = 9;
const MAX_SHOWN = 80;

interface Cam {
  id: string;
  name: string;
  at: [number, number];
  /** The webcam's own page. */
  link: string;
  operator?: string;
  /** Preview picture (Windy only; the address expires after some minutes). */
  preview?: string;
  updated?: string;
  source: 'osm' | 'windy';
}

const escapeHtml = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
/** Only web addresses are taken from the data; anything else (javascript: …) is dropped. */
const webAddress = (text: unknown): string | null => {
  const value = String(text ?? '').trim();
  return /^https?:\/\//i.test(value) ? value : /^www\./i.test(value) ? `https://${value}` : null;
};

export class Webcams {
  enabled = false;
  onError: (message: string) => void = () => {};
  /** Told when webcams cannot be shown at the current zoom, or can again (null). */
  onHint: (hint: string | null) => void = () => {};
  private markers = new Map<string, maplibregl.Marker>();
  private timer: number | undefined;
  private request = 0;
  private complained = false;

  constructor(
    private map: maplibregl.Map,
    private popup: maplibregl.Popup,
    /** The user's Windy key, or '' for OpenStreetMap. */
    private windyKey: () => string,
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

  /** The key was entered or removed: load from the other source. */
  refresh(): void {
    this.complained = false;
    this.schedule(0);
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
      this.onHint('Zoom in to see webcams.');
      return;
    }
    const token = ++this.request;
    const bounds = this.map.getBounds();
    const view = { west: bounds.getWest(), south: bounds.getSouth(), east: bounds.getEast(), north: bounds.getNorth() };
    let cams: Cam[];
    try {
      cams = this.windyKey() ? await this.fromWindy(view) : await this.fromOsm();
    } catch (error) {
      if (token === this.request && !this.complained) {
        this.complained = true; // once, not on every move
        this.onError(`Webcams could not be loaded: ${(error as Error).message}`);
      }
      return;
    }
    if (token !== this.request || !this.enabled) return;
    const inView = cams.filter((cam) => cam.at[0] >= view.west && cam.at[0] <= view.east && cam.at[1] >= view.south && cam.at[1] <= view.north);
    this.onHint(inView.length ? (this.windyKey() ? null : 'From OpenStreetMap (Switzerland and around): links only. A Windy key (Settings) adds webcams with preview pictures.') : 'No webcams known here.');
    this.show(inView.slice(0, MAX_SHOWN));
  }

  /** OpenStreetMap's webcams, from the copy stored with the site (scripts/fetch-webcams.mjs). */
  private fromOsm(): Promise<Cam[]> {
    this.stored ??= fetch(DATA).then(async (response) => {
      if (!response.ok) throw new Error('the stored list is missing (not available when the page is opened as a single file)');
      const data = (await response.json()) as { cams: { id: string; name: string; at: [number, number]; link: string; operator?: string }[] };
      return data.cams.filter((cam) => webAddress(cam.link)).map((cam): Cam => ({ ...cam, id: `osm-${cam.id}`, source: 'osm' }));
    });
    this.stored.catch(() => (this.stored = null));
    return this.stored;
  }
  private stored: Promise<Cam[]> | null = null;

  /** Windy's list for the view; asked again on every move, since its picture addresses expire. */
  private async fromWindy(view: { west: number; south: number; east: number; north: number }): Promise<Cam[]> {
    const query = new URLSearchParams({ bbox: [view.north, view.east, view.south, view.west].map((v) => v.toFixed(4)).join(','), include: 'images,location,urls', limit: '50', lang: 'en' });
    const response = await fetch(`${WINDY}?${query}`, { headers: { 'x-windy-api-key': this.windyKey() } });
    if (response.status === 401 || response.status === 403) throw new Error('Windy did not accept the API key (check it under Settings)');
    if (!response.ok) throw new Error(`Windy: HTTP ${response.status}`);
    const cams: Cam[] = [];
    for (const cam of ((await response.json()).webcams ?? []) as any[]) {
      const lng = Number(cam.location?.longitude);
      const lat = Number(cam.location?.latitude);
      const link = webAddress(cam.urls?.detail) ?? `https://www.windy.com/webcams/${encodeURIComponent(cam.webcamId)}`;
      if (!Number.isFinite(lng) || !Number.isFinite(lat)) continue;
      cams.push({ id: `windy-${cam.webcamId}`, name: String(cam.title ?? 'Webcam'), at: [lng, lat], link, preview: webAddress(cam.images?.current?.preview) ?? webAddress(cam.images?.current?.thumbnail) ?? undefined, updated: cam.lastUpdatedOn, source: 'windy' });
    }
    return cams;
  }

  private show(cams: Cam[]): void {
    const wanted = new Set(cams.map((cam) => cam.id));
    for (const [id, marker] of this.markers) {
      if (!wanted.has(id)) {
        marker.remove();
        this.markers.delete(id);
      }
    }
    for (const cam of cams) {
      if (this.markers.has(cam.id)) continue;
      const element = h('button', { type: 'button', class: 'webcam', title: cam.name, 'aria-label': `Webcam: ${cam.name}` }, '📷');
      element.addEventListener('click', (event) => {
        if (interaction.drawing) return;
        event.stopPropagation();
        this.open(cam);
      });
      this.markers.set(cam.id, new maplibregl.Marker({ element, anchor: 'bottom', opacityWhenCovered: '0.3' }).setLngLat(cam.at).addTo(this.map));
    }
  }

  private open(cam: Cam): void {
    const picture = cam.preview ? `<a href="${escapeHtml(cam.link)}" target="_blank" rel="noopener"><img class="webcam-preview" src="${escapeHtml(cam.preview)}" alt="" loading="lazy"></a>` : '';
    const updated = cam.updated ? `<div class="muted">Picture of ${escapeHtml(new Date(cam.updated).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }))}</div>` : '';
    const source = cam.source === 'windy' ? 'Webcams provided by <a href="https://www.windy.com/" target="_blank" rel="noopener">windy.com</a>' : 'Source: OpenStreetMap';
    this.popup
      .setLngLat(cam.at)
      .setHTML(
        `<div class="popup"><h3>${escapeHtml(cam.name)}</h3>${cam.operator && cam.operator !== cam.name ? `<div class="muted">${escapeHtml(cam.operator)}</div>` : ''}${picture}${updated}` +
          `<div class="popup-links"><a class="button" href="${escapeHtml(cam.link)}" target="_blank" rel="noopener">Open webcam</a></div><div class="muted">${source}</div></div>`,
      )
      .addTo(this.map);
  }
}
