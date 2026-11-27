// Terrain height at arbitrary points, read from the same elevation tiles the 3D terrain uses.
import { DEM_TILES } from './map';

const SIZE = 512;
const ZOOMS = [13, 12]; // finer first; outside high-resolution areas only 12 exists
const CACHE_LIMIT = 48;

type Tile = Float32Array | null; // null: no data (sea level)
const cache = new Map<string, Promise<Tile>>();
const missing = new Set<string>(); // 404/204 tiles tracked separately so they never evict real tiles
let decodeCanvas: OffscreenCanvas | null = null;
let decodeCtx: OffscreenCanvasRenderingContext2D | null = null;

const mercatorY = (lat: number): number =>
  (1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2;

async function decode(response: Response): Promise<Uint8Array | Uint8ClampedArray> {
  // WebCodecs gives exact bytes. Canvas read-back is deliberately perturbed by some browsers
  // (fingerprinting protection), which would show up as height errors.
  if (typeof ImageDecoder !== 'undefined') {
    try {
      const decoder = new ImageDecoder({ data: await response.clone().arrayBuffer(), type: response.headers.get('content-type') ?? 'image/webp', colorSpaceConversion: 'none' });
      const { image } = await decoder.decode();
      const px = new Uint8Array(image.codedWidth * image.codedHeight * 4);
      await image.copyTo(px, { format: 'RGBA' });
      image.close();
      decoder.close();
      return px;
    } catch {
      /* fall through to the canvas */
    }
  }
  const bitmap = await createImageBitmap(await response.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  if (!decodeCanvas || decodeCanvas.width !== bitmap.width || decodeCanvas.height !== bitmap.height) {
    decodeCanvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    decodeCtx = decodeCanvas.getContext('2d', { willReadFrequently: true })!;
  }
  decodeCtx!.drawImage(bitmap, 0, 0);
  bitmap.close();
  return decodeCtx!.getImageData(0, 0, decodeCanvas.width, decodeCanvas.height).data;
}

function loadTile(z: number, x: number, y: number): Promise<Tile> {
  const key = `${z}/${x}/${y}`;
  if (missing.has(key)) return Promise.resolve(null);
  const hit = cache.get(key);
  if (hit) {
    // True LRU: refresh insertion order on cache hit.
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const promise = (async (): Promise<Tile> => {
    const response = await fetch(DEM_TILES.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)), { signal: AbortSignal.timeout(15000) });
    if (response.status === 404 || response.status === 204) {
      missing.add(key);
      cache.delete(key);
      return null;
    }
    if (!response.ok) throw new Error(`Elevation data: HTTP ${response.status}`);
    const px = await decode(response);
    if (px.length !== SIZE * SIZE * 4) throw new Error('Elevation tile has an unexpected size');
    const heights = new Float32Array(SIZE * SIZE);
    for (let i = 0; i < SIZE * SIZE; i++) heights[i] = px[i * 4] * 256 + px[i * 4 + 1] + px[i * 4 + 2] / 256 - 32768; // terrarium
    return heights;
  })();
  promise.catch(() => cache.delete(key));
  cache.set(key, promise);
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return promise;
}

function bilinear(tile: Float32Array, mx: number, my: number, n: number, tx: number, ty: number): number {
  const px = Math.min(SIZE - 1.001, Math.max(0, (mx * n - tx) * SIZE - 0.5));
  const py = Math.min(SIZE - 1.001, Math.max(0, (my * n - ty) * SIZE - 0.5));
  const ix = Math.floor(px);
  const iy = Math.floor(py);
  const fx = px - ix;
  const fy = py - iy;
  const o = iy * SIZE + ix;
  const top = tile[o] + (tile[o + 1] - tile[o]) * fx;
  const bottom = tile[o + SIZE] + (tile[o + SIZE + 1] - tile[o + SIZE]) * fx;
  return top + (bottom - top) * fy;
}

/** Heights in metres for a list of [lng, lat] points (prefetches all unique tiles in parallel). */
export async function elevations(points: [number, number][]): Promise<number[]> {
  if (!points.length) return [];
  const projected = points.map(([lng, lat]): [number, number] => [(lng + 180) / 360, mercatorY(lat)]);
  const tiles = new Map<string, Tile>();
  // First fetch all distinct fine-zoom tiles in parallel; only fetch fallback zoom where missing.
  const fine = ZOOMS[0];
  const fineN = 2 ** fine;
  const fineKeys = new Map<string, [number, number]>();
  for (const [mx, my] of projected) {
    const tx = Math.floor(mx * fineN);
    const ty = Math.floor(my * fineN);
    const k = `${fine}/${tx}/${ty}`;
    if (!fineKeys.has(k)) fineKeys.set(k, [tx, ty]);
  }
  await Promise.all([...fineKeys.entries()].map(([k, [tx, ty]]) => loadTile(fine, tx, ty).then((t) => void tiles.set(k, t))));

  if (ZOOMS.length > 1) {
    const coarse = ZOOMS[1];
    const coarseN = 2 ** coarse;
    const coarseKeys = new Map<string, [number, number]>();
    for (const [mx, my] of projected) {
      const ftx = Math.floor(mx * fineN);
      const fty = Math.floor(my * fineN);
      if (tiles.get(`${fine}/${ftx}/${fty}`)) continue;
      const tx = Math.floor(mx * coarseN);
      const ty = Math.floor(my * coarseN);
      const k = `${coarse}/${tx}/${ty}`;
      if (!coarseKeys.has(k)) coarseKeys.set(k, [tx, ty]);
    }
    if (coarseKeys.size) {
      await Promise.all([...coarseKeys.entries()].map(([k, [tx, ty]]) => loadTile(coarse, tx, ty).then((t) => void tiles.set(k, t))));
    }
  }

  return projected.map(([mx, my]) => {
    for (const z of ZOOMS) {
      const n = 2 ** z;
      const tx = Math.floor(mx * n);
      const ty = Math.floor(my * n);
      const tile = tiles.get(`${z}/${tx}/${ty}`);
      if (tile) return bilinear(tile, mx, my, n, tx, ty);
    }
    return 0;
  });
}

/**
 * Heights on a regular grid over an area, row 0 along its northern edge. The tiles are loaded
 * first, then read without waiting: much faster than asking point by point.
 */
export async function heightGrid(west: number, south: number, east: number, north: number, columns: number, rows: number): Promise<Float32Array> {
  const tiles = new Map<string, Tile>();
  for (const z of ZOOMS) {
    const n = 2 ** z;
    const x0 = Math.floor(((west + 180) / 360) * n);
    const x1 = Math.floor(((east + 180) / 360) * n);
    const y0 = Math.floor(mercatorY(north) * n);
    const y1 = Math.floor(mercatorY(south) * n);
    const wanted: Promise<void>[] = [];
    for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) wanted.push(loadTile(z, x, y).then((tile) => void tiles.set(`${z}/${x}/${y}`, tile)));
    await Promise.all(wanted);
    // The finer zoom covers everything here: no need for the coarser one.
    if ([...tiles.values()].every((tile) => tile !== null)) break;
  }
  const out = new Float32Array(columns * rows);
  for (let row = 0; row < rows; row++) {
    const my = mercatorY(north - ((row + 0.5) / rows) * (north - south));
    for (let column = 0; column < columns; column++) {
      const mx = (west + ((column + 0.5) / columns) * (east - west) + 180) / 360;
      let height = 0;
      for (const z of ZOOMS) {
        const n = 2 ** z;
        const tx = Math.floor(mx * n);
        const ty = Math.floor(my * n);
        const tile = tiles.get(`${z}/${tx}/${ty}`);
        if (!tile) continue;
        height = bilinear(tile, mx, my, n, tx, ty);
        break;
      }
      out[row * columns + column] = height;
    }
  }
  return out;
}
