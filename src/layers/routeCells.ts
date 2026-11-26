// Stored route data (Camptocamp, Skitourenguru's network, …) is cut into cells of half or a
// quarter degree; the scripts that write them use the same naming. Which cell a place is in, and
// which cells a view needs.

export const CELL = 0.5; // degrees

/** Name of the cell holding a point: its south-west corner, e.g. "8.0_46.5". */
export function cellName(lng: number, lat: number, size = CELL): string {
  const digits = size < 0.5 ? 2 : 1; // "8.0_46.5" for half degrees, "8.25_46.50" for quarters
  return `${(Math.floor(lng / size) * size).toFixed(digits)}_${(Math.floor(lat / size) * size).toFixed(digits)}`;
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
