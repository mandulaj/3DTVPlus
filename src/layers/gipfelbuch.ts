// Recent condition reports from gipfelbuch.ch as pins: coloured by age, click for a short excerpt
// and a link to the report. gipfelbuch.ch cannot be asked from a web page (no cross-origin
// permission), so the list is a copy stored with the site (scripts/fetch-gipfelbuch.mjs) and is
// as fresh as its last refresh.
import * as maplibregl from 'maplibre-gl';
import { h } from '../ui/dom';

const DATA = './data/gipfelbuch.json';
const SITE = 'https://www.gipfelbuch.ch/verhaeltnisse/';
const DAY = 86400000;

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

/** Pin colours by age of the report, freshest first. */
export const REPORT_AGES: { upTo: number; colour: string; name: string }[] = [
  { upTo: 1, colour: '#e5383b', name: 'today, yesterday' },
  { upTo: 3, colour: '#f3722c', name: '2–3 days' },
  { upTo: 7, colour: '#f9c74f', name: '4–7 days' },
  { upTo: 14, colour: '#90be6d', name: '1–2 weeks' },
  { upTo: Infinity, colour: '#8d99ae', name: 'older' },
];

const ICONS: Record<string, string> = { ski: '⛷', schneeschuh: '❄', alpwanderung: '🥾', hochtour: '⛏', klettertour: '🧗', klettersteig: '🪜', eisklettern: '🧊', bike: '🚲' };
const VERDICTS: Record<string, string> = { ausgezeichnet: 'excellent', gut: 'good', machbar: 'doable', schlecht: 'poor' };

const escapeHtml = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** Whole days between the day of the tour and today. */
export function ageInDays(date: string, now = new Date()): number {
  const [year, month, day] = date.split('-').map(Number);
  return Math.max(0, Math.round((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - Date.UTC(year, month - 1, day)) / DAY));
}

export const ageColour = (days: number): string => REPORT_AGES.find((age) => days <= age.upTo)!.colour;

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

  constructor(
    private map: maplibregl.Map,
    private popup: maplibregl.Popup,
  ) {}

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
    const shown = data.reports.filter((report) => ageInDays(report.date) <= this.days);
    // Several reports for the same summit share one pin.
    const places = new Map<string, Report[]>();
    for (const report of shown) {
      const key = `${report.at[0].toFixed(3)},${report.at[1].toFixed(3)}`;
      places.set(key, [...(places.get(key) ?? []), report]);
    }
    // Oldest first, so that the freshest pins end up on top.
    const groups = [...places.values()].sort((a, b) => (a[0].date < b[0].date ? -1 : 1));
    for (const reports of groups) {
      const newest = reports[0]; // the list is stored newest first
      const age = ageInDays(newest.date);
      const element = h('button', { type: 'button', class: 'report-pin', title: `${newest.name} · ${ageText(age)}`, 'aria-label': `Condition report: ${newest.name}, ${ageText(age)}` }, ICONS[newest.sym] ?? '📝');
      element.style.setProperty('--age', ageColour(age));
      if (reports.length > 1) element.append(h('span', { class: 'report-count' }, String(reports.length)));
      element.addEventListener('click', (event) => {
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
        const facts = [report.type, `${day}.${month}.${year} (${ageText(age)})`, report.verdict ? `conditions: ${VERDICTS[report.verdict] ?? report.verdict}` : null, report.author ? `by ${report.author}` : null].filter(Boolean).join(' · ');
        return (
          `<div class="report"><h3><span class="report-dot" style="background:${ageColour(age)}"></span>${escapeHtml(report.name)}</h3>` +
          (report.route ? `<div>${escapeHtml(report.route)}</div>` : '') +
          `<div class="muted">${escapeHtml(facts)}</div>` +
          (report.text ? `<p class="report-text">${escapeHtml(report.text)}</p>` : '') +
          `<div class="popup-links"><a class="button" href="${SITE}${encodeURIComponent(report.ident)}" target="_blank" rel="noopener">Read on gipfelbuch.ch${report.photo ? ' (photos)' : ''}</a></div></div>`
        );
      })
      .join('');
    this.popup.setLngLat(reports[0].at).setHTML(`<div class="popup reports">${body}<div class="muted">Source: gipfelbuch.ch</div></div>`).addTo(this.map);
  }
}
