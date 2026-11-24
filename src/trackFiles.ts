// Reading track files (GPX, TCX, FIT) into lines of points. No map or page dependency beyond
// the browser's XML parser.

export type Point = [lng: number, lat: number];
export type Segments = Point[][];

/** What a device recorded besides the line itself, one value per point of `segments.flat()`. */
export interface Recording {
  segments: Segments;
  /** Heights in metres; null as a whole if the file has none. */
  ele: (number | null)[] | null;
  /** Times in milliseconds since 1970; null as a whole if the file has none. */
  time: (number | null)[] | null;
}

interface Sample {
  at: Point;
  ele: number | null;
  time: number | null;
}

// ── parsers ──

/** Elements with this tag name whatever their namespace or prefix. */
function named(root: Element | Document, tag: string): Element[] {
  return [...root.getElementsByTagName('*')].filter((el) => el.localName === tag);
}

const valid = (lng: number, lat: number) => Number.isFinite(lng) && Number.isFinite(lat) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
const numberOrNull = (text: string | null | undefined): number | null => (text != null && text.trim() !== '' && Number.isFinite(Number(text)) ? Number(text) : null);
const timeOrNull = (text: string | null | undefined): number | null => {
  const ms = text ? Date.parse(text.trim()) : NaN;
  return Number.isFinite(ms) ? ms : null;
};

function recording(groups: Sample[][]): Recording {
  const kept = groups.filter((g) => g.length > 1);
  const all = kept.flat();
  return {
    segments: kept.map((g) => g.map((sample) => sample.at)),
    ele: all.some((sample) => sample.ele !== null) ? all.map((sample) => sample.ele) : null,
    time: all.some((sample) => sample.time !== null) ? all.map((sample) => sample.time) : null,
  };
}

function readXml(text: string, pointTags: string[], read: (el: Element) => Sample | null, segmentTag: string): Recording {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('not valid XML');
  const collect = (root: Element | Document, tag: string): Sample[] => named(root, tag).map(read).filter((p): p is Sample => p !== null);
  for (const tag of pointTags) {
    const groups = named(doc, segmentTag).map((seg) => collect(seg, tag)).filter((g) => g.length > 1);
    if (groups.length) return recording(groups);
    const all = collect(doc, tag);
    if (all.length > 1) return recording([all]);
  }
  return recording([]);
}

/** First direct child with this tag name (namespace ignored). */
const child = (el: Element, tag: string): Element | undefined => [...el.children].find((c) => c.localName === tag);

export function readGpx(text: string): Recording {
  // Recorded track first, then a planned route, then loose waypoints.
  return readXml(
    text,
    ['trkpt', 'rtept', 'wpt'],
    (el) => {
      const lng = Number(el.getAttribute('lon'));
      const lat = Number(el.getAttribute('lat'));
      if (!el.hasAttribute('lon') || !valid(lng, lat)) return null;
      return { at: [lng, lat], ele: numberOrNull(child(el, 'ele')?.textContent), time: timeOrNull(child(el, 'time')?.textContent) };
    },
    'trkseg',
  );
}

export function readTcx(text: string): Recording {
  return readXml(
    text,
    ['Trackpoint'],
    (el) => {
      const value = (tag: string) => named(el, tag)[0]?.textContent;
      const lng = Number(value('LongitudeDegrees') ?? NaN);
      const lat = Number(value('LatitudeDegrees') ?? NaN);
      if (!valid(lng, lat)) return null;
      return { at: [lng, lat], ele: numberOrNull(value('AltitudeMeters')), time: timeOrNull(value('Time')) };
    },
    'Track',
  );
}

/** Minimal FIT reader: position, height and time from "record" messages, everything else skipped. */
export function readFit(buffer: ArrayBuffer): Recording {
  const view = new DataView(buffer);
  const RECORD = 20;
  const SEMICIRCLE = 180 / 2 ** 31;
  const FIT_EPOCH = 631065600; // seconds from 1970 to 31 Dec 1989, where FIT time starts
  const samples: Sample[] = [];
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
    let lastTime = 0; // FIT seconds; compressed headers give only the low 5 bits relative to this

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
      if (p + definition.size <= end) {
        let lat = NaN;
        let lng = NaN;
        let ele: number | null = null;
        let stamp: number | null = null;
        let at = p;
        for (const field of definition.fields) {
          if (field.number === 253 && field.size === 4) {
            const raw = view.getUint32(at, definition.little);
            if (raw !== 0xffffffff) stamp = raw;
          } else if (definition.global === RECORD) {
            if (field.size === 4 && (field.number === 0 || field.number === 1)) {
              const raw = view.getInt32(at, definition.little);
              if (raw !== 0x7fffffff) {
                if (field.number === 0) lat = raw * SEMICIRCLE;
                else lng = raw * SEMICIRCLE;
              }
            } else if (field.number === 78 && field.size === 4) {
              const raw = view.getUint32(at, definition.little); // enhanced altitude: preferred
              if (raw !== 0xffffffff) ele = raw / 5 - 500;
            } else if (field.number === 2 && field.size === 2 && ele === null) {
              const raw = view.getUint16(at, definition.little);
              if (raw !== 0xffff) ele = raw / 5 - 500;
            }
          }
          at += field.size;
        }
        // Any message's timestamp moves the clock; a compressed header adds seconds to it.
        if (stamp !== null) lastTime = stamp;
        else if (compressed && lastTime) {
          const low = header & 0x1f;
          lastTime += (low - (lastTime & 0x1f) + 32) % 32;
          stamp = lastTime;
        }
        if (definition.global === RECORD && valid(lng, lat)) samples.push({ at: [lng, lat], ele, time: stamp !== null ? (stamp + FIT_EPOCH) * 1000 : null });
      }
      p += definition.size;
    }
    offset = end + 2; // CRC
  }
  return recording([samples]);
}

/** Line, heights and times from the bytes of a GPX, TCX or FIT file; the name's extension tells which. */
export function readTrack(name: string, data: ArrayBuffer): Recording {
  const extension = name.split(/[?#]/)[0].split('.').pop()?.toLowerCase();
  if (extension === 'fit') return readFit(data);
  const text = new TextDecoder().decode(data);
  if (extension === 'tcx') return readTcx(text);
  if (extension === 'gpx') return readGpx(text);
  // No telling extension (a download address, say): go by the content.
  if (new TextDecoder().decode(data.slice(8, 12)) === '.FIT') return readFit(data);
  if (/<TrainingCenterDatabase[\s>]/.test(text)) return readTcx(text);
  if (/<gpx[\s>]/.test(text)) return readGpx(text);
  throw new Error('unsupported file type (use GPX, TCX or FIT)');
}

/** Just the line. */
export function parseTrack(name: string, data: ArrayBuffer): Segments {
  return readTrack(name, data).segments;
}
