// Terrain height at arbitrary points, read from the same elevation tiles the 3D terrain uses.
import { DEM_TILES } from './map';

const SIZE = 512;
const ZOOMS = [13, 12]; // finer first; outside high-resolution areas only 12 exists
const CACHE_LIMIT = 24;

type Tile = Float32Array | null; // null: no data (sea level)
const cache = new Map<string, Promise<Tile>>();

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
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d', { willReadFrequently: true })!;
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  return context.getImageData(0, 0, canvas.width, canvas.height).data;
}

function loadTile(z: number, x: number, y: number): Promise<Tile> {
  const key = `${z}/${x}/${y}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const promise = (async (): Promise<Tile> => {
    const response = await fetch(DEM_TILES.replace('{z}', String(z)).replace('{x}', String(x)).replace('{y}', String(y)));
    if (response.status === 404 || response.status === 204) return null;
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

async function sample(lng: number, lat: number): Promise<number> {
  const mercatorX = (lng + 180) / 360;
  const mercatorY = (1 - Math.log(Math.tan((lat * Math.PI) / 180) + 1 / Math.cos((lat * Math.PI) / 180)) / Math.PI) / 2;
  for (const z of ZOOMS) {
    const n = 2 ** z;
    const tx = Math.floor(mercatorX * n);
    const ty = Math.floor(mercatorY * n);
    const tile = await loadTile(z, tx, ty);
    if (!tile) continue;
    // Bilinear inside the tile; at the very edge the last pixel is repeated.
    const px = Math.min(SIZE - 1.001, Math.max(0, (mercatorX * n - tx) * SIZE - 0.5));
    const py = Math.min(SIZE - 1.001, Math.max(0, (mercatorY * n - ty) * SIZE - 0.5));
    const ix = Math.floor(px);
    const iy = Math.floor(py);
    const fx = px - ix;
    const fy = py - iy;
    const o = iy * SIZE + ix;
    const top = tile[o] + (tile[o + 1] - tile[o]) * fx;
    const bottom = tile[o + SIZE] + (tile[o + SIZE + 1] - tile[o + SIZE]) * fx;
    return top + (bottom - top) * fy;
  }
  return 0;
}

/** Heights in metres for a list of [lng, lat] points. */
export async function elevations(points: [number, number][]): Promise<number[]> {
  const out: number[] = [];
  for (const [lng, lat] of points) out.push(await sample(lng, lat));
  return out;
}
