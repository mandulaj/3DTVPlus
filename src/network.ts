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
    for (let i = 0; i < this.segmentA.length; i++) {
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
    return found.sort((x, y) => x.off - y.off).slice(0, MAX_HOOKS);
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
        const length = s.off + metres(s.on, e.on) + e.off;
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
      reachNode(s.a, s.off + s.toA, -1, i);
      reachNode(s.b, s.off + s.toB, -1, i);
    });
    const finish = new Map<number, { tail: number; hook: Hook }>();
    for (const e of ends) {
      for (const [node, tail] of [[e.a, e.toA + e.off], [e.b, e.toB + e.off]] as [number, number][]) {
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
