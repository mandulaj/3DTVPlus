// `shadow://{z}/{x}/{y}?t={epoch ms}` tile protocol: shadow masks computed in a worker pool.
import * as maplibregl from 'maplibre-gl';
import { DEM_TILES } from '../map';
import ShadowWorker from './shadow.worker?worker&inline';
import type { ShadowRequest, ShadowResponse } from './shadow.worker';

const SHADOW_TILE_SIZE = 256; // must match N in shadow.worker.ts

interface Pending {
  resolve: (bitmap: ImageBitmap) => void;
  reject: (error: Error) => void;
}

export const shadowStats = { tiles: 0, totalMs: 0 };

let workers: Worker[] = [];
const pending = new Map<number, Pending>();
let nextId = 1;

function ensureWorkers(): void {
  if (workers.length) return;
  const count = Math.max(1, Math.min(4, Math.floor((navigator.hardwareConcurrency || 4) / 2)));
  workers = Array.from({ length: count }, () => {
    const worker = new ShadowWorker();
    worker.onmessage = (event: MessageEvent<ShadowResponse>) => {
      const message = event.data;
      const entry = pending.get(message.id);
      if (!entry) return;
      pending.delete(message.id);
      if (message.ok) {
        shadowStats.tiles++;
        shadowStats.totalMs += message.ms;
        createImageBitmap(new ImageData(message.pixels, SHADOW_TILE_SIZE, SHADOW_TILE_SIZE)).then(entry.resolve, entry.reject);
      } else {
        const error = new Error(message.aborted ? 'aborted' : (message.error ?? 'shadow tile failed'));
        if (message.aborted) error.name = 'AbortError';
        entry.reject(error);
      }
    };
    return worker;
  });
}

export function registerShadowProtocol(): void {
  maplibregl.addProtocol('shadow', (params, abortController) => {
    const match = /^shadow:\/\/(\d+)\/(\d+)\/(\d+)\?t=(\d+)/.exec(params.url);
    if (!match) return Promise.reject(new Error(`bad shadow url ${params.url}`));
    ensureWorkers();
    const [z, x, y, time] = match.slice(1).map(Number);
    const id = nextId++;
    // Neighbouring tiles share most elevation data: route them to the same worker's cache.
    const worker = workers[((x >> 2) * 31 + (y >> 2) * 17 + z) % workers.length];
    return new Promise<{ data: ImageBitmap }>((resolve, reject) => {
      pending.set(id, { resolve: (bitmap) => resolve({ data: bitmap }), reject });
      abortController.signal.addEventListener('abort', () => {
        if (pending.has(id)) worker.postMessage({ type: 'abort', id });
      });
      const request: ShadowRequest = { type: 'tile', id, z, x, y, time, demUrl: DEM_TILES };
      worker.postMessage(request);
    });
  });
}
