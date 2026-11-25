// The Camptocamp snapshot is stored in half-degree cells (scripts/fetch-camptocamp.mjs writes
// them with the same naming): which cell a place is in, and which cells a view needs.

export const CELL = 0.5; // degrees

/** Name of the cell holding a point: its south-west corner, e.g. "8.0_46.5". */
export function cellName(lng: number, lat: number, size = CELL): string {
  return `${(Math.floor(lng / size) * size).toFixed(1)}_${(Math.floor(lat / size) * size).toFixed(1)}`;
}

/** The stored cells a view touches, those nearest its centre first, at most `limit`. */
export function cellsInView(view: { west: number; south: number; east: number; north: number }, available: ReadonlySet<string>, limit: number, size = CELL): string[] {
  const centre = [(view.west + view.east) / 2, (view.south + view.north) / 2];
  const found: { name: string; distance: number }[] = [];
  for (let lng = Math.floor(view.west / size) * size; lng < view.east; lng += size) {
    for (let lat = Math.floor(view.south / size) * size; lat < view.north; lat += size) {
      const name = cellName(lng + size / 2, lat + size / 2, size);
      if (available.has(name)) found.push({ name, distance: Math.hypot(lng + size / 2 - centre[0], lat + size / 2 - centre[1]) });
    }
  }
  return found.sort((a, b) => a.distance - b.distance).slice(0, limit).map((cell) => cell.name);
}
