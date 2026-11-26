// Glacier outlines of the Alps in 2015 (Paul et al. 2019/2020, Sentinel-2 inventory, PANGAEA
// doi:10.1594/PANGAEA.909133, CC BY 4.0) as a static file the viewer loads:
// public/data/glaciers/alps-2015.json. Outlines are simplified to about 12 m and glaciers smaller
// than 0.02 km² are left out, to keep the file small.
//
//   node scripts/fetch-glaciers.mjs
//
// Needs the `unzip` command.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SOURCE = 'https://doi.pangaea.de/10.1594/PANGAEA.909133?format=textfile';
const TOLERANCE = 12; // metres
const MIN_AREA = 20000; // square metres

const work = mkdtempSync(join(tmpdir(), 'glaciers-'));
process.stderr.write('downloading…\n');
const response = await fetch(SOURCE, { headers: { 'User-Agent': 'terrain-viewer-snapshot/1.0' } });
if (!response.ok) throw new Error(`HTTP ${response.status}`);
writeFileSync(join(work, 'g.zip'), Buffer.from(await response.arrayBuffer()));
execFileSync('unzip', ['-o', '-q', join(work, 'g.zip'), '-d', work]);
const folder = join(work, readdirSync(work).find((name) => name.startsWith('c3s_gi')));
const shp = readFileSync(join(folder, readdirSync(folder).find((name) => name.endsWith('.shp'))));

// UTM zone 32N (WGS84) to longitude and latitude.
function toLngLat(easting, northing) {
  const a = 6378137, f = 1 / 298.257223563, k0 = 0.9996, lon0 = (9 * Math.PI) / 180;
  const e2 = f * (2 - f), ep2 = e2 / (1 - e2);
  const e1 = (1 - Math.sqrt(1 - e2)) / (1 + Math.sqrt(1 - e2));
  const m = northing / k0;
  const mu = m / (a * (1 - e2 / 4 - (3 * e2 ** 2) / 64 - (5 * e2 ** 3) / 256));
  const p1 = mu + ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) + ((21 * e1 ** 2) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu) + ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) + ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
  const c1 = ep2 * Math.cos(p1) ** 2, t1 = Math.tan(p1) ** 2;
  const n1 = a / Math.sqrt(1 - e2 * Math.sin(p1) ** 2);
  const r1 = (a * (1 - e2)) / (1 - e2 * Math.sin(p1) ** 2) ** 1.5;
  const d = (easting - 500000) / (n1 * k0);
  const lat = p1 - ((n1 * Math.tan(p1)) / r1) * (d ** 2 / 2 - ((5 + 3 * t1 + 10 * c1 - 4 * c1 ** 2 - 9 * ep2) * d ** 4) / 24 + ((61 + 90 * t1 + 298 * c1 + 45 * t1 ** 2 - 252 * ep2 - 3 * c1 ** 2) * d ** 6) / 720);
  const lon = lon0 + (d - ((1 + 2 * t1 + c1) * d ** 3) / 6 + ((5 - 2 * c1 + 28 * t1 - 3 * c1 ** 2 + 8 * ep2 + 24 * t1 ** 2) * d ** 5) / 120) / Math.cos(p1);
  return [+((lon * 180) / Math.PI).toFixed(5), +((lat * 180) / Math.PI).toFixed(5)];
}

/** Douglas-Peucker on a ring in metres. */
function simplify(ring, tolerance) {
  const keep = new Uint8Array(ring.length);
  keep[0] = keep[ring.length - 1] = 1;
  // A ring starts and ends at the same point: split it at the point furthest from there first.
  let far = 0, most = 0;
  for (let i = 1; i < ring.length - 1; i++) {
    const distance = Math.hypot(ring[i][0] - ring[0][0], ring[i][1] - ring[0][1]);
    if (distance > most) { most = distance; far = i; }
  }
  keep[far] = 1;
  const stack = [[0, far], [far, ring.length - 1]];
  while (stack.length) {
    const [from, to] = stack.pop();
    const [ax, ay] = ring[from], [bx, by] = ring[to];
    const dx = bx - ax, dy = by - ay, length = Math.hypot(dx, dy) || 1;
    let worst = 0, at = -1;
    for (let i = from + 1; i < to; i++) {
      const distance = Math.abs((ring[i][0] - ax) * dy - (ring[i][1] - ay) * dx) / length;
      if (distance > worst) { worst = distance; at = i; }
    }
    if (worst > tolerance) { keep[at] = 1; stack.push([from, at], [at, to]); }
  }
  return ring.filter((_, i) => keep[i]);
}
const areaOf = (ring) => { let sum = 0; for (let i = 1; i < ring.length; i++) sum += ring[i - 1][0] * ring[i][1] - ring[i][0] * ring[i - 1][1]; return sum / 2; };

// Shapefile: 100-byte header, then records (big-endian number and length, little-endian content).
const features = [];
let skipped = 0;
for (let offset = 100; offset < shp.length; ) {
  const length = shp.readInt32BE(offset + 4) * 2;
  const record = shp.subarray(offset + 8, offset + 8 + length);
  offset += 8 + length;
  const type = record.readInt32LE(0);
  if (type !== 5 && type !== 15) continue; // polygons only
  const parts = record.readInt32LE(36), points = record.readInt32LE(40);
  const starts = Array.from({ length: parts }, (_, i) => record.readInt32LE(44 + i * 4));
  const base = 44 + parts * 4;
  const rings = starts.map((start, i) => {
    const end = i + 1 < parts ? starts[i + 1] : points;
    return Array.from({ length: end - start }, (_, k) => [record.readDoubleLE(base + (start + k) * 16), record.readDoubleLE(base + (start + k) * 16 + 8)]);
  });
  // Outer rings run clockwise (negative area here), holes the other way.
  const total = rings.reduce((sum, ring) => sum - areaOf(ring), 0);
  if (total < MIN_AREA) { skipped++; continue; }
  const kept = rings.filter((ring) => Math.abs(areaOf(ring)) >= 4000).map((ring) => simplify(ring, TOLERANCE)).filter((ring) => ring.length >= 4);
  if (!kept.length) continue;
  // Group holes with the outer ring before them (the order shapefiles use).
  const polygons = [];
  for (const ring of kept) {
    if (areaOf(ring) < 0 || !polygons.length) polygons.push([ring.map(([x, y]) => toLngLat(x, y))]);
    else polygons[polygons.length - 1].push(ring.map(([x, y]) => toLngLat(x, y)));
  }
  features.push({ type: 'Feature', properties: { km2: +(total / 1e6).toFixed(2) }, geometry: polygons.length === 1 ? { type: 'Polygon', coordinates: polygons[0] } : { type: 'MultiPolygon', coordinates: polygons } });
}
const out = { type: 'FeatureCollection', year: 2015, source: 'Paul et al., glacier inventory of the Alps from Sentinel-2 (2015), doi:10.1594/PANGAEA.909133, CC BY 4.0', features };
mkdirSync(new URL('../public/data/glaciers/', import.meta.url), { recursive: true });
writeFileSync(new URL('../public/data/glaciers/alps-2015.json', import.meta.url), JSON.stringify(out));
process.stderr.write(`${features.length} glaciers written (${skipped} smaller than ${MIN_AREA / 1e6} km² left out)\n`);
