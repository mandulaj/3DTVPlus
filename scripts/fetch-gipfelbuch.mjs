#!/usr/bin/env node
// Recent condition reports from gipfelbuch.ch, stored with the site as public/data/gipfelbuch.json.
// The site sends no cross-origin permission, so the page cannot ask it directly: this script reads
// the public list (the same request the site's own "load more" makes) and, for reports not seen
// before, the report page for its coordinates. Only a short excerpt is kept; the report itself is
// read on gipfelbuch.ch through the link.
// Usage: node scripts/fetch-gipfelbuch.mjs [days=30]
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SITE = 'https://www.gipfelbuch.ch';
const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '../public/data/gipfelbuch.json');
const DAYS = Number(process.argv[2]) || 30;
const PAGE = 66;
const MAX_PAGES = 30;
const PAUSE = 400; // ms between requests: a guest reading at walking pace
const AGENT = 'Mozilla/5.0 (terrain viewer data refresh; personal, non-commercial)';

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const isoDate = (text) => {
  const m = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(String(text ?? '').trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
};
const shorten = (text, length) => {
  const clean = String(text ?? '').replace(/\s+/g, ' ').trim();
  return clean.length > length ? `${clean.slice(0, clean.lastIndexOf(' ', length))}…` : clean;
};

async function main() {
  let known = new Map();
  try {
    for (const report of JSON.parse(await readFile(OUT, 'utf8')).reports) known.set(report.id, report);
  } catch {
    known = new Map(); // first run
  }

  // A session and its form token, as a browser gets from the overview page.
  const first = await fetch(`${SITE}/verhaeltnisse/uebersicht`, { headers: { 'user-agent': AGENT } });
  if (!first.ok) throw new Error(`overview: HTTP ${first.status}`);
  const cookie = first.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
  const token = /name="dvf_csrf_token"[^>]*value="([^"]*)"/.exec(await first.text())?.[1];
  if (!token) throw new Error('form token not found: the page has changed');

  const cutoff = new Date(Date.now() - DAYS * 86400000).toISOString().slice(0, 10);
  const listed = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const body = new URLSearchParams({ dvf_csrf_token: token, src_conditions: '', src_conditions_region: '', src_conditions_type: '', filter_conditions_limit: String(PAGE), filter_conditions_offset: String(page * PAGE), dvForm_subm: '1' });
    const response = await fetch(`${SITE}/conditions/list`, {
      method: 'POST',
      headers: { 'user-agent': AGENT, cookie, 'x-requested-with': 'XMLHttpRequest', referer: `${SITE}/verhaeltnisse/uebersicht`, 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    if (!response.ok) throw new Error(`list page ${page}: HTTP ${response.status}`);
    const items = (await response.json()).items ?? [];
    const recent = items.filter((item) => (isoDate(item.datum) ?? '') >= cutoff && item.active !== false);
    listed.push(...recent);
    if (!items.length || !recent.length) break;
    await sleep(PAUSE);
  }

  const reports = [];
  let fetched = 0;
  let unplaced = 0;
  for (const item of listed) {
    const id = Number(item.id);
    if (reports.some((r) => r.id === id)) continue;
    let at = known.get(id)?.at;
    if (!at) {
      await sleep(PAUSE);
      const page = await fetch(`${SITE}/verhaeltnisse/${item.ident}`, { headers: { 'user-agent': AGENT } });
      const html = page.ok ? await page.text() : '';
      const m = /data-lat="([-\d.]+)"\s+data-lon="([-\d.]+)"/.exec(html);
      fetched++;
      if (m && Number(m[1]) && Number(m[2])) at = [Number(Number(m[2]).toFixed(5)), Number(Number(m[1]).toFixed(5))];
    }
    if (!at) {
      unplaced++;
      continue;
    }
    reports.push({
      id,
      ident: String(item.ident),
      name: shorten(item.mainpoint || item.point_name, 80),
      route: shorten(item.routename, 100),
      type: String(item.type ?? ''),
      sym: String(item.typesym ?? ''),
      region: String(item.region_group ?? ''),
      date: isoDate(item.datum),
      text: shorten(item.contentpreview, 220),
      author: String(item.autor ?? ''),
      // The author's verdict on the conditions, when given (site's own scale and wording).
      verdict: item.quick_name ? String(item.quick_name) : undefined,
      photo: Boolean(item.hasphoto),
      at,
    });
  }
  reports.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.id - a.id));
  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify({ updated: new Date().toISOString(), days: DAYS, source: 'gipfelbuch.ch', reports }));
  console.log(`${reports.length} reports since ${cutoff} (${fetched} report pages read, ${unplaced} without a position)`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
