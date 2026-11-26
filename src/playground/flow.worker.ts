// Runs the toy avalanche off the main thread and sends back pictures of it.
import { advance, emptyState, type FlowGrid, type FlowParams, type FlowState } from './flow';

export type FlowMessage =
  | { type: 'start'; grid: FlowGrid; depth: Float32Array; params: FlowParams }
  | { type: 'params'; params: FlowParams }
  | { type: 'stop' };

export interface FlowFrame {
  /** Snow depth in centimetres (capped at 255) and speed in m/s per cell. */
  depth: Uint8Array;
  speed: Uint8Array;
  seconds: number;
  fastest: number;
  /** The flow has come to rest: `final` holds the exact depths. */
  final?: Float32Array;
}

const STEP = 0.4; // simulated seconds per picture
const PACE = 45; // milliseconds between pictures: a little faster than real time

let grid: FlowGrid | null = null;
let state: FlowState | null = null;
let params: FlowParams = { mu: 0.25, xi: 1500 };
let timer: ReturnType<typeof setTimeout> | undefined;
let seconds = 0;
let calm = 0;

function tick(): void {
  if (!grid || !state) return;
  const fastest = advance(grid, state, params, STEP);
  seconds += STEP;
  calm = fastest < 0.5 ? calm + 1 : 0;
  const n = state.depth.length;
  const frame: FlowFrame = { depth: new Uint8Array(n), speed: new Uint8Array(n), seconds, fastest };
  for (let i = 0; i < n; i++) {
    frame.depth[i] = Math.min(255, Math.round(state.depth[i] * 100));
    frame.speed[i] = Math.min(255, Math.round(Math.hypot(state.u[i], state.v[i])));
  }
  const done = calm >= 5 || seconds > 600;
  if (done) frame.final = state.depth.slice();
  (self as DedicatedWorkerGlobalScope).postMessage(frame, [frame.depth.buffer, frame.speed.buffer, ...(frame.final ? [frame.final.buffer] : [])]);
  if (!done) timer = setTimeout(tick, PACE);
}

self.onmessage = (event: MessageEvent<FlowMessage>) => {
  const message = event.data;
  clearTimeout(timer);
  if (message.type === 'params') {
    params = message.params;
    if (state) timer = setTimeout(tick, PACE);
    return;
  }
  if (message.type === 'stop') {
    state = null;
    return;
  }
  grid = message.grid;
  params = message.params;
  state = emptyState(grid);
  state.depth.set(message.depth);
  seconds = 0;
  calm = 0;
  tick();
};
