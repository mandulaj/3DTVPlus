// swisstopo/SAC snowshoe routes (open data, ch.swisstopo-karto.schneeschuhrouten) as static
// files the viewer loads: public/data/routes/ch-snowshoe/<cell>.json plus index.json.
//
//   node scripts/fetch-snowshoe.mjs
//
// Lines as published, converted to longitude/latitude (rounded to about 1 m) and sorted into
// quarter-degree cells. The download is kept in .cache/snowshoe. Needs `unzip`.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fromLv95, wkbLines } from './projections.mjs';

const STAC = 'https://data.geo.admin.ch/api/stac/v1/collections/ch.swisstopo-karto.schneeschuhrouten/items?limit=1';
const CELL = 0.25;
const root = new URL('../', import.meta.url);
const cache = new URL('.cache/snowshoe/', root);
mkdirSync(cache, { recursive: true });
const database = new URL('snowshoe_routes_2056.gpkg', cache);
if (!existsSync(database)) {
  const item = (await (await fetch(STAC)).json()).features[0];
  const asset = Object.entries(item.assets).find(([name]) => name.endsWith('gpkg.zip'))[1];
  process.stderr.write(`downloading ${asset.href}\n`);
  const zip = new URL('snowshoe.zip', cache);
  writeFileSync(zip, Buffer.from(await (await fetch(asset.href)).arrayBuffer()));
  execFileSync('unzip', ['-o', '-q', zip.pathname, '-d', cache.pathname]);
}

/** A GeoPackage geometry: a short header (with an optional bounding box), then well-known binary. */
function lines(blob) {
  const buffer = Buffer.from(blob);
  const envelope = [0, 32, 48, 48, 64][(buffer.readUInt8(3) >> 1) & 7] ?? 0;
  return wkbLines(buffer.subarray(8 + envelope));
}

const cellOf = (lng, lat) => `${(Math.floor(lng / CELL) * CELL).toFixed(2)}_${(Math.floor(lat / CELL) * CELL).toFixed(2)}`;
const db = new DatabaseSync(database.pathname, { readOnly: true });
const cells = new Map();
let count = 0;
for (const row of db.prepare('select * from snowshoe_routes_2056').all()) {
  const parts = lines(row.geom).map((line) => line.map(([x, y]) => fromLv95(x, y).map((v) => +v.toFixed(5))));
  if (!parts.length) continue;
  const properties = {
    id: Number(row.sacid ?? row.fid),
    name: row.name ?? null,
    target: row.target_name ?? null,
    top: row.target_altitude ? Math.round(row.target_altitude) : null,
    grade: row.difficulty_en ?? null,
    up: row.ascent_altitude ?? null,
    down: row.descent_altitude ?? null,
    time: row.ascent_time_label ?? null,
    url: row.url_sac_en ?? null,
  };
  const name = cellOf(parts[0][0][0], parts[0][0][1]);
  if (!cells.has(name)) cells.set(name, []);
  cells.get(name).push({ type: 'Feature', id: properties.id, properties, geometry: { type: 'MultiLineString', coordinates: parts } });
  count++;
}
db.close();
const dir = new URL('public/data/routes/ch-snowshoe/', root);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
let bytes = 0;
for (const [name, features] of cells) {
  const body = JSON.stringify({ type: 'FeatureCollection', features });
  bytes += body.length;
  writeFileSync(new URL(`${name}.json`, dir), body);
}
writeFileSync(new URL('index.json', dir), JSON.stringify({ cell: CELL, fetched: new Date().toISOString().slice(0, 10), licence: 'Snowshoe routes: © swisstopo / SAC (open data)', cells: [...cells.keys()].sort() }));
process.stderr.write(`${count} snowshoe routes in ${cells.size} cells, ${(bytes / 1e6).toFixed(1)} MB\n`);
