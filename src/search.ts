// Quick search (Ctrl+F or "/"): type a peak, town, hut or lake and fly there. Misspellings are fine.
// Names come from OpenStreetMap through the Photon search service (no addresses: streets and
// houses are left out); before anything is typed, the highest peaks in view are offered.
import * as maplibregl from 'maplibre-gl';
import { isTyping } from './interaction';
import { vectorLayers } from './map';
import { h } from './ui/dom';

const PHOTON = 'https://photon.komoot.io/api/';
// Everything except streets and house numbers.
const LAYERS = ['other', 'locality', 'district', 'city', 'county', 'state', 'country'];
const RAD = Math.PI / 180;

interface Hit {
  name: string;
  detail: string;
  at: [number, number];
  /** Bounding box for places with an extent (towns, lakes, regions). */
  extent?: [number, number, number, number];
  peak: boolean;
}

/** What kind of thing an OpenStreetMap result is, in plain words. */
function describe(p: Record<string, any>): string {
  const kinds: Record<string, string> = {
    peak: 'peak', volcano: 'volcano', saddle: 'pass', glacier: 'glacier', water: 'lake', alpine_hut: 'hut', wilderness_hut: 'hut',
    town: 'town', village: 'village', city: 'city', hamlet: 'hamlet', locality: 'place', valley: 'valley', ridge: 'ridge', mountain_range: 'range',
  };
  const kind = kinds[p.osm_value] ?? String(p.osm_value ?? '').replace(/_/g, ' ');
  const where = [p.county !== p.name ? p.county : null, p.state, p.country].filter(Boolean).slice(-2).join(', ');
  return [kind, where].filter(Boolean).join(' · ');
}

export function enableSearch(map: maplibregl.Map): void {
  const input = h('input', { type: 'search', placeholder: 'Peak, town, hut, lake…', autocomplete: 'off', spellcheck: false, 'aria-label': 'Search for a place' });
  const list = h('div', { class: 'search-results', role: 'listbox' });
  const box = h('div', { class: 'search', hidden: true }, input, list);
  document.body.append(box);
  const pin = new maplibregl.Marker({ color: '#1f6feb' });

  let hits: Hit[] = [];
  let active = 0;
  let request = 0;
  let timer: number | undefined;

  const PROBE = 'search-peaks'; // invisible layer: makes the map load peak names for the suggestions
  map.on('sourcedata', (event) => {
    if (!box.hidden && input.value.trim().length < 2 && event.sourceId === 'water' && event.isSourceLoaded) show(nearbyPeaks(), 'Highest peaks in view');
  });

  function open(): void {
    if (!map.getLayer(PROBE)) map.addLayer({ id: PROBE, type: 'circle', source: 'water', 'source-layer': vectorLayers.peak, paint: { 'circle-radius': 1, 'circle-opacity': 0 } });
    map.setLayoutProperty(PROBE, 'visibility', 'visible');
    box.hidden = false;
    input.value = '';
    input.focus();
    show(nearbyPeaks(), 'Highest peaks in view');
  }

  function close(): void {
    if (map.getLayer(PROBE)) map.setLayoutProperty(PROBE, 'visibility', 'none');
    box.hidden = true;
    request++;
    clearTimeout(timer);
  }

  /** Peaks already loaded for the map (the peak labels use the same data), highest first. */
  function nearbyPeaks(): Hit[] {
    const bounds = map.getBounds();
    const seen = new Set<string>();
    const peaks: (Hit & { ele: number })[] = [];
    try {
      for (const feature of map.querySourceFeatures('water', { sourceLayer: vectorLayers.peak })) {
        const p = feature.properties ?? {};
        const name = p['name:latin'] ?? p.name;
        if (!name || feature.geometry.type !== 'Point' || seen.has(name)) continue;
        const at = feature.geometry.coordinates as [number, number];
        if (!bounds.contains(at)) continue;
        seen.add(name);
        const ele = Number(p.ele);
        peaks.push({ name, detail: Number.isFinite(ele) ? `peak · ${Math.round(ele)} m` : 'peak', at, peak: true, ele: Number.isFinite(ele) ? ele : 0 });
      }
    } catch {
      return []; // peak data not loaded: nothing to suggest yet
    }
    return peaks.sort((a, b) => b.ele - a.ele).slice(0, 8);
  }

  function show(results: Hit[], heading = ''): void {
    hits = results;
    active = 0;
    list.replaceChildren(
      ...(heading && results.length ? [h('div', { class: 'search-heading' }, heading)] : []),
      ...results.map((hit, i) =>
        h(
          'div',
          { class: `search-hit${i === 0 ? ' on' : ''}`, role: 'option', onmousedown: (event: Event) => event.preventDefault(), onclick: () => go(hit) },
          h('b', {}, hit.name),
          h('span', { class: 'muted' }, hit.detail),
        ),
      ),
    );
  }

  function mark(): void {
    [...list.querySelectorAll('.search-hit')].forEach((el, i) => {
      el.classList.toggle('on', i === active);
      if (i === active) el.scrollIntoView({ block: 'nearest' });
    });
  }

  let searchController: AbortController | null = null;
  async function search(text: string): Promise<void> {
    const token = ++request;
    searchController?.abort();
    searchController = new AbortController();
    const centre = map.getCenter();
    // Results near the map are preferred, but a well-known name far away still comes up.
    const query = new URLSearchParams({ q: text, limit: '8', lang: 'en', lat: centre.lat.toFixed(3), lon: centre.lng.toFixed(3) });
    for (const layer of LAYERS) query.append('layer', layer);
    try {
      const response = await fetch(`${PHOTON}?${query}`, { signal: AbortSignal.any([searchController.signal, AbortSignal.timeout(10000)]) });
      if (!response.ok) throw new Error(String(response.status));
      const data = await response.json();
      if (token !== request) return;
      const seen = new Set<string>();
      const results: Hit[] = [];
      for (const feature of (data.features ?? []) as any[]) {
        const p = feature.properties ?? {};
        const at = feature.geometry?.coordinates as [number, number] | undefined;
        if (!p.name || !at) continue;
        const hit: Hit = { name: p.name, detail: describe(p), at, extent: p.extent, peak: p.osm_key === 'natural' && ['peak', 'volcano'].includes(p.osm_value) };
        // The same place often comes back twice (as a point and as an area).
        const key = `${hit.name}|${hit.detail}|${at[0].toFixed(1)},${at[1].toFixed(1)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        results.push(hit);
      }
      show(results);
      if (!results.length) list.replaceChildren(h('div', { class: 'search-heading' }, 'Nothing found'));
    } catch {
      if (token === request) list.replaceChildren(h('div', { class: 'search-heading' }, 'Search is not available right now'));
    }
  }

  function go(hit: Hit): void {
    close();
    pin.setLngLat(hit.at).addTo(map);
    window.setTimeout(() => pin.remove(), 8000);
    if (hit.extent && !hit.peak) {
      const [west, north, east, south] = hit.extent;
      // Large areas are framed whole; small ones would zoom in absurdly close.
      const span = Math.max(Math.abs(east - west) * Math.cos(hit.at[1] * RAD), Math.abs(north - south)) * 111;
      if (span > 2) {
        map.fitBounds([[west, south], [east, north]], { padding: 80, maxZoom: 14, pitch: map.getPitch(), bearing: map.getBearing() });
        return;
      }
    }
    // A summit is best seen tilted, from a little way off.
    map.flyTo({ center: hit.at, zoom: hit.peak ? 13.2 : 13.5, pitch: Math.max(map.getPitch(), hit.peak ? 60 : 45), essential: true });
  }

  input.addEventListener('input', () => {
    clearTimeout(timer);
    const text = input.value.trim();
    if (text.length < 2) {
      request++;
      show(nearbyPeaks(), 'Highest peaks in view');
      return;
    }
    timer = window.setTimeout(() => void search(text), 220);
  });
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (hits.length) active = (active + (event.key === 'ArrowDown' ? 1 : hits.length - 1)) % hits.length;
      mark();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      if (hits[active]) go(hits[active]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation(); // not also "leave the route planner's selection"
      close();
    }
  });
  input.addEventListener('blur', () => window.setTimeout(close, 150));

  window.addEventListener(
    'keydown',
    (event) => {
      const find = (event.ctrlKey || event.metaKey) && !event.shiftKey && event.key.toLowerCase() === 'f';
      if (find || (event.key === '/' && !isTyping(event.target))) {
        event.preventDefault(); // instead of the browser's "find in page", which finds nothing on a map
        open();
      }
    },
    true,
  );

  // A button with the other map controls, for touch screens and for discovering the shortcut.
  const button = h('button', { type: 'button', class: 'search-button', title: 'Search for a peak or place (Ctrl+F)', onclick: () => (box.hidden ? open() : close()) }, '🔍');
  const group = h('div', { class: 'maplibregl-ctrl maplibregl-ctrl-group' }, button);
  map.addControl({ onAdd: () => group, onRemove: () => group.remove() }, 'top-right');
}
