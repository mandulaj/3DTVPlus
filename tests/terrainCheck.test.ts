import { describe, expect, it } from 'vitest';
import { check, RISK, riskClass, RUNOUT, runout, sectorOf, slopeAspect, steepestWithin, type Conditions, type Grid } from '../src/analysis/terrainCheck';

/** A grid from a height function of metres east and metres north of its south-west corner. */
function grid(width: number, height: number, cell: number, z: (east: number, north: number) => number): Grid {
  const heights = new Float32Array(width * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) heights[y * width + x] = z(x * cell, (height - 1 - y) * cell);
  return { width, height, cell, heights };
}
const all = (g: Grid, level: number, aspects = 255, above = -1): Conditions => {
  const n = g.width * g.height;
  return { level: new Uint8Array(n).fill(level), aspects: new Uint8Array(n).fill(aspects), above: new Int16Array(n).fill(above) };
};
const tan = (deg: number) => Math.tan((deg * Math.PI) / 180);

describe('slopeAspect', () => {
  it('measures a plane that rises to the north as a 30° slope facing south', () => {
    const g = grid(9, 9, 10, (_e, n) => 1000 + n * tan(30));
    const { slope, aspect } = slopeAspect(g);
    const mid = 4 * 9 + 4;
    expect(slope[mid]).toBeCloseTo(30, 1);
    expect(aspect[mid]).toBeCloseTo(180, 1);
    expect(sectorOf(aspect[mid])).toBe(4);
  });
  it('gives a slope rising to the west an east aspect', () => {
    const g = grid(9, 9, 10, (e) => 1000 - e * tan(40));
    const { slope, aspect } = slopeAspect(g);
    expect(slope[40]).toBeCloseTo(40, 1);
    expect(aspect[40]).toBeCloseTo(90, 1);
  });
});

describe('riskClass', () => {
  it('follows the reduction method table', () => {
    expect(riskClass(1, 38, false)).toBe(RISK.LOW);
    expect(riskClass(1, 42, false)).toBe(RISK.ELEVATED);
    expect(riskClass(2, 33, false)).toBe(RISK.LOW);
    expect(riskClass(2, 37, false)).toBe(RISK.ELEVATED);
    expect(riskClass(2, 41, false)).toBe(RISK.HIGH);
    expect(riskClass(3, 28, false)).toBe(RISK.LOW);
    expect(riskClass(3, 32, false)).toBe(RISK.ELEVATED);
    expect(riskClass(3, 36, false)).toBe(RISK.HIGH);
    expect(riskClass(4, 25, false)).toBe(RISK.ELEVATED);
    expect(riskClass(4, 31, false)).toBe(RISK.HIGH);
  });
  it('takes favourable aspects one level lower', () => {
    expect(riskClass(3, 36, true)).toBe(riskClass(2, 36, false));
    expect(riskClass(1, 45, true)).toBe(RISK.LOW);
  });
});

describe('steepestWithin', () => {
  it('finds a steep step nearby, and only uphill when asked', () => {
    // Flat, then a 45° step up toward the east from 100 m on.
    const g = grid(30, 5, 10, (e) => (e < 100 ? 0 : (e - 100) * 1));
    const { slope } = slopeAspect(g);
    const row = 2 * 30;
    expect(slope[row + 3]).toBeCloseTo(0, 1);
    expect(steepestWithin(g, slope, 20)[row + 3]).toBeLessThan(5); // 70 m from the step
    expect(steepestWithin(g, slope, 20)[row + 9]).toBeGreaterThan(20); // right beside it
    expect(steepestWithin(g, slope, 150, true)[row + 3]).toBeGreaterThan(40); // the slope above counts
    // From the top looking down, steeper ground below does not count as "above".
    const top = grid(30, 5, 10, (e) => (e < 100 ? 500 : 500 - (e - 100)));
    const s = slopeAspect(top).slope;
    expect(steepestWithin(top, s, 150, true)[row + 3]).toBeLessThan(5);
    expect(steepestWithin(top, s, 150)[row + 3]).toBeGreaterThan(40);
  });
});

describe('runout', () => {
  it('reaches flat ground below a slope about as far as the 25° line allows', () => {
    // 200 m of 35° slope (140 m high), then flat.
    const g = grid(80, 3, 10, (e) => (e < 200 ? (200 - e) * tan(35) : 0));
    const { slope } = slopeAspect(g);
    const release = new Uint8Array(g.width * g.height);
    for (let i = 0; i < release.length; i++) if (slope[i] >= 30) release[i] = 1;
    const reached = runout(g, release);
    const row = 1 * 80;
    // Top at 140 m: the 25° line meets the flat 140 / tan 25° = 300 m from the top, 100 m beyond the foot.
    expect(reached[row + 25]).toBe(1); // 50 m beyond the foot
    expect(reached[row + 28]).toBe(1);
    expect(reached[row + 33]).toBe(0); // 130 m beyond
    expect(reached[row + 60]).toBe(0);
  });
});

describe('check', () => {
  it('classes a 36° north slope high at level 3 and spares the south side', () => {
    // A ridge running east-west: north side and south side both 36°.
    const g = grid(40, 40, 10, (_e, n) => 2500 - Math.abs(n - 200) * tan(36));
    const north = 5 * 40 + 20; // row 5 = far north: faces north
    const south = 34 * 40 + 20;
    const onlyNorth = check(g, all(g, 3, 0b10000011)); // N, NE, NW critical
    expect(onlyNorth.risk[north] & 3).toBe(RISK.HIGH);
    expect(onlyNorth.risk[south] & 3).toBe(RISK.ELEVATED); // one level lower: 2 at 36°
    expect(onlyNorth.slope[north]).toBe(36);
  });
  it('marks the flat below a critical slope as within reach and leaves unknown cells alone', () => {
    const g = grid(60, 5, 10, (e) => (e < 200 ? (200 - e) * tan(38) : 0));
    const result = check(g, all(g, 3));
    const row = 2 * 60;
    expect(result.risk[row + 24] & RUNOUT).toBe(RUNOUT);
    expect(result.risk[row + 24] & 3).toBe(RISK.LOW); // flat itself: the slope above shows as reach, not as class
    expect(result.risk[row + 10] & 3).toBe(RISK.HIGH); // on the 38° slope
    expect(result.risk[row + 50] & RUNOUT).toBe(0);
    expect(check(g, all(g, 0)).risk.every((v) => v === 0)).toBe(true);
  });
  it('applies the height limit: steep ground below it counts one level lower and releases nothing', () => {
    // 38° slope from about 1235 m down to a floor at 1000 m; critical only above 1800 m.
    const g = grid(60, 5, 10, (e) => (e < 300 ? 1000 + (300 - e) * tan(38) : 1000));
    const row = 2 * 60;
    const limited = check(g, all(g, 3, 255, 1800));
    expect(limited.risk[row + 10] & 3).toBe(RISK.ELEVATED); // as level 2 at 38°
    expect(limited.risk[row + 34] & RUNOUT).toBe(0);
    const everywhere = check(g, all(g, 3));
    expect(everywhere.risk[row + 10] & 3).toBe(RISK.HIGH);
    expect(everywhere.risk[row + 34] & RUNOUT).toBe(RUNOUT);
  });
});
