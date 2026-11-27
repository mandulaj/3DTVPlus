// Peak labels: a thin vertical marker over each summit in view with name, altitude and distance
// from the camera. Click one to stand on that summit and look around (Shift+drag).
import * as maplibregl from 'maplibre-gl';
import { interaction } from './interaction';
import { vectorLayers } from './map';
import type { LookAround } from './lookAround';

const SOURCE = 'water'; // OpenFreeMap vector tiles (map.ts): they also carry OpenStreetMap peaks
const PROBE = 'peaks-probe'; // invisible layer: keeps the peak data loaded
const MAX_LABELS = 36;
const SUMMIT_EYE_HEIGHT = 25; // metres above the summit: clear of the terrain mesh
const RAD = Math.PI / 180;

interface Peak {
  key: string;
  name: string;
  ele: number;
  lngLat: [number, number];
}

export class PeakLabels {
  enabled = false;
  private markers = new Map<string, { marker: maplibregl.Marker; distance: HTMLElement }>();
  private timer: number | undefined;

  constructor(
    private map: maplibregl.Map,
    private look: LookAround,
  ) {
    const later = () => this.schedule();
    map.on('moveend', later);
    map.on('sourcedata', (event) => {
      if (this.enabled && event.sourceId === SOURCE && event.isSourceLoaded) later();
    });
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    if (on && !this.map.getLayer(PROBE)) {
      this.map.addLayer({ id: PROBE, type: 'circle', source: SOURCE, 'source-layer': vectorLayers.peak, paint: { 'circle-radius': 1, 'circle-opacity': 0 } });
    }
    if (this.map.getLayer(PROBE)) this.map.setLayoutProperty(PROBE, 'visibility', on ? 'visible' : 'none');
    if (on) this.schedule(0);
    else this.clear();
  }

  private schedule(delay = 200): void {
    if (!this.enabled) return;
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.update(), delay);
  }

  private clear(): void {
    for (const { marker } of this.markers.values()) marker.remove();
    this.markers.clear();
  }

  private update(): void {
    if (!this.enabled) return;
    const map = this.map;
    const { clientWidth: width, clientHeight: height } = map.getCanvas();
    const camera = this.look.position();

    // Peaks in view, highest first; the same peak arrives once per tile it was loaded in.
    const found = new Map<string, Peak & { x: number; y: number }>();
    for (const feature of map.querySourceFeatures(SOURCE, { sourceLayer: vectorLayers.peak })) {
      const p = feature.properties ?? {};
      const name = p['name:latin'] ?? p.name;
      const ele = Number(p.ele);
      if (!name || !Number.isFinite(ele) || feature.geometry.type !== 'Point') continue;
      const lngLat = feature.geometry.coordinates as [number, number];
      const key = `${name}@${lngLat[0].toFixed(3)},${lngLat[1].toFixed(3)}`;
      if (found.has(key)) continue;
      const { x, y } = map.project(lngLat);
      if (x < 0 || y < 0 || x > width || y > height) continue;
      found.set(key, { key, name, ele, lngLat, x, y });
    }
    // Keep the highest, and drop labels that would sit on top of a higher neighbour.
    const kept: (Peak & { x: number; y: number })[] = [];
    for (const peak of [...found.values()].sort((a, b) => b.ele - a.ele)) {
      if (kept.length >= MAX_LABELS) break;
      if (kept.some((other) => Math.abs(other.x - peak.x) < 90 && Math.abs(other.y - peak.y) < 26)) continue;
      kept.push(peak);
    }

    const wanted = new Set(kept.map((p) => p.key));
    for (const [key, entry] of this.markers) {
      if (!wanted.has(key)) {
        entry.marker.remove();
        this.markers.delete(key);
      }
    }
    for (const peak of kept) {
      let entry = this.markers.get(peak.key);
      if (!entry) entry = this.create(peak);
      entry.distance.textContent = formatDistance(distance(camera, peak));
    }
    // The pre-selection above works with ground positions; the labels sit higher, at their summits.
    // Once they are placed, hide any that still overlap a higher peak's label.
    const order = kept.map((peak) => peak.key);
    requestAnimationFrame(() => {
      const taken: DOMRect[] = [];
      for (const key of order) {
        const element = this.markers.get(key)?.marker.getElement();
        const label = element?.querySelector('.peak-label');
        if (!element || !label) continue;
        element.classList.remove('crowded');
        if (element.style.opacity === '0') continue; // behind terrain: takes no room
        const box = label.getBoundingClientRect();
        const clash = taken.some((other) => box.left < other.right + 4 && box.right > other.left - 4 && box.top < other.bottom + 2 && box.bottom > other.top - 2);
        if (clash) element.classList.add('crowded');
        else taken.push(box);
      }
    });
  }

  private create(peak: Peak): { marker: maplibregl.Marker; distance: HTMLElement } {
    const distanceLabel = document.createElement('span');
    distanceLabel.className = 'peak-distance';
    const label = document.createElement('div');
    label.className = 'peak-label';
    const name = document.createElement('b');
    name.textContent = peak.name;
    label.append(name, ` ${Math.round(peak.ele)} m`, distanceLabel);
    const element = document.createElement('div');
    element.className = 'peak';
    element.title = `View from ${peak.name}`;
    element.append(label, Object.assign(document.createElement('div'), { className: 'peak-stem' }));
    element.addEventListener('click', (event) => {
      if (interaction.drawing) return;
      event.stopPropagation();
      const exaggeration = this.map.getTerrain()?.exaggeration ?? 1;
      this.look.flyTo(peak.lngLat, peak.ele * exaggeration + SUMMIT_EYE_HEIGHT, 82);
    });
    const marker = new maplibregl.Marker({ element, anchor: 'bottom', opacityWhenCovered: '0' }).setLngLat(peak.lngLat).addTo(this.map);
    const entry = { marker, distance: distanceLabel };
    this.markers.set(peak.key, entry);
    return entry;
  }
}

function distance(camera: { lngLat: maplibregl.LngLat; altitude: number }, peak: Peak): number {
  const lat1 = camera.lngLat.lat * RAD;
  const lat2 = peak.lngLat[1] * RAD;
  const a = Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(((peak.lngLat[0] - camera.lngLat.lng) * RAD) / 2) ** 2;
  const ground = 2 * 6371008 * Math.asin(Math.sqrt(a));
  return Math.hypot(ground, camera.altitude - peak.ele);
}

function formatDistance(metres: number): string {
  return metres < 1000 ? ` · ${Math.round(metres / 10) * 10} m` : ` · ${(metres / 1000).toFixed(metres < 20000 ? 1 : 0)} km`;
}
