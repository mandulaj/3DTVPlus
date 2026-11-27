// Ski touring routes from Skitourenguru's open route network (github.com/skitourenguru/Routes)
// as static files the viewer loads: public/data/routes/<source>/<cell>.json plus index.json.
//
//   node scripts/fetch-skitourenguru.mjs [ch] [at] [fr]        (default: all three)
//
//   ch  Switzerland: swisstopo/SAC ski routes, swisstopo open data licence
//   at  Austria, Bavaria, South Tyrol: © ÖAV, DAV, AVS, CC BY-ND 4.0
//   fr  French Alps and Pyrenees: Petzl Foundation / Skitourenguru, CC BY-ND 4.0 (their smoothed lines)
//
// The lines are kept as published: only converted to longitude/latitude (rounded to about 1 m)
// and sorted into half-degree cells. Italy is not taken: its licence does not allow republishing.
// Downloads are kept in .cache/skitourenguru (delete for fresh data). `fr` needs `unzip`.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { fromAustriaLambert, fromLambert93, fromLv95, wkbLines } from './projections.mjs';

const REPO = 'https://raw.githubusercontent.com/skitourenguru/Routes/main';
const SMOOTHED = 'https://download.skitourenguru.com';
const CELL = 0.25; // degrees; quarter-degree cells keep the densest areas near 1 MB
const root = new URL('../', import.meta.url);
const cache = new URL('.cache/skitourenguru/', root);
mkdirSync(cache, { recursive: true });

const SOURCES = {
  ch: { folder: 'stg-ch', licence: 'Ski routes: © swisstopo / SAC (open data), via the Skitourenguru route network' },
  at: { folder: 'stg-at', licence: '© ÖAV, DAV, AVS – Ski Touring Routes for Austria, Germany and South Tyrol, CC BY-ND 4.0' },
  fr: { folder: 'stg-fr', licence: 'Ski routes created and maintained by the Petzl Foundation in cooperation with Skitourenguru GmbH, CC BY-ND 4.0' },
};

async function download(url, name) {
  const file = new URL(name, cache);
  if (!existsSync(file)) {
    process.stderr.write(`  downloading ${name}\n`);
    const response = await fetch(url, { headers: { 'User-Agent': 'terrain-viewer-snapshot/1.0' } });
    if (!response.ok) throw new Error(`${response.status} ${url}`);
    writeFileSync(file, Buffer.from(await response.arrayBuffer()));
  }
  return file;
}

const round = ([lng, lat]) => [+lng.toFixed(5), +lat.toFixed(5)];
const cellOf = (lng, lat) => `${(Math.floor(lng / CELL) * CELL).toFixed(2)}_${(Math.floor(lat / CELL) * CELL).toFixed(2)}`;
const text = (value) => (value === null || value === undefined || value === '' ? null : String(value));

/** Routes of a region given as segments plus compositions (lists of segment ids). */
async function network(region, convert) {
  const segments = JSON.parse(readFileSync(await download(`${REPO}/${region}/${region}_Segments.geojson`, `${region}_Segments.geojson`), 'utf8'));
  const compositions = JSON.parse(readFileSync(await download(`${REPO}/${region}/${region}_Compositions.geojson`, `${region}_Compositions.geojson`), 'utf8'));
  const lines = new Map();
  for (const segment of segments.features) {
    if (segment.geometry?.type !== 'LineString') continue;
    lines.set(Number(segment.properties.id), segment.geometry.coordinates.map(([x, y]) => round(convert(x, y))));
  }
  const routes = [];
  for (const { properties: p } of compositions.features) {
    const parts = String(p.segments ?? '').split(',').map(Number).map((id) => lines.get(id)).filter(Boolean);
    if (!parts.length) continue;
    routes.push({ id: Number(p.id), name: text(p.name), start: text(p.start), stop: text(p.stop), grade: Number(p.mdiff) > 0 ? Number(p.mdiff) : null, sacid: p.sacid ?? undefined, sactid: p.sactid ?? undefined, lines: parts });
  }
  return routes;
}

/** France: the daily smoothed routes (one line per route) in the newest archive of a folder. */
async function smoothed(folder, offset) {
  const listing = await (await fetch(`${SMOOTHED}/public/${folder}/`)).text();
  const newest = [...listing.matchAll(/HREF="([^"]+\.zip)"/gi)].map((m) => m[1]).pop();
  if (!newest) throw new Error(`no archive found in ${folder}`);
  const zip = await download(`${SMOOTHED}${newest}`, `${folder}.zip`);
  const dir = new URL(`${folder}/`, cache);
  mkdirSync(dir, { recursive: true });
  execFileSync('unzip', ['-o', '-q', zip.pathname, '-d', dir.pathname]);
  const file = readdirSync(dir).find((name) => /-Smoothed\.sqlite$/.test(name));
  const db = new DatabaseSync(new URL(file, dir).pathname, { readOnly: true });
  const table = db.prepare("select name from sqlite_master where type = 'table' and name like '%smoothed'").get().name;
  const routes = [];
  for (const row of db.prepare(`select id, start, stop, diff, GEOMETRY as geometry from "${table}"`).all()) {
    const lines = wkbLines(Buffer.from(row.geometry)).map((line) => line.map(([x, y]) => round(fromLambert93(x, y))));
    if (!lines.length) continue;
    routes.push({ id: offset + Number(row.id), name: null, start: text(row.start), stop: text(row.stop), grade: Number(row.diff) > 0 ? Number(row.diff) : null, lines });
  }
  db.close();
  return { routes, revision: /(\d{4}\.\d{2}\.\d{2})/.exec(newest)?.[1] ?? null };
}

function write(key, routes, extra = {}) {
  const { folder, licence } = SOURCES[key];
  const dir = new URL(`public/data/routes/${folder}/`, root);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const cells = new Map();
  for (const route of routes) {
    const { lines, ...properties } = route;
    const feature = { type: 'Feature', id: route.id, properties, geometry: { type: 'MultiLineString', coordinates: lines } };
    const touched = new Set();
    for (const part of lines) for (const [lng, lat] of part) touched.add(cellOf(lng, lat));
    for (const name of touched) {
      if (!cells.has(name)) cells.set(name, []);
      cells.get(name).push(feature);
    }
  }
  let bytes = 0;
  for (const [name, features] of cells) {
    const body = JSON.stringify({ type: 'FeatureCollection', features });
    bytes += body.length;
    writeFileSync(new URL(`${name}.json`, dir), body);
  }
  writeFileSync(new URL('index.json', dir), JSON.stringify({ cell: CELL, fetched: new Date().toISOString().slice(0, 10), licence, cells: [...cells.keys()].sort(), ...extra }));
  process.stderr.write(`${key}: ${routes.length} routes in ${cells.size} cells, ${(bytes / 1e6).toFixed(1)} MB\n`);
}

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : ['ch', 'at', 'fr'];
for (const key of wanted) {
  process.stderr.write(`${key}…\n`);
  if (key === 'ch') write('ch', await network('Switzerland', fromLv95));
  else if (key === 'at') write('at', await network('Austria', fromAustriaLambert));
  else if (key === 'fr') {
    const alps = await smoothed('France-Alps', 0);
    const pyrenees = await smoothed('France-Pyrenees', 1_000_000); // their ids start at 1 again
    write('fr', [...alps.routes, ...pyrenees.routes], { revision: alps.revision });
  } else process.stderr.write(`unknown source "${key}"\n`);
}
