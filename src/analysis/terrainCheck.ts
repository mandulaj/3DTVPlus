// Avalanche terrain check: classifies every cell of an elevation grid from slope steepness, aspect
// and height against a danger level, after the Graphical Reduction Method (SLF/SAC "Achtung
// Lawinen!"). A planning aid for looking at terrain: it knows nothing about the actual snowpack.
//
// Pure functions: used in a worker and in tests.

export interface Grid {
  width: number;
  height: number;
  /** Metres between cells, the same in both directions. Row 0 is the northern edge. */
  cell: number;
  heights: Float32Array;
}

/** Conditions for one cell or for all cells. */
export interface Conditions {
  /** Danger level 1-5 per cell (0: no information, the cell is left unclassified). */
  level: Uint8Array;
  /** Critical aspects per cell as a bit set: bit 0 = N, 1 = NE, … 7 = NW. 255: all. */
  aspects: Uint8Array;
  /** Height above which the critical aspects apply, per cell (-1: at all heights). */
  above: Int16Array;
}

export const RISK = { NONE: 0, LOW: 1, ELEVATED: 2, HIGH: 3 } as const;
/** Bits added to the risk class. */
export const RUNOUT = 4;

export interface Result {
  /** Risk class per cell (RISK), plus RUNOUT where an avalanche from above could reach. */
  risk: Uint8Array;
  /** The slope angle that counted for each cell (degrees, rounded). */
  steepness: Uint8Array;
  /** Slope angle of the cell itself. */
  slope: Uint8Array;
}

const DEG = 180 / Math.PI;
/** From "moderate": the steepest part within this distance counts. */
export const NEAR_REACH = 20;
/** Ground is taken to release avalanches from this steepness. */
export const RELEASE_ANGLE = 30;
/** An avalanche runs out roughly where the line from its top falls at this angle. */
export const RUNOUT_ANGLE = 25;

/** Slope (degrees) and the compass direction the slope faces (degrees, 0 = north), Horn's method. */
export function slopeAspect(grid: Grid): { slope: Float32Array; aspect: Float32Array } {
  const { width: w, height: h, cell, heights: z } = grid;
  const slope = new Float32Array(w * h);
  const aspect = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const yn = Math.max(0, y - 1);
    const ys = Math.min(h - 1, y + 1);
    for (let x = 0; x < w; x++) {
      const xw = Math.max(0, x - 1);
      const xe = Math.min(w - 1, x + 1);
      const nw = z[yn * w + xw], n = z[yn * w + x], ne = z[yn * w + xe];
      const west = z[y * w + xw], east = z[y * w + xe];
      const sw = z[ys * w + xw], s = z[ys * w + x], se = z[ys * w + xe];
      // Height gained per metre going east and going north.
      const dzdx = (ne + 2 * east + se - (nw + 2 * west + sw)) / (8 * cell);
      const dzdy = (nw + 2 * n + ne - (sw + 2 * s + se)) / (8 * cell);
      const i = y * w + x;
      slope[i] = Math.atan(Math.hypot(dzdx, dzdy)) * DEG;
      // The slope faces downhill: opposite to the direction of steepest ascent.
      aspect[i] = (Math.atan2(-dzdx, -dzdy) * DEG + 360) % 360;
    }
  }
  return { slope, aspect };
}

/** Largest value within `reach` metres of each cell; with `onlyAbove`, among cells that lie higher. */
export function steepestWithin(grid: Grid, slope: Float32Array, reach: number, onlyAbove = false): Float32Array {
  const { width: w, height: h, cell, heights: z } = grid;
  const r = Math.max(1, Math.round(reach / cell));
  const offsets: [number, number][] = [];
  for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) if (dx * dx + dy * dy <= r * r) offsets.push([dx, dy]);
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let best = slope[i];
      const here = z[i];
      for (const [dx, dy] of offsets) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (slope[j] > best && (!onlyAbove || z[j] > here)) best = slope[j];
      }
      out[i] = best;
    }
  }
  return out;
}

/**
 * Risk class after the Graphical Reduction Method, for a danger level and the steepness that
 * counts at that level. Outside the bulletin's critical aspects and heights ("favourable") the
 * danger is taken one level lower.
 */
export function riskClass(level: number, steepness: number, favourable: boolean): number {
  const effective = favourable ? level - 1 : level;
  if (effective <= 0) return RISK.LOW;
  if (effective === 1) return steepness >= 40 ? RISK.ELEVATED : RISK.LOW;
  if (effective === 2) return steepness >= 40 ? RISK.HIGH : steepness >= 35 ? RISK.ELEVATED : RISK.LOW;
  if (effective === 3) return steepness >= 35 ? RISK.HIGH : steepness >= 30 ? RISK.ELEVATED : RISK.LOW;
  return steepness >= 30 ? RISK.HIGH : RISK.ELEVATED; // high and very high: no steep terrain at all
}

/** Which of the 8 compass sectors a direction falls in (0 = N, 1 = NE, …). */
export const sectorOf = (aspect: number): number => Math.round(aspect / 45) % 8;

/**
 * Cells an avalanche released above could reach: an "energy line" starts at every release cell
 * and falls at RUNOUT_ANGLE going downhill; where it is still above the ground, the ground is in
 * reach. `release` marks the cells avalanches are taken to start from.
 */
export function runout(grid: Grid, release: Uint8Array, angle = RUNOUT_ANGLE): Uint8Array {
  const { width: w, height: h, cell, heights: z } = grid;
  const drop = Math.tan(angle / DEG);
  const energy = new Float32Array(w * h).fill(-Infinity);
  // Cells are handled from the highest energy line down (a binary heap of cell numbers).
  const heap: number[] = [];
  const push = (i: number) => {
    let at = heap.length;
    heap.push(i);
    while (at > 0) {
      const parent = (at - 1) >> 1;
      if (energy[heap[parent]] >= energy[i]) break;
      heap[at] = heap[parent];
      at = parent;
    }
    heap[at] = i;
  };
  const pop = (): number => {
    const top = heap[0];
    const last = heap.pop()!;
    if (heap.length) {
      let at = 0;
      for (;;) {
        let child = 2 * at + 1;
        if (child >= heap.length) break;
        if (child + 1 < heap.length && energy[heap[child + 1]] > energy[heap[child]]) child++;
        if (energy[heap[child]] <= energy[last]) break;
        heap[at] = heap[child];
        at = child;
      }
      heap[at] = last;
    }
    return top;
  };
  for (let i = 0; i < release.length; i++) {
    if (release[i]) {
      energy[i] = z[i];
      push(i);
    }
  }
  const out = new Uint8Array(w * h);
  const done = new Uint8Array(w * h);
  while (heap.length) {
    const i = pop();
    if (done[i]) continue;
    done[i] = 1;
    if (!release[i]) out[i] = 1;
    const x = i % w;
    const y = (i - x) / w;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const j = ny * w + nx;
        if (done[j] || z[j] > z[i]) continue; // snow does not run uphill
        const arriving = energy[i] - drop * cell * (dx && dy ? Math.SQRT2 : 1);
        if (arriving >= z[j] && arriving > energy[j]) {
          energy[j] = arriving;
          push(j);
        }
      }
    }
  }
  return out;
}

/**
 * The whole check for a grid. Cells outside `mask` (if given) are left unclassified.
 *
 * Every cell is judged twice and the worse result kept: against the steepest ground close by that
 * lies in the critical aspects and heights, at the full danger level; and against the steepest
 * ground close by of any kind, one level lower. "Close by" is the spot itself at "low" and 20 m
 * around from "moderate". Steep critical ground further up is not folded into the class (in the
 * mountains nearly every spot has some above it): the ground it could reach is marked RUNOUT.
 */
export function check(grid: Grid, conditions: Conditions, mask?: Uint8Array): Result {
  const n = grid.width * grid.height;
  const { slope, aspect } = slopeAspect(grid);
  // Slope angle where the ground is critical, 0 elsewhere.
  const critical = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const inAspect = (conditions.aspects[i] >> sectorOf(aspect[i])) & 1;
    if (inAspect && (conditions.above[i] < 0 || grid.heights[i] >= conditions.above[i])) critical[i] = slope[i];
  }
  const near = steepestWithin(grid, slope, NEAR_REACH);
  const nearCritical = steepestWithin(grid, critical, NEAR_REACH);
  const risk = new Uint8Array(n);
  const steepness = new Uint8Array(n);
  const own = new Uint8Array(n);
  const release = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    own[i] = Math.min(90, Math.round(slope[i]));
    const level = conditions.level[i];
    if (!level) continue;
    const any = level <= 1 ? slope[i] : near[i];
    const bad = level <= 1 ? critical[i] : nearCritical[i];
    steepness[i] = Math.min(90, Math.round(any));
    if (critical[i] >= RELEASE_ANGLE) release[i] = 1;
    if (mask && !mask[i]) continue;
    risk[i] = Math.max(riskClass(level, bad, false), riskClass(level, any, true));
  }
  const reached = runout(grid, release);
  for (let i = 0; i < n; i++) if (reached[i] && (!mask || mask[i]) && conditions.level[i]) risk[i] |= RUNOUT;
  return { risk, steepness, slope: own };
}
