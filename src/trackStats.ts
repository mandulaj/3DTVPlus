// Length, ascent and descent of a route drawn on the map, measured along its line on the elevation model.
import { elevations } from './elevation';

type Point = [lng: number, lat: number];
const RAD = Math.PI / 180;
const JOIN_REACH = 15; // metres: segment ends this close belong together
const STEP = 30; // metres between height samples
const HYSTERESIS = 5; // metres of height change ignored as noise

export interface TrackStats {
  length: number; // metres
  up: number;
  down: number;
  lowest: number;
  highest: number;
}

export function metres(a: Point, b: Point): number {
  const s = Math.sin(((b[1] - a[1]) * RAD) / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(((b[0] - a[0]) * RAD) / 2) ** 2;
  return 2 * 6371008 * Math.asin(Math.sqrt(s));
}

/**
 * Routes come as several pieces in no particular order or direction. Pieces whose ends meet are
 * joined into continuous paths (turning them around where needed).
 */
export function joinLines(lines: Point[][]): Point[][] {
  const left = lines.filter((line) => line.length > 1).map((line) => line.slice());
  const paths: Point[][] = [];
  while (left.length) {
    let path = left.shift()!;
    for (let grown = true; grown; ) {
      grown = false;
      for (let i = 0; i < left.length; i++) {
        const piece = left[i];
        const head = path[0];
        const tail = path[path.length - 1];
        if (metres(tail, piece[0]) <= JOIN_REACH) path = path.concat(piece.slice(1));
        else if (metres(tail, piece[piece.length - 1]) <= JOIN_REACH) path = path.concat(piece.slice().reverse().slice(1));
        else if (metres(head, piece[piece.length - 1]) <= JOIN_REACH) path = piece.concat(path.slice(1));
        else if (metres(head, piece[0]) <= JOIN_REACH) path = piece.slice().reverse().concat(path.slice(1));
        else continue;
        left.splice(i, 1);
        grown = true;
        break;
      }
    }
    paths.push(path);
  }
  return paths;
}

/** Points every `STEP` metres along a line, ends included. */
export function resample(line: Point[], step = STEP): Point[] {
  const out: Point[] = [line[0]];
  let carried = 0;
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1];
    const b = line[i];
    const length = metres(a, b);
    for (let d = step - carried; d < length; d += step) out.push([a[0] + ((b[0] - a[0]) * d) / length, a[1] + ((b[1] - a[1]) * d) / length]);
    carried = (carried + length) % step;
  }
  out.push(line[line.length - 1]);
  return out;
}

/** Climb and descent along a height series, ignoring wiggles smaller than the threshold. */
export function climb(heights: number[]): { up: number; down: number } {
  let up = 0;
  let down = 0;
  let anchor = heights[0];
  for (const z of heights) {
    if (z - anchor >= HYSTERESIS) {
      up += z - anchor;
      anchor = z;
    } else if (anchor - z >= HYSTERESIS) {
      down += anchor - z;
      anchor = z;
    }
  }
  return { up, down };
}

/**
 * Totals for a route given as line pieces. Each joined path is read from its lower end to its
 * higher end (the way up to a summit or hut), since the pieces themselves carry no direction.
 */
export async function trackStats(lines: Point[][], heightsOf: (points: Point[]) => Promise<number[]> = elevations): Promise<TrackStats | null> {
  const stats: TrackStats = { length: 0, up: 0, down: 0, lowest: Infinity, highest: -Infinity };
  for (const path of joinLines(lines)) {
    for (let i = 1; i < path.length; i++) stats.length += metres(path[i - 1], path[i]);
    const heights = await heightsOf(resample(path));
    if (heights[0] > heights[heights.length - 1]) heights.reverse();
    const { up, down } = climb(heights);
    stats.up += up;
    stats.down += down;
    for (const z of heights) {
      if (z < stats.lowest) stats.lowest = z;
      if (z > stats.highest) stats.highest = z;
    }
  }
  return stats.length ? stats : null;
}

/** "4.2 km · ↑ 850 m · ↓ 120 m · 1650–2480 m" */
export function describeStats(s: TrackStats): string {
  const km = s.length >= 10000 ? (s.length / 1000).toFixed(0) : (s.length / 1000).toFixed(1);
  return `${km} km · ↑ ${Math.round(s.up)} m · ↓ ${Math.round(s.down)} m · ${Math.round(s.lowest)}–${Math.round(s.highest)} m`;
}

/** The line pieces of any GeoJSON line geometry. */
export function linesOf(geometry: GeoJSON.Geometry | undefined): Point[][] {
  if (!geometry) return [];
  if (geometry.type === 'LineString') return [geometry.coordinates.map((c) => [c[0], c[1]] as Point)];
  if (geometry.type === 'MultiLineString') return geometry.coordinates.map((line) => line.map((c) => [c[0], c[1]] as Point));
  if (geometry.type === 'GeometryCollection') return geometry.geometries.flatMap(linesOf);
  return [];
}
