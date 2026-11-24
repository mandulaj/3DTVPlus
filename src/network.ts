// Shortest path along a set of route lines (the SAC routes currently drawn on the map).
//
// Several routes often share the same ground as separate, overlapping lines. So the lines are
// merged into one graph of their vertices (vertices within about 2 m are the same node), and a
// point may attach to every line passing within reach, not just the nearest: otherwise two clicks
// on the same track can land on different overlapping lines and the path runs to wherever those
// happen to join and back.

type Point = [lng: number, lat: number];
const RAD = Math.PI / 180;
const MAX_HOOKS = 10;
// Leaving the clicked spot for a place further along costs more than walking there on the line:
// otherwise the path may start a little way ahead of the click.
const OFF_LINE_COST = 3;
const SAME_GROUND = 3; // metres
const JUNCTION_REACH = 4; // metres: a line ending this close to another line joins it
// Grid for finding the segments near a point without scanning all of them.
const CELL_LNG = 0.0008;
const CELL_LAT = 0.0005; // about 55 m

function metres(a: Point, b: Point): number {
  const s = Math.sin(((b[1] - a[1]) * RAD) / 2) ** 2 + Math.cos(a[1] * RAD) * Math.cos(b[1] * RAD) * Math.sin(((b[0] - a[0]) * RAD) / 2) ** 2;
  return 2 * 6371008 * Math.asin(Math.sqrt(s));
}

/** Where a point attaches to the network: a spot on the segment between two nodes. */
interface Hook {
  on: Point;
  a: number;
  b: number;
  toA: number; // metres from `on` to node a
  toB: number;
  off: number; // metres from the point to `on`
}

export class Network {
  private nodes: Point[] = [];
  private neighbours: number[][] = [];
  private lengths: number[][] = [];
  /** Every distinct segment once, as a pair of node ids. */
  private segmentA: number[] = [];
  private segmentB: number[] = [];
  private grid = new Map<string, number[]>();

  constructor(lines: Point[][]) {
    const ids = new Map<string, number>();
    const node = (p: Point): number => {
      const key = `${Math.round(p[0] * 40000)},${Math.round(p[1] * 60000)}`; // about 2 m cells
      let id = ids.get(key);
      if (id === undefined) {
        id = this.nodes.length;
        ids.set(key, id);
        this.nodes.push(p);
        this.neighbours.push([]);
        this.lengths.push([]);
      }
      return id;
    };
    for (const line of lines) {
      let previous = -1;
      for (const point of line) {
        const current = node(point);
        if (previous >= 0 && previous !== current && !this.neighbours[previous].includes(current)) {
          const length = metres(this.nodes[previous], this.nodes[current]);
          this.neighbours[previous].push(current);
          this.lengths[previous].push(length);
          this.neighbours[current].push(previous);
          this.lengths[current].push(length);
          this.segmentA.push(previous);
          this.segmentB.push(current);
        }
        previous = current;
      }
    }
    for (let i = 0; i < this.segmentA.length; i++) this.index(i);

    // T-junctions: a line that ends on another line's segment, between its vertices, joins it there.
    const count = this.nodes.length;
    for (let node = 0; node < count; node++) {
      if (this.neighbours[node].length !== 1) continue; // only loose ends
      const hook = this.hooks(this.nodes[node], JUNCTION_REACH).find((h) => h.a !== node && h.b !== node);
      if (!hook) continue;
      this.connect(node, hook.a, hook.off + hook.toA);
      this.connect(node, hook.b, hook.off + hook.toB);
    }
  }

  private connect(a: number, b: number, length: number): void {
    if (a === b || this.neighbours[a].includes(b)) return;
    this.neighbours[a].push(b);
    this.lengths[a].push(length);
    this.neighbours[b].push(a);
    this.lengths[b].push(length);
    this.segmentA.push(a);
    this.segmentB.push(b);
    this.index(this.segmentA.length - 1);
  }

  /** Enter a segment into every grid cell its bounding box touches. */
  private index(segment: number): void {
    const a = this.nodes[this.segmentA[segment]];
    const b = this.nodes[this.segmentB[segment]];
    const x0 = Math.floor(Math.min(a[0], b[0]) / CELL_LNG);
    const x1 = Math.floor(Math.max(a[0], b[0]) / CELL_LNG);
    const y0 = Math.floor(Math.min(a[1], b[1]) / CELL_LAT);
    const y1 = Math.floor(Math.max(a[1], b[1]) / CELL_LAT);
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        const key = `${x},${y}`;
        const cell = this.grid.get(key);
        if (cell) cell.push(segment);
        else this.grid.set(key, [segment]);
      }
    }
  }

  get isEmpty(): boolean {
    return !this.segmentA.length;
  }

  /** The closest spots on the network within `reach` metres, nearest first. */
  private hooks(p: Point, reach: number): Hook[] {
    const scale = Math.cos(p[1] * RAD);
    const dLat = reach / 111000;
    const dLng = dLat / scale;
    const found: Hook[] = [];
    const seen = new Set<number>();
    const candidates: number[] = [];
    for (let x = Math.floor((p[0] - dLng) / CELL_LNG); x <= Math.floor((p[0] + dLng) / CELL_LNG); x++) {
      for (let y = Math.floor((p[1] - dLat) / CELL_LAT); y <= Math.floor((p[1] + dLat) / CELL_LAT); y++) {
        for (const segment of this.grid.get(`${x},${y}`) ?? []) {
          if (!seen.has(segment)) {
            seen.add(segment);
            candidates.push(segment);
          }
        }
      }
    }
    for (const i of candidates) {
      const a = this.nodes[this.segmentA[i]];
      const b = this.nodes[this.segmentB[i]];
      // Cheap rejection before the exact distance.
      if (Math.min(a[0], b[0]) - dLng > p[0] || Math.max(a[0], b[0]) + dLng < p[0] || Math.min(a[1], b[1]) - dLat > p[1] || Math.max(a[1], b[1]) + dLat < p[1]) continue;
      const dx = (b[0] - a[0]) * scale;
      const dy = b[1] - a[1];
      const length = dx * dx + dy * dy;
      const t = length ? Math.min(1, Math.max(0, ((p[0] - a[0]) * scale * dx + (p[1] - a[1]) * dy) / length)) : 0;
      const on: Point = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      const off = metres(p, on);
      if (off <= reach) found.push({ on, a: this.segmentA[i], b: this.segmentB[i], toA: metres(on, a), toB: metres(on, b), off });
    }
    found.sort((x, y) => x.off - y.off);
    // Several hooks are for lines lying on top of each other, which are all about equally near.
    // Anything clearly further away is a different place, not an alternative.
    return found.filter((hook) => hook.off <= found[0].off + SAME_GROUND).slice(0, MAX_HOOKS);
  }

  /** Path from `a` to `b` along the lines, if both lie within `reach` metres of one. */
  route(a: Point, b: Point, reach: number): Point[] | null {
    const starts = this.hooks(a, reach);
    const ends = this.hooks(b, reach);
    if (!starts.length || !ends.length) return null;

    let best: { length: number; path: Point[] } | null = null;
    // Both on the same segment: straight along it.
    for (const s of starts) {
      for (const e of ends) {
        if (!((s.a === e.a && s.b === e.b) || (s.a === e.b && s.b === e.a))) continue;
        const length = (s.off + e.off) * OFF_LINE_COST + metres(s.on, e.on);
        if (!best || length < best.length) best = { length, path: [s.on, e.on] };
      }
    }

    // Dijkstra from every start hook, until nothing shorter than the best finish can remain.
    const count = this.nodes.length;
    const distance = new Float64Array(count).fill(Infinity);
    const previous = new Int32Array(count).fill(-1);
    const origin = new Int32Array(count).fill(-1); // start hook a node was first reached from
    const heap = new Heap();
    const reachNode = (node: number, d: number, from: number, hook: number) => {
      if (d >= distance[node]) return;
      distance[node] = d;
      previous[node] = from;
      origin[node] = hook;
      heap.push(d, node);
    };
    starts.forEach((s, i) => {
      reachNode(s.a, s.off * OFF_LINE_COST + s.toA, -1, i);
      reachNode(s.b, s.off * OFF_LINE_COST + s.toB, -1, i);
    });
    const finish = new Map<number, { tail: number; hook: Hook }>();
    for (const e of ends) {
      for (const [node, tail] of [[e.a, e.toA + e.off * OFF_LINE_COST], [e.b, e.toB + e.off * OFF_LINE_COST]] as [number, number][]) {
        if (!finish.has(node) || tail < finish.get(node)!.tail) finish.set(node, { tail, hook: e });
      }
    }
    let bestNode = -1;
    let bestHook: Hook | null = null;
    for (let top = heap.pop(); top; top = heap.pop()) {
      const [d, node] = top;
      if (d > distance[node]) continue; // outdated entry
      if (best && d >= best.length) break;
      const end = finish.get(node);
      if (end && (!best || d + end.tail < best.length)) {
        best = { length: d + end.tail, path: [] };
        bestNode = node;
        bestHook = end.hook;
      }
      const next = this.neighbours[node];
      const lengths = this.lengths[node];
      for (let k = 0; k < next.length; k++) reachNode(next[k], d + lengths[k], node, origin[node]);
    }
    if (!best) return null;
    if (bestNode >= 0 && bestHook) {
      const middle: Point[] = [];
      let cursor = bestNode;
      for (; previous[cursor] >= 0; cursor = previous[cursor]) middle.unshift(this.nodes[cursor]);
      middle.unshift(this.nodes[cursor]);
      best.path = [starts[origin[cursor]].on, ...middle, bestHook.on];
    }
    return best.path.filter((c, i, all) => i === 0 || c[0] !== all[i - 1][0] || c[1] !== all[i - 1][1]);
  }
}

/** Minimal binary heap of (distance, node) pairs. */
class Heap {
  private keys: number[] = [];
  private values: number[] = [];

  push(key: number, value: number): void {
    let i = this.keys.length;
    this.keys.push(key);
    this.values.push(value);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.keys[parent] <= key) break;
      this.keys[i] = this.keys[parent];
      this.values[i] = this.values[parent];
      i = parent;
    }
    this.keys[i] = key;
    this.values[i] = value;
  }

  pop(): [number, number] | null {
    const size = this.keys.length;
    if (!size) return null;
    const top: [number, number] = [this.keys[0], this.values[0]];
    const key = this.keys.pop()!;
    const value = this.values.pop()!;
    if (size > 1) {
      let i = 0;
      const last = size - 1;
      for (;;) {
        let child = 2 * i + 1;
        if (child >= last) break;
        if (child + 1 < last && this.keys[child + 1] < this.keys[child]) child++;
        if (this.keys[child] >= key) break;
        this.keys[i] = this.keys[child];
        this.values[i] = this.values[child];
        i = child;
      }
      this.keys[i] = key;
      this.values[i] = value;
    }
    return top;
  }
}
