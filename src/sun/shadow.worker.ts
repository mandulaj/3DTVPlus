/// <reference lib="webworker" />
// Computes cast-shadow tiles by sweeping a shadow surface across a pyramid of elevation
// mosaics, away from the sun: coarse mosaics for distant terrain, fine ones near the tile.
import * as SunCalc from 'suncalc';

export interface ShadowRequest {
  type: 'tile';
  id: number;
  z: number;
  x: number;
  y: number;
  time: number;
  demUrl: string;
}
export interface ShadowAbort {
  type: 'abort';
  id: number;
}
export type ShadowResponse =
  | { id: number; ok: true; pixels: Uint8ClampedArray<ArrayBuffer>; ms: number }
  | { id: number; ok: false; aborted: boolean; error?: string };

const N = 256; // elevation samples per tile edge (512 px tiles averaged 2×2)
const MOSAIC = 3 * N;
const LEVELS = 4; // zooms z, z-2, z-4, z-6
const MIN_LEVEL_ZOOM = 6; // coarser mosaics span so much of the globe that one sun direction no longer fits
const EARTH_RADIUS = 6371008;
const CIRCUMFERENCE = 40075016.686;
const PENUMBRA = Math.tan((0.35 * Math.PI) / 180); // sun half-width, slightly softened
const GRAZING = 0.14; // cosine of incidence below which a slope starts to darken
const CACHE_LIMIT = 60;
const SHADOW_RGB = [10, 16, 48]; // cool, dark
const SUNLIT_RGB = [255, 214, 140]; // warm tint on ground the sun reaches
const SUNLIT_ALPHA = 0.18;
const SLOPE_SHADE = 0.45; // how dark a sunlit slope may get from its angle alone: must not read as cast shadow

interface DemTile {
  data: Float32Array; // N×N metres
  max: number;
}

const cache = new Map<string, Promise<DemTile | null>>();

function loadDem(demUrl: string, z: number, x: number, y: number): Promise<DemTile | null> {
  const count = 2 ** z;
  if (y < 0 || y >= count) return Promise.resolve(null);
  x = ((x % count) + count) % count;
  const key = `${z}/${x}/${y}`;
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key); // refresh LRU position
    cache.set(key, hit);
    return hit;
  }
  const promise = fetchDem(demUrl.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)));
  promise.catch(() => cache.delete(key));
  cache.set(key, promise);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return promise;
}

/**
 * Decodes an elevation image to RGBA bytes. WebCodecs decodes on the CPU inside this worker;
 * the canvas fallback goes through the GPU process, and many such readbacks stall the map's
 * own texture uploads.
 */
async function decodeRgba(response: Response): Promise<{ px: Uint8Array | Uint8ClampedArray; size: number }> {
  const type = response.headers.get('content-type') ?? 'image/webp';
  if (typeof ImageDecoder !== 'undefined' && !decoderBroken) {
    const buffer = await response.arrayBuffer();
    try {
      const decoder = new ImageDecoder({ data: buffer, type, colorSpaceConversion: 'none' });
      const { image } = await decoder.decode();
      const size = image.codedWidth;
      const px = new Uint8Array(size * image.codedHeight * 4);
      await image.copyTo(px, { format: 'RGBA' });
      image.close();
      decoder.close();
      return { px, size };
    } catch {
      decoderBroken = true; // unsupported here: use the canvas from now on
      return decodeWithCanvas(new Blob([buffer], { type }));
    }
  }
  return decodeWithCanvas(await response.blob());
}
let decoderBroken = false;

async function decodeWithCanvas(blob: Blob): Promise<{ px: Uint8ClampedArray; size: number }> {
  const bitmap = await createImageBitmap(blob, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const size = bitmap.width;
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();
  return { px: ctx.getImageData(0, 0, size, size).data, size };
}

async function fetchDem(url: string): Promise<DemTile | null> {
  const response = await fetch(url);
  if (response.status === 404 || response.status === 204) return null; // no data: treated as sea level
  if (!response.ok) throw new Error(`DEM ${response.status}`);
  const { px, size } = await decodeRgba(response);
  const data = new Float32Array(N * N);
  const f = size / N; // decode at full resolution first: encoded bytes must not be averaged
  let max = -Infinity;
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      let sum = 0;
      for (let dj = 0; dj < f; dj++) {
        for (let di = 0; di < f; di++) {
          const o = ((j * f + dj) * size + i * f + di) * 4;
          sum += px[o] * 256 + px[o + 1] + px[o + 2] / 256 - 32768; // terrarium
        }
      }
      const h = sum / (f * f);
      data[j * N + i] = h;
      if (h > max) max = h;
    }
  }
  return { data, max };
}

interface Level {
  grid: Float32Array; // MOSAIC×MOSAIC heights
  px: number; // size of one level px in level-0 px (1, 4, 16 …)
  offX: number; // level px of the tile's origin inside the mosaic
  offY: number;
  key: string;
}

async function buildLevel(demUrl: string, z: number, x: number, y: number, k: number): Promise<Level> {
  const shift = 2 * k;
  const zk = z - shift;
  const ax = x >> shift;
  const ay = y >> shift;
  const px = 2 ** shift;
  const key = `${zk}/${ax}/${ay}`;
  const offsets = { px, offX: (x * N) / px - (ax - 1) * N, offY: (y * N) / px - (ay - 1) * N, key };
  // Neighbouring tiles share mosaics (always at coarse levels): keep the most recent ones.
  const known = mosaicCache.get(key);
  if (known) {
    mosaicCache.delete(key);
    mosaicCache.set(key, known);
    return { grid: known, ...offsets };
  }
  const tiles = await Promise.all(
    Array.from({ length: 9 }, (_, i) => loadDem(demUrl, zk, ax - 1 + (i % 3), ay - 1 + Math.floor(i / 3))),
  );
  const grid = new Float32Array(MOSAIC * MOSAIC);
  tiles.forEach((tile, i) => {
    if (!tile) return;
    const ox = (i % 3) * N;
    const oy = Math.floor(i / 3) * N;
    for (let row = 0; row < N; row++) grid.set(tile.data.subarray(row * N, (row + 1) * N), (oy + row) * MOSAIC + ox);
  });
  mosaicCache.set(key, grid);
  if (mosaicCache.size > MOSAIC_CACHE_LIMIT) mosaicCache.delete(mosaicCache.keys().next().value!);
  return { grid, ...offsets };
}
const mosaicCache = new Map<string, Float32Array>();
const MOSAIC_CACHE_LIMIT = 16;

/**
 * Shadow state of one mosaic: for every cell the height of the shadow surface arriving from
 * the sun side (lower edge of the sun disc) and the distance to the terrain that casts it.
 */
interface Field {
  height: Float32Array;
  distance: Float32Array;
  level: Level;
}

const scratchHeight = new Float32Array(MOSAIC * MOSAIC);
const scratchDistance = new Float32Array(MOSAIC * MOSAIC);
const scratchShade = new Float32Array(N * N);
const NONE = -20000; // "no shadow surface here"
const fieldCache = new Map<string, Field>();
const FIELD_CACHE_LIMIT = 8;

interface Sun {
  dirX: number; // toward the sun, grid axes (+x east, +y south)
  dirY: number;
  tanLow: number; // tangent of the altitude of the sun's lower edge
}

/**
 * One pass over the mosaic, from the sun side to the far side. Each cell takes the shadow surface
 * of the cell before it along the sun's direction, lowered by the sun's slope over that step, and
 * replaces it where the terrain rises above it. Cells with nothing before them inside the mosaic
 * start from `coarser`, which carries shadows of terrain further away.
 *
 * `shade`, when given, receives the hidden fraction of the sun disc for the centre tile.
 */
function sweep(level: Level, sun: Sun, metresPerPx: number, coarser: Field | null, shade: Float32Array | null): Field {
  const M = MOSAIC;
  const g = level.grid;
  // The finest level's field is used once: reuse its memory instead of allocating 5 MB per tile.
  const height = shade ? scratchHeight : new Float32Array(M * M);
  const distance = shade ? scratchDistance : new Float32Array(M * M);
  const majorX = Math.abs(sun.dirX) >= Math.abs(sun.dirY);
  const major = majorX ? sun.dirX : sun.dirY;
  const minor = majorX ? sun.dirY : sun.dirX;
  const forward = major > 0 ? -1 : 1; // shadows travel away from the sun
  const drift = -minor / Math.abs(major); // minor-axis shift per major-axis step
  const strideA = majorX ? 1 : M;
  const strideB = majorX ? M : 1;
  const step = Math.sqrt(1 + drift * drift) * metresPerPx * level.px;
  const fall = step * sun.tanLow;
  const first = forward === 1 ? 0 : M - 1;
  // For the finest level only the cells up to the far edge of the centre tile matter.
  const count = shade ? 2 * N : M;

  // Position of a cell in the coarser mosaic.
  const ratio = coarser ? level.px / coarser.level.px : 0;
  const cg = coarser?.height;
  const cd = coarser?.distance;
  const coarseX = coarser ? coarser.level.offX - level.offX * ratio + 0.5 * ratio - 0.5 : 0;
  const coarseY = coarser ? coarser.level.offY - level.offY * ratio + 0.5 * ratio - 0.5 : 0;
  const limit = M - 1.001;

  for (let n = 0; n < count; n++) {
    const a = first + forward * n;
    const row = a * strideA;
    const before = row - forward * strideA;
    for (let b = 0; b < M; b++) {
      const o = row + b * strideB;
      const source = b - drift;
      const b0 = Math.floor(source);
      let h: number;
      let d: number;
      if (n > 0 && b0 >= 0 && b0 < M - 1) {
        const f = source - b0;
        const p = before + b0 * strideB;
        d = distance[p] + (distance[p + strideB] - distance[p]) * f + step;
        h = height[p] + (height[p + strideB] - height[p]) * f - fall - (d * step) / EARTH_RADIUS;
      } else if (cg && cd) {
        const cx = coarseX + (majorX ? a : b) * ratio;
        const cy = coarseY + (majorX ? b : a) * ratio;
        if (cx < 0 || cy < 0 || cx > limit || cy > limit) {
          h = NONE;
          d = 0;
        } else {
          const ix = cx | 0;
          const iy = cy | 0;
          const fx = cx - ix;
          const fy = cy - iy;
          const q = iy * M + ix;
          const top = cg[q] + (cg[q + 1] - cg[q]) * fx;
          const bottom = cg[q + M] + (cg[q + M + 1] - cg[q + M]) * fx;
          h = top + (bottom - top) * fy;
          const dTop = cd[q] + (cd[q + 1] - cd[q]) * fx;
          const dBottom = cd[q + M] + (cd[q + M + 1] - cd[q + M]) * fx;
          d = dTop + (dBottom - dTop) * fy;
        }
      } else {
        h = NONE;
        d = 0;
      }
      const ground = g[o];
      if (ground >= h) {
        height[o] = ground;
        distance[o] = 0;
      } else {
        height[o] = h;
        distance[o] = d;
        if (shade) {
          const x = majorX ? a : b;
          const y = majorX ? b : a;
          if (x >= N && x < 2 * N && y >= N && y < 2 * N) {
            // Depth below the shadow surface against the width of the penumbra at this distance.
            const hidden = (h - ground) / (2 * PENUMBRA * d + 0.01);
            shade[(y - N) * N + (x - N)] = hidden > 1 ? 1 : hidden;
          }
        }
      }
    }
  }
  return { height, distance, level };
}

// Returns raw RGBA. The bitmap is created on the main thread: a bitmap made here blocks
// the main thread's texture upload until this (busy) worker yields.
async function compute(req: ShadowRequest): Promise<Uint8ClampedArray<ArrayBuffer>> {
  const { z, x, y } = req;
  const out = new Uint8ClampedArray(new ArrayBuffer(N * N * 4));
  for (let i = 0; i < N * N; i++) {
    out[i * 4] = SHADOW_RGB[0];
    out[i * 4 + 1] = SHADOW_RGB[1];
    out[i * 4 + 2] = SHADOW_RGB[2];
  }

  const count = 2 ** z;
  const latOf = (ty: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * ty) / count))) * 180) / Math.PI;
  const lng = ((x + 0.5) / count) * 360 - 180;
  // suncalc 2 returns degrees: azimuth clockwise from north, apparent altitude
  const position = SunCalc.getPosition(new Date(req.time), latOf(y + 0.5), lng);
  const altitude = (position.altitude * Math.PI) / 180;

  if (altitude < -PENUMBRA) {
    for (let i = 0; i < N * N; i++) out[i * 4 + 3] = 255; // night
    return out;
  }

  const levels: Level[] = [];
  for (let k = 0; k < LEVELS && (k === 0 || z - 2 * k >= MIN_LEVEL_ZOOM); k++) levels.push(await buildLevel(req.demUrl, z, x, y, k));
  if (aborted.delete(req.id)) throw new AbortError();

  const bearing = (position.azimuth * Math.PI) / 180;
  const sun: Sun = { dirX: Math.sin(bearing), dirY: -Math.cos(bearing), tanLow: Math.tan(altitude) - PENUMBRA };
  const metresPerPx = (CIRCUMFERENCE * Math.cos((latOf(y + 0.5) * Math.PI) / 180)) / (count * N);

  // Coarsest first; coarse fields are shared by all tiles under the same ancestor.
  const shade = scratchShade.fill(0);
  let field: Field | null = null;
  for (let k = levels.length - 1; k >= 0; k--) {
    const level = levels[k];
    if (k === 0) {
      field = sweep(level, sun, metresPerPx, field, shade);
      break;
    }
    const key = `${level.key}@${req.time}`;
    let cached = fieldCache.get(key);
    if (!cached) {
      cached = sweep(level, sun, metresPerPx, field, null);
      fieldCache.set(key, cached);
      if (fieldCache.size > FIELD_CACHE_LIMIT) fieldCache.delete(fieldCache.keys().next().value!);
    }
    // The arrays are shared between tiles; where this tile sits inside them (`level`) is not.
    field = { height: cached.height, distance: cached.distance, level };
  }

  // Unit vector toward the sun, for slope (attached) shading.
  const lightX = sun.dirX * Math.cos(altitude);
  const lightY = sun.dirY * Math.cos(altitude);
  const lightZ = Math.sin(altitude);
  const base = levels[0].grid;
  // The warm tint fades out as the sun sinks to the horizon.
  const warmth = SUNLIT_ALPHA * Math.min(1, Math.max(0, lightZ / 0.12));
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      let cast = shade[j * N + i];
      cast = cast * cast * (3 - 2 * cast);
      // Slopes turned away from the sun, or lit at a grazing angle, darken too.
      const o = (N + j) * MOSAIC + N + i;
      const dzdx = (base[o + 1] - base[o - 1]) / (2 * metresPerPx);
      const dzdy = (base[o + MOSAIC] - base[o - MOSAIC]) / (2 * metresPerPx);
      let facing = (lightZ - dzdx * lightX - dzdy * lightY) / Math.sqrt(1 + dzdx * dzdx + dzdy * dzdy) / GRAZING;
      facing = facing < 0 ? 0 : facing > 1 ? 1 : facing;
      facing = facing * facing * (3 - 2 * facing);
      // Two tones: dark where the sun is hidden, warm where it shines. Mixed as premultiplied colours.
      const dark = cast + (1 - cast) * (1 - facing) * SLOPE_SHADE;
      const warm = (1 - dark) * warmth;
      const alpha = dark + warm;
      const q = (j * N + i) * 4;
      out[q] = (SHADOW_RGB[0] * dark + SUNLIT_RGB[0] * warm) / alpha;
      out[q + 1] = (SHADOW_RGB[1] * dark + SUNLIT_RGB[1] * warm) / alpha;
      out[q + 2] = (SHADOW_RGB[2] * dark + SUNLIT_RGB[2] * warm) / alpha;
      out[q + 3] = alpha * 255;
    }
  }
  return out;
}

class AbortError extends Error {}

// ── request queue: newest first, aborted requests dropped before any work ──

const queue: ShadowRequest[] = [];
const aborted = new Set<number>();
let running = false;

async function pump(): Promise<void> {
  if (running) return;
  running = true;
  while (queue.length) {
    const req = queue.pop()!;
    if (aborted.delete(req.id)) {
      post({ id: req.id, ok: false, aborted: true });
      continue;
    }
    const started = performance.now();
    try {
      const pixels = await compute(req);
      post({ id: req.id, ok: true, pixels, ms: performance.now() - started }, [pixels.buffer]);
    } catch (err) {
      post({ id: req.id, ok: false, aborted: err instanceof AbortError, error: String((err as Error).message ?? err) });
    }
    aborted.delete(req.id);
  }
  running = false;
}

function post(message: ShadowResponse, transfer: Transferable[] = []): void {
  (self as DedicatedWorkerGlobalScope).postMessage(message, transfer);
}

self.onmessage = (event: MessageEvent<ShadowRequest | ShadowAbort>) => {
  const message = event.data;
  if (message.type === 'abort') {
    const index = queue.findIndex((r) => r.id === message.id);
    if (index >= 0) {
      queue.splice(index, 1);
      post({ id: message.id, ok: false, aborted: true });
    } else {
      aborted.add(message.id); // may be mid-flight; checked before the heavy loop
    }
    return;
  }
  queue.push(message);
  void pump();
};
