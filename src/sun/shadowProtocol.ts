// `shadow://{z}/{x}/{y}?t={epoch ms}` tile protocol: shadow masks computed in a worker pool.
import * as maplibregl from 'maplibre-gl';
import { DEM_TILES } from '../map';
import ShadowWorker from './shadow.worker?worker&inline';
import type { ShadowRequest, ShadowResponse } from './shadow.worker';

const SHADOW_TILE_SIZE = 256; // must match N in shadow.worker.ts

interface Pending {
  resolve: (bitmap: ImageBitmap) => void;
  reject: (error: Error) => void;
  since: number;
}

// A worker that died (out of memory) or hangs would leave its tiles waiting for ever, with no
// shadows and nothing happening when the time changes. The pool is replaced when that happens.
const STALL_MS = 25000;
const RESTART_PAUSE_MS = 60000;
let lastReply = 0;
let lastRestart = -Infinity;
let watchdog: number | undefined;
const handlers = { onRestart: () => {} };

/** Called after the worker pool had to be replaced: tiles in flight were dropped and must be asked for again. */
export function onShadowRestart(callback: () => void): void {
  handlers.onRestart = callback;
}

function restart(reason: string): void {
  const now = performance.now();
  if (now - lastRestart < RESTART_PAUSE_MS) return;
  lastRestart = now;
  console.warn(`Shadow workers restarted: ${reason}`);
  releaseShadowWorkers();
  handlers.onRestart();
}

function watch(): void {
  if (watchdog !== undefined) return;
  watchdog = window.setInterval(() => {
    if (!pending.size) {
      clearInterval(watchdog);
      watchdog = undefined;
      return;
    }
    const now = performance.now();
    let oldest = now;
    for (const entry of pending.values()) oldest = Math.min(oldest, entry.since);
    if (now - oldest > STALL_MS && now - lastReply > STALL_MS) restart('no answer');
  }, 5000);
}

export const shadowStats = { tiles: 0, totalMs: 0 };

let workers: Worker[] = [];
const pending = new Map<number, Pending>();
let nextId = 1;

function ensureWorkers(): void {
  if (workers.length) return;
  // Each worker holds its own elevation caches (roughly 100 MB): fewer of them on machines with little memory.
  const memory = (navigator as { deviceMemory?: number }).deviceMemory ?? 8;
  const count = Math.max(1, Math.min(memory <= 4 ? 2 : 3, Math.floor((navigator.hardwareConcurrency || 4) / 2)));
  workers = Array.from({ length: count }, () => {
    const worker = new ShadowWorker();
    worker.onmessage = (event: MessageEvent<ShadowResponse>) => {
      const message = event.data;
      lastReply = performance.now();
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
    worker.onerror = (event) => restart(event.message || 'worker failed');
    return worker;
  });
}

/** Sunlight switched off: give the workers' memory back. They start again on the next shadow tile. */
export function releaseShadowWorkers(): void {
  for (const worker of workers) worker.terminate();
  workers = [];
  for (const entry of pending.values()) {
    const error = new Error('aborted');
    error.name = 'AbortError';
    entry.reject(error);
  }
  pending.clear();
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
      pending.set(id, { resolve: (bitmap) => resolve({ data: bitmap }), reject, since: performance.now() });
      watch();
      abortController.signal.addEventListener('abort', () => {
        if (pending.has(id)) worker.postMessage({ type: 'abort', id });
      });
      const request: ShadowRequest = { type: 'tile', id, z, x, y, time, demUrl: DEM_TILES };
      worker.postMessage(request);
    });
  });
}
