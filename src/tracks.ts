// Drag and drop of recorded tracks (GPX, TCX, FIT): parsed in the browser, drawn on the terrain.
import * as maplibregl from 'maplibre-gl';
import { SLOT } from './map';
import { h, toast } from './ui/dom';

type Point = [lng: number, lat: number];
type Segments = Point[][];

const STORAGE_KEY = 'terrain-viewer.tracks';
const START_COLOUR = '#2fbf5b';
const FINISH_ICON = 'finish-flag';

/** Checkered disc for the end of a track, registered with the map once (and again if a style change drops it). */
function ensureFinishIcon(map: maplibregl.Map): void {
  const add = () => {
    if (map.hasImage(FINISH_ICON)) return;
    const size = 36; // drawn at twice the display size
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const context = canvas.getContext('2d')!;
    context.beginPath();
    context.arc(size / 2, size / 2, size / 2 - 2, 0, 2 * Math.PI);
    context.clip();
    const cell = size / 4;
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        context.fillStyle = (x + y) % 2 ? '#111111' : '#ffffff';
        context.fillRect(x * cell, y * cell, cell, cell);
      }
    }
    context.lineWidth = 3;
    context.strokeStyle = '#111111';
    context.stroke();
    map.addImage(FINISH_ICON, context.getImageData(0, 0, size, size), { pixelRatio: 2 });
  };
  add();
  if (!listening.has(map)) {
    listening.add(map);
    map.on('styleimagemissing', (event) => {
      if (event.id === FINISH_ICON) add();
    });
  }
}
const listening = new WeakSet<maplibregl.Map>();

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

export interface TrackList {
  /** Add a track made elsewhere (the route planner). Returns its id. */
  add(name: string, coords: Point[]): string;
  /** Replace a track's name and line (edited in the route planner). False if it no longer exists. */
  update(id: string, name: string, coords: Point[]): boolean;
  /** Called when the user asks to open a track in the route planner. */
  onEdit: (id: string, name: string, coords: Point[]) => void;
  /** Called when a track is clicked in the list: show its profile and statistics. */
  onView: (id: string, name: string, coords: Point[]) => void;
}

const rounded = ([lng, lat]: Point): Point => [Math.round(lng * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5];

/** A track's line plus its start and finish points, as map data. */
function geometry(segments: Segments): GeoJSON.FeatureCollection {
  const lastSegment = segments[segments.length - 1];
  return {
    type: 'FeatureCollection',
    features: [
      { type: 'Feature', properties: {}, geometry: { type: 'MultiLineString', coordinates: segments } },
      { type: 'Feature', properties: { end: 'start' }, geometry: { type: 'Point', coordinates: segments[0][0] } },
      { type: 'Feature', properties: { end: 'finish' }, geometry: { type: 'Point', coordinates: lastSegment[lastSegment.length - 1] } },
    ],
  };
}

export function enableTrackDrop(map: maplibregl.Map, listParent: HTMLElement): TrackList {
  const api: TrackList = {
    add(name, coords) {
      const track = add(name, [coords.map(rounded)]);
      render();
      save();
      return track.id;
    },
    update(id, name, coords) {
      const track = tracks.find((t) => t.id === id);
      if (!track || coords.length < 2) return false;
      track.name = name;
      track.segments = [coords.map(rounded)];
      track.bounds = new maplibregl.LngLatBounds();
      for (const point of track.segments[0]) track.bounds.extend(point);
      track.km = lengthKm(track.segments);
      (map.getSource(id) as maplibregl.GeoJSONSource | undefined)?.setData(geometry(track.segments));
      render();
      save();
      return true;
    },
    onEdit: () => {},
    onView: () => {},
  };
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
    map.addSource(id, { type: 'geojson', data: geometry(segments) });
    const line = { type: 'line' as const, source: id, filter: ['!', ['has', 'end']] as never, layout: { 'line-cap': 'round' as const, 'line-join': 'round' as const } };
    map.addLayer({ ...line, id: `${id}-casing`, paint: { 'line-color': '#ffffff', 'line-width': 8, 'line-opacity': 0.9 } }, SLOT.tracks);
    map.addLayer({ ...line, id: `${id}-line`, paint: { 'line-color': colour, 'line-width': 4.5 } }, SLOT.tracks);
    map.addLayer(
      {
        id: `${id}-ends`,
        type: 'circle',
        source: id,
        filter: ['==', ['get', 'end'], 'start'],
        paint: { 'circle-radius': 6, 'circle-color': START_COLOUR, 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.5 },
      },
      SLOT.tracks,
    );
    ensureFinishIcon(map);
    map.addLayer(
      { id: `${id}-finish`, type: 'symbol', source: id, filter: ['==', ['get', 'end'], 'finish'], layout: { 'icon-image': FINISH_ICON, 'icon-allow-overlap': true, 'icon-ignore-placement': true } },
      SLOT.tracks,
    );
    const track = { id, name, colour, segments, bounds, km: lengthKm(segments) };
    tracks.push(track);
    return track;
  }

  function remove(track: Track): void {
    for (const suffix of ['-finish', '-ends', '-line', '-casing']) map.removeLayer(track.id + suffix);
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
          h(
            'span',
            {
              class: 'track-name',
              title: `${track.name} — click to zoom to it and see its profile`,
              onclick: () => {
                map.fitBounds(track.bounds, { padding: { top: 80, bottom: 300, left: 340, right: 80 }, maxZoom: 15 });
                api.onView(track.id, track.name, track.segments.flat());
              },
            },
            track.name,
          ),
          h('span', { class: 'muted' }, `${track.km.toFixed(1)} km`),
          h('button', { title: 'Edit in the route planner: move, add and remove points', onclick: () => api.onEdit(track.id, track.name, track.segments.flat()) }, '✎'),
          h('button', { title: 'Remove track', onclick: () => remove(track) }, '✕'),
        );
      }),
    );
  }

  restore();
  return api;
}
