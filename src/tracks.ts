// Drag and drop of recorded tracks (GPX, TCX, FIT): parsed in the browser, drawn on the terrain.
import * as maplibregl from 'maplibre-gl';
import { SLOT } from './map';
import { h, toast } from './ui/dom';

type Point = [lng: number, lat: number];
type Segments = Point[][];

const STORAGE_KEY = 'terrain-viewer.tracks';
const COLOURS = ['#e5007d', '#0a84ff', '#ff7a00', '#7b2ff7', '#00a36c', '#d4002a'];

// ── parsers ──

function parseXml(text: string, pointTags: string[], read: (el: Element) => Point | null, segmentTag: string): Segments {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('not valid XML');
  const collect = (root: Element | Document, tag: string): Point[] =>
    [...root.getElementsByTagNameNS('*', tag)].map(read).filter((p): p is Point => p !== null);
  for (const tag of pointTags) {
    const groups = [...doc.getElementsByTagNameNS('*', segmentTag)].map((seg) => collect(seg, tag)).filter((s) => s.length > 1);
    if (groups.length) return groups;
    const all = collect(doc, tag);
    if (all.length > 1) return [all];
  }
  return [];
}

const valid = (lng: number, lat: number) => Number.isFinite(lng) && Number.isFinite(lat) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;

function parseGpx(text: string): Segments {
  // Recorded track first, then a planned route, then loose waypoints.
  return parseXml(
    text,
    ['trkpt', 'rtept', 'wpt'],
    (el) => {
      const lng = Number(el.getAttribute('lon'));
      const lat = Number(el.getAttribute('lat'));
      return el.hasAttribute('lon') && valid(lng, lat) ? [lng, lat] : null;
    },
    'trkseg',
  );
}

function parseTcx(text: string): Segments {
  return parseXml(
    text,
    ['Trackpoint'],
    (el) => {
      const value = (tag: string) => el.getElementsByTagNameNS('*', tag)[0]?.textContent;
      const lng = Number(value('LongitudeDegrees') ?? NaN);
      const lat = Number(value('LatitudeDegrees') ?? NaN);
      return valid(lng, lat) ? [lng, lat] : null;
    },
    'Track',
  );
}

/** Minimal FIT reader: positions from "record" messages, everything else skipped. */
function parseFit(buffer: ArrayBuffer): Segments {
  const view = new DataView(buffer);
  const RECORD = 20;
  const SEMICIRCLE = 180 / 2 ** 31;
  const points: Point[] = [];
  let offset = 0;

  // A file can hold several FIT files back to back.
  while (offset + 12 <= view.byteLength) {
    const headerSize = view.getUint8(offset);
    const dataSize = view.getUint32(offset + 4, true);
    if (String.fromCharCode(...new Uint8Array(buffer, offset + 8, 4)) !== '.FIT') {
      if (offset === 0) throw new Error('not a FIT file');
      break;
    }
    let p = offset + headerSize;
    const end = Math.min(p + dataSize, view.byteLength);
    interface Definition {
      global: number;
      little: boolean;
      fields: { number: number; size: number }[];
      size: number;
    }
    const definitions = new Map<number, Definition>();

    while (p < end) {
      const header = view.getUint8(p++);
      const compressed = (header & 0x80) !== 0;
      if (!compressed && header & 0x40) {
        const little = view.getUint8(p + 1) === 0;
        const global = view.getUint16(p + 2, little);
        const count = view.getUint8(p + 4);
        p += 5;
        const fields: Definition['fields'] = [];
        let size = 0;
        for (let i = 0; i < count; i++, p += 3) {
          fields.push({ number: view.getUint8(p), size: view.getUint8(p + 1) });
          size += view.getUint8(p + 1);
        }
        if (header & 0x20) {
          const developer = view.getUint8(p++);
          for (let i = 0; i < developer; i++, p += 3) size += view.getUint8(p + 1);
        }
        definitions.set(header & 0x0f, { global, little, fields, size });
        continue;
      }
      const definition = definitions.get(compressed ? (header >> 5) & 0x03 : header & 0x0f);
      if (!definition) throw new Error('damaged FIT file');
      if (definition.global === RECORD && p + definition.size <= end) {
        let lat = NaN;
        let lng = NaN;
        let at = p;
        for (const field of definition.fields) {
          if (field.size === 4 && (field.number === 0 || field.number === 1)) {
            const raw = view.getInt32(at, definition.little);
            if (raw !== 0x7fffffff) {
              if (field.number === 0) lat = raw * SEMICIRCLE;
              else lng = raw * SEMICIRCLE;
            }
          }
          at += field.size;
        }
        if (valid(lng, lat)) points.push([lng, lat]);
      }
      p += definition.size;
    }
    offset = end + 2; // CRC
  }
  return points.length > 1 ? [points] : [];
}

async function parseFile(file: File): Promise<Segments> {
  const extension = file.name.split('.').pop()?.toLowerCase();
  if (extension === 'fit') return parseFit(await file.arrayBuffer());
  if (extension === 'gpx') return parseGpx(await file.text());
  if (extension === 'tcx') return parseTcx(await file.text());
  throw new Error('unsupported file type (use GPX, TCX or FIT)');
}

// ── map layers and list ──

function lengthKm(segments: Segments): number {
  const RAD = Math.PI / 180;
  let metres = 0;
  for (const segment of segments) {
    for (let i = 1; i < segment.length; i++) {
      const [lng1, lat1] = segment[i - 1];
      const [lng2, lat2] = segment[i];
      const a = Math.sin(((lat2 - lat1) * RAD) / 2) ** 2 + Math.cos(lat1 * RAD) * Math.cos(lat2 * RAD) * Math.sin(((lng2 - lng1) * RAD) / 2) ** 2;
      metres += 2 * 6371008 * Math.asin(Math.sqrt(a));
    }
  }
  return metres / 1000;
}

interface Track {
  id: string;
  name: string;
  colour: string;
  segments: Segments;
  bounds: maplibregl.LngLatBounds;
  km: number;
}

/** What is kept in the browser's storage so tracks survive a reload. */
interface StoredTrack {
  name: string;
  colour: string;
  segments: Segments;
}

export function enableTrackDrop(map: maplibregl.Map, listParent: HTMLElement): void {
  const tracks: Track[] = [];
  let counter = 0;
  const list = h('div', { class: 'legend tracks' });
  list.style.display = 'none';
  listParent.append(list);
  const hint = h('div', { class: 'drop-hint' }, 'Drop GPX, TCX or FIT files to show them on the map');
  document.body.append(hint);

  const hasFiles = (event: DragEvent) => event.dataTransfer?.types.includes('Files') ?? false;
  let depth = 0;
  window.addEventListener('dragenter', (event) => {
    if (!hasFiles(event)) return;
    depth++;
    hint.classList.add('show');
  });
  window.addEventListener('dragleave', (event) => {
    if (!hasFiles(event)) return;
    if (--depth <= 0) hint.classList.remove('show');
  });
  window.addEventListener('dragover', (event) => {
    if (hasFiles(event)) event.preventDefault(); // otherwise the browser opens the file
  });
  window.addEventListener('drop', (event) => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth = 0;
    hint.classList.remove('show');
    void addFiles([...(event.dataTransfer?.files ?? [])]);
  });

  async function addFiles(files: File[]): Promise<void> {
    const bounds = new maplibregl.LngLatBounds();
    for (const file of files) {
      try {
        const segments = await parseFile(file);
        if (!segments.length) throw new Error('no track points found');
        // About 1 m precision: plenty for drawing, a third of the storage.
        const rounded = segments.map((segment) => segment.map(([lng, lat]): Point => [Math.round(lng * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5]));
        bounds.extend(add(file.name, rounded).bounds);
      } catch (error) {
        toast(`${file.name}: ${(error as Error).message}`);
      }
    }
    if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: { top: 80, bottom: 120, left: 340, right: 80 }, maxZoom: 15, duration: 1500 });
    render();
    save();
  }

  function save(): void {
    const stored: StoredTrack[] = tracks.map(({ name, colour, segments }) => ({ name, colour, segments }));
    try {
      if (stored.length) localStorage.setItem(STORAGE_KEY, JSON.stringify(stored));
      else localStorage.removeItem(STORAGE_KEY);
    } catch {
      // Browser storage holds about 5 MB. Keep as many tracks as fit, oldest first.
      let kept = stored.length;
      while (kept > 0) {
        try {
          localStorage.setItem(STORAGE_KEY, JSON.stringify(stored.slice(0, --kept)));
          break;
        } catch {
          /* still too large */
        }
      }
      toast(`Browser storage is full: only ${kept} of ${stored.length} tracks will be there after a reload.`);
    }
  }

  function restore(): void {
    let stored: StoredTrack[] = [];
    try {
      stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    } catch {
      return; // storage unavailable or damaged entry
    }
    if (!Array.isArray(stored)) return;
    for (const track of stored) {
      if (typeof track?.name === 'string' && Array.isArray(track.segments) && track.segments[0]?.length > 1) add(track.name, track.segments, track.colour);
    }
    render();
  }

  function add(name: string, segments: Segments, storedColour?: string): Track {
    const id = `track-${++counter}`;
    const colour = storedColour ?? COLOURS.find((c) => !tracks.some((t) => t.colour === c)) ?? COLOURS[(counter - 1) % COLOURS.length];
    const bounds = new maplibregl.LngLatBounds();
    for (const segment of segments) for (const point of segment) bounds.extend(point);
    const first = segments[0][0];
    const lastSegment = segments[segments.length - 1];
    map.addSource(id, {
      type: 'geojson',
      data: {
        type: 'FeatureCollection',
        features: [
          { type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: segments } },
          { type: 'Feature', properties: { end: 'start' }, geometry: { type: 'Point', coordinates: first } },
          { type: 'Feature', properties: { end: 'finish' }, geometry: { type: 'Point', coordinates: lastSegment[lastSegment.length - 1] } },
        ],
      },
    });
    const line = { type: 'line' as const, source: id, filter: ['!', ['has', 'end']] as never, layout: { 'line-cap': 'round' as const, 'line-join': 'round' as const } };
    map.addLayer({ ...line, id: `${id}-casing`, paint: { 'line-color': '#ffffff', 'line-width': 8, 'line-opacity': 0.9 } }, SLOT.top);
    map.addLayer({ ...line, id: `${id}-line`, paint: { 'line-color': colour, 'line-width': 4.5 } }, SLOT.top);
    map.addLayer(
      {
        id: `${id}-ends`,
        type: 'circle',
        source: id,
        filter: ['has', 'end'],
        paint: {
          'circle-radius': 6,
          'circle-color': ['match', ['get', 'end'], 'start', '#ffffff', colour],
          'circle-stroke-color': ['match', ['get', 'end'], 'start', colour, '#ffffff'],
          'circle-stroke-width': 2.5,
        },
      },
      SLOT.top,
    );
    const track = { id, name, colour, segments, bounds, km: lengthKm(segments) };
    tracks.push(track);
    return track;
  }

  function remove(track: Track): void {
    for (const suffix of ['-ends', '-line', '-casing']) map.removeLayer(track.id + suffix);
    map.removeSource(track.id);
    tracks.splice(tracks.indexOf(track), 1);
    render();
    save();
  }

  function render(): void {
    list.style.display = tracks.length ? '' : 'none';
    list.replaceChildren(
      h('div', { class: 'legend-title' }, 'Tracks'),
      ...tracks.map((track) => {
        const swatch = h('i');
        swatch.style.background = track.colour;
        return h(
          'div',
          { class: 'track-row' },
          swatch,
          h('span', { class: 'track-name', title: `${track.name} — click to zoom to it`, onclick: () => map.fitBounds(track.bounds, { padding: 100, maxZoom: 15 }) }, track.name),
          h('span', { class: 'muted' }, `${track.km.toFixed(1)} km`),
          h('button', { title: 'Remove track', onclick: () => remove(track) }, '✕'),
        );
      }),
    );
  }

  restore();
}
