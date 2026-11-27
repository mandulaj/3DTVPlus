// Recent condition reports from gipfelbuch.ch as pins: coloured by activity (snow/hiking/climbing)
// with saturation fading by age, plus a corner dot for reported conditions. Click for a short
// excerpt and a link to the report. gipfelbuch.ch cannot be asked from a web page (no cross-origin
// permission), so the list is a copy stored with the site (scripts/fetch-gipfelbuch.mjs) and is
// as fresh as its last refresh.
import * as maplibregl from 'maplibre-gl';
import { interaction } from '../interaction';
import { groundBounds } from '../viewport';
import { h } from '../ui/dom';
import type { Legend } from './slf';

const DATA = './data/gipfelbuch.json';
const SITE = 'https://www.gipfelbuch.ch/verhaeltnisse/';
const DAY = 86400000;
const MAX_SHOWN = 120;

export interface Report {
  id: number;
  ident: string;
  name: string;
  route: string;
  type: string;
  sym: string;
  region: string;
  /** Day of the tour, YYYY-MM-DD. */
  date: string;
  text: string;
  author: string;
  verdict?: string;
  photo?: boolean;
  at: [number, number];
}

/** Choices for "reports since". */
export const REPORT_SPANS: { days: number; name: string }[] = [
  { days: 3, name: '3 days' },
  { days: 7, name: '1 week' },
  { days: 14, name: '2 weeks' },
  { days: 30, name: '1 month' },
];

export type ReportTheme = 'snow' | 'hiking' | 'climbing';

/** Age cutoffs (days) matching each theme's 5-step saturation/lightness ramp: 0–1d, 2–3d, 4–7d, 8–14d, older. */
const AGE_STEPS = [1, 3, 7, 14, Infinity] as const;

/** Activity themes: vivid & saturated when fresh, progressively desaturated & lighter with age. */
export const REPORT_THEMES: Record<ReportTheme, { name: string; colours: readonly [string, string, string, string, string] }> = {
  snow: { name: 'Snow', colours: ['#1565c0', '#3b82f6', '#7cb3f0', '#b6d4f7', '#e1effe'] },
  hiking: { name: 'Hiking', colours: ['#15803d', '#2ea058', '#6ec48c', '#b0e0c0', '#e2f5e9'] },
  climbing: { name: 'Climbing', colours: ['#334155', '#526071', '#8492a6', '#bcc6d4', '#e6ebf1'] },
};

/** Author's condition verdict mapped to a traffic-light indicator dot. */
export const REPORT_VERDICTS: { key: string; label: string; colour: string }[] = [
  { key: 'ausgezeichnet', label: 'excellent', colour: '#16a34a' },
  { key: 'gut', label: 'good', colour: '#84cc16' },
  { key: 'machbar', label: 'doable', colour: '#eab308' },
  { key: 'schlecht', label: 'poor', colour: '#ef4444' },
];

const SNOW_SYMS = new Set(['ski', 'schneeschuh', 'eisklettern', 'langlauf', 'freeride']);
const HIKING_SYMS = new Set(['alpwanderung', 'wanderung', 'bike']);

const ICONS: Record<string, string> = { ski: '⛷️', schneeschuh: '❄️', alpwanderung: '🥾', hochtour: '⛏️', klettertour: '🧗', klettersteig: '🪜', eisklettern: '🧊', bike: '🚲' };
const VERDICT_BY_KEY = new Map(REPORT_VERDICTS.map((v) => [v.key, v]));

const escapeHtml = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Whole days between the day of the tour and today. */
export function ageInDays(date: string, now = new Date()): number {
  const [year, month, day] = date.split('-').map(Number);
  return Math.max(0, Math.round((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - Date.UTC(year, month - 1, day)) / DAY));
}

/** Activity colour family for a gipfelbuch `sym` code. */
export function reportTheme(sym: string): ReportTheme {
  const key = sym.trim().toLowerCase();
  if (SNOW_SYMS.has(key)) return 'snow';
  if (HIKING_SYMS.has(key)) return 'hiking';
  return 'climbing';
}

/** Pin fill colour for an activity `sym` and report age in days. */
export function pinColour(sym: string, days: number): string {
  const step = AGE_STEPS.findIndex((upTo) => days <= upTo);
  return REPORT_THEMES[reportTheme(sym)].colours[step === -1 ? AGE_STEPS.length - 1 : step];
}

/** Text/glyph colour keeping monochrome symbols legible on pale older pins. */
export const pinForeground = (days: number): string => (days <= 3 ? '#ffffff' : '#1e293b');

/** Condition label and traffic-light dot colour for a report's `verdict`, if recognized. */
export function verdictInfo(verdict?: string): { label: string; colour: string } | null {
  if (!verdict) return null;
  const hit = VERDICT_BY_KEY.get(verdict.trim().toLowerCase());
  return hit ? { label: hit.label, colour: hit.colour } : null;
}

/** Legend entry shown in the unified legend window while condition reports are switched on. */
export function reportLegend(): Legend {
  return {
    title: 'Condition reports',
    subtitle: 'Vivid = recent · pale = older',
    entries: [],
    rows: [
      {
        entries: Object.values(REPORT_THEMES).map((theme) => ({
          color: `linear-gradient(90deg,${theme.colours[0]},${theme.colours[2]},${theme.colours[4]})`,
          label: theme.name,
          shape: 'pill',
        })),
      },
      {
        heading: 'Conditions dot:',
        entries: REPORT_VERDICTS.map((v) => ({
          color: v.colour,
          label: v.label,
          shape: 'dot',
        })),
      },
    ],
  };
}

const ageText = (days: number): string => (days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`);

export class Gipfelbuch {
  enabled = false;
  /** Reports no older than this many days are shown. */
  days = 7;
  onError: (message: string) => void = () => {};
  onHint: (hint: string | null) => void = () => {};
  private markers: maplibregl.Marker[] = [];
  private stored: Promise<{ updated: string; reports: Report[] }> | null = null;
  private request = 0;
  private timer: number | undefined;

  constructor(
    private map: maplibregl.Map,
    private popup: maplibregl.Popup,
  ) {
    map.on('moveend', () => {
      if (!this.enabled) return;
      clearTimeout(this.timer);
      this.timer = window.setTimeout(() => void this.update(), 150);
    });
  }

  setEnabled(on: boolean): void {
    this.enabled = on;
    void this.update();
  }

  setDays(days: number): void {
    this.days = days;
    void this.update();
  }

  private load(): Promise<{ updated: string; reports: Report[] }> {
    this.stored ??= fetch(DATA).then(async (response) => {
      if (!response.ok) throw new Error('the stored list is missing (not available when the page is opened as a single file)');
      return response.json();
    });
    this.stored.catch(() => (this.stored = null));
    return this.stored;
  }

  private async update(): Promise<void> {
    const token = ++this.request;
    for (const marker of this.markers) marker.remove();
    this.markers = [];
    if (!this.enabled) {
      this.onHint(null);
      return;
    }
    let data: { updated: string; reports: Report[] };
    try {
      data = await this.load();
    } catch (error) {
      if (token === this.request) this.onError(`Condition reports could not be loaded: ${(error as Error).message}`);
      return;
    }
    if (token !== this.request || !this.enabled) return;
    const view = groundBounds(this.map, 140);
    const shown = data.reports.filter((report) => ageInDays(report.date) <= this.days);
    const visible = shown.filter((report) => report.at[0] >= view.west && report.at[0] <= view.east && report.at[1] >= view.south && report.at[1] <= view.north);
    // Several reports for the same summit share one pin.
    const places = new Map<string, Report[]>();
    for (const report of visible) {
      const key = `${report.at[0].toFixed(3)},${report.at[1].toFixed(3)}`;
      places.set(key, [...(places.get(key) ?? []), report]);
    }
    // Keep freshest up to MAX_SHOWN, then draw oldest first so freshest pins end up on top.
    const groups = [...places.values()]
      .sort((a, b) => (a[0].date > b[0].date ? -1 : 1))
      .slice(0, MAX_SHOWN)
      .reverse();
    for (const reports of groups) {
      const newest = reports[0]; // the list is stored newest first
      const age = ageInDays(newest.date);
      const verdict = verdictInfo(newest.verdict);
      const summary = [newest.name, ageText(age), verdict ? `conditions: ${verdict.label}` : null].filter(Boolean).join(' · ');
      const element = h('button', { type: 'button', class: 'report-pin', title: summary, 'aria-label': `Condition report: ${summary}` }, ICONS[newest.sym] ?? '📝');
      element.style.setProperty('--pin-bg', pinColour(newest.sym, age));
      element.style.setProperty('--pin-fg', pinForeground(age));
      if (verdict) element.append(h('span', { class: 'report-verdict', style: `background:${verdict.colour}` }));
      if (reports.length > 1) element.append(h('span', { class: 'report-count' }, String(reports.length)));
      element.addEventListener('click', (event) => {
        if (interaction.drawing) return;
        event.stopPropagation();
        this.open(reports);
      });
      this.markers.push(new maplibregl.Marker({ element, anchor: 'bottom', opacityWhenCovered: '0.35' }).setLngLat(newest.at).addTo(this.map));
    }
    const refreshed = Math.max(0, Math.round((Date.now() - new Date(data.updated).getTime()) / DAY));
    this.onHint(`${shown.length} report${shown.length === 1 ? '' : 's'} · list refreshed ${refreshed === 0 ? 'today' : refreshed === 1 ? 'yesterday' : `${refreshed} days ago`}`);
  }

  private open(reports: Report[]): void {
    const body = reports
      .map((report) => {
        const age = ageInDays(report.date);
        const [year, month, day] = report.date.split('-');
        const verdict = verdictInfo(report.verdict);
        const verdictHtml = verdict
          ? `<span class="report-verdict-inline"><i style="background:${verdict.colour}"></i>conditions: ${escapeHtml(verdict.label)}</span>`
          : report.verdict
            ? escapeHtml(`conditions: ${report.verdict}`)
            : null;
        const facts = [
          escapeHtml(report.type),
          escapeHtml(`${day}.${month}.${year} (${ageText(age)})`),
          verdictHtml,
          report.author ? escapeHtml(`by ${report.author}`) : null,
        ]
          .filter(Boolean)
          .join(' · ');
        return (
          `<div class="report"><h3><span class="report-dot" style="background:${pinColour(report.sym, age)}"></span>${escapeHtml(report.name)}</h3>` +
          (report.route ? `<div>${escapeHtml(report.route)}</div>` : '') +
          `<div class="muted">${facts}</div>` +
          (report.text ? `<p class="report-text">${escapeHtml(report.text)}</p>` : '') +
          `<div class="popup-links"><a class="button" href="${SITE}${encodeURIComponent(report.ident)}" target="_blank" rel="noopener">Read on gipfelbuch.ch${report.photo ? ' (photos)' : ''}</a></div></div>`
        );
      })
      .join('');
    this.popup.setLngLat(reports[0].at).setHTML(`<div class="popup reports">${body}<div class="muted">Source: gipfelbuch.ch</div></div>`).addTo(this.map);
  }
}
