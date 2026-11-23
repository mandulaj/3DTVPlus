import type { SunController, SunInfo } from '../sun/sun';
import { h, slider } from './dom';

const pad = (n: number) => String(n).padStart(2, '0');
const dateValue = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const minutesOf = (d: Date) => d.getHours() * 60 + d.getMinutes();
const clock = (minutes: number) => `${pad(Math.floor(minutes / 60))}:${pad(Math.round(minutes) % 60)}`;
const COMPASS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];

/** Bottom bar: sunlight toggle, date, time-of-day slider, play, shadow strength. */
export class SunControls {
  private toggle: HTMLButtonElement;
  private date: HTMLInputElement;
  private time: HTMLInputElement;
  private clockLabel = h('span', { class: 'clock' });
  private readout = h('span', { class: 'muted readout' });
  private track = h('div', { class: 'daylight' });
  private playButton: HTMLButtonElement;
  private playTimer: number | undefined;
  private controls: HTMLElement;

  constructor(
    private root: HTMLElement,
    private sun: SunController,
    private onStateChange: () => void,
  ) {
    this.toggle = h('button', { class: 'sun-toggle', title: 'Sunlight and terrain shadows', onclick: () => this.setEnabled(!sun.enabled) }, '☀ Sunlight');
    this.date = h('input', { type: 'date', value: dateValue(sun.time), onchange: () => this.commit() });
    this.time = slider(minutesOf(sun.time), 0, 1439, 1, () => this.commit(), 'Time of day (your local time zone)');
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
      now,
      look,
      h('span', { class: 'muted' }, 'Shadow'),
      strength,
      this.readout,
    );
    root.append(this.toggle, this.controls);
    sun.onUpdate = (info) => this.showInfo(info);
    this.refresh();
  }

  setEnabled(on: boolean): void {
    this.sun.setEnabled(on);
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
    this.sun.setTime(new Date(year, month - 1, day, Math.floor(minutes / 60), minutes % 60));
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
      this.track.title = `Sunrise ${clock(minutesOf(info.sunrise))}, sunset ${clock(minutesOf(info.sunset))} (your local time zone)`;
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
