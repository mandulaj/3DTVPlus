import { describe, expect, it } from 'vitest';
import { climb, joinLines, resample, trackStats } from '../src/trackStats';

type P = [number, number];
// A line running north from 46°N: 0.001° of latitude is about 111 m.
const at = (i: number): P => [8, 46 + i * 0.001];

describe('joinLines', () => {
  it('joins pieces given out of order and backwards', () => {
    const paths = joinLines([[at(2), at(3)], [at(1), at(0)], [at(2), at(1)]]);
    expect(paths).toHaveLength(1);
    const lats = paths[0].map((p) => p[1]);
    const sorted = [...lats].sort((a, b) => a - b);
    expect(lats.join() === sorted.join() || lats.join() === sorted.reverse().join()).toBe(true);
    expect(paths[0]).toHaveLength(4);
  });
  it('keeps pieces that do not touch apart', () => {
    expect(joinLines([[at(0), at(1)], [at(5), at(6)]])).toHaveLength(2);
  });
});

describe('climb', () => {
  it('ignores small wiggles', () => {
    expect(climb([100, 102, 99, 101, 100])).toEqual({ up: 0, down: 0 });
    expect(climb([100, 150, 140, 200])).toEqual({ up: 110, down: 10 });
  });
});

describe('trackStats', () => {
  it('measures a split route from its low end to its high end', async () => {
    // Height rises 1 m per 0.00001° of latitude, i.e. 100 m per piece.
    const heights = async (points: P[]) => points.map((p) => 1000 + (p[1] - 46) * 100000);
    const stats = (await trackStats([[at(2), at(1)], [at(0), at(1)]], heights))!;
    expect(stats.length).toBeGreaterThan(215);
    expect(stats.length).toBeLessThan(230);
    expect(Math.round(stats.up)).toBe(200);
    expect(stats.down).toBe(0);
    expect(Math.round(stats.lowest)).toBe(1000);
    expect(Math.round(stats.highest)).toBe(1200);
  });
  it('samples about every 30 m', () => {
    const points = resample([at(0), at(1)]);
    expect(points.length).toBeGreaterThanOrEqual(4);
    expect(points.length).toBeLessThanOrEqual(6);
  });
});
