import { describe, expect, it } from 'vitest';
import { simplify } from '../src/geometry';
import { controlPoints, MODES } from '../src/routeMath';
import { toLv95, toWgs84 } from '../src/swissGrid';
import { distanceToLine, lengthOf, metres, windingTrack, type Point } from './helpers';

describe('simplify', () => {
  it('keeps both ends and stays within tolerance', () => {
    const track = windingTrack(6);
    const kept = simplify(track, 10);
    expect(kept[0]).toBe(0);
    expect(kept[kept.length - 1]).toBe(track.length - 1);
    expect(kept.length).toBeLessThan(track.length / 3);
    const line = kept.map((i) => track[i]);
    expect(Math.max(...track.map((p) => distanceToLine(p, line)))).toBeLessThan(10.5);
  });

  it('reduces a straight line to its ends', () => {
    const line: Point[] = Array.from({ length: 50 }, (_, i) => [7 + i * 0.001, 46 + i * 0.0005]);
    expect(simplify(line, 5)).toEqual([0, 49]);
  });

  it('copes with one or two points', () => {
    expect(simplify([[7, 46]], 5)).toEqual([0]);
    expect(simplify([[7, 46], [7.1, 46]], 5)).toEqual([0, 1]);
  });
});

describe('control points for imported tracks', () => {
  it('includes the ends, stays in order and under the cap', () => {
    for (const km of [3, 25, 120]) {
      const track = windingTrack(km);
      const points = controlPoints(track);
      expect(points[0]).toBe(0);
      expect(points[points.length - 1]).toBe(track.length - 1);
      expect([...points].sort((a, b) => a - b)).toEqual(points);
      expect(new Set(points).size).toBe(points.length);
      expect(points.length).toBeLessThanOrEqual(90);
    }
  });

  it('leaves no very long stretch without a point', () => {
    const straight: Point[] = Array.from({ length: 2000 }, (_, i) => [7, 46 + i * 0.0001]); // 22 km, dead straight
    const points = controlPoints(straight);
    const gaps = points.slice(1).map((end, k) => lengthOf(straight.slice(points[k], end + 1)));
    expect(Math.max(...gaps)).toBeLessThan(3000);
  });
});

describe('time model', () => {
  it('gives the flat speed on level ground', () => {
    for (const mode of Object.values(MODES)) expect(mode.factor(0)).toBeCloseTo(1, 1);
  });

  it('slows every activity on a steep climb', () => {
    for (const mode of Object.values(MODES)) expect(mode.factor(0.25)).toBeLessThan(0.6);
  });

  it('caps ski touring climbs at about 400 m per hour at 4 km/h', () => {
    for (const slope of [0.15, 0.25, 0.4]) expect(4000 * MODES.skitouring.factor(slope) * slope).toBeLessThanOrEqual(401);
  });

  it('makes skiing down faster than walking, and hiking down steep ground slower than flat', () => {
    expect(MODES.skitouring.factor(-0.25)).toBeGreaterThan(3);
    expect(MODES.hiking.factor(-0.35)).toBeLessThan(0.5);
  });

  it('lets running gain a little on a gentle descent but not on a steep one', () => {
    expect(MODES.running.factor(-0.08)).toBeGreaterThan(1);
    expect(MODES.running.factor(-0.4)).toBeLessThan(MODES.running.factor(-0.08));
  });

  it('never returns a non-positive factor', () => {
    for (const mode of Object.values(MODES)) for (let s = -0.9; s <= 0.9; s += 0.05) expect(mode.factor(s)).toBeGreaterThan(0);
  });
});

describe('Swiss grid', () => {
  // Reference points published by swisstopo for its approximate formulas.
  it('places the old observatory in Bern at the grid origin', () => {
    const [east, north] = toLv95(7.438632495, 46.951082877);
    expect(east).toBeCloseTo(2600000, -1);
    expect(north).toBeCloseTo(1200000, -1);
  });

  it('round-trips points across Switzerland within a few metres (each direction is good to about 1 m)', () => {
    for (const p of [[7.2286, 46.0961], [9.83, 46.5], [6.14, 46.2], [8.55, 47.37], [10.4, 46.75]] as Point[]) {
      const [east, north] = toLv95(p[0], p[1]);
      expect(metres(p, toWgs84(east, north))).toBeLessThan(3);
    }
  });
});
