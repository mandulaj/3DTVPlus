// Clicking a route on the map (SAC, swisstopo, Skitourenguru lines, Camptocamp …) shows it in the
// route planner's viewer: profile, statistics, snow and slope colouring, and from there "Edit" or
// "Save to my tracks". The route layers call `previewRoute`; main.ts connects it to the planner.
import { elevations } from './elevation';
import { joinLines, metres } from './trackStats';

type Point = [number, number];

export const routePreview = {
  /** Set by main.ts: shows the line in the planner (unless a route is being edited there). */
  open: (_name: string, _line: Point[]): void => {},
};

const lengthOf = (line: Point[]) => line.reduce((sum, point, i) => (i ? sum + metres(line[i - 1], point) : 0), 0);

/**
 * One continuous line for a route stored as pieces: the longest path the pieces join into
 * (variants and separate descents are left out), running uphill, as a tour is usually described.
 */
export async function routeLine(lines: Point[][], heightsOf: (points: Point[]) => Promise<number[]> = elevations): Promise<Point[] | null> {
  const paths = joinLines(lines);
  if (!paths.length) return null;
  const line = paths.reduce((best, path) => (lengthOf(path) > lengthOf(best) ? path : best));
  try {
    const [first, last] = await heightsOf([line[0], line[line.length - 1]]);
    if (first > last) line.reverse();
  } catch {
    // heights unavailable: keep the stored direction
  }
  return line;
}

let latest = 0;
export async function previewRoute(name: string, lines: Point[][]): Promise<void> {
  const token = ++latest;
  const line = await routeLine(lines);
  if (line && line.length > 1 && token === latest) routePreview.open(name, line);
}
