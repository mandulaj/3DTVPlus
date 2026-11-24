// Small geometry helpers shared by the planner and by share links.

type Point = [lng: number, lat: number];
const RAD = Math.PI / 180;

/**
 * Douglas–Peucker: indices of the points to keep so that the simplified line stays within
 * `tolerance` metres of the original. First and last are always kept.
 */
export function simplify(coords: Point[], tolerance: number): number[] {
  if (coords.length < 3) return coords.map((_, i) => i);
  const scale = Math.cos(coords[0][1] * RAD) * 111320;
  const xy = coords.map((c): [number, number] => [c[0] * scale, c[1] * 111320]);
  const offLine = (p: [number, number], a: [number, number], b: [number, number]) => {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = dx * dx + dy * dy;
    const t = length ? Math.min(1, Math.max(0, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / length)) : 0;
    return Math.hypot(p[0] - a[0] - dx * t, p[1] - a[1] - dy * t);
  };
  const keep = new Set([0, coords.length - 1]);
  const stack: [number, number][] = [[0, coords.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    let worst = -1;
    let distance = tolerance;
    for (let i = a + 1; i < b; i++) {
      const d = offLine(xy[i], xy[a], xy[b]);
      if (d > distance) {
        distance = d;
        worst = i;
      }
    }
    if (worst >= 0) {
      keep.add(worst);
      stack.push([a, worst], [worst, b]);
    }
  }
  return [...keep].sort((a, b) => a - b);
}
