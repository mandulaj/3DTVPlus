// Drag and drop of recorded tracks (GPX, TCX, FIT): parsed in the browser, drawn on the terrain.
import * as maplibregl from 'maplibre-gl';
import { SLOT } from './map';
import { readTrack, type Point, type Recording, type Segments } from './trackFiles';
import { h, toast } from './ui/dom';


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

async function parseFile(file: File): Promise<Recording> {
  return readTrack(file.name, await file.arrayBuffer());
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
  /** What the device recorded, for tracks that came from a file and were not edited since. */
  recorded: Recorded | null;
  bounds: maplibregl.LngLatBounds;
  km: number;
}

/** What is kept in the browser's storage so tracks survive a reload. */
/** Recorded heights (m) and times (ms since 1970), one per point of `segments.flat()`. */
export interface Recorded {
  ele: (number | null)[] | null;
  time: (number | null)[] | null;
}

interface StoredTrack {
  name: string;
  colour: string;
  segments: Segments;
  /** Heights in decimetres, null where missing. */
  e?: (number | null)[];
  /** Start time (ms since 1970) and seconds after it per point, null where missing. */
  t0?: number;
  t?: (number | null)[];
}

export interface TrackList {
  /** Add a track made elsewhere (the route planner). Returns its id. */
  add(name: string, coords: Point[]): string;
  /** Replace a track's name and line (edited in the route planner). False if it no longer exists. */
  update(id: string, name: string, coords: Point[]): boolean;
  /** Called when the user asks to open a track in the route planner. */
  onEdit: (id: string, name: string, coords: Point[]) => void;
  /** Called when the user asks for a link that carries a track. */
  onShare: (name: string, coords: Point[]) => void;
  /** Called when a track is clicked in the list: show its profile and statistics. */
  onView: (id: string, name: string, coords: Point[], recorded: Recorded | null) => void;
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
      track.recorded = null; // an edited line no longer matches what the device recorded
      track.bounds = new maplibregl.LngLatBounds();
      for (const point of track.segments[0]) track.bounds.extend(point);
      track.km = lengthKm(track.segments);
      (map.getSource(id) as maplibregl.GeoJSONSource | undefined)?.setData(geometry(track.segments));
      render();
      save();
      return true;
    },
    onEdit: () => {},
    onShare: () => {},
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
        const file_ = await parseFile(file);
        if (!file_.segments.length) throw new Error('no track points found');
        // About 1 m precision: plenty for drawing, a third of the storage.
        const rounded = file_.segments.map((segment) => segment.map(([lng, lat]): Point => [Math.round(lng * 1e5) / 1e5, Math.round(lat * 1e5) / 1e5]));
        const recorded = file_.ele || file_.time ? { ele: file_.ele, time: file_.time } : null;
        bounds.extend(add(file.name, rounded, undefined, recorded).bounds);
      } catch (error) {
        toast(`${file.name}: ${(error as Error).message}`);
      }
    }
    if (!bounds.isEmpty()) map.fitBounds(bounds, { padding: { top: 80, bottom: 120, left: 340, right: 80 }, maxZoom: 15, duration: 1500 });
    render();
    save();
  }

  function save(): void {
    const stored: StoredTrack[] = tracks.map(({ name, colour, segments, recorded }) => {
      const entry: StoredTrack = { name, colour, segments };
      if (recorded?.ele) entry.e = recorded.ele.map((z) => (z === null ? null : Math.round(z * 10)));
      if (recorded?.time) {
        const t0 = recorded.time.find((t) => t !== null) ?? 0;
        entry.t0 = t0;
        entry.t = recorded.time.map((t) => (t === null ? null : Math.round((t - t0) / 1000)));
      }
      return entry;
    });
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
      if (typeof track?.name !== 'string' || !Array.isArray(track.segments) || !(track.segments[0]?.length > 1)) continue;
      const count = track.segments.reduce((n, segment) => n + segment.length, 0);
      const ele = Array.isArray(track.e) && track.e.length === count ? track.e.map((z) => (z === null ? null : z / 10)) : null;
      const time = Array.isArray(track.t) && track.t.length === count ? track.t.map((t) => (t === null ? null : (track.t0 ?? 0) + t * 1000)) : null;
      add(track.name, track.segments, track.colour, ele || time ? { ele, time } : null);
    }
    render();
  }

  function add(name: string, segments: Segments, storedColour?: string, recorded: Recorded | null = null): Track {
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
    const track: Track = { id, name, colour, segments, recorded, bounds, km: lengthKm(segments) };
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
                api.onView(track.id, track.name, track.segments.flat(), track.recorded);
              },
            },
            track.name,
          ),
          h('span', { class: 'muted' }, `${track.km.toFixed(1)} km`),
          h('button', { title: 'Copy a link that shows this track to others', onclick: () => api.onShare(track.name, track.segments.flat()) }, '🔗'),
          h('button', { title: 'Edit in the route planner: move, add and remove points', onclick: () => api.onEdit(track.id, track.name, track.segments.flat()) }, '✎'),
          h('button', { title: 'Remove track', onclick: () => remove(track) }, '✕'),
        );
      }),
    );
  }

  restore();
  return api;
}
