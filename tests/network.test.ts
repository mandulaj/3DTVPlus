import { describe, expect, it } from 'vitest';
import { Network } from '../src/network';
import { lengthOf, metres, type Point } from './helpers';

/** Points every ~11 m along a straight line. */
const line = (from: Point, to: Point, count: number): Point[] =>
  Array.from({ length: count }, (_, i) => [from[0] + ((to[0] - from[0]) * i) / (count - 1), from[1] + ((to[1] - from[1]) * i) / (count - 1)]);

describe('route search along lines', () => {
  const valley = line([7.0, 46.0], [7.0, 46.02], 200); // about 2.2 km north
  const side = line([7.0, 46.01], [7.02, 46.01], 150); // branches east from the middle

  it('follows a single line between two points on it', () => {
    const path = new Network([valley]).route(valley[40], valley[150], 30)!;
    expect(lengthOf(path)).toBeCloseTo(lengthOf(valley.slice(40, 151)), -1);
  });

  it('turns onto a branch at the junction', () => {
    const path = new Network([valley, side]).route(valley[20], side[120], 30)!;
    const expected = lengthOf(valley.slice(20, 101)) + lengthOf(side.slice(0, 121));
    expect(lengthOf(path)).toBeGreaterThan(expected * 0.98);
    expect(lengthOf(path)).toBeLessThan(expected * 1.03);
  });

  it('does not run to the end and back when overlapping lines share the ground', () => {
    // Two routes over the same track: one covers all of it, the other only the upper part.
    // A click may attach to either; the path between two mid-points must stay direct.
    const whole = valley;
    const upper = valley.slice(90);
    const network = new Network([whole, upper]);
    const a = valley[100];
    const b = valley[170];
    const direct = lengthOf(valley.slice(100, 171));
    for (const [from, to] of [[a, b], [b, a]] as [Point, Point][]) {
      expect(lengthOf(network.route(from, to, 30)!)).toBeLessThan(direct * 1.02);
    }
  });

  it('stays direct when overlapping lines were digitised with different points', () => {
    const shifted = line([7.0, 46.0005], [7.0, 46.0195], 171); // same ground, vertices do not coincide
    const network = new Network([valley, shifted]);
    const path = network.route(valley[60], valley[140], 30)!;
    expect(lengthOf(path)).toBeLessThan(lengthOf(valley.slice(60, 141)) * 1.05);
  });

  it('starts and ends at the spots on the line nearest the clicks', () => {
    const beside: Point = [valley[50][0] + 0.0002, valley[50][1]]; // about 15 m east of the line
    const path = new Network([valley]).route(beside, valley[120], 30)!;
    expect(metres(path[0], valley[50])).toBeLessThan(3);
    expect(metres(path[path.length - 1], valley[120])).toBeLessThan(3);
  });

  it('gives nothing when a point is out of reach or the lines do not connect', () => {
    const far: Point = [7.01, 46.0];
    expect(new Network([valley]).route(far, valley[100], 30)).toBeNull();
    const island = line([7.05, 46.0], [7.05, 46.01], 100);
    expect(new Network([valley, island]).route(valley[10], island[50], 30)).toBeNull();
    expect(new Network([]).isEmpty).toBe(true);
  });
});
