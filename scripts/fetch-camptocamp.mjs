// Takes a snapshot of Camptocamp routes and writes it as static files the viewer loads (their API
// does not answer other websites' pages, but the content is openly licensed).
//
//   node scripts/fetch-camptocamp.mjs [west south east north] [activity]
//   node scripts/fetch-camptocamp.mjs                       (Switzerland, ski touring)
//   node scripts/fetch-camptocamp.mjs 8.0 46.5 9.0 47.1 skitouring
//
// Output: public/data/camptocamp/<activity>/<cell>.json, one file per half-degree cell, and
// public/data/camptocamp/index.json listing the cells. A run replaces the activity's cells inside
// the area asked for and keeps the others. Answers are kept in .cache/camptocamp, so a run that
// was interrupted continues where it stopped (delete that folder for fresh data).
//
// Every route keeps its own licence and attribution link. Lines are stored as published (only
// rounded to about 1 m), since some content is under a no-derivatives licence.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const [west, south, east, north] = (args.length >= 4 ? args.slice(0, 4) : ['5.9', '45.75', '10.6', '47.85']).map(Number);
const activity = args[args.length >= 4 ? 4 : 0] ?? 'skitouring';
const API = 'https://api.camptocamp.org';
const PAUSE_MS = 400; // be gentle with a volunteer-run service
const CELL = 0.5; // degrees; the viewer (src/layers/camptocampCells.ts) uses the same grid
const R = 6378137;
const ALLOWED = ['CC-BY-SA', 'CC-BY-NC-ND']; // licences that permit showing a copy with attribution

const root = new URL('../', import.meta.url);
const cacheDir = new URL('.cache/camptocamp/', root);
const outDir = new URL(`public/data/camptocamp/${activity}/`, root);
mkdirSync(cacheDir, { recursive: true });
mkdirSync(outDir, { recursive: true });

const toMercator = (lng, lat) => [(lng * Math.PI * R) / 180, R * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))];
const toLngLat = ([x, y]) => [+((x / R) * (180 / Math.PI)).toFixed(5), +((2 * Math.atan(Math.exp(y / R)) - Math.PI / 2) * (180 / Math.PI)).toFixed(5)];
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** Name of the cell holding a point: its south-west corner, e.g. "8.0_46.5". */
const cellOf = (lng, lat) => `${(Math.floor(lng / CELL) * CELL).toFixed(1)}_${(Math.floor(lat / CELL) * CELL).toFixed(1)}`;

async function get(path) {
  for (let attempt = 1; ; attempt++) {
    try {
      const response = await fetch(`${API}${path}`, { headers: { 'User-Agent': 'terrain-viewer-snapshot/1.0' } });
      if (!response.ok) throw new Error(`${response.status} ${path}`);
      await sleep(PAUSE_MS);
      return await response.json();
    } catch (error) {
      if (attempt >= 4) throw error;
      await sleep(5000 * attempt);
    }
  }
}

async function cached(name, path) {
  const file = new URL(`${name}.json`, cacheDir);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const data = await get(path);
  writeFileSync(file, JSON.stringify(data));
  return data;
}

// The cells touching the area asked for; each is listed on its own (the list is paged, 100 at a time).
const wanted = [];
for (let lng = Math.floor(west / CELL) * CELL; lng < east; lng += CELL) {
  for (let lat = Math.floor(south / CELL) * CELL; lat < north; lat += CELL) wanted.push([lng, lat]);
}

const cells = new Map(wanted.map(([lng, lat]) => [cellOf(lng + CELL / 2, lat + CELL / 2), []]));
const seen = new Set();
let withLine = 0;
let dropped = 0;
for (const [n, [lng, lat]] of wanted.entries()) {
  const name = cellOf(lng + CELL / 2, lat + CELL / 2);
  const bbox = [...toMercator(lng, lat), ...toMercator(lng + CELL, lat + CELL)].map(Math.round).join(',');
  const listed = [];
  for (let offset = 0; ; offset += 100) {
    const page = await cached(`list-${activity}-${name}-${offset}`, `/routes?bbox=${bbox}&act=${activity}&limit=100&offset=${offset}&pl=en`);
    listed.push(...page.documents);
    if (listed.length >= page.total || !page.documents.length) break;
  }
  for (const [i, summary] of listed.entries()) {
    process.stderr.write(`\rcell ${n + 1}/${wanted.length} (${name}): route ${i + 1}/${listed.length}      `);
    if (seen.has(summary.document_id)) continue;
    const point = toLngLat(JSON.parse(summary.geometry.geom).coordinates);
    const home = cellOf(point[0], point[1]);
    if (!cells.has(home)) continue; // sits just outside: belongs to a cell that was not asked for
    seen.add(summary.document_id);
    const locale = summary.locales?.[0] ?? {};
    const properties = {
      id: summary.document_id,
      title: [locale.title_prefix, locale.title].filter(Boolean).join(': '),
      activity,
      up: summary.height_diff_up ?? null,
      top: summary.elevation_max ?? null,
      rating: summary.global_rating ?? summary.labande_global_rating ?? null,
      ski: summary.ski_rating ?? summary.labande_ski_rating ?? null,
      aspects: summary.orientations?.join(',') ?? null,
      licence: null,
      credit: `https://www.camptocamp.org/routes/history/${summary.document_id}`,
    };
    let geometry = { type: 'Point', coordinates: point };
    if (summary.geometry.has_geom_detail) {
      try {
        const route = await cached(`route-${summary.document_id}`, `/routes/${summary.document_id}?pl=en`);
        const licence = route.license?.id ?? '';
        if (!ALLOWED.some((prefix) => licence.startsWith(prefix))) {
          dropped++;
          continue;
        }
        properties.licence = licence;
        const detail = JSON.parse(route.geometry.geom_detail);
        const lines = detail.type === 'LineString' ? [detail.coordinates] : detail.coordinates;
        geometry = { type: 'MultiLineString', coordinates: lines.map((line) => line.map(toLngLat)) };
        withLine++;
      } catch (error) {
        process.stderr.write(`\n  ${summary.document_id}: ${error.message}\n`);
      }
    }
    const feature = { type: 'Feature', id: summary.document_id, properties, geometry };
    const touched = new Set([home]);
    if (geometry.type === 'MultiLineString') {
      for (const part of geometry.coordinates) {
        for (const [lng, lat] of part) {
          const c = cellOf(lng, lat);
          if (cells.has(c)) touched.add(c);
        }
      }
    }
    for (const c of touched) cells.get(c).push(feature);
  }
}

const fetched = new Date().toISOString().slice(0, 10);
for (const [name, features] of cells) {
  const file = new URL(`${name}.json`, outDir);
  if (features.length) writeFileSync(file, JSON.stringify({ type: 'FeatureCollection', features }));
  else rmSync(file, { force: true });
}
// The index lists every cell on disk, also those from earlier runs over other areas.
const indexFile = new URL('public/data/camptocamp/index.json', root);
const index = existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, 'utf8')) : { activities: {} };
index.cell = CELL;
index.licence = 'Routes © Camptocamp contributors, CC BY-SA 3.0 (some CC BY-NC-ND): https://www.camptocamp.org';
index.activities[activity] = { fetched, cells: readdirSync(outDir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort() };
writeFileSync(indexFile, JSON.stringify(index));
process.stderr.write(`\n${seen.size} routes (${withLine} with a line, ${dropped} left out for their licence) in ${index.activities[activity].cells.length} cells\n`);
