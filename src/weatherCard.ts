// "Weather & conditions" for one place: opens beside the map when a forecast pill is clicked (or
// from the right-click menu). Weather from Open-Meteo, snow depth and avalanche bulletin from SLF.
import type { SlfLayers } from './layers/slf';
import { h } from './ui/dom';
import { COMPASS, meteoSwissAddress, symbol, type Spot } from './weather';

const API = 'https://api.open-meteo.com/v1/forecast';
const CURRENT = 'temperature_2m,apparent_temperature,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m,visibility';
const DAILY = 'weather_code,temperature_2m_min,temperature_2m_max,precipitation_sum,snowfall_sum,wind_gusts_10m_max';
const PAST_DAYS = 3;
const CACHE_MINUTES = 30;
/** Snow usually falls down to some 300 m below the freezing level. */
const SNOW_BELOW_FREEZING = 300;

interface Report {
  fetched: number;
  elevation: number;
  current: Record<string, number>;
  freezing: number | null;
  days: { date: string; code: number; min: number; max: number; rain: number; snow: number; gusts: number }[];
}

const round = (value: number) => String(Math.round(value));
const metres = (value: number) => `${Math.round(value / 10) * 10} m`;

export class WeatherCard {
  /** Told when the card opens for a place or closes (null), e.g. to mark the pill it belongs to. */
  onChange: (spot: Spot | null) => void = () => {};
  private root = h('aside', { class: 'weather-card', hidden: true, 'aria-label': 'Weather and conditions' });
  private cache = new Map<string, Report>();
  private request = 0;
  private shown: Spot | null = null;

  constructor(private slf: SlfLayers) {
    document.body.append(this.root);
    window.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && !this.root.hidden && !(event.target instanceof HTMLInputElement)) this.close();
    });
  }

  close(): void {
    this.root.hidden = true;
    this.shown = null;
    this.request++;
    this.onChange(null);
  }

  /** Shows the card for a place; `ele` (a summit's height) makes the forecast one for that height. */
  open(spot: Spot): void {
    if (this.shown?.key === spot.key && !this.root.hidden) return this.close(); // second click on the same pill
    const token = ++this.request;
    this.shown = spot;
    this.onChange(spot);
    const [lng, lat] = spot.at;

    const title = h('a', { class: 'weather-card-title', target: '_blank', rel: 'noopener', href: `https://www.yr.no/en/forecast/daily-table/${lat.toFixed(4)},${lng.toFixed(4)}`, title: 'Open the full forecast (yr.no)' }, spot.name, ' ↗');
    const where = h('div', { class: 'muted weather-card-where' }, `${spot.ele !== undefined ? `${Math.round(spot.ele)} m · ` : ''}${lat.toFixed(5)}°N ${lng.toFixed(5)}°E`);
    const now = section('Now');
    const snow = section('Snow depth');
    const bulletin = section('Avalanche bulletin');
    const past = section(`Last ${PAST_DAYS} days`);
    const next = section('Next 7 days');
    snow.box.hidden = true;
    bulletin.box.hidden = true;
    now.body.append(h('div', { class: 'muted' }, 'Loading…'));
    this.root.replaceChildren(
      h('header', {}, h('b', {}, 'Weather & conditions'), h('button', { type: 'button', class: 'weather-card-close', title: 'Close (Esc)', onclick: () => this.close() }, '×')),
      h('div', { class: 'weather-card-body' }, h('div', { class: 'weather-card-head' }, title, where), now.box, snow.box, bulletin.box, past.box, next.box, h('div', { class: 'muted weather-card-source' }, 'Weather: Open-Meteo (MeteoSwiss ICON model in and around Switzerland). Snow and avalanche data: SLF.')),
    );
    this.root.hidden = false;
    const live = () => token === this.request;

    // In Switzerland the name leads to MeteoSwiss's page for the place.
    void meteoSwissAddress(spot.at).then((address) => {
      if (!live() || !address) return;
      title.href = address;
      title.title = 'Open MeteoSwiss\'s forecast for this place';
    });

    void this.report(spot).then(
      (report) => {
        if (!live()) return;
        const c = report.current;
        const [icon, words] = symbol(c.weather_code);
        const from = COMPASS[Math.round(c.wind_direction_10m / 45) % 8];
        now.title.textContent = `Now at ${Math.round(report.elevation)} m`;
        const visibility = c.visibility >= 10000 ? `${round(c.visibility / 1000)} km` : c.visibility >= 1000 ? `${(c.visibility / 1000).toFixed(1)} km` : metres(c.visibility);
        now.body.replaceChildren(
          h('div', { class: 'weather-card-now' }, h('span', { class: 'weather-card-icon' }, icon), h('div', {}, h('b', {}, `${round(c.temperature_2m)} °C`), h('div', { class: 'muted' }, `${words} · feels ${round(c.apparent_temperature)} °C`))),
          rows([
            ['Wind', `${from} ${round(c.wind_speed_10m)}–${round(c.wind_gusts_10m)} km/h`],
            ['Freezing level', report.freezing === null ? '–' : metres(report.freezing)],
            ['Snowfall line', report.freezing === null ? '–' : `about ${metres(Math.max(0, report.freezing - SNOW_BELOW_FREEZING))}`],
            ['Visibility', visibility],
          ]),
        );
        const today = new Date().toLocaleDateString('sv'); // local date as YYYY-MM-DD
        const before = report.days.filter((d) => d.date < today).slice(-PAST_DAYS);
        const after = report.days.filter((d) => d.date >= today).slice(0, 7);
        const total = (days: typeof before) => days.reduce((sum, d) => sum + d.snow, 0);
        past.body.replaceChildren(h('div', {}, 'New snow ', h('b', {}, `${round(total(before))} cm`), h('span', { class: 'muted' }, ' (model estimate)')), table(before));
        next.body.replaceChildren(h('div', {}, 'New snow ', h('b', {}, `${round(total(after))} cm`), h('span', { class: 'muted' }, ' (model estimate)')), table(after, today));
      },
      () => {
        if (live()) now.body.replaceChildren(h('div', { class: 'muted' }, 'Forecast unavailable right now.'));
      },
    );

    // Measured snow: the nearest stations (Switzerland).
    void Promise.all([this.slf.nearestStations('SNOW_HEIGHT', lng, lat, 2), this.slf.nearestStations('HEIGHT_NEW_SNOW_1D', lng, lat, 6)]).then(
      ([depth, fresh]) => {
        if (!live() || !depth.length) return;
        snow.box.hidden = false;
        snow.body.replaceChildren(
          ...depth.map((station) => {
            const new24 = fresh.find((f) => f.name === station.name);
            return h(
              'div',
              { class: 'weather-card-row' },
              h('span', {}, station.name, h('span', { class: 'muted' }, ` ${Math.round(station.elevation)} m · ${station.km.toFixed(1)} km`)),
              h('b', {}, `${round(station.value)} cm`, new24 && new24.value >= 1 ? h('span', { class: 'weather-card-fresh' }, ` +${round(new24.value)} cm 24 h`) : ''),
            );
          }),
          h('div', { class: 'muted' }, 'Measured at the nearest stations.'),
        );
      },
      () => {},
    );

    // The avalanche bulletin of the region the place lies in.
    void this.slf.bulletinAt(lng, lat).then(
      (html) => {
        if (!live() || !html) return;
        bulletin.box.hidden = false;
        bulletin.body.innerHTML = html; // built and escaped by the bulletin popup's own code
      },
      () => {},
    );
  }

  private async report(spot: Spot): Promise<Report> {
    const hit = this.cache.get(spot.key);
    if (hit && Date.now() - hit.fetched < CACHE_MINUTES * 60000) return hit;
    const query = new URLSearchParams({
      latitude: spot.at[1].toFixed(4),
      longitude: spot.at[0].toFixed(4),
      current: CURRENT,
      hourly: 'freezing_level_height',
      daily: DAILY,
      timezone: 'auto',
      past_days: String(PAST_DAYS),
      forecast_days: '8',
    });
    if (spot.ele !== undefined) query.set('elevation', String(Math.round(spot.ele)));
    const response = await fetch(`${API}?${query}`);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = await response.json();
    // The hour the current values belong to.
    const hour = (data.hourly.time as string[]).findIndex((time) => time.slice(0, 13) === String(data.current.time).slice(0, 13));
    const d = data.daily;
    const report: Report = {
      fetched: Date.now(),
      elevation: Number(data.elevation),
      current: data.current,
      freezing: hour >= 0 && Number.isFinite(data.hourly.freezing_level_height[hour]) ? data.hourly.freezing_level_height[hour] : null,
      days: (d.time as string[]).map((date, i) => ({ date, code: d.weather_code[i], min: d.temperature_2m_min[i], max: d.temperature_2m_max[i], rain: d.precipitation_sum[i] ?? 0, snow: d.snowfall_sum[i] ?? 0, gusts: d.wind_gusts_10m_max[i] })),
    };
    this.cache.set(spot.key, report);
    if (this.cache.size > 60) this.cache.delete(this.cache.keys().next().value!);
    return report;
  }
}

function section(name: string): { box: HTMLElement; title: HTMLElement; body: HTMLElement } {
  const title = h('h4', {}, name);
  const body = h('div', {});
  return { box: h('section', {}, title, body), title, body };
}

function rows(entries: [string, string][]): HTMLElement {
  return h('div', {}, ...entries.map(([label, value]) => h('div', { class: 'weather-card-row' }, h('span', { class: 'muted' }, label), h('b', {}, value))));
}

function table(days: Report['days'], today?: string): HTMLElement {
  const head = h('tr', {}, ...['', '', 'min °C', 'max °C', 'precip mm', 'snow cm', 'gusts km/h'].map((text) => h('th', {}, text)));
  return h(
    'table',
    { class: 'weather-card-days' },
    head,
    ...days.map((day) => {
      const date = new Date(`${day.date}T12:00:00`);
      const [icon, words] = symbol(day.code);
      const snow = day.snow >= 0.5;
      return h(
        'tr',
        {},
        h('td', {}, day.date === today ? 'Today' : date.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric' })),
        h('td', { title: words }, icon),
        h('td', {}, round(day.min)),
        h('td', {}, round(day.max)),
        h('td', {}, day.rain >= 0.05 ? (day.rain < 10 ? day.rain.toFixed(1) : round(day.rain)) : '–'),
        h('td', { class: snow ? 'weather-card-snow' : '' }, snow ? round(day.snow) : '–'),
        h('td', {}, round(day.gusts)),
      );
    }),
  );
}
