// A toy avalanche: snow as a thin layer flowing over the terrain, slowed by friction (Voellmy:
// a dry part that sets where it stops, a speed-dependent part that limits how fast it gets).
// For looking at how terrain steers a flow. It is not a forecast of real avalanches.
//
// Pure functions on a grid: used in a worker and in tests.

export interface FlowGrid {
  width: number;
  height: number;
  /** Metres between cells. Row 0 is the northern edge. */
  cell: number;
  /** Ground height. */
  ground: Float32Array;
}

export interface FlowState {
  /** Snow depth in metres. */
  depth: Float32Array;
  /** Velocity in metres per second, east and south (the direction rows grow). */
  u: Float32Array;
  v: Float32Array;
}

export interface FlowParams {
  /** Dry friction: the flow stops on ground flatter than atan(mu), e.g. 0.3 = 17°. */
  mu: number;
  /** Turbulent friction (m/s²): larger lets the flow run faster. */
  xi: number;
}

const G = 9.81;
const MIN_DEPTH = 0.02; // metres: thinner snow stays where it is
const MAX_SPEED = 70; // metres per second
// Depth used in the speed-dependent friction. The layer here spreads thinner than a real avalanche
// (which stays a dense body), and with its true depth it would stop dead at the foot of the slope.
const FLOW_DEPTH = 1.5;

export function emptyState(grid: FlowGrid): FlowState {
  const n = grid.width * grid.height;
  return { depth: new Float32Array(n), u: new Float32Array(n), v: new Float32Array(n) };
}

/** Total snow volume in cubic metres. */
export function volume(grid: FlowGrid, state: FlowState): number {
  let sum = 0;
  for (let i = 0; i < state.depth.length; i++) sum += state.depth[i];
  return sum * grid.cell * grid.cell;
}

/**
 * Advances the flow by up to `seconds` (in several small steps, as large as stability allows).
 * Returns the fastest speed reached, 0 once everything has come to rest.
 */
export function advance(grid: FlowGrid, state: FlowState, params: FlowParams, seconds: number): number {
  const { width: w, height: h, cell, ground } = grid;
  const { depth, u, v } = state;
  const n = w * h;
  const mass = new Float32Array(n);
  const mx = new Float32Array(n);
  const my = new Float32Array(n);
  let fastest = 0;
  let left = seconds;
  for (let guard = 0; left > 1e-6 && guard < 400; guard++) {
    // Accelerate: down the slope of the snow surface, against friction.
    let top = 0;
    const dtAccel = Math.min(left, 0.25);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (depth[i] < MIN_DEPTH) {
          u[i] = 0;
          v[i] = 0;
          continue;
        }
        const sx = (ground[i + 1] + depth[i + 1] - ground[i - 1] - depth[i - 1]) / (2 * cell);
        const sy = (ground[i + w] + depth[i + w] - ground[i - w] - depth[i - w]) / (2 * cell);
        const cos = 1 / Math.sqrt(1 + sx * sx + sy * sy);
        let ux = u[i] - G * sx * cos * dtAccel;
        let vy = v[i] - G * sy * cos * dtAccel;
        const speed = Math.hypot(ux, vy);
        if (speed > 0) {
          const brake = (params.mu * G * cos + (G * speed * speed) / (params.xi * FLOW_DEPTH)) * dtAccel;
          const kept = speed > brake ? Math.min(speed - brake, MAX_SPEED) / speed : 0;
          ux *= kept;
          vy *= kept;
        }
        u[i] = ux;
        v[i] = vy;
        const now = Math.hypot(ux, vy);
        if (now > top) top = now;
      }
    }
    if (top > fastest) fastest = top;
    if (top < 0.05) break; // at rest
    // Move: each cell hands a share of its snow (and its momentum) to the neighbours it flows toward.
    const dt = Math.min(dtAccel, (0.4 * cell) / top);
    mass.fill(0);
    mx.fill(0);
    my.fill(0);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const d = depth[i];
        if (d <= 0) continue;
        const fx = Math.min(0.45, (Math.abs(u[i]) * dt) / cell);
        const fy = Math.min(0.45, (Math.abs(v[i]) * dt) / cell);
        const stay = d * (1 - fx - fy);
        const give = (j: number, amount: number) => {
          mass[j] += amount;
          mx[j] += amount * u[i];
          my[j] += amount * v[i];
        };
        give(i, stay);
        if (fx > 0) give(u[i] > 0 ? i + 1 : i - 1, d * fx);
        if (fy > 0) give(v[i] > 0 ? i + w : i - w, d * fy);
      }
    }
    for (let i = 0; i < n; i++) {
      const y = (i / w) | 0;
      const x = i - y * w;
      // Snow reaching the edge of the area leaves it.
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) {
        depth[i] = 0;
        u[i] = 0;
        v[i] = 0;
        continue;
      }
      depth[i] = mass[i];
      if (mass[i] > 1e-6) {
        u[i] = mx[i] / mass[i];
        v[i] = my[i] / mass[i];
      } else {
        u[i] = 0;
        v[i] = 0;
      }
    }
    left -= dt;
  }
  return fastest;
}
