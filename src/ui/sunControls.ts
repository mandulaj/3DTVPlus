import type { SunController, SunInfo } from '../sun/sun';
import { h, slider } from './dom';

const pad = (n: number) => String(n).padStart(2, '0');
// Times are shown in the time zone of the place on the map, when that differs from the browser's
// (looking at Nepal from Switzerland, noon should be noon there). `zone` is an IANA name, or null
// for the browser's own zone.
let zone: string | null = null;
const BROWSER_ZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

/** Calendar date and minutes after midnight of an instant, in the zone in use. */
function fields(d: Date): { year: number; month: number; day: number; minutes: number } {
  if (!zone) return { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate(), minutes: d.getHours() * 60 + d.getMinutes() };
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
      .formatToParts(d)
      .map((part) => [part.type, Number(part.value)]),
  );
  return { year: parts.year, month: parts.month, day: parts.day, minutes: parts.hour * 60 + parts.minute };
}

/** The instant at which the zone in use shows this date and time. */
function instant(year: number, month: number, day: number, minutes: number): Date {
  if (!zone) return new Date(year, month - 1, day, Math.floor(minutes / 60), minutes % 60);
  const wanted = Date.UTC(year, month - 1, day, 0, minutes);
  let guess = wanted;
  for (let i = 0; i < 2; i++) {
    const f = fields(new Date(guess));
    guess += wanted - Date.UTC(f.year, f.month - 1, f.day, 0, f.minutes);
  }
  return new Date(guess);
}

const dateValue = (d: Date) => {
  const f = fields(d);
  return `${f.year}-${pad(f.month)}-${pad(f.day)}`;
};
const minutesOf = (d: Date) => fields(d).minutes;
const clock = (minutes: number) => `${pad(Math.floor(minutes / 60))}:${pad(Math.round(minutes) % 60)}`;
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** Bottom bar: sunlight toggle, date, time-of-day slider, play, shadow strength. */
export class SunControls {
  private toggle: HTMLButtonElement;
  private date: HTMLInputElement;
  private time: HTMLInputElement;
  private clockLabel = h('span', { class: 'clock' });
  private zoneLabel = h('span', { class: 'muted zone' });
  private zoneKey = '';
  private zoneTimer: number | undefined;
  private readout = h('span', { class: 'muted readout' });
  private track = h('div', { class: 'daylight' });
  private playButton: HTMLButtonElement;
  private playTimer: number | undefined;
  private controls: HTMLElement;

  constructor(
    private root: HTMLElement,
    private sun: SunController,
    private onStateChange: () => void,
    private map: import('maplibre-gl').Map,
  ) {
    this.toggle = h('button', { class: 'sun-toggle', title: 'Sunlight and terrain shadows', onclick: () => this.setEnabled(!sun.enabled) }, '☀ Sunlight');
    this.date = h('input', { type: 'date', value: dateValue(sun.time), onchange: () => this.commit() });
    this.time = slider(minutesOf(sun.time), 0, 1439, 1, () => this.commit(), 'Time of day at the map location');
    this.time.classList.add('time-slider');
    this.playButton = h('button', { title: 'Animate the day', onclick: () => this.togglePlay() }, '▶');
    const now = h('button', { title: 'Jump to current time', onclick: () => this.setTime(new Date()) }, 'Now');
    const look = h('button', { title: 'Turn the view toward the sun', onclick: () => sun.lookAtSun() }, '◎ Face sun');
    const strength = slider(sun.shadowOpacity, 0, 1, 0.05, (v) => sun.setShadowOpacity(v), 'Shadow strength');
    strength.classList.add('strength');

    this.controls = h(
      'div',
      { class: 'sun-controls' },
      this.date,
      this.playButton,
      h('div', { class: 'time-wrap' }, this.track, this.time),
      this.clockLabel,
      this.zoneLabel,
      now,
      look,
      h('span', { class: 'muted' }, 'Shadow'),
      strength,
      this.readout,
    );
    root.append(this.toggle, this.controls);
    sun.onUpdate = (info) => this.showInfo(info);
    map.on('moveend', () => {
      if (!sun.enabled) return;
      clearTimeout(this.zoneTimer);
      this.zoneTimer = window.setTimeout(() => void this.locateZone(), 1000);
    });
    // Alt+wheel over the map: move the time of day (Alt+Shift: by single minutes).
    map.getCanvasContainer().addEventListener(
      'wheel',
      (event) => {
        if (!event.altKey || event.ctrlKey || event.metaKey || !sun.enabled) return;
        event.preventDefault();
        event.stopImmediatePropagation(); // not a zoom
        const delta = event.deltaY || event.deltaX;
        if (delta) this.nudge(-Math.sign(delta) * (event.shiftKey ? 1 : 10));
      },
      { capture: true, passive: false },
    );
    this.refresh();
  }

  /** Moves the time of day by some minutes, staying within the day shown. */
  nudge(minutes: number): void {
    this.stop();
    this.time.value = String(Math.min(1439, Math.max(0, Number(this.time.value) + minutes)));
    this.commit();
  }

  /** Finds the time zone at the map centre (Open-Meteo) and shows times in it if it is not the browser's. */
  private async locateZone(): Promise<void> {
    const { lng, lat } = this.map.getCenter();
    const key = `${lat.toFixed(0)},${lng.toFixed(0)}`; // zones are large: ask again only after a real move
    if (key === this.zoneKey) return;
    this.zoneKey = key;
    let found: string | null = null;
    try {
      const response = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(1)}&longitude=${lng.toFixed(1)}&current=temperature_2m&timezone=auto`);
      const name = (await response.json()).timezone as string | undefined;
      if (name && name !== BROWSER_ZONE) {
        new Intl.DateTimeFormat('en', { timeZone: name }); // throws if this browser does not know the zone
        found = name;
      }
    } catch {
      found = null; // lookup unavailable: stay with the browser's zone
      this.zoneKey = '';
    }
    if (found === zone) return;
    zone = found;
    // Same instant, shown in the other zone.
    this.date.value = dateValue(this.sun.time);
    this.time.value = String(minutesOf(this.sun.time));
    this.zoneLabel.textContent = zone ? zone.split('/').pop()!.replace(/_/g, ' ') : '';
    this.zoneLabel.title = zone ? `Times are in the time zone of the map location (${zone}), not your own` : '';
    this.refresh();
  }

  setEnabled(on: boolean): void {
    this.sun.setEnabled(on);
    if (on) void this.locateZone();
    if (!on) this.stop();
    this.refresh();
    this.onStateChange();
  }

  setTime(time: Date): void {
    this.date.value = dateValue(time);
    this.time.value = String(minutesOf(time));
    this.commit();
  }

  private commit(): void {
    if (!this.date.value) return;
    const [year, month, day] = this.date.value.split('-').map(Number);
    const minutes = Number(this.time.value);
    this.sun.setTime(instant(year, month, day, minutes));
    this.refresh();
    this.onStateChange();
  }

  private refresh(): void {
    this.root.classList.toggle('active', this.sun.enabled);
    this.toggle.classList.toggle('on', this.sun.enabled);
    this.clockLabel.textContent = clock(Number(this.time.value));
    if (this.sun.enabled) this.showInfo(this.sun.info());
  }

  private showInfo(info: SunInfo): void {
    const direction = COMPASS[Math.round(info.azimuth / 45) % 8];
    this.readout.textContent =
      info.altitude < -0.8 ? `Sun below horizon (${info.altitude.toFixed(0)}°)` : `Sun ${info.altitude.toFixed(1)}° high, ${direction} (${info.azimuth.toFixed(0)}°)`;
    // Daylight band behind the slider, for the map centre on the chosen day.
    if (info.sunrise && info.sunset) {
      const from = (minutesOf(info.sunrise) / 1440) * 100;
      const to = (minutesOf(info.sunset) / 1440) * 100;
      this.track.style.background =
        from < to
          ? `linear-gradient(90deg, #1b2440 ${from - 2}%, #f3c969 ${from + 2}%, #f3c969 ${to - 2}%, #1b2440 ${to + 2}%)`
          : `linear-gradient(90deg, #f3c969 ${to - 2}%, #1b2440 ${to + 2}%, #1b2440 ${from - 2}%, #f3c969 ${from + 2}%)`;
      this.track.title = `Sunrise ${clock(minutesOf(info.sunrise))}, sunset ${clock(minutesOf(info.sunset))} (${zone ?? 'your local time zone'})`;
    } else {
      this.track.style.background = info.altitude > 0 ? '#f3c969' : '#1b2440';
    }
  }

  private togglePlay(): void {
    if (this.playTimer) this.stop();
    else {
      this.playButton.textContent = '⏸';
      this.playTimer = window.setInterval(() => {
        this.time.value = String((Number(this.time.value) + 10) % 1440);
        this.commit();
      }, 700);
    }
  }

  private stop(): void {
    clearInterval(this.playTimer);
    this.playTimer = undefined;
    this.playButton.textContent = '▶';
  }
}
