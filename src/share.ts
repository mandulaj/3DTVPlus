// A track packed into text short enough for a link. Nothing is uploaded anywhere: the track
// travels in the part of the address after "#", which browsers never send to a server.
//
// Format: base64url of [version byte] + payload. Version 1: payload is deflate-compressed,
// version 0: not compressed (browsers without CompressionStream). The payload is the point count
// followed by zig-zag varint deltas of longitude and latitude in 1e-5 degrees (about 1 m).
import { simplify } from './geometry';

type Point = [lng: number, lat: number];
const PRECISION = 1e5;

function pack(coords: Point[]): Uint8Array {
  const bytes: number[] = [];
  const varint = (value: number) => {
    let v = value < 0 ? -2 * value - 1 : 2 * value; // zig-zag: small magnitudes, either sign, stay small
    while (v >= 0x80) {
      bytes.push((v % 0x80) | 0x80);
      v = Math.floor(v / 0x80);
    }
    bytes.push(v);
  };
  varint(coords.length);
  let lastX = 0;
  let lastY = 0;
  for (const [lng, lat] of coords) {
    const x = Math.round(lng * PRECISION);
    const y = Math.round(lat * PRECISION);
    varint(x - lastX);
    varint(y - lastY);
    lastX = x;
    lastY = y;
  }
  return Uint8Array.from(bytes);
}

function unpack(bytes: Uint8Array): Point[] {
  let at = 0;
  const varint = (): number => {
    let value = 0;
    let scale = 1;
    for (;;) {
      if (at >= bytes.length) throw new Error('track data is cut short');
      const byte = bytes[at++];
      value += (byte & 0x7f) * scale;
      if (byte < 0x80) break;
      scale *= 0x80;
    }
    return value % 2 ? -(value + 1) / 2 : value / 2;
  };
  const count = varint();
  if (count < 2 || count > 200000) throw new Error('not a track');
  const coords: Point[] = [];
  let x = 0;
  let y = 0;
  for (let i = 0; i < count; i++) {
    x += varint();
    y += varint();
    const lng = x / PRECISION;
    const lat = y / PRECISION;
    if (!Number.isFinite(lng) || !Number.isFinite(lat) || Math.abs(lng) > 180 || Math.abs(lat) > 90) throw new Error('track coordinates out of range');
    coords.push([lng, lat]);
  }
  return coords;
}

const MAX_PIPE_BYTES = 2 * 1024 * 1024; // guard against decompression bombs

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  const writing = writer
    .write(bytes as Uint8Array<ArrayBuffer>)
    .then(() => writer.close())
    .catch(() => {});
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_PIPE_BYTES) {
        await reader.cancel().catch(() => {});
        throw new Error('shared data is too large');
      }
      chunks.push(value);
    }
  } finally {
    await writing;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

export interface PackedTrack {
  text: string;
  points: number;
  /** How far (metres) the packed line may stray from the original. */
  tolerance: number;
}

/**
 * Packs a track, simplifying it as far as needed to fit `budget` characters.
 * A day tour fits at a few metres' accuracy; very long tracks get coarser.
 */
export async function encodeTrack(coords: Point[], budget = 6000): Promise<PackedTrack> {
  let tolerance = 4;
  for (;;) {
    const kept = simplify(coords, tolerance).map((i) => coords[i]);
    const raw = pack(kept);
    let version = 0;
    let payload = raw;
    if (typeof CompressionStream !== 'undefined') {
      const compressed = await pipe(raw, new CompressionStream('deflate-raw'));
      if (compressed.length < raw.length) {
        version = 1;
        payload = compressed;
      }
    }
    const text = toBase64Url(Uint8Array.from([version, ...payload]));
    if (text.length <= budget || kept.length <= 2 || tolerance > 2000) return { text, points: kept.length, tolerance };
    tolerance *= 1.5;
  }
}

export async function decodeTrack(text: string): Promise<Point[]> {
  const bytes = fromBase64Url(text);
  const version = bytes[0];
  const payload = bytes.subarray(1);
  if (version === 0) return unpack(payload);
  if (version === 1) {
    if (typeof DecompressionStream === 'undefined') throw new Error('this browser cannot unpack compressed links');
    return unpack(await pipe(payload, new DecompressionStream('deflate-raw')));
  }
  throw new Error('this link was made by a newer version of the viewer');
}

// ── a whole view in one short parameter ──
//
// Versions 2 (plain) and 3 (deflate): [length of header][header: UTF-8 JSON {h: hash text, n: track
// name}][track as above, may be absent]. Everything is compressed together, so the map position,
// layers and track cost less than each would alone.

export interface SharedView {
  /** The viewer's ordinary hash text (map position, layers, …) without any track. */
  hash: string;
  name: string;
  coords: Point[] | null;
}

/** Packs view and track into one text, simplifying the track as far as needed to fit `budget` characters. */
export async function encodeShare(view: SharedView, budget = 6000): Promise<PackedTrack> {
  const header = new TextEncoder().encode(JSON.stringify({ h: view.hash, n: view.name }));
  if (header.length > 0xffff) throw new Error('view too large to share');
  const coords = view.coords ?? [];
  let tolerance = 4;
  for (;;) {
    const kept = coords.length > 1 ? simplify(coords, tolerance).map((i) => coords[i]) : [];
    const raw = Uint8Array.from([header.length >> 8, header.length & 0xff, ...header, ...(kept.length ? pack(kept) : [])]);
    let version = 2;
    let payload = raw;
    if (typeof CompressionStream !== 'undefined') {
      const compressed = await pipe(raw, new CompressionStream('deflate-raw'));
      if (compressed.length < raw.length) {
        version = 3;
        payload = compressed as Uint8Array<ArrayBuffer>;
      }
    }
    const text = toBase64Url(Uint8Array.from([version, ...payload]));
    if (text.length <= budget || kept.length <= 2 || tolerance > 2000) return { text, points: kept.length, tolerance };
    tolerance *= 1.5;
  }
}

export async function decodeShare(text: string): Promise<SharedView> {
  const bytes = fromBase64Url(text);
  const version = bytes[0];
  if (version !== 2 && version !== 3) throw new Error('this link was made by a newer version of the viewer');
  if (version === 3 && typeof DecompressionStream === 'undefined') throw new Error('this browser cannot unpack compressed links');
  const raw = version === 3 ? await pipe(bytes.subarray(1), new DecompressionStream('deflate-raw')) : bytes.subarray(1);
  if (raw.length < 2) throw new Error('incomplete shared link');
  const length = (raw[0] << 8) | raw[1];
  if (raw.length < 2 + length) throw new Error('incomplete shared link');
  const header = JSON.parse(new TextDecoder().decode(raw.subarray(2, 2 + length)));
  const rest = raw.subarray(2 + length);
  return { hash: String(header.h ?? ''), name: String(header.n ?? ''), coords: rest.length ? unpack(rest) : null };
}

/**
 * A track name as a readable piece of a link ("Piz Buin (ski).gpx" becomes "Piz-Buin-ski"), so the
 * link says what it shows wherever it is pasted. Empty if nothing readable is left.
 */
export function linkName(name: string): string {
  return name
    .replace(/\.(gpx|tcx|fit|kml|geojson)$/i, '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '') // accents off: plain letters survive every chat program's link detection
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/, '');
}
