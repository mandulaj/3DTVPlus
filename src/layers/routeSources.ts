// The stored route collections the viewer knows (see storedRoutes.ts): where their files are
// and how a route of each is described.
import { gradeRank, SCALES } from './routeFilter';
import type { RouteSpec } from './storedRoutes';

const ACTIVITY_NAMES: Record<string, string> = { skitouring: 'Ski tour', snowshoeing: 'Snowshoe tour', hiking: 'Hike', mountain_climbing: 'Mountaineering' };

const camptocamp: RouteSpec = {
  about: 'Ski tours described by the Camptocamp community: an independent collection, with dots for routes that have no drawn line.',
  id: 'c2c',
  name: 'Camptocamp ski tours',
  colour: '#e8590c',
  cellPath: './data/camptocamp/skitouring',
  indexPath: './data/camptocamp/index.json',
  readIndex: (json) => ({ fetched: json.activities.skitouring.fetched, cells: json.activities.skitouring.cells, size: json.cell }),
  coverage: 'Switzerland and the eastern Alps only',
  attribution: 'Routes © <a href="https://www.camptocamp.org" target="_blank">Camptocamp</a> contributors, CC BY-SA',
  credit: 'Camptocamp: © contributors, CC BY-SA',
  chip: (p) => ACTIVITY_NAMES[p.activity] ?? 'Route',
  title: (p) => String(p.title ?? ''),
  facts: (p) => [p.rating && `grade ${p.rating}`, p.ski && `ski ${p.ski}`, p.up && `↑ ${p.up} m`, p.top && `top ${p.top} m`, p.aspects && `faces ${String(p.aspects).replace(/,/g, ', ')}`],
  links: (p) => [
    { label: 'Open on Camptocamp', href: `https://www.camptocamp.org/routes/${Number(p.id)}` },
    { label: 'authors', href: String(p.credit ?? ''), muted: true },
  ],
  scale: 'french',
  rank: (p) => gradeRank('french', p.rating),
  up: (p) => (p.up ? Number(p.up) : null),
  recorded: true,
};

/**
 * Skitourenguru's route network numbers difficulty in thirds of the SAC ski scale:
 * 1 = L, 3 = WS-, 4 = WS, 5 = WS+, 6 = ZS-, 7 = ZS … (checked against the SAC portal's grades).
 */
export function networkGrade(value: unknown): { rank: number; label: string } | null {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return null;
  const rank = (n - 1) / 3;
  const base = Math.round(rank);
  const name = SCALES.alpine[Math.min(base, SCALES.alpine.length - 1)];
  const step = Math.round((rank - base) * 3);
  return { rank, label: `${name}${step > 0 ? '+' : step < 0 ? '-' : ''}` };
}

const SAC_PORTAL = 'https://www.sac-cas.ch/en/huts-and-tours/sac-route-portal';

function network(id: string, name: string, colour: string, folder: string, coverage: string, attribution: string, credit: string, about: string): RouteSpec {
  return {
    about,
    id,
    name,
    colour,
    cellPath: `./data/routes/${folder}`,
    indexPath: `./data/routes/${folder}/index.json`,
    readIndex: (json) => ({ fetched: json.fetched, cells: json.cells, size: json.cell }),
    coverage,
    attribution,
    credit,
    chip: () => 'Ski tour',
    title: (p) => (p.start && p.stop ? `${p.stop}, from ${p.start}` : String(p.name ?? p.stop ?? p.start ?? 'Ski route')),
    facts: (p) => [networkGrade(p.grade) && `grade ${networkGrade(p.grade)!.label}`, p.name && p.start && p.stop && p.name !== `${p.stop}, von ${p.start}` ? String(p.name) : ''],
    // Swiss routes carry the SAC portal's ids: the destination's and the route's.
    links: (p) => (p.sacid && p.sactid ? [{ label: 'Open in SAC route portal', href: `${SAC_PORTAL}/${Number(p.sactid)}/ski_tour/${Number(p.sacid)}` }] : []),
    scale: 'alpine',
    rank: (p) => networkGrade(p.grade)?.rank ?? null,
    up: () => undefined,
    recorded: false,
  };
}

const snowshoe: RouteSpec = {
  about: 'The official swisstopo/SAC snowshoe routes as open data. The same routes as "SAC snowshoe" and the swisstopo map layer.',
  id: 'ch-snowshoe',
  name: 'Snowshoe routes Switzerland (open data)',
  colour: '#d6336c',
  cellPath: './data/routes/ch-snowshoe',
  indexPath: './data/routes/ch-snowshoe/index.json',
  readIndex: (json) => ({ fetched: json.fetched, cells: json.cells, size: json.cell }),
  coverage: 'Switzerland',
  attribution: 'Snowshoe routes © <a href="https://www.swisstopo.admin.ch" target="_blank">swisstopo</a> / SAC',
  credit: 'Snowshoe routes: © swisstopo / SAC (open data)',
  chip: () => 'Snowshoe tour',
  title: (p) => [p.target, p.top && `${p.top} m`].filter(Boolean).join(', ') || String(p.name ?? 'Snowshoe route'),
  facts: (p) => [p.grade && `grade ${p.grade}`, p.up && `↑ ${p.up} m`, p.down && `↓ ${p.down} m`, p.time && `ascent ${p.time}`, p.name],
  links: (p) => (/^https:\/\/www\.sac-cas\.ch\//.test(String(p.url)) ? [{ label: 'Open in SAC route portal', href: String(p.url) }] : []),
  scale: 'snowshoe',
  rank: (p) => gradeRank('snowshoe', p.grade),
  up: (p) => (p.up ? Number(p.up) : null),
  recorded: false,
};

export const ROUTE_SOURCES: RouteSpec[] = [
  network('stg-ch', 'Ski routes Switzerland (open data)', '#6a3df0', 'stg-ch', 'Switzerland and Liechtenstein', 'Ski routes © <a href="https://www.swisstopo.admin.ch" target="_blank">swisstopo</a> / SAC, via <a href="https://github.com/skitourenguru/Routes" target="_blank">Skitourenguru</a>', 'Ski routes: © swisstopo / SAC (open data), via the Skitourenguru route network', 'The official swisstopo/SAC ski routes as open data, in the subset Skitourenguru has checked (about 3400 routes). Largely the same routes as "SAC ski touring" and the swisstopo map layer, but needing no unofficial data.'),
  network('stg-at', 'Ski routes Austria, Bavaria, South Tyrol', '#0a8f7a', 'stg-at', 'Austria, Bavaria and South Tyrol', '© ÖAV, DAV, AVS – Ski Touring Routes for Austria, Germany and South Tyrol, <a href="https://creativecommons.org/licenses/by-nd/4.0/" target="_blank">CC BY-ND 4.0</a>', '© ÖAV, DAV, AVS – Ski Touring Routes for Austria, Germany and South Tyrol, CC BY-ND 4.0', 'Ski routes of the alpine clubs, from Skitourenguru\'s route network.'),
  network('stg-fr', 'Ski routes French Alps, Pyrenees', '#c2255c', 'stg-fr', 'French Alps and Pyrenees', 'Ski routes: <a href="https://www.petzl.com" target="_blank">Petzl Foundation</a> with <a href="https://www.skitourenguru.com" target="_blank">Skitourenguru GmbH</a>, <a href="https://creativecommons.org/licenses/by-nd/4.0/" target="_blank">CC BY-ND 4.0</a>', 'Ski routes created and maintained by the Petzl Foundation in cooperation with Skitourenguru GmbH, CC BY-ND 4.0', 'Ski routes from Skitourenguru\'s route network (their smoothed lines).'),
  camptocamp,
  snowshoe,
];
