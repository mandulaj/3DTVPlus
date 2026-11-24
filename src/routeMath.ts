// Route arithmetic without any map or page dependency: time model per activity, and control
// points for imported tracks.
import { simplify } from './geometry';

type Point = [lng: number, lat: number];
const RAD = Math.PI / 180;

/**
 * Travel modes for the time estimate. Each has a speed on flat ground (adjustable) and a rule
 * for how slope changes it; the route is timed stretch by stretch with the local slope.
 */
export const MODES = {
  hiking: {
    name: 'Hiking',
    flat: 4.5,
    // Tobler's hiking function, scaled so that level ground gives the chosen speed: fastest on a
    // gentle descent (about 5 %), slower the steeper it gets either way.
    factor: (slope: number) => Math.exp(-3.5 * Math.abs(slope + 0.05)) / Math.exp(-3.5 * 0.05),
  },
  running: {
    name: 'Running',
    flat: 12,
    // Same effort as on the flat: speed follows the energy cost of running on a slope
    // (Minetti et al. 2002). Gentle descents are faster, steep ones slower again.
    factor: (slope: number) => {
      const i = Math.min(0.45, Math.max(-0.45, slope));
      const cost = 155.4 * i ** 5 - 30.4 * i ** 4 - 43.3 * i ** 3 + 46.3 * i ** 2 + 19.5 * i + 3.6;
      return Math.min(1.25, 3.6 / cost);
    },
  },
  skitouring: {
    name: 'Ski touring',
    flat: 4,
    // Skinning up: as hiking, but never more than about 400 m of climb per hour (at 4 km/h flat speed).
    // Skiing down: several times faster, most on moderate slopes, held back on very steep ones.
    factor: (slope: number) => {
      if (slope >= -0.03) return Math.min(Math.exp(-3.5 * slope), slope > 0 ? 0.1 / slope : Infinity);
      const steepness = -slope;
      return steepness < 0.35 ? 1 + 12 * steepness : Math.max(2, 5.2 - 8 * (steepness - 0.35));
    },
  },
} as const;
export type Mode = keyof typeof MODES;

/**
 * Indices of control points for an imported track: where it bends (Douglas–Peucker), plus enough
 * in between that no stretch is very long, without drowning the map in markers.
 */
export function controlPoints(coords: Point[]): number[] {
  const scale = Math.cos(coords[0][1] * RAD) * 111320;
  const xy = coords.map((c): [number, number] => [c[0] * scale, c[1] * 111320]);
  const MOST = 40;
  let tolerance = 60;
  let keep = simplify(coords, tolerance);
  while (keep.length > MOST) keep = simplify(coords, (tolerance *= 1.6));
  // Long straight stretches still get a point now and then.
  const along = [0];
  for (let i = 1; i < xy.length; i++) along.push(along[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
  const spacing = Math.max(1500, along[along.length - 1] / MOST);
  const result = [0];
  for (let k = 1; k < keep.length; k++) {
    let last = result[result.length - 1];
    for (let i = last + 1; i < keep[k]; i++) {
      if (along[i] - along[last] >= spacing && along[keep[k]] - along[i] >= spacing / 2) {
        result.push(i);
        last = i;
      }
    }
    result.push(keep[k]);
  }
  return result;
}
