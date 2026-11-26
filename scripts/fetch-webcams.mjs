// Takes a snapshot of the webcams OpenStreetMap knows (places tagged with a webcam address) and
// writes it as a static file the viewer loads: public/data/webcams.json. The live lookup service
// (Overpass) is too slow and too often busy to ask from the page itself.
//
//   node scripts/fetch-webcams.mjs [west south east north]      (default: Switzerland and around)
//
// Data © OpenStreetMap contributors, ODbL.
import { writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const [west, south, east, north] = (args.length >= 4 ? args.slice(0, 4) : ['5.9', '45.7', '10.6', '47.9']).map(Number);
const SERVERS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter', 'https://overpass.private.coffee/api/interpreter'];
const box = `${south},${west},${north},${east}`;
const query = `[out:json][timeout:120];(nwr["contact:webcam"](${box});nwr["webcam"](${box});nwr["surveillance:type"="webcam"](${box}););out center tags;`;

/** Only web addresses are kept. */
const address = (text) => {
  const value = String(text ?? '').trim();
  return /^https?:\/\//i.test(value) ? value : /^www\./i.test(value) ? `https://${value}` : null;
};

let elements = null;
for (const server of SERVERS) {
  try {
    process.stderr.write(`asking ${new URL(server).hostname}…\n`);
    const response = await fetch(server, { method: 'POST', body: new URLSearchParams({ data: query }), headers: { 'User-Agent': 'terrain-viewer-snapshot/1.0', Accept: 'application/json' }, signal: AbortSignal.timeout(170000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    elements = (await response.json()).elements;
    break;
  } catch (error) {
    process.stderr.write(`  ${error.message}\n`);
  }
}
if (!elements) {
  process.stderr.write('No server answered: nothing written.\n');
  process.exit(1);
}

const cams = [];
for (const element of elements) {
  const tags = element.tags ?? {};
  const lng = element.lon ?? element.center?.lon;
  const lat = element.lat ?? element.center?.lat;
  const link = address(tags['contact:webcam']) ?? address(tags.webcam) ?? address(tags.website) ?? address(tags['contact:website']) ?? address(tags.url);
  if (!link || !Number.isFinite(lng) || !Number.isFinite(lat)) continue;
  let host;
  try {
    host = new URL(link).hostname.replace(/^www\./, '');
  } catch {
    continue;
  }
  const cam = { id: `${element.type[0]}${element.id}`, name: String(tags.name ?? tags.operator ?? host), at: [+lng.toFixed(5), +lat.toFixed(5)], link };
  if (tags.operator && tags.operator !== cam.name) cam.operator = tags.operator;
  cams.push(cam);
}
const out = { fetched: new Date().toISOString().slice(0, 10), area: [west, south, east, north], licence: '© OpenStreetMap contributors, ODbL', cams };
writeFileSync(new URL('../public/data/webcams.json', import.meta.url), JSON.stringify(out));
process.stderr.write(`${cams.length} webcams written to public/data/webcams.json\n`);
