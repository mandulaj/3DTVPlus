export type Point = [number, number];
const RAD = Math.PI / 180;

export function metres(a: Point, b: Point): number {
  return Math.hypot((a[0] - b[0]) * Math.cos(a[1] * RAD) * 111320, (a[1] - b[1]) * 111320);
}

export const lengthOf = (line: Point[]) => line.reduce((sum, p, i) => (i ? sum + metres(line[i - 1], p) : 0), 0);

/** A winding track of roughly `km` kilometres with a point every 12 m. */
export function windingTrack(km: number): Point[] {
  const points: Point[] = [];
  let lng = 7.2;
  let lat = 46.1;
  let heading = 0.6;
  for (let d = 0; d < km * 1000; d += 12) {
    heading += (Math.sin(d / 900) + Math.sin(d / 137)) * 0.02;
    lng += (Math.sin(heading) * 12) / (Math.cos(lat * RAD) * 111320);
    lat += (Math.cos(heading) * 12) / 111320;
    points.push([lng, lat]);
  }
  return points;
}

/** Distance from a point to the nearest place on a line, metres. */
export function distanceToLine(p: Point, line: Point[]): number {
  const scale = Math.cos(p[1] * RAD) * 111320;
  let best = Infinity;
  for (let i = 1; i < line.length; i++) {
    const ax = (line[i - 1][0] - p[0]) * scale;
    const ay = (line[i - 1][1] - p[1]) * 111320;
    const bx = (line[i][0] - p[0]) * scale;
    const by = (line[i][1] - p[1]) * 111320;
    const dx = bx - ax;
    const dy = by - ay;
    const length = dx * dx + dy * dy;
    const t = length ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / length)) : 0;
    best = Math.min(best, Math.hypot(ax + dx * t, ay + dy * t));
  }
  return best;
}
